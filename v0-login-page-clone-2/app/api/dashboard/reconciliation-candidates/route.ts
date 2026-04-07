import { query } from "@/lib/db"
import { classifyMovement, type ClassificationResult, type CaseType } from "@/lib/reconciliation-case-classifier"
import type { CashEventRow } from "@/lib/cash-events-build"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { NextResponse } from "next/server"

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

async function loadOpenCashEvents(userId: string): Promise<CashEventRow[]> {
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
       AND event_type IN ('ar', 'ap')
     ORDER BY expected_date ASC`,
    [userId]
  )
  return result.rows as CashEventRow[]
}

interface ClassifiedMovement {
  id: string
  date: string
  amount: number
  direction: "inflow" | "outflow"
  counterparty: string | null
  economic_class: string | null
  classification: ClassificationResult
}

interface CaseSummary {
  total: number
  by_case_type: Record<CaseType, number>
  operational: number
  non_operational: number
  auto_matchable: number
  needs_review: number
  zero_candidates: number
}

interface ResponseData {
  movements: ClassifiedMovement[]
  summary: CaseSummary
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = user.id

    // Get query parameters
    const url = new URL(request.url)
    const filter = url.searchParams.get("filter") || "all" // all, operational, non_op, review
    const caseTypeFilter = url.searchParams.get("case_type") || null
    const search = url.searchParams.get("search") || null

    // Load data
    const movements = await fetchMovementsWithAvailableCash(userId)
    const cashEvents = await loadOpenCashEvents(userId)

    // Debug: Log cash events count
    console.log(`[reconciliation-candidates] Loaded ${movements.length} movements, ${cashEvents.length} cash events`)
    if (cashEvents.length > 0) {
      const arEvents = cashEvents.filter(e => e.event_type === 'ar')
      const apEvents = cashEvents.filter(e => e.event_type === 'ap')
      console.log(`[reconciliation-candidates] AR events: ${arEvents.length}, AP events: ${apEvents.length}`)
      if (arEvents.length > 0) {
        console.log(`[reconciliation-candidates] Sample AR event:`, JSON.stringify(arEvents[0]))
      }
      if (apEvents.length > 0) {
        console.log(`[reconciliation-candidates] Sample AP event:`, JSON.stringify(apEvents[0]))
      }
    } else {
      console.log(`[reconciliation-candidates] WARNING: No cash events found for user ${userId}`)
    }

    // Classify each movement (pass all movements for cross-movement analysis)
    const classifiedMovements: ClassifiedMovement[] = []
    const caseTypeCounts: Record<CaseType, number> = {} as Record<CaseType, number>
    let operationalCount = 0
    let nonOperationalCount = 0
    let autoMatchableCount = 0
    let needsReviewCount = 0
    let zeroCandidatesCount = 0

    for (const movement of movements) {
      // Pass all movements for cross-movement analysis (duplicate detection, separate fee detection)
      const classification = classifyMovement(movement, cashEvents, movements)

      // Apply filters
      if (filter === "operational" && !classification.is_operational) continue
      if (filter === "non_op" && classification.is_operational) continue
      if (filter === "review" && (classification.candidates.length > 0 || !classification.is_operational)) continue
      if (caseTypeFilter && classification.case_type !== caseTypeFilter) continue
      if (search) {
        const searchLower = search.toLowerCase()
        const matchesSearch =
          movement.counterparty?.toLowerCase().includes(searchLower) ||
          movement.raw_description?.toLowerCase().includes(searchLower) ||
          classification.case_type.toLowerCase().includes(searchLower)
        if (!matchesSearch) continue
      }

      classifiedMovements.push({
        id: movement.id,
        date: movement.date,
        amount: movement.amount,
        direction: movement.direction,
        counterparty: movement.counterparty,
        economic_class: movement.economic_class,
        classification,
      })

      // Update counts
      caseTypeCounts[classification.case_type] = (caseTypeCounts[classification.case_type] || 0) + 1

      if (classification.is_operational) {
        operationalCount++
      } else {
        nonOperationalCount++
      }

      if (classification.suggested_action === "auto_match") {
        autoMatchableCount++
      } else if (classification.suggested_action === "review") {
        needsReviewCount++
      }

      // Count zero candidates (operational only - non-op are expected to have 0)
      if (classification.is_operational && classification.candidates.length === 0) {
        zeroCandidatesCount++
      }
    }

    const summary: CaseSummary = {
      total: classifiedMovements.length,
      by_case_type: caseTypeCounts,
      operational: operationalCount,
      non_operational: nonOperationalCount,
      auto_matchable: autoMatchableCount,
      needs_review: needsReviewCount,
      zero_candidates: zeroCandidatesCount,
    }

    const response: ResponseData = {
      movements: classifiedMovements,
      summary,
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error("[reconciliation-candidates] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
