/**
 * Document layer: bills, invoices, and payments (source documents).
 * These are NOT the accounting ledger. Each document is a normalized view of a source
 * (Stripe, QBO, Xero, Gmail, etc.) and may later be linked to the AP/AR ledger (ap_ar)
 * by the resolver. Documents → candidates → resolver → AP/AR ledger.
 */

import crypto from "crypto"
import { ensureInvoiceDocumentsSchema, query } from "./db"
import { log } from "./logger"

export type InvoiceProvider = "stripe" | "qbo" | "xero" | "gmail" | "manual" | "other"

export type NormalizedInvoiceJSON = {
  version: 1
  user_id: string
  side: "AP" | "AR" | "unknown"
  /** invoice = AR doc (we sent); bill = AP doc (we receive); payment = payment applied; other = statement, receipt, etc. */
  kind: "invoice" | "bill" | "payment" | "other"
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

function getSourceAuthority(provider: InvoiceProvider): number {
  switch (provider) {
    case "qbo":
    case "xero":
      return 0.99
    case "stripe":
      return 0.97
    case "manual":
      return 0.9
    case "gmail":
      return 0.6
    default:
      return 0.5
  }
}

function computeInvoiceFingerprint(doc: NormalizedInvoiceJSON): string | null {
  const parts = [
    doc.invoice_number ?? "",
    (doc.counterparty_name ?? "").toLowerCase(),
    doc.total != null ? String(doc.total) : "",
    (doc.currency ?? "").toUpperCase(),
    doc.issue_date ?? "",
  ]
  const key = parts.join("|")
  if (!key.replace(/\|/g, "")) return null
  return crypto.createHash("sha256").update(key).digest("hex")
}

export async function insertInvoiceDocument(
  doc: NormalizedInvoiceJSON,
  provider: InvoiceProvider,
  providerInvoiceId: string,
  apArId: string | null,
  raw: unknown
): Promise<string | null> {
  await ensureInvoiceDocumentsSchema()
  try {
    const normalizedJson = JSON.stringify(doc)
    const rawJson = JSON.stringify(raw ?? {})

    const { rows } = await query<{ id: string }>(
      `INSERT INTO invoice_documents (user_id, provider, provider_invoice_id, ap_ar_id, normalized, raw)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (user_id, provider, provider_invoice_id) DO UPDATE SET
         ap_ar_id = EXCLUDED.ap_ar_id,
         normalized = EXCLUDED.normalized,
         raw = EXCLUDED.raw,
         updated_at = NOW()
       RETURNING id`,
      [doc.user_id, provider, providerInvoiceId, apArId, normalizedJson, rawJson]
    )

    const invoiceDocumentId = rows[0]?.id

    if (invoiceDocumentId) {
      const documentType = doc.kind
      const candidateSide = doc.side
      const sourceAuthority = getSourceAuthority(provider)
      const classificationConfidence =
        candidateSide === "unknown" ? 0.4 : sourceAuthority
      const extractionConfidence = sourceAuthority
      const fingerprintInvoice = computeInvoiceFingerprint(doc)

      const versionRes = await query<{ id: string }>(
        `INSERT INTO invoice_document_versions (
           invoice_document_id,
           normalized,
           raw,
           extractor_version,
           model_version,
           document_type,
           candidate_side,
           classification_confidence,
           extraction_confidence,
           source_authority,
           fingerprint_invoice
         )
         VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          invoiceDocumentId,
          normalizedJson,
          rawJson,
          null,
          null,
          documentType,
          candidateSide,
          classificationConfidence,
          extractionConfidence,
          sourceAuthority,
          fingerprintInvoice,
        ]
      )

      const latestVersionId = versionRes.rows[0]?.id
      if (latestVersionId) {
        await query(
          `UPDATE invoice_documents
           SET latest_version_id = $1, updated_at = NOW()
           WHERE id = $2`,
          [latestVersionId, invoiceDocumentId]
        )
        return latestVersionId
      }
    }
    return null
  } catch (err) {
    log(
      "invoice_documents.insert.failed",
      { userId: doc.user_id, provider, providerInvoiceId, error: err instanceof Error ? err.message : String(err) },
      "db"
    )
    throw err
  }
}

