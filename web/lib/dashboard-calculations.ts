/**
 * Dashboard Calculations Utility Library
 * Provides helper functions for computing peer statistics, percentiles, and recommendations
 */

export interface EntityMetrics {
  id: string
  archetype: string
  reliability_score: number
  risk_score: number
  avg_days_to_pay: number
  transactions_per_month: number
  on_time_payment_rate: number
  early_payment_rate: number
  amount_trend: "increasing" | "decreasing" | "stable"
  risk_factors: string[]
  transaction_count: number
  avg_interval_days: number
  interval_cv: number
}

/**
 * Calculate percentile ranking for a value within a dataset
 * Handles null values, empty arrays, and division by zero
 */
export function calculatePercentile(value: number | null, values: (number | null)[]): number {
  // Handle null value
  if (value === null || value === undefined) return 50
  
  // Filter out null values
  const validValues = values.filter((v) => v !== null && v !== undefined) as number[]
  
  // Handle empty array
  if (validValues.length === 0) return 50
  
  // Sort and find percentile
  const sorted = [...validValues].sort((a, b) => a - b)
  const index = sorted.findIndex((v) => v >= value)
  
  // If value is greater than all values, return 100
  if (index === -1) return 100
  
  // Calculate percentile (avoid division by zero)
  return (index / Math.max(1, sorted.length)) * 100
}

/**
 * Generate priority-based recommendations for an entity
 */
export function generatePriorityRecommendations(entity: EntityMetrics) {
  const recommendations: Array<{
    priority: "critical" | "high" | "medium" | "low"
    title: string
    description: string
    action?: string
    impact?: string
  }> = []

  // Critical: High overdue risk
  if (entity.risk_score >= 70) {
    recommendations.push({
      priority: "critical",
      title: "High Risk Alert",
      description: "This entity shows critical payment risk indicators.",
      action: "Require upfront deposits or shorter payment terms",
      impact: "Could affect cash flow by significant amount",
    })
  }

  // High: Payment slowing
  if (entity.avg_days_to_pay > 45 && entity.on_time_payment_rate < 70) {
    recommendations.push({
      priority: "high",
      title: "Payment Slowing",
      description: "Recent payments are taking longer than historical average.",
      action: "Follow up to understand the cause",
      impact: "May delay cash flow by 2-3 weeks",
    })
  }

  // High: Frequency dropping
  if (entity.transactions_per_month < 0.5 && entity.transaction_count > 5) {
    recommendations.push({
      priority: "high",
      title: "Frequency Dropping",
      description: "Transaction frequency has declined significantly.",
      action: "Reach out to understand business changes",
      impact: "May indicate relationship deterioration",
    })
  }

  // Medium: Unpredictable payments
  if (entity.interval_cv > 100) {
    recommendations.push({
      priority: "medium",
      title: "Unpredictable Timing",
      description: "Payment timing is highly variable and unpredictable.",
      action: "Consider automated payment reminders",
      impact: "Makes cash flow forecasting difficult",
    })
  }

  // Medium: Declining amounts
  if (entity.amount_trend === "decreasing") {
    recommendations.push({
      priority: "medium",
      title: "Declining Activity",
      description: "Transaction amounts are trending downward.",
      action: "Investigate business relationship health",
      impact: "May indicate reduced business volume",
    })
  }

  // Low: Early payer opportunity
  if (entity.early_payment_rate > 30 && entity.avg_days_to_pay < -20) {
    recommendations.push({
      priority: "low",
      title: "Early Payer Opportunity",
      description: "This entity frequently pays early.",
      action: "Consider offering early payment discounts",
      impact: "Could improve cash flow by 2-3 weeks",
    })
  }

  // Low: Growing customer
  if (entity.amount_trend === "increasing" && entity.transactions_per_month >= 5) {
    recommendations.push({
      priority: "low",
      title: "Growing Opportunity",
      description: "Transaction amounts and frequency are increasing.",
      action: "Nurture this growth opportunity",
      impact: "Potential for increased revenue",
    })
  }

  return recommendations
}

/**
 * Calculate data quality score for an entity
 */
export function calculateDataQuality(entity: EntityMetrics): {
  score: number
  level: "Low" | "Medium" | "High"
  components: {
    transactionCount: number
    dataSpan: number
    dueDateCoverage: number
    consistency: number
  }
} {
  const components = {
    transactionCount: Math.min(entity.transaction_count / 50, 1),
    dataSpan: Math.min(entity.avg_interval_days * entity.transaction_count / 365, 1),
    dueDateCoverage: entity.on_time_payment_rate > 0 ? 1 : 0,
    consistency: Math.max(0, 1 - entity.interval_cv / 100),
  }

  const score =
    (components.transactionCount * 0.3 +
      components.dataSpan * 0.3 +
      components.dueDateCoverage * 0.2 +
      components.consistency * 0.2) *
    100

  const level = score >= 70 ? "High" : score >= 40 ? "Medium" : "Low"

  return { score, level, components }
}

/**
 * Calculate trend velocity (acceleration/deceleration)
 */
export function calculateTrendVelocity(
  currentTrend: "increasing" | "decreasing" | "stable",
  previousTrend: "increasing" | "decreasing" | "stable"
): "accelerating" | "decelerating" | "stable" {
  // Rank the trends on a single axis so the comparison has a direction.
  // Previously both the "moved to increasing" and "moved to decreasing"
  // branches returned "accelerating", so a swing from increasing to decreasing
  // was reported as acceleration.
  const rank = { decreasing: -1, stable: 0, increasing: 1 } as const

  const delta = rank[currentTrend] - rank[previousTrend]
  if (delta === 0) return "stable"
  return delta > 0 ? "accelerating" : "decelerating"
}

/**
 * Group entities by archetype and calculate peer statistics
 */
export function calculatePeerStatistics(entities: EntityMetrics[]) {
  const byArchetype: Record<string, EntityMetrics[]> = {}

  for (const entity of entities) {
    if (!byArchetype[entity.archetype]) {
      byArchetype[entity.archetype] = []
    }
    byArchetype[entity.archetype].push(entity)
  }

  const stats: Record<
    string,
    {
      count: number
      avgReliability: number
      avgRisk: number
      avgDaysToPay: number
      avgFrequency: number
    }
  > = {}

  for (const [archetype, peers] of Object.entries(byArchetype)) {
    stats[archetype] = {
      count: peers.length,
      avgReliability: peers.reduce((sum, p) => sum + p.reliability_score, 0) / peers.length,
      avgRisk: peers.reduce((sum, p) => sum + p.risk_score, 0) / peers.length,
      avgDaysToPay: peers.reduce((sum, p) => sum + p.avg_days_to_pay, 0) / peers.length,
      avgFrequency: peers.reduce((sum, p) => sum + p.transactions_per_month, 0) / peers.length,
    }
  }

  return stats
}
