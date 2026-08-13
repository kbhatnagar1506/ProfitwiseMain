/**
 * AP anomaly detection: flag unusual payment amounts, early/late patterns.
 * LLM explains anomalies. No write — informational only.
 */

import type { APObligation } from "./state/ar-ap"
import type { VendorModel } from "./state/types"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

export type PaymentContext = {
  amount: number
  date: string
  raw_description: string | null
  counterparty_name?: string | null
  entity_id?: string | null
}

export type AnomalyResult = {
  anomaly: boolean
  reasoning: string
  suggested_causes?: string[]
}

async function callLLM(messages: { role: string; content: string }[], maxTokens = 400): Promise<string | null> {
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
        temperature: 0.2,
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
 * Detect anomalies in a payment: unusual amount (e.g. 2x average), early/late patterns.
 * Returns anomaly flag, reasoning, and optional suggested causes.
 */
export async function detectPaymentAnomaly(
  payment: PaymentContext,
  vendorModel: VendorModel | null,
  obligations: APObligation[],
): Promise<AnomalyResult> {
  if (!process.env.AP_LLM_ENABLED || !API_KEY) {
    return { anomaly: false, reasoning: "LLM anomaly detection disabled" }
  }

  const vendorSummary = vendorModel
    ? `Vendor: ${vendorModel.name}, avg payment $${vendorModel.avg_amount.toFixed(2)}, cadence ${vendorModel.cadence}, ${vendorModel.payment_count} payments`
    : "No vendor history"

  const obSummary = obligations
    .slice(0, 5)
    .map((o) => `- ${o.vendor_name}: $${o.amount_due.toFixed(2)} due ${o.due_date ?? "unknown"}`)
    .join("\n")

  const systemPrompt = `You are an AP anomaly analyst. Given a payment and vendor/obligation context, determine if the payment is anomalous (unusual amount, early/late vs expected, etc.). Output JSON only:
{"anomaly": boolean, "reasoning": "brief explanation", "suggested_causes": ["cause1", "cause2"]}
- anomaly: true if amount is 2x+ average, or payment is unusually early/late vs due date, or other red flags
- suggested_causes: optional list of possible explanations (e.g. "partial payment", "early payment discount", "duplicate")`

  const userPrompt = `Payment: $${payment.amount.toFixed(2)} on ${payment.date}
Description: ${payment.raw_description ?? "—"}
Counterparty: ${payment.counterparty_name ?? "—"}

${vendorSummary}

Relevant obligations:
${obSummary || "None"}

Is this payment anomalous? JSON:`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ])

  if (!content) return { anomaly: false, reasoning: "LLM unavailable" }

  try {
    const parsed = JSON.parse(content.replace(/```json?\s*|\s*```/g, "").trim()) as AnomalyResult
    return {
      anomaly: !!parsed.anomaly,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "Unknown",
      suggested_causes: Array.isArray(parsed.suggested_causes) ? parsed.suggested_causes : undefined,
    }
  } catch {
    return { anomaly: false, reasoning: content.slice(0, 200) }
  }
}
