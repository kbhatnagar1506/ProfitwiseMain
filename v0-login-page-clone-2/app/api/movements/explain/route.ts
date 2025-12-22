import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import type { MovementDetailResponse } from "@/lib/movement-detail-types"
import { generateMovementExplanation } from "@/lib/movement-explain"
import { createErrorResponse, createSuccessResponse, log } from "@/lib/api-utils"

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")
    if (!user) return NextResponse.json(createErrorResponse("Unauthorized"), { status: 401 })

    const body = await req.json().catch(() => ({}))
    const detail = (body?.detail ?? null) as MovementDetailResponse | null
    if (!detail) {
      log("movements.explain.missing_detail", { userId: user.id })
      return NextResponse.json(createErrorResponse("detail payload required"), { status: 400 })
    }

    const explanation = await generateMovementExplanation(user.id, detail)
    log("movements.explain.success", { userId: user.id, movementId: detail.id })
    return NextResponse.json(createSuccessResponse({ explanation }, { operation: "explain_movement" }))
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log("movements.explain.error", { error: errorMsg, operation: "explain_movement" })
    return NextResponse.json(createErrorResponse("Failed to generate explanation", { details: errorMsg }), { status: 500 })
  }
}
