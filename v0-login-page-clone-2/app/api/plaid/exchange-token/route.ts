import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { exchangePublicToken, getAccounts, isPlaidConfigured } from "@/lib/plaid"
import { saveAccounts } from "@/lib/plaid-persistence"
import { upsertPlaidItem } from "@/lib/plaid-item-store"

export async function POST(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("plaid.exchange.unauthorized", { reason: "no_session" }, "plaid")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!isPlaidConfigured()) {
    log("item.exchange.rejected", { reason: "not_configured" }, "plaid")
    return NextResponse.json({ error: "Plaid not configured" }, { status: 500 })
  }
  let body: { public_token?: string }
  try {
    body = await request.json()
  } catch {
    log("plaid.exchange.rejected", { reason: "invalid_json" }, "plaid")
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const publicToken = body?.public_token
  if (!publicToken || typeof publicToken !== "string") {
    log("plaid.exchange.rejected", { reason: "missing_public_token" }, "plaid")
    return NextResponse.json({ error: "public_token required" }, { status: 400 })
  }
  try {
    const { accessToken, itemId } = await exchangePublicToken(publicToken)
    await upsertPlaidItem(itemId, accessToken, undefined, user.id)
    const accounts = await getAccounts(accessToken)
    await saveAccounts(itemId, accounts)
    log("item.exchange.succeeded", { itemId }, "plaid")
    return NextResponse.json({ item_id: itemId })
  } catch (err) {
    log("item.exchange.failed", { error: err instanceof Error ? err.message : String(err) }, "plaid")
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Exchange failed" },
      { status: 500 }
    )
  }
}
