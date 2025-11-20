/**
 * One-off: insert per-tenant classification signatures (former CANONICAL_ALIAS_MAP).
 *
 * Usage (from v0-login-page-clone-2, with DATABASE_URL or Cloud SQL env set):
 *   USER_ID=<uuid> npx tsx scripts/seed-user-classification-signatures.ts
 */

import { query, ensureMovementsSchema } from "../lib/db"

/** Mirrors the legacy hardcoded map — one INSERT per signature substring. */
const LEGACY_SEED: Array<{
  canonical_key: string
  alias_role: "customer" | "owner" | "vendor" | "bank" | "processor"
  signatures: string[]
}> = [
  {
    canonical_key: "example_customer_team",
    alias_role: "customer",
    signatures: ["EXAMPLE TEAM1234", "EXAMPLE CUSTOMER", "EXAMPLE TEAM"],
  },
  {
    canonical_key: "owner_account",
    alias_role: "owner",
    signatures: ["OWNER NAME", "OWNER TEST", "OWNER@EXAMPLE.COM"],
  },
  {
    canonical_key: "chase_corporate_card",
    alias_role: "bank",
    signatures: ["CHASE CREDIT CRD", "CHASE CARD", "CHASE CREDIT CARD"],
  },
]

async function main(): Promise<void> {
  const userId = process.env.USER_ID?.trim()
  if (!userId) {
    console.error("USER_ID env var is required (users.id UUID).")
    process.exit(1)
  }

  await ensureMovementsSchema()

  let inserted = 0
  for (const group of LEGACY_SEED) {
    for (const sig of group.signatures) {
      const signature = sig.trim().toUpperCase()
      if (signature.length < 2) continue
      await query(
        `INSERT INTO user_classification_signatures (user_id, signature, alias_role, canonical_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, signature) DO NOTHING`,
        [userId, signature, group.alias_role, group.canonical_key],
      )
      inserted++
    }
  }

  const { rows } = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM user_classification_signatures WHERE user_id = $1`,
    [userId],
  )
  console.log(`Done. Attempted inserts: ${inserted}. Rows for user: ${rows[0]?.c ?? "?"}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
