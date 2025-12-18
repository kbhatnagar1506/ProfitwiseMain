/**
 * Comprehensive Confidence Boost Engine
 * 
 * Systematically improves forecast confidence across all components:
 * 1. Backtest accuracy - Implement validation framework
 * 2. Inflow/Outflow models - Enhance customer/vendor predictions
 * 3. Entity relationships - Leverage graph data
 * 4. Data span - Track historical patterns
 * 5. Recurrence quality - Improve pattern detection
 */

import { log } from "./logger"
import type { CustomerModel, VendorModel, BehavioralModels } from "./state/types"

export interface ConfidenceBoostResult {
  backtest_accuracy_boost: number
  inflow_model_boost: number
  outflow_model_boost: number
  entity_relationships_boost: number
  recurrence_quality_boost: number
  data_span_boost: number
  total_confidence_improvement: number
  improvements_applied: string[]
}

/**
 * 1. BACKTEST ACCURACY BOOST
 * Implement validation framework to measure forecast accuracy
 */
export function boostBacktestAccuracy(
  customers: CustomerModel[],
  vendors: VendorModel[],
  historicalMovements: Array<{ date: string; amount: number; entity_id: string; type: "inflow" | "outflow" }>
): { boost: number; reasoning: string } {
  if (historicalMovements.length === 0) {
    return { boost: 0, reasoning: "No historical movements for backtest" }
  }

  // Calculate prediction accuracy on historical data
  const predictions = new Map<string, { predicted: number; actual: number }>()
  
  // Group movements by entity
  const movementsByEntity = new Map<string, typeof historicalMovements>()
  for (const m of historicalMovements) {
    if (!movementsByEntity.has(m.entity_id)) {
      movementsByEntity.set(m.entity_id, [])
    }
    movementsByEntity.get(m.entity_id)!.push(m)
  }

  let accurateCount = 0
  let totalCount = 0

  // Validate customer predictions
  for (const customer of customers) {
    const movements = movementsByEntity.get(customer.entity_id) || []
    if (movements.length < 2) continue

    const inflowMovements = movements.filter(m => m.type === "inflow")
    if (inflowMovements.length === 0) continue

    // Calculate average interval and amount
    const intervals: number[] = []
    for (let i = 1; i < inflowMovements.length; i++) {
      const prev = new Date(inflowMovements[i - 1].date).getTime()
      const curr = new Date(inflowMovements[i].date).getTime()
      intervals.push((curr - prev) / (1000 * 60 * 60 * 24)) // days
    }

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length
    const avgAmount = inflowMovements.reduce((a, b) => a + b.amount, 0) / inflowMovements.length

    // Check if model predictions are close to actual
    if (
      Math.abs(customer.avg_days_to_payment - avgInterval) < avgInterval * 0.3 &&
      Math.abs(customer.avg_amount - avgAmount) < avgAmount * 0.3
    ) {
      accurateCount++
    }
    totalCount++
  }

  // Validate vendor predictions
  for (const vendor of vendors) {
    const movements = movementsByEntity.get(vendor.entity_id) || []
    if (movements.length < 2) continue

    const outflowMovements = movements.filter(m => m.type === "outflow")
    if (outflowMovements.length === 0) continue

    const intervals: number[] = []
    for (let i = 1; i < outflowMovements.length; i++) {
      const prev = new Date(outflowMovements[i - 1].date).getTime()
      const curr = new Date(outflowMovements[i].date).getTime()
      intervals.push((curr - prev) / (1000 * 60 * 60 * 24))
    }

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length
    const avgAmount = outflowMovements.reduce((a, b) => a + b.amount, 0) / outflowMovements.length

    if (
      Math.abs(vendor.avg_days_to_payment - avgInterval) < avgInterval * 0.3 &&
      Math.abs(vendor.avg_amount - avgAmount) < avgAmount * 0.3
    ) {
      accurateCount++
    }
    totalCount++
  }

  const accuracy = totalCount > 0 ? accurateCount / totalCount : 0
  const boost = Math.min(accuracy * 0.4, 0.25) // Cap at 25% boost

  log("confidence_boost.backtest_accuracy", {
    accuracy,
    boost,
    accurate_count: accurateCount,
    total_count: totalCount,
  })

  return {
    boost,
    reasoning: `Backtest validation: ${(accuracy * 100).toFixed(1)}% of models accurate on historical data`,
  }
}

/**
 * 2. INFLOW/OUTFLOW MODEL BOOST
 * Enhance predictions using data quality and pattern strength
 */
export function boostInflowOutflowModels(
  customers: CustomerModel[],
  vendors: VendorModel[]
): { inflow_boost: number; outflow_boost: number; reasoning: string } {
  let totalCustomerBoost = 0
  let customerCount = 0

  // Boost inflow models based on data quality
  for (const customer of customers) {
    let boost = 0

    // Bonus for high payment count (more data = more confidence)
    if (customer.payment_count >= 10) boost += 0.15
    else if (customer.payment_count >= 5) boost += 0.10
    else if (customer.payment_count >= 3) boost += 0.05

    // Bonus for low variance (predictable)
    if (customer.archetype === "clockwork") boost += 0.20
    else if (customer.archetype === "recurring") boost += 0.10

    // Bonus for recent activity
    const lastPaymentDays = customer.last_payment_days || 999
    if (lastPaymentDays <= 7) boost += 0.10
    else if (lastPaymentDays <= 30) boost += 0.05

    customer._inflow_model_boost = Math.min(boost, 0.35)
    totalCustomerBoost += customer._inflow_model_boost
    customerCount++
  }

  let totalVendorBoost = 0
  let vendorCount = 0

  // Boost outflow models based on data quality
  for (const vendor of vendors) {
    let boost = 0

    // Bonus for high payment count
    if (vendor.payment_count >= 10) boost += 0.15
    else if (vendor.payment_count >= 5) boost += 0.10
    else if (vendor.payment_count >= 3) boost += 0.05

    // Bonus for predictable patterns
    if (vendor.archetype === "hard") boost += 0.20
    else if (vendor.archetype === "recurring") boost += 0.10

    // Bonus for recent activity
    const lastPaymentDays = vendor.last_payment_days || 999
    if (lastPaymentDays <= 7) boost += 0.10
    else if (lastPaymentDays <= 30) boost += 0.05

    vendor._outflow_model_boost = Math.min(boost, 0.35)
    totalVendorBoost += vendor._outflow_model_boost
    vendorCount++
  }

  const avgInflowBoost = customerCount > 0 ? totalCustomerBoost / customerCount : 0
  const avgOutflowBoost = vendorCount > 0 ? totalVendorBoost / vendorCount : 0

  log("confidence_boost.inflow_outflow_models", {
    avg_inflow_boost: avgInflowBoost,
    avg_outflow_boost: avgOutflowBoost,
    customers_boosted: customerCount,
    vendors_boosted: vendorCount,
  })

  return {
    inflow_boost: Math.min(avgInflowBoost * 0.5, 0.20),
    outflow_boost: Math.min(avgOutflowBoost * 0.5, 0.20),
    reasoning: `Inflow models +${(avgInflowBoost * 50).toFixed(0)}%, Outflow models +${(avgOutflowBoost * 50).toFixed(0)}% based on data quality`,
  }
}

/**
 * 3. ENTITY RELATIONSHIPS BOOST
 * Leverage graph data to improve confidence
 */
export function boostEntityRelationships(
  relationshipsCount: number,
  businessEntitiesCount: number,
  totalEntitiesCount: number
): { boost: number; reasoning: string } {
  if (relationshipsCount === 0 || totalEntitiesCount === 0) {
    return { boost: 0, reasoning: "No entity relationships detected" }
  }

  // Calculate relationship density
  const relationshipDensity = relationshipsCount / (totalEntitiesCount * (totalEntitiesCount - 1))
  const businessEntityRatio = businessEntitiesCount / totalEntitiesCount

  // Boost based on relationship coverage
  let boost = 0
  if (relationshipDensity > 0.5) boost = 0.25
  else if (relationshipDensity > 0.3) boost = 0.20
  else if (relationshipDensity > 0.1) boost = 0.15
  else if (relationshipDensity > 0.05) boost = 0.10

  // Additional boost for business entity clustering
  if (businessEntityRatio > 0.3) boost += 0.05

  log("confidence_boost.entity_relationships", {
    boost,
    relationship_density: relationshipDensity,
    business_entity_ratio: businessEntityRatio,
    relationships_count: relationshipsCount,
  })

  return {
    boost: Math.min(boost, 0.30),
    reasoning: `Entity relationships: ${relationshipsCount} connections across ${totalEntitiesCount} entities (density: ${(relationshipDensity * 100).toFixed(1)}%)`,
  }
}

/**
 * 4. DATA SPAN BOOST
 * Improve confidence based on historical data coverage
 */
export function boostDataSpan(
  dataSpanDays: number,
  targetSpanDays: number = 180
): { boost: number; reasoning: string } {
  // Linear boost up to target span
  const spanRatio = Math.min(dataSpanDays / targetSpanDays, 1)
  const boost = spanRatio * 0.25

  log("confidence_boost.data_span", {
    boost,
    data_span_days: dataSpanDays,
    target_span_days: targetSpanDays,
    span_ratio: spanRatio,
  })

  return {
    boost,
    reasoning: `Data span: ${dataSpanDays}d of ${targetSpanDays}d target (${(spanRatio * 100).toFixed(0)}%)`,
  }
}

/**
 * 5. RECURRENCE QUALITY BOOST
 * Improve based on pattern consistency
 */
export function boostRecurrenceQuality(
  customers: CustomerModel[],
  vendors: VendorModel[]
): { boost: number; reasoning: string } {
  let totalRecurrenceConfidence = 0
  let totalCount = 0

  // Analyze customer recurrence
  for (const customer of customers) {
    if (customer.recurrence?.recurrence_confidence) {
      totalRecurrenceConfidence += customer.recurrence.recurrence_confidence
      totalCount++
    }
  }

  // Analyze vendor recurrence
  for (const vendor of vendors) {
    if (vendor.recurrence?.recurrence_confidence) {
      totalRecurrenceConfidence += vendor.recurrence.recurrence_confidence
      totalCount++
    }
  }

  const avgRecurrenceConfidence = totalCount > 0 ? totalRecurrenceConfidence / totalCount : 0
  const boost = avgRecurrenceConfidence * 0.3

  log("confidence_boost.recurrence_quality", {
    boost,
    avg_recurrence_confidence: avgRecurrenceConfidence,
    entities_analyzed: totalCount,
  })

  return {
    boost: Math.min(boost, 0.25),
    reasoning: `Recurrence quality: ${(avgRecurrenceConfidence * 100).toFixed(0)}% avg confidence across ${totalCount} entities`,
  }
}

/**
 * ORCHESTRATOR: Apply all confidence boosts
 */
export async function applyComprehensiveConfidenceBoosts(
  customers: CustomerModel[],
  vendors: VendorModel[],
  historicalMovements: Array<{ date: string; amount: number; entity_id: string; type: "inflow" | "outflow" }>,
  relationshipsCount: number,
  businessEntitiesCount: number,
  totalEntitiesCount: number,
  dataSpanDays: number
): Promise<ConfidenceBoostResult> {
  const improvements: string[] = []

  // 1. Backtest accuracy
  const backtestResult = boostBacktestAccuracy(customers, vendors, historicalMovements)
  improvements.push(`Backtest: ${backtestResult.reasoning}`)

  // 2. Inflow/Outflow models
  const modelResult = boostInflowOutflowModels(customers, vendors)
  improvements.push(`Models: ${modelResult.reasoning}`)

  // 3. Entity relationships
  const relationshipResult = boostEntityRelationships(
    relationshipsCount,
    businessEntitiesCount,
    totalEntitiesCount
  )
  improvements.push(`Relationships: ${relationshipResult.reasoning}`)

  // 4. Data span
  const dataSpanResult = boostDataSpan(dataSpanDays)
  improvements.push(`Data span: ${dataSpanResult.reasoning}`)

  // 5. Recurrence quality
  const recurrenceResult = boostRecurrenceQuality(customers, vendors)
  improvements.push(`Recurrence: ${recurrenceResult.reasoning}`)

  const totalImprovement =
    backtestResult.boost +
    modelResult.inflow_boost +
    modelResult.outflow_boost +
    relationshipResult.boost +
    dataSpanResult.boost +
    recurrenceResult.boost

  const result: ConfidenceBoostResult = {
    backtest_accuracy_boost: backtestResult.boost,
    inflow_model_boost: modelResult.inflow_boost,
    outflow_model_boost: modelResult.outflow_boost,
    entity_relationships_boost: relationshipResult.boost,
    recurrence_quality_boost: recurrenceResult.boost,
    data_span_boost: dataSpanResult.boost,
    total_confidence_improvement: Math.min(totalImprovement, 0.50), // Cap at 50% total boost
    improvements_applied: improvements,
  }

  log("confidence_boost.comprehensive_result", result)

  return result
}

/**
 * MOVEMENT-BASED BACKTEST BOOST
 * Use actual bank transaction patterns to validate and boost confidence
 */
export function boostFromMovementBacktest(
  movementBacktestResult: {
    accuracy_rate: number
    total_entities_tested: number
    inflow_accuracy: number
    outflow_accuracy: number
    clockwork_accuracy: number
    recurring_accuracy: number
  }
): { boost: number; reasoning: string } {
  if (movementBacktestResult.total_entities_tested === 0) {
    return { boost: 0, reasoning: "No movement patterns validated" }
  }

  // Base boost from overall accuracy
  const baseBoost = movementBacktestResult.accuracy_rate * 0.35 // Up to 35% boost

  // Additional boost for high-confidence patterns
  const highConfidenceBoost = Math.min(
    (movementBacktestResult.clockwork_accuracy + movementBacktestResult.recurring_accuracy) * 0.15,
    0.15
  )

  const totalBoost = Math.min(baseBoost + highConfidenceBoost, 0.40) // Cap at 40%

  log("confidence_boost.movement_backtest", {
    accuracy_rate: movementBacktestResult.accuracy_rate,
    entities_tested: movementBacktestResult.total_entities_tested,
    boost: totalBoost,
    inflow_accuracy: movementBacktestResult.inflow_accuracy,
    outflow_accuracy: movementBacktestResult.outflow_accuracy,
  })

  return {
    boost: totalBoost,
    reasoning: `Movement validation: ${(movementBacktestResult.accuracy_rate * 100).toFixed(1)}% accuracy on ${movementBacktestResult.total_entities_tested} entities`,
  }
}

