import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { normalizeShopDomain } from "@/lib/shopify"
import { query, ensureShopifySchema } from "@/lib/db"
import { log } from "@/lib/logger"

export async function POST(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let shopDomain: string | undefined
  try {
    const body = await request.json().catch(() => ({}))
    if (body && typeof body === "object" && typeof (body as { shop?: string }).shop === "string") {
      shopDomain = normalizeShopDomain((body as { shop: string }).shop)
    }
  } catch {
    // ignore
  }

  if (!shopDomain) {
    return NextResponse.json({ error: "Missing shop domain" }, { status: 400 })
  }

  try {
    await ensureShopifySchema()
    
    // Delete connection
    await query(
      "DELETE FROM shopify_connections WHERE user_id = $1 AND shop_domain = $2",
      [user.id, shopDomain]
    )
    
    // Delete sync state
    await query(
      "DELETE FROM shopify_sync_state WHERE user_id = $1 AND shop_domain = $2",
      [user.id, shopDomain]
    )
    
    // Delete entities
    await query(
      "DELETE FROM shopify_entities WHERE user_id = $1 AND shop_domain = $2",
      [user.id, shopDomain]
    )
    
    log("shopify.disconnect.succeeded", { userId: user.id, shopDomain }, "shopify")
    return NextResponse.json({ ok: true, disconnected: shopDomain })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("shopify.disconnect.failed", { userId: user.id, shopDomain, error: message }, "shopify")
    return NextResponse.json({ error: "Failed to disconnect", detail: message }, { status: 500 })
  }
}
