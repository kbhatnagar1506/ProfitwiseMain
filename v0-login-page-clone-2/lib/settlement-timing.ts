/**
 * Settlement Timing Analysis
 * 
 * Extracts settlement timing (days-to-pay) from reconciled AR/AP movements.
 * This provides empirical data on how long it takes customers to pay and
 * vendors to get paid, dramatically improving forecast confidence.
 */

import { query } from "./db"
import { log } from "./logger"

export type SettlementTimingStats = {
  entity_id: string
  entity_name: string
  entity_type: "customer" | "vendor"
  payment_count: number
  avg_days_to_settle: number
  median_days_to_settle: number
  min_days_to_settle: number
  max_days_to_settle: number
  std_dev_days: number
  confidence: number // 0-1, based on payment count and consistency
  recent_avg_days: number // Last 3 payments average
}

/**
 * Calculate settlement timing from reconciled AR movements (customer payments)
 */
export async function calculateARSettlementTiming(userId: string): Promise<SettlementTimingStats[]> {
  try {
    const { rows } = await query<{
      entity_id: string
      entity_name: string
      payment_count: string
      avg_days: string
      median_days: string
      min_days: string
      max_days: string
      std_dev: string
      recent_avg_days: string
    }>(
      `WITH ar_movements AS (
        SELECT 
          a.entity_id,
          COALESCE(e.display_name, e.canonical_name, a.entity_id) as entity_name,
          m.date::date as payment_date,
          -- Try to get invoice date from reference_id or use movement date as fallback
          COALESCE(
            (SELECT created_at::date FROM invoices WHERE id = a.reference_id LIMIT 1),
            m.date::date - INTERVAL '7 days'  -- Conservative estimate if no invoice date
          ) as invoice_date,
          EXTRACT(DAY FROM m.date::date - COALESCE(
            (SELECT created_at::date FROM invoices WHERE id = a.reference_id LIMIT 1),
            m.date::date - INTERVAL '7 days'
          ))::int as days_to_settle,
          ROW_NUMBER() OVER (PARTITION BY a.entity_id ORDER BY m.date DESC) as recency_rank
        FROM movement_attributions a
        JOIN movements m ON a.movement_id = m.id
        LEFT JOIN entities e ON a.entity_id = e.id::text
        WHERE a.user_id = $1::uuid
          AND a.component_type = 'ar'
          AND m.direction = 'inflow'
          AND m.duplicate_of IS NULL
          AND a.confidence > 0.5  -- Only high-confidence matches
      )
      SELECT 
        entity_id,
        entity_name,
        COUNT(*) as payment_count,
        ROUND(AVG(days_to_settle)::numeric, 1)::text as avg_days,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_to_settle)::text as median_days,
        MIN(days_to_settle)::text as min_days,
        MAX(days_to_settle)::text as max_days,
        ROUND(STDDEV(days_to_settle)::numeric, 1)::text as std_dev,
        ROUND(AVG(CASE WHEN recency_rank <= 3 THEN days_to_settle END)::numeric, 1)::text as recent_avg_days
      FROM ar_movements
      GROUP BY entity_id, entity_name
      HAVING COUNT(*) >= 2  -- At least 2 payments for meaningful stats
      ORDER BY COUNT(*) DESC`,
      [userId]
    )

    return rows.map((r) => {
      const paymentCount = parseInt(r.payment_count)
      const avgDays = parseFloat(r.avg_days)
      const stdDev = parseFloat(r.std_dev || "0")
      
      // Confidence based on: payment count (more = higher) and consistency (lower std dev = higher)
      const countConfidence = Math.min(paymentCount / 10, 1) // Max out at 10 payments
      const consistencyConfidence = Math.max(0, 1 - (stdDev / 30)) // Lower std dev = higher confidence
      const confidence = (countConfidence * 0.6 + consistencyConfidence * 0.4)

      return {
        entity_id: r.entity_id,
        entity_name: r.entity_name,
        entity_type: "customer" as const,
        payment_count: paymentCount,
        avg_days_to_settle: avgDays,
        median_days_to_settle: parseFloat(r.median_days),
        min_days_to_settle: parseInt(r.min_days),
        max_days_to_settle: parseInt(r.max_days),
        std_dev_days: stdDev,
        confidence,
        recent_avg_days: parseFloat(r.recent_avg_days || r.avg_days),
      }
    })
  } catch (err) {
    log("settlement_timing.ar.error", { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

/**
 * Calculate settlement timing from reconciled AP movements (vendor payments)
 */
export async function calculateAPSettlementTiming(userId: string): Promise<SettlementTimingStats[]> {
  try {
    const { rows } = await query<{
      entity_id: string
      entity_name: string
      payment_count: string
      avg_days: string
      median_days: string
      min_days: string
      max_days: string
      std_dev: string
      recent_avg_days: string
    }>(
      `WITH ap_movements AS (
        SELECT 
          a.entity_id,
          COALESCE(e.display_name, e.canonical_name, a.entity_id) as entity_name,
          m.date::date as payment_date,
          -- Try to get bill date from reference_id or use movement date as fallback
          COALESCE(
            (SELECT created_at::date FROM bills WHERE id = a.reference_id LIMIT 1),
            m.date::date - INTERVAL '7 days'  -- Conservative estimate if no bill date
          ) as bill_date,
          EXTRACT(DAY FROM m.date::date - COALESCE(
            (SELECT created_at::date FROM bills WHERE id = a.reference_id LIMIT 1),
            m.date::date - INTERVAL '7 days'
          ))::int as days_to_settle,
          ROW_NUMBER() OVER (PARTITION BY a.entity_id ORDER BY m.date DESC) as recency_rank
        FROM movement_attributions a
        JOIN movements m ON a.movement_id = m.id
        LEFT JOIN entities e ON a.entity_id = e.id::text
        WHERE a.user_id = $1::uuid
          AND a.component_type = 'ap'
          AND m.direction = 'outflow'
          AND m.duplicate_of IS NULL
          AND a.confidence > 0.5  -- Only high-confidence matches
      )
      SELECT 
        entity_id,
        entity_name,
        COUNT(*) as payment_count,
        ROUND(AVG(days_to_settle)::numeric, 1)::text as avg_days,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_to_settle)::text as median_days,
        MIN(days_to_settle)::text as min_days,
        MAX(days_to_settle)::text as max_days,
        ROUND(STDDEV(days_to_settle)::numeric, 1)::text as std_dev,
        ROUND(AVG(CASE WHEN recency_rank <= 3 THEN days_to_settle END)::numeric, 1)::text as recent_avg_days
      FROM ap_movements
      GROUP BY entity_id, entity_name
      HAVING COUNT(*) >= 2  -- At least 2 payments for meaningful stats
      ORDER BY COUNT(*) DESC`,
      [userId]
    )

    return rows.map((r) => {
      const paymentCount = parseInt(r.payment_count)
      const avgDays = parseFloat(r.avg_days)
      const stdDev = parseFloat(r.std_dev || "0")
      
      // Confidence based on: payment count (more = higher) and consistency (lower std dev = higher)
      const countConfidence = Math.min(paymentCount / 10, 1) // Max out at 10 payments
      const consistencyConfidence = Math.max(0, 1 - (stdDev / 30)) // Lower std dev = higher confidence
      const confidence = (countConfidence * 0.6 + consistencyConfidence * 0.4)

      return {
        entity_id: r.entity_id,
        entity_name: r.entity_name,
        entity_type: "vendor" as const,
        payment_count: paymentCount,
        avg_days_to_settle: avgDays,
        median_days_to_settle: parseFloat(r.median_days),
        min_days_to_settle: parseInt(r.min_days),
        max_days_to_settle: parseInt(r.max_days),
        std_dev_days: stdDev,
        confidence,
        recent_avg_days: parseFloat(r.recent_avg_days || r.avg_days),
      }
    })
  } catch (err) {
    log("settlement_timing.ap.error", { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

/**
 * Get overall settlement timing confidence for the user
 * This is used to boost the "Settlement timing" component confidence in the forecast
 */
export async function getSettlementTimingConfidence(userId: string): Promise<{
  ar_confidence: number
  ap_confidence: number
  overall_confidence: number
  ar_count: number
  ap_count: number
}> {
  try {
    const arStats = await calculateARSettlementTiming(userId)
    const apStats = await calculateAPSettlementTiming(userId)

    // Calculate average confidence across all entities
    const arConfidence = arStats.length > 0 
      ? arStats.reduce((sum, s) => sum + s.confidence, 0) / arStats.length
      : 0

    const apConfidence = apStats.length > 0
      ? apStats.reduce((sum, s) => sum + s.confidence, 0) / apStats.length
      : 0

    // Overall confidence is weighted average
    const totalCount = arStats.length + apStats.length
    const overallConfidence = totalCount > 0
      ? (arConfidence * arStats.length + apConfidence * apStats.length) / totalCount
      : 0

    return {
      ar_confidence: Math.min(arConfidence, 1),
      ap_confidence: Math.min(apConfidence, 1),
      overall_confidence: Math.min(overallConfidence, 1),
      ar_count: arStats.length,
      ap_count: apStats.length,
    }
  } catch (err) {
    log("settlement_timing.confidence.error", { error: err instanceof Error ? err.message : String(err) })
    return {
      ar_confidence: 0,
      ap_confidence: 0,
      overall_confidence: 0,
      ar_count: 0,
      ap_count: 0,
    }
  }
}

/**
 * Create a lookup map for quick settlement timing access during forecast
 */
export async function buildSettlementTimingMap(userId: string): Promise<Map<string, SettlementTimingStats>> {
  const arStats = await calculateARSettlementTiming(userId)
  const apStats = await calculateAPSettlementTiming(userId)
  
  const map = new Map<string, SettlementTimingStats>()
  
  for (const stat of [...arStats, ...apStats]) {
    map.set(stat.entity_id, stat)
  }
  
  return map
}
