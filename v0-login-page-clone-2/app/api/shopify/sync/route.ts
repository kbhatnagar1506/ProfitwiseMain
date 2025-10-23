import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { normalizeShopDomain } from "@/lib/shopify"
import { runShopifySyncForUser } from "@/lib/shopify-sync"
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

  try {
    const result = await runShopifySyncForUser(user.id, shopDomain ? { shopDomain } : undefined)
    if (!result.ok) {
      return NextResponse.json({ error: "No Shopify connections found" }, { status: 400 })
    }
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("shopify.sync.route.failed", { userId: user.id, error: message }, "shopify")
    return NextResponse.json({ error: "Shopify sync failed", detail: message }, { status: 500 })
  }
}
