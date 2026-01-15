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

    // Get AR summary
    const arSummary = await query<{
      total_outstanding: string
      total_matched: string
      suspicious_count: string
      suspicious_amount: string
    }>(
      `SELECT
        SUM(ce.outstanding_amount) as total_outstanding,
        SUM(CASE WHEN ce.outstanding_amount <= 0 THEN ce.amount ELSE 0 END) as total_matched,
        COUNT(CASE WHEN ce.outstanding_amount > ce.amount * 0.5 THEN 1 END) as suspicious_count,
        SUM(CASE WHEN ce.outstanding_amount > ce.amount * 0.5 THEN ce.outstanding_amount ELSE 0 END) as suspicious_amount
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ar'`,
      [userId]
    ).then((r) => r.rows[0])

    // Get AP summary
    const apSummary = await query<{
      total_outstanding: string
      total_matched: string
      suspicious_count: string
      suspicious_amount: string
    }>(
      `SELECT
        SUM(ce.outstanding_amount) as total_outstanding,
        SUM(CASE WHEN ce.outstanding_amount <= 0 THEN ce.amount ELSE 0 END) as total_matched,
        COUNT(CASE WHEN ce.outstanding_amount > ce.amount * 0.5 THEN 1 END) as suspicious_count,
        SUM(CASE WHEN ce.outstanding_amount > ce.amount * 0.5 THEN ce.outstanding_amount ELSE 0 END) as suspicious_amount
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ap'`,
      [userId]
    ).then((r) => r.rows[0])

    // Get bank transactions with reconciliation status
    const bankTransactions = await query<ReconciliationDetail>(
      `SELECT
        m.id,
        CASE WHEN ma.id IS NOT NULL THEN 'reconciled' ELSE 'not_reconciled' END as status,
        m.direction,
        ABS(m.amount) as amount,
        ABS(m.amount) as gross_amount,
        0 as fee_amount,
        m.date,
        m.description,
        COALESCE(array_agg(DISTINCT ma.entity_id) FILTER (WHERE ma.entity_id IS NOT NULL), '{}') as linked_ar_ap,
        CASE 
          WHEN ma.id IS NOT NULL AND ABS(m.amount) = ABS(ma.net_applied) THEN 'matched'
          WHEN ma.id IS NOT NULL THEN 'partial'
          ELSE 'unmatched'
        END as match_type
       FROM movements m
       LEFT JOIN movement_allocations ma ON ma.movement_id = m.id AND ma.user_id = m.user_id
       WHERE m.user_id = $1 AND m.direction IN ('inflow', 'outflow')
       GROUP BY m.id, m.direction, m.amount, m.date, m.description, ma.id
       ORDER BY m.date DESC
       LIMIT 500`,
      [userId]
    ).then((r) => r.rows)

    const arOutstanding = parseFloat(String(arSummary?.total_outstanding || 0))
    const arMatched = parseFloat(String(arSummary?.total_matched || 0))
    const apOutstanding = parseFloat(String(apSummary?.total_outstanding || 0))
    const apMatched = parseFloat(String(apSummary?.total_matched || 0))

    const totalOutstanding = arOutstanding + apOutstanding
    const totalMatched = arMatched + apMatched
    const totalAmount = totalOutstanding + totalMatched

    const summary: ReconciliationSummary = {
      ar_total_outstanding: arOutstanding,
      ar_total_matched: arMatched,
      ar_match_rate: totalMatched > 0 ? Math.round((arMatched / (arMatched + arOutstanding)) * 100) : 0,
      ar_suspicious_count: parseInt(String(arSummary?.suspicious_count || 0), 10),
      ar_suspicious_amount: parseFloat(String(arSummary?.suspicious_amount || 0)),
      ap_total_outstanding: apOutstanding,
      ap_total_matched: apMatched,
      ap_match_rate: totalMatched > 0 ? Math.round((apMatched / (apMatched + apOutstanding)) * 100) : 0,
      ap_suspicious_count: parseInt(String(apSummary?.suspicious_count || 0), 10),
      ap_suspicious_amount: parseFloat(String(apSummary?.suspicious_amount || 0)),
      net_outstanding: arOutstanding - apOutstanding,
      overall_match_rate: totalAmount > 0 ? Math.round((totalMatched / totalAmount) * 100) : 0,
      total_fees: 0,
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
