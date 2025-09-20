import { NextRequest, NextResponse } from "next/server"
import { runGmailSync } from "@/lib/gmail-sync"
import { log } from "@/lib/logger"

/**
 * POST /api/cron/gmail-sync
 * Fetches recent Gmail messages and stores them in gmail_synced_messages.
 * Auth: x-clean-db-secret header (same as admin). Production only.
 * Heroku Scheduler: run every hour with:
 *   curl -s -X POST -H "x-clean-db-secret: $(heroku config:get CLEAN_DB_SECRET -a profitwise-login-page)" https://dashboard.profitwise.app/api/cron/gmail-sync
 * Optional query params: q (Gmail search, e.g. newer_than:3600 for last hour), maxMessages (default 200).
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("cron.gmail-sync.unauthorized", undefined, "gmail")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const q = req.nextUrl.searchParams.get("q") ?? "newer_than:1h" // default: last 1 hour
  const maxMessages = Math.min(500, Math.max(1, parseInt(req.nextUrl.searchParams.get("maxMessages") ?? "200", 10) || 200))

  try {
    const result = await runGmailSync({ q, maxMessages })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("cron.gmail-sync.failed", { error: message }, "gmail")
    return NextResponse.json({ error: "Sync failed", detail: message }, { status: 500 })
  }
}
