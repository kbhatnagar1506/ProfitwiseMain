/**
 * Entity Relationship Detection
 *
 * Detects and infers relationships between entities based on:
 * - Shared aliases (same entity under different names)
 * - Domain/email matching (related business entities)
 * - Payment pattern correlation (entities that move together)
 * - Entity type relationships (owner-related, processor-related)
 */

import { query } from "./db"
import { log } from "./logger"
import { normalizeForMatch } from "./alias-normalize"

export type DetectedRelationship = {
  from_entity_id: string
  to_entity_id: string
  relationship: string
  confidence: number
  evidence: unknown[]
}

/**
 * Detect same-entity relationships from shared aliases
 * When multiple entities share the same normalized alias, they're likely the same entity
 */
async function detectSameEntityRelationships(userId: string): Promise<DetectedRelationship[]> {
  const relationships: DetectedRelationship[] = []

  try {
    // Get all entities and their aliases
    const { rows: entities } = await query<{ id: string; canonical_name: string; entity_type: string }>(
      `SELECT id, canonical_name, entity_type FROM entities WHERE user_id = $1`,
      [userId]
    )

    if (entities.length === 0) return relationships

    const entityIds = entities.map((e) => e.id)
    const { rows: aliases } = await query<{
      entity_id: string
      alias: string
      alias_type: string
      source: string
      confidence: number
    }>(
      `SELECT entity_id, alias, alias_type, source, confidence FROM entity_aliases WHERE entity_id = ANY($1)`,
      [entityIds]
    )

    // Group aliases by normalized form
    const aliasByNorm = new Map<string, Array<{ entity_id: string; alias: string; confidence: number }>>()
    for (const a of aliases) {
      const norm = normalizeForMatch(a.alias)
      if (norm.length < 3) continue

      if (!aliasByNorm.has(norm)) {
        aliasByNorm.set(norm, [])
      }
      aliasByNorm.get(norm)!.push({
        entity_id: a.entity_id,
        alias: a.alias,
        confidence: a.confidence,
      })
    }

    // Find entities sharing the same normalized alias
    for (const [norm, entries] of aliasByNorm) {
      if (entries.length < 2) continue

      // Get unique entity IDs
      const uniqueEntityIds = [...new Set(entries.map((e) => e.entity_id))]
      if (uniqueEntityIds.length < 2) continue

      // Create bidirectional relationships
      for (let i = 0; i < uniqueEntityIds.length; i++) {
        for (let j = i + 1; j < uniqueEntityIds.length; j++) {
          const fromId = uniqueEntityIds[i]
          const toId = uniqueEntityIds[j]

          // Average confidence from matching aliases
          const avgConf = entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length

          relationships.push({
            from_entity_id: fromId,
            to_entity_id: toId,
            relationship: "same_entity",
            confidence: Math.min(0.95, avgConf + 0.1), // Boost confidence for shared aliases
            evidence: entries.map((e) => ({ alias: e.alias, entity_id: e.entity_id })),
          })

          // Reverse direction
          relationships.push({
            from_entity_id: toId,
            to_entity_id: fromId,
            relationship: "same_entity",
            confidence: Math.min(0.95, avgConf + 0.1),
            evidence: entries.map((e) => ({ alias: e.alias, entity_id: e.entity_id })),
          })
        }
      }
    }

    log("entity_relationships.same_entity_detected", {
      userId,
      relationships_found: relationships.length,
    })
  } catch (err) {
    log("entity_relationships.same_entity_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return relationships
}

/**
 * Detect domain-based relationships
 * Entities sharing the same domain are likely related businesses
 */
async function detectDomainRelationships(userId: string): Promise<DetectedRelationship[]> {
  const relationships: DetectedRelationship[] = []

  try {
    const { rows: entities } = await query<{ id: string; canonical_name: string; entity_type: string }>(
      `SELECT id, canonical_name, entity_type FROM entities WHERE user_id = $1`,
      [userId]
    )

    if (entities.length === 0) return relationships

    const entityIds = entities.map((e) => e.id)
    const { rows: aliases } = await query<{
      entity_id: string
      alias: string
      alias_type: string
    }>(
      `SELECT entity_id, alias, alias_type FROM entity_aliases WHERE entity_id = ANY($1) AND alias_type = 'domain'`,
      [entityIds]
    )

    // Group by domain
    const byDomain = new Map<string, string[]>()
    for (const a of aliases) {
      if (!byDomain.has(a.alias)) {
        byDomain.set(a.alias, [])
      }
      byDomain.get(a.alias)!.push(a.entity_id)
    }

    // Create relationships for entities sharing domains
    for (const [domain, entityIdList] of byDomain) {
      const uniqueIds = [...new Set(entityIdList)]
      if (uniqueIds.length < 2) continue

      for (let i = 0; i < uniqueIds.length; i++) {
        for (let j = i + 1; j < uniqueIds.length; j++) {
          const fromId = uniqueIds[i]
          const toId = uniqueIds[j]

          relationships.push({
            from_entity_id: fromId,
            to_entity_id: toId,
            relationship: "related_business",
            confidence: 0.7,
            evidence: [{ domain, reason: "shared_domain" }],
          })

          relationships.push({
            from_entity_id: toId,
            to_entity_id: fromId,
            relationship: "related_business",
            confidence: 0.7,
            evidence: [{ domain, reason: "shared_domain" }],
          })
        }
      }
    }

    log("entity_relationships.domain_detected", {
      userId,
      relationships_found: relationships.length,
    })
  } catch (err) {
    log("entity_relationships.domain_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return relationships
}

/**
 * Detect owner-related entities
 * Entities marked as "owner" type are related to all other entities
 */
async function detectOwnerRelationships(userId: string): Promise<DetectedRelationship[]> {
  const relationships: DetectedRelationship[] = []

  try {
    const { rows: entities } = await query<{ id: string; entity_type: string }>(
      `SELECT id, entity_type FROM entities WHERE user_id = $1`,
      [userId]
    )

    if (entities.length === 0) return relationships

    const ownerEntities = entities.filter((e) => e.entity_type === "owner")
    const otherEntities = entities.filter((e) => e.entity_type !== "owner")

    // Create relationships from owner to all other entities
    for (const owner of ownerEntities) {
      for (const other of otherEntities) {
        relationships.push({
          from_entity_id: owner.id,
          to_entity_id: other.id,
          relationship: "owner_related",
          confidence: 0.8,
          evidence: [{ reason: "owner_entity_type" }],
        })

        relationships.push({
          from_entity_id: other.id,
          to_entity_id: owner.id,
          relationship: "owner_related",
          confidence: 0.8,
          evidence: [{ reason: "owner_entity_type" }],
        })
      }
    }

    log("entity_relationships.owner_detected", {
      userId,
      owner_count: ownerEntities.length,
      relationships_found: relationships.length,
    })
  } catch (err) {
    log("entity_relationships.owner_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return relationships
}

/**
 * Detect processor-related entities
 * Entities marked as "processor" type are related to customers/vendors
 */
async function detectProcessorRelationships(userId: string): Promise<DetectedRelationship[]> {
  const relationships: DetectedRelationship[] = []

  try {
    const { rows: entities } = await query<{ id: string; entity_type: string }>(
      `SELECT id, entity_type FROM entities WHERE user_id = $1`,
      [userId]
    )

    if (entities.length === 0) return relationships

    const processorEntities = entities.filter((e) => e.entity_type === "processor")
    const businessEntities = entities.filter((e) => ["customer", "vendor"].includes(e.entity_type))

    // Create relationships from processor to business entities
    for (const processor of processorEntities) {
      for (const business of businessEntities) {
        relationships.push({
          from_entity_id: processor.id,
          to_entity_id: business.id,
          relationship: "processor_related",
          confidence: 0.6,
          evidence: [{ reason: "processor_entity_type" }],
        })

        relationships.push({
          from_entity_id: business.id,
          to_entity_id: processor.id,
          relationship: "processor_related",
          confidence: 0.6,
          evidence: [{ reason: "processor_entity_type" }],
        })
      }
    }

    log("entity_relationships.processor_detected", {
      userId,
      processor_count: processorEntities.length,
      relationships_found: relationships.length,
    })
  } catch (err) {
    log("entity_relationships.processor_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return relationships
}

/**
 * Populate entity_relationships table with detected relationships
 */
export async function populateEntityRelationships(userId: string): Promise<{
  total_relationships: number
  same_entity: number
  domain_related: number
  owner_related: number
  processor_related: number
}> {
  const stats = {
    total_relationships: 0,
    same_entity: 0,
    domain_related: 0,
    owner_related: 0,
    processor_related: 0,
  }

  try {
    // Detect all relationship types
    const [sameEntity, domainRel, ownerRel, processorRel] = await Promise.all([
      detectSameEntityRelationships(userId),
      detectDomainRelationships(userId),
      detectOwnerRelationships(userId),
      detectProcessorRelationships(userId),
    ])

    const allRelationships = [...sameEntity, ...domainRel, ...ownerRel, ...processorRel]

    if (allRelationships.length === 0) {
      log("entity_relationships.populate.no_relationships", { userId })
      return stats
    }

    // Insert relationships into database
    for (const rel of allRelationships) {
      try {
        await query(
          `INSERT INTO entity_relationships (from_entity_id, to_entity_id, relationship, confidence, evidence)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (from_entity_id, to_entity_id, relationship) DO UPDATE SET
             confidence = GREATEST(entity_relationships.confidence, EXCLUDED.confidence),
             evidence = EXCLUDED.evidence`,
          [rel.from_entity_id, rel.to_entity_id, rel.relationship, rel.confidence, JSON.stringify(rel.evidence)]
        )

        stats.total_relationships++

        if (rel.relationship === "same_entity") stats.same_entity++
        else if (rel.relationship === "related_business") stats.domain_related++
        else if (rel.relationship === "owner_related") stats.owner_related++
        else if (rel.relationship === "processor_related") stats.processor_related++
      } catch (err) {
        log("entity_relationships.insert_error", {
          userId,
          relationship: rel.relationship,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    log("entity_relationships.populate.complete", { userId, ...stats })
  } catch (err) {
    log("entity_relationships.populate.error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return stats
}
