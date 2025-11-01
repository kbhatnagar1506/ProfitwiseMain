/**
 * Canonical alias map — exact signature hits on scrubbed (uppercase) text
 * skip fuzzy/LLM for known high-value counterparties.
 */

export type AliasRole = "customer" | "owner" | "vendor" | "bank" | "processor"

export type CanonicalAliasEntry = {
  canonical_id: string
  role: AliasRole
  /** Substrings matched against scrubbed uppercase text (longest match wins). */
  signatures: string[]
}

/**
 * Curated defaults; extend per-tenant via DB/env in the future.
 * Signatures must be uppercase-friendly (we match on scrubbed uppercased text).
 */
export const CANONICAL_ALIAS_MAP: CanonicalAliasEntry[] = [
  {
    canonical_id: "sarah_katz_marlins",
    role: "customer",
    signatures: ["MARLINS TEAM5618", "SARAH KATZ", "MARLINS TEAM"],
  },
  {
    canonical_id: "jack_rubenstein",
    role: "owner",
    signatures: ["JACK S RUBENSTEIN", "JACK TEST", "JRUBY14@GMAIL"],
  },
  {
    canonical_id: "chase_corporate_card",
    role: "bank",
    signatures: ["CHASE CREDIT CRD", "CHASE CARD", "CHASE CREDIT CARD"],
  },
]

export type AliasMatch = {
  canonical_id: string
  role: AliasRole
  matched_signature: string
}

/**
 * Return first match by longest signature (reduces false positives).
 */
export function tryResolveCanonicalAlias(scrubbedUpper: string): AliasMatch | null {
  if (!scrubbedUpper || scrubbedUpper.length < 3) return null

  let best: AliasMatch | null = null
  let bestLen = 0

  for (const entry of CANONICAL_ALIAS_MAP) {
    for (const sig of entry.signatures) {
      const s = sig.toUpperCase()
      if (s.length < 3) continue
      if (scrubbedUpper.includes(s) && s.length > bestLen) {
        bestLen = s.length
        best = { canonical_id: entry.canonical_id, role: entry.role, matched_signature: s }
      }
    }
  }
  return best
}
