/**
 * Component-based confidence scoring for reconciliation attributions.
 *
 * Extends the existing ConfidenceEnvelope with a richer breakdown that shows
 * exactly WHY a match has a particular confidence score.
 *
 * Each component has:
 * - score: 0.0 - 1.0 (normalized contribution)
 * - weight: how much this component contributes to the final score
 * - reasoning: human-readable explanation
 *
 * The confidence_detail JSONB stored on movement_attributions uses this format.
 */

import { computeAmountScore, computeDateProximityScore } from "./confidence-recalculation"
import { entityNameSimilarity } from "./levenshtein"
import { getHistoryConfidenceAdjustment } from "./supermemory-decision-history"

export interface ConfidenceComponent {
  score: number
  weight: number
  reasoning: string
}

export interface ConfidenceBreakdown {
  /** Overall confidence score 0.0 - 1.0 */
  score: number
  /** Human-readable summary */
  summary: string
  /** Per-signal breakdown */
  components: {
    amount: ConfidenceComponent
    entity_name: ConfidenceComponent
    date_proximity: ConfidenceComponent
    history: ConfidenceComponent
    category: ConfidenceComponent
    match_sequence: ConfidenceComponent
  }
  /** Waterfall stage that produced this match */
  waterfall_stage?: string
  /** Match method */
  match_method?: string
}

const WEIGHTS = {
  amount: 0.40,
  entity_name: 0.30,
  date_proximity: 0.20,
  history: 0.05,
  category: 0.03,
  match_sequence: 0.02,
}

/** Standard confidence level labels */
export function confidenceLabel(score: number): "high" | "medium" | "low" | "very_low" {
  if (score >= 0.88) return "high"
  if (score >= 0.75) return "medium"
  if (score >= 0.60) return "low"
  return "very_low"
}

/**
 * Build a full confidence breakdown for a reconciliation match.
 *
 * This is the primary function — called when creating attributions that need
 * detailed confidence explanations (mainly Stage 3 FIFO + LLM Stage 4).
 */
export async function buildConfidenceBreakdown(params: {
  movementAmount: number
  targetAmount: number
  bankDescription: string
  entityName: string
  movementDate?: string | null
  invoiceDueDate?: string | null
  userId: string
  entityId: string
  categoryAdjustment?: number
  matchSequenceIndex?: number
  waterfallStage?: string
  matchMethod?: string
}): Promise<ConfidenceBreakdown> {
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
    waterfallStage,
    matchMethod,
  } = params

  // Amount component
  const amountScore = computeAmountScore(movementAmount, targetAmount)
  const amountPct = Math.abs(movementAmount - targetAmount) / Math.max(targetAmount, 0.01) * 100

  // Entity name component
  const entityScore = entityNameSimilarity(bankDescription, entityName)

  // Date proximity component
  const dateScore = computeDateProximityScore(movementDate ?? null, invoiceDueDate ?? null)

  // History component
  const historyAdj = await getHistoryConfidenceAdjustment(userId, entityId, movementAmount)
  const historyScore = 0.5 + historyAdj  // Normalize to 0.5 baseline, +/- 0.15

  // Category component
  const categoryScore = 0.5 + categoryAdjustment  // Normalize: 0 adj → 0.5

  // Match sequence component
  const sequenceScore = matchSequenceIndex === 0 ? 1.0
    : matchSequenceIndex === 1 ? 0.8
    : 0.6

  // Weighted total
  const total =
    WEIGHTS.amount * amountScore +
    WEIGHTS.entity_name * entityScore +
    WEIGHTS.date_proximity * dateScore +
    (WEIGHTS.history + WEIGHTS.category + WEIGHTS.match_sequence) * 0.5  // Adjustment signals contribute smaller share

  const adjustedTotal = total + historyAdj + categoryAdjustment + (matchSequenceIndex === 0 ? 0 : -0.05 * matchSequenceIndex)
  const finalScore = Math.min(0.99, Math.max(0.40, adjustedTotal))

  const components = {
    amount: {
      score: amountScore,
      weight: WEIGHTS.amount,
      reasoning: amountPct < 1
        ? "Exact amount match"
        : amountPct < 5
        ? `Amount within ${amountPct.toFixed(1)}% (likely processor fee)`
        : amountPct < 20
        ? `Amount ${amountPct.toFixed(1)}% off target`
        : "Partial amount match",
    },
    entity_name: {
      score: entityScore,
      weight: WEIGHTS.entity_name,
      reasoning: entityScore >= 0.90
        ? `Strong name match (${(entityScore * 100).toFixed(0)}%)`
        : entityScore >= 0.75
        ? `Good name match (${(entityScore * 100).toFixed(0)}%)`
        : entityScore >= 0.60
        ? `Moderate name similarity (${(entityScore * 100).toFixed(0)}%)`
        : `Weak name match (${(entityScore * 100).toFixed(0)}%) — verify manually`,
    },
    date_proximity: {
      score: dateScore,
      weight: WEIGHTS.date_proximity,
      reasoning: movementDate && invoiceDueDate
        ? `Date proximity score ${(dateScore * 100).toFixed(0)}%`
        : "Date not available for scoring",
    },
    history: {
      score: historyScore,
      weight: WEIGHTS.history,
      reasoning: historyAdj > 0
        ? `Historical success rate boost (+${(historyAdj * 100).toFixed(0)}%)`
        : historyAdj < 0
        ? `Historical rejection penalty (${(historyAdj * 100).toFixed(0)}%)`
        : "No historical adjustment",
    },
    category: {
      score: categoryScore,
      weight: WEIGHTS.category,
      reasoning: categoryAdjustment > 0
        ? "Category match — same economic class"
        : categoryAdjustment < 0
        ? "Category mismatch — different economic class"
        : "Category not factored",
    },
    match_sequence: {
      score: sequenceScore,
      weight: WEIGHTS.match_sequence,
      reasoning: matchSequenceIndex === 0
        ? "First match on this movement"
        : `Match #${matchSequenceIndex + 1} on this movement (penalty applied)`,
    },
  }

  const label = confidenceLabel(finalScore)
  const summary = `${label.toUpperCase()} confidence (${(finalScore * 100).toFixed(0)}%): ${matchMethod ?? waterfallStage ?? "waterfall"}`

  return {
    score: finalScore,
    summary,
    components,
    waterfall_stage: waterfallStage,
    match_method: matchMethod,
  }
}

/**
 * Synchronous confidence breakdown — skips async Supermemory history call.
 * Used in the hot-path reconciliation waterfall (Stage 3 FIFO) where awaiting
 * remote calls would cause too much latency. History signal is omitted.
 */
export function buildSyncConfidenceBreakdown(params: {
  movementAmount: number
  targetAmount: number
  bankDescription: string
  entityName: string
  movementDate?: string | null
  invoiceDueDate?: string | null
  categoryAdjustment?: number
  matchSequenceIndex?: number
  waterfallStage?: string
  matchMethod?: string
}): ConfidenceBreakdown {
  const {
    movementAmount,
    targetAmount,
    bankDescription,
    entityName,
    movementDate,
    invoiceDueDate,
    categoryAdjustment = 0,
    matchSequenceIndex = 0,
    waterfallStage,
    matchMethod,
  } = params

  const amountScore = computeAmountScore(movementAmount, targetAmount)
  const amountPct = Math.abs(movementAmount - targetAmount) / Math.max(targetAmount, 0.01) * 100
  const entityScore = entityNameSimilarity(bankDescription, entityName)
  const dateScore = computeDateProximityScore(movementDate ?? null, invoiceDueDate ?? null)
  const categoryScore = 0.5 + categoryAdjustment
  const sequenceScore = matchSequenceIndex === 0 ? 1.0 : matchSequenceIndex === 1 ? 0.8 : 0.6

  const total =
    WEIGHTS.amount * amountScore +
    WEIGHTS.entity_name * entityScore +
    WEIGHTS.date_proximity * dateScore +
    WEIGHTS.category * categoryScore +
    WEIGHTS.match_sequence * sequenceScore +
    WEIGHTS.history * 0.5  // Neutral history (no data)

  const finalScore = Math.min(0.99, Math.max(0.40, total))
  const label = confidenceLabel(finalScore)
  const summary = `${label.toUpperCase()} confidence (${(finalScore * 100).toFixed(0)}%): ${matchMethod ?? waterfallStage ?? "waterfall"}`

  return {
    score: finalScore,
    summary,
    components: {
      amount: {
        score: amountScore,
        weight: WEIGHTS.amount,
        reasoning: amountPct < 1
          ? "Exact amount match"
          : amountPct < 5
          ? `Amount within ${amountPct.toFixed(1)}% (likely processor fee)`
          : `Amount ${amountPct.toFixed(1)}% off target`,
      },
      entity_name: {
        score: entityScore,
        weight: WEIGHTS.entity_name,
        reasoning: entityScore >= 0.90
          ? `Strong name match (${(entityScore * 100).toFixed(0)}%)`
          : entityScore >= 0.75
          ? `Good name match (${(entityScore * 100).toFixed(0)}%)`
          : `Moderate name similarity (${(entityScore * 100).toFixed(0)}%)`,
      },
      date_proximity: {
        score: dateScore,
        weight: WEIGHTS.date_proximity,
        reasoning: movementDate && invoiceDueDate
          ? `Date proximity score ${(dateScore * 100).toFixed(0)}%`
          : "Date not available for scoring",
      },
      history: {
        score: 0.5,
        weight: WEIGHTS.history,
        reasoning: "History not evaluated in sync path",
      },
      category: {
        score: categoryScore,
        weight: WEIGHTS.category,
        reasoning: categoryAdjustment > 0
          ? "Category match — same economic class"
          : categoryAdjustment < 0
          ? "Category mismatch — different economic class"
          : "Category not factored",
      },
      match_sequence: {
        score: sequenceScore,
        weight: WEIGHTS.match_sequence,
        reasoning: matchSequenceIndex === 0
          ? "First match on this movement"
          : `Match #${matchSequenceIndex + 1} on this movement (penalty applied)`,
      },
    },
    waterfall_stage: waterfallStage,
    match_method: matchMethod,
  }
}

/**
 * Convert ConfidenceBreakdown to the legacy ConfidenceEnvelope format
 * for storage in confidence_detail JSONB.
 */
export function breakdownToEnvelope(breakdown: ConfidenceBreakdown): {
  score: number
  kind: string
  components: {
    amount?: number
    date?: number
    entity?: number
    history?: number
    category?: number
    match_sequence?: number
    breakdown?: ConfidenceBreakdown
  }
} {
  return {
    score: breakdown.score,
    kind: "probabilistic",
    components: {
      amount: breakdown.components.amount.score,
      date: breakdown.components.date_proximity.score,
      entity: breakdown.components.entity_name.score,
      history: breakdown.components.history.score,
      category: breakdown.components.category.score,
      match_sequence: breakdown.components.match_sequence.score,
      breakdown,
    },
  }
}
