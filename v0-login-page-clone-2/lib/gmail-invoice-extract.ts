/**
 * Gmail invoice/bill extraction via LLM. Produces a standalone extracted-invoice JSON object from email content.
 */

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

export type ExtractedInvoice = {
  is_invoice_or_bill: boolean
  side: "AP" | "AR" | "unknown"
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
  lines: {
    description: string
    quantity: number
    unit_price: number | null
    amount: number | null
    sku: string | null
    account_code: string | null
  }[]
  source_system_hint: "stripe" | "qbo" | "other" | null
}

const SYSTEM_PROMPT = `You are a financial document classifier. You read one email and output exactly one JSON object. No markdown, no code fences, no explanation — only the JSON.

## In scope vs out of scope
- Set "is_invoice_or_bill": true only when the email is clearly one of: a request for payment (invoice or bill), a payment confirmation, or a receipt that shows a payment was made/received. If it's marketing, shipping only, newsletter, or has no amount/due/payment context, set "is_invoice_or_bill": false and output minimal other fields.
- When "is_invoice_or_bill": true, fill every field you can infer; use null for unknown. Never omit required keys.

## Document type ("kind") — pick one
- "invoice" — The email is asking the recipient to pay the sender (e.g. "Please pay us", "Amount due", "Your invoice is attached"). The email account owner is the one who will receive the money → receivables.
- "bill" — The email is asking the recipient (the company) to pay the sender (vendor/supplier). The email account owner owes money → payables.
- "payment" — The email confirms that a payment happened: "We received your payment", "Payment of $X has been applied", "Your payment was successful", "Receipt for your payment". Use this for payment confirmations and payment receipts, not for new requests to pay.
- "other" — Statements (balance summary with no single due amount), quotes, estimates, or unclear. Not a clear invoice, bill, or payment.

## Side (AP vs AR) — from the email account owner's perspective
- "AR" — Money is (or will be) owed TO the company. Invoices the company sent, or payment confirmations that the company received payment.
- "AP" — Money is (or was) owed BY the company. Bills from vendors, or payment confirmations that the company made a payment.
- For "payment" kind: company made the payment → side "AP"; company received the payment → side "AR".
- If you truly cannot tell, use "unknown".

## Amounts and dates
- "total": The single main amount in the document. For invoices/bills use the total due or amount due. For payments use the payment amount. Number only (e.g. 78.5), not a string.
- "amount_outstanding": For unpaid or partially paid items, the remaining amount due; otherwise null or same as total. For payments, usually null or 0.
- Dates: YYYY-MM-DD only. "issue_date" = document/issue date; "due_date" = when payment is due (null if not stated or for payment confirmations).

## Other
- "status": "paid" for payment confirmations or when the document says paid; "open" when amount is still due; "partially_paid" when partial payment mentioned; otherwise "unknown".
- "source_system_hint": "stripe" only if the email clearly comes from Stripe; "qbo" only if QuickBooks/Intuit; otherwise "other" or null.
- "counterparty_name" / "counterparty_email": The other party (vendor for bills, customer for invoices, payer/payee for payments).
- "lines": Array of line items if the document has them; use one summary line or empty array for simple payments.
- Output ONLY valid JSON.`

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
      ? `Known vendor/billing senders for this company (if FROM matches one of these, treat as bill to the company → side="AP", kind="bill" unless the body clearly says it's a payment confirmation):\n${invoiceSenderHints
          .map((e) => `- ${e}`)
          .join("\n")}\n\n`
      : ""
  return `Email:
From: ${msg.from_email ?? ""}
To: ${msg.to_emails ?? ""}
Subject: ${msg.subject ?? ""}

Body:
${body}

${hints}Classify this email and output one JSON object with the exact schema below. No other text.
Schema:
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
  const words = ["invoice", "bill", "payment", "payment received", "payment request", "amount due", "balance due", "statement", "receipt", "paid", "we received your payment"]
  return words.some((w) => combined.includes(w))
}

export async function extractInvoiceFromGmail(
  msg: GmailMessageRow,
  _userId: string,
  invoiceSenderHints: string[] = []
): Promise<ExtractedInvoice | null> {
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

  const side = (parsed.side === "AP" || parsed.side === "AR" ? parsed.side : "unknown") as ExtractedInvoice["side"]
  const kind = (["invoice", "bill", "payment", "other"].includes(parsed.kind as string) ? parsed.kind : "other") as ExtractedInvoice["kind"]
  const status = (["open", "paid", "partially_paid", "void", "cancelled", "draft", "unknown"].includes(parsed.status as string)
    ? parsed.status
    : "unknown") as ExtractedInvoice["status"]
  const counterpartyType = (["customer", "vendor", "other", "unknown"].includes(parsed.counterparty_type as string)
    ? parsed.counterparty_type
    : "unknown") as ExtractedInvoice["counterparty_type"]
  const hint = (["stripe", "qbo", "other"].includes(parsed.source_system_hint as string) ? parsed.source_system_hint : null) as ExtractedInvoice["source_system_hint"]

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

  const normalized: ExtractedInvoice = {
    is_invoice_or_bill: true,
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
    source_system_hint: hint,
  }
  return normalized
}
