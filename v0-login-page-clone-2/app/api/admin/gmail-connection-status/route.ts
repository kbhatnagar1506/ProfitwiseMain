import { NextRequest, NextResponse } from "next/server"
import { ensureGmailSchema } from "@/lib/db"
import { getGmailConnection } from "@/lib/gmail-oauth"
import { log } from "@/lib/logger"

/** GET /api/admin/gmail-connection-status — did we receive and save the Gmail inbox connection? Uses app DB (Cloud SQL). Requires x-clean-db-secret header. */

function getSecret(req: NextRequest): string {
  return req.headers.get("x-clean-db-secret") ?? ""
}

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = getSecret(req)
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("admin.gmail-status.unauthorized", { reason: expected ? "bad_secret" : "no_secret_configured" }, "db")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await ensureGmailSchema()
    const conn = await getGmailConnection("inbox")
    if (!conn) {
      return NextResponse.json({ connected: false, email: null })
    }
    return NextResponse.json({
      connected: true,
      email: conn.email ?? null,
      has_refresh_token: !!conn.refresh_token,
      has_access_token: !!conn.access_token,
      expires_at: conn.expires_at ?? null,
    })
  } catch (e) {
    log("admin.gmail-status.error", { error: e instanceof Error ? e.message : String(e) }, "db")
    return NextResponse.json({ error: "Check failed", detail: String(e) }, { status: 500 })
  }
}
