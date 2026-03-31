/**
 * AI Reconciliation Matcher
 * 
 * Uses LLM + Supermemory to intelligently match bank movements to invoices/bills.
 * Processes in background batches for efficiency.
 */

import { searchEntityContextFromSupermemory, searchEntityProfileContext } from "./supermemory"
import type { ClassificationResult, CaseType, Candidate } from "./reconciliation-case-classifier"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.OPENAI_API_KEY

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
  matched_candidate_ids: string[] // For aggregation matches
  confidence: number // 0-1
  reasoning: string
  suggested_action: string
  entity_context: string | null // From Supermemory
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

  // Filter to movements that need AI matching
  const movementsToProcess = movements
    .filter(m => shouldProcessWithAI(m))
    .slice(0, maxMovements)

  // Dynamic batch sizing based on data volume
  // Smaller batches = more parallel requests but less context per request
  // Larger batches = fewer requests but more context (better matching)
  const totalCount = movementsToProcess.length
  let batchSize: number
  let parallelBatches: number

  if (totalCount <= 10) {
    // Very small: single batch, no parallelism needed
    batchSize = totalCount || 1
    parallelBatches = 1
  } else if (totalCount <= 50) {
    // Small: 5-10 per batch, 3 parallel
    batchSize = Math.ceil(totalCount / 5)
    parallelBatches = 3
  } else if (totalCount <= 200) {
    // Medium: 10 per batch, 5 parallel
    batchSize = 10
    parallelBatches = 5
  } else if (totalCount <= 500) {
    // Large: 15 per batch, 10 parallel
    batchSize = 15
    parallelBatches = 10
  } else if (totalCount <= 1000) {
    // Very large: 20 per batch, 15 parallel
    batchSize = 20
    parallelBatches = 15
  } else {
    // Massive (1000+): 25 per batch, 20 parallel (max throughput)
    batchSize = 25
    parallelBatches = 20
  }

  // Allow overrides from options
  if (options.batchSize) batchSize = options.batchSize
  if (options.parallelBatches) parallelBatches = options.parallelBatches

  console.log(`[AI Matcher] Processing ${totalCount} movements: batchSize=${batchSize}, parallel=${parallelBatches}`)

  // Create all batches
  const batches: MovementToMatch[][] = []
  for (let i = 0; i < movementsToProcess.length; i += batchSize) {
    batches.push(movementsToProcess.slice(i, i + batchSize))
  }

  // Process batches in parallel chunks
  for (let i = 0; i < batches.length; i += parallelBatches) {
    const parallelChunk = batches.slice(i, i + parallelBatches)
    
    console.log(`[AI Matcher] Processing parallel chunk ${Math.floor(i / parallelBatches) + 1}/${Math.ceil(batches.length / parallelBatches)} (${parallelChunk.length} batches)`)
    
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
  
  // Process movements WITH candidates (need to pick the right one)
  if (hasCandidates) {
    return (
      ct.startsWith("EXACT_MULTI") ||
      ct === "DUPLICATE_PAYMENT" ||
      ct === "NO_MATCH_HAS_CANDIDATES" ||
      ct.startsWith("FEE_IMPLIED") ||
      ct.startsWith("PARTIAL") ||
      ct.startsWith("AGGREGATION") ||
      movement.classification.flags.same_amount_conflict
    )
  }
  
  // Process zero-candidate movements (need to understand why)
  return ct.startsWith("ZERO_")
}

async function processBatch(
  userId: string,
  movements: MovementToMatch[],
  includeSupermemory: boolean
): Promise<MatchDecision[]> {
  const results: MatchDecision[] = []

  // Group by case type for more efficient prompting
  const withCandidates = movements.filter(m => m.classification.candidates.length > 0)
  const zeroCandidates = movements.filter(m => m.classification.candidates.length === 0)

  // Process movements with candidates
  if (withCandidates.length > 0) {
    const matchResults = await matchMovementsWithCandidates(userId, withCandidates, includeSupermemory)
    results.push(...matchResults)
  }

  // Process zero-candidate movements
  if (zeroCandidates.length > 0) {
    const zeroResults = await classifyZeroCandidateMovements(userId, zeroCandidates, includeSupermemory)
    results.push(...zeroResults)
  }

  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// Match Movements WITH Candidates
// ─────────────────────────────────────────────────────────────────────────────

async function matchMovementsWithCandidates(
  userId: string,
  movements: MovementToMatch[],
  includeSupermemory: boolean
): Promise<MatchDecision[]> {
  // Build context from Supermemory
  let entityContext = ""
  if (includeSupermemory) {
    const counterparties = movements
      .map(m => m.counterparty)
      .filter(Boolean)
      .join(", ")
    
    if (counterparties) {
      entityContext = await searchEntityContextFromSupermemory(userId, counterparties)
    }
  }

  // Build prompt
  const movementDescriptions = movements.map((m, idx) => {
    const candidates = m.classification.candidates.slice(0, 5) // Top 5 candidates
    const candidateList = candidates.map((c, cidx) => 
      `    ${cidx + 1}. ID: ${c.id} | Entity: ${c.entity_name} | Amount: $${c.amount.toFixed(2)} | Match Type: ${c.match_type} | Diff: $${c.amount_diff.toFixed(2)}`
    ).join("\n")

    return `
Movement ${idx + 1}:
  ID: ${m.id}
  Counterparty: ${m.counterparty || "Unknown"}
  Description: ${m.raw_description || "N/A"}
  Amount: $${Math.abs(m.amount).toFixed(2)}
  Direction: ${m.direction === "inflow" ? "AR (received)" : "AP (paid)"}
  Date: ${m.date}
  Case Type: ${m.classification.case_type}
  Candidates:
${candidateList}
`
  }).join("\n---\n")

  const systemPrompt = `You are a financial reconciliation expert. Your job is to match bank movements to invoices/bills.

For each movement, analyze the candidates and decide:
1. Which candidate(s) to match (if any)
2. Confidence level (0-1)
3. Brief reasoning

Consider:
- Amount matching (exact, with fee deduction, partial payment)
- Entity name similarity (variations, abbreviations, typos)
- Date proximity to due date
- Reference numbers in descriptions
- Multiple invoices for aggregated payments

${entityContext ? `\nEntity Knowledge:\n${entityContext}` : ""}

Respond in JSON format:
{
  "decisions": [
    {
      "movement_id": "...",
      "decision": "match" | "no_match" | "needs_review",
      "matched_candidate_id": "..." or null,
      "matched_candidate_ids": ["..."] for aggregation,
      "confidence": 0.0-1.0,
      "reasoning": "brief explanation"
    }
  ]
}`

  const userPrompt = `Match these bank movements to their candidates:\n${movementDescriptions}`

  try {
    const response = await callLLM(systemPrompt, userPrompt)
    return parseMatchResponse(response, movements)
  } catch (error) {
    console.error("[AI Matcher] LLM call failed:", error)
    // Return default decisions on error
    return movements.map(m => ({
      movement_id: m.id,
      decision: "needs_review" as const,
      matched_candidate_id: null,
      matched_candidate_ids: [],
      confidence: 0,
      reasoning: "AI processing failed - manual review required",
      suggested_action: "review",
      entity_context: null
    }))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Classify Zero-Candidate Movements
// ─────────────────────────────────────────────────────────────────────────────

async function classifyZeroCandidateMovements(
  userId: string,
  movements: MovementToMatch[],
  includeSupermemory: boolean
): Promise<MatchDecision[]> {
  // Get entity context for better classification
  let entityContext = ""
  if (includeSupermemory) {
    const counterparties = movements
      .map(m => m.counterparty)
      .filter(Boolean)
      .join(", ")
    
    if (counterparties) {
      entityContext = await searchEntityContextFromSupermemory(userId, counterparties)
    }
  }

  const movementDescriptions = movements.map((m, idx) => `
Movement ${idx + 1}:
  ID: ${m.id}
  Counterparty: ${m.counterparty || "Unknown"}
  Description: ${m.raw_description || "N/A"}
  Amount: $${Math.abs(m.amount).toFixed(2)}
  Direction: ${m.direction === "inflow" ? "AR (received)" : "AP (paid)"}
  Date: ${m.date}
  Current Classification: ${m.classification.case_type}
`).join("\n---\n")

  const systemPrompt = `You are a financial reconciliation expert. These bank movements have NO matching invoices/bills in the system.

For each movement, determine the most likely reason and recommended action:

Possible reasons:
- MISSING_INVOICE: Customer paid but invoice wasn't created yet
- MISSING_BILL: Vendor paid but bill wasn't entered
- PREPAYMENT: Deposit/advance payment before invoice
- SUBSCRIPTION: Recurring SaaS/service payment (often no bills)
- SMALL_EXPENSE: Petty cash / minor operational expense
- REFUND: Refund or credit from vendor/to customer
- DATA_ISSUE: Invoice/bill likely exists but wasn't synced

${entityContext ? `\nEntity Knowledge:\n${entityContext}` : ""}

Respond in JSON format:
{
  "decisions": [
    {
      "movement_id": "...",
      "decision": "create_invoice" | "create_bill" | "no_match" | "needs_review",
      "confidence": 0.0-1.0,
      "reasoning": "brief explanation",
      "suggested_action": "Create invoice for [entity]" | "Mark as subscription expense" | etc.
    }
  ]
}`

  const userPrompt = `Classify these unmatched movements:\n${movementDescriptions}`

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
      reasoning: "AI processing failed - manual review required",
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
      model: "gpt-5.4-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.1,
      max_completion_tokens: 2000,
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
