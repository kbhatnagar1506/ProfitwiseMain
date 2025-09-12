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
    return NextResponse.json({ entities: [], aliases: [], relationships: [], assertionCounts: [] })
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

  // Compute per-entity evidence summary for the frontend
  const aliasArr = aliases as { entity_id: string; alias_type: string; source: string }[]
  const evidenceMap: Record<string, { source_count: number; evidence_count: number; sources: string[] }> = {}
  for (const a of aliasArr) {
    if (!evidenceMap[a.entity_id]) evidenceMap[a.entity_id] = { source_count: 0, evidence_count: 0, sources: [] }
    evidenceMap[a.entity_id].evidence_count++
    if (!evidenceMap[a.entity_id].sources.includes(a.source)) {
      evidenceMap[a.entity_id].sources.push(a.source)
    }
  }
  for (const key of Object.keys(evidenceMap)) {
    evidenceMap[key].source_count = evidenceMap[key].sources.length
  }

  const enrichedEntities = (entities as Record<string, unknown>[]).map((e) => ({
    ...e,
    source_count: evidenceMap[(e as { id: string }).id]?.source_count ?? 0,
    evidence_count: evidenceMap[(e as { id: string }).id]?.evidence_count ?? 0,
    sources: evidenceMap[(e as { id: string }).id]?.sources ?? [],
  }))

  return NextResponse.json({
    entities: enrichedEntities,
    aliases,
    relationships,
    assertionCounts,
  })
}
