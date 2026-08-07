/**
 * Request Size Limiter Middleware
 * Validates request payload sizes to prevent large payload attacks
 */

export interface SizeLimitConfig {
  maxJsonSize: number // Max JSON payload size in bytes (default: 1MB)
  maxFormDataSize: number // Max form data size in bytes (default: 10MB)
  maxFileSize: number // Max single file size in bytes (default: 50MB)
}

export const DEFAULT_SIZE_LIMITS: SizeLimitConfig = {
  maxJsonSize: 1024 * 1024, // 1MB
  maxFormDataSize: 10 * 1024 * 1024, // 10MB
  maxFileSize: 50 * 1024 * 1024, // 50MB
}

/**
 * Check if request size is within limits
 */
export function checkRequestSize(
  contentLength: number | null,
  contentType: string | null,
  config: SizeLimitConfig = DEFAULT_SIZE_LIMITS
): { allowed: boolean; error?: string } {
  if (!contentLength) {
    return { allowed: true }
  }

  // Check JSON payload size
  if (contentType?.includes("application/json")) {
    if (contentLength > config.maxJsonSize) {
      return {
        allowed: false,
        error: `JSON payload too large. Maximum size: ${config.maxJsonSize / 1024 / 1024}MB, received: ${contentLength / 1024 / 1024}MB`,
      }
    }
  }

  // Check form data size
  if (contentType?.includes("multipart/form-data") || contentType?.includes("application/x-www-form-urlencoded")) {
    if (contentLength > config.maxFormDataSize) {
      return {
        allowed: false,
        error: `Form data too large. Maximum size: ${config.maxFormDataSize / 1024 / 1024}MB, received: ${contentLength / 1024 / 1024}MB`,
      }
    }
  }

  return { allowed: true }
}

/**
 * Get size limit headers for response
 */
export function getSizeLimitHeaders(config: SizeLimitConfig = DEFAULT_SIZE_LIMITS): Record<string, string> {
  return {
    "X-Max-JSON-Size": String(config.maxJsonSize),
    "X-Max-FormData-Size": String(config.maxFormDataSize),
    "X-Max-File-Size": String(config.maxFileSize),
  }
}

/**
 * Format bytes to human readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes"
  const k = 1024
  const sizes = ["Bytes", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i]
}
