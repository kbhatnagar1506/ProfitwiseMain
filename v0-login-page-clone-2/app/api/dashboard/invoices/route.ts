import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type InvoiceRow = {
  id: string
  entity_id: string
  amount: number | string
  outstanding_amount: number | string | null
  expected_date: string
  status: string
  source: string
  metadata: Record<string, unknown>
  canonical_name: string | null
}

export async function GET(request?: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("dashboard.invoices.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id
    const url = new URL(request?.url ?? "")
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10))
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10)))
    const status = url.searchParams.get("status") ?? "" // all, open, overdue, paid, partially_paid
    const search = url.searchParams.get("search") ?? ""
    const dateRange = url.searchParams.get("date_range") ?? "" // last_30_days, last_90_days, custom

    const offset = (page - 1) * limit

    // Build WHERE conditions
    const whereConditions = ["ce.user_id = $1", "ce.event_type = 'ar'"]
    const params: unknown[] = [userId]
    let paramIndex = 2

    // Status filter
    if (status && status !== "all") {
      whereConditions.push(`ce.status = $${paramIndex}`)
      params.push(status)
      paramIndex++
    }

    // Date range filter
    if (dateRange === "last_30_days") {
      whereConditions.push(`ce.expected_date >= CURRENT_DATE - INTERVAL '30 days'`)
    } else if (dateRange === "last_90_days") {
      whereConditions.push(`ce.expected_date >= CURRENT_DATE - INTERVAL '90 days'`)
    }

    // Search filter (customer name)
    if (search) {
      whereConditions.push(`e.canonical_name ILIKE $${paramIndex}`)
      params.push(`%${search}%`)
      paramIndex++
    }

    const whereClause = whereConditions.join(" AND ")

    // Fetch total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM cash_events ce
       LEFT JOIN entities e ON e.id = ce.entity_id::uuid
       WHERE ${whereClause}`,
      params
    ).then((r) => r.rows[0])

    const totalCount = parseInt(countResult?.count ?? "0", 10)

    // Fetch invoices
    const invoiceRows = await query<InvoiceRow>(
      `SELECT
        ce.id,
        ce.entity_id,
        ce.amount,
        ce.outstanding_amount,
        ce.expected_date,
        ce.status,
        ce.source,
        ce.metadata,
        e.canonical_name
       FROM cash_events ce
       LEFT JOIN entities e ON e.id = ce.entity_id::uuid
       WHERE ${whereClause}
       ORDER BY ce.expected_date ASC, ce.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    ).then((r) => r.rows)

    // Calculate days until/overdue
    const today = new Date().toISOString().split("T")[0]
    const invoices = invoiceRows.map((row) => {
      const dueDate = row.expected_date
      const daysDiff = Math.floor(
        (new Date(dueDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
      )

      return {
        id: row.id,
        entity_id: row.entity_id,
        customer_name: row.canonical_name || "Unknown Customer",
        amount: parseFloat(String(row.amount)),
        outstanding_amount: row.outstanding_amount ? parseFloat(String(row.outstanding_amount)) : parseFloat(String(row.amount)),
        due_date: row.expected_date,
        status: row.status,
        source: row.source,
        days_until_due: daysDiff,
        days_overdue: daysDiff < 0 ? Math.abs(daysDiff) : null,
        metadata: row.metadata,
      }
    })

    // Calculate totals
    const totals = {
      total_outstanding: invoices.reduce((sum, inv) => sum + inv.outstanding_amount, 0),
      total_overdue: invoices
        .filter((inv) => inv.status === "overdue" || (inv.days_overdue !== null && inv.days_overdue > 0))
        .reduce((sum, inv) => sum + inv.outstanding_amount, 0),
      invoice_count: invoices.length,
      overdue_count: invoices.filter((inv) => inv.status === "overdue" || (inv.days_overdue !== null && inv.days_overdue > 0)).length,
    }

    // Summary by status
    const summaryByStatus = {
      open: invoices.filter((inv) => inv.status === "open").length,
      overdue: invoices.filter((inv) => inv.status === "overdue" || (inv.days_overdue !== null && inv.days_overdue > 0)).length,
      partially_paid: invoices.filter((inv) => inv.status === "partially_paid").length,
      paid: invoices.filter((inv) => inv.status === "paid").length,
    }

    log("dashboard.invoices.success", { userId, invoiceCount: invoices.length, totalCount })

    return NextResponse.json({
      invoices,
      totals,
      summary_by_status: summaryByStatus,
      pagination: {
        page,
        limit,
        total: totalCount,
        pages: Math.ceil(totalCount / limit),
      },
    })
  } catch (error) {
    log("dashboard.invoices.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch invoices" },
      { status: 500 }
    )
  }
}
