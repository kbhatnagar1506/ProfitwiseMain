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
  // AR ONLY - Load invoices for matching against customer payments
  // AP (bills) are NOT loaded - AP goes through vendor classification instead
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

async function loadCustomerMatches(userId: string): Promise<Map<string, string | null>> {
  const result = await query(
    `SELECT movement_id, matched_customer
     FROM movement_customer_matches
     WHERE user_id = $1`,
    [userId]
  )
  const matches = new Map<string, string | null>()
  for (const row of result.rows) {
    matches.set(row.movement_id, row.matched_customer)
  }
  return matches
}

async function loadReconciliationDecisions(userId: string): Promise<Map<string, { movement_id: string; decision: string; confidence: number; payment_amount: number; payment_date: string }>> {
  // Load AI matcher decisions to determine which invoices are matched
  const result = await query(
    `SELECT 
       rd.matched_candidate_id as invoice_id,
       rd.movement_id,
       rd.decision,
       rd.confidence,
       m.amount as payment_amount,
       m.date as payment_date
     FROM reconciliation_decisions rd
     JOIN movements m ON m.id = rd.movement_id
     WHERE rd.user_id = $1
       AND rd.decision = 'match'
       AND rd.matched_candidate_id IS NOT NULL`,
    [userId]
  )
  const decisions = new Map<string, { movement_id: string; decision: string; confidence: number; payment_amount: number; payment_date: string }>()
  for (const row of result.rows) {
    decisions.set(row.invoice_id, {
      movement_id: row.movement_id,
      decision: row.decision,
      confidence: row.confidence,
      payment_amount: Math.abs(row.payment_amount),
      payment_date: row.payment_date
    })
  }
  return decisions
}

function buildInvoicesWithStatus(
  cashEvents: CashEventRow[],
  decisions: Map<string, { movement_id: string; decision: string; confidence: number; payment_amount: number; payment_date: string }>
): InvoiceWithStatus[] {
  return cashEvents
    .filter(e => e.event_type === 'ar')
    .map(invoice => {
      const match = decisions.get(invoice.id)
      return {
        id: invoice.id,
        customer_name: (invoice.metadata?.customer_name as string) || null,
        amount: invoice.amount,
        outstanding_amount: invoice.outstanding_amount ?? invoice.amount,
        due_date: invoice.expected_date,
        status: invoice.status || 'open',
        is_matched: !!match,
        matched_movement_id: match?.movement_id || null,
        matched_payment_amount: match?.payment_amount || null,
        matched_payment_date: match?.payment_date || null
      }
    })
    .sort((a, b) => {
      // Sort: unmatched first, then by due date
      if (a.is_matched !== b.is_matched) return a.is_matched ? 1 : -1
      if (!a.due_date && !b.due_date) return 0
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      return new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
    })
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
  ar_count: number
}

interface ResponseData {
  movements: ClassifiedMovement[]
  summary: CaseSummary
  invoices: InvoiceWithStatus[]
}

interface InvoiceWithStatus {
  id: string
  customer_name: string | null
  amount: number
  outstanding_amount: number
  due_date: string | null
  status: string
  is_matched: boolean
  matched_movement_id: string | null
  matched_payment_amount: number | null
  matched_payment_date: string | null
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
    const filter = url.searchParams.get("filter") || "all" // all, ar, operational, non_op, review
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

    // Load pre-computed customer matches from database (populated by background job)
    const customerMatches = await loadCustomerMatches(userId)
    console.log(`[reconciliation-candidates] Loaded ${customerMatches.size} pre-computed customer matches`)

    // Load reconciliation decisions to determine invoice match status
    const reconciliationDecisions = await loadReconciliationDecisions(userId)
    console.log(`[reconciliation-candidates] Loaded ${reconciliationDecisions.size} reconciliation decisions`)

    // Build invoices with match status
    const invoicesWithStatus = buildInvoicesWithStatus(cashEvents, reconciliationDecisions)
    const matchedInvoices = invoicesWithStatus.filter(i => i.is_matched).length
    const unmatchedInvoices = invoicesWithStatus.filter(i => !i.is_matched).length
    console.log(`[reconciliation-candidates] Invoices: ${matchedInvoices} matched, ${unmatchedInvoices} unmatched`)

    // Classify each movement (pass all movements for cross-movement analysis)
    const classifiedMovements: ClassifiedMovement[] = []
    const caseTypeCounts: Record<CaseType, number> = {} as Record<CaseType, number>
    let operationalCount = 0
    let nonOperationalCount = 0
    let autoMatchableCount = 0
    let needsReviewCount = 0
    let zeroCandidatesCount = 0
    let arCount = 0

    for (const movement of movements) {
      // Pass all movements for cross-movement analysis (duplicate detection, separate fee detection)
      // Also pass the matched customer from LLM
      const matchedCustomer = customerMatches.get(movement.id)
      const classification = classifyMovement(movement, cashEvents, movements, matchedCustomer)

      // Track AR count for summary (before filters)
      if (movement.direction === "inflow" && classification.is_operational) {
        arCount++
      }

      // Apply filters
      if (filter === "ar" && movement.direction !== "inflow") continue
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
      ar_count: arCount,
    }

    const response: ResponseData = {
      movements: classifiedMovements,
      summary,
      invoices: invoicesWithStatus,
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error("[reconciliation-candidates] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
