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
  /** Remaining obligation (expectation layer); defaults to amount when unset. */
  outstanding_amount?: number
  /** Signed amount: positive for AR (inflows), negative for AP (outflows). */
  amount_signed?: number
  /** Credit classification for zero/negative outstanding amounts. */
  credit_type?: "none" | "vendor_credit" | "customer_overpayment"
  status?: "open" | "partially_paid" | "paid" | "credit"
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
    const outstanding =
      r.outstanding_amount != null && !Number.isNaN(Number(r.outstanding_amount))
        ? Number(r.outstanding_amount)
        : Number(r.amount)
    if (r.status === "paid" || outstanding <= 0) continue
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
        amount: r2(outstanding),
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
        amount: r2(outstanding),
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
  const { rows } = await query<
    CashEventRow & {
      amount: string
      outstanding_amount: string | null
      probability: string
      expected_date: string
    }
  >(
    `SELECT id, user_id, entity_id, event_type, amount::float, outstanding_amount::float, status,
            probability::float, expected_date::text, source, movement_id, attribution_id, metadata
     FROM cash_events
     WHERE user_id = $1 AND expected_date >= $2::date AND expected_date <= $3::date
     ORDER BY expected_date ASC`,
    [userId, today, end],
  )
  return rows.map((r) => ({
    ...r,
    amount: parseFloat(String(r.amount)),
    outstanding_amount:
      r.outstanding_amount != null && r.outstanding_amount !== ""
        ? parseFloat(String(r.outstanding_amount))
        : undefined,
    status: (r.status as CashEventRow["status"]) ?? undefined,
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
 * Upsert cash_events from open invoices and bill obligations; preserve reconciliation balances on conflict.
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

  /** Stable upsert keys from current sync — AR and AP must not share one exclusion list or a pure-AR sync marks all AP rows stale (and vice versa). */
  const arStableIds: string[] = []
  const apStableIds: string[] = []

  const upsertArSql = `INSERT INTO cash_events (
      user_id, entity_id, event_type, amount, outstanding_amount, status, probability, expected_date, source, metadata
    ) VALUES ($1, $2, 'ar', $3, $4, $5, $6, $7::date, 'invoice', $8::jsonb)
    ON CONFLICT (user_id, event_type, entity_id) DO UPDATE SET
      amount = EXCLUDED.amount,
      outstanding_amount = EXCLUDED.outstanding_amount,
      probability = EXCLUDED.probability,
      expected_date = EXCLUDED.expected_date,
      source = EXCLUDED.source,
      metadata = EXCLUDED.metadata,
      updated_at = NOW(),
      status = CASE
        WHEN (cash_events.metadata->>'manual_paid')::boolean = true THEN cash_events.status
        WHEN cash_events.last_reconciled_at IS NOT NULL
          AND COALESCE(cash_events.outstanding_amount, cash_events.amount) <= 0.01 THEN 'paid'
        WHEN EXCLUDED.outstanding_amount <= 0.01 THEN 'paid'
        WHEN EXCLUDED.outstanding_amount < EXCLUDED.amount THEN 'partially_paid'
        ELSE 'open'
      END`

  const upsertApSql = `INSERT INTO cash_events (
      user_id, entity_id, event_type, amount, outstanding_amount, status, probability, expected_date, source, metadata
    ) VALUES ($1, $2, 'ap', $3, $3, $4, $5, $6::date, 'inferred', $7::jsonb)
    ON CONFLICT (user_id, event_type, entity_id) DO UPDATE SET
      amount = EXCLUDED.amount,
      probability = EXCLUDED.probability,
      expected_date = EXCLUDED.expected_date,
      source = EXCLUDED.source,
      metadata = EXCLUDED.metadata,
      updated_at = NOW(),
      outstanding_amount = CASE
        WHEN COALESCE(cash_events.outstanding_amount, cash_events.amount) < cash_events.amount
        THEN LEAST(COALESCE(cash_events.outstanding_amount, cash_events.amount), EXCLUDED.amount)
        ELSE EXCLUDED.amount
      END,
      status = CASE
        -- F3: Never overwrite a manually-verified or bank-reconciled payment back to open
        WHEN (cash_events.metadata->>'manual_paid')::boolean = true THEN cash_events.status
        WHEN cash_events.last_reconciled_at IS NOT NULL
          AND COALESCE(cash_events.outstanding_amount, cash_events.amount) <= 0.01 THEN 'paid'
        -- Normal outstanding-amount-derived status
        WHEN (CASE
          WHEN COALESCE(cash_events.outstanding_amount, cash_events.amount) < cash_events.amount
          THEN LEAST(COALESCE(cash_events.outstanding_amount, cash_events.amount), EXCLUDED.amount)
          ELSE EXCLUDED.amount
        END) <= 0.01 THEN 'paid'
        WHEN (CASE
          WHEN COALESCE(cash_events.outstanding_amount, cash_events.amount) < cash_events.amount
          THEN LEAST(COALESCE(cash_events.outstanding_amount, cash_events.amount), EXCLUDED.amount)
          ELSE EXCLUDED.amount
        END) < EXCLUDED.amount THEN 'partially_paid'
        ELSE 'open'
      END`

  const upsertArPaidSql = `INSERT INTO cash_events (
      user_id, entity_id, event_type, amount, outstanding_amount, status, probability, expected_date, source, metadata
    ) VALUES ($1, $2, 'ar', $3, 0, 'paid', $4, $5::date, 'invoice', $6::jsonb)
    ON CONFLICT (user_id, event_type, entity_id) DO UPDATE SET
      amount = EXCLUDED.amount,
      probability = EXCLUDED.probability,
      expected_date = EXCLUDED.expected_date,
      source = EXCLUDED.source,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()`

  for (const inv of invoices) {
    const entityLabel = inv.entity_uri ?? `${inv.source}:${inv.invoice_id}`
    arStableIds.push(entityLabel)

    const metadata = JSON.stringify({
      invoice_id: inv.invoice_id,
      customer_name: inv.customer_name,
      canonical_name: inv.customer_name,
      ...(inv.entity_id ? { graph_entity_id: inv.entity_id } : {}),
    })

    if (inv.status === "paid" || inv.amount_due <= 0) {
      const expectedFromArLayer2 = arExpectedByInvoice.get(inv.invoice_id)
      const fallbackExpected = inv.due_date ?? addDays(today, 0)
      const expected = expectedFromArLayer2 ?? fallbackExpected
      await query(upsertArPaidSql, [
        userId,
        entityLabel,
        inv.amount,
        1.0,
        expected,
        metadata,
      ])
    } else {
      const expectedFromArLayer2 = arExpectedByInvoice.get(inv.invoice_id)
      const fallbackExpected = inv.due_date && inv.due_date >= today ? inv.due_date : addDays(today, Math.min(14, inv.days_until_due ?? 7))
      const expected = expectedFromArLayer2 ?? fallbackExpected
      const prob =
        inv.status === "overdue" ? 0.55 : inv.status === "partially_paid" ? 0.75 : 0.85
      const statusInit: "open" | "partially_paid" | "paid" = inv.amount_due < inv.amount ? "partially_paid" : "open"
      await query(upsertArSql, [
        userId,
        entityLabel,
        inv.amount,      // Original invoice total
        inv.amount_due,  // Outstanding amount
        statusInit,
        prob,
        expected,
        metadata,
      ])
    }
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
    apStableIds.push(ob.obligation_id)
    const statusInit: "open" | "partially_paid" | "paid" = "open"
    await query(upsertApSql, [
      userId,
      ob.obligation_id,
      ob.amount_due,
      statusInit,
      0.6,
      expected,
      JSON.stringify({
        bill_id: ob.bill_id,
        vendor_name: ob.vendor_name,
        canonical_name: ob.vendor_name,
        vendor_delay_days: vendorDelay ?? null,
        ...(ob.entity_id ? { graph_entity_id: ob.entity_id } : {}),
      }),
    ])
  }

  const staleSet = `SET status = 'paid',
         outstanding_amount = 0,
         metadata = COALESCE(metadata, '{}'::jsonb) || '{"stale_reason":"removed_from_source"}'::jsonb,
         updated_at = NOW()`
  if (arStableIds.length > 0) {
    await query(
      `UPDATE cash_events
       ${staleSet}
       WHERE user_id = $1::uuid
         AND source = 'invoice'
         AND event_type = 'ar'
         AND NOT (entity_id = ANY($2::text[]))`,
      [userId, arStableIds],
    )
  }
  if (apStableIds.length > 0) {
    await query(
      `UPDATE cash_events
       ${staleSet}
       WHERE user_id = $1::uuid
         AND source = 'inferred'
         AND event_type = 'ap'
         AND NOT (entity_id = ANY($2::text[]))`,
      [userId, apStableIds],
    )
  }

  // Clean up orphaned attributions pointing to stale cash_events
  // This prevents inflated matched amounts when invoices/bills are deleted from accounting system
  const { rowCount: orphanedCount } = await query(
    `DELETE FROM movement_attributions
     WHERE user_id = $1::uuid
       AND entity_id IN (
         SELECT entity_id FROM cash_events 
         WHERE user_id = $1::uuid 
           AND metadata->>'stale_reason' = 'removed_from_source'
       )`,
    [userId]
  )
  if (orphanedCount && orphanedCount > 0) {
    console.log(`[cash-events-build] Cleaned up ${orphanedCount} orphaned attributions for user:`, userId)
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
