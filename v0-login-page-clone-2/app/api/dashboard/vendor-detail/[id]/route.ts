import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/require-session"
import { query } from "@/lib/db"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id: vendorId } = await params
    const userId = session.user.id

    console.log(`[vendor-detail] userId=${userId} vendorId=${vendorId}`)

    // Fetch recent transactions for this vendor
    const transactionsResult = await query(
      `SELECT 
        id, 
        transaction_date as date, 
        amount,
        description,
        status
      FROM cash_events 
      WHERE entity_id = $1 AND user_id = $2
      ORDER BY transaction_date DESC 
      LIMIT 50`,
      [vendorId, userId]
    )

    const transactions = transactionsResult.rows.map((row: any) => ({
      id: row.id,
      date: row.date,
      amount: Number(row.amount) || 0,
      description: row.description,
      status: row.status,
    }))

    // Generate spark data for charts
    const amountSparkData = transactions
      .slice(0, 12)
      .reverse()
      .map((t: any, i: number) => ({
        date: `Day ${i + 1}`,
        amount: t.amount,
      }))

    // Monthly data
    const monthlyData = Array.from({ length: 12 }, (_, i) => {
      const month = i + 1
      const count = transactions.filter((t: any) => {
        const d = new Date(t.date)
        return d.getMonth() + 1 === month
      }).length
      return {
        month: ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"][i],
        count,
      }
    })

    // Days to pay trend (mock data)
    const dtpData = Array.from({ length: 6 }, (_, i) => ({
      label: `W${i + 1}`,
      dtp: Math.floor(Math.random() * 20 - 10),
    }))

    return NextResponse.json({
      transactions,
      amountSparkData,
      monthlyData,
      dtpData,
    })
  } catch (error) {
    console.error("[vendor-detail] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
