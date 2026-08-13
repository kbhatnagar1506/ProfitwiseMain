/**
 * Circuit breaker for LLM API calls.
 *
 * Prevents cascading failures when the LLM API is unreliable.
 * Three states:
 *   CLOSED    — normal operation; all calls go through
 *   OPEN      — LLM is failing; calls are short-circuited to fallback
 *   HALF_OPEN — testing recovery; one probe call is allowed through
 *
 * Thresholds (conservative for a financial application):
 *   - Opens after 3 consecutive failures
 *   - Resets to HALF_OPEN after 5 minutes in OPEN state
 *   - Returns to CLOSED after 1 successful probe in HALF_OPEN
 *   - Returns to OPEN immediately if probe fails in HALF_OPEN
 */

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

interface CircuitBreakerMetrics {
  state: CircuitState
  consecutiveFailures: number
  totalCalls: number
  totalFailures: number
  totalSuccesses: number
  lastFailureAt: number | null
  lastSuccessAt: number | null
  openedAt: number | null
  stateChanges: Array<{ from: CircuitState; to: CircuitState; at: number; reason: string }>
}

const FAILURE_THRESHOLD = 3          // consecutive failures before opening
const RESET_TIMEOUT_MS = 5 * 60_000  // 5 min before attempting half-open probe
const MAX_STATE_CHANGES = 100        // keep last N state transitions for observability

class LLMCircuitBreaker {
  private state: CircuitState = "CLOSED"
  private consecutiveFailures = 0
  private openedAt: number | null = null
  private metrics: CircuitBreakerMetrics = {
    state: "CLOSED",
    consecutiveFailures: 0,
    totalCalls: 0,
    totalFailures: 0,
    totalSuccesses: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    openedAt: null,
    stateChanges: [],
  }

  private transition(to: CircuitState, reason: string) {
    const from = this.state
    if (from === to) return
    this.state = to
    this.metrics.state = to
    const change = { from, to, at: Date.now(), reason }
    this.metrics.stateChanges.push(change)
    if (this.metrics.stateChanges.length > MAX_STATE_CHANGES) {
      this.metrics.stateChanges.shift()
    }
    console.warn(`[CircuitBreaker] State transition: ${from} → ${to} (${reason})`)
  }

  /**
   * Returns true if the call should be allowed through.
   * Returns false if the circuit is OPEN and should be short-circuited.
   */
  allowRequest(): boolean {
    const now = Date.now()

    if (this.state === "CLOSED") return true

    if (this.state === "OPEN") {
      if (this.openedAt && now - this.openedAt >= RESET_TIMEOUT_MS) {
        this.transition("HALF_OPEN", `Reset timeout elapsed (${RESET_TIMEOUT_MS}ms)`)
        return true  // Allow the probe request
      }
      return false  // Still open
    }

    // HALF_OPEN: allow exactly one probe request
    return true
  }

  /** Called when an LLM call succeeds */
  recordSuccess() {
    this.metrics.totalCalls++
    this.metrics.totalSuccesses++
    this.metrics.lastSuccessAt = Date.now()
    this.consecutiveFailures = 0
    this.metrics.consecutiveFailures = 0

    if (this.state === "HALF_OPEN") {
      this.openedAt = null
      this.metrics.openedAt = null
      this.transition("CLOSED", "Probe succeeded")
    }
  }

  /** Called when an LLM call fails */
  recordFailure(reason = "unknown") {
    this.metrics.totalCalls++
    this.metrics.totalFailures++
    this.metrics.lastFailureAt = Date.now()
    this.consecutiveFailures++
    this.metrics.consecutiveFailures = this.consecutiveFailures

    if (this.state === "HALF_OPEN") {
      this.openedAt = Date.now()
      this.metrics.openedAt = this.openedAt
      this.transition("OPEN", `Probe failed: ${reason}`)
      return
    }

    if (this.state === "CLOSED" && this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.openedAt = Date.now()
      this.metrics.openedAt = this.openedAt
      this.transition("OPEN", `${this.consecutiveFailures} consecutive failures: ${reason}`)
    }
  }

  getState(): CircuitState {
    return this.state
  }

  getMetrics(): Readonly<CircuitBreakerMetrics> {
    return { ...this.metrics, stateChanges: [...this.metrics.stateChanges] }
  }

  /** Force reset — for testing or manual recovery */
  reset() {
    this.consecutiveFailures = 0
    this.openedAt = null
    this.metrics.openedAt = null
    this.metrics.consecutiveFailures = 0
    this.transition("CLOSED", "Manual reset")
  }
}

// Module-level singleton — one circuit breaker per process
export const llmCircuitBreaker = new LLMCircuitBreaker()

/**
 * Wrap an LLM call with circuit breaker protection.
 *
 * Usage:
 *   const result = await withCircuitBreaker(() => callLLM(messages))
 *   if (result === null) {
 *     // circuit is open or LLM failed — use fallback
 *   }
 */
export async function withCircuitBreaker<T>(
  fn: () => Promise<T | null>,
  fallback: T | null = null
): Promise<T | null> {
  if (!llmCircuitBreaker.allowRequest()) {
    const metrics = llmCircuitBreaker.getMetrics()
    console.warn(
      "[CircuitBreaker] Request blocked — circuit OPEN.",
      `Opened at: ${metrics.openedAt ? new Date(metrics.openedAt).toISOString() : "unknown"},`,
      `Failures: ${metrics.consecutiveFailures}`
    )
    return fallback
  }

  try {
    const result = await fn()
    if (result !== null) {
      llmCircuitBreaker.recordSuccess()
    } else {
      llmCircuitBreaker.recordFailure("null result")
    }
    return result
  } catch (err) {
    llmCircuitBreaker.recordFailure(err instanceof Error ? err.message : String(err))
    return fallback
  }
}
