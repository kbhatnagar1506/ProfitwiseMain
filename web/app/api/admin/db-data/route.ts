import { NextRequest, NextResponse } from "next/server"
import {
  ensureAuthSchema,
  ensurePlaidSchema,
  ensureQBOSchema,
  ensureXeroSchema,
  ensureStripeSchema,
  query,
} from "@/lib/db"
import { log } from "@/lib/logger"

/** GET /api/admin/db-data — returns counts and data from all tables. Production only; requires x-clean-db-secret header. */

function getSecret(req: NextRequest): string {
  return req.headers.get("x-clean-db-secret") ?? ""
}

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    log("admin.db-data.rejected", { reason: "not_production" }, "db")
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  if (req.nextUrl.searchParams.has("secret")) {
    log("admin.db-data.rejected", { reason: "secret_in_url" }, "db")
    return NextResponse.json(
      { error: "Do not send the secret in the URL. Use the x-clean-db-secret header." },
      { status: 400 }
    )
  }
  const secret = getSecret(req)
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("admin.db-data.unauthorized", { reason: expected ? "bad_secret" : "no_secret_configured" }, "db")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await ensureAuthSchema()
    await ensurePlaidSchema()
    await ensureXeroSchema()
    await ensureQBOSchema()
    await ensureStripeSchema()
  } catch (err) {
    log("admin.db-data.schema_failed", { error: err instanceof Error ? err.message : String(err) }, "db")
    return NextResponse.json({ error: "Schema failed" }, { status: 500 })
  }

  const out: Record<string, unknown> = {}

  try {
    const users = await query<{ id: string; email: string; onboarding_step: number | null; created_at: Date }>(
      "SELECT id, email, onboarding_step, created_at FROM users ORDER BY created_at DESC"
    )
    out.users = { count: users.rows.length, rows: users.rows }
  } catch (e) {
    out.users = { error: String(e) }
  }

  try {
    const sessions = await query<{ id: string; user_id: string; expires_at: Date }>(
      "SELECT id, user_id, expires_at FROM sessions ORDER BY expires_at DESC"
    )
    out.sessions = { count: sessions.rows.length, rows: sessions.rows }
  } catch (e) {
    out.sessions = { error: String(e) }
  }

  try {
    const plaidItems = await query<{ user_id: string; item_id: string; cursor: string | null; created_at: Date }>(
      "SELECT user_id, item_id, cursor, created_at FROM plaid_items ORDER BY created_at DESC"
    )
    out.plaid_items = { count: plaidItems.rows.length, rows: plaidItems.rows }
  } catch (e) {
    out.plaid_items = { error: String(e) }
  }

  try {
    const plaidAccounts = await query<{ item_id: string; account_id: string; name: string | null; type: string | null; current_balance: string | null; available_balance: string | null }>(
      "SELECT item_id, account_id, name, type, current_balance, available_balance FROM plaid_accounts ORDER BY item_id, account_id"
    )
    out.plaid_accounts = { count: plaidAccounts.rows.length, rows: plaidAccounts.rows }
  } catch (e) {
    out.plaid_accounts = { error: String(e) }
  }

  try {
    const plaidTx = await query<{ item_id: string; account_id: string; transaction_id: string; amount: string; date: string; name: string | null; merchant_name: string | null; category: unknown; pending: boolean; created_at: Date }>(
      "SELECT item_id, account_id, transaction_id, amount, date, name, merchant_name, category, pending, created_at FROM plaid_transactions ORDER BY date DESC, created_at DESC"
    )
    out.plaid_transactions = { count: plaidTx.rows.length, rows: plaidTx.rows }
  } catch (e) {
    out.plaid_transactions = { error: String(e) }
  }

  try {
    const xeroConn = await query<{ id: string; user_id: string; tenant_id: string; tenant_name: string | null; expires_at: Date | null; created_at: Date }>(
      "SELECT id, user_id, tenant_id, tenant_name, expires_at, created_at FROM xero_connections ORDER BY created_at DESC"
    )
    out.xero_connections = { count: xeroConn.rows.length, rows: xeroConn.rows }
  } catch (e) {
    out.xero_connections = { error: String(e) }
  }

  try {
    const xeroEnt = await query<{ tenant_id: string; entity_type: string; entity_id: string; data: unknown }>(
      "SELECT tenant_id, entity_type, entity_id, data FROM xero_entities ORDER BY entity_type, entity_id"
    )
    out.xero_entities = { count: xeroEnt.rows.length, rows: xeroEnt.rows }
  } catch (e) {
    out.xero_entities = { error: String(e) }
  }

  try {
    const qboConn = await query<{ id: string; user_id: string; realm_id: string; company_name: string | null; expires_at: Date | null; created_at: Date }>(
      "SELECT id, user_id, realm_id, company_name, expires_at, created_at FROM qbo_connections ORDER BY created_at DESC"
    )
    out.qbo_connections = { count: qboConn.rows.length, rows: qboConn.rows }
  } catch (e) {
    out.qbo_connections = { error: String(e) }
  }

  try {
    const qboEnt = await query<{ realm_id: string; entity_type: string; entity_id: string; data: unknown }>(
      "SELECT realm_id, entity_type, entity_id, data FROM qbo_entities ORDER BY entity_type, entity_id"
    )
    out.qbo_entities = { count: qboEnt.rows.length, rows: qboEnt.rows }
  } catch (e) {
    out.qbo_entities = { error: String(e) }
  }

  try {
    const stripeConn = await query<{
      id: string
      user_id: string
      stripe_user_id: string
      scope: string | null
      created_at: Date
    }>("SELECT id, user_id, stripe_user_id, scope, created_at FROM stripe_connections ORDER BY created_at DESC")
    out.stripe_connections = { count: stripeConn.rows.length, rows: stripeConn.rows }
  } catch (e) {
    out.stripe_connections = { error: String(e) }
  }

  try {
    const stripeEnt = await query<{
      stripe_account_id: string
      entity_type: string
      entity_id: string
      updated_at: Date
    }>("SELECT stripe_account_id, entity_type, entity_id, updated_at FROM stripe_entities ORDER BY entity_type, entity_id")
    const byType: Record<string, number> = {}
    for (const r of stripeEnt.rows) {
      byType[r.entity_type] = (byType[r.entity_type] ?? 0) + 1
    }
    out.stripe_entities = {
      count: stripeEnt.rows.length,
      by_type: byType,
      rows: stripeEnt.rows,
    }
  } catch (e) {
    out.stripe_entities = { error: String(e) }
  }

  return NextResponse.json(out)
}
