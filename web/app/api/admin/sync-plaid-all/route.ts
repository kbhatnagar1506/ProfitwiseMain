import { NextRequest, NextResponse } from "next/server"
import { log } from "@/lib/logger"
import { query } from "@/lib/db"
import { getPlaidClient } from "@/lib/plaid"
import { getPlaidItem, updatePlaidItemCursor } from "@/lib/plaid-item-store"
import { mapAndDelete, mapAndUpsert } from "@/lib/plaid-persistence"

/**
 * POST /api/admin/sync-plaid-all
 * Runs Plaid transactions sync for every item that exists in plaid_items.
 * Auth: x-clean-db-secret header. Production only.
 *
 * This is the admin equivalent of the per-user /api/plaid/transactions-sync route,
 * but instead of requiring a session and a single item_id, it iterates all items.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }

  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    log("admin.sync-plaid-all.unauthorized", undefined, "plaid")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Find all distinct item_ids that we know about.
  const { rows } = await query<{ item_id: string }>(
    "SELECT DISTINCT item_id FROM plaid_items ORDER BY item_id"
  )
  if (rows.length === 0) {
    log("admin.sync-plaid-all.no_items", undefined, "plaid")
    return NextResponse.json({ ok: true, items: 0, message: "No Plaid items to sync" })
  }

  const client = getPlaidClient()
  const results: Record<
    string,
    { added: number; modified: number; removed: number; error?: string }
  > = {}

  for (const { item_id } of rows) {
    let totalAdded = 0
    let totalModified = 0
    let totalRemoved = 0

    try {
      let hasMore = true
      while (hasMore) {
        const item = await getPlaidItem(item_id)
        if (!item) {
          log("admin.sync-plaid-all.item_not_found", { itemId: item_id }, "plaid")
          results[item_id] = {
            added: totalAdded,
            modified: totalModified,
            removed: totalRemoved,
            error: "Item not found",
          }
          break
        }

        const cursor = item.cursor ?? undefined
        const response = await client.transactionsSync({
          access_token: item.access_token,
          cursor,
        })

        const nextCursor = response.data.next_cursor
        if (nextCursor) {
          await updatePlaidItemCursor(item_id, nextCursor)
        }

        const added = response.data.added ?? []
        const modified = response.data.modified ?? []
        const removed = response.data.removed ?? []

        await mapAndUpsert(item_id, added, modified)
        await mapAndDelete(item_id, removed)

        totalAdded += added.length
        totalModified += modified.length
        totalRemoved += removed.length
        hasMore = response.data.has_more ?? false

        log(
          "admin.sync-plaid-all.page",
          {
            itemId: item_id,
            added: added.length,
            modified: modified.length,
            removed: removed.length,
            hasMore,
          },
          "plaid"
        )
      }

      if (!results[item_id]) {
        results[item_id] = {
          added: totalAdded,
          modified: totalModified,
          removed: totalRemoved,
        }
      }

      log(
        "admin.sync-plaid-all.item_done",
        { itemId: item_id, added: totalAdded, modified: totalModified, removed: totalRemoved },
        "plaid"
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log("admin.sync-plaid-all.item_failed", { itemId: item_id, error: message }, "plaid")
      results[item_id] = {
        added: totalAdded,
        modified: totalModified,
        removed: totalRemoved,
        error: message,
      }
    }
  }

  return NextResponse.json({
    ok: true,
    items: rows.length,
    results,
  })
}

