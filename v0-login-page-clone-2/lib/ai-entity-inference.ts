/**
 * AI-Powered Entity Inference
 * Uses OpenAI to analyze entity names and descriptions to infer:
 * - Payment patterns (recurring vs episodic)
 * - Entity relationships and clusters
 * - Risk profiles
 * - Archetype classification
 */

import { log } from "./logger"

export type EntityInferenceResult = {
  entity_id: string
  entity_name: string
  inferred_archetype?: string
  inferred_pattern?: "recurring" | "episodic" | "seasonal" | "irregular"
  confidence_boost?: number
  reasoning: string
  related_entities?: string[]
  risk_score?: number
}

export type BatchInferenceResult = {
  entities: EntityInferenceResult[]
  total_processed: number
  total_boosted: number
  avg_confidence_boost: number
}

const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.OPENAI_API_KEY

/**
 * Analyze entity names and descriptions to infer payment patterns
 */
export async function inferEntityPatterns(
  entities: Array<{ id: string; name: string; description?: string; type: "customer" | "vendor" }>
): Promise<EntityInferenceResult[]> {
  if (entities.length === 0) return []
  if (!API_KEY) {
    log("ai_entity_inference.error", { error: "OPENAI_API_KEY not configured" })
    return []
  }

  // Batch entities for efficiency
  const entityDescriptions = entities
    .map((e) => `- ${e.name}${e.description ? ` (${e.description})` : ""}`)
    .join("\n")

  const prompt = `Analyze these ${entities[0].type === "customer" ? "customer" : "vendor"} names and descriptions to infer payment patterns and archetypes.

For each entity, provide:
1. Inferred payment pattern: recurring (predictable, regular), episodic (irregular, one-off), seasonal (cyclical), or irregular
2. Confidence boost (0-0.5): how much to boost confidence based on name/description analysis
3. Reasoning: brief explanation
4. Risk score (0-1): payment reliability risk

Entities:
${entityDescriptions}

Respond in JSON format:
{
  "inferences": [
    {
      "name": "entity name",
      "pattern": "recurring|episodic|seasonal|irregular",
      "confidence_boost": 0.0-0.5,
      "reasoning": "brief explanation",
      "risk_score": 0.0-1.0
    }
  ]
}

Focus on:
- Industry indicators (e.g., "Pickles" → food supplier → recurring)
- Entity type indicators (e.g., "Sports" → episodic)
- Payment reliability signals (e.g., "Inc" → established → lower risk)
- Relationship patterns (e.g., similar names → related entities)`

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
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      log("ai_entity_inference.error", { error, status: response.status })
      return []
    }

    const data = (await response.json()) as any
    const content = data.choices?.[0]?.message?.content

    if (!content) {
      log("ai_entity_inference.error", { error: "No content in response" })
      return []
    }

    // Parse JSON from response - extract first valid JSON object
    let parsed
    try {
      // Try to find and parse JSON object
      const startIdx = content.indexOf("{")
      if (startIdx === -1) {
        log("ai_entity_inference.error", { error: "No JSON object found in response" })
        return []
      }

      // Find matching closing brace
      let braceCount = 0
      let endIdx = -1
      for (let i = startIdx; i < content.length; i++) {
        if (content[i] === "{") braceCount++
        if (content[i] === "}") {
          braceCount--
          if (braceCount === 0) {
            endIdx = i + 1
            break
          }
        }
      }

      if (endIdx === -1) {
        log("ai_entity_inference.error", { error: "Could not find matching closing brace" })
        return []
      }

      parsed = JSON.parse(content.substring(startIdx, endIdx))
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr)
      log("ai_entity_inference.error", { error: `JSON parse failed: ${msg}` })
      return []
    }
    const inferences = parsed.inferences || []

    // Map back to entity IDs
    const results: EntityInferenceResult[] = []
    for (let i = 0; i < entities.length && i < inferences.length; i++) {
      const entity = entities[i]
      const inference = inferences[i]

      results.push({
        entity_id: entity.id,
        entity_name: entity.name,
        inferred_pattern: inference.pattern,
        confidence_boost: inference.confidence_boost,
        reasoning: inference.reasoning,
        risk_score: inference.risk_score,
      })
    }

    log("ai_entity_inference.complete", {
      entities_processed: results.length,
      avg_boost: results.reduce((sum, r) => sum + (r.confidence_boost || 0), 0) / results.length,
    })

    return results
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("ai_entity_inference.error", { error: message })
    return []
  }
}

/**
 * Infer hidden relationships between entities based on name/description analysis
 */
export async function inferEntityRelationships(
  entities: Array<{ id: string; name: string; description?: string }>
): Promise<Array<{ entity_id_1: string; entity_id_2: string; relationship_type: string; confidence: number }>> {
  if (entities.length < 2) return []
  if (!API_KEY) return []

  const entityList = entities.map((e) => `${e.id}: ${e.name}${e.description ? ` (${e.description})` : ""}`).join("\n")

  const prompt = `Analyze these entity names and descriptions to find hidden relationships or connections.

Entities:
${entityList}

Look for:
- Same company with different names (e.g., "ABC Inc" and "ABC Incorporated")
- Parent/subsidiary relationships (e.g., "ABC Corp" and "ABC Logistics")
- Related business units (e.g., "ABC Sales" and "ABC Support")
- Shared ownership or management
- Industry/sector relationships

Respond in JSON format:
{
  "relationships": [
    {
      "entity_id_1": "id1",
      "entity_id_2": "id2",
      "relationship_type": "same_entity|parent_subsidiary|related_business|shared_ownership|industry_peer",
      "confidence": 0.0-1.0,
      "reasoning": "brief explanation"
    }
  ]
}

Only include relationships with confidence > 0.7`

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
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    })

    if (!response.ok) return []

    const data = (await response.json()) as any
    const content = data.choices?.[0]?.message?.content

    if (!content) return []

    let parsed
    try {
      const startIdx = content.indexOf("{")
      if (startIdx === -1) return []

      let braceCount = 0
      let endIdx = -1
      for (let i = startIdx; i < content.length; i++) {
        if (content[i] === "{") braceCount++
        if (content[i] === "}") {
          braceCount--
          if (braceCount === 0) {
            endIdx = i + 1
            break
          }
        }
      }

      if (endIdx === -1) return []

      parsed = JSON.parse(content.substring(startIdx, endIdx))
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr)
      log("ai_entity_relationships.error", { error: `JSON parse failed: ${msg}` })
      return []
    }
    const relationships = parsed.relationships || []

    log("ai_entity_relationships.inferred", {
      relationships_found: relationships.length,
      avg_confidence: relationships.reduce((sum: number, r: any) => sum + r.confidence, 0) / Math.max(1, relationships.length),
    })

    return relationships
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("ai_entity_relationships.error", { error: message })
    return []
  }
}

/**
 * Analyze invoice/bill descriptions to extract payment terms and patterns
 */
export async function inferPaymentTerms(
  descriptions: Array<{ id: string; description: string; amount: number; date: string }>
): Promise<
  Array<{
    id: string
    inferred_terms?: string
    inferred_cadence?: string
    confidence: number
    reasoning: string
  }>
> {
  if (descriptions.length === 0) return []
  if (!API_KEY) return []

  const descList = descriptions.map((d) => `- ${d.description} ($${d.amount}, ${d.date})`).join("\n")

  const prompt = `Analyze these invoice/bill descriptions to infer payment terms and cadence.

Descriptions:
${descList}

For each, infer:
1. Payment terms (e.g., "Net 30", "Due on receipt", "Net 60")
2. Cadence (e.g., "monthly", "quarterly", "one-off", "as-needed")
3. Confidence (0-1)

Respond in JSON format:
{
  "inferences": [
    {
      "description": "original description",
      "inferred_terms": "Net 30",
      "inferred_cadence": "monthly",
      "confidence": 0.8,
      "reasoning": "brief explanation"
    }
  ]
}`

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
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    })

    if (!response.ok) return []

    const data = (await response.json()) as any
    const content = data.choices?.[0]?.message?.content

    if (!content) return []

    let parsed
    try {
      const startIdx = content.indexOf("{")
      if (startIdx === -1) return []

      let braceCount = 0
      let endIdx = -1
      for (let i = startIdx; i < content.length; i++) {
        if (content[i] === "{") braceCount++
        if (content[i] === "}") {
          braceCount--
          if (braceCount === 0) {
            endIdx = i + 1
            break
          }
        }
      }

      if (endIdx === -1) return []

      parsed = JSON.parse(content.substring(startIdx, endIdx))
    } catch (parseErr) {
      return []
    }
    const inferences = parsed.inferences || []

    // Map back to IDs
    const results = []
    for (let i = 0; i < descriptions.length && i < inferences.length; i++) {
      results.push({
        id: descriptions[i].id,
        inferred_terms: inferences[i].inferred_terms,
        inferred_cadence: inferences[i].inferred_cadence,
        confidence: inferences[i].confidence,
        reasoning: inferences[i].reasoning,
      })
    }

    return results
  } catch (err) {
    return []
  }
}
