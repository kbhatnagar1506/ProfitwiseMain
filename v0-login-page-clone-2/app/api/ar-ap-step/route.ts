import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema } from "@/lib/db"
import { fetchInvoicesForReconciliation } from "@/lib/invoices-fetch"
import { fetchOutstandingBills } from "@/lib/bills-fetch"
import { computeARState, computeAPStateFromBills } from "@/lib/state/ar-ap"
import { query } from "@/lib/db"
import { runFinancialBrain } from "@/lib/financial-brain"
import {
  fetchReconciliationMovementRows,
  type ReconMovementRow,
} from "@/lib/reconciliation-movement-rows"

type ReconTotals = {
  total_matched_inflows: number
  total_matched_outflows: number
  total_unmatched_inflows: number
  total_unmatched_outflows: number
  total_fees_paid: number
  matched_inflows: ReconMovementRow[]
  matched_outflows: ReconMovementRow[]
  unmatched_inflows: ReconMovementRow[]
  unmatched_outflows: ReconMovementRow[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureMovementsSchema()

  const invoices = await fetchInvoicesForReconciliation(user.id)
  const bills = await fetchOutstandingBills(user.id)
  const obligations = computeAPStateFromBills(bills)

  try {
    await runFinancialBrain(user.id, {
      outstandingInvoices: invoices,
      apObligations: obligations,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[ar-ap-step] runFinancialBrain failed:", msg)
    return NextResponse.json({ error: "Reconciliation run failed", detail: msg }, { status: 500 })
  }

  const ar = computeARState(invoices)
  const ap = {
    total_expected_30d: r2(obligations.reduce((s, o) => s + o.expected_amount, 0)),
    obligation_count: obligations.length,
    obligations: obligations.sort((a, b) => a.days_until_due - b.days_until_due),
  }

  const recon = await fetchReconTotals(user.id)

  return NextResponse.json({ ar, ap, recon })
}

async function fetchReconTotals(userId: string): Promise<ReconTotals> {
  const totals = {
    total_matched_inflows: 0,
    total_matched_outflows: 0,
    total_unmatched_inflows: 0,
    total_unmatched_outflows: 0,
    total_fees_paid: 0,
  }

  const { rows: matchedRows } = await query<{
    inflow: string
    outflow: string
    fees: string
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN m.direction = 'inflow'  AND a.component_type = 'ar' THEN ABS(a.net_amount::float) ELSE 0 END), 0)::text AS inflow,
       COALESCE(SUM(CASE WHEN m.direction = 'outflow' AND a.component_type = 'ap' THEN ABS(a.net_amount::float) ELSE 0 END), 0)::text AS outflow,
       COALESCE(SUM(CASE WHEN a.component_type = 'fee' THEN ABS(a.net_amount::float) ELSE 0 END), 0)::text AS fees
     FROM movement_attributions a
     JOIN movements m ON m.id = a.movement_id AND m.user_id = a.user_id
     WHERE a.user_id = $1`,
    [userId],
  )
  if (matchedRows[0]) {
    totals.total_matched_inflows = r2(parseFloat(matchedRows[0].inflow) || 0)
    totals.total_matched_outflows = r2(parseFloat(matchedRows[0].outflow) || 0)
    totals.total_fees_paid = r2(parseFloat(matchedRows[0].fees) || 0)
  }

  const lists = await fetchReconciliationMovementRows(userId)
  totals.total_unmatched_inflows = lists.unmatched_inflows.length
  totals.total_unmatched_outflows = lists.unmatched_outflows.length

  return {
    ...totals,
    matched_inflows: lists.matched_inflows,
    matched_outflows: lists.matched_outflows,
    unmatched_inflows: lists.unmatched_inflows,
    unmatched_outflows: lists.unmatched_outflows,
  }
}
