import { NextRequest, NextResponse } from "next/server"
import {
  ensureAuthSchema,
  ensurePlaidSchema,
  ensureQBOSchema,
  ensureXeroSchema,
  ensureStripeSchema,
  ensureGmailSchema,
  ensureMerchantTagsSchema,
  ensureUnifiedInvoicesSchema,
  ensureInvoiceDocumentsSchema,
  query,
} from "@/lib/db"
import { gcpDeleteScope } from "@/lib/entity-store-gcp"
import { log } from "@/lib/logger"

/**
 * POST /api/admin/wipe-synced-data
 * Deletes all synced/derived data (unified invoices, AP/AR, documents, entity stores, etc.)
 * but KEEPS connections (QBO, Xero, Stripe, Gmail, Plaid items). Use to resync and show current user fresh data.
 *
 * Optional: ?userId=UUID or body { "userId": "UUID" } to wipe only that user's synced data.
 * If no userId, wipes synced data for all users.
 *
 * Auth: x-clean-db-secret header (or JSON body { "secret": "..." }). Production only.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    log("admin.wipe-synced.rejected", { reason: "not_production" }, "db")
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  if (req.nextUrl.searchParams.has("secret")) {
    log("admin.wipe-synced.rejected", { reason: "secret_in_url" }, "db")
    return NextResponse.json(
      { error: "Do not send the secret in the URL. Use the x-clean-db-secret header or JSON body." },
      { status: 400 }
    )
  }
  let secret = req.headers.get("x-clean-db-secret") ?? ""
  let userId: string | null = req.nextUrl.searchParams.get("userId") ?? null
  if (!secret || !userId && req.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await req.json().catch(() => ({})) as { secret?: string; userId?: string }
      if (body.secret) secret = body.secret
      if (body.userId) userId = body.userId
    } catch {
      // no body
    }
  }
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("admin.wipe-synced.unauthorized", { reason: expected ? "bad_secret" : "no_secret_configured" }, "db")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await ensureAuthSchema()
    await ensurePlaidSchema()
    await ensureQBOSchema()
    await ensureXeroSchema()
    await ensureStripeSchema()
    await ensureGmailSchema()
    await ensureMerchantTagsSchema()
    await ensureUnifiedInvoicesSchema()
    await ensureInvoiceDocumentsSchema()
  } catch (err) {
    log("admin.wipe-synced.schema_failed", { error: err instanceof Error ? err.message : String(err) }, "db")
    return NextResponse.json({ error: "Schema setup failed", details: String(err) }, { status: 500 })
  }

  let bucketDeleted = 0
  try {
    if (userId) {
      const qbo = await query<{ realm_id: string }>("SELECT realm_id FROM qbo_connections WHERE user_id = $1", [userId])
      const xero = await query<{ tenant_id: string }>("SELECT tenant_id FROM xero_connections WHERE user_id = $1", [userId])
      for (const r of qbo.rows) bucketDeleted += await gcpDeleteScope("qbo", r.realm_id, userId)
      for (const r of xero.rows) bucketDeleted += await gcpDeleteScope("xero", r.tenant_id, userId)
    } else {
      const qbo = await query<{ realm_id: string; user_id: string }>("SELECT realm_id, user_id FROM qbo_connections")
      const xero = await query<{ tenant_id: string; user_id: string }>("SELECT tenant_id, user_id FROM xero_connections")
      for (const r of qbo.rows) bucketDeleted += await gcpDeleteScope("qbo", r.realm_id, r.user_id)
      for (const r of xero.rows) bucketDeleted += await gcpDeleteScope("xero", r.tenant_id, r.user_id)
    }
  } catch (err) {
    log("admin.wipe-synced.gcp_failed", { error: String(err) }, "db")
  }

  const oneUser = !!userId

  try {
    if (oneUser) {
      // Delete in FK-safe order for one user
      await query(
        `DELETE FROM ap_ar_match_candidates
         WHERE invoice_document_version_id IN (
           SELECT id FROM invoice_document_versions WHERE invoice_document_id IN (
             SELECT id FROM invoice_documents WHERE user_id = $1
           )
         )`,
        [userId]
      )
      await query(
        "DELETE FROM invoice_document_versions WHERE invoice_document_id IN (SELECT id FROM invoice_documents WHERE user_id = $1)",
        [userId]
      )
      await query("DELETE FROM invoice_documents WHERE user_id = $1", [userId])
      await query("DELETE FROM ap_ar WHERE user_id = $1", [userId])
      await query("DELETE FROM counterparties WHERE user_id = $1", [userId])
      await query("DELETE FROM unified_invoices WHERE user_id = $1", [userId])
      await query(
        `DELETE FROM plaid_transactions
         WHERE account_id IN (SELECT id FROM plaid_accounts WHERE item_id IN (SELECT id FROM plaid_items WHERE user_id = $1))`,
        [userId]
      )
      await query(
        "DELETE FROM plaid_accounts WHERE item_id IN (SELECT id FROM plaid_items WHERE user_id = $1)",
        [userId]
      )
      await query(
        "DELETE FROM qbo_entities WHERE realm_id IN (SELECT realm_id FROM qbo_connections WHERE user_id = $1)",
        [userId]
      )
      await query(
        "DELETE FROM qbo_sync_status WHERE realm_id IN (SELECT realm_id FROM qbo_connections WHERE user_id = $1)",
        [userId]
      )
      await query(
        "DELETE FROM xero_entities WHERE tenant_id IN (SELECT tenant_id FROM xero_connections WHERE user_id = $1)",
        [userId]
      )
      await query("DELETE FROM stripe_entities WHERE user_id = $1", [userId])
      await query("DELETE FROM merchant_tags WHERE user_id = $1", [userId])
    } else {
      // Wipe all users' synced data
      await query("DELETE FROM ap_ar_match_candidates")
      await query("DELETE FROM invoice_document_versions")
      await query("DELETE FROM invoice_documents")
      await query("DELETE FROM ap_ar")
      await query("DELETE FROM counterparties")
      await query("DELETE FROM unified_invoices")
      await query("DELETE FROM plaid_transactions")
      await query("DELETE FROM plaid_accounts")
      await query("DELETE FROM qbo_entities")
      await query("DELETE FROM qbo_sync_status")
      await query("DELETE FROM xero_entities")
      await query("DELETE FROM stripe_entities")
      await query("DELETE FROM merchant_tags")
    }

    // Reset Gmail so pipeline will reprocess messages (no user_id on gmail_synced_messages)
    await query("UPDATE gmail_synced_messages SET processed_for_ap_ar = FALSE")

    log("admin.wipe-synced.done", { userId: userId ?? "all", bucketDeleted }, "db")
    return NextResponse.json({
      ok: true,
      message: oneUser
        ? "Synced data wiped for user. Connections kept. Resync to repopulate."
        : "All synced data wiped. Connections kept. Resync to repopulate.",
      userId: userId ?? undefined,
      bucket_files_deleted: bucketDeleted,
    })
  } catch (err) {
    log("admin.wipe-synced.failed", { error: err instanceof Error ? err.message : String(err) }, "db")
    return NextResponse.json({ error: "Wipe failed", details: String(err) }, { status: 500 })
  }
}
