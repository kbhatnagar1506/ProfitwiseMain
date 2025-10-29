/**
 * Canonical entity URIs for AR/AP allocations.
 * Format: ar://invoice/{source}/{id} or ap://bill/{source}/{id} or ap://inferred/{entity_id}/{date}
 */

export type EntityUriType = "ar" | "ap"

export type ParsedEntityUri = {
  type: EntityUriType
  source: string
  id: string
  synthetic: boolean
}

/**
 * Build canonical entity URI for AR invoices.
 * - ar://invoice/qbo/{id}
 * - ar://invoice/xero/{id}
 * - ar://invoice/stripe/{id}
 * - ar://invoice/gmail/{id}
 * - ar://invoice/synthetic/stripe_settlement/{payout_id}
 */
export function toEntityUri(
  type: "ar" | "ap",
  source: string,
  id: string,
  synthetic?: boolean
): string {
  if (type === "ar") {
    if (synthetic && source === "stripe_settlement") {
      return `ar://invoice/synthetic/stripe_settlement/${id}`
    }
    return `ar://invoice/${source}/${id}`
  }
  if (type === "ap") {
    if (source === "inferred") {
      return `ap://inferred/${id}` // id format: {entity_id}/{date}
    }
    // source is qbo, xero, gmail for bills
    return `ap://bill/${source}/${id}`
  }
  return `${type}://${source}/${id}`
}

/**
 * Build AR invoice URI for standard sources.
 */
export function toEntityUriAr(
  source: "qbo" | "xero" | "gmail" | "stripe",
  invoiceId: string
): string {
  return `ar://invoice/${source}/${invoiceId}`
}

/**
 * Build AR synthetic invoice URI for Stripe payout.
 */
export function toEntityUriArSynthetic(payoutId: string): string {
  return `ar://invoice/synthetic/stripe_settlement/${payoutId}`
}

/**
 * Build AP bill URI.
 */
export function toEntityUriApBill(source: string, billId: string): string {
  return `ap://bill/${source}/${billId}`
}

/**
 * Build AP inferred obligation URI.
 */
export function toEntityUriApInferred(entityId: string, date: string): string {
  return `ap://inferred/${entityId}/${date}`
}

/**
 * Parse entity URI into components.
 */
export function parseEntityUri(uri: string): ParsedEntityUri | null {
  const arMatch = uri.match(/^ar:\/\/invoice\/(synthetic\/)?([^/]+)\/(.+)$/)
  if (arMatch) {
    const synthetic = !!arMatch[1]
    const source = arMatch[2]
    const id = arMatch[3]
    return { type: "ar", source, id, synthetic }
  }
  const apBillMatch = uri.match(/^ap:\/\/bill\/([^/]+)\/(.+)$/)
  if (apBillMatch) {
    return {
      type: "ap",
      source: apBillMatch[1],
      id: apBillMatch[2],
      synthetic: false,
    }
  }
  const apInferredMatch = uri.match(/^ap:\/\/inferred\/([^/]+)\/(.+)$/)
  if (apInferredMatch) {
    return {
      type: "ap",
      source: "inferred",
      id: `${apInferredMatch[1]}/${apInferredMatch[2]}`,
      synthetic: false,
    }
  }
  return null
}

/**
 * Check if string is already a canonical URI.
 */
export function isEntityUri(s: string): boolean {
  return s.startsWith("ar://") || s.startsWith("ap://")
}

/**
 * Optional: source_id for debugging (e.g. "qbo/abc-123").
 */
export function toSourceId(source: string, id: string): string {
  return `${source}/${id}`
}
