import { query } from "./db"

type OpenEventCandidate = {
  id: string
  entity_id: string
  event_type: "ar" | "ap"
  canonical_name: string
  expected_date: string
  outstanding_num: number
}

type ResidualMovement = {
  id: string
  date: string
  direction: "inflow" | "outflow"
  movement_type: string | null
  counterparty: string | null
  counterparty_entity_id: string | null
  raw_description: string | null
}

export type Stage4EntityCorrelation = {
  entity_id: string
  canonical_name: string
  aliases: string[]
}

export type Stage4GhostGap = {
  cash_event_id: string
  entity_id: string
  entity_name: string
  event_type: "ar" | "ap"
  amount: number
  outstanding_amount: number
  expected_date: string
  age_days: number
}

export type Stage4VelocityStat = {
  entity_id: string
  canonical_name: string
  event_type: "ar" | "ap"
  expected_days: number | null
  actual_median_days: number | null
  delta_days: number | null
  sample_size: number
}

export type Stage4CandidatePayload = {
  movement: {
    movement_id: string
    date: string
    amount: number
    direction: "inflow" | "outflow"
    target_type: "ar" | "ap"
    counterparty: string | null
    counterparty_entity_id: string | null
    movement_type: string | null
    raw_description: string | null
    tokens: string[]
    is_big_rock: boolean
  }
  candidates: Array<{
    event_id: string
    entity_id: string
    canonical_name: string
    event_type: "ar" | "ap"
    expected_date: string
    outstanding_amount: number
    amount_delta: number
    date_delta_days: number | null
    alias_match: boolean
    ghost_gap: Stage4GhostGap | null
    velocity: Stage4VelocityStat | null
  }>
  context: {
    unresolved_amount: number
    big_rock_threshold: number
    generated_at: string
  }
}

function normalizeTokenInput(input: string): string[] {
  return (input || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12)
}

function daysBetweenIso(aIso: string, bIso: string): number | null {
  if (!aIso || !bIso) return null
  const a = new Date(aIso)
  const b = new Date(bIso)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null
  const ms = Math.abs(a.getTime() - b.getTime())
  return Math.round(ms / 86400000)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function fetchStage4EntityCorrelationMap(userId: string): Promise<Map<string, Stage4EntityCorrelation>> {
  const { rows } = await query<{
    entity_id: string
    canonical_name: string
    aliases: string[] | null
  }>(
    `SELECT
       e.id::text AS entity_id,
       e.canonical_name,
       COALESCE(array_agg(DISTINCT ea.alias) FILTER (WHERE ea.alias IS NOT NULL), '{}') AS aliases
     FROM entities e
     LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
     WHERE e.user_id = $1
     GROUP BY e.id, e.canonical_name`,
    [userId],
  )

  const byEntityId = new Map<string, Stage4EntityCorrelation>()
  for (const r of rows) {
    byEntityId.set(r.entity_id, {
      entity_id: r.entity_id,
      canonical_name: r.canonical_name,
      aliases: Array.isArray(r.aliases) ? r.aliases.filter(Boolean) : [],
    })
  }
  return byEntityId
}

export async function fetchStage4GhostGaps(userId: string): Promise<Map<string, Stage4GhostGap>> {
  const { rows } = await query<{
    cash_event_id: string
    entity_id: string
    event_type: "ar" | "ap"
    amount: string
    outstanding_amount: string
    expected_date: string
    age_days: string
    metadata: Record<string, unknown> | null
  }>(
    `SELECT
       ce.id::text AS cash_event_id,
       ce.entity_id,
       ce.event_type,
       ce.amount::text AS amount,
       COALESCE(ce.outstanding_amount, ce.amount)::text AS outstanding_amount,
       ce.expected_date::text AS expected_date,
       GREATEST(0, DATE_PART('day', NOW()::date - ce.expected_date::date))::text AS age_days,
       ce.metadata
     FROM cash_events ce
     WHERE ce.user_id = $1
       AND ce.event_type IN ('ar','ap')
       AND COALESCE(ce.outstanding_amount::float, ce.amount::float) > 0.01
       AND ce.expected_date < (NOW()::date - INTERVAL '60 days')`,
    [userId],
  )

  const map = new Map<string, Stage4GhostGap>()
  for (const r of rows) {
    const md = (r.metadata ?? {}) as Record<string, unknown>
    const entityName =
      (typeof md.canonical_name === "string" && md.canonical_name) ||
      (typeof md.customer_name === "string" && md.customer_name) ||
      (typeof md.vendor_name === "string" && md.vendor_name) ||
      r.entity_id
    map.set(r.cash_event_id, {
      cash_event_id: r.cash_event_id,
      entity_id: r.entity_id,
      entity_name: entityName,
      event_type: r.event_type,
      amount: round2(parseFloat(r.amount) || 0),
      outstanding_amount: round2(parseFloat(r.outstanding_amount) || 0),
      expected_date: r.expected_date,
      age_days: parseInt(r.age_days, 10) || 0,
    })
  }
  return map
}

export async function fetchStage4VelocityStats(userId: string): Promise<Map<string, Stage4VelocityStat>> {
  const { rows } = await query<{
    entity_id: string
    event_type: "ar" | "ap"
    expected_days: string | null
    actual_median_days: string | null
    sample_size: string
  }>(
    `WITH obs AS (
       SELECT
         a.entity_id,
         a.component_type AS event_type,
         m.date::date AS paid_date,
         COALESCE(NULLIF(a.metadata->>'expected_date','')::date, NULL) AS expected_date
       FROM movement_attributions a
       JOIN movements m
         ON m.id = a.movement_id AND m.user_id = a.user_id
       WHERE a.user_id = $1
         AND a.component_type IN ('ar','ap')
         AND m.date >= NOW() - INTERVAL '180 days'
     ),
     usable AS (
       SELECT
         entity_id,
         event_type,
         CASE WHEN expected_date IS NOT NULL THEN DATE_PART('day', paid_date - expected_date)::float ELSE NULL END AS delay_days
       FROM obs
     )
     SELECT
       entity_id,
       event_type,
       COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY 0), 0)::text AS expected_days,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY delay_days)::text AS actual_median_days,
       COUNT(*)::text AS sample_size
     FROM usable
     WHERE delay_days IS NOT NULL
     GROUP BY entity_id, event_type`,
    [userId],
  )

  const out = new Map<string, Stage4VelocityStat>()
  for (const r of rows) {
    const expected = r.expected_days != null ? parseFloat(r.expected_days) : null
    const actual = r.actual_median_days != null ? parseFloat(r.actual_median_days) : null
    const key = `${r.event_type}:${r.entity_id}`
    out.set(key, {
      entity_id: r.entity_id,
      canonical_name: r.entity_id,
      event_type: r.event_type,
      expected_days: expected,
      actual_median_days: actual,
      delta_days: expected != null && actual != null ? round2(actual - expected) : null,
      sample_size: parseInt(r.sample_size, 10) || 0,
    })
  }
  return out
}

export function buildStage4CandidatePayload(input: {
  movement: ResidualMovement
  remainingCash: number
  targetType: "ar" | "ap"
  candidates: OpenEventCandidate[]
  entityMap: Map<string, Stage4EntityCorrelation>
  ghostByEventId: Map<string, Stage4GhostGap>
  velocityByEntityEvent: Map<string, Stage4VelocityStat>
  bigRockThreshold?: number
}): Stage4CandidatePayload {
  const {
    movement,
    remainingCash,
    targetType,
    candidates,
    entityMap,
    ghostByEventId,
    velocityByEntityEvent,
    bigRockThreshold = 5000,
  } = input
  const counterparty = movement.counterparty ?? movement.raw_description ?? ""
  const tokens = normalizeTokenInput(counterparty)
  const movementTextLower = counterparty.toLowerCase()

  return {
    movement: {
      movement_id: movement.id,
      date: movement.date,
      amount: round2(remainingCash),
      direction: movement.direction,
      target_type: targetType,
      counterparty: movement.counterparty,
      counterparty_entity_id: movement.counterparty_entity_id,
      movement_type: movement.movement_type,
      raw_description: movement.raw_description,
      tokens,
      is_big_rock: remainingCash >= bigRockThreshold,
    },
    candidates: candidates.map((c) => {
      const corr = entityMap.get(c.entity_id)
      const aliases = corr?.aliases ?? []
      const aliasMatch = aliases.some((alias) => alias && movementTextLower.includes(alias.toLowerCase()))
      const velocity = velocityByEntityEvent.get(`${c.event_type}:${c.entity_id}`) ?? null
      return {
        event_id: c.id,
        entity_id: c.entity_id,
        canonical_name: c.canonical_name,
        event_type: c.event_type,
        expected_date: c.expected_date,
        outstanding_amount: round2(c.outstanding_num),
        amount_delta: round2(Math.abs(c.outstanding_num - remainingCash)),
        date_delta_days: daysBetweenIso(movement.date, c.expected_date),
        alias_match: aliasMatch,
        ghost_gap: ghostByEventId.get(c.id) ?? null,
        velocity: velocity
          ? {
              ...velocity,
              canonical_name: corr?.canonical_name ?? c.canonical_name ?? velocity.canonical_name,
            }
          : null,
      }
    }),
    context: {
      unresolved_amount: round2(remainingCash),
      big_rock_threshold: bigRockThreshold,
      generated_at: new Date().toISOString(),
    },
  }
}
