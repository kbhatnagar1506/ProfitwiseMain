/**
 * Entity Graph Analysis
 *
 * Extracts and analyzes entity relationships from the identity graph.
 * Builds a queryable map of entity connections with confidence scores.
 *
 * This enables:
 * - Grouping related entities (parent-subsidiary, same entity, etc.)
 * - Identifying business vs. non-business relationships
 * - Calculating relationship strength for confidence boosting
 * - Filtering special relationships (owner, internal, processor)
 */

import { query } from "./db"
import { log } from "./logger"

export type EntityRelationshipRow = {
  id: string
  from_entity_id: string
  to_entity_id: string
  relationship: string
  confidence: number
  evidence: unknown[]
}

export type RelatedEntity = {
  entity_id: string
  relationship_type: string
  confidence: number
  evidence_count: number
  direction: "outbound" | "inbound"
}

export type EntityGraphMap = {
  relationships: Map<string, RelatedEntity[]>
  relationshipTypes: Map<string, string>
  relationshipStrengths: Map<string, number>
  businessEntities: Set<string>
  specialRelationships: Map<string, Set<string>>
}

/**
 * Fetch all entity relationships for a user
 */
export async function fetchEntityRelationships(userId: string): Promise<EntityRelationshipRow[]> {
  try {
    const { rows } = await query<{
      id: string
      from_entity_id: string
      to_entity_id: string
      relationship: string
      confidence: string
      evidence: unknown[]
    }>(
      `SELECT id, from_entity_id, to_entity_id, relationship, confidence, evidence
       FROM entity_relationships
       WHERE from_entity_id IN (
         SELECT id FROM entities WHERE user_id = $1
       ) OR to_entity_id IN (
         SELECT id FROM entities WHERE user_id = $1
       )
       ORDER BY confidence DESC`,
      [userId]
    )

    return rows.map((r) => ({
      id: r.id,
      from_entity_id: r.from_entity_id,
      to_entity_id: r.to_entity_id,
      relationship: r.relationship,
      confidence: parseFloat(r.confidence),
      evidence: r.evidence || [],
    }))
  } catch (err) {
    log("entity_graph.fetch.error", { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

/**
 * Fetch entity types for classification
 */
export async function fetchEntityTypes(userId: string): Promise<Map<string, string>> {
  try {
    const { rows } = await query<{
      id: string
      entity_type: string
    }>(
      `SELECT id, entity_type FROM entities WHERE user_id = $1`,
      [userId]
    )

    const typeMap = new Map<string, string>()
    for (const r of rows) {
      typeMap.set(r.id, r.entity_type)
    }
    return typeMap
  } catch (err) {
    log("entity_graph.types.error", { error: err instanceof Error ? err.message : String(err) })
    return new Map()
  }
}

/**
 * Classify relationship type
 */
function classifyRelationshipType(relationship: string): string {
  const rel = relationship.toLowerCase().trim()

  if (rel.includes("parent") || rel.includes("subsidiary") || rel.includes("child")) {
    return "parent_subsidiary"
  }
  if (rel.includes("same") || rel.includes("duplicate") || rel.includes("alias")) {
    return "same_entity"
  }
  if (rel.includes("owner") || rel.includes("personal")) {
    return "owner_related"
  }
  if (rel.includes("processor") || rel.includes("payment")) {
    return "processor_related"
  }
  if (rel.includes("internal") || rel.includes("transfer")) {
    return "internal"
  }
  if (rel.includes("related") || rel.includes("associated")) {
    return "related_business"
  }

  return "other"
}

/**
 * Check if relationship is business-relevant
 */
export function isBusinessRelationship(relType: string): boolean {
  const nonBusiness = ["owner_related", "processor_related", "internal"]
  return !nonBusiness.includes(relType)
}

/**
 * Build entity graph from relationships
 */
export function buildEntityGraph(
  relationships: EntityRelationshipRow[],
  entityTypes: Map<string, string>
): EntityGraphMap {
  const relationshipMap = new Map<string, RelatedEntity[]>()
  const relationshipTypeMap = new Map<string, string>()
  const relationshipStrengthMap = new Map<string, number>()
  const businessEntities = new Set<string>()
  const specialRelationships = new Map<string, Set<string>>()

  // Initialize special relationship tracking
  const specialTypes = ["owner_related", "processor_related", "internal"]
  for (const type of specialTypes) {
    specialRelationships.set(type, new Set())
  }

  // Process each relationship
  for (const rel of relationships) {
    const relType = classifyRelationshipType(rel.relationship)
    const isBusinessRel = isBusinessRelationship(relType)
    const evidenceCount = Array.isArray(rel.evidence) ? rel.evidence.length : 0

    // Create relationship key
    const relKey = `${rel.from_entity_id}→${rel.to_entity_id}:${relType}`
    relationshipTypeMap.set(relKey, relType)
    relationshipStrengthMap.set(relKey, rel.confidence)

    // Track special relationships
    if (!isBusinessRel) {
      const set = specialRelationships.get(relType) || new Set()
      set.add(rel.from_entity_id)
      set.add(rel.to_entity_id)
      specialRelationships.set(relType, set)
    } else {
      businessEntities.add(rel.from_entity_id)
      businessEntities.add(rel.to_entity_id)
    }

    // Add outbound relationship
    const fromRelated: RelatedEntity = {
      entity_id: rel.to_entity_id,
      relationship_type: relType,
      confidence: rel.confidence,
      evidence_count: evidenceCount,
      direction: "outbound",
    }
    const fromList = relationshipMap.get(rel.from_entity_id) || []
    fromList.push(fromRelated)
    relationshipMap.set(rel.from_entity_id, fromList)

    // Add inbound relationship
    const toRelated: RelatedEntity = {
      entity_id: rel.from_entity_id,
      relationship_type: relType,
      confidence: rel.confidence,
      evidence_count: evidenceCount,
      direction: "inbound",
    }
    const toList = relationshipMap.get(rel.to_entity_id) || []
    toList.push(toRelated)
    relationshipMap.set(rel.to_entity_id, toList)
  }

  return {
    relationships: relationshipMap,
    relationshipTypes: relationshipTypeMap,
    relationshipStrengths: relationshipStrengthMap,
    businessEntities,
    specialRelationships,
  }
}

/**
 * Get all related entities for a given entity
 */
export function getRelatedEntities(entityId: string, graph: EntityGraphMap): RelatedEntity[] {
  return graph.relationships.get(entityId) || []
}

/**
 * Get relationship strength between two entities
 */
export function getRelationshipStrength(
  fromId: string,
  toId: string,
  graph: EntityGraphMap
): number {
  const relKey = `${fromId}→${toId}:*`
  const related = getRelatedEntities(fromId, graph)
  const match = related.find((r) => r.entity_id === toId)
  return match ? match.confidence : 0
}

/**
 * Get relationship type between two entities
 */
export function getRelationshipType(
  fromId: string,
  toId: string,
  graph: EntityGraphMap
): string | null {
  const related = getRelatedEntities(fromId, graph)
  const match = related.find((r) => r.entity_id === toId)
  return match ? match.relationship_type : null
}

/**
 * Check if entity is business-related (not owner/internal/processor)
 */
export function isBusinessEntity(entityId: string, graph: EntityGraphMap): boolean {
  return graph.businessEntities.has(entityId)
}

/**
 * Get all entities of a specific relationship type
 */
export function getEntitiesByRelationshipType(
  relType: string,
  graph: EntityGraphMap
): Set<string> {
  return graph.specialRelationships.get(relType) || new Set()
}

/**
 * Calculate average relationship confidence for an entity
 */
export function calculateEntityRelationshipConfidence(
  entityId: string,
  graph: EntityGraphMap
): number {
  const related = getRelatedEntities(entityId, graph)
  if (related.length === 0) return 0

  const businessRelated = related.filter((r) => isBusinessRelationship(r.relationship_type))
  if (businessRelated.length === 0) return 0

  const avgConfidence =
    businessRelated.reduce((sum, r) => sum + r.confidence, 0) / businessRelated.length
  return Math.min(1, avgConfidence)
}

/**
 * Get relationship coverage for an entity (% of related entities with high confidence)
 */
export function getRelationshipCoverage(
  entityId: string,
  graph: EntityGraphMap,
  confidenceThreshold: number = 0.7
): number {
  const related = getRelatedEntities(entityId, graph)
  if (related.length === 0) return 0

  const businessRelated = related.filter((r) => isBusinessRelationship(r.relationship_type))
  if (businessRelated.length === 0) return 0

  const highConfidence = businessRelated.filter((r) => r.confidence >= confidenceThreshold)
  return highConfidence.length / businessRelated.length
}

/**
 * Find all entities connected to a given entity (transitive closure)
 */
export function findConnectedEntities(
  entityId: string,
  graph: EntityGraphMap,
  maxDepth: number = 2
): Set<string> {
  const visited = new Set<string>()
  const queue: [string, number][] = [[entityId, 0]]

  while (queue.length > 0) {
    const [currentId, depth] = queue.shift()!

    if (visited.has(currentId) || depth > maxDepth) continue
    visited.add(currentId)

    const related = getRelatedEntities(currentId, graph)
    for (const r of related) {
      if (!visited.has(r.entity_id) && isBusinessRelationship(r.relationship_type)) {
        queue.push([r.entity_id, depth + 1])
      }
    }
  }

  visited.delete(entityId)
  return visited
}

/**
 * Build complete entity graph for a user
 */
export async function buildCompleteEntityGraph(userId: string): Promise<EntityGraphMap> {
  const [relationships, entityTypes] = await Promise.all([
    fetchEntityRelationships(userId),
    fetchEntityTypes(userId),
  ])

  const graph = buildEntityGraph(relationships, entityTypes)

  log("entity_graph.built", {
    total_relationships: relationships.length,
    business_entities: graph.businessEntities.size,
    owner_related: graph.specialRelationships.get("owner_related")?.size || 0,
    processor_related: graph.specialRelationships.get("processor_related")?.size || 0,
    internal: graph.specialRelationships.get("internal")?.size || 0,
  })

  return graph
}
