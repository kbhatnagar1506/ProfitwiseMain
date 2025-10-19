/**
 * AR/AP reconciliation: matched/unmatched payments, fees.
 * GET returns matched inflows, matched outflows, unmatched buckets, total fees.
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"
import { getMovementIdsWithAllocations, getAllocationsForUser } from "@/lib/allocation-persist"
import { isFeeAnomaly } from "@/lib/fee-anomaly"

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await ensureMovementsSchema()
  } catch {
    return NextResponse.json({ error: "Movements schema not available" }, { status: 500 })
  }

  try {
    const allocatedMovementIds = await getMovementIdsWithAllocations(user.id)
    const allocations = await getAllocationsForUser(user.id)

    const totalFeesPaid = allocations.reduce((s, a) => s + a.fee_amount, 0)

    type MovementRow = { id: string; direction: string; amount: string; date: string; counterparty: string | null }
    const { rows: movementRows } = await query<MovementRow>(
      `SELECT id, direction, amount::float, date, counterparty FROM movements
       WHERE user_id = $1 AND duplicate_of IS NULL
       ORDER BY date DESC`,
      [user.id]
    )

    const matchedInflows: { movement_id: string; amount: number; date: string; counterparty: string | null; allocations: { entity_type: string; entity_id: string; gross: number; fee: number; net: number }[] }[] = []
    const matchedOutflows: typeof matchedInflows = []
    const unmatchedInflows: { movement_id: string; amount: number; date: string; counterparty: string | null }[] = []
    const unmatchedOutflows: typeof unmatchedInflows = []

    for (const m of movementRows) {
      const amount = parseFloat(String(m.amount))
      const allocs = allocations.filter((a) => a.movement_id === m.id)
      const isAllocated = allocs.length > 0

      const entry = {
        movement_id: m.id,
        amount,
        date: m.date,
        counterparty: m.counterparty,
      }

      if (m.direction === "inflow") {
        if (isAllocated) {
          matchedInflows.push({
            ...entry,
            allocations: allocs.map((a) => ({
              entity_type: a.entity_type,
              entity_id: a.entity_id,
              gross: a.gross_applied,
              fee: a.fee_amount,
              net: a.net_applied,
              fee_anomaly: isFeeAnomaly(a.gross_applied, a.fee_amount),
            })),
          })
        } else {
          unmatchedInflows.push(entry)
        }
      } else {
        if (isAllocated) {
          matchedOutflows.push({
            ...entry,
            allocations: allocs.map((a) => ({
              entity_type: a.entity_type,
              entity_id: a.entity_id,
              gross: a.gross_applied,
              fee: a.fee_amount,
              net: a.net_applied,
              fee_anomaly: isFeeAnomaly(a.gross_applied, a.fee_amount),
            })),
          })
        } else {
          unmatchedOutflows.push(entry)
        }
      }
    }

    const totalMatchedInflows = matchedInflows.reduce((s, m) => s + m.amount, 0)
    const totalMatchedOutflows = matchedOutflows.reduce((s, m) => s + m.amount, 0)
    const totalUnmatchedInflows = unmatchedInflows.reduce((s, m) => s + m.amount, 0)
    const totalUnmatchedOutflows = unmatchedOutflows.reduce((s, m) => s + m.amount, 0)

    return NextResponse.json({
      matched_inflows: matchedInflows.slice(0, 50),
      matched_outflows: matchedOutflows.slice(0, 50),
      unmatched_inflows: unmatchedInflows.slice(0, 50),
      unmatched_outflows: unmatchedOutflows.slice(0, 50),
      total_matched_inflows: Math.round(totalMatchedInflows * 100) / 100,
      total_matched_outflows: Math.round(totalMatchedOutflows * 100) / 100,
      total_unmatched_inflows: Math.round(totalUnmatchedInflows * 100) / 100,
      total_unmatched_outflows: Math.round(totalUnmatchedOutflows * 100) / 100,
      total_fees_paid: Math.round(totalFeesPaid * 100) / 100,
      allocation_count: allocations.length,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[AR-AP-Reconciliation] failed:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
