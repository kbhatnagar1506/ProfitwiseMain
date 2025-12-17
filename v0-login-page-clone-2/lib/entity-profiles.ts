/**
 * Entity Profile Computation Engine
 * Builds behavioral profiles for customers and vendors from transaction history.
 * These profiles feed directly into the forecasting engine.
 */

import { query } from "@/lib/db"
import type {
  EntityTransaction,
  BehavioralMetrics,
  SeasonalityPattern,
  RiskAssessment,
  EntityArchetype,
  EntityType,
  AmountTrend,
  RecentTrend,
  EntityPaymentProfile,
} from "@/lib/state/types"

// ─────────────────────────────────────────────────────────────────────────────
// Transaction Aggregation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect all transactions for an entity from movements and invoices/bills
 */
export async function aggregateEntityTransactions(
  userId: string,
  entityId: string
): Promise<EntityTransaction[]> {
  const paymentRows = await query<{
    movement_id: string
    amount: string
    direction: string
    transaction_date: string
    component_type: string
    ref_due_date: string | null
  }>(
    `SELECT 
      m.id as movement_id,
      ABS(a.net_amount::float) as amount,
      m.direction,
      m.date as transaction_date,
      a.component_type,
      COALESCE(
        (qe.data->>'DueDate')::text,
        (xe.data->>'DueDateString')::text,
        (xe.data->>'DueDate')::text
      ) as ref_due_date
    FROM movement_attributions a
    JOIN movements m ON m.id = a.movement_id AND m.user_id = a.user_id
    LEFT JOIN qbo_entities qe
      ON qe.entity_id = a.reference_id
      AND qe.entity_type IN ('Invoice', 'Bill')
      AND a.reference_id IS NOT NULL
    LEFT JOIN xero_entities xe
      ON xe.entity_id = a.reference_id
      AND xe.entity_type IN ('Invoice', 'Bill')
      AND a.reference_id IS NOT NULL
    WHERE a.user_id = $1::uuid
      AND m.counterparty_entity_id = $2::uuid
      AND a.component_type IN ('ar', 'ap')
    ORDER BY m.date DESC`,
    [userId, entityId]
  )

  const transactions: EntityTransaction[] = paymentRows.rows.map((r) => {
    const dueDate = r.ref_due_date?.slice(0, 10) ?? null
    let daysToPay: number | null = null
    let wasOnTime: boolean | null = null

    if (dueDate && r.transaction_date) {
      const payMs = new Date(r.transaction_date).getTime()
      const dueMs = new Date(dueDate).getTime()
      if (!isNaN(payMs) && !isNaN(dueMs)) {
        daysToPay = Math.round((payMs - dueMs) / 86_400_000)
        wasOnTime = daysToPay <= 0
      }
    }

    return {
      id: r.movement_id,
      user_id: userId,
      entity_id: entityId,
      transaction_type: "payment" as const,
      direction: r.direction as "inflow" | "outflow",
      reference_type: "movement" as const,
      reference_id: r.movement_id,
      amount: parseFloat(r.amount) || 0,
      transaction_date: r.transaction_date,
      due_date: dueDate,
      days_to_pay: daysToPay,
      was_on_time: wasOnTime,
      metadata: { component_type: r.component_type },
      created_at: new Date().toISOString(),
    }
  })

  return transactions
}

/**
 * Get all entities with their transaction counts for a user
 */
export async function getEntitiesWithTransactions(
  userId: string
): Promise<Array<{ entity_id: string; canonical_name: string; display_name: string | null; entity_type: string; transaction_count: number; total_amount: number; direction: string }>> {
  const rows = await query<{
    entity_id: string
    canonical_name: string
    display_name: string | null
    entity_type: string
    transaction_count: string
    total_amount: string
    direction: string
  }>(
    `SELECT 
      e.id as entity_id,
      e.canonical_name,
      e.display_name,
      e.entity_type,
      COUNT(DISTINCT m.id)::text as transaction_count,
      COALESCE(SUM(ABS(a.net_amount::float)), 0)::text as total_amount,
      CASE 
        WHEN SUM(CASE WHEN m.direction = 'inflow' THEN 1 ELSE 0 END) > 
             SUM(CASE WHEN m.direction = 'outflow' THEN 1 ELSE 0 END)
        THEN 'inflow'
        ELSE 'outflow'
      END as direction
    FROM entities e
    JOIN movements m ON m.counterparty_entity_id = e.id AND m.user_id = e.user_id
    JOIN movement_attributions a ON a.movement_id = m.id AND a.user_id = m.user_id
    WHERE e.user_id = $1::uuid
      AND a.component_type IN ('ar', 'ap')
    GROUP BY e.id, e.canonical_name, e.display_name, e.entity_type
    HAVING COUNT(DISTINCT m.id) > 0
    ORDER BY SUM(ABS(a.net_amount::float)) DESC`,
    [userId]
  )

  return rows.rows.map((r) => ({
    entity_id: r.entity_id,
    canonical_name: r.canonical_name,
    display_name: r.display_name,
    entity_type: r.entity_type,
    transaction_count: parseInt(r.transaction_count, 10) || 0,
    total_amount: parseFloat(r.total_amount) || 0,
    direction: r.direction,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral Metrics Computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute behavioral metrics from transaction history
 */
export function computeBehavioralMetrics(
  transactions: EntityTransaction[]
): BehavioralMetrics {
  if (transactions.length === 0) {
    return {
      transaction_count: 0,
      avg_days_to_pay: null,
      std_days_to_pay: null,
      on_time_payment_rate: null,
      early_payment_rate: null,
      avg_days_early_late: null,
      avg_transaction_amount: 0,
      std_transaction_amount: null,
      largest_transaction: 0,
      smallest_transaction: 0,
      amount_trend: "stable",
      avg_interval_days: null,
      interval_cv: null,
      transactions_per_month: 0,
    }
  }

  const amounts = transactions.map((t) => t.amount)
  const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length
  const stdAmount = amounts.length > 1
    ? Math.sqrt(amounts.reduce((sum, a) => sum + Math.pow(a - avgAmount, 2), 0) / (amounts.length - 1))
    : null

  // Calculate intervals between transactions
  const sortedDates = transactions
    .map((t) => new Date(t.transaction_date).getTime())
    .sort((a, b) => a - b)
  
  const intervals: number[] = []
  for (let i = 1; i < sortedDates.length; i++) {
    intervals.push((sortedDates[i] - sortedDates[i - 1]) / (1000 * 60 * 60 * 24))
  }

  const avgInterval = intervals.length > 0
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length
    : null

  const intervalStd = intervals.length > 1
    ? Math.sqrt(intervals.reduce((sum, i) => sum + Math.pow(i - (avgInterval || 0), 2), 0) / (intervals.length - 1))
    : null

  const intervalCv = avgInterval && intervalStd ? intervalStd / avgInterval : null

  // Calculate transactions per month
  const firstDate = new Date(sortedDates[0])
  const lastDate = new Date(sortedDates[sortedDates.length - 1])
  const monthSpan = Math.max(1, (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24 * 30))
  const transactionsPerMonth = transactions.length / monthSpan

  // Calculate days to pay metrics (if available)
  const daysToPayValues = transactions
    .filter((t) => t.days_to_pay !== null)
    .map((t) => t.days_to_pay as number)

  const avgDaysToPay = daysToPayValues.length > 0
    ? daysToPayValues.reduce((a, b) => a + b, 0) / daysToPayValues.length
    : null

  const stdDaysToPay = daysToPayValues.length > 1
    ? Math.sqrt(daysToPayValues.reduce((sum, d) => sum + Math.pow(d - (avgDaysToPay || 0), 2), 0) / (daysToPayValues.length - 1))
    : null

  // On-time payment rate
  const onTimePayments = transactions.filter((t) => t.was_on_time === true).length
  const totalWithDueDate = transactions.filter((t) => t.was_on_time !== null).length
  const onTimeRate = totalWithDueDate > 0 ? onTimePayments / totalWithDueDate : null

  // Early payment rate (days_to_pay < 0 means early)
  const earlyPayments = daysToPayValues.filter((d) => d < 0).length
  const earlyRate = daysToPayValues.length > 0 ? earlyPayments / daysToPayValues.length : null

  // Average days early/late
  const avgDaysEarlyLate = daysToPayValues.length > 0
    ? daysToPayValues.reduce((a, b) => a + b, 0) / daysToPayValues.length
    : null

  // Amount trend (compare recent vs older)
  const amountTrend = computeAmountTrend(transactions)

  return {
    transaction_count: transactions.length,
    avg_days_to_pay: avgDaysToPay,
    std_days_to_pay: stdDaysToPay,
    on_time_payment_rate: onTimeRate,
    early_payment_rate: earlyRate,
    avg_days_early_late: avgDaysEarlyLate,
    avg_transaction_amount: avgAmount,
    std_transaction_amount: stdAmount,
    largest_transaction: Math.max(...amounts),
    smallest_transaction: Math.min(...amounts),
    amount_trend: amountTrend,
    avg_interval_days: avgInterval,
    interval_cv: intervalCv,
    transactions_per_month: transactionsPerMonth,
  }
}

function computeAmountTrend(transactions: EntityTransaction[]): AmountTrend {
  if (transactions.length < 4) return "stable"

  const sorted = [...transactions].sort(
    (a, b) => new Date(a.transaction_date).getTime() - new Date(b.transaction_date).getTime()
  )

  const midpoint = Math.floor(sorted.length / 2)
  const olderHalf = sorted.slice(0, midpoint)
  const newerHalf = sorted.slice(midpoint)

  // Additional safety check for edge cases
  if (olderHalf.length === 0 || newerHalf.length === 0) return "stable"

  const olderAvg = olderHalf.reduce((s, t) => s + t.amount, 0) / olderHalf.length
  const newerAvg = newerHalf.reduce((s, t) => s + t.amount, 0) / newerHalf.length

  // Prevent division by zero when olderAvg is 0
  const changeRatio = olderAvg !== 0 ? (newerAvg - olderAvg) / olderAvg : 0

  if (changeRatio > 0.15) return "increasing"
  if (changeRatio < -0.15) return "decreasing"
  return "stable"
}

// ─────────────────────────────────────────────────────────────────────────────
// Seasonality Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect seasonality patterns from transaction history
 */
export function detectSeasonality(
  transactions: EntityTransaction[]
): SeasonalityPattern {
  const monthCounts = new Array(12).fill(0)
  const monthAmounts = new Array(12).fill(0)

  for (const t of transactions) {
    const month = new Date(t.transaction_date).getMonth()
    monthCounts[month]++
    monthAmounts[month] += t.amount
  }

  const totalCount = monthCounts.reduce((a, b) => a + b, 0)
  const avgCount = totalCount / 12

  // Calculate month weights (relative activity)
  const monthWeights = monthCounts.map((c) => (avgCount > 0 ? c / avgCount : 1))

  // Identify peak and low months (>1.3x or <0.7x average)
  const peakMonths: number[] = []
  const lowMonths: number[] = []

  for (let i = 0; i < 12; i++) {
    if (monthWeights[i] > 1.3) peakMonths.push(i + 1) // 1-indexed months
    if (monthWeights[i] < 0.7 && monthCounts[i] > 0) lowMonths.push(i + 1)
  }

  return {
    peak_months: peakMonths,
    low_months: lowMonths,
    month_weights: monthWeights,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk Assessment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate risk signals based on behavioral metrics
 */
export function computeRiskSignals(
  metrics: BehavioralMetrics,
  transactions: EntityTransaction[]
): RiskAssessment {
  const riskFactors: string[] = []
  let riskScore = 0.2 // Base risk

  // Check for payment slowing
  if (transactions.length >= 6) {
    const recent = transactions.slice(0, 3)
    const older = transactions.slice(-3)
    
    const recentDtp = recent.filter((t) => t.days_to_pay !== null).map((t) => t.days_to_pay as number)
    const olderDtp = older.filter((t) => t.days_to_pay !== null).map((t) => t.days_to_pay as number)
    
    if (recentDtp.length > 0 && olderDtp.length > 0) {
      const recentAvg = recentDtp.reduce((a, b) => a + b, 0) / recentDtp.length
      const olderAvg = olderDtp.reduce((a, b) => a + b, 0) / olderDtp.length
      
      // More sensitive threshold: flag if payment delay increases by 2+ days
      if (recentAvg > olderAvg + 2) {
        riskFactors.push("payment_slowing")
        riskScore += 0.15
      }
    }
  }

  // Check for declining amounts
  if (metrics.amount_trend === "decreasing") {
    riskFactors.push("amount_declining")
    riskScore += 0.1
  }

  // Check for low on-time rate
  if (metrics.on_time_payment_rate !== null && metrics.on_time_payment_rate < 0.7) {
    riskFactors.push("low_on_time_rate")
    riskScore += 0.15
  }

  // Check for high variance in payment timing
  if (metrics.interval_cv !== null && metrics.interval_cv > 1.0) {
    riskFactors.push("high_timing_variance")
    riskScore += 0.1
  }

  // Check for frequency dropping
  if (transactions.length >= 6) {
    const threeMonthsAgo = new Date()
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
    
    const recentCount = transactions.filter(
      (t) => new Date(t.transaction_date) > threeMonthsAgo
    ).length
    
    const expectedCount = metrics.transactions_per_month * 3
    
    if (recentCount < expectedCount * 0.5) {
      riskFactors.push("frequency_dropping")
      riskScore += 0.15
    }
  }

  // Determine recent trend
  let recentTrend: RecentTrend = "stable"
  if (riskFactors.length === 0 && metrics.on_time_payment_rate && metrics.on_time_payment_rate > 0.9) {
    recentTrend = "improving"
  } else if (riskFactors.length >= 2) {
    recentTrend = "deteriorating"
  }

  return {
    risk_score: Math.min(1, riskScore),
    risk_factors: riskFactors,
    recent_trend: recentTrend,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Archetype Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify entity archetype based on behavioral metrics
 * Aligns with forecast-engine archetypes
 */
export function classifyArchetype(metrics: BehavioralMetrics): EntityArchetype {
  if (metrics.transaction_count < 3) {
    return "low_data"
  }

  const cv = metrics.interval_cv ?? 1
  const onTimeRate = metrics.on_time_payment_rate ?? 0.5

  // Clockwork: very consistent timing and high on-time rate
  if (cv < 0.3 && onTimeRate > 0.85) {
    return "clockwork"
  }

  // Slow reliable: consistent but takes longer
  if (cv < 0.5 && onTimeRate > 0.7 && (metrics.avg_days_to_pay ?? 0) > 20) {
    return "slow_reliable"
  }

  // Bursty: irregular timing but eventually pays
  if (cv > 0.7 && cv < 1.2 && onTimeRate > 0.5) {
    return "bursty"
  }

  // Volatile: high variance, lower reliability
  if (cv > 1.0 || onTimeRate < 0.5) {
    return "volatile"
  }

  // Default to bursty for moderate cases
  return "bursty"
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Profile Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build or update entity profiles for all entities with transactions
 */
export async function buildEntityProfiles(userId: string): Promise<number> {
  const entities = await getEntitiesWithTransactions(userId)
  let updated = 0

  for (const entity of entities) {
    try {
      const transactions = await aggregateEntityTransactions(userId, entity.entity_id)
      if (transactions.length === 0) continue

      const metrics = computeBehavioralMetrics(transactions)
      const seasonality = detectSeasonality(transactions)
      const risk = computeRiskSignals(metrics, transactions)
      const archetype = classifyArchetype(metrics)

      const entityType: EntityType = entity.direction === "inflow" ? "customer" : "vendor"

      const sortedDates = transactions
        .map((t) => t.transaction_date)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())

      const firstDate = sortedDates[0]
      const lastDate = sortedDates[sortedDates.length - 1]
      const daysSinceLast = Math.floor(
        (Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24)
      )

      // Upsert profile
      await query(
        `INSERT INTO entity_payment_profiles (
          user_id, entity_id, entity_type, archetype,
          first_transaction_date, last_transaction_date, days_since_last_transaction,
          transaction_count, avg_days_to_pay, std_days_to_pay,
          on_time_payment_rate, early_payment_rate, avg_days_early_late,
          avg_payment_amount, std_transaction_amount, largest_transaction, smallest_transaction,
          amount_trend, avg_interval_days, interval_cv, transactions_per_month,
          peak_months, low_months, month_weights,
          lifetime_value, reliability_score, risk_score, risk_factors, recent_trend,
          total_inflow, total_outflow, last_updated
        ) VALUES (
          $1::uuid, $2::uuid, $3, $4,
          $5, $6, $7,
          $8, $9, $10,
          $11, $12, $13,
          $14, $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24,
          $25, $26, $27, $28, $29,
          $30, $31, NOW()
        )
        ON CONFLICT (user_id, entity_id) DO UPDATE SET
          entity_type = EXCLUDED.entity_type,
          archetype = EXCLUDED.archetype,
          first_transaction_date = EXCLUDED.first_transaction_date,
          last_transaction_date = EXCLUDED.last_transaction_date,
          days_since_last_transaction = EXCLUDED.days_since_last_transaction,
          transaction_count = EXCLUDED.transaction_count,
          avg_days_to_pay = EXCLUDED.avg_days_to_pay,
          std_days_to_pay = EXCLUDED.std_days_to_pay,
          on_time_payment_rate = EXCLUDED.on_time_payment_rate,
          early_payment_rate = EXCLUDED.early_payment_rate,
          avg_days_early_late = EXCLUDED.avg_days_early_late,
          avg_payment_amount = EXCLUDED.avg_payment_amount,
          std_transaction_amount = EXCLUDED.std_transaction_amount,
          largest_transaction = EXCLUDED.largest_transaction,
          smallest_transaction = EXCLUDED.smallest_transaction,
          amount_trend = EXCLUDED.amount_trend,
          avg_interval_days = EXCLUDED.avg_interval_days,
          interval_cv = EXCLUDED.interval_cv,
          transactions_per_month = EXCLUDED.transactions_per_month,
          peak_months = EXCLUDED.peak_months,
          low_months = EXCLUDED.low_months,
          month_weights = EXCLUDED.month_weights,
          lifetime_value = EXCLUDED.lifetime_value,
          reliability_score = EXCLUDED.reliability_score,
          risk_score = EXCLUDED.risk_score,
          risk_factors = EXCLUDED.risk_factors,
          recent_trend = EXCLUDED.recent_trend,
          total_inflow = EXCLUDED.total_inflow,
          total_outflow = EXCLUDED.total_outflow,
          last_updated = NOW()`,
        [
          userId,
          entity.entity_id,
          entityType,
          archetype,
          firstDate,
          lastDate,
          daysSinceLast,
          metrics.transaction_count,
          metrics.avg_days_to_pay,
          metrics.std_days_to_pay,
          metrics.on_time_payment_rate,
          metrics.early_payment_rate,
          metrics.avg_days_early_late,
          metrics.avg_transaction_amount,
          metrics.std_transaction_amount,
          metrics.largest_transaction,
          metrics.smallest_transaction,
          metrics.amount_trend,
          metrics.avg_interval_days,
          metrics.interval_cv,
          metrics.transactions_per_month,
          seasonality.peak_months,
          seasonality.low_months,
          seasonality.month_weights,
          entity.total_amount,
          1 - risk.risk_score, // reliability = inverse of risk
          risk.risk_score,
          risk.risk_factors,
          risk.recent_trend,
          entityType === "customer" ? entity.total_amount : 0,
          entityType === "vendor" ? entity.total_amount : 0,
        ]
      )

      updated++
    } catch (e) {
      console.warn(`[entity-profiles] Failed to build profile for entity ${entity.entity_id}:`, e)
    }
  }

  console.log(`[entity-profiles] Built ${updated} entity profiles for user ${userId}`)
  return updated
}

/**
 * Get entity profile by ID
 */
export async function getEntityProfile(
  userId: string,
  entityId: string
): Promise<EntityPaymentProfile | null> {
  const result = await query<EntityPaymentProfile>(
    `SELECT * FROM entity_payment_profiles WHERE user_id = $1::uuid AND entity_id = $2::uuid`,
    [userId, entityId]
  )
  return result.rows[0] || null
}

/**
 * Get all entity profiles for a user
 */
export async function getAllEntityProfiles(
  userId: string,
  options?: { type?: EntityType; minTransactions?: number; sortBy?: string }
): Promise<EntityPaymentProfile[]> {
  let sql = `SELECT * FROM entity_payment_profiles WHERE user_id = $1::uuid`
  const params: unknown[] = [userId]

  if (options?.type) {
    sql += ` AND entity_type = $${params.length + 1}`
    params.push(options.type)
  }

  if (options?.minTransactions) {
    sql += ` AND transaction_count >= $${params.length + 1}`
    params.push(options.minTransactions)
  }

  const sortColumn = options?.sortBy || "lifetime_value"
  sql += ` ORDER BY ${sortColumn} DESC NULLS LAST`

  const result = await query<EntityPaymentProfile>(sql, params)
  return result.rows
}
