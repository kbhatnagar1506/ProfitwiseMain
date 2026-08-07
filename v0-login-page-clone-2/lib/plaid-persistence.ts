/**
 * Persist Plaid accounts (balances) and transactions to Postgres.
 */

import type { PlaidAccount } from "./plaid"
import { ensurePlaidSchema, query } from "./db"
import { log } from "./logger"

export type TransactionRow = {
  transaction_id: string
  account_id: string
  amount: number
  date: string
  name: string
  merchant_name: string | null
  category: string[] | null
  personal_finance_category: Record<string, string> | null
  payment_channel: string | null
  pending: boolean
}

export async function saveAccounts(itemId: string, accounts: PlaidAccount[]): Promise<void> {
  if (process.env.NODE_ENV !== "production") return
  try {
    await ensurePlaidSchema()
    for (const a of accounts) {
      await query(
        `INSERT INTO plaid_accounts (item_id, account_id, name, type, subtype, mask, current_balance, available_balance, currency_code, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (item_id, account_id) DO UPDATE SET
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype,
           mask = EXCLUDED.mask,
           current_balance = EXCLUDED.current_balance,
           available_balance = EXCLUDED.available_balance,
           currency_code = EXCLUDED.currency_code,
           updated_at = NOW()`,
        [
          itemId,
          a.account_id,
          a.name,
          a.type,
          a.subtype,
          a.mask,
          a.current_balance,
          a.available_balance,
          a.currency_code,
        ]
      )
    }
    log("plaid_accounts.saved", { itemId, count: accounts.length }, "plaid")
  } catch (err) {
    log("plaid_accounts.save.failed", { itemId, error: err instanceof Error ? err.message : String(err) }, "plaid")
    throw err
  }
}

function plaidTransactionToRow(t: {
  transaction_id: string
  account_id: string
  amount: number
  date: string
  name?: string | null
  merchant_name?: string | null
  category?: string[] | null
  personal_finance_category?: Record<string, string> | null
  payment_channel?: string | null
  pending?: boolean
}): TransactionRow {
  return {
    transaction_id: t.transaction_id,
    account_id: t.account_id,
    amount: t.amount,
    date: t.date,
    name: typeof t.name === "string" ? t.name : "",
    merchant_name: t.merchant_name ?? null,
    category: t.category ?? null,
    personal_finance_category: t.personal_finance_category ?? null,
    payment_channel: t.payment_channel ?? null,
    pending: t.pending ?? false,
  }
}

export async function upsertTransactions(itemId: string, transactions: TransactionRow[]): Promise<void> {
  if (process.env.NODE_ENV !== "production" || transactions.length === 0) return
  try {
    await ensurePlaidSchema()
    for (const t of transactions) {
      await query(
        `INSERT INTO plaid_transactions (item_id, account_id, transaction_id, amount, date, name, merchant_name, category, personal_finance_category, payment_channel, pending, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, NOW())
         ON CONFLICT (item_id, transaction_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           amount = EXCLUDED.amount,
           date = EXCLUDED.date,
           name = EXCLUDED.name,
           merchant_name = EXCLUDED.merchant_name,
           category = EXCLUDED.category,
           personal_finance_category = EXCLUDED.personal_finance_category,
           payment_channel = EXCLUDED.payment_channel,
           pending = EXCLUDED.pending`,
        [
          itemId,
          t.account_id,
          t.transaction_id,
          t.amount,
          t.date,
          t.name,
          t.merchant_name,
          t.category ? JSON.stringify(t.category) : null,
          t.personal_finance_category ? JSON.stringify(t.personal_finance_category) : null,
          t.payment_channel,
          t.pending,
        ]
      )
    }
  } catch (err) {
    log("plaid_transactions.upsert.failed", { itemId, count: transactions.length, error: err instanceof Error ? err.message : String(err) }, "plaid")
    throw err
  }
}

export async function deleteTransactions(itemId: string, transactionIds: string[]): Promise<void> {
  if (process.env.NODE_ENV !== "production" || transactionIds.length === 0) return
  try {
    await ensurePlaidSchema()
    await query(
      "DELETE FROM plaid_transactions WHERE item_id = $1 AND transaction_id = ANY($2::text[])",
      [itemId, transactionIds]
    )
  } catch (err) {
    log("plaid_transactions.delete.failed", { itemId, count: transactionIds.length, error: err instanceof Error ? err.message : String(err) }, "plaid")
    throw err
  }
}

/** Map Plaid API transaction objects to our row shape and persist added + modified. */
export function mapAndUpsert(itemId: string, added: unknown[], modified: unknown[]): Promise<void> {
  const toRow = (t: unknown): TransactionRow | null => {
    if (!t || typeof t !== "object") return null
    const o = t as Record<string, unknown>
    const transaction_id = typeof o.transaction_id === "string" ? o.transaction_id : null
    const account_id = typeof o.account_id === "string" ? o.account_id : null
    const amount = typeof o.amount === "number" ? o.amount : 0
    const date = typeof o.date === "string" ? o.date : ""
    if (!transaction_id || !account_id || !date) return null
    return plaidTransactionToRow({
      transaction_id,
      account_id,
      amount,
      date,
      name: typeof o.name === "string" ? o.name : null,
      merchant_name: typeof o.merchant_name === "string" ? o.merchant_name : null,
      category: Array.isArray(o.category) ? (o.category as string[]) : null,
      pending: o.pending === true,
    })
  }
  const rows: TransactionRow[] = []
  for (const t of added) {
    const r = toRow(t)
    if (r) rows.push(r)
  }
  for (const t of modified) {
    const r = toRow(t)
    if (r) rows.push(r)
  }
  return upsertTransactions(itemId, rows)
}

/** Map Plaid removed array to transaction_id list and delete. */
export function mapAndDelete(itemId: string, removed: unknown[]): Promise<void> {
  const ids: string[] = []
  for (const r of removed) {
    if (r && typeof r === "object" && typeof (r as Record<string, unknown>).transaction_id === "string") {
      ids.push((r as { transaction_id: string }).transaction_id)
    }
  }
  return deleteTransactions(itemId, ids)
}

export type AccountBalanceRow = {
  item_id: string
  account_id: string
  name: string
  type: string
  subtype: string | null
  mask: string | null
  current_balance: number | null
  available_balance: number | null
  currency_code: string | null
}

export type TransactionForUser = {
  transaction_id: string
  item_id: string
  account_id: string
  amount: number
  date: string
  name: string
  merchant_name: string | null
  category: string[] | null
}

export async function getTransactionsByUserId(
  userId: string,
  options?: { startDate?: string; endDate?: string; limit?: number }
): Promise<TransactionForUser[]> {
  if (process.env.NODE_ENV !== "production") return []
  try {
    await ensurePlaidSchema()
    const start = options?.startDate ?? new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const end = options?.endDate ?? new Date().toISOString().slice(0, 10)
    const limit = options?.limit ?? 500
    const { rows } = await query<TransactionForUser>(
      `SELECT pt.transaction_id, pt.item_id, pt.account_id, pt.amount, pt.date, pt.name, pt.merchant_name, pt.category
       FROM plaid_transactions pt
       JOIN plaid_items pi ON pi.item_id = pt.item_id
       WHERE pi.user_id = $1 AND pt.date >= $2 AND pt.date <= $3
       ORDER BY pt.date DESC, pt.amount DESC
       LIMIT $4`,
      [userId, start, end, limit]
    )
    return rows
  } catch {
    return []
  }
}

export async function getAccountsWithBalancesByUserId(userId: string): Promise<AccountBalanceRow[]> {
  if (process.env.NODE_ENV !== "production") return []
  try {
    await ensurePlaidSchema()
    const { rows } = await query<AccountBalanceRow>(
      `SELECT pa.item_id, pa.account_id, pa.name, pa.type, pa.subtype, pa.mask,
              pa.current_balance, pa.available_balance, pa.currency_code
       FROM plaid_accounts pa
       JOIN plaid_items pi ON pi.item_id = pa.item_id
       WHERE pi.user_id = $1
       ORDER BY pa.item_id, pa.account_id`,
      [userId]
    )
    return rows
  } catch {
    return []
  }
}
