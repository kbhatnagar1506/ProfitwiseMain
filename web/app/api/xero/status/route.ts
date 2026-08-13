import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { listXeroConnectionsByUserId } from "@/lib/xero-token-store"

/**
 * GET /api/xero/status — returns connection status for all Xero tenants for the current user
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const connections = await listXeroConnectionsByUserId(user.id)
    
    return NextResponse.json({
      connected: connections.length > 0,
      connections: connections.map(conn => ({
        tenantId: conn.tenantId,
        tenantName: conn.tenantName,
        status: conn.accessToken ? "connected" : "needs_reauth",
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
