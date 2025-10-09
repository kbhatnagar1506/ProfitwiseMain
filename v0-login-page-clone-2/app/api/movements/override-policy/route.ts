import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"
import { tagMovements } from "@/lib/movement-tag-enrich"

type Body = {
  movement_id?: string
  override?: "include" | "exclude" | "clear"
  reason?: string
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: Body
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const movementId = (body.movement_id ?? "").trim()
  const override = body.override ?? "include"
  const reason = (body.reason ?? "manual_override").trim()
  if (!movementId) return NextResponse.json({ error: "movement_id is required" }, { status: 400 })

  await ensureMovementsSchema()

  // Ensure a tag row exists first; preserves deterministic fields.
  await tagMovements(user.id)

  const { rows } = await query<{ tag_data: Record<string, unknown> }>(
    `SELECT mt.tag_data
     FROM movement_tags mt
     JOIN movements m ON m.id = mt.movement_id
     WHERE m.id = $1 AND m.user_id = $2`,
    [movementId, user.id]
  )
  if (rows.length === 0) return NextResponse.json({ error: "Movement tag not found" }, { status: 404 })

  const prev = (rows[0].tag_data ?? {}) as Record<string, unknown>
  let next = { ...prev }
  if (override === "clear") {
    next = {
      ...next,
      is_user_overridden: false,
      user_override_policy_status: null,
      user_override_state_inclusion_policy: null,
      user_override_reason: reason,
      user_override_at: new Date().toISOString(),
    }
  } else {
    const policyStatus = override === "include" ? "included" : "excluded_for_review"
    const stateInclusionPolicy = override === "include" ? "include" : "exclude_and_review"
    next = {
      ...next,
      policy_status: policyStatus,
      state_inclusion_policy: stateInclusionPolicy,
      is_user_overridden: true,
      user_override_policy_status: policyStatus,
      user_override_state_inclusion_policy: stateInclusionPolicy,
      user_override_reason: reason,
      user_override_at: new Date().toISOString(),
    }
  }

  await query(
    `UPDATE movement_tags
     SET tag_data = $1::jsonb, updated_at = NOW()
     WHERE movement_id = $2`,
    [JSON.stringify(next), movementId]
  )

  // Re-tag to refresh aggregates; engine now preserves overrides when lock is set.
  await tagMovements(user.id)

  return NextResponse.json({ ok: true, movement_id: movementId, override })
}
