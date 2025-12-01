import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureXeroSchema, query } from "@/lib/db"
import { log } from "@/lib/logger"

/**
 * POST /api/xero/disconnect — remove all Xero connections for the current user
 * and delete their stored Xero entities.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureXeroSchema()

  // Delete all Xero entities for this user's tenants first (FK safety).
  const deleteEntitiesResult = await query<{ count: string }>(
    "WITH deleted AS (DELETE FROM xero_entities WHERE user_id = $1 RETURNING 1) SELECT COUNT(*)::text AS count FROM deleted",
    [user.id]
  )
  const entitiesDeleted = Number(deleteEntitiesResult.rows[0]?.count ?? "0")

  const deleteConnectionsResult = await query<{ id: string }>(
    "DELETE FROM xero_connections WHERE user_id = $1 RETURNING id",
    [user.id]
  )
  const connectionsDeleted = deleteConnectionsResult.rows.length

  log(
    "xero.disconnect.succeeded",
    {
      userId: user.id,
      connectionsDeleted,
      entitiesDeleted,
    },
    "xero"
  )

  return NextResponse.json({
    ok: true,
    xero_connections_deleted: connectionsDeleted,
    xero_entities_deleted: entitiesDeleted,
  })
}
