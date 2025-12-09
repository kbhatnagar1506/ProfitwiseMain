/**
 * Entity Clustering
 *
 * Identifies groups of related entities that should share payment patterns.
 * Uses entity graph to find connected components and determine anchor entities.
 *
 * This enables:
 * - Grouping related entities (parent-subsidiary, same entity, etc.)
 * - Identifying anchor entities with most payment history
 * - Aggregating payment patterns across clusters
 * - Boosting confidence for low_data entities via anchor relationships
 */

import type { EntityGraphMap, RelatedEntity } from "./entity-graph-analysis"
import {
  getRelatedEntities,
  isBusinessRelationship,
  findConnectedEntities,
  calculateEntityRelationshipConfidence,
} from "./entity-graph-analysis"
import { log } from "./logger"

export type EntityCluster = {
  cluster_id: string
  anchor_entity_id: string
  satellite_entities: string[]
  relationship_types: string[]
  cluster_confidence: number
  total_payment_count: number
  combined_reliability: number
  combined_recurrence: number
}

export type ClusteringResult = {
  clusters: EntityCluster[]
  clusterMap: Map<string, string>
  anchorMap: Map<string, string>
}

/**
 * Find connected components in the entity graph
 */
function findConnectedComponents(
  entityIds: string[],
  graph: EntityGraphMap
): Set<string>[] {
  const visited = new Set<string>()
  const components: Set<string>[] = []

  for (const entityId of entityIds) {
    if (visited.has(entityId)) continue

    const component = new Set<string>()
    const queue = [entityId]

    while (queue.length > 0) {
      const current = queue.shift()!
      if (visited.has(current)) continue

      visited.add(current)
      component.add(current)

      const related = getRelatedEntities(current, graph)
      for (const r of related) {
        if (!visited.has(r.entity_id) && isBusinessRelationship(r.relationship_type)) {
          queue.push(r.entity_id)
        }
      }
    }

    if (component.size > 0) {
      components.push(component)
    }
  }

  return components
}

/**
 * Calculate cluster confidence based on relationship strengths
 */
function calculateClusterConfidence(
  cluster: Set<string>,
  graph: EntityGraphMap
): number {
  if (cluster.size === 0) return 0
  if (cluster.size === 1) return 0.5

  let totalConfidence = 0
  let relationshipCount = 0

  for (const entityId of cluster) {
    const related = getRelatedEntities(entityId, graph)
    for (const r of related) {
      if (cluster.has(r.entity_id) && isBusinessRelationship(r.relationship_type)) {
        totalConfidence += r.confidence
        relationshipCount++
      }
    }
  }

  if (relationshipCount === 0) return 0.5
  return Math.min(1, totalConfidence / relationshipCount)
}

/**
 * Identify anchor entity in a cluster (entity with most payment history)
 * This is determined by the caller who has access to payment models
 */
export function selectAnchorEntity(
  cluster: Set<string>,
  paymentCounts: Map<string, number>
): string {
  let maxPayments = 0
  let anchorId = Array.from(cluster)[0]

  for (const entityId of cluster) {
    const count = paymentCounts.get(entityId) || 0
    if (count > maxPayments) {
      maxPayments = count
      anchorId = entityId
    }
  }

  return anchorId
}

/**
 * Get relationship types within a cluster
 */
function getClusterRelationshipTypes(
  cluster: Set<string>,
  graph: EntityGraphMap
): string[] {
  const types = new Set<string>()

  for (const entityId of cluster) {
    const related = getRelatedEntities(entityId, graph)
    for (const r of related) {
      if (cluster.has(r.entity_id) && isBusinessRelationship(r.relationship_type)) {
        types.add(r.relationship_type)
      }
    }
  }

  return Array.from(types)
}

/**
 * Cluster entities based on entity graph relationships
 */
export function clusterEntities(
  entityIds: string[],
  graph: EntityGraphMap,
  paymentCounts: Map<string, number>,
  customerStats?: Map<string, { reliability_score: number }>,
  vendorStats?: Map<string, { recurrence_score: number }>
): ClusteringResult {
  const components = findConnectedComponents(entityIds, graph)
  const clusters: EntityCluster[] = []
  const clusterMap = new Map<string, string>()
  const anchorMap = new Map<string, string>()

  let clusterId = 0

  for (const component of components) {
    if (component.size === 1) {
      // Single entity, not a cluster
      const entityId = Array.from(component)[0]
      clusterMap.set(entityId, `singleton-${entityId}`)
      anchorMap.set(entityId, entityId)
      continue
    }

    const anchorId = selectAnchorEntity(component, paymentCounts)
    const satellites = Array.from(component).filter((id) => id !== anchorId)
    const relTypes = getClusterRelationshipTypes(component, graph)
    const clusterConf = calculateClusterConfidence(component, graph)

    // Calculate combined stats
    let totalPayments = 0
    let combinedReliability = 0
    let combinedRecurrence = 0
    let statCount = 0

    for (const entityId of component) {
      totalPayments += paymentCounts.get(entityId) || 0

      const custStats = customerStats?.get(entityId)
      if (custStats) {
        combinedReliability += custStats.reliability_score
        statCount++
      }

      const vendStats = vendorStats?.get(entityId)
      if (vendStats) {
        combinedRecurrence += vendStats.recurrence_score
        statCount++
      }
    }

    const avgReliability = statCount > 0 ? combinedReliability / statCount : 0
    const avgRecurrence = statCount > 0 ? combinedRecurrence / statCount : 0

    const cluster: EntityCluster = {
      cluster_id: `cluster-${clusterId}`,
      anchor_entity_id: anchorId,
      satellite_entities: satellites,
      relationship_types: relTypes,
      cluster_confidence: clusterConf,
      total_payment_count: totalPayments,
      combined_reliability: avgReliability,
      combined_recurrence: avgRecurrence,
    }

    clusters.push(cluster)

    // Map all entities in cluster to this cluster
    for (const entityId of component) {
      clusterMap.set(entityId, cluster.cluster_id)
      anchorMap.set(entityId, anchorId)
    }

    clusterId++
  }

  log("entity_clustering.complete", {
    total_entities: entityIds.length,
    total_clusters: clusters.length,
    avg_cluster_size: entityIds.length / Math.max(1, clusters.length),
    clusters_with_satellites: clusters.filter((c) => c.satellite_entities.length > 0).length,
  })

  return { clusters, clusterMap, anchorMap }
}

/**
 * Determine if two entities should have their models merged
 */
export function shouldMergeModels(
  entity1Id: string,
  entity2Id: string,
  graph: EntityGraphMap,
  clusterMap: Map<string, string>
): boolean {
  // Same cluster
  if (clusterMap.get(entity1Id) === clusterMap.get(entity2Id)) {
    return true
  }

  // Check direct relationship
  const related = getRelatedEntities(entity1Id, graph)
  const match = related.find((r) => r.entity_id === entity2Id)

  if (!match) return false

  // Only merge for strong relationships
  return match.confidence >= 0.8 && match.relationship_type === "same_entity"
}

/**
 * Get satellite entities for an anchor
 */
export function getSatelliteEntities(
  anchorId: string,
  clusters: EntityCluster[]
): string[] {
  const cluster = clusters.find((c) => c.anchor_entity_id === anchorId)
  return cluster ? cluster.satellite_entities : []
}

/**
 * Get anchor entity for a satellite
 */
export function getAnchorEntity(
  satelliteId: string,
  anchorMap: Map<string, string>
): string | null {
  const anchorId = anchorMap.get(satelliteId)
  return anchorId && anchorId !== satelliteId ? anchorId : null
}

/**
 * Calculate confidence boost for a satellite entity based on anchor
 */
export function calculateSatelliteConfidenceBoost(
  satelliteId: string,
  anchorId: string,
  graph: EntityGraphMap,
  anchorConfidence: "high" | "medium" | "low"
): number {
  const related = getRelatedEntities(satelliteId, graph)
  const match = related.find((r) => r.entity_id === anchorId)

  if (!match) return 0

  // Base boost from relationship confidence
  let boost = match.confidence * 0.3

  // Additional boost if anchor has high confidence
  if (anchorConfidence === "high") {
    boost *= 1.5
  } else if (anchorConfidence === "medium") {
    boost *= 1.2
  }

  return Math.min(0.3, boost)
}

/**
 * Determine if satellite should inherit anchor's archetype
 */
export function shouldInheritArchetype(
  satelliteId: string,
  anchorId: string,
  satellitePaymentCount: number,
  relationshipConfidence: number
): boolean {
  // Only inherit if:
  // 1. Satellite has very few payments (< 2)
  // 2. Relationship confidence is high (> 0.7)
  return satellitePaymentCount < 2 && relationshipConfidence > 0.7
}

/**
 * Get cluster statistics
 */
export function getClusterStats(clusters: EntityCluster[]) {
  const stats = {
    total_clusters: clusters.length,
    single_entity_clusters: clusters.filter((c) => c.satellite_entities.length === 0).length,
    multi_entity_clusters: clusters.filter((c) => c.satellite_entities.length > 0).length,
    avg_cluster_size: clusters.length > 0
      ? (clusters.reduce((sum, c) => sum + 1 + c.satellite_entities.length, 0) / clusters.length)
      : 0,
    avg_cluster_confidence: clusters.length > 0
      ? clusters.reduce((sum, c) => sum + c.cluster_confidence, 0) / clusters.length
      : 0,
    total_satellites: clusters.reduce((sum, c) => sum + c.satellite_entities.length, 0),
  }

  return stats
}
