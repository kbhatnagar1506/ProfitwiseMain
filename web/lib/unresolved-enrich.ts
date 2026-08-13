/**
 * Unresolved movement enrichment (plan #9).
 * Keyword-based enrichment for unknown_inflow, unknown_outflow, merchant_deposit_unresolved.
 * Examples: WAYFARER wire → known customer, DEPOSIT by amount, Zelle transfers.
 */

import type { CanonicalMovement } from "./movement-types"

export type UnresolvedEnrichment = {
  suggested_type?: string
  suggested_counterparty?: string
  confidence: number
  reason: string
}

// Wire codes / bank descriptors that may map to known counterparties (extensible)
// Format: regex or string pattern → entity name or null (null = use heuristic match)
const WIRE_CODE_PATTERNS: Array<{ pattern: RegExp | string; hint?: string }> = [
  { pattern: /\bWAYFARER\b/i, hint: "wire_code" },
  { pattern: /\bZELLE\b/i, hint: "p2p_transfer" },
  { pattern: /\bVENMO\b/i, hint: "p2p_transfer" },
  { pattern: /\bCASH\s*APP\b/i, hint: "p2p_transfer" },
]

// Zelle / P2P patterns → suggest internal_transfer or person-to-person
const ZELLE_PATTERNS = [
  /\bZELLE\b/i,
  /\bVENMO\b/i,
  /\bCASH\s*APP\b/i,
  /\bPOPMONEY\b/i,
]

export function enrichUnresolved(
  m: CanonicalMovement,
  knownAmounts?: Map<string, string[]>, // amount → counterparty names for DEPOSIT matching
): UnresolvedEnrichment | null {
  const desc = (m.raw_description ?? "").toLowerCase()
  const counterparty = (m.metadata?.counterparty as string) ?? ""

  // Zelle / P2P transfers → suggest transfer
  if (ZELLE_PATTERNS.some((p) => p.test(desc) || p.test(counterparty))) {
    return {
      suggested_type: "internal_transfer",
      confidence: 0.7,
      reason: "Zelle/Venmo/Cash App pattern",
    }
  }

  // DEPOSIT by amount: if we have recurring deposit amounts, match
  if (m.direction === "inflow" && /\b(deposit|dep)\b/i.test(desc) && knownAmounts) {
    const amtKey = Math.abs(m.amount).toFixed(2)
    const known = knownAmounts.get(amtKey)
    if (known && known.length > 0) {
      return {
        suggested_type: "merchant_deposit_resolved",
        suggested_counterparty: known[0],
        confidence: 0.65,
        reason: `Amount matches known deposit (${known[0]})`,
      }
    }
  }

  // Wire code: all-caps single word often a bank wire identifier
  // Try to match via WIRE_CODE_PATTERNS for future extensibility
  const wireMatch = WIRE_CODE_PATTERNS.find(({ pattern }) =>
    typeof pattern === "string" ? desc.includes(pattern.toLowerCase()) : pattern.test(desc),
  )
  if (wireMatch?.hint === "wire_code") {
    // WAYFARER etc. — would need entity lookup; for now just flag
    return {
      confidence: 0.5,
      reason: "Wire/bank code detected — consider manual mapping",
    }
  }

  return null
}
