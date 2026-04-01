/**
 * AI-Enhanced AR Reconciliation Classifier
 * 
 * Uses LLM to improve AR classification accuracy by:
 * 1. Customer name fuzzy matching (recognizing variations)
 * 2. Description pattern analysis
 * 3. Suggesting better case types for ambiguous cases
 * 4. Providing confidence scores and reasoning
 * 
 * AR-ONLY: This classifier focuses on matching customer payments to invoices.
 */

import type { ClassificationResult, CaseType } from "./reconciliation-case-classifier"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.OPENAI_API_KEY

export interface AIClassificationEnhancement {
  original_case_type: CaseType
  suggested_case_type: CaseType
  confidence: number // 0-1
  reasoning: string
  entity_matches: Array<{
    movement_counterparty: string
    candidate_customer: string
    match_confidence: number
    is_same_customer: boolean
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
 * Enhance a batch of AR classifications using AI
 */
export async function enhanceClassificationsWithAI(
  movements: MovementForAI[],
  cashEvents: CashEventForAI[],
  options: { maxMovements?: number } = {}
): Promise<Map<string, AIClassificationEnhancement>> {
  const results = new Map<string, AIClassificationEnhancement>()
  const maxMovements = options.maxMovements || 50

  // Only process AR movements (inflows) that need enhancement
  const movementsToEnhance = movements
    .filter((m) => {
      // AR only - skip outflows
      if (m.direction === "outflow") return false
      
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

  // Build customer list for matching (AR only)
  const uniqueCustomers = [...new Set(
    cashEvents
      .filter(e => e.event_type === "ar")
      .map((e) => e.entity_name)
  )].slice(0, 100)

  // Process in batches of 10
  const batchSize = 10
  for (let i = 0; i < movementsToEnhance.length; i += batchSize) {
    const batch = movementsToEnhance.slice(i, i + batchSize)
    
    try {
      const batchResults = await classifyBatchWithAI(batch, uniqueCustomers, cashEvents)
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
  customerNames: string[],
  cashEvents: CashEventForAI[]
): Promise<Map<string, AIClassificationEnhancement>> {
  const results = new Map<string, AIClassificationEnhancement>()

  if (!API_KEY) {
    console.error("[AI Classifier] No API key configured")
    return results
  }

  const prompt = buildClassificationPrompt(movements, customerNames, cashEvents)

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an AR (Accounts Receivable) reconciliation expert. Your job is to analyze customer payments and determine:
1. What type of payment this is (exact match, partial payment, overpayment, etc.)
2. Which customer this payment likely belongs to
3. Whether there's a matching invoice in the system

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
      }),
    })

    if (!response.ok) {
      console.error("[AI Classifier] API error:", response.status)
      return results
    }

    const json = await response.json()
    const content = json.choices?.[0]?.message?.content
    if (!content) return results

    const parsed = JSON.parse(content) as {
      classifications: Array<{
        movement_id: string
        suggested_case_type: string
        confidence: number
        reasoning: string
        matched_customer?: string
        customer_match_confidence?: number
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
        entity_matches: c.matched_customer
          ? [
              {
                movement_counterparty: movement.counterparty || "",
                candidate_customer: c.matched_customer,
                match_confidence: c.customer_match_confidence || 0.8,
                is_same_customer: (c.customer_match_confidence || 0) >= 0.7,
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
  customerNames: string[],
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
      customer: c.entity_name,
      amount: c.amount,
      match_type: c.match_type,
      diff: c.amount_diff,
    })),
  }))

  return `Analyze these customer payments and classify them for AR reconciliation.

KNOWN CUSTOMERS (in the system):
${customerNames.slice(0, 50).join(", ")}

PAYMENTS TO CLASSIFY:
${JSON.stringify(movementsList, null, 2)}

For each payment, determine:
1. suggested_case_type: One of: EXACT_SINGLE, EXACT_MULTI_SAME_CUSTOMER, EXACT_MULTI_DIFF_CUSTOMER, FEE_ADJUSTED_SINGLE, PARTIAL_SINGLE, AGGREGATION_SAME_CUSTOMER, DUPLICATE_PAYMENT, OVERPAYMENT_SINGLE, OVERPAYMENT_PREPAYMENT, NO_MATCH_NO_CANDIDATES, REFUND_FULL, REFUND_PARTIAL
2. confidence: 0.0 to 1.0
3. reasoning: Brief explanation (1 sentence)
4. matched_customer: If you can identify which known customer this belongs to (fuzzy match the counterparty name)
5. customer_match_confidence: 0.0 to 1.0 for customer match
6. recommended_action: auto_match, review, manual, or exclude
7. flags: Array of detected issues like ["possible_duplicate", "name_mismatch", "amount_close_match"]

Respond with JSON: { "classifications": [...] }`
}

function validateCaseType(ct: string): CaseType | null {
  // AR-focused case types
  const validTypes: CaseType[] = [
    // Direct Link Cases
    "DIRECT_LINK_SINGLE", "DIRECT_LINK_MULTI_SAME_CUSTOMER", "DIRECT_LINK_MULTI_DIFF_CUSTOMER",
    "DIRECT_LINK_WITH_FEE", "DIRECT_LINK_PARTIAL",
    // Exact Match Cases
    "EXACT_SINGLE", "EXACT_MULTI_SAME_CUSTOMER", "EXACT_MULTI_DIFF_CUSTOMER", "EXACT_WITH_REFERENCE",
    // Fee-Adjusted Cases
    "FEE_ADJUSTED_SINGLE", "FEE_ADJUSTED_MULTI", "FEE_STRIPE_SQUARE", "FEE_ACH",
    // Partial Payment Cases
    "PARTIAL_SINGLE", "PARTIAL_MULTI_SAME_CUSTOMER", "PARTIAL_MULTI_DIFF_CUSTOMER",
    // Aggregation Cases
    "AGGREGATION_SAME_CUSTOMER", "AGGREGATION_DIFF_CUSTOMER", "AGGREGATION_WITH_FEE",
    // Overpayment Cases
    "OVERPAYMENT_SINGLE", "OVERPAYMENT_PREPAYMENT",
    // Rounding Cases
    "ROUNDING_UNDER", "ROUNDING_OVER",
    // Discount Cases
    "EARLY_DISCOUNT", "VOLUME_DISCOUNT",
    // Refund Cases
    "REFUND_FULL", "REFUND_PARTIAL",
    // Special Cases
    "DUPLICATE_PAYMENT", "CROSS_CUSTOMER_PAYMENT", "ZERO_AMOUNT",
    // Zero Candidate Cases
    "ZERO_MISSING_INVOICE", "ZERO_PREPAYMENT", "ZERO_REFUND_RECEIVED", 
    "ZERO_DELETED_CUSTOMER", "ZERO_UNCLASSIFIED",
    // No Match Cases
    "NO_MATCH_HAS_CANDIDATES", "NO_MATCH_NO_CANDIDATES",
    // Non-Operational Cases
    "INTERCOMPANY_TRANSFER", "LOAN_PAYMENT", "LOAN_PROCEEDS", "PAYROLL", "TAX_PAYMENT",
    "OWNER_DRAW", "OWNER_CONTRIBUTION", "BANK_FEE", "INTEREST_INCOME",
    "CREDIT_CARD_PAYMENT", "MERCHANT_DEPOSIT", "UNCLASSIFIED_NON_OP",
    // AP Excluded
    "AP_EXCLUDED",
  ]
  return validTypes.includes(ct as CaseType) ? (ct as CaseType) : null
}

function validateAction(action: string): "auto_match" | "review" | "manual" | "exclude" | null {
  const valid = ["auto_match", "review", "manual", "exclude"]
  return valid.includes(action) ? (action as "auto_match" | "review" | "manual" | "exclude") : null
}

/**
 * Quick customer name matching using AI
 */
export async function matchEntityNamesWithAI(
  counterparty: string,
  candidateCustomers: string[]
): Promise<{ matched_customer: string | null; confidence: number }> {
  if (!counterparty || candidateCustomers.length === 0 || !API_KEY) {
    return { matched_customer: null, confidence: 0 }
  }

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You match customer names. Return JSON with matched_customer (exact string from list or null) and confidence (0-1)."
          },
          {
            role: "user",
            content: `Does "${counterparty}" match any of these customers?\n${candidateCustomers.slice(0, 20).join("\n")}\n\nRespond: {"matched_customer": "...", "confidence": 0.X}`
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 100,
      }),
    })

    if (!response.ok) return { matched_customer: null, confidence: 0 }

    const json = await response.json()
    const content = json.choices?.[0]?.message?.content
    if (!content) return { matched_customer: null, confidence: 0 }

    const parsed = JSON.parse(content)
    return {
      matched_customer: parsed.matched_customer || null,
      confidence: parsed.confidence || 0,
    }
  } catch {
    return { matched_customer: null, confidence: 0 }
  }
}
