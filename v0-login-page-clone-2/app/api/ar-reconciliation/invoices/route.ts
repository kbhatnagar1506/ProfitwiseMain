/**
 * AR Reconciliation - Invoice View API
 * 
 * GET: Fetch all invoices with their match status (matched to bank payments or unmatched)
 * Uses ar_reconciliation_matches as the source of truth for invoice amounts
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

    // Query all invoices from ar_reconciliation_matches table
    // This table has the correct invoice_amount values
    // Use DISTINCT ON to get one row per cash_event_id (invoice), picking the best match
    const invoicesResult = await query(
      `SELECT * FROM (
        SELECT DISTINCT ON (arm.cash_event_id)
          arm.cash_event_id,
          arm.invoice_id,
          arm.customer_name,
          arm.invoice_amount::float as invoice_amount,
          arm.bank_amount::float as bank_amount,
          arm.bank_date,
          arm.bank_counterparty,
          arm.bank_description,
          arm.match_type,
          arm.confidence::float as confidence,
          arm.status as match_status,
          arm.id as match_id,
          arm.created_at,
          ce.expected_date as due_date,
          ce.status as invoice_status,
          ce.outstanding_amount::float as outstanding_amount,
          ce.metadata,
          (SELECT COUNT(*) FROM ar_reconciliation_matches WHERE cash_event_id = arm.cash_event_id AND user_id = $1)::int as match_count
        FROM ar_reconciliation_matches arm
        LEFT JOIN cash_events ce ON ce.id = arm.cash_event_id AND ce.user_id = $1
        WHERE arm.user_id = $1
        ORDER BY arm.cash_event_id, arm.confidence DESC NULLS LAST, arm.created_at DESC
      ) sub
      ORDER BY due_date DESC NULLS LAST, created_at DESC
      LIMIT $2`,
      [user.id, limit]
    )

    // Process matched invoices
    const matchedInvoices: InvoiceWithMatch[] = invoicesResult.rows.map(row => {
      const metadata = row.metadata as Record<string, unknown> || {}
      const invoiceDate = (metadata.txn_date as string) || (metadata.date as string) || null

      return {
        invoice_id: row.invoice_id || row.cash_event_id,
        cash_event_id: row.cash_event_id,
        customer_name: row.customer_name || "Unknown",
        invoice_number: row.invoice_id,
        invoice_amount: row.invoice_amount || 0,
        outstanding_amount: row.outstanding_amount || 0,
        invoice_date: invoiceDate,
        due_date: row.due_date,
        invoice_status: row.invoice_status || "open",
        
        is_matched: true,
        match_id: row.match_id,
        match_count: row.match_count || 1,
        bank_amount: row.bank_amount,
        bank_date: row.bank_date,
        bank_counterparty: row.bank_counterparty,
        bank_description: row.bank_description,
        match_type: row.match_type,
        confidence: row.confidence,
        match_status: row.match_status,
      }
    })

    // Get unmatched invoices (cash_events that don't have a match in ar_reconciliation_matches)
    const unmatchedResult = await query(
      `SELECT 
        ce.id as cash_event_id,
        ce.amount::float as invoice_amount,
        ce.outstanding_amount::float as outstanding_amount,
        ce.expected_date as due_date,
        ce.status as invoice_status,
        ce.metadata,
        ce.created_at
      FROM cash_events ce
      WHERE ce.user_id = $1
        AND ce.event_type = 'ar'
        AND ce.id NOT IN (
          SELECT DISTINCT cash_event_id FROM ar_reconciliation_matches WHERE user_id = $1
        )
      ORDER BY ce.expected_date DESC NULLS LAST, ce.created_at DESC
      LIMIT $2`,
      [user.id, limit]
    )

    const unmatchedInvoices: InvoiceWithMatch[] = unmatchedResult.rows.map(row => {
      const metadata = row.metadata as Record<string, unknown> || {}
      const customerName = (metadata.customer_name as string) || 
                          (metadata.entity_name as string) || 
                          "Unknown"
      const invoiceNumber = (metadata.doc_number as string) || 
                           (metadata.invoice_number as string) || 
                           null
      const invoiceDate = (metadata.txn_date as string) || (metadata.date as string) || null

      return {
        invoice_id: row.cash_event_id,
        cash_event_id: row.cash_event_id,
        customer_name: customerName,
        invoice_number: invoiceNumber,
        invoice_amount: row.invoice_amount || 0,
        outstanding_amount: row.outstanding_amount || 0,
        invoice_date: invoiceDate,
        due_date: row.due_date,
        invoice_status: row.invoice_status,
        
        is_matched: false,
        match_id: null,
        match_count: 0,
        bank_amount: null,
        bank_date: null,
        bank_counterparty: null,
        bank_description: null,
        match_type: null,
        confidence: null,
        match_status: null,
      }
    })

    // Combine and sort all invoices
    const allInvoices = [...matchedInvoices, ...unmatchedInvoices].sort((a, b) => {
      const dateA = a.due_date ? new Date(a.due_date).getTime() : 0
      const dateB = b.due_date ? new Date(b.due_date).getTime() : 0
      return dateB - dateA
    })

    // Apply filter
    let filteredInvoices = allInvoices
    if (filter === "matched") {
      filteredInvoices = matchedInvoices
    } else if (filter === "unmatched") {
      filteredInvoices = unmatchedInvoices
    }

    // Calculate summary with proper precision
    const roundTo2 = (n: number) => Math.round(n * 100) / 100
    
    const summary = {
      total_invoices: allInvoices.length,
      matched_count: matchedInvoices.length,
      unmatched_count: unmatchedInvoices.length,
      total_invoice_amount: roundTo2(allInvoices.reduce((sum, inv) => sum + (inv.invoice_amount || 0), 0)),
      matched_amount: roundTo2(matchedInvoices.reduce((sum, inv) => sum + (inv.invoice_amount || 0), 0)),
      unmatched_amount: roundTo2(unmatchedInvoices.reduce((sum, inv) => sum + (inv.invoice_amount || 0), 0)),
      outstanding_amount: roundTo2(allInvoices.reduce((sum, inv) => sum + (inv.outstanding_amount || 0), 0)),
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
