import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type BillRow = {
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
    log("dashboard.bills.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id

    const whereConditions = ["ce.user_id = $1", "ce.event_type = 'ap'"]
    const params: unknown[] = [userId]

    const whereClause = whereConditions.join(" AND ")

    const billRows = await query<BillRow>(
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

    const today = new Date().toISOString().split("T")[0]
    const bills = billRows.map((row) => {
      const dueDate = row.expected_date
      const daysDiff = Math.floor(
        (new Date(dueDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
      )

      const vendorName = row.metadata?.vendor_name 
        ? String(row.metadata.vendor_name)
        : `Bill ${String(row.entity_id).split("/").pop() || "Unknown"}`

      const billAmount = parseFloat(String(row.amount))
      const outstandingAmount = parseFloat(String(row.outstanding_amount || 0))

      let reconciled_status: "open" | "overdue" | "partially_paid" | "paid"
      if (outstandingAmount <= 0) {
        reconciled_status = "paid"
      } else if (outstandingAmount < billAmount && daysDiff < 0) {
        reconciled_status = "partially_paid"
      } else if (outstandingAmount < billAmount) {
        reconciled_status = "partially_paid"
      } else if (daysDiff < 0) {
        reconciled_status = "overdue"
      } else {
        reconciled_status = "open"
      }

      return {
        id: row.id,
        entity_id: row.entity_id,
        vendor_name: vendorName,
        amount: billAmount,
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
      total_outstanding: bills.reduce((sum, bill) => sum + bill.outstanding_amount, 0),
      total_overdue: bills
        .filter((bill) => bill.status === "overdue" || (bill.status === "partially_paid" && bill.days_overdue !== null))
        .reduce((sum, bill) => sum + bill.outstanding_amount, 0),
      bill_count: bills.length,
      overdue_count: bills.filter((bill) => bill.status === "overdue" || (bill.status === "partially_paid" && bill.days_overdue !== null)).length,
    }

    const summaryByStatus = {
      open: bills.filter((bill) => bill.status === "open").length,
      overdue: bills.filter((bill) => bill.status === "overdue").length,
      partially_paid: bills.filter((bill) => bill.status === "partially_paid").length,
      paid: bills.filter((bill) => bill.status === "paid").length,
    }

    log("dashboard.bills.success", { userId, billCount: bills.length })

    return NextResponse.json({
      bills,
      totals,
      summary_by_status: summaryByStatus,
    })
  } catch (error) {
    log("dashboard.bills.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch bills" },
      { status: 500 }
    )
  }
}
