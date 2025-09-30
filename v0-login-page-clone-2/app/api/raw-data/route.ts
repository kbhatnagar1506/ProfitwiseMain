import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureGmailSchema } from "@/lib/db"
import { listPlaidItemIds } from "@/lib/plaid-item-store"
import { listRealmIdsByUserId } from "@/lib/quickbooks-token-store"
import { listTenantIdsByUserId } from "@/lib/xero-token-store"
import { listStripeAccountIdsByUserId } from "@/lib/stripe-token-store"
import { getEntitiesFromDb as getQboEntities } from "@/lib/qbo-entity-store"
import { getEntitiesFromDb as getXeroEntities } from "@/lib/xero-entity-store"
import { getStripeEntitiesFromDb } from "@/lib/stripe-entity-store"

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const userId = user.id

  // Plaid: 2 years of transactions and all accounts
  const plaidItems = await listPlaidItemIds(userId)
  const plaidAccounts = await query(
    `SELECT pa.*
     FROM plaid_accounts pa
     JOIN plaid_items pi ON pi.item_id = pa.item_id
     WHERE pi.user_id = $1
     ORDER BY pa.item_id, pa.account_id`,
    [userId]
  ).then((r) => r.rows)

  const plaidTransactions = await query(
    `SELECT pt.*
     FROM plaid_transactions pt
     JOIN plaid_items pi ON pi.item_id = pt.item_id
     WHERE pi.user_id = $1
       AND pt.date >= (CURRENT_DATE - INTERVAL '730 days')
     ORDER BY pt.date DESC, pt.amount DESC
     LIMIT 2000`,
    [userId]
  ).then((r) => r.rows)

  // QBO / Xero / Stripe raw entities
  const realmIds = await listRealmIdsByUserId(userId)
  const tenantIds = await listTenantIdsByUserId(userId)
  const stripeAccountIds = await listStripeAccountIdsByUserId(userId)

  const qbo: Record<string, unknown[]> = {}
  for (const realmId of realmIds) {
    const byType = await getQboEntities(realmId, undefined, { userId })
    for (const [type, items] of Object.entries(byType)) {
      if (!qbo[type]) qbo[type] = []
      qbo[type].push(...items)
    }
  }

  const xero: Record<string, unknown[]> = {}
  for (const tenantId of tenantIds) {
    const byType = await getXeroEntities(tenantId, undefined, { userId })
    for (const [type, items] of Object.entries(byType)) {
      if (!xero[type]) xero[type] = []
      xero[type].push(...items)
    }
  }

  const stripe: Record<string, unknown[]> = {}
  for (const acct of stripeAccountIds) {
    const byType = await getStripeEntitiesFromDb(acct, undefined, { userId })
    for (const [type, items] of Object.entries(byType)) {
      if (!stripe[type]) stripe[type] = []
      stripe[type].push(...items)
    }
  }

  // Gmail extracted docs (where extracted_invoice is present)
  let gmailExtracted: unknown[] = []
  try {
    // Ensure the gmail_synced_messages table has the extracted_invoice column before querying.
    await ensureGmailSchema()
    gmailExtracted = await query(
      `SELECT message_id, thread_id, from_email, to_emails, subject, date_sent, snippet, extracted_invoice
       FROM gmail_synced_messages
       WHERE extracted_invoice IS NOT NULL
       ORDER BY date_sent DESC NULLS LAST, synced_at DESC
       LIMIT 500`
    ).then((r) => r.rows)
  } catch {
    // If the column or table does not exist yet in this environment, just return an empty list
    gmailExtracted = []
  }

  return NextResponse.json({
    plaid: {
      items: plaidItems,
      accounts: plaidAccounts,
      transactions: plaidTransactions,
    },
    qbo,
    xero,
    stripe,
    gmail: {
      extracted: gmailExtracted,
    },
  })
}

