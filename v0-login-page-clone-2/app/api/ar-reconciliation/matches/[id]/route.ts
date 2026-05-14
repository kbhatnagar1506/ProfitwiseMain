import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureARMatchesSchema, query } from "@/lib/db"
import { getARMatch, updateARMatchStatus } from "@/lib/ar-reconciliation-queries"

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Ensure schema exists
    await ensureARMatchesSchema()

    const { id: matchId } = await params
    const body = await request.json()
    const { status, confirmed_by } = body

    // Validate status
    if (!status || !["confirmed", "rejected"].includes(status)) {
      return NextResponse.json(
        { error: "Invalid status. Must be 'confirmed' or 'rejected'" },
        { status: 400 }
      )
    }

    // Verify match exists and belongs to user
    const match = await getARMatch(matchId)
    if (!match) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 })
    }

    // Update status
    await updateARMatchStatus(matchId, status, confirmed_by || user.id)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[ar-reconciliation/matches/[id]] PATCH Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Ensure schema exists
    await ensureARMatchesSchema()

    const { id: matchId } = await params

    // Verify match exists and belongs to user
    const match = await getARMatch(matchId)
    if (!match) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 })
    }

    // Delete the match
    await query(
      `DELETE FROM ar_reconciliation_matches WHERE id = $1 AND user_id = $2`,
      [matchId, user.id]
    )

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[ar-reconciliation/matches/[id]] DELETE Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
