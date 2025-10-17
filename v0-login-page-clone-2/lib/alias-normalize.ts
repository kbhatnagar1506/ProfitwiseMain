/**
 * Alias normalization pipeline (plan #5).
 * Normalize entity names for matching: David Vaugh vs David Vaughn, RachelSuba vs Rachel Suba.
 */

/**
 * Split camelCase and PascalCase: "RachelSuba" -> "Rachel Suba"
 */
function splitCamelCase(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
}

/**
 * Normalize for exact match: lowercase, remove punctuation, collapse spaces, split camelCase.
 * "David Vaughn" -> "davidvaughn"
 * "RachelSuba" -> "rachelsuba"
 * "realsy Wholesale" -> "realsywholesale"
 */
export function normalizeForMatch(s: string): string {
  if (!s || typeof s !== "string") return ""
  return splitCamelCase(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

/**
 * Heuristic alias match: normalized forms are similar.
 * Returns true if a and b match (exact normalized, or one contains the other, or high overlap).
 */
export function heuristicAliasMatch(a: string, b: string): boolean {
  const na = normalizeForMatch(a)
  const nb = normalizeForMatch(b)
  if (na === nb) return true
  if (na.length < 3 || nb.length < 3) return false
  if (na.includes(nb) || nb.includes(na)) return true
  // Jaccard-like: shared prefix length
  const minLen = Math.min(na.length, nb.length)
  let prefixMatch = 0
  while (prefixMatch < minLen && na[prefixMatch] === nb[prefixMatch]) prefixMatch++
  return prefixMatch >= Math.min(na.length, nb.length) * 0.85
}

// Hide test aliases: ends with " test" or contains "test" as whole word
const TEST_ALIAS_PATTERN = /\s+test$/i
const TEST_WORD_PATTERN = /\btest\b/i

// Invoice sludge: raw invoice strings, payment-for-invoice — exclude from primary display
export const INVOICE_SLUDGE = /^(INV-\d+|Payment\s+for\s+invoice|Invoice\s+#?\d*)$/i

export function isInvoiceSludge(s: string | null | undefined): boolean {
  return !!(s && typeof s === "string" && INVOICE_SLUDGE.test(s.trim()))
}

// Email: avoid unless no other option
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Common product/brand spacing: known compound words (no personal names)
const CANONICAL_SPACING: Array<[RegExp, string]> = [
  [/\bQuick\s+Books\b/gi, "QuickBooks"],
  [/\bDocu\s*Sign\b/gi, "DocuSign"],
  [/\bMac\s+Lean\b/gi, "MacLean"],
  [/\bHuman\s+N\s+Professional\b/gi, "Human N Professional"],
]

function cleanDisplay(s: string): string {
  let out = splitCamelCase(s)
  for (const [re, repl] of CANONICAL_SPACING) out = out.replace(re, repl)
  return out
    .replace(/\s+/g, " ")
    .replace(/\b([a-z])([A-Z][a-z])/g, "$1 $2")
    .replace(/\b([A-Z][a-z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
}

function isTestLabel(s: string): boolean {
  const t = s.trim()
  if (TEST_ALIAS_PATTERN.test(t)) return true
  if (TEST_WORD_PATTERN.test(t)) return true
  return false
}

function isCleanLabel(s: string): boolean {
  if (!s || s.length < 2) return false
  if (EMAIL_PATTERN.test(s)) return false
  if (INVOICE_SLUDGE.test(s)) return false
  if (isTestLabel(s)) return false
  return true
}

/**
 * Check if a label should be hidden as owner (for privacy/clean display).
 * Pass ownerNames when known; matches normalized.
 */
export function isOwnerLabel(raw: string | null | undefined, ownerNames: string[] = []): boolean {
  if (!raw || typeof raw !== "string") return false
  const n = normalizeForMatch(raw)
  if (n.length < 2) return false
  return ownerNames.some((o) => {
    const on = normalizeForMatch(o)
    return on && (n.includes(on) || on.includes(n))
  })
}

/**
 * Display label: (1) entity canonical_name if resolved and clean, (2) normalized display, (3) raw.
 * Excludes email, invoice sludge, test labels from primary display.
 * When ownerNames provided and raw matches, returns "Owner" for privacy.
 */
export function displayLabelForCounterparty(
  raw: string | null | undefined,
  preferredLabel?: string | null,
  ownerNames: string[] = [],
): string {
  if (preferredLabel && typeof preferredLabel === "string" && isCleanLabel(preferredLabel)) {
    if (ownerNames.length > 0 && isOwnerLabel(preferredLabel, ownerNames)) return "Owner"
    return cleanDisplay(preferredLabel)
  }
  if (!raw || typeof raw !== "string") return "—"
  if (isTestLabel(raw)) return "—"
  if (INVOICE_SLUDGE.test(raw.trim())) return "—"
  if (ownerNames.length > 0 && isOwnerLabel(raw, ownerNames)) return "Owner"
  return cleanDisplay(raw)
}

/**
 * Normalize raw bank account names for dashboard display.
 * Maps Plaid-style names (e.g. "Chase Parent Account:J. RUBENSTEIN (6515) - 2") to readable labels.
 */
export function normalizeAccountDisplayName(
  raw: string | null | undefined,
  accountType?: string | null,
  accountSubtype?: string | null,
): string {
  if (!raw || typeof raw !== "string") return "External / unlinked account"
  const s = raw.trim()
  if (!s) return "External / unlinked account"

  const type = (accountType ?? "").toLowerCase()
  const subtype = (accountSubtype ?? "").toLowerCase()
  const combined = `${s} ${type} ${subtype}`.toLowerCase()

  if (/\bparent\s*account\b/i.test(s) || (type === "credit" && /parent|personal/i.test(s))) {
    return "Owner credit card"
  }
  if (type === "credit" || subtype === "credit card") {
    return "Credit card"
  }
  if (subtype === "checking" || (type === "depository" && /checking|check/i.test(combined))) {
    return "Business checking"
  }
  if (subtype === "savings" || subtype === "money market" || /savings|money\s*market|mma/i.test(combined)) {
    return "Business MMA"
  }
  if (type === "depository") {
    return "Business checking"
  }

  // Try to shorten ugly names: "Chase Parent Account:J. RUBENSTEIN (6515) - 2" -> "Chase (6515)"
  const match = s.match(/^([^:]+)(?::.*?)?\s*\((\d{4})\)/)
  if (match) return `${match[1].trim()} (${match[2]})`
  if (s.length > 40) return s.slice(0, 37) + "..."
  return s
}

/**
 * Generate normalized variants for lookup (preserve original as primary).
 */
export function normalizedVariants(raw: string): string[] {
  const n = normalizeForMatch(raw)
  if (n.length < 2) return []
  const variants = [n]
  const withSpaces = splitCamelCase(raw).toLowerCase().replace(/\s+/g, " ").trim()
  if (withSpaces !== raw.toLowerCase()) {
    const v = withSpaces.replace(/[^a-z0-9]/g, "")
    if (v && v !== n) variants.push(v)
  }
  return [...new Set(variants)]
}
