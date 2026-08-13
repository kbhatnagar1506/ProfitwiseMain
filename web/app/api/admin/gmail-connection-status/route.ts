import { NextRequest, NextResponse } from "next/server"
import { ensureGmailSchema, query } from "@/lib/db"
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

    let latestMessages: Array<{
      message_id: string
      from_email: string | null
      to_emails: string | null
      subject: string | null
      date_sent: string | null
      snippet: string | null
      body_plain: string | null
      synced_at: string | null
    }> = []

    try {
      const { rows } = await query<{
        message_id: string
        from_email: string | null
        to_emails: string | null
        subject: string | null
        date_sent: Date | null
        snippet: string | null
        body_plain: string | null
        synced_at: Date | null
      }>(
        "SELECT message_id, from_email, to_emails, subject, date_sent, snippet, body_plain, synced_at FROM gmail_synced_messages ORDER BY synced_at DESC LIMIT 5"
      )
      latestMessages = rows.map((r) => ({
        message_id: r.message_id,
        from_email: r.from_email,
        to_emails: r.to_emails,
        subject: r.subject,
        date_sent: r.date_sent ? r.date_sent.toISOString() : null,
        snippet: r.snippet,
        body_plain: r.body_plain ?? null,
        synced_at: r.synced_at ? r.synced_at.toISOString() : null,
      }))
    } catch (err) {
      log(
        "admin.gmail-status.latest_messages_error",
        { error: err instanceof Error ? err.message : String(err) },
        "db"
      )
    }

    return NextResponse.json({
      connected: true,
      email: conn.email ?? null,
      has_refresh_token: !!conn.refresh_token,
      has_access_token: !!conn.access_token,
      expires_at: conn.expires_at ?? null,
      latest_messages: latestMessages,
    })
  } catch (e) {
    log("admin.gmail-status.error", { error: e instanceof Error ? e.message : String(e) }, "db")
    return NextResponse.json({ error: "Check failed", detail: String(e) }, { status: 500 })
  }
}
