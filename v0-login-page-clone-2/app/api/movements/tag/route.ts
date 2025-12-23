import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { tagMovements } from "@/lib/movement-tag-enrich"
import { createErrorResponse, createSuccessResponse } from "@/lib/api-utils"
import { log } from "@/lib/logger"

export async function POST() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json(createErrorResponse("Unauthorized"), { status: 401 })

  try {
    const { tags, stats, unresolved_impact, owner_dependency, working_capital } = await tagMovements(user.id)
    log("movements.tag.success", { userId: user.id, tagged: tags.length })
    return NextResponse.json(createSuccessResponse({ tagged: tags.length, stats, unresolved_impact, owner_dependency, working_capital }, { operation: "tag_movements" }))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log("movements.tag.error", { userId: user.id, error: msg, operation: "tag_movements" })
    return NextResponse.json(createErrorResponse("Failed to tag movements", { details: msg }), { status: 500 })
  }
}
