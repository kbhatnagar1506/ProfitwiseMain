/**
 * API Versioning Middleware
 * Handles API version routing and backward compatibility
 */

export type ApiVersion = "v1" | "v2"

export const CURRENT_API_VERSION: ApiVersion = "v1"
export const SUPPORTED_VERSIONS: ApiVersion[] = ["v1"]

/**
 * Parse API version from request
 */
export function parseApiVersion(req: any): ApiVersion {
  // Check Accept-Version header first
  const acceptVersion = req.headers?.get?.("accept-version") || req.headers?.["accept-version"]
  if (acceptVersion && SUPPORTED_VERSIONS.includes(acceptVersion)) {
    return acceptVersion as ApiVersion
  }

  // Check X-API-Version header
  const apiVersion = req.headers?.get?.("x-api-version") || req.headers?.["x-api-version"]
  if (apiVersion && SUPPORTED_VERSIONS.includes(apiVersion)) {
    return apiVersion as ApiVersion
  }

  // Check URL path
  const url = new URL(req.url || "http://localhost")
  const pathMatch = url.pathname.match(/\/api\/(v\d+)\//)
  if (pathMatch && SUPPORTED_VERSIONS.includes(pathMatch[1] as ApiVersion)) {
    return pathMatch[1] as ApiVersion
  }

  // Default to current version
  return CURRENT_API_VERSION
}

/**
 * Add API version to response headers
 */
export function addApiVersionToResponse(response: any, version: ApiVersion): any {
  if (response.headers) {
    response.headers.set("X-API-Version", version)
    response.headers.set("Deprecation", version !== CURRENT_API_VERSION ? "true" : "false")
  }
  return response
}

/**
 * Get deprecation notice for older versions
 */
export function getDeprecationNotice(version: ApiVersion): string | null {
  if (version === "v1") {
    return null // Current version, no deprecation
  }
  return `API version ${version} is deprecated. Please upgrade to ${CURRENT_API_VERSION}.`
}

/**
 * Versioning documentation
 */
export const API_VERSIONING_DOCS = {
  current: CURRENT_API_VERSION,
  supported: SUPPORTED_VERSIONS,
  deprecationPolicy: {
    notice: "Deprecated versions will be supported for 6 months after a new version is released.",
    timeline: "v1 released: 2024-01-01, v2 planned: 2025-01-01",
  },
  migration: {
    v1_to_v2: "See migration guide at /docs/api/migration/v1-to-v2",
  },
}
