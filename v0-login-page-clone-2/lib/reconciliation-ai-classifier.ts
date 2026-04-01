/**
 * AI-Enhanced Reconciliation Classifier
 * 
 * Uses LLM to improve classification accuracy by:
 * 1. Entity name fuzzy matching (recognizing variations)
 * 2. Description pattern analysis
 * 3. Suggesting better case types for ambiguous cases
 * 4. Providing confidence scores and reasoning
 */

import OpenAI from "openai"
import type { ClassificationResult, CaseType, Candidate } from "./reconciliation-case-classifier"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface AIClassificationEnhancement {
  original_case_type: CaseType
  suggested_case_type: CaseType
  confidence: number // 0-1
  reasoning: string
  entity_matches: Array<{
    movement_counterparty: string
    candidate_entity: string
    match_confidence: number
    is_same_entity: boolean
  }>
  recommended_action: "auto_match" | "review" | "manual" | "exclude"
  flags_detected: string[]
}

export interface MovementForAI {
  id: string
  counterparty: string | null
  raw_description: string | null
  amount: number
  direction: "inflow" | "outflow"
  date: string
  classification: ClassificationResult
}

interface CashEventForAI {
  id: string
  entity_name: string
  amount: number
  event_type: "ar" | "ap"
}

/**
 * Enhance a batch of classifications using AI
 */
export async function enhanceClassificationsWithAI(
  movements: MovementForAI[],
  cashEvents: CashEventForAI[],
  options: { maxMovements?: number } = {}
): Promise<Map<string, AIClassificationEnhancement>> {
  const results = new Map<string, AIClassificationEnhancement>()
  const maxMovements = options.maxMovements || 50

  // Only process movements that need enhancement (ambiguous cases)
  const movementsToEnhance = movements
    .filter((m) => {
      const ct = m.classification.case_type
      // Focus on cases that could benefit from AI
      return (
        ct === "OVERPAYMENT_PREPAYMENT" ||
        ct === "NO_MATCH_HAS_CANDIDATES" ||
        ct === "NO_MATCH_NO_CANDIDATES" ||
        ct.startsWith("EXACT_MULTI") ||
        ct === "DUPLICATE_PAYMENT" ||
        m.classification.flags.same_amount_conflict
      )
    })
    .slice(0, maxMovements)

  if (movementsToEnhance.length === 0) {
    return results
  }

  // Build entity list for matching
  const uniqueEntities = [...new Set(cashEvents.map((e) => e.entity_name))].slice(0, 100)

  // Process in batches of 10
  const batchSize = 10
  for (let i = 0; i < movementsToEnhance.length; i += batchSize) {
    const batch = movementsToEnhance.slice(i, i + batchSize)
    
    try {
      const batchResults = await classifyBatchWithAI(batch, uniqueEntities, cashEvents)
      for (const [id, enhancement] of batchResults) {
        results.set(id, enhancement)
      }
    } catch (error) {
      console.error("[AI Classifier] Batch error:", error)
    }
  }

  return results
}

async function classifyBatchWithAI(
  movements: MovementForAI[],
  entityNames: string[],
  cashEvents: CashEventForAI[]
): Promise<Map<string, AIClassificationEnhancement>> {
  const results = new Map<string, AIClassificationEnhancement>()

  const prompt = buildClassificationPrompt(movements, entityNames, cashEvents)

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a financial reconciliation expert. Your job is to analyze bank transactions and determine:
1. What type of transaction this is (payment to vendor, receipt from customer, fee, transfer, etc.)
2. Which entity (customer/vendor) this transaction likely belongs to
3. Whether there's a matching invoice/bill in the system

You must respond with valid JSON only. Be concise but accurate.`
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 2000,
    })

    const content = response.choices[0]?.message?.content
    if (!content) return results

    const parsed = JSON.parse(content) as {
      classifications: Array<{
        movement_id: string
        suggested_case_type: string
        confidence: number
        reasoning: string
        matched_entity?: string
        entity_match_confidence?: number
        recommended_action: string
        flags?: string[]
      }>
    }

    for (const c of parsed.classifications || []) {
      const movement = movements.find((m) => m.id === c.movement_id)
      if (!movement) continue

      results.set(c.movement_id, {
        original_case_type: movement.classification.case_type,
        suggested_case_type: validateCaseType(c.suggested_case_type) || movement.classification.case_type,
        confidence: Math.min(1, Math.max(0, c.confidence || 0.5)),
        reasoning: c.reasoning || "",
        entity_matches: c.matched_entity
          ? [
              {
                movement_counterparty: movement.counterparty || "",
                candidate_entity: c.matched_entity,
                match_confidence: c.entity_match_confidence || 0.8,
                is_same_entity: (c.entity_match_confidence || 0) >= 0.7,
              },
            ]
          : [],
        recommended_action: validateAction(c.recommended_action) || movement.classification.suggested_action,
        flags_detected: c.flags || [],
      })
    }
  } catch (error) {
    console.error("[AI Classifier] Parse error:", error)
  }

  return results
}

function buildClassificationPrompt(
  movements: MovementForAI[],
  entityNames: string[],
  cashEvents: CashEventForAI[]
): string {
  const movementsList = movements.map((m) => ({
    id: m.id,
    counterparty: m.counterparty,
    description: m.raw_description,
    amount: m.amount,
    direction: m.direction,
    date: m.date,
    current_case_type: m.classification.case_type,
    candidates_count: m.classification.candidates.length,
    top_candidates: m.classification.candidates.slice(0, 3).map((c) => ({
      entity: c.entity_name,
      amount: c.amount,
      match_type: c.match_type,
      diff: c.amount_diff,
    })),
  }))

  return `Analyze these bank transactions and classify them.

KNOWN ENTITIES (customers/vendors in the system):
${entityNames.slice(0, 50).join(", ")}

TRANSACTIONS TO CLASSIFY:
${JSON.stringify(movementsList, null, 2)}

For each transaction, determine:
1. suggested_case_type: One of: EXACT_SINGLE, EXACT_MULTI_SAME_ENTITY, FEE_IMPLIED_SINGLE, PARTIAL_SINGLE, AGGREGATION_SAME_ENTITY, DUPLICATE_PAYMENT, OVERPAYMENT_PREPAYMENT, NO_MATCH_NO_CANDIDATES, REVERSAL_FULL, CHARGEBACK
2. confidence: 0.0 to 1.0
3. reasoning: Brief explanation (1 sentence)
4. matched_entity: If you can identify which known entity this belongs to (fuzzy match the counterparty name)
5. entity_match_confidence: 0.0 to 1.0 for entity match
6. recommended_action: auto_match, review, manual, or exclude
7. flags: Array of detected issues like ["possible_duplicate", "name_mismatch", "amount_close_match"]

Respond with JSON: { "classifications": [...] }`
}

function validateCaseType(ct: string): CaseType | null {
  const validTypes: CaseType[] = [
    "DIRECT_LINK_SINGLE", "DIRECT_LINK_MULTI_SAME_ENTITY", "DIRECT_LINK_MULTI_DIFF_ENTITY",
    "DIRECT_LINK_WITH_FEE", "DIRECT_LINK_PARTIAL",
    "EXACT_SINGLE", "EXACT_MULTI_SAME_ENTITY", "EXACT_MULTI_DIFF_ENTITY", "EXACT_WITH_REFERENCE",
    "FEE_IMPLIED_SINGLE", "FEE_IMPLIED_MULTI", "FEE_FROM_TAG_DATA", "FEE_SEPARATE_TRANSACTION",
    "FEE_STRIPE_SQUARE", "FEE_ACH",
    "PARTIAL_SINGLE", "PARTIAL_MULTI_SAME_ENTITY", "PARTIAL_MULTI_DIFF_ENTITY", "PARTIAL_WITH_FEE",
    "AGGREGATION_SAME_ENTITY", "AGGREGATION_DIFF_ENTITY", "AGGREGATION_WITH_FEE", "AGGREGATION_PARTIAL",
    "OVERPAYMENT_SINGLE", "OVERPAYMENT_PREPAYMENT", "OVERPAYMENT_CREDIT_MEMO",
    "ROUNDING_UNDER", "ROUNDING_OVER",
    "EARLY_DISCOUNT", "VOLUME_DISCOUNT",
    "REVERSAL_FULL", "REVERSAL_PARTIAL", "CHARGEBACK",
    "DUPLICATE_PAYMENT", "CROSS_ENTITY_PAYMENT", "SETTLEMENT_BREAKDOWN", "ZERO_AMOUNT",
    "NO_MATCH_HAS_CANDIDATES", "NO_MATCH_NO_CANDIDATES",
    "INTERCOMPANY_TRANSFER", "LOAN_PAYMENT", "LOAN_PROCEEDS", "PAYROLL", "TAX_PAYMENT",
    "OWNER_DRAW", "OWNER_CONTRIBUTION", "BANK_FEE", "INTEREST_INCOME",
    "CREDIT_CARD_PAYMENT", "MERCHANT_DEPOSIT", "UNCLASSIFIED_NON_OP",
  ]
  return validTypes.includes(ct as CaseType) ? (ct as CaseType) : null
}

function validateAction(action: string): "auto_match" | "review" | "manual" | "exclude" | null {
  const valid = ["auto_match", "review", "manual", "exclude"]
  return valid.includes(action) ? (action as "auto_match" | "review" | "manual" | "exclude") : null
}

/**
 * Quick entity name matching using AI
 */
export async function matchEntityNamesWithAI(
  counterparty: string,
  candidateEntities: string[]
): Promise<{ matched_entity: string | null; confidence: number }> {
  if (!counterparty || candidateEntities.length === 0) {
    return { matched_entity: null, confidence: 0 }
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You match business names. Return JSON with matched_entity (exact string from list or null) and confidence (0-1)."
        },
        {
          role: "user",
          content: `Does "${counterparty}" match any of these entities?\n${candidateEntities.slice(0, 20).join("\n")}\n\nRespond: {"matched_entity": "...", "confidence": 0.X}`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 100,
    })

    const content = response.choices[0]?.message?.content
    if (!content) return { matched_entity: null, confidence: 0 }

    const parsed = JSON.parse(content)
    return {
      matched_entity: parsed.matched_entity || null,
      confidence: parsed.confidence || 0,
    }
  } catch {
    return { matched_entity: null, confidence: 0 }
  }
}
