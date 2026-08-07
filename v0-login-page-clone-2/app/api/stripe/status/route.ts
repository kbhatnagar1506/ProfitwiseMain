import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { listStripeConnectionsByUserId } from "@/lib/stripe-token-store"

/**
 * GET /api/stripe/status — returns connection status for all Stripe accounts for the current user
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const connections = await listStripeConnectionsByUserId(user.id)
    
    return NextResponse.json({
      connected: connections.length > 0,
      connections: connections.map(conn => ({
        stripeAccountId: conn.stripeAccountId,
        status: conn.accessToken ? "connected" : "needs_reauth",
        scope: conn.scope,
        updatedAt: conn.updatedAt,
      })),
    })
  } catch (e) {
    return NextResponse.json({ 
      connected: false, 
      connections: [],
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
