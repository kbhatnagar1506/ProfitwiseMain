/**
 * AI Reconciliation Matcher API
 * 
 * POST: Start a background AI matching job
 * GET: Check job status and get results
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureARMatchesSchema } from "@/lib/db"
import { classifyMovement, type CashEventRow } from "@/lib/reconciliation-case-classifier"
import { runAIReconciliationMatcher, type MovementToMatch, type AIMatcherResult } from "@/lib/reconciliation-ai-matcher"
import { syncCashEventsForUser } from "@/lib/cash-events-build"
import { fetchInvoicesForReconciliation } from "@/lib/invoices-fetch"

// In-memory job store (in production, use Redis or database)
const jobStore = new Map<string, {
  status: "pending" | "processing" | "completed" | "failed"
  progress: number
  total: number
  result: AIMatcherResult | null
  error: string | null
  startedAt: number
  completedAt: number | null
}>()

// Clean up old jobs after 1 hour
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  for (const [jobId, job] of jobStore.entries()) {
    if (job.startedAt < oneHourAgo) {
      jobStore.delete(jobId)
    }
  }
}, 5 * 60 * 1000) // Check every 5 minutes

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = user.id
    const body = await request.json().catch(() => ({}))
    // Don't limit by default - let the matcher handle dynamic sizing
    const maxMovements = body.maxMovements || 2000

    // Generate job ID
    const jobId = `ai-match-${userId}-${Date.now()}`

    // Initialize job
    jobStore.set(jobId, {
      status: "pending",
      progress: 0,
      total: 0,
      result: null,
      error: null,
      startedAt: Date.now(),
      completedAt: null
    })

    // Start background processing
    processAIMatching(jobId, userId, maxMovements).catch(error => {
      console.error(`[AI Matcher Job ${jobId}] Fatal error:`, error)
      const job = jobStore.get(jobId)
      if (job) {
        job.status = "failed"
        job.error = error instanceof Error ? error.message : String(error)
        job.completedAt = Date.now()
      }
    })

    return NextResponse.json({
      jobId,
      status: "pending",
      message: "AI matching job started"
    })

  } catch (error) {
    console.error("[AI Matcher] Error starting job:", error)
    return NextResponse.json({ error: "Failed to start AI matching job" }, { status: 500 })
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const url = new URL(request.url)
    const jobId = url.searchParams.get("jobId")

    if (!jobId) {
      return NextResponse.json({ error: "jobId required" }, { status: 400 })
    }

    const job = jobStore.get(jobId)
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    return NextResponse.json({
      jobId,
      status: job.status,
      progress: job.progress,
      total: job.total,
      result: job.result,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      elapsedMs: job.completedAt ? job.completedAt - job.startedAt : Date.now() - job.startedAt
    })

  } catch (error) {
    console.error("[AI Matcher] Error checking job:", error)
    return NextResponse.json({ error: "Failed to check job status" }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Background Processing
// ─────────────────────────────────────────────────────────────────────────────

async function processAIMatching(
  jobId: string,
  userId: string,
  maxMovements: number
): Promise<void> {
  const job = jobStore.get(jobId)
  if (!job) return

  job.status = "processing"
  console.log(`[AI Matcher Job ${jobId}] Starting...`)

  try {
    // Sync cash events from QBO/Xero before processing
    console.log(`[AI Matcher Job ${jobId}] Syncing invoices from accounting system...`)
    try {
      const invoices = await fetchInvoicesForReconciliation(userId)
      await syncCashEventsForUser(userId, invoices, [])
      console.log(`[AI Matcher Job ${jobId}] Synced ${invoices.length} invoices`)
    } catch (syncErr) {
      console.warn(`[AI Matcher Job ${jobId}] Invoice sync failed (continuing with existing data):`, syncErr)
    }

    // Clear existing matches before re-running (fresh start each time)
    console.log(`[AI Matcher Job ${jobId}] Clearing existing AR matches...`)
    const deleteResult = await query(
      `DELETE FROM ar_reconciliation_matches WHERE user_id = $1`,
      [userId]
    )
    console.log(`[AI Matcher Job ${jobId}] Deleted ${deleteResult.rowCount || 0} existing matches`)

    // Load movements
    const movements = await fetchMovementsWithAvailableCash(userId)
    const cashEvents = await loadCashEvents(userId)

    console.log(`[AI Matcher Job ${jobId}] Loaded ${movements.length} movements, ${cashEvents.length} cash events`)

    // Classify movements
    const movementsToMatch: MovementToMatch[] = []
    
    for (const movement of movements) {
      const classification = classifyMovement(movement, cashEvents, movements)
      
      movementsToMatch.push({
        id: movement.id,
        counterparty: movement.counterparty,
        raw_description: movement.raw_description,
        amount: movement.amount,
        direction: movement.direction,
        date: movement.date,
        classification
      })
    }

    job.total = Math.min(movementsToMatch.length, maxMovements)
    console.log(`[AI Matcher Job ${jobId}] Processing ${job.total} movements`)

    // Run AI matcher - let it determine batch size dynamically
    const result = await runAIReconciliationMatcher(userId, movementsToMatch, {
      maxMovements,
      includeSupermemory: true
    })

    // Save matches to database
    await saveMatchesToDatabase(userId, result, movementsToMatch, cashEvents)

    job.status = "completed"
    job.result = result
    job.completedAt = Date.now()
    job.progress = job.total

    console.log(`[AI Matcher Job ${jobId}] Completed in ${result.processing_time_ms}ms`)
    console.log(`[AI Matcher Job ${jobId}] Results: ${result.matches.length} decisions, ${result.errors.length} errors`)

  } catch (error) {
    job.status = "failed"
    job.error = error instanceof Error ? error.message : String(error)
    job.completedAt = Date.now()
    console.error(`[AI Matcher Job ${jobId}] Failed:`, error)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Loading
// ─────────────────────────────────────────────────────────────────────────────

type MovementWithAvailableCash = {
  id: string
  user_id: string
  direction: "inflow" | "outflow"
  amount: number
  date: string
  movement_type: string
  counterparty: string | null
  counterparty_entity_id: string | null
  raw_description: string | null
  metadata: Record<string, unknown>
  available_cash: number
  economic_class: string | null
  tag_data: Record<string, unknown> | null
}

const EPS = 0.01

async function fetchMovementsWithAvailableCash(userId: string): Promise<MovementWithAvailableCash[]> {
  const result = await query(
    `SELECT
       m.id,
       m.user_id,
       m.direction,
       m.amount::float as amount,
       m.date,
       m.movement_type,
       m.counterparty,
       m.counterparty_entity_id,
       m.raw_description,
       m.metadata,
       mt.economic_class,
       mt.tag_data,
       COALESCE(m.amount - COALESCE(attr_sum.total_attributed, 0), m.amount)::float as available_cash
     FROM movements m
     LEFT JOIN movement_tags mt ON mt.movement_id = m.id
     LEFT JOIN (
       SELECT movement_id, SUM(net_amount) as total_attributed
       FROM movement_attributions
       WHERE source = 'rule'
       GROUP BY movement_id
     ) attr_sum ON attr_sum.movement_id = m.id
     WHERE m.user_id = $1
       AND COALESCE(m.amount - COALESCE(attr_sum.total_attributed, 0), m.amount) > $2
     ORDER BY m.date DESC`,
    [userId, EPS]
  )
  return result.rows as MovementWithAvailableCash[]
}

async function loadCashEvents(userId: string): Promise<CashEventRow[]> {
  // AR ONLY - Load invoices for matching against customer payments
  // AP (bills) are NOT loaded because:
  // 1. AP reconciliation doesn't make sense (bills created from payments)
  // 2. AP goes through vendor classification → forecast instead
  const result = await query(
    `SELECT
       id,
       user_id,
       entity_id,
       event_type,
       amount::float as amount,
       outstanding_amount::float as outstanding_amount,
       status,
       expected_date,
       metadata
     FROM cash_events
     WHERE user_id = $1
       AND event_type = 'ar'
     ORDER BY expected_date ASC`,
    [userId]
  )
  return result.rows as CashEventRow[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Save Matches to Database
// ─────────────────────────────────────────────────────────────────────────────

interface ExistingMatchInfo {
  cash_event_id: string
  match_type: string
  total_matched: number
}

interface ExistingMovementMatchInfo {
  movement_id: string
  total_matched: number
}

async function getExistingMatchesForInvoices(userId: string): Promise<Map<string, ExistingMatchInfo>> {
  const result = await query(
    `SELECT 
      cash_event_id,
      MAX(match_type) as match_type,
      SUM(matched_amount)::float as total_matched
    FROM ar_reconciliation_matches
    WHERE user_id = $1
    GROUP BY cash_event_id`,
    [userId]
  )
  
  const map = new Map<string, ExistingMatchInfo>()
  for (const row of result.rows) {
    map.set(row.cash_event_id, {
      cash_event_id: row.cash_event_id,
      match_type: row.match_type,
      total_matched: row.total_matched || 0
    })
  }
  return map
}

async function getExistingMatchesForMovements(userId: string): Promise<Map<string, ExistingMovementMatchInfo>> {
  const result = await query(
    `SELECT 
      movement_id,
      SUM(matched_amount)::float as total_matched
    FROM ar_reconciliation_matches
    WHERE user_id = $1
    GROUP BY movement_id`,
    [userId]
  )
  
  const map = new Map<string, ExistingMovementMatchInfo>()
  for (const row of result.rows) {
    map.set(row.movement_id, {
      movement_id: row.movement_id,
      total_matched: row.total_matched || 0
    })
  }
  return map
}

function canAddMatchToInvoice(
  invoiceId: string,
  invoiceAmount: number,
  existingMatches: Map<string, ExistingMatchInfo>,
  newMatchType: string
): { allowed: boolean; reason: string } {
  const existing = existingMatches.get(invoiceId)
  
  if (!existing) {
    return { allowed: true, reason: "No existing match" }
  }
  
  // EXACT or FEE match = invoice fully matched, no more matches allowed
  if (existing.match_type === "EXACT" || existing.match_type === "FEE") {
    return { allowed: false, reason: `Invoice already has ${existing.match_type} match (fully paid)` }
  }
  
  // AGGREGATION match = invoice was part of aggregated payment, fully consumed
  if (existing.match_type === "AGGREGATION") {
    return { allowed: false, reason: "Invoice already consumed in aggregated payment" }
  }
  
  // PARTIAL match = check if there's remaining balance
  if (existing.match_type === "PARTIAL") {
    const remaining = invoiceAmount - existing.total_matched
    if (remaining <= 0.01) {
      return { allowed: false, reason: "Invoice fully paid via partial payments" }
    }
    return { allowed: true, reason: `Partial match allowed, remaining: ${remaining.toFixed(2)}` }
  }
  
  return { allowed: true, reason: "Unknown match type, allowing" }
}

function determineMatchType(
  paymentAmount: number,
  invoiceAmount: number,
  reasoning: string,
  aiMatchType?: string
): string {
  // If AI explicitly provided a match type, use it
  if (aiMatchType && ["EXACT", "FEE", "PARTIAL", "AGGREGATION"].includes(aiMatchType.toUpperCase())) {
    return aiMatchType.toUpperCase()
  }
  
  const diff = Math.abs(paymentAmount - invoiceAmount)
  const reasoningLower = reasoning.toLowerCase()
  
  // Check reasoning first
  if (reasoningLower.includes("partial") || reasoningLower.includes("fifo")) {
    return "PARTIAL"
  }
  if (reasoningLower.includes("aggregat") || reasoningLower.includes("multiple invoices")) {
    return "AGGREGATION"
  }
  
  // Exact match (within $0.01)
  if (diff <= 0.01) {
    return "EXACT"
  }
  
  // Payment less than invoice = partial payment
  if (paymentAmount < invoiceAmount - 0.01) {
    return "PARTIAL"
  }
  
  // Payment more than invoice but close = fee adjusted
  if (paymentAmount > invoiceAmount && diff < invoiceAmount * 0.1) {
    return "FEE"
  }
  
  // Payment significantly more than invoice = likely aggregation
  if (paymentAmount > invoiceAmount * 1.5) {
    return "AGGREGATION"
  }
  
  // Default to FEE for small differences
  return "FEE"
}

async function saveMatchesToDatabase(
  userId: string,
  result: AIMatcherResult,
  movementsToMatch: MovementToMatch[],
  cashEvents: CashEventRow[]
): Promise<void> {
  // Ensure schema exists
  await ensureARMatchesSchema()
  
  // Create lookup maps
  const movementMap = new Map(movementsToMatch.map(m => [m.id, m]))
  const cashEventMap = new Map(cashEvents.map(ce => [ce.id, ce]))
  
  // Build a set of valid candidate IDs for each movement (for validation)
  const validCandidatesMap = new Map<string, Set<string>>()
  for (const m of movementsToMatch) {
    const candidateIds = new Set(m.classification.candidates.map(c => c.id))
    validCandidatesMap.set(m.id, candidateIds)
  }
  
  // Get existing matches to check for duplicates
  const existingInvoiceMatches = await getExistingMatchesForInvoices(userId)
  const existingMovementMatches = await getExistingMatchesForMovements(userId)
  
  // Track invoices and movements matched in THIS run to prevent duplicates within same batch
  const invoicesMatchedInThisRun = new Set<string>()
  const movementsMatchedInThisRun = new Map<string, number>() // movement_id -> total matched amount
  
  let savedCount = 0
  let skippedCount = 0
  let errorCount = 0
  
  for (const match of result.matches) {
    // Only save actual matches (not no_match or needs_review)
    if (match.decision !== "match") {
      continue
    }
    
    const movement = movementMap.get(match.movement_id)
    if (!movement) {
      console.warn(`[AI Matcher] Could not find movement: ${match.movement_id}`)
      errorCount++
      continue
    }
    
    // Check if this bank payment is already fully matched
    const existingMovementMatch = existingMovementMatches.get(movement.id)
    const movementMatchedThisRun = movementsMatchedInThisRun.get(movement.id) || 0
    const totalMovementMatched = (existingMovementMatch?.total_matched || 0) + movementMatchedThisRun
    
    if (totalMovementMatched >= Math.abs(movement.amount) * 0.99) {
      console.log(`[AI Matcher] Skipping - movement ${movement.id} already fully matched ($${totalMovementMatched.toFixed(2)} of $${Math.abs(movement.amount).toFixed(2)})`)
      skippedCount++
      continue
    }
    
    // Collect all invoice IDs to process (handle both single and aggregation)
    const invoiceIds: string[] = []
    if (match.matched_candidate_id) {
      invoiceIds.push(match.matched_candidate_id)
    }
    if (match.matched_candidate_ids && match.matched_candidate_ids.length > 0) {
      // Add any IDs from matched_candidate_ids that aren't already in the list
      for (const id of match.matched_candidate_ids) {
        if (!invoiceIds.includes(id)) {
          invoiceIds.push(id)
        }
      }
    }
    
    if (invoiceIds.length === 0) {
      console.warn(`[AI Matcher] Match decision has no invoice IDs: ${match.movement_id}`)
      continue
    }
    
    // Determine if this is an aggregation (multiple invoices)
    const isAggregation = invoiceIds.length > 1
    
    // Process each invoice in the match
    for (const invoiceId of invoiceIds) {
      // VALIDATION: Check if invoice exists
      const cashEvent = cashEventMap.get(invoiceId)
      if (!cashEvent) {
        console.warn(`[AI Matcher] AI returned invalid invoice ID: ${invoiceId} (not found in cash events)`)
        errorCount++
        continue
      }
      
      // VALIDATION: Check if invoice was in candidates (AI didn't hallucinate)
      const validCandidates = validCandidatesMap.get(movement.id)
      const wasCandidate = validCandidates?.has(invoiceId) || false
      let statusOverride: "confirmed" | "pending" | null = null
      
      if (!wasCandidate) {
        console.warn(`[AI Matcher] AI matched to invoice not in candidates: ${invoiceId} for movement ${movement.id}`)
        // Still save but force status to pending for review
        statusOverride = "pending"
      }
      
      // Determine match type based on amounts and reasoning
      const matchType = isAggregation 
        ? "AGGREGATION" 
        : determineMatchType(
            Math.abs(movement.amount),
            cashEvent.amount,
            match.reasoning || "",
            match.match_type
          )
      
      // Check if we can add a match to this invoice
      const canMatch = canAddMatchToInvoice(
        cashEvent.id,
        cashEvent.amount,
        existingInvoiceMatches,
        matchType
      )
      
      if (!canMatch.allowed) {
        console.log(`[AI Matcher] Skipping match for invoice ${cashEvent.id}: ${canMatch.reason}`)
        skippedCount++
        continue
      }
      
      // For EXACT and FEE matches, check if already matched in this run
      // (PARTIAL and AGGREGATION can have multiple matches)
      if ((matchType === "EXACT" || matchType === "FEE") && invoicesMatchedInThisRun.has(cashEvent.id)) {
        console.log(`[AI Matcher] Skipping duplicate ${matchType} match for invoice ${cashEvent.id} in this run`)
        skippedCount++
        continue
      }
      
      // Get invoice details from metadata
      const metadata = cashEvent.metadata as Record<string, unknown> || {}
      const invoiceDocNumber = (metadata.doc_number as string) || (metadata.invoice_number as string) || cashEvent.id
      const customerName = (metadata.customer_name as string) || (metadata.entity_name as string) || "Unknown"
      
      // Calculate fee and matched amounts based on match type
      let feeAmount = 0
      let matchedAmount = cashEvent.amount
      
      if (matchType === "FEE") {
        feeAmount = Math.abs(Math.abs(movement.amount) - cashEvent.amount)
        matchedAmount = cashEvent.amount
      } else if (matchType === "PARTIAL") {
        // For partial, matched amount is the payment amount (less than invoice)
        matchedAmount = Math.min(Math.abs(movement.amount), cashEvent.amount)
      } else if (matchType === "AGGREGATION") {
        // For aggregation, this invoice is fully consumed
        matchedAmount = cashEvent.amount
      } else {
        // EXACT
        matchedAmount = cashEvent.amount
      }
      
      // Determine status: use AI-decided status, with override for validation failures
      const finalStatus = statusOverride || match.status || (match.confidence >= 0.85 ? "confirmed" : "pending")
      
      try {
        await query(
          `INSERT INTO ar_reconciliation_matches (
            user_id, movement_id, cash_event_id,
            bank_amount, bank_date, bank_description, bank_counterparty,
            invoice_id, invoice_amount, customer_name,
            match_type, confidence, fee_amount, matched_amount,
            matched_by, ai_reasoning, status
          ) VALUES (
            $1, $2, $3,
            $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17
          )
          ON CONFLICT (movement_id, cash_event_id) DO UPDATE SET
            bank_amount = EXCLUDED.bank_amount,
            bank_date = EXCLUDED.bank_date,
            bank_description = EXCLUDED.bank_description,
            bank_counterparty = EXCLUDED.bank_counterparty,
            invoice_amount = EXCLUDED.invoice_amount,
            customer_name = EXCLUDED.customer_name,
            match_type = EXCLUDED.match_type,
            confidence = EXCLUDED.confidence,
            fee_amount = EXCLUDED.fee_amount,
            matched_amount = EXCLUDED.matched_amount,
            ai_reasoning = EXCLUDED.ai_reasoning,
            status = EXCLUDED.status,
            updated_at = NOW()`,
          [
            userId,
            movement.id,
            cashEvent.id,
            Math.abs(movement.amount),
            movement.date,
            movement.raw_description,
            movement.counterparty,
            invoiceDocNumber,
            cashEvent.amount,
            customerName,
            matchType,
            match.confidence,
            feeAmount,
            matchedAmount,
            "ai",
            match.reasoning,
            finalStatus
          ]
        )
        
        // Track this invoice as matched in this run
        invoicesMatchedInThisRun.add(cashEvent.id)
        
        // Track movement matched amount in this run
        const currentMovementMatched = movementsMatchedInThisRun.get(movement.id) || 0
        movementsMatchedInThisRun.set(movement.id, currentMovementMatched + matchedAmount)
        
        // Update our in-memory tracking for subsequent matches in this batch
        const existing = existingInvoiceMatches.get(cashEvent.id)
        if (existing) {
          existing.total_matched += matchedAmount
          existing.match_type = matchType
        } else {
          existingInvoiceMatches.set(cashEvent.id, {
            cash_event_id: cashEvent.id,
            match_type: matchType,
            total_matched: matchedAmount
          })
        }
        
        savedCount++
        console.log(`[AI Matcher] Saved ${matchType} match: movement ${movement.id} -> invoice ${invoiceDocNumber} ($${matchedAmount.toFixed(2)}, status: ${finalStatus})`)
      } catch (err) {
        console.error(`[AI Matcher] Failed to save match for movement ${movement.id} -> invoice ${invoiceId}:`, err)
        errorCount++
      }
    }
  }
  
  console.log(`[AI Matcher] Saved ${savedCount} matches, skipped ${skippedCount} (duplicates/fully-matched), ${errorCount} errors`)
}
