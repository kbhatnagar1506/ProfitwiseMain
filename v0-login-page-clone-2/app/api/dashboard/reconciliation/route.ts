import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type ReconciliationSummary = {
  ar_total_outstanding: number
  ar_total_matched: number
  ar_match_rate: number
  ar_suspicious_count: number
  ar_suspicious_amount: number
  ap_total_outstanding: number
  ap_total_matched: number
  ap_match_rate: number
  ap_suspicious_count: number
  ap_suspicious_amount: number
  net_outstanding: number
  overall_match_rate: number
  total_fees: number
  internal_transfers_count: number
  internal_transfers_amount: number
  bank_reconciled_count: number
  bank_unreconciled_count: number
}

type ReconciliationDetail = {
  id: string
  status: "reconciled" | "not_reconciled"
  direction: "inflow" | "outflow"
  amount: number
  gross_amount: number
  fee_amount: number
  date: string
  description: string
  linked_ar_ap: string[]
  match_type: "matched" | "partial" | "unmatched"
}

export async function GET(request?: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("dashboard.reconciliation.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id

    // Get AR summary from movement_attributions (actual reconciliation data)
    const arSummary = await query<{
      total_invoiced: string
      total_matched: string
      suspicious_count: string
      suspicious_amount: string
    }>(
      `SELECT
        COUNT(DISTINCT ma.entity_id) as total_invoiced,
        SUM(CASE WHEN ma.component_type = 'ar' THEN ABS(ma.net_amount::float) ELSE 0 END)::text as total_matched,
        COUNT(CASE WHEN ma.component_type = 'ar' AND ABS(ma.net_amount::float) > 1000 THEN 1 END)::text as suspicious_count,
        SUM(CASE WHEN ma.component_type = 'ar' AND ABS(ma.net_amount::float) > 1000 THEN ABS(ma.net_amount::float) ELSE 0 END)::text as suspicious_amount
       FROM movement_attributions ma
       WHERE ma.user_id = $1 AND ma.component_type = 'ar'`,
      [userId]
    ).then((r) => r.rows[0])

    // Get AP summary from movement_attributions (actual reconciliation data)
    const apSummary = await query<{
      total_billed: string
      total_matched: string
      suspicious_count: string
      suspicious_amount: string
    }>(
      `SELECT
        COUNT(DISTINCT ma.entity_id) as total_billed,
        SUM(CASE WHEN ma.component_type = 'ap' THEN ABS(ma.net_amount::float) ELSE 0 END)::text as total_matched,
        COUNT(CASE WHEN ma.component_type = 'ap' AND ABS(ma.net_amount::float) > 1000 THEN 1 END)::text as suspicious_count,
        SUM(CASE WHEN ma.component_type = 'ap' AND ABS(ma.net_amount::float) > 1000 THEN ABS(ma.net_amount::float) ELSE 0 END)::text as suspicious_amount
       FROM movement_attributions ma
       WHERE ma.user_id = $1 AND ma.component_type = 'ap'`,
      [userId]
    ).then((r) => r.rows[0])

    // Get bank transactions with reconciliation status from movement_attributions
    const bankTransactions = await query<ReconciliationDetail>(
      `SELECT
        m.id,
        CASE WHEN COUNT(ma.id) > 0 THEN 'reconciled' ELSE 'not_reconciled' END as status,
        m.direction,
        ABS(m.amount) as amount,
        ABS(m.amount) as gross_amount,
        SUM(CASE WHEN ma.component_type = 'fee' THEN ABS(ma.net_amount::float) ELSE 0 END)::float as fee_amount,
        m.date,
        COALESCE(m.counterparty, m.raw_description, 'Bank Transaction') as description,
        COALESCE(array_agg(DISTINCT ma.entity_id) FILTER (WHERE ma.entity_id IS NOT NULL), '{}') as linked_ar_ap,
        CASE 
          WHEN COUNT(ma.id) > 0 AND ABS(m.amount) = SUM(ABS(COALESCE(ma.net_amount::float, 0))) THEN 'matched'
          WHEN COUNT(ma.id) > 0 THEN 'partial'
          ELSE 'unmatched'
        END as match_type
       FROM movements m
       LEFT JOIN movement_attributions ma ON ma.movement_id = m.id AND ma.user_id = m.user_id
       WHERE m.user_id = $1 AND m.direction IN ('inflow', 'outflow') AND m.duplicate_of IS NULL
       GROUP BY m.id, m.direction, m.amount, m.date, m.counterparty, m.raw_description
       ORDER BY m.date DESC
       LIMIT 500`,
      [userId]
    ).then((r) => r.rows)

    // Get total AR/AP from cash_events for outstanding amounts
    const arCashEvents = await query<{ total_outstanding: string; total_amount: string }>(
      `SELECT
        SUM(ce.outstanding_amount)::text as total_outstanding,
        SUM(ce.amount)::text as total_amount
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ar'`,
      [userId]
    ).then((r) => r.rows[0])

    const apCashEvents = await query<{ total_outstanding: string; total_amount: string }>(
      `SELECT
        SUM(ce.outstanding_amount)::text as total_outstanding,
        SUM(ce.amount)::text as total_amount
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ap'`,
      [userId]
    ).then((r) => r.rows[0])

    // Get fee data
    const feeData = await query<{ total_fees: string; fee_count: string }>(
      `SELECT
        SUM(ABS(ma.net_amount::float))::text as total_fees,
        COUNT(*)::text as fee_count
       FROM movement_attributions ma
       WHERE ma.user_id = $1 AND ma.component_type = 'fee'`,
      [userId]
    ).then((r) => r.rows[0])

    const arMatched = parseFloat(String(arSummary?.total_matched || 0))
    const apMatched = parseFloat(String(apSummary?.total_matched || 0))
    const arOutstanding = parseFloat(String(arCashEvents?.total_outstanding || 0))
    const apOutstanding = parseFloat(String(apCashEvents?.total_outstanding || 0))
    const arTotal = parseFloat(String(arCashEvents?.total_amount || 0))
    const apTotal = parseFloat(String(apCashEvents?.total_amount || 0))
    const totalFees = parseFloat(String(feeData?.total_fees || 0))

    const totalOutstanding = arOutstanding + apOutstanding
    const totalMatched = arMatched + apMatched
    const totalAmount = arTotal + apTotal

    const summary: ReconciliationSummary = {
      ar_total_outstanding: arOutstanding,
      ar_total_matched: arMatched,
      ar_match_rate: arTotal > 0 ? Math.round((arMatched / arTotal) * 100) : 0,
      ar_suspicious_count: parseInt(String(arSummary?.suspicious_count || 0), 10),
      ar_suspicious_amount: parseFloat(String(arSummary?.suspicious_amount || 0)),
      ap_total_outstanding: apOutstanding,
      ap_total_matched: apMatched,
      ap_match_rate: apTotal > 0 ? Math.round((apMatched / apTotal) * 100) : 0,
      ap_suspicious_count: parseInt(String(apSummary?.suspicious_count || 0), 10),
      ap_suspicious_amount: parseFloat(String(apSummary?.suspicious_amount || 0)),
      net_outstanding: arOutstanding - apOutstanding,
      overall_match_rate: totalAmount > 0 ? Math.round(((arMatched + apMatched) / totalAmount) * 100) : 0,
      total_fees: totalFees,
      internal_transfers_count: 0,
      internal_transfers_amount: 0,
      bank_reconciled_count: bankTransactions.filter((t) => t.status === "reconciled").length,
      bank_unreconciled_count: bankTransactions.filter((t) => t.status === "not_reconciled").length,
    }

    log("dashboard.reconciliation.success", { userId, transactionCount: bankTransactions.length })

    return NextResponse.json({
      summary,
      transactions: bankTransactions,
    })
  } catch (error) {
    log("dashboard.reconciliation.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch reconciliation data" },
      { status: 500 }
    )
  }
}
