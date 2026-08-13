/**
 * Reconciliation Test Harness
 *
 * Runs the reconciliation waterfall against the golden dataset stored in
 * reconciliation_test_cases and prints a baseline report.
 *
 * Usage:
 *   npx tsx scripts/test-reconciliation.ts [userId]
 *
 * If userId is omitted, runs against all users who have test cases.
 */

import { query, ensureMovementsSchema } from "../lib/db"

const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"

interface TestCase {
  id: string
  user_id: string
  description: string
  movement_id: string | null
  expected_entity: string | null
  expected_invoice: string | null
  expected_match: boolean
  failure_mode: string | null
  notes: string | null
}

interface AuditEntry {
  movement_id: string
  match_method: string
  waterfall_stage: string | null
  confidence: number | null
  entity_id: string | null
  reference_id: string | null
  amount_matched: number | null
  cross_entity_flag: boolean
}

async function fetchTestCases(userId?: string): Promise<TestCase[]> {
  const sql = userId
    ? `SELECT * FROM reconciliation_test_cases WHERE user_id = $1 ORDER BY created_at`
    : `SELECT * FROM reconciliation_test_cases ORDER BY user_id, created_at`
  const result = await query<TestCase>(sql, userId ? [userId] : [])
  return result.rows
}

async function fetchAuditLog(movementId: string): Promise<AuditEntry[]> {
  const result = await query<AuditEntry>(
    `SELECT movement_id, match_method, waterfall_stage, confidence, entity_id, reference_id, amount_matched, cross_entity_flag
     FROM reconciliation_audit_log
     WHERE movement_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [movementId]
  )
  return result.rows
}

async function fetchBaselineMetrics(userId?: string): Promise<{
  totalMovements: number
  matchedMovements: number
  unmatchedMovements: number
  crossEntityFlags: number
  matchRate: number
}> {
  const userFilter = userId ? "AND m.user_id = $1" : ""
  const params = userId ? [userId] : []

  const totals = await query<{
    total: string
    matched: string
    cross_entity: string
  }>(
    `SELECT
       COUNT(DISTINCT m.id)::text AS total,
       COUNT(DISTINCT ma.movement_id)::text AS matched,
       COUNT(DISTINCT CASE WHEN ral.cross_entity_flag THEN ral.movement_id END)::text AS cross_entity
     FROM movements m
     LEFT JOIN movement_attributions ma ON ma.movement_id = m.id
     LEFT JOIN reconciliation_audit_log ral ON ral.movement_id = m.id
     WHERE m.movement_type = 'cash'
     ${userFilter}`,
    params
  )

  const row = totals.rows[0]
  const total = parseInt(row?.total ?? "0", 10)
  const matched = parseInt(row?.matched ?? "0", 10)
  const crossEntity = parseInt(row?.cross_entity ?? "0", 10)

  return {
    totalMovements: total,
    matchedMovements: matched,
    unmatchedMovements: total - matched,
    crossEntityFlags: crossEntity,
    matchRate: total > 0 ? Math.round((matched / total) * 100) : 0,
  }
}

async function runTestCases(cases: TestCase[]): Promise<{
  passed: number
  failed: number
  skipped: number
  failures: { tc: TestCase; actual: AuditEntry | null; reason: string }[]
}> {
  let passed = 0
  let failed = 0
  let skipped = 0
  const failures: { tc: TestCase; actual: AuditEntry | null; reason: string }[] = []

  for (const tc of cases) {
    if (!tc.movement_id) {
      skipped++
      continue
    }

    const auditEntries = await fetchAuditLog(tc.movement_id)
    const mostRecent = auditEntries[0] ?? null

    if (tc.expected_match) {
      // Test case expects a match to have been made
      if (!mostRecent) {
        failed++
        failures.push({ tc, actual: null, reason: "No match found — expected a match" })
        continue
      }
      if (tc.expected_entity && mostRecent.entity_id !== tc.expected_entity) {
        failed++
        failures.push({
          tc,
          actual: mostRecent,
          reason: `Entity mismatch: expected "${tc.expected_entity}", got "${mostRecent.entity_id}"`,
        })
        continue
      }
      if (tc.expected_invoice && mostRecent.reference_id !== tc.expected_invoice) {
        failed++
        failures.push({
          tc,
          actual: mostRecent,
          reason: `Invoice mismatch: expected "${tc.expected_invoice}", got "${mostRecent.reference_id}"`,
        })
        continue
      }
      if (mostRecent.cross_entity_flag) {
        failed++
        failures.push({ tc, actual: mostRecent, reason: "Cross-entity contamination flag set" })
        continue
      }
      passed++
    } else {
      // Test case expects NO match (should be rejected)
      if (mostRecent) {
        failed++
        failures.push({
          tc,
          actual: mostRecent,
          reason: `Unexpected match found: method=${mostRecent.match_method}, entity=${mostRecent.entity_id}`,
        })
        continue
      }
      passed++
    }
  }

  return { passed, failed, skipped, failures }
}

async function main() {
  const userId = process.argv[2]

  console.log(`\n${BOLD}${CYAN}╔════════════════════════════════════════╗${RESET}`)
  console.log(`${BOLD}${CYAN}║  Reconciliation Test Harness           ║${RESET}`)
  console.log(`${BOLD}${CYAN}╚════════════════════════════════════════╝${RESET}\n`)

  try {
    // Ensure schema is up to date
    await ensureMovementsSchema()

    // Fetch baseline metrics
    console.log(`${BOLD}── Baseline Metrics ──${RESET}`)
    const metrics = await fetchBaselineMetrics(userId)
    console.log(`  Total movements:         ${metrics.totalMovements}`)
    console.log(`  Matched movements:       ${metrics.matchedMovements}`)
    console.log(`  Unmatched movements:     ${metrics.unmatchedMovements}`)
    console.log(
      `  Match rate:              ${metrics.matchRate >= 70 ? GREEN : RED}${metrics.matchRate}%${RESET}`
    )
    console.log(
      `  Cross-entity flags:      ${metrics.crossEntityFlags === 0 ? GREEN : RED}${metrics.crossEntityFlags}${RESET}`
    )

    // Fetch and run test cases
    console.log(`\n${BOLD}── Test Cases ──${RESET}`)
    const cases = await fetchTestCases(userId)

    if (cases.length === 0) {
      console.log(
        `  ${YELLOW}No test cases found. Run the seed script to add golden dataset.${RESET}`
      )
      console.log(
        `  ${YELLOW}  npx tsx scripts/seed-reconciliation-test-cases.ts${RESET}\n`
      )
    } else {
      console.log(`  Found ${cases.length} test case(s).\n`)
      const results = await runTestCases(cases)

      console.log(
        `  ${GREEN}Passed:${RESET}  ${results.passed}`
      )
      console.log(
        `  ${RED}Failed:${RESET}  ${results.failed}`
      )
      console.log(
        `  ${YELLOW}Skipped:${RESET} ${results.skipped} (no movement_id linked)\n`
      )

      if (results.failures.length > 0) {
        console.log(`${BOLD}── Failures ──${RESET}`)
        for (const { tc, actual, reason } of results.failures) {
          console.log(`  ${RED}✗${RESET} [${tc.id}] ${tc.description}`)
          console.log(`    ${YELLOW}Reason:${RESET} ${reason}`)
          if (tc.failure_mode) {
            console.log(`    ${YELLOW}Expected failure mode:${RESET} ${tc.failure_mode}`)
          }
          if (actual) {
            console.log(
              `    ${YELLOW}Actual:${RESET} method=${actual.match_method} entity=${actual.entity_id} ref=${actual.reference_id} conf=${actual.confidence}`
            )
          }
          console.log()
        }
      }

      const allPassed = results.failed === 0
      console.log(
        allPassed
          ? `${BOLD}${GREEN}✓ All test cases passed.${RESET}\n`
          : `${BOLD}${RED}✗ ${results.failed} test case(s) failed.${RESET}\n`
      )

      if (!allPassed) {
        process.exit(1)
      }
    }

    // Summary
    console.log(`${BOLD}── Checkpoint Summary ──${RESET}`)
    const issues: string[] = []
    if (metrics.crossEntityFlags > 0) {
      issues.push(`${metrics.crossEntityFlags} cross-entity contamination flag(s) detected`)
    }
    if (metrics.matchRate < 51) {
      issues.push(`Match rate ${metrics.matchRate}% is below expected baseline of 51%`)
    }

    if (issues.length === 0) {
      console.log(`  ${GREEN}✓ Baseline metrics look healthy.${RESET}`)
    } else {
      for (const issue of issues) {
        console.log(`  ${RED}✗ ${issue}${RESET}`)
      }
    }
    console.log()
  } catch (err) {
    console.error(`${RED}Error running test harness:${RESET}`, err)
    process.exit(1)
  }
}

main()
