/**
 * Decision Layer LLM Integration — AI-powered intervention reasoning, strategy reranking,
 * execution planning, and anomaly detection.
 *
 * Extends forecast-llm.ts with decision-specific AI capabilities:
 * - Enriches interventions with founder-friendly reasoning
 * - Reranks strategies by feasibility and founder fit
 * - Generates step-by-step execution plans with email drafts
 * - Detects anomalies and contradictions in recommendations
 */

import type {
  Intervention,
  CombinedStrategy,
  BehavioralModels,
  ForecastContext,
} from "./state/types"

const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"
const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY

async function callLLM(messages: { role: string; content: string }[], maxTokens = 800): Promise<string | null> {
  if (!API_KEY) return null
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 3000) // 3 second timeout
    
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content?.trim()
    return content ?? null
  } catch (err) {
    return null
  }
}

// ─── Types ──────────────────────────────────────────────────────────────

export type EnrichedIntervention = Intervention & {
  ai_reasoning: string
  feasibility_score: number
  relationship_risk_explanation: string
  hidden_assumptions: string[]
  failure_modes: string[]
}

export type RankedStrategy = CombinedStrategy & {
  feasibility_score: number
  feasibility_reason: string
  execution_difficulty: "easy" | "medium" | "hard"
  urgency_level: "low" | "medium" | "high"
  recommendation_priority: number
  ai_summary: string
}

export type ExecutionStep = {
  step_number: number
  action: string
  details: string
  owner: string
  deadline?: string
}

export type ExecutionPlan = {
  action_id: string
  action_label: string
  steps: ExecutionStep[]
  email_draft?: string
  trigger_condition?: string
  success_metric?: string
  contingency_plan?: string
  estimated_time_minutes?: number
}

export type InterventionAnomaly = {
  intervention_id: string
  anomaly_type: "unusual" | "contradiction" | "missing_context" | "low_confidence"
  severity: "info" | "warning" | "critical"
  message: string
  suggested_action?: string
}

// ─── Phase 1: AI Reasoning Engine ────────────────────────────────────────

export async function enrichInterventionsWithReasoning(
  interventions: Intervention[],
  models: BehavioralModels,
  context: ForecastContext | null,
): Promise<EnrichedIntervention[]> {
  if (!process.env.FORECAST_LLM_ENABLED || !API_KEY || interventions.length === 0) {
    return interventions.map((i) => ({
      ...i,
      ai_reasoning: i.description,
      feasibility_score: 0.7,
      relationship_risk_explanation: "Unknown",
      hidden_assumptions: i.assumptions ?? [],
      failure_modes: [],
    }))
  }

  const top = interventions.slice(0, 5)
  const interventionList = top
    .map((i, idx) => {
      const entity = models.customers.find((c) => c.entity_id === i.entity) ||
        models.vendors.find((v) => v.entity_id === i.entity)
      const entityInfo = entity
        ? `${entity.name} (${entity.payment_count} payments, ${entity.confidence} confidence)`
        : i.entity ?? "N/A"
      return `${idx + 1}. id="${i.id}" ${i.label} (${i.type}, entity: ${entityInfo}, impact: $${Math.round(i.impact_cash_14d).toLocaleString()}/14d)`
    })
    .join("\n")

  const systemPrompt = `You are a CFO advisor. For each cashflow action, provide founder-friendly reasoning explaining:
- Why this action matters
- Tradeoffs (cash freed vs relationship risk)
- Context-specific risks
- Hidden assumptions
- Failure modes

Output a JSON array with one object per action. Each object:
{
  "action_id": "exact id from input",
  "ai_reasoning": "2-3 sentence explanation of tradeoffs",
  "feasibility_score": 0.0-1.0,
  "relationship_risk_explanation": "brief explanation of relationship impact",
  "hidden_assumptions": ["assumption 1", "assumption 2"],
  "failure_modes": ["failure 1", "failure 2"]
}`

  const content = await callLLM(
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Actions:\n${interventionList}\n\nContext: ${context?.risk_level ?? "unknown"} risk, top customer ${Math.round(context?.top_customer_pct ?? 0)}%\n\nProvide reasoning for each action as JSON array.`,
      },
    ],
    1200,
  )

  const enriched: EnrichedIntervention[] = []
  if (content) {
    try {
      const jsonStr = content.replace(/```json?\s*/gi, "").replace(/```/g, "").trim()
      const parsed = JSON.parse(jsonStr) as Array<{
        action_id?: string
        ai_reasoning?: string
        feasibility_score?: number
        relationship_risk_explanation?: string
        hidden_assumptions?: string[]
        failure_modes?: string[]
      }>
      if (Array.isArray(parsed)) {
        for (let idx = 0; idx < parsed.length && idx < top.length; idx++) {
          const item = parsed[idx]
          const iv = top[idx]
          if (iv && item) {
            enriched.push({
              ...iv,
              ai_reasoning: item.ai_reasoning ?? iv.description,
              feasibility_score: Math.max(0, Math.min(1, item.feasibility_score ?? 0.7)),
              relationship_risk_explanation: item.relationship_risk_explanation ?? "Unknown",
              hidden_assumptions: item.hidden_assumptions ?? iv.assumptions ?? [],
              failure_modes: item.failure_modes ?? [],
            })
          }
        }
      }
    } catch {
      /* fallback to defaults */
    }
  }

  // Fallback for any missing interventions
  for (const iv of top) {
    if (!enriched.find((e) => e.id === iv.id)) {
      enriched.push({
        ...iv,
        ai_reasoning: iv.description,
        feasibility_score: 0.7,
        relationship_risk_explanation: "Unknown",
        hidden_assumptions: iv.assumptions ?? [],
        failure_modes: [],
      })
    }
  }

  // Add remaining interventions without enrichment
  for (const iv of interventions.slice(5)) {
    enriched.push({
      ...iv,
      ai_reasoning: iv.description,
      feasibility_score: 0.7,
      relationship_risk_explanation: "Unknown",
      hidden_assumptions: iv.assumptions ?? [],
      failure_modes: [],
    })
  }

  return enriched
}

// ─── Phase 2: AI Rerank Engine ──────────────────────────────────────────

export async function rerankStrategiesWithAI(
  strategies: CombinedStrategy[],
  interventions: Intervention[],
  models: BehavioralModels,
  context: ForecastContext | null,
  founderProfile?: any,
): Promise<RankedStrategy[]> {
  if (!process.env.FORECAST_LLM_ENABLED || !API_KEY || strategies.length === 0) {
    return strategies.map((s, idx) => ({
      ...s,
      feasibility_score: 0.7,
      feasibility_reason: "Unknown",
      execution_difficulty: "medium",
      urgency_level: "medium",
      recommendation_priority: idx + 1,
      ai_summary: s.summary,
    }))
  }

  const strategyList = strategies
    .map((s, idx) => {
      const actionLabels = s.actions.map((a) => a.label).join(" + ")
      return `${idx + 1}. id="${s.id}" ${actionLabels} (low: $${Math.round(s.low_point).toLocaleString()}, stress: ${(s.stress_prob * 100).toFixed(0)}%)`
    })
    .join("\n")

  const systemPrompt = `You are a CFO advisor. Rank these combined strategies by feasibility and founder fit.

Consider:
- Can the founder execute all actions simultaneously?
- Will this damage key relationships?
- How urgent is this strategy?
- Does it match typical founder execution patterns?

Output a JSON array with one object per strategy, ranked by priority. Each object:
{
  "strategy_id": "exact id from input",
  "feasibility_score": 0.0-1.0,
  "feasibility_reason": "brief explanation",
  "execution_difficulty": "easy"|"medium"|"hard",
  "urgency_level": "low"|"medium"|"high",
  "recommendation_priority": 1-N,
  "ai_summary": "1-2 sentence founder-friendly explanation"
}`

  const content = await callLLM(
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Strategies:\n${strategyList}\n\nContext: ${context?.risk_level ?? "unknown"} risk, ${Math.round(context?.recurring_spend_ratio ?? 0)}% fixed spend\n\nRank by feasibility and founder fit as JSON array.`,
      },
    ],
    1200,
  )

  const ranked: RankedStrategy[] = []
  if (content) {
    try {
      const jsonStr = content.replace(/```json?\s*/gi, "").replace(/```/g, "").trim()
      const parsed = JSON.parse(jsonStr) as Array<{
        strategy_id?: string
        feasibility_score?: number
        feasibility_reason?: string
        execution_difficulty?: string
        urgency_level?: string
        recommendation_priority?: number
        ai_summary?: string
      }>
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const strategy = strategies.find((s) => s.id === item.strategy_id)
          if (strategy && item.recommendation_priority) {
            ranked.push({
              ...strategy,
              feasibility_score: Math.max(0, Math.min(1, item.feasibility_score ?? 0.7)),
              feasibility_reason: item.feasibility_reason ?? "Unknown",
              execution_difficulty: (item.execution_difficulty as "easy" | "medium" | "hard") ?? "medium",
              urgency_level: (item.urgency_level as "low" | "medium" | "high") ?? "medium",
              recommendation_priority: item.recommendation_priority,
              ai_summary: item.ai_summary ?? strategy.summary,
            })
          }
        }
      }
    } catch {
      /* fallback to defaults */
    }
  }

  // Fallback: return strategies with default ranking
  if (ranked.length === 0) {
    return strategies.map((s, idx) => ({
      ...s,
      feasibility_score: 0.7,
      feasibility_reason: "Unknown",
      execution_difficulty: "medium",
      urgency_level: "medium",
      recommendation_priority: idx + 1,
      ai_summary: s.summary,
    }))
  }

  return ranked
}

// ─── Phase 3: AI Execution Engine ───────────────────────────────────────

export async function generateExecutionPlans(
  interventions: EnrichedIntervention[],
  strategies: RankedStrategy[],
  models: BehavioralModels,
  context: ForecastContext | null,
): Promise<ExecutionPlan[]> {
  if (!process.env.FORECAST_LLM_ENABLED || !API_KEY || interventions.length === 0) {
    return interventions.slice(0, 3).map((i) => ({
      action_id: i.id,
      action_label: i.label,
      steps: [
        {
          step_number: 1,
          action: i.label,
          details: i.description,
          owner: "You",
        },
      ],
      trigger_condition: "When cash drops below threshold",
      success_metric: `${i.type} completed`,
      estimated_time_minutes: 15,
    }))
  }

  const topInterventions = interventions.slice(0, 3)
  const interventionList = topInterventions
    .map((i, idx) => {
      return `${idx + 1}. id="${i.id}" ${i.label} (${i.type}, impact: $${Math.round(i.impact_cash_14d).toLocaleString()}/14d, feasibility: ${(i.feasibility_score * 100).toFixed(0)}%)`
    })
    .join("\n")

  const systemPrompt = `You are a CFO operations advisor. For each action, generate a detailed execution plan.

For each action, provide:
- Step-by-step execution steps (2-4 steps)
- Email draft (if applicable)
- Trigger condition (when to execute)
- Success metric (how to measure success)
- Contingency plan (what if it fails)
- Estimated time in minutes

Output a JSON array with one object per action:
{
  "action_id": "exact id from input",
  "steps": [
    {"step_number": 1, "action": "...", "details": "...", "owner": "You"|"Finance team", "deadline": "optional"}
  ],
  "email_draft": "optional email text",
  "trigger_condition": "when to execute",
  "success_metric": "how to measure success",
  "contingency_plan": "what if it fails",
  "estimated_time_minutes": 15
}`

  const content = await callLLM(
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Actions:\n${interventionList}\n\nContext: ${context?.risk_level ?? "unknown"} risk, cash urgency high\n\nGenerate execution plans as JSON array.`,
      },
    ],
    2000,
  )

  const plans: ExecutionPlan[] = []
  if (content) {
    try {
      const jsonStr = content.replace(/```json?\s*/gi, "").replace(/```/g, "").trim()
      const parsed = JSON.parse(jsonStr) as Array<{
        action_id?: string
        steps?: Array<{
          step_number?: number
          action?: string
          details?: string
          owner?: string
          deadline?: string
        }>
        email_draft?: string
        trigger_condition?: string
        success_metric?: string
        contingency_plan?: string
        estimated_time_minutes?: number
      }>
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const intervention = topInterventions.find((i) => i.id === item.action_id)
          if (intervention && item.steps && item.steps.length > 0) {
            plans.push({
              action_id: item.action_id ?? intervention.id,
              action_label: intervention.label,
              steps: item.steps.map((s) => ({
                step_number: s.step_number ?? 1,
                action: s.action ?? "Execute action",
                details: s.details ?? "",
                owner: s.owner ?? "You",
                deadline: s.deadline,
              })),
              email_draft: item.email_draft,
              trigger_condition: item.trigger_condition,
              success_metric: item.success_metric,
              contingency_plan: item.contingency_plan,
              estimated_time_minutes: item.estimated_time_minutes,
            })
          }
        }
      }
    } catch {
      /* fallback to defaults */
    }
  }

  // Fallback: generate basic plans
  if (plans.length === 0) {
    return topInterventions.map((i) => ({
      action_id: i.id,
      action_label: i.label,
      steps: [
        {
          step_number: 1,
          action: i.label,
          details: i.description,
          owner: "You",
        },
      ],
      trigger_condition: "When cash drops below threshold",
      success_metric: `${i.type} completed`,
      estimated_time_minutes: 15,
    }))
  }

  return plans
}

// ─── Phase 4: Anomaly Detection ─────────────────────────────────────────

export async function detectInterventionAnomalies(
  interventions: EnrichedIntervention[],
  strategies: RankedStrategy[],
  models: BehavioralModels,
): Promise<InterventionAnomaly[]> {
  if (!process.env.FORECAST_LLM_ENABLED || !API_KEY || interventions.length === 0) {
    return []
  }

  const interventionList = interventions
    .slice(0, 5)
    .map((i, idx) => `${idx + 1}. ${i.label} (${i.type}, feasibility: ${(i.feasibility_score * 100).toFixed(0)}%)`)
    .join("\n")

  const systemPrompt = `You are a CFO advisor. Identify anomalies and contradictions in these cashflow recommendations.

Look for:
- Unusual recommendations (e.g., delay payment to vendor you depend on)
- Contradictions (e.g., "accelerate X" + "reduce spend")
- Missing context (e.g., no recent communication history)
- Low confidence recommendations

Output a JSON array of anomalies. Each object:
{
  "intervention_id": "id or label",
  "anomaly_type": "unusual"|"contradiction"|"missing_context"|"low_confidence",
  "severity": "info"|"warning"|"critical",
  "message": "brief explanation",
  "suggested_action": "optional suggestion"
}`

  const content = await callLLM(
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Recommendations:\n${interventionList}\n\nIdentify anomalies as JSON array.`,
      },
    ],
    800,
  )

  const anomalies: InterventionAnomaly[] = []
  if (content) {
    try {
      const jsonStr = content.replace(/```json?\s*/gi, "").replace(/```/g, "").trim()
      const parsed = JSON.parse(jsonStr) as Array<{
        intervention_id?: string
        anomaly_type?: string
        severity?: string
        message?: string
        suggested_action?: string
      }>
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.intervention_id && item.anomaly_type && item.severity && item.message) {
            anomalies.push({
              intervention_id: item.intervention_id,
              anomaly_type: (item.anomaly_type as "unusual" | "contradiction" | "missing_context" | "low_confidence") ?? "info",
              severity: (item.severity as "info" | "warning" | "critical") ?? "info",
              message: item.message,
              suggested_action: item.suggested_action,
            })
          }
        }
      }
    } catch {
      /* ignore parse errors */
    }
  }

  return anomalies
}
