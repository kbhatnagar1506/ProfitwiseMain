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
  
  let savedCount = 0
  let errorCount = 0
  
  for (const match of result.matches) {
    // Only save actual matches (not no_match or needs_review)
    if (match.decision !== "match" || !match.matched_candidate_id) {
      continue
    }
    
    const movement = movementMap.get(match.movement_id)
    const cashEvent = cashEventMap.get(match.matched_candidate_id)
    
    if (!movement || !cashEvent) {
      console.warn(`[AI Matcher] Could not find movement or cash event for match: ${match.movement_id} -> ${match.matched_candidate_id}`)
      errorCount++
      continue
    }
    
    // Get invoice details from metadata
    const metadata = cashEvent.metadata as Record<string, unknown> || {}
    const invoiceId = (metadata.doc_number as string) || (metadata.invoice_number as string) || cashEvent.id
    const customerName = (metadata.customer_name as string) || (metadata.entity_name as string) || "Unknown"
    
    // Determine match type from reasoning or classification
    let matchType = "EXACT"
    const reasoning = match.reasoning?.toLowerCase() || ""
    if (reasoning.includes("fee") || reasoning.includes("processing")) {
      matchType = "FEE"
    } else if (reasoning.includes("partial")) {
      matchType = "PARTIAL"
    } else if (Math.abs(movement.amount - cashEvent.amount) > 0.01) {
      matchType = "FEE"
    }
    
    // Calculate fee and matched amounts
    const feeAmount = Math.abs(movement.amount - cashEvent.amount)
    const matchedAmount = Math.min(movement.amount, cashEvent.amount)
    
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
          updated_at = NOW()`,
        [
          userId,
          movement.id,
          cashEvent.id,
          movement.amount,
          movement.date,
          movement.raw_description,
          movement.counterparty,
          invoiceId,
          cashEvent.amount,
          customerName,
          matchType,
          match.confidence,
          feeAmount,
          matchedAmount,
          "ai",
          match.reasoning,
          "pending"
        ]
      )
      savedCount++
    } catch (err) {
      console.error(`[AI Matcher] Failed to save match for movement ${movement.id}:`, err)
      errorCount++
    }
  }
  
  console.log(`[AI Matcher] Saved ${savedCount} matches to database (${errorCount} errors)`)
}
