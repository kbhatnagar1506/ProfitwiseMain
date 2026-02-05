import { query } from "./db"

export interface PaymentMetrics {
  avg_days_to_pay: number
  std_days_to_pay: number
  on_time_payment_rate: number
  early_payment_rate: number
  payment_count: number
  avg_payment_amount: number
  std_transaction_amount: number
  payment_metrics_available: boolean
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
      total_count: number
      avg_amount: number
      std_amount: number
    }>(
      `SELECT
        COUNT(*)::int as total_count,
        COALESCE(AVG(ABS(m.amount)), 0)::numeric as avg_amount,
        COALESCE(STDDEV(ABS(m.amount)), 0)::numeric as std_amount
      FROM movements m
      WHERE m.counterparty_entity_id = $1 AND m.user_id = $2 AND m.direction = 'inflow'`,
      [entityId, userId]
    )

    const row = result.rows[0]

    return {
      avg_days_to_pay: 0,
      std_days_to_pay: 0,
      on_time_payment_rate: 0,
      early_payment_rate: 0,
      payment_count: row?.total_count || 0,
      avg_payment_amount: row?.avg_amount || 0,
      std_transaction_amount: row?.std_amount || 0,
      payment_metrics_available: false,
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
      payment_metrics_available: false,
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
      month_count: number
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
        COALESCE((SELECT COUNT(*) FROM monthly_data), 0)::numeric as month_count,
        COALESCE((SELECT COUNT(*) FROM monthly_data)::numeric / NULLIF((SELECT COUNT(*) FROM monthly_data), 0), 0)::numeric as txn_per_month,
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
    const monthCount = row?.month_count || 0

    let amount_trend: "increasing" | "decreasing" | "stable" = "stable"
    if (recentAvg > historicalAvg * 1.1) {
      amount_trend = "increasing"
    } else if (recentAvg < historicalAvg * 0.9) {
      amount_trend = "decreasing"
    }

    const intervalCv = avgInterval > 0 ? (intervalStd / avgInterval) * 100 : 0
    
    // Calculate transactions per month based on actual months of data
    const txnPerMonth = monthCount > 0 ? (row?.txn_per_month || 0) : 0

    return {
      amount_trend,
      transactions_per_month: txnPerMonth,
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

    // If we don't have payment metrics, use reliability score from metadata as proxy
    // Start with LOW risk (20) and only increase if we see negative signals
    if (!metrics.payment_metrics_available) {
      // Without payment data, we can only assess based on transaction patterns
      // Start optimistic (low risk) unless we see red flags
      risk_score = 20
    }

    // Red flag: Unpredictable payment intervals (high coefficient of variation)
    if (trends.interval_cv > 100) {
      risk_factors.push("Highly unpredictable transaction intervals")
      risk_score += 25
    } else if (trends.interval_cv > 60) {
      risk_factors.push("Somewhat unpredictable transaction intervals")
      risk_score += 10
    }

    // Red flag: Transaction frequency dropping significantly
    if (trends.transactions_per_month < 0.5 && metrics.payment_count > 5) {
      risk_factors.push("Transaction frequency has dropped significantly")
      risk_score += 20
    }

    // Red flag: Amount trend declining
    if (trends.amount_trend === "decreasing") {
      risk_factors.push("Transaction amounts trending downward")
      risk_score += 15
    }

    // Green flag: Amount trend increasing (reduce risk)
    if (trends.amount_trend === "increasing") {
      risk_score = Math.max(0, risk_score - 10)
    }

    // Green flag: Consistent transaction pattern (low interval CV)
    if (trends.interval_cv < 30) {
      risk_score = Math.max(0, risk_score - 5)
    }

    // If no risk factors identified and score is still low, indicate low risk
    if (risk_factors.length === 0 && risk_score < 30) {
      risk_factors.push("Stable transaction pattern")
    }

    return {
      risk_score: Math.min(100, Math.max(0, risk_score)),
      risk_factors: risk_factors.length > 0 ? risk_factors : ["Low risk profile"],
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

  if (!metrics.payment_metrics_available) {
    forecast_uncertainty = "high"
    notes.push("Limited historical data - forecasts are conservative estimates")
  }

  if (trends.interval_cv > 100) {
    forecast_uncertainty = "high"
    notes.push("High variability in transaction intervals")
  } else if (trends.interval_cv < 30) {
    forecast_uncertainty = "low"
    notes.push("Predictable transaction patterns")
  }

  if (trends.amount_trend === "increasing") {
    notes.push("Transaction amounts trending upward")
  } else if (trends.amount_trend === "decreasing") {
    notes.push("Transaction amounts trending downward")
  }

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
