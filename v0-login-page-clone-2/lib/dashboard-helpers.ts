export function money(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "$0.00"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export function signedMoney(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "$0.00"
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value))
  return value >= 0 ? `+${formatted}` : `-${formatted}`
}

export function cashDisplay(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "$0.00"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export function pct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "0%"
  return `${Math.round(value * 100)}%`
}

export function confPct(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0
  return Math.round(value * 100)
}

export function sourceColor(s: string): string {
  switch (s) {
    case "qbo":
      return "bg-blue-500/80 border-blue-400/50"
    case "xero":
      return "bg-emerald-500/80 border-emerald-400/50"
    case "stripe":
      return "bg-purple-500/80 border-purple-400/50"
    case "plaid":
      return "bg-amber-500/80 border-amber-400/50"
    case "gmail":
      return "bg-red-500/80 border-red-400/50"
    case "system":
      return "bg-white/30 border-white/20"
    default:
      return "bg-zinc-500/80 border-zinc-400/50"
  }
}

export function typeColor(t: string): string {
  switch (t) {
    case "vendor":
      return "bg-orange-500/80 border-orange-400/50"
    case "customer":
      return "bg-cyan-500/80 border-cyan-400/50"
    case "processor":
      return "bg-violet-500/80 border-violet-400/50"
    case "employee":
      return "bg-pink-500/80 border-pink-400/50"
    case "internal":
      return "bg-yellow-500/80 border-yellow-400/50"
    case "owner":
      return "bg-rose-500/80 border-rose-400/50"
    case "bank_account":
      return "bg-slate-500/80 border-slate-400/50"
    case "tax_authority":
      return "bg-red-700/80 border-red-600/50"
    case "lender":
      return "bg-indigo-500/80 border-indigo-400/50"
    default:
      return "bg-zinc-500/80 border-zinc-400/50"
  }
}

export function typeLabel(t: string): string {
  switch (t) {
    case "bank_account":
      return "bank acct"
    case "tax_authority":
      return "tax auth"
    case "unknown":
      return "unclassified"
    default:
      return t
  }
}

export function confColor(c: number): string {
  if (c >= 0.9) return "bg-emerald-400"
  if (c >= 0.7) return "bg-amber-400"
  return "bg-red-400"
}

export function riskColor(level: "low" | "medium" | "high"): string {
  switch (level) {
    case "low":
      return "text-emerald-400/90"
    case "medium":
      return "text-amber-400/90"
    case "high":
      return "text-red-400/80"
    default:
      return "text-zinc-400"
  }
}

export function riskBg(level: "low" | "medium" | "high"): string {
  switch (level) {
    case "low":
      return "bg-emerald-500/10 border-emerald-400/20"
    case "medium":
      return "bg-amber-500/10 border-amber-400/20"
    case "high":
      return "bg-red-500/10 border-red-400/20"
    default:
      return "bg-zinc-500/10 border-zinc-400/20"
  }
}

export function riskBarColor(level: "low" | "medium" | "high"): string {
  switch (level) {
    case "low":
      return "bg-emerald-500/80"
    case "medium":
      return "bg-amber-500/80"
    case "high":
      return "bg-red-500/80"
    default:
      return "bg-zinc-500/80"
  }
}

export function regimeColor(regime: "strong" | "stable" | "tightening"): string {
  switch (regime) {
    case "strong":
      return "text-emerald-400/90"
    case "stable":
      return "text-blue-400/90"
    case "tightening":
      return "text-amber-400/90"
    default:
      return "text-zinc-400"
  }
}

export function regimeBg(regime: "strong" | "stable" | "tightening"): string {
  switch (regime) {
    case "strong":
      return "bg-emerald-500/10 border-emerald-400/20"
    case "stable":
      return "bg-blue-500/10 border-blue-400/20"
    case "tightening":
      return "bg-amber-500/10 border-amber-400/20"
    default:
      return "bg-zinc-500/10 border-zinc-400/20"
  }
}

export function archetypeLabel(archetype: string): string {
  switch (archetype) {
    case "clockwork":
      return "Clockwork"
    case "slow_reliable":
      return "Reliable"
    case "bursty":
      return "Bursty"
    case "volatile":
      return "Volatile"
    case "low_data":
      return "New"
    default:
      return archetype
  }
}

export function archetypeColor(archetype: string): string {
  switch (archetype) {
    case "clockwork":
      return "bg-emerald-500/80 border-emerald-400/50"
    case "slow_reliable":
      return "bg-blue-500/80 border-blue-400/50"
    case "bursty":
      return "bg-amber-500/80 border-amber-400/50"
    case "volatile":
      return "bg-red-500/80 border-red-400/50"
    case "low_data":
      return "bg-gray-500/80 border-gray-400/50"
    default:
      return "bg-zinc-500/80 border-zinc-400/50"
  }
}

export function behaviorLabel(behavior: string): string {
  switch (behavior) {
    case "recurring":
      return "Recurring"
    case "episodic":
      return "Episodic"
    case "seasonal":
      return "Seasonal"
    case "one_time":
      return "One-time"
    default:
      return behavior
  }
}

export function provenanceLabel(provenance: string): string {
  switch (provenance) {
    case "coalesced":
      return "Coalesced"
    case "bank_observed":
      return "Bank Observed"
    case "accounting_observed":
      return "Accounting Observed"
    default:
      return "Unknown"
  }
}

export function provenanceColor(provenance: string): string {
  switch (provenance) {
    case "coalesced":
      return "bg-emerald-500/80 border-emerald-400/50"
    case "bank_observed":
      return "bg-amber-500/80 border-amber-400/50"
    case "accounting_observed":
      return "bg-blue-500/80 border-blue-400/50"
    default:
      return "bg-zinc-500/80 border-zinc-400/50"
  }
}

export const CLASS_META: Record<
  string,
  { label: string; color: string; group: "pnl" | "non_pnl" | "review" }
> = {
  customer_cash_in: {
    label: "Customer Cash In",
    color: "bg-emerald-500/80 border-emerald-400/50",
    group: "pnl",
  },
  vendor_cash_out: {
    label: "Vendor Cash Out",
    color: "bg-orange-500/80 border-orange-400/50",
    group: "pnl",
  },
  bank_fee: {
    label: "Bank Fee",
    color: "bg-red-500/80 border-red-400/50",
    group: "pnl",
  },
  bank_fee_refund: {
    label: "Bank Fee Refund",
    color: "bg-red-400/60 border-red-300/40",
    group: "pnl",
  },
  refund: {
    label: "Refund",
    color: "bg-amber-500/80 border-amber-400/50",
    group: "pnl",
  },
  interest: {
    label: "Interest",
    color: "bg-teal-500/80 border-teal-400/50",
    group: "pnl",
  },
  processor_fee: {
    label: "Processor Fee",
    color: "bg-violet-700/80 border-violet-600/50",
    group: "pnl",
  },
  internal_transfer: {
    label: "Internal Transfer",
    color: "bg-slate-500/80 border-slate-400/50",
    group: "non_pnl",
  },
  processor_payout: {
    label: "Processor Payout",
    color: "bg-violet-500/80 border-violet-400/50",
    group: "non_pnl",
  },
  credit_card_payment: {
    label: "Credit Card Payment",
    color: "bg-indigo-500/80 border-indigo-400/50",
    group: "non_pnl",
  },
  owner_contribution: {
    label: "Owner Contribution",
    color: "bg-rose-500/80 border-rose-400/50",
    group: "non_pnl",
  },
  owner_draw: {
    label: "Owner Draw",
    color: "bg-rose-500/80 border-rose-400/50",
    group: "non_pnl",
  },
  merchant_deposit: {
    label: "Merchant Deposit",
    color: "bg-cyan-500/80 border-cyan-400/50",
    group: "non_pnl",
  },
}

export const DETAIL_LABELS: Record<string, string> = {
  economic_class: "Economic Class",
  cashflow_bucket: "Cashflow Bucket",
  counterparty_role: "Counterparty Role",
  is_operating: "Operating",
  is_financing: "Financing",
  is_investing: "Investing",
  is_owner_related: "Owner Related",
  hits_pnl: "Hits P&L",
  hits_working_capital: "Hits Working Capital",
  is_recurring: "Recurring",
  is_anomaly: "Anomaly",
  is_large_outlier: "Large Outlier",
  is_first_seen_counterparty: "First Seen Counterparty",
}

export const BUCKET_LABELS: Record<string, string> = {
  operating_revenue: "Operating Revenue",
  operating_expense: "Operating Expense",
  financing_inflow: "Financing Inflow",
  financing_outflow: "Financing Outflow",
  investing_inflow: "Investing Inflow",
  investing_outflow: "Investing Outflow",
  settlement: "Settlement",
  owner_activity: "Owner Activity",
  transfer: "Transfer",
  unclassified: "Unclassified",
}

export const ROLE_LABELS: Record<string, string> = {
  customer: "Customer",
  vendor: "Vendor",
  processor: "Processor",
  bank: "Bank",
  owner: "Owner",
  employee: "Employee",
  tax_authority: "Tax Authority",
  lender: "Lender",
  internal: "Internal",
  unknown: "Unknown",
}
