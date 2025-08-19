import {
  ensureAuthSchema,
  ensurePlaidSchema,
  ensureMerchantTagsSchema,
  query,
} from "./db"
import { getAccountsWithBalancesByUserId } from "./plaid-persistence"
import { listRealmIdsByUserId } from "./quickbooks-token-store"
import { listTenantIdsByUserId } from "./xero-token-store"

const DEFAULT_DAYS = 60
const MAX_TRANSACTIONS = 150

/**
 * Fetches recent banking/accounting transactions with merchant tags for a user,
 * formatted as text for LLM context (e.g. WhatsApp, suggest).
 */
export async function getTransactionContextForUser(userId: string): Promise<string> {
  try {
    await ensureAuthSchema()
    await ensurePlaidSchema()
    await ensureMerchantTagsSchema()
  } catch {
    return ""
  }

  const startDate = new Date(Date.now() - DEFAULT_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const endDate = new Date().toISOString().slice(0, 10)

  const { rows } = await query<{
    date: string
    amount: number
    account_name: string | null
    raw_name: string
    normalized_name: string | null
    tag: string | null
    transaction_type: string | null
  }>(
    `SELECT
       pt.date::text AS date,
       pt.amount::float AS amount,
       pa.name AS account_name,
       COALESCE(pt.merchant_name, pt.name, '') AS raw_name,
       mt.normalized_name,
       mt.tag,
       COALESCE(mt.transaction_type, 'One-time') AS transaction_type
     FROM plaid_transactions pt
     JOIN plaid_items pi ON pi.item_id = pt.item_id
     LEFT JOIN plaid_accounts pa ON pa.item_id = pt.item_id AND pa.account_id = pt.account_id
     LEFT JOIN merchant_tags mt ON mt.user_id = pi.user_id
       AND mt.account_id = pt.account_id
       AND mt.raw_name = COALESCE(pt.merchant_name, pt.name, '')
     WHERE pi.user_id = $1 AND pt.date >= $2 AND pt.date <= $3 AND pt.pending = false
     ORDER BY pt.date DESC, pt.amount DESC
     LIMIT $4`,
    [userId, startDate, endDate, MAX_TRANSACTIONS]
  )

  if (!rows?.length) return ""

  const lines = rows.map((r) => {
    const date = r.date
    const account = r.account_name ?? "—"
    const merchant = (r.normalized_name ?? r.raw_name).trim() || r.raw_name
    const amount = Number(r.amount)
    const tag = r.tag ?? "Uncategorized"
    const type = r.transaction_type ?? "One-time"
    return `${date} | ${account} | ${merchant} | ${amount < 0 ? "" : "+"}${amount.toFixed(2)} | ${tag} | ${type}`
  })
  return `Recent transactions (date | account | merchant | amount | category | type):\n${lines.join("\n")}`
}

/**
 * Balances and connected accounts/integrations for a user, formatted for LLM context.
 */
export async function getBalancesAndConnectionsContextForUser(userId: string): Promise<string> {
  const parts: string[] = []
  try {
    const accounts = await getAccountsWithBalancesByUserId(userId)
    if (accounts.length > 0) {
      const lines = accounts.map((a) => {
        const cur = a.current_balance != null ? Number(a.current_balance).toFixed(2) : "—"
        const avail = a.available_balance != null ? Number(a.available_balance).toFixed(2) : "—"
        return `${a.name ?? a.account_id} (${a.type ?? "account"}): current ${cur}, available ${avail}${a.currency_code ? ` ${a.currency_code}` : ""}`
      })
      parts.push("Bank accounts and balances:\n" + lines.join("\n"))
    }
    const [tenantIds, realmIds] = await Promise.all([
      listTenantIdsByUserId(userId),
      listRealmIdsByUserId(userId),
    ])
    const connections: string[] = []
    if (tenantIds.length > 0) connections.push("Xero")
    if (realmIds.length > 0) connections.push("QuickBooks Online")
    if (connections.length > 0) {
      parts.push("Connected integrations: " + connections.join(", "))
    }
  } catch {
    // optional
  }
  return parts.join("\n\n")
}
