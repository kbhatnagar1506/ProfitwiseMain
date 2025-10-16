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

// Hide test aliases from display (e.g. "foo test" -> "—")
const TEST_ALIAS_PATTERN = /\s+test$/i

// Common product/brand spacing fixes (avoid "Quick Books", "Docu Sign")
const CANONICAL_SPACING: Array<[RegExp, string]> = [
  [/\bQuick\s+Books\b/gi, "QuickBooks"],
  [/\bDocu\s*Sign\b/gi, "DocuSign"],
  [/\bMac\s+Lean\b/gi, "MacLean"],
  [/\bHuman\s+N\s+Professional\b/gi, "Human N Professional"],
]

/**
 * Display label: split concatenated tokens, fix canonical spacing, hide test aliases.
 * Preserve raw for audit; use this for canonical UI display only.
 */
export function displayLabelForCounterparty(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "—"
  if (TEST_ALIAS_PATTERN.test(raw.trim())) return "—"
  let out = splitCamelCase(raw)
  for (const [re, repl] of CANONICAL_SPACING) out = out.replace(re, repl)
  return out
    .replace(/\s+/g, " ")
    .replace(/\b([a-z])([A-Z][a-z])/g, "$1 $2")
    .replace(/\b([A-Z][a-z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
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
