/**
 * AR Reconciliation Customer Matcher
 * 
 * Two-phase approach:
 * 1. Deterministic matching (instant) - handles 80%+ of cases
 * 2. LLM fallback (only for ambiguous cases)
 * 
 * Enables enriched candidate building with customer-specific invoices.
 */

import { normalizeForMatch, heuristicAliasMatch } from "./alias-normalize"
import { entityNameSimilarity } from "./levenshtein"

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.OPENAI_API_KEY
const MODEL = "gpt-4o-mini"

interface CustomerMatchResult {
  movement_id: string
  counterparty: string | null
  matched_customer: string | null
  confidence: number
}

interface LLMResponse {
  matches: Array<{
    movement_id: string
    customer: string | null
    confidence: number
  }>
}

/**
 * Deterministic customer matching using normalized names and similarity algorithms.
 * Returns matched customer name or null if no deterministic match found.
 * 
 * Matching levels (in order):
 * 1. Exact normalized match: "JACK" → "Jack"
 * 2. Heuristic alias match: "MichaelHouk" → "Michael Houk"
 * 3. Entity similarity >= 0.85: "Davd Vaughn" → "David Vaughn"
 */
function matchDeterministically(
  counterparty: string | null,
  knownCustomers: string[]
): string | null {
  if (!counterparty) return null
  
  const normalized = normalizeForMatch(counterparty)
  if (!normalized || normalized.length < 2) return null

  // Level 1: Exact normalized match
  for (const customer of knownCustomers) {
    if (normalizeForMatch(customer) === normalized) {
      return customer
    }
  }

  // Level 2: Heuristic alias match (contains, prefix 85%+)
  for (const customer of knownCustomers) {
    if (heuristicAliasMatch(counterparty, customer)) {
      return customer
    }
  }

  // Level 3: Entity similarity >= 0.85
  for (const customer of knownCustomers) {
    if (entityNameSimilarity(counterparty, customer) >= 0.85) {
      return customer
    }
  }

  return null // No deterministic match, needs LLM
}

/**
 * Match bank transaction counterparties to known invoice customers.
 * Uses deterministic matching first, then LLM only for ambiguous cases.
 * 
 * @param movements Array of movements with id, counterparty (resolved), and optional raw data
 * @param knownCustomers List of known customer names from invoices
 * @returns Map of movement_id -> matched_customer (or null if no match)
 */
export async function matchCustomersWithLLM(
  movements: Array<{ id: string; counterparty: string | null; raw_counterparty?: string | null; description?: string | null }>,
  knownCustomers: string[]
): Promise<Map<string, string | null>> {
  if (movements.length === 0 || knownCustomers.length === 0) {
    return new Map(movements.map(m => [m.id, null]))
  }

  const resultMap = new Map<string, string | null>()
  const needsLLM: Array<{ id: string; counterparty: string | null }> = []

  // Phase 1: Deterministic matching (instant)
  for (const m of movements) {
    const match = matchDeterministically(m.counterparty, knownCustomers)
    if (match) {
      resultMap.set(m.id, match)
    } else {
      needsLLM.push(m)
    }
  }

  console.log(`[Customer Matcher] Deterministic: ${resultMap.size} matched, ${needsLLM.length} need LLM`)

  // Phase 2: LLM for ambiguous cases only
  if (needsLLM.length > 0) {
    if (!API_KEY) {
      console.warn("[Customer Matcher] OPENAI_API_KEY not configured, returning null for ambiguous matches")
      for (const m of needsLLM) {
        resultMap.set(m.id, null)
      }
      return resultMap
    }

    // Batch ambiguous movements (10 per call)
    const batchSize = 10
    for (let i = 0; i < needsLLM.length; i += batchSize) {
      const batch = needsLLM.slice(i, i + batchSize)
      console.log(`[Customer Matcher] LLM batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(needsLLM.length / batchSize)} (${batch.length} movements)`)
      
      try {
        const batchResults = await matchBatchWithLLM(batch, knownCustomers)
        for (const result of batchResults) {
          resultMap.set(result.movement_id, result.matched_customer)
        }
      } catch (error) {
        console.error("[Customer Matcher] LLM batch matching failed:", error)
        // On error, return null matches for this batch
        for (const m of batch) {
          resultMap.set(m.id, null)
        }
      }
    }
  }

  return resultMap
}

async function matchBatchWithLLM(
  movements: Array<{ id: string; counterparty: string | null; raw_counterparty?: string | null; description?: string | null }>,
  knownCustomers: string[]
): Promise<CustomerMatchResult[]> {
  const systemPrompt = `You are an AR (Accounts Receivable) specialist. Match bank transaction counterparties to known customers.

## Known Customers
${knownCustomers.join(", ")}

## Your Task
For each bank transaction, find the matching known customer or return null if no match.

## Input Fields
- **counterparty**: Resolved/normalized name (best quality)
- **raw_counterparty**: Original bank data (may have extra info like payment processor codes)
- **description**: Bank transaction description (may contain customer name or invoice references)

## Matching Rules
1. Exact match (case-insensitive): "David Vaughn" = "david vaughn"
2. Partial match: "David Vaughn (Troubadour)" matches "David Vaughn"
3. Name variations: "MichaelHouk" matches "Michael Houk"
4. Fuzzy match: "Kelsee Gomes (NY Yankees)" matches "Kelsee Gomes"
5. Look for names in description: "Payment from John Smith" → "John Smith"
6. Ignore payment processor prefixes: "VENMO*", "SQ *", "ZELLE*", etc.
7. If no clear match, return null

## Output Format
Return JSON with matches array:
{
  "matches": [
    { "movement_id": "id1", "customer": "David Vaughn", "confidence": 0.95 },
    { "movement_id": "id2", "customer": null, "confidence": 0 }
  ]
}

Respond with JSON only.`

  const userPrompt = `Match these ${movements.length} bank transactions to known customers:

${movements.map(m => {
    let line = `- id:${m.id} counterparty:"${m.counterparty || "unknown"}"`
    if (m.raw_counterparty && m.raw_counterparty !== m.counterparty) {
      line += ` raw:"${m.raw_counterparty}"`
    }
    if (m.description) {
      line += ` desc:"${m.description.substring(0, 100)}"`
    }
    return line
  }).join("\n")}

Return JSON in the format specified above.`

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
    console.error("[Customer Matcher] LLM API error:", response.status, error)
    throw new Error(`LLM API error: ${response.status} - ${error}`)
  }

  const data = await response.json()
  console.log("[Customer Matcher] Full API response:", JSON.stringify(data).substring(0, 1000))
  const content = data.choices?.[0]?.message?.content || "{}"
  
  console.log("[Customer Matcher] LLM response:", content.substring(0, 500))
  
  try {
    const parsed = JSON.parse(content)
    
    // Handle various response formats
    const matches = parsed.matches || parsed.results || parsed.data || []
    
    if (!Array.isArray(matches)) {
      console.error("[Customer Matcher] Invalid response format - matches is not an array:", typeof matches)
      // Return null matches for all movements
      return movements.map(m => ({
        movement_id: m.id,
        counterparty: m.counterparty,
        matched_customer: null,
        confidence: 0
      }))
    }
    
    return matches.map((m: { movement_id?: string; id?: string; customer?: string | null; matched_customer?: string | null; confidence?: number }) => ({
      movement_id: m.movement_id || m.id || "",
      counterparty: movements.find(mov => mov.id === (m.movement_id || m.id))?.counterparty ?? null,
      matched_customer: m.customer ?? m.matched_customer ?? null,
      confidence: m.confidence ?? 0
    }))
  } catch (error) {
    console.error("[Customer Matcher] Failed to parse LLM response:", error, "Content:", content.substring(0, 200))
    // Return null matches for all movements instead of throwing
    return movements.map(m => ({
      movement_id: m.id,
      counterparty: m.counterparty,
      matched_customer: null,
      confidence: 0
    }))
  }
}
