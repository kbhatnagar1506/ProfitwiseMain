/**
 * AI Reconciliation Matcher
 * 
 * Uses GPT-5.4-mini + Supermemory to intelligently match bank movements to invoices/bills.
 * Optimized prompts for structured financial matching.
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
  decision: "match" | "no_match" | "needs_review" | "create_invoice" | "create_bill"
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

  const movementsToProcess = movements
    .filter(m => shouldProcessWithAI(m))
    .slice(0, maxMovements)

  const totalCount = movementsToProcess.length
  let batchSize: number
  let parallelBatches: number

  if (totalCount <= 10) {
    batchSize = totalCount || 1
    parallelBatches = 1
  } else if (totalCount <= 50) {
    batchSize = Math.ceil(totalCount / 5)
    parallelBatches = 3
  } else if (totalCount <= 200) {
    batchSize = 10
    parallelBatches = 5
  } else if (totalCount <= 500) {
    batchSize = 15
    parallelBatches = 10
  } else if (totalCount <= 1000) {
    batchSize = 20
    parallelBatches = 15
  } else {
    batchSize = 25
    parallelBatches = 20
  }

  if (options.batchSize) batchSize = options.batchSize
  if (options.parallelBatches) parallelBatches = options.parallelBatches

  console.log(`[AI Matcher] Model: ${MODEL} | Processing ${totalCount} movements: batchSize=${batchSize}, parallel=${parallelBatches}`)

  const batches: MovementToMatch[][] = []
  for (let i = 0; i < movementsToProcess.length; i += batchSize) {
    batches.push(movementsToProcess.slice(i, i + batchSize))
  }

  for (let i = 0; i < batches.length; i += parallelBatches) {
    const parallelChunk = batches.slice(i, i + parallelBatches)
    
    console.log(`[AI Matcher] Processing chunk ${Math.floor(i / parallelBatches) + 1}/${Math.ceil(batches.length / parallelBatches)}`)
    
    const batchPromises = parallelChunk.map(async (batch, idx) => {
      try {
        return await processBatch(userId, batch, includeSupermemory)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        errors.push(`Batch ${i + idx + 1} failed: ${errorMsg}`)
        console.error(`[AI Matcher] Batch ${i + idx + 1} error:`, error)
        return []
      }
    })

    const batchResults = await Promise.all(batchPromises)
    for (const batchResult of batchResults) {
      results.push(...batchResult)
    }
  }

  return {
    total_processed: movementsToProcess.length,
    matches: results,
    errors,
    processing_time_ms: Date.now() - startTime
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch Processing
// ─────────────────────────────────────────────────────────────────────────────

function shouldProcessWithAI(movement: MovementToMatch): boolean {
  const ct = movement.classification.case_type
  const hasCandidates = movement.classification.candidates.length > 0
  
  if (!movement.classification.is_operational) {
    return false
  }
  
  if (hasCandidates) {
    return true
  }
  
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
    const candidates = m.classification.candidates.slice(0, 8)
    
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
        diff: c.amount_diff,
        diff_pct: c.amount !== 0 ? ((c.amount_diff / c.amount) * 100).toFixed(1) + "%" : "N/A",
        match_type: c.match_type,
        score: c.score
      }))
    }
  })

  const systemPrompt = `You are a financial reconciliation AI. Match bank transactions to invoices/bills.

## YOUR TASK
For each bank movement, pick the BEST matching candidate (or none).

## MATCHING RULES (in priority order)

1. **EXACT MATCH**: Bank amount = Candidate amount (within $0.01)
   → High confidence match if entity names are similar

2. **FEE-ADJUSTED MATCH**: Bank amount = Candidate amount - fee (2-5%)
   → Common for payment processors (Stripe, Square, PayPal)
   → Example: Invoice $100, Bank $97 (3% fee) = MATCH

3. **ENTITY NAME MATCHING**:
   - "MichaelHouk" = "Michael Houk" = "M. Houk" (same person)
   - "Kelsee Gomes (NY Yankees)" matches invoice for "Kelsee Gomes"
   - Ignore parenthetical info like "(Detroit Tigers)" - focus on the NAME
   - Company variations: "Belle's Gourmet" = "Belles Gourmet Popcorn"

4. **PARTIAL PAYMENT**: Bank < Invoice amount
   → Only match if entity names match AND it's clearly a partial

5. **AGGREGATION**: Bank = Sum of multiple invoices
   → Return multiple candidate IDs

## CONFIDENCE SCORING
- 0.95-1.00: Exact amount + exact/very similar entity name
- 0.85-0.94: Exact amount + somewhat similar entity name
- 0.70-0.84: Fee-adjusted match with good entity match
- 0.50-0.69: Partial match or uncertain entity
- Below 0.50: Weak match, needs review

## OUTPUT FORMAT
Return JSON with decisions array. Each decision:
{
  "movement_id": "exact ID from input",
  "decision": "match" | "no_match" | "needs_review",
  "matched_candidate_id": "candidate ID or null",
  "matched_candidate_ids": ["id1", "id2"] // for aggregation only
  "confidence": 0.0-1.0,
  "reasoning": "Brief: [entity match quality] + [amount match quality]"
}

${entityContext ? `\n## KNOWN ENTITIES (from memory)\n${entityContext}` : ""}`

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
  let entityContext = ""
  if (includeSupermemory) {
    const counterparties = [...new Set(movements.map(m => m.counterparty).filter(Boolean))]
    if (counterparties.length > 0) {
      entityContext = await searchEntityContextFromSupermemory(userId, counterparties.slice(0, 10).join(", "))
    }
  }

  const movementData = movements.map((m, idx) => ({
    idx: idx + 1,
    id: m.id,
    counterparty: m.counterparty || "Unknown",
    description: m.raw_description || "",
    amount: Math.abs(m.amount),
    type: m.direction === "inflow" ? "RECEIVED (AR)" : "PAID (AP)",
    date: m.date,
    current_case: m.classification.case_type
  }))

  const systemPrompt = `You are a financial reconciliation AI. These bank movements have NO matching invoices/bills.

## YOUR TASK
Determine WHY there's no match and what action to take.

## CLASSIFICATION RULES

### FOR MONEY RECEIVED (AR):
- **create_invoice**: Customer paid but invoice missing
  → Confidence 0.7+ if clear customer name
  → Example: "Sarah Katz (Marlins)" paid $1,060 - likely needs invoice created

- **needs_review**: Unclear situation
  → Prepayments, deposits, refunds, unclear counterparty

### FOR MONEY PAID (AP):
- **create_bill**: Vendor paid but bill missing
  → Confidence 0.7+ if clear vendor name
  → Example: "Amazon" charge $23.48 - likely needs bill created

- **no_match**: Known non-billable expenses
  → Subscriptions (Shopify, Zapier, Google Workspace)
  → Bank fees, small operational expenses
  → Confidence 0.8+ for clear subscriptions

## PATTERNS TO RECOGNIZE
- Subscriptions: Shopify, Zapier, DocuSign, Google Workspace, QuickBooks
- Payment processors: Stripe, Square, PayPal (usually fees)
- Small expenses under $50: Often operational, may not need bills
- "(deleted)" in name: Data sync issue, needs review

## OUTPUT FORMAT
{
  "decisions": [
    {
      "movement_id": "exact ID",
      "decision": "create_invoice" | "create_bill" | "no_match" | "needs_review",
      "confidence": 0.0-1.0,
      "reasoning": "Brief explanation",
      "suggested_action": "Create invoice for [Customer]" | "Create bill for [Vendor]" | "Mark as subscription" | "Review manually"
    }
  ]
}

${entityContext ? `\n## KNOWN ENTITIES\n${entityContext}` : ""}`

  const userPrompt = `Classify these ${movements.length} unmatched movements:

${JSON.stringify(movementData, null, 2)}`

  try {
    const response = await callLLM(systemPrompt, userPrompt)
    return parseZeroResponse(response, movements)
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
