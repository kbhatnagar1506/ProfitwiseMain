/**
 * AR Reconciliation Customer Matcher
 * 
 * Uses LLM to match bank transaction counterparties to known invoice customers.
 * Enables enriched candidate building with customer-specific invoices.
 */

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.OPENAI_API_KEY
const MODEL = "gpt-5.4-nano"

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

  // Batch movements (50 per call to keep tokens reasonable)
  const batchSize = 50
  for (let i = 0; i < movements.length; i += batchSize) {
    const batch = movements.slice(i, i + batchSize)
    
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
    throw new Error(`LLM API error: ${response.status} - ${error}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content || "{}"
  
  try {
    const parsed = JSON.parse(content) as LLMResponse
    return parsed.matches.map(m => ({
      movement_id: m.movement_id,
      counterparty: movements.find(mov => mov.id === m.movement_id)?.counterparty ?? null,
      matched_customer: m.customer,
      confidence: m.confidence
    }))
  } catch (error) {
    console.error("[Customer Matcher] Failed to parse LLM response:", error)
    throw new Error("Failed to parse customer matcher response")
  }
}
