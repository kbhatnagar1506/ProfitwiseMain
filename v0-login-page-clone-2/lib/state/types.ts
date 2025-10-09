// ─── State Objects: downstream consumers of frozen tag schema ───────
//
// These are the 3 core state objects that the AI CFO reads.
// They are computed from MovementTag[], not raw transactions.

export type RevenueState = {
  period_start: string
  period_end: string

  gross_revenue: number
  contra_revenue: number
  net_revenue: number

  customer_count: number
  avg_receipt: number
  top_customer_pct: number
  concentration_index: number

  revenue_by_customer: { entity_id: string | null; name: string; total: number; count: number }[]
  provisional_revenue: number
  excluded_revenue: number
}

export type SpendState = {
  period_start: string
  period_end: string

  total_opex: number
  total_cogs: number
  total_spend: number

  payroll: number
  vendor_payments: number
  bank_fees: number
  taxes: number
  processor_fees: number

  vendor_count: number
  avg_payment: number
  top_vendor_pct: number

  spend_by_vendor: { entity_id: string | null; name: string; total: number; count: number }[]
  provisional_spend: number
  excluded_spend: number
}

export type LiquidityState = {
  period_start: string
  period_end: string

  total_inflows: number
  total_outflows: number
  net_cash_flow: number

  operating_inflows: number
  operating_outflows: number
  net_operating: number

  financing_inflows: number
  financing_outflows: number
  net_financing: number

  settlement_inflows: number
  settlement_outflows: number
  net_settlement: number

  owner_inflows: number
  owner_outflows: number
  net_owner: number

  excluded_cash: number
}

export type TransitionSignal = {
  signal: string
  severity: "info" | "warning" | "critical"
  description: string
  current_value: number
  previous_value: number | null
  threshold: number
  triggered: boolean
}

export type BusinessState = {
  revenue: RevenueState
  spend: SpendState
  liquidity: LiquidityState
  transitions: TransitionSignal[]
  computed_at: string
}
