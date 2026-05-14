/**
 * AR Reconciliation - Movement Candidates API
 * 
 * GET: Fetch all candidate invoices for a specific bank movement
 * Used by the Review Queue's Triage Drawer to show the full candidate lineup
 */

import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { classifyMovement, type CashEventRow } from "@/lib/reconciliation-case-classifier"

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const url = new URL(request.url)
    const movementId = url.searchParams.get("movement_id")

    if (!movementId) {
      return NextResponse.json({ error: "movement_id required" }, { status: 400 })
    }

    // Fetch the specific movement
    const movementResult = await query(
      `SELECT
         m.id, m.user_id, m.direction, m.amount::float as amount,
         m.date, m.movement_type, m.counterparty, m.counterparty_entity_id,
         m.raw_description, m.metadata,
         mt.economic_class, mt.tag_data,
         COALESCE(m.amount - COALESCE(attr_sum.total_attributed, 0), m.amount)::float as available_cash
       FROM movements m
       LEFT JOIN movement_tags mt ON mt.movement_id = m.id
       LEFT JOIN (
         SELECT movement_id, SUM(net_amount) as total_attributed
         FROM movement_attributions WHERE source = 'rule'
         GROUP BY movement_id
       ) attr_sum ON attr_sum.movement_id = m.id
       WHERE m.id = $1 AND m.user_id = $2`,
      [movementId, user.id]
    )

    if (movementResult.rows.length === 0) {
      return NextResponse.json({ error: "Movement not found" }, { status: 404 })
    }

    const movement = movementResult.rows[0]

    // Load all AR cash events for classification
    const cashEventsResult = await query(
      `SELECT id, user_id, entity_id, event_type, amount::float as amount,
              outstanding_amount::float as outstanding_amount, status, expected_date, metadata
       FROM cash_events
       WHERE user_id = $1 AND event_type = 'ar'
       ORDER BY expected_date ASC`,
      [user.id]
    )
    const cashEvents = cashEventsResult.rows as CashEventRow[]

    // Load all movements for cross-movement analysis
    const allMovementsResult = await query(
      `SELECT m.id, m.user_id, m.direction, m.amount::float as amount,
              m.date, m.movement_type, m.counterparty, m.counterparty_entity_id,
              m.raw_description, m.metadata, mt.economic_class, mt.tag_data,
              COALESCE(m.amount - COALESCE(attr_sum.total_attributed, 0), m.amount)::float as available_cash
       FROM movements m
       LEFT JOIN movement_tags mt ON mt.movement_id = m.id
       LEFT JOIN (
         SELECT movement_id, SUM(net_amount) as total_attributed
         FROM movement_attributions WHERE source = 'rule'
         GROUP BY movement_id
       ) attr_sum ON attr_sum.movement_id = m.id
       WHERE m.user_id = $1
       ORDER BY m.date DESC`,
      [user.id]
    )

    // Load customer matches
    const customerMatchResult = await query(
      `SELECT movement_id, matched_customer
       FROM movement_customer_matches
       WHERE user_id = $1 AND movement_id = $2`,
      [user.id, movementId]
    )
    const matchedCustomer = customerMatchResult.rows[0]?.matched_customer || null

    // Classify the movement to get candidates
    const classification = classifyMovement(
      movement,
      cashEvents,
      allMovementsResult.rows,
      matchedCustomer
    )

    // Enrich candidates with invoice metadata
    const enrichedCandidates = classification.candidates.map(c => {
      const cashEvent = cashEvents.find(ce => ce.id === c.id)
      const metadata = (cashEvent?.metadata as Record<string, unknown>) || {}
      return {
        ...c,
        invoice_number: (metadata.doc_number as string) || (metadata.invoice_number as string) || null,
        customer_name: (metadata.customer_name as string) || (metadata.entity_name as string) || c.entity_name,
        invoice_date: (metadata.txn_date as string) || (metadata.date as string) || null,
      }
    })

    // Check which candidates already have matches
    const existingMatchesResult = await query(
      `SELECT cash_event_id, match_type, confidence::float as confidence, status,
              matched_amount::float as matched_amount
       FROM ar_reconciliation_matches
       WHERE user_id = $1 AND movement_id = $2`,
      [user.id, movementId]
    )
    const existingMatchMap = new Map(
      existingMatchesResult.rows.map((r: any) => [r.cash_event_id, r])
    )

    return NextResponse.json({
      movement: {
        id: movement.id,
        date: movement.date,
        amount: movement.amount,
        direction: movement.direction,
        counterparty: movement.counterparty,
        raw_description: movement.raw_description,
      },
      classification: {
        case_type: classification.case_type,
        is_operational: classification.is_operational,
        flags: classification.flags,
        suggested_action: classification.suggested_action,
      },
      candidates: enrichedCandidates,
      existing_matches: Object.fromEntries(existingMatchMap),
      total_candidates: enrichedCandidates.length,
    })

  } catch (error) {
    console.error("[ar-reconciliation/candidates] GET Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
