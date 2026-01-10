import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type TransactionRow = {
  id: string
  direction: string
  amount: number | string
  date: string
  movement_type: string
  counterparty: string | null
  raw_description: string | null
  cash_account_id: string | null
  pnl_eligible: boolean
  review_needed: boolean
  currency: string | null
  confidence: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  economic_class: string | null
  cashflow_bucket: string | null
  counterparty_role: string | null
  tag_data: Record<string, unknown> | null
  account_name: string | null
  account_mask: string | null
  entity_name: string | null
  counterparty_entity_id: string | null
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("dashboard.transactions.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id
    const searchParams = request.nextUrl.searchParams

    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10))
    const limit = Math.min(100, Math.max(10, parseInt(searchParams.get("limit") || "50", 10)))
    const offset = (page - 1) * limit

    const accountId = searchParams.get("account_id")
    const direction = searchParams.get("direction")
    const economicClass = searchParams.get("economic_class")
    const cashflowBucket = searchParams.get("cashflow_bucket")
    const reviewNeeded = searchParams.get("review_needed") === "true"
    const search = searchParams.get("search")

    // Build WHERE clause dynamically
    const whereConditions = ["m.user_id = $1", "m.duplicate_of IS NULL"]
    const params: unknown[] = [userId]
    let paramIndex = 2

    if (accountId) {
      whereConditions.push(`m.cash_account_id = $${paramIndex}`)
      params.push(accountId)
      paramIndex++
    }

    if (direction && (direction === "inflow" || direction === "outflow")) {
      whereConditions.push(`m.direction = $${paramIndex}`)
      params.push(direction)
      paramIndex++
    }

    if (economicClass) {
      whereConditions.push(`mt.economic_class = $${paramIndex}`)
      params.push(economicClass)
      paramIndex++
    }

    if (cashflowBucket) {
      whereConditions.push(`mt.cashflow_bucket = $${paramIndex}`)
      params.push(cashflowBucket)
      paramIndex++
    }

    if (reviewNeeded) {
      whereConditions.push(`m.review_needed = true`)
    }

    if (search) {
      whereConditions.push(`(m.raw_description ILIKE $${paramIndex} OR m.counterparty ILIKE $${paramIndex})`)
      params.push(`%${search}%`)
      paramIndex++
    }

    const whereClause = whereConditions.join(" AND ")

    // Fetch transactions
    const txnRows = await query<TransactionRow>(
      `SELECT
        m.id, m.direction, m.amount, m.date, m.movement_type,
        m.counterparty, m.raw_description, m.cash_account_id,
        m.pnl_eligible, m.review_needed, m.currency,
        m.confidence, m.metadata,
        mt.economic_class, mt.cashflow_bucket, mt.counterparty_role,
        mt.tag_data,
        pa.name AS account_name, pa.mask AS account_mask,
        e.canonical_name AS entity_name, m.counterparty_entity_id
      FROM movements m
      LEFT JOIN movement_tags mt ON mt.movement_id = m.id
      LEFT JOIN plaid_accounts pa ON pa.account_id = m.cash_account_id
      LEFT JOIN entities e ON e.id = m.counterparty_entity_id
      WHERE ${whereClause}
      ORDER BY m.date DESC, m.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    ).then((r) => r.rows)

    // Fetch total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text FROM movements m
       LEFT JOIN movement_tags mt ON mt.movement_id = m.id
       WHERE ${whereClause}`,
      params
    ).then((r) => r.rows[0])

    const total = countResult ? parseInt(countResult.count, 10) : 0
    const totalPages = Math.ceil(total / limit)

    // Fetch summary aggregations
    const summaryResult = await query<{
      total_inflow: string | null
      total_outflow: string | null
      txn_count: string
      pnl_count: string
      review_needed_count: string
    }>(
      `SELECT
        COALESCE(SUM(CASE WHEN m.direction='inflow' THEN m.amount ELSE 0 END), 0)::text AS total_inflow,
        COALESCE(SUM(CASE WHEN m.direction='outflow' THEN m.amount ELSE 0 END), 0)::text AS total_outflow,
        COUNT(*)::text AS txn_count,
        SUM(CASE WHEN mt.tag_data->>'hits_pnl' = 'true' THEN 1 ELSE 0 END)::text AS pnl_count,
        SUM(CASE WHEN m.review_needed = true THEN 1 ELSE 0 END)::text AS review_needed_count
      FROM movements m
      LEFT JOIN movement_tags mt ON mt.movement_id = m.id
      WHERE ${whereClause}`,
      params
    ).then((r) => r.rows[0])

    // Fetch by_economic_class breakdown
    const byEconomicClassResult = await query<{ economic_class: string | null; count: string }>(
      `SELECT mt.economic_class, COUNT(*)::text AS count
       FROM movements m
       LEFT JOIN movement_tags mt ON mt.movement_id = m.id
       WHERE ${whereClause}
       GROUP BY mt.economic_class
       ORDER BY count DESC`,
      params
    ).then((r) => r.rows)

    const byEconomicClass: Record<string, number> = {}
    for (const row of byEconomicClassResult) {
      if (row.economic_class) {
        byEconomicClass[row.economic_class] = parseInt(row.count, 10)
      }
    }

    // Fetch by_cashflow_bucket breakdown
    const byCashflowBucketResult = await query<{ cashflow_bucket: string | null; count: string }>(
      `SELECT mt.cashflow_bucket, COUNT(*)::text AS count
       FROM movements m
       LEFT JOIN movement_tags mt ON mt.movement_id = m.id
       WHERE ${whereClause}
       GROUP BY mt.cashflow_bucket
       ORDER BY count DESC`,
      params
    ).then((r) => r.rows)

    const byCashflowBucket: Record<string, number> = {}
    for (const row of byCashflowBucketResult) {
      if (row.cashflow_bucket) {
        byCashflowBucket[row.cashflow_bucket] = parseInt(row.count, 10)
      }
    }

    // Transform transactions
    const transactions = txnRows.map((row) => {
      const tagData = (row.tag_data || {}) as Record<string, unknown>
      const displayName =
        tagData.display_name ||
        row.entity_name ||
        row.counterparty ||
        row.raw_description ||
        "Unknown"

      return {
        id: row.id,
        date: row.date,
        description: row.raw_description || row.counterparty || "Unknown",
        counterparty: row.counterparty,
        entity_name: row.entity_name,
        display_name: displayName,
        amount: parseFloat(String(row.amount)),
        direction: row.direction as "inflow" | "outflow",
        currency: row.currency || "USD",
        movement_type: row.movement_type,
        account_name: row.account_name,
        account_mask: row.account_mask,
        pnl_eligible: row.pnl_eligible,
        review_needed: row.review_needed,
        classification: {
          economic_class: row.economic_class,
          cashflow_bucket: row.cashflow_bucket,
          counterparty_role: row.counterparty_role,
          hits_pnl: tagData.hits_pnl ?? false,
          is_operating: tagData.is_operating ?? false,
          is_financing: tagData.is_financing ?? false,
          is_recurring: tagData.is_recurring ?? false,
          is_anomaly: tagData.is_anomaly ?? false,
          is_large_outlier: tagData.is_large_outlier ?? false,
          is_first_seen_counterparty: tagData.is_first_seen_counterparty ?? false,
          policy_status: tagData.policy_status ?? null,
          classification_confidence: tagData.classification_confidence ?? 0,
          evidence_strength: tagData.evidence_strength ?? 0,
          expense_subtype: tagData.expense_subtype ?? null,
          settlement_subtype: tagData.settlement_subtype ?? null,
          needs_review: tagData.needs_review ?? false,
          review_reasons: (tagData.review_reasons as string[]) ?? [],
        },
      }
    })

    const summary = {
      total_inflow: summaryResult ? parseFloat(summaryResult.total_inflow || "0") : 0,
      total_outflow: summaryResult ? parseFloat(summaryResult.total_outflow || "0") : 0,
      net: summaryResult
        ? parseFloat(summaryResult.total_inflow || "0") - parseFloat(summaryResult.total_outflow || "0")
        : 0,
      txn_count: summaryResult ? parseInt(summaryResult.txn_count, 10) : 0,
      pnl_count: summaryResult ? parseInt(summaryResult.pnl_count, 10) : 0,
      review_needed_count: summaryResult ? parseInt(summaryResult.review_needed_count, 10) : 0,
      by_economic_class: byEconomicClass,
      by_cashflow_bucket: byCashflowBucket,
    }

    log("dashboard.transactions.success", { userId, txnCount: transactions.length, page, limit })

    return NextResponse.json({
      transactions,
      pagination: { page, limit, total, total_pages: totalPages },
      summary,
    })
  } catch (error) {
    log("dashboard.transactions.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch transactions" },
      { status: 500 }
    )
  }
}
