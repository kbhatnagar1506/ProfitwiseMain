/**
 * Payment → AP matching: suggest likely obligation matches for unmatched payments.
 * When deterministic match confidence < threshold, LLM suggests matches with reasoning.
 * No write — UI or user confirms.
 */

import type { APObligation } from "./state/ar-ap"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

const AMOUNT_TOLERANCE_PCT = 0.05
const DATE_TOLERANCE_DAYS = 14

export type PaymentInput = {
  movement_id: string
  amount: number
  date: string
  raw_description: string | null
  entity_id: string | null
  counterparty_name?: string | null
}

export type MatchSuggestion = {
  obligation_id: string
  vendor_name: string
  confidence: "high" | "medium" | "low"
  reasoning: string
}

/** Normalize name for fuzzy match. */
function normalizeName(s: string | null | undefined): string {
  if (!s || typeof s !== "string") return ""
  return s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim()
}

/** Check if two names are similar enough. */
function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) return true
  const tokensA = new Set(na.split(/\s+/).filter((t) => t.length > 1))
  const tokensB = new Set(nb.split(/\s+/).filter((t) => t.length > 1))
  const overlap = [...tokensA].filter((t) => tokensB.has(t)).length
  return overlap >= Math.min(tokensA.size, tokensB.size, 2)
}

/** Deterministic match: amount ±5%, date ±14 days. When entity_id missing, use counterparty vs vendor name. */
function deterministicMatch(
  payment: PaymentInput,
  obligation: APObligation,
): { confidence: number; reasoning: string } | null {
  if (payment.amount <= 0 || obligation.amount_due <= 0) return null
  const amountRatio = payment.amount / obligation.amount_due
  if (amountRatio < 1 - AMOUNT_TOLERANCE_PCT || amountRatio > 1 + AMOUNT_TOLERANCE_PCT) return null

  const payDate = new Date(payment.date).getTime()
  const dueDate = obligation.due_date ? new Date(obligation.due_date).getTime() : payDate
  const diffDays = Math.abs((payDate - dueDate) / 86_400_000)
  if (diffDays > DATE_TOLERANCE_DAYS) return null

  const amountMatch = 1 - Math.abs(amountRatio - 1)
  const dateMatch = 1 - diffDays / DATE_TOLERANCE_DAYS
  const entityMatch = payment.entity_id && obligation.entity_id
    ? payment.entity_id === obligation.entity_id
    : false
  const nameMatch = namesMatch(
    payment.counterparty_name ?? payment.raw_description,
    obligation.vendor_name,
  )
  if (payment.entity_id && obligation.entity_id && !entityMatch && !nameMatch) return null
  const entityScore = entityMatch ? 1 : nameMatch ? 0.85 : 0.5
  const confidence = (amountMatch + dateMatch + entityScore) / 3
  return {
    confidence,
    reasoning: `Amount within ±${AMOUNT_TOLERANCE_PCT * 100}%, date within ±${DATE_TOLERANCE_DAYS} days`,
  }
}

const DETERMINISTIC_THRESHOLD = 0.8

export type APAllocationCandidate = {
  movement_id: string
  obligation_id: string
  gross_applied: number
  fee_amount: number
  net_applied: number
  confidence: number
  match_method: "exact" | "tolerance"
}

/**
 * Find best AP match for an outflow payment. Returns allocation candidate or null.
 * Used for auto-matching in reconciliation.
 */
export function matchAPPayment(
  payment: PaymentInput,
  obligations: APObligation[],
): APAllocationCandidate | null {
  let best: { cand: APAllocationCandidate; conf: number } | null = null
  for (const ob of obligations) {
    const m = deterministicMatch(payment, ob)
    if (!m || m.confidence < DETERMINISTIC_THRESHOLD) continue
    // When entity IDs differ, deterministicMatch uses name fallback; allow match if confidence passes.
    if (!best || m.confidence > best.conf) {
      const gross = ob.amount_due
      const net = payment.amount
      const fee = Math.max(0, gross - net)
      const method = Math.abs(payment.amount / ob.amount_due - 1) < 0.01 ? "exact" : "tolerance"
      best = {
        conf: m.confidence,
        cand: {
          movement_id: payment.movement_id,
          obligation_id: ob.obligation_id,
          gross_applied: gross,
          fee_amount: fee,
          net_applied: net,
          confidence: m.confidence,
          match_method: method,
        },
      }
    }
  }
  return best?.cand ?? null
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

function parseLLMMatches(content: string | null, obligations: APObligation[]): MatchSuggestion[] {
  if (!content) return []
  const suggestions: MatchSuggestion[] = []
  const lines = content.split("\n").filter((l) => l.trim())
  const obById = new Map(obligations.map((o) => [o.obligation_id, o]))
  for (const line of lines) {
    const match = line.match(/^[-*]?\s*(?:obligation_id[:\s]+)?([a-z0-9_]+)[:\s,]+(?:confidence[:\s]+)?(high|medium|low)[:\s]*(.*)$/i)
    if (match) {
      const [, id, conf, reason] = match
      const ob = obById.get(id?.trim() ?? "")
      if (ob) {
        suggestions.push({
          obligation_id: ob.obligation_id,
          vendor_name: ob.vendor_name,
          confidence: conf?.toLowerCase() as "high" | "medium" | "low",
          reasoning: (reason ?? "").trim() || "LLM suggested match",
        })
      }
    }
  }
  return suggestions.slice(0, 5)
}

/**
 * Suggest AP obligation matches for an unmatched payment.
 * If deterministic match confidence >= threshold, returns that match.
 * Otherwise calls LLM to suggest likely matches. No write; user confirms.
 */
export async function suggestAPMatches(
  payment: PaymentInput,
  obligations: APObligation[],
): Promise<MatchSuggestion[]> {
  // Deterministic: find best match
  let best: { obligation: APObligation; confidence: number; reasoning: string } | null = null
  for (const ob of obligations) {
    const m = deterministicMatch(payment, ob)
    if (m && m.confidence >= DETERMINISTIC_THRESHOLD && (!best || m.confidence > best.confidence)) {
      best = { obligation: ob, confidence: m.confidence, reasoning: m.reasoning }
    }
  }
  if (best) {
    return [{
      obligation_id: best.obligation.obligation_id,
      vendor_name: best.obligation.vendor_name,
      confidence: "high",
      reasoning: best.reasoning,
    }]
  }

  // LLM fallback for unmatched
  if (!API_KEY || obligations.length === 0) return []

  const obSummary = obligations.slice(0, 15).map((o) =>
    `- ${o.obligation_id}: ${o.vendor_name}, $${o.amount_due.toFixed(2)} due ${o.due_date ?? "unknown"}`
  ).join("\n")

  const systemPrompt = `You are an AP matching assistant. Given an unmatched payment (outflow) and a list of outstanding AP obligations, suggest the most likely match(es). Output one line per suggestion in this format:
obligation_id: confidence (high|medium|low): brief reasoning

Only suggest obligations that could reasonably match the payment. Order by likelihood. Max 5 suggestions.`

  const userPrompt = `Payment: $${payment.amount.toFixed(2)} on ${payment.date}
Description: ${payment.raw_description ?? "—"}
Counterparty: ${payment.counterparty_name ?? "—"}

Outstanding obligations:
${obSummary}

Suggest matches (one per line):`

  const content = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ])
  return parseLLMMatches(content, obligations)
}
