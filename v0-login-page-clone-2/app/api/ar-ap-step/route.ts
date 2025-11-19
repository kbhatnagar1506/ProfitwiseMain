import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema } from "@/lib/db"
import { fetchInvoicesForReconciliation, enrichInvoicesWithReconciliationStatus } from "@/lib/invoices-fetch"
import { fetchOutstandingBills } from "@/lib/bills-fetch"
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
import type { OutstandingInvoice } from "@/lib/state/types"

const WATERFALL_REVIEW_PREVIEW = 15

type ReconTotals = {
  total_matched_inflows: number
  total_matched_outflows: number
  total_unmatched_inflows: number
  total_unmatched_outflows: number
  total_fees_paid: number
  matched_inflows: ReconMovementRow[]
  matched_outflows: ReconMovementRow[]
  unmatched_inflows: ReconMovementRow[]
  unmatched_outflows: ReconMovementRow[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

const reconInProgress = new Map<string, boolean>()

async function runReconciliationInBackground(userId: string) {
  if (reconInProgress.get(userId)) {
    console.log("[ar-ap-step] Reconciliation already in progress for user:", userId)
    return
  }
  
  reconInProgress.set(userId, true)
  console.log("[ar-ap-step] Starting background reconciliation for user:", userId)
  
  try {
    const invoices = await fetchInvoicesForReconciliation(userId)
    const bills = await fetchOutstandingBills(userId)
    const obligations = computeAPStateFromBills(bills)
    
    await refreshEntityAliasesFromAccounting(userId)
    await refreshMovementEntityIds(userId)
    
    await runFinancialBrain(userId, {
      outstandingInvoices: invoices,
      apObligations: obligations,
    })
    
    console.log("[ar-ap-step] Background reconciliation completed for user:", userId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[ar-ap-step] Background reconciliation failed:", msg)
  } finally {
    reconInProgress.delete(userId)
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

  if (runRecon) {
    runReconciliationInBackground(user.id).catch((e) => {
      console.error("[ar-ap-step] Background task error:", e)
    })
  }

  const invoices = await fetchInvoicesForReconciliation(user.id)
  const bills = await fetchOutstandingBills(user.id)
  const obligations = computeAPStateFromBills(bills)

  const enrichedInvoices = await enrichInvoicesWithReconciliationStatus(user.id, invoices)

  const openInvoices = enrichedInvoices.filter((i) => i.status !== "paid")
  const paidInvoices = enrichedInvoices.filter((i) => i.status === "paid")

  const ar = computeARState(openInvoices)

  const reconciliationSummary = computeReconciliationSummary(enrichedInvoices)

  const ap = {
    total_expected_30d: r2(obligations.reduce((s, o) => s + o.expected_amount, 0)),
    obligation_count: obligations.length,
    obligations: obligations.sort((a, b) => a.days_until_due - b.days_until_due),
  }

  const recon = await fetchReconTotals(user.id)

  const pendingReview = await getMovementsPendingWaterfallReview(user.id)
  const waterfall_review = {
    count: pendingReview.length,
    movements: pendingReview.slice(0, WATERFALL_REVIEW_PREVIEW),
  }

  const isReconciling = reconInProgress.get(user.id) ?? false

  return NextResponse.json({
    ar: {
      ...ar,
      invoices: openInvoices,
      paid_invoices: paidInvoices,
      reconciliation_summary: reconciliationSummary,
    },
    ap,
    recon,
    waterfall_review,
    is_reconciling: isReconciling,
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
  const unmatchedAmount = invoices
    .filter((i) => i.reconciliation_status === "unmatched" || !i.reconciliation_status)
    .reduce((sum, i) => sum + i.amount, 0)
  const partialAmount = invoices
    .filter((i) => i.reconciliation_status === "partial")
    .reduce((sum, i) => sum + (i.matched_amount ?? 0), 0)

  return {
    total_invoices: total,
    matched_count: matched,
    partial_count: partial,
    unmatched_count: unmatched,
    matched_amount: r2(matchedAmount),
    partial_matched_amount: r2(partialAmount),
    unmatched_amount: r2(unmatchedAmount),
    match_rate: total > 0 ? r2((matched + partial) / total * 100) : 0,
  }
}

async function fetchReconTotals(userId: string): Promise<ReconTotals> {
  const totals = {
    total_matched_inflows: 0,
    total_matched_outflows: 0,
    total_unmatched_inflows: 0,
    total_unmatched_outflows: 0,
    total_fees_paid: 0,
  }

  const { rows: matchedRows } = await query<{
    inflow: string
    outflow: string
    fees: string
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN m.direction = 'inflow'  AND a.component_type = 'ar' THEN ABS(a.net_amount::float) ELSE 0 END), 0)::text AS inflow,
       COALESCE(SUM(CASE WHEN m.direction = 'outflow' AND a.component_type = 'ap' THEN ABS(a.net_amount::float) ELSE 0 END), 0)::text AS outflow,
       COALESCE(SUM(CASE WHEN a.component_type = 'fee' THEN ABS(a.net_amount::float) ELSE 0 END), 0)::text AS fees
     FROM movement_attributions a
     JOIN movements m ON m.id = a.movement_id AND m.user_id = a.user_id
     WHERE a.user_id = $1`,
    [userId],
  )
  if (matchedRows[0]) {
    totals.total_matched_inflows = r2(parseFloat(matchedRows[0].inflow) || 0)
    totals.total_matched_outflows = r2(parseFloat(matchedRows[0].outflow) || 0)
    totals.total_fees_paid = r2(parseFloat(matchedRows[0].fees) || 0)
  }

  const lists = await fetchReconciliationMovementRows(userId)
  totals.total_unmatched_inflows = lists.unmatched_inflows.length
  totals.total_unmatched_outflows = lists.unmatched_outflows.length

  return {
    ...totals,
    matched_inflows: lists.matched_inflows,
    matched_outflows: lists.matched_outflows,
    unmatched_inflows: lists.unmatched_inflows,
    unmatched_outflows: lists.unmatched_outflows,
  }
}
