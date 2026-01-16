import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type ReconciliationSummary = {
  ar_total_invoiced: number
  ar_total_outstanding: number
  ar_total_matched: number
  ar_match_rate: number
  ar_suspicious_count: number
  ar_suspicious_amount: number
  ap_total_billed: number
  ap_total_outstanding: number
  ap_total_matched: number
  ap_match_rate: number
  ap_suspicious_count: number
  ap_suspicious_amount: number
  net_outstanding: number
  overall_match_rate: number
  total_fees: number
  bank_reconciled_count: number
  bank_unreconciled_count: number
  bank_partial_count: number
  ar_invoices: ARInvoice[]
  ap_bills: APBill[]
}

type ARInvoice = {
  id: string
  customer_name: string
  source: string
  due_date: string
  status: "open" | "paid" | "overdue"
  bank_match: "matched" | "partial" | "unmatched"
  amount: number
  matched_amount: number
}

type APBill = {
  id: string
  vendor_name: string
  source: string
  due_date: string
  status: "open" | "paid" | "overdue"
  bank_match: "matched" | "partial" | "unmatched"
  amount: number
  matched_amount: number
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

    // Get AR totals from cash_events (source of truth for invoices)
    const arCashEvents = await query<{
      total_invoiced: string
      total_outstanding: string
      total_paid: string
    }>(
      `SELECT
        SUM(ce.amount)::text as total_invoiced,
        SUM(ce.outstanding_amount)::text as total_outstanding,
        SUM(CASE WHEN ce.outstanding_amount <= 0 THEN ce.amount ELSE 0 END)::text as total_paid
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ar' AND ce.status NOT IN ('cancelled', 'voided')`,
      [userId]
    ).then((r) => r.rows[0])

    // Get AP totals from cash_events (source of truth for bills)
    const apCashEvents = await query<{
      total_billed: string
      total_outstanding: string
      total_paid: string
    }>(
      `SELECT
        SUM(ce.amount)::text as total_billed,
        SUM(ce.outstanding_amount)::text as total_outstanding,
        SUM(CASE WHEN ce.outstanding_amount <= 0 THEN ce.amount ELSE 0 END)::text as total_paid
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ap' AND ce.status NOT IN ('cancelled', 'voided')`,
      [userId]
    ).then((r) => r.rows[0])

    // Get AR matched amounts from movement_attributions (reconciliation output)
    const arMatched = await query<{ total_matched: string; count: string }>(
      `SELECT
        SUM(ABS(ma.net_amount::float))::text as total_matched,
        COUNT(DISTINCT ma.entity_id)::text as count
       FROM movement_attributions ma
       WHERE ma.user_id = $1 AND ma.component_type = 'ar'`,
      [userId]
    ).then((r) => r.rows[0])

    // Get AP matched amounts from movement_attributions (reconciliation output)
    const apMatched = await query<{ total_matched: string; count: string }>(
      `SELECT
        SUM(ABS(ma.net_amount::float))::text as total_matched,
        COUNT(DISTINCT ma.entity_id)::text as count
       FROM movement_attributions ma
       WHERE ma.user_id = $1 AND ma.component_type = 'ap'`,
      [userId]
    ).then((r) => r.rows[0])

    // Get fee data
    const feeData = await query<{ total_fees: string }>(
      `SELECT
        SUM(ABS(ma.net_amount::float))::text as total_fees
       FROM movement_attributions ma
       WHERE ma.user_id = $1 AND ma.component_type = 'fee'`,
      [userId]
    ).then((r) => r.rows[0])

    // Get suspicious activity (large unmatched amounts)
    const suspiciousAR = await query<{ count: string; amount: string }>(
      `SELECT
        COUNT(*)::text as count,
        SUM(ce.outstanding_amount)::text as amount
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ar' AND ce.outstanding_amount > 1000`,
      [userId]
    ).then((r) => r.rows[0])

    const suspiciousAP = await query<{ count: string; amount: string }>(
      `SELECT
        COUNT(*)::text as count,
        SUM(ce.outstanding_amount)::text as amount
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ap' AND ce.outstanding_amount > 1000`,
      [userId]
    ).then((r) => r.rows[0])

    // Get bank transactions with reconciliation status from movement_attributions
    const bankTransactions = await query<ReconciliationDetail>(
      `SELECT
        m.id,
        CASE 
          WHEN COUNT(ma.id) > 0 AND ABS(m.amount) = SUM(ABS(COALESCE(CASE WHEN ma.component_type != 'fee' THEN ma.net_amount::float ELSE 0 END, 0))) THEN 'reconciled'
          ELSE 'not_reconciled'
        END as status,
        m.direction,
        ABS(m.amount) as amount,
        ABS(m.amount) as gross_amount,
        SUM(CASE WHEN ma.component_type = 'fee' THEN ABS(ma.net_amount::float) ELSE 0 END)::float as fee_amount,
        m.date,
        COALESCE(m.counterparty, m.raw_description, 'Bank Transaction') as description,
        COALESCE(array_agg(DISTINCT ma.entity_id) FILTER (WHERE ma.entity_id IS NOT NULL), '{}') as linked_ar_ap,
        CASE 
          WHEN COUNT(ma.id) > 0 AND ABS(m.amount) = SUM(ABS(COALESCE(CASE WHEN ma.component_type != 'fee' THEN ma.net_amount::float ELSE 0 END, 0))) THEN 'matched'
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

    // Get AR invoices with reconciliation status
    const arInvoices = await query<ARInvoice>(
      `SELECT
        ce.id,
        COALESCE(e.canonical_name, ce.entity_name, 'Unknown Customer') as customer_name,
        'qbo' as source,
        ce.due_date,
        CASE 
          WHEN ce.outstanding_amount <= 0 THEN 'paid'
          WHEN ce.due_date < NOW() THEN 'overdue'
          ELSE 'open'
        END as status,
        CASE 
          WHEN COUNT(ma.id) > 0 AND ABS(ce.amount) = SUM(ABS(COALESCE(ma.net_amount::float, 0))) THEN 'matched'
          WHEN COUNT(ma.id) > 0 THEN 'partial'
          ELSE 'unmatched'
        END as bank_match,
        ABS(ce.amount)::float as amount,
        SUM(ABS(COALESCE(ma.net_amount::float, 0)))::float as matched_amount
       FROM cash_events ce
       LEFT JOIN entities e ON e.id = ce.entity_id AND e.user_id = ce.user_id
       LEFT JOIN movement_attributions ma ON ma.entity_id = ce.entity_id AND ma.user_id = ce.user_id AND ma.component_type = 'ar'
       WHERE ce.user_id = $1 AND ce.event_type = 'ar' AND ce.status NOT IN ('cancelled', 'voided')
       GROUP BY ce.id, e.canonical_name, ce.entity_name, ce.due_date, ce.amount, ce.outstanding_amount
       ORDER BY ce.due_date DESC
       LIMIT 200`,
      [userId]
    ).then((r) => r.rows)

    // Get AP bills with reconciliation status
    const apBills = await query<APBill>(
      `SELECT
        ce.id,
        COALESCE(e.canonical_name, ce.entity_name, 'Unknown Vendor') as vendor_name,
        'qbo' as source,
        ce.due_date,
        CASE 
          WHEN ce.outstanding_amount <= 0 THEN 'paid'
          WHEN ce.due_date < NOW() THEN 'overdue'
          ELSE 'open'
        END as status,
        CASE 
          WHEN COUNT(ma.id) > 0 AND ABS(ce.amount) = SUM(ABS(COALESCE(ma.net_amount::float, 0))) THEN 'matched'
          WHEN COUNT(ma.id) > 0 THEN 'partial'
          ELSE 'unmatched'
        END as bank_match,
        ABS(ce.amount)::float as amount,
        SUM(ABS(COALESCE(ma.net_amount::float, 0)))::float as matched_amount
       FROM cash_events ce
       LEFT JOIN entities e ON e.id = ce.entity_id AND e.user_id = ce.user_id
       LEFT JOIN movement_attributions ma ON ma.entity_id = ce.entity_id AND ma.user_id = ce.user_id AND ma.component_type = 'ap'
       WHERE ce.user_id = $1 AND ce.event_type = 'ap' AND ce.status NOT IN ('cancelled', 'voided')
       GROUP BY ce.id, e.canonical_name, ce.entity_name, ce.due_date, ce.amount, ce.outstanding_amount
       ORDER BY ce.due_date DESC
       LIMIT 200`,
      [userId]
    ).then((r) => r.rows)

    // Parse values with proper null handling
    const arInvoiced = arCashEvents?.total_invoiced ? parseFloat(String(arCashEvents.total_invoiced)) : 0
    const arOutstanding = arCashEvents?.total_outstanding ? parseFloat(String(arCashEvents.total_outstanding)) : 0
    const arPaid = arCashEvents?.total_paid ? parseFloat(String(arCashEvents.total_paid)) : 0
    const arMatchedAmount = arMatched?.total_matched ? parseFloat(String(arMatched.total_matched)) : 0

    const apBilled = apCashEvents?.total_billed ? parseFloat(String(apCashEvents.total_billed)) : 0
    const apOutstanding = apCashEvents?.total_outstanding ? parseFloat(String(apCashEvents.total_outstanding)) : 0
    const apPaid = apCashEvents?.total_paid ? parseFloat(String(apCashEvents.total_paid)) : 0
    const apMatchedAmount = apMatched?.total_matched ? parseFloat(String(apMatched.total_matched)) : 0

    const totalFees = feeData?.total_fees ? parseFloat(String(feeData.total_fees)) : 0
    const arSuspiciousCount = suspiciousAR?.count ? parseInt(String(suspiciousAR.count), 10) : 0
    const arSuspiciousAmount = suspiciousAR?.amount ? parseFloat(String(suspiciousAR.amount)) : 0
    const apSuspiciousCount = suspiciousAP?.count ? parseInt(String(suspiciousAP.count), 10) : 0
    const apSuspiciousAmount = suspiciousAP?.amount ? parseFloat(String(suspiciousAP.amount)) : 0

    // Calculate match rates
    const arMatchRate = arInvoiced > 0 ? Math.round((arMatchedAmount / arInvoiced) * 100) : 0
    const apMatchRate = apBilled > 0 ? Math.round((apMatchedAmount / apBilled) * 100) : 0
    const overallMatchRate = (arInvoiced + apBilled) > 0 ? Math.round(((arMatchedAmount + apMatchedAmount) / (arInvoiced + apBilled)) * 100) : 0

    // Count transaction statuses
    const reconciled = bankTransactions.filter((t) => t.status === "reconciled").length
    const partial = bankTransactions.filter((t) => t.match_type === "partial").length
    const unreconciled = bankTransactions.filter((t) => t.status === "not_reconciled").length

    const summary: ReconciliationSummary = {
      ar_total_invoiced: arInvoiced,
      ar_total_outstanding: arOutstanding,
      ar_total_matched: arMatchedAmount,
      ar_match_rate: arMatchRate,
      ar_suspicious_count: arSuspiciousCount,
      ar_suspicious_amount: arSuspiciousAmount,
      ap_total_billed: apBilled,
      ap_total_outstanding: apOutstanding,
      ap_total_matched: apMatchedAmount,
      ap_match_rate: apMatchRate,
      ap_suspicious_count: apSuspiciousCount,
      ap_suspicious_amount: apSuspiciousAmount,
      net_outstanding: arOutstanding - apOutstanding,
      overall_match_rate: overallMatchRate,
      total_fees: totalFees,
      bank_reconciled_count: reconciled,
      bank_unreconciled_count: unreconciled,
      bank_partial_count: partial,
      ar_invoices: arInvoices,
      ap_bills: apBills,
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
