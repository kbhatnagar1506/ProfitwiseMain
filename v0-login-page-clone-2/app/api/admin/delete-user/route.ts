import { NextRequest, NextResponse } from "next/server"
import { ensureAuthSchema, query } from "@/lib/db"
import { log } from "@/lib/logger"

function getSecret(req: NextRequest): string {
  return req.headers.get("x-clean-db-secret") ?? ""
}

/** POST /api/admin/delete-user — delete a single user (and cascades) by email. Production only; requires x-clean-db-secret. */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    log("admin.delete-user.rejected", { reason: "not_production" }, "db")
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }

  if (req.nextUrl.searchParams.has("secret")) {
    log("admin.delete-user.rejected", { reason: "secret_in_url" }, "db")
    return NextResponse.json(
      { error: "Do not send the secret in the URL. Use the x-clean-db-secret header." },
      { status: 400 }
    )
  }

  const secret = getSecret(req)
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log(
      "admin.delete-user.unauthorized",
      { reason: expected ? "bad_secret" : "no_secret_configured" },
      "db"
    )
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { email?: string }
  try {
    body = (await req.json().catch(() => ({}))) as { email?: string }
  } catch {
    body = {}
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  if (!email) {
    return NextResponse.json({ error: "email is required in JSON body" }, { status: 400 })
  }

  try {
    await ensureAuthSchema()
    const userRes = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email])
    const user = userRes.rows[0]
    if (!user) {
      return NextResponse.json({ ok: true, email, deleted: 0 })
    }
    const userId = user.id

    // Delete dependent rows first to satisfy older schemas that may not have
    // ON DELETE CASCADE configured.
    await query("DELETE FROM plaid_items WHERE user_id = $1", [userId])
    await query("DELETE FROM qbo_connections WHERE user_id = $1", [userId])
    await query("DELETE FROM xero_connections WHERE user_id = $1", [userId])
    await query("DELETE FROM stripe_connections WHERE user_id = $1", [userId])
    await query("DELETE FROM merchant_tags WHERE user_id = $1", [userId])
    await query("DELETE FROM user_whatsapp WHERE user_id = $1", [userId])
    await query("DELETE FROM user_slack WHERE user_id = $1", [userId])
    await query("DELETE FROM sessions WHERE user_id = $1", [userId])

    const res = await query<{ id: string }>("DELETE FROM users WHERE id = $1 RETURNING id", [
      userId,
    ])
    const deleted = res.rows.length
    log("admin.delete-user.done", { email, userId, deleted }, "db")
    return NextResponse.json({ ok: true, email, deleted })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("admin.delete-user.failed", { email, error: message }, "db")
    return NextResponse.json({ error: "Delete failed", details: message }, { status: 500 })
  }
}

