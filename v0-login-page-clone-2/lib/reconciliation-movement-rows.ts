/**
 * Build per-movement reconciliation rows for AR/AP dashboard (matched vs unmatched to invoices/obligations).
 */

import { query } from "./db"
import { resolveReconciliationBankLabelsForMatch } from "./display-name-resolve"

export type ReconAllocationRow = {
  gross: number
  fee: number
  net: number
  entity_type?: string
  entity_id?: string
}

export type ReconMovementRow = {
  movement_id: string
  amount: number
  date: string
  counterparty: string | null
  display_name?: string | null
  allocations: ReconAllocationRow[]
}

type FlatRow = {
  movement_id: string
  direction: string
  amount: string
  date: string
  counterparty: string | null
  counterparty_entity_id: string | null
  movement_metadata: unknown
  component_type: string | null
  entity_id: string | null
  gross_amount: string | null
  net_amount: string | null
  metadata: unknown
}

type Grouped = {
  direction: string
  base: Omit<ReconMovementRow, "allocations">
  attrs: ReconAllocationRow[]
  counterparty_entity_id: string | null
  movement_metadata: Record<string, unknown>
}

function feeFromMeta(md: unknown): number {
  if (!md || typeof md !== "object") return 0
  const f = (md as Record<string, unknown>).fee_amount
  if (typeof f === "number") return f
  if (typeof f === "string") return parseFloat(f) || 0
  return 0
}

/**
 * Lists movements with AR/AP attributions vs those still needing AR (inflow) or AP (outflow) links.
 */
export async function fetchReconciliationMovementRows(userId: string): Promise<{
  matched_inflows: ReconMovementRow[]
  matched_outflows: ReconMovementRow[]
  unmatched_inflows: ReconMovementRow[]
  unmatched_outflows: ReconMovementRow[]
}> {
  const { rows } = await query<FlatRow>(
    `SELECT m.id AS movement_id, m.direction, m.amount::text AS amount, m.date::text AS date, m.counterparty,
            m.counterparty_entity_id::text AS counterparty_entity_id, m.metadata AS movement_metadata,
            a.component_type, a.entity_id, a.gross_amount::text, a.net_amount::text, a.metadata
     FROM movements m
     LEFT JOIN movement_attributions a ON a.movement_id = m.id AND a.user_id = m.user_id
     WHERE m.user_id = $1::uuid AND m.duplicate_of IS NULL
     ORDER BY m.date DESC NULLS LAST, m.id, a.created_at ASC NULLS LAST`,
    [userId],
  )

  const byMovement = new Map<string, Grouped>()

  for (const r of rows) {
    const id = r.movement_id
    let g = byMovement.get(id)
    if (!g) {
      const md =
        r.movement_metadata && typeof r.movement_metadata === "object"
          ? (r.movement_metadata as Record<string, unknown>)
          : {}
      g = {
        direction: r.direction,
        base: {
          movement_id: id,
          amount: Math.abs(parseFloat(String(r.amount)) || 0),
          date: typeof r.date === "string" ? r.date.slice(0, 10) : "",
          counterparty: r.counterparty,
          display_name: r.counterparty,
        },
        attrs: [],
        counterparty_entity_id: r.counterparty_entity_id,
        movement_metadata: md,
      }
      byMovement.set(id, g)
    }
    if (r.component_type) {
      const gross = parseFloat(String(r.gross_amount ?? 0)) || 0
      const net = parseFloat(String(r.net_amount ?? 0)) || 0
      const feeMeta = feeFromMeta(r.metadata)
      g.attrs.push({
        gross,
        fee: feeMeta || Math.max(0, gross - Math.abs(net)),
        net,
        entity_type: r.component_type,
        entity_id: r.entity_id ?? undefined,
      })
    }
  }

  const groupedList = [...byMovement.values()]
  const displayMap = await resolveReconciliationBankLabelsForMatch(
    groupedList.map((g) => ({
      movement_id: g.base.movement_id,
      user_id: userId,
      counterparty:
        (typeof g.movement_metadata.counterparty === "string" ? g.movement_metadata.counterparty : null) ??
        g.base.counterparty,
      counterparty_entity_id: g.counterparty_entity_id,
    })),
  )

  const matched_inflows: ReconMovementRow[] = []
  const matched_outflows: ReconMovementRow[] = []
  const unmatched_inflows: ReconMovementRow[] = []
  const unmatched_outflows: ReconMovementRow[] = []

  for (const { direction, base, attrs } of groupedList) {
    const resolved = displayMap.get(base.movement_id)?.display_name ?? null
    const row: ReconMovementRow = {
      ...base,
      display_name: resolved ?? base.display_name ?? base.counterparty,
      allocations: attrs,
    }
    const hasAr = attrs.some((a) => a.entity_type === "ar")
    const hasAp = attrs.some((a) => a.entity_type === "ap")
    if (direction === "inflow") {
      if (hasAr) matched_inflows.push(row)
      else unmatched_inflows.push(row)
    } else {
      if (hasAp) matched_outflows.push(row)
      else unmatched_outflows.push(row)
    }
  }

  return { matched_inflows, matched_outflows, unmatched_inflows, unmatched_outflows }
}
