import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureIdentitySchema } from "@/lib/db"

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await ensureIdentitySchema()
  } catch {
    return NextResponse.json({ entities: [], aliases: [], relationships: [], assertions: [] })
  }

  const userId = user.id

  const entities = await query(
    `SELECT id, entity_type, canonical_name, display_name, domain, confidence, metadata, created_at
     FROM entities WHERE user_id = $1
     ORDER BY confidence DESC, canonical_name`,
    [userId]
  ).then((r) => r.rows)

  const entityIds = (entities as { id: string }[]).map((e) => e.id)

  let aliases: unknown[] = []
  let relationships: unknown[] = []
  let assertionCounts: unknown[] = []

  if (entityIds.length > 0) {
    aliases = await query(
      `SELECT id, entity_id, alias, alias_type, source, source_id, confidence
       FROM entity_aliases WHERE entity_id = ANY($1)
       ORDER BY confidence DESC`,
      [entityIds]
    ).then((r) => r.rows)

    relationships = await query(
      `SELECT id, from_entity_id, to_entity_id, relationship, confidence, evidence
       FROM entity_relationships
       WHERE from_entity_id = ANY($1) OR to_entity_id = ANY($1)
       ORDER BY confidence DESC`,
      [entityIds]
    ).then((r) => r.rows)

    assertionCounts = await query(
      `SELECT entity_id, assertion_type, source, COUNT(*)::int as count, AVG(score)::real as avg_score
       FROM identity_assertions
       WHERE entity_id = ANY($1)
       GROUP BY entity_id, assertion_type, source
       ORDER BY count DESC`,
      [entityIds]
    ).then((r) => r.rows)
  }

  return NextResponse.json({
    entities,
    aliases,
    relationships,
    assertionCounts,
  })
}
