import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type MarkDuplicateRequest = {
  primary_id: string
  duplicate_ids: string[]
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("reconciliation.mark_duplicate.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id
    const body: MarkDuplicateRequest = await request.json()
    const { primary_id, duplicate_ids } = body

    if (!primary_id || !duplicate_ids || duplicate_ids.length === 0) {
      return NextResponse.json(
        { error: "Missing required fields: primary_id, duplicate_ids" },
        { status: 400 }
      )
    }

    // Mark all duplicates as pointing to the primary
    for (const duplicate_id of duplicate_ids) {
      await query(
        `UPDATE movements 
         SET duplicate_of = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3`,
        [primary_id, duplicate_id, userId]
      )
    }

    log("reconciliation.mark_duplicate.success", {
      userId,
      primary_id,
      duplicate_count: duplicate_ids.length,
    })

    return NextResponse.json({
      success: true,
      message: `Marked ${duplicate_ids.length} transactions as duplicates`,
      primary_id,
      duplicate_count: duplicate_ids.length,
    })
  } catch (error) {
    log("reconciliation.mark_duplicate.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to mark duplicates" },
      { status: 500 }
    )
  }
}
