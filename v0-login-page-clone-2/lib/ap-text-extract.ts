/**
 * Text-to-structured extraction for AP: parse PDFs/contracts to extract payment terms, due dates.
 * Extends gmail-invoice-extract pattern. Feed into OutstandingBill or APObligation.
 *
 * Extension points:
 * - File upload: accept PDF, extract text (e.g. pdf-parse), call extractFromText
 * - Drive integration: fetch file, extract text, call extractFromText
 */

import type { OutstandingBill } from "./state/types"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

const TEXT_TRUNCATE = 8000

export type ExtractedBillFields = {
  vendor_name: string | null
  amount: number | null
  amount_due: number | null
  due_date: string | null
  payment_terms: string | null
  invoice_number: string | null
}

async function callLLM(messages: { role: string; content: string }[], maxTokens = 500): Promise<string | null> {
  if (!API_KEY) return null
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.1,
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content?.trim() ?? null
  } catch {
    return null
  }
}

/**
 * Extract bill/invoice fields from raw text (e.g. PDF content, contract text).
 * Use with pdf-parse or similar to get text from PDFs before calling.
 */
export async function extractFromText(text: string): Promise<ExtractedBillFields | null> {
  if (!process.env.AP_LLM_ENABLED || !API_KEY) return null
  const truncated = text.slice(0, TEXT_TRUNCATE)

  const systemPrompt = `You extract structured bill/invoice fields from document text. Output JSON only:
{"vendor_name": string|null, "amount": number|null, "amount_due": number|null, "due_date": "YYYY-MM-DD"|null, "payment_terms": string|null, "invoice_number": string|null}
- vendor_name: who is owed / who sent the bill
- amount / amount_due: total or amount due (number)
- due_date: when payment is due (YYYY-MM-DD)
- payment_terms: e.g. "Net 30", "Due on receipt"
- invoice_number: if present
Use null for unknown. Output only valid JSON.`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Extract from:\n\n${truncated}` },
  ])
  if (!content) return null

  try {
    const parsed = JSON.parse(content.replace(/```json?\s*|\s*```/g, "").trim()) as ExtractedBillFields
    return parsed
  } catch {
    return null
  }
}

/**
 * Convert extracted fields to OutstandingBill shape (for feeding into AP state).
 * Uses source "gmail" (OutstandingBill type); PDF/Drive would use same when integrated.
 */
export function toOutstandingBill(extracted: ExtractedBillFields): OutstandingBill | null {
  const amount = extracted.amount_due ?? extracted.amount
  if (amount == null || amount <= 0) return null
  const today = new Date().toISOString().slice(0, 10)
  const dueDate = extracted.due_date ?? null
  let days_until_due: number | null = null
  let days_overdue: number | null = null
  let status: OutstandingBill["status"] = "open"
  if (dueDate) {
    const diff = Math.round((new Date(dueDate).getTime() - new Date(today).getTime()) / 86_400_000)
    if (diff < 0) { days_overdue = Math.abs(diff); status = "overdue" }
    else days_until_due = diff
  }
  return {
    bill_id: `extract_${extracted.invoice_number ?? Date.now()}`,
    source: "gmail",
    vendor_name: extracted.vendor_name ?? "Unknown",
    vendor_source_id: null,
    entity_id: null,
    amount: extracted.amount ?? amount,
    amount_due: amount,
    due_date: dueDate,
    days_until_due: days_until_due,
    days_overdue: days_overdue,
    status,
  }
}
