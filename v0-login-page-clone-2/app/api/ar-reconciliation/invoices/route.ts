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
  outstanding_amount: number
  invoice_date: string | null
  due_date: string | null
  invoice_status: string
  
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
    const filter = url.searchParams.get("filter") || "all" // all, matched, unmatched
    const limit = parseInt(url.searchParams.get("limit") || "1000")

    // Query all AR invoices with their BEST match (highest confidence)
    // Uses DISTINCT ON to get one row per invoice, picking the match with highest confidence
    // Then re-orders by due_date for display
    const invoicesResult = await query(
      `SELECT * FROM (
        SELECT DISTINCT ON (ce.id)
          ce.id as cash_event_id,
          ce.amount::float as invoice_amount,
          ce.outstanding_amount::float as outstanding_amount,
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
          
          -- Count of all matches for this invoice
          (SELECT COUNT(*) FROM ar_reconciliation_matches WHERE cash_event_id = ce.id AND user_id = $1)::int as match_count
          
        FROM cash_events ce
        LEFT JOIN ar_reconciliation_matches arm ON arm.cash_event_id = ce.id AND arm.user_id = $1
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

      return {
        invoice_id: row.cash_event_id,
        cash_event_id: row.cash_event_id,
        customer_name: customerName,
        invoice_number: invoiceNumber,
        invoice_amount: row.invoice_amount,
        outstanding_amount: row.outstanding_amount || 0,
        invoice_date: invoiceDate,
        due_date: row.due_date,
        invoice_status: row.invoice_status,
        
        is_matched: row.match_id !== null,
        match_id: row.match_id,
        match_count: row.match_count || 0,
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
      filteredInvoices = invoices.filter(inv => inv.is_matched)
    } else if (filter === "unmatched") {
      filteredInvoices = invoices.filter(inv => !inv.is_matched)
    }

    // Calculate summary
    const summary = {
      total_invoices: invoices.length,
      matched_count: invoices.filter(inv => inv.is_matched).length,
      unmatched_count: invoices.filter(inv => !inv.is_matched).length,
      total_invoice_amount: invoices.reduce((sum, inv) => sum + inv.invoice_amount, 0),
      matched_amount: invoices.filter(inv => inv.is_matched).reduce((sum, inv) => sum + inv.invoice_amount, 0),
      unmatched_amount: invoices.filter(inv => !inv.is_matched).reduce((sum, inv) => sum + inv.invoice_amount, 0),
      outstanding_amount: invoices.reduce((sum, inv) => sum + inv.outstanding_amount, 0),
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
