/**
 * Supermemory Entity Profiles for Reconciliation
 *
 * Stores and retrieves entity payment profiles from Supermemory.
 * These profiles are used by the semantic matching engine to validate
 * whether a bank movement description semantically matches a known entity.
 *
 * Profile structure:
 * - entity_id: Internal entity UUID
 * - entity_name: Canonical display name
 * - aliases: Known name variations (bank description patterns, org names)
 * - avg_payment_amount: Historical average payment
 * - payment_amount_range: [min, max] of historical payments
 * - typical_payment_frequency: days between payments
 * - bank_description_patterns: Known bank memo patterns
 * - last_matched_at: ISO date of most recent successful reconciliation
 */

import { getUserFinanceTag } from "./supermemory"
import { query } from "./db"

export interface EntityMemoryProfile {
  entity_id: string
  entity_name: string
  aliases: string[]
  avg_payment_amount: number
  payment_amount_range: [number, number]
  typical_payment_frequency_days: number | null
  bank_description_patterns: string[]
  last_matched_at: string | null
  total_matched_movements: number
  reconciliation_success_rate: number
}

// ─── 5-minute in-process cache ─────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  profile: EntityMemoryProfile
  cachedAt: number
}

const profileCache = new Map<string, CacheEntry>()

function getCached(cacheKey: string): EntityMemoryProfile | null {
  const entry = profileCache.get(cacheKey)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    profileCache.delete(cacheKey)
    return null
  }
  return entry.profile
}

function setCache(cacheKey: string, profile: EntityMemoryProfile): void {
  profileCache.set(cacheKey, { profile, cachedAt: Date.now() })
}

/** Clear the in-process cache (e.g. after backfill). */
export function clearEntityProfileCache(): void {
  profileCache.clear()
}
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build an EntityMemoryProfile from the local database.
 * This is the source of truth — Supermemory is the memory layer on top.
 */
async function buildProfileFromDB(
  userId: string,
  entityId: string
): Promise<EntityMemoryProfile | null> {
  // Fetch entity details
  const entityRow = await query<{
    id: string
    canonical_name: string
    aliases: string[] | null
  }>(
    `SELECT id::text, canonical_name, aliases FROM entities WHERE id = $1::uuid AND user_id = $2::uuid`,
    [entityId, userId]
  )
  if (entityRow.rows.length === 0) return null
  const entity = entityRow.rows[0]

  // Fetch payment stats from movement_attributions
  const statsRow = await query<{
    avg_amount: number | null
    min_amount: number | null
    max_amount: number | null
    count: number
    last_matched: string | null
  }>(
    `SELECT
       AVG(ma.gross_amount)::float AS avg_amount,
       MIN(ma.gross_amount)::float AS min_amount,
       MAX(ma.gross_amount)::float AS max_amount,
       COUNT(*)::int AS count,
       MAX(ma.created_at)::text AS last_matched
     FROM movement_attributions ma
     WHERE ma.user_id = $1
       AND ma.entity_id = $2
       AND ma.component_type IN ('ar', 'ap')`,
    [userId, entityId]
  )
  const stats = statsRow.rows[0]

  // Fetch distinct bank description patterns from matched movements
  const patternsRow = await query<{ description: string }>(
    `SELECT DISTINCT COALESCE(m.raw_description, m.counterparty, '') AS description
     FROM movements m
     JOIN movement_attributions ma ON ma.movement_id = m.id
     WHERE ma.user_id = $1
       AND ma.entity_id = $2
       AND ma.component_type IN ('ar', 'ap')
       AND COALESCE(m.raw_description, m.counterparty, '') != ''
     LIMIT 20`,
    [userId, entityId]
  )

  const patterns = patternsRow.rows.map((r) => r.description).filter(Boolean)
  const aliases = entity.aliases ?? []

  return {
    entity_id: entityId,
    entity_name: entity.canonical_name ?? "",
    aliases,
    avg_payment_amount: stats?.avg_amount ?? 0,
    payment_amount_range: [stats?.min_amount ?? 0, stats?.max_amount ?? 0],
    typical_payment_frequency_days: null,
    bank_description_patterns: patterns,
    last_matched_at: stats?.last_matched ?? null,
    total_matched_movements: stats?.count ?? 0,
    reconciliation_success_rate: stats?.count ? 1.0 : 0,
  }
}

/**
 * Get entity profile, using in-process cache first.
 * Falls back to building from DB if not cached.
 */
export async function getEntityProfile(
  userId: string,
  entityId: string
): Promise<EntityMemoryProfile | null> {
  const cacheKey = `${userId}:${entityId}`
  const cached = getCached(cacheKey)
  if (cached) return cached

  const profile = await buildProfileFromDB(userId, entityId)
  if (profile) setCache(cacheKey, profile)
  return profile
}

/**
 * Get entity profile by entity name (fuzzy lookup).
 * Used when we only have a bank description or counterparty name.
 */
export async function findEntityProfileByName(
  userId: string,
  entityName: string
): Promise<EntityMemoryProfile | null> {
  if (!entityName?.trim()) return null

  // Look up entity by canonical_name similarity
  const entityRow = await query<{ id: string }>(
    `SELECT id::text
     FROM entities
     WHERE user_id = $1::uuid
       AND (
         canonical_name ILIKE $2
         OR $2 ILIKE '%' || canonical_name || '%'
       )
     ORDER BY LENGTH(canonical_name) DESC
     LIMIT 1`,
    [userId, `%${entityName.trim()}%`]
  )
  if (entityRow.rows.length === 0) return null
  return getEntityProfile(userId, entityRow.rows[0].id)
}

/**
 * Backfill entity profiles for all entities with at least one matched movement.
 * Should be run once to populate the cache layer.
 */
export async function backfillEntityProfiles(userId: string): Promise<number> {
  const entityIds = await query<{ entity_id: string }>(
    `SELECT DISTINCT entity_id
     FROM movement_attributions
     WHERE user_id = $1
       AND component_type IN ('ar', 'ap')`,
    [userId]
  )

  let count = 0
  for (const { entity_id } of entityIds.rows) {
    const profile = await buildProfileFromDB(userId, entity_id)
    if (profile) {
      const cacheKey = `${userId}:${entity_id}`
      setCache(cacheKey, profile)
      count++
    }
  }

  console.log(`[supermemory-entity-profiles] Backfilled ${count} entity profiles for user ${userId}`)
  return count
}

/**
 * Store a reconciliation memory tag in Supermemory for an entity.
 * This creates a semantic memory that the LLM can query.
 */
export async function storeEntityProfileInSupermemory(
  userId: string,
  profile: EntityMemoryProfile
): Promise<void> {
  try {
    const tag = getUserFinanceTag(userId)
    const content = `Entity Reconciliation Profile:
Name: ${profile.entity_name}
ID: ${profile.entity_id}
Aliases: ${profile.aliases.join(", ") || "none"}
Average Payment: $${profile.avg_payment_amount.toFixed(2)}
Payment Range: $${profile.payment_amount_range[0].toFixed(2)} - $${profile.payment_amount_range[1].toFixed(2)}
Bank Description Patterns: ${profile.bank_description_patterns.slice(0, 5).join("; ") || "none"}
Total Matched Movements: ${profile.total_matched_movements}
Last Matched: ${profile.last_matched_at ?? "never"}`

    // Import dynamically to avoid breaking if Supermemory is not configured
    const { default: Supermemory } = await import("supermemory")
    const sm = new Supermemory({ apiKey: process.env.SUPERMEMORY_API_KEY })
    await sm.memories.add({
      content,
      metadata: {
        type: "entity_reconciliation_profile",
        entity_id: profile.entity_id,
        entity_name: profile.entity_name,
      },
      containerTags: [tag],
    })
  } catch (err) {
    // Never block reconciliation on Supermemory failures
    console.warn("[supermemory-entity-profiles] Failed to store in Supermemory:", err)
  }
}
