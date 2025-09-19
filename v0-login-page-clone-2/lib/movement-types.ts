// ─── Frozen Public Contract: Movement Types ─────────────────────────
//
// This file defines the stable public contract for the money movement layer.
// Downstream consumers (UI, P&L engine, dashboard, AI context) import from here.
// Internal classification uses 30 granular types; this maps to 13 public classes.

export type MovementClass =
  | "customer_cash_in"
  | "vendor_cash_out"
  | "internal_transfer"
  | "processor_fee"
  | "processor_payout"
  | "owner_contribution"
  | "owner_draw"
  | "credit_card_payment"
  | "bank_fee"
  | "refund"
  | "interest"
  | "opening_balance"
  | "unknown"

export type Provenance = "bank_observed" | "accounting_observed" | "coalesced"

export type ReviewReason =
  | "low_classification_confidence"
  | "direction_type_mismatch"
  | "provisional_classification"
  | "llm_fallback"
  | "low_evidence"

export type CanonicalMovement = {
  id: string
  user_id: string
  occurred_at: string
  direction: "inflow" | "outflow"
  amount: number
  currency: string
  raw_description: string | null
  source_record_ids: string[]
  entity_id: string | null
  account_id: string | null
  movement_class: MovementClass
  movement_type_detail: string
  pnl_eligible: boolean
  confidence: number
  evidence_strength: number
  needs_review: boolean
  review_reasons: ReviewReason[]
  provenance: Provenance
  coalesced_group_id: string | null
  metadata: Record<string, unknown>
}

const INTERNAL_TO_CLASS: Record<string, MovementClass> = {
  cash_in_customer: "customer_cash_in",
  cash_out_vendor: "vendor_cash_out",
  cash_out_operating_expense: "vendor_cash_out",
  cash_out_payroll: "vendor_cash_out",
  cash_out_tax: "vendor_cash_out",
  internal_transfer: "internal_transfer",
  processor_fee_settlement: "processor_fee",
  processor_payout: "processor_payout",
  owner_contribution: "owner_contribution",
  owner_contribution_candidate: "owner_contribution",
  owner_draw: "owner_draw",
  credit_card_payment: "credit_card_payment",
  cash_out_bank_fee: "bank_fee",
  cash_in_refund: "refund",
  cash_out_refund: "refund",
  cash_in_interest: "interest",
  cash_out_interest: "interest",
  opening_balance: "opening_balance",
  balance_adjustment: "opening_balance",
  account_verification: "opening_balance",
  loan_funding: "unknown",
  loan_principal_payment: "unknown",
  merchant_deposit_unresolved: "unknown",
  unknown_inflow: "unknown",
  unknown_outflow: "unknown",
  unknown_transfer_candidate: "unknown",
  other_operating: "unknown",
}

export function toMovementClass(internalType: string): MovementClass {
  return INTERNAL_TO_CLASS[internalType] ?? "unknown"
}

export const MOVEMENT_CLASS_META: Record<MovementClass, { label: string; color: string; group: "pnl" | "non_pnl" | "review" }> = {
  customer_cash_in:  { label: "Customer Cash In",    color: "bg-emerald-500/80 border-emerald-400/50", group: "pnl" },
  vendor_cash_out:   { label: "Vendor Cash Out",     color: "bg-orange-500/80 border-orange-400/50",   group: "pnl" },
  bank_fee:          { label: "Bank Fee",            color: "bg-red-500/80 border-red-400/50",         group: "pnl" },
  refund:            { label: "Refund",              color: "bg-amber-500/80 border-amber-400/50",     group: "pnl" },
  interest:          { label: "Interest",            color: "bg-teal-500/80 border-teal-400/50",       group: "pnl" },
  internal_transfer: { label: "Internal Transfer",   color: "bg-slate-500/80 border-slate-400/50",     group: "non_pnl" },
  processor_payout:  { label: "Processor Payout",    color: "bg-violet-500/80 border-violet-400/50",   group: "non_pnl" },
  processor_fee:     { label: "Processor Fee",       color: "bg-violet-700/80 border-violet-600/50",   group: "non_pnl" },
  credit_card_payment: { label: "Credit Card Payment", color: "bg-indigo-500/80 border-indigo-400/50", group: "non_pnl" },
  owner_contribution:  { label: "Owner Contribution",  color: "bg-rose-400/80 border-rose-300/50",     group: "non_pnl" },
  owner_draw:          { label: "Owner Draw",          color: "bg-rose-600/80 border-rose-500/50",     group: "non_pnl" },
  opening_balance:     { label: "Opening Balance",     color: "bg-gray-600/80 border-gray-500/50",     group: "non_pnl" },
  unknown:             { label: "Needs Review",        color: "bg-zinc-500/80 border-zinc-400/50",     group: "review" },
}

export const PNL_CLASSES = new Set<MovementClass>([
  "customer_cash_in", "vendor_cash_out", "bank_fee", "refund", "interest",
])

export function isClassPnlEligible(mc: MovementClass): boolean {
  return PNL_CLASSES.has(mc)
}

// ─── Phase 1: Structural Tagging Layer ──────────────────────────────
//
// Tags convert classified movements into state-readable business semantics.
// The state engine reads tags, never raw bank text.

export type EconomicClass =
  | "customer_receipt"
  | "vendor_payment"
  | "payroll"
  | "bank_fee"
  | "transfer"
  | "owner_contribution"
  | "owner_draw"
  | "processor_fee"
  | "processor_payout"
  | "refund"
  | "tax"
  | "debt_payment"
  | "interest"
  | "adjustment"
  | "unknown"

export type CashflowBucket =
  | "revenue_in"
  | "cogs_out"
  | "opex_out"
  | "financing_in"
  | "financing_out"
  | "transfer"
  | "settlement"
  | "unknown"

export type CounterpartyRole =
  | "customer"
  | "vendor"
  | "owner"
  | "employee"
  | "processor"
  | "bank"
  | "tax_authority"
  | "lender"
  | "marketplace"
  | "unknown"

export type MovementTag = {
  movement_id: string

  economic_class: EconomicClass
  cashflow_bucket: CashflowBucket
  counterparty_role: CounterpartyRole

  is_operating: boolean
  is_financing: boolean
  is_investing: boolean
  is_owner_related: boolean
  hits_pnl: boolean
  hits_working_capital: boolean

  classification_confidence: number
  evidence_strength: number
  needs_review: boolean
  review_reasons: string[]

  entity_id: string | null
  customer_id: string | null
  vendor_id: string | null
  processor_id: string | null
  account_id: string | null
  order_id: string | null
  invoice_id: string | null
  bill_id: string | null

  recurrence_family_id: string | null
  is_recurring: boolean
  is_anomaly: boolean
  is_large_outlier: boolean
  is_first_seen_counterparty: boolean
}
