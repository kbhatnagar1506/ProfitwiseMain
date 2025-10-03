/**
 * AR (invoice) to Payment matching via LLM.
 * When deterministic confidence < threshold, LLM suggests invoice matches.
 * Mirrors ap-llm-match pattern.
 */

import type { OutstandingInvoice } from "./state/types"
import type { InflowPayment } from "./ar-payment-match"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

export type ARMatchSuggestion = {
  invoice_id: string
  customer_name: string
  amount_due: number
  confidence: "high" | "medium" | "low"
  reasoning: string
}

async function callLLM(messages: { role: string; content: string }[], maxTokens = 600): Promise<string | null> {
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

function parseLLMMatches(content: string | null, invoices: OutstandingInvoice[]): ARMatchSuggestion[] {
  if (!content) return []
  const suggestions: ARMatchSuggestion[] = []
  const invById = new Map(invoices.map((i) => [i.invoice_id, i]))
  const lines = content.split("\n").filter((l) => l.trim())
  for (const line of lines) {
    const m = line.match(/^[-*]?\s*(?:invoice_id[:\s]+)?([a-zA-Z0-9_-]+)[:\s,]+(?:confidence[:\s]+)?(high|medium|low)[:\s]*(.*)$/i)
    if (m) {
      const [, id, conf, reason] = m
      const inv = invById.get(id?.trim() ?? "")
      if (inv) {
        suggestions.push({
          invoice_id: inv.invoice_id,
          customer_name: inv.customer_name,
          amount_due: inv.amount_due,
          confidence: conf?.toLowerCase() as "high" | "medium" | "low",
          reasoning: (reason ?? "").trim() || "LLM suggested match",
        })
      }
    }
  }
  return suggestions.slice(0, 5)
}

/**
 * Suggest AR (invoice) matches for an inflow payment via LLM.
 * Call when deterministic match confidence < threshold.
 */
export async function suggestARMatchesLLM(
  payment: InflowPayment,
  invoices: OutstandingInvoice[],
): Promise<ARMatchSuggestion[]> {
  if (!process.env.AR_LLM_ENABLED || !API_KEY || invoices.length === 0) return []

  const invSummary = invoices.slice(0, 15).map((i) =>
    `- ${i.invoice_id}: ${i.customer_name}, $${i.amount_due.toFixed(2)} due ${i.due_date ?? "unknown"}`
  ).join("\n")

  const systemPrompt = `You are an AR matching assistant. Given an unmatched inflow payment and a list of outstanding invoices, suggest the most likely match(es). Output one line per suggestion:
invoice_id: confidence (high|medium|low): brief reasoning

Only suggest invoices that could reasonably match the payment (same customer, amount within ~5%, date within ~14 days). Order by likelihood. Max 5 suggestions.`

  const userPrompt = `Payment: $${payment.amount.toFixed(2)} on ${payment.date}
Description: ${payment.raw_description ?? "—"}
Counterparty: ${payment.counterparty_name ?? "—"}

Outstanding invoices:
${invSummary}

Suggest matches (one per line):`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ])
  return parseLLMMatches(content, invoices)
}
