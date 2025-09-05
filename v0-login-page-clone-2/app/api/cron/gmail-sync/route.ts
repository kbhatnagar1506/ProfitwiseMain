import { NextRequest, NextResponse } from "next/server"
import { runGmailSync } from "@/lib/gmail-sync"
import { runGmailInvoicePipeline } from "@/lib/gmail-invoice-pipeline"
import { log } from "@/lib/logger"

/**
 * POST /api/cron/gmail-sync
 * 1. Fetches recent Gmail messages and stores them in gmail_synced_messages.
 * 2. Runs invoice/bill extraction (LLM) and upserts into AP/AR for unprocessed messages.
 * Auth: x-clean-db-secret header. Production only.
 * Optional params: q, maxMessages; processInvoices (default true) to run AP/AR extraction.
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

  const q = req.nextUrl.searchParams.get("q") ?? "newer_than:1h"
  const maxMessages = Math.min(500, Math.max(1, parseInt(req.nextUrl.searchParams.get("maxMessages") ?? "200", 10) || 200))
  const processInvoices = req.nextUrl.searchParams.get("processInvoices") !== "false"

  try {
    const result = await runGmailSync({ q, maxMessages })
    let invoiceResult: { processed: number; extracted: number; errors: number } | null = null
    if (processInvoices) {
      invoiceResult = await runGmailInvoicePipeline({ limit: 15 })
    }
    return NextResponse.json({ ok: true, sync: result, invoices: invoiceResult })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("cron.gmail-sync.failed", { error: message }, "gmail")
    return NextResponse.json({ error: "Sync failed", detail: message }, { status: 500 })
  }
}
