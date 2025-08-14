import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureAuthSchema, ensureMerchantTagsSchema, ensurePlaidSchema, query } from "@/lib/db"

export type AccountingTransactionRow = {
  transaction_id: string
  account_id: string
  date: string
  created_at: string
  amount: number
  account_name: string
  raw_name: string
  normalized_name: string
  tag: string
  transaction_type: string
}

/**
 * GET /api/onboarding/merchants/transactions
 * Returns transactions for the current user with merchant tags and account name,
 * for the accounting section (date, time, amount, tagging in colors).
 */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    await ensureAuthSchema()
    await ensurePlaidSchema()
    await ensureMerchantTagsSchema()
  } catch {
    return NextResponse.json({ transactions: [] })
  }
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 200, 500)
  const startDate =
    req.nextUrl.searchParams.get("start") ?? new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const endDate = req.nextUrl.searchParams.get("end") ?? new Date().toISOString().slice(0, 10)

  const { rows } = await query<{
    transaction_id: string
    account_id: string
    date: string
    created_at: string
    amount: number
    account_name: string | null
    raw_name: string
    normalized_name: string | null
    tag: string | null
    transaction_type: string | null
  }>(
    `SELECT
       pt.transaction_id,
       pt.account_id,
       pt.date::text AS date,
       pt.created_at::text AS created_at,
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
     ORDER BY pt.date DESC, pt.created_at DESC, pt.amount DESC
     LIMIT $4`,
    [user.id, startDate, endDate, limit]
  )

  const transactions: AccountingTransactionRow[] = (rows ?? []).map((r) => ({
    transaction_id: r.transaction_id,
    account_id: r.account_id,
    date: r.date,
    created_at: r.created_at,
    amount: Number(r.amount),
    account_name: r.account_name ?? "—",
    raw_name: r.raw_name,
    normalized_name: r.normalized_name ?? r.raw_name,
    tag: r.tag ?? "Uncategorized",
    transaction_type: r.transaction_type ?? "One-time",
  }))
  return NextResponse.json({ transactions })
}
