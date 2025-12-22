import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

async function getUser() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  return getUserBySessionToken(sessionToken ?? "")
}

export async function POST() {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await (await import("next/server")).NextRequest.prototype.json.call(
      new (await import("next/server")).NextRequest(new Request("http://localhost", { method: "POST" }))
    )

    const { entity_id, feedback_type, feedback_value, notes } = body

    if (!entity_id || !feedback_type) {
      return NextResponse.json(
        { error: "Missing required fields: entity_id, feedback_type" },
        { status: 400 }
      )
    }

    // Save entity profile feedback
    const result = await query(
      `INSERT INTO entity_profile_feedback (user_id, entity_id, feedback_type, feedback_value, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [user.id, entity_id, feedback_type, feedback_value || null, notes || null]
    )

    log("entity_profile.feedback.saved", {
      userId: user.id,
      entityId: entity_id,
      feedbackType: feedback_type,
    })

    return NextResponse.json({
      success: true,
      feedback_id: result.rows[0].id,
    })
  } catch (err) {
    log("entity_profile.feedback.error", { error: String(err) })
    return NextResponse.json(
      { error: "Failed to save feedback" },
      { status: 500 }
    )
  }
}

export async function GET(request: Request) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const entityId = searchParams.get("entity_id")

    let query_str = `SELECT entity_id, feedback_type, feedback_value, notes, created_at
                     FROM entity_profile_feedback
                     WHERE user_id = $1`
    const params: any[] = [user.id]

    if (entityId) {
      query_str += ` AND entity_id = $2`
      params.push(entityId)
    }

    query_str += ` ORDER BY created_at DESC LIMIT 100`

    const result = await query(query_str, params)

    return NextResponse.json({
      feedback: result.rows,
    })
  } catch (err) {
    log("entity_profile.feedback.fetch_error", { error: String(err) })
    return NextResponse.json(
      { error: "Failed to fetch feedback" },
      { status: 500 }
    )
  }
}
