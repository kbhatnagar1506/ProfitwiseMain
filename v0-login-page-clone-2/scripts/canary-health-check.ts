/**
 * Phase 9 Canary Health Check
 *
 * Run daily during the canary deployment week to evaluate Go/No-Go criteria.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register --project tsconfig.json scripts/canary-health-check.ts
 *
 * Go/No-Go Criteria (from the Lean 9-Week Plan):
 *   Match rate          ≥ 70%        (hard floor)
 *   Cross-entity        0 matches    (hard requirement)
 *   Confidence accuracy ≥ 80%        (matches confidence ≥ 0.75 that were accepted)
 *   Error rate          < 1%         (movements that errored vs total processed)
 *   User complaints     < 5          (manual check — reported separately)
 */

import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

interface HealthReport {
  matchRate: number
  crossEntityCount: number
  highConfidenceAcceptanceRate: number
  errorRate: number
  unmatchedCash: number
  totalMovements: number
  matchedMovements: number
  go: boolean
  reasons: string[]
}

async function runCanaryHealthCheck(): Promise<void> {
  const client = await pool.connect()
  try {
    console.log("=== Phase 9 Canary Health Check ===\n")

    // 1. Match rate — movements that have at least one attribution
    const matchRateResult = await client.query<{ total: string; matched: string }>(`
      SELECT
        COUNT(DISTINCT m.id)::text AS total,
        COUNT(DISTINCT ma.movement_id)::text AS matched
      FROM cash_movements m
      LEFT JOIN movement_attributions ma ON ma.movement_id = m.id
      WHERE m.economic_class = 'operating'
        AND m.direction IN ('inflow','outflow')
    `)
    const { total, matched } = matchRateResult.rows[0]
    const totalMovements = parseInt(total, 10)
    const matchedMovements = parseInt(matched, 10)
    const matchRate = totalMovements > 0 ? (matchedMovements / totalMovements) * 100 : 0

    // 2. Cross-entity contamination — attributions where entity on the attribution
    //    doesn't match the entity on the cash event
    const crossEntityResult = await client.query<{ cnt: string }>(`
      SELECT COUNT(*)::text AS cnt
      FROM movement_attributions ma
      JOIN cash_events ce ON ce.id = ma.event_id
      WHERE ma.entity_id IS NOT NULL
        AND ce.entity_id IS NOT NULL
        AND ma.entity_id != ce.entity_id
    `)
    const crossEntityCount = parseInt(crossEntityResult.rows[0].cnt, 10)

    // 3. Confidence accuracy — high-confidence (≥0.75) audit log entries vs total
    const confResult = await client.query<{ total_entries: string; high_conf: string }>(`
      SELECT
        COUNT(*)::text AS total_entries,
        COUNT(*) FILTER (WHERE confidence >= 0.75)::text AS high_conf
      FROM reconciliation_audit_log
      WHERE created_at > NOW() - INTERVAL '7 days'
    `)
    const totalAudit = parseInt(confResult.rows[0].total_entries, 10)
    const highConf = parseInt(confResult.rows[0].high_conf, 10)
    const highConfidenceAcceptanceRate = totalAudit > 0 ? (highConf / totalAudit) * 100 : 0

    // 4. Error rate — movements where reconciliation errored (no attribution, not excluded)
    const errorResult = await client.query<{ errored: string }>(`
      SELECT COUNT(DISTINCT m.id)::text AS errored
      FROM cash_movements m
      WHERE m.economic_class = 'operating'
        AND m.status = 'error'
    `)
    const erroredMovements = parseInt(errorResult.rows[0].errored, 10)
    const errorRate = totalMovements > 0 ? (erroredMovements / totalMovements) * 100 : 0

    // 5. Unmatched cash
    const unmatchedResult = await client.query<{ unmatched_cash: string }>(`
      SELECT COALESCE(SUM(m.amount), 0)::text AS unmatched_cash
      FROM cash_movements m
      WHERE m.economic_class = 'operating'
        AND NOT EXISTS (SELECT 1 FROM movement_attributions ma WHERE ma.movement_id = m.id)
    `)
    const unmatchedCash = parseFloat(unmatchedResult.rows[0].unmatched_cash)

    // Evaluate criteria
    const report: HealthReport = {
      matchRate,
      crossEntityCount,
      highConfidenceAcceptanceRate,
      errorRate,
      unmatchedCash,
      totalMovements,
      matchedMovements,
      go: false,
      reasons: [],
    }

    const failures: string[] = []

    if (matchRate < 70) {
      failures.push(`Match rate ${matchRate.toFixed(1)}% < 70% threshold`)
    }
    if (crossEntityCount > 0) {
      failures.push(`Cross-entity contamination: ${crossEntityCount} matches (must be 0)`)
    }
    if (highConfidenceAcceptanceRate < 80) {
      failures.push(`Confidence accuracy ${highConfidenceAcceptanceRate.toFixed(1)}% < 80% threshold`)
    }
    if (errorRate >= 1) {
      failures.push(`Error rate ${errorRate.toFixed(2)}% ≥ 1% threshold`)
    }

    report.go = failures.length === 0
    report.reasons = failures

    // Print report
    console.log("📊 Canary Metrics")
    console.log("─────────────────────────────────────────")
    console.log(`  Total movements:       ${totalMovements}`)
    console.log(`  Matched:               ${matchedMovements}`)
    console.log(`  Match rate:            ${matchRate.toFixed(1)}%  ${matchRate >= 70 ? "✅" : "❌"} (target ≥70%)`)
    console.log(`  Cross-entity:          ${crossEntityCount}  ${crossEntityCount === 0 ? "✅" : "❌"} (target 0)`)
    console.log(`  Confidence accuracy:   ${highConfidenceAcceptanceRate.toFixed(1)}%  ${highConfidenceAcceptanceRate >= 80 ? "✅" : "❌"} (target ≥80%)`)
    console.log(`  Error rate:            ${errorRate.toFixed(2)}%  ${errorRate < 1 ? "✅" : "❌"} (target <1%)`)
    console.log(`  Unmatched cash:        $${unmatchedCash.toFixed(2)}  (target <$15,000)`)
    console.log("")

    if (report.go) {
      console.log("🟢 GO — All criteria pass. Ready to expand to 50% → 100%.")
    } else {
      console.log("🔴 NO-GO — The following criteria failed:")
      report.reasons.forEach(r => console.log(`   • ${r}`))
      console.log("\nAction: Stop canary, investigate, fix, restart.")
    }

    console.log("\n─────────────────────────────────────────")
    console.log("Manual checks (not automated):")
    console.log("  [ ] User complaints < 5?")
    console.log("  [ ] AI Reconciliation Overview screen looks healthy?")
    console.log("  [ ] No unexpected spikes in LLM token usage?")
    console.log("")

  } finally {
    client.release()
    await pool.end()
  }
}

runCanaryHealthCheck().catch(err => {
  console.error("Health check failed:", err)
  process.exit(1)
})
