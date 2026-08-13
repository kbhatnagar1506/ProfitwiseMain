/**
 * Tenant-scoped classification signatures: substring hits on scrubbed (uppercase) text
 * skip fuzzy/LLM for known high-value counterparties. Rows live in user_classification_signatures.
 */

import { query, ensureMovementsSchema } from "./db"

export type AliasRole = "customer" | "owner" | "vendor" | "bank" | "processor"

const ALIAS_ROLES: readonly AliasRole[] = ["customer", "owner", "vendor", "bank", "processor"]

function parseAliasRole(raw: string): AliasRole | null {
  const s = raw.toLowerCase().trim()
  return ALIAS_ROLES.includes(s as AliasRole) ? (s as AliasRole) : null
}

export type UserClassificationSignatureRow = {
  id: string
  user_id: string
  signature: string
  alias_role: AliasRole
  canonical_key: string
}

export type AliasMatch = {
  canonical_id: string
  role: AliasRole
  matched_signature: string
}

/**
 * Load per-tenant precedence signatures (one row per substring). Call once per classify run.
 */
export async function loadUserClassificationSignatures(userId: string): Promise<UserClassificationSignatureRow[]> {
  await ensureMovementsSchema()
  const { rows } = await query<{
    id: string
    user_id: string
    signature: string
    alias_role: string
    canonical_key: string
  }>(
    `SELECT id, user_id, signature, alias_role, canonical_key
     FROM user_classification_signatures
     WHERE user_id = $1`,
    [userId],
  )
  const out: UserClassificationSignatureRow[] = []
  for (const r of rows) {
    const role = parseAliasRole(r.alias_role)
    if (!role) continue
    out.push({
      id: r.id,
      user_id: r.user_id,
      signature: r.signature.trim().toUpperCase(),
      alias_role: role,
      canonical_key: r.canonical_key,
    })
  }
  return out
}

/**
 * Longest signature match wins (same semantics as former CANONICAL_ALIAS_MAP).
 */
export function tryResolveCanonicalAliasFromRows(
  scrubbedUpper: string,
  rows: UserClassificationSignatureRow[],
): AliasMatch | null {
  if (!scrubbedUpper || scrubbedUpper.length < 3 || rows.length === 0) return null

  let best: AliasMatch | null = null
  let bestLen = 0

  for (const row of rows) {
    const s = row.signature
    if (s.length < 3) continue
    if (scrubbedUpper.includes(s) && s.length > bestLen) {
      bestLen = s.length
      best = {
        canonical_id: row.canonical_key,
        role: row.alias_role,
        matched_signature: s,
      }
    }
  }
  return best
}
