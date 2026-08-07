/**
 * Fee anomaly detection: flag allocations where fee/gross > threshold (e.g. 7% vs typical 3%).
 * LLM can summarize: "This transaction has 7.2% effective fee, higher than typical 3%."
 */

const FEE_ANOMALY_THRESHOLD = 0.07
const TYPICAL_FEE_RATE = 0.03

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

export type FeeAllocation = {
  gross_applied: number
  fee_amount: number
  net_applied: number
  entity_type: string
  entity_id: string
}

export function isFeeAnomaly(gross: number, fee: number): boolean {
  if (gross <= 0) return false
  const rate = fee / gross
  return rate > FEE_ANOMALY_THRESHOLD
}

export function getFeeRate(gross: number, fee: number): number {
  if (gross <= 0) return 0
  return fee / gross
}

async function callLLM(messages: { role: string; content: string }[], maxTokens = 300): Promise<string | null> {
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
 * LLM summary for fee anomaly: "This transaction has 7.2% effective fee, higher than typical 3%."
 */
export async function explainFeeAnomaly(allocation: FeeAllocation): Promise<string> {
  if (!process.env.AR_LLM_ENABLED && !process.env.AP_LLM_ENABLED) {
    const rate = getFeeRate(allocation.gross_applied, allocation.fee_amount)
    return `Effective fee ${(rate * 100).toFixed(1)}% exceeds typical ${(TYPICAL_FEE_RATE * 100)}%. Review recommended.`
  }
  if (!API_KEY) return "High fee detected — LLM unavailable."

  const rate = getFeeRate(allocation.gross_applied, allocation.fee_amount)
  const systemPrompt = `You are a payment analyst. Given an allocation with unusually high fees, provide a brief 1–2 sentence explanation. Compare to typical 3% processor fees.`

  const userPrompt = `${allocation.entity_type.toUpperCase()} allocation: Gross $${allocation.gross_applied.toFixed(2)}, Fee $${allocation.fee_amount.toFixed(2)} (${(rate * 100).toFixed(1)}%), Net $${allocation.net_applied.toFixed(2)}. Entity: ${allocation.entity_id}. Explain why this fee may be high.`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ])
  return content ?? `Effective fee ${(rate * 100).toFixed(1)}% exceeds typical ${(TYPICAL_FEE_RATE * 100)}%.`
}
