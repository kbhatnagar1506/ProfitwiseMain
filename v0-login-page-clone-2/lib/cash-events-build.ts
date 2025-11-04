/**
 * Build / refresh cash_events and entity cash profile fields from invoices, obligations, and attributions.
 */

import { query, ensureMovementsSchema } from "./db"
import type { OutstandingInvoice } from "./state/types"
import type { APObligation } from "./state/ar-ap"
import type { ForecastEvent, EventReasoning } from "./state/types"
import { buildArExpectedCollectionMap, type ArPaymentObservation } from "./state/behavioral-timing-ar"

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
  metadata: Record<string, unknown>
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
    const md = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>
    const canonicalName = typeof md.canonical_name === "string"
      ? md.canonical_name
      : typeof md.customer_name === "string"
        ? md.customer_name
        : typeof md.vendor_name === "string"
          ? md.vendor_name
          : r.entity_id
    const invoiceId = typeof md.invoice_id === "string" ? md.invoice_id : undefined
    const billId = typeof md.bill_id === "string" ? md.bill_id : undefined
    if (r.event_type === "ar") {
      out.push({
        date: r.expected_date,
        day_offset: offset,
        type: "customer_payment",
        entity: canonicalName,
        amount: r2(Number(r.amount)),
        direction: "in",
        probability: r2(Math.min(1, Math.max(0, r.probability))),
        confidence: r.probability >= 0.75 ? "high" : r.probability >= 0.45 ? "medium" : "low",
        source_model: "customer",
        reasoning: { ...base, basis: `Bridge: AR (${r.source})` },
        ...(invoiceId ? { invoice_id: invoiceId } : {}),
      })
    } else if (r.event_type === "ap") {
      out.push({
        date: r.expected_date,
        day_offset: offset,
        type: "vendor_payment",
        entity: canonicalName,
        amount: r2(Number(r.amount)),
        direction: "out",
        probability: r2(Math.min(1, Math.max(0, r.probability))),
        confidence: r.probability >= 0.75 ? "high" : r.probability >= 0.45 ? "medium" : "low",
        source_model: "vendor",
        reasoning: { ...base, basis: `Bridge: AP (${r.source})` },
        ...(billId ? { bill_id: billId } : {}),
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
    `SELECT id, user_id, entity_id, event_type, amount::float, probability::float, expected_date::text, source, movement_id, attribution_id, metadata
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
    metadata: (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>,
  }))
}

function normalizeVendorKey(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function median(vals: number[]): number | null {
  if (vals.length === 0) return null
  const sorted = [...vals].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

async function fetchArPaymentObservations(userId: string): Promise<ArPaymentObservation[]> {
  type ArObsRow = {
    entity_id: string | null
    customer_id: string | null
    counterparty: string | null
    raw_description: string | null
    date: string
    amount: string
    economic_class: string
    tag_data: Record<string, unknown> | null
  }
  const { rows } = await query<ArObsRow>(
    `SELECT
       m.counterparty_entity_id::text AS entity_id,
       COALESCE(mt.tag_data->>'customer_id', NULL) AS customer_id,
       m.counterparty,
       m.raw_description,
       m.date::text AS date,
       m.amount::float::text AS amount,
       mt.economic_class,
       mt.tag_data
     FROM movements m
     JOIN movement_tags mt ON mt.movement_id = m.id
     WHERE m.user_id = $1
       AND m.duplicate_of IS NULL
       AND mt.economic_class = 'customer_receipt'
     ORDER BY m.date ASC`,
    [userId],
  )
  return rows.map((r) => {
    const td = (r.tag_data && typeof r.tag_data === "object" ? r.tag_data : {}) as Record<string, unknown>
    return {
      entity_id: r.entity_id,
      customer_id: typeof r.customer_id === "string" ? r.customer_id : null,
      counterparty: r.counterparty,
      raw_description: r.raw_description,
      date: r.date.slice(0, 10),
      amount: parseFloat(r.amount) || 0,
      classification_confidence: typeof td.classification_confidence === "number" ? td.classification_confidence : null,
      is_anomaly: Boolean(td.is_anomaly),
      is_large_outlier: Boolean(td.is_large_outlier),
      is_first_seen_counterparty: Boolean(td.is_first_seen_counterparty),
      state_inclusion_policy: typeof td.state_inclusion_policy === "string" ? td.state_inclusion_policy : null,
      counterparty_role: typeof td.counterparty_role === "string" ? td.counterparty_role : null,
      invoice_id: typeof td.invoice_id === "string" ? td.invoice_id : null,
    }
  })
}

async function fetchApMedianDelayByVendorName(userId: string, windowDays: number): Promise<Map<string, number>> {
  type AttrRow = { obligation_uri: string; paid_date: string }
  const { rows: attrRows } = await query<AttrRow>(
    `SELECT a.entity_id AS obligation_uri, m.date::text AS paid_date
     FROM movement_attributions a
     JOIN movements m ON m.id = a.movement_id AND m.user_id = a.user_id
     WHERE a.user_id = $1
       AND a.component_type = 'ap'
       AND a.entity_id LIKE 'ap://bill/%'
       AND m.date >= (CURRENT_DATE - ($2::int * INTERVAL '1 day'))`,
    [userId, windowDays],
  )
  if (attrRows.length === 0) return new Map()

  const qboIds = new Set<string>()
  const xeroIds = new Set<string>()
  for (const r of attrRows) {
    const parts = r.obligation_uri.split("/")
    const source = parts[3]
    const billId = parts[4]
    if (!source || !billId) continue
    if (source === "qbo") qboIds.add(billId)
    if (source === "xero") xeroIds.add(billId)
  }

  const qboById = new Map<string, { dueDate: string | null; vendorName: string | null }>()
  const xeroById = new Map<string, { dueDate: string | null; vendorName: string | null }>()

  if (qboIds.size > 0) {
    type QboBill = { entity_id: string; data: Record<string, unknown> }
    const { rows } = await query<QboBill>(
      `SELECT entity_id, data FROM qbo_entities
       WHERE entity_type = 'Bill' AND entity_id = ANY($1::text[])`,
      [[...qboIds]],
    )
    for (const r of rows) {
      const dueDate = typeof r.data?.DueDate === "string" ? r.data.DueDate.slice(0, 10) : null
      const vendRef = r.data?.VendorRef as Record<string, unknown> | undefined
      const vendorName = vendRef?.name != null ? String(vendRef.name) : null
      qboById.set(r.entity_id, { dueDate, vendorName })
    }
  }

  if (xeroIds.size > 0) {
    type XeroBill = { entity_id: string; data: Record<string, unknown> }
    const { rows } = await query<XeroBill>(
      `SELECT entity_id, data FROM xero_entities
       WHERE entity_type = 'Bill' AND entity_id = ANY($1::text[])`,
      [[...xeroIds]],
    )
    for (const r of rows) {
      const dd = typeof r.data?.DueDateString === "string"
        ? r.data.DueDateString
        : typeof r.data?.DueDate === "string"
          ? r.data.DueDate
          : null
      const dueDate = dd ? dd.slice(0, 10) : null
      const contact = r.data?.Contact as Record<string, unknown> | undefined
      const vendorName = contact?.Name != null ? String(contact.Name) : null
      xeroById.set(r.entity_id, { dueDate, vendorName })
    }
  }

  const delaysByVendor = new Map<string, number[]>()
  for (const r of attrRows) {
    const parts = r.obligation_uri.split("/")
    const source = parts[3]
    const billId = parts[4]
    if (!source || !billId) continue

    const doc = source === "qbo" ? qboById.get(billId) : source === "xero" ? xeroById.get(billId) : undefined
    if (!doc?.dueDate || !doc.vendorName) continue
    const delay = daysBetween(doc.dueDate, r.paid_date.slice(0, 10))
    const key = normalizeVendorKey(doc.vendorName)
    const arr = delaysByVendor.get(key) ?? []
    arr.push(delay)
    delaysByVendor.set(key, arr)
  }

  const medians = new Map<string, number>()
  for (const [k, arr] of delaysByVendor) {
    const m = median(arr)
    if (m != null) medians.set(k, Math.round(m))
  }
  return medians
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
  const arObservations = await fetchArPaymentObservations(userId)
  const arExpectedByInvoice = buildArExpectedCollectionMap(invoices, arObservations, today)
  const apMedianDelayByVendorName = await fetchApMedianDelayByVendorName(userId, 120)

  await query(`DELETE FROM cash_events WHERE user_id = $1`, [userId])

  for (const inv of invoices) {
    if (inv.amount_due <= 0) continue
    const expectedFromArLayer2 = arExpectedByInvoice.get(inv.invoice_id)
    const fallbackExpected = inv.due_date && inv.due_date >= today ? inv.due_date : addDays(today, Math.min(14, inv.days_until_due ?? 7))
    const expected = expectedFromArLayer2 ?? fallbackExpected
    const prob =
      inv.status === "overdue" ? 0.85 : inv.status === "partially_paid" ? 0.7 : 0.55
    const entityLabel = inv.entity_uri ?? `${inv.source}:${inv.invoice_id}`
    await query(
      `INSERT INTO cash_events (user_id, entity_id, event_type, amount, probability, expected_date, source, metadata)
       VALUES ($1, $2, 'ar', $3, $4, $5::date, 'invoice', $6::jsonb)`,
      [userId, entityLabel, inv.amount_due, prob, expected, JSON.stringify({
        invoice_id: inv.invoice_id,
        customer_name: inv.customer_name,
        canonical_name: inv.customer_name,
      })],
    )
  }

  for (const ob of billObligations) {
    if (ob.amount_due <= 0) continue
    const fallbackExpected = (ob.next_expected_date >= today
      ? ob.next_expected_date
      : ob.due_date && ob.due_date >= today
        ? ob.due_date
        : addDays(today, 14)) as string
    const vendorDelay = apMedianDelayByVendorName.get(normalizeVendorKey(ob.vendor_name))
    const delayedExpected = ob.due_date && vendorDelay != null ? addDays(ob.due_date, vendorDelay) : fallbackExpected
    const expected = delayedExpected < addDays(today, 1) ? addDays(today, 1) : delayedExpected
    await query(
      `INSERT INTO cash_events (user_id, entity_id, event_type, amount, probability, expected_date, source, metadata)
       VALUES ($1, $2, 'ap', $3, $4, $5::date, 'inferred', $6::jsonb)`,
      [userId, ob.obligation_id, ob.amount_due, 0.6, expected, JSON.stringify({
        bill_id: ob.bill_id,
        vendor_name: ob.vendor_name,
        canonical_name: ob.vendor_name,
        vendor_delay_days: vendorDelay ?? null,
      })],
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
