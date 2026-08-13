import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type TransferRow = {
  id: string
  direction: string
  amount: number | string
  date: string
  movement_type: string
  counterparty: string | null
  raw_description: string | null
  cash_account_id: string | null
  linked_internal_account_id: string | null
  currency: string | null
  metadata: Record<string, unknown> | null
  tag_data: Record<string, unknown> | null
  src_account_name: string | null
  src_account_mask: string | null
  dst_account_name: string | null
  dst_account_mask: string | null
  entity_name: string | null
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("dashboard.transfers.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id
    const searchParams = request.nextUrl.searchParams

    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10))
    const limit = Math.min(100, Math.max(10, parseInt(searchParams.get("limit") || "50", 10)))
    const offset = (page - 1) * limit

    const accountId = searchParams.get("account_id")
    const dateFrom = searchParams.get("date_from")
    const dateTo = searchParams.get("date_to")
    const search = searchParams.get("search")

    const whereConditions = [
      "m.user_id = $1",
      "m.duplicate_of IS NULL",
      "m.movement_type = 'internal_transfer'",
    ]
    const params: unknown[] = [userId]
    let paramIndex = 2

    if (accountId) {
      whereConditions.push(
        `(m.cash_account_id = $${paramIndex} OR m.linked_internal_account_id = $${paramIndex})`
      )
      params.push(accountId)
      paramIndex++
    }

    if (dateFrom) {
      whereConditions.push(`m.date >= $${paramIndex}`)
      params.push(dateFrom)
      paramIndex++
    }

    if (dateTo) {
      whereConditions.push(`m.date <= $${paramIndex}`)
      params.push(dateTo)
      paramIndex++
    }

    if (search) {
      whereConditions.push(
        `(m.raw_description ILIKE $${paramIndex} OR m.counterparty ILIKE $${paramIndex})`
      )
      params.push(`%${search}%`)
      paramIndex++
    }

    const whereClause = whereConditions.join(" AND ")

    const txnRows = await query<TransferRow>(
      `SELECT
        m.id, m.direction, m.amount, m.date, m.movement_type,
        m.counterparty, m.raw_description, m.cash_account_id,
        m.linked_internal_account_id, m.currency, m.metadata,
        mt.tag_data,
        pa_src.name  AS src_account_name,  pa_src.mask  AS src_account_mask,
        pa_dst.name  AS dst_account_name,  pa_dst.mask  AS dst_account_mask,
        e.canonical_name AS entity_name
      FROM movements m
      LEFT JOIN movement_tags mt ON mt.movement_id = m.id
      LEFT JOIN plaid_accounts pa_src ON pa_src.account_id = m.cash_account_id
      LEFT JOIN plaid_accounts pa_dst ON pa_dst.name = m.linked_internal_account_id
        AND pa_dst.item_id IN (SELECT item_id FROM plaid_items WHERE user_id = $1)
      LEFT JOIN entities e ON e.id = m.counterparty_entity_id
      WHERE ${whereClause}
      ORDER BY m.date DESC, m.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    ).then((r) => r.rows)

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text FROM movements m WHERE ${whereConditions.filter((_, i) => i < whereConditions.length).join(" AND ")}`,
      params
    ).then((r) => r.rows[0])

    const total = countResult ? parseInt(countResult.count, 10) : 0
    const totalPages = Math.ceil(total / limit)

    const summaryResult = await query<{
      total_count: string
      total_volume: string
      paired_count: string
      unpaired_count: string
    }>(
      `SELECT
        COUNT(*)::text AS total_count,
        COALESCE(SUM(m.amount), 0)::text AS total_volume,
        SUM(CASE WHEN m.metadata->>'transfer_type' = 'cross_account' THEN 1 ELSE 0 END)::text AS paired_count,
        SUM(CASE WHEN m.metadata->>'transfer_type' IS DISTINCT FROM 'cross_account' THEN 1 ELSE 0 END)::text AS unpaired_count
      FROM movements m
      WHERE ${whereClause}`,
      params
    ).then((r) => r.rows[0])

    const netFlowRows = await query<{
      account_id: string
      account_name: string | null
      mask: string | null
      net: string
    }>(
      `SELECT
        acct.account_id,
        acct.name AS account_name,
        acct.mask,
        COALESCE(
          SUM(CASE WHEN m.cash_account_id = acct.account_id AND m.direction = 'inflow' THEN m.amount
                   WHEN m.cash_account_id = acct.account_id AND m.direction = 'outflow' THEN -m.amount
                   ELSE 0 END),
          0
        )::text AS net
      FROM movements m
      JOIN plaid_accounts acct ON acct.account_id = m.cash_account_id
      WHERE m.user_id = $1 AND m.duplicate_of IS NULL AND m.movement_type = 'internal_transfer'
      GROUP BY acct.account_id, acct.name, acct.mask
      ORDER BY ABS(SUM(CASE WHEN m.direction = 'inflow' THEN m.amount ELSE -m.amount END)) DESC`,
      [userId]
    ).then((r) => r.rows)

    const transfers = txnRows.map((row) => {
      const tagData = (row.tag_data || {}) as Record<string, unknown>
      const meta = (row.metadata || {}) as Record<string, unknown>
      const isPaired = meta.transfer_type === "cross_account"
      const isOutflow = row.direction === "outflow"

      const displayName =
        (tagData.display_name as string) ||
        row.entity_name ||
        row.counterparty ||
        row.raw_description ||
        "Internal Transfer"

      const metaFrom = meta.from_account_name as string | undefined
      const metaTo = meta.to_account_name as string | undefined

      const srcAcct = {
        id: row.cash_account_id,
        name: row.src_account_name ?? metaFrom ?? null,
        mask: row.src_account_mask,
      }
      const dstAcct = {
        id: row.linked_internal_account_id,
        name: row.dst_account_name ?? row.linked_internal_account_id ?? metaTo ?? null,
        mask: row.dst_account_mask,
      }

      let fromAcct, toAcct
      if (isOutflow) {
        fromAcct = { ...srcAcct, name: srcAcct.name ?? metaFrom ?? null }
        toAcct = { ...dstAcct, name: dstAcct.name ?? metaTo ?? row.counterparty ?? null }
      } else {
        fromAcct = { ...dstAcct, name: dstAcct.name ?? metaFrom ?? row.counterparty ?? null }
        toAcct = { ...srcAcct, name: srcAcct.name ?? metaTo ?? null }
      }

      return {
        id: row.id,
        date: row.date,
        amount: parseFloat(String(row.amount)),
        direction: row.direction as "inflow" | "outflow",
        description: row.raw_description || row.counterparty || "Internal Transfer",
        display_name: displayName,
        currency: row.currency || "USD",
        is_paired: isPaired,
        confidence: (tagData.classification_confidence as number) ?? 0,
        source_account: fromAcct,
        destination_account: toAcct,
      }
    })

    const summary = {
      total_count: summaryResult ? parseInt(summaryResult.total_count, 10) : 0,
      total_volume: summaryResult ? parseFloat(summaryResult.total_volume) : 0,
      paired_count: summaryResult ? parseInt(summaryResult.paired_count, 10) : 0,
      unpaired_count: summaryResult ? parseInt(summaryResult.unpaired_count, 10) : 0,
      net_flow_by_account: netFlowRows.map((r) => ({
        account_id: r.account_id,
        account_name: r.account_name,
        mask: r.mask,
        net: parseFloat(r.net),
      })),
    }

    log("dashboard.transfers.success", { userId, count: transfers.length, page, limit })

    return NextResponse.json({
      transfers,
      pagination: { page, limit, total, total_pages: totalPages },
      summary,
    })
  } catch (error) {
    log("dashboard.transfers.error", { error: String(error) })
    return NextResponse.json({ error: "Failed to fetch transfers" }, { status: 500 })
  }
}
