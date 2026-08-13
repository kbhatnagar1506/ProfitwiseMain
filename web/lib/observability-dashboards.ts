/**
 * Observability dashboard data layer.
 *
 * Provides typed query functions for each dashboard panel.
 * All functions are read-only and safe to call from API routes.
 *
 * Dashboards:
 *   1. Reconciliation health  — match rate trend, stage breakdown, unmatched cash
 *   2. LLM performance        — latency, error rate, circuit breaker, retry distribution
 *   3. Hallucination tracking — hallucination rate trend, rejection breakdown
 *   4. Confidence distribution — histogram of confidence scores by stage
 */

import { query } from "@/lib/db"
import { getLLMCallStats } from "@/lib/llm-logging"
import { llmCircuitBreaker } from "@/lib/llm-circuit-breaker"
import { llmRateLimiter } from "@/lib/llm-rate-limiter"
import { getMatchRateTrend, getMetricsSummary } from "@/lib/reconciliation-monitoring"

// ─── Reconciliation Health ─────────────────────────────────────────────────────

export interface ReconciliationHealthDashboard {
  matchRateTrend: Array<{ date: string; matchRate: number; runs: number }>
  summary: {
    avgMatchRate: number
    avgErrorRate: number
    totalRuns: number
    avgDurationMs: number
    circuitBreakerOpenCount: number
  } | null
  stageBreakdown: Array<{
    stage: string
    totalMatches: number
    avgPerRun: number
  }>
  unmatchedCashTrend: Array<{ date: string; amount: number }>
}

export async function getReconciliationHealthDashboard(
  userId: string,
  days = 30
): Promise<ReconciliationHealthDashboard> {
  const [matchRateTrend, summary] = await Promise.all([
    getMatchRateTrend(userId, days),
    getMetricsSummary(userId, days),
  ])

  // Stage breakdown (sum of each stage's matches over the period)
  const stageRows = await query<{ metric_name: string; total: string; avg_per_run: string }>(
    `SELECT
       metric_name,
       SUM(metric_value) AS total,
       AVG(metric_value) AS avg_per_run
     FROM reconciliation_metrics
     WHERE user_id = $1
       AND metric_name IN ('stage_0_matches', 'stage_1_matches', 'stage_2_matches', 'stage_3_matches', 'stage_4_matches')
       AND created_at > NOW() - INTERVAL '1 day' * $2
     GROUP BY metric_name`,
    [userId, days]
  ).then(r => r.rows).catch(() => [])

  const stageBreakdown = stageRows.map(r => ({
    stage: r.metric_name.replace("_matches", "").replace("_", " "),
    totalMatches: parseFloat(r.total),
    avgPerRun: parseFloat(r.avg_per_run),
  }))

  // Unmatched cash trend
  const unmatchedRows = await query<{ date: string; amount: string }>(
    `SELECT
       DATE_TRUNC('day', created_at) AS date,
       AVG(metric_value) AS amount
     FROM reconciliation_metrics
     WHERE user_id = $1
       AND metric_name = 'unmatched_cash_amount'
       AND created_at > NOW() - INTERVAL '1 day' * $2
     GROUP BY 1
     ORDER BY 1 ASC`,
    [userId, days]
  ).then(r => r.rows).catch(() => [])

  return {
    matchRateTrend,
    summary,
    stageBreakdown,
    unmatchedCashTrend: unmatchedRows.map(r => ({ date: r.date, amount: parseFloat(r.amount) })),
  }
}

// ─── LLM Performance ──────────────────────────────────────────────────────────

export interface LLMPerformanceDashboard {
  callStats: {
    successes: number
    failures: number
    avgLatencyMs: number
    p95LatencyMs: number
    avgRetries: number
  } | null
  circuitBreakerState: "CLOSED" | "OPEN" | "HALF_OPEN"
  circuitBreakerMetrics: {
    consecutiveFailures: number
    totalCalls: number
    totalFailures: number
    totalSuccesses: number
    recentStateChanges: Array<{
      from: string
      to: string
      at: number
      reason: string
    }>
  }
  rateLimiterMetrics: {
    currentConcurrent: number
    requestsThisMinute: number
    queueDepth: number
    totalQueued: number
    totalDropped: number
    rateLimitHits: number
  }
}

export async function getLLMPerformanceDashboard(
  userId: string,
  hours = 24
): Promise<LLMPerformanceDashboard> {
  const [callStatsRaw, cbMetrics, rlMetrics] = await Promise.all([
    getLLMCallStats(userId, hours),
    Promise.resolve(llmCircuitBreaker.getMetrics()),
    Promise.resolve(llmRateLimiter.getMetrics()),
  ])

  type CallStats = {
    successes: string
    failures: string
    avg_latency_ms: string
    p95_latency_ms: string
    avg_retries: string
  }
  const cs = callStatsRaw as CallStats | null

  return {
    callStats: cs ? {
      successes: parseInt(cs.successes ?? "0"),
      failures: parseInt(cs.failures ?? "0"),
      avgLatencyMs: parseFloat(cs.avg_latency_ms ?? "0"),
      p95LatencyMs: parseFloat(cs.p95_latency_ms ?? "0"),
      avgRetries: parseFloat(cs.avg_retries ?? "0"),
    } : null,
    circuitBreakerState: llmCircuitBreaker.getState(),
    circuitBreakerMetrics: {
      consecutiveFailures: cbMetrics.consecutiveFailures,
      totalCalls: cbMetrics.totalCalls,
      totalFailures: cbMetrics.totalFailures,
      totalSuccesses: cbMetrics.totalSuccesses,
      recentStateChanges: cbMetrics.stateChanges.slice(-10),
    },
    rateLimiterMetrics: {
      currentConcurrent: rlMetrics.currentConcurrent,
      requestsThisMinute: rlMetrics.requestsThisMinute,
      queueDepth: rlMetrics.queueDepth,
      totalQueued: rlMetrics.totalQueued,
      totalDropped: rlMetrics.totalDropped,
      rateLimitHits: rlMetrics.rateLimitHits,
    },
  }
}

// ─── Hallucination Tracking ───────────────────────────────────────────────────

export interface HallucinationDashboard {
  currentRate: number
  trend: Array<{ date: string; rate: number }>
  byType: {
    missingEntity: number
    amountMismatch: number
    dateMismatch: number
    nameMismatch: number
    missingMovement: number
  }
}

export async function getHallucinationDashboard(
  userId: string,
  days = 14
): Promise<HallucinationDashboard> {
  const rateRows = await query<{ date: string; rate: string }>(
    `SELECT
       DATE_TRUNC('day', created_at) AS date,
       AVG(metric_value) AS rate
     FROM reconciliation_metrics
     WHERE user_id = $1
       AND metric_name = 'hallucination_rate'
       AND created_at > NOW() - INTERVAL '1 day' * $2
     GROUP BY 1
     ORDER BY 1 ASC`,
    [userId, days]
  ).then(r => r.rows).catch(() => [])

  const latestRate = rateRows.length > 0 ? parseFloat(rateRows[rateRows.length - 1].rate) : 0

  return {
    currentRate: latestRate,
    trend: rateRows.map(r => ({ date: r.date, rate: parseFloat(r.rate) })),
    // Detailed by-type breakdown requires audit log analysis (future enhancement)
    byType: { missingEntity: 0, amountMismatch: 0, dateMismatch: 0, nameMismatch: 0, missingMovement: 0 },
  }
}

// ─── Confidence Distribution ──────────────────────────────────────────────────

export interface ConfidenceDashboard {
  distribution: Array<{ bucket: string; count: number }>
  avgByStage: Array<{ stage: string; avgConfidence: number; count: number }>
}

export async function getConfidenceDashboard(
  userId: string,
  days = 30
): Promise<ConfidenceDashboard> {
  const distRows = await query<{ bucket: string; count: string }>(
    `SELECT
       CASE
         WHEN confidence < 0.5 THEN 'low (<50%)'
         WHEN confidence < 0.7 THEN 'medium (50-70%)'
         WHEN confidence < 0.9 THEN 'high (70-90%)'
         ELSE 'very high (90%+)'
       END AS bucket,
       COUNT(*) AS count
     FROM movement_attributions
     WHERE user_id = $1
       AND created_at > NOW() - INTERVAL '1 day' * $2
     GROUP BY 1
     ORDER BY MIN(confidence)`,
    [userId, days]
  ).then(r => r.rows).catch(() => [])

  const stageRows = await query<{ stage: string; avg_confidence: string; count: string }>(
    `SELECT
       COALESCE(metadata->>'waterfall_stage', source) AS stage,
       AVG(confidence) AS avg_confidence,
       COUNT(*) AS count
     FROM movement_attributions
     WHERE user_id = $1
       AND created_at > NOW() - INTERVAL '1 day' * $2
     GROUP BY 1
     ORDER BY 2 DESC`,
    [userId, days]
  ).then(r => r.rows).catch(() => [])

  return {
    distribution: distRows.map(r => ({ bucket: r.bucket, count: parseInt(r.count) })),
    avgByStage: stageRows.map(r => ({
      stage: r.stage,
      avgConfidence: parseFloat(r.avg_confidence),
      count: parseInt(r.count),
    })),
  }
}

// ─── Combined Dashboard (all panels in one call) ──────────────────────────────

export async function getAllDashboards(userId: string) {
  const [health, llm, hallucination, confidence] = await Promise.all([
    getReconciliationHealthDashboard(userId).catch(() => null),
    getLLMPerformanceDashboard(userId).catch(() => null),
    getHallucinationDashboard(userId).catch(() => null),
    getConfidenceDashboard(userId).catch(() => null),
  ])

  return { health, llm, hallucination, confidence }
}
