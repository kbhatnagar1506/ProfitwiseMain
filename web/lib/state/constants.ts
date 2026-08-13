// ─── Shared concentration thresholds ─────────────────────────────────
//
// Use consistently across summary, insights, transition signals, and risk.
// Low < 15%, Moderate 15–35%, High 35–50%, Critical > 50%

export const CONCENTRATION = {
  /** Low: top customer/vendor < 15% */
  LOW_MAX: 15,
  /** Moderate: 15–35% */
  MODERATE_MAX: 35,
  /** High: 35–50% */
  HIGH_MAX: 50,
  /** Critical: > 50% */
} as const

export function concentrationLabelFromPct(topPct: number): "low" | "moderate" | "high" | "critical" {
  if (topPct > CONCENTRATION.HIGH_MAX) return "critical"
  if (topPct > CONCENTRATION.MODERATE_MAX) return "high"
  if (topPct > CONCENTRATION.LOW_MAX) return "moderate"
  return "low"
}

export function concentrationAdverb(band: "low" | "moderate" | "high" | "critical"): string {
  return band === "critical" || band === "high" ? "highly" : band === "moderate" ? "moderately" : "lightly"
}
