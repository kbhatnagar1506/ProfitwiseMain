import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"
import { validateUUID, validateRequiredFields, createErrorResponse, createSuccessResponse } from "@/lib/api-utils"

async function getUser() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  return getUserBySessionToken(sessionToken ?? "")
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json(createErrorResponse("Unauthorized"), { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const { entity_id, feedback_type, feedback_value, notes } = body

    // Validate required fields
    const validation = validateRequiredFields(body, ["entity_id", "feedback_type"])
    if (!validation.valid) {
      log("entity_profile.feedback.missing_fields", { userId: user.id, missingFields: validation.missingFields })
      return NextResponse.json(createErrorResponse(`Missing required fields: ${validation.missingFields.join(", ")}`), { status: 400 })
    }

    // Validate UUID format
    if (!validateUUID(entity_id)) {
      log("entity_profile.feedback.invalid_uuid", { userId: user.id, entity_id })
      return NextResponse.json(createErrorResponse("Invalid entity_id format"), { status: 400 })
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

    return NextResponse.json(createSuccessResponse({ feedback_id: result.rows[0].id }, { operation: "save_feedback" }))
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log("entity_profile.feedback.error", { error: errorMsg, operation: "save_feedback" })
    return NextResponse.json(createErrorResponse("Failed to save feedback", { details: errorMsg }), { status: 500 })
  }
}

export async function GET(request: Request) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json(createErrorResponse("Unauthorized"), { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const entityId = searchParams.get("entity_id")

    // Validate UUID if provided
    if (entityId && !validateUUID(entityId)) {
      log("entity_profile.feedback.invalid_uuid", { userId: user.id, entity_id: entityId })
      return NextResponse.json(createErrorResponse("Invalid entity_id format"), { status: 400 })
    }

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

    log("entity_profile.feedback.fetched", { userId: user.id, count: result.rows.length })
    return NextResponse.json(createSuccessResponse({ feedback: result.rows }, { operation: "fetch_feedback" }))
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log("entity_profile.feedback.fetch_error", { error: errorMsg, operation: "fetch_feedback" })
    return NextResponse.json(createErrorResponse("Failed to fetch feedback", { details: errorMsg }), { status: 500 })
  }
}
