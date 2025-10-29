/**
 * POST /api/onboarding/after-identity
 * Called when user leaves Identity graph step (step 9).
 * 1. Sync entities to Supermemory
 * 2. Classify movements (background) + tag movements
 * Returns 202 immediately to avoid Heroku 30s timeout. Frontend polls /api/movements until done.
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema, ensureIdentitySchema } from "@/lib/db"
import { addEntitiesToSupermemory } from "@/lib/supermemory"
import { classifyMovements } from "@/lib/movement-classify"
import { tagMovements } from "@/lib/movement-tag-enrich"
import { log } from "@/lib/logger"

export async function POST() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await ensureIdentitySchema()
    await ensureMovementsSchema()

    // 1. Load entities + aliases, sync to Supermemory
    const entities = (
      await query<{ id: string; canonical_name: string }>(
        "SELECT id, canonical_name FROM entities WHERE user_id = $1",
        [user.id]
      )
    ).rows
    if (entities.length > 0) {
      const ids = entities.map((e) => e.id)
      const aliasRows = (
        await query<{ entity_id: string; alias: string }>(
          "SELECT entity_id, alias FROM entity_aliases WHERE entity_id = ANY($1)",
          [ids]
        )
      ).rows
      const aliasesByEntity = new Map<string, string[]>()
      for (const r of aliasRows) {
        const list = aliasesByEntity.get(r.entity_id) ?? []
        list.push(r.alias)
        aliasesByEntity.set(r.entity_id, list)
      }
      const entityHints = entities.map((e) => ({
        canonical_name: e.canonical_name,
        aliases: [e.canonical_name, ...(aliasesByEntity.get(e.id) ?? [])],
      }))
      await addEntitiesToSupermemory(user.id, entityHints)
    }

    // 2. Classify + tag in background (avoids Heroku 30s request timeout)
    classifyMovements(user.id)
      .then(() => tagMovements(user.id))
      .then(() => log("onboarding.after_identity.classify_done", { userId: user.id }, "onboarding"))
      .catch((err) =>
        log("onboarding.after_identity.classify_error", { userId: user.id, error: err instanceof Error ? err.message : String(err) }, "onboarding")
      )

    return NextResponse.json({ ok: true, status: "classifying" }, { status: 202 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
