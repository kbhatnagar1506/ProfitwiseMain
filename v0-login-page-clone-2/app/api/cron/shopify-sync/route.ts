import { NextRequest, NextResponse } from "next/server"
import { runShopifySyncForAllConnections } from "@/lib/shopify-sync"
import { convertShopifyOrdersToMovements } from "@/lib/shopify-movements"
import { listAllShopifyConnectionsWithToken } from "@/lib/shopify-token-store"
import { autoResolveDuplicates } from "@/lib/cross-source-dedup"
import { log } from "@/lib/logger"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    log("shopify.cron.start", undefined, "shopify")
    
    // First sync from Shopify API
    const result = await runShopifySyncForAllConnections()
    
    // Then convert orders to movements for each connection
    const connections = await listAllShopifyConnectionsWithToken()
    const movementResults: Array<{ userId: string; shopDomain: string; stats: { processed: number; created: number; updated: number; errors: number } }> = []
    
    for (const conn of connections) {
      try {
        const stats = await convertShopifyOrdersToMovements(conn.userId, conn.shopDomain)
        movementResults.push({ userId: conn.userId, shopDomain: conn.shopDomain, stats })
      } catch (e) {
        log("shopify.cron.movements_error", { userId: conn.userId, shopDomain: conn.shopDomain, error: String(e) }, "shopify")
      }
    }
    
    // Run deduplication for each user
    const userIds = [...new Set(connections.map(c => c.userId))]
    const dedupResults: Array<{ userId: string; resolved: number; candidates: number }> = []
    for (const userId of userIds) {
      try {
        const dedupStats = await autoResolveDuplicates(userId)
        dedupResults.push({ userId, resolved: dedupStats.resolved, candidates: dedupStats.candidates.length })
      } catch (e) {
        log("shopify.cron.dedup_error", { userId, error: String(e) }, "shopify")
      }
    }
    
    log("shopify.cron.complete", { total: result.total, shops: result.shops.length, movements: movementResults.length, dedup: dedupResults.length }, "shopify")
    
    return NextResponse.json({
      ok: true,
      total_connections: result.total,
      synced: result.shops.map((s) => ({
        shop: s.shopDomain,
        resources: s.resources.map((r) => ({
          resource: r.resource,
          fetched: r.fetched,
          upserted: r.upserted,
          error: r.error ?? null,
        })),
      })),
      movements: movementResults.map((m) => ({
        shop: m.shopDomain,
        processed: m.stats.processed,
        created: m.stats.created,
        updated: m.stats.updated,
        errors: m.stats.errors,
      })),
      deduplication: dedupResults.map((d) => ({
        userId: d.userId,
        resolved: d.resolved,
        candidates: d.candidates,
      })),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("shopify.cron.failed", { error: message }, "shopify")
    return NextResponse.json({ error: "Shopify cron sync failed" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
