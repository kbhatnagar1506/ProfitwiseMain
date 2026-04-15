import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureARMatchesSchema, query } from "@/lib/db"

export interface ReconciliationStats {
  // Invoice-Centric Coverage (PRIMARY)
  total_invoices: number
  total_invoice_amount: number
  paid_invoices: number
  paid_invoice_amount: number
  unpaid_invoices: number
  unpaid_invoice_amount: number
  outstanding_amount: number
  coverage_percentage: number  // Based on invoices paid

  // Match Status (of paid invoices)
  pending_review: number
  pending_review_amount: number
  confirmed: number
  confirmed_amount: number

  // Match Quality
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

    // 1. Invoice Stats with CALCULATED outstanding (not QBO's)
    // An invoice is:
    //   - "fully paid" if SUM(matched_amount) >= invoice_amount (or has EXACT/FEE match)
    //   - "partially paid" if has matches but SUM(matched_amount) < invoice_amount
    //   - "unpaid" if has no matches at all
    const invoiceResult = await query(
      `SELECT 
        COUNT(*) as total_count,
        COALESCE(SUM(ce.amount), 0)::float as total_amount,
        
        -- Fully paid: has EXACT/FEE match OR sum of matches >= invoice amount
        COUNT(*) FILTER (
          WHERE matched.match_type IN ('EXACT', 'FEE', 'AGGREGATION')
          OR (matched.total_matched IS NOT NULL AND ce.amount - matched.total_matched <= 0.01)
        ) as paid_count,
        COALESCE(SUM(ce.amount) FILTER (
          WHERE matched.match_type IN ('EXACT', 'FEE', 'AGGREGATION')
          OR (matched.total_matched IS NOT NULL AND ce.amount - matched.total_matched <= 0.01)
        ), 0)::float as paid_amount,
        
        -- Partially paid: has matches but not fully paid
        COUNT(*) FILTER (
          WHERE matched.total_matched IS NOT NULL 
          AND matched.total_matched > 0
          AND matched.match_type NOT IN ('EXACT', 'FEE', 'AGGREGATION')
          AND ce.amount - matched.total_matched > 0.01
        ) as partial_count,
        COALESCE(SUM(ce.amount) FILTER (
          WHERE matched.total_matched IS NOT NULL 
          AND matched.total_matched > 0
          AND matched.match_type NOT IN ('EXACT', 'FEE', 'AGGREGATION')
          AND ce.amount - matched.total_matched > 0.01
        ), 0)::float as partial_amount,
        
        -- Unpaid: no matches at all
        COUNT(*) FILTER (WHERE matched.total_matched IS NULL OR matched.total_matched = 0) as unpaid_count,
        COALESCE(SUM(ce.amount) FILTER (WHERE matched.total_matched IS NULL OR matched.total_matched = 0), 0)::float as unpaid_amount,
        
        -- Calculated outstanding (invoice amount - matched amount)
        COALESCE(SUM(
          GREATEST(ce.amount - COALESCE(matched.total_matched, 0), 0)
        ), 0)::float as calculated_outstanding
        
      FROM cash_events ce
      LEFT JOIN (
        SELECT 
          cash_event_id, 
          SUM(matched_amount)::float as total_matched,
          MAX(match_type) as match_type
        FROM ar_reconciliation_matches
        WHERE user_id = $1
        GROUP BY cash_event_id
      ) matched ON matched.cash_event_id = ce.id
      WHERE ce.user_id = $1
        AND ce.event_type = 'ar'`,
      [user.id]
    )

    const invoices = invoiceResult.rows[0]
    const totalInvoices = parseInt(invoices?.total_count || "0")
    const totalInvoiceAmount = invoices?.total_amount || 0
    const paidInvoices = parseInt(invoices?.paid_count || "0")
    const paidInvoiceAmount = invoices?.paid_amount || 0
    const partialInvoices = parseInt(invoices?.partial_count || "0")
    const partialInvoiceAmount = invoices?.partial_amount || 0
    const unpaidInvoices = parseInt(invoices?.unpaid_count || "0")
    const unpaidInvoiceAmount = invoices?.unpaid_amount || 0
    const calculatedOutstanding = invoices?.calculated_outstanding || 0
    
    // Coverage is based on NUMBER of invoices fully paid
    const coveragePercentage = totalInvoices > 0 ? (paidInvoices / totalInvoices) * 100 : 0

    // 2. Match Status Stats (pending vs confirmed)
    const matchStatusResult = await query(
      `SELECT 
        COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed_count,
        COALESCE(SUM(invoice_amount) FILTER (WHERE status = 'confirmed'), 0)::float as confirmed_amount,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COALESCE(SUM(invoice_amount) FILTER (WHERE status = 'pending'), 0)::float as pending_amount,
        COUNT(*) FILTER (WHERE confidence >= 0.85) as high_confidence,
        COUNT(*) FILTER (WHERE confidence < 0.70) as low_confidence,
        COALESCE(AVG(confidence), 0)::float as avg_confidence
      FROM ar_reconciliation_matches
      WHERE user_id = $1`,
      [user.id]
    )

    const matchStatus = matchStatusResult.rows[0]

    // 3. Match Types Breakdown (by invoice amount)
    const matchTypesResult = await query(
      `SELECT 
        match_type as type,
        COUNT(*) as count,
        COALESCE(SUM(invoice_amount), 0)::float as amount
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

    // 4. Fee Analysis
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

    // 5. Time-based Stats
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
      // Invoice-Centric Coverage (PRIMARY)
      total_invoices: totalInvoices,
      total_invoice_amount: totalInvoiceAmount,
      paid_invoices: paidInvoices,
      paid_invoice_amount: paidInvoiceAmount,
      unpaid_invoices: unpaidInvoices,
      unpaid_invoice_amount: unpaidInvoiceAmount,
      outstanding_amount: calculatedOutstanding,
      coverage_percentage: Math.round(coveragePercentage * 10) / 10,

      // Match Status
      pending_review: parseInt(matchStatus?.pending_count || "0"),
      pending_review_amount: matchStatus?.pending_amount || 0,
      confirmed: parseInt(matchStatus?.confirmed_count || "0"),
      confirmed_amount: matchStatus?.confirmed_amount || 0,

      // Match Quality
      high_confidence_matches: parseInt(matchStatus?.high_confidence || "0"),
      low_confidence_matches: parseInt(matchStatus?.low_confidence || "0"),
      avg_confidence: Math.round((matchStatus?.avg_confidence || 0) * 100),

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
