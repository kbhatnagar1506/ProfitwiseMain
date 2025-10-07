/**
 * Payment → AP matching API.
 * POST { movement_id } → suggested obligation matches.
 * POST { movement_id, obligation_id } → confirm and persist allocation.
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"
import { suggestAPMatches, type PaymentInput, type MatchSuggestion } from "@/lib/ap-llm-match"
import type { APObligation } from "@/lib/state/ar-ap"
import { fetchOutstandingBills } from "@/lib/bills-fetch"
import { buildBehavioralModels, setIdentityContext } from "@/lib/state/forecast-engine"
import type { IdentityContext } from "@/lib/state/forecast-engine"
import { computeAPStateFromBills, mergeAPObligations, computeAPState } from "@/lib/state/ar-ap"
import type { OutstandingInvoice } from "@/lib/state/types"
import { createAllocation } from "@/lib/allocation-persist"

export async function POST(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: { movement_id?: string; obligation_id?: string }
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
    await ensureMovementsSchema()
  } catch {
    return NextResponse.json({ error: "Movements schema not available" }, { status: 500 })
  }

  try {
  type MovementRow = { id: string; direction: string; amount: string; date: string; raw_description: string | null; counterparty_entity_id: string | null; counterparty?: string }
  const rows = await query<MovementRow>(
    `SELECT m.id, m.direction, m.amount, m.date, m.raw_description, m.counterparty_entity_id, m.counterparty
     FROM movements m WHERE m.user_id = $1 AND m.id = $2`,
    [user.id, movementId]
  ).then((r) => r.rows)
  const row = rows[0]
  if (!row) return NextResponse.json({ error: "Movement not found" }, { status: 404 })
  if (row.direction !== "outflow") {
    return NextResponse.json({ suggestions: [] as MatchSuggestion[] })
  }

  const amount = parseFloat(row.amount)
  const counterpartyName = row.counterparty ?? null
  const payment: PaymentInput = {
    movement_id: row.id,
    amount,
    date: row.date,
    raw_description: row.raw_description,
    entity_id: row.counterparty_entity_id,
    counterparty_name: counterpartyName,
  }

  // Fetch AP obligations (reuse ar-ap logic)
  const outstandingBills = await fetchOutstandingBills(user.id)
  const billObligations = computeAPStateFromBills(outstandingBills)
  const identityCtx: IdentityContext = {
    entityNames: new Map(),
    entityTypes: new Map(),
    aliasToEntityId: new Map(),
    counterpartyByMovement: new Map(),
    familyMembers: new Map(),
  }
  try {
    const entityRows = await query<{ id: string; display_name: string | null; canonical_name: string }>(
      `SELECT id, display_name, canonical_name FROM entities WHERE user_id = $1`,
      [user.id]
    ).then((r) => r.rows)
    for (const e of entityRows) {
      const name = e.display_name || e.canonical_name
      if (name) identityCtx.entityNames.set(e.id, name)
    }
  } catch { /* entities may not exist */ }
  setIdentityContext(identityCtx)

  const outstandingInvoices: OutstandingInvoice[] = []
  const models = buildBehavioralModels([], outstandingInvoices, outstandingBills)
  const patternObligations = computeAPState(models.vendors, 30).obligations
  const obligations: APObligation[] = mergeAPObligations(billObligations, patternObligations)

  // Confirm: persist allocation when obligation_id provided
  const obligationId = body.obligation_id
  if (obligationId && typeof obligationId === "string") {
    const obligation = obligations.find((o) => o.obligation_id === obligationId)
    if (!obligation) return NextResponse.json({ error: "Obligation not found" }, { status: 404 })
    const amount = payment.amount
    const allocation = await createAllocation({
      userId: user.id,
      movementId,
      entity_type: "ap",
      entity_id: obligationId,
      gross_applied: amount,
      fee_amount: 0,
      net_applied: amount,
      confidence: 0.9,
      match_method: "manual",
      reconcile_at: new Date(),
    })
    await query("DELETE FROM reconciliation_cache WHERE user_id = $1", [user.id]).catch(() => {})
    return NextResponse.json({ suggestions: [], allocation })
  }

  const suggestions = await suggestAPMatches(payment, obligations)
  return NextResponse.json({ suggestions })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[AP-Match] failed:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
