/**
 * AR Reconciliation - Invoice View API
 * 
 * GET: Fetch all invoices with their match status
 * Summary stats are calculated from ORIGINAL invoice amounts (QBO TotalAmt / Xero Total)
 * NOT from cash_events.amount which stores amount_due (remaining balance)
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
  invoice_amount: number  // Original invoice total (TotalAmt)
  outstanding_amount: number  // Remaining balance (Balance/AmountDue)
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

    // Step 1: Get ALL original invoice amounts from QBO/Xero (source of truth)
    // This gives us the TRUE TotalAmt, not the amount_due stored in cash_events
    const allInvoicesResult = await query(
      `WITH qbo_invoices AS (
        -- QBO: Get TotalAmt (original invoice total) and Balance (remaining)
        SELECT 
          e.entity_id as invoice_id,
          'qbo' as source,
          COALESCE((e.data->>'TotalAmt')::numeric, (e.data->>'Balance')::numeric, 0) as total_amount,
          COALESCE((e.data->>'Balance')::numeric, 0) as balance,
          e.data->>'DueDate' as due_date,
          e.data->'CustomerRef'->>'name' as customer_name,
          e.data->>'DocNumber' as doc_number
        FROM qbo_entities e
        JOIN qbo_connections c ON c.realm_id = e.realm_id
        WHERE c.user_id = $1 
          AND e.entity_type = 'Invoice'
      ),
      xero_invoices AS (
        -- Xero: Get Total (original invoice total) and AmountDue (remaining)
        SELECT 
          e.entity_id as invoice_id,
          'xero' as source,
          COALESCE((e.data->>'Total')::numeric, (e.data->>'AmountDue')::numeric, 0) as total_amount,
          COALESCE((e.data->>'AmountDue')::numeric, 0) as balance,
          COALESCE(e.data->>'DueDateString', e.data->>'DateString') as due_date,
          e.data->'Contact'->>'Name' as customer_name,
          e.data->>'InvoiceNumber' as doc_number
        FROM xero_entities e
        JOIN xero_connections xc ON xc.tenant_id = e.tenant_id
        WHERE xc.user_id = $1 
          AND e.entity_type = 'Invoice'
      ),
      all_invoices AS (
        SELECT * FROM qbo_invoices
        UNION ALL
        SELECT * FROM xero_invoices
      ),
      matched_invoice_ids AS (
        -- Get invoice_ids that have been matched in ar_reconciliation_matches
        -- The invoice_id in ar_reconciliation_matches corresponds to entity_id in qbo/xero_entities
        SELECT DISTINCT invoice_id FROM ar_reconciliation_matches WHERE user_id = $1
      )
      SELECT
        -- Total: ALL invoices from QBO/Xero
        (SELECT COUNT(*) FROM all_invoices)::int as total_invoices,
        (SELECT COALESCE(SUM(total_amount), 0) FROM all_invoices)::float as total_invoice_amount,
        (SELECT COALESCE(SUM(balance), 0) FROM all_invoices)::float as total_outstanding,
        
        -- Matched: Invoices that exist in ar_reconciliation_matches
        (SELECT COUNT(*) FROM all_invoices WHERE invoice_id IN (SELECT invoice_id FROM matched_invoice_ids))::int as matched_count,
        (SELECT COALESCE(SUM(total_amount), 0) FROM all_invoices WHERE invoice_id IN (SELECT invoice_id FROM matched_invoice_ids))::float as matched_invoice_amount,
        (SELECT COALESCE(SUM(balance), 0) FROM all_invoices WHERE invoice_id IN (SELECT invoice_id FROM matched_invoice_ids))::float as matched_outstanding,
        
        -- Unmatched: Invoices NOT in ar_reconciliation_matches
        (SELECT COUNT(*) FROM all_invoices WHERE invoice_id NOT IN (SELECT invoice_id FROM matched_invoice_ids))::int as unmatched_count,
        (SELECT COALESCE(SUM(total_amount), 0) FROM all_invoices WHERE invoice_id NOT IN (SELECT invoice_id FROM matched_invoice_ids))::float as unmatched_invoice_amount,
        (SELECT COALESCE(SUM(balance), 0) FROM all_invoices WHERE invoice_id NOT IN (SELECT invoice_id FROM matched_invoice_ids))::float as unmatched_outstanding`,
      [user.id]
    )

    // Step 2: Get bank-side stats from ar_reconciliation_matches
    const bankStatsResult = await query(
      `WITH unique_matches AS (
        SELECT DISTINCT ON (cash_event_id)
          bank_amount,
          fee_amount,
          confidence,
          status
        FROM ar_reconciliation_matches
        WHERE user_id = $1
        ORDER BY cash_event_id, confidence DESC NULLS LAST, created_at DESC
      )
      SELECT
        COALESCE(SUM(bank_amount), 0)::float as total_bank_received,
        COALESCE(SUM(fee_amount), 0)::float as total_fees,
        COALESCE(AVG(confidence), 0)::float as avg_confidence,
        COUNT(*) FILTER (WHERE status = 'pending')::int as pending_count,
        COUNT(*) FILTER (WHERE status = 'confirmed')::int as confirmed_count
      FROM unique_matches`,
      [user.id]
    )

    const invoiceStats = allInvoicesResult.rows[0] || {}
    const bankStats = bankStatsResult.rows[0] || {}

    const summary = {
      // Totals (from original QBO/Xero data)
      total_invoices: invoiceStats.total_invoices || 0,
      total_invoice_amount: invoiceStats.total_invoice_amount || 0,
      total_outstanding: invoiceStats.total_outstanding || 0,
      
      // Matched breakdown (invoice amounts from QBO/Xero, bank amounts from matches)
      matched_count: invoiceStats.matched_count || 0,
      matched_invoice_amount: invoiceStats.matched_invoice_amount || 0,
      matched_outstanding: invoiceStats.matched_outstanding || 0,
      
      // Bank side stats
      matched_bank_amount: bankStats.total_bank_received || 0,
      total_fee_amount: bankStats.total_fees || 0,
      avg_confidence: bankStats.avg_confidence || 0,
      
      // Status breakdown
      pending_count: bankStats.pending_count || 0,
      confirmed_count: bankStats.confirmed_count || 0,
      
      // Unmatched (from QBO/Xero)
      unmatched_count: invoiceStats.unmatched_count || 0,
      unmatched_invoice_amount: invoiceStats.unmatched_invoice_amount || 0,
      unmatched_outstanding: invoiceStats.unmatched_outstanding || 0,
    }

    // Step 3: Query invoices for display with original amounts
    const invoicesResult = await query(
      `WITH qbo_invoices AS (
        SELECT 
          e.entity_id as invoice_id,
          'qbo' as source,
          COALESCE((e.data->>'TotalAmt')::numeric, (e.data->>'Balance')::numeric, 0)::float as total_amount,
          COALESCE((e.data->>'Balance')::numeric, 0)::float as balance,
          (e.data->>'DueDate')::date as due_date,
          e.data->>'TxnDate' as txn_date,
          COALESCE(e.data->'CustomerRef'->>'name', 'Unknown') as customer_name,
          e.data->>'DocNumber' as doc_number
        FROM qbo_entities e
        JOIN qbo_connections c ON c.realm_id = e.realm_id
        WHERE c.user_id = $1 
          AND e.entity_type = 'Invoice'
      ),
      xero_invoices AS (
        SELECT 
          e.entity_id as invoice_id,
          'xero' as source,
          COALESCE((e.data->>'Total')::numeric, (e.data->>'AmountDue')::numeric, 0)::float as total_amount,
          COALESCE((e.data->>'AmountDue')::numeric, 0)::float as balance,
          COALESCE(e.data->>'DueDateString', e.data->>'DateString')::date as due_date,
          e.data->>'DateString' as txn_date,
          COALESCE(e.data->'Contact'->>'Name', 'Unknown') as customer_name,
          e.data->>'InvoiceNumber' as doc_number
        FROM xero_entities e
        JOIN xero_connections xc ON xc.tenant_id = e.tenant_id
        WHERE xc.user_id = $1 
          AND e.entity_type = 'Invoice'
      ),
      all_invoices AS (
        SELECT * FROM qbo_invoices
        UNION ALL
        SELECT * FROM xero_invoices
      ),
      matches AS (
        SELECT DISTINCT ON (invoice_id)
          id as match_id,
          invoice_id,
          cash_event_id,
          bank_amount,
          bank_date,
          bank_counterparty,
          bank_description,
          match_type,
          confidence,
          status as match_status,
          fee_amount,
          matched_amount
        FROM ar_reconciliation_matches
        WHERE user_id = $1
        ORDER BY invoice_id, confidence DESC NULLS LAST, created_at DESC
      )
      SELECT
        inv.invoice_id,
        inv.source,
        inv.total_amount as invoice_amount,
        inv.balance as outstanding_amount,
        inv.due_date,
        inv.txn_date as invoice_date,
        inv.customer_name,
        inv.doc_number as invoice_number,
        
        -- Match details
        m.match_id,
        m.cash_event_id,
        m.bank_amount,
        m.bank_date,
        m.bank_counterparty,
        m.bank_description,
        m.match_type,
        m.confidence,
        m.match_status,
        m.fee_amount,
        m.matched_amount,
        
        -- Match count for this invoice
        (SELECT COUNT(*) FROM ar_reconciliation_matches WHERE invoice_id = inv.invoice_id AND user_id = $1)::int as match_count,
        
        -- Status
        CASE WHEN inv.balance <= 0.01 THEN 'paid'
             WHEN inv.balance < inv.total_amount THEN 'partially_paid'
             ELSE 'open' END as invoice_status
             
      FROM all_invoices inv
      LEFT JOIN matches m ON m.invoice_id = inv.invoice_id
      ORDER BY inv.due_date DESC NULLS LAST, inv.invoice_id
      LIMIT $2`,
      [user.id, limit]
    )

    // Process results
    const invoices: InvoiceWithMatch[] = invoicesResult.rows.map(row => {
      return {
        invoice_id: row.invoice_id,
        cash_event_id: row.cash_event_id || row.invoice_id,
        customer_name: row.customer_name || "Unknown",
        invoice_number: row.invoice_number || row.doc_number,
        invoice_amount: row.invoice_amount || 0,
        outstanding_amount: row.outstanding_amount || 0,
        invoice_date: row.invoice_date,
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
