import { NextRequest, NextResponse } from "next/server"
import { ensureAuthSchema, query } from "@/lib/db"
import { log } from "@/lib/logger"

/**
 * One-time cleanup: truncates users and sessions so you can sign up again.
 * Only works in production. Send secret via header (x-clean-db-secret) or JSON body { "secret": "..." }.
 * Do not send the secret in the URL (logs/referrer risk).
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    log("admin.clean-auth-db.rejected", { reason: "not_production" }, "db")
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  if (req.nextUrl.searchParams.has("secret")) {
    log("admin.clean-auth-db.rejected", { reason: "secret_in_url" }, "db")
    return NextResponse.json(
      { error: "Do not send the secret in the URL. Use the x-clean-db-secret header or JSON body." },
      { status: 400 }
    )
  }
  let secret = req.headers.get("x-clean-db-secret") ?? ""
  if (!secret) {
    try {
      const body = await req.json().catch(() => ({}))
      secret = typeof (body as { secret?: string }).secret === "string" ? (body as { secret: string }).secret : ""
    } catch {
      // no body
    }
  }
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("admin.clean-auth-db.unauthorized", { reason: expected ? "bad_secret" : "no_secret_configured" }, "db")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    await ensureAuthSchema()
    await query("TRUNCATE sessions, users CASCADE")
    log("admin.clean-auth-db.done", undefined, "db")
    return NextResponse.json({ ok: true })
  } catch (err) {
    log("admin.clean-auth-db.failed", { pgErr: err }, "db")
    return NextResponse.json({ error: "Clean failed" }, { status: 500 })
  }
}
