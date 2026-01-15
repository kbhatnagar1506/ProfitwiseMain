import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type VendorRow = {
  vendor_name: string
  total_bills: number
  total_outstanding: number
  total_overdue: number
  overdue_count: number
  open_count: number
  paid_count: number
}

export async function GET(request?: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("dashboard.vendors.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id

    // Aggregate bills by vendor with reconciliation status
    const vendorRows = await query<VendorRow>(
      `SELECT
        COALESCE(ce.metadata->>'vendor_name', 'Unknown Vendor') as vendor_name,
        COUNT(*) as total_bills,
        SUM(ce.amount) as total_outstanding,
        SUM(CASE WHEN ce.outstanding_amount > 0 AND (
          (EXTRACT(DAY FROM (ce.expected_date::date - CURRENT_DATE)) < 0)
        ) THEN ce.outstanding_amount ELSE 0 END) as total_overdue,
        SUM(CASE WHEN ce.outstanding_amount > 0 AND (
          (EXTRACT(DAY FROM (ce.expected_date::date - CURRENT_DATE)) < 0)
        ) THEN 1 ELSE 0 END) as overdue_count,
        SUM(CASE WHEN ce.outstanding_amount > 0 AND (
          (EXTRACT(DAY FROM (ce.expected_date::date - CURRENT_DATE)) >= 0)
        ) THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN ce.outstanding_amount <= 0 THEN 1 ELSE 0 END) as paid_count
       FROM cash_events ce
       WHERE ce.user_id = $1 AND ce.event_type = 'ap'
       GROUP BY vendor_name
       ORDER BY total_outstanding DESC`,
      [userId]
    ).then((r) => r.rows)

    const vendors = vendorRows.map((row) => ({
      vendor_name: String(row.vendor_name),
      total_bills: parseInt(String(row.total_bills), 10),
      total_outstanding: parseFloat(String(row.total_outstanding || 0)),
      total_overdue: parseFloat(String(row.total_overdue || 0)),
      overdue_count: parseInt(String(row.overdue_count || 0), 10),
      open_count: parseInt(String(row.open_count || 0), 10),
      paid_count: parseInt(String(row.paid_count || 0), 10),
    }))

    const totals = {
      total_vendors: vendors.length,
      total_outstanding: vendors.reduce((sum, v) => sum + v.total_outstanding, 0),
      total_overdue: vendors.reduce((sum, v) => sum + v.total_overdue, 0),
    }

    log("dashboard.vendors.success", { userId, vendorCount: vendors.length })

    return NextResponse.json({
      vendors,
      totals,
    })
  } catch (error) {
    log("dashboard.vendors.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch vendors" },
      { status: 500 }
    )
  }
}
