/**
 * POST /api/onboarding/after-identity
 * Called when user leaves Identity graph step (step 9).
 * 1. Sync entities to Supermemory
 * 2. Queue sync-initial-data job for async processing
 * Returns 202 immediately to avoid Heroku 30s timeout. Frontend polls /api/dashboard/sync-status until done.
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema, ensureIdentitySchema, ensureJobStatusSchema } from "@/lib/db"
import { addEntitiesToSupermemory } from "@/lib/supermemory"
import { log } from "@/lib/logger"

export async function POST() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await ensureIdentitySchema()
    await ensureMovementsSchema()
    await ensureJobStatusSchema()

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

    // 2. Queue sync-initial-data job (CRITICAL: pass only userId, not data)
    // Use require to avoid bundling Bull at build time
    const { queues } = require("@/lib/queue/bull-client")
    const { SyncInitialDataJob } = require("@/lib/queue/job-types")

    const job = await queues.syncInitialData.add(
      { userId: user.id } as SyncInitialDataJob,
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
      }
    )

    // Create initial job status record
    await query(
      `INSERT INTO job_status (job_id, user_id, status, step, progress, created_at, updated_at)
       VALUES ($1, $2, 'queued', 'fetching', 0, NOW(), NOW())`,
      [job.id, user.id]
    )

    log("onboarding.after_identity.sync_queued", { userId: user.id, jobId: job.id }, "onboarding")

    return NextResponse.json({ ok: true, status: "syncing", jobId: job.id }, { status: 202 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log("onboarding.after_identity.error", { userId: user.id, error: msg }, "onboarding")
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
