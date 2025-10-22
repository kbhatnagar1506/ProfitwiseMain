import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { disconnectConnection } from "@/lib/shopify-token-store"
import { deactivateWebhookSubscriptions } from "@/lib/shopify-sync"

type Body = {
  shop_domain?: string
  mode?: "disconnect_only" | "disconnect_and_purge"
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as Body
  const shopDomain = (body.shop_domain ?? "").trim().toLowerCase()
  if (!shopDomain) {
    return NextResponse.json({ error: "Missing shop_domain" }, { status: 400 })
  }
  const purge = body.mode === "disconnect_and_purge"
  await disconnectConnection({ userId: user.id, shopDomain, purge })
  await deactivateWebhookSubscriptions(user.id, shopDomain)
  return NextResponse.json({ ok: true, mode: purge ? "disconnect_and_purge" : "disconnect_only" })
}
