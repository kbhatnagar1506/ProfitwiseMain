/**
 * Entity Profile AI Narratives
 * Generates LLM-powered summaries, forecast notes, and risk explanations for entity profiles.
 */

import { query } from "@/lib/db"
import type {
  EntityTransaction,
  BehavioralMetrics,
  EntityArchetype,
  EntityType,
  EntityNarratives,
  RiskAssessment,
  SeasonalityPattern,
} from "@/lib/state/types"

const MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o-mini"
const API_URL = process.env.FORECAST_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.FORECAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY

async function callLLM(
  messages: { role: string; content: string }[],
  maxTokens = 500
): Promise<string | null> {
  if (!API_KEY) return null
  try {
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
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content?.trim() ?? null
  } catch {
    return null
  }
}

function formatCurrency(amount: number): string {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`
  return `$${amount.toFixed(0)}`
}

function formatMonths(months: number[]): string {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return months.map((m) => names[m - 1]).join(", ")
}

interface EntityProfileData {
  name: string
  entityType: EntityType
  archetype: EntityArchetype
  metrics: BehavioralMetrics
  risk: RiskAssessment
  seasonality: SeasonalityPattern
  lifetimeValue: number
  outstandingAmount: number
  overdueAmount: number
  recentTransactions: EntityTransaction[]
}

/**
 * Generate AI narratives for an entity profile
 */
export async function generateEntityNarratives(
  data: EntityProfileData
): Promise<EntityNarratives> {
  const {
    name,
    entityType,
    archetype,
    metrics,
    risk,
    seasonality,
    lifetimeValue,
    outstandingAmount,
    overdueAmount,
    recentTransactions,
  } = data

  // Build context for LLM
  const transactionSummary = recentTransactions
    .slice(0, 8)
    .map((t) => {
      const dtp = t.days_to_pay !== null ? ` (${t.days_to_pay}d to pay)` : ""
      return `- ${t.transaction_date}: ${formatCurrency(t.amount)}${dtp}`
    })
    .join("\n")

  const systemPrompt = `You are a financial analyst providing concise insights about customer/vendor payment behavior.
Your responses should be:
- Clear and actionable for a business owner
- Data-driven but easy to understand
- 1-2 sentences per section
- No jargon or unnecessary qualifiers

Respond in JSON format with exactly these fields:
{
  "summary": "1-2 sentence behavioral summary",
  "forecast_notes": "What to expect for forecasting",
  "risk_explanation": "Risk assessment explanation"
}`

  const userPrompt = `Analyze this ${entityType}'s payment behavior:

Entity: ${name}
Type: ${entityType}
Archetype: ${archetype}
Lifetime Value: ${formatCurrency(lifetimeValue)}
Outstanding: ${formatCurrency(outstandingAmount)}
Overdue: ${formatCurrency(overdueAmount)}

Payment Metrics:
- Transaction count: ${metrics.transaction_count}
- Avg days to pay: ${metrics.avg_days_to_pay?.toFixed(1) ?? "N/A"}
- On-time rate: ${metrics.on_time_payment_rate ? (metrics.on_time_payment_rate * 100).toFixed(0) + "%" : "N/A"}
- Avg amount: ${formatCurrency(metrics.avg_transaction_amount)}
- Amount trend: ${metrics.amount_trend}
- Interval: ${metrics.avg_interval_days?.toFixed(0) ?? "N/A"} days avg

Risk Assessment:
- Risk score: ${(risk.risk_score * 100).toFixed(0)}%
- Risk factors: ${risk.risk_factors.length > 0 ? risk.risk_factors.join(", ") : "None"}
- Recent trend: ${risk.recent_trend}

Seasonality:
- Peak months: ${seasonality.peak_months.length > 0 ? formatMonths(seasonality.peak_months) : "None detected"}
- Low months: ${seasonality.low_months.length > 0 ? formatMonths(seasonality.low_months) : "None detected"}

Recent Transactions:
${transactionSummary || "No recent transactions"}`

  const response = await callLLM(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    400
  )

  // Parse response or use fallbacks
  if (response) {
    try {
      const parsed = JSON.parse(response) as {
        summary?: string
        forecast_notes?: string
        risk_explanation?: string
      }
      return {
        ai_summary: parsed.summary || generateFallbackSummary(data),
        ai_forecast_notes: parsed.forecast_notes || generateFallbackForecastNotes(data),
        ai_risk_explanation: parsed.risk_explanation || generateFallbackRiskExplanation(data),
      }
    } catch {
      // JSON parse failed, try to extract from text
    }
  }

  // Fallback to rule-based narratives
  return {
    ai_summary: generateFallbackSummary(data),
    ai_forecast_notes: generateFallbackForecastNotes(data),
    ai_risk_explanation: generateFallbackRiskExplanation(data),
  }
}

function generateFallbackSummary(data: EntityProfileData): string {
  const { name, entityType, archetype, metrics, lifetimeValue } = data
  const typeLabel = entityType === "customer" ? "customer" : "vendor"

  const archetypeDescriptions: Record<EntityArchetype, string> = {
    clockwork: "highly consistent",
    slow_reliable: "reliable but slower-paying",
    bursty: "irregular but active",
    volatile: "unpredictable",
    low_data: "new or infrequent",
  }

  const desc = archetypeDescriptions[archetype] || "typical"
  const avgDays = metrics.avg_days_to_pay
    ? `typically pays in ${metrics.avg_days_to_pay.toFixed(0)} days`
    : `${metrics.transaction_count} transactions recorded`

  return `${name} is a ${desc} ${typeLabel} with ${formatCurrency(lifetimeValue)} lifetime value. ${avgDays.charAt(0).toUpperCase() + avgDays.slice(1)}.`
}

function generateFallbackForecastNotes(data: EntityProfileData): string {
  const { archetype, metrics, seasonality } = data

  const notes: string[] = []

  switch (archetype) {
    case "clockwork":
      notes.push("High confidence in timing predictions.")
      break
    case "slow_reliable":
      notes.push("Expect longer payment cycles but eventual collection.")
      break
    case "bursty":
      notes.push("Use wider confidence intervals for timing.")
      break
    case "volatile":
      notes.push("High uncertainty - consider conservative estimates.")
      break
    case "low_data":
      notes.push("Limited history - use cohort averages as prior.")
      break
  }

  if (metrics.amount_trend === "increasing") {
    notes.push("Transaction amounts trending upward.")
  } else if (metrics.amount_trend === "decreasing") {
    notes.push("Transaction amounts declining.")
  }

  if (seasonality.peak_months.length > 0) {
    notes.push(`Peak activity in ${formatMonths(seasonality.peak_months)}.`)
  }

  return notes.join(" ")
}

function generateFallbackRiskExplanation(data: EntityProfileData): string {
  const { risk, metrics } = data

  if (risk.risk_factors.length === 0) {
    if (metrics.on_time_payment_rate && metrics.on_time_payment_rate > 0.9) {
      return "Low risk - consistent payment history with high on-time rate."
    }
    return "No significant risk factors detected."
  }

  const explanations: Record<string, string> = {
    payment_slowing: "Payment times have been increasing recently",
    amount_declining: "Transaction amounts are trending downward",
    low_on_time_rate: "Below-average on-time payment rate",
    high_timing_variance: "Highly variable payment timing",
    frequency_dropping: "Transaction frequency has decreased",
  }

  const riskExplanations = risk.risk_factors
    .map((f) => explanations[f] || f)
    .slice(0, 2)
    .join(". ")

  const level = risk.risk_score > 0.6 ? "Elevated" : risk.risk_score > 0.4 ? "Moderate" : "Low"
  return `${level} risk. ${riskExplanations}.`
}

/**
 * Update AI narratives for an entity profile in the database
 */
export async function updateEntityNarratives(
  userId: string,
  entityId: string,
  narratives: EntityNarratives
): Promise<void> {
  await query(
    `UPDATE entity_payment_profiles
     SET ai_summary = $3,
         ai_forecast_notes = $4,
         ai_risk_explanation = $5,
         ai_updated_at = NOW()
     WHERE user_id = $1::uuid AND entity_id = $2::uuid`,
    [
      userId,
      entityId,
      narratives.ai_summary,
      narratives.ai_forecast_notes,
      narratives.ai_risk_explanation,
    ]
  )
}

/**
 * Generate and store AI narratives for all entity profiles that need updating
 */
export async function refreshEntityNarratives(
  userId: string,
  options?: { forceAll?: boolean; maxEntities?: number }
): Promise<number> {
  const forceAll = options?.forceAll ?? false
  const maxEntities = options?.maxEntities ?? 50

  // Get entities that need narrative updates
  const whereClause = forceAll
    ? ""
    : "AND (ai_updated_at IS NULL OR ai_updated_at < last_updated)"

  const profiles = await query<{
    entity_id: string
    canonical_name: string
    entity_type: string
    archetype: string
    transaction_count: number
    avg_days_to_pay: number | null
    std_days_to_pay: number | null
    on_time_payment_rate: number | null
    early_payment_rate: number | null
    avg_days_early_late: number | null
    avg_payment_amount: number
    std_transaction_amount: number | null
    largest_transaction: number | null
    smallest_transaction: number | null
    amount_trend: string | null
    avg_interval_days: number | null
    interval_cv: number | null
    transactions_per_month: number | null
    peak_months: number[] | null
    low_months: number[] | null
    month_weights: number[] | null
    lifetime_value: number | null
    outstanding_amount: number | null
    overdue_amount: number | null
    risk_score: number | null
    risk_factors: string[] | null
    recent_trend: string | null
  }>(
    `SELECT 
      epp.entity_id,
      e.canonical_name,
      epp.entity_type,
      epp.archetype,
      epp.transaction_count,
      epp.avg_days_to_pay,
      epp.std_days_to_pay,
      epp.on_time_payment_rate,
      epp.early_payment_rate,
      epp.avg_days_early_late,
      epp.avg_payment_amount,
      epp.std_transaction_amount,
      epp.largest_transaction,
      epp.smallest_transaction,
      epp.amount_trend,
      epp.avg_interval_days,
      epp.interval_cv,
      epp.transactions_per_month,
      epp.peak_months,
      epp.low_months,
      epp.month_weights,
      epp.lifetime_value,
      epp.outstanding_amount,
      epp.overdue_amount,
      epp.risk_score,
      epp.risk_factors,
      epp.recent_trend
    FROM entity_payment_profiles epp
    JOIN entities e ON e.id = epp.entity_id
    WHERE epp.user_id = $1::uuid
      AND epp.transaction_count >= 2
      ${whereClause}
    ORDER BY epp.lifetime_value DESC NULLS LAST
    LIMIT $2`,
    [userId, maxEntities]
  )

  let updated = 0

  for (const p of profiles.rows) {
    try {
      const data: EntityProfileData = {
        name: p.canonical_name,
        entityType: (p.entity_type as EntityType) || "customer",
        archetype: (p.archetype as EntityArchetype) || "low_data",
        metrics: {
          transaction_count: p.transaction_count,
          avg_days_to_pay: p.avg_days_to_pay,
          std_days_to_pay: p.std_days_to_pay,
          on_time_payment_rate: p.on_time_payment_rate,
          early_payment_rate: p.early_payment_rate,
          avg_days_early_late: p.avg_days_early_late,
          avg_transaction_amount: p.avg_payment_amount || 0,
          std_transaction_amount: p.std_transaction_amount,
          largest_transaction: p.largest_transaction || 0,
          smallest_transaction: p.smallest_transaction || 0,
          amount_trend: (p.amount_trend as "increasing" | "decreasing" | "stable") || "stable",
          avg_interval_days: p.avg_interval_days,
          interval_cv: p.interval_cv,
          transactions_per_month: p.transactions_per_month || 0,
        },
        risk: {
          risk_score: p.risk_score || 0.2,
          risk_factors: p.risk_factors || [],
          recent_trend: (p.recent_trend as "improving" | "stable" | "deteriorating") || "stable",
        },
        seasonality: {
          peak_months: p.peak_months || [],
          low_months: p.low_months || [],
          month_weights: p.month_weights || new Array(12).fill(1),
        },
        lifetimeValue: p.lifetime_value || 0,
        outstandingAmount: p.outstanding_amount || 0,
        overdueAmount: p.overdue_amount || 0,
        recentTransactions: [], // We'll skip detailed transactions for bulk updates
      }

      const narratives = await generateEntityNarratives(data)
      await updateEntityNarratives(userId, p.entity_id, narratives)
      updated++
    } catch (e) {
      console.warn(`[entity-profile-ai] Failed to generate narratives for ${p.entity_id}:`, e)
    }
  }

  console.log(`[entity-profile-ai] Updated ${updated} entity narratives for user ${userId}`)
  return updated
}
