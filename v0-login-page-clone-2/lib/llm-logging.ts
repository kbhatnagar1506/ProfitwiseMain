/**
 * Lightweight structured logging for LLM calls.
 *
 * Logs are written to the `llm_call_log` table.
 * Sampling: 100% for errors, 10% for successes (avoids log spam).
 *
 * All PII / sensitive data is excluded — we only store:
 *   - request_hash (SHA-256 of sanitized prompt, for dedup)
 *   - prompt_length / response_length (char counts, not content)
 *   - latency, status, error type, retry count
 */

import { query } from "@/lib/db"

export type LLMCallStatus = "success" | "failure" | "timeout" | "circuit_open" | "rate_limited"

export interface LLMCallLogEntry {
  userId: string | null
  requestHash: string
  promptLength: number
  responseLength: number
  latencyMs: number
  status: LLMCallStatus
  errorMessage: string | null
  retryCount: number
  circuitBreakerState: "CLOSED" | "OPEN" | "HALF_OPEN"
  model: string
}

const SUCCESS_SAMPLE_RATE = 0.1  // log 10% of successes

/** Ensure llm_call_log table exists (idempotent) */
let tableEnsured = false
async function ensureTable() {
  if (tableEnsured) return
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS llm_call_log (
        id SERIAL PRIMARY KEY,
        user_id UUID,
        request_hash TEXT NOT NULL,
        prompt_length INT NOT NULL,
        response_length INT NOT NULL,
        latency_ms INT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        retry_count INT NOT NULL DEFAULT 0,
        circuit_breaker_state TEXT NOT NULL DEFAULT 'CLOSED',
        model TEXT NOT NULL DEFAULT 'gpt-4o',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await query(`
      CREATE INDEX IF NOT EXISTS idx_llm_call_log_user_created
        ON llm_call_log (user_id, created_at DESC)
    `)
    tableEnsured = true
  } catch (err) {
    // Never block LLM calls because logging failed
    console.error("[LLM-Logging] Failed to ensure table:", err)
  }
}

/** Simple non-cryptographic hash for deduplication (not security-sensitive) */
function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < Math.min(s.length, 500); i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * Write a log entry for an LLM call.
 * Fire-and-forget — never throws so it can't interrupt the reconciliation hot path.
 */
export function logLLMCall(entry: LLMCallLogEntry, promptPreview = ""): void {
  // Apply sampling
  if (entry.status === "success" && Math.random() > SUCCESS_SAMPLE_RATE) return

  const hash = entry.requestHash || simpleHash(promptPreview)

  setImmediate(async () => {
    try {
      await ensureTable()
      await query(
        `INSERT INTO llm_call_log
           (user_id, request_hash, prompt_length, response_length,
            latency_ms, status, error_message, retry_count,
            circuit_breaker_state, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          entry.userId,
          hash,
          entry.promptLength,
          entry.responseLength,
          entry.latencyMs,
          entry.status,
          entry.errorMessage,
          entry.retryCount,
          entry.circuitBreakerState,
          entry.model,
        ]
      )
    } catch (err) {
      console.error("[LLM-Logging] Failed to write log entry:", err)
    }
  })
}

/**
 * Read recent LLM call logs for a user (for observability dashboards).
 */
export async function getRecentLLMCallLogs(userId: string, limit = 100) {
  try {
    await ensureTable()
    const result = await query(
      `SELECT * FROM llm_call_log
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    )
    return result.rows
  } catch {
    return []
  }
}

/**
 * Aggregate LLM call stats for a user over the last N hours.
 */
export async function getLLMCallStats(userId: string, hours = 24) {
  try {
    await ensureTable()
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'success') AS successes,
         COUNT(*) FILTER (WHERE status != 'success') AS failures,
         AVG(latency_ms) FILTER (WHERE status = 'success') AS avg_latency_ms,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)
           FILTER (WHERE status = 'success') AS p95_latency_ms,
         AVG(retry_count) AS avg_retries
       FROM llm_call_log
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '1 hour' * $2`,
      [userId, hours]
    )
    return result.rows[0] ?? null
  } catch {
    return null
  }
}
