import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { getPlaidClient } from "@/lib/plaid"
import { mapAndDelete, mapAndUpsert } from "@/lib/plaid-persistence"
import { getPlaidItem, listPlaidItemIds, updatePlaidItemCursor } from "@/lib/plaid-item-store"
import { classifyMovements } from "@/lib/movement-classify"

export async function POST(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("plaid.transactions_sync.unauthorized", { reason: "no_session" }, "plaid")
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
    log("plaid.transactions_sync.forbidden", { itemId, userId: user.id }, "plaid")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const client = getPlaidClient()
  try {
    let totalAdded = 0
    let totalModified = 0
    let totalRemoved = 0
    let hasMore = true
    while (hasMore) {
      const item = await getPlaidItem(itemId)
      if (!item) {
        log("plaid.transactions_sync.item_not_found", { itemId }, "plaid")
        return NextResponse.json({ error: "Item not found" }, { status: 404 })
      }
      const cursor = item.cursor ?? undefined
      const response = await client.transactionsSync({
        access_token: item.access_token,
        cursor,
      })
      const nextCursor = response.data.next_cursor
      if (nextCursor) {
        await updatePlaidItemCursor(itemId, nextCursor)
      }
      const added = response.data.added ?? []
      const modified = response.data.modified ?? []
      const removed = response.data.removed ?? []
      await mapAndUpsert(itemId, added, modified)
      await mapAndDelete(itemId, removed)
      totalAdded += added.length
      totalModified += modified.length
      totalRemoved += removed.length
      hasMore = response.data.has_more ?? false
      log("transactions.sync.page", { itemId, added: added.length, modified: modified.length, removed: removed.length, hasMore }, "plaid")
    }
    log("transactions.sync.succeeded", { itemId, added: totalAdded, modified: totalModified, removed: totalRemoved }, "plaid")
    // Rebuild movements + movement_observations from all sources so Plaid rows appear in recon (full classify; CASCADE clears prior movement_attributions).
    void classifyMovements(user.id).catch((err) => {
      log(
        "plaid.transactions_sync.classify_failed",
        { itemId, userId: user.id, error: err instanceof Error ? err.message : String(err) },
        "plaid",
      )
    })
    return NextResponse.json({
      added: totalAdded,
      modified: totalModified,
      removed: totalRemoved,
      has_more: false,
    })
  } catch (err) {
    log("transactions.sync.failed", { itemId, error: err instanceof Error ? err.message : String(err) }, "plaid")
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed" },
      { status: 500 }
    )
  }
}
