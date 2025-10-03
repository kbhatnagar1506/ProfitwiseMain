/**
 * "Explain This" — LLM explains why a payment matches an invoice/obligation.
 * POST { movement_id, entity_type?, entity_id? }
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { getAllocationsByMovement } from "@/lib/allocation-persist"
import { explainMatch } from "@/lib/explain-match"
import { isFeeAnomaly } from "@/lib/fee-anomaly"

export async function POST(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: { movement_id?: string; entity_type?: string; entity_id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const movementId = body.movement_id
  if (!movementId || typeof movementId !== "string") {
    return NextResponse.json({ error: "movement_id required" }, { status: 400 })
  }

  try {
    type MovementRow = { id: string; direction: string; amount: string; date: string; raw_description: string | null; counterparty: string | null }
    const { rows } = await query<MovementRow>(
      `SELECT id, direction, amount, date, raw_description, counterparty FROM movements WHERE user_id = $1 AND id = $2`,
      [user.id, movementId]
    )
    const m = rows[0]
    if (!m) return NextResponse.json({ error: "Movement not found" }, { status: 404 })

    const amount = parseFloat(String(m.amount))
    const allocations = await getAllocationsByMovement(movementId)

    const alloc = allocations.find(
      (a) => (!body.entity_type || a.entity_type === body.entity_type) && (!body.entity_id || a.entity_id === body.entity_id)
    ) ?? allocations[0]
    if (!alloc) {
      return NextResponse.json({ error: "No allocation found for this movement" }, { status: 404 })
    }

    const explanation = await explainMatch({
      movement_id: movementId,
      amount,
      date: m.date,
      raw_description: m.raw_description,
      counterparty: m.counterparty,
      direction: m.direction as "inflow" | "outflow",
      entity_type: alloc.entity_type as "ar" | "ap",
      entity_id: alloc.entity_id,
      entity_name: alloc.entity_id,
      gross_applied: alloc.gross_applied,
      fee_amount: alloc.fee_amount,
      net_applied: alloc.net_applied,
      confidence: alloc.confidence,
      fee_anomaly: isFeeAnomaly(alloc.gross_applied, alloc.fee_amount),
    })
    return NextResponse.json({ explanation, type: "match" })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[Explain-Match] failed:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
