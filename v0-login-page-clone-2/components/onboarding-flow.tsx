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
import Image, { type StaticImageData } from "next/image"
import { Sparkles, Loader2 } from "lucide-react"
import { displayLabelForCounterparty } from "@/lib/alias-normalize"
import type { MovementDetailResponse } from "@/lib/movement-detail-types"
import whatsappQr from "../Screenshot 2026-03-08 at 03.57.15.png"
import shopifyLogo from "../Screenshot 2026-03-24 at 09.43.29.png"
import { useRouter } from "next/navigation"
interface Integration {
  name: string
  description: string
  category: string
  logo: string | StaticImageData
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
    name: "Shopify",
    description: "Orders, customers, products, and payouts",
    category: "Revenue",
    logo: shopifyLogo,
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
    title: "Entity profiles",
    description: "AI-powered customer and vendor intelligence with payment behavior analysis and risk scoring.",
  },
  {
    id: 13,
    title: "Business state",
    description: "Real-time financial health: revenue, spend, liquidity, and risk signals all in one view.",
  },
  {
    id: 14,
    title: "Cashflow forecast",
    description: "Simulate future cash based on behavioral component models, not simple time-series prediction.",
  },
  {
    id: 15,
    title: "Decisions & actions",
    description: "Top actions ranked by impact, combined strategies, and execution steps.",
  },
]

// Keep Step 12–14 placeholdered while Step 11 (AP/AR) is re-enabled.
const DISABLE_ADVANCED_STEPS_FROM_ONBOARDING = false

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
  shopify_invalid_shop: "Please enter a valid Shopify domain like your-store.myshopify.com.",
  shopify_config: "Shopify OAuth is not configured yet. Please try again later.",
  shopify_missing_params: "Shopify connection did not complete. Please try again.",
  shopify_invalid_hmac: "Shopify callback security check failed. Please reconnect.",
  shopify_state_missing: "Your Shopify session expired. Please reconnect.",
  shopify_state_invalid: "Shopify state validation failed. Please reconnect.",
  shopify_state_mismatch: "Shopify state mismatch detected. Please reconnect.",
  shopify_state_shop_mismatch: "Shop domain changed during OAuth. Please reconnect.",
  shopify_token_exchange: "Shopify token exchange failed. Please try again.",
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
  const [shopifyScopeWarning, setShopifyScopeWarning] = useState<string | null>(null)
  const [shopifyModalOpen, setShopifyModalOpen] = useState(false)
  const [shopifyShopDomain, setShopifyShopDomain] = useState("")
  const [shopifyConnecting, setShopifyConnecting] = useState(false)
  const [shopifyConnections, setShopifyConnections] = useState<{ shopDomain: string; status: string; missingScopes: string[] }[]>([])
  const [shopifySyncLoading, setShopifySyncLoading] = useState(false)
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
  const [movementDetail, setMovementDetail] = useState<{
    movementId: string
    loading: boolean
    error: string | null
    detail: MovementDetailResponse | null
  } | null>(null)
  const [movementDetailRecatIntent, setMovementDetailRecatIntent] = useState("")
  const [movementDetailRecatLoading, setMovementDetailRecatLoading] = useState(false)
  const [movementDetailUnmergeLoading, setMovementDetailUnmergeLoading] = useState(false)
  const [movementDetailPolicyLoading, setMovementDetailPolicyLoading] = useState(false)
  const [movementDetailAiExplain, setMovementDetailAiExplain] = useState<string | null>(null)
  const [movementDetailAiLoading, setMovementDetailAiLoading] = useState(false)
  const [movementExplainCache, setMovementExplainCache] = useState<Record<string, string>>({})
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
  type LiquidityState = { period_start: string; period_end: string; total_inflows: number; total_outflows: number; period_net_cash_flow: number; operating_inflows: number; operating_outflows: number; net_operating: number; financing_inflows: number; financing_outflows: number; net_financing: number; settlement_inflows: number; settlement_outflows: number; net_settlement: number; settlement_lag?: SettlementLagSignal; owner_inflows: number; owner_outflows: number; net_owner: number; cash_by_account: AccountCash[]; transfer_dependency_ratio: number; owner_support_ratio: number; operating_dependency_ratio: number; liquidity_regime: "strong" | "stable" | "tightening"; excluded_cash: number; starting_cash: number; ending_cash: number; avg_daily_outflow: number; burn_rate: number; runway_days: number | null; bank_account_count: number; largest_account_balance: number; transfer_count: number; period_days: number }
  type Insight = { id: string; type: "revenue" | "spend" | "liquidity" | "risk"; severity: "low" | "medium" | "high"; message: string; metric: number }
  type RiskLevel = "low" | "medium" | "high"
  type RiskDimension = { level: RiskLevel; score: number; reason: string }
  type RiskState = { liquidity_risk: RiskDimension; concentration_risk: RiskDimension; dependency_risk: RiskDimension; anomaly_risk: RiskDimension; uncertainty_risk: RiskDimension; overall: RiskLevel; overall_score: number }
  type BusinessState = { revenue: RevenueState; spend: SpendState; liquidity: LiquidityState; risk: RiskState; transitions: TransitionSignal[]; insights: Insight[]; state_confidence: StateConfidence; insight_block: string; computed_at: string }
  const [stateData, setStateData] = useState<BusinessState | null>(null)
  type ARReconciliationSummary = { 
    total_invoices: number; matched_count: number; partial_count: number; unmatched_count: number; 
    matched_amount: number; partial_matched_amount: number; unmatched_amount: number; match_rate: number;
    accounting_outstanding?: number; bank_verified_outstanding?: number; bank_verified_matched?: number;
    discrepancy?: number; suspicious_count?: number; suspicious_amount?: number;
  }
  type APReconciliationSummary = { 
    total_bills: number; matched_count: number; partial_count: number; unmatched_count: number; 
    matched_amount: number; partial_matched_amount: number; unmatched_amount: number; match_rate: number;
    accounting_outstanding?: number; bank_verified_outstanding?: number; bank_verified_matched?: number;
    discrepancy?: number; suspicious_count?: number; suspicious_amount?: number;
  }
  type ExcludedMovement = { id: string; amount: number; date: string; counterparty: string | null; direction: "inflow" | "outflow"; economic_class: string; cashflow_bucket: string | null }
  type ExcludedCategories = {
    transfers: ExcludedMovement[]; owner_activity: ExcludedMovement[]; fees_and_interest: ExcludedMovement[]; processor_settlements: ExcludedMovement[];
    totals: { transfers_count: number; transfers_amount: number; owner_activity_count: number; owner_activity_amount: number; fees_and_interest_count: number; fees_and_interest_amount: number; processor_settlements_count: number; processor_settlements_amount: number }
  }
  type TransferPair = { outflow_id: string; inflow_id: string; amount: number; date: string; counterparty: string | null; days_apart: number }
  type TransferPairsResult = { pairs: TransferPair[]; unpaired_transfers: ExcludedMovement[]; total_paired_amount: number; total_unpaired_amount: number }
  type ARState = { total_outstanding: number; total_overdue: number; overdue_count: number; invoice_count: number; invoices: OutstandingInvoice[]; paid_invoices?: OutstandingInvoice[]; avg_days_to_due: number | null; reconciliation_summary?: ARReconciliationSummary }
  type APState = { total_expected_30d: number; obligation_count: number; obligations: { obligation_id: string; source: "bill" | "inferred"; vendor_name: string; expected_amount: number; next_expected_date: string; days_until_due: number; days_overdue: number | null; confidence: string; cadence: string; payment_count: number; priority: "high" | "medium" | "low"; risk_flag: string | null }[]; bills?: OutstandingBill[]; paid_bills?: OutstandingBill[]; reconciliation_summary?: APReconciliationSummary }
  type LifetimeSide = { total: number; reconciled: number; reconciled_pct: number; paid: number; paid_pct: number; outstanding: number; invoice_count?: number; bill_count?: number; paid_count: number; open_count: number }
  type LifetimeData = { ar: LifetimeSide; ap: LifetimeSide }
  const [arApData, setArApData] = useState<{ ar: ARState; ap: APState } | null>(null)
  const [lifetimeData, setLifetimeData] = useState<LifetimeData | null>(null)
  const [excludedCategories, setExcludedCategories] = useState<ExcludedCategories | null>(null)
  const [transferPairs, setTransferPairs] = useState<TransferPairsResult | null>(null)
  const [arApLoading, setArApLoading] = useState(false)
  const [arApError, setArApError] = useState<string | null>(null)
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<string | null>(null)
  const [expandedObligationId, setExpandedObligationId] = useState<string | null>(null)
  const [stateLoading, setStateLoading] = useState(false)
  const [stateError, setStateError] = useState<string | null>(null)
  
  // Entity profiles state (Step 12)
  type EntitySummary = {
    id: string
    canonical_name: string
    display_name: string | null
    entity_type: "customer" | "vendor" | null
    archetype: string | null
    lifetime_value: number | null
    outstanding_amount: number | null
    overdue_amount: number | null
    reliability_score: number
    risk_score: number | null
    transaction_count: number
    last_transaction_date: string | null
    ai_summary: string | null
  }
  type EntityProfilesSummary = {
    total_entities: number
    total_customers: number
    total_vendors: number
    total_ar_outstanding: number
    total_ap_outstanding: number
    total_lifetime_value: number
    at_risk_count: number
  }
  const [entityProfiles, setEntityProfiles] = useState<EntitySummary[]>([])
  const [entityProfilesSummary, setEntityProfilesSummary] = useState<EntityProfilesSummary | null>(null)
  const [entityProfilesLoading, setEntityProfilesLoading] = useState(false)
  const [entityProfilesError, setEntityProfilesError] = useState<string | null>(null)
  
  type MappingReconRow = {
    movement_id: string
    amount: number
    date: string
    counterparty: string | null
    display_name?: string | null
    allocations?: { gross: number; fee: number; net: number; entity_type?: string; entity_id?: string }[]
  }
  type MappingReconData = {
    total_matched_inflows: number
    total_matched_outflows: number
    total_unmatched_inflows: number
    total_unmatched_outflows: number
    total_excluded_inflows: number
    total_excluded_outflows: number
    total_fees_paid: number
    count_matched_inflows: number
    count_matched_outflows: number
    count_unmatched_inflows: number
    count_unmatched_outflows: number
    count_excluded_inflows: number
    count_excluded_outflows: number
    matched_inflows?: MappingReconRow[]
    matched_outflows?: MappingReconRow[]
    unmatched_inflows?: MappingReconRow[]
    unmatched_outflows?: MappingReconRow[]
    excluded_inflows?: MappingReconRow[]
    excluded_outflows?: MappingReconRow[]
  }
  type WaterfallReviewPreviewRow = {
    movement_id: string
    amount: number
    date: string
    counterparty: string | null
    raw_description: string | null
    direction: "inflow" | "outflow"
    remaining_cash: number
  }
  type WaterfallReviewData = {
    count: number
    movements: WaterfallReviewPreviewRow[]
  }
  const [mappingArAp, setMappingArAp] = useState<{ ar: ARState; ap: APState } | null>(null)
  const [mappingRecon, setMappingRecon] = useState<MappingReconData | null>(null)
  const [waterfallReview, setWaterfallReview] = useState<WaterfallReviewData | null>(null)
  const [mappingLoading, setMappingLoading] = useState(false)
  const [mappingError, setMappingError] = useState<string | null>(null)
  /** Step 11: manual re-run of /api/ar-ap-step (financial brain + recon) */
  const [reconRefreshLoading, setReconRefreshLoading] = useState(false)
  /** Step 11 bank tx table: show all, reconciled (AR/AP linked), or not reconciled */
  const [reconTxFilter, setReconTxFilter] = useState<"all" | "reconciled" | "unreconciled">("all")

  // Step 13 Enhanced: Additional data for comprehensive Business State view
  type MovementStats = {
    total_count: number
    tagged_count: number
    unresolved_count: number
    anomaly_count: number
    coalesced_count: number
    excluded_for_review: number
    class_counts: Record<string, { count: number; total_amount: number }>
  }
  const [step13ArAp, setStep13ArAp] = useState<{ ar: ARState; ap: APState } | null>(null)
  const [step13Movements, setStep13Movements] = useState<{ movements: unknown[]; summary: unknown[]; summaryFromTags?: MovementStats } | null>(null)
  const [step13Entities, setStep13Entities] = useState<{ profiles: EntitySummary[]; summary: EntityProfilesSummary } | null>(null)
  const [step13DataLoading, setStep13DataLoading] = useState(false)

  const openMovementDetail = useCallback(async (movementId: string) => {
    setMovementDetail({ movementId, loading: true, error: null, detail: null })
    setMovementDetailRecatIntent("")
    setMovementDetailAiExplain(movementExplainCache[movementId] ?? null)
    try {
      const res = await fetch(`/api/movements/${movementId}/detail`)
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? "Failed to load movement detail")
      setMovementDetail({ movementId, loading: false, error: null, detail: data as MovementDetailResponse })
    } catch (e) {
      setMovementDetail({
        movementId,
        loading: false,
        error: e instanceof Error ? e.message : "Failed to load movement detail",
        detail: null,
      })
    }
  }, [movementExplainCache])

  type ComponentBehavior = "recurring" | "episodic" | "seasonal" | "one_time"
  type CashflowComponent = { id: string; label: string; direction: "in" | "out"; category: string; behavior: ComponentBehavior; monthly_avg: number; monthly_count: number; trend: number; volatility: number; confidence: "high" | "medium" | "low"; seasonal_index: Record<number, number> | null }
  type OutstandingInvoice = { invoice_id: string; source: string; customer_name: string; customer_source_id: string | null; entity_id: string | null; amount: number; amount_due: number; due_date: string | null; days_until_due: number | null; days_overdue: number | null; status: "open" | "overdue" | "partially_paid" | "paid"; reconciliation_status?: "matched" | "unmatched" | "partial"; matched_movement_ids?: string[]; matched_amount?: number; payment_date?: string | null }
  type InvoiceSignal = { invoices: OutstandingInvoice[]; total_outstanding: number; total_overdue: number; overdue_count: number; avg_days_to_due: number | null }
  type CustomerArchetype = "clockwork" | "bursty" | "episodic" | "slow_reliable" | "volatile" | "low_data"
  type CustomerFeatures = { payment_count: number; invoice_count: number; paid_vs_unpaid_ratio: number; avg_days_to_pay: number; std_days_to_pay: number; amount_mean: number; amount_std: number; interval_cv: number; recent_trend: string; last_payment_recency_days: number; overdue_count: number; weekday_bias: number | null }
  type InvoiceForecast = { invoice_id: string; customer_name: string; amount_due: number; due_date: string | null; days_overdue: number | null; customer_dso: number; probability_7d: number; probability_14d: number; probability_30d: number; expected_collection_date: string; expected_amount: number; reasoning: string }
  type CustomerModel = { entity_id: string; name: string; archetype: CustomerArchetype; features: CustomerFeatures; avg_amount: number; payment_interval_days: number; interval_variance: number; last_payment_date: string; payment_count: number; probability_of_next: number; next_expected_date: string | null; confidence: "high" | "medium" | "low"; outstanding_invoices: OutstandingInvoice[]; invoice_forecasts: InvoiceForecast[] }
  type OutstandingBill = { bill_id: string; source: string; vendor_name: string; vendor_source_id?: string | null; entity_id?: string | null; amount: number; amount_due: number; due_date: string | null; days_until_due: number | null; days_overdue: number | null; status: "open" | "overdue" | "partially_paid" | "paid"; reconciliation_status?: "matched" | "unmatched" | "partial"; matched_movement_ids?: string[]; matched_amount?: number }
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
  type CashflowForecast = { period_start: string; forecast_horizon_months: number; horizon_capped?: boolean; horizon_cap_reason?: string; components: CashflowComponent[]; behavioral_models: BehavioralModels; events_30d: ForecastEvent[]; daily_simulation: DailySimulation; monte_carlo: MonteCarloResult; narrative: ForecastNarrative; scenarios: ScenarioResult[]; data_span_days: number; computed_at: string; forecast_confidence?: ForecastConfidence; cash_runway?: CashRunway; sensitivity?: SensitivityAnalysis; interventions?: Intervention[]; combined_strategies?: CombinedStrategy[]; execution_suggestions?: ExecutionSuggestion[]; context?: ForecastContext; backtest?: BacktestResult | null; separated_forecast?: SeparatedForecast }
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
      .catch(() => {})
      .finally(() => setAddAccountLinkLoading(false))
  }, [currentStep, fetchConnectedItems])

  const lastAccountingSyncRef = useRef<number>(0)
  const lastRealmCountRef = useRef<number>(0)
  const lastTenantCountRef = useRef<number>(0)
  const pollRetryCountRef = useRef<number>(0)
  const reconPollCancelledRef = useRef<boolean>(false)
  const reconPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const SYNC_COOLDOWN_MS = 60_000 // 1 minute: avoid duplicate syncs and QBO 429
  const MAX_POLL_RETRIES = 90 // 90 retries * 2s = 3 minutes max polling

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
      .catch(() => {})
      .finally(() => setAccountingStepLinkLoading(false))
    fetch("/api/connections")
      .then((res) => (res.ok ? res.json() : { connected: [], realmIds: [], tenantIds: [] }))
      .then((data: { connected?: string[]; realmIds?: string[]; tenantIds?: string[] }) => {
        setConnectedIntegrations(data.connected ?? [])
      })
      .catch(() => setConnectedIntegrations([]))
    fetch("/api/shopify/status")
      .then((res) => (res.ok ? res.json() : { connections: [] }))
      .then((data: { connected?: boolean; connections?: { shopDomain?: string; status?: string; missingScopes?: string[] }[] }) => {
        const connections = (data.connections ?? []).map((c) => ({
          shopDomain: c.shopDomain ?? "",
          status: c.status ?? "unknown",
          missingScopes: c.missingScopes ?? [],
        }))
        setShopifyConnections(connections)
        setShopifyConnecting(false)
        if (data.connected) {
          setConnectedIntegrations((prev) => prev.includes("Shopify") ? prev : [...prev, "Shopify"])
        }
        
        const problematic = connections.find((c) => c.missingScopes.length > 0)
        if (problematic) {
          setShopifyScopeWarning(
            `Shopify connection for ${problematic.shopDomain || "your store"} is missing scopes: ${problematic.missingScopes.join(", ")}`
          )
        } else {
          setShopifyScopeWarning(null)
        }
      })
      .catch(() => {
        setShopifyScopeWarning(null)
        setShopifyConnections([])
        setShopifyConnecting(false)
      })
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
    reconPollCancelledRef.current = false

    setArApLoading(true)
    setArApError(null)
    setArApData(null)
    setMappingLoading(true)
    setMappingError(null)
    setMappingArAp(null)
    setMappingRecon(null)
    setWaterfallReview(null)

    fetch("/api/ar-ap-step")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("AR/AP step failed"))))
      .then((data: { ar: ARState; ap: APState; recon?: MappingReconData; waterfall_review?: WaterfallReviewData; excluded_categories?: ExcludedCategories; transfer_pairs?: TransferPairsResult; is_reconciling?: boolean }) => {
        if (cancelled) return
        if (data.is_reconciling) {
          setArApLoading(false)
          setMappingLoading(false)
          void pollReconciliationStatus()
          return
        }
        setArApData({ ar: data.ar, ap: data.ap })
        setMappingArAp({ ar: data.ar, ap: data.ap })
        setMappingRecon(data.recon ?? null)
        setWaterfallReview(data.waterfall_review ?? null)
        setExcludedCategories(data.excluded_categories ?? null)
        setTransferPairs(data.transfer_pairs ?? null)
        if (data.lifetime) setLifetimeData(data.lifetime)
        setArApLoading(false)
        setMappingLoading(false)
      })
      .catch((e) => {
        if (cancelled || (e instanceof Error && e.message === "Cancelled")) return
        const msg = e instanceof Error ? e.message : "Failed to load"
        setMappingError(msg)
        setArApError(msg)
        setArApLoading(false)
        setMappingLoading(false)
      })

    return () => {
      cancelled = true
      reconPollCancelledRef.current = true
      if (reconPollTimerRef.current) { clearTimeout(reconPollTimerRef.current); reconPollTimerRef.current = null }
    }
  }, [currentStep])

  const runArApReconciliation = useCallback(async () => {
    setReconRefreshLoading(true)
    setMappingError(null)
    setArApError(null)
    try {
      const r = await fetch("/api/ar-ap-step?run=true")
      const data = (await r.json()) as {
        ar?: ARState
        ap?: APState
        recon?: MappingReconData
        waterfall_review?: WaterfallReviewData
        excluded_categories?: ExcludedCategories
        transfer_pairs?: TransferPairsResult
        is_reconciling?: boolean
        error?: string
        detail?: string
        message?: string
      }
      if (!r.ok) {
        const msg =
          typeof data.detail === "string" ? data.detail : data.error ?? "Reconciliation failed"
        throw new Error(msg)
      }
      
      // If reconciliation just started or is in progress, start polling
      // Don't try to update UI with data that may not be present
      if (data.is_reconciling) {
        // Start polling to update data when reconciliation completes
        void pollReconciliationStatus()
        // Keep reconRefreshLoading true to show indicator
        return
      }
      
      // Reconciliation not running - update UI with current data
      if (data.ar && data.ap) {
        setArApData({ ar: data.ar, ap: data.ap })
        setMappingArAp({ ar: data.ar, ap: data.ap })
      }
      if (data.recon !== undefined) setMappingRecon(data.recon)
      if (data.waterfall_review !== undefined) setWaterfallReview(data.waterfall_review)
      if (data.excluded_categories !== undefined) setExcludedCategories(data.excluded_categories)
      if (data.transfer_pairs !== undefined) setTransferPairs(data.transfer_pairs)
      if (data.lifetime) setLifetimeData(data.lifetime)
      
      setReconRefreshLoading(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to reconcile"
      setMappingError(msg)
      setArApError(msg)
      setReconRefreshLoading(false)
    }
  }, [])

  const pollReconciliationStatus = useCallback(async () => {
    if (reconPollCancelledRef.current) return
    try {
      const r = await fetch("/api/ar-ap-step")
      if (reconPollCancelledRef.current) return
      const data = (await r.json()) as {
        ar?: ARState
        ap?: APState
        recon?: MappingReconData
        waterfall_review?: WaterfallReviewData
        excluded_categories?: ExcludedCategories
        transfer_pairs?: TransferPairsResult
        is_reconciling?: boolean
        message?: string
      }
      if (r.ok) {
        if (data.is_reconciling) {
          pollRetryCountRef.current++
          if (pollRetryCountRef.current >= MAX_POLL_RETRIES) {
            setMappingError("Reconciliation is taking too long. Please refresh the page to check status.")
            setReconRefreshLoading(false)
            pollRetryCountRef.current = 0
            return
          }
          reconPollTimerRef.current = setTimeout(() => {
            void pollReconciliationStatus()
          }, 2000)
          return
        }
        
        // Reconciliation complete - reset retry counter and update UI
        pollRetryCountRef.current = 0
        if (data.ar && data.ap) {
          setArApData({ ar: data.ar, ap: data.ap })
          setMappingArAp({ ar: data.ar, ap: data.ap })
        }
        if (data.recon !== undefined) setMappingRecon(data.recon)
        if (data.waterfall_review !== undefined) setWaterfallReview(data.waterfall_review)
        if (data.excluded_categories !== undefined) setExcludedCategories(data.excluded_categories)
        if (data.transfer_pairs !== undefined) setTransferPairs(data.transfer_pairs)
        if (data.lifetime) setLifetimeData(data.lifetime)
        setReconRefreshLoading(false)
      }
    } catch {
      pollRetryCountRef.current = 0
      setReconRefreshLoading(false)
    }
  }, [])

  // Step 12: Entity Profiles (AI-powered customer/vendor intelligence)
  useEffect(() => {
    if (currentStep !== 12) return
    let cancelled = false

    setEntityProfilesLoading(true)
    setEntityProfilesError(null)

    fetch("/api/entities?sort=lifetime_value&min_transactions=1")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then((data: { entities: EntitySummary[]; summary: EntityProfilesSummary }) => {
        if (cancelled) return
        setEntityProfiles(data.entities || [])
        setEntityProfilesSummary(data.summary || null)
        setEntityProfilesLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setEntityProfilesError(err instanceof Error ? err.message : "Failed to load entity profiles")
        setEntityProfilesLoading(false)
      })

    return () => { cancelled = true }
  }, [currentStep])

  // Step 13: Business State (financial health overview)
  useEffect(() => {
    if (currentStep !== 13) return
    let cancelled = false

    setStateLoading(true)
    setStateError(null)
    setStep13DataLoading(true)

    // Fetch all data in parallel for comprehensive dashboard
    Promise.all([
      fetch("/api/state/compute", { method: "POST" }).then((res) => res.ok ? res.json() : Promise.reject(new Error(res.statusText))),
      fetch("/api/ar-ap-step").then((res) => res.ok ? res.json() : null).catch(() => null),
      fetch("/api/movements").then((res) => res.ok ? res.json() : null).catch(() => null),
      fetch("/api/entities?sort=reliability_score&min_transactions=1").then((res) => res.ok ? res.json() : null).catch(() => null),
    ])
      .then(([stateResult, arApResult, movementsResult, entitiesResult]) => {
        if (cancelled) return
        setStateData(stateResult as BusinessState)
        if (arApResult) setStep13ArAp(arApResult as { ar: ARState; ap: APState })
        if (movementsResult) setStep13Movements(movementsResult as { movements: unknown[]; summary: unknown[]; summaryFromTags?: MovementStats })
        if (entitiesResult) {
          const entities = (entitiesResult as { entities?: EntitySummary[] }).entities ?? []
          const summary = (entitiesResult as { summary?: EntityProfilesSummary }).summary ?? {
            total_entities: entities.length,
            total_customers: entities.filter((p: EntitySummary) => p.entity_type === "customer").length,
            total_vendors: entities.filter((p: EntitySummary) => p.entity_type === "vendor").length,
            total_ar_outstanding: entities.reduce((sum: number, p: EntitySummary) => sum + (p.entity_type === "customer" ? (p.outstanding_amount ?? 0) : 0), 0),
            total_ap_outstanding: entities.reduce((sum: number, p: EntitySummary) => sum + (p.entity_type === "vendor" ? (p.outstanding_amount ?? 0) : 0), 0),
            total_lifetime_value: entities.reduce((sum: number, p: EntitySummary) => sum + (p.lifetime_value ?? 0), 0),
            at_risk_count: entities.filter((p: EntitySummary) => p.reliability_score < 50).length,
          }
          setStep13Entities({ profiles: entities, summary })
        }
        setStateLoading(false)
        setStep13DataLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setStateError(err instanceof Error ? err.message : "Failed to compute business state")
        setStateLoading(false)
        setStep13DataLoading(false)
      })

    return () => { cancelled = true }
  }, [currentStep])

  // Step 14 & 15: Cashflow forecast + Decisions (share forecast data)
  useEffect(() => {
    if (currentStep !== 14 && currentStep !== 15) return
    if (DISABLE_ADVANCED_STEPS_FROM_ONBOARDING) {
      setForecastLoading(false)
      setForecastError(null)
      setForecastData(null)
      return
    }
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
        }).catch(() => {}).finally(() => handleNext())
      } else {
        handleNext()
      }
    } else if (currentStep === 7) {
      fetch("/api/onboarding/company-form", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ form: companyForm }),
      }).catch(() => {}).finally(() => handleNext())
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
            {shopifyScopeWarning && (
              <p className="text-sm text-amber-300 text-center mb-4">{shopifyScopeWarning}</p>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-8 max-w-2xl mx-auto">
              {integrations.map((integration) => {
                const usePlaid = PLAID_INTEGRATIONS.includes(integration.name)
                const isStripe = integration.name === "Stripe"
                const isShopify = integration.name === "Shopify"
                const isXero = integration.name === "Xero"
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
                        window.location.href = "/api/stripe/oauth/authorize"
                      } else if (isXero) {
                        window.location.href = "/api/xero/oauth/authorize"
                      } else if (isShopify) {
                        setShopifyModalOpen(true)
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

            {/* Shopify Connection Modal */}
            {shopifyModalOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="bg-[#1a1a2e] border border-white/10 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-white">Connect Shopify Store</h3>
                    <button
                      onClick={() => {
                        setShopifyModalOpen(false)
                        setShopifyShopDomain("")
                      }}
                      className="text-gray-400 hover:text-white transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  
                  <p className="text-sm text-gray-400 mb-4">
                    Enter your Shopify store domain to connect. We'll sync your orders, customers, and products.
                  </p>
                  
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-1.5">Store Domain</label>
                      <div className="flex items-center">
                        <input
                          type="text"
                          value={shopifyShopDomain}
                          onChange={(e) => setShopifyShopDomain(e.target.value)}
                          placeholder="your-store"
                          className="flex-1 bg-white/5 border border-white/10 rounded-l-lg px-3 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30"
                        />
                        <span className="bg-white/10 border border-l-0 border-white/10 rounded-r-lg px-3 py-2.5 text-gray-400 text-sm">
                          .myshopify.com
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1.5">
                        Find this in your Shopify admin URL: https://<span className="text-emerald-400">your-store</span>.myshopify.com
                      </p>
                    </div>
                    
                    {/* Show existing connections */}
                    {shopifyConnections.length > 0 && (
                      <div className="border-t border-white/10 pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs text-gray-400">Connected stores:</p>
                          <button
                            onClick={async () => {
                              setShopifySyncLoading(true)
                              try {
                                const res = await fetch("/api/shopify/sync", { method: "POST" })
                                if (!res.ok) throw new Error("Sync failed")
                                // Refresh status after sync
                                const statusRes = await fetch("/api/shopify/status")
                                if (statusRes.ok) {
                                  const data = await statusRes.json()
                                  const connections = (data.connections ?? []).map((c: { shopDomain?: string; status?: string; missingScopes?: string[] }) => ({
                                    shopDomain: c.shopDomain ?? "",
                                    status: c.status ?? "unknown",
                                    missingScopes: c.missingScopes ?? [],
                                  }))
                                  setShopifyConnections(connections)
                                }
                              } catch {
                                // ignore
                              } finally {
                                setShopifySyncLoading(false)
                              }
                            }}
                            disabled={shopifySyncLoading}
                            className="text-xs text-emerald-400 hover:text-emerald-300 disabled:text-gray-500 transition-colors flex items-center gap-1"
                          >
                            {shopifySyncLoading ? (
                              <>
                                <div className="h-3 w-3 rounded-full border border-emerald-400/30 border-t-emerald-400 animate-spin" />
                                Syncing...
                              </>
                            ) : (
                              <>
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                                Sync Now
                              </>
                            )}
                          </button>
                        </div>
                        <div className="space-y-2">
                          {shopifyConnections.map((conn) => (
                            <div key={conn.shopDomain} className="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2">
                              <span className="text-sm text-white">{conn.shopDomain}</span>
                              <div className="flex items-center gap-2">
                                <span className={`text-xs px-2 py-0.5 rounded-full ${conn.status === "connected" ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"}`}>
                                  {conn.status === "connected" ? "Connected" : "Needs Reauth"}
                                </span>
                                <button
                                  onClick={async () => {
                                    if (!confirm(`Disconnect ${conn.shopDomain}? This will remove all synced data.`)) return
                                    try {
                                      const res = await fetch("/api/shopify/disconnect", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ shop: conn.shopDomain }),
                                      })
                                      if (res.ok) {
                                        setShopifyConnections((prev) => prev.filter((c) => c.shopDomain !== conn.shopDomain))
                                        setConnectedIntegrations((prev) => {
                                          const remaining = shopifyConnections.filter((c) => c.shopDomain !== conn.shopDomain)
                                          if (remaining.length === 0) return prev.filter((i) => i !== "Shopify")
                                          return prev
                                        })
                                      }
                                    } catch {
                                      // ignore
                                    }
                                  }}
                                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                                >
                                  Disconnect
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={() => {
                          setShopifyModalOpen(false)
                          setShopifyShopDomain("")
                        }}
                        className="flex-1 px-4 py-2.5 border border-white/20 rounded-lg text-gray-300 hover:bg-white/5 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          const domain = shopifyShopDomain.trim().toLowerCase()
                          if (!domain) return
                          const fullDomain = domain.includes(".myshopify.com") ? domain : `${domain}.myshopify.com`
                          setShopifyConnecting(true)
                          window.location.href = `/api/shopify/oauth/authorize?shop=${encodeURIComponent(fullDomain)}`
                        }}
                        disabled={!shopifyShopDomain.trim() || shopifyConnecting}
                        className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors flex items-center justify-center gap-2"
                      >
                        {shopifyConnecting ? (
                          <>
                            <div className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                            Connecting...
                          </>
                        ) : (
                          "Connect Store"
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
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
                            <td className="text-gray-400 px-3 py-1.5 text-xs max-w-[220px]">
                              <div className="truncate">{m.raw_description ?? "\u2014"}</div>
                              <button
                                type="button"
                                onClick={() => openMovementDetail(m.id)}
                                className="mt-1 text-[10px] text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
                              >
                                View details
                              </button>
                            </td>
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
                          <td className="text-gray-400 px-3 py-1.5 text-xs max-w-[220px]">
                            <div className="truncate">{m.raw_description ?? "\u2014"}</div>
                            <button
                              type="button"
                              onClick={() => openMovementDetail(m.id)}
                              className="mt-1 text-[10px] text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
                            >
                              View details
                            </button>
                          </td>
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
                          .catch(() => {})
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

                {movementDetail && (
                  <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end justify-center p-0 sm:items-center sm:p-6">
                    <div className="w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-white/15 bg-[#0B0D10] shadow-2xl">
                      <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-white/10 bg-[#0B0D10]/95">
                        <h3 className="text-lg font-semibold text-white">Movement detail</h3>
                        <button type="button" onClick={() => setMovementDetail(null)} className="text-sm text-gray-400 hover:text-white">Close</button>
                      </div>
                      <div className="p-5 space-y-5">
                        {movementDetail.loading && <p className="text-sm text-gray-400">Loading detail...</p>}
                        {movementDetail.error && <p className="text-sm text-red-300">{movementDetail.error}</p>}
                        {movementDetail.detail && (() => {
                          const d = movementDetail.detail
                          const statusText =
                            d.headline.status_badge === "included_pnl" ? "Included in P&L" :
                            d.headline.status_badge === "included_non_pnl" ? "Included non-P&L" :
                            d.headline.status_badge === "excluded_needs_review" ? "Excluded - needs review" :
                            "Unresolved"
                          return (
                            <>
                              <section className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                                <div className="flex flex-wrap items-center gap-3">
                                  <div className="text-2xl font-semibold text-white">
                                    {`${d.headline.direction === "outflow" ? "-" : "+"}$${Math.abs(d.headline.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                                  </div>
                                  <div className="text-sm text-gray-400">{d.headline.date?.slice(0, 10)}</div>
                                  <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-xs text-cyan-300">{statusText}</span>
                                </div>
                                <div className="mt-2 text-sm text-white">Canonical entity: {d.headline.canonical_entity_name ?? "Unresolved"}</div>
                                <div className="text-xs text-gray-500">Raw counterparty: {d.headline.raw_counterparty ?? "—"}</div>
                              </section>

                              <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div className="rounded-lg border border-white/10 p-4">
                                  <h4 className="text-sm font-medium text-white mb-2">Economic semantics</h4>
                                  <p className="text-xs text-gray-400">Class: <span className="text-gray-200">{d.economic_semantics.economic_class ?? "—"}</span></p>
                                  <p className="text-xs text-gray-400">Bucket: <span className="text-gray-200">{d.economic_semantics.cashflow_bucket ?? "—"}</span></p>
                                  <p className="text-xs text-gray-400">Role: <span className="text-gray-200">{d.economic_semantics.counterparty_role ?? "—"}</span></p>
                                  <p className="text-xs text-gray-400 mt-2">Policy: <span className="text-gray-200">{d.economic_semantics.policy_status ?? "—"}</span></p>
                                </div>
                                <div className="rounded-lg border border-white/10 p-4">
                                  <h4 className="text-sm font-medium text-white mb-2">Confidence engine</h4>
                                  <p className="text-xs text-gray-400">Class score: <span className="text-gray-200">{Math.round(d.confidence_engine.overall.classification_score * 100)}%</span></p>
                                  <p className="text-xs text-gray-400">Evidence: <span className="text-gray-200">{Math.round(d.confidence_engine.overall.evidence_strength * 100)}%</span></p>
                                  {d.confidence_engine.explanation_lines.slice(0, 3).map((line, idx) => (
                                    <p key={idx} className="text-xs text-gray-500 mt-1">{line}</p>
                                  ))}
                                </div>
                              </section>

                              <section className="rounded-lg border border-white/10 p-4">
                                <h4 className="text-sm font-medium text-white mb-2">Normalized bank info</h4>
                                <p className="text-xs text-gray-400">Raw: <span className="text-gray-200">{d.normalized_bank_info.raw_bank_text ?? "—"}</span></p>
                                <p className="text-xs text-gray-400">Scrubbed: <span className="text-gray-200">{d.normalized_bank_info.scrubbed_bank_text || "—"}</span></p>
                                <p className="text-xs text-gray-400">Normalized: <span className="text-gray-200">{d.normalized_bank_info.normalized_display_name ?? "—"}</span></p>
                                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                                  <p className="text-gray-500">Precedence: <span className="text-gray-300">{d.normalized_bank_info.resolution_path.classification_precedence ?? "—"}</span></p>
                                  <p className="text-gray-500">Alias signature: <span className="text-gray-300">{d.normalized_bank_info.resolution_path.alias_signature ?? "—"}</span></p>
                                  <p className="text-gray-500">Canonical alias ID: <span className="text-gray-300">{d.normalized_bank_info.resolution_path.canonical_alias_id ?? "—"}</span></p>
                                  <p className="text-gray-500">Entity ID: <span className="text-gray-300">{d.normalized_bank_info.resolution_path.counterparty_entity_id ?? "—"}</span></p>
                                </div>
                              </section>

                              <section className="rounded-lg border border-white/10 p-4">
                                <h4 className="text-sm font-medium text-white mb-2">Source mapping & evidence trail</h4>
                                <p className="text-xs text-gray-500 mb-3">
                                  Provenance: <span className="text-gray-300">{d.evidence_trail.provenance}</span>
                                  {" · "}
                                  Coalesced group: <span className="text-gray-300">{d.evidence_trail.coalesced_group_id ?? "—"}</span>
                                </p>
                                <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
                                  {d.evidence_trail.observations.map((o, idx) => (
                                    <div key={`${o.source}-${o.source_id}-${idx}`} className="rounded-md border border-white/10 bg-white/[0.02] p-2">
                                      <div className="flex flex-wrap items-center gap-2 mb-1">
                                        <span className="text-[10px] uppercase rounded bg-white/10 px-1.5 py-0.5 text-gray-300">{o.source}</span>
                                        <span className="text-[10px] text-gray-500">{o.source_type}</span>
                                        <span className="text-[10px] text-cyan-300">ID: {o.source_id}</span>
                                      </div>
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-[11px]">
                                        <p className="text-gray-400">Amount: <span className="text-gray-200">{o.amount == null ? "—" : `$${Number(o.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</span></p>
                                        <p className="text-gray-400">Date: <span className="text-gray-200">{o.date ?? "—"}</span></p>
                                        <p className="text-gray-400">Counterparty: <span className="text-gray-200">{o.counterparty ?? "—"}</span></p>
                                        <p className="text-gray-400">Account: <span className="text-gray-200">{o.account_name ?? o.account_id ?? "—"}</span></p>
                                      </div>
                                      <p className="text-[11px] text-gray-500 mt-1 break-words">Raw: {o.raw_description ?? "—"}</p>
                                      {Object.keys(o.metadata ?? {}).length > 0 && (
                                        <pre className="mt-1 rounded bg-black/40 p-2 text-[10px] text-gray-400 overflow-x-auto">{JSON.stringify(o.metadata, null, 2)}</pre>
                                      )}
                                    </div>
                                  ))}
                                  {d.evidence_trail.observations.length === 0 && (
                                    <p className="text-xs text-gray-500">No source observations available.</p>
                                  )}
                                </div>
                              </section>

                              <section className="rounded-lg border border-white/10 p-4">
                                <h4 className="text-sm font-medium text-white mb-2">Confidence breakdown (all signals)</h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs">
                                  {Object.entries(d.confidence_engine.breakdown).map(([k, v]) => (
                                    <p key={k} className="text-gray-400">
                                      {k.replaceAll("_", " ")}:{" "}
                                      <span className="text-gray-200">{v == null ? "—" : `${Math.round(v * 100)}%`}</span>
                                    </p>
                                  ))}
                                </div>
                                {d.confidence_engine.reasons.length > 0 && (
                                  <div className="mt-2 text-xs text-yellow-300">
                                    Reasons: {d.confidence_engine.reasons.join(", ")}
                                  </div>
                                )}
                              </section>

                              <section className="rounded-lg border border-white/10 p-4">
                                <div className="flex items-center justify-between gap-2 mb-2">
                                  <h4 className="text-sm font-medium text-white">AI explainability</h4>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={movementDetailAiLoading}
                                    onClick={async () => {
                                      setMovementDetailAiLoading(true)
                                      try {
                                        const res = await fetch("/api/movements/explain", {
                                          method: "POST",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ detail: d }),
                                        })
                                        const data = await res.json().catch(() => ({}))
                                        const text = res.ok ? (data.explanation ?? "No explanation returned.") : (data.error ?? "Failed to generate AI explanation")
                                        setMovementExplainCache((prev) => ({ ...prev, [d.headline.movement_id]: text }))
                                        setMovementDetailAiExplain(text)
                                      } finally {
                                        setMovementDetailAiLoading(false)
                                      }
                                    }}
                                  >
                                    {movementDetailAiLoading ? "Generating..." : "Generate AI explanation"}
                                  </Button>
                                </div>
                                <p className="text-xs text-gray-500">Plain-English narrative of how this movement was mapped, where certainty is strong, and what might still be wrong.</p>
                                {movementDetailAiExplain && <p className="mt-2 text-xs text-gray-200 whitespace-pre-wrap">{movementDetailAiExplain}</p>}
                              </section>

                              <section className="rounded-lg border border-white/10 p-4">
                                <h4 className="text-sm font-medium text-white mb-3">Controls</h4>
                                <div className="flex flex-wrap gap-2">
                                  <Input
                                    value={movementDetailRecatIntent}
                                    onChange={(e) => setMovementDetailRecatIntent(e.target.value)}
                                    placeholder='Recategorize, e.g. "Set as owner draw"'
                                    className="min-w-[260px] flex-1 bg-black/40 border-white/20 text-white placeholder:text-gray-500"
                                  />
                                  <Button
                                    type="button"
                                    disabled={!movementDetailRecatIntent.trim() || movementDetailRecatLoading}
                                    onClick={async () => {
                                      if (!movementDetailRecatIntent.trim()) return
                                      setMovementDetailRecatLoading(true)
                                      try {
                                        await fetch("/api/movements/edit", {
                                          method: "POST",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ intent: movementDetailRecatIntent.trim(), movement_ids: [d.headline.movement_id] }),
                                        })
                                        await fetch("/api/movements/tag", { method: "POST" })
                                        const refreshed = await fetch(`/api/movements/${d.headline.movement_id}/detail`)
                                        const detailData = await refreshed.json()
                                        if (refreshed.ok) setMovementDetail((prev) => prev ? { ...prev, detail: detailData, loading: false, error: null } : prev)
                                        const movementRes = await fetch("/api/movements")
                                        if (movementRes.ok) setMovementsData(await movementRes.json())
                                        setMovementDetailRecatIntent("")
                                      } finally {
                                        setMovementDetailRecatLoading(false)
                                      }
                                    }}
                                  >
                                    {movementDetailRecatLoading ? "Saving..." : "Recategorize"}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    disabled={movementDetailUnmergeLoading || !d.controls.can_unmerge_entity}
                                    onClick={async () => {
                                      setMovementDetailUnmergeLoading(true)
                                      try {
                                        await fetch("/api/movements/unmerge", {
                                          method: "POST",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ movement_id: d.headline.movement_id, apply_to_all_with_same_alias: true }),
                                        })
                                        const movementRes = await fetch("/api/movements")
                                        if (movementRes.ok) setMovementsData(await movementRes.json())
                                        setMovementDetail(null)
                                      } finally {
                                        setMovementDetailUnmergeLoading(false)
                                      }
                                    }}
                                  >
                                    {movementDetailUnmergeLoading ? "Unmerging..." : "Unmerge entity"}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    disabled={movementDetailPolicyLoading || !d.controls.can_force_policy}
                                    onClick={async () => {
                                      setMovementDetailPolicyLoading(true)
                                      try {
                                        await fetch("/api/movements/override-policy", {
                                          method: "POST",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ movement_id: d.headline.movement_id, action: "force_include" }),
                                        })
                                        await fetch("/api/movements/tag", { method: "POST" })
                                        const movementRes = await fetch("/api/movements")
                                        if (movementRes.ok) setMovementsData(await movementRes.json())
                                      } finally {
                                        setMovementDetailPolicyLoading(false)
                                      }
                                    }}
                                  >
                                    Force include
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    disabled={movementDetailPolicyLoading || !d.controls.can_force_policy}
                                    onClick={async () => {
                                      setMovementDetailPolicyLoading(true)
                                      try {
                                        await fetch("/api/movements/override-policy", {
                                          method: "POST",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ movement_id: d.headline.movement_id, action: "force_exclude" }),
                                        })
                                        await fetch("/api/movements/tag", { method: "POST" })
                                        const movementRes = await fetch("/api/movements")
                                        if (movementRes.ok) setMovementsData(await movementRes.json())
                                      } finally {
                                        setMovementDetailPolicyLoading(false)
                                      }
                                    }}
                                  >
                                    Force exclude
                                  </Button>
                                </div>
                              </section>
                            </>
                          )
                        })()}
                      </div>
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
          if (status === "paid") return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">Paid</span>
          if (status === "overdue" || (daysOverdue != null && daysOverdue > 0))
            return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">Overdue</span>
          if (status === "partially_paid") return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">Partial</span>
          return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">Open</span>
        }
        const arInvoices = arApData?.ar?.invoices ?? []
        const arOverdueFirst = [...arInvoices].sort((a, b) => (b.days_overdue ?? 0) - (a.days_overdue ?? 0))
        const apObligations = arApData?.ap?.obligations ?? []
        const allReconRowsRaw = mappingRecon
          ? [
              ...(mappingRecon.matched_inflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations?: { gross: number; fee: number; net: number }[] }) => ({
                ...m,
                direction: "inflow" as const,
                reconciled: true as const,
              })),
              ...(mappingRecon.matched_outflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations?: { gross: number; fee: number; net: number }[] }) => ({
                ...m,
                direction: "outflow" as const,
                reconciled: true as const,
              })),
              ...(mappingRecon.unmatched_inflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations?: { gross: number; fee: number; net: number }[] }) => ({
                ...m,
                direction: "inflow" as const,
                reconciled: false as const,
                allocations: m.allocations ?? [],
              })),
              ...(mappingRecon.unmatched_outflows ?? []).map((m: { movement_id: string; amount: number; date: string; counterparty: string | null; display_name?: string | null; allocations?: { gross: number; fee: number; net: number }[] }) => ({
                ...m,
                direction: "outflow" as const,
                reconciled: false as const,
                allocations: m.allocations ?? [],
              })),
            ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
          : []
        const reconReconciledCount = allReconRowsRaw.filter((r) => r.reconciled).length
        const reconUnreconciledCount = allReconRowsRaw.length - reconReconciledCount
        const allReconRows = allReconRowsRaw.filter((r) => {
          if (reconTxFilter === "all") return true
          if (reconTxFilter === "reconciled") return r.reconciled
          return !r.reconciled
        })

        return (
          <div className="space-y-6">
            <div className="text-center mb-2">
              <h2 className="text-2xl font-semibold text-white mb-1">{steps[10].title}</h2>
              <p className="text-gray-400 text-lg mb-1">{steps[10].description}</p>
              <p className="text-[11px] text-gray-500 mb-3">Bank payments matched to invoices and obligations. Gross − Fee = Net.</p>

              {!arApLoading && !mappingLoading && (
                <div className="flex justify-center mb-5">
                  <button
                    type="button"
                    onClick={() => void runArApReconciliation()}
                    disabled={reconRefreshLoading}
                    className="text-sm font-medium px-4 py-2 rounded-lg border border-cyan-500/45 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {reconRefreshLoading ? "Reconciling…" : "Run reconciliation"}
                  </button>
                </div>
              )}

              {(arApLoading || mappingLoading) && (
                <div className="flex items-center justify-center gap-2 py-6 text-gray-400">
                  <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Loading AR/AP & reconciliation…
                </div>
              )}

              {(arApError || mappingError) && !arApLoading && !mappingLoading && (
                <p className="text-red-300 text-sm mb-4">Failed: {arApError || mappingError}</p>
              )}

              {!arApLoading && !mappingLoading && waterfallReview && waterfallReview.count > 0 && (
                <div className="max-w-2xl mx-auto rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-left text-sm text-amber-100/95 mb-4">
                  <p className="font-medium text-amber-200">
                    {waterfallReview.count} bank transaction{waterfallReview.count !== 1 ? "s" : ""} flagged for review
                    <span className="font-normal text-amber-100/80"> — large leftover cash after deterministic rules (Stage 4).</span>
                  </p>
                  {waterfallReview.movements.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[11px] text-amber-100/70 font-mono">
                      {waterfallReview.movements.map((m) => (
                        <li key={m.movement_id}>
                          {m.date.slice(0, 10)} · {m.direction === "inflow" ? "+" : "−"}
                          {m.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ·{" "}
                          {m.counterparty ?? m.raw_description ?? "—"}{" "}
                          <span className="text-amber-200/80">
                            (leftover {m.remaining_cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {waterfallReview.count > waterfallReview.movements.length && (
                    <p className="mt-2 text-[11px] text-amber-100/60">
                      +{waterfallReview.count - waterfallReview.movements.length} more not shown.
                    </p>
                  )}
                </div>
              )}
            </div>

            {!arApLoading && !mappingLoading && (arApData || mappingRecon) && (
              <div className="space-y-6">
                {arApData && (
                <>
                {/* ─── Lifetime AP/AR + Reconciliation Hero ─── */}
                {lifetimeData && (
                  <div className="bg-gradient-to-br from-indigo-500/10 via-purple-500/8 to-cyan-500/10 border border-indigo-500/25 rounded-xl p-6 mb-2">
                    <h3 className="text-sm font-semibold text-indigo-300 uppercase tracking-wider mb-5">Lifetime Overview</h3>
                    <div className="grid grid-cols-2 gap-6">
                      {/* AR Lifetime */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="w-2 h-2 rounded-full bg-emerald-400" />
                          <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Accounts Receivable</span>
                        </div>
                        <div className="flex items-baseline gap-2">
                          <span className="text-3xl font-bold font-mono text-white">{money(lifetimeData.ar.total)}</span>
                          <span className="text-xs text-gray-500">lifetime invoiced</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="bg-emerald-500/10 rounded-lg px-2 py-2">
                            <div className="text-lg font-bold font-mono text-emerald-400">{money(lifetimeData.ar.paid)}</div>
                            <div className="text-[10px] text-gray-500">Collected</div>
                          </div>
                          <div className="bg-amber-500/10 rounded-lg px-2 py-2">
                            <div className="text-lg font-bold font-mono text-amber-400">{money(lifetimeData.ar.outstanding)}</div>
                            <div className="text-[10px] text-gray-500">Outstanding</div>
                          </div>
                          <div className="bg-cyan-500/10 rounded-lg px-2 py-2">
                            <div className="text-lg font-bold font-mono text-cyan-400">{lifetimeData.ar.reconciled_pct}%</div>
                            <div className="text-[10px] text-gray-500">Reconciled</div>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="flex justify-between text-[10px] text-gray-500">
                            <span>{lifetimeData.ar.invoice_count ?? 0} invoices</span>
                            <span>{lifetimeData.ar.paid_count} paid · {lifetimeData.ar.open_count} open</span>
                          </div>
                          <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden flex">
                            <div className="h-full bg-cyan-500 transition-all" style={{ width: `${lifetimeData.ar.reconciled_pct}%` }} />
                            <div className="h-full bg-cyan-500/20" style={{ width: `${Math.max(0, lifetimeData.ar.paid_pct - lifetimeData.ar.reconciled_pct)}%` }} />
                          </div>
                          <div className="flex justify-between text-[9px]">
                            <span className="text-cyan-400">{money(lifetimeData.ar.reconciled)} reconciled</span>
                            <span className="text-gray-600">{money(lifetimeData.ar.total - lifetimeData.ar.reconciled)} unreconciled</span>
                          </div>
                        </div>
                      </div>

                      {/* AP Lifetime */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="w-2 h-2 rounded-full bg-red-400" />
                          <span className="text-xs font-semibold text-red-400 uppercase tracking-wider">Accounts Payable</span>
                        </div>
                        <div className="flex items-baseline gap-2">
                          <span className="text-3xl font-bold font-mono text-white">{money(lifetimeData.ap.total)}</span>
                          <span className="text-xs text-gray-500">lifetime billed</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="bg-emerald-500/10 rounded-lg px-2 py-2">
                            <div className="text-lg font-bold font-mono text-emerald-400">{money(lifetimeData.ap.paid)}</div>
                            <div className="text-[10px] text-gray-500">Paid</div>
                          </div>
                          <div className="bg-amber-500/10 rounded-lg px-2 py-2">
                            <div className="text-lg font-bold font-mono text-amber-400">{money(lifetimeData.ap.outstanding)}</div>
                            <div className="text-[10px] text-gray-500">Outstanding</div>
                          </div>
                          <div className="bg-cyan-500/10 rounded-lg px-2 py-2">
                            <div className="text-lg font-bold font-mono text-cyan-400">{lifetimeData.ap.reconciled_pct}%</div>
                            <div className="text-[10px] text-gray-500">Reconciled</div>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="flex justify-between text-[10px] text-gray-500">
                            <span>{lifetimeData.ap.bill_count ?? 0} bills</span>
                            <span>{lifetimeData.ap.paid_count} paid · {lifetimeData.ap.open_count} open</span>
                          </div>
                          <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden flex">
                            <div className="h-full bg-cyan-500 transition-all" style={{ width: `${lifetimeData.ap.reconciled_pct}%` }} />
                            <div className="h-full bg-cyan-500/20" style={{ width: `${Math.max(0, lifetimeData.ap.paid_pct - lifetimeData.ap.reconciled_pct)}%` }} />
                          </div>
                          <div className="flex justify-between text-[9px]">
                            <span className="text-cyan-400">{money(lifetimeData.ap.reconciled)} reconciled</span>
                            <span className="text-gray-600">{money(lifetimeData.ap.total - lifetimeData.ap.reconciled)} unreconciled</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Net Position */}
                    <div className="mt-5 pt-4 border-t border-white/10 flex items-center justify-center gap-8">
                      <div className="text-center">
                        <div className="text-2xl font-bold font-mono text-white">{money(lifetimeData.ar.total - lifetimeData.ap.total)}</div>
                        <div className="text-[10px] text-gray-500">Lifetime Net (AR − AP)</div>
                      </div>
                      <div className="h-8 w-px bg-white/10" />
                      <div className="text-center">
                        <div className="text-2xl font-bold font-mono text-white">{money(lifetimeData.ar.outstanding - lifetimeData.ap.outstanding)}</div>
                        <div className="text-[10px] text-gray-500">Net Outstanding</div>
                      </div>
                      <div className="h-8 w-px bg-white/10" />
                      <div className="text-center">
                        <div className={`text-2xl font-bold font-mono ${((lifetimeData.ar.reconciled_pct + lifetimeData.ap.reconciled_pct) / 2) >= 80 ? "text-emerald-400" : ((lifetimeData.ar.reconciled_pct + lifetimeData.ap.reconciled_pct) / 2) >= 50 ? "text-amber-400" : "text-red-400"}`}>
                          {(lifetimeData.ar.total + lifetimeData.ap.total) > 0
                            ? Math.round(((lifetimeData.ar.reconciled + lifetimeData.ap.reconciled) / (lifetimeData.ar.total + lifetimeData.ap.total)) * 100)
                            : 0}%
                        </div>
                        <div className="text-[10px] text-gray-500">Overall Reconciled</div>
                      </div>
                    </div>
                  </div>
                )}

                {/* ─── Current Period Summary bar ─── */}
                {arApData?.ar && arApData?.ap && (
                <div className="flex flex-wrap gap-4 justify-center text-sm mb-4">
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
                )}

                {/* ─── Reconciliation Summary Cards ─── */}
                {arApData?.ar?.reconciliation_summary && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                    <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold text-blue-400">{arApData.ar.reconciliation_summary.total_invoices - arApData.ar.reconciliation_summary.matched_count - arApData.ar.reconciliation_summary.partial_count}</div>
                      <div className="text-xs text-gray-400 mt-1">Open</div>
                      <div className="text-[10px] text-gray-500">{money(arApData.ar.total_outstanding)}</div>
                    </div>
                    <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold text-red-400">{arApData.ar.overdue_count}</div>
                      <div className="text-xs text-gray-400 mt-1">Overdue</div>
                      <div className="text-[10px] text-gray-500">{money(arApData.ar.total_overdue)}</div>
                    </div>
                    <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold text-emerald-400">{(arApData.ar.paid_invoices ?? []).length}</div>
                      <div className="text-xs text-gray-400 mt-1">Paid (180d)</div>
                      <div className="text-[10px] text-gray-500">{money((arApData.ar.paid_invoices ?? []).reduce((s, i) => s + i.amount, 0))}</div>
                    </div>
                    <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold text-cyan-400">{arApData.ar.reconciliation_summary.matched_count}</div>
                      <div className="text-xs text-gray-400 mt-1">Reconciled</div>
                      <div className="text-[10px] text-gray-500">{arApData.ar.reconciliation_summary.match_rate.toFixed(0)}% match rate</div>
                    </div>
                  </div>
                )}

                {/* ─── AR (Accounts Receivable) ─── */}
                {arApData?.ar && (
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
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-20">Bank Match</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-24 text-right">Amount</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {arOverdueFirst.map((inv, i) => {
                            const invExt = inv as OutstandingInvoice & { allocations?: { movement_id: string; gross: number; fee: number; net: number }[]; amount_collected?: number; amount_remaining?: number }
                            const allocs = invExt.allocations ?? []
                            const amountCollected = invExt.matched_amount ?? invExt.amount_collected ?? allocs.reduce((s: number, c: { gross: number }) => s + c.gross, 0)
                            const pct = inv.amount > 0 ? Math.round((amountCollected / inv.amount) * 100) : 0
                            const isExpanded = expandedInvoiceId === inv.invoice_id
                            const reconBadge = () => {
                              if (inv.reconciliation_status === "matched") return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />Matched</span>
                              if (inv.reconciliation_status === "partial") return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">Partial</span>
                              return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-400">Unmatched</span>
                            }
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
                                  <TableCell className="py-2.5">{reconBadge()}</TableCell>
                                  <TableCell className={`text-right font-mono font-semibold py-2.5 ${inv.status === "overdue" ? "text-red-400" : "text-emerald-400"}`}>
                                    {moneySmall(inv.amount)}
                                    {inv.amount_due > 0 && inv.amount_due < inv.amount && <span className="block text-[10px] text-gray-500">due: {moneySmall(inv.amount_due)}</span>}
                                    {amountCollected > 0 && <span className="block text-[10px] text-cyan-400">matched: {moneySmall(amountCollected)}</span>}
                                  </TableCell>
                                </TableRow>
                                {isExpanded && (
                                  <TableRow className="border-emerald-500/5 bg-emerald-500/5">
                                    <TableCell colSpan={6} className="py-3 pl-8">
                                      <div className="space-y-2 text-xs">
                                        <div className="flex gap-4">
                                          <span>Invoice Total: {moneySmall(inv.amount)}</span>
                                          {inv.amount_due > 0 && <span className="text-amber-400">Outstanding: {moneySmall(inv.amount_due)}</span>}
                                          {amountCollected > 0 && <span className="text-cyan-400">Bank Matched: {moneySmall(amountCollected)}</span>}
                                        </div>
                                        {amountCollected > 0 && (
                                          <>
                                            <div className="w-48 h-1.5 bg-white/10 rounded-full overflow-hidden">
                                              <div className="h-full bg-cyan-500 rounded-full" style={{ width: `${Math.min(100, pct)}%` }} />
                                            </div>
                                            <div className="text-gray-500">{pct}% reconciled to bank</div>
                                          </>
                                        )}
                                        {inv.matched_movement_ids && inv.matched_movement_ids.length > 0 && (
                                          <div className="text-gray-500">
                                            Linked to {inv.matched_movement_ids.length} bank transaction{inv.matched_movement_ids.length !== 1 ? "s" : ""}
                                          </div>
                                        )}
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
                )}

                {/* ─── AP (Accounts Payable) ─── */}
                {arApData?.ap && (
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
                          <div className="text-xl font-bold text-white">{(arApData.ap.bills ?? []).length + (arApData.ap.paid_bills ?? []).length}</div>
                          <div className="text-[10px] text-gray-500">Total Bills</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* AP Summary Cards */}
                  {arApData?.ap?.reconciliation_summary && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 border-b border-red-500/10">
                      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-center">
                        <div className="text-xl font-bold text-blue-400">{(arApData.ap.bills ?? []).filter(b => b.status === "open").length}</div>
                        <div className="text-[10px] text-gray-400 mt-1">Open</div>
                      </div>
                      <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-center">
                        <div className="text-xl font-bold text-red-400">{(arApData.ap.bills ?? []).filter(b => b.status === "overdue").length}</div>
                        <div className="text-[10px] text-gray-400 mt-1">Overdue</div>
                      </div>
                      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 text-center">
                        <div className="text-xl font-bold text-emerald-400">{(arApData.ap.paid_bills ?? []).length}</div>
                        <div className="text-[10px] text-gray-400 mt-1">Paid (180d)</div>
                      </div>
                      <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg p-3 text-center">
                        <div className="text-xl font-bold text-cyan-400">{arApData.ap.reconciliation_summary.matched_count}</div>
                        <div className="text-[10px] text-gray-400 mt-1">Reconciled</div>
                        <div className="text-[9px] text-gray-500">{arApData.ap.reconciliation_summary.match_rate.toFixed(0)}% rate</div>
                      </div>
                    </div>
                  )}

                  {(arApData.ap.bills ?? []).length > 0 ? (
                    <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-red-500/10 hover:bg-transparent sticky top-0 bg-red-500/10 backdrop-blur-sm z-10">
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold">Vendor</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-16">Source</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-24">Due date</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-20">Status</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-20">Bank Match</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 font-semibold w-24 text-right">Amount</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[...(arApData.ap.bills ?? [])].sort((a, b) => (b.days_overdue ?? 0) - (a.days_overdue ?? 0)).map((bill, i) => {
                            const matchedAmount = bill.matched_amount ?? 0
                            const pct = bill.amount > 0 ? Math.round((matchedAmount / bill.amount) * 100) : 0
                            const isExpanded = expandedObligationId === bill.bill_id
                            const apStatusBadge = (status: string, daysOverdue: number | null) => {
                              if (status === "paid") return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">Paid</span>
                              if (status === "overdue" || (daysOverdue != null && daysOverdue > 0))
                                return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">Overdue</span>
                              if (status === "partially_paid") return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">Partial</span>
                              return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">Open</span>
                            }
                            const apReconBadge = () => {
                              if (bill.reconciliation_status === "matched") return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />Matched</span>
                              if (bill.reconciliation_status === "partial") return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">Partial</span>
                              return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-400">Unmatched</span>
                            }
                            return (
                              <Fragment key={`${bill.bill_id}-${i}`}>
                                <TableRow
                                  className="border-red-500/5 hover:bg-red-500/5 cursor-pointer"
                                  onClick={() => setExpandedObligationId(isExpanded ? null : bill.bill_id)}
                                >
                                  <TableCell className="text-sm text-white font-medium py-2.5">{bill.vendor_name}</TableCell>
                                  <TableCell className="py-2.5">{sourceBadge(bill.source)}</TableCell>
                                  <TableCell className="text-xs text-gray-400 py-2.5">
                                    {bill.due_date ?? "—"}
                                    {bill.days_overdue != null && bill.days_overdue > 0 && (
                                      <span className="block text-red-400 font-medium">{bill.days_overdue}d overdue</span>
                                    )}
                                  </TableCell>
                                  <TableCell className="py-2.5">{apStatusBadge(bill.status, bill.days_overdue ?? null)}</TableCell>
                                  <TableCell className="py-2.5">{apReconBadge()}</TableCell>
                                  <TableCell className={`text-right font-mono font-semibold py-2.5 ${bill.status === "overdue" ? "text-red-400" : "text-red-400"}`}>
                                    {moneySmall(bill.amount)}
                                    {bill.amount_due > 0 && bill.amount_due < bill.amount && <span className="block text-[10px] text-gray-500">due: {moneySmall(bill.amount_due)}</span>}
                                    {matchedAmount > 0 && <span className="block text-[10px] text-cyan-400">matched: {moneySmall(matchedAmount)}</span>}
                                  </TableCell>
                                </TableRow>
                                {isExpanded && (
                                  <TableRow className="border-red-500/5 bg-red-500/5">
                                    <TableCell colSpan={6} className="py-3 pl-8">
                                      <div className="space-y-2 text-xs">
                                        <div className="flex gap-4">
                                          <span>Bill Total: {moneySmall(bill.amount)}</span>
                                          {bill.amount_due > 0 && <span className="text-amber-400">Outstanding: {moneySmall(bill.amount_due)}</span>}
                                          {matchedAmount > 0 && <span className="text-cyan-400">Bank Matched: {moneySmall(matchedAmount)}</span>}
                                        </div>
                                        {matchedAmount > 0 && (
                                          <>
                                            <div className="w-48 h-1.5 bg-white/10 rounded-full overflow-hidden">
                                              <div className="h-full bg-cyan-500 rounded-full" style={{ width: `${Math.min(100, pct)}%` }} />
                                            </div>
                                            <div className="text-gray-500">{pct}% reconciled to bank</div>
                                          </>
                                        )}
                                        {bill.matched_movement_ids && bill.matched_movement_ids.length > 0 && (
                                          <div className="text-gray-500">
                                            Linked to {bill.matched_movement_ids.length} bank transaction{bill.matched_movement_ids.length !== 1 ? "s" : ""}
                                          </div>
                                        )}
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                )}
                              </Fragment>
                            )
                          })}
                        </TableBody>
                      </Table>
                      {(arApData.ap.bills ?? []).length > 0 && (
                        <div className="p-3 border-t border-red-500/10 text-center">
                          <span className="text-[11px] text-gray-500">{(arApData.ap.bills ?? []).length} bill{(arApData.ap.bills ?? []).length !== 1 ? "s" : ""} outstanding</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-8 text-center text-gray-500 text-sm">No outstanding bills.</div>
                  )}
                </div>
                )}

                {/* ─── Reconciliation Summary Dashboard ─── */}
                {(arApData?.ar?.reconciliation_summary || arApData?.ap?.reconciliation_summary) && mappingRecon && (
                  <div className="bg-gradient-to-br from-cyan-500/10 to-blue-500/10 border border-cyan-500/20 rounded-xl p-5">
                    <h3 className="text-base font-semibold text-cyan-400 mb-4 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-cyan-400" />
                      Reconciliation Overview
                    </h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                      <div className="text-center">
                        <div className="text-3xl font-bold text-cyan-400">{arApData.ar.reconciliation_summary?.match_rate.toFixed(0) ?? 0}%</div>
                        <div className="text-xs text-gray-400 mt-1">AR Match Rate</div>
                      </div>
                      <div className="text-center">
                        <div className="text-3xl font-bold text-emerald-400">{money(arApData.ar.reconciliation_summary?.matched_amount ?? 0)}</div>
                        <div className="text-xs text-gray-400 mt-1">AR Matched</div>
                      </div>
                      <div className="text-center">
                        <div className="text-3xl font-bold text-red-400">{arApData.ap.reconciliation_summary?.match_rate.toFixed(0) ?? 0}%</div>
                        <div className="text-xs text-gray-400 mt-1">AP Match Rate</div>
                      </div>
                      <div className="text-center">
                        <div className="text-3xl font-bold text-red-400">{money(arApData.ap.reconciliation_summary?.matched_amount ?? 0)}</div>
                        <div className="text-xs text-gray-400 mt-1">AP Matched</div>
                      </div>
                    </div>

                    {/* Bank-Verified Outstanding */}
                    {(arApData?.ar?.reconciliation_summary?.accounting_outstanding !== undefined || arApData?.ap?.reconciliation_summary?.accounting_outstanding !== undefined) && (
                      <div className="grid grid-cols-2 gap-4 mb-4 pt-4 border-t border-white/10">
                        <div className="bg-white/5 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-2">AR Outstanding</div>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-gray-400">Accounting:</span>
                            <span className="text-white">{money(arApData.ar.reconciliation_summary?.accounting_outstanding ?? 0)}</span>
                          </div>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-gray-400">Bank-Verified:</span>
                            <span className="text-emerald-400">{money(arApData.ar.reconciliation_summary?.bank_verified_outstanding ?? 0)}</span>
                          </div>
                          {(arApData.ar.reconciliation_summary?.suspicious_count ?? 0) > 0 && (
                            <div className="flex justify-between text-sm mt-2 pt-2 border-t border-white/10">
                              <span className="text-amber-400">Suspicious:</span>
                              <span className="text-amber-400">{arApData.ar.reconciliation_summary?.suspicious_count} ({money(arApData.ar.reconciliation_summary?.suspicious_amount ?? 0)})</span>
                            </div>
                          )}
                        </div>
                        <div className="bg-white/5 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-2">AP Outstanding</div>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-gray-400">Accounting:</span>
                            <span className="text-white">{money(arApData.ap.reconciliation_summary?.accounting_outstanding ?? 0)}</span>
                          </div>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-gray-400">Bank-Verified:</span>
                            <span className="text-emerald-400">{money(arApData.ap.reconciliation_summary?.bank_verified_outstanding ?? 0)}</span>
                          </div>
                          {(arApData.ap.reconciliation_summary?.suspicious_count ?? 0) > 0 && (
                            <div className="flex justify-between text-sm mt-2 pt-2 border-t border-white/10">
                              <span className="text-amber-400">Suspicious:</span>
                              <span className="text-amber-400">{arApData.ap.reconciliation_summary?.suspicious_count} ({money(arApData.ap.reconciliation_summary?.suspicious_amount ?? 0)})</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-white/5 rounded-lg p-3">
                        <div className="text-xs text-gray-400 mb-2">Bank Inflows (AR)</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-cyan-300">Matched: {money(mappingRecon.total_matched_inflows)}</span>
                          <span className="text-gray-400">Unmatched: {money(mappingRecon.total_unmatched_inflows)}</span>
                        </div>
                      </div>
                      <div className="bg-white/5 rounded-lg p-3">
                        <div className="text-xs text-gray-400 mb-2">Bank Outflows (AP)</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-cyan-300">Matched: {money(mappingRecon.total_matched_outflows)}</span>
                          <span className="text-gray-400">Unmatched: {money(mappingRecon.total_unmatched_outflows)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-4 pt-4 border-t border-white/10 text-center">
                      <span className="text-purple-400 font-semibold">{money(mappingRecon.total_fees_paid)}</span>
                      <span className="text-xs text-gray-400 ml-2">Total Fees Identified</span>
                    </div>
                  </div>
                )}

                {/* ─── Excluded Categories (Non-AR/AP Movements) ─── */}
                {excludedCategories && excludedCategories.totals && (
                  <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-white/10">
                      <h3 className="text-base font-semibold text-white">Excluded from AR/AP Reconciliation</h3>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        These movements are classified as non-AR/AP and excluded from invoice/bill matching.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4">
                      <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-3 text-center">
                        <div className="text-xl font-bold text-purple-400">{excludedCategories.totals.transfers_count}</div>
                        <div className="text-[10px] text-gray-400 mt-1">Transfers</div>
                        <div className="text-[9px] text-gray-500">{money(excludedCategories.totals.transfers_amount)}</div>
                      </div>
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-center">
                        <div className="text-xl font-bold text-amber-400">{excludedCategories.totals.owner_activity_count}</div>
                        <div className="text-[10px] text-gray-400 mt-1">Owner Activity</div>
                        <div className="text-[9px] text-gray-500">{money(excludedCategories.totals.owner_activity_amount)}</div>
                      </div>
                      <div className="bg-gray-500/10 border border-gray-500/20 rounded-lg p-3 text-center">
                        <div className="text-xl font-bold text-gray-400">{excludedCategories.totals.fees_and_interest_count}</div>
                        <div className="text-[10px] text-gray-400 mt-1">Fees & Interest</div>
                        <div className="text-[9px] text-gray-500">{money(excludedCategories.totals.fees_and_interest_amount)}</div>
                      </div>
                      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-center">
                        <div className="text-xl font-bold text-blue-400">{excludedCategories.totals.processor_settlements_count}</div>
                        <div className="text-[10px] text-gray-400 mt-1">Processor Settlements</div>
                        <div className="text-[9px] text-gray-500">{money(excludedCategories.totals.processor_settlements_amount)}</div>
                      </div>
                    </div>
                  </div>
                )}

                {/* ─── Transfer Pairs (Netted Internal Transfers) ─── */}
                {transferPairs && (transferPairs.pairs.length > 0 || transferPairs.unpaired_transfers.length > 0) && (
                  <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-white/10">
                      <h3 className="text-base font-semibold text-white">Internal Transfers</h3>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        Matched transfer pairs (outflow + inflow within 3 days, same amount) net to zero.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4">
                      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 text-center">
                        <div className="text-xl font-bold text-emerald-400">{transferPairs.pairs.length}</div>
                        <div className="text-[10px] text-gray-400 mt-1">Matched Pairs</div>
                        <div className="text-[9px] text-gray-500">{money(transferPairs.total_paired_amount)} (nets to $0)</div>
                      </div>
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-center">
                        <div className="text-xl font-bold text-amber-400">{transferPairs.unpaired_transfers.length}</div>
                        <div className="text-[10px] text-gray-400 mt-1">Unpaired Transfers</div>
                        <div className="text-[9px] text-gray-500">{money(transferPairs.total_unpaired_amount)}</div>
                      </div>
                    </div>
                    {transferPairs.pairs.length > 0 && (
                      <div className="px-4 pb-4">
                        <div className="text-[10px] text-gray-400 mb-2">Recent Matched Pairs</div>
                        <div className="space-y-2 max-h-40 overflow-y-auto">
                          {transferPairs.pairs.slice(0, 5).map((pair, idx) => (
                            <div key={idx} className="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2 text-[11px]">
                              <div className="flex items-center gap-2">
                                <span className="text-red-400">OUT</span>
                                <span className="text-gray-400">→</span>
                                <span className="text-emerald-400">IN</span>
                                <span className="text-gray-500">({pair.days_apart}d apart)</span>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="text-gray-400">{pair.counterparty ?? "Internal"}</span>
                                <span className="text-white font-medium">{money(pair.amount)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ─── Bank transactions: reconciled vs not reconciled (AR/AP) ─── */}
                {mappingRecon && (
                  <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-white/10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between gap-y-2">
                      <div>
                        <h3 className="text-base font-semibold text-white">Bank transaction reconciliation</h3>
                        <p className="text-[11px] text-gray-500 mt-0.5">
                          Reconciled = linked to an AR (deposit) or AP (payment) line. Not reconciled = still needs an invoice/bill match.
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void runArApReconciliation()}
                          disabled={reconRefreshLoading}
                          className="text-[11px] font-medium px-3 py-1.5 rounded-md border border-cyan-500/45 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {reconRefreshLoading ? "…" : "Reconcile"}
                        </button>
                        <span className="text-[10px] text-gray-500 mr-1">Show:</span>
                        {(["all", "reconciled", "unreconciled"] as const).map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setReconTxFilter(f)}
                            className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                              reconTxFilter === f
                                ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-200"
                                : "bg-white/5 border-white/10 text-gray-400 hover:border-white/20"
                            }`}
                          >
                            {f === "all" ? "All" : f === "reconciled" ? "Reconciled" : "Not reconciled"}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="px-4 py-2 flex flex-wrap gap-4 text-[11px] border-b border-white/5 bg-white/[0.02]">
                      <span>
                        <span className="text-emerald-400 font-semibold">{reconReconciledCount}</span>
                        <span className="text-gray-500"> reconciled</span>
                      </span>
                      <span>
                        <span className="text-amber-400 font-semibold">{reconUnreconciledCount}</span>
                        <span className="text-gray-500"> not reconciled</span>
                      </span>
                    </div>
                    <div className="max-h-[min(70vh,900px)] overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-white/10 hover:bg-transparent bg-white/5 sticky top-0 z-10 backdrop-blur-sm">
                            <TableHead className="text-[10px] uppercase text-gray-500 w-28">Status</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500">Payment</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 w-24">Gross</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 w-20">Fee</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500 w-24">Net</TableHead>
                            <TableHead className="text-[10px] uppercase text-gray-500">Linked AR/AP</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {allReconRows.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={6} className="py-8 text-center text-sm text-gray-500">
                                {allReconRowsRaw.length === 0
                                  ? "No bank movements yet. Sync your bank, then run reconciliation."
                                  : "No transactions match this filter."}
                              </TableCell>
                            </TableRow>
                          ) : (
                            allReconRows.map((r) => {
                              // Only sum AR/AP allocations for gross/net - exclude fee allocations
                              const arApAllocations = (r.allocations ?? []).filter((a: { entity_type?: string }) => 
                                a.entity_type === "ar" || a.entity_type === "ap" || a.entity_type === "settlement"
                              )
                              // Gross/Net from AR/AP allocations only
                              const totalGross = arApAllocations.reduce((s: number, a: { gross: number }) => s + a.gross, 0)
                              const totalNet = arApAllocations.reduce((s: number, a: { net: number }) => s + a.net, 0)
                              // Fee is simply the difference between gross and net
                              // This avoids double-counting from separate fee allocations
                              const totalFee = Math.max(0, totalGross - totalNet)
                              const linked = (r.allocations ?? []).length > 0
                                ? (r.allocations ?? [])
                                    .map((a: { entity_type?: string; entity_id?: string }) => {
                                      const t = (a.entity_type ?? "?").toUpperCase()
                                      const id = (a.entity_id ?? "").slice(0, 14)
                                      return id ? `${t}: ${id}${(a.entity_id ?? "").length > 14 ? "…" : ""}` : t
                                    })
                                    .join(", ")
                                : "—"
                              const isReconciled = (r as { reconciled?: boolean }).reconciled === true
                              return (
                                <TableRow
                                  key={r.movement_id}
                                  className={`border-white/5 ${!isReconciled ? "bg-amber-500/5" : ""}`}
                                >
                                  <TableCell className="py-2">
                                    {isReconciled ? (
                                      <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 whitespace-nowrap">
                                        Reconciled
                                      </span>
                                    ) : (
                                      <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-amber-500/20 text-amber-200 whitespace-nowrap">
                                        Not reconciled
                                      </span>
                                    )}
                                  </TableCell>
                                  <TableCell className="py-2">
                                    <span className={r.direction === "inflow" ? "text-emerald-400" : "text-red-400"}>
                                      {r.direction === "inflow" ? "+" : "-"}{money2(r.amount)}
                                    </span>
                                    <span className="text-gray-500 text-xs block">{(r as { date?: string }).date} · {(r as { display_name?: string | null }).display_name ?? r.counterparty ?? "—"}</span>
                                  </TableCell>
                                  <TableCell className="py-2 font-mono text-sm">{totalGross > 0 ? money2(totalGross) : money2(r.amount)}</TableCell>
                                  <TableCell className="py-2 font-mono text-amber-400 text-sm">{totalFee > 0 ? money2(totalFee) : "—"}</TableCell>
                                  <TableCell className="py-2 font-mono text-sm">{totalNet > 0 ? money2(totalNet) : money2(r.amount)}</TableCell>
                                  <TableCell className="py-2 text-xs text-gray-400 truncate max-w-[200px]" title={linked}>
                                    {linked}
                                  </TableCell>
                                </TableRow>
                              )
                            })
                          )}
                        </TableBody>
                      </Table>
                    </div>
                    <div className="px-4 py-2 border-t border-white/10 text-xs text-gray-500 text-center">
                      Showing {allReconRows.length} of {allReconRowsRaw.length} bank transaction{allReconRowsRaw.length !== 1 ? "s" : ""}
                    </div>
                  </div>
                )}

                </>
                )}

              </div>
            )}
          </div>
        )
      }

      case 12: {
        const money = (n: number | string | null | undefined) => {
          const num = typeof n === "string" ? parseFloat(n) : n
          if (num == null || isNaN(num)) return "$0"
          if (Math.abs(num) >= 1000000) return `$${(num / 1000000).toFixed(1)}M`
          if (Math.abs(num) >= 1000) return `$${(num / 1000).toFixed(1)}K`
          return `$${num.toFixed(0)}`
        }
        const archetypeLabel = (a: string | null) => {
          const labels: Record<string, string> = { clockwork: "Clockwork", slow_reliable: "Reliable", bursty: "Bursty", volatile: "Volatile", low_data: "New" }
          return a ? labels[a] || a : "—"
        }
        const archetypeColor = (a: string | null) => {
          const colors: Record<string, string> = { clockwork: "text-emerald-400 bg-emerald-500/10", slow_reliable: "text-blue-400 bg-blue-500/10", bursty: "text-amber-400 bg-amber-500/10", volatile: "text-red-400 bg-red-500/10", low_data: "text-gray-400 bg-gray-500/10" }
          return a ? colors[a] || "text-gray-400 bg-gray-500/10" : "text-gray-400 bg-gray-500/10"
        }
        const customers = entityProfiles.filter(e => e.entity_type === "customer").slice(0, 5)
        const vendors = entityProfiles.filter(e => e.entity_type === "vendor").slice(0, 5)

        return (
          <div className="space-y-6">
            <div className="text-center mb-2">
              <h2 className="text-2xl font-semibold text-white mb-1">{steps[11].title}</h2>
              <p className="text-gray-400 text-lg mb-5">{steps[11].description}</p>

              {entityProfilesLoading && (
                <div className="flex items-center justify-center gap-2 py-6 text-gray-400">
                  <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Loading entity profiles…
                </div>
              )}

              {entityProfilesError && !entityProfilesLoading && (
                <p className="text-red-300 text-sm mb-4">Failed: {entityProfilesError}</p>
              )}
            </div>

            {!entityProfilesLoading && entityProfilesSummary && (
              <div className="space-y-6">
                {/* Summary Stats */}
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-emerald-400">{entityProfilesSummary.total_customers}</div>
                    <div className="text-xs text-gray-400 mt-1">Customers</div>
                  </div>
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-blue-400">{entityProfilesSummary.total_vendors}</div>
                    <div className="text-xs text-gray-400 mt-1">Vendors</div>
                  </div>
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-white">{money(entityProfilesSummary.total_lifetime_value)}</div>
                    <div className="text-xs text-gray-400 mt-1">Lifetime Value</div>
                  </div>
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-amber-400">{entityProfilesSummary.at_risk_count}</div>
                    <div className="text-xs text-gray-400 mt-1">At Risk</div>
                  </div>
                </div>

                {/* Top Customers */}
                {customers.length > 0 && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                    <div className="text-xs uppercase tracking-wider text-gray-400 mb-3">Top Customers</div>
                    <div className="space-y-2">
                      {customers.map((e) => (
                        <div key={e.id} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                          <div className="flex items-center gap-3">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full ${archetypeColor(e.archetype)}`}>{archetypeLabel(e.archetype)}</span>
                            <span className="text-sm text-white truncate max-w-[200px]">{e.display_name || e.canonical_name}</span>
                          </div>
                          <div className="flex items-center gap-4 text-xs">
                            <span className="text-gray-400">{e.transaction_count} txns</span>
                            <span className="text-emerald-400 font-medium">{money(e.lifetime_value)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Top Vendors */}
                {vendors.length > 0 && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                    <div className="text-xs uppercase tracking-wider text-gray-400 mb-3">Top Vendors</div>
                    <div className="space-y-2">
                      {vendors.map((e) => (
                        <div key={e.id} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                          <div className="flex items-center gap-3">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full ${archetypeColor(e.archetype)}`}>{archetypeLabel(e.archetype)}</span>
                            <span className="text-sm text-white truncate max-w-[200px]">{e.display_name || e.canonical_name}</span>
                          </div>
                          <div className="flex items-center gap-4 text-xs">
                            <span className="text-gray-400">{e.transaction_count} txns</span>
                            <span className="text-blue-400 font-medium">{money(e.lifetime_value)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* View All Link */}
                <div className="text-center">
                  <a
                    href="/entities"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
                  >
                    View all {entityProfiles.length} entities →
                  </a>
                </div>
              </div>
            )}
          </div>
        )
      }

      case 13: {
        const money = (n: number | string | null | undefined) => {
          const num = typeof n === "string" ? parseFloat(n) : n
          if (num == null || isNaN(num)) return "$0"
          if (Math.abs(num) >= 1000000) return `$${(num / 1000000).toFixed(1)}M`
          if (Math.abs(num) >= 1000) return `$${(num / 1000).toFixed(1)}K`
          return `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        }
        const signedMoney = (n: number | string | null | undefined) => {
          const num = typeof n === "string" ? parseFloat(n) : n
          if (num == null || isNaN(num)) return "$0"
          const prefix = num >= 0 ? "+" : ""
          if (Math.abs(num) >= 1000000) return `${prefix}$${(Math.abs(num) / 1000000).toFixed(1)}M`
          if (Math.abs(num) >= 1000) return `${prefix}$${(Math.abs(num) / 1000).toFixed(1)}K`
          return `${prefix}$${Math.abs(num).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        }
        const pct = (n: number | null | undefined) => n != null ? `${Math.round(n)}%` : "—"
        const riskColor = (level: string) => level === "high" ? "text-red-400" : level === "medium" ? "text-amber-400" : "text-emerald-400"
        const riskBg = (level: string) => level === "high" ? "bg-red-500/10 border-red-500/20" : level === "medium" ? "bg-amber-500/10 border-amber-500/20" : "bg-emerald-500/10 border-emerald-500/20"
        const riskBarColor = (level: string) => level === "high" ? "bg-red-400" : level === "medium" ? "bg-amber-400" : "bg-emerald-400"
        const confColor = (c: number) => c >= 90 ? "text-emerald-400" : c >= 70 ? "text-amber-400" : "text-red-400"
        const regimeColor = (r: string) => r === "strong" ? "text-emerald-400" : r === "stable" ? "text-blue-400" : "text-amber-400"
        const regimeBg = (r: string) => r === "strong" ? "bg-emerald-500/10" : r === "stable" ? "bg-blue-500/10" : "bg-amber-500/10"

        return (
          <div className="space-y-6">
            <div className="text-center mb-2">
              <h2 className="text-2xl font-semibold text-white mb-1">{steps[12].title}</h2>
              <p className="text-gray-400 text-lg mb-5">{steps[12].description}</p>

              {stateLoading && (
                <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
                  <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Computing business state…
                </div>
              )}

              {stateError && !stateLoading && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 max-w-md mx-auto">
                  <p className="text-red-300 text-sm">{stateError}</p>
                </div>
              )}
            </div>

            {!stateLoading && stateData && (
              <div className="space-y-6">
                {/* ─── NEW: Period Context ─── */}
                <div className="flex items-center justify-center gap-4 text-xs text-gray-500 flex-wrap">
                  {stateData.revenue.period_start && stateData.revenue.period_end && (
                    <span>
                      Period: {new Date(stateData.revenue.period_start).toLocaleDateString("en-US", { month: "short", day: "numeric" })} – {new Date(stateData.revenue.period_end).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      {stateData.liquidity.period_days > 0 && <span className="text-gray-600"> ({stateData.liquidity.period_days} days)</span>}
                    </span>
                  )}
                  {stateData.computed_at && (
                    <span className="text-gray-600">
                      Updated: {new Date(stateData.computed_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </span>
                  )}
                </div>

                {/* ─── AI Summary Block ─── */}
                {stateData.insight_block && (
                  <div className="bg-gradient-to-br from-emerald-500/10 via-blue-500/5 to-purple-500/10 border border-white/10 rounded-2xl p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      <span className="text-xs uppercase tracking-wider text-emerald-400/80 font-medium">AI Summary</span>
                    </div>
                    <p className="text-sm text-gray-200 leading-relaxed">{stateData.insight_block}</p>
                  </div>
                )}

                {/* ─── Key Metrics Overview ─── */}
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center hover:bg-white/[0.07] transition-colors">
                    <div className="text-2xl font-bold text-emerald-400">{money(stateData.revenue.net_revenue)}</div>
                    <div className="text-xs text-gray-400 mt-1">Net Revenue</div>
                  </div>
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center hover:bg-white/[0.07] transition-colors">
                    <div className="text-2xl font-bold text-amber-400">{money(stateData.spend.total_spend)}</div>
                    <div className="text-xs text-gray-400 mt-1">Total Spend</div>
                  </div>
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center hover:bg-white/[0.07] transition-colors">
                    <div className="text-2xl font-bold text-blue-400">{money(stateData.liquidity.ending_cash)}</div>
                    <div className="text-xs text-gray-400 mt-1">Cash Position</div>
                  </div>
                  <div className={`border rounded-xl p-4 text-center hover:opacity-90 transition-opacity ${riskBg(stateData.risk.overall)}`}>
                    <div className={`text-2xl font-bold ${riskColor(stateData.risk.overall)}`}>{stateData.risk.overall.toUpperCase()}</div>
                    <div className="text-xs text-gray-400 mt-1">Risk Level</div>
                  </div>
                </div>

                {/* ─── NEW: Data Health Bar ─── */}
                {(() => {
                  const arMatchRate = step13ArAp?.ar?.reconciliation_summary?.match_rate ?? 0
                  const apMatchRate = step13ArAp?.ap?.reconciliation_summary?.match_rate ?? 0
                  const reconHealth = step13ArAp ? Math.round((arMatchRate + apMatchRate) / 2) : null
                  
                  const movementStats = step13Movements?.summaryFromTags
                  const totalMovements = movementStats ? (movementStats.tagged_count + movementStats.unresolved_count) : (step13Movements?.movements?.length ?? 0)
                  const taggedPct = movementStats && totalMovements > 0 ? Math.round((movementStats.tagged_count / totalMovements) * 100) : null
                  const anomalyPct = movementStats && totalMovements > 0 ? Math.round(((totalMovements - (movementStats.anomaly_count ?? 0)) / totalMovements) * 100) : 100
                  const movementHealth = taggedPct !== null ? Math.round((taggedPct + anomalyPct) / 2) : null
                  
                  const entityCount = step13Entities?.summary?.total_entities ?? 0
                  const atRiskCount = step13Entities?.summary?.at_risk_count ?? 0
                  const entityHealth = entityCount > 0 ? Math.round(((entityCount - atRiskCount) / entityCount) * 100) : null
                  
                  const healthColor = (h: number | null) => h === null ? "text-gray-500" : h >= 80 ? "text-emerald-400" : h >= 60 ? "text-amber-400" : "text-red-400"
                  const healthBg = (h: number | null) => h === null ? "bg-gray-500/20" : h >= 80 ? "bg-emerald-500/20" : h >= 60 ? "bg-amber-500/20" : "bg-red-500/20"
                  const healthBarColor = (h: number | null) => h === null ? "bg-gray-500" : h >= 80 ? "bg-emerald-400" : h >= 60 ? "bg-amber-400" : "bg-red-400"
                  
                  return (
                    <div className="bg-gradient-to-r from-white/[0.03] to-white/[0.06] border border-white/10 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs uppercase tracking-wider text-gray-400 font-medium">Data Health</span>
                        {step13DataLoading && <div className="h-3 w-3 rounded-full border border-white/30 border-t-white animate-spin" />}
                      </div>
                      <div className="grid grid-cols-3 gap-4">
                        <div className="text-center">
                          <div className="relative w-full h-2 bg-white/10 rounded-full overflow-hidden mb-2">
                            <div className={`absolute left-0 top-0 h-full rounded-full transition-all ${healthBarColor(reconHealth)}`} style={{ width: `${reconHealth ?? 0}%` }} />
                          </div>
                          <div className={`text-lg font-bold ${healthColor(reconHealth)}`}>{reconHealth !== null ? `${reconHealth}%` : "—"}</div>
                          <div className="text-[10px] text-gray-500">Reconciliation</div>
                        </div>
                        <div className="text-center">
                          <div className="relative w-full h-2 bg-white/10 rounded-full overflow-hidden mb-2">
                            <div className={`absolute left-0 top-0 h-full rounded-full transition-all ${healthBarColor(movementHealth)}`} style={{ width: `${movementHealth ?? 0}%` }} />
                          </div>
                          <div className={`text-lg font-bold ${healthColor(movementHealth)}`}>{movementHealth !== null ? `${movementHealth}%` : "—"}</div>
                          <div className="text-[10px] text-gray-500">Movements</div>
                        </div>
                        <div className="text-center">
                          <div className="relative w-full h-2 bg-white/10 rounded-full overflow-hidden mb-2">
                            <div className={`absolute left-0 top-0 h-full rounded-full transition-all ${healthBarColor(entityHealth)}`} style={{ width: `${entityHealth ?? 0}%` }} />
                          </div>
                          <div className={`text-lg font-bold ${healthColor(entityHealth)}`}>{entityHealth !== null ? `${entityHealth}%` : "—"}</div>
                          <div className="text-[10px] text-gray-500">Entities</div>
                        </div>
                      </div>
                    </div>
                  )
                })()}

                {/* ─── Confidence Indicators ─── */}
                <div className="flex items-center justify-center gap-8 py-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${stateData.state_confidence.revenue_confidence >= 90 ? "bg-emerald-400" : stateData.state_confidence.revenue_confidence >= 70 ? "bg-amber-400" : "bg-red-400"}`} />
                    <span className="text-xs text-gray-500">Revenue</span>
                    <span className={`text-xs font-semibold ${confColor(stateData.state_confidence.revenue_confidence)}`}>{pct(stateData.state_confidence.revenue_confidence)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${stateData.state_confidence.spend_confidence >= 90 ? "bg-emerald-400" : stateData.state_confidence.spend_confidence >= 70 ? "bg-amber-400" : "bg-red-400"}`} />
                    <span className="text-xs text-gray-500">Spend</span>
                    <span className={`text-xs font-semibold ${confColor(stateData.state_confidence.spend_confidence)}`}>{pct(stateData.state_confidence.spend_confidence)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${stateData.state_confidence.liquidity_confidence >= 90 ? "bg-emerald-400" : stateData.state_confidence.liquidity_confidence >= 70 ? "bg-amber-400" : "bg-red-400"}`} />
                    <span className="text-xs text-gray-500">Liquidity</span>
                    <span className={`text-xs font-semibold ${confColor(stateData.state_confidence.liquidity_confidence)}`}>{pct(stateData.state_confidence.liquidity_confidence)}</span>
                  </div>
                </div>

                {/* ─── Risk Breakdown ─── */}
                <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Risk Analysis</h3>
                    <div className={`text-xs font-bold px-3 py-1 rounded-full border ${riskBg(stateData.risk.overall)} ${riskColor(stateData.risk.overall)}`}>
                      Score: {stateData.risk.overall_score}/100
                    </div>
                  </div>
                  <div className="grid grid-cols-5 gap-3">
                    {(["liquidity_risk", "concentration_risk", "dependency_risk", "anomaly_risk", "uncertainty_risk"] as const).map((key) => {
                      const dim = stateData.risk[key]
                      const label = key.replace(/_risk$/, "").charAt(0).toUpperCase() + key.replace(/_risk$/, "").slice(1)
                      return (
                        <div key={key} className="text-center">
                          <div className="relative w-full h-1.5 bg-white/10 rounded-full overflow-hidden mb-2">
                            <div className={`absolute left-0 top-0 h-full rounded-full transition-all ${riskBarColor(dim.level)}`} style={{ width: `${Math.min(dim.score, 100)}%` }} />
                          </div>
                          <div className={`text-xs font-semibold ${riskColor(dim.level)}`}>{dim.level.toUpperCase()}</div>
                          <div className="text-[10px] text-gray-500 mt-0.5">{label}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* ─── Revenue & Spend Side by Side ─── */}
                <div className="grid grid-cols-2 gap-4">
                  {/* Revenue Card */}
                  <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider">Revenue</h3>
                      <span className="text-xs text-gray-500">{stateData.revenue.customer_count} customers</span>
                    </div>
                    <div className="text-3xl font-bold text-white mb-3">{money(stateData.revenue.net_revenue)}</div>
                    <div className="text-xs text-gray-500 mb-4">
                      Gross {money(stateData.revenue.gross_revenue)} − Contra {money(stateData.revenue.contra_revenue)}
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="bg-white/5 rounded-lg p-2">
                        <div className="text-sm font-semibold text-white">{money(stateData.revenue.avg_receipt)}</div>
                        <div className="text-[10px] text-gray-500">Avg Receipt</div>
                      </div>
                      <div className="bg-white/5 rounded-lg p-2">
                        <div className="text-sm font-semibold text-white">{pct(stateData.revenue.top_customer_pct)}</div>
                        <div className="text-[10px] text-gray-500">Top Customer</div>
                      </div>
                      <div className="bg-white/5 rounded-lg p-2">
                        <div className="text-sm font-semibold text-white">{pct(stateData.revenue.repeat_revenue_ratio * 100)}</div>
                        <div className="text-[10px] text-gray-500">Repeat Rev</div>
                      </div>
                    </div>
                    {stateData.revenue.revenue_by_customer.length > 0 && (
                      <div className="mt-4 pt-3 border-t border-white/5">
                        <div className="text-[10px] uppercase text-gray-500 mb-2">Top Customers</div>
                        <div className="space-y-1">
                          {stateData.revenue.revenue_by_customer.slice(0, 3).map((c, i) => (
                            <div key={i} className="flex items-center justify-between text-xs">
                              <span className="text-gray-300 truncate max-w-[60%]">{c.name}</span>
                              <span className="text-emerald-400 font-mono">{money(c.total)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Spend Card */}
                  <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider">Spend</h3>
                      <span className="text-xs text-gray-500">{stateData.spend.vendor_count} vendors</span>
                    </div>
                    <div className="text-3xl font-bold text-white mb-3">{money(stateData.spend.total_spend)}</div>
                    <div className="text-xs text-gray-500 mb-4">
                      OpEx {money(stateData.spend.total_opex)} + COGS {money(stateData.spend.total_cogs)}
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="bg-white/5 rounded-lg p-2">
                        <div className="text-sm font-semibold text-white">{money(stateData.spend.payroll)}</div>
                        <div className="text-[10px] text-gray-500">Payroll</div>
                      </div>
                      <div className="bg-white/5 rounded-lg p-2">
                        <div className="text-sm font-semibold text-white">{money(stateData.spend.recurring_obligations)}</div>
                        <div className="text-[10px] text-gray-500">Recurring</div>
                      </div>
                      <div className="bg-white/5 rounded-lg p-2">
                        <div className="text-sm font-semibold text-white">{pct(stateData.spend.top_vendor_pct)}</div>
                        <div className="text-[10px] text-gray-500">Top Vendor</div>
                      </div>
                    </div>
                    {stateData.spend.spend_by_vendor.length > 0 && (
                      <div className="mt-4 pt-3 border-t border-white/5">
                        <div className="text-[10px] uppercase text-gray-500 mb-2">Top Vendors</div>
                        <div className="space-y-1">
                          {stateData.spend.spend_by_vendor.slice(0, 3).map((v, i) => (
                            <div key={i} className="flex items-center justify-between text-xs">
                              <span className="text-gray-300 truncate max-w-[60%]">{v.name}</span>
                              <span className="text-amber-400 font-mono">{money(v.total)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* ─── NEW: Reconciliation Status ─── */}
                {step13ArAp && (
                  <div className="bg-gradient-to-r from-cyan-500/5 via-transparent to-purple-500/5 border border-white/10 rounded-xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider">Reconciliation Status</h3>
                      <button
                        onClick={() => setCurrentStep(11)}
                        className="text-xs text-gray-400 hover:text-white transition-colors flex items-center gap-1"
                      >
                        View Details →
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-6">
                      {/* AR Reconciliation */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-400">Accounts Receivable</span>
                          <span className="text-xs font-semibold text-emerald-400">
                            {step13ArAp.ar.reconciliation_summary?.match_rate?.toFixed(0) ?? 0}% matched
                          </span>
                        </div>
                        <div className="relative w-full h-2 bg-white/10 rounded-full overflow-hidden">
                          <div 
                            className="absolute left-0 top-0 h-full bg-emerald-400 rounded-full transition-all" 
                            style={{ width: `${step13ArAp.ar.reconciliation_summary?.match_rate ?? 0}%` }} 
                          />
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="bg-white/5 rounded-lg p-2">
                            <div className="text-sm font-semibold text-emerald-400">{step13ArAp.ar.reconciliation_summary?.matched_count ?? 0}</div>
                            <div className="text-[9px] text-gray-500">Matched</div>
                          </div>
                          <div className="bg-white/5 rounded-lg p-2">
                            <div className="text-sm font-semibold text-amber-400">{step13ArAp.ar.reconciliation_summary?.partial_count ?? 0}</div>
                            <div className="text-[9px] text-gray-500">Partial</div>
                          </div>
                          <div className="bg-white/5 rounded-lg p-2">
                            <div className="text-sm font-semibold text-red-400">{step13ArAp.ar.reconciliation_summary?.unmatched_count ?? 0}</div>
                            <div className="text-[9px] text-gray-500">Unmatched</div>
                          </div>
                        </div>
                        <div className="text-[10px] text-gray-500">
                          {money(step13ArAp.ar.reconciliation_summary?.matched_amount ?? 0)} verified · {money(step13ArAp.ar.reconciliation_summary?.unmatched_amount ?? 0)} pending
                        </div>
                      </div>
                      
                      {/* AP Reconciliation */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-400">Accounts Payable</span>
                          <span className="text-xs font-semibold text-purple-400">
                            {step13ArAp.ap.reconciliation_summary?.match_rate?.toFixed(0) ?? 0}% matched
                          </span>
                        </div>
                        <div className="relative w-full h-2 bg-white/10 rounded-full overflow-hidden">
                          <div 
                            className="absolute left-0 top-0 h-full bg-purple-400 rounded-full transition-all" 
                            style={{ width: `${step13ArAp.ap.reconciliation_summary?.match_rate ?? 0}%` }} 
                          />
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="bg-white/5 rounded-lg p-2">
                            <div className="text-sm font-semibold text-emerald-400">{step13ArAp.ap.reconciliation_summary?.matched_count ?? 0}</div>
                            <div className="text-[9px] text-gray-500">Matched</div>
                          </div>
                          <div className="bg-white/5 rounded-lg p-2">
                            <div className="text-sm font-semibold text-amber-400">{step13ArAp.ap.reconciliation_summary?.partial_count ?? 0}</div>
                            <div className="text-[9px] text-gray-500">Partial</div>
                          </div>
                          <div className="bg-white/5 rounded-lg p-2">
                            <div className="text-sm font-semibold text-red-400">{step13ArAp.ap.reconciliation_summary?.unmatched_count ?? 0}</div>
                            <div className="text-[9px] text-gray-500">Unmatched</div>
                          </div>
                        </div>
                        <div className="text-[10px] text-gray-500">
                          {money(step13ArAp.ap.reconciliation_summary?.matched_amount ?? 0)} verified · {money(step13ArAp.ap.reconciliation_summary?.unmatched_amount ?? 0)} pending
                        </div>
                      </div>
                    </div>
                    
                    {/* Discrepancy Alert */}
                    {((step13ArAp.ar.reconciliation_summary?.discrepancy ?? 0) > 100 || (step13ArAp.ap.reconciliation_summary?.discrepancy ?? 0) > 100) && (
                      <div className="mt-4 pt-3 border-t border-white/5">
                        <div className="flex items-center gap-2 text-xs text-amber-400">
                          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                          Discrepancy detected: Accounting records differ from bank-verified amounts
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ─── Liquidity State ─── */}
                <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-blue-400 uppercase tracking-wider">Liquidity</h3>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${regimeBg(stateData.liquidity.liquidity_regime)} ${regimeColor(stateData.liquidity.liquidity_regime)}`}>
                      {stateData.liquidity.liquidity_regime.charAt(0).toUpperCase() + stateData.liquidity.liquidity_regime.slice(1)} Regime
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-4 mb-4">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-blue-400">{money(stateData.liquidity.ending_cash)}</div>
                      <div className="text-xs text-gray-500 mt-1">Ending Cash</div>
                    </div>
                    <div className="text-center">
                      <div className={`text-2xl font-bold ${stateData.liquidity.period_net_cash_flow >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {signedMoney(stateData.liquidity.period_net_cash_flow)}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">Net Cash Flow</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-white">{stateData.liquidity.runway_days ?? "∞"}</div>
                      <div className="text-xs text-gray-500 mt-1">Runway (days)</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-white">{money(stateData.liquidity.burn_rate)}</div>
                      <div className="text-xs text-gray-500 mt-1">
                        {stateData.liquidity.period_days >= 30 ? "Burn Rate/mo" : `Spend (${stateData.liquidity.period_days}d)`}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div className="bg-white/5 rounded-lg p-3">
                      <div className="flex justify-between mb-1">
                        <span className="text-gray-400">Operating</span>
                        <span className={stateData.liquidity.net_operating >= 0 ? "text-emerald-400" : "text-red-400"}>{signedMoney(stateData.liquidity.net_operating)}</span>
                      </div>
                      <div className="text-[10px] text-gray-600">In {money(stateData.liquidity.operating_inflows)} / Out {money(stateData.liquidity.operating_outflows)}</div>
                    </div>
                    <div className="bg-white/5 rounded-lg p-3">
                      <div className="flex justify-between mb-1">
                        <span className="text-gray-400">Financing</span>
                        <span className={stateData.liquidity.net_financing >= 0 ? "text-emerald-400" : "text-red-400"}>{signedMoney(stateData.liquidity.net_financing)}</span>
                      </div>
                      <div className="text-[10px] text-gray-600">In {money(stateData.liquidity.financing_inflows)} / Out {money(stateData.liquidity.financing_outflows)}</div>
                    </div>
                    <div className="bg-white/5 rounded-lg p-3">
                      <div className="flex justify-between mb-1">
                        <span className="text-gray-400">Owner</span>
                        <span className={stateData.liquidity.net_owner >= 0 ? "text-emerald-400" : "text-red-400"}>{signedMoney(stateData.liquidity.net_owner)}</span>
                      </div>
                      <div className="text-[10px] text-gray-600">In {money(stateData.liquidity.owner_inflows)} / Out {money(stateData.liquidity.owner_outflows)}</div>
                    </div>
                  </div>
                </div>

                {/* ─── NEW: Movement & Entity Health ─── */}
                <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs uppercase tracking-wider text-gray-400 font-medium">Data Quality</span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {/* Movement Stats */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                        <span className="text-xs font-medium text-gray-300">Movements</span>
                      </div>
                      {(() => {
                        const stats = step13Movements?.summaryFromTags
                        const totalCount = stats ? (stats.tagged_count + stats.unresolved_count) : (step13Movements?.movements?.length ?? 0)
                        const taggedPct = stats && totalCount > 0 ? Math.round((stats.tagged_count / totalCount) * 100) : null
                        return (
                          <div className="grid grid-cols-4 gap-2 text-center">
                            <div className="bg-white/5 rounded-lg p-2">
                              <div className="text-sm font-semibold text-white">{totalCount.toLocaleString()}</div>
                              <div className="text-[9px] text-gray-500">Total</div>
                            </div>
                            <div className="bg-white/5 rounded-lg p-2">
                              <div className={`text-sm font-semibold ${taggedPct !== null && taggedPct >= 90 ? "text-emerald-400" : taggedPct !== null && taggedPct >= 70 ? "text-amber-400" : "text-red-400"}`}>
                                {taggedPct !== null ? `${taggedPct}%` : "—"}
                              </div>
                              <div className="text-[9px] text-gray-500">Tagged</div>
                            </div>
                            <div className="bg-white/5 rounded-lg p-2">
                              <div className={`text-sm font-semibold ${(stats?.anomaly_count ?? 0) === 0 ? "text-emerald-400" : "text-amber-400"}`}>
                                {stats?.anomaly_count ?? 0}
                              </div>
                              <div className="text-[9px] text-gray-500">Anomalies</div>
                            </div>
                            <div className="bg-white/5 rounded-lg p-2">
                              <div className={`text-sm font-semibold ${(stats?.excluded_for_review ?? 0) === 0 ? "text-emerald-400" : "text-amber-400"}`}>
                                {stats?.excluded_for_review ?? 0}
                              </div>
                              <div className="text-[9px] text-gray-500">Review</div>
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                    
                    {/* Entity Stats */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                        <span className="text-xs font-medium text-gray-300">Entities</span>
                        <button
                          onClick={() => setCurrentStep(12)}
                          className="ml-auto text-[10px] text-gray-500 hover:text-white transition-colors"
                        >
                          View All →
                        </button>
                      </div>
                      {(() => {
                        const summary = step13Entities?.summary
                        return (
                          <div className="grid grid-cols-4 gap-2 text-center">
                            <div className="bg-white/5 rounded-lg p-2">
                              <div className="text-sm font-semibold text-white">{summary?.total_entities ?? 0}</div>
                              <div className="text-[9px] text-gray-500">Total</div>
                            </div>
                            <div className="bg-white/5 rounded-lg p-2">
                              <div className="text-sm font-semibold text-emerald-400">{summary?.total_customers ?? 0}</div>
                              <div className="text-[9px] text-gray-500">Customers</div>
                            </div>
                            <div className="bg-white/5 rounded-lg p-2">
                              <div className="text-sm font-semibold text-amber-400">{summary?.total_vendors ?? 0}</div>
                              <div className="text-[9px] text-gray-500">Vendors</div>
                            </div>
                            <div className="bg-white/5 rounded-lg p-2">
                              <div className={`text-sm font-semibold ${(summary?.at_risk_count ?? 0) === 0 ? "text-emerald-400" : "text-red-400"}`}>
                                {summary?.at_risk_count ?? 0}
                              </div>
                              <div className="text-[9px] text-gray-500">At Risk</div>
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                </div>

                {/* ─── Insights ─── */}
                {stateData.insights.length > 0 && (
                  <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                    <div className="text-xs uppercase tracking-wider text-gray-400 mb-3">Key Insights</div>
                    <div className="space-y-2">
                      {stateData.insights.slice(0, 5).map((ins) => (
                        <div key={ins.id} className="flex items-start gap-2.5">
                          <span className={`mt-1 shrink-0 w-2 h-2 rounded-full ${ins.severity === "high" ? "bg-red-400" : ins.severity === "medium" ? "bg-amber-400" : "bg-blue-400"}`} />
                          <span className="text-sm text-gray-200">{ins.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ─── NEW: Transitions (Regime Changes) ─── */}
                {stateData.transitions && stateData.transitions.length > 0 && (
                  <div className="bg-gradient-to-r from-amber-500/5 via-transparent to-red-500/5 border border-white/10 rounded-xl p-4">
                    <div className="text-xs uppercase tracking-wider text-amber-400 mb-3">Regime Changes Detected</div>
                    <div className="space-y-2">
                      {stateData.transitions.slice(0, 4).map((t, i) => (
                        <div key={i} className="flex items-start gap-2.5">
                          <span className={`mt-1 shrink-0 w-2 h-2 rounded-full ${t.severity === "critical" ? "bg-red-400 animate-pulse" : t.severity === "warning" ? "bg-amber-400" : "bg-blue-400"}`} />
                          <div className="flex-1">
                            <span className="text-sm text-gray-200">{t.description}</span>
                            {t.previous_state && (
                              <div className="text-[10px] text-gray-500 mt-0.5">
                                {t.previous_state} → {t.current_state}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ─── Refresh Button ─── */}
                <div className="flex justify-center pt-2">
                  <button
                    onClick={async () => {
                      setStateLoading(true)
                      setStateError(null)
                      try {
                        const res = await fetch("/api/state/compute", { method: "POST" })
                        if (!res.ok) throw new Error(await res.text())
                        const data = await res.json()
                        setStateData(data)
                      } catch (err) {
                        setStateError(err instanceof Error ? err.message : "Unknown error")
                      } finally {
                        setStateLoading(false)
                      }
                    }}
                    disabled={stateLoading}
                    className="rounded-lg border border-white/20 bg-white/5 px-5 py-3 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="text-sm font-medium text-white">{stateLoading ? "Computing…" : "Refresh State"}</div>
                    <div className="text-xs text-gray-400">Recompute from latest data</div>
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      }

      case 14: {
        const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        const signedMoney = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        const cashDisplay = (n: number) => n < 0 ? `-$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        const behaviorLabel = (b: ComponentBehavior) => b === "recurring" ? "Recurring" : b === "episodic" ? "Episodic" : b === "seasonal" ? "Seasonal" : "One-time"
        const confDot = (c: "high" | "medium" | "low") => c === "high" ? "bg-emerald-400" : c === "medium" ? "bg-amber-400" : "bg-red-400"
        const scenarioColor = (s: string) => s === "optimistic" ? "text-emerald-400" : s === "pessimistic" ? "text-red-400" : "text-blue-400"
        const scenarioBorder = (s: string) => s === "optimistic" ? "border-emerald-500/20" : s === "pessimistic" ? "border-red-500/20" : "border-blue-500/20"
        const scenarioBg = (s: string) => s === "optimistic" ? "bg-emerald-500/10" : s === "pessimistic" ? "bg-red-500/10" : "bg-blue-500/10"

        return (
          <div className="space-y-8">
            <div className="text-center mb-2">
              <h2 className="text-3xl font-bold text-white mb-2 tracking-tight">{steps[13].title}</h2>
              <p className="text-gray-400 text-base max-w-xl mx-auto">{steps[13].description}</p>

              {forecastLoading && (
                <div className="flex flex-col items-center justify-center gap-4 py-16">
                  <div className="relative w-16 h-16">
                    <div className="absolute inset-0 rounded-full border-2 border-white/5" />
                    <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-blue-400 animate-spin" />
                    <div className="absolute inset-[6px] rounded-full border-2 border-transparent border-b-blue-400/50 animate-spin" style={{ animationDirection: "reverse", animationDuration: "1.5s" }} />
                  </div>
                  <span className="text-sm text-gray-400 animate-pulse">Computing forecast…</span>
                </div>
              )}

              {forecastError && !forecastLoading && (
                <p className="text-red-300 text-sm mb-4">Failed: {forecastError}</p>
              )}
            </div>

            {!forecastLoading && forecastData && (
              <div className="space-y-8">
                {/* ─── Data Quality + Forecast Confidence ─── */}
                <div className="flex flex-wrap items-center justify-between gap-4 mb-2">
                  <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                    <span className="flex items-center gap-1.5"><span className="w-1 h-1 rounded-full bg-gray-500" />Data span: {forecastData.data_span_days}d</span>
                    <span className="flex items-center gap-1.5"><span className="w-1 h-1 rounded-full bg-gray-500" />Components: {forecastData.components.length}</span>
                    <span className="flex items-center gap-1.5"><span className="w-1 h-1 rounded-full bg-gray-500" />Horizon: {forecastData.forecast_horizon_months} months{forecastData.horizon_capped && <span className="text-amber-400 ml-1">(capped)</span>}</span>
                    {forecastData.context && (
                      <span className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${forecastData.context.balance_source === "plaid" ? "bg-emerald-400" : "bg-amber-400"}`} />
                        Balance: <span className={forecastData.context.balance_source === "plaid" ? "text-emerald-400" : "text-amber-400"}>{forecastData.context.balance_source === "plaid" ? "Live (Plaid)" : "Derived"}</span>
                      </span>
                    )}
                  </div>
                  {forecastData.forecast_confidence && (() => {
                    const conf = forecastData.forecast_confidence
                    const pct = Math.round(conf.score * 100)
                    const color = conf.label === "high" ? "emerald" : conf.label === "medium" ? "amber" : "red"
                    return (
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                          <div className="relative w-10 h-10">
                            <svg viewBox="0 0 36 36" className="w-10 h-10 -rotate-90">
                              <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
                              <circle cx="18" cy="18" r="15.5" fill="none" stroke={color === "emerald" ? "rgb(52,211,153)" : color === "amber" ? "rgb(251,191,36)" : "rgb(248,113,113)"} strokeWidth="3" strokeDasharray={`${pct * 0.975} 100`} strokeLinecap="round" />
                            </svg>
                            <span className={`absolute inset-0 flex items-center justify-center text-xs font-bold font-mono text-${color}-400`}>{pct}</span>
                          </div>
                          <div className="text-right">
                            <div className={`text-xs font-semibold text-${color}-400`}>Confidence</div>
                            <div className="text-[10px] text-gray-500 capitalize">{conf.label}</div>
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                </div>

                {/* ─── Horizon Cap Warning ─── */}
                {forecastData.horizon_capped && forecastData.horizon_cap_reason && (
                  <div className="flex items-center gap-2.5 px-4 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300">
                    <span className="text-amber-400 text-sm">⚠</span>
                    <span>{forecastData.horizon_cap_reason}</span>
                  </div>
                )}

                {/* ─── MAE Buffer Warning ─── */}
                {forecastData.backtest && forecastData.backtest.mean_absolute_error > 0 && forecastData.daily_simulation.min_cash > 0 && forecastData.daily_simulation.min_cash < forecastData.backtest.mean_absolute_error && (
                  <div className="flex items-center gap-2.5 px-4 py-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-300">
                    <span className="text-red-400 text-sm">⚠</span>
                    <span>Projected cash low (${Math.round(forecastData.daily_simulation.min_cash).toLocaleString()}) is within forecast error margin (${Math.round(forecastData.backtest.mean_absolute_error).toLocaleString()}) — safety buffer may be insufficient</span>
                  </div>
                )}

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
                  const glowColor = n.severity === "danger" ? "shadow-red-500/10" : n.severity === "caution" ? "shadow-amber-500/10" : "shadow-emerald-500/10"
                  return (
                    <div className={`border rounded-2xl ${borderColor} ${bgColor} shadow-lg ${glowColor} overflow-hidden`}>
                      <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-white/5">
                        <div className="p-5">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-lg">🔮</span>
                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Forecast</span>
                          </div>
                          <div className={`text-sm leading-relaxed ${accentColor} font-medium`}>{n.forecast}</div>
                        </div>
                        <div className="p-5">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-lg">⚠️</span>
                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Risk</span>
                          </div>
                          <div className="text-sm leading-relaxed text-gray-200">{n.risk}</div>
                        </div>
                        <div className="p-5">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-lg">🧠</span>
                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Insight</span>
                          </div>
                          <div className="text-sm leading-relaxed text-gray-300">{n.insight}</div>
                        </div>
                        <div className="p-5">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-lg">🎯</span>
                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Action</span>
                          </div>
                          <div className="text-sm leading-relaxed text-white font-medium">{n.action}</div>
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
                    <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-5">
                      {/* Summary bar */}
                      <div className="grid grid-cols-4 gap-4 mb-6 text-center">
                        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3">
                          <div className="text-[10px] text-emerald-400/70 uppercase tracking-wider mb-1">Expected in</div>
                          <div className="text-lg font-bold font-mono text-emerald-400">{money(totalIn)}</div>
                        </div>
                        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3">
                          <div className="text-[10px] text-red-400/70 uppercase tracking-wider mb-1">Expected out</div>
                          <div className="text-lg font-bold font-mono text-red-400">{money(totalOut)}</div>
                        </div>
                        <div className={`${net >= 0 ? "bg-blue-500/10 border-blue-500/20" : "bg-amber-500/10 border-amber-500/20"} border rounded-xl p-3`}>
                          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Net</div>
                          <div className={`text-lg font-bold font-mono ${net >= 0 ? "text-blue-400" : "text-amber-400"}`}>{signedMoney(net)}</div>
                        </div>
                        {lowDay && sim.min_cash < sim.starting_cash * 0.8 && (
                          <div className={`${sim.min_cash < 0 ? "bg-red-500/10 border-red-500/20" : "bg-amber-500/10 border-amber-500/20"} border rounded-xl p-3`}>
                            <div className={`text-[10px] ${sim.min_cash < 0 ? "text-red-400/70" : "text-amber-400/70"} uppercase tracking-wider mb-1`}>Low point D{sim.min_cash_day}</div>
                            <div className={`text-lg font-bold font-mono ${sim.min_cash < 0 ? "text-red-400" : "text-amber-400"}`}>{cashDisplay(sim.min_cash)}</div>
                          </div>
                        )}
                      </div>

                      {/* Next 7 Days */}
                      {events7d.length > 0 && (
                        <>
                          <h3 className="text-xs font-semibold text-white uppercase tracking-widest mb-3">Next 7 days</h3>
                          <div className="space-y-1.5 mb-5">
                            {events7d.slice(0, 8).map((evt, i) => {
                              const typeColor = evt.direction === "in" ? "text-emerald-400" : "text-red-400"
                              const confDot = evt.confidence === "high" ? "bg-emerald-500" : evt.confidence === "medium" ? "bg-amber-500" : "bg-red-500"
                              return (
                                <div key={`7d-${evt.date}-${evt.entity}-${i}`} className="flex items-center gap-2.5 py-2 px-3 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors border border-transparent hover:border-white/5">
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
                      <h3 className="text-xs font-semibold text-white uppercase tracking-widest mb-3">Top 10 drivers (30d)</h3>
                      <div className="space-y-1.5 mb-4">
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
                                <div className="flex items-center gap-2.5 py-2 px-3 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors border border-transparent hover:border-white/5" title={tooltip}>
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
                    <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-6">
                      <div className="flex items-center justify-between mb-5">
                        <h3 className="text-sm font-semibold text-white uppercase tracking-wider">Daily Cash Position — 30 Days</h3>
                        <div className="flex items-center gap-5 text-xs">
                          <span className="text-gray-500">Start: <span className="text-white font-mono font-semibold">{money(sim.starting_cash)}</span></span>
                          <span className="text-gray-500">End: <span className={`font-mono font-semibold ${sim.ending_cash >= sim.starting_cash ? "text-emerald-400" : "text-red-400"}`}>{money(sim.ending_cash)}</span></span>
                        </div>
                      </div>

                      {sim.min_cash < sim.starting_cash * 0.5 && (
                        <div className={`mb-4 px-3 py-2 rounded-lg border text-xs flex items-center gap-2 ${sim.min_cash < 0 ? "bg-red-500/10 border-red-500/20" : "bg-amber-500/10 border-amber-500/20"}`}>
                          <span className={`w-2 h-2 rounded-full animate-pulse ${sim.min_cash < 0 ? "bg-red-400" : "bg-amber-400"}`} />
                          <span className={`font-semibold ${sim.min_cash < 0 ? "text-red-400" : "text-amber-400"}`}>Expected path low</span>
                          <span className={sim.min_cash < 0 ? "text-red-300" : "text-gray-400"}>Day {sim.min_cash_day}: <span className="font-mono font-semibold">{cashDisplay(sim.min_cash)}</span></span>
                        </div>
                      )}

                      {/* Bar chart */}
                      <div className="flex items-end gap-[2px] h-32 mb-2">
                        {sim.days.map((d) => {
                          const h = barHeight(d.cash)
                          const isMin = d.day === sim.min_cash_day && sim.min_cash < sim.starting_cash * 0.7
                          const color = d.cash < 0 ? "bg-red-500" : isMin ? "bg-amber-400" : d.cash >= sim.starting_cash ? "bg-emerald-400/60" : "bg-blue-400/60"
                          return (
                            <div
                              key={d.day}
                              className={`flex-1 rounded-t-sm ${color} transition-all relative group cursor-default`}
                              style={{ height: `${h}%` }}
                            >
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10 bg-gray-900 border border-white/20 rounded px-2 py-1.5 text-[10px] whitespace-nowrap shadow-lg">
                                <div className="text-white font-semibold">D{d.day} — {d.date}</div>
                                <div className="text-gray-400">Cash: <span className={`font-mono ${d.cash < 0 ? "text-red-400" : "text-white"}`}>{cashDisplay(d.cash)}</span></div>
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
                    <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-6">
                      <div className="flex items-center justify-between mb-5">
                        <div>
                          <h3 className="text-sm font-semibold text-white uppercase tracking-wider">Monte Carlo Simulation</h3>
                          <p className="text-[10px] text-gray-500 mt-0.5">{mc.simulations} simulations with payment delays, amount variance, missed payments</p>
                        </div>
                      </div>

                      {/* Probability queries */}
                      <div className="grid grid-cols-3 gap-4 mb-6">
                        <div className={`rounded-xl p-4 text-center border ${mc.prob_below_zero_14d > 0.3 ? "bg-red-500/10 border-red-500/20" : mc.prob_below_zero_14d > 0.1 ? "bg-amber-500/10 border-amber-500/20" : "bg-emerald-500/10 border-emerald-500/20"}`}>
                          <div className="text-[10px] text-gray-400 mb-2 uppercase tracking-wider">P(cash &lt; 0) in 14d</div>
                          <div className={`text-2xl font-bold font-mono ${probColor(mc.prob_below_zero_14d)}`}>{Math.round(mc.prob_below_zero_14d * 100)}%</div>
                        </div>
                        <div className={`rounded-xl p-4 text-center border ${mc.prob_below_zero_30d > 0.3 ? "bg-red-500/10 border-red-500/20" : mc.prob_below_zero_30d > 0.1 ? "bg-amber-500/10 border-amber-500/20" : "bg-emerald-500/10 border-emerald-500/20"}`}>
                          <div className="text-[10px] text-gray-400 mb-2 uppercase tracking-wider">P(cash &lt; 0) in 30d</div>
                          <div className={`text-2xl font-bold font-mono ${probColor(mc.prob_below_zero_30d)}`}>{Math.round(mc.prob_below_zero_30d * 100)}%</div>
                        </div>
                        <div className={`rounded-xl p-4 text-center border ${mc.prob_above_starting_30d > 0.5 ? "bg-emerald-500/10 border-emerald-500/20" : "bg-amber-500/10 border-amber-500/20"}`}>
                          <div className="text-[10px] text-gray-400 mb-2 uppercase tracking-wider">P(cash &gt; start) in 30d</div>
                          <div className={`text-2xl font-bold font-mono ${mc.prob_above_starting_30d > 0.5 ? "text-emerald-400" : "text-amber-400"}`}>{Math.round(mc.prob_above_starting_30d * 100)}%</div>
                        </div>
                      </div>

                      {/* Percentile fan chart */}
                      <div className="relative h-40 mb-3 bg-white/[0.02] rounded-xl p-2">
                        <svg viewBox="0 0 300 100" preserveAspectRatio="none" className="w-full h-full">
                          <defs>
                            <linearGradient id="fanOuter" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="rgb(59,130,246)" stopOpacity="0.06" />
                              <stop offset="100%" stopColor="rgb(59,130,246)" stopOpacity="0.12" />
                            </linearGradient>
                            <linearGradient id="fanInner" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="rgb(59,130,246)" stopOpacity="0.12" />
                              <stop offset="100%" stopColor="rgb(59,130,246)" stopOpacity="0.25" />
                            </linearGradient>
                          </defs>
                          {/* P5-P95 band */}
                          <polygon
                            points={
                              pctiles.map((p, i) => `${(i / 29) * 300},${yPos(p.p95)}`).join(" ") + " " +
                              [...pctiles].reverse().map((p, i) => `${((29 - i) / 29) * 300},${yPos(p.p5)}`).join(" ")
                            }
                            fill="url(#fanOuter)"
                          />
                          {/* P25-P75 band */}
                          <polygon
                            points={
                              pctiles.map((p, i) => `${(i / 29) * 300},${yPos(p.p75)}`).join(" ") + " " +
                              [...pctiles].reverse().map((p, i) => `${((29 - i) / 29) * 300},${yPos(p.p25)}`).join(" ")
                            }
                            fill="url(#fanInner)"
                          />
                          {/* P50 median line */}
                          <polyline
                            points={pctiles.map((p, i) => `${(i / 29) * 300},${yPos(p.p50)}`).join(" ")}
                            fill="none" stroke="rgb(96,165,250)" strokeWidth="2" strokeLinejoin="round"
                          />
                          {/* Zero line if visible */}
                          {minVal < 0 && (
                            <line x1="0" y1={yPos(0)} x2="300" y2={yPos(0)} stroke="rgba(239,68,68,0.5)" strokeWidth="0.5" strokeDasharray="4,3" />
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
                      <div className="grid grid-cols-3 gap-4 text-center">
                        <div className="bg-white/[0.03] rounded-xl p-3">
                          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Expected (30d)</div>
                          <div className="text-lg text-white font-mono font-bold">{cashDisplay(mc.expected_cash_30d)}</div>
                        </div>
                        <div className="bg-white/[0.03] rounded-xl p-3">
                          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Probabilistic downside (5th %ile)</div>
                          <div className={`text-lg font-mono font-bold ${mc.worst_case_cash_30d < 0 ? "text-red-400" : "text-amber-400"}`}>{cashDisplay(mc.worst_case_cash_30d)}</div>
                        </div>
                        <div className="bg-white/[0.03] rounded-xl p-3">
                          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Best case (95th %ile)</div>
                          <div className="text-lg text-emerald-400 font-mono font-bold">{cashDisplay(mc.best_case_cash_30d)}</div>
                        </div>
                      </div>

                      {/* Day-level scenario comparison */}
                      {mc.day_scenarios.length > 0 && (
                        <div className="mt-5 pt-4 border-t border-white/10">
                          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">Scenario Comparison</h4>
                          <div className="grid grid-cols-3 gap-4">
                            {mc.day_scenarios.map((sc) => {
                              const color = sc.scenario === "aggressive" ? "emerald" : sc.scenario === "conservative" ? "red" : "blue"
                              const borderCls = `border-${color}-500/20`
                              const bgCls = `bg-${color}-500/10`
                              const textCls = `text-${color}-400`
                              return (
                                <div key={sc.scenario} className={`border rounded-xl p-4 backdrop-blur-sm ${sc.scenario === "aggressive" ? "border-emerald-500/20 bg-emerald-500/10" : sc.scenario === "conservative" ? "border-red-500/20 bg-red-500/10" : "border-blue-500/20 bg-blue-500/10"}`}>
                                  <div className={`text-[10px] font-bold uppercase tracking-wider mb-1.5 ${sc.scenario === "aggressive" ? "text-emerald-400" : sc.scenario === "conservative" ? "text-red-400" : "text-blue-400"}`}>
                                {sc.scenario === "conservative" ? "Stress scenario" : sc.scenario === "base" ? "Expected path" : sc.scenario}
                              </div>
                                  <div className="text-[10px] text-gray-500 mb-2">{sc.label}</div>
                                  <div className="space-y-1">
                                    <div className="flex justify-between text-xs">
                                      <span className="text-gray-400">14d</span>
                                      <span className={`font-mono font-semibold ${sc.cash_14d < 0 ? "text-red-400" : "text-white"}`}>{cashDisplay(sc.cash_14d)}</span>
                                    </div>
                                    <div className="flex justify-between text-xs">
                                      <span className="text-gray-400">30d</span>
                                      <span className={`font-mono font-semibold ${sc.cash_30d < 0 ? "text-red-400" : "text-white"}`}>{cashDisplay(sc.cash_30d)}</span>
                                    </div>
                                    {sc.min_cash_day > 0 && (
                                      <div className="flex justify-between text-xs">
                                        <span className="text-gray-500">Low D{sc.min_cash_day}</span>
                                        <span className={`font-mono ${sc.min_cash < 0 ? "text-red-400" : "text-gray-400"}`}>{cashDisplay(sc.min_cash)}</span>
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
                {forecastData.cash_runway && (() => {
                  const mc = forecastData.monte_carlo
                  const sim = forecastData.daily_simulation
                  const shortTermRisk = mc && mc.prob_below_zero_14d > 0.2
                  const shortTermCrisis = mc && mc.prob_below_zero_14d > 0.5
                  return (
                  <div className={`bg-white/5 border ${shortTermCrisis ? "border-red-500/30" : "border-white/10"} rounded-xl p-5`}>
                    <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">Cash Runway</h3>
                    
                    {shortTermRisk && sim && (
                      <div className={`mb-4 p-3 rounded-lg border ${shortTermCrisis ? "bg-red-500/10 border-red-500/20" : "bg-amber-500/10 border-amber-500/20"}`}>
                        <div className={`text-xs font-semibold ${shortTermCrisis ? "text-red-400" : "text-amber-400"} mb-1`}>
                          Short-term liquidity risk
                        </div>
                        <div className="text-[10px] text-gray-300">
                          {Math.round(mc.prob_below_zero_14d * 100)}% chance of cash going negative in the next 14 days
                          {sim.min_cash < 0 && <span className="text-red-400 font-mono"> (low point: {cashDisplay(sim.min_cash)} on day {sim.min_cash_day})</span>}
                          {sim.min_cash >= 0 && <span className="text-amber-400 font-mono"> (low point: {cashDisplay(sim.min_cash)} on day {sim.min_cash_day})</span>}
                        </div>
                        <div className="text-[10px] text-gray-500 mt-1">
                          Long-term projections are positive, but near-term large outflows create a temporary crunch
                        </div>
                      </div>
                    )}
                    
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
                  )
                })()}

                {/* ─── Sensitivity Analysis ─── */}
                {forecastData.sensitivity && forecastData.sensitivity.drivers.length > 0 && (
                  <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-6">
                    <h3 className="text-sm font-semibold text-white uppercase tracking-widest mb-1">Top Drivers of Cash Position</h3>
                    <p className="text-xs text-gray-500 mb-5">Which entities move your cash the most</p>
                    <div className="space-y-2.5">
                      {forecastData.sensitivity.drivers.map((d, i) => (
                        <div key={i} className="flex items-center gap-3 bg-white/[0.03] rounded-xl px-4 py-3 hover:bg-white/[0.06] transition-colors border border-transparent hover:border-white/5">
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
                  <div className="bg-gradient-to-b from-cyan-500/5 to-transparent border border-cyan-500/20 rounded-2xl p-6">
                    <h3 className="text-sm font-semibold text-cyan-400 uppercase tracking-widest mb-1">Top Actions (by risk reduction)</h3>
                    <p className="text-xs text-gray-500 mb-5">If I do X, what happens to my cash distribution?</p>
                    <div className="space-y-3">
                      {forecastData.interventions.slice(0, 5).map((iv) => {
                        const hasRange = iv.plausible_range_low != null && iv.plausible_range_high != null
                        const rangeStr = hasRange ? `${money(iv.plausible_range_low!)} – ${money(iv.plausible_range_high!)}` : money(iv.impact_cash_14d)
                        const confLabel = iv.confidence_band ? ` (${iv.confidence_band} confidence)` : ""
                        const sim = iv.simulation_impact
                        return (
                          <div key={iv.id} className="bg-white/[0.03] rounded-xl px-4 py-3.5 border border-white/5 hover:border-cyan-500/20 transition-colors">
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center gap-2.5">
                                {iv.rank != null && <span className="text-[10px] bg-cyan-500/20 text-cyan-400 font-bold w-5 h-5 rounded-full flex items-center justify-center">#{iv.rank}</span>}
                                <div className="text-sm text-white font-medium">{iv.label}</div>
                              </div>
                              <div className="text-emerald-400 font-mono font-bold text-sm">
                                +{hasRange ? rangeStr : money(iv.impact_cash_14d)}
                                <span className="text-[10px] text-gray-500 font-normal ml-1">@14d{confLabel}</span>
                              </div>
                            </div>
                            {sim && (
                              <div className="flex flex-wrap gap-3 text-[10px] text-gray-400 mb-2">
                                <span>Low point: <span className={sim.low_point_before < 0 ? "text-red-400" : ""}>{cashDisplay(Math.round(sim.low_point_before))}</span> → <span className="text-emerald-400">{cashDisplay(Math.round(sim.low_point_after))}</span></span>
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
                                <span className={s.low_point < 0 ? "text-red-400" : "text-gray-500"}>Low point: {cashDisplay(Math.round(s.low_point))}</span>
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
                  <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-6">
                    <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-widest mb-1">Forecast Confidence</h3>
                    <p className="text-[10px] text-gray-500 mb-4">What would make this prediction wrong? How to improve trust.</p>

                    {/* Diagnosis sentence */}
                    {forecastData.forecast_confidence.diagnosis && (
                      <p className="text-xs text-gray-300 mb-4 italic border-l-2 border-white/10 pl-3">{forecastData.forecast_confidence.diagnosis}</p>
                    )}

                    {/* What would make wrong */}
                    {forecastData.forecast_confidence.what_would_make_wrong && (
                      <div className="mb-4 p-3 bg-amber-500/10 rounded-xl border border-amber-500/20">
                        <div className="text-[10px] text-amber-400/90 font-semibold uppercase tracking-wider mb-1.5">What could make this wrong</div>
                        <p className="text-xs text-gray-300 leading-relaxed">{forecastData.forecast_confidence.what_would_make_wrong}</p>
                      </div>
                    )}

                    {/* Why confidence is low */}
                    {forecastData.forecast_confidence.why_confidence_low && forecastData.forecast_confidence.why_confidence_low.length > 0 && (
                      <div className="mb-4">
                        <div className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-2">Why</div>
                        <ul className="space-y-1 text-xs text-gray-400">
                          {forecastData.forecast_confidence.why_confidence_low.map((r, i) => (
                            <li key={i} className="flex items-start gap-2"><span className="text-gray-600 mt-0.5">•</span><span>{r}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* How to improve */}
                    {forecastData.forecast_confidence.how_to_improve && forecastData.forecast_confidence.how_to_improve.length > 0 && (
                      <div className="mb-4 p-3 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
                        <div className="text-[10px] text-emerald-400/90 font-semibold uppercase tracking-wider mb-1.5">How to improve</div>
                        <ul className="space-y-1 text-xs text-gray-300">
                          {forecastData.forecast_confidence.how_to_improve.map((r, i) => (
                            <li key={i} className="flex items-start gap-2"><span className="text-emerald-400/50 mt-0.5">•</span><span>{r}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Identity breakdown */}
                    {forecastData.forecast_confidence.identity_breakdown && (
                      <div className="grid grid-cols-3 gap-3 mb-5 text-[10px]">
                        <div className="bg-emerald-500/10 rounded-xl px-3 py-2.5 text-center">
                          <div className="text-gray-500 mb-0.5">High-confidence canonical</div>
                          <div className="font-mono text-lg font-bold text-emerald-400">{forecastData.forecast_confidence.identity_breakdown.high_confidence_canonical_pct}%</div>
                        </div>
                        <div className="bg-amber-500/10 rounded-xl px-3 py-2.5 text-center">
                          <div className="text-gray-500 mb-0.5">Weak / inferred</div>
                          <div className="font-mono text-lg font-bold text-amber-400">{forecastData.forecast_confidence.identity_breakdown.weak_inferred_pct}%</div>
                        </div>
                        <div className="bg-red-500/10 rounded-xl px-3 py-2.5 text-center">
                          <div className="text-gray-500 mb-0.5">Unresolved</div>
                          <div className="font-mono text-lg font-bold text-red-400">{forecastData.forecast_confidence.identity_breakdown.unresolved_pct}%</div>
                        </div>
                      </div>
                    )}

                    {/* 8-component confidence breakdown */}
                    {forecastData.forecast_confidence.by_component && forecastData.forecast_confidence.by_component.length > 0 && (
                      <div className="space-y-3 mb-5">
                        {forecastData.forecast_confidence.by_component.map((cc, i) => (
                          <div key={i}>
                            <div className="flex items-center gap-3">
                              <div className="text-xs text-gray-400 w-36 shrink-0 font-medium">{cc.area}</div>
                              <div className="flex-1 h-2.5 bg-white/5 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all ${cc.label === "high" ? "bg-gradient-to-r from-emerald-600 to-emerald-400" : cc.label === "medium" ? "bg-gradient-to-r from-amber-600 to-amber-400" : "bg-gradient-to-r from-red-600 to-red-400"}`}
                                  style={{ width: `${Math.round(cc.score * 100)}%` }}
                                />
                              </div>
                              <div className={`text-xs font-mono font-bold w-10 text-right ${cc.label === "high" ? "text-emerald-400" : cc.label === "medium" ? "text-amber-400" : "text-red-400"}`}>
                                {Math.round(cc.score * 100)}%
                              </div>
                            </div>
                            <div className="text-[10px] text-gray-600 pl-[9.5rem] mt-0.5">{cc.reason}</div>
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

      case 15: {
        const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        const cashDisplay = (n: number) => n < 0 ? `-$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        return (
          <div className="space-y-6">
            <div className="text-center mb-2">
              <h2 className="text-2xl font-semibold text-white mb-1">{steps[14].title}</h2>
              <p className="text-gray-400 text-lg mb-5">{steps[14].description}</p>
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
                                <span>Low point: <span className={sim.low_point_before < 0 ? "text-red-400" : ""}>{cashDisplay(Math.round(sim.low_point_before))}</span> → <span className="text-emerald-400">{cashDisplay(Math.round(sim.low_point_after))}</span></span>
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
                                <span className={s.low_point < 0 ? "text-red-400" : "text-gray-500"}>Low point: {cashDisplay(Math.round(s.low_point))}</span>
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
