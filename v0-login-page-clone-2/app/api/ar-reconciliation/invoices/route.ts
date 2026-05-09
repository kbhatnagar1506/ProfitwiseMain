/**
 * AR Reconciliation - Invoice View API
 * 
 * GET: Fetch all invoices with their match status (matched to bank payments or unmatched)
 */

import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"

export interface InvoiceWithMatch {
  // Invoice details
  invoice_id: string
  cash_event_id: string
  customer_name: string
  invoice_number: string | null
  invoice_amount: number
  outstanding_amount: number  // Calculated from our matches, not QBO
  total_matched: number       // Sum of all matched amounts
  invoice_date: string | null
  due_date: string | null
  invoice_status: string
  payment_status: "paid" | "partial" | "unpaid"  // Based on our matches
  
  // Match details (null if unmatched)
  is_matched: boolean
  match_id: string | null
  match_count: number  // Total number of matches for this invoice
  bank_amount: number | null
  bank_date: string | null
  bank_counterparty: string | null
  bank_description: string | null
  match_type: string | null
  confidence: number | null
  match_status: string | null
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const url = new URL(request.url)
    const filter = url.searchParams.get("filter") || "all" // all, matched, unmatched, partial
    const limit = parseInt(url.searchParams.get("limit") || "1000")

    // Query all AR invoices with their BEST match (highest confidence)
    // Also calculates total_matched from ALL matches (for FIFO/partial payment tracking)
    const invoicesResult = await query(
      `SELECT * FROM (
        SELECT DISTINCT ON (ce.id)
          ce.id as cash_event_id,
          ce.amount::float as invoice_amount,
          ce.expected_date as due_date,
          ce.status as invoice_status,
          ce.metadata,
          ce.created_at as invoice_created_at,
          
          -- Match details (will be null if no match)
          arm.id as match_id,
          arm.bank_amount::float as bank_amount,
          arm.bank_date,
          arm.bank_counterparty,
          arm.bank_description,
          arm.match_type,
          arm.confidence::float as confidence,
          arm.status as match_status,
          arm.invoice_id as matched_invoice_id,
          arm.customer_name as matched_customer_name,
          
          -- Aggregated match info for this invoice
          match_agg.match_count,
          match_agg.total_matched,
          match_agg.best_match_type
          
        FROM cash_events ce
        LEFT JOIN ar_reconciliation_matches arm ON arm.cash_event_id = ce.id AND arm.user_id = $1
        LEFT JOIN (
          SELECT 
            cash_event_id,
            COUNT(*)::int as match_count,
            COALESCE(SUM(matched_amount), 0)::float as total_matched,
            MAX(match_type) as best_match_type
          FROM ar_reconciliation_matches
          WHERE user_id = $1
          GROUP BY cash_event_id
        ) match_agg ON match_agg.cash_event_id = ce.id
        WHERE ce.user_id = $1
          AND ce.event_type = 'ar'
        ORDER BY ce.id, arm.confidence DESC NULLS LAST, arm.created_at DESC
      ) sub
      ORDER BY due_date DESC NULLS LAST, invoice_created_at DESC
      LIMIT $2`,
      [user.id, limit]
    )

    // Process results
    const invoices: InvoiceWithMatch[] = invoicesResult.rows.map(row => {
      const metadata = row.metadata as Record<string, unknown> || {}
      const customerName = row.matched_customer_name || 
                          (metadata.customer_name as string) || 
                          (metadata.entity_name as string) || 
                          "Unknown"
      const invoiceNumber = row.matched_invoice_id ||
                           (metadata.doc_number as string) || 
                           (metadata.invoice_number as string) || 
                           null
      const invoiceDate = (metadata.txn_date as string) || (metadata.date as string) || null

      const invoiceAmount = row.invoice_amount || 0
      const totalMatched = row.total_matched || 0
      const matchCount = row.match_count || 0
      const bestMatchType = row.best_match_type
      
      // Calculate outstanding from our matches (not QBO)
      const calculatedOutstanding = Math.max(invoiceAmount - totalMatched, 0)
      
      // Determine payment status based on our matches
      let paymentStatus: "paid" | "partial" | "unpaid" = "unpaid"
      if (matchCount > 0) {
        // EXACT, FEE, AGGREGATION = fully paid
        if (bestMatchType === "EXACT" || bestMatchType === "FEE" || bestMatchType === "AGGREGATION") {
          paymentStatus = "paid"
        } else if (calculatedOutstanding <= 0.01) {
          // Fully paid via partials
          paymentStatus = "paid"
        } else {
          // Has matches but still has balance
          paymentStatus = "partial"
        }
      }

      return {
        invoice_id: row.cash_event_id,
        cash_event_id: row.cash_event_id,
        customer_name: customerName,
        invoice_number: invoiceNumber,
        invoice_amount: invoiceAmount,
        outstanding_amount: calculatedOutstanding,
        total_matched: totalMatched,
        invoice_date: invoiceDate,
        due_date: row.due_date,
        invoice_status: row.invoice_status,
        payment_status: paymentStatus,
        
        is_matched: matchCount > 0,
        match_id: row.match_id,
        match_count: matchCount,
        bank_amount: row.bank_amount,
        bank_date: row.bank_date,
        bank_counterparty: row.bank_counterparty,
        bank_description: row.bank_description,
        match_type: row.match_type,
        confidence: row.confidence,
        match_status: row.match_status,
      }
    })

    // Apply filter
    let filteredInvoices = invoices
    if (filter === "matched") {
      filteredInvoices = invoices.filter(inv => inv.payment_status === "paid")
    } else if (filter === "unmatched") {
      filteredInvoices = invoices.filter(inv => inv.payment_status === "unpaid")
    } else if (filter === "partial") {
      filteredInvoices = invoices.filter(inv => inv.payment_status === "partial")
    }

    // Calculate summary based on payment status
    const paidInvoices = invoices.filter(inv => inv.payment_status === "paid")
    const partialInvoices = invoices.filter(inv => inv.payment_status === "partial")
    const unpaidInvoices = invoices.filter(inv => inv.payment_status === "unpaid")
    
    const summary = {
      total_invoices: invoices.length,
      paid_count: paidInvoices.length,
      partial_count: partialInvoices.length,
      unpaid_count: unpaidInvoices.length,
      // Legacy fields for backward compatibility
      matched_count: paidInvoices.length,
      unmatched_count: unpaidInvoices.length,
      // Amounts
      total_invoice_amount: invoices.reduce((sum, inv) => sum + inv.invoice_amount, 0),
      paid_amount: paidInvoices.reduce((sum, inv) => sum + inv.invoice_amount, 0),
      partial_amount: partialInvoices.reduce((sum, inv) => sum + inv.invoice_amount, 0),
      unpaid_amount: unpaidInvoices.reduce((sum, inv) => sum + inv.invoice_amount, 0),
      // Legacy fields
      matched_amount: paidInvoices.reduce((sum, inv) => sum + inv.invoice_amount, 0),
      unmatched_amount: unpaidInvoices.reduce((sum, inv) => sum + inv.invoice_amount, 0),
      // Calculated outstanding (sum of remaining balances)
      outstanding_amount: invoices.reduce((sum, inv) => sum + inv.outstanding_amount, 0),
      total_matched: invoices.reduce((sum, inv) => sum + inv.total_matched, 0),
    }

    return NextResponse.json({
      invoices: filteredInvoices,
      summary,
    })

  } catch (error) {
    console.error("[ar-reconciliation/invoices] GET Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
