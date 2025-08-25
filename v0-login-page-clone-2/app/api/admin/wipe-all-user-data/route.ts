import { NextRequest, NextResponse } from "next/server"
import {
  ensureAuthSchema,
  ensurePlaidSchema,
  ensureQBOSchema,
  ensureXeroSchema,
  ensureMerchantTagsSchema,
  ensureWhatsAppSchema,
  ensureSlackSchema,
  query,
} from "@/lib/db"
import { gcpDeleteScope } from "@/lib/entity-store-gcp"
import { log } from "@/lib/logger"

/**
 * POST /api/admin/wipe-all-user-data
 * Deletes all user data so you can test from a clean slate.
 * - Removes QBO/Xero entity files from GCP bucket (if used)
 * - Truncates: plaid_transactions, plaid_accounts, plaid_webhook_last, plaid_items,
 *   qbo_entities, qbo_sync_status, qbo_connections, xero_entities, xero_connections,
 *   merchant_tags, user_whatsapp, user_slack, slack_events_seen, sessions, users
 *
 * Auth: x-clean-db-secret header (or JSON body { "secret": "..." }).
 * Production only.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    log("admin.wipe-all.rejected", { reason: "not_production" }, "db")
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  if (req.nextUrl.searchParams.has("secret")) {
    log("admin.wipe-all.rejected", { reason: "secret_in_url" }, "db")
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
    log("admin.wipe-all.unauthorized", { reason: expected ? "bad_secret" : "no_secret_configured" }, "db")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await ensureAuthSchema()
    await ensurePlaidSchema()
    await ensureQBOSchema()
    await ensureXeroSchema()
    await ensureMerchantTagsSchema()
    await ensureWhatsAppSchema()
    await ensureSlackSchema()
  } catch (err) {
    log("admin.wipe-all.schema_failed", { error: err instanceof Error ? err.message : String(err) }, "db")
    return NextResponse.json({ error: "Schema setup failed" }, { status: 500 })
  }

  // Delete GCP entity data before truncating (we need realm_id/user_id and tenant_id/user_id)
  let bucketDeleted = 0
  try {
    const qboScopes = await query<{ realm_id: string; user_id: string }>(
      "SELECT realm_id, user_id FROM qbo_connections"
    )
    const xeroScopes = await query<{ tenant_id: string; user_id: string }>(
      "SELECT tenant_id, user_id FROM xero_connections"
    )
    for (const r of qboScopes.rows) {
      bucketDeleted += await gcpDeleteScope("qbo", r.realm_id, r.user_id)
    }
    for (const r of xeroScopes.rows) {
      bucketDeleted += await gcpDeleteScope("xero", r.tenant_id, r.user_id)
    }
  } catch (err) {
    log("admin.wipe-all.gcp_failed", { error: String(err) }, "db")
    // continue with DB truncate
  }

  // Truncate in dependency order (children first). CASCADE in case we missed a ref.
  const truncateSql = `
    TRUNCATE TABLE
      plaid_transactions,
      plaid_accounts,
      plaid_webhook_last,
      plaid_items,
      qbo_entities,
      qbo_sync_status,
      qbo_connections,
      xero_entities,
      xero_connections,
      merchant_tags,
      user_whatsapp,
      user_slack,
      slack_events_seen,
      sessions,
      users
    RESTART IDENTITY
    CASCADE
  `
  try {
    await query(truncateSql)
    log("admin.wipe-all.done", { bucketDeleted }, "db")
    return NextResponse.json({
      ok: true,
      message: "All user data wiped. You can sign up again and test from a clean slate.",
      bucket_files_deleted: bucketDeleted,
    })
  } catch (err) {
    log("admin.wipe-all.failed", { error: err instanceof Error ? err.message : String(err) }, "db")
    return NextResponse.json({ error: "Wipe failed", details: String(err) }, { status: 500 })
  }
}
