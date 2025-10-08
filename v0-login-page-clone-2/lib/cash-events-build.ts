/**
 * Build / refresh cash_events and entity cash profile fields from invoices, obligations, and attributions.
 */

import { query, ensureMovementsSchema } from "./db"
import type { OutstandingInvoice } from "./state/types"
import type { APObligation } from "./state/ar-ap"
import type { ForecastEvent, EventReasoning } from "./state/types"

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000)
}

function addDays(date: string, days: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + Math.round(days))
  return d.toISOString().slice(0, 10)
}

const r2 = (n: number) => Math.round(n * 100) / 100

export type CashEventRow = {
  id: string
  user_id: string
  entity_id: string
  event_type: "ar" | "ap" | "settlement"
  amount: number
  probability: number
  expected_date: string
  source: "invoice" | "inferred" | "model" | "attribution"
  movement_id: string | null
  attribution_id: string | null
}

function defaultReasoning(label: string): EventReasoning {
  return {
    basis: label,
    payment_history: undefined,
    interval_info: undefined,
    amount_range: undefined,
    recurrence_info: undefined,
  }
}

/** Convert DB cash_events (next 30d) into forecast-engine events for merge. */
export function cashEventRowsToForecastEvents(rows: CashEventRow[], today: string): ForecastEvent[] {
  const horizon = addDays(today, 30)
  const out: ForecastEvent[] = []
  for (const r of rows) {
    if (r.expected_date < today || r.expected_date > horizon) continue
    const offset = daysBetween(today, r.expected_date)
    if (offset < 1) continue
    const base = defaultReasoning(`cash_events:${r.source}`)
    if (r.event_type === "ar") {
      out.push({
        date: r.expected_date,
        day_offset: offset,
        type: "customer_payment",
        entity: r.entity_id,
        amount: r2(Number(r.amount)),
        direction: "in",
        probability: r2(Math.min(1, Math.max(0, r.probability))),
        confidence: r.probability >= 0.75 ? "high" : r.probability >= 0.45 ? "medium" : "low",
        source_model: "customer",
        reasoning: { ...base, basis: `Bridge: AR (${r.source})` },
      })
    } else if (r.event_type === "ap") {
      out.push({
        date: r.expected_date,
        day_offset: offset,
        type: "vendor_payment",
        entity: r.entity_id,
        amount: r2(Number(r.amount)),
        direction: "out",
        probability: r2(Math.min(1, Math.max(0, r.probability))),
        confidence: r.probability >= 0.75 ? "high" : r.probability >= 0.45 ? "medium" : "low",
        source_model: "vendor",
        reasoning: { ...base, basis: `Bridge: AP (${r.source})` },
      })
    } else {
      out.push({
        date: r.expected_date,
        day_offset: offset,
        type: "settlement",
        entity: r.entity_id,
        amount: r2(Math.abs(Number(r.amount))),
        direction: Number(r.amount) >= 0 ? "in" : "out",
        probability: r2(Math.min(1, Math.max(0, r.probability))),
        confidence: "medium",
        source_model: "settlement",
        reasoning: { ...base, basis: `Bridge: settlement (${r.source})` },
      })
    }
  }
  return out
}

export async function fetchCashEventsForUser30d(userId: string): Promise<CashEventRow[]> {
  await ensureMovementsSchema()
  const today = new Date().toISOString().slice(0, 10)
  const end = addDays(today, 30)
  const { rows } = await query<CashEventRow & { amount: string; probability: string; expected_date: string }>(
    `SELECT id, user_id, entity_id, event_type, amount::float, probability::float, expected_date::text, source, movement_id, attribution_id
     FROM cash_events
     WHERE user_id = $1 AND expected_date >= $2::date AND expected_date <= $3::date
     ORDER BY expected_date ASC`,
    [userId, today, end],
  )
  return rows.map((r) => ({
    ...r,
    amount: parseFloat(String(r.amount)),
    probability: parseFloat(String(r.probability)),
    expected_date: (r.expected_date as string).slice(0, 10),
  }))
}

/**
 * Replace cash_events for user with rows derived from open invoices and bill obligations (v1).
 */
export async function syncCashEventsForUser(
  userId: string,
  invoices: OutstandingInvoice[],
  billObligations: APObligation[],
): Promise<void> {
  await ensureMovementsSchema()
  const today = new Date().toISOString().slice(0, 10)

  await query(`DELETE FROM cash_events WHERE user_id = $1`, [userId])

  for (const inv of invoices) {
    if (inv.amount_due <= 0) continue
    const expected = inv.due_date && inv.due_date >= today ? inv.due_date : addDays(today, Math.min(14, inv.days_until_due ?? 7))
    const prob =
      inv.status === "overdue" ? 0.85 : inv.status === "partially_paid" ? 0.7 : 0.55
    const entityLabel = inv.entity_uri ?? `${inv.source}:${inv.invoice_id}`
    await query(
      `INSERT INTO cash_events (user_id, entity_id, event_type, amount, probability, expected_date, source, metadata)
       VALUES ($1, $2, 'ar', $3, $4, $5::date, 'invoice', $6::jsonb)`,
      [userId, entityLabel, inv.amount_due, prob, expected, JSON.stringify({ invoice_id: inv.invoice_id, customer_name: inv.customer_name })],
    )
  }

  for (const ob of billObligations) {
    if (ob.amount_due <= 0) continue
    const expected = (ob.next_expected_date >= today
      ? ob.next_expected_date
      : ob.due_date && ob.due_date >= today
        ? ob.due_date
        : addDays(today, 14)) as string
    await query(
      `INSERT INTO cash_events (user_id, entity_id, event_type, amount, probability, expected_date, source, metadata)
       VALUES ($1, $2, 'ap', $3, $4, $5::date, 'inferred', $6::jsonb)`,
      [userId, ob.obligation_id, ob.amount_due, 0.6, expected, JSON.stringify({ vendor_name: ob.vendor_name })],
    )
  }
}

/** Aggregate inflow/outflow by counterparty entity from attributions + movements. */
export async function refreshEntityCashProfilesFromAttributions(userId: string): Promise<void> {
  await ensureMovementsSchema()
  type AggRow = {
    entity_uuid: string
    inflow: string
    outflow: string
    cnt: string
    avg_abs: string
  }
  const { rows } = await query<AggRow>(
    `SELECT m.counterparty_entity_id::text AS entity_uuid,
            SUM(CASE WHEN m.direction = 'inflow' THEN ABS(a.net_amount::float) ELSE 0 END) AS inflow,
            SUM(CASE WHEN m.direction = 'outflow' THEN ABS(a.net_amount::float) ELSE 0 END) AS outflow,
            COUNT(*)::text AS cnt,
            AVG(ABS(a.net_amount::float))::text AS avg_abs
     FROM movement_attributions a
     JOIN movements m ON m.id = a.movement_id AND m.user_id = a.user_id
     WHERE a.user_id = $1 AND m.counterparty_entity_id IS NOT NULL
       AND a.component_type IN ('ar', 'ap', 'fee', 'transfer', 'settlement')
     GROUP BY m.counterparty_entity_id`,
    [userId],
  )

  for (const r of rows) {
    const inflow = parseFloat(r.inflow) || 0
    const outflow = parseFloat(r.outflow) || 0
    const cnt = parseInt(r.cnt, 10) || 0
    const avgAbs = parseFloat(r.avg_abs) || 0
    const reliability = Math.min(1, 0.35 + cnt * 0.05)
    try {
      await query(
        `INSERT INTO entity_payment_profiles (user_id, entity_id, total_inflow, total_outflow, avg_payment_amount, reliability_score, last_updated)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id, entity_id) DO UPDATE SET
           total_inflow = EXCLUDED.total_inflow,
           total_outflow = EXCLUDED.total_outflow,
           avg_payment_amount = EXCLUDED.avg_payment_amount,
           reliability_score = EXCLUDED.reliability_score,
           last_updated = NOW()`,
        [userId, r.entity_uuid, inflow, outflow, avgAbs, reliability],
      )
    } catch {
      /* counterparty may not exist in entities — skip */
    }
  }
}
