/**
 * AI Forecast Enhancement
 * Integrates AI-powered entity inference and pattern learning into the forecast
 */

import { inferEntityPatterns, inferEntityRelationships, inferPaymentTerms } from "./ai-entity-inference"
import { analyzePaymentPatterns, identifyPaymentRisks } from "./ai-payment-patterns"
import { log } from "./logger"
import type { CustomerModel, VendorModel } from "./state/types"

export type AIEnhancementResult = {
  customers_enhanced: number
  vendors_enhanced: number
  avg_customer_boost: number
  avg_vendor_boost: number
  relationships_inferred: number
  patterns_analyzed: number
  total_confidence_improvement: number
}

/**
 * Enhance behavioral models with AI-powered insights
 */
export async function enhanceModelsWithAI(
  customers: CustomerModel[],
  vendors: VendorModel[],
  reconciledPayments?: Array<{
    entity_id: string
    entity_name: string
    invoice_date: string
    payment_date: string
    invoice_amount: number
    payment_amount: number
    payment_count: number
  }>
): Promise<{
  enhanced_customers: CustomerModel[]
  enhanced_vendors: VendorModel[]
  enhancement_result: AIEnhancementResult
}> {
  const result: AIEnhancementResult = {
    customers_enhanced: 0,
    vendors_enhanced: 0,
    avg_customer_boost: 0,
    avg_vendor_boost: 0,
    relationships_inferred: 0,
    patterns_analyzed: 0,
    total_confidence_improvement: 0,
  }

  let enhancedCustomers = [...customers]
  let enhancedVendors = [...vendors]

  try {
    // 1. Infer entity patterns from names/descriptions
    log("ai_enhancement.inferring_patterns", { customers: customers.length, vendors: vendors.length })

    const customerPatterns = await inferEntityPatterns(
      customers.map((c) => ({
        id: c.entity_id,
        name: c.name,
        type: "customer",
      }))
    )

    const vendorPatterns = await inferEntityPatterns(
      vendors.map((v) => ({
        id: v.entity_id,
        name: v.name,
        type: "vendor",
      }))
    )

    // Apply customer pattern boosts
    let customerBoostSum = 0
    for (const pattern of customerPatterns) {
      const customer = enhancedCustomers.find((c) => c.entity_id === pattern.entity_id)
      if (customer && pattern.confidence_boost) {
        // Store the AI boost for use in confidence calculation
        ;(customer as any)._ai_confidence_boost = pattern.confidence_boost
        customerBoostSum += pattern.confidence_boost
        result.customers_enhanced++
      }
    }
    result.avg_customer_boost = result.customers_enhanced > 0 ? customerBoostSum / result.customers_enhanced : 0

    // Apply vendor pattern boosts
    let vendorBoostSum = 0
    for (const pattern of vendorPatterns) {
      const vendor = enhancedVendors.find((v) => v.entity_id === pattern.entity_id)
      if (vendor && pattern.confidence_boost) {
        ;(vendor as any)._ai_confidence_boost = pattern.confidence_boost
        vendorBoostSum += pattern.confidence_boost
        result.vendors_enhanced++
      }
    }
    result.avg_vendor_boost = result.vendors_enhanced > 0 ? vendorBoostSum / result.vendors_enhanced : 0

    // 2. Infer hidden entity relationships
    log("ai_enhancement.inferring_relationships", { total_entities: customers.length + vendors.length })

    const allEntities = [
      ...customers.map((c) => ({ id: c.entity_id, name: c.name })),
      ...vendors.map((v) => ({ id: v.entity_id, name: v.name })),
    ]

    const relationships = await inferEntityRelationships(allEntities)
    result.relationships_inferred = relationships.length

    // 3. Analyze reconciled payment patterns if available
    if (reconciledPayments && reconciledPayments.length > 0) {
      log("ai_enhancement.analyzing_payment_patterns", { payments: reconciledPayments.length })

      const patterns = await analyzePaymentPatterns(reconciledPayments)
      result.patterns_analyzed = patterns.length

      // Apply pattern boosts
      for (const pattern of patterns) {
        const customer = enhancedCustomers.find((c) => c.entity_id === pattern.entity_id)
        if (customer) {
          const existingBoost = (customer as any)._ai_confidence_boost || 0
          ;(customer as any)._ai_confidence_boost = Math.min(1, existingBoost + pattern.confidence_boost)
        }

        const vendor = enhancedVendors.find((v) => v.entity_id === pattern.entity_id)
        if (vendor) {
          const existingBoost = (vendor as any)._ai_confidence_boost || 0
          ;(vendor as any)._ai_confidence_boost = Math.min(1, existingBoost + pattern.confidence_boost)
        }
      }
    }

    result.total_confidence_improvement = result.avg_customer_boost * 0.5 + result.avg_vendor_boost * 0.5

    log("ai_enhancement.complete", result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("ai_enhancement.error", { error: message })
  }

  return {
    enhanced_customers: enhancedCustomers,
    enhanced_vendors: enhancedVendors,
    enhancement_result: result,
  }
}
