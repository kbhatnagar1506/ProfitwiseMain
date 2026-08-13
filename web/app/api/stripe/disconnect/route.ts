import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureStripeSchema, query } from "@/lib/db"
import { log } from "@/lib/logger"

/**
 * POST /api/stripe/disconnect — remove all Stripe connections for the current user
 * and delete their stored Stripe entities.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureStripeSchema()

  // Delete all Stripe entities for this user's accounts first (FK safety).
  const deleteEntitiesResult = await query<{ count: string }>(
    "WITH deleted AS (DELETE FROM stripe_entities WHERE user_id = $1 RETURNING 1) SELECT COUNT(*)::text AS count FROM deleted",
    [user.id]
  )
  const entitiesDeleted = Number(deleteEntitiesResult.rows[0]?.count ?? "0")

  const deleteConnectionsResult = await query<{ id: string }>(
    "DELETE FROM stripe_connections WHERE user_id = $1 RETURNING id",
    [user.id]
  )
  const connectionsDeleted = deleteConnectionsResult.rows.length

  log(
    "stripe.disconnect.succeeded",
    {
      userId: user.id,
      connectionsDeleted,
      entitiesDeleted,
    },
    "stripe"
  )

  return NextResponse.json({
    ok: true,
    stripe_connections_deleted: connectionsDeleted,
    stripe_entities_deleted: entitiesDeleted,
  })
}

