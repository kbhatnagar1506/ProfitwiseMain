/**
 * Multi-factor confidence recalculation engine.
 *
 * Combines signals from:
 * 1. Amount match quality (exact, within tolerance, partial)
 * 2. Entity name semantic similarity (Levenshtein + token overlap)
 * 3. Date proximity (movement date vs invoice due date)
 * 4. History confidence adjustment (entity's reconciliation track record)
 * 5. Category match (economic class vs invoice category)
 * 6. Match sequence penalty (Nth match on same movement)
 *
 * The final confidence is clamped to [0.40, 0.99].
 */

import { entityNameSimilarity } from "./levenshtein"
import { getHistoryConfidenceAdjustment } from "./supermemory-decision-history"

export interface ConfidenceComponents {
  amountScore: number           // 0.0 - 1.0: how close the amounts are
  entityNameScore: number       // 0.0 - 1.0: semantic similarity of names
  dateProximityScore: number    // 0.0 - 1.0: how close the dates are
  historyScore: number          // -0.15 to +0.15: history adjustment
  categoryScore: number         // -0.10 to +0.05: category match bonus/penalty
  matchSequencePenalty: number  // 0 to -0.10: penalty for being Nth match
}

export interface ConfidenceEnvelopeV2 {
  score: number
  components: ConfidenceComponents
  reasoning: string
}

const CLAMP_MIN = 0.40
const CLAMP_MAX = 0.99

function clamp(val: number): number {
  return Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, val))
}

/**
 * Compute amount match score.
 * 1.0 = exact, 0.9 = within 1%, 0.8 = within 5%, 0.6 = partial
 */
export function computeAmountScore(
  movementAmount: number,
  targetAmount: number
): number {
  if (targetAmount <= 0) return 0
  const diff = Math.abs(movementAmount - targetAmount)
  const pct = diff / targetAmount
  if (pct < 0.001) return 1.0      // Exact
  if (pct < 0.01) return 0.97      // Within 1%
  if (pct < 0.03) return 0.92      // Within 3%
  if (pct < 0.05) return 0.88      // Within 5%
  if (pct < 0.10) return 0.80      // Within 10%
  if (pct < 0.20) return 0.65      // Within 20%
  // Partial: movement < target (some remaining)
  if (movementAmount < targetAmount) return 0.60
  return 0.40
}

/**
 * Compute date proximity score.
 * 1.0 = same day, 0.9 = within a week, 0.75 = within a month
 */
export function computeDateProximityScore(
  movementDate: string | null,
  invoiceDueDate: string | null
): number {
  if (!movementDate || !invoiceDueDate) return 0.75  // Unknown — neutral

  const mDate = new Date(movementDate).getTime()
  const iDate = new Date(invoiceDueDate).getTime()
  if (isNaN(mDate) || isNaN(iDate)) return 0.75

  const diffDays = Math.abs(mDate - iDate) / 86_400_000

  if (diffDays <= 1) return 1.0      // Same day
  if (diffDays <= 7) return 0.93     // Within a week
  if (diffDays <= 14) return 0.87    // Within two weeks
  if (diffDays <= 30) return 0.80    // Within a month
  if (diffDays <= 60) return 0.72    // Within two months
  if (diffDays <= 90) return 0.65    // Within a quarter
  return 0.50                         // Old invoice
}

/**
 * Full multi-factor confidence computation.
 */
export async function computeMultiFactorConfidence(params: {
  movementAmount: number
  targetAmount: number
  bankDescription: string
  entityName: string
  movementDate?: string | null
  invoiceDueDate?: string | null
  userId: string
  entityId: string
  categoryAdjustment?: number
  matchSequenceIndex?: number  // 0-based (0 = first match)
}): Promise<ConfidenceEnvelopeV2> {
  const {
    movementAmount,
    targetAmount,
    bankDescription,
    entityName,
    movementDate,
    invoiceDueDate,
    userId,
    entityId,
    categoryAdjustment = 0,
    matchSequenceIndex = 0,
  } = params

  // Component 1: Amount
  const amountScore = computeAmountScore(movementAmount, targetAmount)

  // Component 2: Entity name similarity
  const entityNameScore = entityNameSimilarity(bankDescription, entityName)

  // Component 3: Date proximity
  const dateProximityScore = computeDateProximityScore(movementDate ?? null, invoiceDueDate ?? null)

  // Component 4: History
  const historyScore = await getHistoryConfidenceAdjustment(userId, entityId, movementAmount)

  // Component 5: Category
  const categoryScore = categoryAdjustment

  // Component 6: Match sequence penalty
  const matchSequencePenalty = matchSequenceIndex === 0 ? 0
    : matchSequenceIndex === 1 ? -0.05
    : matchSequenceIndex === 2 ? -0.10
    : -99  // Should never reach here (blocked by Phase 3 guards)

  const components: ConfidenceComponents = {
    amountScore,
    entityNameScore,
    dateProximityScore,
    historyScore,
    categoryScore,
    matchSequencePenalty,
  }

  // Weighted combination
  // Amount: 40%, Entity: 30%, Date: 20%, History + Category + Sequence: adjustments
  const baseScore =
    0.40 * amountScore +
    0.30 * entityNameScore +
    0.20 * dateProximityScore +
    0.10  // Base confidence floor

  const adjustedScore = baseScore + historyScore + categoryScore + matchSequencePenalty
  const finalScore = clamp(adjustedScore)

  const reasoning = [
    `Amount ${(amountScore * 100).toFixed(0)}%`,
    `Entity name ${(entityNameScore * 100).toFixed(0)}%`,
    `Date proximity ${(dateProximityScore * 100).toFixed(0)}%`,
    historyScore !== 0 ? `History adj ${historyScore > 0 ? "+" : ""}${(historyScore * 100).toFixed(0)}%` : null,
    categoryScore !== 0 ? `Category adj ${categoryScore > 0 ? "+" : ""}${(categoryScore * 100).toFixed(0)}%` : null,
    matchSequencePenalty !== 0 ? `Sequence penalty ${(matchSequencePenalty * 100).toFixed(0)}%` : null,
  ]
    .filter(Boolean)
    .join(", ")

  return {
    score: finalScore,
    components,
    reasoning,
  }
}

/**
 * Convert confidence envelope to ConfidenceEnvelope (legacy format) for
 * backward compatibility with attribution-persist.ts.
 */
export function toConfidenceEnvelope(env: ConfidenceEnvelopeV2): {
  score: number
  kind: "amount_match" | "entity_match" | "semantic" | "manual"
  components: ConfidenceComponents
} {
  const kind = env.components.entityNameScore >= 0.85
    ? ("entity_match" as const)
    : env.components.amountScore >= 0.95
    ? ("amount_match" as const)
    : ("semantic" as const)
  return { score: env.score, kind, components: env.components }
}
