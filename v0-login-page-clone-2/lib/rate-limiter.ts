/**
 * Rate Limiting Middleware
 * Implements token bucket algorithm for rate limiting
 * Uses in-memory store (can be upgraded to Redis for distributed systems)
 */

interface RateLimitConfig {
  windowMs: number // Time window in milliseconds
  maxRequests: number // Max requests per window
  keyGenerator?: (req: any) => string // Function to generate rate limit key
  skipSuccessfulRequests?: boolean // Skip counting successful requests
  skipFailedRequests?: boolean // Skip counting failed requests
}

interface RateLimitStore {
  [key: string]: {
    count: number
    resetTime: number
  }
}

const store: RateLimitStore = {}

/**
 * Create a rate limiter middleware
 */
export function createRateLimiter(config: RateLimitConfig) {
  const {
    windowMs = 60000, // 1 minute default
    maxRequests = 100,
    keyGenerator = (req: any) => req.ip || 'unknown',
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
  } = config

  return {
    /**
     * Check if request is within rate limit
     */
    check: (req: any): { allowed: boolean; remaining: number; resetTime: number } => {
      const key = keyGenerator(req)
      const now = Date.now()

      // Initialize or reset if window expired
      if (!store[key] || store[key].resetTime < now) {
        store[key] = {
          count: 0,
          resetTime: now + windowMs,
        }
      }

      const remaining = Math.max(0, maxRequests - store[key].count)
      const allowed = store[key].count < maxRequests

      if (allowed) {
        store[key].count++
      }

      return {
        allowed,
        remaining,
        resetTime: store[key].resetTime,
      }
    },

    /**
     * Increment counter (for manual tracking)
     */
    increment: (req: any): void => {
      const key = keyGenerator(req)
      const now = Date.now()

      if (!store[key] || store[key].resetTime < now) {
        store[key] = {
          count: 1,
          resetTime: now + windowMs,
        }
      } else {
        store[key].count++
      }
    },

    /**
     * Reset counter for a key
     */
    reset: (key: string): void => {
      delete store[key]
    },

    /**
     * Get current status
     */
    getStatus: (req: any): { count: number; limit: number; remaining: number; resetTime: number } => {
      const key = keyGenerator(req)
      const now = Date.now()

      if (!store[key] || store[key].resetTime < now) {
        return {
          count: 0,
          limit: maxRequests,
          remaining: maxRequests,
          resetTime: now + windowMs,
        }
      }

      return {
        count: store[key].count,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - store[key].count),
        resetTime: store[key].resetTime,
      }
    },
  }
}

/**
 * Pre-configured rate limiters for common scenarios
 */
export const rateLimiters = {
  // Strict limit for auth endpoints (5 attempts per minute)
  auth: createRateLimiter({
    windowMs: 60000,
    maxRequests: 5,
    keyGenerator: (req: any) => `auth:${req.ip || 'unknown'}`,
  }),

  // Moderate limit for expensive operations (10 requests per minute)
  expensive: createRateLimiter({
    windowMs: 60000,
    maxRequests: 10,
    keyGenerator: (req: any) => `expensive:${req.ip || 'unknown'}`,
  }),

  // Moderate limit for forecast operations (5 requests per minute)
  forecast: createRateLimiter({
    windowMs: 60000,
    maxRequests: 5,
    keyGenerator: (req: any) => `forecast:${req.ip || 'unknown'}`,
  }),

  // General API limit (100 requests per minute)
  general: createRateLimiter({
    windowMs: 60000,
    maxRequests: 100,
    keyGenerator: (req: any) => `general:${req.ip || 'unknown'}`,
  }),
}

/**
 * Helper to create rate limit response headers
 */
export function getRateLimitHeaders(status: ReturnType<typeof createRateLimiter>['getStatus']): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(status.limit),
    'X-RateLimit-Remaining': String(status.remaining),
    'X-RateLimit-Reset': String(Math.ceil(status.resetTime / 1000)),
  }
}
