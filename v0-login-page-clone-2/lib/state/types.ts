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
  repeat_revenue_ratio: number

  revenue_by_customer: { entity_id: string | null; name: string; total: number; count: number }[]
  provisional_revenue: number
  excluded_revenue: number
}

export type SpendBreakdownEntry = {
  entity_id: string | null
  name: string
  total: number
  count: number
  pct_of_spend: number
}

export type SpendState = {
  period_start: string
  period_end: string

  total_opex: number
  total_cogs: number
  direct_cost_candidates: number
  total_spend: number

  payroll: number
  vendor_payments: number
  bank_fees: number
  taxes: number
  processor_fees: number

  recurring_obligations: number
  recurring_obligation_count: number
  non_recurring_spend: number

  vendor_count: number
  avg_payment: number
  top_vendor_pct: number
  supplier_concentration_index: number

  spend_by_vendor: SpendBreakdownEntry[]
  provisional_spend: number
  excluded_spend: number
}

export type AccountCash = {
  account_id: string
  account_name: string
  account_type: string
  net_flow: number
  inflows: number
  outflows: number
  movement_count: number
}

export type LiquidityRegime = "strong" | "stable" | "tightening"

export type SettlementLagSignal = {
  avg_settlement_lag_days: number
  sample_count: number
  confidence: "high" | "medium" | "low" | "insufficient"
}

export type LiquidityState = {
  period_start: string
  period_end: string

  total_inflows: number
  total_outflows: number
  period_net_cash_flow: number

  operating_inflows: number
  operating_outflows: number
  net_operating: number

  financing_inflows: number
  financing_outflows: number
  net_financing: number

  settlement_inflows: number
  settlement_outflows: number
  net_settlement: number
  settlement_lag: SettlementLagSignal

  owner_inflows: number
  owner_outflows: number
  net_owner: number

  cash_by_account: AccountCash[]
  transfer_dependency_ratio: number
  owner_support_ratio: number
  operating_dependency_ratio: number
  liquidity_regime: LiquidityRegime
  excluded_cash: number
}

export type StateConfidence = {
  revenue_confidence: number
  spend_confidence: number
  liquidity_confidence: number
}

export type SeverityBand = "low" | "moderate" | "elevated" | "high" | "critical"

export type TransitionSignal = {
  signal: string
  severity: "info" | "warning" | "critical"
  description: string
  current_band: SeverityBand
  previous_band: SeverityBand | null
  current_state: string
  previous_state: string | null
  regime_change: boolean
  current_value: number
  previous_value: number | null
  threshold: number
  triggered: boolean
}

export type Insight = {
  id: string
  type: "revenue" | "spend" | "liquidity" | "risk"
  severity: "low" | "medium" | "high"
  message: string
  metric: number
}

export type RiskLevel = "low" | "medium" | "high"

export type RiskDimension = {
  level: RiskLevel
  score: number
  reason: string
}

export type RiskState = {
  liquidity_risk: RiskDimension
  concentration_risk: RiskDimension
  dependency_risk: RiskDimension
  anomaly_risk: RiskDimension
  uncertainty_risk: RiskDimension
  overall: RiskLevel
  overall_score: number
}

// ─── Forecast Types ──────────────────────────────────────────────────

export type ComponentBehavior = "recurring" | "episodic" | "seasonal" | "one_time"

export type CashflowComponent = {
  id: string
  label: string
  direction: "in" | "out"
  category: "customer_receipts" | "processor_payouts" | "financing_in" | "owner_contributions"
    | "vendor_payments" | "recurring_expenses" | "processor_fees" | "debt_payments" | "transfers" | "other"
  behavior: ComponentBehavior
  monthly_avg: number
  monthly_count: number
  trend: number
  volatility: number
  confidence: "high" | "medium" | "low"
  seasonal_index: Record<number, number> | null
}

// ─── Outstanding Invoice Signals ─────────────────────────────────────

export type OutstandingInvoice = {
  invoice_id: string
  source: "qbo" | "xero" | "gmail" | "stripe"
  customer_name: string
  customer_source_id: string | null
  entity_id: string | null
  amount: number
  amount_due: number
  due_date: string | null
  days_until_due: number | null
  days_overdue: number | null
  status: "open" | "overdue" | "partially_paid"
}

export type InvoiceSignal = {
  invoices: OutstandingInvoice[]
  total_outstanding: number
  total_overdue: number
  overdue_count: number
  avg_days_to_due: number | null
}

// ─── Entity-Level Behavioral Models ─────────────────────────────────

export type CustomerModel = {
  entity_id: string
  name: string
  avg_amount: number
  payment_interval_days: number
  interval_variance: number
  last_payment_date: string
  payment_count: number
  probability_of_next: number
  next_expected_date: string | null
  confidence: "high" | "medium" | "low"
  outstanding_invoices: OutstandingInvoice[]
}

export type VendorModel = {
  entity_id: string
  name: string
  avg_amount: number
  cadence: "weekly" | "biweekly" | "monthly" | "quarterly" | "irregular"
  cadence_interval_days: number
  is_recurring: boolean
  last_payment_date: string
  payment_count: number
  next_expected_date: string | null
  confidence: "high" | "medium" | "low"
}

export type SettlementModel = {
  avg_delay_days: number
  delay_std: number
  sample_count: number
  confidence: "high" | "medium" | "low" | "insufficient"
}

export type TransferBehaviorModel = {
  avg_transfer_amount: number
  transfer_count: number
  trigger_pattern: "low_balance" | "periodic" | "irregular" | "unknown"
  avg_interval_days: number | null
  primary_account: string | null
  secondary_account: string | null
  confidence: "high" | "medium" | "low"
}

export type BehavioralModels = {
  customers: CustomerModel[]
  vendors: VendorModel[]
  settlement: SettlementModel
  transfers: TransferBehaviorModel
  recurring_fixed: { label: string; monthly_amount: number; last_date: string }[]
  invoice_signal: InvoiceSignal
}

export type ForecastEvent = {
  date: string
  day_offset: number
  type: "customer_payment" | "vendor_payment" | "recurring_expense" | "debt_payment" | "settlement" | "transfer" | "processor_fee"
  entity: string
  amount: number
  direction: "in" | "out"
  probability: number
  confidence: "high" | "medium" | "low"
  source_model: "customer" | "vendor" | "recurring" | "settlement" | "transfer" | "aggregate"
}

export type ForecastMonth = {
  month: string
  inflows: number
  outflows: number
  net: number
  cumulative_net: number
  components: { component_id: string; amount: number }[]
}

export type ScenarioResult = {
  scenario: "base" | "optimistic" | "pessimistic"
  label: string
  months: ForecastMonth[]
  runway_months: number | null
  ending_cash: number
}

export type DailySimDay = {
  day: number
  date: string
  cash: number
  inflows: number
  outflows: number
  events: { entity: string; amount: number; direction: "in" | "out" }[]
}

export type DailySimulation = {
  starting_cash: number
  days: DailySimDay[]
  min_cash: number
  min_cash_day: number
  ending_cash: number
}

export type MonteCarloPercentile = {
  day: number
  p5: number
  p25: number
  p50: number
  p75: number
  p95: number
}

export type DayScenarioSnapshot = {
  scenario: "base" | "conservative" | "aggressive"
  label: string
  cash_14d: number
  cash_30d: number
  min_cash: number
  min_cash_day: number
}

export type MonteCarloResult = {
  simulations: number
  percentiles: MonteCarloPercentile[]
  prob_below_zero_14d: number
  prob_below_zero_30d: number
  prob_above_starting_30d: number
  expected_cash_30d: number
  worst_case_cash_30d: number
  best_case_cash_30d: number
  day_scenarios: DayScenarioSnapshot[]
}

export type ForecastNarrative = {
  forecast: string
  risk: string
  insight: string
  action: string
  severity: "healthy" | "caution" | "danger"
}

// ─── Forecast Confidence ─────────────────────────────────────────────

export type ComponentConfidence = {
  area: string
  score: number
  label: "high" | "medium" | "low"
  reason: string
}

export type ForecastConfidence = {
  score: number
  label: "high" | "medium" | "low"
  model_coverage: number
  data_completeness: number
  variance_penalty: number
  reasons: string[]
  by_component: ComponentConfidence[]
}

// ─── Cash Runway ─────────────────────────────────────────────────────

export type CashRunway = {
  base_months: number | null
  pessimistic_months: number | null
  monthly_burn_rate: number
  months_of_data: number
}

// ─── Sensitivity Analysis ────────────────────────────────────────────

export type SensitivityDriver = {
  entity: string
  type: "customer" | "vendor" | "transfer" | "recurring" | "settlement"
  impact_pct: number
  direction: "positive" | "negative"
  description: string
}

export type SensitivityAnalysis = {
  drivers: SensitivityDriver[]
  top_risk_driver: string
  top_opportunity_driver: string
}

// ─── Intervention Engine ─────────────────────────────────────────────

export type Intervention = {
  id: string
  label: string
  type: "accelerate_collection" | "delay_payment" | "reduce_spend" | "increase_transfer"
  entity: string | null
  parameter_days: number | null
  parameter_pct: number | null
  impact_cash_14d: number
  impact_cash_30d: number
  impact_risk_reduction: number
  description: string
}

// ─── Scenario Drivers ────────────────────────────────────────────────

export type ScenarioDriver = {
  factor: string
  impact_amount: number
  direction: "positive" | "negative"
}

export type ScenarioResultV2 = ScenarioResult & {
  drivers: ScenarioDriver[]
}

export type CashflowForecast = {
  period_start: string
  forecast_horizon_months: number
  components: CashflowComponent[]
  behavioral_models: BehavioralModels
  events_30d: ForecastEvent[]
  daily_simulation: DailySimulation
  monte_carlo: MonteCarloResult
  narrative: ForecastNarrative
  scenarios: ScenarioResult[]
  data_span_days: number
  computed_at: string
  forecast_confidence: ForecastConfidence
  cash_runway: CashRunway
  sensitivity: SensitivityAnalysis
  interventions: Intervention[]
}

export type BusinessState = {
  revenue: RevenueState
  spend: SpendState
  liquidity: LiquidityState
  risk: RiskState
  transitions: TransitionSignal[]
  insights: Insight[]
  state_confidence: StateConfidence
  insight_block: string
  computed_at: string
}
