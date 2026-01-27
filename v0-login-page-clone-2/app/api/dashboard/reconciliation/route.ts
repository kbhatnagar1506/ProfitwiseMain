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
  transfer_count: number
  fee_count: number
  operational_expense_count: number
  adjustment_count: number
  unclassified_count: number
  data_quality_score: number
  duplicate_count: number
  over_matched_count: number
  status_anomaly_count: number
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
  classification: "ar_invoice" | "ap_bill" | "internal_transfer" | "fee" | "operational_expense" | "adjustment" | "unclassified"
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
      total_count: string
    }>(
      `SELECT
        SUM(ce.amount)::text as total_invoiced,
        SUM(ce.outstanding_amount)::text as total_outstanding,
        SUM(CASE WHEN ce.outstanding_amount <= 0 THEN ce.amount ELSE 0 END)::text as total_paid,
        COUNT(*)::text as total_count
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ar' AND ce.status NOT IN ('cancelled', 'voided')`,
      [userId]
    ).then((r) => r.rows[0])

    // Get AP totals from cash_events (source of truth for bills)
    const apCashEvents = await query<{
      total_billed: string
      total_outstanding: string
      total_paid: string
      total_count: string
    }>(
      `SELECT
        SUM(ce.amount)::text as total_billed,
        SUM(ce.outstanding_amount)::text as total_outstanding,
        SUM(CASE WHEN ce.outstanding_amount <= 0 THEN ce.amount ELSE 0 END)::text as total_paid,
        COUNT(*)::text as total_count
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ap' AND ce.status NOT IN ('cancelled', 'voided')`,
      [userId]
    ).then((r) => r.rows[0])

    // Get AR matched amounts from movement_attributions (reconciliation output)
    // Count distinct invoices that have at least one match
    const arMatched = await query<{ total_matched: string; count: string }>(
      `SELECT
        COUNT(DISTINCT ce.id)::text as count,
        SUM(ABS(ce.amount))::text as total_matched
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ar' AND EXISTS (
         SELECT 1 FROM movement_attributions ma 
         WHERE ma.entity_id = ce.entity_id AND ma.user_id = ce.user_id AND ma.component_type = 'ar'
       )`,
      [userId]
    ).then((r) => r.rows[0])

    // Get AP matched amounts from movement_attributions (reconciliation output)
    // Count distinct bills that have at least one match
    const apMatched = await query<{ total_matched: string; count: string }>(
      `SELECT
        COUNT(DISTINCT ce.id)::text as count,
        SUM(ABS(ce.amount))::text as total_matched
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ap' AND EXISTS (
         SELECT 1 FROM movement_attributions ma 
         WHERE ma.entity_id = ce.entity_id AND ma.user_id = ce.user_id AND ma.component_type = 'ap'
       )`,
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

    // Phase 1: Data Quality Detection
    // 1.2 Detect duplicate transactions (same counterparty, amount, date within 24 hours)
    const duplicateDetection = await query<{ duplicate_count: string }>(
      `SELECT COUNT(*)::text as duplicate_count
       FROM (
         SELECT m1.id
         FROM movements m1
         JOIN movements m2 ON m1.user_id = m2.user_id 
           AND m1.counterparty = m2.counterparty 
           AND ABS(m1.amount - m2.amount) < 0.01
           AND ABS(m1.date::date - m2.date::date) <= 1
           AND m1.id < m2.id
           AND m1.duplicate_of IS NULL
           AND m2.duplicate_of IS NULL
         WHERE m1.user_id = $1
       ) duplicates`,
      [userId]
    ).then((r) => r.rows[0])

    // 1.3 Detect over-matching (matched amount > invoice/bill amount)
    const overMatchedDetection = await query<{ over_matched_count: string }>(
      `SELECT COUNT(DISTINCT ce.id)::text as over_matched_count
       FROM cash_events ce
       JOIN (
         SELECT entity_id, SUM(ABS(net_amount::float)) as total_matched
         FROM movement_attributions
         WHERE user_id = $1 AND component_type IN ('ar', 'ap')
         GROUP BY entity_id
       ) ma ON ce.entity_id = ma.entity_id
       WHERE ce.user_id = $1 
         AND ce.event_type IN ('ar', 'ap')
         AND ma.total_matched > ABS(ce.amount)`,
      [userId]
    ).then((r) => r.rows[0])

    // 1.1 Detect status anomalies (marked paid but has outstanding amount)
    const statusAnomalyDetection = await query<{ status_anomaly_count: string }>(
      `SELECT COUNT(*)::text as status_anomaly_count
       FROM cash_events ce
       WHERE ce.user_id = $1 
         AND ce.event_type IN ('ar', 'ap')
         AND ce.status = 'paid'
         AND ce.outstanding_amount > 0`,
      [userId]
    ).then((r) => r.rows[0])

    // Get classification counts from bank transactions
    const classificationCounts = await query<{
      transfer_count: string
      fee_count: string
      operational_expense_count: string
      adjustment_count: string
      unclassified_count: string
    }>(
      `SELECT
        SUM(CASE WHEN (COALESCE(m.raw_description, '') ILIKE '%TRANSFER DEBIT%' OR COALESCE(m.raw_description, '') ILIKE '%TRANSFER CREDIT%') THEN 1 ELSE 0 END)::text as transfer_count,
        SUM(CASE WHEN (COALESCE(m.raw_description, '') ILIKE '%FEE%' OR COALESCE(m.raw_description, '') ILIKE '%CHARGE%' OR COALESCE(m.raw_description, '') ILIKE '%MERCHANT BANKCD%') THEN 1 ELSE 0 END)::text as fee_count,
        SUM(CASE WHEN (
          COALESCE(m.raw_description, '') ILIKE '%Shopify%' OR COALESCE(m.raw_description, '') ILIKE '%Amazon%' OR COALESCE(m.raw_description, '') ILIKE '%Stripe%' OR
          COALESCE(m.raw_description, '') ILIKE '%SUBSCRIPTION%' OR COALESCE(m.raw_description, '') ILIKE '%MONTHLY%' OR COALESCE(m.raw_description, '') ILIKE '%ANNUAL%' OR
          COALESCE(m.raw_description, '') ILIKE '%AWS%' OR COALESCE(m.raw_description, '') ILIKE '%AZURE%' OR COALESCE(m.raw_description, '') ILIKE '%GOOGLE CLOUD%' OR
          COALESCE(m.raw_description, '') ILIKE '%WHOLESALE%' OR COALESCE(m.raw_description, '') ILIKE '%DISTRIBUTOR%' OR COALESCE(m.raw_description, '') ILIKE '%SUPPLIER%' OR
          COALESCE(m.raw_description, '') ILIKE '%RESTAURANT%' OR COALESCE(m.raw_description, '') ILIKE '%CAFE%' OR COALESCE(m.raw_description, '') ILIKE '%BAKERY%' OR
          COALESCE(m.raw_description, '') ILIKE '%CONSULTING%' OR COALESCE(m.raw_description, '') ILIKE '%ADVISORY%' OR COALESCE(m.raw_description, '') ILIKE '%LEGAL%' OR
          COALESCE(m.raw_description, '') ILIKE '%ACCOUNTING%' OR COALESCE(m.raw_description, '') ILIKE '%AUDIT%' OR COALESCE(m.raw_description, '') ILIKE '%TAX%' OR
          COALESCE(m.raw_description, '') ILIKE '%ELECTRIC%' OR COALESCE(m.raw_description, '') ILIKE '%GAS%' OR COALESCE(m.raw_description, '') ILIKE '%WATER%' OR
          COALESCE(m.raw_description, '') ILIKE '%PHONE%' OR COALESCE(m.raw_description, '') ILIKE '%MOBILE%' OR COALESCE(m.raw_description, '') ILIKE '%CARRIER%' OR
          COALESCE(m.raw_description, '') ILIKE '%INSURANCE%' OR COALESCE(m.raw_description, '') ILIKE '%PREMIUM%' OR COALESCE(m.raw_description, '') ILIKE '%POLICY%'
        ) THEN 1 ELSE 0 END)::text as operational_expense_count,
        0::text as adjustment_count,
        0::text as unclassified_count
       FROM movements m
       WHERE m.user_id = $1 AND m.direction IN ('inflow', 'outflow') AND m.duplicate_of IS NULL`,
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
        COALESCE(array_agg(DISTINCT ma.entity_id::text) FILTER (WHERE ma.entity_id IS NOT NULL), '{}') as linked_ar_ap,
        CASE 
          WHEN COUNT(ma.id) > 0 AND ABS(m.amount) = SUM(ABS(COALESCE(CASE WHEN ma.component_type != 'fee' THEN ma.net_amount::float ELSE 0 END, 0))) THEN 'matched'
          WHEN COUNT(ma.id) > 0 THEN 'partial'
          ELSE 'unmatched'
        END as match_type,
        CASE
          WHEN COALESCE(m.raw_description, '') ILIKE '%TRANSFER DEBIT%' OR COALESCE(m.raw_description, '') ILIKE '%TRANSFER CREDIT%' THEN 'internal_transfer'
          WHEN COALESCE(m.raw_description, '') ILIKE '%FEE%' OR COALESCE(m.raw_description, '') ILIKE '%CHARGE%' OR COALESCE(m.raw_description, '') ILIKE '%MERCHANT BANKCD%' THEN 'fee'
          WHEN COALESCE(m.raw_description, '') ILIKE '%Shopify%' OR COALESCE(m.raw_description, '') ILIKE '%Amazon%' OR COALESCE(m.raw_description, '') ILIKE '%Stripe%' THEN 'operational_expense'
          WHEN COALESCE(m.raw_description, '') ILIKE '%SUBSCRIPTION%' OR COALESCE(m.raw_description, '') ILIKE '%MONTHLY%' OR COALESCE(m.raw_description, '') ILIKE '%ANNUAL%' OR COALESCE(m.raw_description, '') ILIKE '%RECURRING%' THEN 'operational_expense'
          WHEN COALESCE(m.raw_description, '') ILIKE '%AWS%' OR COALESCE(m.raw_description, '') ILIKE '%AZURE%' OR COALESCE(m.raw_description, '') ILIKE '%GOOGLE CLOUD%' THEN 'operational_expense'
          WHEN COALESCE(m.raw_description, '') ILIKE '%WHOLESALE%' OR COALESCE(m.raw_description, '') ILIKE '%DISTRIBUTOR%' OR COALESCE(m.raw_description, '') ILIKE '%SUPPLIER%' THEN 'operational_expense'
          WHEN COALESCE(m.raw_description, '') ILIKE '%RESTAURANT%' OR COALESCE(m.raw_description, '') ILIKE '%CAFE%' OR COALESCE(m.raw_description, '') ILIKE '%BAKERY%' OR COALESCE(m.raw_description, '') ILIKE '%GROCERY%' THEN 'operational_expense'
          WHEN COALESCE(m.raw_description, '') ILIKE '%CONSULTING%' OR COALESCE(m.raw_description, '') ILIKE '%ADVISORY%' OR COALESCE(m.raw_description, '') ILIKE '%STRATEGY%' THEN 'operational_expense'
          WHEN COALESCE(m.raw_description, '') ILIKE '%LAW FIRM%' OR COALESCE(m.raw_description, '') ILIKE '%ATTORNEY%' OR COALESCE(m.raw_description, '') ILIKE '%LEGAL%' THEN 'operational_expense'
          WHEN COALESCE(m.raw_description, '') ILIKE '%ACCOUNTING%' OR COALESCE(m.raw_description, '') ILIKE '%AUDIT%' OR COALESCE(m.raw_description, '') ILIKE '%TAX%' THEN 'operational_expense'
          WHEN COALESCE(m.raw_description, '') ILIKE '%ELECTRIC%' OR COALESCE(m.raw_description, '') ILIKE '%GAS%' OR COALESCE(m.raw_description, '') ILIKE '%WATER%' OR COALESCE(m.raw_description, '') ILIKE '%INTERNET%' THEN 'operational_expense'
          WHEN COALESCE(m.raw_description, '') ILIKE '%PHONE%' OR COALESCE(m.raw_description, '') ILIKE '%MOBILE%' OR COALESCE(m.raw_description, '') ILIKE '%CARRIER%' THEN 'operational_expense'
          WHEN COALESCE(m.raw_description, '') ILIKE '%INSURANCE%' OR COALESCE(m.raw_description, '') ILIKE '%PREMIUM%' OR COALESCE(m.raw_description, '') ILIKE '%POLICY%' THEN 'operational_expense'
          WHEN COUNT(ma.id) > 0 AND MAX(CASE WHEN ma.component_type = 'ar' THEN 1 ELSE 0 END) = 1 THEN 'ar_invoice'
          WHEN COUNT(ma.id) > 0 AND MAX(CASE WHEN ma.component_type = 'ap' THEN 1 ELSE 0 END) = 1 THEN 'ap_bill'
          ELSE 'unclassified'
        END as classification
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
        COALESCE(ce.metadata->>'canonical_name', ce.metadata->>'customer_name', 'Unknown Customer') as customer_name,
        'qbo' as source,
        ce.expected_date as due_date,
        CASE 
          WHEN ce.outstanding_amount <= 0 THEN 'paid'
          WHEN ce.expected_date < NOW()::date THEN 'overdue'
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
       LEFT JOIN movement_attributions ma ON ma.entity_id = ce.entity_id AND ma.user_id = ce.user_id AND ma.component_type = 'ar'
       WHERE ce.user_id = $1 AND ce.event_type = 'ar'
       GROUP BY ce.id, ce.expected_date, ce.amount, ce.outstanding_amount, ce.metadata->>'canonical_name', ce.metadata->>'customer_name'
       ORDER BY ce.expected_date DESC
       LIMIT 200`,
      [userId]
    ).then((r) => r.rows)

    // Get AP bills with reconciliation status
    const apBills = await query<APBill>(
      `SELECT
        ce.id,
        COALESCE(ce.metadata->>'canonical_name', ce.metadata->>'vendor_name', 'Unknown Vendor') as vendor_name,
        'qbo' as source,
        ce.expected_date as due_date,
        CASE 
          WHEN ce.outstanding_amount <= 0 THEN 'paid'
          WHEN ce.expected_date < NOW()::date THEN 'overdue'
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
       LEFT JOIN movement_attributions ma ON ma.entity_id = ce.entity_id AND ma.user_id = ce.user_id AND ma.component_type = 'ap'
       WHERE ce.user_id = $1 AND ce.event_type = 'ap'
       GROUP BY ce.id, ce.expected_date, ce.amount, ce.outstanding_amount, ce.metadata->>'canonical_name', ce.metadata->>'vendor_name'
       ORDER BY ce.expected_date DESC
       LIMIT 200`,
      [userId]
    ).then((r) => r.rows)

    // Parse values with proper null handling
    const arInvoiced = arCashEvents?.total_invoiced ? parseFloat(String(arCashEvents.total_invoiced)) : 0
    const arOutstanding = arCashEvents?.total_outstanding ? parseFloat(String(arCashEvents.total_outstanding)) : 0
    const arPaid = arCashEvents?.total_paid ? parseFloat(String(arCashEvents.total_paid)) : 0
    const arTotalCount = arCashEvents?.total_count ? parseInt(String(arCashEvents.total_count), 10) : 0
    const arMatchedCount = arMatched?.count ? parseInt(String(arMatched.count), 10) : 0
    const arMatchedAmount = arMatched?.total_matched ? parseFloat(String(arMatched.total_matched)) : 0

    const apBilled = apCashEvents?.total_billed ? parseFloat(String(apCashEvents.total_billed)) : 0
    const apOutstanding = apCashEvents?.total_outstanding ? parseFloat(String(apCashEvents.total_outstanding)) : 0
    const apPaid = apCashEvents?.total_paid ? parseFloat(String(apCashEvents.total_paid)) : 0
    const apTotalCount = apCashEvents?.total_count ? parseInt(String(apCashEvents.total_count), 10) : 0
    const apMatchedCount = apMatched?.count ? parseInt(String(apMatched.count), 10) : 0
    const apMatchedAmount = apMatched?.total_matched ? parseFloat(String(apMatched.total_matched)) : 0

    const totalFees = feeData?.total_fees ? parseFloat(String(feeData.total_fees)) : 0
    const arSuspiciousCount = suspiciousAR?.count ? parseInt(String(suspiciousAR.count), 10) : 0
    const arSuspiciousAmount = suspiciousAR?.amount ? parseFloat(String(suspiciousAR.amount)) : 0
    const apSuspiciousCount = suspiciousAP?.count ? parseInt(String(suspiciousAP.count), 10) : 0
    const apSuspiciousAmount = suspiciousAP?.amount ? parseFloat(String(suspiciousAP.amount)) : 0

    const transferCount = classificationCounts?.transfer_count ? parseInt(String(classificationCounts.transfer_count), 10) : 0
    const feeCount = classificationCounts?.fee_count ? parseInt(String(classificationCounts.fee_count), 10) : 0
    const operationalExpenseCount = classificationCounts?.operational_expense_count ? parseInt(String(classificationCounts.operational_expense_count), 10) : 0
    const adjustmentCount = classificationCounts?.adjustment_count ? parseInt(String(classificationCounts.adjustment_count), 10) : 0
    const unclassifiedCount = bankTransactions.length - transferCount - feeCount - operationalExpenseCount - adjustmentCount

    // Parse data quality metrics
    const duplicateCount = duplicateDetection?.duplicate_count ? parseInt(String(duplicateDetection.duplicate_count), 10) : 0
    const overMatchedCount = overMatchedDetection?.over_matched_count ? parseInt(String(overMatchedDetection.over_matched_count), 10) : 0
    const statusAnomalyCount = statusAnomalyDetection?.status_anomaly_count ? parseInt(String(statusAnomalyDetection.status_anomaly_count), 10) : 0

    // Calculate data quality score (0-10)
    // Deduct points for: duplicates (1 pt each), over-matching (0.5 pt each), status anomalies (0.5 pt each)
    const qualityPenalty = Math.min(10, (duplicateCount * 1) + (overMatchedCount * 0.5) + (statusAnomalyCount * 0.5))
    const dataQualityScore = Math.max(0, 10 - qualityPenalty)

    // Calculate match rates based on invoice/bill count (percentage of invoices/bills that have at least one match)
    const arMatchRate = arTotalCount > 0 ? Math.round((arMatchedCount / arTotalCount) * 100) : 0
    const apMatchRate = apTotalCount > 0 ? Math.round((apMatchedCount / apTotalCount) * 100) : 0
    const overallMatchRate = (arTotalCount + apTotalCount) > 0 ? Math.round(((arMatchedCount + apMatchedCount) / (arTotalCount + apTotalCount)) * 100) : 0

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
      transfer_count: transferCount,
      fee_count: feeCount,
      operational_expense_count: operationalExpenseCount,
      adjustment_count: adjustmentCount,
      unclassified_count: unclassifiedCount,
      data_quality_score: dataQualityScore,
      duplicate_count: duplicateCount,
      over_matched_count: overMatchedCount,
      status_anomaly_count: statusAnomalyCount,
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
