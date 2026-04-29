/**
 * AR Reconciliation Query Functions
 * All metrics computed dynamically from database
 */

import { query } from "./db"

export interface ARReconciliationSummary {
  // Top cards
  unmatched_cash: number
  unmatched_count: number
  reconciled_count: number
  bank_cash_cleared: number
  excluded_count: number
  excluded_amount: number

  // Coverage
  coverage_percent: number
  matched_amount: number
  unmatched_amount: number

  // AR specific
  ar: {
    total_invoices: number
    total_amount: number
    matched_count: number
    matched_amount: number
    unmatched_count: number
    unmatched_amount: number
    outstanding_count: number
    outstanding_amount: number
    verified_percent: number
    books_paid_amount: number
  }

  // Match stats
  matches: {
    by_type: {
      exact: number
      fee_adjusted: number
      partial: number
    }
    by_source: {
      ai: number
      manual: number
    }
    avg_confidence: number
    total_fees: number
  }

  // Queue
  review_count: number
}

/**
 * Get comprehensive AR reconciliation summary with all computed metrics
 */
export async function getARReconciliationSummary(userId: string): Promise<ARReconciliationSummary> {
  // 1. Unmatched cash and reconciled count
  const unmatchedResult = await query(
    `SELECT
      COUNT(*) FILTER (WHERE id NOT IN (SELECT movement_id FROM ar_reconciliation_matches WHERE user_id = $1 AND status = 'confirmed')) as unmatched_count,
      SUM(amount) FILTER (WHERE id NOT IN (SELECT movement_id FROM ar_reconciliation_matches WHERE user_id = $1 AND status = 'confirmed')) as unmatched_cash,
      COUNT(*) FILTER (WHERE id IN (SELECT movement_id FROM ar_reconciliation_matches WHERE user_id = $1 AND status = 'confirmed')) as reconciled_count,
      SUM(amount) FILTER (WHERE id IN (SELECT movement_id FROM ar_reconciliation_matches WHERE user_id = $1 AND status = 'confirmed')) as matched_amount
    FROM movements
    WHERE user_id = $1 AND direction = 'inflow' AND pnl_eligible = true`,
    [userId]
  )

  const unmatchedRow = unmatchedResult.rows[0] || {}
  const unmatched_count = parseInt(unmatchedRow.unmatched_count || "0")
  const unmatched_cash = parseFloat(unmatchedRow.unmatched_cash || "0")
  const reconciled_count = parseInt(unmatchedRow.reconciled_count || "0")
  const matched_amount = parseFloat(unmatchedRow.matched_amount || "0")

  // 2. Excluded movements
  const excludedResult = await query(
    `SELECT
      COUNT(*) as excluded_count,
      SUM(amount) as excluded_amount
    FROM movements
    WHERE user_id = $1 AND pnl_eligible = false`,
    [userId]
  )

  const excludedRow = excludedResult.rows[0] || {}
  const excluded_count = parseInt(excludedRow.excluded_count || "0")
  const excluded_amount = parseFloat(excludedRow.excluded_amount || "0")

  // 3. Coverage percentage
  const coverageResult = await query(
    `SELECT
      SUM(amount) as total_amount
    FROM movements
    WHERE user_id = $1 AND direction = 'inflow' AND pnl_eligible = true`,
    [userId]
  )

  const coverageRow = coverageResult.rows[0] || {}
  const total_amount = parseFloat(coverageRow.total_amount || "0")
  const coverage_percent = total_amount > 0 ? Math.round((matched_amount / total_amount) * 100) : 0

  // 4. Bank cash cleared
  const clearedResult = await query(
    `SELECT SUM(matched_amount) as bank_cash_cleared
    FROM ar_reconciliation_matches
    WHERE user_id = $1 AND status = 'confirmed'`,
    [userId]
  )

  const clearedRow = clearedResult.rows[0] || {}
  const bank_cash_cleared = parseFloat(clearedRow.bank_cash_cleared || "0")

  // 5. AR Summary
  const arResult = await query(
    `SELECT
      COUNT(*) as total_invoices,
      SUM(amount) as total_ar_amount,
      COUNT(*) FILTER (WHERE id IN (SELECT cash_event_id FROM ar_reconciliation_matches WHERE user_id = $1 AND status = 'confirmed')) as matched_count,
      SUM(amount) FILTER (WHERE id IN (SELECT cash_event_id FROM ar_reconciliation_matches WHERE user_id = $1 AND status = 'confirmed')) as matched_amount,
      COUNT(*) FILTER (WHERE id NOT IN (SELECT cash_event_id FROM ar_reconciliation_matches WHERE user_id = $1 AND status = 'confirmed')) as unmatched_count,
      SUM(amount) FILTER (WHERE id NOT IN (SELECT cash_event_id FROM ar_reconciliation_matches WHERE user_id = $1 AND status = 'confirmed')) as unmatched_amount,
      COUNT(*) FILTER (WHERE status = 'open') as outstanding_count,
      SUM(outstanding_amount) FILTER (WHERE status = 'open') as outstanding_amount
    FROM cash_events
    WHERE user_id = $1 AND event_type = 'ar'`,
    [userId]
  )

  const arRow = arResult.rows[0] || {}
  const ar_total_invoices = parseInt(arRow.total_invoices || "0")
  const ar_total_amount = parseFloat(arRow.total_ar_amount || "0")
  const ar_matched_count = parseInt(arRow.matched_count || "0")
  const ar_matched_amount = parseFloat(arRow.matched_amount || "0")
  const ar_unmatched_count = parseInt(arRow.unmatched_count || "0")
  const ar_unmatched_amount = parseFloat(arRow.unmatched_amount || "0")
  const ar_outstanding_count = parseInt(arRow.outstanding_count || "0")
  const ar_outstanding_amount = parseFloat(arRow.outstanding_amount || "0")
  const ar_verified_percent = ar_total_invoices > 0 ? Math.round((ar_matched_count / ar_total_invoices) * 100) : 0

  // 6. Books paid amount (from QBO)
  const booksResult = await query(
    `SELECT SUM(amount) as books_paid_amount
    FROM cash_events
    WHERE user_id = $1 AND event_type = 'ar' AND status = 'paid'`,
    [userId]
  )

  const booksRow = booksResult.rows[0] || {}
  const books_paid_amount = parseFloat(booksRow.books_paid_amount || "0")

  // 7. Match statistics
  const matchStatsResult = await query(
    `SELECT
      COUNT(*) FILTER (WHERE match_type = 'EXACT') as exact_matches,
      COUNT(*) FILTER (WHERE match_type = 'FEE') as fee_adjusted_matches,
      COUNT(*) FILTER (WHERE match_type = 'PARTIAL') as partial_matches,
      COUNT(*) FILTER (WHERE matched_by = 'ai') as ai_matches,
      COUNT(*) FILTER (WHERE matched_by = 'manual') as manual_matches,
      AVG(confidence) as avg_confidence,
      SUM(fee_amount) as total_fees
    FROM ar_reconciliation_matches
    WHERE user_id = $1 AND status = 'confirmed'`,
    [userId]
  )

  const matchStatsRow = matchStatsResult.rows[0] || {}
  const exact_matches = parseInt(matchStatsRow.exact_matches || "0")
  const fee_adjusted_matches = parseInt(matchStatsRow.fee_adjusted_matches || "0")
  const partial_matches = parseInt(matchStatsRow.partial_matches || "0")
  const ai_matches = parseInt(matchStatsRow.ai_matches || "0")
  const manual_matches = parseInt(matchStatsRow.manual_matches || "0")
  const avg_confidence = parseFloat(matchStatsRow.avg_confidence || "0")
  const total_fees = parseFloat(matchStatsRow.total_fees || "0")

  // 8. Review queue count
  const reviewResult = await query(
    `SELECT COUNT(*) as review_count
    FROM movements m
    WHERE m.user_id = $1
      AND m.direction = 'inflow'
      AND m.pnl_eligible = true
      AND m.id NOT IN (
        SELECT movement_id FROM ar_reconciliation_matches WHERE user_id = $1 AND status = 'confirmed'
      )`,
    [userId]
  )

  const reviewRow = reviewResult.rows[0] || {}
  const review_count = parseInt(reviewRow.review_count || "0")

  return {
    unmatched_cash,
    unmatched_count,
    reconciled_count,
    bank_cash_cleared,
    excluded_count,
    excluded_amount,
    coverage_percent,
    matched_amount,
    unmatched_amount,
    ar: {
      total_invoices: ar_total_invoices,
      total_amount: ar_total_amount,
      matched_count: ar_matched_count,
      matched_amount: ar_matched_amount,
      unmatched_count: ar_unmatched_count,
      unmatched_amount: ar_unmatched_amount,
      outstanding_count: ar_outstanding_count,
      outstanding_amount: ar_outstanding_amount,
      verified_percent: ar_verified_percent,
      books_paid_amount,
    },
    matches: {
      by_type: {
        exact: exact_matches,
        fee_adjusted: fee_adjusted_matches,
        partial: partial_matches,
      },
      by_source: {
        ai: ai_matches,
        manual: manual_matches,
      },
      avg_confidence,
      total_fees,
    },
    review_count,
  }
}

export interface ARMatch {
  id: string
  movement_id: string
  cash_event_id: string
  bank_date: string
  bank_description: string
  bank_counterparty: string
  bank_amount: number
  invoice_id: string
  customer_name: string
  invoice_amount: number
  match_type: string
  confidence: number
  fee_amount: number
  matched_amount: number
  matched_by: string
  status: string
  confirmed_at: string | null
  created_at: string
}

/**
 * Get all AR matches for a user with optional filters
 */
export async function getARMatches(
  userId: string,
  status?: string,
  limit: number = 100,
  offset: number = 0
): Promise<{ matches: ARMatch[]; total: number }> {
  let whereClause = "WHERE arm.user_id = $1"
  const params: any[] = [userId]

  if (status) {
    whereClause += ` AND arm.status = $${params.length + 1}`
    params.push(status)
  }

  // Get total count
  const countResult = await query(
    `SELECT COUNT(*) as total FROM ar_reconciliation_matches arm ${whereClause}`,
    params
  )

  const total = parseInt(countResult.rows[0]?.total || "0")

  // Get matches with pagination
  const matchesResult = await query(
    `SELECT
      arm.id,
      arm.movement_id,
      arm.cash_event_id,
      arm.bank_date,
      arm.bank_description,
      arm.bank_counterparty,
      arm.bank_amount,
      arm.invoice_id,
      arm.customer_name,
      arm.invoice_amount,
      arm.match_type,
      arm.confidence,
      arm.fee_amount,
      arm.matched_amount,
      arm.matched_by,
      arm.status,
      arm.confirmed_at,
      arm.created_at
    FROM ar_reconciliation_matches arm
    ${whereClause}
    ORDER BY arm.bank_date DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  )

  const matches = matchesResult.rows.map((row) => ({
    id: row.id,
    movement_id: row.movement_id,
    cash_event_id: row.cash_event_id,
    bank_date: row.bank_date,
    bank_description: row.bank_description,
    bank_counterparty: row.bank_counterparty,
    bank_amount: parseFloat(row.bank_amount),
    invoice_id: row.invoice_id,
    customer_name: row.customer_name,
    invoice_amount: parseFloat(row.invoice_amount),
    match_type: row.match_type,
    confidence: parseFloat(row.confidence),
    fee_amount: parseFloat(row.fee_amount),
    matched_amount: parseFloat(row.matched_amount),
    matched_by: row.matched_by,
    status: row.status,
    confirmed_at: row.confirmed_at,
    created_at: row.created_at,
  }))

  return { matches, total }
}

/**
 * Create a new AR match
 */
export async function createARMatch(
  userId: string,
  movementId: string,
  cashEventId: string,
  bankAmount: number,
  bankDate: string,
  bankDescription: string,
  bankCounterparty: string,
  invoiceId: string,
  customerName: string,
  invoiceAmount: number,
  matchType: string,
  confidence: number,
  matchedBy: string = "manual",
  aiReasoning?: string
): Promise<string> {
  const feeAmount = Math.abs(bankAmount - invoiceAmount)
  const matchedAmount = Math.min(bankAmount, invoiceAmount)

  const result = await query(
    `INSERT INTO ar_reconciliation_matches (
      user_id, movement_id, cash_event_id, bank_amount, bank_date, bank_description,
      bank_counterparty, invoice_id, customer_name, invoice_amount, match_type,
      confidence, fee_amount, matched_amount, matched_by, ai_reasoning, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending')
    RETURNING id`,
    [
      userId,
      movementId,
      cashEventId,
      bankAmount,
      bankDate,
      bankDescription,
      bankCounterparty,
      invoiceId,
      customerName,
      invoiceAmount,
      matchType,
      confidence,
      feeAmount,
      matchedAmount,
      matchedBy,
      aiReasoning || null,
    ]
  )

  return result.rows[0].id
}

/**
 * Update AR match status
 */
export async function updateARMatchStatus(
  matchId: string,
  status: "confirmed" | "rejected",
  confirmedBy?: string
): Promise<void> {
  await query(
    `UPDATE ar_reconciliation_matches
    SET status = $1, confirmed_at = NOW(), confirmed_by = $2, updated_at = NOW()
    WHERE id = $3`,
    [status, confirmedBy || null, matchId]
  )
}

/**
 * Get a single AR match by ID
 */
export async function getARMatch(matchId: string): Promise<ARMatch | null> {
  const result = await query(
    `SELECT
      id, movement_id, cash_event_id, bank_date, bank_description, bank_counterparty,
      bank_amount, invoice_id, customer_name, invoice_amount, match_type, confidence,
      fee_amount, matched_amount, matched_by, status, confirmed_at, created_at
    FROM ar_reconciliation_matches
    WHERE id = $1`,
    [matchId]
  )

  if (result.rows.length === 0) return null

  const row = result.rows[0]
  return {
    id: row.id,
    movement_id: row.movement_id,
    cash_event_id: row.cash_event_id,
    bank_date: row.bank_date,
    bank_description: row.bank_description,
    bank_counterparty: row.bank_counterparty,
    bank_amount: parseFloat(row.bank_amount),
    invoice_id: row.invoice_id,
    customer_name: row.customer_name,
    invoice_amount: parseFloat(row.invoice_amount),
    match_type: row.match_type,
    confidence: parseFloat(row.confidence),
    fee_amount: parseFloat(row.fee_amount),
    matched_amount: parseFloat(row.matched_amount),
    matched_by: row.matched_by,
    status: row.status,
    confirmed_at: row.confirmed_at,
    created_at: row.created_at,
  }
}
