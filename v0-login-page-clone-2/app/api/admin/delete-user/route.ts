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
    const res = await query<{ id: string }>("DELETE FROM users WHERE email = $1 RETURNING id", [
      email,
    ])
    const deleted = res.rows.length
    log("admin.delete-user.done", { email, deleted }, "db")
    return NextResponse.json({ ok: true, email, deleted })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("admin.delete-user.failed", { email, error: message }, "db")
    return NextResponse.json({ error: "Delete failed", details: message }, { status: 500 })
  }
}

