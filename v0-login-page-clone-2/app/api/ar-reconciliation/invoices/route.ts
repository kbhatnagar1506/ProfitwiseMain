/**
 * AR Reconciliation - Invoice View API
 * 
 * GET: Fetch all invoices with their match status from ar_reconciliation_matches table
 * Summary stats are calculated directly in PostgreSQL for accuracy
 */

import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureARMatchesSchema } from "@/lib/db"

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
  match_count: number
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

    await ensureARMatchesSchema()

    const url = new URL(request.url)
    const filter = url.searchParams.get("filter") || "all" // all, matched, unmatched
    const limit = parseInt(url.searchParams.get("limit") || "1000")

    // Calculate summary stats directly from ar_reconciliation_matches table (PostgreSQL for precision)
    // This gives us accurate totals from the source of truth
    const summaryResult = await query(
      `WITH matched_invoices AS (
        -- Get unique invoices that have been matched (by cash_event_id)
        SELECT DISTINCT ON (cash_event_id)
          cash_event_id,
          invoice_amount,
          bank_amount,
          matched_amount,
          fee_amount,
          status,
          confidence
        FROM ar_reconciliation_matches
        WHERE user_id = $1
        ORDER BY cash_event_id, confidence DESC NULLS LAST, created_at DESC
      ),
      unmatched_invoices AS (
        -- Get AR invoices that have NO match in ar_reconciliation_matches
        SELECT 
          ce.id as cash_event_id,
          ce.amount as invoice_amount,
          ce.outstanding_amount
        FROM cash_events ce
        WHERE ce.user_id = $1
          AND ce.event_type = 'ar'
          AND ce.id NOT IN (SELECT cash_event_id FROM ar_reconciliation_matches WHERE user_id = $1)
      )
      SELECT
        -- Matched stats
        (SELECT COUNT(*) FROM matched_invoices)::int as matched_count,
        (SELECT COALESCE(SUM(invoice_amount), 0) FROM matched_invoices)::float as matched_invoice_amount,
        (SELECT COALESCE(SUM(bank_amount), 0) FROM matched_invoices)::float as matched_bank_amount,
        (SELECT COALESCE(SUM(matched_amount), 0) FROM matched_invoices)::float as total_matched_amount,
        (SELECT COALESCE(SUM(fee_amount), 0) FROM matched_invoices)::float as total_fee_amount,
        (SELECT COUNT(*) FILTER (WHERE status = 'pending') FROM matched_invoices)::int as pending_count,
        (SELECT COUNT(*) FILTER (WHERE status = 'confirmed') FROM matched_invoices)::int as confirmed_count,
        (SELECT COALESCE(SUM(invoice_amount) FILTER (WHERE status = 'pending'), 0) FROM matched_invoices)::float as pending_amount,
        (SELECT COALESCE(SUM(invoice_amount) FILTER (WHERE status = 'confirmed'), 0) FROM matched_invoices)::float as confirmed_amount,
        (SELECT COALESCE(AVG(confidence), 0) FROM matched_invoices)::float as avg_confidence,
        -- Unmatched stats
        (SELECT COUNT(*) FROM unmatched_invoices)::int as unmatched_count,
        (SELECT COALESCE(SUM(invoice_amount), 0) FROM unmatched_invoices)::float as unmatched_invoice_amount,
        (SELECT COALESCE(SUM(outstanding_amount), 0) FROM unmatched_invoices)::float as unmatched_outstanding_amount,
        -- Total stats
        ((SELECT COUNT(*) FROM matched_invoices) + (SELECT COUNT(*) FROM unmatched_invoices))::int as total_invoices,
        ((SELECT COALESCE(SUM(invoice_amount), 0) FROM matched_invoices) + 
         (SELECT COALESCE(SUM(invoice_amount), 0) FROM unmatched_invoices))::float as total_invoice_amount`,
      [user.id]
    )

    const summaryRow = summaryResult.rows[0] || {}
    const summary = {
      // Totals
      total_invoices: summaryRow.total_invoices || 0,
      total_invoice_amount: summaryRow.total_invoice_amount || 0,
      // Matched breakdown
      matched_count: summaryRow.matched_count || 0,
      matched_invoice_amount: summaryRow.matched_invoice_amount || 0,
      matched_bank_amount: summaryRow.matched_bank_amount || 0,
      total_matched_amount: summaryRow.total_matched_amount || 0,
      total_fee_amount: summaryRow.total_fee_amount || 0,
      avg_confidence: summaryRow.avg_confidence || 0,
      // Status breakdown
      pending_count: summaryRow.pending_count || 0,
      confirmed_count: summaryRow.confirmed_count || 0,
      pending_amount: summaryRow.pending_amount || 0,
      confirmed_amount: summaryRow.confirmed_amount || 0,
      // Unmatched
      unmatched_count: summaryRow.unmatched_count || 0,
      unmatched_invoice_amount: summaryRow.unmatched_invoice_amount || 0,
      unmatched_outstanding_amount: summaryRow.unmatched_outstanding_amount || 0,
    }

    // Query invoices for display (with LIMIT for performance)
    // Uses DISTINCT ON to get best match per invoice
    const invoicesResult = await query(
      `SELECT * FROM (
        SELECT DISTINCT ON (cash_event_id)
          arm.id as match_id,
          arm.cash_event_id,
          arm.invoice_id,
          arm.invoice_amount::float as invoice_amount,
          arm.customer_name,
          arm.bank_amount::float as bank_amount,
          arm.bank_date,
          arm.bank_counterparty,
          arm.bank_description,
          arm.match_type,
          arm.confidence::float as confidence,
          arm.status as match_status,
          arm.fee_amount::float as fee_amount,
          arm.matched_amount::float as matched_amount,
          arm.created_at,
          -- Count of all matches for this invoice
          (SELECT COUNT(*) FROM ar_reconciliation_matches WHERE cash_event_id = arm.cash_event_id AND user_id = $1)::int as match_count,
          -- Get due_date from cash_events
          ce.expected_date as due_date,
          ce.outstanding_amount::float as outstanding_amount,
          ce.status as invoice_status,
          ce.metadata
        FROM ar_reconciliation_matches arm
        JOIN cash_events ce ON ce.id = arm.cash_event_id
        WHERE arm.user_id = $1
        ORDER BY cash_event_id, arm.confidence DESC NULLS LAST, arm.created_at DESC
      ) matched
      
      UNION ALL
      
      -- Unmatched invoices from cash_events
      SELECT
        NULL as match_id,
        ce.id as cash_event_id,
        COALESCE(ce.metadata->>'doc_number', ce.metadata->>'invoice_number', ce.id::text) as invoice_id,
        ce.amount::float as invoice_amount,
        COALESCE(ce.metadata->>'customer_name', ce.metadata->>'entity_name', 'Unknown') as customer_name,
        NULL::float as bank_amount,
        NULL::date as bank_date,
        NULL as bank_counterparty,
        NULL as bank_description,
        NULL as match_type,
        NULL::float as confidence,
        NULL as match_status,
        NULL::float as fee_amount,
        NULL::float as matched_amount,
        ce.created_at,
        0 as match_count,
        ce.expected_date as due_date,
        ce.outstanding_amount::float as outstanding_amount,
        ce.status as invoice_status,
        ce.metadata
      FROM cash_events ce
      WHERE ce.user_id = $1
        AND ce.event_type = 'ar'
        AND ce.id NOT IN (SELECT cash_event_id FROM ar_reconciliation_matches WHERE user_id = $1)
      
      ORDER BY due_date DESC NULLS LAST, created_at DESC
      LIMIT $2`,
      [user.id, limit]
    )

    // Process results
    const invoices: InvoiceWithMatch[] = invoicesResult.rows.map(row => {
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
