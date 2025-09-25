/**
 * Pipeline: process gmail_synced_messages through LLM extraction and upsert into AP/AR.
 */

import { ensureGmailSchema, query } from "./db"
import { extractInvoiceFromGmail, type GmailMessageRow } from "./gmail-invoice-extract"
import { log } from "./logger"
import { gcpReadGmailInvoiceSenders } from "./entity-store-gcp"
import { insertInvoiceDocument } from "./invoice-documents"
import { resolveInvoiceCandidate } from "./ap-ar-resolver"

async function getInboxUserId(): Promise<string | null> {
  const envUserId = process.env.GMAIL_INBOX_USER_ID
  if (envUserId) return envUserId
  const adminEmail = process.env.GMAIL_ADMIN_EMAIL?.toLowerCase().trim()
  if (adminEmail) {
    const { rows } = await query<{ id: string }>("SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1", [
      adminEmail,
    ])
    if (rows.length > 0) return rows[0].id
  }
  const { rows } = await query<{ id: string }>("SELECT id FROM users ORDER BY created_at ASC LIMIT 1", [])
  return rows.length > 0 ? rows[0].id : null
}

export async function runGmailInvoicePipeline(options: { limit?: number } = {}): Promise<{
  processed: number
  extracted: number
  errors: number
}> {
  const limit = options.limit ?? 20
  let processed = 0
  let extracted = 0
  let errors = 0

  await ensureGmailSchema()
  const userId = await getInboxUserId()
  if (!userId) {
    log("gmail.invoice_pipeline.no_user", {}, "gmail")
    return { processed: 0, extracted: 0, errors: 0 }
  }

  const invoiceSenderHints = await gcpReadGmailInvoiceSenders(userId).catch(() => [] as string[])

  const { rows } = await query<{
    message_id: string
    thread_id: string | null
    from_email: string | null
    to_emails: string | null
    subject: string | null
    body_plain: string | null
  }>(
    `SELECT message_id, thread_id, from_email, to_emails, subject, body_plain
     FROM gmail_synced_messages
     WHERE processed_for_ap_ar = FALSE AND body_plain IS NOT NULL
       AND synced_at > NOW() - INTERVAL '7 days'
     ORDER BY synced_at DESC
     LIMIT $1`,
    [limit]
  )

  for (const r of rows) {
    processed++
    const msg: GmailMessageRow = {
      message_id: r.message_id,
      thread_id: r.thread_id,
      from_email: r.from_email,
      to_emails: r.to_emails,
      subject: r.subject,
      body_plain: r.body_plain,
    }
    try {
      const normalized = await extractInvoiceFromGmail(msg, userId, invoiceSenderHints)
      if (normalized) {
        const rawPayload = { subject: r.subject, from: r.from_email, to: r.to_emails }
        const versionId = await insertInvoiceDocument(normalized, "gmail", r.message_id, null, rawPayload)
        if (versionId) {
          const outcome = await resolveInvoiceCandidate(versionId, { shadowMode: false })
          log("gmail.invoice_pipeline.resolver_outcome", { messageId: r.message_id, versionId, outcome }, "gmail")
        }
        extracted++
      }
      await query(
        "UPDATE gmail_synced_messages SET processed_for_ap_ar = TRUE WHERE message_id = $1",
        [r.message_id]
      )
    } catch (e) {
      log("gmail.invoice_pipeline.extract_error", { messageId: r.message_id, error: String(e) }, "gmail")
      errors++
    }
  }

  if (processed > 0) {
    log("gmail.invoice_pipeline.done", { processed, extracted, errors }, "gmail")
  }
  return { processed, extracted, errors }
}
