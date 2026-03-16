/**
 * AI-powered entity name validator for reconciliation.
 *
 * Validates that a bank transaction description semantically matches a set of
 * candidate invoice/bill entity names BEFORE any amount matching occurs.
 * This prevents wrong-entity matches (e.g., "BOBOS" → "MUSH Wholesale").
 *
 * Key design decisions:
 * - Batches all candidates for a given bank description into one LLM call
 * - In-memory cache per waterfall run to avoid duplicate calls
 * - Graceful degradation: on LLM failure, returns all candidates as valid
 * - Read-only mode (DRY_RUN=true) logs rejections without actually filtering
 */

import { entityNameSimilarity, levenshteinSimilarity } from "./levenshtein"

const LLM_API_URL =
  process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const LLM_API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const LLM_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

/**
 * Whether entity filtering is active. Set to "true" in env to enable full filtering.
 * When false, validation still runs (for logging) but all candidates pass through.
 */
const ENTITY_FILTER_ENABLED =
  (process.env.RECONCILIATION_ENTITY_FILTER ?? "true") === "true"

/** Minimum entity name similarity score to pass WITHOUT LLM (fast path). */
const FAST_PATH_ACCEPT_THRESHOLD = 0.72

/** Below this score, reject WITHOUT LLM (fast path rejection). */
const FAST_PATH_REJECT_THRESHOLD = 0.10

/** Max candidates to include in one LLM batch. Beyond this, we split. */
const MAX_CANDIDATES_PER_LLM_CALL = 20

export interface CandidateEntity {
  entity_id: string
  /** Display name used for matching (customer_name or vendor_name) */
  display_name: string
  /** Optional aliases to also try */
  aliases?: string[]
}

export interface EntityValidationResult {
  entity_id: string
  isValid: boolean
  /** 0.0 – 1.0 */
  confidence: number
  /** How this decision was made */
  method: "fast_accept" | "fast_reject" | "llm_accept" | "llm_reject" | "fallback_accept"
  reason: string
}

interface LLMValidationResponse {
  /** entity_id → boolean */
  matches: Record<string, boolean>
}

/**
 * Batch-validate bank description against candidate entity names using a
 * single LLM call. Returns a match decision per entity_id.
 */
async function batchValidateWithLLM(
  bankDescription: string,
  candidates: CandidateEntity[]
): Promise<Map<string, boolean>> {
  if (!LLM_API_KEY || candidates.length === 0) {
    const fallback = new Map<string, boolean>()
    for (const c of candidates) fallback.set(c.entity_id, true)
    return fallback
  }

  const candidateLines = candidates
    .map((c, i) => {
      const aliases = c.aliases?.length
        ? ` (also known as: ${c.aliases.join(", ")})`
        : ""
      return `${i + 1}. ID="${c.entity_id}" Name="${c.display_name}"${aliases}`
    })
    .join("\n")

  const prompt = `You are a financial reconciliation assistant. Determine which invoice/bill entities semantically match this bank transaction.

Bank Transaction: "${bankDescription}"

Candidates:
${candidateLines}

Rules:
- "SP BOBOS - WHOLESALE" matches "Bobos" or "BOBOS" (same vendor, abbreviated bank label)
- "SP SMASH FOODS" matches "Smash Foods" (same vendor)
- "Spread The Love Foods" does NOT match "High Brew" (completely different vendors)
- "GOOGLE *Workspace" matches "Energlee Wholesale Portal" ONLY if they are the same vendor
- Abbreviations, "SP " prefixes, and minor typos are acceptable variations
- Match based on the VENDOR/CUSTOMER NAME only, not on amount or date
- When in doubt, return false (we prefer precision over recall)

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{"matches": {"<entity_id>": true_or_false, ...}}`

  try {
    const res = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      console.warn(
        `[EntityValidator] LLM HTTP error ${res.status} for "${bankDescription}"`
      )
      const fallback = new Map<string, boolean>()
      for (const c of candidates) fallback.set(c.entity_id, true)
      return fallback
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const raw = data.choices?.[0]?.message?.content?.trim() ?? ""

    let parsed: LLMValidationResponse
    try {
      parsed = JSON.parse(raw) as LLMValidationResponse
    } catch {
      console.warn(`[EntityValidator] Failed to parse LLM response: ${raw}`)
      const fallback = new Map<string, boolean>()
      for (const c of candidates) fallback.set(c.entity_id, true)
      return fallback
    }

    const result = new Map<string, boolean>()
    for (const c of candidates) {
      // Default to true if entity_id missing from LLM response (defensive)
      result.set(c.entity_id, parsed.matches?.[c.entity_id] ?? true)
    }
    return result
  } catch (err) {
    console.warn(
      `[EntityValidator] LLM call failed for "${bankDescription}":`,
      err instanceof Error ? err.message : String(err)
    )
    const fallback = new Map<string, boolean>()
    for (const c of candidates) fallback.set(c.entity_id, true)
    return fallback
  }
}

/**
 * Fast-path entity validation using string similarity only (no LLM).
 * Returns null when the result is uncertain (needs LLM).
 */
function fastPathValidate(
  bankDescription: string,
  candidate: CandidateEntity
): { isValid: boolean; confidence: number; reason: string } | null {
  const bankLow = bankDescription.toLowerCase().trim()
  const nameLow = candidate.display_name.toLowerCase().trim()

  // Exact substring match (e.g., "Spread The Love Foods" in "Spread The Love Foods")
  if (bankLow.includes(nameLow) && nameLow.length >= 4) {
    return { isValid: true, confidence: 0.97, reason: "Exact substring match" }
  }
  if (nameLow.includes(bankLow) && bankLow.length >= 4) {
    return { isValid: true, confidence: 0.95, reason: "Entity contains bank description" }
  }

  // Strip common bank prefixes before scoring ("SP ", "ACH ", "PREAUTHORIZED ")
  const bankStripped = bankLow
    .replace(/^(sp|ach|wire|preauthorized|preauth|pos|chk|check|debit|credit|deposit)\s+/i, "")
    .replace(/\s*(inc|llc|ltd|corp|co|wholesale|foods?|group)\b/gi, "")
    .trim()
  const nameStripped = nameLow
    .replace(/\s*(inc|llc|ltd|corp|co|wholesale|foods?|group)\b/gi, "")
    .trim()

  if (bankStripped && nameStripped) {
    if (bankStripped.includes(nameStripped) && nameStripped.length >= 4) {
      return { isValid: true, confidence: 0.93, reason: "Substring match after prefix strip" }
    }
    if (nameStripped.includes(bankStripped) && bankStripped.length >= 4) {
      return { isValid: true, confidence: 0.91, reason: "Reverse substring match after strip" }
    }
  }

  // String similarity score
  const simScore = entityNameSimilarity(bankDescription, candidate.display_name)
  const levScore = levenshteinSimilarity(
    bankStripped || bankLow,
    nameStripped || nameLow
  )
  const bestScore = Math.max(simScore, levScore)

  // Also check aliases
  let bestAliasScore = 0
  for (const alias of candidate.aliases ?? []) {
    const aliasSim = entityNameSimilarity(bankDescription, alias)
    if (aliasSim > bestAliasScore) bestAliasScore = aliasSim
  }
  const finalScore = Math.max(bestScore, bestAliasScore)

  if (finalScore >= FAST_PATH_ACCEPT_THRESHOLD) {
    return {
      isValid: true,
      confidence: finalScore,
      reason: `High similarity score (${(finalScore * 100).toFixed(0)}%)`,
    }
  }

  if (finalScore < FAST_PATH_REJECT_THRESHOLD) {
    return {
      isValid: false,
      confidence: 1 - finalScore,
      reason: `Very low similarity (${(finalScore * 100).toFixed(0)}%) — different entity`,
    }
  }

  // Uncertain: needs LLM
  return null
}

/**
 * Validate a bank description against a set of candidate entities.
 *
 * Algorithm:
 * 1. Fast-path: accept/reject based on string similarity (no LLM cost)
 * 2. For uncertain candidates, batch a single LLM call
 * 3. Return results for all candidates
 *
 * @param bankDescription  The bank's raw description or resolved display name
 * @param candidates       The candidate invoice/bill entities to validate
 * @param runCache         Optional Map for caching results within a single waterfall run
 *                         Key: `${bankDescription}::${entity_id}`
 */
export async function validateEntitiesForBankDescription(
  bankDescription: string,
  candidates: CandidateEntity[],
  runCache?: Map<string, EntityValidationResult>
): Promise<Map<string, EntityValidationResult>> {
  const results = new Map<string, EntityValidationResult>()
  const needsLLM: CandidateEntity[] = []

  for (const candidate of candidates) {
    const cacheKey = `${bankDescription}::${candidate.entity_id}`
    if (runCache?.has(cacheKey)) {
      results.set(candidate.entity_id, runCache.get(cacheKey)!)
      continue
    }

    const fastResult = fastPathValidate(bankDescription, candidate)
    if (fastResult !== null) {
      const result: EntityValidationResult = {
        entity_id: candidate.entity_id,
        isValid: fastResult.isValid,
        confidence: fastResult.confidence,
        method: fastResult.isValid ? "fast_accept" : "fast_reject",
        reason: fastResult.reason,
      }
      results.set(candidate.entity_id, result)
      runCache?.set(cacheKey, result)
    } else {
      needsLLM.push(candidate)
    }
  }

  if (needsLLM.length > 0) {
    // Batch into chunks if needed
    for (let i = 0; i < needsLLM.length; i += MAX_CANDIDATES_PER_LLM_CALL) {
      const chunk = needsLLM.slice(i, i + MAX_CANDIDATES_PER_LLM_CALL)
      const llmResults = await batchValidateWithLLM(bankDescription, chunk)

      for (const candidate of chunk) {
        const llmValid = llmResults.get(candidate.entity_id) ?? true
        const simScore = entityNameSimilarity(
          bankDescription,
          candidate.display_name
        )
        const result: EntityValidationResult = {
          entity_id: candidate.entity_id,
          isValid: llmValid,
          confidence: llmValid ? Math.max(simScore, 0.70) : Math.max(1 - simScore, 0.70),
          method: llmValid ? "llm_accept" : "llm_reject",
          reason: llmValid
            ? `LLM confirmed entity match`
            : `LLM rejected: "${bankDescription}" ≠ "${candidate.display_name}"`,
        }
        results.set(candidate.entity_id, result)
        runCache?.set(`${bankDescription}::${candidate.entity_id}`, result)
      }
    }
  }

  return results
}

/**
 * Filter a set of candidate cash events by AI entity name validation.
 *
 * Returns only events whose entity name semantically matches the bank description.
 * Also returns a map of rejected events with reasons for audit logging.
 *
 * When ENTITY_FILTER_ENABLED=false (read-only mode), all candidates pass through
 * but rejections are still logged.
 */
export async function filterCandidatesByEntityName<
  T extends {
    entity_id: string
    metadata?: Record<string, unknown> | null
  }
>(
  bankDescription: string | null,
  candidates: T[],
  runCache?: Map<string, EntityValidationResult>
): Promise<{
  accepted: T[]
  rejected: Array<{ event: T; reason: string; confidence: number }>
  validationMap: Map<string, EntityValidationResult>
}> {
  if (!bankDescription || candidates.length === 0) {
    return { accepted: candidates, rejected: [], validationMap: new Map() }
  }

  // Build candidate list with display names extracted from metadata
  const entityList: CandidateEntity[] = candidates.map((c) => {
    const meta = (c.metadata ?? {}) as Record<string, unknown>
    const displayName =
      (typeof meta.customer_name === "string" ? meta.customer_name : null) ??
      (typeof meta.vendor_name === "string" ? meta.vendor_name : null) ??
      (typeof meta.canonical_name === "string" ? meta.canonical_name : null) ??
      c.entity_id

    return {
      entity_id: c.entity_id,
      display_name: displayName,
    }
  })

  const validationMap = await validateEntitiesForBankDescription(
    bankDescription,
    entityList,
    runCache
  )

  const accepted: T[] = []
  const rejected: Array<{ event: T; reason: string; confidence: number }> = []

  for (const candidate of candidates) {
    const validation = validationMap.get(candidate.entity_id)
    const isValid = validation?.isValid ?? true // Default accept if no result

    if (isValid || !ENTITY_FILTER_ENABLED) {
      accepted.push(candidate)
      if (!isValid) {
        // DRY_RUN: log but don't filter
        console.log(
          `[EntityValidator:dry-run] Would reject entity=${candidate.entity_id} ` +
            `reason="${validation?.reason}" bank="${bankDescription}"`
        )
      }
    } else {
      rejected.push({
        event: candidate,
        reason: validation?.reason ?? "Entity validation failed",
        confidence: validation?.confidence ?? 0,
      })
      console.log(
        `[EntityValidator] Rejected entity=${candidate.entity_id} ` +
          `method=${validation?.method} reason="${validation?.reason}" bank="${bankDescription}"`
      )
    }
  }

  return { accepted, rejected, validationMap }
}

/**
 * Build a per-run cache for entity validation results.
 * Pass this into filterCandidatesByEntityName to avoid redundant LLM calls
 * for movements that share the same bank description (e.g., batch payouts).
 */
export function createEntityValidationCache(): Map<string, EntityValidationResult> {
  return new Map()
}
