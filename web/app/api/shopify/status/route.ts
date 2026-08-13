import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { listShopifyConnectionsByUserId } from "@/lib/shopify-token-store"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const connections = await listShopifyConnectionsByUserId(user.id)
    const connected = connections.filter((c) => c.missingScopes.length === 0).length > 0
    return NextResponse.json({
      connected,
      connections: connections.map((c) => ({
        shopDomain: c.shopDomain,
        scope: c.scope ?? null,
        grantedScopes: c.grantedScopes,
        missingScopes: c.missingScopes,
        status: c.missingScopes.length === 0 ? "connected" : "scope_missing",
        updatedAt: c.updatedAt ?? null,
      })),
    })
  } catch {
    return NextResponse.json({ connected: false, connections: [] })
  }
}
