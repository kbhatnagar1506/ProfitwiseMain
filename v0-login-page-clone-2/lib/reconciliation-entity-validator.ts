/**
 * AI-powered entity name validator for reconciliation.
 *
 * Architecture: Supermemory → LLM → fast-path string similarity
 *
 * 1. Supermemory first: Search the user's entity memory for the bank description.
 *    Returns known canonical names, aliases, and previously-seen bank patterns.
 *    This is the normalization layer — it grounds the LLM in the user's actual
 *    entity graph rather than relying on generic string similarity.
 *
 * 2. LLM with memory context: Feed Supermemory results into the GPT-4o prompt
 *    as authoritative context. The LLM normalizes "SP BOBOS - WHOLESALE" →
 *    "Bobos" because Supermemory already knows that pattern maps to "Bobos".
 *    Without Supermemory context, the LLM would have to guess.
 *
 * 3. Fast-path: For well-known patterns that appear in entity profiles
 *    (bank_description_patterns), we match instantly without any LLM cost.
 *
 * 4. Write-back: After a confirmed match, the bank description pattern is
 *    stored back to Supermemory so the next run is even faster/more accurate.
 *
 * Controlled by:
 *   RECONCILIATION_ENTITY_FILTER=true|false (default: true)
 *   SUPERMEMORY_API_KEY — if not set, falls back to LLM-only mode
 */

import { entityNameSimilarity, levenshteinSimilarity } from "./levenshtein"
import {
  searchEntityContextFromSupermemory,
  getUserFinanceTag,
} from "./supermemory"
import { getEntityProfile } from "./supermemory-entity-profiles"

const LLM_API_URL =
  process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const LLM_API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY
const LLM_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

const ENTITY_FILTER_ENABLED =
  (process.env.RECONCILIATION_ENTITY_FILTER ?? "true") === "true"

const FAST_PATH_ACCEPT_THRESHOLD = 0.72
const FAST_PATH_REJECT_THRESHOLD = 0.10
const MAX_CANDIDATES_PER_LLM_CALL = 20

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CandidateEntity {
  entity_id: string
  display_name: string
  aliases?: string[]
}

export interface EntityValidationResult {
  entity_id: string
  isValid: boolean
  confidence: number
  method:
    | "memory_pattern_accept"
    | "fast_accept"
    | "fast_reject"
    | "llm_accept"
    | "llm_reject"
    | "memory_llm_accept"
    | "memory_llm_reject"
    | "fallback_accept"
  reason: string
  /** Canonical name resolved from Supermemory, if found */
  resolvedCanonicalName?: string
}

// ─── Supermemory: bank description pattern cache ──────────────────────────────
// Maps bankDesc (lowercase) → Set of known canonical entity names from memory

interface MemoryContextEntry {
  /** Known canonical names that appeared in Supermemory search results */
  knownCanonicals: Set<string>
  /** Raw context string to pass to LLM */
  rawContext: string
  cachedAt: number
}

const memoryContextCache = new Map<string, MemoryContextEntry>()
const MEMORY_CACHE_TTL_MS = 10 * 60 * 1000

async function getMemoryContext(
  userId: string,
  bankDescription: string
): Promise<{ knownCanonicals: Set<string>; rawContext: string }> {
  if (!process.env.SUPERMEMORY_API_KEY) {
    return { knownCanonicals: new Set(), rawContext: "" }
  }

  const cacheKey = `${userId}::${bankDescription.toLowerCase().slice(0, 120)}`
  const cached = memoryContextCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt < MEMORY_CACHE_TTL_MS) {
    return { knownCanonicals: cached.knownCanonicals, rawContext: cached.rawContext }
  }

  try {
    const rawContext = await searchEntityContextFromSupermemory(userId, bankDescription)
    const knownCanonicals = extractCanonicalNamesFromContext(rawContext)

    const entry: MemoryContextEntry = { knownCanonicals, rawContext, cachedAt: Date.now() }
    memoryContextCache.set(cacheKey, entry)
    return { knownCanonicals, rawContext }
  } catch {
    return { knownCanonicals: new Set(), rawContext: "" }
  }
}

/** Parse canonical entity names out of a Supermemory context string. */
function extractCanonicalNamesFromContext(context: string): Set<string> {
  const names = new Set<string>()
  if (!context) return names

  // Match patterns like: Entity: "Name", Name: "...", canonical name ...: "..."
  const patterns = [
    /Entity:\s*"([^"]+)"/gi,
    /canonical(?:\s+name)?[:\s]+["']?([^"'\n,]+)["']?/gi,
    /Name:\s*"([^"]+)"/gi,
    /"([^"]{3,60})"\s+should be normalized as\s+"([^"]+)"/gi,
  ]

  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(context)) !== null) {
      // For normalization pattern, use the normalized form (group 2)
      const name = (match[2] ?? match[1])?.trim()
      if (name && name.length >= 2 && name.length <= 100) {
        names.add(name.toLowerCase())
      }
    }
  }

  return names
}

/** Check if a bank description matches any known canonical name from Supermemory memory. */
function matchesMemoryPattern(
  bankDescription: string,
  candidate: CandidateEntity,
  knownCanonicals: Set<string>
): { matches: boolean; confidence: number } {
  const bankLow = bankDescription.toLowerCase().trim()
  const nameLow = candidate.display_name.toLowerCase().trim()

  // Direct hit: Supermemory knows this canonical name
  if (knownCanonicals.has(nameLow)) {
    // Now check if bank description relates to it
    const sim = entityNameSimilarity(bankDescription, candidate.display_name)
    if (sim >= 0.60) {
      return { matches: true, confidence: Math.max(sim, 0.88) }
    }
    // Supermemory confirmed it exists but string sim is low — check substring
    if (bankLow.includes(nameLow.replace(/[^a-z0-9]/g, "")) && nameLow.length >= 3) {
      return { matches: true, confidence: 0.90 }
    }
  }

  // Check all aliases
  for (const alias of candidate.aliases ?? []) {
    const aliasLow = alias.toLowerCase().trim()
    if (knownCanonicals.has(aliasLow)) {
      const sim = entityNameSimilarity(bankDescription, alias)
      if (sim >= 0.55) {
        return { matches: true, confidence: Math.max(sim, 0.85) }
      }
    }
  }

  return { matches: false, confidence: 0 }
}

// ─── Entity profile: bank_description_patterns fast-path ──────────────────────

/**
 * Check if a bank description matches any previously-seen pattern for an entity.
 * Uses the bank_description_patterns stored in entity profiles from Supermemory.
 */
async function matchesBankDescriptionPattern(
  userId: string,
  bankDescription: string,
  entityId: string
): Promise<{ matches: boolean; confidence: number }> {
  if (!userId || !process.env.SUPERMEMORY_API_KEY) {
    return { matches: false, confidence: 0 }
  }

  try {
    const profile = await getEntityProfile(userId, entityId)
    if (!profile?.bank_description_patterns?.length) return { matches: false, confidence: 0 }

    const bankLow = bankDescription.toLowerCase().trim()
    for (const pattern of profile.bank_description_patterns) {
      const patternLow = pattern.toLowerCase().trim()
      if (!patternLow) continue

      // Exact match
      if (bankLow === patternLow) return { matches: true, confidence: 0.99 }

      // Substring match (pattern is long enough to be discriminative)
      if (patternLow.length >= 6 && bankLow.includes(patternLow)) {
        return { matches: true, confidence: 0.96 }
      }
      if (bankLow.length >= 6 && patternLow.includes(bankLow)) {
        return { matches: true, confidence: 0.94 }
      }

      // Similarity match
      const sim = entityNameSimilarity(bankDescription, pattern)
      if (sim >= 0.88) return { matches: true, confidence: sim }
    }
  } catch {
    // Non-fatal
  }

  return { matches: false, confidence: 0 }
}

// ─── LLM batch call with Supermemory context ──────────────────────────────────

interface LLMValidationResponse {
  matches: Record<string, boolean>
}

async function batchValidateWithLLM(
  bankDescription: string,
  candidates: CandidateEntity[],
  memoryContext: string
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

  // Include Supermemory context as authoritative normalization hints
  const memorySection = memoryContext
    ? `\nKnown entity memory (authoritative — use this to resolve aliases and bank labels):\n${memoryContext.slice(0, 1500)}\n`
    : ""

  const prompt = `You are a financial reconciliation assistant normalizing bank transaction descriptions to known entities.

Bank Transaction: "${bankDescription}"
${memorySection}
Candidates:
${candidateLines}

Rules:
- Use the entity memory above as authoritative ground truth for name resolution
- "SP BOBOS - WHOLESALE" matches "Bobos" — same vendor, abbreviated bank label  
- "SP SMASH FOODS" matches "Smash Foods" — same vendor
- Processor prefixes ("SP ", "ACH ", "PREAUTHORIZED ACH ") are common and should be ignored when matching
- "Neve Foods" does NOT match "Think Jerky" — completely different vendors
- "Harmless Harvest" does NOT match "Belle's Gourmet Popcorn" — different vendors
- Match by VENDOR/CUSTOMER NAME ONLY, ignore amounts and dates
- If memory context says this bank description maps to a canonical name, trust it
- When truly uncertain, return false (prefer precision)

Respond ONLY with valid JSON (no markdown):
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
        max_tokens: 300,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      console.warn(`[EntityValidator] LLM HTTP ${res.status} for "${bankDescription}"`)
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
      console.warn(`[EntityValidator] Failed to parse LLM response for "${bankDescription}": ${raw}`)
      const fallback = new Map<string, boolean>()
      for (const c of candidates) fallback.set(c.entity_id, true)
      return fallback
    }

    const result = new Map<string, boolean>()
    for (const c of candidates) {
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

// ─── Fast-path: pure string similarity ────────────────────────────────────────

function fastPathValidate(
  bankDescription: string,
  candidate: CandidateEntity
): { isValid: boolean; confidence: number; reason: string } | null {
  const bankLow = bankDescription.toLowerCase().trim()
  const nameLow = candidate.display_name.toLowerCase().trim()

  // Exact substring match
  if (bankLow.includes(nameLow) && nameLow.length >= 4) {
    return { isValid: true, confidence: 0.97, reason: "Exact substring match" }
  }
  if (nameLow.includes(bankLow) && bankLow.length >= 4) {
    return { isValid: true, confidence: 0.95, reason: "Entity contains bank description" }
  }

  // Strip common bank prefixes + corporate suffixes
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

  // Combined similarity score
  const simScore = entityNameSimilarity(bankDescription, candidate.display_name)
  const levScore = levenshteinSimilarity(
    bankStripped || bankLow,
    nameStripped || nameLow
  )

  // Check aliases
  let bestAliasScore = 0
  for (const alias of candidate.aliases ?? []) {
    const aliasSim = entityNameSimilarity(bankDescription, alias)
    if (aliasSim > bestAliasScore) bestAliasScore = aliasSim
  }

  const finalScore = Math.max(simScore, levScore, bestAliasScore)

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

  // Uncertain: needs Supermemory + LLM
  return null
}

// ─── Primary validation function ─────────────────────────────────────────────

/**
 * Validate a bank description against candidate entities.
 *
 * Resolution order:
 * 1. Entity profile bank_description_patterns (fastest — pure DB lookup)
 * 2. Fast-path string similarity (no API cost)
 * 3. Supermemory context retrieval (one search per bank description)
 * 4. Memory pattern matching (Supermemory results vs candidate names)
 * 5. LLM validation with Supermemory context injected (most accurate)
 *
 * @param userId    Required when Supermemory is enabled (for per-user isolation)
 * @param runCache  Per-waterfall-run result cache to avoid redundant calls
 */
export async function validateEntitiesForBankDescription(
  bankDescription: string,
  candidates: CandidateEntity[],
  runCache?: Map<string, EntityValidationResult>,
  userId?: string
): Promise<Map<string, EntityValidationResult>> {
  const results = new Map<string, EntityValidationResult>()
  const needsMemoryOrLLM: CandidateEntity[] = []

  // ── Pass 1: profile pattern match + fast-path ──────────────────────────────
  for (const candidate of candidates) {
    const cacheKey = `${bankDescription}::${candidate.entity_id}`
    if (runCache?.has(cacheKey)) {
      results.set(candidate.entity_id, runCache.get(cacheKey)!)
      continue
    }

    // Profile pattern match (only if we have a userId for Supermemory)
    if (userId) {
      const patternMatch = await matchesBankDescriptionPattern(userId, bankDescription, candidate.entity_id)
      if (patternMatch.matches) {
        const result: EntityValidationResult = {
          entity_id: candidate.entity_id,
          isValid: true,
          confidence: patternMatch.confidence,
          method: "memory_pattern_accept",
          reason: `Matched known bank description pattern for entity`,
        }
        results.set(candidate.entity_id, result)
        runCache?.set(cacheKey, result)
        continue
      }
    }

    // Fast-path string similarity
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
      needsMemoryOrLLM.push(candidate)
    }
  }

  if (needsMemoryOrLLM.length === 0) return results

  // ── Pass 2: Supermemory context retrieval ──────────────────────────────────
  let memoryContext = ""
  let knownCanonicals = new Set<string>()

  if (userId && process.env.SUPERMEMORY_API_KEY) {
    const ctx = await getMemoryContext(userId, bankDescription)
    memoryContext = ctx.rawContext
    knownCanonicals = ctx.knownCanonicals
  }

  // ── Pass 3: Memory pattern matching for uncertain candidates ──────────────
  const stillNeedsLLM: CandidateEntity[] = []
  for (const candidate of needsMemoryOrLLM) {
    const memoryMatch = matchesMemoryPattern(bankDescription, candidate, knownCanonicals)
    if (memoryMatch.matches || knownCanonicals.size > 0) {
      // If memory gave us canonical names, and this entity's name is NOT among them,
      // we can be more aggressive about rejection
      const nameLow = candidate.display_name.toLowerCase().trim()
      const entityInMemory = knownCanonicals.has(nameLow) ||
        (candidate.aliases ?? []).some(a => knownCanonicals.has(a.toLowerCase().trim()))

      if (memoryMatch.matches) {
        const result: EntityValidationResult = {
          entity_id: candidate.entity_id,
          isValid: true,
          confidence: memoryMatch.confidence,
          method: "memory_pattern_accept",
          reason: `Supermemory canonical match`,
          resolvedCanonicalName: candidate.display_name,
        }
        results.set(candidate.entity_id, result)
        runCache?.set(`${bankDescription}::${candidate.entity_id}`, result)
        continue
      }
    }
    stillNeedsLLM.push(candidate)
  }

  // ── Pass 4: LLM with Supermemory context ──────────────────────────────────
  for (let i = 0; i < stillNeedsLLM.length; i += MAX_CANDIDATES_PER_LLM_CALL) {
    const chunk = stillNeedsLLM.slice(i, i + MAX_CANDIDATES_PER_LLM_CALL)
    const llmResults = await batchValidateWithLLM(bankDescription, chunk, memoryContext)

    for (const candidate of chunk) {
      const llmValid = llmResults.get(candidate.entity_id) ?? true
      const simScore = entityNameSimilarity(bankDescription, candidate.display_name)
      const hasMemoryContext = memoryContext.length > 0
      const result: EntityValidationResult = {
        entity_id: candidate.entity_id,
        isValid: llmValid,
        confidence: llmValid ? Math.max(simScore, 0.70) : Math.max(1 - simScore, 0.70),
        method: hasMemoryContext
          ? llmValid ? "memory_llm_accept" : "memory_llm_reject"
          : llmValid ? "llm_accept" : "llm_reject",
        reason: llmValid
          ? hasMemoryContext
            ? `Supermemory+LLM confirmed entity match`
            : `LLM confirmed entity match`
          : hasMemoryContext
            ? `Supermemory+LLM rejected: "${bankDescription}" ≠ "${candidate.display_name}"`
            : `LLM rejected: "${bankDescription}" ≠ "${candidate.display_name}"`,
      }
      results.set(candidate.entity_id, result)
      runCache?.set(`${bankDescription}::${candidate.entity_id}`, result)
    }
  }

  return results
}

// ─── filterCandidatesByEntityName ────────────────────────────────────────────

export async function filterCandidatesByEntityName<
  T extends {
    entity_id: string
    metadata?: Record<string, unknown> | null
  }
>(
  bankDescription: string | null,
  candidates: T[],
  runCache?: Map<string, EntityValidationResult>,
  userId?: string
): Promise<{
  accepted: T[]
  rejected: Array<{ event: T; reason: string; confidence: number }>
  validationMap: Map<string, EntityValidationResult>
}> {
  if (!bankDescription || candidates.length === 0) {
    return { accepted: candidates, rejected: [], validationMap: new Map() }
  }

  const entityList: CandidateEntity[] = candidates.map((c) => {
    const meta = (c.metadata ?? {}) as Record<string, unknown>
    const displayName =
      (typeof meta.customer_name === "string" ? meta.customer_name : null) ??
      (typeof meta.vendor_name === "string" ? meta.vendor_name : null) ??
      (typeof meta.canonical_name === "string" ? meta.canonical_name : null) ??
      c.entity_id

    return { entity_id: c.entity_id, display_name: displayName }
  })

  const validationMap = await validateEntitiesForBankDescription(
    bankDescription,
    entityList,
    runCache,
    userId
  )

  const accepted: T[] = []
  const rejected: Array<{ event: T; reason: string; confidence: number }> = []

  for (const candidate of candidates) {
    const validation = validationMap.get(candidate.entity_id)
    const isValid = validation?.isValid ?? true

    if (isValid || !ENTITY_FILTER_ENABLED) {
      accepted.push(candidate)
      if (!isValid) {
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

// ─── Write-back: store confirmed bank description pattern in Supermemory ──────

/**
 * After a match is confirmed (applied or user-verified), store the bank description
 * as a known pattern for this entity in Supermemory. This builds up the memory
 * layer over time so future runs use the faster memory_pattern_accept path.
 */
export async function recordConfirmedBankPattern(
  userId: string,
  entityId: string,
  entityName: string,
  bankDescription: string
): Promise<void> {
  if (!userId || !entityId || !bankDescription || !process.env.SUPERMEMORY_API_KEY) return

  try {
    const { default: Supermemory } = await import("supermemory")
    const sm = new Supermemory({ apiKey: process.env.SUPERMEMORY_API_KEY })
    const tag = getUserFinanceTag(userId)

    const safeEntityId = entityId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
    const safeBankDesc = bankDescription.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
    const customId = `recon_pattern_${safeEntityId}_${safeBankDesc}`

    const content = `Reconciliation bank pattern (confirmed match):
Entity: "${entityName}"
Entity ID: ${entityId}
Bank Description Pattern: "${bankDescription}"
This bank transaction description reliably maps to entity "${entityName}". 
Use this to normalize "${bankDescription}" → "${entityName}" in future reconciliation.`

    await sm.memories.add({
      content,
      metadata: {
        type: "reconciliation_bank_pattern",
        entity_id: entityId,
        entity_name: entityName,
        bank_description: bankDescription,
      },
      containerTags: [tag],
      // @ts-ignore — customId is supported but not in all SDK type defs
      customId,
    })

    // Invalidate memory cache for this bank description so next run fetches fresh
    const cacheKeyPrefix = `${userId}::${bankDescription.toLowerCase().slice(0, 120)}`
    memoryContextCache.delete(cacheKeyPrefix)
  } catch (err) {
    // Non-fatal: write-back failure should never block reconciliation
    console.warn(
      `[EntityValidator] Failed to write bank pattern to Supermemory:`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

export function createEntityValidationCache(): Map<string, EntityValidationResult> {
  return new Map()
}

export function clearEntityMemoryContextCache(): void {
  memoryContextCache.clear()
}
