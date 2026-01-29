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

    // Fetch entity profiles summary
    const summaryResult = await query<{
      total_customers: number
      total_vendors: number
      total_lifetime_value: number
      at_risk_count: number
    }>(
      `SELECT 
        COUNT(CASE WHEN entity_type = 'customer' THEN 1 END) as total_customers,
        COUNT(CASE WHEN entity_type = 'vendor' THEN 1 END) as total_vendors,
        COALESCE(SUM(CASE WHEN entity_type IN ('customer', 'vendor') THEN lifetime_value ELSE 0 END), 0) as total_lifetime_value,
        0 as at_risk_count
      FROM entities
      WHERE user_id = $1`,
      [userId]
    )

    // Fetch top customers and vendors
    const profilesResult = await query<{
      id: string
      entity_type: "customer" | "vendor"
      canonical_name: string
      display_name: string | null
      archetype: string | null
      transaction_count: number
      lifetime_value: number
    }>(
      `SELECT 
        e.id,
        e.entity_type,
        e.canonical_name,
        e.display_name,
        e.archetype,
        COUNT(m.id) as transaction_count,
        COALESCE(SUM(ABS(m.amount)), 0) as lifetime_value
      FROM entities e
      LEFT JOIN movements m ON e.id = m.entity_id AND m.user_id = $1
      WHERE e.user_id = $1 AND e.entity_type IN ('customer', 'vendor')
      GROUP BY e.id, e.entity_type, e.canonical_name, e.display_name, e.archetype
      ORDER BY lifetime_value DESC
      LIMIT 20`,
      [userId]
    )

    const summary = summaryResult.rows[0] || {
      total_customers: 0,
      total_vendors: 0,
      total_lifetime_value: 0,
      at_risk_count: 0,
    }

    return NextResponse.json({
      summary,
      profiles: profilesResult.rows,
    })
  } catch (error) {
    console.error("[entity-profiles] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch entity profiles" },
      { status: 500 }
    )
  }
}
