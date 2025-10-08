"use client"

import { useState, useEffect, useCallback, useRef, Fragment } from "react"
import { usePlaidLink } from "react-plaid-link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import Image from "next/image"
import { Sparkles, Loader2 } from "lucide-react"
import { displayLabelForCounterparty } from "@/lib/alias-normalize"
import whatsappQr from "../Screenshot 2026-03-08 at 03.57.15.png"
import { useRouter } from "next/navigation"
interface Integration {
  name: string
  description: string
  category: string
  logo: string
}

const integrations: Integration[] = [
  {
    name: "QuickBooks Online",
    description: "Cloud accounting for growing businesses",
    category: "Accounting",
    logo: "/quickbooks-logo.png",
  },
  {
    name: "Xero",
    description: "Modern accounting for SMEs",
    category: "Accounting",
    logo: "/xero-logo.png",
  },
  {
    name: "Stripe",
    description: "Revenue, invoices, and subscriptions",
    category: "Revenue",
    logo: "/stripe-logo.png",
  },
  {
    name: "FreshBooks",
    description: "Simple accounting for small businesses",
    category: "Accounting",
    logo: "/freshbooks-logo.png",
  },
  {
    name: "Ramp",
    description: "Spend management and corporate cards",
    category: "Spend Management",
    logo: "/ramp-logo.png",
  },
  {
    name: "Brex",
    description: "Corporate card and spend platform",
    category: "Spend Management",
    logo: "/brex-logo.png",
  },
  {
    name: "Mercury",
    description: "Modern banking for startups and SMBs",
    category: "Business Banking",
    logo: "/mercury-logo.png",
  },
]

const steps = [
  { id: 1, title: "Connect your bank", description: "Securely link your first bank account." },
  { id: 2, title: "Review bank accounts", description: "See balances and add more accounts." },
  { id: 3, title: "Connect accounting tools", description: "Link the accounting and spend tools you already use." },
  {
    id: 4,
    title: "Connect documents & drives",
    description: "Link where your invoices and financial documents live.",
  },
  {
    id: 5,
    title: "Choose communication channels",
    description: "Pick where you want to talk to ProfitWise and receive updates.",
  },
  { id: 6, title: "Company & financial context", description: "Review and refine how we describe your business." },
  { id: 7, title: "Company profile", description: "Fill in key details about how your business is set up." },
  {
    id: 8,
    title: "Review your data",
    description: "Inspect the raw data we’ve pulled in from your banks, accounting tools, and Gmail.",
  },
  {
    id: 9,
    title: "Identity graph",
    description: "See every vendor, customer, and entity we’ve resolved across all your connected sources.",
  },
  {
    id: 10,
    title: "Money movements & tags",
    description: "Every transaction classified and tagged: P&L impact, economic class, cashflow bucket, and counterparty role.",
  },
  {
    id: 11,
    title: "AR/AP & reconciliation",
    description: "Expected inflows (AR) and outflows (AP). Bank payments matched to invoices. Gross − Fee = Net.",
  },
  {
    id: 12,
    title: "State objects",
    description: "Revenue, Spend, and Liquidity states computed from frozen tags, plus transition detectors.",
  },
  {
    id: 13,
    title: "Cashflow forecast",
    description: "Simulate future cash based on behavioral component models, not simple time-series prediction.",
  },
  {
    id: 14,
    title: "Decisions & actions",
    description: "Top actions ranked by impact, combined strategies, and execution steps.",
  },
]

const PLAID_INTEGRATIONS = ["Ramp", "Brex", "Mercury"]

function formatBalance(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

const QBO_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "QuickBooks connection was cancelled. You can try again when you're ready.",
  missing_params: "QuickBooks connection didn't complete. Please try connecting again.",
  state_mismatch: "QuickBooks security check failed. Please try again.",
  config: "QuickBooks isn't configured yet. Please try again later.",
  token_exchange: "QuickBooks connection failed. Please try again.",
}

export function OnboardingFlow({
  qboError,
  initialStep = 1,
}: {
  qboError?: string | null
  initialStep?: number
}) {
  const [currentStep, setCurrentStep] = useState(
    Math.min(Math.max(initialStep, 1), steps.length)
  )
  const [bankConnected, setBankConnected] = useState(false)
  const [dismissedError, setDismissedError] = useState(false)
  const [plaidLinkToken, setPlaidLinkToken] = useState<string | null>(null)
  const [plaidLinkLoading, setPlaidLinkLoading] = useState(false)
  const [plaidLinkError, setPlaidLinkError] = useState<string | null>(null)
  const [connectedItemIds, setConnectedItemIds] = useState<string[]>([])
  const [connectedAccounts, setConnectedAccounts] = useState<
    { name: string; mask: string | null; type: string; current_balance: number | null; available_balance: number | null }[]
  >([])
  const [addAccountLinkToken, setAddAccountLinkToken] = useState<string | null>(null)
  const [addAccountLinkLoading, setAddAccountLinkLoading] = useState(false)
  const [accountingStepLinkToken, setAccountingStepLinkToken] = useState<string | null>(null)
  const [accountingStepLinkLoading, setAccountingStepLinkLoading] = useState(false)
  const [connectedIntegrations, setConnectedIntegrations] = useState<string[]>([])
  const [accountingSyncLoading, setAccountingSyncLoading] = useState(false)
  const [disconnectAccountingLoading, setDisconnectAccountingLoading] = useState(false)
  const [connectedContextIntegrations, setConnectedContextIntegrations] = useState<string[]>([])
  const [companyContextLoading, setCompanyContextLoading] = useState(false)
  const [companyContext, setCompanyContext] = useState<string | null>(null)
  const [companyContextError, setCompanyContextError] = useState<string | null>(null)
  const [refineInput, setRefineInput] = useState("")
  const [refineLoading, setRefineLoading] = useState(false)
  const [editedContext, setEditedContext] = useState<string | null>(null)
  const [contextSelection, setContextSelection] = useState({ start: 0, end: 0, text: "" })
  const [companyForm, setCompanyForm] = useState<Record<string, string>>({})
  const [companyFormLoading, setCompanyFormLoading] = useState(false)
  const [companyFormSaveLoading, setCompanyFormSaveLoading] = useState(false)
  const [companyFormAutofillLoading, setCompanyFormAutofillLoading] = useState(false)
  const [step7BankAccounts, setStep7BankAccounts] = useState<{ name: string; mask: string | null }[]>([])
  type RawDataResponse = {
    plaid: {
      items: string[]
      accounts: { item_id: string; account_id: string; name: string; type: string; subtype: string | null; mask: string | null; current_balance: number | null; available_balance: number | null; currency_code: string | null }[]
      transactions: { item_id: string; account_id: string; transaction_id: string; amount: number; date: string; name: string; merchant_name: string | null; category: string[] | null; pending: boolean }[]
    }
    qbo: Record<string, unknown[]>
    xero: Record<string, unknown[]>
    stripe: Record<string, unknown[]>
    gmail: { extracted: { message_id: string; from_email: string | null; to_emails: string | null; subject: string | null; date_sent: string | null; snippet: string | null; extracted_invoice: unknown }[] }
  }
  const [rawData, setRawData] = useState<RawDataResponse | null>(null)
  const [rawDataLoading, setRawDataLoading] = useState(false)
  const [rawDataError, setRawDataError] = useState<string | null>(null)
  const [whatsappStatus, setWhatsappStatus] = useState<{ phone: string | null; verified: boolean } | null>(null)
  const [whatsappPhoneInput, setWhatsappPhoneInput] = useState("")
  const [whatsappOtpSent, setWhatsappOtpSent] = useState(false)
  const [whatsappCodeInput, setWhatsappCodeInput] = useState("")
  const [whatsappSendLoading, setWhatsappSendLoading] = useState(false)
  const [whatsappVerifyLoading, setWhatsappVerifyLoading] = useState(false)
  type IdentityEntity = { id: string; entity_type: string; canonical_name: string; display_name: string | null; domain: string | null; confidence: number; metadata: Record<string, unknown>; created_at: string; source_count: number; evidence_count: number; sources: string[] }
  type IdentityAlias = { id: string; entity_id: string; alias: string; alias_type: string; source: string; source_id: string | null; confidence: number }
  type IdentityAssertionCount = { entity_id: string; assertion_type: string; source: string; count: number; avg_score: number }
  type IdentityData = { entities: IdentityEntity[]; aliases: IdentityAlias[]; relationships: unknown[]; assertionCounts: IdentityAssertionCount[] }
  const [identityData, setIdentityData] = useState<IdentityData | null>(null)
  const [identityLoading, setIdentityLoading] = useState(false)
  const [identitySeeding, setIdentitySeeding] = useState(false)
  const [identityError, setIdentityError] = useState<string | null>(null)
  const [identityExpandedEntity, setIdentityExpandedEntity] = useState<string | null>(null)
  const [afterIdentityLoading, setAfterIdentityLoading] = useState(false)
  type MovementRow = {
    id: string; user_id: string; occurred_at: string; direction: string; amount: number;
    currency: string; raw_description: string | null; source_record_ids: string[];
    entity_id: string | null; account_id: string | null;
    movement_class: string; movement_type_detail: string; pnl_eligible: boolean;
    confidence: number; evidence_strength: number;
    needs_review: boolean; review_reasons: string[];
    provenance: string; coalesced_group_id: string | null;
    metadata: Record<string, unknown>;
  }
  type MovementSummary = { movement_class: string; movement_type_detail: string; pnl_eligible: boolean; count: number; total_amount: string }
  type SummaryFromTags = { pnl_count: number; non_pnl_count: number; excluded_for_review: number; unresolved: number; coalesced_count: number; included_pnl: number; included_non_pnl: number; included_count: number; class_counts: Record<string, { count: number; total_amount: number }> }
  type MovementsData = { movements: MovementRow[]; summary: MovementSummary[]; summary_from_tags?: SummaryFromTags | null }
  const [movementsData, setMovementsData] = useState<MovementsData | null>(null)
  const [movementsLoading, setMovementsLoading] = useState(false)
  const [movementsClassifying, setMovementsClassifying] = useState(false)
  const [movementsError, setMovementsError] = useState<string | null>(null)
  const [movementEditIntent, setMovementEditIntent] = useState("")
  const [movementEditLoading, setMovementEditLoading] = useState(false)
  const [movementEditMessage, setMovementEditMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)
  type TaggedMovement = MovementRow & { tag?: { economic_class: string; cashflow_bucket: string; counterparty_role: string; state_scope?: { affects_revenue: boolean; affects_spend: boolean; affects_liquidity: boolean; affects_operating_performance: boolean; affects_revenue_quality: boolean }; state_inclusion_policy?: string; is_operating?: boolean; is_financing?: boolean; is_investing?: boolean; is_owner_related?: boolean; hits_pnl?: boolean; hits_working_capital?: boolean; is_recurring?: boolean; is_anomaly?: boolean; is_large_outlier?: boolean; is_first_seen_counterparty?: boolean; recurrence_family_id?: string | null; classification_confidence?: number; evidence_strength?: number; needs_review?: boolean; review_reasons?: string[] } }
  type TagStats = { total: number; deterministic: number; identity_aware: number; inferred: number; recurring: number; anomalies: number; first_seen: number; policy_include: number; policy_provisional: number; policy_exclude: number }
  type UnresolvedImpact = { unresolved_inflow_total: number; unresolved_outflow_total: number; unresolved_count: number; unresolved_operating_exposure: number; unresolved_pct_of_inflows: number; unresolved_pct_of_operating_inflows: number; unresolved_pct_of_last_30d: number }
  type OwnerDependency = { owner_inflow_total: number; total_inflow: number; owner_dependency_ratio: number; owner_draw_total: number; net_owner_flow: number; contribution_count: number; draw_count: number }
  type WorkingCapitalSignals = { avg_settlement_lag_days: number | null; avg_inflow_cadence_days: number | null; avg_outflow_cadence_days: number | null; inflow_regularity: number; outflow_regularity: number; confidence: string; sample_sizes: { settlements: number; revenue_inflows: number; spend_outflows: number }; data_span_days: number }
  const [tagData, setTagData] = useState<{ movements: TaggedMovement[]; stats: TagStats; unresolved_impact?: UnresolvedImpact; owner_dependency?: OwnerDependency; working_capital?: WorkingCapitalSignals } | null>(null)
  const [tagLoading, setTagLoading] = useState(false)
  const [tagRunning, setTagRunning] = useState(false)
  const [tagError, setTagError] = useState<string | null>(null)
  type SeverityBand = "low" | "moderate" | "elevated" | "high" | "critical"
  type TransitionSignal = { signal: string; severity: "info" | "warning" | "critical"; description: string; current_band: SeverityBand; previous_band: SeverityBand | null; current_state: string; previous_state: string | null; regime_change: boolean; current_value: number; previous_value: number | null; threshold: number; triggered: boolean }
  type RevenueState = { period_start: string; period_end: string; gross_revenue: number; contra_revenue: number; net_revenue: number; customer_count: number; avg_receipt: number; top_customer_pct: number; concentration_index: number; repeat_revenue_ratio: number; revenue_by_customer: { entity_id: string | null; name: string; total: number; count: number }[]; provisional_revenue: number; excluded_revenue: number }
  type SpendBreakdownEntry = { entity_id: string | null; name: string; total: number; count: number; pct_of_spend: number }
  type SpendState = { period_start: string; period_end: string; total_opex: number; total_cogs: number; direct_cost_candidates: number; total_spend: number; payroll: number; vendor_payments: number; bank_fees: number; taxes: number; processor_fees: number; recurring_obligations: number; recurring_obligation_count: number; recurring_fixed_contractual?: number; recurring_soft?: number; recurring_discretionary?: number; non_recurring_spend: number; vendor_count: number; avg_payment: number; top_vendor_pct: number; supplier_concentration_index: number; spend_by_vendor: SpendBreakdownEntry[]; provisional_spend: number; excluded_spend: number }
  type AccountCash = { account_id: string; account_name: string; account_type: string; net_flow: number; inflows: number; outflows: number; movement_count: number }
  type StateConfidence = { revenue_confidence: number; spend_confidence: number; liquidity_confidence: number }
  type SettlementLagSignal = { avg_settlement_lag_days: number; sample_count: number; confidence: string }
  type LiquidityState = { period_start: string; period_end: string; total_inflows: number; total_outflows: number; period_net_cash_flow: number; operating_inflows: number; operating_outflows: number; net_operating: number; financing_inflows: number; financing_outflows: number; net_financing: number; settlement_inflows: number; settlement_outflows: number; net_settlement: number; settlement_lag?: SettlementLagSignal; owner_inflows: number; owner_outflows: number; net_owner: number; cash_by_account: AccountCash[]; transfer_dependency_ratio: number; owner_support_ratio: number; operating_dependency_ratio: number; liquidity_regime: "strong" | "stable" | "tightening"; excluded_cash: number }
  type Insight = { id: string; type: "revenue" | "spend" | "liquidity" | "risk"; severity: "low" | "medium" | "high"; message: string; metric: number }
  type RiskLevel = "low" | "medium" | "high"
  type RiskDimension = { level: RiskLevel; score: number; reason: string }
  type RiskState = { liquidity_risk: RiskDimension; concentration_risk: RiskDimension; dependency_risk: RiskDimension; anomaly_risk: RiskDimension; uncertainty_risk: RiskDimension; overall: RiskLevel; overall_score: number }
  type BusinessState = { revenue: RevenueState; spend: SpendState; liquidity: LiquidityState; risk: RiskState; transitions: TransitionSignal[]; insights: Insight[]; state_confidence: StateConfidence; insight_block: string; computed_at: string }
  const [stateData, setStateData] = useState<BusinessState | null>(null)
  type ARState = { total_outstanding: number; total_overdue: number; overdue_count: number; invoice_count: number; invoices: { invoice_id: string; source: string; customer_name: string; amount_due: number; due_date: string | null; days_until_due: number | null; days_overdue: number | null; status: string }[]; avg_days_to_due: number | null }
  type APState = { total_expected_30d: number; obligation_count: number; obligations: { obligation_id: string; source: "bill" | "inferred"; vendor_name: string; expected_amount: number; next_expected_date: string; days_until_due: number; days_overdue: number | null; confidence: string; cadence: string; payment_count: number; priority: "high" | "medium" | "low"; risk_flag: string | null }[] }
  const [arApData, setArApData] = useState<{ ar: ARState; ap: APState } | null>(null)
  const [arApLoading, setArApLoading] = useState(false)
  const [arApError, setArApError] = useState<string | null>(null)
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<string | null>(null)
  const [expandedObligationId, setExpandedObligationId] = useState<string | null>(null)
  const [stateLoading, setStateLoading] = useState(false)
  const [stateError, setStateError] = useState<string | null>(null)
  type MappingReconData = {
    total_matched_inflows: number
    total_matched_outflows: number
    total_unmatched_inflows: number
    total_unmatched_outflows: number
    total_fees_paid: number
  }
  const [mappingArAp, setMappingArAp] = useState<{ ar: ARState; ap: APState } | null>(null)
  const [mappingRecon, setMappingRecon] = useState<MappingReconData | null>(null)
  const [mappingLoading, setMappingLoading] = useState(false)
  const [mappingError, setMappingError] = useState<string | null>(null)

  type ComponentBehavior = "recurring" | "episodic" | "seasonal" | "one_time"
  type CashflowComponent = { id: string; label: string; direction: "in" | "out"; category: string; behavior: ComponentBehavior; monthly_avg: number; monthly_count: number; trend: number; volatility: number; confidence: "high" | "medium" | "low"; seasonal_index: Record<number, number> | null }
  type OutstandingInvoice = { invoice_id: string; source: string; customer_name: string; customer_source_id: string | null; entity_id: string | null; amount: number; amount_due: number; due_date: string | null; days_until_due: number | null; days_overdue: number | null; status: "open" | "overdue" | "partially_paid" }
  type InvoiceSignal = { invoices: OutstandingInvoice[]; total_outstanding: number; total_overdue: number; overdue_count: number; avg_days_to_due: number | null }
  type CustomerArchetype = "clockwork" | "bursty" | "episodic" | "slow_reliable" | "volatile" | "low_data"
  type CustomerFeatures = { payment_count: number; invoice_count: number; paid_vs_unpaid_ratio: number; avg_days_to_pay: number; std_days_to_pay: number; amount_mean: number; amount_std: number; interval_cv: number; recent_trend: string; last_payment_recency_days: number; overdue_count: number; weekday_bias: number | null }
  type InvoiceForecast = { invoice_id: string; customer_name: string; amount_due: number; due_date: string | null; days_overdue: number | null; customer_dso: number; probability_7d: number; probability_14d: number; probability_30d: number; expected_collection_date: string; expected_amount: number; reasoning: string }
  type CustomerModel = { entity_id: string; name: string; archetype: CustomerArchetype; features: CustomerFeatures; avg_amount: number; payment_interval_days: number; interval_variance: number; last_payment_date: string; payment_count: number; probability_of_next: number; next_expected_date: string | null; confidence: "high" | "medium" | "low"; outstanding_invoices: OutstandingInvoice[]; invoice_forecasts: InvoiceForecast[] }
  type OutstandingBill = { bill_id: string; source: string; vendor_name: string; amount: number; amount_due: number; due_date: string | null; days_until_due: number | null; days_overdue: number | null; status: string }
  type RecurrenceModel = { recurrence_type: string; recurrence_confidence: number; expected_interval_days: number | null; interval_std_days: number | null; amount_mean: number | null; amount_std: number | null }
  type VendorModel = { entity_id: string; name: string; avg_amount: number; cadence: string; cadence_interval_days: number; is_recurring: boolean; recurrence: RecurrenceModel; last_payment_date: string; payment_count: number; next_expected_date: string | null; confidence: "high" | "medium" | "low"; outstanding_bills?: OutstandingBill[] }
  type ProcessorSettlementProfile = { processor: string; avg_delay_days: number; delay_std: number; sample_count: number; weekday_pattern: Record<number, number> | null; fee_rate: number | null }
  type SettlementModel = { avg_delay_days: number; delay_std: number; sample_count: number; confidence: string; by_processor?: ProcessorSettlementProfile[] }
  type TransferBehaviorModel = { avg_transfer_amount: number; transfer_count: number; trigger_pattern: string; avg_interval_days: number | null; primary_account: string | null; secondary_account: string | null; confidence: string }
  type BehavioralModels = { customers: CustomerModel[]; vendors: VendorModel[]; settlement: SettlementModel; transfers: TransferBehaviorModel; recurring_fixed: { label: string; monthly_amount: number; last_date: string }[]; invoice_signal: InvoiceSignal }
  type ForecastMonth = { month: string; inflows: number; outflows: number; net: number; cumulative_net: number; components: { component_id: string; amount: number }[] }
  type ScenarioResult = { scenario: "base" | "optimistic" | "pessimistic"; label: string; months: ForecastMonth[]; runway_months: number | null; ending_cash: number }
  type EventReasoning = { basis: string; payment_history?: string; interval_info?: string; amount_range?: string; recurrence_info?: string; invoice_info?: string; risk_factors?: string[] }
  type ForecastEvent = { date: string; day_offset: number; type: string; entity: string; amount: number; direction: "in" | "out"; probability: number; confidence: "high" | "medium" | "low"; source_model: string; reasoning?: EventReasoning }
  type DailySimDay = { day: number; date: string; cash: number; inflows: number; outflows: number; events: { entity: string; amount: number; direction: "in" | "out" }[] }
  type DailySimulation = { starting_cash: number; days: DailySimDay[]; min_cash: number; min_cash_day: number; ending_cash: number }
  type MonteCarloPercentile = { day: number; p5: number; p25: number; p50: number; p75: number; p95: number }
  type DayScenarioSnapshot = { scenario: "base" | "conservative" | "aggressive"; label: string; cash_14d: number; cash_30d: number; min_cash: number; min_cash_day: number }
  type MonteCarloResult = { simulations: number; percentiles: MonteCarloPercentile[]; prob_below_zero_14d: number; prob_below_zero_30d: number; prob_above_starting_30d: number; expected_cash_30d: number; worst_case_cash_30d: number; best_case_cash_30d: number; day_scenarios: DayScenarioSnapshot[] }
  type ForecastNarrative = { forecast: string; risk: string; insight: string; action: string; severity: "healthy" | "caution" | "danger" }
  type ComponentConfidence = { area: string; score: number; label: "high" | "medium" | "low"; reason: string }
  type ForecastConfidence = { score: number; label: string; model_coverage: number; data_completeness: number; variance_penalty: number; reasons: string[]; by_component: ComponentConfidence[]; diagnosis?: string; why_confidence_low?: string[]; how_to_improve?: string[]; what_would_make_wrong?: string }
  type CashRunway = { base_months: number | null; pessimistic_months: number | null; monthly_burn_rate: number; months_of_data: number }
  type SensitivityDriver = { entity: string; type: string; impact_pct: number; direction: "positive" | "negative"; description: string }
  type SensitivityAnalysis = { drivers: SensitivityDriver[]; top_risk_driver: string; top_opportunity_driver: string }
  type ActionSimImpact = { low_point_before: number; low_point_after: number; stress_prob_before: number; stress_prob_after: number; runway_months_change?: number }
  type Intervention = { id: string; label: string; type: string; entity: string | null; parameter_days: number | null; parameter_pct: number | null; impact_cash_14d: number; impact_cash_30d: number; impact_risk_reduction: number; description: string; plausible_range_low?: number; plausible_range_high?: number; confidence_band?: string; assumptions?: string[]; simulation_impact?: ActionSimImpact; rank?: number; second_order_risks?: { late_fee?: string; relationship?: string; next_period?: string } }
  type CombinedStrategy = { id: string; actions: { label: string; entity: string | null }[]; low_point: number; stress_prob: number; risk_level: string; summary: string }
  type ExecutionSuggestion = { action_id: string; action_label: string; type: string; label: string; content?: string }
  type ScenarioDriver = { factor: string; impact_amount: number; direction: "positive" | "negative" }
  type ScenarioResultV2 = ScenarioResult & { drivers?: ScenarioDriver[] }
  type AccountBalance = { account_id: string; name: string; type: string; subtype: string | null; balance: number }
  type RiskDecomposition = { liquidity: number; concentration: number; dependency: number; anomaly: number; uncertainty: number }
  type ForecastContext = { risk_score: number; risk_level: string; risk_decomposition?: RiskDecomposition; concentration_risk_score: number; dependency_risk_score: number; liquidity_risk_score: number; top_customer_pct: number; repeat_revenue_ratio: number; operating_dependency_ratio: number; transfer_dependency_ratio: number; recurring_spend_ratio: number; liquidity_regime: string; balance_source: string; account_balances: AccountBalance[]; transitions: { signal: string; severity: string; description: string; regime_change: boolean }[] }
  type CalibrationBucket = { range: string; predicted_prob: number; actual_rate: number; count: number }
  type CalibrationResult = { total_events_evaluated: number; buckets: CalibrationBucket[]; calibration_error: number; is_overconfident: boolean; is_underconfident: boolean; details: string; suggested_interpretation?: string; probability_temperature?: number }
  type BacktestResult = { accuracy_score: number; days_tested: number; mean_absolute_error: number; direction_accuracy: number; details: string; calibration?: CalibrationResult | null }
  type SeparatedForecast = { days: { day: number; date: string; operating_in: number; operating_out: number; settlement_in: number; settlement_out: number; treasury_in: number; treasury_out: number; owner_in: number; owner_out: number }[]; operating_30d_in: number; operating_30d_out: number; settlement_30d_in: number; settlement_30d_out: number; treasury_30d_in: number; treasury_30d_out: number; owner_30d_in: number; owner_30d_out: number }
  type CashflowForecast = { period_start: string; forecast_horizon_months: number; components: CashflowComponent[]; behavioral_models: BehavioralModels; events_30d: ForecastEvent[]; daily_simulation: DailySimulation; monte_carlo: MonteCarloResult; narrative: ForecastNarrative; scenarios: ScenarioResult[]; data_span_days: number; computed_at: string; forecast_confidence?: ForecastConfidence; cash_runway?: CashRunway; sensitivity?: SensitivityAnalysis; interventions?: Intervention[]; combined_strategies?: CombinedStrategy[]; execution_suggestions?: ExecutionSuggestion[]; context?: ForecastContext; backtest?: BacktestResult | null; separated_forecast?: SeparatedForecast }
  const [forecastData, setForecastData] = useState<CashflowForecast | null>(null)
  const [forecastLoading, setForecastLoading] = useState(false)
  const [forecastError, setForecastError] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())
  const toggleSection = (key: string) => setExpandedSections((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const router = useRouter()

  const COMPANY_FORM_FIELDS: { key: string; label: string; placeholder: string }[] = [
    { key: "companyName", label: "Company name", placeholder: "e.g. Acme Inc." },
    { key: "legalName", label: "Legal name", placeholder: "Registered legal name" },
    { key: "industry", label: "Industry", placeholder: "e.g. Technology, Retail" },
    { key: "businessModel", label: "Business model", placeholder: "e.g. B2B SaaS, Marketplace" },
    { key: "productsServices", label: "Products / Services", placeholder: "What you sell or offer" },
    { key: "annualRevenue", label: "Annual revenue", placeholder: "e.g. $2M, Series A" },
    { key: "teamSize", label: "Team size", placeholder: "e.g. 15, 10-20" },
    { key: "fiscalYearEnd", label: "Fiscal year end", placeholder: "e.g. December, March 31" },
    { key: "hqLocation", label: "HQ location", placeholder: "City, State / Country" },
    { key: "fundingStage", label: "Funding stage", placeholder: "e.g. Bootstrapped, Seed, Series A" },
    { key: "primaryBanks", label: "Primary bank(s)", placeholder: "e.g. Mercury, Brex, Chase" },
    { key: "accountingSystem", label: "Accounting system", placeholder: "e.g. QuickBooks, Xero, NetSuite" },
    { key: "monthlyBurnRunway", label: "Monthly burn / runway", placeholder: "e.g. $50k burn, 18 months runway" },
    { key: "currency", label: "Currency", placeholder: "e.g. USD, EUR" },
    { key: "financeOwnerContact", label: "Key contact / finance owner", placeholder: "Name or title" },
    { key: "departmentsCostCenters", label: "Departments or cost centers", placeholder: "e.g. Engineering, Sales, G&A" },
    { key: "auditFiscalCalendar", label: "Audit / fiscal calendar", placeholder: "e.g. Audit in Q2, Board in March" },
    { key: "keyReportingDates", label: "Key reporting dates", placeholder: "e.g. Board pack by 5th, Close by 10th" },
    { key: "website", label: "Website", placeholder: "https://..." },
    { key: "yearFounded", label: "Year founded", placeholder: "e.g. 2020" },
    { key: "primaryCustomerType", label: "Primary customer type", placeholder: "e.g. SMB, Enterprise, Consumer" },
  ]

  const showQboError = qboError && QBO_ERROR_MESSAGES[qboError] && !dismissedError

  useEffect(() => {
    if (qboError) setDismissedError(false)
  }, [qboError])

  useEffect(() => {
    fetch("/api/onboarding/progress", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: currentStep }),
    }).catch(() => {})
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 1 || bankConnected || plaidLinkToken) return
    setPlaidLinkLoading(true)
    setPlaidLinkError(null)
    fetch("/api/plaid/link-token", { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error("Could not start bank connection")
        return res.json()
      })
      .then((data) => {
        if (data.link_token) setPlaidLinkToken(data.link_token)
        else throw new Error("No link token")
      })
      .catch(() => setPlaidLinkError("Bank connection is not available right now. Please try again later."))
      .finally(() => setPlaidLinkLoading(false))
  }, [currentStep, bankConnected, plaidLinkToken])

  const fetchConnectedItems = useCallback(() => {
    fetch("/api/plaid/items")
      .then((res) => (res.ok ? res.json() : { item_ids: [] }))
      .then((data: { item_ids?: string[] }) => setConnectedItemIds(data.item_ids ?? []))
      .catch(() => setConnectedItemIds([]))
    fetch("/api/plaid/balances?refresh=1")
      .then((res) => (res.ok ? res.json() : { accounts: [] }))
      .then(
        (data: {
          accounts?: {
            name: string
            mask?: string | null
            type?: string
            current_balance?: number | string | null
            available_balance?: number | string | null
          }[]
        }) =>
          setConnectedAccounts(
            (data.accounts ?? []).map((a) => ({
              name: a.name ?? "",
              mask: a.mask ?? null,
              type: a.type ?? "account",
              current_balance: a.current_balance != null ? Number(a.current_balance) : null,
              available_balance: a.available_balance != null ? Number(a.available_balance) : null,
            }))
          )
      )
      .catch(() => setConnectedAccounts([]))
  }, [])

  useEffect(() => {
    if (currentStep !== 2) return
    fetchConnectedItems()
    setAddAccountLinkLoading(true)
    setPlaidLinkError(null)
    fetch("/api/plaid/link-token", { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data?.link_token ? setAddAccountLinkToken(data.link_token) : null))
      .finally(() => setAddAccountLinkLoading(false))
  }, [currentStep, fetchConnectedItems])

  const lastAccountingSyncRef = useRef<number>(0)
  const lastRealmCountRef = useRef<number>(0)
  const lastTenantCountRef = useRef<number>(0)
  const SYNC_COOLDOWN_MS = 60_000 // 1 minute: avoid duplicate syncs and QBO 429

  const triggerAccountingSyncIfNeeded = useCallback(
    (realmIds: string[], tenantIds: string[], forceIfNewConnections: boolean) => {
      const now = Date.now()
      const cooldownOk = now - lastAccountingSyncRef.current >= SYNC_COOLDOWN_MS
      const newConnections =
        realmIds.length > lastRealmCountRef.current || tenantIds.length > lastTenantCountRef.current
      if (!cooldownOk && !(forceIfNewConnections && newConnections)) return
      lastAccountingSyncRef.current = now
      lastRealmCountRef.current = realmIds.length
      lastTenantCountRef.current = tenantIds.length
      realmIds.forEach((realmId) => {
        fetch("/api/quickbooks/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ realmId }),
        }).catch(() => {})
      })
      if (tenantIds.length > 0) {
        fetch("/api/xero/sync", { method: "POST" }).catch(() => {})
      }
    },
    []
  )

  useEffect(() => {
    if (currentStep !== 3) return
    setAccountingStepLinkLoading(true)
    setPlaidLinkError(null)
    fetch("/api/plaid/link-token", { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data?.link_token ? setAccountingStepLinkToken(data.link_token) : null))
      .finally(() => setAccountingStepLinkLoading(false))
    fetch("/api/connections")
      .then((res) => (res.ok ? res.json() : { connected: [], realmIds: [], tenantIds: [] }))
      .then((data: { connected?: string[]; realmIds?: string[]; tenantIds?: string[] }) => {
        setConnectedIntegrations(data.connected ?? [])
      })
      .catch(() => setConnectedIntegrations([]))
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 3) return
    const onFocus = () => {
      fetch("/api/connections")
        .then((res) => (res.ok ? res.json() : { connected: [], realmIds: [], tenantIds: [] }))
        .then((data: { connected?: string[]; realmIds?: string[]; tenantIds?: string[] }) => {
          setConnectedIntegrations(data.connected ?? [])
        })
        .catch(() => {})
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") onFocus()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 4) return
    fetch("/api/supermemory/status")
      .then((res) => (res.ok ? res.json() : { connected: [] }))
      .then((data: { connected?: string[] }) => setConnectedContextIntegrations(data.connected ?? []))
      .catch(() => setConnectedContextIntegrations([]))
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 4) return
    const onFocus = () => {
      fetch("/api/supermemory/status")
        .then((res) => (res.ok ? res.json() : { connected: [] }))
        .then((data: { connected?: string[] }) => setConnectedContextIntegrations(data.connected ?? []))
        .catch(() => {})
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") onFocus()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 5) return
    setWhatsappStatus(null)
    fetch("/api/whatsapp/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { phone: string | null; verified: boolean } | null) => {
        if (data) setWhatsappStatus({ phone: data.phone ?? null, verified: data.verified })
        else setWhatsappStatus({ phone: null, verified: false })
      })
      .catch(() => setWhatsappStatus({ phone: null, verified: false }))
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 6) return
    setCompanyContextError(null)
    setCompanyContextLoading(true)

    let pollInterval: ReturnType<typeof setInterval> | null = null

    const stopPolling = () => {
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
      setCompanyContextLoading(false)
    }

    fetch("/api/context/save")
      .then(async (res) => {
        if (!res.ok) return { ok: false as const, data: { finalContext: null as string | null } }
        const data = (await res.json()) as { finalContext?: string | null }
        return { ok: true as const, data }
      })
      .then((result) => {
        if (result.ok && result.data.finalContext && String(result.data.finalContext).trim()) {
          setCompanyContext(String(result.data.finalContext).trim())
          setEditedContext(null)
          stopPolling()
          return
        }
        if (!result.ok) {
          stopPolling()
          return
        }
        setCompanyContext(null)
        // No saved context: start async build and poll until ready; user gets WhatsApp when done
        return fetch("/api/context/build-and-notify", { method: "POST" })
          .then((res) => {
            if (!res.ok) throw new Error("Failed to start context build")
            return res.json()
          })
          .then(() => {
            const poll = () => {
              fetch("/api/context/save")
                .then((res) => (res.ok ? res.json() : { finalContext: null }))
                .then((data: { finalContext?: string | null }) => {
                  const ctx = data.finalContext && String(data.finalContext).trim()
                  if (ctx) {
                    setCompanyContext(ctx)
                    setEditedContext(null)
                    stopPolling()
                  }
                })
                .catch(() => {})
            }
            poll()
            pollInterval = setInterval(poll, 5000)
          })
      })
      .catch((err) => {
        if (err?.message) setCompanyContextError("We couldn't start building your context. You can try again or continue.")
        stopPolling()
      })
      .finally(() => {
        if (!pollInterval) setCompanyContextLoading(false)
      })

    return () => {
      if (pollInterval) clearInterval(pollInterval)
    }
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 7) return
    setCompanyFormLoading(true)
    fetch("/api/plaid/balances?refresh=1")
      .then((res) => (res.ok ? res.json() : { accounts: [] }))
      .then((data: { accounts?: { name?: string; mask?: string | null }[] }) => {
        const list = (data.accounts ?? []).map((a) => ({
          name: a.name ?? "Unknown",
          mask: a.mask ?? null,
        }))
        setStep7BankAccounts(list)
      })
      .catch(() => setStep7BankAccounts([]))
    fetch("/api/onboarding/company-form")
      .then((res) => (res.ok ? res.json() : { form: {} }) as Promise<{ form?: Record<string, string> }>)
      .then((savedData) => {
        const saved = savedData.form ?? {}
        const hasSaved = Object.keys(saved).some((k) => String(saved[k] ?? "").trim())
        if (hasSaved) {
          setCompanyForm(saved)
          setCompanyFormLoading(false)
          return
        }
        return fetch("/api/onboarding/company-form/autofill", { method: "POST" })
          .then((res) => res.json())
          .then((data: { form?: Record<string, string> }) => {
            const autofillForm = data.form ?? {}
            setCompanyForm({ ...autofillForm, ...saved })
          })
          .catch(() => setCompanyForm(saved))
      })
      .finally(() => setCompanyFormLoading(false))
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 8) return
    setRawDataLoading(true)
    setRawDataError(null)
    fetch("/api/raw-data")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((data: RawDataResponse) => setRawData(data))
      .catch((err) => {
        setRawData(null)
        setRawDataError(err instanceof Error ? err.message : "Failed to load raw data")
      })
      .finally(() => setRawDataLoading(false))
  }, [currentStep])

  useEffect(() => {
    if (currentStep !== 9) return
    let cancelled = false

    setIdentityLoading(true)
    setIdentityError(null)

    // Try loading existing identity data first
    fetch("/api/identity")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((data: IdentityData) => {
        if (cancelled) return
        if (data.entities.length > 0) {
          setIdentityData(data)
          setIdentityLoading(false)
          setIdentitySeeding(false)
          return
        }

        // No entities yet — trigger seed and poll
        setIdentitySeeding(true)
        setIdentityLoading(false)
        fetch("/api/identity/seed", { method: "POST" }).catch(() => {})

        let attempts = 0
        const maxAttempts = 30
        const poll = () => {
          if (cancelled) return
          attempts++
          fetch("/api/identity")
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
            .then((d: IdentityData) => {
              if (cancelled) return
              if (d.entities.length > 0) {
                setIdentityData(d)
                setIdentitySeeding(false)
              } else if (attempts < maxAttempts) {
                setTimeout(poll, 3000)
              } else {
                setIdentitySeeding(false)
              }
            })
            .catch(() => { if (!cancelled && attempts < maxAttempts) setTimeout(poll, 3000) })
        }
        setTimeout(poll, 2000)
      })
      .catch((err) => {
        if (cancelled) return
        setIdentityError(err instanceof Error ? err.message : "Failed to load identity graph")
        setIdentityLoading(false)
      })

    return () => { cancelled = true }
  }, [currentStep])

  // Step 10: Money movements
  useEffect(() => {
    if (currentStep !== 10) return
    let cancelled = false

    setMovementsLoading(true)
    setMovementsError(null)

    fetch("/api/movements")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((data: MovementsData) => {
        if (cancelled) return
        if (data.movements.length > 0) {
          setMovementsData(data)
          setMovementsLoading(false)
          setMovementsClassifying(false)
          // Run tagging in background if no tag-based summary yet (ensures accurate counts)
          if (!data.summary_from_tags) {
            fetch("/api/movements/tag", { method: "POST" })
              .then((res) => (res.ok ? fetch("/api/movements") : null))
              .then((r) => (r && r.ok ? r.json() : null))
              .then((d: MovementsData | null) => { if (!cancelled && d) setMovementsData(d) })
              .catch(() => {})
          }
          return
        }

        setMovementsClassifying(true)
        setMovementsLoading(false)
        fetch("/api/movements/classify", { method: "POST" }).catch(() => {})

        let attempts = 0
        const maxAttempts = 40
        const poll = () => {
          if (cancelled) return
          attempts++
          fetch("/api/movements")
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
            .then((d: MovementsData) => {
              if (cancelled) return
              if (d.movements.length > 0) {
                setMovementsData(d)
                setMovementsClassifying(false)
              } else if (attempts < maxAttempts) {
                setTimeout(poll, 3000)
              } else {
                setMovementsClassifying(false)
              }
            })
            .catch(() => { if (!cancelled && attempts < maxAttempts) setTimeout(poll, 3000) })
        }
        setTimeout(poll, 3000)
      })
      .catch((err) => {
        if (cancelled) return
        setMovementsError(err instanceof Error ? err.message : "Failed to load movements")
        setMovementsLoading(false)
      })

    return () => { cancelled = true }
  }, [currentStep])

  // Step 11: AR/AP & reconciliation — fetch reconciliation first (creates allocations), then AR/AP
  useEffect(() => {
    if (currentStep !== 11) return
    let cancelled = false

    setArApLoading(true)
    setArApError(null)
    setArApData(null)
    setMappingLoading(true)
    setMappingError(null)
    setMappingArAp(null)
    setMappingRecon(null)

    const pollReconciliation = (): Promise<Record<string, unknown>> =>
      fetch("/api/ar-ap-reconciliation")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Reconciliation failed"))))
        .then((data: Record<string, unknown>) => {
          if (cancelled) return Promise.reject(new Error("Cancelled"))
          if (data.status === "processing") {
            return new Promise<Record<string, unknown>>((resolve, reject) => {
              setTimeout(() => {
                if (cancelled) return reject(new Error("Cancelled"))
                pollReconciliation().then(resolve).catch(reject)
              }, 2500)
            })
          }
          return data
        })

    pollReconciliation()
      .then((reconData) => {
        if (cancelled) return
        setMappingRecon(reconData)
        setMappingLoading(false)
        return fetch("/api/ar-ap").then((r) => (r.ok ? r.json() : Promise.reject(new Error("AR/AP failed"))))
      })
      .then((arApData) => {
        if (cancelled) return
        setArApData(arApData)
        setMappingArAp(arApData)
        setArApLoading(false)
      })
      .catch((e) => {
        if (cancelled || (e instanceof Error && e.message === "Cancelled")) return
        const msg = e instanceof Error ? e.message : "Failed to load"
        setMappingError(msg)
        setArApError(msg)
        setArApLoading(false)
        setMappingLoading(false)
      })

    return () => { cancelled = true }
  }, [currentStep])

  // Step 12: State objects (computed from frozen tags)
  useEffect(() => {
    if (currentStep !== 12) return
    let cancelled = false

    setStateLoading(true)
    setStateError(null)
    setStateData(null)

    fetch("/api/state")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((data: BusinessState) => {
        if (cancelled) return
        setStateData(data)
        setStateLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setStateError(err instanceof Error ? err.message : "Failed to load state")
        setStateLoading(false)
      })

    return () => { cancelled = true }
  }, [currentStep])

  // Step 13 & 14: Cashflow forecast + Decisions (share forecast data)
  useEffect(() => {
    if (currentStep !== 13 && currentStep !== 14) return
    let cancelled = false

    setForecastLoading(true)
    setForecastError(null)
    setForecastData(null)

    fetch("/api/forecast")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((data: CashflowForecast) => {
        if (cancelled) return
        setForecastData(data)
        setForecastLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setForecastError(err instanceof Error ? err.message : "Failed to load forecast")
        setForecastLoading(false)
      })

    return () => { cancelled = true }
  }, [currentStep])

  const onPlaidSuccess = useCallback(
    async (publicToken: string) => {
      try {
        const res = await fetch("/api/plaid/exchange-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token: publicToken }),
        })
        if (!res.ok) throw new Error("Exchange failed")
        const data = (await res.json()) as { item_id?: string }
        if (data.item_id) {
          fetch("/api/plaid/transactions-sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ item_id: data.item_id }),
          }).catch(() => {})
        }
        setBankConnected(true)
        if (currentStep === 1) {
          setCurrentStep(2)
        }
        fetchConnectedItems()
      } catch {
        setPlaidLinkError("Connection succeeded but we couldn't save it. Please try again.")
      }
    },
    [currentStep, fetchConnectedItems]
  )

  const plaidToken =
    currentStep === 1
      ? plaidLinkToken
      : currentStep === 2
        ? addAccountLinkToken
        : accountingStepLinkToken
  const { open: openPlaidLink, ready: plaidReady } = usePlaidLink({
    token: plaidToken,
    onSuccess: onPlaidSuccess,
    onExit: (err) => {
      if (err) setPlaidLinkError(err?.error_message ?? "Connection was cancelled.")
    },
  })

  const handleConnectBank = () => {
    if (bankConnected || !plaidReady) return
    openPlaidLink()
  }

  const handleAddAnotherAccount = () => {
    if (!plaidReady) return
    openPlaidLink()
  }

  const handleNext = () => {
    if (currentStep < steps.length) {
      setCurrentStep(currentStep + 1)
    }
  }

  const handleNextOrFinish = () => {
    if (currentStep === 6) {
      const toSave = (editedContext ?? companyContext ?? "").trim()
      if (toSave) {
        fetch("/api/context/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ finalContext: toSave }),
        }).finally(() => handleNext())
      } else {
        handleNext()
      }
    } else if (currentStep === 7) {
      fetch("/api/onboarding/company-form", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ form: companyForm }),
      }).finally(() => handleNext())
    } else if (currentStep === 9) {
      setAfterIdentityLoading(true)
      setIdentityError(null)
      fetch("/api/onboarding/after-identity", { method: "POST" })
        .then((res) => {
          if (res.status === 202) return res.json()
          if (res.ok) return res.json()
          throw new Error(res.statusText)
        })
        .then((data) => {
          // 202 = classification running in background; poll until done
          if (data?.status === "classifying") {
            const start = Date.now()
            const poll = () => {
              fetch("/api/movements")
                .then((r) => r.ok ? r.json() : null)
                .then((d: { summary_from_tags?: unknown; movements?: unknown[] } | null) => {
                  const elapsed = Date.now() - start
                  const hasTags = d?.summary_from_tags != null
                  if (hasTags || elapsed > 120_000) {
                    handleNext()
                    setAfterIdentityLoading(false)
                    return
                  }
                  setTimeout(poll, 3000)
                })
                .catch(() => {
                  if (Date.now() - start > 120_000) {
                    handleNext()
                    setAfterIdentityLoading(false)
                  } else {
                    setTimeout(poll, 3000)
                  }
                })
            }
            poll()
          } else {
            handleNext()
            setAfterIdentityLoading(false)
          }
        })
        .catch(() => {
          setIdentityError("Failed to sync and tag. Please try again.")
          setAfterIdentityLoading(false)
        })
    } else if (currentStep >= steps.length) {
      router.push("/dashboard")
    } else {
      handleNext()
    }
  }

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1)
    }
  }

  const toggleIntegration = (name: string) => {
    const integrationSlug = name.toLowerCase().replace(/\s+/g, "-")
    router.push(`/oauth/${integrationSlug}`)
  }

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="my-0 py-9">
            <div className="flex flex-col items-center">
              <h2 className="text-3xl font-bold text-white mb-2 text-center">Connect Your Bank Account</h2>
              <p className="text-gray-300 text-center max-w-lg">{""}</p>
            </div>

            <div>
              <h3 className="text-center text-sm font-semibold text-gray-300 uppercase tracking-wider my-0 py-1.5">
                Trusted by users from leading financial institutions
              </h3>

              <div className="relative overflow-hidden py-3 my-9">
                <style jsx>{`
                  @keyframes scroll {
                    0% {
                      transform: translateX(0);
                    }
                    100% {
                      transform: translateX(-50%);
                    }
                  }
                  .animate-scroll {
                    animation: scroll 14s linear infinite;
                  }
                `}</style>
                <div className="flex animate-scroll">
                  {/* First set of banks */}
                  {[
                    { name: "Chase", logo: "/chase-logo.png" },
                    { name: "Bank of America", logo: "/bofa-logo.png" },
                    { name: "Wells Fargo", logo: "/wells-fargo-logo.png" },
                    { name: "Citibank", logo: "/citibank-logo.png" },
                    { name: "Capital One", logo: "/capital-one-logo.png" },
                    { name: "PNC Bank", logo: "/pnc-logo.png" },
                    { name: "US Bank", logo: "/us-bank-logo.png" },
                    { name: "TD Bank", logo: "/td-bank-logo.png" },
                    { name: "Truist Bank", logo: "/truist-logo.png" },
                    { name: "HSBC", logo: "/hsbc-logo.png" },
                    { name: "Goldman Sachs", logo: "/goldman-sachs-logo.jpg" },
                    { name: "Morgan Stanley", logo: "/morgan-stanley-logo.jpg" },
                    { name: "American Express", logo: "/amex-logo.jpg" },
                    { name: "Discover", logo: "/discover-logo.jpg" },
                    { name: "Ally Bank", logo: "/ally-logo.jpg" },
                    { name: "Charles Schwab", logo: "/schwab-logo.jpg" },
                    { name: "Barclays", logo: "/barclays-logo.jpg" },
                    { name: "Santander", logo: "/santander-logo.jpg" },
                    { name: "Citizens Bank", logo: "/citizens-logo.jpg" },
                    { name: "Fifth Third Bank", logo: "/fifth-third-logo.jpg" },
                    { name: "KeyBank", logo: "/keybank-logo.jpg" },
                    { name: "Regions Bank", logo: "/regions-logo.jpg" },
                    { name: "M&T Bank", logo: "/mt-bank-logo.jpg" },
                    { name: "Navy Federal Credit Union", logo: "/navy-federal-logo.jpg" },
                    { name: "BMO Harris", logo: "/bmo-logo.jpg" },
                    { name: "USAA", logo: "/usaa-logo.jpg" },
                    { name: "SunTrust", logo: "/suntrust-logo.jpg" },
                    { name: "Huntington Bank", logo: "/huntington-logo.jpg" },
                  ].map((bank, index) => (
                    <div
                      key={`${bank.name}-1-${index}`}
                      className="bg-white/5 backdrop-blur-sm border-white/10 p-5 transition-all duration-300 flex-shrink-0 w-36 h-36 flex items-center justify-center group shadow-none opacity-100 mx-2.5 gap-0 flex-col border-0 rounded-lg"
                    >
                      <div className="w-24 h-24 mb-2 flex items-center justify-center">
                        <Image
                          src={bank.logo || "/placeholder.svg"}
                          alt={`${bank.name} logo`}
                          width={96}
                          height={96}
                          className="object-contain max-w-full max-h-full"
                        />
                      </div>
                      <span className="text-white text-xs font-medium text-center leading-tight">{bank.name}</span>
                    </div>
                  ))}
                  {/* Duplicate set for seamless loop */}
                  {[
                    { name: "Chase", logo: "/chase-logo.png" },
                    { name: "Bank of America", logo: "/bofa-logo.png" },
                    { name: "Wells Fargo", logo: "/wells-fargo-logo.png" },
                    { name: "Citibank", logo: "/citibank-logo.png" },
                    { name: "Capital One", logo: "/capital-one-logo.png" },
                    { name: "PNC Bank", logo: "/pnc-logo.png" },
                    { name: "US Bank", logo: "/us-bank-logo.png" },
                    { name: "TD Bank", logo: "/td-bank-logo.png" },
                    { name: "Truist Bank", logo: "/truist-logo.png" },
                    { name: "HSBC", logo: "/hsbc-logo.png" },
                    { name: "Goldman Sachs", logo: "/goldman-sachs-logo.jpg" },
                    { name: "Morgan Stanley", logo: "/morgan-stanley-logo.jpg" },
                    { name: "American Express", logo: "/amex-logo.jpg" },
                    { name: "Discover", logo: "/discover-logo.jpg" },
                    { name: "Ally Bank", logo: "/ally-logo.jpg" },
                    { name: "Charles Schwab", logo: "/schwab-logo.jpg" },
                    { name: "Barclays", logo: "/barclays-logo.jpg" },
                    { name: "Santander", logo: "/santander-logo.jpg" },
                    { name: "Citizens Bank", logo: "/citizens-logo.jpg" },
                    { name: "Fifth Third Bank", logo: "/fifth-third-logo.jpg" },
                    { name: "KeyBank", logo: "/keybank-logo.jpg" },
                    { name: "Regions Bank", logo: "/regions-logo.jpg" },
                    { name: "M&T Bank", logo: "/mt-bank-logo.jpg" },
                    { name: "Navy Federal Credit Union", logo: "/navy-federal-logo.jpg" },
                    { name: "BMO Harris", logo: "/bmo-logo.jpg" },
                    { name: "USAA", logo: "/usaa-logo.jpg" },
                    { name: "SunTrust", logo: "/suntrust-logo.jpg" },
                    { name: "Huntington Bank", logo: "/huntington-logo.jpg" },
                  ].map((bank, index) => (
                    <div
                      key={`${bank.name}-2-${index}`}
                      className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl p-5 transition-all duration-300 flex-shrink-0 w-36 h-36 flex flex-col items-center justify-center mx-3 group"
                    >
                      <div className="w-24 h-24 mb-2 flex items-center justify-center">
                        <Image
                          src={bank.logo || "/placeholder.svg"}
                          alt={`${bank.name} logo`}
                          width={96}
                          height={96}
                          className="object-contain max-w-full max-h-full"
                        />
                      </div>
                      <span className="text-white text-xs font-medium text-center leading-tight">{bank.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="max-w-md mx-auto">
              {plaidLinkError && (
                <p className="text-sm text-red-400 text-center mb-3">{plaidLinkError}</p>
              )}
              <Button
                type="button"
                onClick={handleConnectBank}
                disabled={bankConnected || plaidLinkLoading || !plaidReady}
                className="w-full bg-white hover:bg-gray-100 text-black font-semibold text-base shadow-lg shadow-white/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none transition-all h-14"
              >
                {bankConnected ? (
                  <span className="flex items-center gap-2">
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Connected Successfully
                  </span>
                ) : plaidLinkLoading ? (
                  "Loading..."
                ) : (
                  "Connect Your Bank Securely"
                )}
              </Button>
              <p className="text-xs text-center text-gray-500 leading-relaxed my-3.5 mt-6 mb-7">
                By connecting, you agree to our{" "}
                <a href="#" className="hover:text-emerald-300 underline text-foreground">
                  Terms of Service
                </a>{" "}
                and{" "}
                <a href="#" className="hover:text-emerald-300 underline text-foreground">
                  Privacy Policy
                </a>
                . Your data is always encrypted and secure.
              </p>
            </div>
          </div>
        )

      case 2: {
        const totalBalance = connectedAccounts.reduce(
          (sum, a) => sum + (a.current_balance != null && !Number.isNaN(a.current_balance) ? a.current_balance : 0),
          0
        )
        const hasAccounts = connectedAccounts.length > 0
        const hasItemsOnly = !hasAccounts && connectedItemIds.length > 0
        return (
          <div className="my-0 py-9">
            <div className="flex flex-col items-center mb-6">
              <h2 className="text-3xl font-bold text-white mb-2 text-center tracking-tight">
                Your bank accounts
              </h2>
              <p className="text-gray-400 text-center max-w-lg text-base">
                View balances in the table below. Add more accounts or continue when you’re ready.
              </p>
            </div>
            <div className="max-w-4xl mx-auto space-y-4">
              {hasAccounts ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {connectedAccounts.map((acc, i) => (
                      <div
                        key={`${acc.name}-${acc.mask ?? i}`}
                        className="rounded-2xl border border-white/15 bg-white/5 p-4 flex flex-col justify-between h-40"
                      >
                        <div>
                          <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                            Bank account
                          </p>
                          <p className="text-white font-semibold text-base truncate">
                            {acc.name}
                          </p>
                          <p className="text-gray-400 text-xs mt-1">
                            {acc.type || "—"} {acc.mask ? `•••• ${acc.mask}` : ""}
                          </p>
                        </div>
                        <div className="mt-3 flex items-end justify-between">
                          <div>
                            <p className="text-xs text-gray-400">Current balance</p>
                            <p className="text-white font-semibold text-lg">
                              {formatBalance(acc.current_balance)}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-gray-500">Available</p>
                            <p className="text-gray-300 text-sm">
                              {formatBalance(acc.available_balance)}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={handleAddAnotherAccount}
                      disabled={addAccountLinkLoading || !plaidReady}
                      className="rounded-2xl border border-dashed border-white/25 text-gray-300 hover:border-white/60 hover:bg-white/5 transition-colors flex flex-col items-center justify-center h-40"
                    >
                      <div className="w-12 h-12 rounded-2xl border border-white/40 flex items-center justify-center text-2xl font-semibold mb-2">
                        +
                      </div>
                      <span className="text-sm font-medium text-white">
                        Add another bank account
                      </span>
                      <span className="text-xs text-gray-400 mt-1">
                        Link a new account with Plaid
                      </span>
                    </button>
                  </div>
                  {hasAccounts && (
                    <div className="mt-2 flex justify-end">
                      <p className="text-sm text-gray-300">
                        Total across connected accounts:{" "}
                        <span className="font-semibold text-white">
                          {formatBalance(totalBalance)}
                        </span>
                      </p>
                    </div>
                  )}
                </>
              ) : hasItemsOnly ? (
                <div className="rounded-lg border border-white/20 bg-white/5 p-4">
                  <p className="text-sm font-medium text-white mb-2">Connected</p>
                  <p className="text-gray-400 text-sm">
                    {connectedItemIds.length} account{connectedItemIds.length !== 1 ? "s" : ""} linked. Balances will appear in the table once synced.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-6">No accounts loaded yet.</p>
              )}
              {plaidLinkError && (
                <p className="text-sm text-red-400 rounded-lg bg-red-500/10 px-3 py-2">
                  {plaidLinkError}
                </p>
              )}
            </div>
          </div>
        )
      }

      case 3:
        return (
          <div>
            <div className="text-center mb-8">
              <h2 className="text-2xl font-semibold text-white mb-3">
                Connect your accounting institution
              </h2>
              <p className="text-gray-400 text-base">
                Choose the accounting or spend platform you currently use with your business.
              </p>
            </div>

            {plaidLinkError && (
              <p className="text-sm text-red-400 text-center mb-4">{plaidLinkError}</p>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-8 max-w-2xl mx-auto">
              {integrations.map((integration) => {
                const usePlaid = PLAID_INTEGRATIONS.includes(integration.name)
                const isStripe = integration.name === "Stripe"
                const plaidDisabled = usePlaid && (accountingStepLinkLoading || !plaidReady)
                const isConnected = connectedIntegrations.includes(integration.name)
                return (
                  <button
                    key={integration.name}
                    type="button"
                    onClick={() => {
                      if (usePlaid) {
                        openPlaidLink()
                      } else if (isStripe) {
                        window.location.href = "/oauth/stripe"
                      } else {
                        toggleIntegration(integration.name)
                      }
                    }}
                    disabled={plaidDisabled}
                    className={`relative rounded-lg p-5 text-center transition-all flex flex-col items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${
                      isConnected
                        ? "bg-emerald-500/10 border-2 border-emerald-500/50 hover:border-emerald-500/70 hover:bg-emerald-500/15"
                        : "bg-white/5 border border-white/10 hover:border-white/30 hover:bg-white/10"
                    }`}
                  >
                    {isConnected && (
                      <span className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </span>
                    )}
                    <div className="w-28 h-28 mb-4 flex items-center justify-center">
                      <Image
                        src={integration.logo || "/placeholder.svg"}
                        alt={`${integration.name} logo`}
                        width={120}
                        height={120}
                        className="object-contain max-w-full max-h-full"
              />
            </div>
                    <h3 className="text-white font-semibold text-sm leading-tight">
                      {integration.name}
                    </h3>
                    {integration.description && (
                      <p className="text-[11px] text-gray-400 mt-1">{integration.description}</p>
                    )}
                    {isConnected ? (
                      <span className="text-xs font-medium text-emerald-400 mt-1">Connected</span>
                    ) : usePlaid && accountingStepLinkLoading ? (
                      <span className="text-xs text-gray-400 mt-1">Loading...</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        )

      case 4:
        return (
          <div>
            <div className="text-center mb-8">
              <h2 className="text-2xl font-semibold text-white mb-3">Connect documents & drives</h2>
              <p className="text-gray-400 text-base">
                Link where your contracts, invoices, and docs live so we can better understand your business.
              </p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-8 max-w-2xl mx-auto">
              {[
                { name: "Google Drive", logo: "/google-drive-logo.png" },
                { name: "OneDrive", logo: "/onedrive-logo.png" },
                { name: "Notion", logo: "/notion-logo.png" },
              ].map((integration) => {
                const isConnected = connectedContextIntegrations.includes(integration.name)
                return (
                  <button
                    key={integration.name}
                    type="button"
                    onClick={() => toggleIntegration(integration.name)}
                    className={`relative rounded-lg p-5 text-center transition-all flex flex-col items-center justify-center hover:border-white/30 hover:bg-white/10 ${
                      isConnected
                        ? "bg-emerald-500/10 border-2 border-emerald-500/50 hover:border-emerald-500/70 hover:bg-emerald-500/15"
                        : "bg-white/5 border border-white/10"
                    }`}
                  >
                    {isConnected && (
                      <span className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </span>
                    )}
                  <div className="w-28 h-28 mb-4 flex items-center justify-center">
                      <Image
                        src={integration.logo || "/placeholder.svg"}
                        alt={`${integration.name} logo`}
                      width={120}
                      height={120}
                        className="object-contain max-w-full max-h-full"
                      />
                    </div>
                    <h3 className="text-white font-semibold text-sm leading-tight">{integration.name}</h3>
                    {isConnected && (
                      <span className="text-xs font-medium text-emerald-400 mt-1">Connected</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )

      case 5:
        return (
              <div>
            <div className="text-center mb-6">
              <h2 className="text-2xl font-semibold text-white mb-3">Choose your communication channels</h2>
              <p className="text-gray-400 text-base">
                Add your WhatsApp number to chat with ProfitWise and get answers using your company context. We’ll send a code to verify it.
              </p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-10 max-w-2xl mx-auto">
              {/* WhatsApp now opens dedicated setup page */}
              <button
                type="button"
                onClick={() => toggleIntegration("WhatsApp")}
                className="bg-white/5 border border-white/10 rounded-lg p-5 text-center transition-all flex flex-col items-center justify-center hover:border-white/30 hover:bg-white/10 min-h-[200px]"
              >
                <div className="w-20 h-20 mb-3 flex items-center justify-center">
                  <Image
                    src="/whatsapp-logo.png"
                    alt="WhatsApp"
                    width={80}
                    height={80}
                    className="object-contain max-w-full max-h-full"
                />
              </div>
                <h3 className="text-white font-semibold text-sm leading-tight mb-1">WhatsApp</h3>
                {whatsappStatus?.verified && whatsappStatus.phone ? null : null}
              </button>

              {[
                { name: "Slack", logo: "/slack-logo.png" },
                { name: "Gmail", logo: "/gmail-logo.png" },
              ].map((channel) => (
                <button
                  key={channel.name}
                  type="button"
                  onClick={() => toggleIntegration(channel.name)}
                  className="bg-white/5 border border-white/10 rounded-lg p-5 text-center transition-all flex flex-col items-center justify-center hover:border-white/30 hover:bg-white/10 min-h-[200px]"
                >
                  <div className="w-20 h-20 mb-3 flex items-center justify-center">
                    <Image
                      src={channel.logo || "/placeholder.svg"}
                      alt={`${channel.name} logo`}
                      width={80}
                      height={80}
                      className="object-contain max-w-full max-h-full"
                />
              </div>
                  <h3 className="text-white font-semibold text-sm leading-tight">{channel.name}</h3>
                </button>
              ))}
            </div>
          </div>
        )

      case 6:
        if (companyContextLoading) {
          return (
            <div className="py-12 flex flex-col items-center justify-center text-center max-w-lg mx-auto">
              <h2 className="text-2xl font-semibold text-white mb-3">Building your company and financial context</h2>
              <p className="text-gray-400 text-base mb-8">
                We’re combining your business docs with expenses and vendors from the last 60 days. We’ll notify you on WhatsApp when it’s ready. You can wait here or come back later.
              </p>
              <div className="flex flex-col items-center gap-4">
                <div className="h-10 w-10 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                <p className="text-sm text-gray-500">Mapping business and financial context with AI…</p>
              </div>
            </div>
          )
        }
        if (companyContextError) {
          return (
            <div className="py-12 text-center max-w-lg mx-auto">
              <h2 className="text-2xl font-semibold text-white mb-3">Company and financial context</h2>
              <p className="text-gray-400 text-base mb-4">{steps[5].description}</p>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-200 text-sm mb-6">
                {companyContextError}
              </div>
              <p className="text-gray-500 text-sm">You can continue to the next step.</p>
            </div>
          )
        }
        const currentCtx = companyContext ?? ""
        const editedCtx = editedContext ?? ""
        const hasEdited = editedCtx.length > 0
        const runRefine = () => {
          const base = editedCtx || currentCtx
          if (!refineInput.trim() || !base) return
          const message =
            contextSelection.text.trim()
              ? `Selected text: "${contextSelection.text.slice(0, 500)}${contextSelection.text.length > 500 ? "…" : ""}". User instruction: ${refineInput.trim()}`
              : refineInput.trim()
          setRefineLoading(true)
          fetch("/api/context/final", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentFinalContext: base, userMessage: message }),
          })
            .then((res) => {
              if (!res.ok) throw new Error("Refine failed")
              return res.json()
            })
            .then((data: { finalContext?: string }) => {
              if (data.finalContext != null) setEditedContext(data.finalContext)
              setRefineInput("")
              setContextSelection({ start: 0, end: 0, text: "" })
            })
            .catch(() => {})
            .finally(() => setRefineLoading(false))
        }
        const acceptChanges = () => {
          if (!editedCtx.trim()) return
          setCompanyContext(editedCtx)
          setEditedContext(null)
        }
        return (
          <div className="py-2 flex flex-col w-full">
            <div className="grid grid-cols-2 gap-5 h-[68vh] min-h-[420px]">
              <div className="flex flex-col rounded-2xl border border-white/15 bg-white/[0.07] overflow-hidden shadow-xl min-h-0">
                <div className="px-5 py-3 border-b border-white/15 shrink-0">
                  <h3 className="text-base font-semibold text-white">Your current context</h3>
                    <p className="text-gray-400 text-sm mt-0.5">Saved when you click Finish below</p>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-5">
                  <p className="text-gray-200 text-base leading-relaxed whitespace-pre-wrap font-sans">
                    {currentCtx || "No context yet. Refine below, then Accept changes to move your edit here. Click Finish to save and go to the next step."}
                  </p>
                </div>
              </div>
              <div className="flex flex-col rounded-2xl border border-white/15 bg-white/[0.07] overflow-hidden shadow-xl min-h-0">
                <div className="px-5 py-3 border-b border-white/15 flex items-center justify-between gap-3 shrink-0">
              <div>
                    <h3 className="text-base font-semibold text-white">Edited context</h3>
                    <p className="text-gray-400 text-sm mt-0.5">Appears here after you refine</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={acceptChanges}
                    disabled={!hasEdited}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg px-4 py-2 shrink-0"
                  >
                    Accept changes
                  </Button>
                </div>
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                  {hasEdited ? (
                    <textarea
                      value={editedCtx}
                      onChange={(e) => setEditedContext(e.target.value)}
                      onSelect={(e) => {
                        const ta = e.target as HTMLTextAreaElement
                        setContextSelection({
                          start: ta.selectionStart,
                          end: ta.selectionEnd,
                          text: ta.value.slice(ta.selectionStart, ta.selectionEnd),
                        })
                      }}
                      placeholder="Your edited context appears here after Refine."
                      className="flex-1 w-full min-h-0 p-5 text-base text-gray-200 bg-transparent border-0 resize-none focus:outline-none focus:ring-0 placeholder:text-gray-500 leading-relaxed overflow-y-auto"
                      spellCheck={false}
                    />
                  ) : (
                    <div className="flex-1 flex items-center justify-center p-8 text-center overflow-y-auto min-h-0">
                      <p className="text-gray-500 text-base max-w-sm">
                        Refine with the AI bar below to see your edited version here. Accept changes moves it to the left; Finish saves (one context) and goes to the next step.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-center">
              <div className="flex-1 max-w-2xl flex items-center rounded-full bg-white/[0.07] border border-white/15 px-5 py-3 focus-within:border-white/25 focus-within:ring-1 focus-within:ring-white/20 shadow-lg">
                <input
                  type="text"
                  value={refineInput}
                  onChange={(e) => setRefineInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      runRefine()
                    }
                  }}
                  placeholder={contextSelection.text ? "e.g. Simplify this / Fix typo / Make it shorter" : "e.g. Add that we use NetSuite for ERP"}
                  disabled={refineLoading || !currentCtx}
                  className="flex-1 min-w-0 bg-transparent text-white placeholder:text-gray-500 text-base focus:outline-none"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={refineLoading || !refineInput.trim() || !currentCtx}
                  onClick={runRefine}
                  className="rounded-full bg-white text-black hover:bg-gray-200 font-medium shrink-0 px-5 py-2"
                >
                  {refineLoading ? "Refining…" : "Refine"}
                </Button>
              </div>
            </div>
            {contextSelection.text ? (
              <p className="text-sm text-gray-500 mt-2 text-center">
                Selection will be sent with your instruction so the AI can change text around that region.
              </p>
            ) : null}
          </div>
        )

      case 7: {
        if (companyFormLoading) {
          return (
            <div className="py-12 flex flex-col items-center justify-center text-center max-w-md mx-auto">
              <div className="h-10 w-10 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              <p className="text-white font-medium mt-4">Preparing your company form</p>
              <p className="text-gray-400 text-sm mt-1">Using your connected data to prefill the form…</p>
            </div>
          )
        }
        return (
          <div className="pt-0 pb-2 max-w-2xl mx-auto">
            <h2 className="text-3xl font-bold tracking-tight text-white mb-2">{steps[6].title}</h2>
            <p className="text-gray-400 text-lg mb-5">{steps[6].description}</p>
            <div className="flex flex-wrap gap-3 mb-5">
              <Button
                type="button"
                variant="outline"
                disabled={companyFormAutofillLoading}
                onClick={() => {
                  setCompanyFormAutofillLoading(true)
                  fetch("/api/onboarding/company-form/autofill", { method: "POST" })
                    .then((res) => res.json())
                    .then((data: { form?: Record<string, string>; error?: string }) => {
                      if (data.form) setCompanyForm((prev) => ({ ...prev, ...data.form }))
                    })
                    .catch(() => {})
                    .finally(() => setCompanyFormAutofillLoading(false))
                }}
                className="bg-white/5 border-white/20 text-white hover:bg-white/10 text-base h-10 px-5"
              >
                {companyFormAutofillLoading ? "Filling…" : "Auto-fill from context"}
              </Button>
              <Button
                type="button"
                disabled={companyFormSaveLoading}
                onClick={() => {
                  setCompanyFormSaveLoading(true)
                  fetch("/api/onboarding/company-form", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ form: companyForm }),
                  })
                    .then((res) => res.ok ? res.json() : Promise.reject(new Error("Save failed")))
                    .catch(() => {})
                    .finally(() => setCompanyFormSaveLoading(false))
                }}
                className="bg-white text-black hover:bg-gray-200 text-base font-medium h-10 px-5"
              >
                {companyFormSaveLoading ? "Saving…" : "Save"}
              </Button>
            </div>
            <div className="space-y-5">
              {COMPANY_FORM_FIELDS.map(({ key, label, placeholder }) => {
                if (key === "primaryBanks" && step7BankAccounts.length > 0) {
                  const selected = (companyForm.primaryBanks ?? "").split(",").map((s) => s.trim()).filter(Boolean)
                  const toggle = (accountLabel: string) => {
                    const next = selected.includes(accountLabel)
                      ? selected.filter((s) => s !== accountLabel)
                      : [...selected, accountLabel]
                    setCompanyForm((prev) => ({ ...prev, primaryBanks: next.join(", ") }))
                  }
                  return (
                    <div key={key}>
                      <label className="block text-base font-semibold text-gray-200 mb-2">{label}</label>
                      <div className="flex flex-wrap gap-3">
                        {step7BankAccounts.map((acc) => {
                          const label = acc.mask ? `${acc.name} (••${acc.mask})` : acc.name
                          const checked = selected.includes(label)
                          return (
                            <label
                              key={label}
                              className="flex items-center gap-2.5 cursor-pointer rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 hover:bg-white/10 transition-colors"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggle(label)}
                                className="rounded border-white/30 text-white focus:ring-2 focus:ring-white/40 w-4 h-4"
                              />
                              <span className="text-base text-gray-200">{label}</span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={key}>
                    <label className="block text-base font-semibold text-gray-200 mb-2">{label}</label>
                <Input
                      value={companyForm[key] ?? ""}
                      onChange={(e) => setCompanyForm((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder={placeholder}
                      className="bg-white/5 border-white/20 text-white placeholder:text-gray-500 text-base h-11 px-4"
                />
              </div>
                )
              })}
            </div>
            <p className="text-base text-gray-500 mt-4">
              Form is prefilled from your connected data and recent activity. Edit any field; click Finish to save the final
              version.
            </p>
          </div>
        )
      }

      case 8: {
        const plaidTxns = Array.isArray(rawData?.plaid.transactions) ? rawData?.plaid.transactions ?? [] : []
        const plaidAccounts = Array.isArray(rawData?.plaid.accounts) ? rawData?.plaid.accounts ?? [] : []
        const qboEntities = rawData?.qbo ?? {}
        const xeroEntities = rawData?.xero ?? {}
        const stripeEntities = rawData?.stripe ?? {}
        const gmailExtracts = rawData?.gmail.extracted ?? []

        // New Step 8: raw data review only. Old tagging UI below is now unreachable.
        if (true) {
          return (
            <div className="pt-0 pb-2 w-full">
              <h2 className="text-3xl font-bold tracking-tight text-white mb-2">{steps[7].title}</h2>
              <p className="text-gray-400 text-lg mb-5">{steps[7].description}</p>

              {rawDataLoading && (
                <div className="flex items-center gap-2 py-6 text-gray-400">
                  <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Loading raw data…
                </div>
              )}

              {rawDataError && !rawDataLoading && (
                <p className="text-red-300 text-sm mb-4">Failed to load raw data: {rawDataError}</p>
              )}

              {!rawDataLoading && !rawData && !rawDataError && (
                <p className="text-gray-400 text-sm mb-4">
                  No raw data found yet. Connect integrations and run syncs to see data here.
                </p>
              )}

              {rawData && (
                <div className="space-y-6">
                  <div className="rounded-xl border border-white/20 bg-white/5 p-4">
                    <h3 className="text-lg font-semibold text-white mb-2">
                      Plaid — Bank transactions (last 2 years)
                    </h3>
                    <p className="text-gray-400 text-sm mb-3">
                      Showing up to 200 most recent transactions from Plaid.
                    </p>
                    {plaidTxns.length === 0 ? (
                      <p className="text-gray-400 text-sm">No Plaid transactions yet.</p>
                    ) : (
                      <div className="rounded-lg border border-white/20 bg-black/40 overflow-x-auto max-h-[40vh]">
                        <Table>
                          <TableHeader>
                            <TableRow className="border-white/20 hover:bg-transparent">
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Date
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Account
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Name
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap text-right">
                                Amount
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Raw JSON
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {plaidTxns.map((tx: any, idx: number) => {
                              const account = plaidAccounts.find((a: any) => a.account_id === tx.account_id)
                              return (
                                <TableRow
                                  key={tx.transaction_id ?? idx}
                                  className="border-white/20 hover:bg-white/5 align-top"
                                >
                                  <TableCell className="text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap text-sm">
                                    {tx.date ?? "—"}
                                  </TableCell>
                                  <TableCell className="text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap text-sm">
                                    {account?.name ?? tx.account_id ?? "—"}
                                  </TableCell>
                                  <TableCell className="text-white border-white/20 px-3 py-2 whitespace-nowrap text-sm">
                                    {tx.name ?? "—"}
                                  </TableCell>
                                  <TableCell className="text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap text-right text-sm">
                                    {typeof tx.amount === "number"
                                      ? formatBalance(tx.amount)
                                      : String(tx.amount ?? "—")}
                                  </TableCell>
                                  <TableCell className="text-gray-400 border-white/20 px-3 py-2 text-xs max-w-[260px]">
                                    <code className="block whitespace-pre overflow-x-auto">
                                      {JSON.stringify(tx, null, 2)}
                                    </code>
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/20 bg-white/5 p-4">
                    <h3 className="text-lg font-semibold text-white mb-2">QuickBooks Online — raw entities</h3>
                    <p className="text-gray-400 text-sm mb-3">
                      Every synced QBO entity type is shown as JSON, grouped by type.
                    </p>
                    {Object.keys(qboEntities).length === 0 ? (
                      <p className="text-gray-400 text-sm">No QBO entities synced yet.</p>
                    ) : (
                      <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-1">
                        {Object.entries(qboEntities).map(([entityType, list]) => (
                          <div
                            key={entityType}
                            className="rounded-lg border border-white/15 bg-black/40 p-3"
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-sm font-medium text-white">{entityType}</span>
                              <span className="text-xs text-gray-400">
                                {Array.isArray(list) ? list.length : 0} records
                              </span>
                            </div>
                            <pre className="text-xs text-gray-300 bg-black/60 rounded-md p-2 overflow-x-auto max-h-40">
                              {JSON.stringify(list, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/20 bg-white/5 p-4">
                    <h3 className="text-lg font-semibold text-white mb-2">Xero — raw entities</h3>
                    <p className="text-gray-400 text-sm mb-3">
                      Raw synced objects from Xero, grouped by type.
                    </p>
                    {Object.keys(xeroEntities).length === 0 ? (
                      <p className="text-gray-400 text-sm">No Xero entities synced yet.</p>
                    ) : (
                      <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-1">
                        {Object.entries(xeroEntities).map(([entityType, list]) => (
                          <div
                            key={entityType}
                            className="rounded-lg border border-white/15 bg-black/40 p-3"
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-sm font-medium text-white">{entityType}</span>
                              <span className="text-xs text-gray-400">
                                {Array.isArray(list) ? list.length : 0} records
                              </span>
                            </div>
                            <pre className="text-xs text-gray-300 bg-black/60 rounded-md p-2 overflow-x-auto max-h-40">
                              {JSON.stringify(list, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/20 bg-white/5 p-4">
                    <h3 className="text-lg font-semibold text-white mb-2">Stripe — raw entities</h3>
                    <p className="text-gray-400 text-sm mb-3">
                      Invoices, customers, payments, and other Stripe records in raw form.
                    </p>
                    {Object.keys(stripeEntities).length === 0 ? (
                      <p className="text-gray-400 text-sm">No Stripe entities synced yet.</p>
                    ) : (
                      <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-1">
                        {Object.entries(stripeEntities).map(([entityType, list]) => (
                          <div
                            key={entityType}
                            className="rounded-lg border border-white/15 bg-black/40 p-3"
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-sm font-medium text-white">{entityType}</span>
                              <span className="text-xs text-gray-400">
                                {Array.isArray(list) ? list.length : 0} records
                              </span>
                            </div>
                            <pre className="text-xs text-gray-300 bg-black/60 rounded-md p-2 overflow-x-auto max-h-40">
                              {JSON.stringify(list, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-white/20 bg-white/5 p-4">
                    <h3 className="text-lg font-semibold text-white mb-2">
                      Gmail — messages with extracted invoices
                    </h3>
                    <p className="text-gray-400 text-sm mb-3">
                      Raw Gmail metadata plus the LLM-extracted invoice JSON we now store on each
                      message.
                    </p>
                    {gmailExtracts.length === 0 ? (
                      <p className="text-gray-400 text-sm">No Gmail invoice messages yet.</p>
                    ) : (
                      <div className="rounded-lg border border-white/20 bg-black/40 overflow-x-auto max-h-[40vh]">
                        <Table>
                          <TableHeader>
                            <TableRow className="border-white/20 hover:bg-transparent">
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Message ID
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                From
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                To
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Date
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Subject
                              </TableHead>
                              <TableHead className="text-gray-300 font-semibold border-white/20 bg-white/10 px-3 py-2 whitespace-nowrap">
                                Extracted invoice JSON
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {gmailExtracts.map((m: any) => (
                              <TableRow
                                key={m.message_id}
                                className="border-white/20 hover:bg-white/5 align-top"
                              >
                                <TableCell className="text-xs text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap">
                                  {m.message_id}
                                </TableCell>
                                <TableCell className="text-xs text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap">
                                  {m.from_email ?? "—"}
                                </TableCell>
                                <TableCell className="text-xs text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap">
                                  {m.to_emails ?? "—"}
                                </TableCell>
                                <TableCell className="text-xs text-gray-300 border-white/20 px-3 py-2 whitespace-nowrap">
                                  {m.date_sent ?? "—"}
                                </TableCell>
                                <TableCell className="text-xs text-white border-white/20 px-3 py-2 whitespace-nowrap max-w-[220px] truncate">
                                  {m.subject ?? "—"}
                                </TableCell>
                                <TableCell className="text-xs text-gray-300 border-white/20 px-3 py-2 max-w-[260px]">
                                  <code className="block whitespace-pre overflow-x-auto">
                                    {JSON.stringify(m.extracted_invoice, null, 2)}
                                  </code>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        }
      }

      case 9: {
        const idEntities = identityData?.entities ?? []
        const idAliases = identityData?.aliases ?? []
        const idAssertionCounts = identityData?.assertionCounts ?? []
        const aliasesByEntity = new Map<string, IdentityAlias[]>()
        for (const a of idAliases) {
          const list = aliasesByEntity.get(a.entity_id) ?? []
          list.push(a)
          aliasesByEntity.set(a.entity_id, list)
        }
        const assertionsByEntity = new Map<string, IdentityAssertionCount[]>()
        for (const a of idAssertionCounts) {
          const list = assertionsByEntity.get(a.entity_id) ?? []
          list.push(a)
          assertionsByEntity.set(a.entity_id, list)
        }
        const typeCounts: Record<string, number> = {}
        for (const e of idEntities) { typeCounts[e.entity_type] = (typeCounts[e.entity_type] ?? 0) + 1 }
        const confPct = (c: number) => Math.round(c * 100)
        const sourceColor = (s: string) =>
          s === "qbo" ? "bg-blue-500/80 border-blue-400/50" :
          s === "xero" ? "bg-emerald-500/80 border-emerald-400/50" :
          s === "stripe" ? "bg-purple-500/80 border-purple-400/50" :
          s === "plaid" ? "bg-amber-500/80 border-amber-400/50" :
          s === "gmail" ? "bg-red-500/80 border-red-400/50" :
          s === "system" ? "bg-white/30 border-white/20" :
          "bg-zinc-500/80 border-zinc-400/50"
        const typeColor = (t: string) =>
          t === "vendor" ? "bg-orange-500/80 border-orange-400/50" :
          t === "customer" ? "bg-cyan-500/80 border-cyan-400/50" :
          t === "processor" ? "bg-violet-500/80 border-violet-400/50" :
          t === "employee" ? "bg-pink-500/80 border-pink-400/50" :
          t === "internal" ? "bg-yellow-500/80 border-yellow-400/50" :
          t === "owner" ? "bg-rose-500/80 border-rose-400/50" :
          t === "bank_account" ? "bg-slate-500/80 border-slate-400/50" :
          t === "tax_authority" ? "bg-red-700/80 border-red-600/50" :
          t === "lender" ? "bg-indigo-500/80 border-indigo-400/50" :
          "bg-zinc-500/80 border-zinc-400/50"
        const typeLabel = (t: string) =>
          t === "bank_account" ? "bank acct" :
          t === "tax_authority" ? "tax auth" :
          t === "unknown" ? "unclassified" :
          t

        return (
          <div className="pt-0 pb-2 w-full">
            <h2 className="text-3xl font-bold tracking-tight text-white mb-2">{steps[8].title}</h2>
            <p className="text-gray-400 text-lg mb-5">{steps[8].description}</p>

            {(identitySeeding || identityLoading || afterIdentityLoading) && (
              <div className="flex items-center gap-2 py-6 text-gray-400">
                <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                {afterIdentityLoading
                  ? "Syncing to Supermemory & tagging merchants\u2026"
                  : identitySeeding
                    ? "Resolving identities across all sources (this may take a moment)\u2026"
                    : "Loading identity graph\u2026"}
              </div>
            )}

            {identityError && !identityLoading && !identitySeeding && !afterIdentityLoading && (
              <p className="text-red-300 text-sm mb-4">Failed to load identity graph: {identityError}</p>
            )}

            {!identityLoading && !identitySeeding && !afterIdentityLoading && identityData && idEntities.length === 0 && (
              <p className="text-gray-400 text-sm mb-4">No entities resolved yet. Connect integrations and sync data first.</p>
            )}

            {!identityLoading && !identitySeeding && !afterIdentityLoading && idEntities.length > 0 && (
              <div className="space-y-6">
                {/* Summary stats */}
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
                    <div className="text-2xl font-bold text-white">{idEntities.length}</div>
                    <div className="text-xs text-gray-400">Total entities</div>
                  </div>
                  {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                    <div key={type} className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
                      <div className="text-2xl font-bold text-white">{count}</div>
                      <div className="text-xs text-gray-400 capitalize">{typeLabel(type) + "s"}</div>
                    </div>
                  ))}
                  <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
                    <div className="text-2xl font-bold text-white">{idAliases.length}</div>
                    <div className="text-xs text-gray-400">Aliases</div>
                  </div>
                  <button
                    type="button"
                    disabled={identitySeeding}
                    onClick={() => {
                      setIdentitySeeding(true)
                      setIdentityData(null)
                      fetch("/api/identity/wipe", { method: "POST" })
                        .then(() => fetch("/api/identity/seed?force=true", { method: "POST" }))
                        .catch(() => {})
                      let a = 0
                      const rePoll = () => {
                        a++
                        fetch("/api/identity")
                          .then((r) => r.ok ? r.json() : null)
                          .then((d: IdentityData | null) => {
                            if (d && d.entities.length > 0) { setIdentityData(d); setIdentitySeeding(false) }
                            else if (a < 30) setTimeout(rePoll, 3000)
                            else setIdentitySeeding(false)
                          })
                          .catch(() => { if (a < 30) setTimeout(rePoll, 3000); else setIdentitySeeding(false) })
                      }
                      setTimeout(rePoll, 3000)
                    }}
                    className="rounded-lg border border-white/20 bg-white/5 px-4 py-3 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="text-sm font-medium text-white">{identitySeeding ? "Scanning\u2026" : "Re-scan sources"}</div>
                    <div className="text-xs text-gray-400">Pick up new data</div>
                  </button>
                </div>

                {/* Entity tables by category */}
                {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => {
                  const categoryEntities = idEntities.filter((e) => e.entity_type === type)
                  return (
                    <div key={type} className="rounded-xl border border-white/20 bg-white/5 overflow-hidden">
                      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/20">
                        <span className={`inline-flex rounded-md border px-2.5 py-1 text-sm font-semibold text-white capitalize ${typeColor(type)}`}>
                          {typeLabel(type)}s
                        </span>
                        <span className="text-sm text-gray-400">{count} entit{count !== 1 ? "ies" : "y"}</span>
                      </div>
                      <div className="max-h-[50vh] overflow-y-auto divide-y divide-white/10">
                        {categoryEntities.map((ent) => {
                          const expanded = identityExpandedEntity === ent.id
                          const entAliases = aliasesByEntity.get(ent.id) ?? []
                          const entAssertions = assertionsByEntity.get(ent.id) ?? []
                          const nameAliases = entAliases.filter((a) => a.alias_type === "name" || a.alias_type === "merchant_string")
                          const emailAliases = entAliases.filter((a) => a.alias_type === "email")
                          const domainAliases = entAliases.filter((a) => a.alias_type === "domain")
                          return (
                            <div key={ent.id}>
                              <button
                                type="button"
                                onClick={() => setIdentityExpandedEntity(expanded ? null : ent.id)}
                                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 transition-colors text-left"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-white font-semibold truncate">{ent.canonical_name}</span>
                                    {(ent.sources ?? []).map((s: string) => (
                                      <span key={s} className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium text-white uppercase ${sourceColor(s)}`}>
                                        {s}
                                      </span>
                                    ))}
                                  </div>
                                  <span className="text-[10px] text-gray-500">{ent.evidence_count ?? entAliases.length} signals from {ent.source_count ?? new Set(entAliases.map((a) => a.source)).size} source{(ent.source_count ?? 1) !== 1 ? "s" : ""}</span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <div className="flex items-center gap-1.5">
                                    <div className="w-14 h-1.5 rounded-full bg-white/10 overflow-hidden">
                                      <div
                                        className={`h-full rounded-full ${ent.confidence >= 0.9 ? "bg-emerald-400" : ent.confidence >= 0.7 ? "bg-amber-400" : "bg-red-400"}`}
                                        style={{ width: `${confPct(ent.confidence)}%` }}
                                      />
                                    </div>
                                    <span className="text-xs text-gray-400 w-8 text-right">{confPct(ent.confidence)}%</span>
                                  </div>
                                  <svg className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                </div>
                              </button>
                              {expanded && (
                                <div className="px-4 pb-3 space-y-2 border-l-2 border-white/10 ml-4">
                                  <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider pt-1">Evidence trail</div>
                                  {nameAliases.length > 0 && (
                                    <div>
                                      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Names</div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {nameAliases.map((a) => (
                                          <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-white/5 border border-white/10 px-2 py-1 text-xs text-white">
                                            {a.alias}
                                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} title={a.source} />
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {emailAliases.length > 0 && (
                                    <div>
                                      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Emails</div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {emailAliases.map((a) => (
                                          <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-white/5 border border-white/10 px-2 py-1 text-xs text-gray-300 font-mono">
                                            {a.alias}
                                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} title={a.source} />
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {domainAliases.length > 0 && (
                                    <div>
                                      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Domains</div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {domainAliases.map((a) => (
                                          <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-white/5 border border-white/10 px-2 py-1 text-xs text-gray-400 font-mono">
                                            {a.alias}
                                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} title={a.source} />
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {entAssertions.length > 0 && (
                                    <div>
                                      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Assertions</div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {entAssertions.map((a, i) => (
                                          <span key={i} className="inline-flex items-center gap-1 rounded-full bg-white/5 border border-white/10 px-2 py-0.5 text-[11px] text-gray-400">
                                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceColor(a.source)}`} />
                                            {a.assertion_type.replace(/_/g, " ")} via {a.source} ({a.count}x, avg {confPct(a.avg_score)}%)
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      }

      case 10: {
        const mvts = movementsData?.movements ?? []
        const mvtSummary = movementsData?.summary ?? []
        const summaryFromTags = movementsData?.summary_from_tags ?? null

        const CLASS_META: Record<string, { label: string; color: string; group: "pnl" | "non_pnl" | "review" }> = {
          customer_cash_in:  { label: "Customer Cash In",    color: "bg-emerald-500/80 border-emerald-400/50", group: "pnl" },
          vendor_cash_out:   { label: "Vendor Cash Out",     color: "bg-orange-500/80 border-orange-400/50",   group: "pnl" },
          bank_fee:          { label: "Bank Fee",            color: "bg-red-500/80 border-red-400/50",         group: "pnl" },
          bank_fee_refund:   { label: "Bank Fee Refund",     color: "bg-red-400/60 border-red-300/40",         group: "pnl" },
          refund:            { label: "Refund",              color: "bg-amber-500/80 border-amber-400/50",     group: "pnl" },
          interest:          { label: "Interest",            color: "bg-teal-500/80 border-teal-400/50",       group: "pnl" },
          processor_fee:     { label: "Processor Fee",       color: "bg-violet-700/80 border-violet-600/50",   group: "pnl" },
          internal_transfer: { label: "Internal Transfer",   color: "bg-slate-500/80 border-slate-400/50",     group: "non_pnl" },
          processor_payout:  { label: "Processor Payout",    color: "bg-violet-500/80 border-violet-400/50",   group: "non_pnl" },
          credit_card_payment: { label: "Credit Card Payment", color: "bg-indigo-500/80 border-indigo-400/50", group: "non_pnl" },
          owner_contribution:  { label: "Owner Contribution",  color: "bg-rose-400/80 border-rose-300/50",     group: "non_pnl" },
          owner_draw:          { label: "Owner Draw",          color: "bg-rose-600/80 border-rose-500/50",     group: "non_pnl" },
          merchant_deposit:    { label: "Merchant Deposit",    color: "bg-cyan-600/80 border-cyan-500/50",     group: "non_pnl" },
          settlement_in:       { label: "Merchant Deposit",    color: "bg-cyan-600/80 border-cyan-500/50",     group: "non_pnl" },
          settlement_adjustment: { label: "Merchant Adjustment", color: "bg-cyan-700/60 border-cyan-600/40",   group: "non_pnl" },
          opening_balance:     { label: "Opening Balance",     color: "bg-gray-600/80 border-gray-500/50",     group: "non_pnl" },
          unknown:             { label: "Needs Review",        color: "bg-zinc-500/80 border-zinc-400/50",     group: "review" },
        }

        const getDisplayClass = (m: { movement_class: string; tag?: { economic_class?: string; settlement_subtype?: string } }) => {
          if (m.movement_class === "merchant_deposit") {
            if (m.tag?.economic_class === "settlement_adjustment" || m.tag?.settlement_subtype === "merchant_adjustment") return "settlement_adjustment"
            return "settlement_in"
          }
          return m.movement_class
        }

        const classCounts: Record<string, number> = {}
        const classAmounts: Record<string, number> = {}
        let pnlCount = 0
        let nonPnlCount = 0
        let excludedForReview = 0
        let unresolved = 0
        let coalescedCount = 0

        if (summaryFromTags) {
          pnlCount = summaryFromTags.pnl_count
          nonPnlCount = summaryFromTags.non_pnl_count
          excludedForReview = summaryFromTags.excluded_for_review
          unresolved = summaryFromTags.unresolved
          coalescedCount = summaryFromTags.coalesced_count
          for (const [mc, data] of Object.entries(summaryFromTags.class_counts)) {
            if (mc === "merchant_deposit") {
              for (const m of mvts) {
                if (m.movement_class === "merchant_deposit") {
                  const dc = getDisplayClass(m as { movement_class: string; tag?: { economic_class?: string; settlement_subtype?: string } })
                  classCounts[dc] = (classCounts[dc] ?? 0) + 1
                  classAmounts[dc] = (classAmounts[dc] ?? 0) + m.amount
                }
              }
            } else {
              classCounts[mc] = data.count
              classAmounts[mc] = data.total_amount
            }
          }
        } else {
          for (const s of mvtSummary) {
            classCounts[s.movement_class] = (classCounts[s.movement_class] ?? 0) + s.count
            classAmounts[s.movement_class] = (classAmounts[s.movement_class] ?? 0) + parseFloat(s.total_amount)
            if (s.pnl_eligible) pnlCount += s.count
            else nonPnlCount += s.count
          }
          for (const m of mvts) {
            if (m.needs_review) excludedForReview++
            if (m.provenance === "coalesced") coalescedCount++
          }
        }

        const provenanceLabel = (p: string) =>
          p === "coalesced" ? { text: "C", color: "bg-green-600/80", title: "Coalesced (multi-source)" } :
          p === "bank_observed" ? { text: "B", color: "bg-amber-600/80", title: "Bank observed" } :
          p === "accounting_observed" ? { text: "A", color: "bg-blue-600/80", title: "Accounting observed" } :
          { text: "?", color: "bg-zinc-600/80", title: "Unknown provenance" }

        const DETAIL_LABELS: Record<string, string> = {
          cash_in_customer: "Customer Receipt", cash_out_vendor: "Vendor Payment",
          cash_out_operating_expense: "Operating Expense", cash_out_payroll: "Payroll",
          cash_out_tax: "Tax", cash_out_bank_fee: "Bank Fee",
          cash_out_refund: "Refund Out", cash_in_refund: "Refund In",
          cash_in_interest: "Interest In", cash_out_interest: "Interest Out",
          merchant_deposit_unresolved: "Merchant Deposit?",
          settlement_in: "Settlement In",
          settlement_adjustment: "Merchant Adjustment",
          owner_contribution_candidate: "Owner Contribution?",
          unknown_inflow: "Unknown Inflow", unknown_outflow: "Unknown Outflow",
          unknown_transfer_candidate: "Unknown Transfer?",
          review_candidate_revenue: "Revenue? (needs review)",
          loan_funding: "Loan Funding", loan_principal_payment: "Loan Payment",
          other_operating: "Other Operating",
        }

        const BUCKET_LABELS: Record<string, string> = {
          revenue_in: "Revenue", contra_revenue: "Contra Rev", cogs_out: "COGS", opex_out: "OpEx",
          other_operating_in: "Op In", other_income: "Other Inc", financing_in: "Fin In", financing_out: "Fin Out",
          transfer: "Transfer", settlement: "Settlement", system_setup: "Setup", unknown: "—",
        }
        const ROLE_LABELS: Record<string, string> = {
          customer: "Customer", vendor: "Vendor", owner: "Owner", employee: "Employee",
          processor: "Processor", bank: "Bank", tax_authority: "Tax", lender: "Lender",
          marketplace: "Marketplace", unknown: "—",
        }

        const hasSettlementSplit = (classCounts["settlement_in"] ?? 0) > 0 || (classCounts["settlement_adjustment"] ?? 0) > 0
        const pnlClasses = Object.entries(CLASS_META).filter(([, v]) => v.group === "pnl").map(([k]) => k).filter((k) => (classCounts[k] ?? 0) > 0)
        const nonPnlClasses = Object.entries(CLASS_META).filter(([, v]) => v.group === "non_pnl").map(([k]) => k).filter((k) => {
          if (k === "merchant_deposit" && hasSettlementSplit) return false
          return (classCounts[k] ?? 0) > 0
        })
        const reviewClasses = Object.entries(CLASS_META).filter(([, v]) => v.group === "review").map(([k]) => k).filter((k) => (classCounts[k] ?? 0) > 0)

        const isTransferClass = (cls: string) => cls === "internal_transfer"

        const renderClassTable = (classKey: string) => {
          const meta = CLASS_META[classKey] ?? { label: classKey, color: "bg-zinc-500/80 border-zinc-400/50", group: "review" }
          const classMvts = (classKey === "settlement_in" || classKey === "settlement_adjustment")
            ? mvts.filter((m) => getDisplayClass(m as { movement_class: string; tag?: { economic_class?: string; settlement_subtype?: string } }) === classKey)
            : mvts.filter((m) => m.movement_class === classKey)
          const isPnl = meta.group === "pnl"
          const isTransfer = isTransferClass(classKey)
          return (
            <div key={classKey} className="rounded-xl border border-white/20 bg-white/5 overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 border-b border-white/20">
                <span className={`inline-flex rounded-md border px-2.5 py-1 text-sm font-semibold text-white ${meta.color}`}>
                  {meta.label}
                </span>
                <span className="text-sm text-gray-400">{classCounts[classKey]} movement{classCounts[classKey] !== 1 ? "s" : ""}</span>
                <span className="text-sm text-gray-500">${(classAmounts[classKey] ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                {isPnl ? (
                  <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[11px] text-emerald-400 font-medium">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    P&L
                  </span>
                ) : meta.group === "review" ? null : (
                  <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-white/5 border border-white/10 px-2 py-0.5 text-[11px] text-gray-500 font-medium">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-500" />
                    Non-P&L
                  </span>
                )}
              </div>
              <div className="max-h-[40vh] overflow-y-auto overflow-x-auto">
                {isTransfer ? (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-black/60 backdrop-blur-sm">
                      <tr className="border-b border-white/15">
                        <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[90px]">Date</th>
                        <th className="text-right text-gray-400 font-medium px-3 py-2 text-xs w-[100px]">Amount</th>
                        <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs">From</th>
                        <th className="text-center text-gray-400 font-medium px-3 py-2 text-xs w-[30px]"></th>
                        <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs">To</th>
                        <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs">Description</th>
                        <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[50px]">Prov</th>
                        <th className="text-right text-gray-400 font-medium px-3 py-2 text-xs w-[60px]" title="Classification / Evidence">Conf</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {classMvts.slice(0, 200).map((m) => {
                        const md = m.metadata ?? {}
                        const fromName = (md.from_account_name as string) ?? m.account_id ?? "\u2014"
                        const fromType = (md.from_account_subtype as string) ?? (md.from_account_type as string) ?? ""
                        const toName = (md.to_account_name as string) ?? (md.linked_internal_account_id as string) ?? "\u2014"
                        const toType = (md.to_account_subtype as string) ?? (md.to_account_type as string) ?? ""
                        const isConfidentIncluded = (m as { tag?: { policy_status?: string } }).tag?.policy_status === "included" && m.confidence >= 0.85
                        const showReviewStyle = m.needs_review && !isConfidentIncluded
                        return (
                          <tr key={m.id} className={`hover:bg-white/5 ${showReviewStyle ? "bg-yellow-500/5" : ""}`}>
                            <td className="text-gray-400 px-3 py-1.5 text-xs whitespace-nowrap">{m.occurred_at?.split("T")[0]}</td>
                            <td className="px-3 py-1.5 text-xs text-right font-mono whitespace-nowrap text-white">
                              ${m.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                            <td className="px-3 py-1.5 text-xs">
                              <div className="text-white truncate max-w-[140px]">{fromName}</div>
                              {fromType && <div className="text-[10px] text-gray-500 capitalize">{fromType}</div>}
                            </td>
                            <td className="px-3 py-1.5 text-center text-gray-500 text-xs">{"\u2192"}</td>
                            <td className="px-3 py-1.5 text-xs">
                              <div className="text-white truncate max-w-[140px]">{toName}</div>
                              {toType && <div className="text-[10px] text-gray-500 capitalize">{toType}</div>}
                            </td>
                            <td className="text-gray-400 px-3 py-1.5 text-xs truncate max-w-[160px]">{m.raw_description ?? "\u2014"}</td>
                            <td className="px-3 py-1.5">
                              {(() => { const p = provenanceLabel(m.provenance ?? ""); return (
                                <span title={p.title} className={`inline-flex rounded-md px-1 py-0.5 text-[9px] font-bold text-white ${p.color}`}>{p.text}</span>
                              ) })()}
                            </td>
                            <td className="px-3 py-1.5 text-xs text-right whitespace-nowrap" title={`Class: ${Math.round(m.confidence * 100)}% · Evidence: ${Math.round(m.evidence_strength * 100)}`}>
                              {showReviewStyle && <span className="text-yellow-400 mr-1" title={m.review_reasons?.join(", ") ?? "Needs review"}>!</span>}
                              <span className="text-white font-medium">Class {Math.round(m.confidence * 100)}%</span>
                              <span className="text-gray-600 ml-0.5">/ Ev {Math.round(m.evidence_strength * 100)}</span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-black/60 backdrop-blur-sm">
                      <tr className="border-b border-white/15">
                        <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[90px]">Date</th>
                        <th className="text-center text-gray-400 font-medium px-3 py-2 text-xs w-[50px]">Dir</th>
                        <th className="text-right text-gray-400 font-medium px-3 py-2 text-xs w-[100px]">Amount</th>
                        <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs">Counterparty</th>
                        <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[90px]" title="Cashflow bucket">Bucket</th>
                        <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[70px]" title="Counterparty role">Role</th>
                        {(classKey === "unknown" || classKey === "merchant_deposit" || classKey === "settlement_in" || classKey === "settlement_adjustment") && <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[110px]">Detail</th>}
                        <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs">Description</th>
                        <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[50px]">Prov</th>
                        <th className="text-right text-gray-400 font-medium px-3 py-2 text-xs w-[60px]" title="Classification / Evidence">Conf</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {classMvts.slice(0, 200).map((m) => {
                        // Phase 14: ! = low-confidence/review; do not show on confident included rows
                        const isConfidentIncluded = (m as { tag?: { policy_status?: string } }).tag?.policy_status === "included" && m.confidence >= 0.85
                        const showReviewStyle = m.needs_review && !isConfidentIncluded
                        return (
                        <tr key={m.id} className={`hover:bg-white/5 ${showReviewStyle ? "bg-yellow-500/5" : ""}`}>
                          <td className="text-gray-400 px-3 py-1.5 text-xs whitespace-nowrap">{m.occurred_at?.split("T")[0]}</td>
                          <td className="px-3 py-1.5 text-xs text-center">
                            <span className={`inline-block w-8 text-center font-bold ${m.direction === "inflow" ? "text-emerald-400" : "text-red-400"}`}>
                              {m.direction === "inflow" ? "↑ In" : "↓ Out"}
                            </span>
                          </td>
                          <td className={`px-3 py-1.5 text-xs text-right font-mono whitespace-nowrap ${m.direction === "inflow" ? "text-emerald-400" : "text-red-400"}`}>
                            ${m.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="text-white px-3 py-1.5 text-xs truncate max-w-[180px]" title={(m.metadata?.counterparty as string) ?? undefined}>{displayLabelForCounterparty(m.metadata?.counterparty as string, (m as { tag?: { display_name?: string; entity_canonical_name?: string } }).tag?.display_name ?? (m as { tag?: { entity_canonical_name?: string } }).tag?.entity_canonical_name)}</td>
                          <td className="text-gray-500 px-3 py-1.5 text-[10px]">{BUCKET_LABELS[(m as { tag?: { cashflow_bucket?: string } }).tag?.cashflow_bucket ?? "unknown"] ?? "—"}</td>
                          <td className="text-gray-500 px-3 py-1.5 text-[10px]">{ROLE_LABELS[(m as { tag?: { counterparty_role?: string } }).tag?.counterparty_role ?? "unknown"] ?? "—"}</td>
                          {(classKey === "unknown" || classKey === "merchant_deposit" || classKey === "settlement_in" || classKey === "settlement_adjustment") && (
                            <td className="px-3 py-1.5 text-xs">
                              <span className="text-[10px] text-gray-500 bg-white/5 rounded px-1.5 py-0.5">
                                {classKey === "settlement_adjustment" ? "Merchant Adjustment" : classKey === "settlement_in" ? "Settlement In" : DETAIL_LABELS[m.movement_type_detail] ?? m.movement_type_detail}
                              </span>
                            </td>
                          )}
                          <td className="text-gray-400 px-3 py-1.5 text-xs truncate max-w-[200px]">{m.raw_description ?? "\u2014"}</td>
                          <td className="px-3 py-1.5">
                            {(() => { const p = provenanceLabel(m.provenance ?? ""); return (
                              <span title={p.title} className={`inline-flex rounded-md px-1 py-0.5 text-[9px] font-bold text-white ${p.color}`}>{p.text}</span>
                            ) })()}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-right whitespace-nowrap" title={`Class: ${Math.round(m.confidence * 100)}% · Evidence: ${Math.round(m.evidence_strength * 100)}`}>
                            {showReviewStyle && <span className="text-yellow-400 mr-1" title={m.review_reasons?.join(", ") ?? "Needs review"}>!</span>}
                            <span className="text-white font-medium">Class {Math.round(m.confidence * 100)}%</span>
                            <span className="text-gray-600 ml-0.5">/ Ev {Math.round(m.evidence_strength * 100)}</span>
                          </td>
                        </tr>
                      )})}
                    </tbody>
                  </table>
                )}
                {classMvts.length > 200 && (
                  <div className="px-3 py-2 text-xs text-gray-500 border-t border-white/10">Showing 200 of {classMvts.length} movements</div>
                )}
              </div>
            </div>
          )
        }

        return (
          <div className="pt-0 pb-2 w-full">
            <h2 className="text-3xl font-bold tracking-tight text-white mb-2">{steps[9].title}</h2>
            <p className="text-gray-400 text-lg mb-5">{steps[9].description}</p>

            {/* AI-powered edit bar: user asks to change X → AI applies universal edits */}
            {mvts.length > 0 && (
              <div className="mb-6 rounded-xl border border-white/20 bg-white/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span className="text-sm font-medium text-gray-300">AI Edit</span>
                </div>
                <p className="text-xs text-gray-500 mb-3">Ask to change transactions in bulk, e.g. &quot;Change all Gusto to payroll&quot; or &quot;Recategorize Acme Corp as vendor payment&quot;</p>
                <form
                  className="flex gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (!movementEditIntent.trim() || movementEditLoading) return
                    setMovementEditLoading(true)
                    setMovementEditMessage(null)
                    try {
                      const res = await fetch("/api/movements/edit", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ intent: movementEditIntent.trim() }),
                      })
                      const data = await res.json().catch(() => ({}))
                      if (res.ok) {
                        setMovementEditMessage({ type: "success", text: data.plan ?? `Updated ${data.updated ?? 0} transaction(s)` })
                        setMovementEditIntent("")
                        fetch("/api/movements")
                          .then((r) => r.json())
                          .then((d) => { setMovementsData(d); return fetch("/api/movements/tag", { method: "POST" }) })
                          .then((r) => (r.ok ? fetch("/api/movements") : null))
                          .then((r) => r?.json())
                          .then((d) => { if (d) setMovementsData(d) })
                      } else {
                        setMovementEditMessage({ type: "error", text: data.error ?? "Edit failed" })
                      }
                    } catch {
                      setMovementEditMessage({ type: "error", text: "Request failed" })
                    } finally {
                      setMovementEditLoading(false)
                    }
                  }}
                >
                  <Input
                    value={movementEditIntent}
                    onChange={(e) => setMovementEditIntent(e.target.value)}
                    placeholder="e.g. Change all Gusto to payroll"
                    className="flex-1 bg-black/40 border-white/20 text-white placeholder:text-gray-500"
                    disabled={movementEditLoading || movementsClassifying || movementsLoading}
                  />
                  <Button
                    type="submit"
                    disabled={!movementEditIntent.trim() || movementEditLoading || movementsClassifying || movementsLoading}
                    className="shrink-0"
                  >
                    {movementEditLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Apply changes"}
                  </Button>
                </form>
                {movementEditMessage && (
                  <p className={`mt-2 text-sm ${movementEditMessage.type === "success" ? "text-emerald-400" : "text-red-400"}`}>
                    {movementEditMessage.text}
                  </p>
                )}
              </div>
            )}

            {(movementsClassifying || movementsLoading) && (
              <div className="flex items-center gap-2 py-6 text-gray-400">
                <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                {movementsClassifying ? "Classifying cash movements across all sources (this may take a moment)\u2026" : "Loading movements\u2026"}
              </div>
            )}

            {movementsError && !movementsLoading && !movementsClassifying && (
              <p className="text-red-300 text-sm mb-4">Failed to load movements: {movementsError}</p>
            )}

            {!movementsLoading && !movementsClassifying && movementsData && mvts.length === 0 && (
              <p className="text-gray-400 text-sm mb-4">No movements classified yet. Connect integrations and sync data first.</p>
            )}

            {!movementsLoading && !movementsClassifying && mvts.length > 0 && (
              <div className="space-y-6">
                {/* Summary: true partition — each movement in exactly one bucket */}
                <div className="space-y-4">
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">State partition (Included P&L + Included Non-P&L + Excluded + Unresolved + Coalesced = Total)</div>
                  <div className="flex flex-wrap gap-3 items-end">
                    <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
                      <div className="text-2xl font-bold text-white">{mvts.length + coalescedCount}</div>
                      <div className="text-xs text-gray-400">Total movements</div>
                    </div>
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
                      <div className="text-2xl font-bold text-emerald-400">{summaryFromTags?.included_pnl ?? 0}</div>
                      <div className="text-xs text-emerald-400/70">Included P&L</div>
                    </div>
                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
                      <div className="text-2xl font-bold text-emerald-300">{summaryFromTags?.included_non_pnl ?? 0}</div>
                      <div className="text-xs text-emerald-400/60">Included Non-P&L</div>
                    </div>
                    {excludedForReview > 0 && (
                      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3">
                        <div className="text-2xl font-bold text-yellow-400">{excludedForReview}</div>
                        <div className="text-xs text-yellow-400/70">Excluded for review</div>
                      </div>
                    )}
                    {unresolved > 0 && (
                      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
                        <div className="text-2xl font-bold text-red-400">{unresolved}</div>
                        <div className="text-xs text-red-400/70">Unresolved</div>
                      </div>
                    )}
                    {coalescedCount > 0 && (
                      <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3">
                        <div className="text-2xl font-bold text-green-400">{coalescedCount}</div>
                        <div className="text-xs text-green-400/70">Coalesced hidden</div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 items-end">
                  <button
                    type="button"
                    disabled={movementsClassifying}
                    onClick={() => {
                      setMovementsClassifying(true)
                      setMovementsData(null)
                      fetch("/api/movements/wipe", { method: "POST" })
                        .then(() => fetch("/api/movements/classify?force=true", { method: "POST" }))
                        .catch(() => {})
                      let a = 0
                      const rePoll = () => {
                        a++
                        fetch("/api/movements")
                          .then((r) => r.ok ? r.json() : null)
                          .then((d: MovementsData | null) => {
                            if (d && d.movements.length > 0) { setMovementsData(d); setMovementsClassifying(false) }
                            else if (a < 40) setTimeout(rePoll, 3000)
                            else setMovementsClassifying(false)
                          })
                          .catch(() => { if (a < 40) setTimeout(rePoll, 3000); else setMovementsClassifying(false) })
                      }
                      setTimeout(rePoll, 3000)
                    }}
                    className="rounded-lg border border-white/20 bg-white/5 px-4 py-3 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="text-sm font-medium text-white">{movementsClassifying ? "Classifying\u2026" : "Re-classify"}</div>
                    <div className="text-xs text-gray-400">Wipe & re-run</div>
                  </button>
                </div>

                {/* Review queue: high-value needs_review first, owner vs processor conflicts highlighted */}
                {excludedForReview > 0 && (() => {
                  const reviewMvts = mvts
                    .filter((m) => m.needs_review)
                    .sort((a, b) => b.amount - a.amount)
                  const ownerConflictMvts = reviewMvts.filter((m) => (m.review_reasons ?? []).includes("owner_vs_processor_conflict"))
                  return (
                    <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-3 border-b border-yellow-500/20">
                        <h3 className="text-lg font-semibold text-yellow-400">Review queue</h3>
                        <span className="text-xs text-gray-500">
                          {reviewMvts.length} item{reviewMvts.length !== 1 ? "s" : ""} · High-value first
                          {ownerConflictMvts.length > 0 && (
                            <span className="ml-2 text-amber-400">· {ownerConflictMvts.length} owner vs processor conflict{ownerConflictMvts.length !== 1 ? "s" : ""}</span>
                          )}
                        </span>
                      </div>
                      <div className="max-h-[35vh] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-black/80 backdrop-blur-sm">
                            <tr className="border-b border-white/15">
                              <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[90px]">Date</th>
                              <th className="text-right text-gray-400 font-medium px-3 py-2 text-xs w-[100px]">Amount</th>
                              <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs">Counterparty</th>
                              <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs">Class</th>
                              <th className="text-left text-gray-400 font-medium px-3 py-2 text-xs w-[120px]">Flags</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/5">
                            {reviewMvts.slice(0, 50).map((m) => {
                              const hasOwnerConflict = (m.review_reasons ?? []).includes("owner_vs_processor_conflict")
                              return (
                                <tr key={m.id} className={`hover:bg-white/5 ${hasOwnerConflict ? "bg-amber-500/10" : ""}`}>
                                  <td className="text-gray-400 px-3 py-1.5 text-xs whitespace-nowrap">{m.occurred_at?.split("T")[0]}</td>
                                  <td className={`px-3 py-1.5 text-xs text-right font-mono font-semibold ${m.direction === "inflow" ? "text-emerald-400" : "text-red-400"}`}>
                                    ${m.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="text-white px-3 py-1.5 text-xs truncate max-w-[180px]" title={(m.metadata?.counterparty as string) ?? undefined}>
                                    {displayLabelForCounterparty(m.metadata?.counterparty as string, (m as { tag?: { display_name?: string; entity_canonical_name?: string } }).tag?.display_name ?? (m as { tag?: { entity_canonical_name?: string } }).tag?.entity_canonical_name)}
                                  </td>
                                  <td className="text-gray-400 px-3 py-1.5 text-xs">{m.movement_class}</td>
                                  <td className="px-3 py-1.5">
                                    {hasOwnerConflict && (
                                      <span className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/20 text-amber-400 border border-amber-500/30" title="Owner vs merchant deposit conflict">
                                        Owner vs processor
                                      </span>
                                    )}
                                    {!hasOwnerConflict && (m.review_reasons ?? []).length > 0 && (
                                      <span className="text-[10px] text-gray-500" title={(m.review_reasons ?? []).join(", ")}>
                                        {(m.review_reasons ?? []).slice(0, 2).join(", ")}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                        {reviewMvts.length > 50 && (
                          <div className="px-3 py-2 text-xs text-gray-500 border-t border-white/10">Showing top 50 of {reviewMvts.length} (by amount)</div>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* P&L Eligible movements */}
                {pnlClasses.length > 0 && (
                  <div>
                    <h3 className="text-lg font-semibold text-emerald-400 mb-3">P&L Eligible (Operational Cash Activity)</h3>
                    <div className="space-y-4">
                      {pnlClasses.map(renderClassTable)}
                    </div>
                  </div>
                )}

                {/* Non-P&L movements */}
                {nonPnlClasses.length > 0 && (
                  <div>
                    <h3 className="text-lg font-semibold text-gray-400 mb-3">Non-P&L (Transfers, Financing, Equity, Settlement)</h3>
                    <div className="space-y-4">
                      {nonPnlClasses.map(renderClassTable)}
                    </div>
                  </div>
                )}

              </div>
            )}
          </div>
        )
      }

      case 11: {
        const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        const moneySmall = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        const money2 = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        const sourceBadge = (s: string) => {
          const c = s === "qbo" ? "bg-blue-500/20 text-blue-300" : s === "xero" ? "bg-teal-500/20 text-teal-300" : s === "stripe" ? "bg-purple-500/20 text-purple-300" : "bg-gray-500/20 text-gray-300"
          return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded uppercase ${c}`}>{s}</span>
        }
        const statusBadge = (status: string, daysOverdue: number | null) => {
          if (status === "overdue" || (daysOverdue != null && daysOverdue > 0))
            return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">Overdue</span>
          if (status === "partially_paid") return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">Partial</span>
          return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">Open</span>
        }
        const arInvoices = arApData?.ar.invoices ?? []
        const arOverdueFirst = [...arInvoices].sort((a, b) => (b.days_overdue ?? 0) - (a.days_overdue ?? 0))
        const apObligations = arApData?.ap.obligations ?? []
        const allReconRows = mappingRecon
          ? [
              ...(mappingRecon.matched_inflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations?: { gross: number; fee: number; net: number }[] }) => ({ ...m, direction: "inflow" as const })),
              ...(mappingRecon.matched_outflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations?: { gross: number; fee: number; net: number }[] }) => ({ ...m, direction: "outflow" as const })),
              ...(mappingRecon.unmatched_inflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null }) => ({ ...m, direction: "inflow" as const, allocations: [] })),
              ...(mappingRecon.unmatched_outflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null }) => ({ ...m, direction: "outflow" as const, allocations: [] })),
            ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
          : []

        return (
          <div className="space-y-6">
            <div className="text-center mb-2">
              <h2 className="text-2xl font-semibold text-white mb-1">{steps[10].title}</h2>
              <p className="text-gray-400 text-lg mb-1">{steps[10].description}</p>
              <p className="text-[11px] text-gray-500 mb-5">Bank payments matched to invoices and obligations. Gross − Fee = Net.</p>

              {(arApLoading || mappingLoading) && (
                <div className="flex items-center justify-center gap-2 py-6 text-gray-400">
                  <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Loading AR/AP & reconciliation…
                </div>
              )}

              {(arApError || mappingError) && !arApLoading && !mappingLoading && (
                <p className="text-red-300 text-sm mb-4">Failed: {arApError || mappingError}</p>
              )}
            </div>

            {!arApLoading && !mappingLoading && (arApData || mappingRecon) && (
              <div className="space-y-6">
                {arApData && (
                <>
                {/* ─── Summary bar ─── */}
                <div className="flex flex-wrap gap-4 justify-center text-sm">
                  <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                    <span className="text-emerald-400 font-bold">{money(arApData.ar.total_outstanding)}</span>
                    <span className="text-gray-400">AR outstanding</span>
                  </div>
                  <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
                  <span className="text-red-400 font-bold">{money(arApData.ap.total_expected_30d)}</span>
                  <span className="text-gray-400">AP (next 30d)</span>
                  </div>
                  <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10">
                    <span className="text-white font-bold">{money(arApData.ar.total_outstanding - arApData.ap.total_expected_30d)}</span>
                    <span className="text-gray-400">Net expected</span>
                  </div>
                </div>

                {/* ─── AR (Accounts Receivable) ─── */}
                <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl overflow-hidden">
                  <div className="p-5 border-b border-emerald-500/10">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-base font-semibold text-emerald-400 flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-emerald-400" />
                          AR (Accounts Receivable)
                        </h3>
                        <p className="text-xs text-gray-400 mt-1">Expected inflow — money you are owed. From invoices (QBO, Xero, Stripe, Gmail).</p>
                      </div>
                      <div className="flex gap-4 shrink-0">
                        <div className="text-right">
                          <div className="text-2xl font-bold font-mono text-emerald-400">{money(arApData.ar.total_outstanding)}</div>
                          <div className="text-[10px] text-gray-500">Total outstanding</div>
                        </div>
                        <div className="text-right">
                          <div className="text-xl font-bold font-mono text-red-400">{money(arApData.ar.total_overdue)}</div>
                          <div className="text-[10px] text-gray-500">Overdue ({arApData.ar.overdue_count})</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {arInvoices.length > 0 ? (
                    <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-emerald-500/10 hover:bg-transparent sticky top-0 bg-emerald-500/10 backdrop-blur-sm z-10">
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold">Customer</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-16">Source</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-24">Due date</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-20">Status</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-24 text-right">Amount due</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {arOverdueFirst.map((inv, i) => {
                            const invExt = inv as { allocations?: { movement_id: string; gross: number; fee: number; net: number }[]; amount_collected?: number; amount_remaining?: number }
                            const allocs = invExt.allocations ?? []
                            const amountCollected = invExt.amount_collected ?? allocs.reduce((s: number, c: { gross: number }) => s + c.gross, 0)
                            const amountRemaining = invExt.amount_remaining ?? Math.max(0, inv.amount_due - amountCollected)
                            const pct = inv.amount_due > 0 ? Math.round((amountCollected / inv.amount_due) * 100) : 0
                            const isExpanded = expandedInvoiceId === inv.invoice_id
                            return (
                              <Fragment key={`${inv.invoice_id}-${i}`}>
                                <TableRow
                                  className="border-emerald-500/5 hover:bg-emerald-500/5 cursor-pointer"
                                  onClick={() => setExpandedInvoiceId(isExpanded ? null : inv.invoice_id)}
                                >
                                  <TableCell className="text-sm text-white font-medium py-2.5">{inv.customer_name}</TableCell>
                                  <TableCell className="py-2.5">{sourceBadge(inv.source)}</TableCell>
                                  <TableCell className="text-xs text-gray-400 py-2.5">
                                    {inv.due_date ?? "—"}
                                    {inv.days_overdue != null && inv.days_overdue > 0 && (
                                      <span className="block text-red-400 font-medium">{inv.days_overdue}d overdue</span>
                                    )}
                                  </TableCell>
                                  <TableCell className="py-2.5">{statusBadge(inv.status, inv.days_overdue ?? null)}</TableCell>
                                  <TableCell className={`text-right font-mono font-semibold py-2.5 ${inv.status === "overdue" ? "text-red-400" : "text-emerald-400"}`}>
                                    {moneySmall(inv.amount_due)}
                                    {allocs.length > 0 && <span className="block text-[10px] text-gray-500">collected {moneySmall(amountCollected)}</span>}
                                  </TableCell>
                                </TableRow>
                                {isExpanded && allocs.length > 0 && (
                                  <TableRow className="border-emerald-500/5 bg-emerald-500/5">
                                    <TableCell colSpan={5} className="py-3 pl-8">
                                      <div className="space-y-2 text-xs">
                                        <div className="flex gap-4">
                                          <span>Gross: {moneySmall(inv.amount_due)}</span>
                                          <span className="text-amber-400">Fee: {moneySmall(allocs.reduce((s, c) => s + c.fee, 0))}</span>
                                          <span className="text-emerald-400">Net: {moneySmall(allocs.reduce((s, c) => s + c.net, 0))}</span>
                                        </div>
                                        <div className="w-48 h-1.5 bg-white/10 rounded-full overflow-hidden">
                                          <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.min(100, pct)}%` }} />
                                        </div>
                                        <div className="text-gray-500">{pct}% collected</div>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                )}
                              </Fragment>
                            )
                          })}
                        </TableBody>
                      </Table>
                      {arInvoices.length > 0 && (
                        <div className="p-3 border-t border-emerald-500/10 text-center">
                          <span className="text-[11px] text-gray-500">{arInvoices.length} invoice{arInvoices.length !== 1 ? "s" : ""} total</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-8 text-center text-gray-500 text-sm">No outstanding invoices.</div>
                  )}
                </div>

                {/* ─── AP (Accounts Payable) ─── */}
                <div className="bg-red-500/5 border border-red-500/20 rounded-xl overflow-hidden">
                  <div className="p-5 border-b border-red-500/10">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-base font-semibold text-red-400 flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-red-400" />
                          AP (Accounts Payable)
                        </h3>
                        <p className="text-xs text-gray-400 mt-1">Expected outflow — money you are expected to pay.</p>
                      </div>
                      <div className="flex gap-4 shrink-0">
                        <div className="text-right">
                          <div className="text-2xl font-bold font-mono text-red-400">{money(arApData.ap.total_expected_30d)}</div>
                          <div className="text-[10px] text-gray-500">Next 30 days</div>
                        </div>
                        <div className="text-right">
                          <div className="text-xl font-bold text-white">{arApData.ap.obligation_count}</div>
                          <div className="text-[10px] text-gray-500">Obligations</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {apObligations.length > 0 ? (
                    <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-red-500/10 hover:bg-transparent sticky top-0 bg-red-500/10 backdrop-blur-sm z-10">
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold">Vendor</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-20">Source</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-28">Cadence</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-20">Due in</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-20">Confidence</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-24 text-right">Expected</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {apObligations.map((ob) => {
                            const obExt = ob as { allocations?: { movement_id: string; gross: number; fee: number; net: number }[]; amount_paid?: number; amount_remaining?: number }
                            const allocs = obExt.allocations ?? []
                            const amountPaid = obExt.amount_paid ?? allocs.reduce((s: number, c: { gross: number }) => s + c.gross, 0)
                            const pct = ob.expected_amount > 0 ? Math.round((amountPaid / ob.expected_amount) * 100) : 0
                            const isExpanded = expandedObligationId === ob.obligation_id
                            return (
                              <Fragment key={ob.obligation_id}>
                                <TableRow
                                  className="border-red-500/5 hover:bg-red-500/5 cursor-pointer"
                                  onClick={() => setExpandedObligationId(isExpanded ? null : ob.obligation_id)}
                                >
                                  <TableCell className="text-sm text-white font-medium py-2.5">
                                    <div className="flex items-center gap-2">
                                      {ob.vendor_name}
                                      {ob.risk_flag && (
                                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">{ob.risk_flag}</span>
                                      )}
                                      {ob.priority === "high" && !ob.risk_flag && (
                                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">high</span>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-xs text-gray-400 py-2.5">
                                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                      (ob.source ?? "inferred") === "bill" ? "bg-blue-500/20 text-blue-300" : "bg-gray-500/20 text-gray-400"
                                    }`}>{ob.source ?? "inferred"}</span>
                                  </TableCell>
                                  <TableCell className="text-xs text-gray-400 py-2.5">{(ob.cadence ?? "") === "bill" ? "bill" : `${ob.cadence ?? "—"} · ${ob.payment_count ?? 0} payments`}</TableCell>
                                  <TableCell className="text-xs text-gray-400 py-2.5">
                                    {ob.days_overdue != null && ob.days_overdue > 0 ? (
                                      <span className="text-red-400">{ob.days_overdue}d overdue</span>
                                    ) : (
                                      `${ob.days_until_due} days`
                                    )}
                                  </TableCell>
                                  <TableCell className="py-2.5">
                                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                      ob.confidence === "high" ? "bg-emerald-500/20 text-emerald-300" :
                                      ob.confidence === "medium" ? "bg-amber-500/20 text-amber-300" : "bg-gray-500/20 text-gray-400"
                                    }`}>{ob.confidence}</span>
                                  </TableCell>
                                  <TableCell className="text-right font-mono font-semibold text-red-400 py-2.5">
                                    {moneySmall(ob.expected_amount)}
                                    {allocs.length > 0 && <span className="block text-[10px] text-gray-500">paid {moneySmall(amountPaid)}</span>}
                                  </TableCell>
                                </TableRow>
                                {isExpanded && allocs.length > 0 && (
                                  <TableRow className="border-red-500/5 bg-red-500/5">
                                    <TableCell colSpan={6} className="py-3 pl-8">
                                      <div className="space-y-2 text-xs">
                                        <div className="flex gap-4">
                                          <span>Gross: {moneySmall(amountPaid)}</span>
                                          <span className="text-amber-400">Fee: {moneySmall(allocs.reduce((s, c) => s + c.fee, 0))}</span>
                                          <span className="text-red-400">Net: {moneySmall(allocs.reduce((s, c) => s + c.net, 0))}</span>
                                        </div>
                                        <div className="w-48 h-1.5 bg-white/10 rounded-full overflow-hidden">
                                          <div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.min(100, pct)}%` }} />
                                        </div>
                                        <div className="text-gray-500">{pct}% paid</div>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                )}
                              </Fragment>
                            )
                          })}
                        </TableBody>
                      </Table>
                      {apObligations.length > 0 && (
                        <div className="p-3 border-t border-red-500/10 text-center">
                          <span className="text-[11px] text-gray-500">{apObligations.length} obligation{apObligations.length !== 1 ? "s" : ""} in next 30d</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-8 text-center text-gray-500 text-sm">No recurring vendor obligations detected in the next 30 days.</div>
                  )}
                </div>
                </>
                )}

                {/* ─── Tagged bank transactions (reconciliation) ─── */}
                {mappingRecon && allReconRows.length > 0 && (
                  <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
                    <h3 className="text-base font-semibold text-white px-4 py-3 border-b border-white/10">Tagged bank transactions</h3>
                    <div className="max-h-[min(70vh,900px)] overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-white/10 hover:bg-transparent bg-white/5 sticky top-0 z-10 backdrop-blur-sm">
                            <TableHead className="text-[10px] uppercase text-gray-500">Payment</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 w-24">Gross</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 w-20">Fee</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 w-24">Net</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500">Linked AR/AP</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {allReconRows.map((r) => {
                            const totalFee = (r.allocations ?? []).reduce((s: number, a: { fee: number }) => s + a.fee, 0)
                            const totalGross = (r.allocations ?? []).reduce((s: number, a: { gross: number }) => s + a.gross, 0)
                            const totalNet = (r.allocations ?? []).reduce((s: number, a: { net: number }) => s + a.net, 0)
                            const linked = (r.allocations ?? []).length > 0
                              ? (r.allocations ?? []).map((a: { entity_type: string; entity_id: string }) => `${a.entity_type.toUpperCase()}: ${a.entity_id.slice(0, 12)}...`).join(", ")
                              : "—"
                            return (
                              <TableRow key={r.movement_id} className={`border-white/5 ${(r.allocations ?? []).length === 0 ? "bg-amber-500/5" : ""}`}>
                                <TableCell className="py-2">
                                  <span className={r.direction === "inflow" ? "text-emerald-400" : "text-red-400"}>
                                    {r.direction === "inflow" ? "+" : "-"}{money2(r.amount)}
                                  </span>
                                  <span className="text-gray-500 text-xs block">{(r as { date?: string }).date} · {(r as { display_name?: string | null }).display_name ?? r.counterparty ?? "—"}</span>
                                </TableCell>
                                <TableCell className="py-2 font-mono text-sm">{totalGross > 0 ? money2(totalGross) : money2(r.amount)}</TableCell>
                                <TableCell className="py-2 font-mono text-amber-400 text-sm">{totalFee > 0 ? money2(totalFee) : "—"}</TableCell>
                                <TableCell className="py-2 font-mono text-sm">{totalNet > 0 ? money2(totalNet) : money2(r.amount)}</TableCell>
                                <TableCell className="py-2 text-xs text-gray-400 truncate max-w-[160px]">{linked}</TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    </div>
                    <div className="px-4 py-2 border-t border-white/10 text-xs text-gray-500 text-center">
                      {allReconRows.length} bank transaction{allReconRows.length !== 1 ? "s" : ""}
                    </div>
                  </div>
                )}

              </div>
            )}
          </div>
        )
      }

      case 12: {
        const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        const badge = (severity: "info" | "warning" | "critical") =>
          severity === "critical"
            ? "text-red-300 bg-red-500/10 border-red-500/20"
            : severity === "warning"
              ? "text-amber-300 bg-amber-500/10 border-amber-500/20"
              : "text-blue-300 bg-blue-500/10 border-blue-500/20"
        const bandColor = (b: SeverityBand) =>
          b === "critical" ? "text-red-400" : b === "high" ? "text-orange-400" : b === "elevated" ? "text-amber-400" : b === "moderate" ? "text-yellow-300" : "text-emerald-400"
        const pct = (n: number) => `${(n * 100).toFixed(1)}%`
        const confColor = (c: number) => c >= 95 ? "text-emerald-400" : c >= 85 ? "text-yellow-300" : c >= 70 ? "text-amber-400" : "text-red-400"

        return (
          <div className="space-y-6">
            <div className="text-center mb-2">
              <h2 className="text-2xl font-semibold text-white mb-1">{steps[11].title}</h2>
              <p className="text-gray-400 text-lg mb-5">{steps[11].description}</p>

              {stateLoading && (
                <div className="flex items-center justify-center gap-2 py-6 text-gray-400">
                  <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Loading state objects…
                </div>
              )}

              {stateError && !stateLoading && (
                <p className="text-red-300 text-sm mb-4">Failed: {stateError}</p>
              )}
            </div>

            {!stateLoading && stateData && (
              <div className="space-y-6">
                {/* ─── Insight Block ─── */}
                {stateData.insight_block && (
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4">
                    <div className="text-xs uppercase tracking-wider text-emerald-400/80 mb-2">Summary</div>
                    <p className="text-sm text-gray-200 leading-relaxed">{stateData.insight_block}</p>
                  </div>
                )}

                {/* ─── Insights ─── */}
                {stateData.insights.length > 0 && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                    <div className="text-xs uppercase tracking-wider text-gray-400 mb-3">Insights</div>
                    <div className="space-y-2">
                      {stateData.insights.map((ins) => (
                        <div key={ins.id} className="flex items-start gap-2.5">
                          <span className={`mt-0.5 shrink-0 w-2 h-2 rounded-full ${ins.severity === "high" ? "bg-red-400" : ins.severity === "medium" ? "bg-amber-400" : "bg-blue-400"}`} />
                          <span className="text-sm text-gray-200">{ins.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ─── Financial Risk ─── */}
                <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Financial Risk</h3>
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                      stateData.risk.overall === "high" ? "bg-red-500/20 text-red-300 border border-red-500/30"
                        : stateData.risk.overall === "medium" ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                        : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                    }`}>
                      {stateData.risk.overall.toUpperCase()} RISK
                    </span>
                  </div>

                  <div className="space-y-3">
                    {(["liquidity_risk", "concentration_risk", "dependency_risk", "anomaly_risk", "uncertainty_risk"] as const).map((key) => {
                      const dim = stateData.risk[key]
                      const label = key.replace(/_risk$/, "").replace(/_/g, " ")
                      const barColor = dim.level === "high" ? "bg-red-400" : dim.level === "medium" ? "bg-amber-400" : "bg-emerald-400"
                      const textColor = dim.level === "high" ? "text-red-400" : dim.level === "medium" ? "text-amber-400" : "text-emerald-400"
                      const bufferTooltip = key === "liquidity_risk" ? "Based on period net cash flow and average daily outflows. Excludes transfers and owner inflows from burn calculation." : undefined
                      return (
                        <div key={key}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm text-gray-300 capitalize">{label}</span>
                            <span className={`text-xs font-semibold ${textColor}`}>{dim.level.toUpperCase()}</span>
                          </div>
                          <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden mb-1">
                            <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${Math.min(dim.score, 100)}%` }} />
                          </div>
                          <div className="text-[11px] text-gray-500" title={bufferTooltip}>{dim.reason}</div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="mt-4 pt-3 border-t border-white/10">
                    <div className="text-center mb-2">
                      <span className="text-xs text-gray-500">Overall risk score: </span>
                      <span className={`text-sm font-bold ${
                        stateData.risk.overall === "high" ? "text-red-400" : stateData.risk.overall === "medium" ? "text-amber-400" : "text-emerald-400"
                      }`}>{stateData.risk.overall_score}/100</span>
                    </div>
                    <div className="text-[10px] text-gray-500 text-center flex flex-wrap justify-center gap-x-3 gap-y-1">
                      <span>Liquidity 30% → {Math.round(stateData.risk.liquidity_risk.score * 0.30)}</span>
                      <span>Concentration 20% → {Math.round(stateData.risk.concentration_risk.score * 0.20)}</span>
                      <span>Dependency 25% → {Math.round(stateData.risk.dependency_risk.score * 0.25)}</span>
                      <span>Anomaly 10% → {Math.round(stateData.risk.anomaly_risk.score * 0.10)}</span>
                      <span>Uncertainty 15% → {Math.round(stateData.risk.uncertainty_risk.score * 0.15)}</span>
                    </div>
                  </div>
                </div>

                {/* ─── Excluded & Unresolved ─── */}
                {(stateData.revenue.excluded_revenue > 0 || stateData.spend.excluded_spend > 0 || stateData.liquidity.excluded_cash > 0) && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
                    <div className="text-xs uppercase tracking-wider text-amber-400/90 mb-2">Excluded from state</div>
                    <div className="text-xs text-gray-300 space-y-1">
                      {stateData.revenue.excluded_revenue > 0 && (
                        <div>Revenue: {money(stateData.revenue.excluded_revenue)} ({stateData.revenue.gross_revenue > 0 ? Math.round((stateData.revenue.excluded_revenue / stateData.revenue.gross_revenue) * 100) : 0}% of gross)</div>
                      )}
                      {stateData.spend.excluded_spend > 0 && (
                        <div>Spend: {money(stateData.spend.excluded_spend)} ({stateData.spend.total_spend > 0 ? Math.round((stateData.spend.excluded_spend / stateData.spend.total_spend) * 100) : 0}% of total)</div>
                      )}
                      {stateData.liquidity.excluded_cash > 0 && (
                        <div>Liquidity: {money(stateData.liquidity.excluded_cash)} ({(stateData.liquidity.total_inflows + stateData.liquidity.total_outflows) > 0 ? Math.round((stateData.liquidity.excluded_cash / (stateData.liquidity.total_inflows + stateData.liquidity.total_outflows)) * 100) : 0}% of total flow)</div>
                      )}
                    </div>
                  </div>
                )}

                {/* ─── State Confidence ─── */}
                <div className="flex items-center justify-center gap-6 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="text-gray-500">Revenue confidence:</span>
                    <span className={`font-semibold ${confColor(stateData.state_confidence.revenue_confidence)}`}>{stateData.state_confidence.revenue_confidence}%</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-gray-500">Spend confidence:</span>
                    <span className={`font-semibold ${confColor(stateData.state_confidence.spend_confidence)}`}>{stateData.state_confidence.spend_confidence}%</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-gray-500">Liquidity confidence:</span>
                    <span className={`font-semibold ${confColor(stateData.state_confidence.liquidity_confidence)}`}>{stateData.state_confidence.liquidity_confidence}%</span>
                  </div>
                </div>

                {/* ─── Revenue State ─── */}
                <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                  <div className="text-xs uppercase tracking-wider text-gray-400 mb-3">Revenue state</div>
                  <div className="flex items-baseline gap-3 mb-1">
                    <div className="text-3xl font-bold text-emerald-400">{money(stateData.revenue.net_revenue)}</div>
                    <div className="text-xs text-gray-500">net revenue</div>
                  </div>
                  <div className="text-xs text-gray-500 mb-4">
                    Gross {money(stateData.revenue.gross_revenue)} − Contra {money(stateData.revenue.contra_revenue)} = Net {money(stateData.revenue.net_revenue)}
                  </div>
                  <div className="grid grid-cols-5 gap-2 text-center mb-4">
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className="text-sm font-semibold text-white">{stateData.revenue.customer_count}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">Customers</div>
                    </div>
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className="text-sm font-semibold text-white">{money(stateData.revenue.avg_receipt)}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">Avg receipt</div>
                    </div>
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className="text-sm font-semibold text-white">{stateData.revenue.top_customer_pct}%</div>
                      <div className="text-[10px] text-gray-500 mt-0.5" title="Share of revenue from the single largest customer.">Top cust %</div>
                    </div>
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className="text-sm font-semibold text-white">{Math.round(stateData.revenue.repeat_revenue_ratio * 100)}%</div>
                      <div className="text-[10px] text-gray-500 mt-0.5" title="Share of revenue in this period from customers who also paid in a prior period.">Repeat revenue</div>
                    </div>
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className="text-sm font-semibold text-white">{stateData.revenue.concentration_index}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">HHI</div>
                    </div>
                  </div>
                  {stateData.revenue.revenue_by_customer.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase text-gray-500 mb-1.5">Top customers</div>
                      <div className="space-y-1">
                        {stateData.revenue.revenue_by_customer.slice(0, 5).map((c, i) => (
                          <div key={i} className="flex items-center justify-between text-xs">
                            <span className="text-gray-300 truncate max-w-[60%]">{c.name}</span>
                            <span className="text-gray-400 font-mono">{money(c.total)} ({c.count}x)</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(stateData.revenue.provisional_revenue > 0 || stateData.revenue.excluded_revenue > 0) && (
                    <div className="mt-3 pt-3 border-t border-white/5 text-[10px] text-gray-600">
                      {stateData.revenue.provisional_revenue > 0 && <span>Provisional: {money(stateData.revenue.provisional_revenue)} · </span>}
                      {stateData.revenue.excluded_revenue > 0 && <span>Excluded: {money(stateData.revenue.excluded_revenue)}</span>}
                    </div>
                  )}
                </div>

                {/* ─── Spend State ─── */}
                <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                  <div className="text-xs uppercase tracking-wider text-gray-400 mb-3">Spend state</div>
                  <div className="flex items-baseline gap-3 mb-1">
                    <div className="text-3xl font-bold text-amber-400">{money(stateData.spend.total_spend)}</div>
                    <div className="text-xs text-gray-500">total</div>
                  </div>
                  <div className={`text-xs text-gray-500 ${stateData.spend.direct_cost_candidates > 0 ? "mb-2" : "mb-4"}`}>
                    Booked: OpEx {money(stateData.spend.total_opex)} · COGS {money(stateData.spend.total_cogs)}
                  </div>
                  {stateData.spend.direct_cost_candidates > 0 && (
                    <div className="text-xs text-gray-500 mb-4" title="Direct cost estimate is inferred from supplier patterns, not from accounting records.">
                      Analytical: Estimated direct-cost share {money(stateData.spend.direct_cost_candidates)} (not in COGS)
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs mb-4">
                    <div className="flex justify-between"><span className="text-gray-400">Vendor payments</span><span className="text-white font-mono">{money(stateData.spend.vendor_payments)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Payroll</span><span className="text-white font-mono">{money(stateData.spend.payroll)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Processor fees</span><span className="text-white font-mono">{money(stateData.spend.processor_fees)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Bank fees</span><span className="text-white font-mono">{money(stateData.spend.bank_fees)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Taxes</span><span className="text-white font-mono">{money(stateData.spend.taxes)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Recurring ({stateData.spend.recurring_obligation_count})</span><span className="text-white font-mono">{money(stateData.spend.recurring_obligations)}</span></div>
                    {(stateData.spend.recurring_fixed_contractual != null || stateData.spend.recurring_soft != null || stateData.spend.recurring_discretionary != null) && (
                      <div className="grid grid-cols-2 gap-x-6 gap-y-1 pl-2 border-l-2 border-white/10">
                        {stateData.spend.recurring_fixed_contractual != null && stateData.spend.recurring_fixed_contractual > 0 && (
                          <div className="flex justify-between"><span className="text-gray-500 text-[11px]">Fixed contractual</span><span className="text-gray-400 font-mono text-[11px]">{money(stateData.spend.recurring_fixed_contractual)}</span></div>
                        )}
                        {stateData.spend.recurring_soft != null && stateData.spend.recurring_soft > 0 && (
                          <div className="flex justify-between"><span className="text-gray-500 text-[11px]">Soft recurring</span><span className="text-gray-400 font-mono text-[11px]">{money(stateData.spend.recurring_soft)}</span></div>
                        )}
                        {stateData.spend.recurring_discretionary != null && stateData.spend.recurring_discretionary > 0 && (
                          <div className="flex justify-between"><span className="text-gray-500 text-[11px]">Discretionary recurring</span><span className="text-gray-400 font-mono text-[11px]">{money(stateData.spend.recurring_discretionary)}</span></div>
                        )}
                      </div>
                    )}
                    <div className="flex justify-between"><span className="text-gray-400">Non-recurring</span><span className="text-white font-mono">{money(stateData.spend.non_recurring_spend)}</span></div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center mb-4">
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className="text-sm font-semibold text-white">{stateData.spend.vendor_count}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">Vendors</div>
                    </div>
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className="text-sm font-semibold text-white">{stateData.spend.top_vendor_pct}%</div>
                      <div className="text-[10px] text-gray-500 mt-0.5" title="Share of spend with the single largest vendor.">Top vendor %</div>
                    </div>
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className="text-sm font-semibold text-white">{stateData.spend.supplier_concentration_index}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">Supplier HHI</div>
                    </div>
                  </div>

                  {stateData.spend.spend_by_vendor.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase text-gray-500 mb-1.5">Top vendors</div>
                      <div className="space-y-1">
                        {stateData.spend.spend_by_vendor.slice(0, 5).map((v, i) => (
                          <div key={i} className="flex items-center justify-between text-xs">
                            <span className="text-gray-300 truncate max-w-[50%]">{v.name}</span>
                            <span className="text-gray-400 font-mono">{money(v.total)} ({v.pct_of_spend}%) · {v.count}x</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(stateData.spend.provisional_spend > 0 || stateData.spend.excluded_spend > 0) && (
                    <div className="mt-3 pt-3 border-t border-white/5 text-[10px] text-gray-600">
                      {stateData.spend.provisional_spend > 0 && <span>Provisional: {money(stateData.spend.provisional_spend)} · </span>}
                      {stateData.spend.excluded_spend > 0 && <span>Excluded: {money(stateData.spend.excluded_spend)}</span>}
                    </div>
                  )}
                </div>

                {/* ─── Liquidity State ─── */}
                <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                  <div className="text-xs uppercase tracking-wider text-gray-400 mb-3">Liquidity state</div>
                  <div className="flex items-baseline gap-3 mb-1">
                    <div className="text-3xl font-bold text-blue-300">{money(stateData.liquidity.period_net_cash_flow)}</div>
                    <div className="text-xs text-gray-500">period net cash flow</div>
                  </div>
                  <div className="text-xs text-gray-500 mb-4">
                    In {money(stateData.liquidity.total_inflows)} · Out {money(stateData.liquidity.total_outflows)}
                  </div>

                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs mb-4">
                    <div className="flex justify-between"><span className="text-gray-400" title="Business-generated net cash">Net operating</span><span className="text-white font-mono">{money(stateData.liquidity.net_operating)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-400" title="Debt, credit, owner contributions">Net financing</span><span className="text-white font-mono">{money(stateData.liquidity.net_financing)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-400" title="Timing-related processor inflows/outflows">Net settlement</span><span className="text-white font-mono">{money(stateData.liquidity.net_settlement)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-400" title="Owner/personal support (subset of financing)">Net owner</span><span className="text-white font-mono">{money(stateData.liquidity.net_owner)}</span></div>
                    {stateData.liquidity.settlement_lag && stateData.liquidity.settlement_lag.confidence !== "insufficient" && (
                      <div className="flex justify-between"><span className="text-gray-400" title="Average days from customer payment (e.g. card charge) to funds arriving in your bank.">Settlement lag (payment → bank)</span><span className="text-white font-mono">~{stateData.liquidity.settlement_lag.avg_settlement_lag_days.toFixed(1)}d ({stateData.liquidity.settlement_lag.sample_count} samples)</span></div>
                    )}
                  </div>

                  <div className="grid grid-cols-4 gap-2 text-center mb-4">
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className={`text-sm font-semibold ${stateData.liquidity.liquidity_regime === "strong" ? "text-emerald-400" : stateData.liquidity.liquidity_regime === "stable" ? "text-yellow-300" : "text-amber-400"}`}>{stateData.liquidity.liquidity_regime}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">Liquidity regime</div>
                    </div>
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className={`text-sm font-semibold ${stateData.liquidity.operating_dependency_ratio >= 0.7 ? "text-emerald-400" : stateData.liquidity.operating_dependency_ratio >= 0.5 ? "text-yellow-300" : "text-red-400"}`}>{pct(stateData.liquidity.operating_dependency_ratio)}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5" title="Share of total inflows from operating activities (customer receipts, vendor refunds, etc.), excluding transfers and financing.">Operating driven</div>
                    </div>
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className="text-sm font-semibold text-white">{pct(stateData.liquidity.transfer_dependency_ratio)}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5" title="Share of total cash flow that is internal transfers between accounts (reallocation, not new cash).">Transfer dep.</div>
                    </div>
                    <div className="bg-white/5 rounded-lg px-2 py-2">
                      <div className={`text-sm font-semibold ${stateData.liquidity.owner_support_ratio > 0.25 ? "text-amber-400" : "text-white"}`}>{pct(stateData.liquidity.owner_support_ratio)}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">Owner support</div>
                    </div>
                  </div>

                  {stateData.liquidity.cash_by_account.length > 0 && (
                    <div className="bg-white/5 rounded-lg p-3">
                      <div className="text-[10px] uppercase text-gray-500 mb-2">Cash by account</div>
                      <div className="space-y-1.5">
                        {stateData.liquidity.cash_by_account.map((a, i) => (
                          <div key={i} className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2 min-w-0 max-w-[55%]">
                              <span className="text-gray-300 truncate">{a.account_name}</span>
                              {a.account_type && <span className="text-[10px] text-gray-600 shrink-0">{a.account_type}</span>}
                            </div>
                            <div className="text-right font-mono">
                              <span className={a.net_flow >= 0 ? "text-emerald-400" : "text-red-400"}>{a.net_flow >= 0 ? "+" : "-"}{money(Math.abs(a.net_flow))}</span>
                              <span className="text-gray-600 ml-2">({a.movement_count})</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {stateData.liquidity.excluded_cash > 0 && (
                    <div className="mt-3 text-[10px] text-gray-600">Excluded: {money(stateData.liquidity.excluded_cash)}</div>
                  )}
                </div>

                {/* ─── Transitions ─── */}
                <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Transition signals</h3>
                    <div className="text-[10px] text-gray-500">Computed {stateData.computed_at.slice(0, 19).replace("T", " ")}</div>
                  </div>

                  <div className="space-y-2">
                    {stateData.transitions.length === 0 && (
                      <div className="text-sm text-gray-500">No transition signals.</div>
                    )}

                    {stateData.transitions.map((s) => (
                      <div key={s.signal} className="flex items-start justify-between gap-3 bg-white/5 rounded-lg px-3 py-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`inline-block text-[10px] font-semibold border rounded px-1.5 py-0.5 ${badge(s.severity)}`}>
                              {s.severity.toUpperCase()}
                            </span>
                            <div className="text-sm font-medium text-white">{s.signal.replace(/_/g, " ")}</div>
                            {s.triggered && <span className="text-[10px] text-red-300 font-semibold">TRIGGERED</span>}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">{s.description}</div>
                          <div className="flex items-center gap-3 mt-1.5">
                            <span className={`text-[10px] font-semibold ${bandColor(s.current_band)}`}>{s.current_state}</span>
                            {s.regime_change && s.previous_state && (
                              <span className="text-[10px] text-gray-600">← was {s.previous_state}</span>
                            )}
                          </div>
                        </div>
                        <div className="text-right text-xs text-gray-400 font-mono whitespace-nowrap">
                          {s.current_value}{s.previous_value !== null ? ` (prev ${s.previous_value})` : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ─── Refresh ─── */}
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={stateLoading}
                    onClick={() => {
                      setStateLoading(true)
                      setStateError(null)
                      fetch("/api/state")
                        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
                        .then((data: BusinessState) => { setStateData(data); setStateLoading(false) })
                        .catch((err) => { setStateError(err instanceof Error ? err.message : "Failed to load state"); setStateLoading(false) })
                    }}
                    className="rounded-lg border border-white/20 bg-white/5 px-4 py-3 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="text-sm font-medium text-white">{stateLoading ? "Loading…" : "Refresh state"}</div>
                    <div className="text-xs text-gray-400">Recompute from latest tags</div>
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      }

      case 13: {
        const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        const signedMoney = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        const behaviorLabel = (b: ComponentBehavior) => b === "recurring" ? "Recurring" : b === "episodic" ? "Episodic" : b === "seasonal" ? "Seasonal" : "One-time"
        const confDot = (c: "high" | "medium" | "low") => c === "high" ? "bg-emerald-400" : c === "medium" ? "bg-amber-400" : "bg-red-400"
        const scenarioColor = (s: string) => s === "optimistic" ? "text-emerald-400" : s === "pessimistic" ? "text-red-400" : "text-blue-400"
        const scenarioBorder = (s: string) => s === "optimistic" ? "border-emerald-500/20" : s === "pessimistic" ? "border-red-500/20" : "border-blue-500/20"
        const scenarioBg = (s: string) => s === "optimistic" ? "bg-emerald-500/10" : s === "pessimistic" ? "bg-red-500/10" : "bg-blue-500/10"

        return (
          <div className="space-y-6">
            <div className="text-center mb-2">
              <h2 className="text-2xl font-semibold text-white mb-1">{steps[12].title}</h2>
              <p className="text-gray-400 text-lg mb-5">{steps[12].description}</p>

              {forecastLoading && (
                <div className="flex items-center justify-center gap-2 py-6 text-gray-400">
                  <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Computing forecast…
                </div>
              )}

              {forecastError && !forecastLoading && (
                <p className="text-red-300 text-sm mb-4">Failed: {forecastError}</p>
              )}
            </div>

            {!forecastLoading && forecastData && (
              <div className="space-y-6">
                {/* ─── Data Quality + Forecast Confidence ─── */}
                <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
                  <span>Data span: {forecastData.data_span_days}d</span>
                  <span>Components: {forecastData.components.length}</span>
                  <span>Horizon: {forecastData.forecast_horizon_months} months</span>
                  {forecastData.context && (
                    <span className="text-gray-400">Balance: <span className={forecastData.context.balance_source === "plaid" ? "text-emerald-400" : "text-amber-400"}>{forecastData.context.balance_source === "plaid" ? "Live (Plaid)" : "Derived"}</span></span>
                  )}
                  {forecastData.forecast_confidence && (
                    <span className={`font-semibold ${forecastData.forecast_confidence.label === "high" ? "text-emerald-400" : forecastData.forecast_confidence.label === "medium" ? "text-amber-400" : "text-red-400"}`}>
                      Forecast confidence: {Math.round(forecastData.forecast_confidence.score * 100)}% ({forecastData.forecast_confidence.label})
                    </span>
                  )}
                </div>
                {/* ─── Context: Risk & Account Balances ─── */}
                {forecastData.context && (forecastData.context.risk_score > 0 || forecastData.context.account_balances.length > 0) && (
                  <div className="flex flex-col gap-1 text-[10px] text-gray-400 mt-1">
                    <div className="flex flex-wrap gap-3">
                      {forecastData.context.risk_score > 0 && (
                        <span>Risk: <span className={forecastData.context.risk_level === "high" ? "text-red-400 font-semibold" : forecastData.context.risk_level === "medium" ? "text-amber-400" : "text-emerald-400"}>{forecastData.context.risk_level} ({forecastData.context.risk_score})</span></span>
                      )}
                    {forecastData.context.liquidity_regime !== "stable" && (
                      <span>Regime: <span className={forecastData.context.liquidity_regime === "tightening" ? "text-red-400" : "text-emerald-400"}>{forecastData.context.liquidity_regime}</span></span>
                    )}
                    {forecastData.sensitivity?.top_risk_driver && (
                      <span>Top risk: <span className="text-red-300">{forecastData.sensitivity.top_risk_driver}</span></span>
                    )}
                    {forecastData.sensitivity?.top_opportunity_driver && (
                      <span>Largest near-term expected inflow: <span className="text-emerald-300">{forecastData.sensitivity.top_opportunity_driver}</span></span>
                    )}
                    {forecastData.context.account_balances.length > 0 && forecastData.context.account_balances.map((ab) => (
                      <span key={ab.account_id}>{ab.name}: <span className="text-white font-mono">${Math.round(ab.balance).toLocaleString()}</span></span>
                    ))}
                    </div>
                    {forecastData.context.risk_decomposition && (
                      <div className="text-[9px] text-gray-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span title="Liquidity risk (30% weight)">+{Math.round(forecastData.context.risk_decomposition.liquidity * 0.30)} liquidity</span>
                        <span title="Concentration risk (20% weight)">+{Math.round(forecastData.context.risk_decomposition.concentration * 0.20)} concentration</span>
                        <span title="Dependency risk (25% weight)">+{Math.round(forecastData.context.risk_decomposition.dependency * 0.25)} dependency</span>
                        <span title="Anomaly risk (10% weight)">+{Math.round(forecastData.context.risk_decomposition.anomaly * 0.10)} anomaly</span>
                        <span title="Uncertainty risk (15% weight)">+{Math.round(forecastData.context.risk_decomposition.uncertainty * 0.15)} data coverage</span>
                      </div>
                    )}
                  </div>
                )}

                {/* ─── Narrative: The Final Output ─── */}
                {(() => {
                  const n = forecastData.narrative
                  const borderColor = n.severity === "danger" ? "border-red-500/30" : n.severity === "caution" ? "border-amber-500/30" : "border-emerald-500/30"
                  const bgColor = n.severity === "danger" ? "bg-red-500/5" : n.severity === "caution" ? "bg-amber-500/5" : "bg-emerald-500/5"
                  const accentColor = n.severity === "danger" ? "text-red-400" : n.severity === "caution" ? "text-amber-400" : "text-emerald-400"
                  return (
                    <div className={`border rounded-xl p-6 ${borderColor} ${bgColor}`}>
                      <div className="space-y-4">
                        <div className="flex items-start gap-3">
                          <span className="text-lg mt-0.5">🔮</span>
                          <div>
                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-0.5">Forecast</div>
                            <div className={`text-sm font-semibold ${accentColor}`}>{n.forecast}</div>
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <span className="text-lg mt-0.5">⚠️</span>
                          <div>
                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-0.5">Risk</div>
                            <div className="text-sm text-gray-200">{n.risk}</div>
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <span className="text-lg mt-0.5">🧠</span>
                          <div>
                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-0.5">Insight</div>
                            <div className="text-sm text-gray-300">{n.insight}</div>
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <span className="text-lg mt-0.5">🎯</span>
                          <div>
                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-0.5">Action</div>
                            <div className="text-sm text-white font-medium">{n.action}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })()}

                {/* ─── Next 7 Days — Top Drivers ─── */}
                {forecastData.events_30d.length > 0 && (() => {
                  const allEvents = forecastData.events_30d
                  const events7d = allEvents.filter((e) => e.day_offset <= 7)
                  const probTemp = forecastData.backtest?.calibration?.probability_temperature
                  const adjProb = (p: number) => (probTemp && probTemp > 1 ? Math.pow(p, probTemp) : p)
                  const topByImpact = [...allEvents].sort((a, b) => (b.amount * b.probability) - (a.amount * a.probability)).slice(0, 10)
                  const totalIn = allEvents.filter((e) => e.direction === "in").reduce((s, e) => s + e.amount * e.probability, 0)
                  const totalOut = allEvents.filter((e) => e.direction === "out").reduce((s, e) => s + e.amount * e.probability, 0)
                  const net = totalIn - totalOut
                  const sim = forecastData.daily_simulation
                  const lowDay = sim.min_cash_day > 0 ? sim.days.find((d) => d.day === sim.min_cash_day) : null

                  return (
                    <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                      {/* Summary bar */}
                      <div className="grid grid-cols-4 gap-3 mb-5 text-center">
                        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg py-2">
                          <div className="text-[10px] text-emerald-400/70">Expected in</div>
                          <div className="text-sm font-bold font-mono text-emerald-400">{money(totalIn)}</div>
                        </div>
                        <div className="bg-red-500/10 border border-red-500/20 rounded-lg py-2">
                          <div className="text-[10px] text-red-400/70">Expected out</div>
                          <div className="text-sm font-bold font-mono text-red-400">{money(totalOut)}</div>
                        </div>
                        <div className={`${net >= 0 ? "bg-blue-500/10 border-blue-500/20" : "bg-amber-500/10 border-amber-500/20"} border rounded-lg py-2`}>
                          <div className="text-[10px] text-gray-400">Net</div>
                          <div className={`text-sm font-bold font-mono ${net >= 0 ? "text-blue-400" : "text-amber-400"}`}>{signedMoney(net)}</div>
                        </div>
                        {lowDay && sim.min_cash < sim.starting_cash * 0.8 && (
                          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg py-2">
                            <div className="text-[10px] text-amber-400/70">Low point D{sim.min_cash_day}</div>
                            <div className="text-sm font-bold font-mono text-amber-400">{money(sim.min_cash)}</div>
                          </div>
                        )}
                      </div>

                      {/* Next 7 Days */}
                      {events7d.length > 0 && (
                        <>
                          <h3 className="text-xs font-semibold text-white uppercase tracking-wider mb-2">Next 7 days</h3>
                          <div className="space-y-1 mb-4">
                            {events7d.slice(0, 8).map((evt, i) => {
                              const typeColor = evt.direction === "in" ? "text-emerald-400" : "text-red-400"
                              const confDot = evt.confidence === "high" ? "bg-emerald-500" : evt.confidence === "medium" ? "bg-amber-500" : "bg-red-500"
                              return (
                                <div key={`7d-${evt.date}-${evt.entity}-${i}`} className="flex items-center gap-2 py-1.5 px-2 rounded bg-white/[0.02]">
                                  <span className="text-xs font-mono text-gray-500 w-8 shrink-0">D+{evt.day_offset}</span>
                                  <span className={`w-1.5 h-1.5 rounded-full ${confDot} shrink-0`} title={`${evt.confidence} confidence (${evt.source_model})`} />
                                  <span className={`text-xs truncate flex-1 ${typeColor}`}>{evt.entity}</span>
                                  <span className="text-[10px] text-gray-600 shrink-0" title={probTemp ? "Calibration-adjusted probability" : undefined}>
                                    {Math.round(adjProb(evt.probability) * 100)}%
                                  </span>
                                  <span className={`text-sm font-mono font-semibold shrink-0 w-20 text-right ${typeColor}`}>
                                    {evt.direction === "in" ? "+" : "-"}{money(evt.amount)}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        </>
                      )}

                      {/* Top 10 Drivers (by expected impact, grouped by entity) */}
                      <h3 className="text-xs font-semibold text-white uppercase tracking-wider mb-2">Top 10 drivers (30d)</h3>
                      <div className="space-y-1 mb-3">
                        {(() => {
                          const entityKey = (e: typeof allEvents[0]) => e.entity.trim().toLowerCase()
                          const byEntity = new Map<string, { entity: string; direction: "in" | "out"; events: typeof allEvents; expectedImpact: number }>()
                          for (const evt of allEvents) {
                            const key = entityKey(evt)
                            const existing = byEntity.get(key)
                            const impact = evt.amount * evt.probability
                            if (existing) {
                              existing.events.push(evt)
                              existing.expectedImpact += impact
                            } else {
                              byEntity.set(key, { entity: evt.entity, direction: evt.direction, events: [evt], expectedImpact: impact })
                            }
                          }
                          const grouped = [...byEntity.values()]
                            .sort((a, b) => Math.abs(b.expectedImpact) - Math.abs(a.expectedImpact))
                            .slice(0, 10)
                          return grouped.map((g, i) => {
                            const evt = g.events[0]
                            const typeColor = g.direction === "in" ? "text-emerald-400" : "text-red-400"
                            const cDot = evt.confidence === "high" ? "bg-emerald-500" : evt.confidence === "medium" ? "bg-amber-500" : "bg-red-500"
                            const r = evt.reasoning
                            const tooltipParts = [r?.basis, r?.payment_history, r?.interval_info, r?.invoice_info, r?.recurrence_info].filter(Boolean)
                            const tooltip = tooltipParts.join(" | ")
                            const dayRange = g.events.length > 1
                              ? `D+${Math.min(...g.events.map((e) => e.day_offset))}–${Math.max(...g.events.map((e) => e.day_offset))}`
                              : `D+${evt.day_offset}`
                            return (
                              <div key={`top-${g.entity}-${i}`}>
                                <div className="flex items-center gap-2 py-1.5 px-2 rounded bg-white/[0.02]" title={tooltip}>
                                  <span className="text-xs font-mono text-gray-500 w-12 shrink-0">{dayRange}</span>
                                  <span className={`w-1.5 h-1.5 rounded-full ${cDot} shrink-0`} />
                                  <span className={`text-xs truncate flex-1 ${typeColor}`}>
                                    {g.entity}{g.events.length > 1 ? ` (${g.events.length} payments)` : ""}
                                  </span>
                                  <span className="text-[10px] text-gray-600 shrink-0">{evt.type.replace(/_/g, " ")}</span>
                                  <span className={`text-sm font-mono font-semibold shrink-0 w-24 text-right ${typeColor}`}>
                                    {g.direction === "in" ? "+" : "-"}{money(g.expectedImpact)}
                                    {g.events.length > 1 && <span className="text-[9px] text-gray-500 font-normal ml-0.5">exp</span>}
                                  </span>
                                </div>
                                {r && (
                                  <div className="text-[9px] text-gray-600 px-2 pb-0.5">{r.basis}{r.invoice_info ? ` · ${r.invoice_info}` : ""}</div>
                                )}
                              </div>
                            )
                          })
                        })()}
                      </div>

                      {/* Expand all events */}
                      <button type="button" onClick={() => toggleSection("all-events")} className="text-xs text-blue-400 hover:text-blue-300">
                        {expandedSections.has("all-events") ? "▾ Hide" : "▸ Show"} all {allEvents.length} events
                      </button>
                      {expandedSections.has("all-events") && (
                        <div className="space-y-1 mt-2 max-h-[300px] overflow-y-auto">
                          {allEvents.map((evt, i) => {
                            const typeColor = evt.direction === "in" ? "text-emerald-400" : "text-red-400"
                            return (
                              <div key={`all-${evt.date}-${evt.entity}-${i}`} className="flex items-center gap-2 py-1 px-2 text-[11px] bg-white/[0.02]">
                                <span className="font-mono text-gray-600 w-8 shrink-0">D+{evt.day_offset}</span>
                                <span className={`truncate flex-1 ${typeColor}`}>{evt.entity}</span>
                                <span className="text-gray-600 shrink-0">{evt.type.replace(/_/g, " ")}</span>
                                <span className={`font-mono font-semibold shrink-0 w-20 text-right ${typeColor}`}>
                                  {evt.direction === "in" ? "+" : "-"}{money(evt.amount)}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* ─── Daily Cashflow Simulation ─── */}
                {forecastData.daily_simulation.days.length > 0 && (() => {
                  const sim = forecastData.daily_simulation
                  const maxCash = Math.max(sim.starting_cash, ...sim.days.map((d) => d.cash))
                  const minCash = Math.min(sim.starting_cash, ...sim.days.map((d) => d.cash))
                  const range = Math.max(1, maxCash - minCash)
                  const barHeight = (cash: number) => Math.max(2, ((cash - minCash) / range) * 100)

                  return (
                    <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold text-white uppercase tracking-wider">Daily Cash Position — 30 Days</h3>
                        <div className="flex items-center gap-4 text-xs">
                          <span className="text-gray-500">Start: <span className="text-white font-mono">{money(sim.starting_cash)}</span></span>
                          <span className="text-gray-500">End: <span className={`font-mono ${sim.ending_cash >= sim.starting_cash ? "text-emerald-400" : "text-red-400"}`}>{money(sim.ending_cash)}</span></span>
                        </div>
                      </div>

                      {sim.min_cash < sim.starting_cash * 0.5 && (
                        <div className="mb-3 flex items-center gap-2 text-xs">
                          <span className="text-amber-400 font-semibold">Expected path low</span>
                          <span className="text-gray-400">Day {sim.min_cash_day}: {money(sim.min_cash)}</span>
                        </div>
                      )}

                      {/* Bar chart */}
                      <div className="flex items-end gap-[2px] h-24 mb-2">
                        {sim.days.map((d) => {
                          const h = barHeight(d.cash)
                          const isMin = d.day === sim.min_cash_day && sim.min_cash < sim.starting_cash * 0.7
                          const color = d.cash < 0 ? "bg-red-500" : isMin ? "bg-amber-400" : d.cash >= sim.starting_cash ? "bg-emerald-400/70" : "bg-blue-400/70"
                          return (
                            <div
                              key={d.day}
                              className={`flex-1 rounded-t-sm ${color} transition-all relative group cursor-default`}
                              style={{ height: `${h}%` }}
                            >
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10 bg-gray-900 border border-white/20 rounded px-2 py-1.5 text-[10px] whitespace-nowrap shadow-lg">
                                <div className="text-white font-semibold">D{d.day} — {d.date}</div>
                                <div className="text-gray-400">Cash: <span className="text-white font-mono">{money(d.cash)}</span></div>
                                {d.inflows > 0 && <div className="text-emerald-400">+{money(d.inflows)} in</div>}
                                {d.outflows > 0 && <div className="text-red-400">-{money(d.outflows)} out</div>}
                                {d.events.map((e, i) => (
                                  <div key={i} className="text-gray-500">{e.direction === "in" ? "+" : "-"}{money(e.amount)} {e.entity}</div>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </div>

                      {/* Day labels */}
                      <div className="flex gap-[2px] text-[8px] text-gray-600">
                        {sim.days.map((d) => (
                          <div key={d.day} className="flex-1 text-center">{d.day % 5 === 0 ? d.day : ""}</div>
                        ))}
                      </div>

                      {/* Operating vs Treasury breakdown (optional) */}
                      {forecastData.separated_forecast && (() => {
                        const sf = forecastData.separated_forecast
                        const hasBreakdown = sf.operating_30d_in + sf.operating_30d_out + sf.settlement_30d_in + sf.settlement_30d_out + sf.treasury_30d_in + sf.treasury_30d_out > 0
                        if (!hasBreakdown) return null
                        return (
                          <div className="mt-4 pt-4 border-t border-white/10">
                            <h4 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">30-Day Breakdown</h4>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                              {(sf.operating_30d_in > 0 || sf.operating_30d_out > 0) && (
                                <div className="bg-white/5 rounded-lg p-2" title="Business-generated cash (customer receipts, vendor payments). Excludes transfers, owner injections, processor settlement timing.">
                                  <div className="text-gray-500">Operating</div>
                                  <div className="text-emerald-400">+{money(sf.operating_30d_in)}</div>
                                  <div className="text-red-400">-{money(sf.operating_30d_out)}</div>
                                </div>
                              )}
                              {(sf.settlement_30d_in > 0 || sf.settlement_30d_out > 0) && (
                                <div className="bg-white/5 rounded-lg p-2">
                                  <div className="text-gray-500">Settlement</div>
                                  <div className="text-emerald-400">+{money(sf.settlement_30d_in)}</div>
                                  <div className="text-red-400">-{money(sf.settlement_30d_out)}</div>
                                </div>
                              )}
                              {(sf.treasury_30d_in > 0 || sf.treasury_30d_out > 0) && (
                                <div className="bg-white/5 rounded-lg p-2">
                                  <div className="text-gray-500">Treasury</div>
                                  <div className="text-emerald-400">+{money(sf.treasury_30d_in)}</div>
                                  <div className="text-red-400">-{money(sf.treasury_30d_out)}</div>
                                </div>
                              )}
                              {(sf.owner_30d_in > 0 || sf.owner_30d_out > 0) && (
                                <div className="bg-white/5 rounded-lg p-2">
                                  <div className="text-gray-500">Owner</div>
                                  <div className="text-emerald-400">+{money(sf.owner_30d_in)}</div>
                                  <div className="text-red-400">-{money(sf.owner_30d_out)}</div>
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                  )
                })()}

                {/* ─── Monte Carlo Simulation ─── */}
                {(() => {
                  const mc = forecastData.monte_carlo
                  const pctiles = mc.percentiles
                  const allValues = pctiles.flatMap((p) => [p.p5, p.p95])
                  const maxVal = Math.max(...allValues)
                  const minVal = Math.min(...allValues)
                  const range = Math.max(1, maxVal - minVal)
                  const yPos = (v: number) => 100 - ((v - minVal) / range) * 100

                  const probColor = (p: number) => p > 0.3 ? "text-red-400" : p > 0.1 ? "text-amber-400" : "text-emerald-400"

                  return (
                    <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h3 className="text-sm font-semibold text-white uppercase tracking-wider">Monte Carlo Simulation</h3>
                          <p className="text-[10px] text-gray-500 mt-0.5">{mc.simulations} simulations with payment delays, amount variance, missed payments</p>
                        </div>
                      </div>

                      {/* Probability queries */}
                      <div className="grid grid-cols-3 gap-3 mb-5">
                        <div className="bg-white/5 border border-white/10 rounded-lg p-3 text-center">
                          <div className="text-[10px] text-gray-500 mb-1">P(cash &lt; 0) in 14d</div>
                          <div className={`text-lg font-bold font-mono ${probColor(mc.prob_below_zero_14d)}`}>{Math.round(mc.prob_below_zero_14d * 100)}%</div>
                        </div>
                        <div className="bg-white/5 border border-white/10 rounded-lg p-3 text-center">
                          <div className="text-[10px] text-gray-500 mb-1">P(cash &lt; 0) in 30d</div>
                          <div className={`text-lg font-bold font-mono ${probColor(mc.prob_below_zero_30d)}`}>{Math.round(mc.prob_below_zero_30d * 100)}%</div>
                        </div>
                        <div className="bg-white/5 border border-white/10 rounded-lg p-3 text-center">
                          <div className="text-[10px] text-gray-500 mb-1">P(cash &gt; start) in 30d</div>
                          <div className={`text-lg font-bold font-mono ${mc.prob_above_starting_30d > 0.5 ? "text-emerald-400" : "text-amber-400"}`}>{Math.round(mc.prob_above_starting_30d * 100)}%</div>
                        </div>
                      </div>

                      {/* Percentile fan chart */}
                      <div className="relative h-32 mb-2">
                        <svg viewBox="0 0 300 100" preserveAspectRatio="none" className="w-full h-full">
                          {/* P5-P95 band */}
                          <polygon
                            points={
                              pctiles.map((p, i) => `${(i / 29) * 300},${yPos(p.p95)}`).join(" ") + " " +
                              [...pctiles].reverse().map((p, i) => `${((29 - i) / 29) * 300},${yPos(p.p5)}`).join(" ")
                            }
                            fill="rgba(59,130,246,0.08)"
                          />
                          {/* P25-P75 band */}
                          <polygon
                            points={
                              pctiles.map((p, i) => `${(i / 29) * 300},${yPos(p.p75)}`).join(" ") + " " +
                              [...pctiles].reverse().map((p, i) => `${((29 - i) / 29) * 300},${yPos(p.p25)}`).join(" ")
                            }
                            fill="rgba(59,130,246,0.15)"
                          />
                          {/* P50 median line */}
                          <polyline
                            points={pctiles.map((p, i) => `${(i / 29) * 300},${yPos(p.p50)}`).join(" ")}
                            fill="none" stroke="rgb(96,165,250)" strokeWidth="1.5"
                          />
                          {/* Zero line if visible */}
                          {minVal < 0 && (
                            <line x1="0" y1={yPos(0)} x2="300" y2={yPos(0)} stroke="rgba(239,68,68,0.4)" strokeWidth="0.5" strokeDasharray="4,3" />
                          )}
                        </svg>

                        {/* Y-axis labels */}
                        <div className="absolute top-0 right-1 text-[8px] text-gray-600 font-mono">{money(maxVal)}</div>
                        <div className="absolute bottom-0 right-1 text-[8px] text-gray-600 font-mono">{money(minVal)}</div>
                      </div>

                      {/* Legend */}
                      <div className="flex items-center justify-center gap-4 text-[10px] text-gray-500 mb-4">
                        <span className="flex items-center gap-1"><span className="w-3 h-1.5 rounded bg-blue-500/15 inline-block" /> P5–P95</span>
                        <span className="flex items-center gap-1"><span className="w-3 h-1.5 rounded bg-blue-500/30 inline-block" /> P25–P75</span>
                        <span className="flex items-center gap-1"><span className="w-3 h-0.5 rounded bg-blue-400 inline-block" /> Median</span>
                      </div>

                      {/* Summary stats */}
                      <div className="grid grid-cols-3 gap-3 text-center text-xs">
                        <div>
                          <div className="text-gray-500">Expected (30d)</div>
                          <div className="text-white font-mono font-semibold">{money(mc.expected_cash_30d)}</div>
                        </div>
                        <div>
                          <div className="text-gray-500">Probabilistic downside (5th %ile)</div>
                          <div className={`font-mono font-semibold ${mc.worst_case_cash_30d < 0 ? "text-red-400" : "text-amber-400"}`}>{money(mc.worst_case_cash_30d)}</div>
                        </div>
                        <div>
                          <div className="text-gray-500">Best case (95th %ile)</div>
                          <div className="text-emerald-400 font-mono font-semibold">{money(mc.best_case_cash_30d)}</div>
                        </div>
                      </div>

                      {/* Day-level scenario comparison */}
                      {mc.day_scenarios.length > 0 && (
                        <div className="mt-5 pt-4 border-t border-white/10">
                          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Scenario Comparison</h4>
                          <div className="grid grid-cols-3 gap-3">
                            {mc.day_scenarios.map((sc) => {
                              const color = sc.scenario === "aggressive" ? "emerald" : sc.scenario === "conservative" ? "red" : "blue"
                              const borderCls = `border-${color}-500/20`
                              const bgCls = `bg-${color}-500/10`
                              const textCls = `text-${color}-400`
                              return (
                                <div key={sc.scenario} className={`border rounded-lg p-3 ${sc.scenario === "aggressive" ? "border-emerald-500/20 bg-emerald-500/10" : sc.scenario === "conservative" ? "border-red-500/20 bg-red-500/10" : "border-blue-500/20 bg-blue-500/10"}`}>
                                  <div className={`text-xs font-bold uppercase mb-1 ${sc.scenario === "aggressive" ? "text-emerald-400" : sc.scenario === "conservative" ? "text-red-400" : "text-blue-400"}`}>
                                {sc.scenario === "conservative" ? "Stress scenario" : sc.scenario === "base" ? "Expected path" : sc.scenario}
                              </div>
                                  <div className="text-[10px] text-gray-500 mb-2">{sc.label}</div>
                                  <div className="space-y-1">
                                    <div className="flex justify-between text-xs">
                                      <span className="text-gray-400">14d</span>
                                      <span className="text-white font-mono font-semibold">{money(sc.cash_14d)}</span>
                                    </div>
                                    <div className="flex justify-between text-xs">
                                      <span className="text-gray-400">30d</span>
                                      <span className="text-white font-mono font-semibold">{money(sc.cash_30d)}</span>
                                    </div>
                                    {sc.min_cash_day > 0 && (
                                      <div className="flex justify-between text-xs">
                                        <span className="text-gray-500">Low D{sc.min_cash_day}</span>
                                        <span className={`font-mono ${sc.min_cash < 0 ? "text-red-400" : "text-gray-400"}`}>{money(sc.min_cash)}</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* ─── Detail Models (Collapsed by default) ─── */}
                <div className="border border-white/10 rounded-xl overflow-hidden">
                  <button type="button" onClick={() => toggleSection("detail-models")} className="w-full flex items-center justify-between px-5 py-3 bg-white/5 hover:bg-white/[0.07] transition-colors text-left">
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Behavioral Models & Detail</span>
                    <span className="text-xs text-gray-500">{expandedSections.has("detail-models") ? "▾ Collapse" : "▸ Expand"}</span>
                  </button>

                  {expandedSections.has("detail-models") && (
                    <div className="p-5 space-y-5 border-t border-white/10">

                {/* ─── Outstanding Invoices Signal ─── */}
                {forecastData.behavioral_models.invoice_signal.invoices.length > 0 && (() => {
                  const sig = forecastData.behavioral_models.invoice_signal
                  return (
                    <div className="bg-white/5 border border-amber-500/20 rounded-xl p-5">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider">Outstanding Invoices</h3>
                        <span className="text-xs text-gray-400">{sig.invoices.length} open</span>
                      </div>
                      <div className="grid grid-cols-4 gap-3 mb-4">
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase">Total Due</div>
                          <div className="text-lg font-mono font-bold text-white">{money(sig.total_outstanding)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase">Overdue</div>
                          <div className={`text-lg font-mono font-bold ${sig.total_overdue > 0 ? "text-red-400" : "text-emerald-400"}`}>{money(sig.total_overdue)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase">Overdue Count</div>
                          <div className={`text-lg font-mono font-bold ${sig.overdue_count > 0 ? "text-red-400" : "text-gray-400"}`}>{sig.overdue_count}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase">Avg Days to Due</div>
                          <div className="text-lg font-mono font-bold text-gray-300">{sig.avg_days_to_due != null ? `${Math.round(sig.avg_days_to_due)}d` : "—"}</div>
                        </div>
                      </div>
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {sig.invoices.slice(0, 15).map((inv) => (
                          <div key={inv.invoice_id} className="flex items-center justify-between text-xs bg-white/5 rounded px-2.5 py-1.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${inv.status === "overdue" ? "bg-red-400" : inv.status === "partially_paid" ? "bg-amber-400" : "bg-emerald-400"}`} />
                              <span className="text-gray-200 truncate">{inv.customer_name}</span>
                              <span className="text-[9px] text-gray-600 uppercase">{inv.source}</span>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              {inv.due_date && (
                                <span className={`text-[10px] ${inv.status === "overdue" ? "text-red-400" : "text-gray-500"}`}>
                                  {inv.status === "overdue" ? `${inv.days_overdue}d overdue` : `due ${inv.due_date.slice(5)}`}
                                </span>
                              )}
                              <span className="font-mono text-white">{money(inv.amount_due)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}

                {/* ─── Customer Models ─── */}
                {forecastData.behavioral_models.customers.length > 0 && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                    <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider mb-3">Customer Payment Models</h3>
                    <div className="space-y-2">
                      {forecastData.behavioral_models.customers.slice(0, 10).map((c) => {
                        const archetypeColors: Record<string, string> = {
                          clockwork: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
                          bursty: "bg-amber-500/20 text-amber-300 border-amber-500/30",
                          episodic: "bg-blue-500/20 text-blue-300 border-blue-500/30",
                          slow_reliable: "bg-purple-500/20 text-purple-300 border-purple-500/30",
                          volatile: "bg-red-500/20 text-red-300 border-red-500/30",
                          low_data: "bg-gray-500/20 text-gray-300 border-gray-500/30",
                        }
                        return (
                        <div key={c.entity_id} className="bg-white/5 rounded-lg px-3 py-2.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`shrink-0 w-2 h-2 rounded-full ${confDot(c.confidence)}`} />
                              <span className="text-sm text-white truncate">{c.name}</span>
                              {c.archetype && (
                                <span className={`text-[9px] border rounded px-1.5 py-0.5 ${archetypeColors[c.archetype] ?? "bg-gray-500/20 text-gray-300 border-gray-500/30"}`}>
                                  {c.archetype.replace("_", " ")}
                                </span>
                              )}
                              <span className="text-[10px] text-gray-500">{c.payment_count} payments</span>
                              {c.outstanding_invoices.length > 0 && (
                                <span className="text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded px-1.5 py-0.5">
                                  {c.outstanding_invoices.length} inv · {money(c.outstanding_invoices.reduce((s, i) => s + i.amount_due, 0))}
                                </span>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-sm font-mono text-emerald-400">{money(c.avg_amount)}<span className="text-gray-500"> avg</span></div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500">
                            {c.payment_interval_days > 0 && <span>every ~{c.payment_interval_days}d ±{Math.round(c.interval_variance)}d</span>}
                            <span>P(next) = {Math.round(c.probability_of_next * 100)}%</span>
                            {c.next_expected_date && <span className="text-blue-400">next ≈ {c.next_expected_date}</span>}
                            {c.payment_count > 0 && <span>last: {c.last_payment_date.slice(0, 10)}</span>}
                            {c.payment_count === 0 && c.outstanding_invoices.length > 0 && <span className="text-amber-400">invoice-only</span>}
                            {c.features && c.features.recent_trend !== "insufficient" && <span className={c.features.recent_trend === "accelerating" ? "text-emerald-400" : c.features.recent_trend === "decelerating" ? "text-red-400" : "text-gray-400"}>trend: {c.features.recent_trend}</span>}
                          </div>
                          {c.invoice_forecasts && c.invoice_forecasts.length > 0 && (
                            <div className="mt-1.5 pl-4 border-l border-white/5">
                              {c.invoice_forecasts.slice(0, 3).map((f) => (
                                <div key={f.invoice_id} className="text-[10px] text-gray-500 flex gap-2">
                                  <span className="text-amber-400">{money(f.amount_due)}</span>
                                  <span>P(7d)={Math.round(f.probability_7d * 100)}%</span>
                                  <span>P(14d)={Math.round(f.probability_14d * 100)}%</span>
                                  <span>P(30d)={Math.round(f.probability_30d * 100)}%</span>
                                  <span className="text-gray-600">DSO {f.customer_dso}d</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* ─── Vendor Models ─── */}
                {forecastData.behavioral_models.vendors.length > 0 && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                    <h3 className="text-sm font-semibold text-red-400 uppercase tracking-wider mb-3">Vendor Payment Models</h3>
                    <div className="space-y-2">
                      {forecastData.behavioral_models.vendors.slice(0, 10).map((v) => {
                        const recColors: Record<string, string> = {
                          hard: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
                          soft: "bg-amber-500/20 text-amber-300 border-amber-500/30",
                          episodic: "bg-blue-500/20 text-blue-300 border-blue-500/30",
                          seasonal: "bg-purple-500/20 text-purple-300 border-purple-500/30",
                          invoice_triggered: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
                          unknown: "bg-gray-500/20 text-gray-300 border-gray-500/30",
                        }
                        const recType = v.recurrence?.recurrence_type ?? "unknown"
                        return (
                        <div key={v.entity_id} className="bg-white/5 rounded-lg px-3 py-2.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`shrink-0 w-2 h-2 rounded-full ${confDot(v.confidence)}`} />
                              <span className="text-sm text-white truncate">{v.name}</span>
                              <span className={`text-[9px] border rounded px-1.5 py-0.5 ${recColors[recType] ?? recColors.unknown}`}>{recType.replace("_", " ")}</span>
                              {v.recurrence && <span className="text-[10px] text-gray-500">{Math.round(v.recurrence.recurrence_confidence * 100)}% rec.conf</span>}
                              {v.outstanding_bills && v.outstanding_bills.length > 0 && (
                                <span className="text-[10px] text-red-300 border border-red-500/30 rounded px-1 py-0.5">{v.outstanding_bills.length} bill{v.outstanding_bills.length > 1 ? "s" : ""} due</span>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-sm font-mono text-red-400">{money(v.avg_amount)}<span className="text-gray-500"> avg</span></div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500">
                            <span>every ~{v.cadence_interval_days}d</span>
                            <span>{v.payment_count} payments</span>
                            {v.next_expected_date && <span className="text-blue-400">next ≈ {v.next_expected_date}</span>}
                            <span>last: {v.last_payment_date.slice(0, 10)}</span>
                            {v.outstanding_bills && v.outstanding_bills.length > 0 && (
                              <span className="text-red-300">${v.outstanding_bills.reduce((s, b) => s + b.amount_due, 0).toLocaleString()} outstanding</span>
                            )}
                          </div>
                        </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* ─── Settlement + Transfer Models ─── */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-blue-400 uppercase tracking-wider mb-2">Settlement Model</h3>
                    <div className="space-y-1.5 text-sm">
                      <div className="flex justify-between"><span className="text-gray-400">Avg delay</span><span className="text-white font-mono">{forecastData.behavioral_models.settlement.avg_delay_days}d</span></div>
                      <div className="flex justify-between"><span className="text-gray-400">Std deviation</span><span className="text-white font-mono">±{forecastData.behavioral_models.settlement.delay_std}d</span></div>
                      <div className="flex justify-between"><span className="text-gray-400">Samples</span><span className="text-white font-mono">{forecastData.behavioral_models.settlement.sample_count}</span></div>
                      <div className="flex justify-between"><span className="text-gray-400">Confidence</span><span className={`font-mono ${forecastData.behavioral_models.settlement.confidence === "high" ? "text-emerald-400" : forecastData.behavioral_models.settlement.confidence === "medium" ? "text-amber-400" : "text-gray-500"}`}>{forecastData.behavioral_models.settlement.confidence}</span></div>
                    </div>
                    {forecastData.behavioral_models.settlement.by_processor && forecastData.behavioral_models.settlement.by_processor.length > 0 && (
                      <div className="mt-3 pt-2 border-t border-white/5 space-y-1.5">
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Per-Processor</div>
                        {forecastData.behavioral_models.settlement.by_processor.slice(0, 5).map((p, i) => (
                          <div key={i} className="flex items-center justify-between text-[11px]">
                            <span className="text-gray-300 truncate max-w-[120px]">{p.processor}</span>
                            <div className="flex gap-2 text-gray-500">
                              <span className="text-white font-mono">{p.avg_delay_days}d</span>
                              <span>±{p.delay_std}d</span>
                              <span>{p.sample_count} samples</span>
                              {p.fee_rate != null && <span className="text-amber-400">{(p.fee_rate * 100).toFixed(1)}% fee</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-purple-400 uppercase tracking-wider mb-2">Transfer Behavior</h3>
                    <div className="space-y-1.5 text-sm">
                      <div className="flex justify-between"><span className="text-gray-400">Pattern</span><span className="text-white font-mono">{forecastData.behavioral_models.transfers.trigger_pattern.replace(/_/g, " ")}</span></div>
                      <div className="flex justify-between"><span className="text-gray-400">Avg amount</span><span className="text-white font-mono">{money(forecastData.behavioral_models.transfers.avg_transfer_amount)}</span></div>
                      <div className="flex justify-between"><span className="text-gray-400">Count</span><span className="text-white font-mono">{forecastData.behavioral_models.transfers.transfer_count}</span></div>
                      {forecastData.behavioral_models.transfers.avg_interval_days && <div className="flex justify-between"><span className="text-gray-400">Interval</span><span className="text-white font-mono">~{forecastData.behavioral_models.transfers.avg_interval_days}d</span></div>}
                      {forecastData.behavioral_models.transfers.primary_account && <div className="flex justify-between"><span className="text-gray-400">Primary</span><span className="text-white font-mono text-xs truncate max-w-[120px]">{forecastData.behavioral_models.transfers.primary_account}</span></div>}
                    </div>
                  </div>
                </div>

                {/* ─── Recurring Fixed Obligations ─── */}
                {forecastData.behavioral_models.recurring_fixed.length > 0 && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-2">Recurring Fixed Obligations</h3>
                    <div className="space-y-1">
                      {forecastData.behavioral_models.recurring_fixed.slice(0, 8).map((rf, i) => (
                        <div key={i} className="flex items-center justify-between text-sm py-1 border-b border-white/5 last:border-0">
                          <span className="text-gray-300 truncate max-w-[200px]">{rf.label}</span>
                          <span className="text-red-400 font-mono shrink-0">{money(rf.monthly_amount)}/mo</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ─── Cashflow Components ─── */}
                <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">Aggregate Components</h3>
                  <div className="space-y-2">
                    {forecastData.components
                      .sort((a, b) => b.monthly_avg - a.monthly_avg)
                      .map((c) => (
                      <div key={c.id} className="flex items-center justify-between gap-3 bg-white/5 rounded-lg px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`shrink-0 w-2 h-2 rounded-full ${confDot(c.confidence)}`} />
                          <span className={`text-xs font-semibold ${c.direction === "in" ? "text-emerald-400" : "text-red-400"}`}>
                            {c.direction === "in" ? "IN" : "OUT"}
                          </span>
                          <span className="text-sm text-white truncate">{c.label}</span>
                          <span className="text-[10px] text-gray-500 border border-white/10 rounded px-1.5 py-0.5">
                            {behaviorLabel(c.behavior)}
                          </span>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-mono text-white">{money(c.monthly_avg)}<span className="text-gray-500">/mo</span></div>
                          <div className="text-[10px] text-gray-500">
                            {Math.abs(c.trend) < 0.05 ? "stable" : c.trend > 0.3 ? "↑ growing" : c.trend > 0 ? "↗ slight growth" : c.trend < -0.3 ? "↓ declining" : "↘ slight decline"}
                            {" · "}
                            {c.volatility < 0.2 ? "steady" : c.volatility < 0.5 ? "moderate var." : c.volatility < 1 ? "high var." : "very volatile"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                    </div>
                  )}
                </div>

                {/* ─── Scenario Forecasts ─── */}
                {forecastData.scenarios.map((sc) => (
                  <div key={sc.scenario} className={`border rounded-xl p-5 ${scenarioBorder(sc.scenario)} ${scenarioBg(sc.scenario)}`}>
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className={`text-sm font-semibold uppercase tracking-wider ${scenarioColor(sc.scenario)}`}>
                          {sc.scenario} case
                        </h3>
                        <p className="text-xs text-gray-500 mt-0.5">{sc.label}</p>
                      </div>
                      <div className="text-right">
                        <div className={`text-lg font-bold font-mono ${sc.ending_cash >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {signedMoney(sc.ending_cash)}
                        </div>
                        <div className="text-[10px] text-gray-500">ending cash</div>
                      </div>
                    </div>

                    {sc.runway_months !== null && (
                      <div className="mb-3 flex items-center gap-2 text-xs">
                        <span className="text-red-400 font-semibold">RUNWAY WARNING</span>
                        <span className="text-gray-400">Cash runs out in ~{sc.runway_months} month{sc.runway_months !== 1 ? "s" : ""}</span>
                      </div>
                    )}

                    {/* Scenario Drivers (WHY) */}
                    {(sc as ScenarioResultV2).drivers && (sc as ScenarioResultV2).drivers!.length > 0 && (
                      <div className="mb-3 bg-black/20 rounded-lg p-3">
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-1.5">Driven by</div>
                        <div className="space-y-1">
                          {(sc as ScenarioResultV2).drivers!.map((d, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs">
                              <span className="text-red-400">•</span>
                              <span className="text-gray-300">{d.factor}</span>
                              {d.impact_amount > 0 && <span className="text-red-400 font-mono ml-auto">-{money(d.impact_amount)}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Monthly projection table */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-gray-500 border-b border-white/10">
                            <th className="text-left py-1.5 pr-3">Month</th>
                            <th className="text-right py-1.5 px-2">Inflows</th>
                            <th className="text-right py-1.5 px-2">Outflows</th>
                            <th className="text-right py-1.5 px-2">Net</th>
                            <th className="text-right py-1.5 pl-2">Cumulative</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sc.months.map((m) => (
                            <tr key={m.month} className="border-b border-white/5">
                              <td className="py-1.5 pr-3 text-gray-400 font-mono">{m.month}</td>
                              <td className="py-1.5 px-2 text-right text-emerald-400 font-mono">{money(m.inflows)}</td>
                              <td className="py-1.5 px-2 text-right text-red-400 font-mono">{money(m.outflows)}</td>
                              <td className={`py-1.5 px-2 text-right font-mono font-semibold ${m.net >= 0 ? "text-emerald-300" : "text-red-300"}`}>{signedMoney(m.net)}</td>
                              <td className={`py-1.5 pl-2 text-right font-mono ${m.cumulative_net >= 0 ? "text-white" : "text-red-400 font-semibold"}`}>{signedMoney(m.cumulative_net)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}

                {/* ─── Cash Runway ─── */}
                {forecastData.cash_runway && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                    <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">Cash Runway</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-white/5 rounded-lg p-3 text-center">
                        <div className="text-xs text-gray-500 mb-1">Base case</div>
                        {forecastData.cash_runway.base_months === null ? (
                          <>
                            <div className="text-sm font-semibold text-emerald-400">No depletion</div>
                            <div className="text-[10px] text-emerald-400/70 mt-0.5">in forecast horizon</div>
                          </>
                        ) : (
                          <div className={`text-xl font-bold font-mono ${forecastData.cash_runway.base_months > 6 ? "text-emerald-400" : forecastData.cash_runway.base_months > 3 ? "text-amber-400" : "text-red-400"}`}>
                            {forecastData.cash_runway.base_months.toFixed(1)} mo
                          </div>
                        )}
                      </div>
                      <div className="bg-white/5 rounded-lg p-3 text-center">
                        <div className="text-xs text-gray-500 mb-1">Pessimistic</div>
                        {forecastData.cash_runway.pessimistic_months === null ? (
                          <>
                            <div className="text-sm font-semibold text-emerald-400">No depletion</div>
                            <div className="text-[10px] text-gray-500 mt-0.5">in stress scenario</div>
                          </>
                        ) : (
                          <>
                            <div className={`text-xl font-bold font-mono ${forecastData.cash_runway.pessimistic_months > 3 ? "text-amber-400" : "text-red-400"}`}>
                              {forecastData.cash_runway.pessimistic_months.toFixed(1)} mo
                            </div>
                            {forecastData.cash_runway.pessimistic_months <= 3 && (
                              <div className="text-[10px] text-red-400/70">Needs attention</div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {forecastData.cash_runway.monthly_burn_rate > 0 && (
                      <div className="mt-3 text-xs text-gray-500 text-center">
                        Monthly burn rate: <span className="text-red-400 font-mono">{money(forecastData.cash_runway.monthly_burn_rate)}</span>/mo
                        {" · "}Data: {forecastData.cash_runway.months_of_data.toFixed(1)} months
                      </div>
                    )}
                  </div>
                )}

                {/* ─── Sensitivity Analysis ─── */}
                {forecastData.sensitivity && forecastData.sensitivity.drivers.length > 0 && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                    <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-1">Top Drivers of Cash Position</h3>
                    <p className="text-xs text-gray-500 mb-4">Which entities move your cash the most</p>
                    <div className="space-y-2">
                      {forecastData.sensitivity.drivers.map((d, i) => (
                        <div key={i} className="flex items-center gap-3 bg-white/5 rounded-lg px-3 py-2.5">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span className={`text-sm font-bold ${d.direction === "positive" ? "text-emerald-400" : "text-red-400"}`}>
                              {d.direction === "positive" ? "↑" : "↓"}
                            </span>
                            <div className="min-w-0">
                              <div className="text-sm text-white truncate">{d.entity}</div>
                              <div className="text-[10px] text-gray-500">{d.description}</div>
                            </div>
                          </div>
                          <div className="shrink-0">
                            <div className={`text-sm font-bold font-mono ${d.direction === "positive" ? "text-emerald-400" : "text-red-400"}`}>
                              {d.impact_pct.toFixed(1)}%
                            </div>
                            <div className="text-[10px] text-gray-500">{d.type}</div>
                          </div>
                          <div className="w-20 h-2 bg-white/10 rounded-full overflow-hidden shrink-0">
                            <div
                              className={`h-full rounded-full ${d.direction === "positive" ? "bg-emerald-500" : "bg-red-500"}`}
                              style={{ width: `${Math.min(100, d.impact_pct)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ─── Decision Layer: Top Actions (ranked by impact) ─── */}
                {forecastData.interventions && forecastData.interventions.length > 0 && (
                  <div className="bg-white/5 border border-cyan-500/20 rounded-xl p-5">
                    <h3 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-1">Top Actions (by risk reduction)</h3>
                    <p className="text-xs text-gray-500 mb-4">If I do X, what happens to my cash distribution?</p>
                    <div className="space-y-2">
                      {forecastData.interventions.slice(0, 5).map((iv) => {
                        const hasRange = iv.plausible_range_low != null && iv.plausible_range_high != null
                        const rangeStr = hasRange ? `${money(iv.plausible_range_low!)} – ${money(iv.plausible_range_high!)}` : money(iv.impact_cash_14d)
                        const confLabel = iv.confidence_band ? ` (${iv.confidence_band} confidence)` : ""
                        const sim = iv.simulation_impact
                        return (
                          <div key={iv.id} className="bg-white/5 rounded-lg px-4 py-3">
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                {iv.rank != null && <span className="text-[10px] text-cyan-400 font-bold">#{iv.rank}</span>}
                                <div className="text-sm text-white font-medium">{iv.label}</div>
                              </div>
                              <div className="text-emerald-400 font-mono font-bold text-sm">
                                +{hasRange ? rangeStr : money(iv.impact_cash_14d)}
                                <span className="text-[10px] text-gray-500 font-normal ml-1">@14d{confLabel}</span>
                              </div>
                            </div>
                            {sim && (
                              <div className="flex flex-wrap gap-3 text-[10px] text-gray-400 mb-2">
                                <span>Low point: ${Math.round(sim.low_point_before).toLocaleString()} → <span className="text-emerald-400">${Math.round(sim.low_point_after).toLocaleString()}</span></span>
                                <span>Stress prob: {(sim.stress_prob_before * 100).toFixed(0)}% → <span className="text-emerald-400">{(sim.stress_prob_after * 100).toFixed(0)}%</span></span>
                                {sim.runway_months_change != null && sim.runway_months_change > 0 && (
                                  <span>Runway: <span className="text-emerald-400">+{sim.runway_months_change.toFixed(1)} mo</span></span>
                                )}
                              </div>
                            )}
                            <div className="text-xs text-gray-400 mb-2">{iv.description}</div>
                            {iv.assumptions && iv.assumptions.length > 0 && (
                              <div className="text-[10px] text-amber-600/80 mb-2 italic">Assumes: {iv.assumptions.slice(0, 2).join("; ")}</div>
                            )}
                            {iv.second_order_risks && (iv.second_order_risks.late_fee || iv.second_order_risks.relationship || iv.second_order_risks.next_period) && (
                              <div className="mb-2 p-2 bg-amber-500/5 rounded border border-amber-500/20">
                                <div className="text-[10px] text-amber-400/90 font-semibold mb-1">Second-order effects</div>
                                <ul className="space-y-0.5 text-[10px] text-gray-400">
                                  {iv.second_order_risks.late_fee && <li>• {iv.second_order_risks.late_fee}</li>}
                                  {iv.second_order_risks.relationship && <li>• {iv.second_order_risks.relationship}</li>}
                                  {iv.second_order_risks.next_period && <li>• {iv.second_order_risks.next_period}</li>}
                                </ul>
                              </div>
                            )}
                            <div className="flex items-center gap-4 text-[10px] text-gray-500">
                              <span>30d impact: <span className="text-emerald-400 font-mono">+{money(iv.impact_cash_30d)}</span></span>
                              {iv.impact_risk_reduction > 0 && (
                                <span>↓ downside risk: <span className="text-cyan-400 font-mono">~{iv.impact_risk_reduction.toFixed(0)}%</span></span>
                              )}
                              {iv.parameter_days && <span>Shift: {iv.parameter_days}d</span>}
                              {iv.parameter_pct && <span>Change: {iv.parameter_pct}%</span>}
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {/* Best 2-action strategy */}
                    {forecastData.combined_strategies && forecastData.combined_strategies.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-white/10">
                        <h4 className="text-xs font-semibold text-cyan-400/90 uppercase mb-2">Best 2-action strategy</h4>
                        <div className="space-y-2">
                          {forecastData.combined_strategies.map((s) => (
                            <div key={s.id} className="bg-cyan-500/10 rounded-lg px-3 py-2 border border-cyan-500/20">
                              <div className="text-xs text-white font-medium mb-1">{s.summary}</div>
                              <div className="flex gap-2 text-[10px]">
                                <span className={`${s.risk_level === "low" ? "text-emerald-400" : s.risk_level === "medium" ? "text-amber-400" : "text-red-400"}`}>
                                  Risk: {s.risk_level.toUpperCase()}
                                </span>
                                <span className="text-gray-500">Low point: ${Math.round(s.low_point).toLocaleString()}</span>
                                <span className="text-gray-500">Stress prob: {(s.stress_prob * 100).toFixed(0)}%</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ─── Control Layer: Execution (reminders, drafts) ─── */}
                {forecastData.execution_suggestions && forecastData.execution_suggestions.length > 0 && (
                  <div className="bg-white/5 border border-violet-500/20 rounded-xl p-5">
                    <h3 className="text-sm font-semibold text-violet-400 uppercase tracking-wider mb-1">Execution</h3>
                    <p className="text-xs text-gray-500 mb-4">Turn advice into doing: reminders, drafts, triggers</p>
                    <div className="space-y-3">
                      {forecastData.execution_suggestions.map((es, i) => (
                        <div key={i} className="bg-white/5 rounded-lg px-4 py-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-violet-300">{es.label}</span>
                            <span className="text-[10px] text-gray-500 uppercase">{es.type}</span>
                          </div>
                          <div className="text-[10px] text-gray-500 mb-1">For: {es.action_label}</div>
                          {es.content && (
                            <div className="text-xs text-gray-300 mt-2 p-2 bg-white/5 rounded border border-white/10 font-mono">
                              {es.content}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ─── Forecast Confidence (Trust Engine) ─── */}
                {forecastData.forecast_confidence && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-2">Forecast Confidence</h3>
                    <p className="text-[10px] text-gray-500 mb-2">What would make this prediction wrong? How to improve trust.</p>

                    {/* Diagnosis sentence */}
                    {forecastData.forecast_confidence.diagnosis && (
                      <p className="text-xs text-gray-300 mb-3 italic">{forecastData.forecast_confidence.diagnosis}</p>
                    )}

                    {/* What would make wrong */}
                    {forecastData.forecast_confidence.what_would_make_wrong && (
                      <div className="mb-3 p-2 bg-amber-500/10 rounded border border-amber-500/20">
                        <div className="text-[10px] text-amber-400/90 font-semibold uppercase mb-1">What could make this wrong</div>
                        <p className="text-xs text-gray-300">{forecastData.forecast_confidence.what_would_make_wrong}</p>
                      </div>
                    )}

                    {/* Why confidence is low */}
                    {forecastData.forecast_confidence.why_confidence_low && forecastData.forecast_confidence.why_confidence_low.length > 0 && (
                      <div className="mb-3">
                        <div className="text-[10px] text-gray-500 font-semibold uppercase mb-1">Why</div>
                        <ul className="space-y-0.5 text-xs text-gray-400">
                          {forecastData.forecast_confidence.why_confidence_low.map((r, i) => (
                            <li key={i}>• {r}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* How to improve */}
                    {forecastData.forecast_confidence.how_to_improve && forecastData.forecast_confidence.how_to_improve.length > 0 && (
                      <div className="mb-3 p-2 bg-emerald-500/10 rounded border border-emerald-500/20">
                        <div className="text-[10px] text-emerald-400/90 font-semibold uppercase mb-1">How to improve</div>
                        <ul className="space-y-0.5 text-xs text-gray-300">
                          {forecastData.forecast_confidence.how_to_improve.map((r, i) => (
                            <li key={i}>• {r}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Identity breakdown (high / weak / unresolved) */}
                    {forecastData.forecast_confidence.identity_breakdown && (
                      <div className="grid grid-cols-3 gap-2 mb-4 text-[10px]">
                        <div className="bg-emerald-500/10 rounded px-2 py-1.5">
                          <div className="text-gray-500">High-confidence canonical</div>
                          <div className="font-mono text-emerald-400">{forecastData.forecast_confidence.identity_breakdown.high_confidence_canonical_pct}%</div>
                        </div>
                        <div className="bg-amber-500/10 rounded px-2 py-1.5">
                          <div className="text-gray-500">Weak / inferred</div>
                          <div className="font-mono text-amber-400">{forecastData.forecast_confidence.identity_breakdown.weak_inferred_pct}%</div>
                        </div>
                        <div className="bg-red-500/10 rounded px-2 py-1.5">
                          <div className="text-gray-500">Unresolved</div>
                          <div className="font-mono text-red-400">{forecastData.forecast_confidence.identity_breakdown.unresolved_pct}%</div>
                        </div>
                      </div>
                    )}

                    {/* 8-component confidence breakdown */}
                    {forecastData.forecast_confidence.by_component && forecastData.forecast_confidence.by_component.length > 0 && (
                      <div className="space-y-2 mb-4">
                        {forecastData.forecast_confidence.by_component.map((cc, i) => (
                          <div key={i}>
                            <div className="flex items-center gap-3">
                              <div className="text-xs text-gray-400 w-36 shrink-0">{cc.area}</div>
                              <div className="flex-1 h-2 bg-white/10 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${cc.label === "high" ? "bg-emerald-500" : cc.label === "medium" ? "bg-amber-500" : "bg-red-500"}`}
                                  style={{ width: `${Math.round(cc.score * 100)}%` }}
                                />
                              </div>
                              <div className={`text-xs font-mono w-10 text-right ${cc.label === "high" ? "text-emerald-400" : cc.label === "medium" ? "text-amber-400" : "text-red-400"}`}>
                                {Math.round(cc.score * 100)}%
                              </div>
                            </div>
                            <div className="text-[10px] text-gray-600 pl-[9.5rem]">{cc.reason}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {forecastData.forecast_confidence.reasons.length > 0 && (
                      <div className="space-y-1">
                        {forecastData.forecast_confidence.reasons.map((r, i) => (
                          <div key={i} className="text-xs text-gray-400 flex items-center gap-1.5">
                            <span className="text-gray-600">•</span> {r}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ─── Backtest Accuracy & Calibration ─── */}
                {forecastData.backtest && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Backtest & Calibration</h3>
                      <span className={`text-lg font-mono font-bold ${forecastData.backtest.accuracy_score >= 75 ? "text-emerald-400" : forecastData.backtest.accuracy_score >= 50 ? "text-amber-400" : "text-red-400"}`}>
                        {forecastData.backtest.accuracy_score}%
                      </span>
                    </div>
                    <div className="flex flex-col gap-1 text-[11px] text-gray-400 mb-2">
                      <span className="font-medium text-gray-300">{forecastData.backtest.days_tested}-day backtest</span>
                      <span>{Math.round(forecastData.backtest.direction_accuracy * 100)}% direction accuracy</span>
                      <span>MAE ${Math.round(forecastData.backtest.mean_absolute_error).toLocaleString()}</span>
                    </div>
                    <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${forecastData.backtest.accuracy_score >= 75 ? "bg-emerald-500" : forecastData.backtest.accuracy_score >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                        style={{ width: `${forecastData.backtest.accuracy_score}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-gray-500 mt-2">{forecastData.backtest.details}</p>

                    {/* Calibration: predicted vs actual probability buckets */}
                    {forecastData.backtest.calibration && (
                      <div className="mt-3 pt-3 border-t border-white/5">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[11px] text-gray-400 font-semibold">Probability Calibration</span>
                          <span className={`text-[10px] font-mono ${forecastData.backtest.calibration.calibration_error < 0.15 ? "text-emerald-400" : forecastData.backtest.calibration.calibration_error < 0.3 ? "text-amber-400" : "text-red-400"}`}>
                            ECE: {(forecastData.backtest.calibration.calibration_error * 100).toFixed(1)}%
                            {forecastData.backtest.calibration.is_overconfident && " (overconfident)"}
                            {forecastData.backtest.calibration.is_underconfident && " (underconfident)"}
                          </span>
                        </div>
                        {forecastData.backtest.calibration.suggested_interpretation && (
                          <div className="mt-2 p-2 bg-amber-500/10 rounded border border-amber-500/20 text-[10px] text-amber-200/90">
                            {forecastData.backtest.calibration.suggested_interpretation}
                          </div>
                        )}
                        {forecastData.backtest.calibration.probability_temperature && forecastData.backtest.calibration.probability_temperature > 1 && (
                          <div className="mt-1 text-[10px] text-gray-500">
                            Probabilities scaled by T={forecastData.backtest.calibration.probability_temperature.toFixed(1)} to reduce overconfidence
                          </div>
                        )}
                        <div className="space-y-1">
                          {forecastData.backtest.calibration.buckets.map((b, i) => (
                            <div key={i} className="flex items-center gap-2 text-[10px]">
                              <span className="text-gray-500 w-14 shrink-0">{b.range}</span>
                              <div className="flex-1 h-3 bg-white/5 rounded relative overflow-hidden">
                                <div className="absolute inset-y-0 left-0 bg-blue-500/40 rounded" style={{ width: `${Math.round(b.predicted_prob * 100)}%` }} />
                                <div className="absolute inset-y-0 left-0 bg-emerald-500/60 rounded" style={{ width: `${Math.round(b.actual_rate * 100)}%`, height: "50%", top: "25%" }} />
                              </div>
                              <span className="text-blue-400 w-8 text-right font-mono">{Math.round(b.predicted_prob * 100)}%</span>
                              <span className="text-emerald-400 w-8 text-right font-mono">{Math.round(b.actual_rate * 100)}%</span>
                              <span className={`w-10 text-right font-mono ${b.count < 5 ? "text-amber-400" : "text-gray-600"}`} title={b.count < 5 ? "Low sample — interpret with caution" : undefined}>
                                n={b.count}{b.count < 5 ? " ⚠" : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-3 mt-1 text-[9px] text-gray-600">
                          <span><span className="inline-block w-2 h-2 bg-blue-500/40 rounded mr-1" />predicted</span>
                          <span><span className="inline-block w-2 h-2 bg-emerald-500/60 rounded mr-1" />actual</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ─── Refresh ─── */}
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={forecastLoading}
                    onClick={() => {
                      setForecastLoading(true)
                      setForecastError(null)
                      fetch("/api/forecast")
                        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
                        .then((data: CashflowForecast) => { setForecastData(data); setForecastLoading(false) })
                        .catch((err) => { setForecastError(err instanceof Error ? err.message : "Failed to load forecast"); setForecastLoading(false) })
                    }}
                    className="rounded-lg border border-white/20 bg-white/5 px-4 py-3 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="text-sm font-medium text-white">{forecastLoading ? "Computing…" : "Refresh forecast"}</div>
                    <div className="text-xs text-gray-400">Re-simulate from latest data</div>
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      }

      case 14: {
        const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        return (
          <div className="space-y-6">
            <div className="text-center mb-2">
              <h2 className="text-2xl font-semibold text-white mb-1">{steps[13].title}</h2>
              <p className="text-gray-400 text-lg mb-5">{steps[13].description}</p>
              {forecastLoading && (
                <div className="flex justify-center gap-2 py-6 text-gray-400">
                  <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Loading forecast…
                </div>
              )}
            </div>

            {!forecastLoading && forecastData && (
              <div className="space-y-6">
                {/* ─── Decision Layer: Top Actions ─── */}
                {forecastData.interventions && forecastData.interventions.length > 0 ? (
                  <div className="bg-white/5 border border-cyan-500/20 rounded-xl p-5">
                    <h3 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mb-1">Top Actions (by risk reduction)</h3>
                    <p className="text-xs text-gray-500 mb-4">If I do X, what happens to my cash distribution?</p>
                    <div className="space-y-2">
                      {forecastData.interventions.slice(0, 6).map((iv) => {
                        const hasRange = iv.plausible_range_low != null && iv.plausible_range_high != null
                        const rangeStr = hasRange ? `${money(iv.plausible_range_low!)} – ${money(iv.plausible_range_high!)}` : money(iv.impact_cash_14d)
                        const confLabel = iv.confidence_band ? ` (${iv.confidence_band} confidence)` : ""
                        const sim = iv.simulation_impact
                        return (
                          <div key={iv.id} className="bg-white/5 rounded-lg px-4 py-3">
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                {iv.rank != null && <span className="text-[10px] text-cyan-400 font-bold">#{iv.rank}</span>}
                                <div className="text-sm text-white font-medium">{iv.label}</div>
                              </div>
                              <div className="text-emerald-400 font-mono font-bold text-sm">
                                +{hasRange ? rangeStr : money(iv.impact_cash_14d)}
                                <span className="text-[10px] text-gray-500 font-normal ml-1">@14d{confLabel}</span>
                              </div>
                            </div>
                            {sim && (
                              <div className="flex flex-wrap gap-3 text-[10px] text-gray-400 mb-2">
                                <span>Low point: ${Math.round(sim.low_point_before).toLocaleString()} → <span className="text-emerald-400">${Math.round(sim.low_point_after).toLocaleString()}</span></span>
                                <span>Stress prob: {(sim.stress_prob_before * 100).toFixed(0)}% → <span className="text-emerald-400">{(sim.stress_prob_after * 100).toFixed(0)}%</span></span>
                                {sim.runway_months_change != null && sim.runway_months_change > 0 && (
                                  <span>Runway: <span className="text-emerald-400">+{sim.runway_months_change.toFixed(1)} mo</span></span>
                                )}
                              </div>
                            )}
                            <div className="text-xs text-gray-400 mb-2">{iv.description}</div>
                            {iv.assumptions && iv.assumptions.length > 0 && (
                              <div className="text-[10px] text-amber-600/80 mb-2 italic">Assumes: {iv.assumptions.slice(0, 2).join("; ")}</div>
                            )}
                            {iv.second_order_risks && (iv.second_order_risks.late_fee || iv.second_order_risks.relationship || iv.second_order_risks.next_period) && (
                              <div className="mb-2 p-2 bg-amber-500/5 rounded border border-amber-500/20">
                                <div className="text-[10px] text-amber-400/90 font-semibold mb-1">Second-order effects</div>
                                <ul className="space-y-0.5 text-[10px] text-gray-400">
                                  {iv.second_order_risks.late_fee && <li>• {iv.second_order_risks.late_fee}</li>}
                                  {iv.second_order_risks.relationship && <li>• {iv.second_order_risks.relationship}</li>}
                                  {iv.second_order_risks.next_period && <li>• {iv.second_order_risks.next_period}</li>}
                                </ul>
                              </div>
                            )}
                            <div className="flex items-center gap-4 text-[10px] text-gray-500">
                              <span>30d impact: <span className="text-emerald-400 font-mono">+{money(iv.impact_cash_30d)}</span></span>
                              {iv.impact_risk_reduction > 0 && (
                                <span>↓ downside risk: <span className="text-cyan-400 font-mono">~{iv.impact_risk_reduction.toFixed(0)}%</span></span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {forecastData.combined_strategies && forecastData.combined_strategies.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-white/10">
                        <h4 className="text-xs font-semibold text-cyan-400/90 uppercase mb-2">Best 2-action strategy</h4>
                        <div className="space-y-2">
                          {forecastData.combined_strategies.map((s) => (
                            <div key={s.id} className="bg-cyan-500/10 rounded-lg px-3 py-2 border border-cyan-500/20">
                              <div className="text-xs text-white font-medium mb-1">{s.summary}</div>
                              <div className="flex gap-2 text-[10px]">
                                <span className={`${s.risk_level === "low" ? "text-emerald-400" : s.risk_level === "medium" ? "text-amber-400" : "text-red-400"}`}>
                                  Risk: {s.risk_level.toUpperCase()}
                                </span>
                                <span className="text-gray-500">Low point: ${Math.round(s.low_point).toLocaleString()}</span>
                                <span className="text-gray-500">Stress prob: {(s.stress_prob * 100).toFixed(0)}%</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-6 text-center">
                    <p className="text-gray-400 text-sm">No actions available. Complete step 16 (Cashflow forecast) first to see recommended actions.</p>
                  </div>
                )}

                {/* ─── Control Layer: Execution ─── */}
                {forecastData.execution_suggestions && forecastData.execution_suggestions.length > 0 && (
                  <div className="bg-white/5 border border-violet-500/20 rounded-xl p-5">
                    <h3 className="text-sm font-semibold text-violet-400 uppercase tracking-wider mb-1">Execution</h3>
                    <p className="text-xs text-gray-500 mb-4">Turn advice into doing: reminders, drafts, triggers</p>
                    <div className="space-y-3">
                      {forecastData.execution_suggestions.map((es, i) => (
                        <div key={i} className="bg-white/5 rounded-lg px-4 py-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-violet-300">{es.label}</span>
                            <span className="text-[10px] text-gray-500 uppercase">{es.type}</span>
                          </div>
                          <div className="text-[10px] text-gray-500 mb-1">For: {es.action_label}</div>
                          {es.content && (
                            <div className="text-xs text-gray-300 mt-2 p-2 bg-white/5 rounded border border-white/10 font-mono">
                              {es.content}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={forecastLoading}
                    onClick={() => {
                      setForecastLoading(true)
                      setForecastError(null)
                      fetch("/api/forecast")
                        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
                        .then((data: CashflowForecast) => { setForecastData(data); setForecastLoading(false) })
                        .catch((err) => { setForecastError(err instanceof Error ? err.message : "Failed"); setForecastLoading(false) })
                    }}
                    className="rounded-lg border border-white/20 bg-white/5 px-4 py-3 hover:bg-white/10 transition-colors disabled:opacity-50"
                  >
                    <div className="text-sm font-medium text-white">Refresh forecast</div>
                  </button>
                </div>
              </div>
            )}

            {!forecastLoading && !forecastData && forecastError && (
              <p className="text-red-300 text-sm text-center">Failed to load forecast: {forecastError}</p>
            )}
          </div>
        )
      }

      default:
        return (
          <div className="text-center py-12">
            <div className="mb-6">
              <h2 className="text-2xl font-semibold text-white mb-2">{steps[currentStep - 1]?.title}</h2>
              <p className="text-gray-400 text-base max-w-lg mx-auto">{steps[currentStep - 1]?.description}</p>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-xl p-8 max-w-md mx-auto">
              <p className="text-sm text-gray-500">This step will be available soon.</p>
            </div>
          </div>
        )
    }
  }

  const isStep6 = currentStep === 6
  const isWideStep = currentStep === 8 || currentStep === 9 || currentStep === 10 || currentStep === 11 || currentStep === 12 || currentStep === 13 || currentStep === 14
  return (
    <div
      className={
        isStep6
          ? "w-full max-w-[96rem] mx-auto px-4 pt-6 pb-8"
          : isWideStep
            ? "w-full max-w-[90vw] mx-auto px-4 pt-10 pb-8 md:pt-16 md:pb-10"
            : "w-full max-w-5xl mx-auto px-4 pt-10 pb-8 md:pt-16 md:pb-10"
      }
    >
      {showQboError && qboError && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3.5 text-amber-200 backdrop-blur-sm">
          <p className="text-sm">{QBO_ERROR_MESSAGES[qboError]}</p>
          <button
            type="button"
            onClick={() => setDismissedError(true)}
            className="shrink-0 rounded-lg p-2 text-amber-300 hover:bg-amber-500/20 transition-colors"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <div className={isStep6 ? "mb-2" : "mb-8"}>
        <div className="flex items-center flex-col justify-start mb-0">
          <Image
            src="/profitwise-logo.png"
            alt="ProfitWise"
            width={320}
            height={96}
            className="h-16 md:h-20 w-auto object-contain mx-0 px-0 my-0.5"
          />
        </div>
        {!isStep6 && (
        <div className="w-full max-w-2xl mx-auto py-4 pt-2">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-sm font-medium text-white/90">
              Step {currentStep} of {steps.length}
            </span>
            <span className="text-sm font-medium text-emerald-400/90 tabular-nums">
              {Math.round((currentStep / steps.length) * 100)}%
            </span>
          </div>
          <div className="w-full h-2.5 bg-white/5 rounded-full overflow-hidden border border-white/5">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all duration-500 ease-out shadow-[0_0_12px_rgba(16,185,129,0.4)]"
              style={{ width: `${(currentStep / steps.length) * 100}%` }}
            />
          </div>
        </div>
        )}
      </div>
      {/* Main step content without extra dark card background */}
      <div className="mb-10">
        {renderStepContent()}
      </div>

      <div className="flex justify-between gap-4 pt-2">
        <Button
          type="button"
          onClick={handleBack}
          disabled={currentStep === 1}
          variant="outline"
          className="min-w-[120px] h-12 px-6 bg-white/5 border-white/20 text-white hover:bg-white/10 hover:border-white/30 disabled:opacity-40 disabled:cursor-not-allowed font-medium rounded-xl transition-all duration-200"
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={handleNextOrFinish}
          disabled={afterIdentityLoading}
          className="min-w-[120px] h-12 px-6 bg-white hover:bg-white/95 text-black font-semibold disabled:opacity-70 disabled:cursor-not-allowed rounded-xl transition-all duration-200 shadow-lg shadow-white/10"
        >
          {afterIdentityLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </span>
          ) : currentStep === 6 || currentStep === 7 || currentStep === steps.length ? "Finish" : "Next"}
        </Button>
      </div>
    </div>
  )
}
