import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMerchantTagsSchema, query } from "@/lib/db"
import { addMerchantOverrideToSupermemory } from "@/lib/supermemory"
import { log } from "@/lib/logger"

const TRANSACTION_TYPES = ["Recurring subscription", "Recurring (other)", "One-time"]

/**
 * PATCH /api/onboarding/merchants/update
 * Update one merchant's normalized_name, tag, transaction_type in DB and add to Supermemory.
 * Body: { account_id, raw_name, normalized_name, tag, transaction_type }
 */
export async function PATCH(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { account_id?: string; raw_name?: string; normalized_name?: string; tag?: string; transaction_type?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const account_id = typeof body.account_id === "string" ? body.account_id.trim() : ""
  const raw_name = typeof body.raw_name === "string" ? body.raw_name.trim() : ""
  const normalized_name = typeof body.normalized_name === "string" ? body.normalized_name.trim() : ""
  const tag = typeof body.tag === "string" ? body.tag.trim() : ""
  const transaction_type =
    typeof body.transaction_type === "string" && TRANSACTION_TYPES.includes(body.transaction_type)
      ? body.transaction_type
      : "One-time"

  if (!account_id || !raw_name) {
    return NextResponse.json({ error: "account_id and raw_name are required" }, { status: 400 })
  }
  if (!normalized_name || !tag) {
    return NextResponse.json({ error: "normalized_name and tag are required" }, { status: 400 })
  }

  try {
    await ensureMerchantTagsSchema()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("merchants.update.schema_failed", { userId: user.id, error: message }, "db")
    return NextResponse.json({ error: "Database unavailable" }, { status: 500 })
  }

  const { rows } = await query<{ id: string }>(
    `UPDATE merchant_tags
     SET normalized_name = $1, tag = $2, transaction_type = $3, updated_at = NOW()
     WHERE user_id = $4 AND account_id = $5 AND raw_name = $6
     RETURNING id`,
    [normalized_name, tag, transaction_type, user.id, account_id, raw_name]
  )

  if (rows.length === 0) {
    return NextResponse.json({ error: "Merchant not found" }, { status: 404 })
  }

  try {
    await addMerchantOverrideToSupermemory(user.id, account_id, raw_name, normalized_name, tag, transaction_type)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("merchants.update.supermemory_failed", { userId: user.id, error: message }, "supermemory")
    // still return 200 - DB was updated
  }

  return NextResponse.json({ ok: true })
}
