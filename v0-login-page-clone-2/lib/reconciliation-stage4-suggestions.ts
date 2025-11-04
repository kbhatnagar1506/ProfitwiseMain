import { query } from "./db"
import { searchEntityContextFromSupermemory } from "./supermemory"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

type QueueRow = {
  id: string
  movement_id: string
  remaining_cash: string
  candidate_payload: unknown
}

type Candidate = {
  event_id: string
  entity_id: string
  canonical_name: string
  event_type: "ar" | "ap"
  expected_date: string
  outstanding_amount: number
  amount_delta: number
  date_delta_days: number | null
  alias_match: boolean
}

type MovementPayload = {
  movement_id: string
  amount: number
  target_type: "ar" | "ap"
  counterparty: string | null
  raw_description: string | null
}

type ParsedPayload = {
  movement: MovementPayload
  candidates: Candidate[]
}

export type Stage4Suggestion = {
  event_id: string
  entity_id: string
  canonical_name: string
  confidence: number
  reasoning: string
  allocation_plan: {
    gross_amount: number
    net_amount: number
    fee_amount: number
    component_type: "ar" | "ap"
  }
}

export type Stage4SuggestionSummary = {
  queued_count: number
  suggested_count: number
  failed_count: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function toParsedPayload(raw: unknown): ParsedPayload | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const mv = obj.movement as Record<string, unknown> | undefined
  const candidates = Array.isArray(obj.candidates) ? obj.candidates : []
  if (!mv) return null
  return {
    movement: {
      movement_id: String(mv.movement_id ?? ""),
      amount: Number(mv.amount ?? 0),
      target_type: (mv.target_type === "ap" ? "ap" : "ar"),
      counterparty: typeof mv.counterparty === "string" ? mv.counterparty : null,
      raw_description: typeof mv.raw_description === "string" ? mv.raw_description : null,
    },
    candidates: candidates
      .map((c) => c as Record<string, unknown>)
      .map((c) => ({
        event_id: String(c.event_id ?? ""),
        entity_id: String(c.entity_id ?? ""),
        canonical_name: String(c.canonical_name ?? ""),
        event_type: c.event_type === "ap" ? "ap" : "ar",
        expected_date: String(c.expected_date ?? ""),
        outstanding_amount: Number(c.outstanding_amount ?? 0),
        amount_delta: Number(c.amount_delta ?? 0),
        date_delta_days: c.date_delta_days == null ? null : Number(c.date_delta_days),
        alias_match: Boolean(c.alias_match),
      }))
      .filter((c) => Boolean(c.event_id)),
  }
}

export function scoreCandidateForTest(movementAmount: number, c: Candidate): { confidence: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0.45
  const amountGap = Math.abs((c.amount_delta || 0) / Math.max(1, movementAmount))
  if (amountGap <= 0.02) {
    score += 0.28
    reasons.push("amount_exactish")
  } else if (amountGap <= 0.08) {
    score += 0.16
    reasons.push("amount_close")
  } else if (amountGap <= 0.2) {
    score += 0.08
    reasons.push("amount_possible")
  }
  if (c.alias_match) {
    score += 0.14
    reasons.push("alias_match")
  }
  if (c.date_delta_days != null && c.date_delta_days <= 14) {
    score += 0.1
    reasons.push("date_near")
  } else if (c.date_delta_days != null && c.date_delta_days <= 45) {
    score += 0.04
    reasons.push("date_plausible")
  }
  return { confidence: clamp(round2(score), 0.05, 0.99), reasons }
}

async function callReasoningLLM(input: {
  movement: MovementPayload
  candidates: Stage4Suggestion[]
  supermemoryHints: string
}): Promise<Record<string, string>> {
  if (!API_KEY || input.candidates.length === 0) return {}
  const lines = input.candidates
    .map(
      (s) =>
        `${s.event_id} | ${s.canonical_name} | confidence=${s.confidence.toFixed(2)} | gross=${s.allocation_plan.gross_amount.toFixed(2)} | fee=${s.allocation_plan.fee_amount.toFixed(2)} | net=${s.allocation_plan.net_amount.toFixed(2)}`,
    )
    .join("\n")
  const prompt = [
    "You are a reconciliation analyst. Improve reasoning for candidate matches.",
    `Movement: id=${input.movement.movement_id}, amount=${input.movement.amount.toFixed(2)}, counterparty=${input.movement.counterparty ?? input.movement.raw_description ?? "unknown"}, target=${input.movement.target_type}`,
    input.supermemoryHints ? `Supermemory context:\n${input.supermemoryHints.slice(0, 2000)}` : "",
    `Candidates:\n${lines}`,
    "Return one line per candidate: event_id: short_reason",
  ]
    .filter(Boolean)
    .join("\n\n")

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        max_tokens: 300,
        messages: [
          { role: "system", content: "Produce concise evidence-based reconciliation reasons." },
          { role: "user", content: prompt },
        ],
      }),
    })
    if (!res.ok) return {}
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content ?? ""
    const out: Record<string, string> = {}
    for (const line of content.split("\n")) {
      const idx = line.indexOf(":")
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      const reason = line.slice(idx + 1).trim()
      if (key && reason) out[key] = reason
    }
    return out
  } catch {
    return {}
  }
}

export function buildAllocationPlanForTest(movement: MovementPayload, c: Candidate): Stage4Suggestion["allocation_plan"] {
  const fee = movement.target_type === "ar" && c.outstanding_amount > movement.amount ? round2(c.outstanding_amount - movement.amount) : 0
  const gross = round2(Math.min(c.outstanding_amount, fee > 0 ? c.outstanding_amount : movement.amount))
  const net = round2(Math.max(0, gross - fee))
  return {
    gross_amount: gross,
    net_amount: net,
    fee_amount: fee,
    component_type: movement.target_type,
  }
}

export async function generateStage4Suggestions(
  userId: string,
  options: { batchSize?: number; minConfidence?: number } = {},
): Promise<Stage4SuggestionSummary> {
  const batchSize = Math.max(1, Math.min(200, options.batchSize ?? 50))
  const minConfidence = options.minConfidence ?? 0.62
  const { rows } = await query<QueueRow>(
    `SELECT id::text, movement_id::text, remaining_cash::text, candidate_payload
     FROM reconciliation_review_queue
     WHERE user_id = $1
       AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, batchSize],
  )

  let suggested = 0
  let failed = 0
  for (const row of rows) {
    const parsed = toParsedPayload(row.candidate_payload)
    if (!parsed) {
      failed++
      continue
    }
    const movementAmount = Number(row.remaining_cash) || parsed.movement.amount || 0
    const merchantString = parsed.movement.counterparty ?? parsed.movement.raw_description ?? ""
    const supermemoryHints = await searchEntityContextFromSupermemory(userId, merchantString)

    const deterministic = parsed.candidates
      .map((c) => {
        const score = scoreCandidateForTest(movementAmount, c)
        const plan = buildAllocationPlanForTest(parsed.movement, c)
        return {
          event_id: c.event_id,
          entity_id: c.entity_id,
          canonical_name: c.canonical_name,
          confidence: score.confidence,
          reasoning: score.reasons.join(", "),
          allocation_plan: plan,
        } satisfies Stage4Suggestion
      })
      .filter((s) => s.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3)

    const llmReasons = await callReasoningLLM({
      movement: parsed.movement,
      candidates: deterministic,
      supermemoryHints,
    })

    const suggestions = deterministic.map((s) => ({
      ...s,
      reasoning: llmReasons[s.event_id] ?? s.reasoning ?? "candidate match",
    }))

    await query(
      `UPDATE reconciliation_review_queue
       SET resolution = jsonb_build_object(
         'suggestions', $2::jsonb,
         'supermemory_hints_used', $3::boolean,
         'generated_at', NOW()
       ),
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, JSON.stringify(suggestions), Boolean(supermemoryHints)],
    )
    if (suggestions.length > 0) suggested += 1
  }

  return {
    queued_count: rows.length,
    suggested_count: suggested,
    failed_count: failed,
  }
}
