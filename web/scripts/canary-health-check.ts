/**
 * Canary Health Check — Phase C+E Staged Rollout
 *
 * Evaluates Go/No-Go criteria for each canary stage:
 *   - Phase C (Stages 0-3):  5% → 25% → 100%  (target: 72% match rate)
 *   - Phase E (Stage 4 LLM): 5% → 25% → 100%  (target: 80% match rate)
 *
 * Go/No-Go Criteria:
 *   Phase C: match rate ≥ 70%, cross-entity = 0, error rate < 1%
 *   Phase E: match rate ≥ 80%, hallucination rate < 2%, error rate < 1%
 *
 * Run with: npm run canary:health-check
 */

import { Pool } from "pg"

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Which phase is active — read from env, default to Phase C (deterministic only)
const ACTIVE_PHASE = process.env.CANARY_PHASE ?? "C"
const MATCH_RATE_THRESHOLD = ACTIVE_PHASE === "E" ? 80 : 70
const HALLUCINATION_THRESHOLD = 0.02  // 2%

interface HealthReport {
  phase: string
  matchRate: number
  crossEntityCount: number
  highConfidenceAcceptanceRate: number
  errorRate: number
  hallucinationRate: number
  unmatchedCash: number
  totalMovements: number
  matchedMovements: number
  circuitBreakerOpen: boolean
  go: boolean
  reasons: string[]
}

async function runCanaryHealthCheck(): Promise<void> {
  const client = await pool.connect()
  try {
    console.log(`\n=== Canary Health Check — Phase ${ACTIVE_PHASE} ===\n`)

    // 1. Match rate — movements with at least one attribution
    const matchRateResult = await client.query<{ total: string; matched: string }>(`
      SELECT
        COUNT(DISTINCT m.id)::text AS total,
        COUNT(DISTINCT ma.movement_id)::text AS matched
      FROM movements m
      LEFT JOIN movement_attributions ma ON ma.movement_id = m.id
      WHERE m.pnl_eligible = true
        AND m.direction IN ('inflow','outflow')
    `)
    const { total, matched } = matchRateResult.rows[0]
    const totalMovements = parseInt(total, 10)
    const matchedMovements = parseInt(matched, 10)
    const matchRate = totalMovements > 0 ? (matchedMovements / totalMovements) * 100 : 0

    // 2. Cross-entity contamination
    const crossEntityResult = await client.query<{ cnt: string }>(`
      SELECT COUNT(*)::text AS cnt
      FROM movement_attributions ma
      WHERE (ma.metadata->>'cross_entity_flag')::boolean = true
    `)
    const crossEntityCount = parseInt(crossEntityResult.rows[0].cnt, 10)

    // 3. High-confidence acceptance rate (audit log, last 7 days)
    const confResult = await client.query<{ total_entries: string; high_conf: string }>(`
      SELECT
        COUNT(*)::text AS total_entries,
        COUNT(*) FILTER (WHERE confidence >= 0.75)::text AS high_conf
      FROM reconciliation_audit_log
      WHERE created_at > NOW() - INTERVAL '7 days'
    `)
    const totalAudit = parseInt(confResult.rows[0].total_entries, 10)
    const highConf = parseInt(confResult.rows[0].high_conf, 10)
    const highConfidenceAcceptanceRate = totalAudit > 0 ? (highConf / totalAudit) * 100 : 100

    // 4. Error rate
    const errorResult = await client.query<{ errored: string }>(`
      SELECT COUNT(DISTINCT m.id)::text AS errored
      FROM movements m
      WHERE m.pnl_eligible = true
        AND m.metadata ? 'reconciliation_error'
    `)
    const erroredMovements = parseInt(errorResult.rows[0].errored, 10)
    const errorRate = totalMovements > 0 ? (erroredMovements / totalMovements) * 100 : 0

    // 5. Hallucination rate (Phase E only — from reconciliation_metrics)
    let hallucinationRate = 0
    if (ACTIVE_PHASE === "E") {
      const hallResult = await client.query<{ rate: string }>(`
        SELECT AVG(metric_value)::text AS rate
        FROM reconciliation_metrics
        WHERE metric_name = 'hallucination_rate'
          AND created_at > NOW() - INTERVAL '7 days'
      `)
      hallucinationRate = parseFloat(hallResult.rows[0]?.rate ?? "0")
    }

    // 6. Unmatched cash
    const unmatchedResult = await client.query<{ unmatched_cash: string }>(`
      SELECT COALESCE(SUM(ABS(m.amount)), 0)::text AS unmatched_cash
      FROM movements m
      WHERE m.pnl_eligible = true
        AND NOT EXISTS (SELECT 1 FROM movement_attributions ma WHERE ma.movement_id = m.id)
    `)
    const unmatchedCash = parseFloat(unmatchedResult.rows[0].unmatched_cash)

    // 7. Circuit breaker state
    const cbResult = await client.query<{ metric_value: string }>(`
      SELECT metric_value FROM reconciliation_metrics
      WHERE metric_name = 'circuit_breaker_open'
      ORDER BY created_at DESC LIMIT 1
    `)
    const circuitBreakerOpen = parseFloat(cbResult.rows[0]?.metric_value ?? "0") > 0

    // ─── Evaluate Go/No-Go ────────────────────────────────────────────────────
    const failures: string[] = []

    if (matchRate < MATCH_RATE_THRESHOLD) {
      failures.push(`Match rate ${matchRate.toFixed(1)}% < ${MATCH_RATE_THRESHOLD}% threshold`)
    }
    if (crossEntityCount > 0) {
      failures.push(`Cross-entity contamination: ${crossEntityCount} (must be 0)`)
    }
    if (errorRate >= 1) {
      failures.push(`Error rate ${errorRate.toFixed(2)}% ≥ 1% threshold`)
    }
    if (ACTIVE_PHASE === "E" && hallucinationRate > HALLUCINATION_THRESHOLD) {
      failures.push(`Hallucination rate ${(hallucinationRate * 100).toFixed(1)}% > ${HALLUCINATION_THRESHOLD * 100}% threshold`)
    }
    if (circuitBreakerOpen) {
      failures.push("Circuit breaker is currently OPEN — LLM is failing")
    }

    const report: HealthReport = {
      phase: ACTIVE_PHASE,
      matchRate,
      crossEntityCount,
      highConfidenceAcceptanceRate,
      errorRate,
      hallucinationRate,
      unmatchedCash,
      totalMovements,
      matchedMovements,
      circuitBreakerOpen,
      go: failures.length === 0,
      reasons: failures,
    }

    // ─── Print Report ─────────────────────────────────────────────────────────
    console.log(`📊 Phase ${ACTIVE_PHASE} Canary Metrics`)
    console.log("─────────────────────────────────────────────────")
    console.log(`  Total movements:        ${totalMovements}`)
    console.log(`  Matched:                ${matchedMovements}`)
    console.log(`  Match rate:             ${matchRate.toFixed(1)}%   ${matchRate >= MATCH_RATE_THRESHOLD ? "✅" : "❌"} (target ≥${MATCH_RATE_THRESHOLD}%)`)
    console.log(`  Cross-entity:           ${crossEntityCount}   ${crossEntityCount === 0 ? "✅" : "❌"} (target 0)`)
    console.log(`  Confidence accuracy:    ${highConfidenceAcceptanceRate.toFixed(1)}%   ✅ (informational)`)
    console.log(`  Error rate:             ${errorRate.toFixed(2)}%   ${errorRate < 1 ? "✅" : "❌"} (target <1%)`)
    if (ACTIVE_PHASE === "E") {
      console.log(`  Hallucination rate:     ${(hallucinationRate * 100).toFixed(2)}%   ${hallucinationRate <= HALLUCINATION_THRESHOLD ? "✅" : "❌"} (target <2%)`)
    }
    console.log(`  Circuit breaker:        ${circuitBreakerOpen ? "❌ OPEN" : "✅ CLOSED"}`)
    console.log(`  Unmatched cash:         $${unmatchedCash.toFixed(2)}`)
    console.log("")

    if (report.go) {
      const nextStage = ACTIVE_PHASE === "C" ? "5% → 25% → 100% rollout" : "Stage 4 LLM deployment"
      console.log(`🟢 GO — All criteria pass. Proceed with ${nextStage}.`)
    } else {
      console.log("🔴 NO-GO — Failed criteria:")
      report.reasons.forEach(r => console.log(`   • ${r}`))
      console.log("\nAction: Stop canary, investigate, fix, restart.")
    }

    console.log("\n─────────────────────────────────────────────────")
    console.log("Manual checks (not automated):")
    console.log("  [ ] User complaints < 5 in last 24h?")
    console.log("  [ ] AI Reconciliation Overview looks healthy?")
    if (ACTIVE_PHASE === "E") {
      console.log("  [ ] LLM token costs within budget?")
      console.log("  [ ] No unexpected cross-entity matches in sample review?")
    }

    process.exitCode = report.go ? 0 : 1

  } finally {
    client.release()
    await pool.end()
  }
}

runCanaryHealthCheck().catch(err => {
  console.error("Health check failed:", err)
  process.exit(1)
})
