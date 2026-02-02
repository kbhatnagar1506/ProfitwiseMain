import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type BankAccountRow = {
  account_id: string
  name: string | null
  type: string | null
  subtype: string | null
  mask: string | null
  current_balance: number | string | null
  available_balance: number | string | null
  currency_code: string | null
  item_id: string
  txn_count: number | string
  internal_transfer_count: number | string
  total_inflow: number | string | null
  total_outflow: number | string | null
  last_txn_date: string | null
}

type AccountEntityRow = {
  account_id: string
  canonical_name: string | null
}

export async function GET(request?: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("dashboard.bank-accounts.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id

    const accountRows = await query<BankAccountRow>(
      `SELECT
        pa.account_id,
        pa.name,
        pa.type,
        pa.subtype,
        pa.mask,
        pa.current_balance,
        pa.available_balance,
        pa.currency_code,
        pi.item_id,
        COALESCE(COUNT(CASE WHEN m.movement_type != 'internal_transfer' THEN 1 END), 0)::int AS txn_count,
        COALESCE(COUNT(CASE WHEN m.movement_type = 'internal_transfer' THEN 1 END), 0)::int AS internal_transfer_count,
        COALESCE(SUM(CASE WHEN m.direction='inflow' AND m.movement_type != 'internal_transfer' THEN m.amount ELSE 0 END), 0)::numeric AS total_inflow,
        COALESCE(SUM(CASE WHEN m.direction='outflow' AND m.movement_type != 'internal_transfer' THEN m.amount ELSE 0 END), 0)::numeric AS total_outflow,
        MAX(m.date) AS last_txn_date
      FROM plaid_accounts pa
      JOIN plaid_items pi ON pi.item_id = pa.item_id
      LEFT JOIN movements m ON m.cash_account_id = pa.account_id AND m.user_id = $1 AND m.duplicate_of IS NULL
      WHERE pi.user_id = $1
      GROUP BY pa.id, pa.account_id, pa.name, pa.type, pa.subtype, pa.mask, pa.current_balance, pa.available_balance, pa.currency_code, pi.item_id
      ORDER BY pa.current_balance DESC NULLS LAST`,
      [userId]
    ).then((r) => r.rows)

    // Fetch entity canonical names for accounts (if they've been linked/tagged)
    const accountIds = accountRows.map((r) => r.account_id)
    const entityNamesByAccount = new Map<string, string>()
    
    if (accountIds.length > 0) {
      const entityRows = await query<AccountEntityRow>(
        `SELECT DISTINCT ON (m.cash_account_id) m.cash_account_id AS account_id, e.canonical_name
         FROM movements m
         LEFT JOIN entities e ON e.id = m.counterparty_entity_id
         WHERE m.user_id = $1 AND m.cash_account_id = ANY($2) AND e.canonical_name IS NOT NULL
         ORDER BY m.cash_account_id, m.date DESC`,
        [userId, accountIds]
      ).then((r) => r.rows)
      
      for (const row of entityRows) {
        if (row.account_id && row.canonical_name && !entityNamesByAccount.has(row.account_id)) {
          entityNamesByAccount.set(row.account_id, row.canonical_name)
        }
      }
    }

    const accounts = accountRows.map((row) => ({
      account_id: row.account_id,
      name: row.name,
      normalized_name: entityNamesByAccount.get(row.account_id) || null,
      type: row.type,
      subtype: row.subtype,
      mask: row.mask,
      current_balance: row.current_balance ? parseFloat(String(row.current_balance)) : 0,
      available_balance: row.available_balance ? parseFloat(String(row.available_balance)) : 0,
      currency_code: row.currency_code || "USD",
      item_id: row.item_id,
      txn_count: parseInt(String(row.txn_count), 10),
      internal_transfer_count: parseInt(String(row.internal_transfer_count), 10),
      total_inflow: row.total_inflow ? parseFloat(String(row.total_inflow)) : 0,
      total_outflow: row.total_outflow ? parseFloat(String(row.total_outflow)) : 0,
      last_txn_date: row.last_txn_date,
    }))

    // Build 30-day sparkline: daily net change per account, walked back from current balance
    type DailyDelta = { cash_account_id: string; d: string; net: string }
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const sparkRows = accountIds.length > 0
      ? await query<DailyDelta>(
          `SELECT cash_account_id, date::text AS d,
                  SUM(CASE WHEN direction='inflow' THEN amount ELSE -amount END)::text AS net
           FROM movements
           WHERE user_id = $1 AND cash_account_id = ANY($2)
             AND duplicate_of IS NULL AND date >= $3
           GROUP BY cash_account_id, date
           ORDER BY cash_account_id, date`,
          [userId, accountIds, thirtyDaysAgo.toISOString().split("T")[0]]
        ).then((r) => r.rows)
      : []

    const balanceHistoryMap = new Map<string, number[]>()
    for (const acct of accounts) {
      const dailyDeltas = sparkRows
        .filter((r) => r.cash_account_id === acct.account_id)
        .map((r) => parseFloat(r.net))

      if (dailyDeltas.length < 2) {
        balanceHistoryMap.set(acct.account_id, [])
        continue
      }

      // Walk backwards from current balance to reconstruct daily closing balances
      const totalDelta = dailyDeltas.reduce((s, v) => s + v, 0)
      let running = acct.current_balance - totalDelta
      const points: number[] = []
      for (const delta of dailyDeltas) {
        running += delta
        points.push(Math.round(running * 100) / 100)
      }
      balanceHistoryMap.set(acct.account_id, points)
    }

    // Fetch last 10 transactions across all accounts for the Recent Activity ledger
    type RecentTxnRow = {
      id: string; date: string; direction: string; amount: string;
      counterparty: string | null; raw_description: string | null;
      cash_account_id: string | null; account_name: string | null;
      account_mask: string | null; entity_name: string | null;
    }
    const recentTxnRows = await query<RecentTxnRow>(
      `SELECT m.id, m.date::text, m.direction, m.amount::text,
              m.counterparty, m.raw_description, m.cash_account_id,
              pa.name AS account_name, pa.mask AS account_mask,
              e.canonical_name AS entity_name
       FROM movements m
       LEFT JOIN plaid_accounts pa ON pa.account_id = m.cash_account_id
       LEFT JOIN entities e ON e.id = m.counterparty_entity_id
       WHERE m.user_id = $1 AND m.duplicate_of IS NULL AND m.movement_type != 'internal_transfer'
       ORDER BY m.date DESC, m.created_at DESC
       LIMIT 10`,
      [userId]
    ).then((r) => r.rows)

    const recentTransactions = recentTxnRows.map((r) => ({
      id: r.id,
      date: r.date,
      direction: r.direction,
      amount: parseFloat(r.amount),
      display_name: r.entity_name || r.counterparty || r.raw_description || "Unknown",
      account_name: r.account_name,
      account_mask: r.account_mask,
    }))

    const accountsWithHistory = accounts.map((a) => ({
      ...a,
      balance_history: balanceHistoryMap.get(a.account_id) || [],
    }))

    const totals = {
      total_balance: accounts.reduce((sum, a) => sum + a.current_balance, 0),
      total_available: accounts.reduce((sum, a) => sum + a.available_balance, 0),
      account_count: accounts.length,
    }

    log("dashboard.bank-accounts.success", { userId, accountCount: accounts.length })

    return NextResponse.json({
      accounts: accountsWithHistory,
      totals,
      recent_transactions: recentTransactions,
    })
  } catch (error) {
    log("dashboard.bank-accounts.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch bank accounts" },
      { status: 500 }
    )
  }
}
