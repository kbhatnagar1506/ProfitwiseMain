import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureARMatchesSchema, query } from "@/lib/db"

export interface ReconciliationStats {
  // Overall Cash Coverage
  total_bank_inflows: number
  total_bank_inflow_amount: number
  matched_bank_inflows: number
  matched_bank_amount: number
  unmatched_bank_inflows: number
  unmatched_bank_amount: number
  coverage_percentage: number

  // AR Invoice Stats
  total_invoices: number
  total_invoice_amount: number
  matched_invoices: number
  matched_invoice_amount: number
  unmatched_invoices: number
  unmatched_invoice_amount: number
  outstanding_amount: number
  ar_match_rate: number

  // Match Quality
  confirmed_matches: number
  confirmed_amount: number
  pending_matches: number
  pending_amount: number
  high_confidence_matches: number
  low_confidence_matches: number
  avg_confidence: number

  // Match Types Breakdown
  match_types: {
    type: string
    count: number
    amount: number
  }[]

  // Fee Analysis
  total_fees_detected: number
  fee_amount: number

  // Time-based
  matches_today: number
  matches_this_week: number
  matches_this_month: number
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    await ensureARMatchesSchema()

    // 1. Bank Inflow Stats (movements)
    const bankInflowsResult = await query(
      `SELECT 
        COUNT(*) as total_count,
        COALESCE(SUM(amount), 0)::float as total_amount,
        COUNT(*) FILTER (WHERE id IN (SELECT movement_id FROM ar_reconciliation_matches WHERE user_id = $1)) as matched_count,
        COALESCE(SUM(amount) FILTER (WHERE id IN (SELECT movement_id FROM ar_reconciliation_matches WHERE user_id = $1)), 0)::float as matched_amount
      FROM movements
      WHERE user_id = $1
        AND direction = 'inflow'
        AND pnl_eligible = true`,
      [user.id]
    )

    const bankInflows = bankInflowsResult.rows[0]
    const totalBankInflows = parseInt(bankInflows?.total_count || "0")
    const totalBankAmount = bankInflows?.total_amount || 0
    const matchedBankInflows = parseInt(bankInflows?.matched_count || "0")
    const matchedBankAmount = bankInflows?.matched_amount || 0
    const unmatchedBankInflows = totalBankInflows - matchedBankInflows
    const unmatchedBankAmount = totalBankAmount - matchedBankAmount
    const coveragePercentage = totalBankAmount > 0 ? (matchedBankAmount / totalBankAmount) * 100 : 0

    // 2. Invoice Stats (cash_events)
    const invoiceResult = await query(
      `SELECT 
        COUNT(*) as total_count,
        COALESCE(SUM(amount), 0)::float as total_amount,
        COALESCE(SUM(outstanding_amount), 0)::float as outstanding_amount,
        COUNT(*) FILTER (WHERE id IN (SELECT cash_event_id FROM ar_reconciliation_matches WHERE user_id = $1)) as matched_count,
        COALESCE(SUM(amount) FILTER (WHERE id IN (SELECT cash_event_id FROM ar_reconciliation_matches WHERE user_id = $1)), 0)::float as matched_amount
      FROM cash_events
      WHERE user_id = $1
        AND event_type = 'ar'`,
      [user.id]
    )

    const invoices = invoiceResult.rows[0]
    const totalInvoices = parseInt(invoices?.total_count || "0")
    const totalInvoiceAmount = invoices?.total_amount || 0
    const outstandingAmount = invoices?.outstanding_amount || 0
    const matchedInvoices = parseInt(invoices?.matched_count || "0")
    const matchedInvoiceAmount = invoices?.matched_amount || 0
    const unmatchedInvoices = totalInvoices - matchedInvoices
    const unmatchedInvoiceAmount = totalInvoiceAmount - matchedInvoiceAmount
    const arMatchRate = totalInvoices > 0 ? (matchedInvoices / totalInvoices) * 100 : 0

    // 3. Match Quality Stats
    const matchQualityResult = await query(
      `SELECT 
        COUNT(*) as total_matches,
        COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed_count,
        COALESCE(SUM(bank_amount) FILTER (WHERE status = 'confirmed'), 0)::float as confirmed_amount,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COALESCE(SUM(bank_amount) FILTER (WHERE status = 'pending'), 0)::float as pending_amount,
        COUNT(*) FILTER (WHERE confidence >= 0.85) as high_confidence,
        COUNT(*) FILTER (WHERE confidence < 0.70) as low_confidence,
        COALESCE(AVG(confidence), 0)::float as avg_confidence
      FROM ar_reconciliation_matches
      WHERE user_id = $1`,
      [user.id]
    )

    const matchQuality = matchQualityResult.rows[0]

    // 4. Match Types Breakdown
    const matchTypesResult = await query(
      `SELECT 
        match_type as type,
        COUNT(*) as count,
        COALESCE(SUM(bank_amount), 0)::float as amount
      FROM ar_reconciliation_matches
      WHERE user_id = $1
      GROUP BY match_type
      ORDER BY count DESC`,
      [user.id]
    )

    const matchTypes = matchTypesResult.rows.map(row => ({
      type: row.type,
      count: parseInt(row.count),
      amount: row.amount
    }))

    // 5. Fee Analysis
    const feeResult = await query(
      `SELECT 
        COUNT(*) as fee_count,
        COALESCE(SUM(fee_amount), 0)::float as fee_amount
      FROM ar_reconciliation_matches
      WHERE user_id = $1
        AND fee_amount > 0`,
      [user.id]
    )

    const fees = feeResult.rows[0]

    // 6. Time-based Stats
    const timeResult = await query(
      `SELECT 
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) as today,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') as this_week,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '30 days') as this_month
      FROM ar_reconciliation_matches
      WHERE user_id = $1`,
      [user.id]
    )

    const timeStats = timeResult.rows[0]

    const stats: ReconciliationStats = {
      // Overall Cash Coverage
      total_bank_inflows: totalBankInflows,
      total_bank_inflow_amount: totalBankAmount,
      matched_bank_inflows: matchedBankInflows,
      matched_bank_amount: matchedBankAmount,
      unmatched_bank_inflows: unmatchedBankInflows,
      unmatched_bank_amount: unmatchedBankAmount,
      coverage_percentage: Math.round(coveragePercentage * 10) / 10,

      // AR Invoice Stats
      total_invoices: totalInvoices,
      total_invoice_amount: totalInvoiceAmount,
      matched_invoices: matchedInvoices,
      matched_invoice_amount: matchedInvoiceAmount,
      unmatched_invoices: unmatchedInvoices,
      unmatched_invoice_amount: unmatchedInvoiceAmount,
      outstanding_amount: outstandingAmount,
      ar_match_rate: Math.round(arMatchRate * 10) / 10,

      // Match Quality
      confirmed_matches: parseInt(matchQuality?.confirmed_count || "0"),
      confirmed_amount: matchQuality?.confirmed_amount || 0,
      pending_matches: parseInt(matchQuality?.pending_count || "0"),
      pending_amount: matchQuality?.pending_amount || 0,
      high_confidence_matches: parseInt(matchQuality?.high_confidence || "0"),
      low_confidence_matches: parseInt(matchQuality?.low_confidence || "0"),
      avg_confidence: Math.round((matchQuality?.avg_confidence || 0) * 100),

      // Match Types
      match_types: matchTypes,

      // Fee Analysis
      total_fees_detected: parseInt(fees?.fee_count || "0"),
      fee_amount: fees?.fee_amount || 0,

      // Time-based
      matches_today: parseInt(timeStats?.today || "0"),
      matches_this_week: parseInt(timeStats?.this_week || "0"),
      matches_this_month: parseInt(timeStats?.this_month || "0"),
    }

    return NextResponse.json(stats)
  } catch (error) {
    console.error("[ar-reconciliation/stats] GET Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
