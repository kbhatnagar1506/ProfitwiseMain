/**
 * Standardized confidence envelope for attribution, AR/AP, and forecast boundaries.
 */

export type ConfidenceKind = "deterministic" | "probabilistic"

export type ConfidenceComponents = {
  amount?: number
  date?: number
  entity?: number
  history?: number
}

export type ConfidenceEnvelope = {
  score: number
  kind: ConfidenceKind
  components?: ConfidenceComponents
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(1, n))
}

/** Build envelope from a single scalar score (common path). */
export function confidenceFromScore(score: number, kind: ConfidenceKind = "probabilistic"): ConfidenceEnvelope {
  return { score: clamp01(score), kind }
}

/** Serialize for JSONB storage on movement_attributions.confidence_detail */
export function serializeConfidenceEnvelope(c: ConfidenceEnvelope): Record<string, unknown> {
  return {
    score: c.score,
    kind: c.kind,
    components: c.components ?? undefined,
  }
}

export function parseConfidenceEnvelope(raw: unknown): ConfidenceEnvelope | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const score = typeof o.score === "number" ? clamp01(o.score) : null
  if (score === null) return null
  const kind = o.kind === "deterministic" || o.kind === "probabilistic" ? o.kind : "probabilistic"
  const comp = o.components
  let components: ConfidenceComponents | undefined
  if (comp && typeof comp === "object") {
    const c = comp as Record<string, unknown>
    components = {
      amount: typeof c.amount === "number" ? clamp01(c.amount) : undefined,
      date: typeof c.date === "number" ? clamp01(c.date) : undefined,
      entity: typeof c.entity === "number" ? clamp01(c.entity) : undefined,
      history: typeof c.history === "number" ? clamp01(c.history) : undefined,
    }
  }
  return { score, kind, components }
}
