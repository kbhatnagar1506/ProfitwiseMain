import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureARMatchesSchema } from "@/lib/db"
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

    return NextResponse.json({
      matches,
      total,
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
