/**
 * Unified invoices table: one Postgres table per user aggregating invoices from QBO, Xero, and Stripe.
 * Updated whenever any source writes or deletes an invoice (sync, webhook, or GCP update).
 */

import { ensureUnifiedInvoicesSchema, query } from "./db"
import { log } from "./logger"

export type UnifiedInvoiceSource = "qbo" | "xero" | "stripe"

const SOURCE_PREFIX: Record<UnifiedInvoiceSource, string> = {
  qbo: "qb_",
  xero: "xr_",
  stripe: "st_",
}

/** Return prefixed invoice id for display: qb_{id}, xr_{id}, st_{id}. */
export function prefixedInvoiceId(source: UnifiedInvoiceSource, externalId: string): string {
  return SOURCE_PREFIX[source] + externalId
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

export type NormalizedInvoice = {
  number: string
  date: string | null
  total: number | null
  customer: string | null
  email: string | null
  amount_paid: number | null
  amount_due: number | null
  status: string | null
}

function normalizeQbo(item: Record<string, unknown>): NormalizedInvoice {
  const docNum = item.DocNumber != null ? String(item.DocNumber) : ""
  const txnDate = item.TxnDate != null ? String(item.TxnDate) : null
  const totalAmt = typeof item.TotalAmt === "number" ? item.TotalAmt : item.TotalAmt != null ? Number(item.TotalAmt) : null
  const balance = typeof item.Balance === "number" ? item.Balance : item.Balance != null ? Number(item.Balance) : null
  const amount_due = balance
  const amount_paid =
    totalAmt != null && balance != null ? Math.max(0, totalAmt - balance) : null
  const status = balance != null ? (balance === 0 ? "Paid" : "Open") : (item as { status?: string }).status ?? null
  const customerRef = item.CustomerRef as { name?: string } | undefined
  const customer = customerRef?.name != null ? String(customerRef.name) : null
  const billEmail = item.BillEmail as { Address?: string } | undefined
  const email = billEmail?.Address != null ? String(billEmail.Address) : null
  return { number: docNum, date: txnDate, total: totalAmt, customer, email, amount_paid, amount_due, status }
}

function normalizeXero(item: Record<string, unknown>): NormalizedInvoice {
  const number = item.InvoiceNumber != null ? String(item.InvoiceNumber) : ""
  const date = item.Date != null ? String(item.Date) : null
  const total = typeof item.Total === "number" ? item.Total : item.Total != null ? Number(item.Total) : null
  const amountPaid = typeof item.AmountPaid === "number" ? item.AmountPaid : item.AmountPaid != null ? Number(item.AmountPaid) : null
  const amountDue = typeof item.AmountDue === "number" ? item.AmountDue : item.AmountDue != null ? Number(item.AmountDue) : null
  const status = item.Status != null ? String(item.Status) : null
  const contact = item.Contact as { Name?: string; EmailAddress?: string } | undefined
  const customer = contact?.Name != null ? String(contact.Name) : null
  const email = contact?.EmailAddress != null ? String(contact.EmailAddress) : null
  return { number, date, total, customer, email, amount_paid: amountPaid, amount_due: amountDue, status }
}

function normalizeStripe(item: Record<string, unknown>): NormalizedInvoice {
  const number = item.number != null ? String(item.number) : item.id != null ? String(item.id) : ""
  const created = item.created != null ? String(item.created) : null
  const date = created ? new Date(Number(created) * 1000).toISOString().slice(0, 10) : null
  const totalCents = typeof item.total === "number" ? item.total : typeof item.amount_due === "number" ? item.amount_due : item.amount_paid != null ? Number(item.amount_paid) : null
  const total = totalCents != null ? Number(totalCents) / 100 : null
  const amount_paid = typeof item.amount_paid === "number" ? item.amount_paid / 100 : null
  const amount_due = typeof item.amount_due === "number" ? item.amount_due / 100 : null
  const status = item.status != null ? String(item.status) : null
  const customer = item.customer_email != null ? String(item.customer_email) : item.customer_name != null ? String(item.customer_name) : null
  const email = item.customer_email != null ? String(item.customer_email) : null
  return { number, date, total, customer, email, amount_paid, amount_due, status }
}

function normalize(source: UnifiedInvoiceSource, item: unknown): NormalizedInvoice {
  const empty: NormalizedInvoice = { number: "", date: null, total: null, customer: null, email: null, amount_paid: null, amount_due: null, status: null }
  if (item == null || typeof item !== "object") return empty
  const o = item as Record<string, unknown>
  switch (source) {
    case "qbo":
      return normalizeQbo(o)
    case "xero":
      return normalizeXero(o)
    case "stripe":
      return normalizeStripe(o)
    default:
      return empty
  }
}

function getExternalId(source: UnifiedInvoiceSource, item: unknown): string | null {
  if (item == null || typeof item !== "object") return null
  const o = item as Record<string, unknown>
  switch (source) {
    case "qbo":
      return o.Id != null ? String(o.Id) : null
    case "xero":
      return (o.InvoiceID ?? o.Id) != null ? String(o.InvoiceID ?? o.Id) : null
    case "stripe":
      return o.id != null ? String(o.id) : null
    default:
      return null
  }
}

/**
 * Upsert one or more invoices into unified_invoices for a user. Call this whenever QBO, Xero, or Stripe
 * writes or updates invoices (sync or webhook).
 */
export async function upsertUnifiedInvoices(
  userId: string,
  source: UnifiedInvoiceSource,
  sourceScope: string,
  items: unknown[]
): Promise<number> {
  if (!isProduction() || items.length === 0) return 0
  try {
    await ensureUnifiedInvoicesSchema()
    let count = 0
    for (const item of items) {
      const externalId = getExternalId(source, item)
      if (!externalId) continue
      const n = normalize(source, item)
      await query(
        `INSERT INTO unified_invoices (user_id, source, source_scope, external_id, data, invoice_number, invoice_date, total, customer_name, customer_email, amount_paid, amount_due, status, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT (user_id, source, source_scope, external_id) DO UPDATE SET
           data = EXCLUDED.data,
           invoice_number = EXCLUDED.invoice_number,
           invoice_date = EXCLUDED.invoice_date,
           total = EXCLUDED.total,
           customer_name = EXCLUDED.customer_name,
           customer_email = EXCLUDED.customer_email,
           amount_paid = EXCLUDED.amount_paid,
           amount_due = EXCLUDED.amount_due,
           status = EXCLUDED.status,
           updated_at = NOW()`,
        [userId, source, sourceScope, externalId, JSON.stringify(item), n.number || null, n.date, n.total, n.customer, n.email, n.amount_paid, n.amount_due, n.status]
      )
      count++
    }
    if (count > 0) {
      log("unified_invoices.upsert.succeeded", { userId, source, sourceScope, count }, "db")
    }
    return count
  } catch (err) {
    log("unified_invoices.upsert.failed", { userId, source, error: err instanceof Error ? err.message : String(err) }, "db")
    throw err
  }
}

/**
 * Remove one invoice from unified_invoices (e.g. when a source reports a delete).
 */
export async function deleteUnifiedInvoice(
  userId: string,
  source: UnifiedInvoiceSource,
  sourceScope: string,
  externalId: string
): Promise<boolean> {
  if (!isProduction()) return false
  try {
    await ensureUnifiedInvoicesSchema()
    const { rows } = await query<{ id: string }>(
      `DELETE FROM unified_invoices WHERE user_id = $1 AND source = $2 AND source_scope = $3 AND external_id = $4 RETURNING id`,
      [userId, source, sourceScope, externalId]
    )
    const deleted = rows.length > 0
    if (deleted) log("unified_invoices.delete.succeeded", { userId, source, sourceScope, externalId }, "db")
    return deleted
  } catch (err) {
    log("unified_invoices.delete.failed", { userId, source, externalId, error: err instanceof Error ? err.message : String(err) }, "db")
    return false
  }
}

export type UnifiedInvoiceRow = {
  unique_id: string
  id: string
  source: UnifiedInvoiceSource
  source_scope: string
  external_id: string
  data: unknown
  invoice_number: string | null
  invoice_date: string | null
  total: number | null
  customer_name: string | null
  email: string | null
  amount_paid: number | null
  amount_due: number | null
  status: string | null
  updated_at: string
}

/**
 * Return all unified invoices for a user, sorted by date descending.
 */
export async function getUnifiedInvoices(userId: string): Promise<UnifiedInvoiceRow[]> {
  if (!isProduction()) return []
  try {
    await ensureUnifiedInvoicesSchema()
    const { rows } = await query<{
      id: string
      source: string
      source_scope: string
      external_id: string
      data: unknown
      invoice_number: string | null
      invoice_date: string | null
      total: string | null
      customer_name: string | null
      customer_email: string | null
      amount_paid: string | null
      amount_due: string | null
      status: string | null
      updated_at: string
    }>(
      `SELECT id, source, source_scope, external_id, data, invoice_number, invoice_date, total, customer_name, customer_email, amount_paid, amount_due, status, updated_at
       FROM unified_invoices
       WHERE user_id = $1
       ORDER BY updated_at DESC NULLS LAST, invoice_date DESC NULLS LAST`,
      [userId]
    )
    return rows.map((r) => {
      const source = r.source as UnifiedInvoiceSource
      return {
      unique_id: r.id,
      id: prefixedInvoiceId(source, r.external_id),
      source,
      source_scope: r.source_scope,
      external_id: r.external_id,
      data: r.data,
      invoice_number: r.invoice_number,
      invoice_date: r.invoice_date,
      total: r.total != null ? Number(r.total) : null,
      customer_name: r.customer_name,
      email: r.customer_email,
      amount_paid: r.amount_paid != null ? Number(r.amount_paid) : null,
      amount_due: r.amount_due != null ? Number(r.amount_due) : null,
      status: r.status,
      updated_at: r.updated_at,
    }
    })
  } catch (err) {
    log("unified_invoices.get.failed", { userId, error: err instanceof Error ? err.message : String(err) }, "db")
    return []
  }
}

/**
 * Backfill unified_invoices for a user from current QBO, Xero, and Stripe entity stores (and GCP when enabled).
 * Call when unified list is empty but user has connections, so first load after deploy gets data.
 */
export async function backfillUnifiedInvoicesForUser(
  userId: string,
  options: {
    getQboInvoices: (realmId: string) => Promise<unknown[]>
    getXeroInvoices: (tenantId: string) => Promise<unknown[]>
    getStripeInvoices: (stripeAccountId: string) => Promise<unknown[]>
    realmIds: string[]
    tenantIds: string[]
    stripeAccountIds: string[]
  }
): Promise<void> {
  if (!isProduction()) return
  const { realmIds, tenantIds, stripeAccountIds, getQboInvoices, getXeroInvoices, getStripeInvoices } = options
  for (const realmId of realmIds) {
    try {
      const items = await getQboInvoices(realmId)
      if (items.length > 0) await upsertUnifiedInvoices(userId, "qbo", realmId, items)
    } catch (e) {
      log("unified_invoices.backfill.qbo.failed", { userId, realmId, error: String(e) }, "db")
    }
  }
  for (const tenantId of tenantIds) {
    try {
      const items = await getXeroInvoices(tenantId)
      if (items.length > 0) await upsertUnifiedInvoices(userId, "xero", tenantId, items)
    } catch (e) {
      log("unified_invoices.backfill.xero.failed", { userId, tenantId, error: String(e) }, "db")
    }
  }
  for (const stripeAccountId of stripeAccountIds) {
    try {
      const items = await getStripeInvoices(stripeAccountId)
      if (items.length > 0) await upsertUnifiedInvoices(userId, "stripe", stripeAccountId, items)
    } catch (e) {
      log("unified_invoices.backfill.stripe.failed", { userId, stripeAccountId, error: String(e) }, "db")
    }
  }
}
