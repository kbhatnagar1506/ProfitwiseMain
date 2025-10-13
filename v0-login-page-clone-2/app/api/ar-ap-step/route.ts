import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema } from "@/lib/db"
import { fetchInvoicesForReconciliation } from "@/lib/invoices-fetch"
import { fetchOutstandingBills } from "@/lib/bills-fetch"
import { computeARState, computeAPStateFromBills } from "@/lib/state/ar-ap"
import { query } from "@/lib/db"
import { toEntityUriAr } from "@/lib/entity-uri"

type ReconTotals = {
  total_matched_inflows: number
  total_matched_outflows: number
  total_unmatched_inflows: number
  total_unmatched_outflows: number
  total_fees_paid: number
  matched_movement_count: number
  ar_linked_movement_count: number
  ap_linked_movement_count: number
  fee_row_count: number
  matched_inflows: ReconRow[]
  matched_outflows: ReconRow[]
  unmatched_inflows: ReconRow[]
  unmatched_outflows: ReconRow[]
}

type ReconAllocation = {
  entity_type: string
  entity_id: string
  gross: number
  fee: number
  net: number
}

type ReconRow = {
  movement_id: string
  amount: number
  date: string
  counterparty: string | null
  display_name: string | null
  allocations: ReconAllocation[]
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

  const ar = computeARState(invoices)
  const obligations = computeAPStateFromBills(bills)
  const allocationsByEntity = await fetchAllocationsByEntity(user.id)
  const arInvoicesWithAlloc = ar.invoices.map((inv) => {
    const uri = toEntityUriAr(inv.source as "qbo" | "xero" | "gmail" | "stripe", inv.invoice_id)
    const allocs = allocationsByEntity.get(uri) ?? []
    const amount_collected = r2(allocs.reduce((s, a) => s + a.gross, 0))
    const amount_remaining = r2(Math.max(0, inv.amount_due - amount_collected))
    return { ...inv, allocations: allocs, amount_collected, amount_remaining }
  })
  const apObligationsWithAlloc = obligations.map((ob) => {
    const uri = ob.obligation_id
    const allocs = allocationsByEntity.get(uri) ?? []
    const amount_paid = r2(allocs.reduce((s, a) => s + a.gross, 0))
    const amount_remaining = r2(Math.max(0, ob.expected_amount - amount_paid))
    return { ...ob, allocations: allocs, amount_paid, amount_remaining }
  })
  const ap = {
    total_expected_30d: r2(apObligationsWithAlloc.reduce((s, o) => s + o.expected_amount, 0)),
    obligation_count: apObligationsWithAlloc.length,
    obligations: apObligationsWithAlloc.sort((a, b) => a.days_until_due - b.days_until_due),
  }

  const recon = await fetchReconTotals(user.id)

  return NextResponse.json({ ar: { ...ar, invoices: arInvoicesWithAlloc }, ap, recon })
}

async function fetchReconTotals(userId: string): Promise<ReconTotals> {
  const totals = {
    total_matched_inflows: 0,
    total_matched_outflows: 0,
    total_unmatched_inflows: 0,
    total_unmatched_outflows: 0,
    total_fees_paid: 0,
    matched_movement_count: 0,
    ar_linked_movement_count: 0,
    ap_linked_movement_count: 0,
    fee_row_count: 0,
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

  const { rows: unmatchedRows } = await query<{ inflow_count: string; outflow_count: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN m.direction = 'inflow'  THEN 1 ELSE 0 END), 0)::text AS inflow_count,
       COALESCE(SUM(CASE WHEN m.direction = 'outflow' THEN 1 ELSE 0 END), 0)::text AS outflow_count
     FROM movements m
     WHERE m.user_id = $1
       AND m.duplicate_of IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM movement_attributions a
         WHERE a.user_id = m.user_id AND a.movement_id = m.id
       )`,
    [userId],
  )
  if (unmatchedRows[0]) {
    totals.total_unmatched_inflows = parseInt(unmatchedRows[0].inflow_count, 10) || 0
    totals.total_unmatched_outflows = parseInt(unmatchedRows[0].outflow_count, 10) || 0
  }

  const matched = await fetchMatchedMovementRows(userId)
  const unmatched = await fetchUnmatchedMovementRows(userId)
  totals.matched_movement_count = matched.length
  totals.ar_linked_movement_count = matched.filter((m) => m.allocations.some((a) => a.entity_type === "ar")).length
  totals.ap_linked_movement_count = matched.filter((m) => m.allocations.some((a) => a.entity_type === "ap")).length
  totals.fee_row_count = matched.reduce((acc, m) => acc + m.allocations.filter((a) => a.entity_type === "fee").length, 0)

  return {
    ...totals,
    matched_inflows: matched.filter((m) => m.direction === "inflow").map(({ direction: _d, ...rest }) => rest),
    matched_outflows: matched.filter((m) => m.direction === "outflow").map(({ direction: _d, ...rest }) => rest),
    unmatched_inflows: unmatched.filter((m) => m.direction === "inflow").map(({ direction: _d, ...rest }) => rest),
    unmatched_outflows: unmatched.filter((m) => m.direction === "outflow").map(({ direction: _d, ...rest }) => rest),
  }
}

async function fetchAllocationsByEntity(userId: string): Promise<Map<string, ReconAllocation[]>> {
  const { rows } = await query<{
    entity_id: string
    entity_type: string
    gross: string
    fee: string
    net: string
  }>(
    `SELECT
       a.entity_id,
       a.component_type AS entity_type,
       ABS(a.gross_amount::float)::text AS gross,
       COALESCE(
         CASE
           WHEN a.component_type = 'fee' THEN ABS(a.net_amount::float)
           ELSE (a.metadata->>'fee_amount')::float
         END,
         0
       )::text AS fee,
       ABS(a.net_amount::float)::text AS net
     FROM movement_attributions a
     WHERE a.user_id = $1
       AND a.component_type IN ('ar', 'ap')`,
    [userId],
  )

  const byEntity = new Map<string, ReconAllocation[]>()
  for (const r of rows) {
    const arr = byEntity.get(r.entity_id) ?? []
    arr.push({
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      gross: r2(parseFloat(r.gross) || 0),
      fee: r2(parseFloat(r.fee) || 0),
      net: r2(parseFloat(r.net) || 0),
    })
    byEntity.set(r.entity_id, arr)
  }
  return byEntity
}

async function fetchMatchedMovementRows(userId: string): Promise<(ReconRow & { direction: "inflow" | "outflow" })[]> {
  const { rows } = await query<{
    movement_id: string
    direction: "inflow" | "outflow"
    amount: string
    date: string
    counterparty: string | null
    counterparty_entity_id: string | null
    allocations: unknown
  }>(
    `SELECT
       m.id AS movement_id,
       m.direction,
       m.amount::text AS amount,
       m.date::text AS date,
       m.counterparty,
       m.counterparty_entity_id::text,
       jsonb_agg(
         jsonb_build_object(
           'entity_type', a.component_type,
           'entity_id', a.entity_id,
           'gross', ABS(a.gross_amount::float),
           'fee', COALESCE(
             CASE
               WHEN a.component_type = 'fee' THEN ABS(a.net_amount::float)
               ELSE (a.metadata->>'fee_amount')::float
             END,
             0
           ),
           'net', ABS(a.net_amount::float)
         )
         ORDER BY a.created_at ASC
       ) AS allocations
     FROM movements m
     JOIN movement_attributions a ON a.movement_id = m.id AND a.user_id = m.user_id
     WHERE m.user_id = $1
       AND m.duplicate_of IS NULL
     GROUP BY m.id
     ORDER BY m.date DESC`,
    [userId],
  )

  return rows.map((r) => ({
    movement_id: r.movement_id,
    direction: r.direction,
    amount: r2(Math.abs(parseFloat(r.amount) || 0)),
    date: r.date.slice(0, 10),
    counterparty: r.counterparty,
    display_name: r.counterparty ?? r.counterparty_entity_id ?? "—",
    allocations: (Array.isArray(r.allocations) ? r.allocations : []).map((a) => ({
      entity_type: String((a as Record<string, unknown>).entity_type ?? ""),
      entity_id: String((a as Record<string, unknown>).entity_id ?? ""),
      gross: r2(Number((a as Record<string, unknown>).gross ?? 0)),
      fee: r2(Number((a as Record<string, unknown>).fee ?? 0)),
      net: r2(Number((a as Record<string, unknown>).net ?? 0)),
    })),
  }))
}

async function fetchUnmatchedMovementRows(userId: string): Promise<(ReconRow & { direction: "inflow" | "outflow" })[]> {
  const { rows } = await query<{
    movement_id: string
    direction: "inflow" | "outflow"
    amount: string
    date: string
    counterparty: string | null
    counterparty_entity_id: string | null
  }>(
    `SELECT
       m.id AS movement_id,
       m.direction,
       m.amount::text AS amount,
       m.date::text AS date,
       m.counterparty,
       m.counterparty_entity_id::text
     FROM movements m
     WHERE m.user_id = $1
       AND m.duplicate_of IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM movement_attributions a
         WHERE a.user_id = m.user_id AND a.movement_id = m.id
       )
     ORDER BY m.date DESC
     LIMIT 500`,
    [userId],
  )
  return rows.map((r) => ({
    movement_id: r.movement_id,
    direction: r.direction,
    amount: r2(Math.abs(parseFloat(r.amount) || 0)),
    date: r.date.slice(0, 10),
    counterparty: r.counterparty,
    display_name: r.counterparty ?? r.counterparty_entity_id ?? "—",
    allocations: [],
  }))
}
