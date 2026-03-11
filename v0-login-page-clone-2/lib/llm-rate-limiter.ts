/**
 * Token bucket rate limiter for LLM API calls.
 *
 * Prevents OpenAI rate limit errors (429) which cause the circuit breaker
 * to trip unnecessarily. Also prevents quota exhaustion in high-traffic scenarios.
 *
 * Strategy:
 *   - Max 10 concurrent in-flight requests
 *   - Max 60 requests per minute (conservative; OpenAI allows more)
 *   - Queued requests wait up to 30s before failing
 *   - Respects Retry-After headers when a 429 is received
 */

const MAX_CONCURRENT = 10
const MAX_PER_MINUTE = 60
const QUEUE_TIMEOUT_MS = 30_000

interface RateLimiterMetrics {
  currentConcurrent: number
  requestsThisMinute: number
  queueDepth: number
  totalQueued: number
  totalDropped: number
  rateLimitHits: number
  lastRateLimitAt: number | null
  retryAfterUntil: number | null
}

class LLMRateLimiter {
  private concurrent = 0
  private minuteWindow: number[] = []  // timestamps of requests in last 60s
  private queue: Array<{ resolve: () => void; reject: (e: Error) => void; queuedAt: number }> = []
  private metrics: RateLimiterMetrics = {
    currentConcurrent: 0,
    requestsThisMinute: 0,
    queueDepth: 0,
    totalQueued: 0,
    totalDropped: 0,
    rateLimitHits: 0,
    lastRateLimitAt: null,
    retryAfterUntil: null,
  }

  /** Notify the rate limiter that a 429 was received, with an optional Retry-After value */
  notifyRateLimit(retryAfterMs = 60_000) {
    this.metrics.rateLimitHits++
    this.metrics.lastRateLimitAt = Date.now()
    this.metrics.retryAfterUntil = Date.now() + retryAfterMs
    console.warn(`[RateLimiter] 429 received — backing off for ${retryAfterMs}ms`)
  }

  private cleanMinuteWindow() {
    const cutoff = Date.now() - 60_000
    this.minuteWindow = this.minuteWindow.filter(t => t > cutoff)
    this.metrics.requestsThisMinute = this.minuteWindow.length
  }

  private canProceed(): boolean {
    this.cleanMinuteWindow()
    const now = Date.now()

    if (this.metrics.retryAfterUntil && now < this.metrics.retryAfterUntil) return false
    if (this.concurrent >= MAX_CONCURRENT) return false
    if (this.minuteWindow.length >= MAX_PER_MINUTE) return false

    return true
  }

  private tryFlushQueue() {
    const now = Date.now()
    // Drain expired queue entries
    while (this.queue.length > 0 && now - this.queue[0].queuedAt > QUEUE_TIMEOUT_MS) {
      const entry = this.queue.shift()!
      this.metrics.totalDropped++
      this.metrics.queueDepth = this.queue.length
      entry.reject(new Error("Rate limiter queue timeout exceeded"))
    }
    // Process queue entries that can now proceed
    while (this.queue.length > 0 && this.canProceed()) {
      const entry = this.queue.shift()!
      this.metrics.queueDepth = this.queue.length
      this.acquire()
      entry.resolve()
    }
  }

  private acquire() {
    this.concurrent++
    this.minuteWindow.push(Date.now())
    this.metrics.currentConcurrent = this.concurrent
    this.metrics.requestsThisMinute = this.minuteWindow.length
  }

  private release() {
    this.concurrent = Math.max(0, this.concurrent - 1)
    this.metrics.currentConcurrent = this.concurrent
    // Try to unblock queued requests
    setTimeout(() => this.tryFlushQueue(), 0)
  }

  /**
   * Acquire a slot. Returns a release function to call when the request completes.
   * Queues the request if limits are reached; throws if queue timeout exceeded.
   */
  async acquireSlot(): Promise<() => void> {
    if (this.canProceed()) {
      this.acquire()
      return () => this.release()
    }

    // Queue the request
    return new Promise<() => void>((outerResolve, outerReject) => {
      const waitForSlot = new Promise<void>((resolve, reject) => {
        this.queue.push({ resolve, reject, queuedAt: Date.now() })
        this.metrics.totalQueued++
        this.metrics.queueDepth = this.queue.length
        console.warn(`[RateLimiter] Request queued (depth: ${this.queue.length})`)
      })

      waitForSlot
        .then(() => outerResolve(() => this.release()))
        .catch(outerReject)
    })
  }

  getMetrics(): Readonly<RateLimiterMetrics> {
    this.cleanMinuteWindow()
    return { ...this.metrics }
  }
}

export const llmRateLimiter = new LLMRateLimiter()

/**
 * Wrap an LLM fetch call with rate limiting.
 *
 * Usage:
 *   const result = await withRateLimit(() => fetch(...))
 */
export async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  const release = await llmRateLimiter.acquireSlot()
  try {
    return await fn()
  } finally {
    release()
  }
}
