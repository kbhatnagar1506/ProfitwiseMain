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
      avg_days_to_pay: number | null
      std_days_to_pay: number | null
      on_time_rate: number | null
      early_rate: number | null
      with_due_dates: number
    }>(
      `WITH payment_data AS (
        SELECT 
          a.net_amount::float as amount,
          m.date as transaction_date,
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
      ),
      days_to_pay_calc AS (
        SELECT 
          amount,
          CASE 
            WHEN ref_due_date IS NOT NULL 
            THEN ROUND((EXTRACT(EPOCH FROM (transaction_date::timestamp - ref_due_date::timestamp)) / 86400)::numeric)
            ELSE NULL
          END as days_to_pay
        FROM payment_data
      )
      SELECT
        COUNT(*)::int as total_count,
        COALESCE(AVG(amount), 0)::numeric as avg_amount,
        COALESCE(STDDEV(amount), 0)::numeric as std_amount,
        COALESCE(AVG(days_to_pay), 0)::numeric as avg_days_to_pay,
        COALESCE(STDDEV(days_to_pay), 0)::numeric as std_days_to_pay,
        COALESCE(
          SUM(CASE WHEN days_to_pay <= 0 THEN 1 ELSE 0 END)::numeric / 
          NULLIF(COUNT(CASE WHEN days_to_pay IS NOT NULL THEN 1 END), 0),
          0
        )::numeric as on_time_rate,
        COALESCE(
          SUM(CASE WHEN days_to_pay < 0 THEN 1 ELSE 0 END)::numeric / 
          NULLIF(COUNT(CASE WHEN days_to_pay IS NOT NULL THEN 1 END), 0),
          0
        )::numeric as early_rate,
        COUNT(CASE WHEN days_to_pay IS NOT NULL THEN 1 END)::int as with_due_dates
      FROM days_to_pay_calc`,
      [userId, entityId]
    )

    const row = result.rows[0]
    const hasPaymentData = (row?.with_due_dates || 0) > 0

    return {
      avg_days_to_pay: row?.avg_days_to_pay || 0,
      std_days_to_pay: row?.std_days_to_pay || 0,
      on_time_payment_rate: row?.on_time_rate || 0,
      early_payment_rate: row?.early_rate || 0,
      payment_count: row?.total_count || 0,
      avg_payment_amount: row?.avg_amount || 0,
      std_transaction_amount: row?.std_amount || 0,
      payment_metrics_available: hasPaymentData,
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
          AVG(m.amount) as avg_amount
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
          EXTRACT(DAY FROM (m.date::timestamp - LAG(m.date::timestamp) OVER (ORDER BY m.date))) as days_between
        FROM movements m
        WHERE m.counterparty_entity_id = $1 AND m.user_id = $2
        ORDER BY m.date
      )
      SELECT
        COALESCE((SELECT recent_avg FROM recent_data), 0)::numeric as recent_avg,
        COALESCE((SELECT historical_avg FROM historical_data), 0)::numeric as historical_avg,
        COALESCE((SELECT COUNT(*) FROM monthly_data), 0)::numeric as month_count,
        COALESCE((SELECT SUM(txn_count) FROM monthly_data)::numeric / NULLIF((SELECT COUNT(*) FROM monthly_data), 0), 0)::numeric as txn_per_month,
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

    // If data span is <= 1 month, insufficient data for trend analysis
    let amount_trend: "increasing" | "decreasing" | "stable" = "stable"
    if (monthCount > 1) {
      // Only calculate trends if we have more than 1 month of data
      if (recentAvg > historicalAvg * 1.1) {
        amount_trend = "increasing"
      } else if (recentAvg < historicalAvg * 0.9) {
        amount_trend = "decreasing"
      }
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
  trends: TrendData,
  entityType: "customer" | "vendor" = "customer"
): Promise<RiskAssessment> {
  try {
    const risk_factors: string[] = []
    let risk_score = 0

    // If we have payment metrics, use them to assess risk
    if (metrics.payment_metrics_available) {
      // Start with base risk of 20 (low)
      risk_score = 20

      if (entityType === "customer") {
        // CUSTOMER: high on-time rate means they reliably pay YOU
        if (metrics.on_time_payment_rate > 0.85) {
          risk_factors.push("Consistently pays on time")
          risk_score = Math.max(0, risk_score - 15)
        } else if (metrics.on_time_payment_rate < 0.70) {
          risk_factors.push("Frequently pays late")
          risk_score += 25
        }

        // CUSTOMER: early payment = strong financial health, positive signal
        if (metrics.avg_days_to_pay <= 0 && metrics.early_payment_rate > 0.30) {
          risk_factors.push("Often pays early - strong financial position")
          risk_score = Math.max(0, risk_score - 20)
        }
      } else {
        // VENDOR: on-time AP rate measures whether YOU pay them on time
        if (metrics.on_time_payment_rate > 0.85) {
          risk_factors.push("AP invoices consistently paid on time")
          risk_score = Math.max(0, risk_score - 15)
        } else if (metrics.on_time_payment_rate < 0.70) {
          risk_factors.push("AP invoices frequently paid late")
          risk_score += 20
        }

        // VENDOR: paying early means YOUR cash is leaving early — neutral to slight flag
        if (metrics.avg_days_to_pay <= 0 && metrics.early_payment_rate > 0.30) {
          risk_factors.push("Often paying vendors early (cash flow consideration)")
          risk_score += 5
        }
      }

      // High payment delay variance — bad for both
      if (metrics.std_days_to_pay > 20) {
        risk_factors.push("Highly variable payment timing")
        risk_score += 10
      }
    } else {
      risk_score = 20
    }

    // Unpredictable transaction intervals — bad for both
    if (trends.interval_cv > 100) {
      risk_factors.push("Highly unpredictable transaction intervals")
      risk_score += 25
    } else if (trends.interval_cv > 60) {
      risk_factors.push("Somewhat unpredictable transaction intervals")
      risk_score += 10
    }

    // Transaction frequency dropping — bad for both (for vendors: may mean ending the relationship)
    if (trends.transactions_per_month < 0.5 && metrics.payment_count > 5) {
      risk_factors.push("Transaction frequency has dropped significantly")
      risk_score += 20
    }

    if (entityType === "customer") {
      // CUSTOMER: declining revenue = bad, increasing revenue = good
      if (trends.amount_trend === "decreasing") {
        risk_factors.push("Transaction amounts trending downward")
        risk_score += 15
      }
      if (trends.amount_trend === "increasing") {
        risk_score = Math.max(0, risk_score - 10)
      }
    } else {
      // VENDOR: declining spend = cost reduction = good, increasing spend = cost growth = flag
      if (trends.amount_trend === "decreasing") {
        risk_factors.push("Vendor spend trending downward (cost reduction)")
        risk_score = Math.max(0, risk_score - 10)
      }
      if (trends.amount_trend === "increasing") {
        risk_factors.push("Vendor spend increasing (monitor cost growth)")
        risk_score += 10
      }
    }

    // Consistent transaction pattern (low interval CV) — good for both
    if (trends.interval_cv < 30) {
      risk_score = Math.max(0, risk_score - 5)
    }

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
  userId: string,
  entityType: "customer" | "vendor" = "customer"
): Promise<EnrichedEntityData> {
  const metrics = await calculatePaymentMetrics(entityId, userId)
  const trends = await calculateTrends(entityId, userId)
  const seasonality = await calculateSeasonality(entityId, userId)
  const risk = await calculateRiskScore(entityId, userId, metrics, trends, entityType)
  const forecast = await generateForecastSignals(metrics, trends, risk, seasonality)

  return {
    ...metrics,
    ...trends,
    ...seasonality,
    ...risk,
    ...forecast,
  }
}
