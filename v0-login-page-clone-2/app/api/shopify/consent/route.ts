import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getLatestConsent, recordConsent } from "@/lib/shopify-token-store"
import { normalizeShopDomain, type ShopifyRetentionMode } from "@/lib/shopify"

type Body = {
  shop_domain?: string
  retention_mode?: ShopifyRetentionMode
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const shopDomain = normalizeShopDomain(request.nextUrl.searchParams.get("shop_domain") ?? "")
  if (!shopDomain) return NextResponse.json({ error: "Missing shop_domain" }, { status: 400 })
  const consent = await getLatestConsent(user.id, shopDomain)
  return NextResponse.json({ consent })
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = (await request.json().catch(() => ({}))) as Body
  const shopDomain = normalizeShopDomain(body.shop_domain ?? "")
  if (!shopDomain) return NextResponse.json({ error: "Missing shop_domain" }, { status: 400 })
  await recordConsent({
    userId: user.id,
    shopDomain,
    retentionMode: body.retention_mode ?? "default",
  })
  return NextResponse.json({ ok: true })
}
