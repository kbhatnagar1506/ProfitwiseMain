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

    // Build WHERE conditions
    const whereConditions = ["ce.user_id = $1", "ce.event_type = 'ar'"]
    const params: unknown[] = [userId]

    const whereClause = whereConditions.join(" AND ")

    // Fetch ALL invoices with reconciliation data
    // The waterfall already updated cash_events.outstanding_amount, so we use that directly
    const invoiceRows = await query<InvoiceRow>(
      `SELECT
        ce.id,
        ce.entity_id,
        ce.amount,
        ce.outstanding_amount,
        ce.expected_date,
        ce.status,
        ce.source,
        ce.metadata
       FROM cash_events ce
       WHERE ${whereClause}
       ORDER BY ce.expected_date ASC, ce.created_at DESC`,
      params
    ).then((r) => r.rows)

    // Calculate days until/overdue and reconciled status
    const today = new Date().toISOString().split("T")[0]
    const invoices = invoiceRows.map((row) => {
      const dueDate = row.expected_date
      const daysDiff = Math.floor(
        (new Date(dueDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
      )

      // Use customer_name from metadata (set during reconciliation)
      const customerName = row.metadata?.customer_name 
        ? String(row.metadata.customer_name)
        : `Invoice ${String(row.entity_id).split("/").pop() || "Unknown"}`

      // Use the waterfall-calculated outstanding_amount and status directly
      const invoiceAmount = parseFloat(String(row.amount))
      const outstandingAmount = parseFloat(String(row.outstanding_amount || 0))

      let reconciled_status: "open" | "overdue" | "partially_paid" | "paid"
      if (outstandingAmount <= 0) {
        reconciled_status = "paid"
      } else if (outstandingAmount < invoiceAmount && daysDiff < 0) {
        reconciled_status = "partially_paid"
      } else if (outstandingAmount < invoiceAmount) {
        reconciled_status = "partially_paid"
      } else if (daysDiff < 0) {
        reconciled_status = "overdue"
      } else {
        reconciled_status = "open"
      }

      return {
        id: row.id,
        entity_id: row.entity_id,
        customer_name: customerName,
        amount: invoiceAmount,
        outstanding_amount: outstandingAmount,
        due_date: row.expected_date,
        status: reconciled_status,
        source: row.source,
        days_until_due: daysDiff,
        days_overdue: daysDiff < 0 ? Math.abs(daysDiff) : null,
        metadata: row.metadata,
      }
    })

    const totals = {
      total_outstanding: invoices.reduce((sum, inv) => sum + inv.outstanding_amount, 0),
      total_overdue: invoices
        .filter((inv) => inv.status === "overdue" || (inv.status === "partially_paid" && inv.days_overdue !== null))
        .reduce((sum, inv) => sum + inv.outstanding_amount, 0),
      invoice_count: invoices.length,
      overdue_count: invoices.filter((inv) => inv.status === "overdue" || (inv.status === "partially_paid" && inv.days_overdue !== null)).length,
    }

    const summaryByStatus = {
      open: invoices.filter((inv) => inv.status === "open").length,
      overdue: invoices.filter((inv) => inv.status === "overdue").length,
      partially_paid: invoices.filter((inv) => inv.status === "partially_paid").length,
      paid: invoices.filter((inv) => inv.status === "paid").length,
    }

    log("dashboard.invoices.success", { userId, invoiceCount: invoices.length })

    return NextResponse.json({
      invoices,
      totals,
      summary_by_status: summaryByStatus,
    })
  } catch (error) {
    log("dashboard.invoices.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch invoices" },
      { status: 500 }
    )
  }
}
