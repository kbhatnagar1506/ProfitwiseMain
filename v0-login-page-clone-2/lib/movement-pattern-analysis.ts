/**
 * Movement Pattern Analysis
 * 
 * Analyzes actual bank movements to extract behavioral patterns
 * This is the ground truth for forecasting - not AP/AR records
 */

import { log } from "./logger"

export interface MovementPattern {
  entity_id: string
  entity_name: string
  direction: "inflow" | "outflow"
  
  // Basic stats
  payment_count: number
  first_payment_date: string
  last_payment_date: string
  days_of_history: number
  
  // Amount analysis
  avg_amount: number
  min_amount: number
  max_amount: number
  std_dev_amount: number
  
  // Frequency analysis
  avg_days_between_payments: number
  min_days_between_payments: number
  max_days_between_payments: number
  std_dev_days: number
  
  // Recurrence confidence
  recurrence_confidence: number // 0-1, based on consistency
  recurrence_type: "clockwork" | "recurring" | "episodic" | "bursty"
  
  // Pattern strength
  pattern_strength: number // 0-1, how predictable is this entity?
  
  // Metadata
  last_payment_days_ago: number
  is_active: boolean // Had payment in last 90 days?
}

export interface EntityMovementGroup {
  entity_id: string
  entity_name: string
  inflows: Array<{ date: string; amount: number }>
  outflows: Array<{ date: string; amount: number }>
}

/**
 * Group movements by entity
 */
export function groupMovementsByEntity(
  movements: Array<{ entity_id: string; entity_name: string; direction: "inflow" | "outflow"; amount: number; occurred_at: string }>
): Map<string, EntityMovementGroup> {
  const groups = new Map<string, EntityMovementGroup>()

  for (const movement of movements) {
    if (!groups.has(movement.entity_id)) {
      groups.set(movement.entity_id, {
        entity_id: movement.entity_id,
        entity_name: movement.entity_name,
        inflows: [],
        outflows: [],
      })
    }

    const group = groups.get(movement.entity_id)!
    const date = movement.occurred_at.split("T")[0]

    if (movement.direction === "inflow") {
      group.inflows.push({ date, amount: movement.amount })
    } else {
      group.outflows.push({ date, amount: movement.amount })
    }
  }

  return groups
}

/**
 * Analyze a single direction's payment pattern
 */
function analyzePaymentPattern(
  payments: Array<{ date: string; amount: number }>,
  entityName: string,
  direction: "inflow" | "outflow"
): MovementPattern | null {
  if (payments.length === 0) {
    return null
  }

  // Sort by date
  const sorted = [...payments].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  // Calculate amount stats
  const amounts = sorted.map((p) => p.amount)
  const avg_amount = amounts.reduce((a, b) => a + b, 0) / amounts.length
  const min_amount = Math.min(...amounts)
  const max_amount = Math.max(...amounts)
  const variance = amounts.reduce((sum, amt) => sum + Math.pow(amt - avg_amount, 2), 0) / amounts.length
  const std_dev_amount = Math.sqrt(variance)

  // Calculate frequency stats
  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1].date).getTime()
    const curr = new Date(sorted[i].date).getTime()
    const days = (curr - prev) / (1000 * 60 * 60 * 24)
    intervals.push(days)
  }

  const avg_days_between_payments = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0
  const min_days_between_payments = intervals.length > 0 ? Math.min(...intervals) : 0
  const max_days_between_payments = intervals.length > 0 ? Math.max(...intervals) : 0
  const freq_variance = intervals.length > 0 ? intervals.reduce((sum, d) => sum + Math.pow(d - avg_days_between_payments, 2), 0) / intervals.length : 0
  const std_dev_days = Math.sqrt(freq_variance)

  // Calculate recurrence confidence
  // High confidence if: consistent intervals, consistent amounts, regular pattern
  let recurrence_confidence = 0

  if (intervals.length >= 2) {
    // Coefficient of variation for intervals (lower = more consistent)
    const cv_intervals = avg_days_between_payments > 0 ? std_dev_days / avg_days_between_payments : 1
    const interval_consistency = Math.max(0, 1 - cv_intervals) // 0-1, higher is more consistent

    // Coefficient of variation for amounts
    const cv_amounts = avg_amount > 0 ? std_dev_amount / avg_amount : 1
    const amount_consistency = Math.max(0, 1 - cv_amounts) // 0-1, higher is more consistent

    // Weight: intervals are more important for recurrence
    recurrence_confidence = interval_consistency * 0.7 + amount_consistency * 0.3
  }

  // Determine recurrence type
  let recurrence_type: "clockwork" | "recurring" | "episodic" | "bursty"
  if (recurrence_confidence > 0.8 && std_dev_days < avg_days_between_payments * 0.2) {
    recurrence_type = "clockwork" // Very regular, tight variance
  } else if (recurrence_confidence > 0.5) {
    recurrence_type = "recurring" // Regular but with some variance
  } else if (intervals.length <= 2) {
    recurrence_type = "episodic" // Not enough data to establish pattern
  } else {
    recurrence_type = "bursty" // Irregular, clustered payments
  }

  // Pattern strength: how predictable is this entity?
  const pattern_strength = recurrence_confidence * (Math.min(payments.length, 20) / 20) // More payments = more confidence

  // Days since last payment
  const today = new Date()
  const lastPaymentDate = new Date(sorted[sorted.length - 1].date)
  const last_payment_days_ago = Math.floor((today.getTime() - lastPaymentDate.getTime()) / (1000 * 60 * 60 * 24))

  // Is active? (payment in last 90 days)
  const is_active = last_payment_days_ago <= 90

  // Days of history
  const firstDate = new Date(sorted[0].date)
  const days_of_history = Math.floor((today.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24))

  return {
    entity_id: "", // Will be set by caller
    entity_name: entityName,
    direction,
    payment_count: payments.length,
    first_payment_date: sorted[0].date,
    last_payment_date: sorted[sorted.length - 1].date,
    days_of_history,
    avg_amount,
    min_amount,
    max_amount,
    std_dev_amount,
    avg_days_between_payments,
    min_days_between_payments,
    max_days_between_payments,
    std_dev_days,
    recurrence_confidence,
    recurrence_type,
    pattern_strength,
    last_payment_days_ago,
    is_active,
  }
}

/**
 * Analyze all movement patterns for an entity
 */
export function analyzeEntityPatterns(
  entityId: string,
  entityName: string,
  group: EntityMovementGroup
): { inflow?: MovementPattern; outflow?: MovementPattern } {
  const result: { inflow?: MovementPattern; outflow?: MovementPattern } = {}

  if (group.inflows.length > 0) {
    const pattern = analyzePaymentPattern(group.inflows, entityName, "inflow")
    if (pattern) {
      pattern.entity_id = entityId
      result.inflow = pattern
    }
  }

  if (group.outflows.length > 0) {
    const pattern = analyzePaymentPattern(group.outflows, entityName, "outflow")
    if (pattern) {
      pattern.entity_id = entityId
      result.outflow = pattern
    }
  }

  return result
}

/**
 * Analyze all movements and return patterns
 */
export function analyzeAllMovementPatterns(
  movements: Array<{ entity_id: string; entity_name: string; direction: "inflow" | "outflow"; amount: number; occurred_at: string }>
): Map<string, { inflow?: MovementPattern; outflow?: MovementPattern }> {
  const groups = groupMovementsByEntity(movements)
  const patterns = new Map<string, { inflow?: MovementPattern; outflow?: MovementPattern }>()

  for (const [entityId, group] of groups) {
    const entityPatterns = analyzeEntityPatterns(entityId, group.entity_name, group)
    patterns.set(entityId, entityPatterns)
  }

  log("movement_pattern_analysis.complete", {
    total_entities: patterns.size,
    entities_with_inflows: Array.from(patterns.values()).filter((p) => p.inflow).length,
    entities_with_outflows: Array.from(patterns.values()).filter((p) => p.outflow).length,
  })

  return patterns
}

/**
 * Get high-confidence patterns (for backtest validation)
 */
export function getHighConfidencePatterns(
  patterns: Map<string, { inflow?: MovementPattern; outflow?: MovementPattern }>,
  minConfidence: number = 0.6,
  minPayments: number = 5
): MovementPattern[] {
  const highConfidence: MovementPattern[] = []

  for (const entityPatterns of patterns.values()) {
    if (entityPatterns.inflow && entityPatterns.inflow.recurrence_confidence >= minConfidence && entityPatterns.inflow.payment_count >= minPayments) {
      highConfidence.push(entityPatterns.inflow)
    }
    if (entityPatterns.outflow && entityPatterns.outflow.recurrence_confidence >= minConfidence && entityPatterns.outflow.payment_count >= minPayments) {
      highConfidence.push(entityPatterns.outflow)
    }
  }

  return highConfidence
}
