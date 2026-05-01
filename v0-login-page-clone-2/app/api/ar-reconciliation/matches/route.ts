import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureARMatchesSchema, query } from "@/lib/db"
import { getARMatches, createARMatch } from "@/lib/ar-reconciliation-queries"

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Ensure schema exists
    await ensureARMatchesSchema()

    // Get query parameters
    const url = new URL(request.url)
    const status = url.searchParams.get("status") || undefined
    const limit = parseInt(url.searchParams.get("limit") || "100")
    const offset = parseInt(url.searchParams.get("offset") || "0")

    // Get matches
    const { matches, total } = await getARMatches(user.id, status, limit, offset)

    // Get summary counts for all statuses
    const summaryResult = await query(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
        COALESCE(SUM(bank_amount), 0)::float as total_amount,
        COALESCE(SUM(bank_amount) FILTER (WHERE status = 'confirmed'), 0)::float as confirmed_amount,
        COALESCE(SUM(bank_amount) FILTER (WHERE status = 'pending'), 0)::float as pending_amount
      FROM ar_reconciliation_matches
      WHERE user_id = $1`,
      [user.id]
    )
    
    // Get unmatched inflow movements count
    const unmatchedResult = await query(
      `SELECT 
        COUNT(*) as unmatched_count,
        COALESCE(SUM(m.amount), 0)::float as unmatched_amount
      FROM movements m
      WHERE m.user_id = $1
        AND m.direction = 'inflow'
        AND m.pnl_eligible = true
        AND m.id NOT IN (
          SELECT movement_id FROM ar_reconciliation_matches WHERE user_id = $1
        )`,
      [user.id]
    )
    
    const summary = {
      total: parseInt(summaryResult.rows[0]?.total || "0"),
      pending: parseInt(summaryResult.rows[0]?.pending || "0"),
      confirmed: parseInt(summaryResult.rows[0]?.confirmed || "0"),
      total_amount: summaryResult.rows[0]?.total_amount || 0,
      confirmed_amount: summaryResult.rows[0]?.confirmed_amount || 0,
      pending_amount: summaryResult.rows[0]?.pending_amount || 0,
      unmatched_count: parseInt(unmatchedResult.rows[0]?.unmatched_count || "0"),
      unmatched_amount: unmatchedResult.rows[0]?.unmatched_amount || 0,
    }

    return NextResponse.json({
      matches,
      total,
      summary,
      limit,
      offset,
    })
  } catch (error) {
    console.error("[ar-reconciliation/matches] GET Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Ensure schema exists
    await ensureARMatchesSchema()

    const body = await request.json()

    const {
      movement_id,
      cash_event_id,
      bank_amount,
      bank_date,
      bank_description,
      bank_counterparty,
      invoice_id,
      customer_name,
      invoice_amount,
      match_type,
      confidence,
      matched_by = "manual",
      ai_reasoning,
    } = body

    // Validate required fields
    if (
      !movement_id ||
      !cash_event_id ||
      bank_amount === undefined ||
      !bank_date ||
      !invoice_id ||
      !customer_name ||
      invoice_amount === undefined ||
      !match_type ||
      confidence === undefined
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    // Create match
    const matchId = await createARMatch(
      user.id,
      movement_id,
      cash_event_id,
      bank_amount,
      bank_date,
      bank_description,
      bank_counterparty,
      invoice_id,
      customer_name,
      invoice_amount,
      match_type,
      confidence,
      matched_by,
      ai_reasoning
    )

    return NextResponse.json({ id: matchId }, { status: 201 })
  } catch (error) {
    console.error("[ar-reconciliation/matches] POST Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
