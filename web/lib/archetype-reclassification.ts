/**
 * Archetype Reclassification
 *
 * Reclassifies entity archetypes based on relationships to anchor entities.
 * Enables low_data and episodic entities to inherit patterns from related entities.
 */

import type { EntityGraphMap } from "./entity-graph-analysis"
import type { EntityCluster } from "./entity-clustering"
import {
  getRelatedEntities,
  isBusinessRelationship,
} from "./entity-graph-analysis"
import { getAnchorEntity } from "./entity-clustering"
import { log } from "./logger"

export type ArchetypeReclassification = {
  entity_id: string
  original_archetype: string
  reclassified_archetype: string
  anchor_entity_id?: string
  reason: string
  confidence_penalty: number
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
  // Only inherit if satellite has very few payments
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
  // Only inherit if satellite has very few payments
  if (paymentCount >= 2) return false

  const related = getRelatedEntities(vendorId, graph)
  const match = related.find((r) => r.entity_id === anchorId)

  return match ? match.confidence > 0.7 && isBusinessRelationship(match.relationship_type) : false
}

/**
 * Reclassify customer archetype based on anchor
 */
export function reclassifyCustomerArchetype(
  customerId: string,
  originalArchetype: string,
  paymentCount: number,
  anchorArchetype: string,
  anchorPaymentCount: number,
  graph: EntityGraphMap,
  anchorMap: Map<string, string>
): ArchetypeReclassification | null {
  const anchorId = getAnchorEntity(customerId, anchorMap)
  if (!anchorId) return null

  if (!shouldInheritCustomerArchetype(customerId, anchorId, paymentCount, graph)) {
    return null
  }

  // Map anchor archetype to satellite archetype
  let newArchetype = originalArchetype
  let reason = ""
  let penalty = 0

  if (anchorArchetype === "clockwork") {
    newArchetype = "clockwork"
    reason = `Inherited from clockwork anchor (${anchorPaymentCount} payments)`
    penalty = 0.1 // Small penalty for inherited archetype
  } else if (anchorArchetype === "slow_reliable") {
    newArchetype = "slow_reliable"
    reason = `Inherited from slow_reliable anchor (${anchorPaymentCount} payments)`
    penalty = 0.1
  } else if (anchorArchetype === "bursty") {
    newArchetype = "bursty"
    reason = `Inherited from bursty anchor (${anchorPaymentCount} payments)`
    penalty = 0.15
  } else if (anchorArchetype === "volatile") {
    // Don't inherit volatile, keep original
    return null
  } else if (anchorArchetype === "episodic") {
    newArchetype = "episodic"
    reason = `Inherited from episodic anchor (${anchorPaymentCount} payments)`
    penalty = 0.2
  }

  if (newArchetype === originalArchetype) {
    return null
  }

  return {
    entity_id: customerId,
    original_archetype: originalArchetype,
    reclassified_archetype: newArchetype,
    anchor_entity_id: anchorId,
    reason,
    confidence_penalty: penalty,
  }
}

/**
 * Reclassify vendor archetype based on anchor
 */
export function reclassifyVendorArchetype(
  vendorId: string,
  originalArchetype: string,
  paymentCount: number,
  anchorArchetype: string,
  anchorPaymentCount: number,
  graph: EntityGraphMap,
  anchorMap: Map<string, string>
): ArchetypeReclassification | null {
  const anchorId = getAnchorEntity(vendorId, anchorMap)
  if (!anchorId) return null

  if (!shouldInheritVendorArchetype(vendorId, anchorId, paymentCount, graph)) {
    return null
  }

  // Map anchor archetype to satellite archetype
  let newArchetype = originalArchetype
  let reason = ""
  let penalty = 0

  if (anchorArchetype === "hard") {
    newArchetype = "hard"
    reason = `Inherited from hard (recurring) anchor (${anchorPaymentCount} payments)`
    penalty = 0.1
  } else if (anchorArchetype === "soft") {
    newArchetype = "soft"
    reason = `Inherited from soft (regular) anchor (${anchorPaymentCount} payments)`
    penalty = 0.1
  } else if (anchorArchetype === "episodic") {
    newArchetype = "episodic"
    reason = `Inherited from episodic anchor (${anchorPaymentCount} payments)`
    penalty = 0.2
  }

  if (newArchetype === originalArchetype) {
    return null
  }

  return {
    entity_id: vendorId,
    original_archetype: originalArchetype,
    reclassified_archetype: newArchetype,
    anchor_entity_id: anchorId,
    reason,
    confidence_penalty: penalty,
  }
}

/**
 * Apply archetype reclassifications to customer models
 */
export function applyCustomerArchetypeReclassifications(
  customers: Array<{
    entity_id: string
    archetype: string
    payment_count: number
  }>,
  graph: EntityGraphMap,
  anchorMap: Map<string, string>,
  customerArchetypeMap: Map<string, string>
): ArchetypeReclassification[] {
  const reclassifications: ArchetypeReclassification[] = []

  for (const customer of customers) {
    const anchorId = getAnchorEntity(customer.entity_id, anchorMap)
    if (!anchorId) continue

    const anchorCustomer = customers.find((c) => c.entity_id === anchorId)
    if (!anchorCustomer) continue

    const reclassification = reclassifyCustomerArchetype(
      customer.entity_id,
      customer.archetype,
      customer.payment_count,
      anchorCustomer.archetype,
      anchorCustomer.payment_count,
      graph,
      anchorMap
    )

    if (reclassification) {
      reclassifications.push(reclassification)
      customerArchetypeMap.set(customer.entity_id, reclassification.reclassified_archetype)
    }
  }

  return reclassifications
}

/**
 * Apply archetype reclassifications to vendor models
 */
export function applyVendorArchetypeReclassifications(
  vendors: Array<{
    entity_id: string
    archetype: string
    payment_count: number
  }>,
  graph: EntityGraphMap,
  anchorMap: Map<string, string>,
  vendorArchetypeMap: Map<string, string>
): ArchetypeReclassification[] {
  const reclassifications: ArchetypeReclassification[] = []

  for (const vendor of vendors) {
    const anchorId = getAnchorEntity(vendor.entity_id, anchorMap)
    if (!anchorId) continue

    const anchorVendor = vendors.find((v) => v.entity_id === anchorId)
    if (!anchorVendor) continue

    const reclassification = reclassifyVendorArchetype(
      vendor.entity_id,
      vendor.archetype,
      vendor.payment_count,
      anchorVendor.archetype,
      anchorVendor.payment_count,
      graph,
      anchorMap
    )

    if (reclassification) {
      reclassifications.push(reclassification)
      vendorArchetypeMap.set(vendor.entity_id, reclassification.reclassified_archetype)
    }
  }

  return reclassifications
}

/**
 * Log archetype reclassifications
 */
export function logArchetypeReclassifications(
  customerReclassifications: ArchetypeReclassification[],
  vendorReclassifications: ArchetypeReclassification[]
) {
  const customerByNewArchetype: Record<string, number> = {}
  const vendorByNewArchetype: Record<string, number> = {}

  for (const r of customerReclassifications) {
    customerByNewArchetype[r.reclassified_archetype] =
      (customerByNewArchetype[r.reclassified_archetype] ?? 0) + 1
  }

  for (const r of vendorReclassifications) {
    vendorByNewArchetype[r.reclassified_archetype] =
      (vendorByNewArchetype[r.reclassified_archetype] ?? 0) + 1
  }

  log("archetype_reclassification.complete", {
    customers_reclassified: customerReclassifications.length,
    vendors_reclassified: vendorReclassifications.length,
    customer_archetypes: customerByNewArchetype,
    vendor_archetypes: vendorByNewArchetype,
  })
}
