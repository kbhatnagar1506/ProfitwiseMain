import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { populateEntityRelationships } from "@/lib/entity-relationship-detection"
import { log } from "@/lib/logger"

async function getUser() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  return getUserBySessionToken(sessionToken ?? "")
}

/**
 * POST /api/entity-relationships/populate
 * Manually trigger entity relationship detection and population
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    log("entity_relationships.populate.triggered", { userId: user.id })

    const stats = await populateEntityRelationships(user.id)

    return NextResponse.json({
      ok: true,
      userId: user.id,
      stats,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("entity_relationships.populate.error", { error: message })
    return NextResponse.json({ error: "Failed to populate relationships" }, { status: 500 })
  }
}
