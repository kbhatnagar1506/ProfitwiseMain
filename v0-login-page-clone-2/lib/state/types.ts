// ─── State Engine Input Types ───────────────────────────────────────
//
// Tagged movements as consumed by revenue, spend, and liquidity engines.
// State engines read tags, never raw bank text.

export type TaggedMovementInput = {
  id: string
  amount: number
  direction: "inflow" | "outflow"
  occurred_at: string
  account_id: string | null
  entity_id: string | null
  metadata: Record<string, unknown>
  tag: {
    economic_class: string
    cashflow_bucket: string
    counterparty_role: string
    state_inclusion_policy: "include" | "include_provisional" | "exclude_and_review"
    customer_id?: string | null
    vendor_id?: string | null
    is_recurring?: boolean
    is_first_seen_counterparty?: boolean
    classification_confidence?: number
    evidence_strength?: number
  }
}

export type AccountBalanceInput = {
  account_id: string
  name?: string | null
  type?: string | null
  subtype?: string | null
  current_balance: number | null
  available_balance: number | null
  currency_code?: string | null
}

function isIncluded(policy: string): boolean {
  return policy === "include" || policy === "include_provisional"
}

export function filterIncluded<T extends { tag: { state_inclusion_policy: string } }>(
  items: T[],
): { included: T[]; excluded: T[] } {
  const included: T[] = []
  const excluded: T[] = []
  for (const x of items) {
    if (isIncluded(x.tag.state_inclusion_policy)) included.push(x)
    else excluded.push(x)
  }
  return { included, excluded }
}
