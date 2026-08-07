import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"
import { classifyMovements } from "@/lib/movement-classify"
import { tagMovements } from "@/lib/movement-tag-enrich"
import { scrubMovementText } from "@/lib/text-cleaner"
import { createErrorResponse, validateString, validateRequiredFields, validateMetadata } from "@/lib/api-utils"
import { log } from "@/lib/logger"

type Body = {
  movement_id?: string
  apply_to_related?: boolean
  reason?: string
  preview_only?: boolean
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json(createErrorResponse("Unauthorized"), { status: 401 })

  let body: Body
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(createErrorResponse("Invalid JSON body"), { status: 400 })
  }

  // Validate required fields
  const validation = validateRequiredFields(body, ["movement_id"])
  if (!validation.valid) {
    log("movements.unmerge.missing_fields", { userId: user.id, missingFields: validation.missingFields })
    return NextResponse.json(createErrorResponse(`Missing required fields: ${validation.missingFields.join(", ")}`), { status: 400 })
  }

  const movementId = validateString(body.movement_id, 1, 100)
  const applyToRelated = body.apply_to_related !== false
  const reason = validateString(body.reason, 1, 500) || "manual_unmerge"
  const previewOnly = body.preview_only === true

  if (!movementId) {
    return NextResponse.json(createErrorResponse("movement_id is required and must be non-empty"), { status: 400 })
  }

  await ensureMovementsSchema()

  const { rows: mRows } = await query<{
    id: string
    counterparty_entity_id: string | null
    counterparty_entity_type: string | null
    raw_description: string | null
    counterparty: string | null
    metadata: Record<string, unknown>
  }>(
    `SELECT id, counterparty_entity_id, counterparty_entity_type, raw_description, counterparty, metadata
     FROM movements WHERE id = $1 AND user_id = $2`,
    [movementId, user.id]
  )
  const movement = mRows[0]
  if (!movement) return NextResponse.json(createErrorResponse("Movement not found"), { status: 404 })
  if (!movement.counterparty_entity_id) {
    return NextResponse.json({ ok: true, affected: 0, reason: "movement has no resolved entity" })
  }

  const scrubbed = scrubMovementText(movement.raw_description, movement.counterparty)
  const aliasFromMeta = (movement.metadata?.alias_signature as string | undefined)?.trim() || null

  const { rows: aliasRows } = await query<{ alias: string }>(
    `SELECT alias FROM entity_aliases WHERE entity_id = $1`,
    [movement.counterparty_entity_id]
  )
  let offendingAlias = aliasFromMeta
  if (!offendingAlias) {
    let bestLen = 0
    for (const a of aliasRows) {
      const up = a.alias.toUpperCase()
      if (up.length >= 3 && scrubbed.includes(up) && up.length > bestLen) {
        bestLen = up.length
        offendingAlias = a.alias
      }
    }
  }
  if (!offendingAlias && movement.counterparty) offendingAlias = movement.counterparty

  if (offendingAlias && !previewOnly) {
    await query(
      `INSERT INTO entity_alias_blacklist (user_id, entity_id, alias, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, entity_id, alias) DO UPDATE SET reason = EXCLUDED.reason`,
      [user.id, movement.counterparty_entity_id, offendingAlias, reason]
    )
  }

  let affectedIds = [movementId]
  if (applyToRelated && offendingAlias) {
    const { rows: candidates } = await query<{
      id: string
      raw_description: string | null
      counterparty: string | null
      counterparty_entity_id: string | null
    }>(
      `SELECT id, raw_description, counterparty, counterparty_entity_id
       FROM movements
       WHERE user_id = $1 AND counterparty_entity_id = $2`,
      [user.id, movement.counterparty_entity_id]
    )
    const aliasUpper = offendingAlias.toUpperCase()
    affectedIds = candidates
      .filter((c) => scrubMovementText(c.raw_description, c.counterparty).includes(aliasUpper))
      .map((c) => c.id)
    if (!affectedIds.includes(movementId)) affectedIds.push(movementId)
  }

  if (previewOnly) {
    return NextResponse.json({
      ok: true,
      preview_only: true,
      affected: affectedIds.length,
      blacklisted_alias: offendingAlias,
    })
  }

  for (const id of affectedIds) {
    const { rows: metaRows } = await query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM movements WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    )
    const md = validateMetadata(metaRows[0]?.metadata ?? {})
    const reviewReasons = Array.isArray(md.review_reasons) ? [...(md.review_reasons as string[])] : []
    if (!reviewReasons.includes("unmerged_entity_alias")) reviewReasons.push("unmerged_entity_alias")
    const nextMeta = validateMetadata({
      ...md,
      review_reasons: reviewReasons,
      unmerged_alias: offendingAlias ?? null,
      unmerge_reason: reason,
    })
    await query(
      `UPDATE movements
       SET counterparty_entity_id = NULL,
           counterparty_entity_type = NULL,
           review_needed = true,
           metadata = $1::jsonb
       WHERE id = $2 AND user_id = $3`,
      [JSON.stringify(nextMeta), id, user.id]
    )
  }

  // Rebuild movement identity + tags so broken alias links do not come back.
  await classifyMovements(user.id)
  await tagMovements(user.id)

  return NextResponse.json({
    ok: true,
    affected: affectedIds.length,
    blacklisted_alias: offendingAlias,
  })
}
