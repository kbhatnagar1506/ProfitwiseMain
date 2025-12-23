import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { buildEntityProfiles, getAllEntityProfiles } from "@/lib/entity-profiles"
import { refreshEntityNarratives } from "@/lib/entity-profile-ai"
import { validateSortField, validateNumericParam, getErrorMessage } from "@/lib/api-utils"
import { log } from "@/lib/logger"
import type { EntityPaymentProfile, EntityType } from "@/lib/state/types"

async function getUser() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  return getUserBySessionToken(sessionToken ?? "")
}

const ALLOWED_SORT_FIELDS = ["lifetime_value", "transaction_count", "last_transaction", "name"]

export async function GET(request: Request) {
  const user = await getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const userId = user.id

  const { searchParams } = new URL(request.url)
  const type = searchParams.get("type") as EntityType | null
  const sortBy = validateSortField(searchParams.get("sort"), ALLOWED_SORT_FIELDS)
  const minTransactions = validateNumericParam(searchParams.get("min_transactions"), 1, 1, 1000)
  const refresh = searchParams.get("refresh") === "true"

  try {
    // Optionally rebuild profiles
    if (refresh) {
      await buildEntityProfiles(userId)
      await refreshEntityNarratives(userId, { maxEntities: 30 })
    }

    // Get profiles with optional filters
    const profiles = await getAllEntityProfiles(userId, {
      type: type || undefined,
      minTransactions,
      sortBy,
    })

    // Get entity details for display names
    const entityIds = profiles.map((p) => p.entity_id)
    const entityDetails = entityIds.length > 0
      ? await query<{ id: string; canonical_name: string; display_name: string | null }>(
          `SELECT id, canonical_name, display_name FROM entities WHERE id = ANY($1::uuid[])`,
          [entityIds]
        )
      : { rows: [] }

    const entityMap = new Map(entityDetails.rows.map((e) => [e.id, e]))

    // Build response with entity names
    const entities = profiles.map((p) => {
      const entity = entityMap.get(p.entity_id)
      return {
        id: p.entity_id,
        canonical_name: entity?.canonical_name || "Unknown",
        display_name: entity?.display_name,
        entity_type: p.entity_type,
        archetype: p.archetype,
        lifetime_value: p.lifetime_value,
        outstanding_amount: p.outstanding_amount,
        overdue_amount: p.overdue_amount,
        reliability_score: p.reliability_score,
        risk_score: p.risk_score,
        transaction_count: p.transaction_count,
        last_transaction_date: p.last_transaction_date,
        ai_summary: p.ai_summary,
      }
    })

    // Calculate summary stats
    const customers = profiles.filter((p) => p.entity_type === "customer")
    const vendors = profiles.filter((p) => p.entity_type === "vendor")

    const summary = {
      total_entities: profiles.length,
      total_customers: customers.length,
      total_vendors: vendors.length,
      total_ar_outstanding: customers.reduce((s, p) => s + (p.outstanding_amount || 0), 0),
      total_ap_outstanding: vendors.reduce((s, p) => s + (p.outstanding_amount || 0), 0),
      total_lifetime_value: profiles.reduce((s, p) => s + (p.lifetime_value || 0), 0),
      at_risk_count: profiles.filter((p) => (p.risk_score || 0) > 0.5).length,
    }

    log("entities.list.success", { userId, entityCount: entities.length, operation: "list_entities" })
    return NextResponse.json({ entities, summary })
  } catch (error) {
    const errorMsg = getErrorMessage(error)
    log("entities.list.error", { userId, error: errorMsg, operation: "list_entities" })
    return NextResponse.json(
      { error: "Failed to fetch entities" },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const user = await getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const userId = user.id

  try {
    const body = await request.json()
    const { action } = body

    if (action === "rebuild") {
      const profilesBuilt = await buildEntityProfiles(userId)
      const narrativesUpdated = await refreshEntityNarratives(userId, { 
        forceAll: body.forceNarratives ?? false,
        maxEntities: body.maxEntities ?? 50 
      })

      return NextResponse.json({
        success: true,
        profiles_built: profilesBuilt,
        narratives_updated: narrativesUpdated,
      })
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (error) {
    console.error("[api/entities] POST Error:", error)
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    )
  }
}
