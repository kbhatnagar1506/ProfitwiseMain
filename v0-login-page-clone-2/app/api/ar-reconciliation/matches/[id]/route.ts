import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureARMatchesSchema, query, withTransaction } from "@/lib/db"
import { getARMatch, updateARMatchStatus, syncInvoiceStatusFromMatch } from "@/lib/ar-reconciliation-queries"

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

    // Use transaction to update match status and sync invoice status atomically
    await withTransaction(async (client) => {
      // Update match status and get match details
      const matchDetails = await updateARMatchStatus(
        client,
        matchId,
        status,
        confirmed_by || user.id
      )

      // If confirming, mark the invoice as paid
      if (status === "confirmed") {
        await syncInvoiceStatusFromMatch(
          client,
          matchDetails.userId,
          matchDetails.cashEventId,
          matchDetails.matchedAmount,
          "ar_match_confirm"
        )
      }
    })

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

    // Use transaction to delete match and restore invoice status if needed
    await withTransaction(async (client) => {
      // If the match was confirmed, restore the invoice outstanding amount
      if (match.status === "confirmed") {
        await syncInvoiceStatusFromMatch(
          client,
          user.id,
          match.cash_event_id,
          -match.matched_amount, // Negative to restore outstanding
          "ar_match_reject"
        )
      }

      // Delete the match
      await client.query(
        `DELETE FROM ar_reconciliation_matches WHERE id = $1 AND user_id = $2`,
        [matchId, user.id]
      )
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[ar-reconciliation/matches/[id]] DELETE Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
