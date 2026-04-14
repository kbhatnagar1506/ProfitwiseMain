/**
 * AR Reconciliation Customer Matcher
 * 
 * Uses LLM to match bank transaction counterparties to known invoice customers.
 * Enables enriched candidate building with customer-specific invoices.
 */

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
 * Match bank transaction counterparties to known invoice customers using LLM.
 * 
 * @param movements Array of movements with id and counterparty
 * @param knownCustomers List of known customer names from invoices
 * @returns Map of movement_id -> matched_customer (or null if no match)
 */
export async function matchCustomersWithLLM(
  movements: Array<{ id: string; counterparty: string | null }>,
  knownCustomers: string[]
): Promise<Map<string, string | null>> {
  if (!API_KEY) {
    console.warn("[Customer Matcher] OPENAI_API_KEY not configured, returning empty matches")
    return new Map(movements.map(m => [m.id, null]))
  }

  if (movements.length === 0 || knownCustomers.length === 0) {
    return new Map(movements.map(m => [m.id, null]))
  }

  const resultMap = new Map<string, string | null>()

  // Batch movements (20 per call to avoid response truncation)
  const batchSize = 20
  for (let i = 0; i < movements.length; i += batchSize) {
    const batch = movements.slice(i, i + batchSize)
    console.log(`[Customer Matcher] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(movements.length / batchSize)} (${batch.length} movements)`)
    
    try {
      const batchResults = await matchBatchWithLLM(batch, knownCustomers)
      for (const result of batchResults) {
        resultMap.set(result.movement_id, result.matched_customer)
      }
    } catch (error) {
      console.error("[Customer Matcher] Batch matching failed:", error)
      // On error, return null matches for this batch
      for (const m of batch) {
        resultMap.set(m.id, null)
      }
    }
  }

  return resultMap
}

async function matchBatchWithLLM(
  movements: Array<{ id: string; counterparty: string | null }>,
  knownCustomers: string[]
): Promise<CustomerMatchResult[]> {
  const systemPrompt = `You are an AR (Accounts Receivable) specialist. Match bank transaction counterparties to known customers.

## Known Customers
${knownCustomers.join(", ")}

## Your Task
For each bank transaction counterparty, find the matching known customer or return null if no match.

## Matching Rules
1. Exact match (case-insensitive): "David Vaughn" = "david vaughn"
2. Partial match: "David Vaughn (Troubadour)" matches "David Vaughn"
3. Name variations: "MichaelHouk" matches "Michael Houk"
4. Fuzzy match: "Kelsee Gomes (NY Yankees)" matches "Kelsee Gomes"
5. If no clear match, return null

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

${movements.map(m => `- id:${m.id} counterparty:"${m.counterparty || "unknown"}"`).join("\n")}

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
      max_completion_tokens: 2000,
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
