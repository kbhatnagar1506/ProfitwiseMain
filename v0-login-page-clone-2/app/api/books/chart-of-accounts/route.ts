import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMovementsSchema, query } from "@/lib/db"

// EconomicClass → GAAP account mapping
const ACCOUNT_MAP: Record<string, { code: string; name: string; group: string; type: string }> = {
  customer_receipt:      { code: "4001", name: "Customer Receipts",     group: "revenue",      type: "Revenue" },
  settlement_in:         { code: "4002", name: "Settlement Income",     group: "revenue",      type: "Revenue" },
  refund:                { code: "4003", name: "Refunds / Returns",      group: "revenue",      type: "Revenue" },
  interest:              { code: "4004", name: "Interest Income",        group: "revenue",      type: "Revenue" },
  vendor_payment:        { code: "5001", name: "Vendor Payments",        group: "expenses",     type: "Expense" },
  payroll:               { code: "5002", name: "Payroll",                group: "expenses",     type: "Expense" },
  bank_fee:              { code: "5003", name: "Bank Fees",              group: "expenses",     type: "Expense" },
  bank_fee_refund:       { code: "5004", name: "Bank Fee Refunds",       group: "expenses",     type: "Expense" },
  processor_fee:         { code: "5005", name: "Processor Fees",         group: "expenses",     type: "Expense" },
  tax:                   { code: "5006", name: "Taxes",                  group: "expenses",     type: "Expense" },
  debt_payment:          { code: "5007", name: "Debt Payments",          group: "expenses",     type: "Expense" },
  owner_contribution:    { code: "3001", name: "Owner Contributions",    group: "equity",       type: "Equity" },
  owner_draw:            { code: "3002", name: "Owner Draws",            group: "equity",       type: "Equity" },
  transfer:              { code: "9001", name: "Bank Transfers",         group: "nonOperating", type: "Non-Operating" },
  processor_payout:      { code: "9002", name: "Processor Payouts",      group: "nonOperating", type: "Non-Operating" },
  settlement_adjustment: { code: "9003", name: "Settlement Adjustments", group: "nonOperating", type: "Non-Operating" },
  opening_balance:       { code: "9004", name: "Opening Balances",       group: "nonOperating", type: "Non-Operating" },
  account_verification:  { code: "9005", name: "Account Verification",   group: "nonOperating", type: "Non-Operating" },
  system_adjustment:     { code: "9006", name: "System Adjustments",     group: "nonOperating", type: "Non-Operating" },
  unknown:               { code: "9999", name: "Suspense / Unclassified",group: "nonOperating", type: "Non-Operating" },
}

export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureMovementsSchema()

  const now = new Date()
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1)

  // Run all queries in parallel
  const [bankRows, arApRows, movementRows, trendRows] = await Promise.all([
    // Bank accounts (assets 1xxx)
    query<{ account_id: string; name: string; type: string; subtype: string; current_balance: string }>(
      `SELECT pa.account_id, pa.name, pa.type, pa.subtype, pa.current_balance::text
       FROM plaid_accounts pa
       JOIN plaid_items pi ON pi.item_id = pa.item_id
       WHERE pi.user_id = $1
       ORDER BY pa.name`,
      [user.id]
    ).then(r => r.rows),

    // AR/AP outstanding (assets 1100, liabilities 2001)
    query<{ event_type: string; total_outstanding: string; count: string }>(
      `SELECT event_type,
              SUM(outstanding_amount)::text AS total_outstanding,
              COUNT(*)::text AS count
       FROM cash_events
       WHERE user_id = $1 AND status != 'paid'
       GROUP BY event_type`,
      [user.id]
    ).then(r => r.rows),

    // P&L accounts (movements grouped by economic_class)
    query<{ economic_class: string; direction: string; total: string; count: string }>(
      `SELECT mt.economic_class,
              m.direction,
              SUM(m.amount)::text AS total,
              COUNT(*)::text AS count
       FROM movements m
       JOIN movement_tags mt ON mt.movement_id = m.id AND mt.user_id = m.user_id
       WHERE m.user_id = $1 AND m.duplicate_of IS NULL
       GROUP BY mt.economic_class, m.direction`,
      [user.id]
    ).then(r => r.rows),

    // Monthly trend per economic_class (last 12 months)
    query<{ economic_class: string; yr: string; mo: string; total: string }>(
      `SELECT mt.economic_class,
              EXTRACT(YEAR FROM m.date)::text AS yr,
              EXTRACT(MONTH FROM m.date)::text AS mo,
              SUM(m.amount)::text AS total
       FROM movements m
       JOIN movement_tags mt ON mt.movement_id = m.id AND mt.user_id = m.user_id
       WHERE m.user_id = $1 AND m.duplicate_of IS NULL AND m.date >= $2
       GROUP BY mt.economic_class, yr, mo
       ORDER BY yr, mo`,
      [user.id, twelveMonthsAgo]
    ).then(r => r.rows),
  ])

  // Build monthly trend map: economic_class → 12 monthly values
  const trendMap: Record<string, number[]> = {}
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1)
    const yr = d.getFullYear().toString()
    const mo = (d.getMonth() + 1).toString()
    for (const r of trendRows) {
      if (!trendMap[r.economic_class]) trendMap[r.economic_class] = Array(12).fill(0)
      if (r.yr === yr && r.mo === mo) trendMap[r.economic_class][i] = parseFloat(r.total)
    }
  }

  // Build movement balance map
  const balanceMap: Record<string, number> = {}
  for (const r of movementRows) {
    const key = r.economic_class
    const amt = parseFloat(r.total)
    balanceMap[key] = (balanceMap[key] ?? 0) + amt
  }

  // Build accounts from movement data
  const accountsByGroup: Record<string, unknown[]> = {
    assets: [], liabilities: [], equity: [], revenue: [], expenses: [], nonOperating: []
  }

  // Bank accounts → assets 1001+
  let bankCode = 1001
  for (const acct of bankRows) {
    accountsByGroup.assets.push({
      code: String(bankCode++),
      name: acct.name,
      type: `${acct.type} (${acct.subtype})`,
      balance: parseFloat(acct.current_balance ?? "0"),
      movement_count: null,
      monthly_trend: null,
      account_id: acct.account_id,
      group: "assets",
    })
  }

  // AR outstanding → assets 1100
  const arRow = arApRows.find(r => r.event_type === "ar")
  accountsByGroup.assets.push({
    code: "1100",
    name: "Accounts Receivable",
    type: "Receivable",
    balance: parseFloat(arRow?.total_outstanding ?? "0"),
    movement_count: parseInt(arRow?.count ?? "0"),
    monthly_trend: trendMap["customer_receipt"] ?? Array(12).fill(0),
    group: "assets",
    link: "/dashboard/invoices",
  })

  // AP outstanding → liabilities 2001
  const apRow = arApRows.find(r => r.event_type === "ap")
  accountsByGroup.liabilities.push({
    code: "2001",
    name: "Accounts Payable",
    type: "Payable",
    balance: parseFloat(apRow?.total_outstanding ?? "0"),
    movement_count: parseInt(apRow?.count ?? "0"),
    monthly_trend: trendMap["vendor_payment"] ?? Array(12).fill(0),
    group: "liabilities",
    link: "/dashboard/bills",
  })

  // P&L and other accounts from movement data
  const countMap: Record<string, number> = {}
  for (const r of movementRows) {
    const key = r.economic_class
    countMap[key] = (countMap[key] ?? 0) + parseInt(r.count)
  }

  for (const [econClass, acctDef] of Object.entries(ACCOUNT_MAP)) {
    if (econClass === "customer_receipt" || econClass === "vendor_payment") continue // already handled via cash_events
    const balance = balanceMap[econClass] ?? 0
    if (balance === 0 && (trendMap[econClass] ?? []).every(v => v === 0)) continue // skip empty accounts

    accountsByGroup[acctDef.group].push({
      code: acctDef.code,
      name: acctDef.name,
      type: acctDef.type,
      balance,
      movement_count: countMap[econClass] ?? 0,
      monthly_trend: trendMap[econClass] ?? Array(12).fill(0),
      group: acctDef.group,
    })
  }

  // Sort each group by code
  for (const grp of Object.values(accountsByGroup)) {
    ;(grp as { code: string }[]).sort((a, b) => a.code.localeCompare(b.code))
  }

  return NextResponse.json({
    assets: accountsByGroup.assets,
    liabilities: accountsByGroup.liabilities,
    equity: accountsByGroup.equity,
    revenue: accountsByGroup.revenue,
    expenses: accountsByGroup.expenses,
    nonOperating: accountsByGroup.nonOperating,
  })
}
