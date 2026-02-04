import { query } from "./db"

export interface PaymentMetrics {
  avg_days_to_pay: number
  std_days_to_pay: number
  on_time_payment_rate: number
  early_payment_rate: number
  payment_count: number
  avg_payment_amount: number
  std_transaction_amount: number
}

export interface TrendData {
  amount_trend: "increasing" | "decreasing" | "stable"
  transactions_per_month: number
  avg_interval_days: number
  interval_cv: number
}

export interface SeasonalityData {
  peak_months: number[]
  low_months: number[]
}

export interface RiskAssessment {
  risk_score: number
  risk_factors: string[]
}

export interface ForecastSignals {
  forecast_uncertainty: "low" | "medium" | "high"
  forecast_notes: string
}

export interface EnrichedEntityData extends PaymentMetrics, TrendData, SeasonalityData, RiskAssessment, ForecastSignals {}

export async function calculatePaymentMetrics(
  entityId: string,
  userId: string
): Promise<PaymentMetrics> {
  try {
    const result = await query<{
      avg_days_to_pay: number
      std_days_to_pay: number
      on_time_count: number
      early_count: number
      total_count: number
      avg_amount: number
      std_amount: number
    }>(
      `SELECT
        COALESCE(AVG(EXTRACT(DAY FROM (m.date - m.date))), 0)::numeric as avg_days_to_pay,
        COALESCE(STDDEV(EXTRACT(DAY FROM (m.date - m.date))), 0)::numeric as std_days_to_pay,
        COUNT(CASE WHEN EXTRACT(DAY FROM (m.date - m.date)) <= 0 THEN 1 END)::int as on_time_count,
        COUNT(CASE WHEN EXTRACT(DAY FROM (m.date - m.date)) < -5 THEN 1 END)::int as early_count,
        COUNT(*)::int as total_count,
        COALESCE(AVG(ABS(m.amount)), 0)::numeric as avg_amount,
        COALESCE(STDDEV(ABS(m.amount)), 0)::numeric as std_amount
      FROM movements m
      WHERE m.counterparty_entity_id = $1 AND m.user_id = $2 AND m.direction = 'inflow'`,
      [entityId, userId]
    )

    const row = result.rows[0]

    return {
      avg_days_to_pay: row?.avg_days_to_pay || 0,
      std_days_to_pay: row?.std_days_to_pay || 0,
      on_time_payment_rate: row?.total_count ? (row.on_time_count / row.total_count) * 100 : 0,
      early_payment_rate: row?.total_count ? (row.early_count / row.total_count) * 100 : 0,
      payment_count: row?.total_count || 0,
      avg_payment_amount: row?.avg_amount || 0,
      std_transaction_amount: row?.std_amount || 0,
    }
  } catch (error) {
    console.error("[entity-calculations] Error calculating payment metrics:", error)
    return {
      avg_days_to_pay: 0,
      std_days_to_pay: 0,
      on_time_payment_rate: 0,
      early_payment_rate: 0,
      payment_count: 0,
      avg_payment_amount: 0,
      std_transaction_amount: 0,
    }
  }
}

export async function calculateTrends(
  entityId: string,
  userId: string
): Promise<TrendData> {
  try {
    const result = await query<{
      recent_avg: number
      historical_avg: number
      txn_per_month: number
      avg_interval: number
      interval_std: number
    }>(
      `WITH monthly_data AS (
        SELECT
          DATE_TRUNC('month', m.date)::date as month,
          COUNT(*) as txn_count,
          AVG(ABS(m.amount)) as avg_amount
        FROM movements m
        WHERE m.counterparty_entity_id = $1 AND m.user_id = $2
        GROUP BY DATE_TRUNC('month', m.date)
      ),
      recent_data AS (
        SELECT AVG(avg_amount) as recent_avg
        FROM monthly_data
        WHERE month >= CURRENT_DATE - INTERVAL '3 months'
      ),
      historical_data AS (
        SELECT AVG(avg_amount) as historical_avg
        FROM monthly_data
        WHERE month < CURRENT_DATE - INTERVAL '3 months'
      ),
      intervals AS (
        SELECT
          EXTRACT(DAY FROM (m.date - LAG(m.date) OVER (ORDER BY m.date))) as days_between
        FROM movements m
        WHERE m.counterparty_entity_id = $1 AND m.user_id = $2
        ORDER BY m.date
      )
      SELECT
        COALESCE((SELECT recent_avg FROM recent_data), 0)::numeric as recent_avg,
        COALESCE((SELECT historical_avg FROM historical_data), 0)::numeric as historical_avg,
        COALESCE((SELECT COUNT(*) / 12.0 FROM monthly_data), 0)::numeric as txn_per_month,
        COALESCE(AVG(days_between), 0)::numeric as avg_interval,
        COALESCE(STDDEV(days_between), 0)::numeric as interval_std
      FROM intervals`,
      [entityId, userId]
    )

    const row = result.rows[0]
    const recentAvg = row?.recent_avg || 0
    const historicalAvg = row?.historical_avg || 0
    const avgInterval = row?.avg_interval || 0
    const intervalStd = row?.interval_std || 0

    let amount_trend: "increasing" | "decreasing" | "stable" = "stable"
    if (recentAvg > historicalAvg * 1.1) {
      amount_trend = "increasing"
    } else if (recentAvg < historicalAvg * 0.9) {
      amount_trend = "decreasing"
    }

    const intervalCv = avgInterval > 0 ? (intervalStd / avgInterval) * 100 : 0

    return {
      amount_trend,
      transactions_per_month: row?.txn_per_month || 0,
      avg_interval_days: avgInterval,
      interval_cv: intervalCv,
    }
  } catch (error) {
    console.error("[entity-calculations] Error calculating trends:", error)
    return {
      amount_trend: "stable",
      transactions_per_month: 0,
      avg_interval_days: 0,
      interval_cv: 0,
    }
  }
}

export async function calculateSeasonality(
  entityId: string,
  userId: string
): Promise<SeasonalityData> {
  try {
    const result = await query<{
      month: number
      txn_count: number
    }>(
      `SELECT
        EXTRACT(MONTH FROM m.date)::int as month,
        COUNT(*) as txn_count
      FROM movements m
      WHERE m.counterparty_entity_id = $1 AND m.user_id = $2
      GROUP BY EXTRACT(MONTH FROM m.date)
      ORDER BY txn_count DESC`,
      [entityId, userId]
    )

    const monthCounts = result.rows
    const totalTxns = monthCounts.reduce((sum, row) => sum + row.txn_count, 0)

    if (totalTxns === 0) {
      return { peak_months: [], low_months: [] }
    }

    const avgPerMonth = totalTxns / 12
    const peak_months = monthCounts
      .filter(row => row.txn_count > avgPerMonth * 1.2)
      .map(row => row.month)
      .sort((a, b) => a - b)

    const low_months = monthCounts
      .filter(row => row.txn_count < avgPerMonth * 0.8)
      .map(row => row.month)
      .sort((a, b) => a - b)

    return { peak_months, low_months }
  } catch (error) {
    console.error("[entity-calculations] Error calculating seasonality:", error)
    return { peak_months: [], low_months: [] }
  }
}

export async function calculateRiskScore(
  entityId: string,
  userId: string,
  metrics: PaymentMetrics,
  trends: TrendData
): Promise<RiskAssessment> {
  try {
    const risk_factors: string[] = []
    let risk_score = 0

    // Factor 1: Payment delay variance
    if (metrics.std_days_to_pay > 15) {
      risk_factors.push("Highly variable timing")
      risk_score += 25
    }

    // Factor 2: On-time payment rate
    if (metrics.on_time_payment_rate < 70) {
      risk_factors.push("Low on-time payment rate")
      risk_score += 20
    }

    // Factor 3: Trend in payment delays
    const recentDelays = await query<{ avg_recent_delay: number }>(
      `SELECT AVG(EXTRACT(DAY FROM (m.date - m.date)))::numeric as avg_recent_delay
       FROM movements m
       WHERE m.counterparty_entity_id = $1 AND m.user_id = $2 AND m.date >= CURRENT_DATE - INTERVAL '90 days'`,
      [entityId, userId]
    )

    const historicalDelays = await query<{ avg_historical_delay: number }>(
      `SELECT AVG(EXTRACT(DAY FROM (m.date - m.date)))::numeric as avg_historical_delay
       FROM movements m
       WHERE m.counterparty_entity_id = $1 AND m.user_id = $2 AND m.date < CURRENT_DATE - INTERVAL '90 days'`,
      [entityId, userId]
    )

    const recentDelay = recentDelays.rows[0]?.avg_recent_delay || 0
    const historicalDelay = historicalDelays.rows[0]?.avg_historical_delay || 0

    if (recentDelay > historicalDelay + 5) {
      risk_factors.push("Payment times increasing")
      risk_score += 20
    }

    // Factor 4: Transaction frequency trend
    if (trends.transactions_per_month < 2 && metrics.payment_count > 5) {
      risk_factors.push("Transaction frequency dropping")
      risk_score += 15
    }

    // Factor 5: Interval volatility
    if (trends.interval_cv > 80) {
      risk_factors.push("Unpredictable payment intervals")
      risk_score += 15
    }

    // Factor 6: Early payment rate (positive signal)
    if (metrics.early_payment_rate > 30) {
      risk_score = Math.max(0, risk_score - 10)
    }

    return {
      risk_score: Math.min(100, risk_score),
      risk_factors,
    }
  } catch (error) {
    console.error("[entity-calculations] Error calculating risk score:", error)
    return { risk_score: 50, risk_factors: ["Unable to calculate risk factors"] }
  }
}

export async function generateForecastSignals(
  metrics: PaymentMetrics,
  trends: TrendData,
  risk: RiskAssessment,
  seasonality: SeasonalityData
): Promise<ForecastSignals> {
  let forecast_uncertainty: "low" | "medium" | "high" = "medium"
  const notes: string[] = []

  // Determine uncertainty level
  if (trends.interval_cv > 100 || metrics.std_days_to_pay > 20) {
    forecast_uncertainty = "high"
    notes.push("High uncertainty - consider conservative estimates")
  } else if (trends.interval_cv < 30 && metrics.std_days_to_pay < 5) {
    forecast_uncertainty = "low"
    notes.push("Predictable payment patterns")
  }

  // Add trend signal
  if (trends.amount_trend === "increasing") {
    notes.push("Transaction amounts trending upward")
  } else if (trends.amount_trend === "decreasing") {
    notes.push("Transaction amounts trending downward")
  }

  // Add seasonality signal
  if (seasonality.peak_months.length > 0) {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    const peakMonthNames = seasonality.peak_months.map(m => monthNames[m - 1]).join(", ")
    notes.push(`Peak activity in ${peakMonthNames}`)
  }

  return {
    forecast_uncertainty,
    forecast_notes: notes.join(". "),
  }
}

export async function calculateEnrichedEntityData(
  entityId: string,
  userId: string
): Promise<EnrichedEntityData> {
  const metrics = await calculatePaymentMetrics(entityId, userId)
  const trends = await calculateTrends(entityId, userId)
  const seasonality = await calculateSeasonality(entityId, userId)
  const risk = await calculateRiskScore(entityId, userId, metrics, trends)
  const forecast = await generateForecastSignals(metrics, trends, risk, seasonality)

  return {
    ...metrics,
    ...trends,
    ...seasonality,
    ...risk,
    ...forecast,
  }
}
