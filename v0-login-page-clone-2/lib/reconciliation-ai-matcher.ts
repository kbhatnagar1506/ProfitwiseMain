/**
 * AI AR Reconciliation Matcher
 * 
 * Uses GPT-5.4-mini + Supermemory to intelligently match bank INFLOWS to INVOICES.
 * 
 * AR ONLY - This matcher handles Accounts Receivable reconciliation:
 * - Bank inflows (customer payments) → Match to invoices
 * 
 * AP (outflows) are NOT reconciled here because:
 * - Bills are often created FROM the payment (circular)
 * - AP should go through: classify → vendor model → forecast
 */

import { searchEntityContextFromSupermemory, searchEntityProfileContext } from "./supermemory"
import type { ClassificationResult, CaseType, Candidate } from "./reconciliation-case-classifier"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.OPENAI_API_KEY
const MODEL = "gpt-5.4-mini"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MovementToMatch {
  id: string
  counterparty: string | null
  raw_description: string | null
  amount: number
  direction: "inflow" | "outflow"
  date: string
  classification: ClassificationResult
}

export interface MatchDecision {
  movement_id: string
  decision: "match" | "no_match" | "needs_review" | "create_invoice"
  matched_candidate_id: string | null
  matched_candidate_ids: string[]
  match_type?: string  // EXACT, FEE, PARTIAL, DIRECT_LINK, AGGREGATION
  status?: "confirmed" | "pending"  // AI-decided status based on confidence
  confidence: number
  reasoning: string
  suggested_action: string
  entity_context: string | null
}

export interface AIMatcherResult {
  total_processed: number
  matches: MatchDecision[]
  errors: string[]
  processing_time_ms: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice State Tracking
// ─────────────────────────────────────────────────────────────────────────────

interface InvoiceState {
  id: string
  originalAmount: number
  remainingAmount: number  // Tracks partial payments
  isFullyMatched: boolean
  matchedPayments: string[]  // Movement IDs that matched this invoice
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Matcher Function
// ─────────────────────────────────────────────────────────────────────────────

export async function runAIReconciliationMatcher(
  userId: string,
  movements: MovementToMatch[],
  options: {
    batchSize?: number
    maxMovements?: number
    includeSupermemory?: boolean
    parallelBatches?: number
  } = {}
): Promise<AIMatcherResult> {
  const startTime = Date.now()
  const maxMovements = options.maxMovements || 2000
  const includeSupermemory = options.includeSupermemory !== false

  const results: MatchDecision[] = []
  const errors: string[] = []
  
  // CRITICAL: Track invoice state to handle all edge cases:
  // 1. Same customer, multiple invoices, same amount → track by unique ID
  // 2. Partial payments → track remaining amount
  // 3. Aggregation → remove all matched invoices
  // 4. Overpayment → mark invoice as fully matched
  // 5. FIFO → handled by sorting candidates by due date
  const invoiceStates = new Map<string, InvoiceState>()

  const movementsToProcess = movements
    .filter(m => shouldProcessWithAI(m))
    .slice(0, maxMovements)
  
  // Initialize invoice states from all candidates
  for (const m of movementsToProcess) {
    for (const c of m.classification.candidates) {
      if (!invoiceStates.has(c.id)) {
        invoiceStates.set(c.id, {
          id: c.id,
          originalAmount: c.amount,
          remainingAmount: c.outstanding_amount ?? c.amount,
          isFullyMatched: false,
          matchedPayments: []
        })
      }
    }
  }
  
  console.log(`[AI Matcher] Tracking ${invoiceStates.size} unique invoices`)

  const totalCount = movementsToProcess.length
  let batchSize: number

  if (totalCount <= 10) {
    batchSize = totalCount || 1
  } else if (totalCount <= 50) {
    batchSize = Math.ceil(totalCount / 5)
  } else if (totalCount <= 200) {
    batchSize = 10
  } else if (totalCount <= 500) {
    batchSize = 15
  } else if (totalCount <= 1000) {
    batchSize = 20
  } else {
    batchSize = 25
  }

  if (options.batchSize) batchSize = options.batchSize

  console.log(`[AI Matcher] Model: ${MODEL} | Processing ${totalCount} movements: batchSize=${batchSize}`)

  // Process batches SEQUENTIALLY to maintain invoice state
  // Each batch's matches update invoice states for subsequent batches
  for (let i = 0; i < movementsToProcess.length; i += batchSize) {
    const batch = movementsToProcess.slice(i, i + batchSize)
    
    // Filter candidates based on current invoice states
    const filteredBatch = filterByInvoiceState(batch, invoiceStates)
    
    const fullyMatchedCount = Array.from(invoiceStates.values()).filter(s => s.isFullyMatched).length
    console.log(`[AI Matcher] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(movementsToProcess.length / batchSize)} | ${filteredBatch.length} movements | ${fullyMatchedCount}/${invoiceStates.size} invoices fully matched`)
    
    try {
      const batchResults = await processBatch(userId, filteredBatch, includeSupermemory)
      
      // Update invoice states based on match decisions
      for (const decision of batchResults) {
        if (decision.decision === "match") {
          // Handle single invoice match
          if (decision.matched_candidate_id) {
            updateInvoiceState(
              invoiceStates, 
              decision.matched_candidate_id, 
              decision.movement_id,
              getPaymentAmount(movementsToProcess, decision.movement_id),
              decision
            )
          }
          // Handle aggregation (multiple invoices)
          for (const id of decision.matched_candidate_ids) {
            updateInvoiceState(
              invoiceStates, 
              id, 
              decision.movement_id,
              null, // For aggregation, mark as fully matched
              decision
            )
          }
        }
      }
      
      results.push(...batchResults)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      errors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${errorMsg}`)
      console.error(`[AI Matcher] Batch error:`, error)
    }
  }

  const fullyMatchedCount = Array.from(invoiceStates.values()).filter(s => s.isFullyMatched).length
  const partiallyMatchedCount = Array.from(invoiceStates.values()).filter(s => s.matchedPayments.length > 0 && !s.isFullyMatched).length
  console.log(`[AI Matcher] Completed. Invoices: ${fullyMatchedCount} fully matched, ${partiallyMatchedCount} partially matched`)

  return {
    total_processed: movementsToProcess.length,
    matches: results,
    errors,
    processing_time_ms: Date.now() - startTime
  }
}

// Get payment amount from movement
function getPaymentAmount(movements: MovementToMatch[], movementId: string): number {
  const m = movements.find(m => m.id === movementId)
  return m ? Math.abs(m.amount) : 0
}

// Update invoice state after a match
function updateInvoiceState(
  invoiceStates: Map<string, InvoiceState>,
  invoiceId: string,
  movementId: string,
  paymentAmount: number | null,
  decision: MatchDecision
): void {
  const state = invoiceStates.get(invoiceId)
  if (!state) return
  
  state.matchedPayments.push(movementId)
  
  // Determine if this is a partial or full match based on match_type from AI
  const isPartialMatch = decision.match_type?.toUpperCase() === 'PARTIAL'
  
  if (isPartialMatch && paymentAmount !== null) {
    // Partial payment - reduce remaining amount but don't mark as fully matched
    state.remainingAmount = Math.max(0, state.remainingAmount - paymentAmount)
    if (state.remainingAmount < 0.01) {
      state.isFullyMatched = true
    }
    console.log(`[AI Matcher] Invoice ${invoiceId}: Partial payment $${paymentAmount}, remaining $${state.remainingAmount.toFixed(2)}`)
  } else {
    // Full match or aggregation - mark as fully matched
    state.isFullyMatched = true
    state.remainingAmount = 0
    console.log(`[AI Matcher] Invoice ${invoiceId}: Fully matched`)
  }
}

// Filter candidates based on invoice state
// - Remove fully matched invoices
// - Update outstanding amounts for partially matched invoices
function filterByInvoiceState(
  movements: MovementToMatch[],
  invoiceStates: Map<string, InvoiceState>
): MovementToMatch[] {
  return movements.map(m => {
    const originalCount = m.classification.candidates.length
    
    // Filter and update candidates based on invoice state
    const filteredCandidates = m.classification.candidates
      .filter(c => {
        const state = invoiceStates.get(c.id)
        // Keep if: no state (new invoice) OR not fully matched
        return !state || !state.isFullyMatched
      })
      .map(c => {
        const state = invoiceStates.get(c.id)
        if (state && state.remainingAmount < state.originalAmount) {
          // Update outstanding amount for partially paid invoices
          return {
            ...c,
            outstanding_amount: state.remainingAmount,
            amount_diff: Math.abs(m.amount) - state.remainingAmount
          }
        }
        return c
      })
      // Sort by due date (FIFO - older invoices first)
      .sort((a, b) => {
        if (!a.due_date && !b.due_date) return 0
        if (!a.due_date) return 1
        if (!b.due_date) return -1
        return new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
      })
    
    // If candidates changed, create a new movement object
    if (filteredCandidates.length !== originalCount) {
      const removedCount = originalCount - filteredCandidates.length
      if (removedCount > 0) {
        console.log(`[AI Matcher] Movement ${m.id}: Removed ${removedCount} fully-matched invoices, ${filteredCandidates.length} remaining`)
      }
      return {
        ...m,
        classification: {
          ...m.classification,
          candidates: filteredCandidates
        }
      }
    }
    
    return m
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch Processing
// ─────────────────────────────────────────────────────────────────────────────

function shouldProcessWithAI(movement: MovementToMatch): boolean {
  // AR ONLY - Skip outflows (AP)
  // AP goes through vendor classification, not invoice matching
  if (movement.direction === "outflow") {
    return false
  }
  
  // Skip non-operational
  if (!movement.classification.is_operational) {
    return false
  }
  
  const ct = movement.classification.case_type
  const hasCandidates = movement.classification.candidates.length > 0
  
  // Process AR movements with invoice candidates
  if (hasCandidates) {
    return true
  }
  
  // Process zero-candidate AR movements (missing invoice scenarios)
  return ct.startsWith("ZERO_")
}

async function processBatch(
  userId: string,
  movements: MovementToMatch[],
  includeSupermemory: boolean
): Promise<MatchDecision[]> {
  const results: MatchDecision[] = []

  const withCandidates = movements.filter(m => m.classification.candidates.length > 0)
  const zeroCandidates = movements.filter(m => m.classification.candidates.length === 0)

  if (withCandidates.length > 0) {
    const matchResults = await matchMovementsWithCandidates(userId, withCandidates, includeSupermemory)
    results.push(...matchResults)
  }

  if (zeroCandidates.length > 0) {
    const zeroResults = await classifyZeroCandidateMovements(userId, zeroCandidates, includeSupermemory)
    results.push(...zeroResults)
  }

  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// Match Movements WITH Candidates - IMPROVED PROMPTS
// ─────────────────────────────────────────────────────────────────────────────

async function matchMovementsWithCandidates(
  userId: string,
  movements: MovementToMatch[],
  includeSupermemory: boolean
): Promise<MatchDecision[]> {
  let entityContext = ""
  if (includeSupermemory) {
    const counterparties = [...new Set(movements.map(m => m.counterparty).filter(Boolean))]
    if (counterparties.length > 0) {
      entityContext = await searchEntityContextFromSupermemory(userId, counterparties.slice(0, 10).join(", "))
    }
  }

  const movementData = movements.map((m, idx) => {
    // Send ALL candidates - don't truncate, let AI see everything
    const candidates = m.classification.candidates
    
    return {
      idx: idx + 1,
      id: m.id,
      bank: {
        counterparty: m.counterparty || "Unknown",
        description: m.raw_description || "",
        amount: Math.abs(m.amount),
        type: m.direction === "inflow" ? "RECEIVED (AR)" : "PAID (AP)",
        date: m.date
      },
      case_type: m.classification.case_type,
      flags: Object.entries(m.classification.flags)
        .filter(([_, v]) => v)
        .map(([k]) => k),
      candidates: candidates.map((c, cidx) => ({
        num: cidx + 1,
        id: c.id,
        entity: c.entity_name,
        amount: c.amount,
        outstanding: c.outstanding_amount,
        diff: c.amount_diff,
        diff_pct: c.amount !== 0 ? ((c.amount_diff / c.amount) * 100).toFixed(1) + "%" : "N/A",
        match_type: c.match_type,
        due_date: c.due_date,
        is_direct_link: c.is_direct_link,
        reference_match: c.reference_match,
        fee_implied: c.fee_implied,
        is_customer_match: c.is_customer_match ?? false,
        is_amount_match: c.is_amount_match ?? false,
        name_similarity: c.name_similarity ?? 0,  // NEW: 0-1 score of name similarity
      }))
    }
  })

  const systemPrompt = `You are an AR (Accounts Receivable) reconciliation AI. Match customer payments to invoices.

## YOUR TASK
For each bank INFLOW (customer payment), find the matching INVOICE(s).

## CRITICAL RULE: CUSTOMER NAME MUST MATCH
You MUST NOT match a payment to an invoice if the customer names are clearly different.
- "Leann Brenneke" payment CANNOT match "Lacey Carpovich" invoice (different people!)
- "Kenzie Masters" payment CANNOT match "Allison Keim" invoice (different people!)
- "Jack" payment CANNOT match "Kelsee Gomes" invoice (different people!)

Use the name_similarity score: 
- 0.8+ = Same person (match allowed)
- 0.5-0.8 = Possibly same person (needs review)
- Below 0.5 = Different people (DO NOT MATCH)

## CRITICAL RULE: ONE INVOICE = ONE PAYMENT
Each invoice ID can only be matched to ONE payment. If the same invoice appears as a candidate for multiple payments, you must choose the BEST match and leave others unmatched.

## CANDIDATE FIELDS EXPLAINED
- **id**: Unique invoice ID (use this for matching)
- **entity**: Customer name from invoice
- **amount**: Original invoice amount
- **outstanding**: Remaining unpaid amount on invoice
- **diff**: Bank amount minus invoice amount (negative = received less than invoice)
- **match_type**: EXACT, FEE, PARTIAL, DIRECT_LINK, etc.
- **is_direct_link**: true if invoice ID was found in bank description
- **reference_match**: true if reference number matches
- **fee_implied**: Payment processor fee (Stripe, Square, PayPal deducted this)
- **due_date**: Invoice due date
- **is_customer_match**: true if invoice customer matches bank counterparty (name_similarity >= 0.6)
- **is_amount_match**: true if payment amount is within 5% of invoice
- **name_similarity**: 0-1 score of how similar the names are (1.0 = exact match)

## MATCHING RULES (in priority order)

1. **DIRECT LINK** (is_direct_link=true): Invoice ID found in bank data
   → Confidence 0.99+ if amounts also match

2. **BOTH MATCH** (is_customer_match=true AND is_amount_match=true): Customer + amount both match
   → Highest confidence (0.95+) - this is the gold standard

3. **EXACT MATCH with name_similarity >= 0.8**: Payment = Invoice amount AND same customer
   → High confidence (0.90+)

4. **FEE-ADJUSTED MATCH with name_similarity >= 0.8**: Payment = Invoice - fee AND same customer
   → High confidence (0.85+)

5. **PARTIAL PAYMENT with name_similarity >= 0.8**: Payment < Invoice AND same customer
   → Medium confidence (0.70-0.85), always pending

6. **AGGREGATION with name_similarity >= 0.8**: Multiple invoices, same customer
   → Medium confidence (0.70-0.85), always pending

## CONFIDENCE SCORING (STRICT RULES)
- 0.95-1.00: ONLY for direct link OR (exact amount + name_similarity >= 0.9)
- 0.85-0.94: ONLY for (amount within 5% + name_similarity >= 0.8)
- 0.70-0.84: For matches with name_similarity 0.6-0.8
- 0.50-0.69: For uncertain matches (needs_review)
- Below 0.50: DO NOT MATCH - return "no_match"

## CRITICAL: CONFIDENCE CAPS
- If name_similarity < 0.5: MAX confidence = 0.40 (return "no_match")
- If name_similarity 0.5-0.6: MAX confidence = 0.60 (return "needs_review")
- If name_similarity 0.6-0.8: MAX confidence = 0.80 (return "pending")
- If name_similarity >= 0.8: Can use full confidence range

## OUTPUT FORMAT
Return JSON with decisions array. Each decision:
{
  "movement_id": "exact ID from input",
  "decision": "match" | "no_match" | "needs_review",
  "matched_candidate_id": "invoice ID or null",
  "matched_candidate_ids": ["id1", "id2"], // for aggregation only
  "match_type": "EXACT" | "FEE" | "PARTIAL" | "AGGREGATION",
  "confidence": 0.0-1.0,
  "reasoning": "Brief: name_similarity=X.XX, [reason]"
}

${entityContext ? `\n## KNOWN CUSTOMERS (from memory)\n${entityContext}` : ""}`

  const userPrompt = `Match these ${movements.length} bank movements to invoices.
Respond with JSON in the format specified above.

${JSON.stringify(movementData, null, 2)}`

  try {
    const response = await callLLM(systemPrompt, userPrompt)
    return parseMatchResponse(response, movements)
  } catch (error) {
    console.error("[AI Matcher] LLM call failed:", error)
    return movements.map(m => ({
      movement_id: m.id,
      decision: "needs_review" as const,
      matched_candidate_id: null,
      matched_candidate_ids: [],
      confidence: 0,
      reasoning: "AI processing failed",
      suggested_action: "review",
      entity_context: null
    }))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Classify Zero-Candidate Movements - IMPROVED PROMPTS
// ─────────────────────────────────────────────────────────────────────────────

async function classifyZeroCandidateMovements(
  userId: string,
  movements: MovementToMatch[],
  includeSupermemory: boolean
): Promise<MatchDecision[]> {
  // AR ONLY - these are inflows with no matching invoice
  // Filter to only inflows (should already be filtered, but double-check)
  const arMovements = movements.filter(m => m.direction === "inflow")
  
  if (arMovements.length === 0) {
    return []
  }
  
  let entityContext = ""
  if (includeSupermemory) {
    const counterparties = [...new Set(arMovements.map(m => m.counterparty).filter(Boolean))]
    if (counterparties.length > 0) {
      entityContext = await searchEntityContextFromSupermemory(userId, counterparties.slice(0, 10).join(", "))
    }
  }

  const movementData = arMovements.map((m, idx) => ({
    idx: idx + 1,
    id: m.id,
    counterparty: m.counterparty || "Unknown",
    description: m.raw_description || "",
    amount: Math.abs(m.amount),
    date: m.date,
    current_case: m.classification.case_type
  }))

  const systemPrompt = `You are an AR (Accounts Receivable) specialist. These customer PAYMENTS have NO matching INVOICE.

## YOUR TASK
Determine WHY there's no invoice and what action to take.

## CLASSIFICATION RULES

### LIKELY NEEDS INVOICE CREATED (decision: "create_invoice")
- Clear customer name in bank description
- Amount suggests a real sale (not a refund or adjustment)
- Example: "Sarah Katz (Marlins)" paid $1,060 → Create invoice for Sarah Katz

### LIKELY A PREPAYMENT/DEPOSIT (decision: "needs_review")
- Large round amounts ($5,000, $10,000)
- Description mentions "deposit", "prepay", "advance"
- New customer not seen before

### LIKELY A REFUND RECEIVED (decision: "no_match")
- Small amounts under $50
- Description mentions "refund", "credit", "return"
- Negative context in description

### DATA ISSUE (decision: "needs_review")
- "(deleted)" in counterparty name
- Very generic description
- Can't identify the customer

## CONFIDENCE SCORING
- 0.8+: Clear customer name, reasonable amount, likely needs invoice
- 0.6-0.8: Probable customer, some uncertainty
- Below 0.6: Unclear, needs manual review

## OUTPUT FORMAT
{
  "decisions": [
    {
      "movement_id": "exact ID",
      "decision": "create_invoice" | "no_match" | "needs_review",
      "confidence": 0.0-1.0,
      "reasoning": "Brief explanation",
      "suggested_action": "Create invoice for [Customer Name]" | "Review - possible prepayment" | "Review - unclear customer"
    }
  ]
}

${entityContext ? `\n## KNOWN CUSTOMERS (from memory)\n${entityContext}` : ""}`

  const userPrompt = `Classify these ${arMovements.length} customer payments with no matching invoice.
Respond with JSON in the format specified above.

${JSON.stringify(movementData, null, 2)}`

  try {
    const response = await callLLM(systemPrompt, userPrompt)
    return parseZeroResponse(response, arMovements)
  } catch (error) {
    console.error("[AI Matcher] LLM call failed:", error)
    return movements.map(m => ({
      movement_id: m.id,
      decision: "needs_review" as const,
      matched_candidate_id: null,
      matched_candidate_ids: [],
      confidence: 0,
      reasoning: "AI processing failed",
      suggested_action: "review",
      entity_context: null
    }))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!API_KEY) {
    throw new Error("OPENAI_API_KEY not configured")
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.1,
      max_completion_tokens: 4000,
      response_format: { type: "json_object" }
    })
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`LLM API error: ${response.status} - ${error}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || "{}"
}

function parseMatchResponse(response: string, movements: MovementToMatch[]): MatchDecision[] {
  try {
    const parsed = JSON.parse(response)
    const decisions = parsed.decisions || []
    
    return movements.map(m => {
      const decision = decisions.find((d: { movement_id: string }) => d.movement_id === m.id)
      
      if (!decision) {
        return {
          movement_id: m.id,
          decision: "needs_review" as const,
          matched_candidate_id: null,
          matched_candidate_ids: [],
          match_type: "EXACT",
          status: "pending" as const,
          confidence: 0,
          reasoning: "No AI decision returned",
          suggested_action: "review",
          entity_context: null
        }
      }

      // Extract status from AI response, with fallback based on confidence
      const aiStatus = decision.status === "confirmed" || decision.status === "pending" 
        ? decision.status 
        : (decision.confidence >= 0.85 ? "confirmed" : "pending")

      return {
        movement_id: m.id,
        decision: decision.decision || "needs_review",
        matched_candidate_id: decision.matched_candidate_id || null,
        matched_candidate_ids: decision.matched_candidate_ids || [],
        match_type: decision.match_type || "EXACT",
        status: aiStatus as "confirmed" | "pending",
        confidence: decision.confidence || 0,
        reasoning: decision.reasoning || "",
        suggested_action: decision.decision === "match" ? "apply_match" : "review",
        entity_context: null
      }
    })
  } catch (error) {
    console.error("[AI Matcher] Failed to parse response:", error)
    return movements.map(m => ({
      movement_id: m.id,
      decision: "needs_review" as const,
      matched_candidate_id: null,
      matched_candidate_ids: [],
      match_type: "EXACT",
      status: "pending" as const,
      confidence: 0,
      reasoning: "Failed to parse AI response",
      suggested_action: "review",
      entity_context: null
    }))
  }
}

function parseZeroResponse(response: string, movements: MovementToMatch[]): MatchDecision[] {
  try {
    const parsed = JSON.parse(response)
    const decisions = parsed.decisions || []
    
    return movements.map(m => {
      const decision = decisions.find((d: { movement_id: string }) => d.movement_id === m.id)
      
      if (!decision) {
        return {
          movement_id: m.id,
          decision: "needs_review" as const,
          matched_candidate_id: null,
          matched_candidate_ids: [],
          match_type: "EXACT",
          confidence: 0,
          reasoning: "No AI decision returned",
          suggested_action: "review",
          entity_context: null
        }
      }

      return {
        movement_id: m.id,
        decision: decision.decision || "needs_review",
        matched_candidate_id: null,
        matched_candidate_ids: [],
        match_type: decision.match_type || "EXACT",
        confidence: decision.confidence || 0,
        reasoning: decision.reasoning || "",
        suggested_action: decision.suggested_action || "review",
        entity_context: null
      }
    })
  } catch (error) {
    console.error("[AI Matcher] Failed to parse response:", error)
    return movements.map(m => ({
      movement_id: m.id,
      decision: "needs_review" as const,
      matched_candidate_id: null,
      matched_candidate_ids: [],
      match_type: "EXACT",
      confidence: 0,
      reasoning: "Failed to parse AI response",
      suggested_action: "review",
      entity_context: null
    }))
  }
}
