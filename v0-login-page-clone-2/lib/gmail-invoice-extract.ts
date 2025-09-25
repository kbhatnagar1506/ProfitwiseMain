/**
 * Gmail invoice/bill extraction via LLM. Produces NormalizedInvoiceJSON from email content.
 */

import type { NormalizedInvoiceJSON, InvoiceProvider } from "./invoice-documents"
import { log } from "./logger"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"
const BODY_TRUNCATE = 6000

export type GmailMessageRow = {
  message_id: string
  thread_id: string | null
  from_email: string | null
  to_emails: string | null
  subject: string | null
  body_plain: string | null
}

const SYSTEM_PROMPT = `You are a financial document parser. Your job is to read raw email text (invoices, bills, payments, and payment requests) and output a single JSON object.

Rules:
- If the email is NOT an invoice, bill, payment, or payment request, set "is_invoice_or_bill": false and output minimal other fields.
- Otherwise set "is_invoice_or_bill": true and fill ALL fields you can.
- VERY IMPORTANT: Do NOT assume everything is an "invoice". Many documents are BILLS (company owes vendor) or PAYMENTS (payment made/received).
- "kind":
  - Use "invoice" when the sender is charging the recipient as a customer (AR document sent to be paid by someone else).
  - Use "bill" when the sender is a vendor/supplier charging the recipient (AP document that the recipient must pay).
  - Use "payment" when the email is a payment confirmation, receipt for payment made, or evidence that a payment was applied (e.g. "we received your payment", "payment of $X applied", "your payment has been received").
  - Use "other" for statements, generic receipts, quotes, or things that are not clearly an invoice, bill, or payment.
- "side":
  - AP = the company (email account owner) must pay someone else (bills, vendor invoices).
  - AR = someone else must pay the company (invoices to customers, payment requests from the company).
  - For "payment" kind: use AP if the company made the payment (reducing what we owe); use AR if the company received the payment (reducing what's owed to us).
- If unsure but clearly a vendor charging the company, prefer side="AP" and kind="bill".
- If unsure but clearly the company charging a customer, prefer side="AR" and kind="invoice".
- Extract amounts as numbers (e.g. 78.0 not "$78"). Use YYYY-MM-DD for dates. For payments, "total" is the payment amount.
- For source_system_hint: use "stripe" if Stripe, "qbo" if QuickBooks/Intuit, else "other" or null.
- Output ONLY valid JSON, no markdown, no explanations.`

const OUTPUT_SCHEMA = `{
  "is_invoice_or_bill": boolean,
  "side": "AP" | "AR" | "unknown",
  "kind": "invoice" | "bill" | "payment" | "other",
  "invoice_number": string | null,
  "issue_date": string | null,
  "due_date": string | null,
  "currency": string | null,
  "total": number | null,
  "amount_outstanding": number | null,
  "status": "open" | "paid" | "partially_paid" | "void" | "cancelled" | "draft" | "unknown",
  "counterparty_type": "customer" | "vendor" | "other" | "unknown",
  "counterparty_name": string | null,
  "counterparty_email": string | null,
  "lines": [{"description": string, "quantity": number, "unit_price": number | null, "amount": number | null, "sku": string | null, "account_code": string | null}],
  "source_system_hint": "stripe" | "qbo" | "other" | null
}`

function buildUserPrompt(msg: GmailMessageRow, invoiceSenderHints: string[]): string {
  const body = (msg.body_plain ?? "").slice(0, BODY_TRUNCATE)
  const hints =
    invoiceSenderHints.length > 0
      ? `Known invoice/bill senders for this company (email addresses or domains):\n${invoiceSenderHints
          .map((e) => `- ${e}`)
          .join("\n")}\n\n`
      : ""
  return `Email:
From: ${msg.from_email ?? ""}
To: ${msg.to_emails ?? ""}
Subject: ${msg.subject ?? ""}

Body:
${body}

${hints}Use the known senders above as a strong signal: if the FROM address matches one of them (by exact email or domain), it is very likely a vendor or billing system sending a bill to the company (AP, kind="bill").

Output JSON with this schema (only the JSON, nothing else):
${OUTPUT_SCHEMA}`
}

function isFromKnownInvoiceSender(fromEmail: string | null, invoiceSenderHints: string[]): boolean {
  const from = fromEmail?.toLowerCase().trim()
  if (!from) return false
  return invoiceSenderHints.some((hint) => {
    const v = hint.toLowerCase().trim()
    if (!v) return false
    // If hint looks like a domain (starts with @ or has no @), treat as domain match
    if (!v.includes("@") || v.startsWith("@")) {
      const domain = v.startsWith("@") ? v.slice(1) : v
      return from.endsWith(`@${domain}`)
    }
    // Full email match
    return from === v
  })
}

function parseJsonOutput(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  let start = trimmed.indexOf("{")
  let end = trimmed.lastIndexOf("}")
  if (start === -1 || end === -1 || start >= end) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

function candidateKeywords(subject: string | null, body: string | null): boolean {
  const s = (subject ?? "").toLowerCase()
  const b = (body ?? "").toLowerCase()
  const combined = s + " " + b
  const words = ["invoice", "bill", "payment request", "amount due", "balance due", "statement", "receipt"]
  return words.some((w) => combined.includes(w))
}

export async function extractInvoiceFromGmail(
  msg: GmailMessageRow,
  userId: string,
  invoiceSenderHints: string[] = []
): Promise<NormalizedInvoiceJSON | null> {
  if (!candidateKeywords(msg.subject, msg.body_plain)) {
    log("gmail.invoice_extract.skipped_no_keywords", { messageId: msg.message_id, subject: msg.subject?.slice(0, 80), bodyLen: (msg.body_plain ?? "").length }, "gmail")
    return null
  }

  const bodyPreview = (msg.body_plain ?? "").slice(0, 400)
  log("gmail.invoice_extract.attempting", { messageId: msg.message_id, subject: msg.subject, bodyLen: (msg.body_plain ?? "").length, bodyPreview }, "gmail")

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    log("gmail.invoice_extract.no_openai_key", {}, "gmail")
    return null
  }

  const userContent = buildUserPrompt(msg, invoiceSenderHints)
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      max_tokens: 2048,
      temperature: 0.1,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    log("gmail.invoice_extract.openai_error", { status: res.status, error: err }, "gmail")
    return null
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content
  if (!content) return null

  const parsed = parseJsonOutput(content)
  if (!parsed) {
    log("gmail.invoice_extract.parse_failed", { messageId: msg.message_id, contentPreview: content.slice(0, 300) }, "gmail")
    return null
  }
  if (parsed.is_invoice_or_bill !== true) {
    log("gmail.invoice_extract.not_invoice", { messageId: msg.message_id, isInvoice: parsed.is_invoice_or_bill }, "gmail")
    return null
  }
  log("gmail.invoice_extract.llm_response", {
    messageId: msg.message_id,
    total: parsed.total,
    counterparty_name: parsed.counterparty_name,
    invoice_number: parsed.invoice_number,
    status: parsed.status,
    side: parsed.side,
  }, "gmail")

  const totalVal = typeof parsed.total === "number" ? parsed.total : null
  const statusVal = typeof parsed.status === "string" ? parsed.status : "unknown"
  if ((totalVal === null || totalVal === 0) && (statusVal === "unknown" || !statusVal)) {
    log("gmail.invoice_extract.low_confidence_skip", {
      messageId: msg.message_id,
      total: totalVal,
      status: statusVal,
      invoice_number: parsed.invoice_number,
    }, "gmail")
    return null
  }

  const side = (parsed.side === "AP" || parsed.side === "AR" ? parsed.side : "unknown") as "AP" | "AR" | "unknown"
  const kind = (["invoice", "bill", "payment", "other"].includes(parsed.kind as string) ? parsed.kind : "other") as "invoice" | "bill" | "payment" | "other"
  const status = (["open", "paid", "partially_paid", "void", "cancelled", "draft", "unknown"].includes(parsed.status as string)
    ? parsed.status
    : "unknown") as NormalizedInvoiceJSON["status"]
  const counterpartyType = (["customer", "vendor", "other", "unknown"].includes(parsed.counterparty_type as string)
    ? parsed.counterparty_type
    : "unknown") as NormalizedInvoiceJSON["counterparty_type"]
  const hint = (["stripe", "qbo", "other"].includes(parsed.source_system_hint as string) ? parsed.source_system_hint : null) as "stripe" | "qbo" | "other" | null

  const lines = Array.isArray(parsed.lines)
    ? (parsed.lines as Array<Record<string, unknown>>).map((l) => ({
        description: String(l.description ?? ""),
        quantity: typeof l.quantity === "number" ? l.quantity : 1,
        unit_price: typeof l.unit_price === "number" ? l.unit_price : null,
        amount: typeof l.amount === "number" ? l.amount : null,
        sku: (l.sku as string) ?? null,
        account_code: (l.account_code as string) ?? null,
      }))
    : []

  if (lines.length === 0 && typeof parsed.total === "number") {
    lines.push({
      description: msg.subject ?? "Invoice from email",
      quantity: 1,
      unit_price: parsed.total,
      amount: parsed.total,
      sku: null,
      account_code: null,
    })
  }

  const total = typeof parsed.total === "number" ? parsed.total : null
  const amountOutstanding = typeof parsed.amount_outstanding === "number" ? parsed.amount_outstanding : total

  const fromKnownSender = isFromKnownInvoiceSender(msg.from_email, invoiceSenderHints)

  const inferredKind: "invoice" | "bill" | "payment" | "other" =
    kind === "payment" ? "payment" : kind === "other" && fromKnownSender ? "bill" : kind

  const inferredSide: "AP" | "AR" | "unknown" =
    side === "AP" || side === "AR"
      ? side
      : fromKnownSender
        ? "AP"
        : inferredKind === "bill"
          ? "AP"
          : inferredKind === "invoice"
            ? "AR"
            : "unknown"

  const normalized: NormalizedInvoiceJSON = {
    version: 1,
    user_id: userId,
    side: inferredSide,
    kind: inferredKind,
    invoice_number: typeof parsed.invoice_number === "string" ? parsed.invoice_number : null,
    issue_date: typeof parsed.issue_date === "string" ? parsed.issue_date : null,
    due_date: typeof parsed.due_date === "string" ? parsed.due_date : null,
    currency: typeof parsed.currency === "string" ? parsed.currency : null,
    total: total ?? 0,
    amount_outstanding: amountOutstanding ?? total ?? 0,
    status,
    counterparty_type: counterpartyType,
    counterparty_name: typeof parsed.counterparty_name === "string" ? parsed.counterparty_name : null,
    counterparty_email: typeof parsed.counterparty_email === "string" ? parsed.counterparty_email : null,
    lines,
    meta: {
      source_system: "gmail" as InvoiceProvider,
      source_system_hint: hint,
      provider_invoice_id: msg.message_id,
      provider_data: {},
      gmail_message_id: msg.message_id,
      gmail_thread_id: msg.thread_id,
      gmail_subject: msg.subject,
      gmail_body_excerpt: (msg.body_plain ?? "").slice(0, 500),
      stripe_invoice_id: null,
      stripe_customer_id: null,
      qbo_invoice_id: null,
      xero_invoice_id: null,
      raw_payload: {},
    },
  }
  return normalized
}
