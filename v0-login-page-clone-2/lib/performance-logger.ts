/**
 * Performance Logging Utilities
 * Track and log performance metrics for API operations
 */

import { log } from "@/lib/logger"

export interface PerformanceMetrics {
  operation: string
  duration: number // milliseconds
  userId?: string
  recordCount?: number
  cacheHit?: boolean
  error?: string
}

/**
 * Track operation performance
 */
export class PerformanceTracker {
  private startTime: number
  private operation: string
  private userId?: string

  constructor(operation: string, userId?: string) {
    this.startTime = Date.now()
    this.operation = operation
    this.userId = userId
  }

  /**
   * End tracking and log metrics
   */
  end(meta?: Partial<PerformanceMetrics>): PerformanceMetrics {
    const duration = Date.now() - this.startTime
    const metrics: PerformanceMetrics = {
      operation: this.operation,
      duration,
      userId: this.userId,
      ...meta,
    }

    // Log based on duration
    const logLevel = duration > 5000 ? "slow" : duration > 1000 ? "moderate" : "fast"
    const logMessage = `${this.operation}.${logLevel}`

    log(logMessage, {
      duration,
      ...meta,
    })

    return metrics
  }

  /**
   * Get elapsed time without ending
   */
  getElapsed(): number {
    return Date.now() - this.startTime
  }
}

/**
 * Log database query performance
 */
export function logQueryPerformance(
  query: string,
  duration: number,
  rowCount: number,
  userId?: string
): void {
  const logLevel = duration > 1000 ? "slow" : duration > 100 ? "moderate" : "fast"
  const logMessage = `db.query.${logLevel}`

  log(logMessage, {
    duration,
    rowCount,
    userId,
    queryLength: query.length,
  }, "db")
}

/**
 * Log cache operation
 */
export function logCacheOperation(
  operation: "hit" | "miss" | "set" | "delete",
  key: string,
  duration: number,
  userId?: string
): void {
  log(`cache.${operation}`, {
    key: key.substring(0, 50), // Truncate long keys
    duration,
    userId,
  })
}

/**
 * Log external API call
 */
export function logExternalApiCall(
  service: string,
  endpoint: string,
  duration: number,
  statusCode?: number,
  error?: string
): void {
  const logLevel = error ? "error" : statusCode && statusCode >= 400 ? "warning" : "success"
  const logMessage = `external_api.${service}.${logLevel}`

  log(logMessage, {
    endpoint,
    duration,
    statusCode,
    error,
  })
}
