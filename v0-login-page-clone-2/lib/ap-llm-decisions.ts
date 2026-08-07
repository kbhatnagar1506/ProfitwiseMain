/**
 * AP decision support: suggest safe delays, prepayment opportunities, prioritization.
 * LLM recommends actions. No write — user decides.
 */

import type { APObligation, APState } from "./state/ar-ap"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

export type DecisionSuggestion = {
  action: "delay" | "prepay" | "prioritize" | "other"
  entity: string
  parameter_days?: number
  reasoning: string
}

export type DecisionSupportInput = {
  apState: APState
  liquidity?: number
  cashForecast?: { min_cash_30d?: number; prob_below_zero_30d?: number }
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

function parseSuggestions(content: string | null): DecisionSuggestion[] {
  if (!content) return []
  const suggestions: DecisionSuggestion[] = []
  const lines = content.split("\n").filter((l) => l.trim())
  const actionWords = ["delay", "prepay", "prioritize", "other"]
  for (const line of lines) {
    const lower = line.toLowerCase()
    const action = actionWords.find((a) => lower.startsWith(a) || lower.includes(` ${a}:`)) ?? "other"
    const daysMatch = line.match(/(\d+)\s*days?/i)
    const clean = line.replace(/^[-*]\s*/i, "").trim()
    const entity = clean.split(/[:–-]/)[0]?.replace(/^(delay|prepay|prioritize|other)\s*/i, "").trim() || clean.slice(0, 60)
    suggestions.push({
      action: action as DecisionSuggestion["action"],
      entity: entity.slice(0, 80),
      parameter_days: daysMatch ? parseInt(daysMatch[1], 10) : undefined,
      reasoning: clean,
    })
  }
  return suggestions.slice(0, 5)
}

/**
 * Suggest AP decisions: safe delays, prepayment opportunities, prioritization.
 * E.g. "Vendor B can wait 3 days", "Pay Vendor A first — avoids penalties".
 */
export async function suggestAPDecisions(input: DecisionSupportInput): Promise<DecisionSuggestion[]> {
  if (!process.env.AP_LLM_ENABLED || !API_KEY) return []

  const { apState, liquidity, cashForecast } = input
  const obSummary = apState.obligations
    .slice(0, 12)
    .map((o) => `- ${o.vendor_name}: $${o.amount_due.toFixed(2)} due ${o.due_date ?? "unknown"}, ${o.priority} priority${o.risk_flag ? ` (${o.risk_flag})` : ""}`)
    .join("\n")

  const liquidityNote = liquidity != null
    ? `Current liquidity: $${liquidity.toLocaleString()}`
    : cashForecast?.min_cash_30d != null
      ? `Min cash 30d: $${cashForecast.min_cash_30d.toLocaleString()}`
      : ""

  const systemPrompt = `You are an AP decision advisor. Given AP obligations and liquidity context, suggest actions:
- delay: Vendor X can wait N days (safe to defer)
- prepay: Opportunity to prepay Vendor Y for discount/early payment
- prioritize: Pay Vendor Z first — avoids penalties / critical vendor

Output one line per suggestion:
action: entity - N days: brief reasoning

Max 5 suggestions. Be concise.`

  const userPrompt = `AP total (30d): $${apState.total_expected_30d.toLocaleString()}
${liquidityNote}

Obligations:
${obSummary || "None"}

Suggest actions:`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ])
  return parseSuggestions(content)
}
