/**
 * Semantic Validation with Supermemory Context
 *
 * Enhanced entity name validation using:
 * 1. Levenshtein / token similarity (fast, no API calls)
 * 2. Entity profile bank description patterns (from Supermemory cache)
 * 3. Decision history confidence adjustment
 *
 * This replaces the simple `namesMatch` fuzzy check in the waterfall with
 * a multi-signal semantic validator that catches:
 * - Cross-entity contamination (Spread The Love vs High Brew)
 * - Name variations (ABC Corp vs ABC Inc)
 * - Processor aggregates vs individual invoices
 */

import { matchEntityName, areSameEntity } from "./levenshtein"
import { getEntityProfile, type EntityMemoryProfile } from "./supermemory-entity-profiles"
import { getHistoryConfidenceAdjustment } from "./supermemory-decision-history"

export interface SemanticValidationResult {
  /** Whether the bank description semantically matches the entity */
  valid: boolean
  /** Composite similarity score 0.0 - 1.0 */
  score: number
  /** Which signal produced the match/rejection */
  method: "levenshtein" | "bank_pattern" | "alias" | "history" | "rejected" | "insufficient_data"
  /** Confidence adjustment to apply (+/- 0.15 max) */
  confidenceAdjustment: number
  /** Human-readable explanation */
  reasoning: string
}

/**
 * Validate whether a bank movement description semantically matches an entity.
 *
 * @param bankDescription - Raw bank memo or counterparty name
 * @param entityId        - Internal entity UUID
 * @param entityName      - Canonical entity name (for fast path)
 * @param amount          - Movement amount (for history scoring)
 * @param userId          - User context for profile/history lookup
 */
export async function validateSemanticMatch(
  bankDescription: string,
  entityId: string,
  entityName: string,
  amount: number,
  userId: string
): Promise<SemanticValidationResult> {
  if (!bankDescription?.trim() || !entityName?.trim()) {
    return {
      valid: true,  // Insufficient data — don't block, let other signals decide
      score: 0.5,
      method: "insufficient_data",
      confidenceAdjustment: 0,
      reasoning: "Insufficient bank description or entity name for semantic validation",
    }
  }

  const threshold = 0.80

  // ─── 1. Fast path: direct Levenshtein + token similarity ─────────────────
  const nameMatch = matchEntityName(bankDescription, entityName, [], threshold)
  if (nameMatch.match) {
    // Found a good match — get history adjustment
    const histAdj = await getHistoryConfidenceAdjustment(userId, entityId, amount)
    return {
      valid: true,
      score: nameMatch.score,
      method: "levenshtein",
      confidenceAdjustment: histAdj,
      reasoning: `Name similarity ${(nameMatch.score * 100).toFixed(0)}% via ${nameMatch.method}`,
    }
  }

  // ─── 2. Check entity profile (aliases + bank description patterns) ────────
  let profile: EntityMemoryProfile | null = null
  try {
    profile = await getEntityProfile(userId, entityId)
  } catch {
    // Fall through
  }

  if (profile) {
    // Check aliases
    const aliasMatch = matchEntityName(bankDescription, entityName, profile.aliases, threshold)
    if (aliasMatch.match && aliasMatch.method === "alias") {
      const histAdj = await getHistoryConfidenceAdjustment(userId, entityId, amount)
      return {
        valid: true,
        score: aliasMatch.score,
        method: "alias",
        confidenceAdjustment: histAdj,
        reasoning: `Matched via alias "${bankDescription}" ~ ${profile.entity_name}`,
      }
    }

    // Check bank description patterns from history
    for (const pattern of profile.bank_description_patterns) {
      if (areSameEntity(bankDescription, pattern, 0.75)) {
        const histAdj = await getHistoryConfidenceAdjustment(userId, entityId, amount)
        return {
          valid: true,
          score: 0.87,
          method: "bank_pattern",
          confidenceAdjustment: histAdj,
          reasoning: `Matched via historical bank pattern "${pattern}"`,
        }
      }
    }

    // ─── 3. History-based: if high success rate for this entity, soften rejection
    const histAdj = await getHistoryConfidenceAdjustment(userId, entityId, amount)
    if (histAdj > 0 && nameMatch.score >= 0.6) {
      // Somewhat similar name + good history — allow but with a small boost
      return {
        valid: true,
        score: nameMatch.score,
        method: "history",
        confidenceAdjustment: histAdj - 0.05,  // Slightly less boost since name didn't fully match
        reasoning: `Allowed by history (score ${(nameMatch.score * 100).toFixed(0)}%, history adj +${histAdj.toFixed(2)})`,
      }
    }
  }

  // ─── 4. Hard rejection: name too dissimilar, no alias/pattern match ───────
  return {
    valid: false,
    score: nameMatch.score,
    method: "rejected",
    confidenceAdjustment: -0.15,
    reasoning: `Entity name mismatch: "${bankDescription}" vs "${entityName}" (score ${(nameMatch.score * 100).toFixed(0)}%)`,
  }
}

/**
 * Batch validate multiple (bankDescription, entityName) pairs for efficiency.
 */
export async function batchValidateSemanticMatches(
  pairs: Array<{
    bankDescription: string
    entityId: string
    entityName: string
    amount: number
    userId: string
  }>
): Promise<SemanticValidationResult[]> {
  return Promise.all(pairs.map((p) =>
    validateSemanticMatch(p.bankDescription, p.entityId, p.entityName, p.amount, p.userId)
  ))
}

/**
 * Simple token count estimate for LLM context pruning.
 * Rule of thumb: 1 token ≈ 4 characters.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Build Supermemory context for LLM prompt within token limit.
 * Prunes oldest decisions if context would exceed maxTokens.
 */
export function buildSupermemoryContext(
  entityName: string,
  profile: EntityMemoryProfile | null,
  recentPatterns: string[],
  maxTokens = 100_000
): string {
  const parts: string[] = []
  let tokenCount = 0

  if (profile) {
    const profileBlock = `Entity Profile: ${profile.entity_name}
Aliases: ${profile.aliases.slice(0, 5).join(", ") || "none"}
Avg Payment: $${profile.avg_payment_amount.toFixed(2)}
Payment Range: $${profile.payment_amount_range[0].toFixed(2)} - $${profile.payment_amount_range[1].toFixed(2)}
Bank Patterns: ${profile.bank_description_patterns.slice(0, 5).join("; ") || "none"}
Total Matches: ${profile.total_matched_movements}`

    const profileTokens = estimateTokens(profileBlock)
    if (tokenCount + profileTokens < maxTokens) {
      parts.push(profileBlock)
      tokenCount += profileTokens
    }
  }

  for (const pattern of recentPatterns) {
    const patternBlock = `Recent Pattern: ${pattern}`
    const patternTokens = estimateTokens(patternBlock)
    if (tokenCount + patternTokens < maxTokens) {
      parts.push(patternBlock)
      tokenCount += patternTokens
    } else {
      break  // Context window full
    }
  }

  return parts.join("\n\n")
}

/** Imported for convenience from levenshtein.ts */
export { matchEntityName, areSameEntity } from "./levenshtein"
