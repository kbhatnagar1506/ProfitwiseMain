/**
 * Entity Pattern Aggregation
 *
 * Aggregates payment patterns across related entities in clusters.
 * Enables better forecasting for low_data entities by combining with anchor patterns.
 */

import type { EntityCluster } from "./entity-clustering"
import type { ReconciledARMovement, ReconciledAPMovement } from "./reconciled-models"
import { log } from "./logger"

export type AggregatedCustomerPattern = {
  cluster_id: string
  anchor_entity_id: string
  satellite_count: number
  combined_payment_count: number
  combined_total_amount: number
  weighted_avg_amount: number
  weighted_avg_interval: number
  weighted_reliability: number
  combined_date_range_days: number
}

export type AggregatedVendorPattern = {
  cluster_id: string
  anchor_entity_id: string
  satellite_count: number
  combined_payment_count: number
  combined_total_amount: number
  weighted_avg_amount: number
  weighted_avg_interval: number
  weighted_recurrence: number
  combined_date_range_days: number
}

/**
 * Calculate weighted average for customer patterns
 */
function calculateWeightedCustomerAverage(
  movements: ReconciledARMovement[],
  weights: number[]
): {
  avg_amount: number
  avg_interval: number
  reliability: number
} {
  if (movements.length === 0) {
    return { avg_amount: 0, avg_interval: 0, reliability: 0 }
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0)
  if (totalWeight === 0) {
    return { avg_amount: 0, avg_interval: 0, reliability: 0 }
  }

  // Weighted average amount
  let weightedAmount = 0
  for (let i = 0; i < movements.length; i++) {
    weightedAmount += movements[i].amount * (weights[i] / totalWeight)
  }

  // Calculate intervals
  const sorted = [...movements].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const days = Math.round(
      (new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / 86_400_000
    )
    if (days > 0 && days < 365) intervals.push(days)
  }

  const avgInterval = intervals.length > 0
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length
    : 0

  // Reliability: consistency of amounts
  const amounts = movements.map((m) => m.amount)
  const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length
  const variance = amounts.reduce((sum, a) => sum + Math.pow(a - avgAmount, 2), 0) / amounts.length
  const stdDev = Math.sqrt(variance)
  const cv = avgAmount > 0 ? stdDev / avgAmount : 0
  const reliability = Math.max(0, 1 - cv)

  return {
    avg_amount: weightedAmount,
    avg_interval: avgInterval,
    reliability,
  }
}

/**
 * Calculate weighted average for vendor patterns
 */
function calculateWeightedVendorAverage(
  movements: ReconciledAPMovement[],
  weights: number[]
): {
  avg_amount: number
  avg_interval: number
  recurrence: number
} {
  if (movements.length === 0) {
    return { avg_amount: 0, avg_interval: 0, recurrence: 0 }
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0)
  if (totalWeight === 0) {
    return { avg_amount: 0, avg_interval: 0, recurrence: 0 }
  }

  // Weighted average amount
  let weightedAmount = 0
  for (let i = 0; i < movements.length; i++) {
    weightedAmount += movements[i].amount * (weights[i] / totalWeight)
  }

  // Calculate intervals
  const sorted = [...movements].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const days = Math.round(
      (new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / 86_400_000
    )
    if (days > 0 && days < 365) intervals.push(days)
  }

  // Recurrence: consistency of intervals
  const avgInterval = intervals.length > 0
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length
    : 0

  let intervalVariance = 0
  if (intervals.length > 1) {
    intervalVariance = intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length
  }
  const intervalStdDev = Math.sqrt(intervalVariance)
  const intervalCV = avgInterval > 0 ? intervalStdDev / avgInterval : 0

  // Amount consistency
  const amounts = movements.map((m) => m.amount)
  const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length
  const variance = amounts.reduce((sum, a) => sum + Math.pow(a - avgAmount, 2), 0) / amounts.length
  const stdDev = Math.sqrt(variance)
  const cv = avgAmount > 0 ? stdDev / avgAmount : 0

  const recurrence = Math.max(0, (1 - cv) * (1 - intervalCV))

  return {
    avg_amount: weightedAmount,
    avg_interval: avgInterval,
    recurrence,
  }
}

/**
 * Aggregate customer patterns for a cluster
 */
export function aggregateCustomerPatterns(
  cluster: EntityCluster,
  movements: Map<string, ReconciledARMovement[]>
): AggregatedCustomerPattern {
  const allEntityIds = [cluster.anchor_entity_id, ...cluster.satellite_entities]
  const clusterMovements: ReconciledARMovement[] = []
  const weights: number[] = []

  for (const entityId of allEntityIds) {
    const entityMovements = movements.get(entityId) || []
    clusterMovements.push(...entityMovements)
    weights.push(entityMovements.length)
  }

  const { avg_amount, avg_interval, reliability } = calculateWeightedCustomerAverage(
    clusterMovements,
    weights
  )

  const totalAmount = clusterMovements.reduce((sum, m) => sum + m.amount, 0)
  const dates = clusterMovements.map((m) => new Date(m.date).getTime()).sort((a, b) => a - b)
  const dateRangeDays = dates.length > 1
    ? Math.round((dates[dates.length - 1] - dates[0]) / 86_400_000)
    : 0

  return {
    cluster_id: cluster.cluster_id,
    anchor_entity_id: cluster.anchor_entity_id,
    satellite_count: cluster.satellite_entities.length,
    combined_payment_count: clusterMovements.length,
    combined_total_amount: totalAmount,
    weighted_avg_amount: avg_amount,
    weighted_avg_interval: avg_interval,
    weighted_reliability: reliability,
    combined_date_range_days: dateRangeDays,
  }
}

/**
 * Aggregate vendor patterns for a cluster
 */
export function aggregateVendorPatterns(
  cluster: EntityCluster,
  movements: Map<string, ReconciledAPMovement[]>
): AggregatedVendorPattern {
  const allEntityIds = [cluster.anchor_entity_id, ...cluster.satellite_entities]
  const clusterMovements: ReconciledAPMovement[] = []
  const weights: number[] = []

  for (const entityId of allEntityIds) {
    const entityMovements = movements.get(entityId) || []
    clusterMovements.push(...entityMovements)
    weights.push(entityMovements.length)
  }

  const { avg_amount, avg_interval, recurrence } = calculateWeightedVendorAverage(
    clusterMovements,
    weights
  )

  const totalAmount = clusterMovements.reduce((sum, m) => sum + m.amount, 0)
  const dates = clusterMovements.map((m) => new Date(m.date).getTime()).sort((a, b) => a - b)
  const dateRangeDays = dates.length > 1
    ? Math.round((dates[dates.length - 1] - dates[0]) / 86_400_000)
    : 0

  return {
    cluster_id: cluster.cluster_id,
    anchor_entity_id: cluster.anchor_entity_id,
    satellite_count: cluster.satellite_entities.length,
    combined_payment_count: clusterMovements.length,
    combined_total_amount: totalAmount,
    weighted_avg_amount: avg_amount,
    weighted_avg_interval: avg_interval,
    weighted_recurrence: recurrence,
    combined_date_range_days: dateRangeDays,
  }
}

/**
 * Aggregate all customer patterns for clusters
 */
export function aggregateAllCustomerPatterns(
  clusters: EntityCluster[],
  movements: ReconciledARMovement[]
): AggregatedCustomerPattern[] {
  const movementsByEntity = new Map<string, ReconciledARMovement[]>()

  for (const movement of movements) {
    const list = movementsByEntity.get(movement.entity_id) || []
    list.push(movement)
    movementsByEntity.set(movement.entity_id, list)
  }

  const aggregated = clusters
    .filter((c) => c.satellite_entities.length > 0)
    .map((c) => aggregateCustomerPatterns(c, movementsByEntity))

  log("pattern_aggregation.customers", {
    clusters_aggregated: aggregated.length,
    avg_satellites_per_cluster: aggregated.length > 0
      ? aggregated.reduce((sum, a) => sum + a.satellite_count, 0) / aggregated.length
      : 0,
    avg_combined_payments: aggregated.length > 0
      ? aggregated.reduce((sum, a) => sum + a.combined_payment_count, 0) / aggregated.length
      : 0,
  })

  return aggregated
}

/**
 * Aggregate all vendor patterns for clusters
 */
export function aggregateAllVendorPatterns(
  clusters: EntityCluster[],
  movements: ReconciledAPMovement[]
): AggregatedVendorPattern[] {
  const movementsByEntity = new Map<string, ReconciledAPMovement[]>()

  for (const movement of movements) {
    const list = movementsByEntity.get(movement.entity_id) || []
    list.push(movement)
    movementsByEntity.set(movement.entity_id, list)
  }

  const aggregated = clusters
    .filter((c) => c.satellite_entities.length > 0)
    .map((c) => aggregateVendorPatterns(c, movementsByEntity))

  log("pattern_aggregation.vendors", {
    clusters_aggregated: aggregated.length,
    avg_satellites_per_cluster: aggregated.length > 0
      ? aggregated.reduce((sum, a) => sum + a.satellite_count, 0) / aggregated.length
      : 0,
    avg_combined_payments: aggregated.length > 0
      ? aggregated.reduce((sum, a) => sum + a.combined_payment_count, 0) / aggregated.length
      : 0,
  })

  return aggregated
}

/**
 * Get aggregated pattern for a satellite entity
 */
export function getAggregatedPatternForSatellite(
  satelliteId: string,
  aggregatedPatterns: AggregatedCustomerPattern[] | AggregatedVendorPattern[],
  anchorMap: Map<string, string>
): (AggregatedCustomerPattern | AggregatedVendorPattern) | null {
  const anchorId = anchorMap.get(satelliteId)
  if (!anchorId) return null

  return aggregatedPatterns.find((p) => p.anchor_entity_id === anchorId) || null
}
