/**
 * Request ID Middleware
 * Generates unique request IDs for tracing and logging
 */

import { v4 as uuidv4 } from 'crypto'

// Store request ID in a context-like structure
const requestIdMap = new WeakMap<any, string>()

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  // Use a simple UUID-like format with timestamp prefix for better readability
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 9)
  return `${timestamp}-${random}`
}

/**
 * Get or create request ID for a request
 */
export function getOrCreateRequestId(req: any): string {
  // Try to get from map first
  if (requestIdMap.has(req)) {
    return requestIdMap.get(req)!
  }

  // Check if already in headers
  const existingId = req.headers?.get?.('x-request-id') || req.headers?.['x-request-id']
  if (existingId) {
    requestIdMap.set(req, existingId)
    return existingId
  }

  // Generate new ID
  const newId = generateRequestId()
  requestIdMap.set(req, newId)
  return newId
}

/**
 * Add request ID to response headers
 */
export function addRequestIdToResponse(response: any, requestId: string): any {
  if (response.headers) {
    response.headers.set('X-Request-ID', requestId)
  }
  return response
}

/**
 * Create a request ID context for logging
 */
export function createRequestIdContext(requestId: string): { requestId: string } {
  return { requestId }
}

/**
 * Extract request ID from request
 */
export function extractRequestId(req: any): string | null {
  return req.headers?.get?.('x-request-id') || req.headers?.['x-request-id'] || null
}
