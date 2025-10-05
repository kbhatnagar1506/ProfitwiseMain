/**
 * AR (invoice) to Payment matching API.
 * POST { movement_id } → suggested matches.
 * POST { movement_id, invoice_id } → confirm and persist allocation.
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"
import { matchARPayment, suggestARMatches, type InflowPayment, type ARMatchSuggestion } from "@/lib/ar-payment-match"
import { suggestARMatchesLLM } from "@/lib/ar-llm-match"
import { createAllocation } from "@/lib/allocation-persist"
import { fetchInvoicesForReconciliation } from "@/lib/invoices-fetch"

export async function POST(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: { movement_id?: string; invoice_id?: string }
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
    if (row.direction !== "inflow") {
      return NextResponse.json({ suggestions: [] as ARMatchSuggestion[], allocation: null })
    }

    const payment: InflowPayment = {
      movement_id: row.id,
      amount: parseFloat(row.amount),
      date: row.date,
      raw_description: row.raw_description,
      entity_id: row.counterparty_entity_id,
      counterparty_name: row.counterparty ?? null,
    }

    const outstandingInvoices = await fetchInvoicesForReconciliation(user.id)

    // Confirm: persist allocation when invoice_id provided
    const invoiceId = body.invoice_id
    if (invoiceId && typeof invoiceId === "string") {
      const invoice = outstandingInvoices.find((i) => i.invoice_id === invoiceId)
      if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })
      const match = matchARPayment(payment, [invoice])
      const gross = match?.gross_applied ?? invoice.amount_due
      const net = payment.amount
      const fee = Math.max(0, gross - net)
      const allocation = await createAllocation(
        user.id,
        movementId,
        "ar",
        invoiceId,
        gross,
        fee,
        net,
        match?.confidence ?? 0.5,
        match?.match_method ?? "manual",
      )
      return NextResponse.json({ suggestions: [], allocation })
    }

    // Suggest: return matches
    const match = matchARPayment(payment, outstandingInvoices)
    if (match) {
      return NextResponse.json({
        suggestions: [{
          invoice_id: match.invoice_id,
          customer_name: outstandingInvoices.find((i) => i.invoice_id === match.invoice_id)?.customer_name ?? "—",
          amount_due: match.gross_applied,
          confidence: match.confidence >= 0.8 ? "high" : match.confidence >= 0.5 ? "medium" : "low",
          reasoning: "Deterministic match (entity + time + amount tolerance)",
          gross_applied: match.gross_applied,
          fee_amount: match.fee_amount,
          net_applied: match.net_applied,
        }],
        allocation: null,
      })
    }
    const suggestions = suggestARMatches(payment, outstandingInvoices)
    if (suggestions.length === 0) {
      const llmSuggestions = await suggestARMatchesLLM(payment, outstandingInvoices)
      if (llmSuggestions.length > 0) {
        return NextResponse.json({
          suggestions: llmSuggestions.map((s) => ({
            ...s,
            gross_applied: s.amount_due,
            fee_amount: Math.max(0, s.amount_due - payment.amount),
            net_applied: payment.amount,
          })),
          allocation: null,
        })
      }
    }
    return NextResponse.json({ suggestions, allocation: null })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[AR-Match] failed:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
