import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { getPlaidClient } from "@/lib/plaid"
import { getPlaidItem, listPlaidItemIds } from "@/lib/plaid-item-store"

/**
 * Trigger a Plaid transactions refresh for an item.
 * This will cause Plaid to fetch the latest transactions and send a webhook.
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("plaid.refresh.unauthorized", { reason: "no_session" }, "plaid")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { item_id?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const itemId = body?.item_id
  if (!itemId || typeof itemId !== "string") {
    return NextResponse.json({ error: "item_id required" }, { status: 400 })
  }

  const userItemIds = await listPlaidItemIds(user.id)
  if (!userItemIds.includes(itemId)) {
    log("plaid.refresh.forbidden", { itemId, userId: user.id }, "plaid")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const item = await getPlaidItem(itemId)
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 })
  }

  const client = getPlaidClient()
  try {
    // Call transactionsRefresh to trigger Plaid to fetch latest transactions
    // This will cause Plaid to send a SYNC_UPDATES_AVAILABLE webhook
    await client.transactionsRefresh({
      access_token: item.access_token,
    })

    log("plaid.refresh.triggered", { itemId, userId: user.id }, "plaid")
    return NextResponse.json({
      success: true,
      message: "Refresh triggered. Plaid will send a webhook when new transactions are available.",
    })
  } catch (err) {
    log("plaid.refresh.failed", { itemId, error: err instanceof Error ? err.message : String(err) }, "plaid")
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Refresh failed" },
      { status: 500 }
    )
  }
}
