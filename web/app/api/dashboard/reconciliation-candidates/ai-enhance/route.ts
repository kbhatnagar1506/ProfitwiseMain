import { query } from "@/lib/db"
import { classifyMovement, type MovementWithAvailableCash } from "@/lib/reconciliation-case-classifier"
import { enhanceClassificationsWithAI, type MovementForAI } from "@/lib/reconciliation-ai-classifier"
import type { CashEventRow } from "@/lib/cash-events-build"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { NextResponse } from "next/server"

const EPS = 0.01

async function fetchMovementsWithAvailableCash(userId: string): Promise<MovementWithAvailableCash[]> {
  const result = await query(
    `SELECT
       m.id,
       m.user_id,
       m.direction,
       m.amount,
       m.date,
       m.movement_type,
       m.counterparty,
       m.counterparty_entity_id,
       m.raw_description,
       m.metadata,
       mt.economic_class,
       mt.tag_data,
       COALESCE(m.amount - COALESCE(attr_sum.total_attributed, 0), m.amount) as available_cash
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
     ORDER BY m.date DESC
     LIMIT 200`,
    [userId, EPS]
  )
  return result.rows as MovementWithAvailableCash[]
}

async function loadCashEvents(userId: string): Promise<CashEventRow[]> {
  const result = await query(
    `SELECT
       id,
       user_id,
       entity_id,
       event_type,
       amount,
       outstanding_amount,
       status,
       expected_date,
       metadata
     FROM cash_events
     WHERE user_id = $1
       AND event_type IN ('ar', 'ap')
     ORDER BY expected_date ASC`,
    [userId]
  )
  return result.rows as CashEventRow[]
}

// Store for job status (in production, use Redis or DB)
const jobStore = new Map<string, {
  status: "pending" | "running" | "completed" | "failed"
  progress: number
  result?: unknown
  error?: string
  startedAt: Date
  completedAt?: Date
}>()

// POST - Start a new AI enhancement job
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = user.id
    const body = await request.json()
    const maxMovements = body.maxMovements || 30

    // Create job ID
    const jobId = `ai-enhance-${userId}-${Date.now()}`
    
    // Initialize job status
    jobStore.set(jobId, {
      status: "pending",
      progress: 0,
      startedAt: new Date(),
    })

    // Start background processing (don't await)
    processAIEnhancement(jobId, userId, maxMovements).catch((err) => {
      console.error("[AI Enhance Job] Error:", err)
      const job = jobStore.get(jobId)
      if (job) {
        job.status = "failed"
        job.error = err instanceof Error ? err.message : "Unknown error"
        job.completedAt = new Date()
      }
    })

    return NextResponse.json({ 
      jobId,
      status: "pending",
      message: "AI enhancement job started. Poll GET /api/dashboard/reconciliation-candidates/ai-enhance?jobId=... for status."
    })
  } catch (error) {
    console.error("[reconciliation-ai-classify] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}

// GET - Check job status
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

    // Clean up old completed jobs (older than 5 minutes)
    if (job.completedAt && Date.now() - job.completedAt.getTime() > 5 * 60 * 1000) {
      jobStore.delete(jobId)
    }

    return NextResponse.json({
      jobId,
      status: job.status,
      progress: job.progress,
      result: job.result,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    })
  } catch (error) {
    console.error("[reconciliation-ai-classify] GET Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}

// Background processing function
async function processAIEnhancement(jobId: string, userId: string, maxMovements: number) {
  const job = jobStore.get(jobId)
  if (!job) return

  job.status = "running"
  job.progress = 10

  try {
    // Load data
    const movements = await fetchMovementsWithAvailableCash(userId)
    const cashEvents = await loadCashEvents(userId)
    job.progress = 20

    // First, run deterministic classification
    const classifiedMovements: MovementForAI[] = movements.map((m) => {
      const classification = classifyMovement(m, cashEvents, movements)
      return {
        id: m.id,
        counterparty: m.counterparty,
        raw_description: m.raw_description,
        amount: m.amount,
        direction: m.direction,
        date: m.date,
        classification,
      }
    })
    job.progress = 40

    // Build entity list for AI
    const cashEventsForAI = cashEvents.map((e) => ({
      id: e.id,
      entity_name: (e.metadata?.customer_name || e.metadata?.vendor_name || e.entity_id) as string,
      amount: e.amount,
      event_type: e.event_type as "ar" | "ap",
    }))

    // Run AI enhancement
    job.progress = 50
    const aiEnhancements = await enhanceClassificationsWithAI(
      classifiedMovements,
      cashEventsForAI,
      { maxMovements }
    )
    job.progress = 90

    // Merge results
    const enhancedResults = classifiedMovements.map((m) => {
      const aiEnhancement = aiEnhancements.get(m.id)
      return {
        id: m.id,
        counterparty: m.counterparty,
        amount: m.amount,
        direction: m.direction,
        date: m.date,
        deterministic: {
          case_type: m.classification.case_type,
          suggested_action: m.classification.suggested_action,
          candidates_count: m.classification.candidates.length,
        },
        ai_enhanced: aiEnhancement
          ? {
              suggested_case_type: aiEnhancement.suggested_case_type,
              confidence: aiEnhancement.confidence,
              reasoning: aiEnhancement.reasoning,
              recommended_action: aiEnhancement.recommended_action,
            }
          : null,
      }
    })

    // Summary stats
    const summary = {
      total: enhancedResults.length,
      ai_enhanced: enhancedResults.filter((r) => r.ai_enhanced).length,
      case_type_changes: enhancedResults.filter(
        (r) => r.ai_enhanced && r.ai_enhanced.suggested_case_type !== r.deterministic.case_type
      ).length,
      high_confidence: enhancedResults.filter((r) => r.ai_enhanced && r.ai_enhanced.confidence >= 0.8).length,
    }

    job.status = "completed"
    job.progress = 100
    job.result = { movements: enhancedResults, summary }
    job.completedAt = new Date()

  } catch (error) {
    job.status = "failed"
    job.error = error instanceof Error ? error.message : "Unknown error"
    job.completedAt = new Date()
    throw error
  }
}
