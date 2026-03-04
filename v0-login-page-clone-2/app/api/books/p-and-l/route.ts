import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"

export async function GET(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  if (!sessionToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const user = await getUserBySessionToken(sessionToken)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = user.id

  const url = new URL(req.url)
  const year = url.searchParams.get("year")
  const month = url.searchParams.get("month")
  const dateFrom = url.searchParams.get("dateFrom")
  const dateTo = url.searchParams.get("dateTo")

  let startDate: Date
  let endDate: Date

  if (year && month) {
    const y = parseInt(year)
    const m = parseInt(month)
    startDate = new Date(y, m - 1, 1)
    endDate = new Date(y, m, 0)
  } else if (dateFrom && dateTo) {
    startDate = new Date(dateFrom)
    endDate = new Date(dateTo)
  } else {
    const now = new Date()
    startDate = new Date(now.getFullYear(), now.getMonth(), 1)
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  }

  try {
    const result = await query(
      `
      WITH movements_in_period AS (
        SELECT 
          m.id,
          m.direction,
          m.amount,
          m.date,
          mt.economic_class,
          mt.tag_data,
          ma.id as attribution_id,
          ma.confidence,
          ma.component_type,
          ma.entity_id,
          COALESCE(ma.net_amount, m.amount) as attributed_amount
        FROM movements m
        LEFT JOIN movement_tags mt ON m.id = mt.movement_id
        LEFT JOIN movement_attributions ma ON m.id = ma.movement_id
        WHERE m.user_id = $1
          AND m.pnl_eligible = true
          AND m.date >= $2
          AND m.date <= $3
      ),
      revenue_items AS (
        SELECT 
          'customer_cash_in' as line_item,
          SUM(amount) as total_amount,
          COUNT(DISTINCT id) as transaction_count,
          AVG(COALESCE(confidence, 0.5)) as avg_confidence
        FROM movements_in_period
        WHERE direction = 'inflow'
          AND economic_class IN ('customer_cash_in', 'interest_income')
          AND attribution_id IS NOT NULL
        GROUP BY economic_class
        
        UNION ALL
        
        SELECT 
          'interest_income' as line_item,
          SUM(amount) as total_amount,
          COUNT(DISTINCT id) as transaction_count,
          AVG(COALESCE(confidence, 0.5)) as avg_confidence
        FROM movements_in_period
        WHERE direction = 'inflow'
          AND economic_class = 'interest_income'
          AND attribution_id IS NOT NULL
      ),
      cogs_items AS (
        SELECT 
          COALESCE(tag_data->>'vendor_name', 'Other COGS') as line_item,
          SUM(amount) as total_amount,
          COUNT(DISTINCT id) as transaction_count,
          AVG(COALESCE(confidence, 0.5)) as avg_confidence
        FROM movements_in_period
        WHERE direction = 'outflow'
          AND economic_class = 'vendor_cash_out'
          AND (tag_data->>'cost_type' = 'cogs' OR tag_data->>'cost_type' IS NULL)
          AND attribution_id IS NOT NULL
        GROUP BY tag_data->>'vendor_name'
      ),
      opex_items AS (
        SELECT 
          CASE 
            WHEN economic_class = 'bank_fee' THEN 'Bank Fees'
            WHEN economic_class = 'processor_fee' THEN 'Processor Fees'
            WHEN economic_class = 'vendor_cash_out' THEN COALESCE(tag_data->>'category', 'Other OpEx')
            ELSE 'Other OpEx'
          END as line_item,
          SUM(amount) as total_amount,
          COUNT(DISTINCT id) as transaction_count,
          AVG(COALESCE(confidence, 0.5)) as avg_confidence
        FROM movements_in_period
        WHERE direction = 'outflow'
          AND (
            economic_class IN ('bank_fee', 'processor_fee')
            OR (economic_class = 'vendor_cash_out' AND tag_data->>'cost_type' = 'opex')
          )
          AND attribution_id IS NOT NULL
        GROUP BY line_item
      ),
      suspense_items AS (
        SELECT 
          SUM(amount) as total_amount,
          COUNT(DISTINCT id) as transaction_count
        FROM movements_in_period
        WHERE attribution_id IS NULL
          OR confidence < 0.5
      ),
      totals AS (
        SELECT 
          COALESCE(SUM(CASE WHEN direction = 'inflow' THEN amount ELSE 0 END), 0) as gross_revenue,
          COALESCE(SUM(CASE WHEN direction = 'outflow' AND economic_class = 'vendor_cash_out' AND (tag_data->>'cost_type' = 'cogs' OR tag_data->>'cost_type' IS NULL) THEN amount ELSE 0 END), 0) as total_cogs,
          COALESCE(SUM(CASE WHEN direction = 'outflow' AND (economic_class IN ('bank_fee', 'processor_fee') OR (economic_class = 'vendor_cash_out' AND tag_data->>'cost_type' = 'opex')) THEN amount ELSE 0 END), 0) as total_opex
        FROM movements_in_period
        WHERE attribution_id IS NOT NULL
      )
      SELECT 
        $2::date as period_start,
        $3::date as period_end,
        (SELECT gross_revenue FROM totals) as gross_revenue,
        (SELECT total_cogs FROM totals) as total_cogs,
        (SELECT total_opex FROM totals) as total_opex,
        (SELECT total_amount FROM suspense_items) as suspense_amount,
        (SELECT transaction_count FROM suspense_items) as suspense_count,
        (SELECT json_agg(json_build_object('line_item', line_item, 'amount', total_amount, 'count', transaction_count, 'confidence', avg_confidence)) FROM revenue_items) as revenue_items,
        (SELECT json_agg(json_build_object('line_item', line_item, 'amount', total_amount, 'count', transaction_count, 'confidence', avg_confidence)) FROM cogs_items) as cogs_items,
        (SELECT json_agg(json_build_object('line_item', line_item, 'amount', total_amount, 'count', transaction_count, 'confidence', avg_confidence)) FROM opex_items) as opex_items
      `,
      [userId, startDate, endDate]
    )

    const row = result.rows[0]

    const grossRevenue = parseFloat(row.gross_revenue) || 0
    const totalCogs = parseFloat(row.total_cogs) || 0
    const totalOpex = parseFloat(row.total_opex) || 0
    const suspenseAmount = parseFloat(row.suspense_amount) || 0
    const suspenseCount = row.suspense_count || 0

    const grossProfit = grossRevenue - totalCogs
    const operatingIncome = grossProfit - totalOpex

    const status = Math.abs(suspenseAmount) > 0.01 ? "provisional" : "final"

    return NextResponse.json({
      period: {
        start: row.period_start,
        end: row.period_end,
        status,
      },
      revenue: {
        gross_revenue: grossRevenue,
        line_items: row.revenue_items || [],
      },
      cogs: {
        total_cogs: totalCogs,
        line_items: row.cogs_items || [],
      },
      gross_profit: grossProfit,
      operating_expenses: {
        total_opex: totalOpex,
        line_items: row.opex_items || [],
      },
      operating_income: operatingIncome,
      suspense: {
        amount: suspenseAmount,
        count: suspenseCount,
        status: status === "provisional" ? "provisional" : "reconciled",
      },
    })
  } catch (err) {
    console.error("P&L calculation error:", err)
    return NextResponse.json({ error: "Failed to calculate P&L" }, { status: 500 })
  }
}
