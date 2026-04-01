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
  
  // CRITICAL: Track matched invoice IDs to prevent double-matching
  // Same customer can have multiple invoices of same amount
  // Once an invoice is matched, remove it from all other candidates
  const matchedInvoiceIds = new Set<string>()

  const movementsToProcess = movements
    .filter(m => shouldProcessWithAI(m))
    .slice(0, maxMovements)

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

  // Process batches SEQUENTIALLY to maintain invoice deduplication
  // Each batch's matches are removed from subsequent batches' candidates
  // (No parallel processing - we need to track matched invoices across batches)
  for (let i = 0; i < movementsToProcess.length; i += batchSize) {
    const batch = movementsToProcess.slice(i, i + batchSize)
    
    // Filter out already-matched invoices from this batch's candidates
    const filteredBatch = filterMatchedInvoices(batch, matchedInvoiceIds)
    
    console.log(`[AI Matcher] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(movementsToProcess.length / batchSize)} | ${filteredBatch.length} movements | ${matchedInvoiceIds.size} invoices already matched`)
    
    try {
      const batchResults = await processBatch(userId, filteredBatch, includeSupermemory)
      
      // Track newly matched invoice IDs
      for (const decision of batchResults) {
        if (decision.decision === "match") {
          if (decision.matched_candidate_id) {
            matchedInvoiceIds.add(decision.matched_candidate_id)
          }
          for (const id of decision.matched_candidate_ids) {
            matchedInvoiceIds.add(id)
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

  console.log(`[AI Matcher] Completed. Total matched invoices: ${matchedInvoiceIds.size}`)

  return {
    total_processed: movementsToProcess.length,
    matches: results,
    errors,
    processing_time_ms: Date.now() - startTime
  }
}

// Filter out already-matched invoices from candidates
function filterMatchedInvoices(
  movements: MovementToMatch[],
  matchedInvoiceIds: Set<string>
): MovementToMatch[] {
  if (matchedInvoiceIds.size === 0) return movements
  
  return movements.map(m => {
    const originalCount = m.classification.candidates.length
    const filteredCandidates = m.classification.candidates.filter(
      c => !matchedInvoiceIds.has(c.id)
    )
    
    // If candidates changed, create a new movement object with filtered candidates
    if (filteredCandidates.length !== originalCount) {
      console.log(`[AI Matcher] Movement ${m.id}: Removed ${originalCount - filteredCandidates.length} already-matched invoices`)
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
        fee_implied: c.fee_implied
      }))
    }
  })

  const systemPrompt = `You are an AR (Accounts Receivable) reconciliation AI. Match customer payments to invoices.

## YOUR TASK
For each bank INFLOW (customer payment), find the matching INVOICE(s).

## CRITICAL RULE: ONE INVOICE = ONE PAYMENT
Each invoice ID can only be matched to ONE payment. If the same invoice appears as a candidate for multiple payments, you must choose the BEST match and leave others unmatched.

Example: Customer "John Smith" has two $500 invoices (INV-001, INV-002)
- Payment 1: $500 from "John Smith" → Match to INV-001
- Payment 2: $500 from "John Smith" → Match to INV-002 (NOT INV-001 again!)
- Payment 3: $500 from "John Smith" → No match (both invoices already used)

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

## MATCHING RULES (in priority order)

1. **DIRECT LINK** (is_direct_link=true): Invoice ID found in bank data
   → Confidence 0.99+ if amounts also match

2. **EXACT MATCH**: Payment = Invoice amount (diff ≈ 0)
   → High confidence if customer names are similar

3. **FEE-ADJUSTED MATCH**: Payment = Invoice - processor fee (2-5%)
   → Common: Stripe/Square/PayPal deduct fees before deposit
   → Example: Invoice $100, Bank $97, fee_implied=$3 = MATCH

4. **CUSTOMER NAME MATCHING**:
   - "MichaelHouk" = "Michael Houk" = "M. Houk" (same person)
   - "Kelsee Gomes (NY Yankees)" matches invoice for "Kelsee Gomes"
   - Ignore parenthetical info like team names - focus on the PERSON NAME
   - Company variations: "ABC Corp" = "ABC Corporation" = "ABC Inc"

5. **PARTIAL PAYMENT**: Payment < Invoice amount
   → Only match if customer names match clearly

6. **AGGREGATION**: Single payment covers multiple invoices
   → Return multiple invoice IDs in matched_candidate_ids

## CONFIDENCE SCORING
- 0.95-1.00: Direct link OR exact amount + exact customer name
- 0.85-0.94: Exact amount + similar customer name
- 0.70-0.84: Fee-adjusted match with good name match
- 0.50-0.69: Partial payment or uncertain customer
- Below 0.50: Weak match, needs review

## OUTPUT FORMAT
Return JSON with decisions array. Each decision:
{
  "movement_id": "exact ID from input",
  "decision": "match" | "no_match" | "needs_review",
  "matched_candidate_id": "invoice ID or null",
  "matched_candidate_ids": ["id1", "id2"] // for aggregation only
  "confidence": 0.0-1.0,
  "reasoning": "Brief: [customer match] + [amount match]"
}

${entityContext ? `\n## KNOWN CUSTOMERS (from memory)\n${entityContext}` : ""}`

  const userPrompt = `Match these ${movements.length} bank movements:

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

  const userPrompt = `Classify these ${arMovements.length} customer payments with no matching invoice:

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
          confidence: 0,
          reasoning: "No AI decision returned",
          suggested_action: "review",
          entity_context: null
        }
      }

      return {
        movement_id: m.id,
        decision: decision.decision || "needs_review",
        matched_candidate_id: decision.matched_candidate_id || null,
        matched_candidate_ids: decision.matched_candidate_ids || [],
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
      confidence: 0,
      reasoning: "Failed to parse AI response",
      suggested_action: "review",
      entity_context: null
    }))
  }
}
