import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { normalizeShopDomain } from "@/lib/shopify"
import { runShopifySyncForUser } from "@/lib/shopify-sync"
import { convertAllShopifyOrdersToMovements, convertShopifyOrdersToMovements } from "@/lib/shopify-movements"
import { autoResolveDuplicates } from "@/lib/cross-source-dedup"
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
    // First sync from Shopify API
    const result = await runShopifySyncForUser(user.id, shopDomain ? { shopDomain } : undefined)
    if (!result.ok) {
      return NextResponse.json({ error: "No Shopify connections found" }, { status: 400 })
    }

    // Then convert orders to movements
    let movementStats
    if (shopDomain) {
      movementStats = await convertShopifyOrdersToMovements(user.id, shopDomain)
    } else {
      movementStats = await convertAllShopifyOrdersToMovements(user.id)
    }

    // Auto-resolve duplicates between Shopify and other sources (QBO, bank, etc.)
    let dedupStats = { resolved: 0, candidates: 0 }
    try {
      dedupStats = await autoResolveDuplicates(user.id)
      log("shopify.sync.dedup", { userId: user.id, ...dedupStats }, "shopify")
    } catch (dedupErr) {
      log("shopify.sync.dedup.error", { userId: user.id, error: String(dedupErr) }, "shopify")
    }

    return NextResponse.json({ 
      ok: true, 
      ...result,
      movements: movementStats,
      deduplication: dedupStats,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("shopify.sync.route.failed", { userId: user.id, error: message }, "shopify")
    return NextResponse.json({ error: "Shopify sync failed", detail: message }, { status: 500 })
  }
}
