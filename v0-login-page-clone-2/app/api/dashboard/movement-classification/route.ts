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

    // Fetch movements
    const movementsResult = await query<{
      id: string
      occurred_at: string
      direction: "in" | "out"
      amount: number
      raw_description: string | null
      movement_class: string
      confidence: number
      needs_review: boolean
    }>(
      `SELECT 
        m.id,
        m.occurred_at,
        m.direction,
        m.amount,
        m.raw_description,
        COALESCE(m.movement_class, 'unknown') as movement_class,
        COALESCE(m.confidence, 0.5) as confidence,
        COALESCE(m.needs_review, false) as needs_review
      FROM movements m
      WHERE m.user_id = $1 AND m.movement_type != 'internal_transfer'
      ORDER BY m.occurred_at DESC
      LIMIT 100`,
      [userId]
    )

    return NextResponse.json({
      movements: movementsResult.rows,
    })
  } catch (error) {
    console.error("[movement-classification] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch movements" },
      { status: 500 }
    )
  }
}
