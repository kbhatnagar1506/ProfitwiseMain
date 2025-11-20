/**
 * Entity Graph Integration for Forecast Engine
 *
 * Integrates entity graph analysis into the behavioral model blending process.
 * Boosts confidence for low_data and episodic entities based on relationships.
 */

import type { EntityGraphMap } from "./entity-graph-analysis"
import type { EntityCluster } from "./entity-clustering"
import {
  getRelatedEntities,
  isBusinessRelationship,
  calculateEntityRelationshipConfidence,
} from "./entity-graph-analysis"
import {
  getAnchorEntity,
  calculateSatelliteConfidenceBoost,
  shouldInheritArchetype,
} from "./entity-clustering"
import { log } from "./logger"

export type EntityGraphBoostResult = {
  entity_id: string
  original_confidence: "high" | "medium" | "low"
  boosted_confidence: "high" | "medium" | "low"
  boost_amount: number
  boost_reason: string
  anchor_entity_id?: string
  relationship_confidence?: number
}

/**
 * Boost customer confidence based on entity graph relationships
 */
export function boostCustomerConfidenceFromGraph(
  customerId: string,
  originalConfidence: "high" | "medium" | "low",
  paymentCount: number,
  graph: EntityGraphMap,
  anchorMap: Map<string, string>,
  customerModels: Map<string, { confidence: "high" | "medium" | "low"; payment_count: number }>
): EntityGraphBoostResult {
  const result: EntityGraphBoostResult = {
    entity_id: customerId,
    original_confidence: originalConfidence,
    boosted_confidence: originalConfidence,
    boost_amount: 0,
    boost_reason: "",
  }

  // Check if this is a satellite entity
  const anchorId = getAnchorEntity(customerId, anchorMap)
  if (!anchorId) {
    result.boost_reason = "No related entities found"
    return result
  }

  const anchorModel = customerModels.get(anchorId)
  if (!anchorModel) {
    result.boost_reason = "Anchor entity not found in models"
    return result
  }

  // Calculate relationship confidence
  const relConfidence = calculateEntityRelationshipConfidence(customerId, graph)
  if (relConfidence < 0.5) {
    result.boost_reason = `Weak relationship confidence (${(relConfidence * 100).toFixed(0)}%)`
    return result
  }

  // Boost low_data customers
  if (originalConfidence === "low" && paymentCount < 3) {
    if (anchorModel.confidence === "high" || anchorModel.confidence === "medium") {
      result.boosted_confidence = "medium"
      result.boost_amount = 0.2
      result.boost_reason = `Related to anchor entity with ${anchorModel.payment_count} payments (${anchorModel.confidence} confidence)`
      result.anchor_entity_id = anchorId
      result.relationship_confidence = relConfidence
    }
  }

  // Boost medium customers if anchor is high
  if (originalConfidence === "medium" && anchorModel.confidence === "high") {
    result.boosted_confidence = "high"
    result.boost_amount = 0.15
    result.boost_reason = `Related to high-confidence anchor entity with ${anchorModel.payment_count} payments`
    result.anchor_entity_id = anchorId
    result.relationship_confidence = relConfidence
  }

  return result
}

/**
 * Boost vendor confidence based on entity graph relationships
 */
export function boostVendorConfidenceFromGraph(
  vendorId: string,
  originalConfidence: "high" | "medium" | "low",
  paymentCount: number,
  archetype: string,
  graph: EntityGraphMap,
  anchorMap: Map<string, string>,
  vendorModels: Map<string, { confidence: "high" | "medium" | "low"; payment_count: number; archetype: string }>
): EntityGraphBoostResult {
  const result: EntityGraphBoostResult = {
    entity_id: vendorId,
    original_confidence: originalConfidence,
    boosted_confidence: originalConfidence,
    boost_amount: 0,
    boost_reason: "",
  }

  // Check if this is a satellite entity
  const anchorId = getAnchorEntity(vendorId, anchorMap)
  if (!anchorId) {
    result.boost_reason = "No related entities found"
    return result
  }

  const anchorModel = vendorModels.get(anchorId)
  if (!anchorModel) {
    result.boost_reason = "Anchor entity not found in models"
    return result
  }

  // Calculate relationship confidence
  const relConfidence = calculateEntityRelationshipConfidence(vendorId, graph)
  if (relConfidence < 0.5) {
    result.boost_reason = `Weak relationship confidence (${(relConfidence * 100).toFixed(0)}%)`
    return result
  }

  // Boost episodic vendors related to regular vendors
  if (archetype === "episodic" && (anchorModel.archetype === "hard" || anchorModel.archetype === "soft")) {
    if (originalConfidence === "low") {
      result.boosted_confidence = "medium"
      result.boost_amount = 0.2
      result.boost_reason = `Related to ${anchorModel.archetype} vendor with ${anchorModel.payment_count} payments`
      result.anchor_entity_id = anchorId
      result.relationship_confidence = relConfidence
    }
  }

  // Boost low_data vendors
  if (originalConfidence === "low" && paymentCount < 3) {
    if (anchorModel.confidence === "high" || anchorModel.confidence === "medium") {
      result.boosted_confidence = "medium"
      result.boost_amount = 0.2
      result.boost_reason = `Related to anchor entity with ${anchorModel.payment_count} payments (${anchorModel.confidence} confidence)`
      result.anchor_entity_id = anchorId
      result.relationship_confidence = relConfidence
    }
  }

  // Boost medium vendors if anchor is high
  if (originalConfidence === "medium" && anchorModel.confidence === "high") {
    result.boosted_confidence = "high"
    result.boost_amount = 0.15
    result.boost_reason = `Related to high-confidence anchor entity with ${anchorModel.payment_count} payments`
    result.anchor_entity_id = anchorId
    result.relationship_confidence = relConfidence
  }

  return result
}

/**
 * Determine if customer should inherit archetype from anchor
 */
export function shouldInheritCustomerArchetype(
  customerId: string,
  anchorId: string,
  paymentCount: number,
  graph: EntityGraphMap
): boolean {
  if (paymentCount >= 2) return false

  const related = getRelatedEntities(customerId, graph)
  const match = related.find((r) => r.entity_id === anchorId)

  return match ? match.confidence > 0.7 && isBusinessRelationship(match.relationship_type) : false
}

/**
 * Determine if vendor should inherit archetype from anchor
 */
export function shouldInheritVendorArchetype(
  vendorId: string,
  anchorId: string,
  paymentCount: number,
  graph: EntityGraphMap
): boolean {
  if (paymentCount >= 2) return false

  const related = getRelatedEntities(vendorId, graph)
  const match = related.find((r) => r.entity_id === anchorId)

  return match ? match.confidence > 0.7 && isBusinessRelationship(match.relationship_type) : false
}

/**
 * Calculate entity graph coverage for forecast
 */
export function calculateEntityGraphCoverage(
  customerIds: string[],
  vendorIds: string[],
  graph: EntityGraphMap
): {
  customer_coverage: number
  vendor_coverage: number
  overall_coverage: number
  avg_relationship_confidence: number
} {
  const allIds = [...customerIds, ...vendorIds]
  if (allIds.length === 0) {
    return {
      customer_coverage: 0,
      vendor_coverage: 0,
      overall_coverage: 0,
      avg_relationship_confidence: 0,
    }
  }

  let customerWithRelationships = 0
  let vendorWithRelationships = 0
  let totalConfidence = 0
  let confidenceCount = 0

  for (const customerId of customerIds) {
    const related = getRelatedEntities(customerId, graph)
    const businessRelated = related.filter((r) => isBusinessRelationship(r.relationship_type))
    if (businessRelated.length > 0) {
      customerWithRelationships++
      const avgConf = businessRelated.reduce((sum, r) => sum + r.confidence, 0) / businessRelated.length
      totalConfidence += avgConf
      confidenceCount++
    }
  }

  for (const vendorId of vendorIds) {
    const related = getRelatedEntities(vendorId, graph)
    const businessRelated = related.filter((r) => isBusinessRelationship(r.relationship_type))
    if (businessRelated.length > 0) {
      vendorWithRelationships++
      const avgConf = businessRelated.reduce((sum, r) => sum + r.confidence, 0) / businessRelated.length
      totalConfidence += avgConf
      confidenceCount++
    }
  }

  const customerCoverage = customerIds.length > 0 ? customerWithRelationships / customerIds.length : 0
  const vendorCoverage = vendorIds.length > 0 ? vendorWithRelationships / vendorIds.length : 0
  const overallCoverage = (customerWithRelationships + vendorWithRelationships) / allIds.length
  const avgConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0

  return {
    customer_coverage: customerCoverage,
    vendor_coverage: vendorCoverage,
    overall_coverage: overallCoverage,
    avg_relationship_confidence: avgConfidence,
  }
}

/**
 * Log entity graph boosting results
 */
export function logEntityGraphBoosting(
  customerBoosts: EntityGraphBoostResult[],
  vendorBoosts: EntityGraphBoostResult[]
) {
  const customerBoosted = customerBoosts.filter((b) => b.boost_amount > 0)
  const vendorBoosted = vendorBoosts.filter((b) => b.boost_amount > 0)

  log("entity_graph.boosting", {
    customers_boosted: customerBoosted.length,
    vendors_boosted: vendorBoosted.length,
    avg_customer_boost: customerBoosted.length > 0
      ? customerBoosted.reduce((sum, b) => sum + b.boost_amount, 0) / customerBoosted.length
      : 0,
    avg_vendor_boost: vendorBoosted.length > 0
      ? vendorBoosted.reduce((sum, b) => sum + b.boost_amount, 0) / vendorBoosted.length
      : 0,
  })
}
