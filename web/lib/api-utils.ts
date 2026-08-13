/**
 * API Validation Utilities
 * Centralized validation functions for all API endpoints
 */

/**
 * Validate sort field against whitelist
 */
export function validateSortField(sortBy: string | null, allowedFields: string[]): string {
  if (!sortBy) return allowedFields[0]
  if (allowedFields.includes(sortBy)) return sortBy
  return allowedFields[0]
}

/**
 * Validate and constrain numeric parameter
 */
export function validateNumericParam(
  value: string | null,
  defaultValue: number,
  min: number = 1,
  max: number = Infinity
): number {
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  if (isNaN(parsed)) return defaultValue
  return Math.max(min, Math.min(max, parsed))
}

/**
 * Validate enum value
 */
export function validateEnumValue<T extends string>(
  value: any,
  allowedValues: readonly T[],
  defaultValue: T
): T {
  if (!value) return defaultValue
  if (allowedValues.includes(value)) return value as T
  return defaultValue
}

/**
 * Validate UUID format
 */
export function validateUUID(value: string | null): boolean {
  if (!value) return false
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return uuidRegex.test(value)
}

/**
 * Validate array length
 */
export function validateArrayLength<T>(
  array: T[],
  minLength: number = 1,
  maxLength: number = 100
): T[] {
  if (!Array.isArray(array)) return []
  if (array.length < minLength) return []
  if (array.length > maxLength) return array.slice(0, maxLength)
  return array
}

/**
 * Validate string length and trim
 */
export function validateString(
  value: string | null,
  minLength: number = 1,
  maxLength: number = 10000
): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed.length < minLength) return null
  if (trimmed.length > maxLength) return trimmed.slice(0, maxLength)
  return trimmed
}

/**
 * Safe error message extraction
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown error'
}

/**
 * Validate request body has required fields
 */
export function validateRequiredFields(
  body: any,
  requiredFields: string[]
): { valid: boolean; missingFields: string[] } {
  const missingFields = requiredFields.filter(field => !body?.[field])
  return {
    valid: missingFields.length === 0,
    missingFields
  }
}

/**
 * Constrain numeric value to range
 */
export function constrainNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Safe JSON parse
 */
export function safeJsonParse<T>(json: string, defaultValue: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return defaultValue
  }
}

/**
 * Safe JSON stringify
 */
export function safeJsonStringify(obj: any, defaultValue: string = '{}'): string {
  try {
    return JSON.stringify(obj)
  } catch {
    return defaultValue
  }
}

/**
 * Validate numeric range
 */
export function isValidNumber(value: any): boolean {
  const num = Number(value)
  return !isNaN(num) && isFinite(num)
}

/**
 * Standardized error response
 */
export function errorResponse(
  message: string,
  statusCode: number = 400,
  details?: any
) {
  return {
    error: message,
    ...(details && { details }),
    timestamp: new Date().toISOString()
  }
}

/**
 * Standardized success response
 */
export function successResponse(data: any, message?: string) {
  return {
    success: true,
    data,
    ...(message && { message }),
    timestamp: new Date().toISOString()
  }
}

/**
 * Add timeout to a promise
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = 25000,
  timeoutMessage: string = 'Operation timeout'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    )
  ])
}

/**
 * Validate metadata object structure
 */
export function validateMetadata(metadata: any): Record<string, any> {
  if (!metadata || typeof metadata !== 'object') return {}
  if (Array.isArray(metadata)) return {}
  
  // Filter out circular references and invalid values
  const validated: Record<string, any> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof key !== 'string') continue
    if (value === null || value === undefined) continue
    if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      // Skip nested objects to prevent circular references
      continue
    }
    validated[key] = value
  }
  return validated
}

/**
 * Create standardized error response with context
 */
export function createErrorResponse(
  message: string,
  context?: {
    operation?: string
    userId?: string
    details?: any
    statusCode?: number
  }
) {
  return {
    error: message,
    ...(context?.operation && { operation: context.operation }),
    ...(context?.details && { details: context.details }),
    timestamp: new Date().toISOString()
  }
}

/**
 * Create standardized success response with context
 */
export function createSuccessResponse(
  data: any,
  context?: {
    operation?: string
    message?: string
  }
) {
  return {
    success: true,
    data,
    ...(context?.operation && { operation: context.operation }),
    ...(context?.message && { message: context.message }),
    timestamp: new Date().toISOString()
  }
}

/**
 * Type guard for database query results
 */
export function isValidQueryResult<T>(
  result: any,
  requiredFields: (keyof T)[]
): result is T {
  if (!result || typeof result !== 'object') return false
  return requiredFields.every(field => field in result)
}

/**
 * Safe numeric calculation with overflow check
 */
export function safeNumericAdd(a: number, b: number, max: number = Number.MAX_SAFE_INTEGER): number {
  const result = a + b
  if (result > max) return max
  if (result < -max) return -max
  return result
}
