/**
 * AP/AR: core truth for payables and receivables.
 * findApArMatch + upsertApArFromInvoice link invoice documents (Stripe, QBO, Gmail) to canonical AP/AR rows.
 */

import { ensureApArSchema, ensureInvoiceDocumentsSchema, query } from "./db"
import { insertInvoiceDocument, type InvoiceProvider, type NormalizedInvoiceJSON } from "./invoice-documents"
import { log } from "./logger"

const TOLERANCE = 0.01
const DATE_WINDOW_DAYS = 7

function normalizeInvoiceNumber(n: string | null): string {
  if (!n || typeof n !== "string") return ""
  return n.replace(/\s+/g, "").replace(/-/g, "").toUpperCase()
}

function dateWithinWindow(d1: string | null, d2: string | null): boolean {
  if (!d1 || !d2) return false
  const a = new Date(d1).getTime()
  const b = new Date(d2).getTime()
  const diff = Math.abs(a - b)
  return diff <= DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000
}

export type ApArRow = {
  id: string
  user_id: string
  side: string
  status: string
  invoice_number: string | null
  issue_date: string | null
  due_date: string | null
  currency: string | null
  amount_total: number
  amount_outstanding: number
  counterparty_type: string | null
  counterparty_name: string | null
  counterparty_email: string | null
  description: string | null
  source_summary: Record<string, unknown>
  created_at: string
  updated_at: string
}

export async function findApArMatch(
  userId: string,
  side: "AP" | "AR",
  invoiceNumber: string | null,
  total: number,
  issueDate: string | null,
  counterpartyName: string | null
): Promise<ApArRow | null> {
  await ensureApArSchema()
  const normNum = normalizeInvoiceNumber(invoiceNumber)

  if (normNum) {
    const { rows } = await query<ApArRow & { amount_total: string; amount_outstanding: string }>(
      `SELECT id, user_id, side, status, invoice_number, issue_date, due_date, currency, amount_total, amount_outstanding,
              counterparty_type, counterparty_name, counterparty_email, description, source_summary, created_at, updated_at
       FROM ap_ar
       WHERE user_id = $1 AND side = $2 AND (
         UPPER(REPLACE(REPLACE(COALESCE(invoice_number,''), ' ', ''), '-', '')) = $3
         OR (invoice_number IS NOT NULL AND UPPER(REPLACE(REPLACE(invoice_number, ' ', ''), '-', '')) = $3)
       )
       LIMIT 1`,
      [userId, side, normNum]
    )
    if (rows.length > 0) {
      const r = rows[0]
      return {
        ...r,
        amount_total: Number(r.amount_total),
        amount_outstanding: Number(r.amount_outstanding),
        source_summary: (r.source_summary as Record<string, unknown>) ?? {},
      }
    }
  }

  const { rows } = await query<ApArRow & { amount_total: string; amount_outstanding: string }>(
    `SELECT id, user_id, side, status, invoice_number, issue_date, due_date, currency, amount_total, amount_outstanding,
            counterparty_type, counterparty_name, counterparty_email, description, source_summary, created_at, updated_at
     FROM ap_ar
     WHERE user_id = $1 AND side = $2
       AND ABS(amount_total - $3::numeric) < $4
       AND ($5::date IS NULL OR issue_date IS NULL OR (issue_date BETWEEN $5::date - INTERVAL '7 days' AND $5::date + INTERVAL '7 days'))
       AND ($6::text IS NULL OR counterparty_name IS NULL OR LOWER(counterparty_name) = LOWER($6))
     ORDER BY updated_at DESC
     LIMIT 5`,
    [userId, side, total, TOLERANCE, issueDate ?? null, counterpartyName ?? null]
  )

  for (const r of rows) {
    if (dateWithinWindow(r.issue_date, issueDate)) {
      return {
        ...r,
        amount_total: Number(r.amount_total),
        amount_outstanding: Number(r.amount_outstanding),
        source_summary: (r.source_summary as Record<string, unknown>) ?? {},
      }
    }
  }
  return null
}

function mergeSourceSummary(
  existing: Record<string, unknown>,
  provider: string,
  doc: NormalizedInvoiceJSON
): Record<string, unknown> {
  const next = { ...existing }
  const providerId = doc.meta.provider_invoice_id
  const payload: Record<string, unknown> = {
    provider_invoice_id: providerId,
    invoice_number: doc.invoice_number,
    total: doc.total,
  }
  if (doc.meta.stripe_invoice_id) payload.stripe_invoice_id = doc.meta.stripe_invoice_id
  if (doc.meta.qbo_invoice_id) payload.qbo_invoice_id = doc.meta.qbo_invoice_id
  if (doc.meta.gmail_message_id) payload.gmail_message_id = doc.meta.gmail_message_id
  next[provider] = payload
  return next
}

export async function upsertApArFromInvoice(
  normalized: NormalizedInvoiceJSON,
  provider: InvoiceProvider,
  providerInvoiceId: string,
  raw: unknown
): Promise<string> {
  await ensureApArSchema()
  await ensureInvoiceDocumentsSchema()

  const side = normalized.side === "unknown" ? "AR" : normalized.side
  const match = await findApArMatch(
    normalized.user_id,
    side as "AP" | "AR",
    normalized.invoice_number,
    normalized.total ?? 0,
    normalized.issue_date,
    normalized.counterparty_name
  )

  if (match) {
    const merged = mergeSourceSummary(match.source_summary, provider, normalized)
    await query(
      `UPDATE ap_ar SET
        source_summary = $1::jsonb,
        amount_outstanding = COALESCE($2::numeric, amount_outstanding),
        status = COALESCE($3, status),
        counterparty_name = COALESCE(counterparty_name, $5),
        counterparty_email = COALESCE(counterparty_email, $6),
        due_date = COALESCE(due_date, $7::date),
        invoice_number = COALESCE(invoice_number, $8),
        currency = COALESCE(currency, $9),
        updated_at = NOW()
      WHERE id = $4`,
      [
        JSON.stringify(merged),
        normalized.amount_outstanding ?? match.amount_outstanding,
        normalized.status !== "unknown" ? normalized.status : match.status,
        match.id,
        normalized.counterparty_name,
        normalized.counterparty_email,
        normalized.due_date,
        normalized.invoice_number,
        normalized.currency,
      ]
    )
    await insertInvoiceDocument(normalized, provider, providerInvoiceId, match.id, raw)
    log("ap_ar.upsert.matched", { apArId: match.id, provider, providerInvoiceId }, "db")
    return match.id
  }

  const amountOutstanding = normalized.amount_outstanding ?? normalized.total ?? 0
  const sourceSummaryJson = JSON.stringify(mergeSourceSummary({}, provider, normalized))
  const { rows } = await query<{ id: string }>(
    `INSERT INTO ap_ar (user_id, side, status, invoice_number, issue_date, due_date, currency, amount_total, amount_outstanding, counterparty_type, counterparty_name, counterparty_email, description, source_summary)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     ON CONFLICT (user_id, side, invoice_number) WHERE invoice_number IS NOT NULL DO UPDATE SET
       source_summary = ap_ar.source_summary || EXCLUDED.source_summary,
       amount_outstanding = COALESCE(EXCLUDED.amount_outstanding, ap_ar.amount_outstanding),
       status = COALESCE(EXCLUDED.status, ap_ar.status),
       counterparty_name = COALESCE(ap_ar.counterparty_name, EXCLUDED.counterparty_name),
       counterparty_email = COALESCE(ap_ar.counterparty_email, EXCLUDED.counterparty_email),
       due_date = COALESCE(ap_ar.due_date, EXCLUDED.due_date),
       currency = COALESCE(ap_ar.currency, EXCLUDED.currency),
       updated_at = NOW()
     RETURNING id`,
    [
      normalized.user_id,
      side,
      normalized.status || "open",
      normalized.invoice_number,
      normalized.issue_date,
      normalized.due_date,
      normalized.currency ?? "USD",
      normalized.total ?? 0,
      amountOutstanding,
      normalized.counterparty_type,
      normalized.counterparty_name,
      normalized.counterparty_email,
      null,
      sourceSummaryJson,
    ]
  )
  const apArId = rows[0].id
  await insertInvoiceDocument(normalized, provider, providerInvoiceId, apArId, raw)
  log("ap_ar.upsert.created", { apArId, provider, providerInvoiceId }, "db")
  return apArId
}

export async function getApArList(
  userId: string,
  side: "AP" | "AR"
): Promise<ApArRow[]> {
  await ensureApArSchema()
  const { rows } = await query<ApArRow & { amount_total: string; amount_outstanding: string }>(
    `SELECT id, user_id, side, status, invoice_number, issue_date, due_date, currency, amount_total, amount_outstanding,
            counterparty_type, counterparty_name, counterparty_email, description, source_summary, created_at, updated_at
     FROM ap_ar
     WHERE user_id = $1 AND side = $2
     ORDER BY updated_at DESC NULLS LAST, issue_date DESC NULLS LAST`,
    [userId, side]
  )
  return rows.map((r) => ({
    ...r,
    amount_total: Number(r.amount_total),
    amount_outstanding: Number(r.amount_outstanding),
    source_summary: (r.source_summary as Record<string, unknown>) ?? {},
  }))
}

export async function getApArById(userId: string, apArId: string): Promise<ApArRow | null> {
  await ensureApArSchema()
  const { rows } = await query<ApArRow & { amount_total: string; amount_outstanding: string }>(
    `SELECT id, user_id, side, status, invoice_number, issue_date, due_date, currency, amount_total, amount_outstanding,
            counterparty_type, counterparty_name, counterparty_email, description, source_summary, created_at, updated_at
     FROM ap_ar
     WHERE id = $1 AND user_id = $2`,
    [apArId, userId]
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    ...r,
    amount_total: Number(r.amount_total),
    amount_outstanding: Number(r.amount_outstanding),
    source_summary: (r.source_summary as Record<string, unknown>) ?? {},
  }
}
