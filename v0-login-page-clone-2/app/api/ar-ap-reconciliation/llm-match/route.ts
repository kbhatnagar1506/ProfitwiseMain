/**
 * Batch LLM match: given unmatched transactions and invoices/bills, suggest mappings.
 * POST returns suggested matches. Does NOT auto-apply; user confirms each.
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"
import { getAllocationsForUser } from "@/lib/allocation-persist"
import { fetchInvoicesForReconciliation } from "@/lib/invoices-fetch"
import { fetchOutstandingBills } from "@/lib/bills-fetch"
import { getPaymentClass, isARAPOperating } from "@/lib/payment-class"
import { toEntityUriApBill } from "@/lib/entity-uri"
import { batchLLMMatch } from "@/lib/reconciliation-llm-match"

function isTestEntityName(name: string): boolean {
  const cn = (name ?? "").trim().toLowerCase()
  if (!cn) return true
  if (/\b(test|jruby|jack\s*test)\b/.test(cn)) return true
  if (/^[^\s]+@[^\s]+\.[^\s]+$/.test(cn)) return true
  return false
}

export async function POST() {
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
    const allocations = await getAllocationsForUser(user.id)
    const allocatedMovementIds = new Set(allocations.map((a) => a.movement_id))

    type MovementRow = { id: string; direction: string; amount: string; date: string; counterparty: string | null; raw_description: string | null }
    const { rows: movementRows } = await query<MovementRow>(
      `SELECT id, direction, amount::float, date, counterparty, raw_description FROM movements
       WHERE user_id = $1 AND duplicate_of IS NULL`,
      [user.id]
    )

    type TagRow = { movement_id: string; economic_class: string }
    const { rows: tagRows } = await query<TagRow>(
      `SELECT movement_id, economic_class FROM movement_tags
       WHERE movement_id IN (SELECT id FROM movements WHERE user_id = $1 AND duplicate_of IS NULL)`,
      [user.id]
    )
    const economicClassByMovement = new Map<string, string>()
    for (const t of tagRows) economicClassByMovement.set(t.movement_id, t.economic_class)

    const unmatchedInflows: { movement_id: string; amount: number; date: string; counterparty: string | null; raw_description: string | null }[] = []
    const unmatchedOutflows: typeof unmatchedInflows = []

    for (const m of movementRows) {
      if (allocatedMovementIds.has(m.id)) continue
      const ec = economicClassByMovement.get(m.id) ?? "unknown"
      const pc = getPaymentClass(ec)
      if (!isARAPOperating(pc)) continue

      const amount = parseFloat(String(m.amount))
      if (m.direction === "inflow") {
        unmatchedInflows.push({
          movement_id: m.id,
          amount,
          date: m.date,
          counterparty: m.counterparty,
          raw_description: m.raw_description,
        })
      } else {
        unmatchedOutflows.push({
          movement_id: m.id,
          amount,
          date: m.date,
          counterparty: m.counterparty,
          raw_description: m.raw_description,
        })
      }
    }

    const allInvoices = await fetchInvoicesForReconciliation(user.id)
    const allBills = await fetchOutstandingBills(user.id)
    const invoices = allInvoices
      .filter((i) => !isTestEntityName(i.customer_name))
      .map((i) => ({
        invoice_id: i.invoice_id,
        customer_name: i.customer_name,
        amount_due: i.amount_due,
        due_date: i.due_date,
      }))
    const bills = allBills
      .filter((b) => !isTestEntityName(b.vendor_name))
      .map((b) => ({
        bill_id: b.bill_id,
        obligation_id: b.entity_uri ?? toEntityUriApBill(b.source, b.bill_id),
        vendor_name: b.vendor_name,
        amount_due: b.amount_due,
        due_date: b.due_date,
      }))

    const result = await batchLLMMatch(unmatchedInflows, unmatchedOutflows, invoices, bills)
    return NextResponse.json(result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[LLM-Match] failed:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
