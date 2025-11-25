/**
 * AI-Powered Reconciliation Pattern Learning
 * Uses Claude to analyze reconciled AR/AP movements to extract:
 * - Actual payment delays
 * - Amount variance patterns
 * - Seasonal/cyclical patterns
 * - Payment reliability
 */

import Anthropic from "@anthropic-ai/sdk"
import { log } from "./logger"

export type PaymentPattern = {
  entity_id: string
  entity_name: string
  avg_days_to_pay: number
  payment_reliability: number // 0-1
  amount_variance: number // 0-1
  seasonality_detected: boolean
  pattern_type: "predictable" | "variable" | "seasonal" | "unreliable"
  confidence_boost: number
  reasoning: string
}

const client = new Anthropic()

/**
 * Analyze reconciled payment history to extract patterns
 */
export async function analyzePaymentPatterns(
  payments: Array<{
    entity_id: string
    entity_name: string
    invoice_date: string
    payment_date: string
    invoice_amount: number
    payment_amount: number
    payment_count: number
  }>
): Promise<PaymentPattern[]> {
  if (payments.length === 0) return []

  // Group by entity
  const byEntity = new Map<string, typeof payments>()
  for (const p of payments) {
    if (!byEntity.has(p.entity_id)) byEntity.set(p.entity_id, [])
    byEntity.get(p.entity_id)!.push(p)
  }

  const results: PaymentPattern[] = []

  for (const [entityId, entityPayments] of byEntity) {
    if (entityPayments.length < 2) continue

    // Calculate metrics
    const daysToPayList = entityPayments.map((p) => {
      const invoiceDate = new Date(p.invoice_date)
      const paymentDate = new Date(p.payment_date)
      return Math.floor((paymentDate.getTime() - invoiceDate.getTime()) / (1000 * 60 * 60 * 24))
    })

    const avgDaysToPay = daysToPayList.reduce((a, b) => a + b, 0) / daysToPayList.length
    const daysVariance = Math.sqrt(daysToPayList.reduce((sum, d) => sum + Math.pow(d - avgDaysToPay, 2), 0) / daysToPayList.length)

    const amountVariance = entityPayments.reduce((sum, p) => sum + Math.abs(p.payment_amount - p.invoice_amount), 0) / entityPayments.length / (entityPayments.reduce((sum, p) => sum + p.invoice_amount, 0) / entityPayments.length)

    // Detect on-time payment rate
    const onTimeCount = daysToPayList.filter((d) => d <= 30).length
    const paymentReliability = onTimeCount / daysToPayList.length

    // Determine pattern type
    let patternType: "predictable" | "variable" | "seasonal" | "unreliable"
    if (paymentReliability > 0.8 && daysVariance < 10) {
      patternType = "predictable"
    } else if (paymentReliability > 0.6 && daysVariance < 20) {
      patternType = "variable"
    } else if (paymentReliability < 0.5) {
      patternType = "unreliable"
    } else {
      patternType = "seasonal"
    }

    // Calculate confidence boost
    let confidenceBoost = 0
    if (patternType === "predictable") confidenceBoost = 0.4
    else if (patternType === "variable") confidenceBoost = 0.25
    else if (patternType === "seasonal") confidenceBoost = 0.15
    else confidenceBoost = 0.05

    results.push({
      entity_id: entityId,
      entity_name: entityPayments[0].entity_name,
      avg_days_to_pay: Math.round(avgDaysToPay),
      payment_reliability: paymentReliability,
      amount_variance: Math.min(1, amountVariance),
      seasonality_detected: patternType === "seasonal",
      pattern_type: patternType,
      confidence_boost: confidenceBoost,
      reasoning: `${entityPayments.length} payments analyzed: ${paymentReliability * 100 | 0}% on-time, avg ${Math.round(avgDaysToPay)}d to pay, ${daysVariance | 0}d variance`,
    })
  }

  log("ai_payment_patterns.analyzed", {
    entities_analyzed: results.length,
    avg_boost: results.reduce((sum, r) => sum + r.confidence_boost, 0) / Math.max(1, results.length),
  })

  return results
}

/**
 * Use LLM to identify anomalies and risks in payment patterns
 */
export async function identifyPaymentRisks(
  patterns: PaymentPattern[]
): Promise<
  Array<{
    entity_id: string
    entity_name: string
    risk_level: "low" | "medium" | "high"
    risk_factors: string[]
    recommendation: string
  }>
> {
  if (patterns.length === 0) return []

  const patternSummary = patterns
    .map(
      (p) =>
        `- ${p.entity_name}: ${p.pattern_type}, ${p.payment_reliability * 100 | 0}% on-time, avg ${p.avg_days_to_pay}d to pay`
    )
    .join("\n")

  const prompt = `Analyze these payment patterns to identify risks and recommend actions.

Patterns:
${patternSummary}

For each entity, provide:
1. Risk level: low, medium, or high
2. Risk factors: list of specific concerns
3. Recommendation: action to take

Respond in JSON format:
{
  "risks": [
    {
      "entity_name": "name",
      "risk_level": "low|medium|high",
      "risk_factors": ["factor1", "factor2"],
      "recommendation": "action to take"
    }
  ]
}`

  try {
    const response = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    })

    const content = response.content[0]
    if (content.type !== "text") return []

    const jsonMatch = content.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0])
    const risks = parsed.risks || []

    // Map back to entity IDs
    const results = []
    for (const risk of risks) {
      const pattern = patterns.find((p) => p.entity_name === risk.entity_name)
      if (pattern) {
        results.push({
          entity_id: pattern.entity_id,
          entity_name: pattern.entity_name,
          risk_level: risk.risk_level,
          risk_factors: risk.risk_factors,
          recommendation: risk.recommendation,
        })
      }
    }

    return results
  } catch (err) {
    return []
  }
}
