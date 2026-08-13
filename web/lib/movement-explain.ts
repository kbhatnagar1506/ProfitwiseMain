import type { MovementDetailResponse } from "@/lib/movement-detail-types"
import { searchEntityContextFromSupermemory } from "@/lib/supermemory"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

function supermemoryOnEveryLlmEnabled(): boolean {
  return process.env.SUPERMEMORY_ON_EVERY_LLM !== "false"
}

async function supermemoryContextForExplain(userId: string, detail: MovementDetailResponse): Promise<string> {
  if (!supermemoryOnEveryLlmEnabled()) return ""
  const query = [
    detail.headline.raw_counterparty ?? "",
    detail.normalized_bank_info.normalized_display_name ?? "",
    detail.normalized_bank_info.scrubbed_bank_text ?? "",
    detail.economic_semantics.movement_type ?? "",
  ]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 500)
  if (!query) return ""
  try {
    return await searchEntityContextFromSupermemory(userId, query)
  } catch {
    return ""
  }
}

async function callLlm(messages: Array<{ role: "system" | "user"; content: string }>): Promise<string | null> {
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
        max_tokens: 500,
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

export function fallbackMovementExplanation(detail: MovementDetailResponse): string {
  return [
    `Movement ${detail.headline.movement_id} is mapped as ${detail.economic_semantics.movement_type}.`,
    `Status is ${detail.headline.status_badge}, class confidence ${Math.round(detail.confidence_engine.overall.classification_score * 100)}%, evidence ${Math.round(detail.confidence_engine.overall.evidence_strength * 100)}%.`,
    `Entity path: ${detail.normalized_bank_info.resolution_path.classification_precedence ?? "none"}; alias signature ${detail.normalized_bank_info.resolution_path.alias_signature ?? "none"}.`,
  ].join(" ")
}

export async function generateMovementExplanation(userId: string, detail: MovementDetailResponse): Promise<string> {
  const sm = await supermemoryContextForExplain(userId, detail)
  const systemPrompt = `You are a senior financial data auditor. Explain movement mapping decisions clearly for founders.
Write concise but concrete output with:
1) Why this was mapped to this class/entity
2) Which source records support it
3) Weaknesses or uncertainty
4) What user action is best if wrong
Keep under 180 words.${sm ? `\n\nSupermemory context (use as grounding hints, do not invent facts):\n${sm}` : ""}`

  const userPrompt = JSON.stringify(detail)
  const explanation = await callLlm([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ])
  return explanation ?? fallbackMovementExplanation(detail)
}
