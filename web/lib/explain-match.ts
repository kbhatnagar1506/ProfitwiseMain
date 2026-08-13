/**
 * "Explain This" — LLM explains why a payment matches an invoice/obligation.
 * Amount similarity, timing, historical pattern.
 */

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

export type MatchContext = {
  movement_id: string
  amount: number
  date: string
  raw_description: string | null
  counterparty: string | null
  direction: "inflow" | "outflow"
  entity_type: "ar" | "ap"
  entity_id: string
  entity_name: string
  gross_applied: number
  fee_amount: number
  net_applied: number
  confidence?: number
  fee_anomaly?: boolean
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
 * LLM explains why this payment matches the given invoice/obligation.
 */
export async function explainMatch(ctx: MatchContext): Promise<string> {
  if (!process.env.AR_LLM_ENABLED && !process.env.AP_LLM_ENABLED) {
    return `Match: ${ctx.entity_type.toUpperCase()} ${ctx.entity_name} — amount within tolerance, date aligned.`
  }
  if (!API_KEY) return "Match explanation unavailable."

  const systemPrompt = `You are a reconciliation analyst. Explain in 2–3 sentences why this payment likely matches the linked ${ctx.entity_type === "ar" ? "invoice" : "obligation"}. Consider: amount similarity (gross vs net, fee), timing (payment date vs due date), counterparty alignment. Be concise.`

  const feeRate = ctx.gross_applied > 0 ? (ctx.fee_amount / ctx.gross_applied * 100).toFixed(1) : "0"
  const feeNote = ctx.fee_anomaly ? " [Note: Fee exceeds typical 3% — consider mentioning why.]" : ""
  const userPrompt = `Payment: $${ctx.amount.toFixed(2)} on ${ctx.date}
Description: ${ctx.raw_description ?? "—"}
Counterparty: ${ctx.counterparty ?? "—"}
Direction: ${ctx.direction}

Linked ${ctx.entity_type.toUpperCase()}: ${ctx.entity_name} (${ctx.entity_id})
Gross: $${ctx.gross_applied.toFixed(2)}, Fee: $${ctx.fee_amount.toFixed(2)} (${feeRate}%), Net: $${ctx.net_applied.toFixed(2)}
Confidence: ${(ctx.confidence ?? 0) * 100}%${feeNote}

Explain why this match makes sense:`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ])
  return content ?? `Match: amount within tolerance, date aligned.`
}
