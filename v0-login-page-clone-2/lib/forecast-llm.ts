/**
 * Forecast LLM integration — finance-grade framing and entity canonicalization.
 * Uses OpenAI API when FORECAST_LLM_ENABLED.
 *
 * Heroku config:
 *   heroku config:set FORECAST_LLM_ENABLED=1 --app profitwise-login-page
 *   heroku config:set OPENAI_API_KEY=sk-... --app profitwise-login-page
 *
 * Optional: point to a proxy (e.g. another Heroku service):
 *   heroku config:set FORECAST_LLM_API_URL=https://your-llm-proxy.herokuapp.com/v1/chat/completions --app profitwise-login-page
 *   heroku config:set FORECAST_LLM_API_KEY=... --app profitwise-login-page
 */

const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"
const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY

async function callLLM(messages: { role: string; content: string }[], maxTokens = 800): Promise<string | null> {
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
        temperature: 0.3,
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content?.trim()
    return content ?? null
  } catch {
    return null
  }
}

export type ForecastNarrative = { forecast: string; risk: string; insight: string; action: string; severity: string }
export type ForecastContext = {
  risk_score?: number
  risk_level?: string
  top_customer_pct?: number
  operating_dependency_ratio?: number
  recurring_spend_ratio?: number
}

/**
 * Enrich forecast narrative with finance-grade framing.
 * Preserves numbers and structure; improves clarity and avoids false precision.
 */
export async function generateNarrativeWithLLM(
  narrative: ForecastNarrative,
  context: ForecastContext | null,
): Promise<string> {
  if (!process.env.FORECAST_LLM_ENABLED) return narrative.forecast
  const ctx = context ?? {}
  const systemPrompt = `You are a CFO-grade financial analyst. Rewrite the forecast statement to be:
- Clear and actionable for a founder
- Finance-grade language (avoid jargon, but be precise)
- No false precision — if numbers are estimates, frame them as such
- Preserve all dollar amounts and percentages exactly as given
- Keep it to 1–2 sentences max

Context: risk ${ctx.risk_level ?? "unknown"} (${ctx.risk_score ?? 0}), top customer ${Math.round(ctx.top_customer_pct ?? 0)}%, operating-driven ${Math.round((ctx.operating_dependency_ratio ?? 1) * 100)}%`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Rewrite this forecast statement:\n\n"${narrative.forecast}"` },
  ], 150)
  return content && content.length > 10 ? content : narrative.forecast
}

/**
 * Disambiguate entity: pick best match from candidates for a raw counterparty string.
 */
export async function disambiguateEntity(
  counterparty: string,
  candidates: string[],
): Promise<string> {
  if (!process.env.FORECAST_LLM_ENABLED || candidates.length <= 1) return candidates[0] ?? counterparty
  const content = await callLLM([
    {
      role: "system",
      content: "Given a raw bank/processor description and candidate entity names, return ONLY the single best canonical name. Output nothing else.",
    },
    {
      role: "user",
      content: `Raw: "${counterparty}"\nCandidates: ${candidates.join(", ")}\nBest canonical name:`,
    },
  ], 50)
  const picked = content?.trim().replace(/^["']|["']$/g, "")
  return (picked && candidates.some((c) => c.toLowerCase().includes(picked.toLowerCase()) || picked.toLowerCase().includes(c.toLowerCase())))
    ? picked
    : (candidates[0] ?? counterparty)
}

/**
 * Batch canonicalize raw entity strings (e.g. "MARLINS TEAM5618/Payment 30280") to human-readable names.
 * Returns a map: raw -> canonical. Skips entries that look already clean.
 */
export async function canonicalizeEntitiesBatch(
  rawStrings: string[],
): Promise<Map<string, string>> {
  if (!process.env.FORECAST_LLM_ENABLED || !API_KEY || rawStrings.length === 0) return new Map()
  const needsWork = rawStrings.filter((s) => {
    const t = s.trim()
    return t.length > 3 && (/TEAM\s*\d+/i.test(t) || /\/\s*Payment\s+\d+/i.test(t) || /Payment\s+\d+/i.test(t) || t === t.toUpperCase())
  })
  if (needsWork.length === 0) return new Map()
  const unique = [...new Set(needsWork)].slice(0, 20) // cap batch size
  const asJson = JSON.stringify(unique)
  const systemPrompt = `You are a financial identity normalizer. Given an array of raw bank/processor transaction descriptions, return a JSON array of objects: [{"raw": "<exact original>", "canonical": "<clean name>"}].

Rules:
- "MARLINS TEAM5618/Payment 30280 PERFORMAN" -> "Marlins Team (Invoice 30280)"
- Strip TEAM1234, /Payment 30280, truncations
- Title-case company names
- Keep invoice numbers in parentheses when relevant
- "raw" must match the input string exactly. "canonical" is the human-readable name.
- Output ONLY valid JSON array.`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Normalize these:\n${asJson}` },
  ], 1024)
  const result = new Map<string, string>()
  if (!content) return result
  try {
    const jsonStr = content.replace(/```json?\s*/gi, "").replace(/```/g, "").trim()
    const parsed = JSON.parse(jsonStr) as Array<{ raw?: string; canonical?: string }>
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const raw = item?.raw
        const canonical = item?.canonical
        if (raw && canonical && typeof canonical === "string" && canonical.length >= 2) {
          result.set(String(raw).trim(), String(canonical).trim())
        }
      }
    }
  } catch { /* ignore parse errors */ }
  return result
}

// ─── Control Layer: Execution suggestions (reminders, drafts) ─────────

export type ExecutionSuggestionOut = {
  action_id: string
  action_label: string
  type: "reminder" | "draft" | "trigger"
  label: string
  content?: string
}

type InterventionForExecution = {
  id: string
  label: string
  type: string
  entity: string | null
}

/**
 * Generate execution suggestions: reminder text, email draft, etc.
 * Turns "Accelerate Sarah Katz" into "Send reminder", "Draft payment reminder email".
 */
export async function generateExecutionSuggestions(
  interventions: InterventionForExecution[],
): Promise<ExecutionSuggestionOut[]> {
  if (!process.env.FORECAST_LLM_ENABLED || !API_KEY || interventions.length === 0) return []
  const top = interventions.slice(0, 4)
  const list = top.map((i, idx) => `${idx + 1}. id="${i.id}" ${i.label} (${i.type}, entity: ${i.entity ?? "N/A"})`).join("\n")
  const systemPrompt = `You are a CFO assistant. For each cashflow action below, output ONE execution suggestion.

Rules:
- accelerate_collection → type "reminder", label "Send payment reminder", content = 2-3 sentence email draft
- delay_payment → type "draft", label "Draft extension request", content = 2-3 sentence message to vendor
- reduce_spend → type "trigger", label "Review discretionary spend", content = null

Output a JSON array with one object per action, in the same order. Each object: {"action_id": "exact id from input", "type": "reminder"|"draft"|"trigger", "label": "short label", "content": "draft or null"}`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Actions:\n${list}\n\nFor each, output execution suggestions as JSON array.` },
  ], 600)
  if (!content) return []
  const suggestions: ExecutionSuggestion[] = []
  try {
    const jsonStr = content.replace(/```json?\s*/gi, "").replace(/```/g, "").trim()
    const parsed = JSON.parse(jsonStr) as Array<{ action_id?: string; action_label?: string; type?: string; label?: string; content?: string }>
    if (Array.isArray(parsed)) {
      for (let idx = 0; idx < parsed.length && idx < top.length; idx++) {
        const item = parsed[idx]
        const iv = top[idx]
        if (iv && item && item.type && item.label) {
          suggestions.push({
            action_id: item.action_id ?? iv.id,
            action_label: iv.label,
            type: item.type as "reminder" | "draft" | "trigger",
            label: item.label,
            content: item.content ?? undefined,
          })
        }
      }
    }
  } catch { /* ignore */ }
  return suggestions
}
