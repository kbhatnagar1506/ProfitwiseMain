/**
 * Load test script for the reconciliation pipeline.
 *
 * Simulates concurrent reconciliation runs to identify:
 *   - API response time degradation under load (p50, p95, p99)
 *   - Database connection pool exhaustion
 *   - LLM API rate limit hits
 *   - Circuit breaker activation
 *   - Error rate under load
 *
 * Run with: npm run test:load-reconciliation
 *
 * NOTE: This script is designed for staging environments only.
 * Do NOT run against production.
 */

import { Pool } from "pg"

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const LOAD_TEST_USER_ID = process.env.LOAD_TEST_USER_ID
if (!LOAD_TEST_USER_ID) {
  console.error("LOAD_TEST_USER_ID env var required for load testing")
  process.exit(1)
}

const CONCURRENT_REQUESTS = parseInt(process.env.LOAD_TEST_CONCURRENT ?? "50")
const DURATION_SECONDS = parseInt(process.env.LOAD_TEST_DURATION ?? "60")
const TARGET_URL = process.env.LOAD_TEST_TARGET_URL ?? "http://localhost:3000"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

interface RequestResult {
  durationMs: number
  success: boolean
  errorType?: string
}

async function sendReconciliationRequest(): Promise<RequestResult> {
  const start = Date.now()
  try {
    const res = await fetch(`${TARGET_URL}/api/ar-ap-step`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-load-test": "true",
      },
      signal: AbortSignal.timeout(30_000),
    })
    const durationMs = Date.now() - start
    if (res.ok) {
      return { durationMs, success: true }
    }
    return { durationMs, success: false, errorType: `http_${res.status}` }
  } catch (err) {
    return {
      durationMs: Date.now() - start,
      success: false,
      errorType: err instanceof Error ? err.name : "unknown",
    }
  }
}

function percentile(sortedArr: number[], p: number): number {
  const idx = Math.floor(sortedArr.length * p) - 1
  return sortedArr[Math.max(0, idx)] ?? 0
}

async function runLoadTest(): Promise<void> {
  console.log(`\n🔥 Load Test Configuration:`)
  console.log(`   Target: ${TARGET_URL}`)
  console.log(`   Concurrent: ${CONCURRENT_REQUESTS}`)
  console.log(`   Duration: ${DURATION_SECONDS}s`)
  console.log(`   User ID: ${LOAD_TEST_USER_ID}\n`)

  const results: RequestResult[] = []
  const startTime = Date.now()
  const endTime = startTime + DURATION_SECONDS * 1000

  let requestsInFlight = 0
  const errors: Record<string, number> = {}

  // Fill up to CONCURRENT_REQUESTS in-flight at all times
  while (Date.now() < endTime) {
    while (requestsInFlight < CONCURRENT_REQUESTS && Date.now() < endTime) {
      requestsInFlight++
      sendReconciliationRequest().then(result => {
        results.push(result)
        requestsInFlight--
        if (!result.success && result.errorType) {
          errors[result.errorType] = (errors[result.errorType] ?? 0) + 1
        }
        // Print live progress every 100 requests
        if (results.length % 100 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          const successCount = results.filter(r => r.success).length
          console.log(`   [${elapsed}s] ${results.length} requests | ${successCount} success | ${results.length - successCount} errors`)
        }
      })
    }
    await new Promise(r => setTimeout(r, 10))
  }

  // Wait for in-flight requests to complete (up to 30s)
  const drainStart = Date.now()
  while (requestsInFlight > 0 && Date.now() - drainStart < 30_000) {
    await new Promise(r => setTimeout(r, 100))
  }

  // ─── Results ─────────────────────────────────────────────────────────────────
  const successResults = results.filter(r => r.success)
  const durations = successResults.map(r => r.durationMs).sort((a, b) => a - b)
  const totalRequests = results.length
  const errorCount = results.filter(r => !r.success).length
  const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0
  const throughput = totalRequests / DURATION_SECONDS

  console.log(`\n📊 Load Test Results:`)
  console.log(`   Total Requests: ${totalRequests}`)
  console.log(`   Throughput: ${throughput.toFixed(1)} req/s`)
  console.log(`   Success Rate: ${((1 - errorRate) * 100).toFixed(1)}%`)
  console.log(`   Error Rate: ${(errorRate * 100).toFixed(1)}%`)
  console.log(`\n⏱  Latency (successful requests):`)
  console.log(`   p50: ${percentile(durations, 0.50).toFixed(0)}ms`)
  console.log(`   p95: ${percentile(durations, 0.95).toFixed(0)}ms`)
  console.log(`   p99: ${percentile(durations, 0.99).toFixed(0)}ms`)

  if (Object.keys(errors).length > 0) {
    console.log(`\n❌ Error Breakdown:`)
    for (const [type, count] of Object.entries(errors)) {
      console.log(`   ${type}: ${count}`)
    }
  }

  // Check circuit breaker state via DB
  const client = await pool.connect()
  try {
    const { rows: cbMetrics } = await client.query<{ metric_value: string }>(
      `SELECT metric_value FROM reconciliation_metrics
       WHERE metric_name = 'circuit_breaker_open'
       ORDER BY created_at DESC LIMIT 1`
    )
    const cbOpen = parseFloat(cbMetrics[0]?.metric_value ?? "0") > 0
    console.log(`\n🔌 Circuit Breaker: ${cbOpen ? "⚠️  TRIPPED during test" : "✅ Stable"}`)
  } finally {
    client.release()
  }

  // Go/No-Go criteria
  console.log(`\n🎯 Go/No-Go Criteria:`)
  const p95 = percentile(durations, 0.95)
  const p95Pass = p95 < 5000
  const errorPass = errorRate < 0.05
  console.log(`   p95 latency < 5s: ${p95Pass ? "✅ PASS" : "❌ FAIL"} (${p95.toFixed(0)}ms)`)
  console.log(`   Error rate < 5%: ${errorPass ? "✅ PASS" : "❌ FAIL"} (${(errorRate * 100).toFixed(1)}%)`)

  const allPass = p95Pass && errorPass
  console.log(`\n${allPass ? "✅ LOAD TEST PASSED" : "❌ LOAD TEST FAILED"}`)
  process.exit(allPass ? 0 : 1)
}

runLoadTest().catch(err => {
  console.error("Load test failed:", err)
  process.exit(1)
})
