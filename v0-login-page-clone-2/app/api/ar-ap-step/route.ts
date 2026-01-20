import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema } from "@/lib/db"
import { fetchInvoicesForReconciliation, enrichInvoicesWithReconciliationStatus } from "@/lib/invoices-fetch"
import { fetchBillsForReconciliation, enrichBillsWithReconciliationStatus } from "@/lib/bills-fetch"
import { computeARState, computeAPStateFromBills } from "@/lib/state/ar-ap"
import { query } from "@/lib/db"
import { runFinancialBrain } from "@/lib/financial-brain"
import {
  fetchReconciliationMovementRows,
  type ReconMovementRow,
} from "@/lib/reconciliation-movement-rows"
import { getMovementsPendingWaterfallReview } from "@/lib/reconciliation-waterfall"
import { refreshEntityAliasesFromAccounting } from "@/lib/identity-seed"
import { refreshMovementEntityIds } from "@/lib/movement-classify"
import { tagMovements } from "@/lib/movement-tag-enrich"
import { runLLMStage4, getAllUnreconciledMovements, type InvoiceForMatch, type BillForMatch } from "@/lib/reconciliation-llm-match"
import { toEntityUriApBill } from "@/lib/entity-uri"
import type { OutstandingInvoice, OutstandingBill } from "@/lib/state/types"
import { buildEntityProfiles } from "@/lib/entity-profiles"
import { refreshEntityNarratives } from "@/lib/entity-profile-ai"

const WATERFALL_REVIEW_PREVIEW = 15
const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes - consider stale locks as failed
const MIN_RECONCILIATION_INTERVAL_MS = 60 * 1000 // Minimum 60 seconds between reconciliation runs

type ReconTotals = {
  total_matched_inflows: number
  total_matched_outflows: number
  total_unmatched_inflows: number
  total_unmatched_outflows: number
  total_excluded_inflows: number
  total_excluded_outflows: number
  total_fees_paid: number
  matched_inflows: ReconMovementRow[]
  matched_outflows: ReconMovementRow[]
  unmatched_inflows: ReconMovementRow[]
  unmatched_outflows: ReconMovementRow[]
  excluded_inflows: ReconMovementRow[]
  excluded_outflows: ReconMovementRow[]
}

type ReconciliationLockStatus = {
  is_running: boolean
  last_run_at: string | null
  last_status: "completed" | "failed" | "completed_with_warnings" | null
  last_error: string | null
  warnings?: string[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * Attempt to acquire a reconciliation lock for the user.
 * Returns true if lock acquired, false if already running or too soon after last run.
 * Uses a single atomic query to clean up stale locks and acquire in one operation.
 */
async function acquireReconciliationLock(userId: string): Promise<boolean> {
  // Atomic lock acquisition: clean up stale locks, check minimum interval, and try to acquire in one query
  // This prevents TOCTOU race conditions between cleanup and acquisition
  const { rows } = await query<{ acquired: boolean }>(
    `WITH cleanup AS (
       UPDATE reconciliation_locks 
       SET status = 'failed', 
           error_message = 'Lock timed out (stale)',
           completed_at = NOW()
       WHERE user_id = $1::uuid 
         AND status = 'running' 
         AND started_at < NOW() - INTERVAL '${LOCK_TIMEOUT_MS} milliseconds'
       RETURNING user_id
     )
     INSERT INTO reconciliation_locks (user_id, started_at, status)
     VALUES ($1::uuid, NOW(), 'running')
     ON CONFLICT (user_id) DO UPDATE
       SET started_at = NOW(),
           status = 'running',
           error_message = NULL,
           completed_at = NULL
       WHERE reconciliation_locks.status != 'running'
         AND (reconciliation_locks.completed_at IS NULL 
              OR reconciliation_locks.completed_at < NOW() - INTERVAL '${MIN_RECONCILIATION_INTERVAL_MS} milliseconds')
     RETURNING true AS acquired`,
    [userId]
  )
  return rows.length > 0 && rows[0].acquired === true
}

/**
 * Release the reconciliation lock with final status.
 */
async function releaseReconciliationLock(
  userId: string, 
  status: "completed" | "failed" | "completed_with_warnings", 
  errorMessage?: string,
  warnings?: string[]
): Promise<void> {
  // Store warnings in error_message field as JSON if present
  const messageToStore = warnings && warnings.length > 0
    ? JSON.stringify({ error: errorMessage, warnings })
    : errorMessage ?? null
  await query(
    `UPDATE reconciliation_locks 
     SET status = $2, 
         error_message = $3,
         completed_at = NOW()
     WHERE user_id = $1::uuid`,
    [userId, status, messageToStore]
  )
}

/**
 * Check if reconciliation is currently running for the user.
 */
async function isReconciliationRunning(userId: string): Promise<boolean> {
  const { rows } = await query<{ status: string; started_at: Date }>(
    `SELECT status, started_at FROM reconciliation_locks WHERE user_id = $1::uuid`,
    [userId]
  )
  if (rows.length === 0) return false
  const lock = rows[0]
  if (lock.status !== "running") return false
  // Check if lock is stale
  const elapsed = Date.now() - new Date(lock.started_at).getTime()
  return elapsed < LOCK_TIMEOUT_MS
}

/**
 * Get the full reconciliation lock status for API response.
 */
async function getReconciliationLockStatus(userId: string): Promise<ReconciliationLockStatus> {
  const { rows } = await query<{ 
    status: string
    started_at: Date
    completed_at: Date | null
    error_message: string | null 
  }>(
    `SELECT status, started_at, completed_at, error_message 
     FROM reconciliation_locks 
     WHERE user_id = $1::uuid`,
    [userId]
  )
  
  if (rows.length === 0) {
    return { is_running: false, last_run_at: null, last_status: null, last_error: null }
  }
  
  const lock = rows[0]
  const elapsed = Date.now() - new Date(lock.started_at).getTime()
  const isRunning = lock.status === "running" && elapsed < LOCK_TIMEOUT_MS
  
  return {
    is_running: isRunning,
    last_run_at: lock.completed_at?.toISOString() ?? lock.started_at.toISOString(),
    last_status: lock.status === "running" 
      ? (isRunning ? null : "failed") 
      : (lock.status as "completed" | "failed"),
    last_error: lock.status === "running" && !isRunning 
      ? "Lock timed out (stale)" 
      : lock.error_message,
  }
}

async function runReconciliationInBackground(userId: string) {
  console.log("[ar-ap-step] Starting background reconciliation for user:", userId)
  const warnings: string[] = []
  
  try {
    const invoices = await fetchInvoicesForReconciliation(userId)
    const bills = await fetchBillsForReconciliation(userId)
    const obligations = computeAPStateFromBills(bills.filter(b => b.status !== "paid"))
    
    await refreshEntityAliasesFromAccounting(userId)
    await refreshMovementEntityIds(userId)
    
    // Ensure movement tags are up-to-date before reconciliation
    console.log("[ar-ap-step] Running tagMovements for user:", userId)
    await tagMovements(userId)
    
    // Run rule-based waterfall (Stages 0-3)
    await runFinancialBrain(userId, {
      outstandingInvoices: invoices,
      apObligations: obligations,
    })
    
    // Run LLM Stage 4 on ALL unreconciled movements (not just flagged ones)
    console.log("[ar-ap-step] Running LLM Stage 4 for user:", userId)
    const unreconciledMovements = await getAllUnreconciledMovements(userId)
    
    if (unreconciledMovements.length > 0) {
      console.log("[ar-ap-step] Found", unreconciledMovements.length, "unreconciled movements for LLM matching")
      
      // Prepare invoice/bill data for LLM matching
      // Filter to only open/overdue invoices and bills (exclude paid ones)
      const invoicesForLLM: InvoiceForMatch[] = invoices
        .filter((i) => i.status !== "paid" && i.amount_due > 0)
        .map((i) => ({
          invoice_id: i.invoice_id,
          customer_name: i.customer_name,
          amount_due: i.amount_due,
          due_date: i.due_date,
          entity_id: i.entity_uri,
          source: i.source,
        }))

      const billsForLLM: BillForMatch[] = bills
        .filter((b) => b.status !== "paid" && b.amount_due > 0)
        .map((b) => ({
          bill_id: b.bill_id,
          obligation_id: b.entity_uri ?? toEntityUriApBill(b.source, b.bill_id),
          vendor_name: b.vendor_name,
          amount_due: b.amount_due,
          due_date: b.due_date,
          entity_id: b.entity_uri,
          source: b.source,
        }))
      
      const llmResult = await runLLMStage4(
        userId,
        unreconciledMovements,
        invoicesForLLM,
        billsForLLM,
        "high" // Only auto-apply high-confidence matches
      )
      
      console.log("[ar-ap-step] LLM Stage 4 result:", {
        unreconciledCount: unreconciledMovements.length,
        arMatches: llmResult.matches.ar.length,
        apMatches: llmResult.matches.ap.length,
        applied: llmResult.applied.applied,
        skipped: llmResult.applied.skipped,
        errors: llmResult.applied.errors.length,
      })
      
      // Track LLM errors as warnings
      if (llmResult.applied.errors.length > 0) {
        warnings.push(`LLM matching had ${llmResult.applied.errors.length} errors`)
      }
    } else {
      console.log("[ar-ap-step] No unreconciled movements for LLM Stage 4")
    }
    
    // Build entity profiles after reconciliation completes
    let profilesBuilt = 0
    let narrativesRefreshed = 0
    try {
      console.log("[ar-ap-step] Building entity profiles for user:", userId)
      profilesBuilt = await buildEntityProfiles(userId)
      console.log("[ar-ap-step] Entity profiles built:", profilesBuilt)
      
      // Generate AI narratives for top entities - await to ensure completion before lock release
      try {
        narrativesRefreshed = await refreshEntityNarratives(userId, { maxEntities: 25 })
        console.log("[ar-ap-step] Entity narratives refreshed:", narrativesRefreshed)
      } catch (narrativeErr) {
        console.warn("[ar-ap-step] Failed to refresh entity narratives:", narrativeErr)
        warnings.push("Failed to refresh entity narratives")
      }
    } catch (e) {
      console.warn("[ar-ap-step] Failed to build entity profiles:", e)
      warnings.push("Failed to build entity profiles")
    }
    
    console.log("[ar-ap-step] Background reconciliation completed for user:", userId)
    const finalStatus = warnings.length > 0 ? "completed_with_warnings" : "completed"
    await releaseReconciliationLock(userId, finalStatus, undefined, warnings.length > 0 ? warnings : undefined)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[ar-ap-step] Background reconciliation failed:", msg)
    await releaseReconciliationLock(userId, "failed", msg)
  }
}

export async function GET(request: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureMovementsSchema()

  const url = new URL(request.url)
  const runRecon = url.searchParams.get("run") === "true"
  const getStatus = url.searchParams.get("status") === "true"

  // Handle status check request
  if (getStatus) {
    const reconciliationStatus = await getReconciliationLockStatus(user.id)
    return NextResponse.json(reconciliationStatus)
  }

  if (runRecon) {
    // Try to acquire database lock - this works across multiple dynos
    const lockAcquired = await acquireReconciliationLock(user.id)
    if (lockAcquired) {
      // Start background task - lock will be released when it completes
      runReconciliationInBackground(user.id).catch(async (e) => {
        console.error("[ar-ap-step] Background task error:", e)
        try {
          await releaseReconciliationLock(user.id, "failed", e instanceof Error ? e.message : String(e))
        } catch (releaseErr) {
          console.error("[ar-ap-step] Failed to release lock after error:", releaseErr)
        }
      })
      
      // Return immediately with is_reconciling=true so frontend knows to poll
      // Don't read database state while reconciliation is actively mutating it
      const reconciliationStatus = await getReconciliationLockStatus(user.id)
      return NextResponse.json({
        is_reconciling: true,
        reconciliation_status: reconciliationStatus,
        message: "Reconciliation started, poll for updates",
      })
    } else {
      console.log("[ar-ap-step] Reconciliation already running for user:", user.id)
    }
  }

  // Check if reconciliation is currently running - if so, return minimal response
  // to avoid reading mid-mutation database state
  const reconciliationStatus = await getReconciliationLockStatus(user.id)
  if (reconciliationStatus.is_running) {
    return NextResponse.json({
      is_reconciling: true,
      reconciliation_status: reconciliationStatus,
      message: "Reconciliation in progress, poll for updates",
    })
  }

  const invoices = await fetchInvoicesForReconciliation(user.id)
  const bills = await fetchBillsForReconciliation(user.id)
  const obligations = computeAPStateFromBills(bills.filter(b => b.status !== "paid"))

  const enrichedInvoices = await enrichInvoicesWithReconciliationStatus(user.id, invoices)
  const enrichedBills = await enrichBillsWithReconciliationStatus(user.id, bills)

  const openInvoices = enrichedInvoices.filter((i) => i.status !== "paid")
  const paidInvoices = enrichedInvoices.filter((i) => i.status === "paid")

  const openBills = enrichedBills.filter((b) => b.status !== "paid")
  const paidBills = enrichedBills.filter((b) => b.status === "paid")

  const ar = computeARState(openInvoices)

  const arReconciliationSummary = computeReconciliationSummary(enrichedInvoices)
  const apReconciliationSummary = computeApReconciliationSummary(enrichedBills)

  const ap = {
    total_expected_30d: r2(obligations.reduce((s, o) => s + o.expected_amount, 0)),
    obligation_count: obligations.length,
    obligations: obligations.sort((a, b) => a.days_until_due - b.days_until_due),
    bills: openBills,
    paid_bills: paidBills,
    reconciliation_summary: apReconciliationSummary,
  }

  const recon = await fetchReconTotals(user.id)
  const excludedCategories = await fetchExcludedCategories(user.id)
  const transferPairs = await fetchTransferPairs(user.id)

  const pendingReview = await getMovementsPendingWaterfallReview(user.id)
  const waterfall_review = {
    count: pendingReview.length,
    movements: pendingReview.slice(0, WATERFALL_REVIEW_PREVIEW),
  }

  // reconciliationStatus already fetched above and we know is_running is false here

  const lifetimeArTotal = enrichedInvoices.reduce((s, i) => s + i.amount, 0)
  const lifetimeArReconciled = enrichedInvoices
    .filter(i => i.reconciliation_status === "matched" || i.reconciliation_status === "partial")
    .reduce((s, i) => s + i.amount, 0)
  const lifetimeArPaid = paidInvoices.reduce((s, i) => s + i.amount, 0)

  const lifetimeApTotal = enrichedBills.reduce((s, b) => s + b.amount, 0)
  const lifetimeApReconciled = enrichedBills
    .filter(b => b.reconciliation_status === "matched" || b.reconciliation_status === "partial")
    .reduce((s, b) => s + b.amount, 0)
  const lifetimeApPaid = paidBills.reduce((s, b) => s + b.amount, 0)

  const lifetime = {
    ar: {
      total: r2(lifetimeArTotal),
      reconciled: r2(lifetimeArReconciled),
      reconciled_pct: lifetimeArTotal > 0 ? r2((lifetimeArReconciled / lifetimeArTotal) * 100) : 0,
      paid: r2(lifetimeArPaid),
      paid_pct: lifetimeArTotal > 0 ? r2((lifetimeArPaid / lifetimeArTotal) * 100) : 0,
      outstanding: r2(lifetimeArTotal - lifetimeArPaid),
      invoice_count: enrichedInvoices.length,
      paid_count: paidInvoices.length,
      open_count: openInvoices.length,
    },
    ap: {
      total: r2(lifetimeApTotal),
      reconciled: r2(lifetimeApReconciled),
      reconciled_pct: lifetimeApTotal > 0 ? r2((lifetimeApReconciled / lifetimeApTotal) * 100) : 0,
      paid: r2(lifetimeApPaid),
      paid_pct: lifetimeApTotal > 0 ? r2((lifetimeApPaid / lifetimeApTotal) * 100) : 0,
      outstanding: r2(lifetimeApTotal - lifetimeApPaid),
      bill_count: enrichedBills.length,
      paid_count: paidBills.length,
      open_count: openBills.length,
    },
  }

  return NextResponse.json({
    ar: {
      ...ar,
      invoices: openInvoices,
      paid_invoices: paidInvoices,
      reconciliation_summary: arReconciliationSummary,
    },
    ap,
    recon,
    lifetime,
    excluded_categories: excludedCategories,
    transfer_pairs: transferPairs,
    waterfall_review,
    is_reconciling: reconciliationStatus.is_running,
    reconciliation_status: reconciliationStatus,
  })
}

function computeReconciliationSummary(invoices: OutstandingInvoice[]) {
  const total = invoices.length
  const matched = invoices.filter((i) => i.reconciliation_status === "matched").length
  const partial = invoices.filter((i) => i.reconciliation_status === "partial").length
  const unmatched = invoices.filter((i) => i.reconciliation_status === "unmatched" || !i.reconciliation_status).length

  const matchedAmount = invoices
    .filter((i) => i.reconciliation_status === "matched")
    .reduce((sum, i) => sum + i.amount, 0)
  const partialMatchedAmount = invoices
    .filter((i) => i.reconciliation_status === "partial")
    .reduce((sum, i) => sum + (i.matched_amount ?? 0), 0)
  const partialUnmatchedAmount = invoices
    .filter((i) => i.reconciliation_status === "partial")
    .reduce((sum, i) => sum + Math.max(0, i.amount - (i.matched_amount ?? 0)), 0)
  const unmatchedAmount = invoices
    .filter((i) => i.reconciliation_status === "unmatched" || !i.reconciliation_status)
    .reduce((sum, i) => sum + i.amount, 0)
  const partialAmount = partialMatchedAmount

  // Bank-verified outstanding calculation
  // Accounting outstanding = sum of amount_due for open/partially_paid invoices
  const accountingOutstanding = invoices
    .filter((i) => i.status !== "paid")
    .reduce((sum, i) => sum + i.amount_due, 0)

  // For open invoices that are matched/partial, calculate how much has been verified by bank
  // Cap matched_amount at the invoice amount to avoid over-counting from entity-level matching
  const openInvoicesMatched = invoices
    .filter((i) => i.status !== "paid" && (i.reconciliation_status === "matched" || i.reconciliation_status === "partial"))
    .reduce((sum, i) => {
      const matchedAmt = i.matched_amount ?? 0
      // Cap at invoice amount to prevent over-counting
      return sum + Math.min(matchedAmt, i.amount_due)
    }, 0)

  // Bank-verified outstanding = what accounting says is outstanding minus what bank has verified
  const bankVerifiedOutstanding = Math.max(0, accountingOutstanding - openInvoicesMatched)

  // Total bank-verified matched across all invoices (for display purposes)
  const bankVerifiedMatched = invoices
    .filter((i) => i.reconciliation_status === "matched" || i.reconciliation_status === "partial")
    .reduce((sum, i) => sum + Math.min(i.matched_amount ?? 0, i.amount), 0)

  // Suspicious: paid in accounting but no bank match
  const suspicious = invoices.filter(
    (i) => i.status === "paid" && (i.reconciliation_status === "unmatched" || !i.reconciliation_status)
  )
  const suspiciousAmount = suspicious.reduce((sum, i) => sum + i.amount, 0)

  // Discrepancy: difference between accounting outstanding and bank-verified outstanding
  const discrepancy = accountingOutstanding - bankVerifiedOutstanding

  return {
    total_invoices: total,
    matched_count: matched,
    partial_count: partial,
    unmatched_count: unmatched,
    matched_amount: r2(matchedAmount),
    partial_matched_amount: r2(partialAmount),
    unmatched_amount: r2(unmatchedAmount),
    // Fix: Weight match_rate by dollar amount, not just count
    match_rate: (matchedAmount + partialAmount + unmatchedAmount + partialUnmatchedAmount) > 0 
      ? r2((matchedAmount + partialAmount) / (matchedAmount + partialAmount + unmatchedAmount + partialUnmatchedAmount) * 100) 
      : 0,
    // New bank-verified fields
    accounting_outstanding: r2(accountingOutstanding),
    bank_verified_outstanding: r2(bankVerifiedOutstanding),
    bank_verified_matched: r2(bankVerifiedMatched),
    discrepancy: r2(discrepancy),
    suspicious_count: suspicious.length,
    suspicious_amount: r2(suspiciousAmount),
  }
}

function computeApReconciliationSummary(bills: OutstandingBill[]) {
  const total = bills.length
  const matched = bills.filter((b) => b.reconciliation_status === "matched").length
  const partial = bills.filter((b) => b.reconciliation_status === "partial").length
  const unmatched = bills.filter((b) => b.reconciliation_status === "unmatched" || !b.reconciliation_status).length

  const matchedAmount = bills
    .filter((b) => b.reconciliation_status === "matched")
    .reduce((sum, b) => sum + b.amount, 0)
  const partialMatchedAmount = bills
    .filter((b) => b.reconciliation_status === "partial")
    .reduce((sum, b) => sum + (b.matched_amount ?? 0), 0)
  const partialUnmatchedAmount = bills
    .filter((b) => b.reconciliation_status === "partial")
    .reduce((sum, b) => sum + Math.max(0, b.amount - (b.matched_amount ?? 0)), 0)
  const unmatchedAmount = bills
    .filter((b) => b.reconciliation_status === "unmatched" || !b.reconciliation_status)
    .reduce((sum, b) => sum + b.amount, 0)
  const partialAmount = partialMatchedAmount

  // Bank-verified outstanding calculation for AP
  // accountingOutstanding = sum of amount_due for open bills
  const accountingOutstanding = bills
    .filter((b) => b.status !== "paid")
    .reduce((sum, b) => sum + b.amount_due, 0)

  // For open bills that are matched/partial, calculate how much has been verified by bank
  // Cap matched_amount at the bill amount to avoid over-counting from entity-level matching
  const openBillsMatched = bills
    .filter((b) => b.status !== "paid" && (b.reconciliation_status === "matched" || b.reconciliation_status === "partial"))
    .reduce((sum, b) => {
      const matchedAmt = b.matched_amount ?? 0
      // Cap at bill amount to prevent over-counting
      return sum + Math.min(matchedAmt, b.amount_due)
    }, 0)

  // Bank-verified outstanding = what accounting says is outstanding minus what bank has verified
  const bankVerifiedOutstanding = Math.max(0, accountingOutstanding - openBillsMatched)

  // Total bank-verified matched across all bills (for display purposes)
  const bankVerifiedMatched = bills
    .filter((b) => b.reconciliation_status === "matched" || b.reconciliation_status === "partial")
    .reduce((sum, b) => sum + Math.min(b.matched_amount ?? 0, b.amount), 0)

  // Suspicious: paid in accounting but no bank match
  const suspicious = bills.filter(
    (b) => b.status === "paid" && (b.reconciliation_status === "unmatched" || !b.reconciliation_status)
  )
  const suspiciousAmount = suspicious.reduce((sum, b) => sum + b.amount, 0)

  // Discrepancy: difference between accounting outstanding and bank-verified outstanding
  const discrepancy = accountingOutstanding - bankVerifiedOutstanding

  return {
    total_bills: total,
    matched_count: matched,
    partial_count: partial,
    unmatched_count: unmatched,
    matched_amount: r2(matchedAmount),
    partial_matched_amount: r2(partialAmount),
    unmatched_amount: r2(unmatchedAmount),
    // Fix: Weight match_rate by dollar amount, not just count
    match_rate: (matchedAmount + partialAmount + unmatchedAmount + partialUnmatchedAmount) > 0 
      ? r2((matchedAmount + partialAmount) / (matchedAmount + partialAmount + unmatchedAmount + partialUnmatchedAmount) * 100) 
      : 0,
    // New bank-verified fields
    accounting_outstanding: r2(accountingOutstanding),
    bank_verified_outstanding: r2(bankVerifiedOutstanding),
    bank_verified_matched: r2(bankVerifiedMatched),
    discrepancy: r2(discrepancy),
    suspicious_count: suspicious.length,
    suspicious_amount: r2(suspiciousAmount),
  }
}

async function fetchReconTotals(userId: string): Promise<ReconTotals> {
  const totals: any = {
    total_matched_inflows: 0,
    total_matched_outflows: 0,
    total_unmatched_inflows: 0,
    total_unmatched_outflows: 0,
    total_excluded_inflows: 0,
    total_excluded_outflows: 0,
    total_fees_paid: 0,
    count_matched_inflows: 0,
    count_matched_outflows: 0,
    count_unmatched_inflows: 0,
    count_unmatched_outflows: 0,
    count_excluded_inflows: 0,
    count_excluded_outflows: 0,
  }

  const { rows: matchedRows } = await query<{
    inflow: string
    outflow: string
    fees: string
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN m.direction = 'inflow'  AND a.component_type IN ('ar', 'settlement') THEN ABS(a.net_amount::float) ELSE 0 END), 0)::text AS inflow,
       COALESCE(SUM(CASE WHEN m.direction = 'outflow' AND a.component_type IN ('ap', 'settlement') THEN ABS(a.net_amount::float) ELSE 0 END), 0)::text AS outflow,
       COALESCE(SUM(CASE WHEN a.component_type = 'fee' THEN ABS(a.net_amount::float) ELSE 0 END), 0)::text AS fees
     FROM movement_attributions a
     JOIN movements m ON m.id = a.movement_id AND m.user_id = a.user_id
     WHERE a.user_id = $1 AND m.duplicate_of IS NULL`,
    [userId],
  )
  if (matchedRows[0]) {
    totals.total_matched_inflows = r2(parseFloat(matchedRows[0].inflow) || 0)
    totals.total_matched_outflows = r2(parseFloat(matchedRows[0].outflow) || 0)
    totals.total_fees_paid = r2(parseFloat(matchedRows[0].fees) || 0)
  }

  const lists = await fetchReconciliationMovementRows(userId)
  // Fix: Use dollar amounts instead of counts for unmatched totals
  totals.total_unmatched_inflows = r2(lists.unmatched_inflows.reduce((s, r) => s + Math.abs(r.amount), 0))
  totals.total_unmatched_outflows = r2(lists.unmatched_outflows.reduce((s, r) => s + Math.abs(r.amount), 0))
  totals.total_excluded_inflows = r2(lists.excluded_inflows.reduce((s, r) => s + Math.abs(r.amount), 0))
  totals.total_excluded_outflows = r2(lists.excluded_outflows.reduce((s, r) => s + Math.abs(r.amount), 0))
  // Keep counts as separate fields for reference
  totals.count_matched_inflows = lists.matched_inflows.length
  totals.count_matched_outflows = lists.matched_outflows.length
  totals.count_unmatched_inflows = lists.unmatched_inflows.length
  totals.count_unmatched_outflows = lists.unmatched_outflows.length
  totals.count_excluded_inflows = lists.excluded_inflows.length
  totals.count_excluded_outflows = lists.excluded_outflows.length

  // Limit lists to prevent huge responses - return first 500 of each category
  const MAX_MOVEMENT_ROWS = 500
  return {
    ...totals,
    matched_inflows: lists.matched_inflows.slice(0, MAX_MOVEMENT_ROWS),
    matched_outflows: lists.matched_outflows.slice(0, MAX_MOVEMENT_ROWS),
    unmatched_inflows: lists.unmatched_inflows.slice(0, MAX_MOVEMENT_ROWS),
    unmatched_outflows: lists.unmatched_outflows.slice(0, MAX_MOVEMENT_ROWS),
    excluded_inflows: lists.excluded_inflows.slice(0, MAX_MOVEMENT_ROWS),
    excluded_outflows: lists.excluded_outflows.slice(0, MAX_MOVEMENT_ROWS),
  }
}

type ExcludedMovement = {
  id: string
  amount: number
  date: string
  counterparty: string | null
  direction: "inflow" | "outflow"
  economic_class: string
  cashflow_bucket: string | null
}

type ExcludedCategories = {
  transfers: ExcludedMovement[]
  owner_activity: ExcludedMovement[]
  fees_and_interest: ExcludedMovement[]
  processor_settlements: ExcludedMovement[]
  totals: {
    transfers_count: number
    transfers_amount: number
    owner_activity_count: number
    owner_activity_amount: number
    fees_and_interest_count: number
    fees_and_interest_amount: number
    processor_settlements_count: number
    processor_settlements_amount: number
  }
}

async function fetchExcludedCategories(userId: string): Promise<ExcludedCategories> {
  const { rows } = await query<{
    id: string
    amount: string
    date: string
    counterparty: string | null
    direction: string
    economic_class: string
    cashflow_bucket: string | null
  }>(
    `SELECT m.id, ABS(m.amount::float)::text AS amount, m.date::text, m.counterparty, m.direction,
            mt.economic_class, mt.cashflow_bucket
     FROM movements m
     JOIN movement_tags mt ON mt.movement_id = m.id AND mt.user_id = m.user_id
     WHERE m.user_id = $1
       AND m.duplicate_of IS NULL
       AND mt.economic_class IN (
         'transfer', 'owner_draw', 'owner_contribution', 
         'bank_fee', 'bank_fee_refund', 'interest', 
         'processor_fee', 'processor_payout',
         'opening_balance', 'account_verification', 'system_adjustment', 'settlement_in', 'settlement_adjustment'
       )
     ORDER BY m.date DESC
     LIMIT 200`,
    [userId],
  )

  const movements: ExcludedMovement[] = rows.map((r) => ({
    id: r.id,
    amount: parseFloat(r.amount),
    date: r.date,
    counterparty: r.counterparty,
    direction: r.direction as "inflow" | "outflow",
    economic_class: r.economic_class,
    cashflow_bucket: r.cashflow_bucket,
  }))

  const transfers = movements.filter((m) => m.economic_class === "transfer")
  const ownerActivity = movements.filter((m) => 
    m.economic_class === "owner_draw" || m.economic_class === "owner_contribution"
  )
  const feesAndInterest = movements.filter((m) => 
    m.economic_class === "bank_fee" || 
    m.economic_class === "bank_fee_refund" || 
    m.economic_class === "interest"
  )
  const processorSettlements = movements.filter((m) => 
    m.economic_class === "processor_fee" || m.economic_class === "processor_payout"
  )

  return {
    transfers: transfers.slice(0, 50),
    owner_activity: ownerActivity.slice(0, 50),
    fees_and_interest: feesAndInterest.slice(0, 50),
    processor_settlements: processorSettlements.slice(0, 50),
    totals: {
      transfers_count: transfers.length,
      transfers_amount: r2(transfers.reduce((sum, m) => sum + m.amount, 0)),
      owner_activity_count: ownerActivity.length,
      owner_activity_amount: r2(ownerActivity.reduce((sum, m) => sum + m.amount, 0)),
      fees_and_interest_count: feesAndInterest.length,
      fees_and_interest_amount: r2(feesAndInterest.reduce((sum, m) => sum + m.amount, 0)),
      processor_settlements_count: processorSettlements.length,
      processor_settlements_amount: r2(processorSettlements.reduce((sum, m) => sum + m.amount, 0)),
    },
  }
}

type TransferPair = {
  outflow_id: string
  inflow_id: string
  amount: number
  date: string
  counterparty: string | null
  days_apart: number
}

type TransferPairsResult = {
  pairs: TransferPair[]
  unpaired_transfers: ExcludedMovement[]
  total_paired_amount: number
  total_unpaired_amount: number
}

async function fetchTransferPairs(userId: string): Promise<TransferPairsResult> {
  // Find transfer pairs: same amount, opposite direction, within 3 days
  const { rows: pairRows } = await query<{
    outflow_id: string
    inflow_id: string
    amount: string
    outflow_date: string
    inflow_date: string
    counterparty: string | null
    days_apart: string
  }>(
    `WITH transfer_movements AS (
      SELECT m.id, m.amount, m.date, m.counterparty, m.direction
      FROM movements m
      JOIN movement_tags mt ON mt.movement_id = m.id AND mt.user_id = m.user_id
      WHERE m.user_id = $1
        AND m.duplicate_of IS NULL
        AND mt.economic_class = 'transfer'
    )
    SELECT 
      m1.id as outflow_id, 
      m2.id as inflow_id,
      ABS(m1.amount::float)::text AS amount, 
      m1.date::text as outflow_date,
      m2.date::text as inflow_date,
      COALESCE(m1.counterparty, m2.counterparty) as counterparty,
      ABS(m2.date - m1.date)::text as days_apart
    FROM transfer_movements m1
    JOIN transfer_movements m2 ON 
      ABS(ABS(m1.amount::float) - ABS(m2.amount::float)) < 0.01
      AND m1.direction = 'outflow' 
      AND m2.direction = 'inflow'
      AND ABS(m2.date - m1.date) <= 3
      AND m1.id < m2.id
    ORDER BY m1.date DESC
    LIMIT 50`,
    [userId],
  )

  const pairs: TransferPair[] = pairRows.map((r) => ({
    outflow_id: r.outflow_id,
    inflow_id: r.inflow_id,
    amount: parseFloat(r.amount),
    date: r.outflow_date,
    counterparty: r.counterparty,
    days_apart: parseInt(r.days_apart, 10),
  }))

  // Find paired movement IDs
  const pairedIds = new Set<string>()
  for (const p of pairs) {
    pairedIds.add(p.outflow_id)
    pairedIds.add(p.inflow_id)
  }

  // Get unpaired transfers
  const { rows: unpairedRows } = await query<{
    id: string
    amount: string
    date: string
    counterparty: string | null
    direction: string
    economic_class: string
    cashflow_bucket: string | null
  }>(
    `SELECT m.id, ABS(m.amount::float)::text AS amount, m.date::text, m.counterparty, m.direction,
            mt.economic_class, mt.cashflow_bucket
     FROM movements m
     JOIN movement_tags mt ON mt.movement_id = m.id AND mt.user_id = m.user_id
     WHERE m.user_id = $1
       AND m.duplicate_of IS NULL
       AND mt.economic_class = 'transfer'
     ORDER BY m.date DESC
     LIMIT 100`,
    [userId],
  )

  const unpairedTransfers: ExcludedMovement[] = unpairedRows
    .filter((r) => !pairedIds.has(r.id))
    .map((r) => ({
      id: r.id,
      amount: parseFloat(r.amount),
      date: r.date,
      counterparty: r.counterparty,
      direction: r.direction as "inflow" | "outflow",
      economic_class: r.economic_class,
      cashflow_bucket: r.cashflow_bucket,
    }))
    .slice(0, 50)

  const totalPairedAmount = pairs.reduce((sum, p) => sum + p.amount, 0)
  const totalUnpairedAmount = unpairedTransfers.reduce((sum, t) => sum + t.amount, 0)

  return {
    pairs,
    unpaired_transfers: unpairedTransfers,
    total_paired_amount: r2(totalPairedAmount),
    total_unpaired_amount: r2(totalUnpairedAmount),
  }
}
