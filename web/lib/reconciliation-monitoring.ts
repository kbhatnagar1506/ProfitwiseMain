/**
 * Comprehensive monitoring for the reconciliation pipeline.
 *
 * Tracks and stores key operational metrics after each reconciliation run:
 *   - Match rate (matched / total movements)
 *   - Error rate (errors / total movements)
 *   - Attribution breakdown by waterfall stage
 *   - Unmatched cash amount
 *   - Circuit breaker state transitions
 *
 * Metrics are stored in the reconciliation_metrics table for dashboard queries.
 * Fire-and-forget: monitoring failures never block the reconciliation path.
 */

import { query } from "@/lib/db"
import { llmCircuitBreaker } from "@/lib/llm-circuit-breaker"

function generateRunId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID()
  // Fallback for Node 14-
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export interface ReconciliationRunMetrics {
  userId: string
  runId: string
  // Core match quality
  totalMovements: number
  matchedMovements: number
  matchRate: number
  unmatchedCashAmount: number
  // Error tracking
  errorCount: number
  errorRate: number
  // Stage breakdown
  stage0Matches: number
  stage1Matches: number
  stage2Matches: number
  stage3Matches: number
  stage4Matches: number
  // Circuit breaker
  circuitBreakerState: "CLOSED" | "OPEN" | "HALF_OPEN"
  // Timing
  durationMs: number
}

/**
 * Emit a set of metrics for a reconciliation run.
 * Fire-and-forget — never throws.
 */
export async function emitReconciliationMetrics(metrics: ReconciliationRunMetrics): Promise<void> {
  try {
    const rows: Array<[string, string, number]> = [
      [metrics.runId, "match_rate", metrics.matchRate],
      [metrics.runId, "error_rate", metrics.errorRate],
      [metrics.runId, "total_movements", metrics.totalMovements],
      [metrics.runId, "matched_movements", metrics.matchedMovements],
      [metrics.runId, "unmatched_cash_amount", metrics.unmatchedCashAmount],
      [metrics.runId, "error_count", metrics.errorCount],
      [metrics.runId, "stage_0_matches", metrics.stage0Matches],
      [metrics.runId, "stage_1_matches", metrics.stage1Matches],
      [metrics.runId, "stage_2_matches", metrics.stage2Matches],
      [metrics.runId, "stage_3_matches", metrics.stage3Matches],
      [metrics.runId, "stage_4_matches", metrics.stage4Matches],
      [metrics.runId, "duration_ms", metrics.durationMs],
      [metrics.runId, "circuit_breaker_open", metrics.circuitBreakerState === "OPEN" ? 1 : 0],
    ]

    for (const [runId, name, value] of rows) {
      await query(
        `INSERT INTO reconciliation_metrics (user_id, run_id, metric_name, metric_value)
         VALUES ($1, $2::uuid, $3, $4)`,
        [metrics.userId, runId, name, value]
      ).catch(err => {
        console.error("[Monitoring] Failed to insert metric", name, err)
      })
    }

    console.log(
      `[Monitoring] Run ${metrics.runId}: ` +
      `match_rate=${(metrics.matchRate * 100).toFixed(1)}% ` +
      `error_rate=${(metrics.errorRate * 100).toFixed(1)}% ` +
      `circuit=${metrics.circuitBreakerState} ` +
      `${metrics.durationMs}ms`
    )
  } catch (err) {
    console.error("[Monitoring] emitReconciliationMetrics failed:", err)
  }
}

/**
 * Build a ReconciliationRunMetrics object from waterfall output.
 * Call this at the end of runFullReconciliation before returning.
 */
export function buildRunMetrics(
  userId: string,
  opts: {
    totalMovements: number
    matchedMovements: number
    unmatchedCashAmount: number
    errorCount: number
    stageCounts: { s0: number; s1: number; s2: number; s3: number; s4: number }
    durationMs: number
  }
): ReconciliationRunMetrics {
  return {
    userId,
    runId: generateRunId(),
    totalMovements: opts.totalMovements,
    matchedMovements: opts.matchedMovements,
    matchRate: opts.totalMovements > 0 ? opts.matchedMovements / opts.totalMovements : 0,
    unmatchedCashAmount: opts.unmatchedCashAmount,
    errorCount: opts.errorCount,
    errorRate: opts.totalMovements > 0 ? opts.errorCount / opts.totalMovements : 0,
    stage0Matches: opts.stageCounts.s0,
    stage1Matches: opts.stageCounts.s1,
    stage2Matches: opts.stageCounts.s2,
    stage3Matches: opts.stageCounts.s3,
    stage4Matches: opts.stageCounts.s4,
    circuitBreakerState: llmCircuitBreaker.getState(),
    durationMs: opts.durationMs,
  }
}

/**
 * Query aggregate metrics for a user over the last N days.
 * Used by observability dashboards and the canary health check.
 */
export async function getMetricsSummary(
  userId: string,
  days = 7
): Promise<{
  avgMatchRate: number
  avgErrorRate: number
  totalRuns: number
  avgDurationMs: number
  circuitBreakerOpenCount: number
} | null> {
  try {
    const result = await query<{
      avg_match_rate: string
      avg_error_rate: string
      total_runs: string
      avg_duration_ms: string
      cb_open_count: string
    }>(
      `SELECT
         AVG(metric_value) FILTER (WHERE metric_name = 'match_rate') AS avg_match_rate,
         AVG(metric_value) FILTER (WHERE metric_name = 'error_rate') AS avg_error_rate,
         COUNT(DISTINCT run_id) FILTER (WHERE metric_name = 'match_rate') AS total_runs,
         AVG(metric_value) FILTER (WHERE metric_name = 'duration_ms') AS avg_duration_ms,
         SUM(metric_value) FILTER (WHERE metric_name = 'circuit_breaker_open') AS cb_open_count
       FROM reconciliation_metrics
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '1 day' * $2`,
      [userId, days]
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      avgMatchRate: parseFloat(row.avg_match_rate ?? "0"),
      avgErrorRate: parseFloat(row.avg_error_rate ?? "0"),
      totalRuns: parseInt(row.total_runs ?? "0"),
      avgDurationMs: parseFloat(row.avg_duration_ms ?? "0"),
      circuitBreakerOpenCount: parseInt(row.cb_open_count ?? "0"),
    }
  } catch (err) {
    console.error("[Monitoring] getMetricsSummary failed:", err)
    return null
  }
}

/**
 * Get match rate trend (one data point per day) for the last N days.
 */
export async function getMatchRateTrend(
  userId: string,
  days = 30
): Promise<Array<{ date: string; matchRate: number; runs: number }>> {
  try {
    const { rows } = await query<{ date: string; match_rate: string; runs: string }>(
      `SELECT
         DATE_TRUNC('day', created_at) AS date,
         AVG(metric_value) AS match_rate,
         COUNT(*) AS runs
       FROM reconciliation_metrics
       WHERE user_id = $1
         AND metric_name = 'match_rate'
         AND created_at > NOW() - INTERVAL '1 day' * $2
       GROUP BY 1
       ORDER BY 1 ASC`,
      [userId, days]
    )
    return rows.map(r => ({
      date: r.date,
      matchRate: parseFloat(r.match_rate),
      runs: parseInt(r.runs),
    }))
  } catch {
    return []
  }
}
