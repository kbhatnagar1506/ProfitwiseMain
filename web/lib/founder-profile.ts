/**
 * Founder Profile Inference — Infer founder characteristics from business context
 * and historical patterns to personalize recommendations.
 */

import type { ForecastContext } from "./state/types"

export type FounderProfile = {
  business_model: "saas" | "services" | "ecommerce" | "other"
  risk_tolerance: "conservative" | "moderate" | "aggressive"
  execution_bandwidth: "low" | "medium" | "high"
  communication_style: "formal" | "casual"
  payment_delay_history: number
  collection_aggressiveness: "low" | "medium" | "high"
  inferred_confidence: number
}

/**
 * Infer founder profile from business context and historical patterns.
 * Returns a profile with confidence scores for personalization.
 */
export function inferFounderProfile(
  context: ForecastContext | null,
  historicalActions?: any[],
): FounderProfile {
  const profile: FounderProfile = {
    business_model: "other",
    risk_tolerance: "moderate",
    execution_bandwidth: "medium",
    communication_style: "formal",
    payment_delay_history: 0,
    collection_aggressiveness: "medium",
    inferred_confidence: 0.5,
  }

  if (!context) return profile

  // ─── Business Model Inference ───────────────────────────────────────

  // SaaS indicators: high recurring spend ratio, low volatility, predictable cash
  if ((context.recurring_spend_ratio ?? 0) > 0.7) {
    profile.business_model = "saas"
  }
  // E-commerce indicators: high volatility, seasonal patterns, variable spend
  else if ((context.recurring_spend_ratio ?? 0) < 0.3) {
    profile.business_model = "ecommerce"
  }
  // Services: moderate recurring, variable customer concentration
  else if ((context.top_customer_pct ?? 0) > 40) {
    profile.business_model = "services"
  }

  // ─── Risk Tolerance Inference ───────────────────────────────────────

  // Conservative: high cash buffer, low risk score, prefers stability
  if ((context.risk_score ?? 0) < 0.3 && (context.operating_dependency_ratio ?? 1) > 0.8) {
    profile.risk_tolerance = "conservative"
  }
  // Aggressive: low cash buffer, high risk score, willing to take chances
  else if ((context.risk_score ?? 0) > 0.7 && (context.operating_dependency_ratio ?? 1) < 0.5) {
    profile.risk_tolerance = "aggressive"
  }
  // Moderate: balanced approach
  else {
    profile.risk_tolerance = "moderate"
  }

  // ─── Execution Bandwidth Inference ──────────────────────────────────

  // High bandwidth: many customers/vendors, complex operations
  if ((context.concentration_risk_score ?? 0) < 0.3) {
    profile.execution_bandwidth = "high"
  }
  // Low bandwidth: few customers/vendors, simple operations
  else if ((context.concentration_risk_score ?? 0) > 0.7) {
    profile.execution_bandwidth = "low"
  }
  // Medium: balanced
  else {
    profile.execution_bandwidth = "medium"
  }

  // ─── Collection Aggressiveness Inference ────────────────────────────

  // Aggressive: high repeat revenue, low overdue ratio
  if ((context.repeat_revenue_ratio ?? 0) > 0.7) {
    profile.collection_aggressiveness = "high"
  }
  // Conservative: low repeat revenue, high overdue ratio
  else if ((context.repeat_revenue_ratio ?? 0) < 0.3) {
    profile.collection_aggressiveness = "low"
  }
  // Medium: balanced
  else {
    profile.collection_aggressiveness = "medium"
  }

  // ─── Confidence Scoring ─────────────────────────────────────────────

  // Confidence increases with data richness
  let confidence = 0.5
  if (context.risk_score !== undefined) confidence += 0.1
  if (context.top_customer_pct !== undefined) confidence += 0.1
  if (context.operating_dependency_ratio !== undefined) confidence += 0.1
  if (context.recurring_spend_ratio !== undefined) confidence += 0.1
  if (context.repeat_revenue_ratio !== undefined) confidence += 0.1

  profile.inferred_confidence = Math.min(1, confidence)

  return profile
}

/**
 * Get personalized recommendation language based on founder profile.
 */
export function getPersonalizedLanguage(profile: FounderProfile): {
  urgency_multiplier: number
  risk_tolerance_language: string
  execution_style: string
} {
  const urgency_multiplier =
    profile.risk_tolerance === "aggressive" ? 1.5 : profile.risk_tolerance === "conservative" ? 0.7 : 1.0

  const risk_tolerance_language =
    profile.risk_tolerance === "aggressive"
      ? "This is a high-impact move that could significantly improve your position."
      : profile.risk_tolerance === "conservative"
        ? "This is a measured approach that balances opportunity with stability."
        : "This is a balanced approach that manages both opportunity and risk."

  const execution_style =
    profile.execution_bandwidth === "high"
      ? "You can handle multiple simultaneous actions."
      : profile.execution_bandwidth === "low"
        ? "Focus on one action at a time for maximum impact."
        : "You can handle 2-3 actions in parallel."

  return {
    urgency_multiplier,
    risk_tolerance_language,
    execution_style,
  }
}
