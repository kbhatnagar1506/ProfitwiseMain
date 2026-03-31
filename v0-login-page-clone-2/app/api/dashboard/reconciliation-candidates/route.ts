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
       amount,
       outstanding_amount,
       status,
       expected_date,
       metadata
     FROM cash_events
     WHERE user_id = $1
       AND event_type IN ('ar', 'ap')
       AND status != 'paid'
       AND COALESCE(outstanding_amount, amount) > $2
     ORDER BY expected_date ASC`,
    [userId, EPS]
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
    const filter = url.searchParams.get("filter") || "all" // all, operational, non_op
    const caseTypeFilter = url.searchParams.get("case_type") || null
    const search = url.searchParams.get("search") || null

    // Load data
    const movements = await fetchMovementsWithAvailableCash(userId)
    const cashEvents = await loadOpenCashEvents(userId)

    // Classify each movement (pass all movements for cross-movement analysis)
    const classifiedMovements: ClassifiedMovement[] = []
    const caseTypeCounts: Record<CaseType, number> = {} as Record<CaseType, number>
    let operationalCount = 0
    let nonOperationalCount = 0
    let autoMatchableCount = 0
    let needsReviewCount = 0

    for (const movement of movements) {
      // Pass all movements for cross-movement analysis (duplicate detection, separate fee detection)
      const classification = classifyMovement(movement, cashEvents, movements)

      // Apply filters
      if (filter === "operational" && !classification.is_operational) continue
      if (filter === "non_op" && classification.is_operational) continue
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
    }

    const summary: CaseSummary = {
      total: classifiedMovements.length,
      by_case_type: caseTypeCounts,
      operational: operationalCount,
      non_operational: nonOperationalCount,
      auto_matchable: autoMatchableCount,
      needs_review: needsReviewCount,
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
