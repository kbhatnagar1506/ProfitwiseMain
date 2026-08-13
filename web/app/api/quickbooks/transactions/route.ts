import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import {
  getEntities,
  getAllForEntity,
  type QBOEntityType,
  ENTITY_TYPES,
} from "@/lib/quickbooks"
import { upsertEntities } from "@/lib/qbo-entity-store"
import { log } from "@/lib/logger"
import { listRealmIdsByUserId } from "@/lib/quickbooks-token-store"

const ENTITY_SET = new Set<string>(ENTITY_TYPES)

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("qbo.transactions.unauthorized", { reason: "no_session" }, "qbo")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const realmId = searchParams.get("realmId")
  const entityType = searchParams.get("entityType") as string | null
  const startPosition = searchParams.get("startPosition")
  const maxResults = searchParams.get("maxResults")

  if (!realmId) {
    log("qbo.transactions.rejected", { reason: "missing_realm_id" }, "qbo")
    return NextResponse.json({ error: "realmId required" }, { status: 400 })
  }
  const userRealmIds = await listRealmIdsByUserId(user.id)
  if (!userRealmIds.includes(realmId)) {
    log("qbo.transactions.forbidden", { realmId, userId: user.id }, "qbo")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const start = startPosition ? parseInt(startPosition, 10) : 1
  const max = maxResults ? parseInt(maxResults, 10) : 1000

  if (entityType) {
    if (!ENTITY_SET.has(entityType)) {
      return NextResponse.json({ error: `Invalid entityType: ${entityType}` }, { status: 400 })
    }
    try {
      log("transactions.fetch.started", { realmId, entityType })
      const items = await getEntities(realmId, entityType as QBOEntityType, start, max)
      await upsertEntities(realmId, entityType, items)
      log("transactions.fetch.succeeded", { realmId, entityType, status: 200, count: items.length })
      return NextResponse.json({ [entityType]: items })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log("transactions.fetch.failed", { realmId, entityType, error: message })
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  try {
    log("transactions.fetch.started", { realmId, entityType: "all" })
    const all: Record<string, unknown[]> = {}
    for (const type of ENTITY_TYPES) {
      const items = await getAllForEntity(realmId, type)
      all[type] = items
      await upsertEntities(realmId, type, items)
    }
    const total = Object.values(all).reduce((s, arr) => s + arr.length, 0)
    log("transactions.fetch.succeeded", { realmId, entityType: "all", status: 200, count: total })
    return NextResponse.json(all)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("transactions.fetch.failed", { realmId, entityType: "all", error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
