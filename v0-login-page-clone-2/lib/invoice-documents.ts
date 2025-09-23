/**
 * Invoice documents: per-provider invoice/bill documents that feed into AP/AR (ap_ar table).
 * Each document is a normalized view of a source invoice (Stripe, QBO, Gmail, etc.), plus the raw payload.
 */

import { ensureInvoiceDocumentsSchema, query } from "./db"
import { log } from "./logger"

export type InvoiceProvider = "stripe" | "qbo" | "xero" | "gmail" | "manual" | "other"

export type NormalizedInvoiceJSON = {
  version: 1
  user_id: string
  side: "AP" | "AR" | "unknown"
  kind: "invoice" | "bill" | "other"
  invoice_number: string | null
  issue_date: string | null
  due_date: string | null
  currency: string | null
  total: number | null
  amount_outstanding: number | null
  status: "open" | "paid" | "partially_paid" | "void" | "cancelled" | "draft" | "unknown"
  counterparty_type: "customer" | "vendor" | "other" | "unknown"
  counterparty_name: string | null
  counterparty_email: string | null
  lines: Array<{
    description: string
    quantity: number
    unit_price: number | null
    amount: number | null
    sku: string | null
    account_code: string | null
  }>
  meta: {
    source_system: InvoiceProvider
    source_system_hint: "stripe" | "qbo" | "other" | null
    provider_invoice_id: string | null
    provider_data: Record<string, unknown>
    gmail_message_id: string | null
    gmail_thread_id: string | null
    gmail_subject: string | null
    gmail_body_excerpt: string | null
    stripe_invoice_id: string | null
    stripe_customer_id: string | null
    qbo_invoice_id: string | null
    xero_invoice_id: string | null
    raw_payload: Record<string, unknown>
  }
}

export type InvoiceDocumentRow = {
  id: string
  user_id: string
  provider: InvoiceProvider
  provider_invoice_id: string
  ap_ar_id: string | null
  normalized: NormalizedInvoiceJSON
  raw: unknown
  created_at: string
  updated_at: string
}

export async function insertInvoiceDocument(
  doc: NormalizedInvoiceJSON,
  provider: InvoiceProvider,
  providerInvoiceId: string,
  apArId: string | null,
  raw: unknown
): Promise<void> {
  await ensureInvoiceDocumentsSchema()
  try {
    await query(
      `INSERT INTO invoice_documents (user_id, provider, provider_invoice_id, ap_ar_id, normalized, raw)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (user_id, provider, provider_invoice_id) DO UPDATE SET
         ap_ar_id = EXCLUDED.ap_ar_id,
         normalized = EXCLUDED.normalized,
         raw = EXCLUDED.raw,
         updated_at = NOW()`,
      [doc.user_id, provider, providerInvoiceId, apArId, JSON.stringify(doc), JSON.stringify(raw ?? {})]
    )
  } catch (err) {
    log(
      "invoice_documents.insert.failed",
      { userId: doc.user_id, provider, providerInvoiceId, error: err instanceof Error ? err.message : String(err) },
      "db"
    )
    throw err
  }
}

