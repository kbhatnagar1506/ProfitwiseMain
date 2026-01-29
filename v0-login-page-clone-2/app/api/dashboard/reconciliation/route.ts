import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/require-session"
import { query } from "@/lib/db"

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = session.id

    // Fetch AR invoices
    const arResult = await query<{
      id: string
      customer_name: string
      amount: number
      outstanding_amount: number
      status: "open" | "partially_paid" | "paid"
      due_date: string
    }>(
      `SELECT 
        ce.id,
        COALESCE(ce.metadata->>'customer_name', 'Unknown') as customer_name,
        COALESCE((ce.metadata->>'amount')::numeric, 0) as amount,
        COALESCE(ce.outstanding_amount, 0) as outstanding_amount,
        COALESCE(ce.status, 'open') as status,
        COALESCE(ce.expected_date, NOW())::date as due_date
      FROM cash_events ce
      WHERE ce.user_id = $1 AND ce.event_type = 'ar'
      ORDER BY ce.expected_date ASC`,
      [userId]
    )

    // Fetch AP bills
    const apResult = await query<{
      id: string
      customer_name: string
      amount: number
      outstanding_amount: number
      status: "open" | "partially_paid" | "paid"
      due_date: string
    }>(
      `SELECT 
        ce.id,
        COALESCE(ce.metadata->>'vendor_name', 'Unknown') as customer_name,
        COALESCE((ce.metadata->>'amount')::numeric, 0) as amount,
        COALESCE(ce.outstanding_amount, 0) as outstanding_amount,
        COALESCE(ce.status, 'open') as status,
        COALESCE(ce.expected_date, NOW())::date as due_date
      FROM cash_events ce
      WHERE ce.user_id = $1 AND ce.event_type = 'ap'
      ORDER BY ce.expected_date ASC`,
      [userId]
    )

    return NextResponse.json({
      invoices: arResult.rows,
      bills: apResult.rows,
    })
  } catch (error) {
    console.error("[reconciliation] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch reconciliation data" },
      { status: 500 }
    )
  }
}
