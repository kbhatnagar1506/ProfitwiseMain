// ─── Cashflow Simulation Engine (v2: Entity-Level Behavioral Models) ─
//
// Architecture:
//   movement history
//   → behavioral models (per customer, per vendor, settlement, transfers, recurring)
//   → future event generators
//   → cashflow simulator
//   → scenario engine
//   → forecast outputs
//
// Each entity (customer, vendor) gets its own payment rhythm model.
// Settlement gets a delay distribution model.
// Transfers get a human-behavior trigger model.
// This is behavioral simulation, not time-series ML.

const FORECAST_ENGINE_VERSION = "2.2"
const MODEL_VERSION = "2.2"
const TAGGING_VERSION = "1.0"
const POLICY_VERSION = "1.0"

import { extractEntityFromRawDescriptor } from "@/lib/alias-normalize"
import type { CanonicalMovement, MovementTag } from "@/lib/movement-types"
import type { EntityPaymentProfile } from "./types"
import { log } from "@/lib/logger"
import {
  fetchReconciledARMovements,
  fetchReconciledAPMovements,
  buildReconciledCustomerModels,
  buildReconciledVendorModels,
} from "@/lib/reconciled-models"
import {
  buildCompleteEntityGraph,
  type EntityGraphMap,
} from "@/lib/entity-graph-analysis"
import {
  clusterEntities,
  type ClusteringResult,
} from "@/lib/entity-clustering"
import {
  boostCustomerConfidenceFromGraph,
  boostVendorConfidenceFromGraph,
  calculateEntityGraphCoverage,
  logEntityGraphBoosting,
} from "@/lib/entity-graph-integration"
import {
  DEFAULT_FORECAST_CALIBRATION,
  mergeCalibration,
  computeCalibrationHash,
  type ForecastCalibrationParams,
} from "./forecast-calibration"
import type {
  BacktestByHorizon,
  BacktestBySegment,
  BaselineComparison,
  CashflowComponent,
  ComponentBehavior,
  ComponentConfidence,
  CustomerModel,
  CustomerArchetype,
  CustomerFeatures,
  ForecastConfidenceComponents,
  InflowEventClass,
  OutflowEventClass,
  InvoiceForecast,
  RecurrenceModel,
  RecurrenceType,
  VendorArchetype,
  VendorFeatures,
  VendorModel,
  SettlementModel,
  ProcessorSettlementProfile,
  TransferBehaviorModel,
  BehavioralModels,
  OutstandingInvoice,
  OutstandingBill,
  InvoiceSignal,
  ForecastEvent,
  EventReasoning,
  DailySimDay,
  DailySimulation,
  MonteCarloPercentile,
  DayScenarioSnapshot,
  MonteCarloResult,
  ForecastNarrative,
  ForecastMonth,
  ScenarioResult,
  SeparatedForecast,
  SeparatedForecastDay,
  CashflowForecast,
  ForecastConfidence,
  ForecastMetadata,
  IdentityBreakdown,
  ForecastContext,
  CashRunway,
  SensitivityDriver,
  SensitivityAnalysis,
  Intervention,
  ActionSimulationImpact,
  ScenarioDriver,
  BacktestResult,
  CalibrationResult,
  CombinedStrategy,
  SeasonalityPattern,
} from "./types"

type TaggedMovement = CanonicalMovement & { tag: MovementTag }
type ComponentCategory = CashflowComponent["category"]

function isInflow(m: TaggedMovement): boolean {
  return m.direction === "inflow"
}
function isOutflow(m: TaggedMovement): boolean {
  return m.direction === "outflow"
}

// ─── Utilities ──────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000))
}

function monthKey(date: string): string {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

function addDays(date: string, days: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + Math.round(days))
  return d.toISOString().slice(0, 10)
}

function monthIndex(date: string, refDate: Date): number {
  const d = new Date(date)
  return (d.getFullYear() - refDate.getFullYear()) * 12 + (d.getMonth() - refDate.getMonth())
}

function std(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

const r2 = (n: number) => Math.round(n * 100) / 100

// ─── Seeded PRNG (mulberry32) for reproducible Monte Carlo ──────────
// Seed is derived from date + userId so results are stable within a day

function mulberry32(seed: number): () => number {
  return function() {
    let t = seed += 0x6D2B79F5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash)
}

let _prng: () => number = Math.random

export function seedPrng(userId: string, date?: string): void {
  const dateStr = date ?? new Date().toISOString().slice(0, 10)
  const seed = hashString(`${userId}-${dateStr}`)
  _prng = mulberry32(seed)
}

export function resetPrng(): void {
  _prng = Math.random
}

function seededRandom(): number {
  return _prng()
}

function toDateStr(d: unknown): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  if (typeof d === "string") return d.slice(0, 10)
  return new Date().toISOString().slice(0, 10)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type IdentityContext = {
  entityNames: Map<string, string>
  entityTypes: Map<string, string>
  aliasToEntityId: Map<string, string>
  counterpartyByMovement: Map<string, string>
  familyMembers: Map<string, { occurrences: number; dominantType: string; pattern: string }>
}

let _ctx: IdentityContext = {
  entityNames: new Map(),
  entityTypes: new Map(),
  aliasToEntityId: new Map(),
  counterpartyByMovement: new Map(),
  familyMembers: new Map(),
}

export function setIdentityContext(ctx: IdentityContext) { _ctx = ctx }

function cleanDescriptor(raw: string): string {
  let name = raw
    .replace(/^PREAUTHORIZED ACH CREDIT\s*/i, "")
    .replace(/^ACH CREDIT\s*/i, "")
    .replace(/^ACH DEBIT\s*/i, "")
    .replace(/^WIRE (CREDIT|DEBIT)\s*/i, "")
    .replace(/^ONLINE (PAYMENT|TRANSFER)\s*/i, "")
    .replace(/\s+ST-[A-Z0-9]+$/i, "")
    .replace(/\s+\d{6,}$/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
  if (!name) return ""
  if (name === name.toUpperCase() && name.length > 3) {
    name = name.split(/[\s/]+/).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ")
  }
  return name.slice(0, 40)
}

function resolveEntityId(m: TaggedMovement): string {
  // Prefer typed IDs from tag_data (these are entity graph UUIDs)
  const t = m.tag
  if (t.customer_id) return t.customer_id
  if (t.vendor_id) return t.vendor_id
  if (m.entity_id) return m.entity_id

  // Try alias reverse lookup from counterparty string to collapse fragmented entries
  const cp = observedCounterparty(m)
  if (cp) {
    for (const prefix of ["name", "merchant_string", "account_ref"]) {
      const resolved = _ctx.aliasToEntityId.get(`${prefix}:${cp.toLowerCase()}`)
      if (resolved) return resolved
    }
  }

  // Fall back to raw description as grouping key
  return m.raw_description ?? "unknown"
}

function observedCounterparty(m: TaggedMovement): string | null {
  const fromObs = _ctx.counterpartyByMovement.get(m.id)
  if (fromObs) return fromObs
  const fromMeta = m.metadata?.counterparty as string | undefined
  if (fromMeta && !UUID_RE.test(fromMeta)) return fromMeta
  return null
}

function resolveEntityName(entityId: string | undefined | null, counterparty: string | undefined | null, rawDesc: string | undefined | null, role: string = "entity"): string {
  // 1. Canonical name from identity graph
  if (entityId && _ctx.entityNames.has(entityId)) return _ctx.entityNames.get(entityId)!

  // 2. Try alias reverse lookup → graph name
  if (counterparty) {
    const aliasKey = `name:${counterparty.toLowerCase()}`
    const resolved = _ctx.aliasToEntityId.get(aliasKey)
    if (resolved && _ctx.entityNames.has(resolved)) return _ctx.entityNames.get(resolved)!
  }

  // 3. Extract from raw descriptor patterns (TEAM1234/Payment 30280, etc.)
  const extracted = extractEntityFromRawDescriptor(counterparty ?? rawDesc ?? "")
  if (extracted) return extracted

  // 4. Counterparty from observation/metadata (if clean)
  if (counterparty && !UUID_RE.test(counterparty)) {
    const cleaned = cleanDescriptor(counterparty)
    if (cleaned.length >= 2) return cleaned
  }

  // 5. Cleaned descriptor
  if (rawDesc && !UUID_RE.test(rawDesc)) {
    const cleaned = cleanDescriptor(rawDesc)
    if (cleaned.length >= 2) return cleaned
  }

  // 6. Role-based fallback with short ID fragment (never "Unnamed entity")
  const shortId = (entityId ?? "").slice(0, 4).toUpperCase() || Math.random().toString(36).slice(2, 6).toUpperCase()
  const roleLabel = role === "customer" ? "Customer" : role === "vendor" ? "Vendor" : role === "processor" ? "Processor" : "Entity"
  return `${roleLabel} #${shortId}`
}

// ─── Step 1: Decompose (same as v1) ────────────────────────────────

function categorize(m: TaggedMovement): { category: ComponentCategory; direction: "in" | "out"; label: string } | null {
  const t = m.tag
  if (t.state_inclusion_policy === "exclude_and_review") return null
  const dir = isInflow(m) ? "in" as const : "out" as const
  const scope = t.state_scope

  // Use state_scope for precise flow gating when available
  if (scope && !scope.affects_liquidity && t.economic_class !== "transfer") return null

  switch (t.economic_class) {
    case "customer_receipt": return { category: "customer_receipts", direction: "in", label: "Customer receipts" }
    case "processor_payout": return { category: "processor_payouts", direction: "in", label: "Processor payouts" }
    case "owner_contribution": return { category: "owner_contributions", direction: "in", label: "Owner contributions" }
    case "vendor_payment": return { category: "vendor_payments", direction: "out", label: "Vendor payments" }
    case "payroll": return { category: "recurring_expenses", direction: "out", label: "Payroll" }
    case "processor_fee": return { category: "processor_fees", direction: "out", label: "Processor fees" }
    case "debt_payment": return { category: "debt_payments", direction: "out", label: "Debt payments" }
    case "bank_fee": case "bank_fee_refund": return { category: "recurring_expenses", direction: dir, label: "Bank fees" }
    case "transfer": return { category: "transfers", direction: dir, label: "Transfers" }
    case "interest": return { category: "financing_in", direction: dir, label: "Interest" }
    case "refund": return { category: "other", direction: "out", label: "Refunds" }
    case "tax": return { category: "recurring_expenses", direction: "out", label: "Taxes" }
    default: return { category: "other", direction: dir, label: t.economic_class || "Other" }
  }
}

// ─── Event Classification (before forecasting) ───────────────────────
//
// Classify each movement into inflow/outflow behavior classes.
// Used to route events through class-specific generators.

export function classifyEventBehavior(
  m: TaggedMovement,
  models?: BehavioralModels,
): InflowEventClass | OutflowEventClass {
  const cat = categorize(m)
  if (!cat) return "unknown"

  if (cat.direction === "in") {
    switch (m.tag.economic_class) {
      case "processor_payout":
        return "processor_settlement"
      case "owner_contribution":
        return "owner_support"
      case "transfer":
        return "treasury_transfer"
      case "customer_receipt": {
        if (models) {
          const entityId = resolveEntityId(m)
          const cust = models.customers.find((c) => c.entity_id === entityId)
          if (cust) {
            if (cust.outstanding_invoices.some((i) => i.status === "overdue")) return "overdue_receivable"
            if (cust.archetype === "clockwork") return "clockwork_receivable"
            if (cust.archetype === "episodic" || cust.archetype === "volatile") return "sporadic_receivable"
          }
        }
        const td = (m.tag as unknown as { tag_data?: { invoice_status?: string } }).tag_data ?? {}
        if (td.invoice_status === "overdue") return "overdue_receivable"
        return "likely_receivable"
      }
      default:
        return "unknown"
    }
  }

  if (cat.direction === "out") {
    switch (m.tag.economic_class) {
      case "payroll":
        return "payroll_fixed"
      case "processor_fee":
        return "processor_fees"
      case "bank_fee":
      case "bank_fee_refund":
        return "bank_fees"
      case "owner_draw":
        return "owner_draw"
      case "transfer":
        return "treasury_transfer"
      case "vendor_payment": {
        if (models) {
          const entityId = resolveEntityId(m)
          const vend = models.vendors.find((v) => v.entity_id === entityId)
          if (vend) {
            if (vend.outstanding_bills.length > 0) return "ap_due_driven"
            if (vend.recurrence.recurrence_type === "hard" || vend.recurrence.recurrence_type === "soft")
              return "contractual_recurring"
            return "discretionary_vendor"
          }
        }
        const td = (m.tag as unknown as { tag_data?: { recurrence_type?: string; has_bill?: boolean } }).tag_data ?? {}
        if (td.has_bill || td.recurrence_type === "invoice_triggered") return "ap_due_driven"
        if (td.recurrence_type === "hard" || td.recurrence_type === "soft") return "contractual_recurring"
        return "discretionary_vendor"
      }
      default:
        return "unknown"
    }
  }

  return "unknown"
}

// ─── Step 2a: Customer Behavioral Models ────────────────────────────
//
// Each customer is classified into an archetype that drives forecast logic:
//   clockwork  → tight cadence model (interval ± small variance)
//   bursty     → hazard model with wider variance bands
//   episodic   → opportunity-weighted, not cadence
//   slow_reliable → invoice-aging driven, consistently late
//   volatile   → erratic, large confidence penalty
//   low_data   → <3 payments, anchor to invoices with sparse penalty

function sigmoidDecay(overdueRatio: number, cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): number {
  return 1 / (1 + Math.exp(cal.sigmoid_decay.steepness * (overdueRatio - cal.sigmoid_decay.midpoint)))
}

// Cohort statistics computed from actual payment data
type CohortStats = {
  avg_prob_7d: number
  avg_prob_14d: number
  avg_prob_30d: number
  avg_interval: number
  sample_count: number
}

// Global cohort stats - will be populated from actual data
let globalCohortStats: CohortStats | null = null

function computeCohortStats(customerModels: CustomerModel[], cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): CohortStats {
  // Compute cohort-level statistics from customers with actual payment history
  const withHistory = customerModels.filter(c => c.payment_count >= 3)
  
  if (withHistory.length === 0) {
    return {
      avg_prob_7d: cal.cohort_prior_fallback.avg_prob_7d,
      avg_prob_14d: cal.cohort_prior_fallback.avg_prob_14d,
      avg_prob_30d: cal.cohort_prior_fallback.avg_prob_30d,
      avg_interval: 30,
      sample_count: 0,
    }
  }
  
  // Compute average probability from customers with history
  // Probability = 1 / (1 + days_since_last / avg_interval) weighted by payment count
  let totalWeight = 0
  let weightedProb7 = 0
  let weightedProb14 = 0
  let weightedProb30 = 0
  let weightedInterval = 0
  
  for (const c of withHistory) {
    const weight = Math.log(1 + c.payment_count) // Log-weighted by payment count
    totalWeight += weight
    
    // Derive probabilities from interval distribution
    const interval = c.payment_interval_days || 30
    const variance = c.interval_variance || interval * cal.cohort_prior_fallback.default_variance_mult
    
    // Probability of payment within N days given interval and variance
    // Using cumulative normal approximation
    const prob7 = normalCdf(7, interval, variance)
    const prob14 = normalCdf(14, interval, variance)
    const prob30 = normalCdf(30, interval, variance)
    
    weightedProb7 += prob7 * weight
    weightedProb14 += prob14 * weight
    weightedProb30 += prob30 * weight
    weightedInterval += interval * weight
  }
  
  return {
    avg_prob_7d: r2(weightedProb7 / totalWeight),
    avg_prob_14d: r2(weightedProb14 / totalWeight),
    avg_prob_30d: r2(weightedProb30 / totalWeight),
    avg_interval: r2(weightedInterval / totalWeight),
    sample_count: withHistory.length,
  }
}

// Cumulative normal distribution approximation
function normalCdf(x: number, mean: number, std: number): number {
  if (std <= 0) return x >= mean ? 1 : 0
  const z = (x - mean) / std
  // Approximation of standard normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp(-z * z / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}

function getCohortPrior(
  archetype: string,
  cohortStats: CohortStats | null,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): { prob: number; interval: number } {
  // If we have cohort data, use it as the base and adjust by archetype
  if (cohortStats && cohortStats.sample_count > 0) {
    const mult = cal.archetype_multipliers[archetype as keyof typeof cal.archetype_multipliers] ?? { probMult: 1.0, intervalMult: 1.0 }
    return {
      prob: Math.min(cal.probability_ceiling, cohortStats.avg_prob_30d * mult.probMult),
      interval: cohortStats.avg_interval * mult.intervalMult,
    }
  }
  
  // Fallback to uninformative priors if no cohort data
  return cal.archetype_fallbacks[archetype as keyof typeof cal.archetype_fallbacks] ?? { prob: 0.3, interval: 30 }
}

function classifyCustomerArchetype(
  paymentCount: number,
  intervalCv: number,
  avgDaysToPay: number,
  amountCv: number,
  recentTrend: "accelerating" | "decelerating" | "stable" | "insufficient",
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): CustomerArchetype {
  if (paymentCount < 3) return "low_data"
  if (intervalCv < cal.archetype_clockwork_interval_cv_max && amountCv < cal.archetype_clockwork_amount_cv_max) return "clockwork"
  if (intervalCv > cal.archetype_volatile_interval_cv_min && paymentCount >= 3) return "volatile"
  if (avgDaysToPay > cal.archetype_slow_reliable_avg_days_min && intervalCv < cal.archetype_residual.slow_reliable_cv) return "slow_reliable"
  if (intervalCv > cal.archetype_bursty_interval_cv_range[0] && intervalCv <= cal.archetype_bursty_interval_cv_range[1]) return "bursty"
  if (paymentCount >= cal.archetype_episodic_payment_count_range[0] && paymentCount <= cal.archetype_episodic_payment_count_range[1] && intervalCv > cal.archetype_residual.episodic_cv) return "episodic"
  if (intervalCv < cal.archetype_residual.clockwork_cv) return "clockwork"
  return "bursty"
}

function computeCustomerFeatures(
  payments: { amount: number; date: string; confidence: number }[],
  invoiceCount: number,
  overdueCount: number,
  now: string,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): CustomerFeatures {
  const amounts = payments.map((p) => p.amount)
  const amountMean = amounts.reduce((a, b) => a + b, 0) / amounts.length
  const amountStd = std(amounts)

  const intervals: number[] = []
  for (let i = 1; i < payments.length; i++) {
    intervals.push(daysBetween(payments[i - 1].date, payments[i].date))
  }
  const avgInterval = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0
  const stdInterval = std(intervals)
  const intervalCv = avgInterval > 0 ? stdInterval / avgInterval : 999

  const cf = cal.customer_features
  let recentTrend: CustomerFeatures["recent_trend"] = "insufficient"
  if (payments.length >= 4) {
    const mid = Math.floor(payments.length / 2)
    const firstAvg = amounts.slice(0, mid).reduce((a, b) => a + b, 0) / mid
    const secondAvg = amounts.slice(mid).reduce((a, b) => a + b, 0) / (amounts.length - mid)
    if (firstAvg > 0) {
      const ratio = secondAvg / firstAvg
      recentTrend = ratio > cf.accel_threshold ? "accelerating" : ratio < cf.decel_threshold ? "decelerating" : "stable"
    }
  }

  const lastDate = payments[payments.length - 1].date
  const recencyDays = daysBetween(lastDate, now)

  const dayOfWeek = payments.map((p) => new Date(p.date).getDay())
  const dayCounts = new Array(7).fill(0)
  dayOfWeek.forEach((d) => dayCounts[d]++)
  const maxDay = Math.max(...dayCounts)
  const weekdayBias = payments.length >= cf.weekday_min_payments && maxDay / payments.length > cf.weekday_bias_threshold
    ? dayOfWeek[dayCounts.indexOf(maxDay)]
    : null

  const avg_dso = avgInterval
  const dso_variance = stdInterval
  const pct_overdue_paid = overdueCount > 0 && invoiceCount > 0 ? r2(1 - overdueCount / Math.max(invoiceCount, 1)) : 1
  const amount_elasticity = amountMean > 0 && amountStd > 0 ? r2(amountStd / amountMean) : 0
  const dataSpanMonths = payments.length >= 2 ? daysBetween(payments[0].date, payments[payments.length - 1].date) / 30 : 1
  const monthly_cadence = dataSpanMonths > 0 ? r2(payments.length / dataSpanMonths) : 0
  const last_3_intervals = intervals.slice(-3)
  const payer_reliability_cluster = intervalCv < cf.reliable_cv ? "reliable" : intervalCv < cf.moderate_cv ? "moderate" : "volatile"

  return {
    payment_count: payments.length,
    invoice_count: invoiceCount,
    paid_vs_unpaid_ratio: invoiceCount > 0 ? payments.length / invoiceCount : 1,
    avg_days_to_pay: avgInterval,
    std_days_to_pay: stdInterval,
    amount_mean: r2(amountMean),
    amount_std: r2(amountStd),
    interval_cv: r2(intervalCv),
    recent_trend: recentTrend,
    last_payment_recency_days: recencyDays,
    overdue_count: overdueCount,
    weekday_bias: weekdayBias,
    avg_dso,
    dso_variance: r2(dso_variance),
    pct_overdue_paid,
    amount_elasticity,
    monthly_cadence,
    last_3_intervals,
    payer_reliability_cluster,
  }
}

function buildInvoiceForecasts(
  customerInvoices: OutstandingInvoice[],
  features: CustomerFeatures,
  archetype: CustomerArchetype,
  now: string,
  portfolioPriors?: PortfolioPriors,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): InvoiceForecast[] {
  const forecasts: InvoiceForecast[] = []
  const dso = features.avg_days_to_pay
  const priors = portfolioPriors ?? defaultPortfolioPriors(cal)

  for (const inv of customerInvoices) {
    const daysOverdue = inv.days_overdue ?? 0
    const daysUntilDue = inv.days_until_due ?? 0

    // Compute base probability from portfolio priors and archetype
    const archetypeMultiplier = priors.archetype_multipliers[archetype] ?? 1.0
    
    // Time-based probability: closer to due date = higher probability
    // Uses logistic function centered on due date
    const timeScore = daysOverdue > 0
      ? Math.min(1, 0.5 + daysOverdue / (priors.avg_collection_delay * 2))
      : Math.max(0, 1 - daysUntilDue / 30)
    
    // Compute probabilities for each horizon using portfolio data
    let p7 = priors.base_p7 * archetypeMultiplier * (daysOverdue > 0 ? cal.reconciliation_matched_boost_p7 : timeScore)
    let p14 = priors.base_p14 * archetypeMultiplier * (daysOverdue > 0 ? cal.reconciliation_matched_boost_p14 : Math.max(timeScore, 0.5))
    let p30 = priors.base_p30 * archetypeMultiplier
    
    // Adjust for customer-specific DSO if available
    if (dso > 0 && features.payment_count >= 2) {
      const dsoFactor = Math.max(cal.invoice_dso_factor_min, Math.min(cal.invoice_dso_factor_max, priors.avg_collection_delay / dso))
      p7 *= dsoFactor
      p14 *= dsoFactor
      p30 *= Math.sqrt(dsoFactor)
    }
    
    // Reliability adjustment based on payment history
    if (features.payer_reliability_cluster === "reliable") {
      p7 *= 1.3; p14 *= 1.2; p30 *= 1.1
    } else if (features.payer_reliability_cluster === "volatile") {
      p7 *= cal.invoice_volatile_penalty_p7; p14 *= cal.invoice_volatile_penalty_p14; p30 *= cal.invoice_volatile_penalty_p30
    }
    
    // Reconciliation status adjustment: matched invoices have higher collection probability
    if (inv.reconciliation_status === "matched") {
      p7 = Math.min(cal.probability_ceiling, p7 * cal.reconciliation_matched_boost_p7)
      p14 = Math.min(cal.probability_ceiling, p14 * cal.reconciliation_matched_boost_p14)
      p30 = Math.min(cal.probability_ceiling, p30 * cal.reconciliation_matched_boost_p30)
    } else if (inv.reconciliation_status === "partial" && inv.matched_amount) {
      const matchedPct = inv.matched_amount / inv.amount
      const boost = 1 + matchedPct * cal.reconciliation_partial_boost_factor
      p7 *= boost; p14 *= boost; p30 *= boost
    }
    
    // Cap probabilities
    p7 = Math.min(cal.probability_ceiling, Math.max(cal.probability_floor, p7))
    p14 = Math.min(cal.probability_ceiling, Math.max(p7, p14))
    p30 = Math.min(cal.probability_ceiling, Math.max(p14, p30))
    
    // Expected collection date based on DSO or due date
    let expectedDate: string
      if (daysOverdue > 0) {
      const expectedDelay = dso > 0 ? Math.max(1, dso - daysOverdue) : priors.avg_collection_delay
      expectedDate = addDays(now, Math.max(1, Math.round(expectedDelay)))
    } else if (dso > 0) {
      expectedDate = inv.due_date ? addDays(inv.due_date, Math.round(dso)) : addDays(now, Math.round(dso))
      } else {
      expectedDate = inv.due_date ?? addDays(now, priors.avg_collection_delay)
    }
    
    // Build reasoning from data
    const reasoning = buildInvoiceReasoning(archetype, features, daysOverdue, daysUntilDue, dso, priors)

    forecasts.push({
      invoice_id: inv.invoice_id,
      customer_name: inv.customer_name,
      amount_due: inv.amount_due,
      due_date: inv.due_date,
      days_overdue: inv.days_overdue,
      customer_dso: r2(dso),
      probability_7d: r2(p7),
      probability_14d: r2(p14),
      probability_30d: r2(p30),
      expected_collection_date: expectedDate,
      expected_amount: r2(inv.amount_due),
      reasoning,
    })
  }

  return forecasts
}

type PortfolioPriors = {
  base_p7: number
  base_p14: number
  base_p30: number
  avg_collection_delay: number
  archetype_multipliers: Record<CustomerArchetype, number>
}

function defaultPortfolioPriors(cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): PortfolioPriors {
  return {
    base_p7: cal.portfolio_prior_base_p7,
    base_p14: cal.portfolio_prior_base_p14,
    base_p30: cal.portfolio_prior_base_p30,
    avg_collection_delay: cal.portfolio_prior_avg_collection_delay,
    archetype_multipliers: { ...cal.portfolio_prior.archetype_weights },
  }
}

function computePortfolioPriors(
  movements: TaggedMovement[],
  invoices: OutstandingInvoice[],
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): PortfolioPriors {
  const priors = defaultPortfolioPriors(cal)
  const pp = cal.portfolio_prior
  
  const customerReceipts = movements.filter(m => 
    m.tag?.economic_class === "customer_receipt" && m.direction === "inflow"
  )
  
  if (customerReceipts.length < pp.min_receipts) {
    return priors
  }
  
  const byMonth = new Map<string, number[]>()
  for (const m of customerReceipts) {
    const month = monthKey(m.occurred_at)
    const arr = byMonth.get(month) ?? []
    arr.push(m.amount)
    byMonth.set(month, arr)
  }
  
  const monthCount = byMonth.size
  const avgPaymentsPerMonth = customerReceipts.length / Math.max(1, monthCount)
  
  const frequencyFactor = Math.min(pp.frequency_cap, avgPaymentsPerMonth / pp.frequency_divisor)
  priors.base_p7 = Math.min(pp.p7_cap, pp.p7_base + pp.p7_freq_mult * frequencyFactor)
  priors.base_p14 = Math.min(pp.p14_cap, priors.base_p7 + pp.p14_offset + pp.p14_freq_mult * frequencyFactor)
  priors.base_p30 = Math.min(pp.p30_cap, priors.base_p14 + pp.p30_offset + pp.p30_freq_mult * frequencyFactor)
  
  const paidInvoices = invoices.filter(i => i.status === "paid" && i.due_date)
  if (paidInvoices.length >= pp.min_paid_invoices) {
    const avgDelay = paidInvoices.reduce((sum, i) => {
      const delay = i.days_overdue ?? 0
      return sum + Math.max(0, delay)
    }, 0) / paidInvoices.length
    priors.avg_collection_delay = Math.max(pp.collection_delay_clamp_min, Math.min(pp.collection_delay_clamp_max, avgDelay + pp.delay_base_offset))
  } else if (customerReceipts.length >= pp.min_receipts_interval) {
    const intervals: number[] = []
    const sorted = [...customerReceipts].sort((a, b) =>
      toDateStr(a.occurred_at).localeCompare(toDateStr(b.occurred_at)),
    )
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(daysBetween(toDateStr(sorted[i - 1].occurred_at), toDateStr(sorted[i].occurred_at)))
    }
    if (intervals.length > 0) {
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length
      priors.avg_collection_delay = Math.max(pp.collection_delay_clamp_min, Math.min(pp.collection_delay_clamp_max, avgInterval))
    }
  }
  
  return priors
}

function buildInvoiceReasoning(
  archetype: CustomerArchetype,
  features: CustomerFeatures,
  daysOverdue: number,
  daysUntilDue: number,
  dso: number,
  priors: PortfolioPriors,
): string {
  const parts: string[] = []
  
  // Archetype description
  const archetypeDesc: Record<CustomerArchetype, string> = {
    clockwork: "Highly regular payer",
    slow_reliable: "Pays consistently but late",
    bursty: "Clusters payments then pauses",
    episodic: "Project-based, irregular",
    volatile: "Erratic timing and amounts",
    low_data:
      features.invoice_count > 0
        ? "Limited tagged bank history — modeled from open invoices"
        : "Insufficient payment history",
  }
  parts.push(archetypeDesc[archetype])
  
  // Payment history
  if (features.payment_count > 0) {
    parts.push(`${features.payment_count} prior payments`)
    if (dso > 0) {
      parts.push(`avg ${Math.round(dso)}d to pay`)
    }
  } else if (features.invoice_count > 0) {
    parts.push("no tagged customer_receipt movements — expecting cash from open invoices")
  } else {
    parts.push("no payment history")
  }
  
  // Invoice status
  if (daysOverdue > 0) {
    parts.push(`${daysOverdue}d overdue`)
  } else if (daysUntilDue > 0) {
    parts.push(`due in ${daysUntilDue}d`)
  }
  
  // Reliability
  if (features.payer_reliability_cluster === "reliable") {
    parts.push("reliable payer")
  } else if (features.payer_reliability_cluster === "volatile") {
    parts.push("volatile payment pattern")
  }
  
  return parts.join(" · ")
}

function buildCustomerModels(
  movements: TaggedMovement[],
  invoices: OutstandingInvoice[] = [],
  portfolioPriors?: PortfolioPriors,
  profileByEntityId?: Map<string, EntityPaymentProfile>,
  profileByNormalizedName?: Map<string, EntityPaymentProfile>,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): CustomerModel[] {
  const priors = portfolioPriors ?? computePortfolioPriors(movements, invoices, cal)
  const byEntity = new Map<string, { name: string; payments: { amount: number; date: string; isAnomaly: boolean; isOutlier: boolean; isFirstSeen: boolean; confidence: number }[] }>()

  // Helper to find profile for an entity
  function findProfile(entityId: string, name: string): EntityPaymentProfile | undefined {
    if (profileByEntityId?.has(entityId)) {
      const p = profileByEntityId.get(entityId)!
      if (p.entity_type !== "vendor") return p
    }
    const normName = name.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (normName.length >= 3 && profileByNormalizedName?.has(normName)) {
      const p = profileByNormalizedName.get(normName)!
      if (p.entity_type !== "vendor") return p
    }
    return undefined
  }

  for (const m of movements) {
    if (m.tag.economic_class !== "customer_receipt") continue
    if (m.tag.state_inclusion_policy === "exclude_and_review") continue
    if (m.tag.counterparty_role === "owner") continue

    const key = resolveEntityId(m)
    const cp = observedCounterparty(m)
    const name = resolveEntityName(key, cp, m.raw_description, "customer")
    let entry = byEntity.get(key)
    if (!entry) { entry = { name, payments: [] }; byEntity.set(key, entry) }
    entry.payments.push({
      amount: m.amount,
      date: toDateStr(m.occurred_at),
      isAnomaly: m.tag.is_anomaly ?? false,
      isOutlier: m.tag.is_large_outlier ?? false,
      isFirstSeen: m.tag.is_first_seen_counterparty ?? false,
      confidence: m.tag.classification_confidence ?? 0,
    })
  }

  const models: CustomerModel[] = []
  const now = new Date().toISOString().slice(0, 10)

  for (const [entityId, data] of byEntity) {
    const payments = data.payments.sort((a, b) => a.date.localeCompare(b.date))
    if (payments.length === 0) continue

    const normalPayments = payments.filter((p) => !p.isAnomaly && !p.isOutlier)
    const usePayments = normalPayments.length >= 2 ? normalPayments : payments
    let weightedSum = 0, weightSum = 0
    for (const p of usePayments) {
      const w = Math.max(0.1, Math.min(1, p.confidence))
      weightedSum += p.amount * w
      weightSum += w
    }
    const avgAmount = weightSum > 0 ? weightedSum / weightSum : usePayments.reduce((s, p) => s + p.amount, 0) / usePayments.length

    const intervals: number[] = []
    for (let i = 1; i < payments.length; i++) {
      intervals.push(daysBetween(payments[i - 1].date, payments[i].date))
    }

    const avgInterval = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0
    const intervalVariance = std(intervals)
    const lastDate = payments[payments.length - 1].date
    const daysSinceLast = daysBetween(lastDate, now)

    // Collect invoice info for this customer
    const linkedInvoiceIds = new Set<string>()
    for (const m of movements) {
      if (m.tag.economic_class !== "customer_receipt") continue
      if (resolveEntityId(m) !== entityId) continue
      if (m.tag.invoice_id) linkedInvoiceIds.add(m.tag.invoice_id)
    }
    const normName = data.name.toLowerCase().replace(/[^a-z0-9]/g, "")
    const customerInvoices = invoices.filter((inv) => {
      if (linkedInvoiceIds.has(inv.invoice_id)) return true
      if (inv.entity_id && inv.entity_id === entityId) return true
      const invName = inv.customer_name.toLowerCase().replace(/[^a-z0-9]/g, "")
      return invName.length >= 3 && (normName.includes(invName) || invName.includes(normName))
    })

    const overdueInvCount = customerInvoices.filter((i) => i.status === "overdue").length

    const features = computeCustomerFeatures(
      payments.map((p) => ({ amount: p.amount, date: p.date, confidence: p.confidence })),
      customerInvoices.length,
      overdueInvCount,
      now,
    )

    const amountCv = features.amount_mean > 0 ? features.amount_std / features.amount_mean : 0
    const archetype = classifyCustomerArchetype(
      payments.length,
      features.interval_cv,
      features.avg_days_to_pay,
      amountCv,
      features.recent_trend,
    )

    // Data-driven probability based on archetype and payment history
    const overdueRatio = avgInterval > 0 ? daysSinceLast / avgInterval : (daysSinceLast / priors.avg_collection_delay)
    const baseProb = priors.archetype_multipliers[archetype] * priors.base_p30
    const cp = cal.customer_probability
    
    let probability: number
    if (payments.length >= 3) {
      probability = sigmoidDecay(overdueRatio, cal) * baseProb * (1 + cp.payment_count_scale * Math.min(1, payments.length / cp.payment_count_norm))
    } else if (customerInvoices.length > 0) {
      const hasOverdue = customerInvoices.some((i) => i.status === "overdue")
      probability = baseProb * (hasOverdue ? cp.overdue_mult : cp.not_overdue_mult)
    } else {
      probability = baseProb * cp.low_data_mult * sigmoidDecay(overdueRatio, cal)
    }

    if (features.recent_trend === "decelerating") probability *= cp.decel_mult
    if (payments.length === 1 && payments[0].isFirstSeen) probability *= cp.first_seen_mult

    probability = Math.max(cp.floor, Math.min(cp.ceiling, probability))

    let nextDate: string | null = null
    if (archetype === "clockwork" || archetype === "slow_reliable" || archetype === "bursty") {
      if (avgInterval > 0 && probability > cp.min_prob_for_next_date) {
        nextDate = addDays(lastDate, avgInterval)
        while (nextDate < now && avgInterval > 0) {
          nextDate = addDays(nextDate, avgInterval)
        }
        if (daysBetween(now, nextDate) < cp.min_day_offset) nextDate = addDays(now, Math.max(cp.min_day_offset, Math.round(avgInterval * cp.interval_fraction)))
      }
    } else if (archetype === "low_data" && customerInvoices.length > 0) {
      const earliest = customerInvoices.filter((i) => i.due_date).sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""))[0]
      nextDate = earliest?.due_date ?? addDays(now, 14)
    }

    let confidence: "high" | "medium" | "low" = "low"
    if (archetype === "clockwork" && payments.length >= 5) confidence = "high"
    else if (archetype === "clockwork" && payments.length >= 3) confidence = "medium"
    else if (archetype === "slow_reliable" && payments.length >= 4) confidence = "medium"
    else if (archetype === "bursty" && payments.length >= 4) confidence = "medium"
    else if (payments.length >= 3) confidence = "medium"

    // Invoice boost — scaled by archetype multiplier from portfolio data
    if (customerInvoices.length > 0) {
      const earliestDue = customerInvoices
        .filter((i) => i.due_date)
        .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""))[0]

      const invoiceBoost = (priors.archetype_multipliers[archetype] - cp.invoice_boost_offset) * cp.invoice_boost_scale
      if (probability < cp.invoice_boost_cap && invoiceBoost > 0) {
        probability = Math.min(cp.invoice_boost_max, probability + invoiceBoost)
      }
      if (confidence === "low" && payments.length >= 2) confidence = "medium"

      if (earliestDue?.due_date && earliestDue.due_date >= now) {
        const dueOffset = daysBetween(now, earliestDue.due_date)
        if (dueOffset <= 30) nextDate = earliestDue.due_date
      } else if (earliestDue?.status === "overdue") {
        nextDate = addDays(now, Math.max(1, Math.round(priors.avg_collection_delay / 4)))
        probability = Math.min(cp.overdue_invoice_cap, probability * cp.overdue_invoice_mult)
      }
    }

    probability = Math.max(cp.floor, Math.min(cp.ceiling, probability))

    const invoiceForecasts = buildInvoiceForecasts(customerInvoices, features, archetype, now, priors)

    const inflow_event_class: InflowEventClass =
      overdueInvCount > 0 ? "overdue_receivable"
      : archetype === "clockwork" ? "clockwork_receivable"
      : archetype === "episodic" || archetype === "volatile" ? "sporadic_receivable"
      : "likely_receivable"

    models.push({
      entity_id: entityId,
      name: data.name,
      archetype,
      inflow_event_class,
      features,
      avg_amount: r2(avgAmount),
      payment_interval_days: Math.round(avgInterval),
      interval_variance: r2(intervalVariance),
      last_payment_date: lastDate,
      payment_count: payments.length,
      probability_of_next: r2(probability),
      next_expected_date: nextDate,
      confidence,
      outstanding_invoices: customerInvoices,
      invoice_forecasts: invoiceForecasts,
    })
  }

  // Invoice-only customers with no payment history
  const existingEntities = new Set(models.map((m) => m.entity_id))
  const existingNames = new Set(models.map((m) => m.name.toLowerCase().replace(/[^a-z0-9]/g, "")))

  const unmatchedInvoices = invoices.filter((inv) => {
    if (inv.entity_id && existingEntities.has(inv.entity_id)) return false
    const invName = inv.customer_name.toLowerCase().replace(/[^a-z0-9]/g, "")
    return !existingNames.has(invName)
  })

  const byCustomer = new Map<string, OutstandingInvoice[]>()
  for (const inv of unmatchedInvoices) {
    const key = inv.customer_name.toLowerCase().replace(/[^a-z0-9]/g, "")
    let arr = byCustomer.get(key)
    if (!arr) { arr = []; byCustomer.set(key, arr) }
    arr.push(inv)
  }

  for (const [, custInvs] of byCustomer) {
    const totalDue = custInvs.reduce((s, i) => s + i.amount_due, 0)
    // Skip trivially small invoice-only customers (< $100 total due) to avoid
    // creating dozens of noise low_data models that dilute confidence scoring
    if (totalDue < 100) continue

    const earliest = custInvs.filter((i) => i.due_date).sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""))[0]
    const overdueCount = custInvs.filter((i) => i.status === "overdue").length

    const invCustomerName = custInvs[0].customer_name
    const canonicalName = extractEntityFromRawDescriptor(invCustomerName)
      ?? (invCustomerName && invCustomerName.length >= 2 ? cleanDescriptor(invCustomerName) : null)
      ?? `Customer (${custInvs.length} invoice${custInvs.length > 1 ? "s" : ""})`

    const entityId = custInvs[0].entity_id ?? `inv_${custInvs[0].invoice_id}`

    // Try to find entity profile for this invoice-only customer
    const profile = findProfile(entityId, canonicalName)

    const ioc = cal.invoice_only_customer

    let archetype: CustomerArchetype = "low_data"
    let probability = custInvs.some((i) => i.status === "overdue") ? ioc.overdue_prob : ioc.not_overdue_prob
    let confidence: "high" | "medium" | "low" = "low"
    let paymentIntervalDays = 0
    let paymentCount = 0

    if (profile && profile.transaction_count > 0) {
      paymentCount = profile.transaction_count

      if (profile.archetype) {
        const archetypeMap: Record<string, CustomerArchetype> = {
          clockwork: "clockwork", slow_reliable: "slow_reliable", bursty: "bursty",
          volatile: "volatile", low_data: "low_data", episodic: "episodic",
        }
        archetype = archetypeMap[profile.archetype] ?? "low_data"
      } else if (profile.interval_cv !== null && profile.transaction_count >= 3) {
        if (profile.interval_cv < ioc.cv_clockwork) archetype = "clockwork"
        else if (profile.interval_cv < ioc.cv_slow_reliable) archetype = "slow_reliable"
        else if (profile.interval_cv < ioc.cv_bursty) archetype = "bursty"
        else archetype = "volatile"
      }

      if (profile.reliability_score !== null && profile.reliability_score > 0) {
        probability = ioc.profile_prob_base + profile.reliability_score * ioc.profile_prob_scale
        if (profile.on_time_payment_rate !== null && profile.on_time_payment_rate > ioc.on_time_threshold) {
          probability = Math.min(ioc.on_time_cap, probability * ioc.on_time_mult)
        }
      }

      if (profile.transaction_count >= ioc.high_conf_count && profile.reliability_score !== null && profile.reliability_score > ioc.high_conf_reliability) {
        confidence = "high"
      } else if (profile.transaction_count >= 5) {
        confidence = "medium"
      } else if (profile.transaction_count >= 3) {
        confidence = "medium"
      }

      // Use interval from profile
      if (profile.avg_interval_days !== null) {
        paymentIntervalDays = Math.round(profile.avg_interval_days)
      }
    }

    const features: CustomerFeatures = {
      payment_count: paymentCount, invoice_count: custInvs.length, paid_vs_unpaid_ratio: 0,
      avg_days_to_pay: profile?.avg_days_to_pay ?? 0,
      std_days_to_pay: profile?.std_days_to_pay ?? 0,
      amount_mean: r2(totalDue / custInvs.length),
      amount_std: 0, interval_cv: profile?.interval_cv ?? 999, recent_trend: "insufficient",
      last_payment_recency_days: profile?.days_since_last_transaction ?? 999,
      overdue_count: overdueCount, weekday_bias: null,
    }

    const invoiceForecasts = buildInvoiceForecasts(custInvs, features, archetype, now, priors)

    models.push({
      entity_id: entityId,
      name: canonicalName,
      archetype,
      inflow_event_class: custInvs.some((i) => i.status === "overdue") ? "overdue_receivable" : "sporadic_receivable",
      features,
      avg_amount: r2(totalDue / custInvs.length),
      payment_interval_days: paymentIntervalDays,
      interval_variance: 0,
      last_payment_date: profile?.last_transaction_date ?? now,
      payment_count: paymentCount,
      probability_of_next: r2(Math.max(cal.customer_probability.floor, Math.min(cal.customer_probability.ceiling, probability))),
      next_expected_date: earliest?.due_date ?? addDays(now, 14),
      confidence,
      outstanding_invoices: custInvs,
      invoice_forecasts: invoiceForecasts,
    })
  }

  return models.sort(
    (a, b) =>
      b.avg_amount * Math.max(1, b.payment_count) - a.avg_amount * Math.max(1, a.payment_count),
  )
}

/**
 * Compute entity profile quality score for forecast confidence.
 * Returns a score from 0-1 based on profile completeness and data quality.
 */
export function computeEntityProfileQuality(
  entityProfiles: Map<string, EntityPaymentProfile>,
  customerModels: CustomerModel[],
  vendorModels: VendorModel[]
): { score: number; reason: string } {
  if (entityProfiles.size === 0) {
    return { score: 0.5, reason: "No entity profiles available" }
  }

  let totalWeight = 0
  let weightedQuality = 0

  // Check customer profile coverage and quality
  for (const customer of customerModels) {
    const profile = entityProfiles.get(customer.entity_id)
    const weight = customer.avg_amount * customer.payment_count

    if (profile) {
      const dataQuality = Math.min(1, profile.transaction_count / 10)
      const archetypeQuality = profile.archetype && profile.archetype !== "low_data" ? 1 : 0.5
      const reliabilityQuality = profile.reliability_score
      const quality = (dataQuality * 0.4 + archetypeQuality * 0.3 + reliabilityQuality * 0.3)
      weightedQuality += weight * quality
    } else {
      weightedQuality += weight * 0.3 // Penalty for missing profile
    }
    totalWeight += weight
  }

  // Check vendor profile coverage
  for (const vendor of vendorModels) {
    const profile = entityProfiles.get(vendor.entity_id)
    const weight = vendor.avg_amount * vendor.payment_count

    if (profile) {
      const dataQuality = Math.min(1, profile.transaction_count / 10)
      weightedQuality += weight * dataQuality
    } else {
      weightedQuality += weight * 0.3
    }
    totalWeight += weight
  }

  const score = totalWeight > 0 ? weightedQuality / totalWeight : 0.5
  const coverage = entityProfiles.size / Math.max(1, customerModels.length + vendorModels.length)
  const coveragePct = Math.round(coverage * 100)

  return {
    score: r2(score),
    reason: `${entityProfiles.size} profiles (${coveragePct}% coverage)`,
  }
}

// ─── Step 2b: Vendor Behavioral Models ──────────────────────────────

function detectCadence(avgInterval: number, cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): VendorModel["cadence"] {
  const cd = cal.cadence_detection
  if (avgInterval <= cd.weekly_max) return "weekly"
  if (avgInterval <= cd.biweekly_max) return "biweekly"
  if (avgInterval <= cd.monthly_max) return "monthly"
  if (avgInterval <= cd.quarterly_max) return "quarterly"
  return "irregular"
}

function computeVendorFeatures(
  payments: { amount: number; date: string }[],
  vendorBills: { due_date: string | null }[],
  intervalCV: number,
  amountCV: number,
  archetype: VendorArchetype,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): VendorFeatures {
  const vc = cal.vendor_classification
  const due_date_adherence = vendorBills.length > 0 ? vc.due_date_adherence_with_bills : vc.due_date_adherence_without
  const monthKeys = new Set(payments.map((p) => p.date.slice(0, 7)))
  const dataSpanMonths = monthKeys.size || 1
  const skipped_month_freq = dataSpanMonths > 1 ? r2(1 - payments.length / dataSpanMonths) : 0
  const payment_batching = payments.length >= 3 && intervalCV < vc.batch_supplier_cv ? vc.batching_score_batch : vc.batching_score_non_batch
  return {
    due_date_adherence,
    payment_batching,
    skipped_month_freq,
    amount_volatility: r2(amountCV),
    discretionary_flag: archetype === "spend_on_demand"
  }
}

function classifyVendorArchetype(
  recurrenceType: RecurrenceType,
  hasBills: boolean,
  paymentCount: number,
  intervalCV: number,
  amountCV: number,
  economicClass: string,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): VendorArchetype {
  const vc = cal.vendor_classification
  if (economicClass === "transfer") return "treasury_linked"
  if (hasBills && paymentCount < 3) return "one_off_ap"
  if (hasBills && recurrenceType !== "hard" && recurrenceType !== "soft") return "hard_due_date"
  if (recurrenceType === "hard" && intervalCV < vc.hard_cv_threshold) return "soft_recurring"
  if (recurrenceType === "soft") return "soft_recurring"
  if (recurrenceType === "episodic" && paymentCount >= vc.spend_on_demand_count && amountCV > vc.spend_on_demand_cv) return "spend_on_demand"
  if (recurrenceType === "seasonal" || (paymentCount >= vc.batch_supplier_count && intervalCV < vc.batch_supplier_cv)) return "batch_supplier"
  if (hasBills) return "hard_due_date"
  return "spend_on_demand"
}

function classifyRecurrence(
  payments: { date: string; recurring: boolean; amount?: number }[],
  intervals: number[],
  avgInterval: number,
  intervalCV: number,
  taggedRecurring: boolean,
  familyRecurring: boolean,
  amounts?: number[],
  hasBillsWithDueDates?: boolean,
  billDueDates?: string[],
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): RecurrenceModel {
  const n = payments.length
  const intervalStd = std(intervals)
  const rc = cal.recurrence_confidence
  const cw = rc.component_weights

  const interval_stability_score = intervalCV < 1 ? r2(Math.max(0, 1 - intervalCV)) : 0
  const amts = amounts ?? payments.map((p) => p.amount).filter((a): a is number => typeof a === "number")
  const amountMean = amts.length > 0 ? amts.reduce((a, b) => a + b, 0) / amts.length : 0
  const amountStd = amts.length > 1 ? std(amts) : 0
  const amountCV = amountMean > 0 ? amountStd / amountMean : 999
  const amount_stability_score = amountCV < 1 ? r2(Math.max(0, 1 - amountCV)) : 0
  const counterparty_consistency = 1
  const due_date_consistency = hasBillsWithDueDates ? 0.9 : 0.5
  const class_consistency = 1

  const componentConfidence = (
    interval_stability_score * cw.interval +
    amount_stability_score * cw.amount +
    counterparty_consistency * cw.counterparty +
    due_date_consistency * cw.due_date +
    class_consistency * cw.class_consistency
  )

  // When payment count is low, try to infer recurrence from bill due date intervals
  const sortedBillDates = (billDueDates ?? []).filter(Boolean).sort()
  const billIntervals: number[] = []
  for (let i = 1; i < sortedBillDates.length; i++) {
    billIntervals.push(daysBetween(sortedBillDates[i - 1], sortedBillDates[i]))
  }
  const billAvgInterval = billIntervals.length > 0 ? billIntervals.reduce((a, b) => a + b, 0) / billIntervals.length : 0
  const billIntervalStd = billIntervals.length > 1 ? std(billIntervals) : 0
  const billIntervalCV = billAvgInterval > 0 ? billIntervalStd / billAvgInterval : 999

  if (n <= 2 && !taggedRecurring && !familyRecurring) {
    if (billIntervals.length >= 2 && billIntervalCV < cal.vendor_soft_recurrence_cv_max) {
      const billConf = Math.min(rc.bill_soft_cap, componentConfidence * rc.bill_soft_base + rc.bill_soft_floor)
      return {
        recurrence_type: "soft",
        recurrence_confidence: r2(billConf),
        expected_interval_days: Math.round(billAvgInterval),
        interval_std_days: r2(billIntervalStd),
        amount_mean: amountMean > 0 ? r2(amountMean) : null,
        amount_std: amountStd > 0 ? r2(amountStd) : null,
        interval_stability_score: r2(Math.max(0, 1 - billIntervalCV)),
        amount_stability_score,
        counterparty_consistency,
        due_date_consistency: 0.9,
        class_consistency,
      }
    }
    if (billIntervals.length >= 1 && billIntervalCV < 0.8) {
      const billConf = Math.min(rc.bill_episodic_cap, componentConfidence * rc.bill_episodic_base + rc.bill_episodic_floor)
      return {
        recurrence_type: "episodic",
        recurrence_confidence: r2(billConf),
        expected_interval_days: Math.round(billAvgInterval),
        interval_std_days: billIntervals.length > 1 ? r2(billIntervalStd) : null,
        amount_mean: amountMean > 0 ? r2(amountMean) : null,
        amount_std: amountStd > 0 ? r2(amountStd) : null,
        interval_stability_score: r2(Math.max(0, 1 - billIntervalCV)),
        amount_stability_score,
        counterparty_consistency,
        due_date_consistency: 0.8,
        class_consistency,
      }
    }
    return {
      recurrence_type: n === 0 ? "unknown" : "episodic",
      recurrence_confidence: r2(n === 0 ? 0 : Math.min(rc.unknown_cap, componentConfidence * rc.unknown_base)),
      expected_interval_days: avgInterval > 0 ? Math.round(avgInterval) : null,
      interval_std_days: null,
      amount_mean: amountMean > 0 ? r2(amountMean) : null,
      amount_std: amountStd > 0 ? r2(amountStd) : null,
      interval_stability_score,
      amount_stability_score,
      counterparty_consistency,
      due_date_consistency,
      class_consistency,
    }
  }

  if (n >= 6) {
    const allMonths = payments.map((p) => new Date(p.date).getMonth())
    const monthCounts = new Array(12).fill(0)
    allMonths.forEach((m) => monthCounts[m]++)
    const activeMonths = monthCounts.filter((c) => c > 0).length
    const peakMonth = Math.max(...monthCounts)
    const dataSpanMonths = new Set(payments.map((p) => p.date.slice(0, 7))).size
    if (dataSpanMonths >= 6 && activeMonths <= dataSpanMonths - 3 && peakMonth >= 2) {
      return {
        recurrence_type: "seasonal",
        recurrence_confidence: r2(Math.min(rc.seasonal_cap, componentConfidence * rc.seasonal_mult)),
        expected_interval_days: Math.round(avgInterval),
        interval_std_days: r2(intervalStd),
        amount_mean: amountMean > 0 ? r2(amountMean) : null,
        amount_std: amountStd > 0 ? r2(amountStd) : null,
        interval_stability_score,
        amount_stability_score,
        counterparty_consistency,
        due_date_consistency,
        class_consistency,
      }
    }
  }

  if (intervals.length >= 3 && intervalCV < cal.vendor_hard_recurrence_cv_max) {
    return {
      recurrence_type: "hard",
      recurrence_confidence: r2(Math.min(rc.hard_cap, componentConfidence * rc.hard_mult)),
      expected_interval_days: Math.round(avgInterval),
      interval_std_days: r2(intervalStd),
      amount_mean: amountMean > 0 ? r2(amountMean) : null,
      amount_std: amountStd > 0 ? r2(amountStd) : null,
      interval_stability_score,
      amount_stability_score,
      counterparty_consistency,
      due_date_consistency,
      class_consistency,
    }
  }

  if (intervals.length >= 2 && intervalCV < cal.vendor_soft_recurrence_cv_max && (taggedRecurring || familyRecurring || n >= 3)) {
    return {
      recurrence_type: "soft",
      recurrence_confidence: r2(Math.min(rc.soft_cap, componentConfidence)),
      expected_interval_days: Math.round(avgInterval),
      interval_std_days: r2(intervalStd),
      amount_mean: amountMean > 0 ? r2(amountMean) : null,
      amount_std: amountStd > 0 ? r2(amountStd) : null,
      interval_stability_score,
      amount_stability_score,
      counterparty_consistency,
      due_date_consistency,
      class_consistency,
    }
  }

  if (n >= 3) {
    return {
      recurrence_type: "episodic",
      recurrence_confidence: r2(Math.min(rc.episodic_cap, componentConfidence * rc.episodic_mult)),
      expected_interval_days: Math.round(avgInterval),
      interval_std_days: r2(intervalStd),
      amount_mean: amountMean > 0 ? r2(amountMean) : null,
      amount_std: amountStd > 0 ? r2(amountStd) : null,
      interval_stability_score,
      amount_stability_score,
      counterparty_consistency,
      due_date_consistency,
      class_consistency,
    }
  }

  // Fallback: also try bill due dates for low-data vendors that passed the n>2 check
  // but failed all other classification criteria
  if (billIntervals.length >= 2 && billIntervalCV < cal.vendor_soft_recurrence_cv_max && n < 3) {
    return {
      recurrence_type: "soft",
      recurrence_confidence: r2(Math.min(rc.bill_interval_soft_cap, componentConfidence * 0.6 + 0.1)),
      expected_interval_days: Math.round(billAvgInterval),
      interval_std_days: r2(billIntervalStd),
      amount_mean: amountMean > 0 ? r2(amountMean) : null,
      amount_std: amountStd > 0 ? r2(amountStd) : null,
      interval_stability_score: r2(Math.max(0, 1 - billIntervalCV)),
      amount_stability_score,
      counterparty_consistency,
      due_date_consistency: 0.9,
      class_consistency,
    }
  }

  return {
    recurrence_type: taggedRecurring || familyRecurring ? "soft" : "unknown",
    recurrence_confidence: r2(Math.min(rc.fallback_cap, componentConfidence * rc.fallback_base)),
    expected_interval_days: avgInterval > 0 ? Math.round(avgInterval) : null,
    interval_std_days: intervals.length > 0 ? r2(intervalStd) : null,
    amount_mean: amountMean > 0 ? r2(amountMean) : null,
    amount_std: amountStd > 0 ? r2(amountStd) : null,
    interval_stability_score,
    amount_stability_score,
    counterparty_consistency,
    due_date_consistency,
    class_consistency,
  }
}

function buildVendorModels(
  movements: TaggedMovement[],
  bills: OutstandingBill[] = [],
  profileByEntityId?: Map<string, EntityPaymentProfile>,
  profileByNormalizedName?: Map<string, EntityPaymentProfile>,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): VendorModel[] {
  const byEntity = new Map<string, { name: string; ecCounts: Record<string, number>; payments: { amount: number; date: string; recurring: boolean; isAnomaly: boolean; isOutlier: boolean; confidence: number; familyKey: string | null }[] }>()

  // Helper to find profile for a vendor
  function findVendorProfile(entityId: string, name: string): EntityPaymentProfile | undefined {
    if (profileByEntityId?.has(entityId)) {
      const p = profileByEntityId.get(entityId)!
      if (p.entity_type !== "customer") return p
    }
    const normName = name.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (normName.length >= 3 && profileByNormalizedName?.has(normName)) {
      const p = profileByNormalizedName.get(normName)!
      if (p.entity_type !== "customer") return p
    }
    return undefined
  }

  for (const m of movements) {
    const ec = m.tag.economic_class
    if (ec !== "vendor_payment" && ec !== "payroll" && ec !== "processor_fee" && ec !== "debt_payment") continue
    if (m.tag.state_inclusion_policy === "exclude_and_review") continue

    const key = resolveEntityId(m)
    const cp = observedCounterparty(m)
    const name = resolveEntityName(key, cp, m.raw_description, "vendor")
    let entry = byEntity.get(key)
    if (!entry) { entry = { name, ecCounts: {}, payments: [] }; byEntity.set(key, entry) }
    entry.ecCounts[ec] = (entry.ecCounts[ec] ?? 0) + 1
    entry.payments.push({
      amount: m.amount,
      date: toDateStr(m.occurred_at),
      recurring: m.tag.is_recurring ?? false,
      isAnomaly: m.tag.is_anomaly ?? false,
      isOutlier: m.tag.is_large_outlier ?? false,
      confidence: m.tag.classification_confidence ?? 0,
      familyKey: m.tag.recurrence_family_id ?? null,
    })
  }

  const models: VendorModel[] = []

  for (const [entityId, data] of byEntity) {
    const payments = data.payments.sort((a, b) => a.date.localeCompare(b.date))
    if (payments.length === 0) continue

    const normalPayments = payments.filter((p) => !p.isAnomaly && !p.isOutlier)
    const usePayments = normalPayments.length >= 2 ? normalPayments : payments
    let vWeightedSum = 0, vWeightTotal = 0
    for (const p of usePayments) {
      const w = Math.max(0.1, Math.min(1, p.confidence))
      vWeightedSum += p.amount * w
      vWeightTotal += w
    }
    const avgAmount = vWeightTotal > 0 ? vWeightedSum / vWeightTotal : usePayments.reduce((s, p) => s + p.amount, 0) / usePayments.length
    const amountStd = std(usePayments.map((p) => p.amount))
    const taggedRecurring = payments.filter((p) => p.recurring).length > payments.length * cal.vendor_classification.tagged_recurring_fraction

    const familyKeys = new Set(payments.map((p) => p.familyKey).filter(Boolean))
    let familyRecurring = false
    for (const fk of familyKeys) {
      const fam = _ctx.familyMembers.get(fk!)
      if (fam && fam.occurrences >= 3) { familyRecurring = true; break }
    }

    const intervals: number[] = []
    for (let i = 1; i < payments.length; i++) {
      intervals.push(daysBetween(payments[i - 1].date, payments[i].date))
    }

    const avgInterval = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0
    const intervalStdDev = intervals.length > 1
      ? Math.sqrt(intervals.reduce((s, v) => s + (v - avgInterval) ** 2, 0) / intervals.length)
      : avgInterval
    const intervalCV = avgInterval > 0 ? intervalStdDev / avgInterval : 999
    const cadenceRegular = intervals.length >= 2 && intervalCV < 0.5
    const isRecurring = taggedRecurring || cadenceRegular || familyRecurring

    // Collect bill_ids from tag_data for this vendor's movements (before classifyRecurrence)
    const linkedBillIds = new Set<string>()
    for (const m of movements) {
      const ec = m.tag.economic_class
      if (ec !== "vendor_payment" && ec !== "payroll" && ec !== "processor_fee" && ec !== "debt_payment") continue
      if (resolveEntityId(m) !== entityId) continue
      if (m.tag.bill_id) linkedBillIds.add(m.tag.bill_id)
    }

    const normName = data.name.toLowerCase().replace(/[^a-z0-9]/g, "")
    const vendorBills = bills.filter((b) => {
      if (linkedBillIds.has(b.bill_id)) return true
      if (b.entity_id && b.entity_id === entityId) return true
      const bName = b.vendor_name.toLowerCase().replace(/[^a-z0-9]/g, "")
      return bName.length >= 3 && (normName.includes(bName) || bName.includes(normName))
    })
    const hasBillsWithDueDates = vendorBills.some((b) => !!b.due_date)

    const recurrence = classifyRecurrence(
      payments.map((p) => ({ date: p.date, recurring: p.recurring, amount: p.amount })),
      intervals, avgInterval, intervalCV, taggedRecurring, familyRecurring,
      usePayments.map((p) => p.amount),
      hasBillsWithDueDates,
      vendorBills.filter((b) => !!b.due_date).map((b) => b.due_date!),
    )
    recurrence.amount_mean = r2(avgAmount)
    recurrence.amount_std = r2(amountStd)

    const lastDate = payments[payments.length - 1].date
    const cadence = detectCadence(avgInterval, cal)

    let nextDate: string | null = null
    if (avgInterval > 0 && (isRecurring || payments.length >= 3)) {
      nextDate = addDays(lastDate, avgInterval)
      const now = new Date().toISOString().slice(0, 10)
      if (nextDate < now) nextDate = addDays(now, Math.max(1, avgInterval * 0.5))
    }

    let confidence: "high" | "medium" | "low" = "low"
    if (recurrence.recurrence_type === "hard" && payments.length >= 4) confidence = "high"
    else if (recurrence.recurrence_type === "hard") confidence = "medium"
    else if (recurrence.recurrence_type === "soft" && payments.length >= 4) confidence = "medium"
    else if (recurrence.recurrence_type === "seasonal" && payments.length >= 5) confidence = "medium"
    else if (payments.length >= 3 && isRecurring) confidence = "medium"
    else if (payments.length >= 3) confidence = "medium"
    else if (payments.length >= 2 && (taggedRecurring || familyRecurring)) confidence = "medium"

    if (vendorBills.length > 0) {
      const now = new Date().toISOString().slice(0, 10)
      const earliestDue = vendorBills.filter((b) => b.due_date).sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""))[0]
      if (earliestDue?.due_date && earliestDue.due_date >= now) {
        const dueOffset = daysBetween(now, earliestDue.due_date)
        if (dueOffset <= 30) nextDate = earliestDue.due_date
      } else if (earliestDue?.status === "overdue") {
        nextDate = addDays(new Date().toISOString().slice(0, 10), 2)
      }
      if (confidence === "low") confidence = "medium"
    }

    const totalEc = Object.values(data.ecCounts).reduce((a, b) => a + b, 0)
    const payrollCount = data.ecCounts["payroll"] ?? 0
    const processorCount = data.ecCounts["processor_fee"] ?? 0
    const outflow_event_class: OutflowEventClass =
      payrollCount === totalEc ? "payroll_fixed"
      : processorCount === totalEc ? "processor_fees"
      : vendorBills.length > 0 ? "ap_due_driven"
      : recurrence.recurrence_type === "hard" || recurrence.recurrence_type === "soft" ? "contractual_recurring"
      : "discretionary_vendor"

    const amountCV = avgAmount > 0 ? amountStd / avgAmount : 0
    const primaryEc = Object.entries(data.ecCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "vendor_payment"
    const archetype = classifyVendorArchetype(
      recurrence.recurrence_type,
      vendorBills.length > 0,
      payments.length,
      intervalCV,
      amountCV,
      primaryEc,
      cal,
    )

    const features = computeVendorFeatures(
      usePayments,
      vendorBills,
      intervalCV,
      amountCV,
      archetype,
      cal,
    )

    models.push({
      entity_id: entityId,
      name: data.name,
      archetype,
      features,
      avg_amount: r2(avgAmount),
      cadence,
      cadence_interval_days: Math.round(avgInterval),
      is_recurring: isRecurring,
      recurrence,
      outflow_event_class,
      last_payment_date: lastDate,
      payment_count: payments.length,
      next_expected_date: nextDate,
      confidence,
      outstanding_bills: vendorBills,
    })
  }

  // Bill-only vendors: outstanding AP with no tagged vendor_payment movements
  const existingVendorIds = new Set(models.map((m) => m.entity_id))
  const existingVendorNames = new Set(models.map((m) => m.name.toLowerCase().replace(/[^a-z0-9]/g, "")))

  const unmatchedBills = bills.filter((b) => {
    if (b.amount_due <= 0) return false
    if (b.entity_id && existingVendorIds.has(b.entity_id)) return false
    const bn = b.vendor_name.toLowerCase().replace(/[^a-z0-9]/g, "")
    return bn.length >= 2 && !existingVendorNames.has(bn)
  })

  const billsByVendor = new Map<string, OutstandingBill[]>()
  for (const b of unmatchedBills) {
    const key = b.vendor_name.toLowerCase().replace(/[^a-z0-9]/g, "")
    let arr = billsByVendor.get(key)
    if (!arr) { arr = []; billsByVendor.set(key, arr) }
    arr.push(b)
  }

  const billOnlyNow = new Date().toISOString().slice(0, 10)
  for (const [, vendBills] of billsByVendor) {
    const totalDue = vendBills.reduce((s, b) => s + b.amount_due, 0)
    if (totalDue < 50) continue

    const earliest = vendBills.filter((b) => b.due_date).sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""))[0]
    const avgAmount = totalDue / vendBills.length
    const entityId = vendBills[0].entity_id ?? `ap_${vendBills[0].source}_${vendBills[0].bill_id}`
    const vendorName = vendBills[0].vendor_name.trim() || "Vendor (AP)"

    // Try to find entity profile for this bill-only vendor
    const profile = findVendorProfile(entityId, vendorName)

    // Compute bill due date intervals for recurrence inference
    const billDueDates = vendBills.filter((b) => !!b.due_date).map((b) => b.due_date!).sort()
    const billDueIntervals: number[] = []
    for (let i = 1; i < billDueDates.length; i++) {
      billDueIntervals.push(daysBetween(billDueDates[i - 1], billDueDates[i]))
    }
    const billDueAvgInterval = billDueIntervals.length > 0 ? billDueIntervals.reduce((a, b) => a + b, 0) / billDueIntervals.length : 0
    const billDueStd = billDueIntervals.length > 1 ? std(billDueIntervals) : 0
    const billDueCV = billDueAvgInterval > 0 ? billDueStd / billDueAvgInterval : 999

    // Use profile data if available
    let recurrenceType: RecurrenceModel["recurrence_type"] = "unknown"
    const rc = cal.recurrence_confidence
    let recurrenceConfidence = rc.bill_only_base_conf
    let cadenceIntervalDays = 0
    let isRecurring = false
    let paymentCount = 0
    let confidence: "high" | "medium" | "low" = "medium"

    if (profile && profile.transaction_count > 0) {
      paymentCount = profile.transaction_count

      if (profile.interval_cv !== null && profile.transaction_count >= 3) {
        const cvBasedConf = Math.max(0, 1 - profile.interval_cv)
        recurrenceConfidence = Math.max(recurrenceConfidence, cvBasedConf * rc.bill_only_cv_mult)

        if (profile.interval_cv < rc.bill_only_hard_cv) {
          recurrenceType = "hard"
          isRecurring = true
        } else if (profile.interval_cv < rc.bill_only_soft_cv) {
          recurrenceType = "soft"
          isRecurring = true
        }
      }

      if (profile.avg_interval_days !== null) {
        cadenceIntervalDays = Math.round(profile.avg_interval_days)
      }

      if (profile.transaction_count >= 10 && recurrenceConfidence > 0.6) {
        confidence = "high"
      } else if (profile.transaction_count >= 5) {
        confidence = "medium"
      }
    }

    // If profile didn't classify recurrence, try bill due date intervals
    if (recurrenceType === "unknown" && billDueIntervals.length >= 2 && billDueCV < cal.vendor_soft_recurrence_cv_max) {
      recurrenceType = "soft"
      recurrenceConfidence = Math.max(recurrenceConfidence, Math.min(rc.bill_interval_soft_cap, (1 - billDueCV) * rc.bill_interval_soft_base))
      cadenceIntervalDays = Math.round(billDueAvgInterval)
      isRecurring = true
    } else if (recurrenceType === "unknown" && billDueIntervals.length >= 1 && billDueCV < 0.8) {
      recurrenceType = "episodic"
      recurrenceConfidence = Math.max(recurrenceConfidence, Math.min(rc.bill_interval_episodic_cap, (1 - billDueCV) * rc.bill_interval_episodic_base))
      cadenceIntervalDays = Math.round(billDueAvgInterval)
    }

    const bareRecurrence: RecurrenceModel = {
      recurrence_type: recurrenceType,
      recurrence_confidence: r2(recurrenceConfidence),
      expected_interval_days: cadenceIntervalDays > 0 ? cadenceIntervalDays : null,
      interval_std_days: null,
      amount_mean: r2(avgAmount),
      amount_std: null,
      interval_stability_score: profile?.interval_cv != null ? Math.max(0, 1 - profile.interval_cv) : 0,
      amount_stability_score: 0,
      counterparty_consistency: 0.5,
      due_date_consistency: vendBills.some((b) => b.due_date) ? cal.vendor_classification.bill_only_due_date_with : cal.vendor_classification.bill_only_due_date_without,
      class_consistency: 0.5,
    }
    const vf: VendorFeatures = {
      due_date_adherence: profile?.on_time_payment_rate ?? cal.vendor_classification.bill_only_adherence_fallback,
      payment_batching: 0.4,
      skipped_month_freq: 0,
      amount_volatility: cal.vendor_classification.bill_only_amount_volatility,
      discretionary_flag: false,
    }
    let nextDate: string | null = null
    if (earliest?.due_date) {
      nextDate = earliest.due_date >= billOnlyNow ? earliest.due_date : addDays(billOnlyNow, 2)
    } else if (vendBills[0]?.days_until_due != null) {
      nextDate = addDays(billOnlyNow, Math.max(1, vendBills[0].days_until_due))
    } else {
      nextDate = addDays(billOnlyNow, 14)
    }

    models.push({
      entity_id: entityId,
      name: vendorName,
      archetype: isRecurring ? "soft_recurring" : "one_off_ap",
      features: vf,
      avg_amount: r2(avgAmount),
      cadence: cadenceIntervalDays > 0 ? detectCadence(cadenceIntervalDays, cal) : "irregular",
      cadence_interval_days: cadenceIntervalDays,
      is_recurring: isRecurring,
      recurrence: bareRecurrence,
      outflow_event_class: "ap_due_driven",
      last_payment_date: profile?.last_transaction_date ?? billOnlyNow,
      payment_count: paymentCount,
      next_expected_date: nextDate,
      confidence,
      outstanding_bills: vendBills,
    })
  }

  return models.sort(
    (a, b) =>
      b.avg_amount * Math.max(1, b.payment_count) - a.avg_amount * Math.max(1, a.payment_count),
  )
}

// ─── Step 2c: Settlement Delay Model ────────────────────────────────
//
// Per-processor settlement profiles with weekday effects, fee netting,
// and aggregated overall cadence.

/**
 * Extract settlement delays from reconciliation data.
 * Compares movement date vs. when it was attributed/matched to infer clearing delays.
 * Returns intervals (in days) between transaction date and settlement/attribution date.
 * 
 * Note: This function looks for reconcile_at in movement metadata, which is populated
 * when movements are enriched with attribution data. For direct attribution queries,
 * use fetchMovementsWithAttributionTimestamps() instead.
 */
function extractSettlementDelaysFromReconciliation(
  movements: TaggedMovement[],
): number[] {
  const delays: number[] = []

  for (const m of movements) {
    // Only look at processor payouts and settlement adjustments
    if (m.tag?.economic_class !== "processor_payout" && m.tag?.economic_class !== "settlement_adjustment") {
      continue
    }

    // Skip if no metadata or attribution info
    if (!m.metadata || typeof m.metadata !== "object") continue

    const md = m.metadata as Record<string, unknown>
    
    // Try multiple possible timestamp fields (in order of preference)
    const reconcileAt = md.reconcile_at
    const attributedAt = md.attributed_at
    const matchedAt = md.matched_at
    const createdAt = md.created_at

    // If we have a reconciliation timestamp, calculate delay
    for (const ts of [reconcileAt, attributedAt, matchedAt, createdAt]) {
      if (ts && typeof ts === "string") {
        try {
          const movementDate = new Date(m.occurred_at).getTime()
          const reconDate = new Date(ts).getTime()
          if (!isNaN(movementDate) && !isNaN(reconDate)) {
            const delayDays = Math.round((reconDate - movementDate) / 86_400_000)
            if (delayDays >= 0 && delayDays <= 90) {
              delays.push(delayDays)
              break // Only use first available timestamp
            }
          }
        } catch {
          // Ignore parse errors, try next timestamp
        }
      }
    }
  }

  return delays
}

function buildSettlementModel(movements: TaggedMovement[]): SettlementModel {
  const byProcessor = new Map<string, { timestamps: number[]; amounts: number[]; fees: number[] }>()

  // Extract settlement delays from reconciliation data
  const reconDelays = extractSettlementDelaysFromReconciliation(movements)

  for (const m of movements) {
    const t = m.tag
    if (t.state_inclusion_policy === "exclude_and_review") continue
    if (t.economic_class !== "processor_payout" && t.economic_class !== "settlement_adjustment") continue
    const d = m.occurred_at
    if (!d) continue
    const ts = new Date(d).getTime()
    if (isNaN(ts)) continue

    const processor = resolveEntityId(m)
    const cp = observedCounterparty(m)
    const name = resolveEntityName(processor, cp, m.raw_description, "vendor")
    let entry = byProcessor.get(name)
    if (!entry) { entry = { timestamps: [], amounts: [], fees: [] }; byProcessor.set(name, entry) }

    if (isInflow(m)) {
      entry.timestamps.push(ts)
      entry.amounts.push(m.amount)
    } else {
      entry.fees.push(m.amount)
    }
  }

  const allIntervals: number[] = []
  const profiles: ProcessorSettlementProfile[] = []

  for (const [procName, data] of byProcessor) {
    if (data.timestamps.length < 2) continue

    data.timestamps.sort((a, b) => a - b)
    const intervals: number[] = []
    const weekdayCounts: Record<number, number> = {}

    for (let i = 1; i < data.timestamps.length; i++) {
      const gap = Math.round((data.timestamps[i] - data.timestamps[i - 1]) / 86_400_000)
      if (gap >= 1 && gap <= 90) {
        intervals.push(gap)
        allIntervals.push(gap)
      }
      const dow = new Date(data.timestamps[i]).getDay()
      weekdayCounts[dow] = (weekdayCounts[dow] ?? 0) + 1
    }

    const avg = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0
    const delayStd = std(intervals)

    const totalPayout = data.amounts.reduce((s, a) => s + a, 0)
    const totalFee = data.fees.reduce((s, a) => s + a, 0)
    const feeRate = totalPayout > 0 ? totalFee / totalPayout : null

    // Only include weekday pattern if enough samples
    const weekdayPattern = Object.keys(weekdayCounts).length >= 3
      ? weekdayCounts as Record<number, number>
      : null

    profiles.push({
      processor: procName,
      avg_delay_days: r2(avg),
      delay_std: r2(delayStd),
      sample_count: intervals.length,
      weekday_pattern: weekdayPattern,
      fee_rate: feeRate != null ? r2(feeRate) : null,
    })
  }

  // Merge reconciliation delays with processor intervals
  // Reconciliation delays provide direct evidence of settlement timing
  const allDelays = [...allIntervals, ...reconDelays]

  const n = allDelays.length
  const avg = n > 0 ? allDelays.reduce((a, b) => a + b, 0) / n : 0
  const delayStd = std(allDelays)
  const confidence: SettlementModel["confidence"] =
    n >= 20 ? "high" : n >= 10 ? "medium" : n >= 3 ? "low" : "insufficient"

  return {
    avg_delay_days: r2(avg),
    delay_std: r2(delayStd),
    sample_count: n,
    confidence,
    by_processor: profiles.sort((a, b) => b.sample_count - a.sample_count),
  }
}

// ─── Step 2d: Transfer Behavior Model ───────────────────────────────
//
// Classifies transfer patterns as:
//   periodic:  regular intervals with low variance (CV < 0.3)
//   irregular: some pattern but not consistent enough to predict reliably
//   unknown:   too few data points to determine

function buildTransferModel(movements: TaggedMovement[], cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): TransferBehaviorModel {
  const transfers: { amount: number; date: string; account: string | null }[] = []

  for (const m of movements) {
    if (m.tag.economic_class !== "transfer") continue
    if (m.tag.state_inclusion_policy === "exclude_and_review") continue
    transfers.push({ amount: m.amount, date: toDateStr(m.occurred_at), account: m.account_id ?? null })
  }

  if (transfers.length === 0) {
    return {
      avg_transfer_amount: 0, transfer_count: 0, trigger_pattern: "unknown",
      avg_interval_days: null, primary_account: null, secondary_account: null, confidence: "low",
    }
  }

  const sorted = transfers.sort((a, b) => a.date.localeCompare(b.date))
  const avgAmount = sorted.reduce((s, t) => s + t.amount, 0) / sorted.length

  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(daysBetween(sorted[i - 1].date, sorted[i].date))
  }
  const avgInterval = intervals.length > 0
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length
    : null

  const intervalStd = std(intervals)
  const cv = avgInterval && avgInterval > 0 ? intervalStd / avgInterval : Infinity

  const tm = cal.transfer_model
  let triggerPattern: TransferBehaviorModel["trigger_pattern"] = "unknown"
  if (avgInterval && cv < tm.periodic_cv && intervals.length >= 3) {
    triggerPattern = "periodic"
  } else if (intervals.length >= 3 && cv < tm.irregular_cv) {
    triggerPattern = "irregular"
  }

  // Detect low_balance pattern: transfers cluster after large outflow days.
  // Check if transfers tend to follow days with high net outflows (reactive sweeps).
  if (triggerPattern === "irregular" || triggerPattern === "unknown") {
    const allMovements = movements.filter((m) => m.tag.economic_class !== "transfer")
    const netByDate = new Map<string, number>()
    for (const m of allMovements) {
      const d = toDateStr(m.occurred_at)
      const sign = isInflow(m) ? 1 : -1
      netByDate.set(d, (netByDate.get(d) ?? 0) + m.amount * sign)
    }
    let lowBalanceTriggers = 0
    for (const t of sorted) {
      // Look at net flow in the 3 days before the transfer
      let priorNet = 0
      for (let lookback = 1; lookback <= 3; lookback++) {
        const priorDate = addDays(t.date, -lookback)
        priorNet += netByDate.get(priorDate) ?? 0
      }
      if (priorNet < -avgAmount * tm.low_balance_threshold) lowBalanceTriggers++
    }
    if (sorted.length >= 3 && lowBalanceTriggers / sorted.length > tm.low_balance_frequency) {
      triggerPattern = "low_balance"
    }
  }

  // Detect primary/secondary accounts by frequency
  const acctCounts = new Map<string, number>()
  for (const t of transfers) {
    if (t.account) acctCounts.set(t.account, (acctCounts.get(t.account) ?? 0) + 1)
  }
  const sortedAccts = [...acctCounts.entries()].sort((a, b) => b[1] - a[1])
  const primaryAccount = sortedAccts[0]?.[0] ?? null
  const secondaryAccount = sortedAccts[1]?.[0] ?? null

  let confidence: "high" | "medium" | "low" = "low"
  if (transfers.length >= 10 && triggerPattern === "periodic") confidence = "high"
  else if (transfers.length >= 5 && triggerPattern !== "unknown") confidence = "medium"
  else if (transfers.length >= 4 && triggerPattern === "low_balance") confidence = "medium"

  return {
    avg_transfer_amount: r2(avgAmount),
    transfer_count: transfers.length,
    trigger_pattern: triggerPattern,
    avg_interval_days: avgInterval ? Math.round(avgInterval) : null,
    primary_account: primaryAccount,
    secondary_account: secondaryAccount,
    confidence,
  }
}

// ─── Step 2e: Recurring Fixed Obligations ───────────────────────────

function buildRecurringFixed(movements: TaggedMovement[]): BehavioralModels["recurring_fixed"] {
  const groups = new Map<string, { amounts: number[]; dates: string[] }>()

  for (const m of movements) {
    if (!m.tag.is_recurring) continue
    if (!isOutflow(m)) continue
    if (m.tag.state_inclusion_policy === "exclude_and_review") continue

    const key = resolveEntityId(m)
    const cp = observedCounterparty(m)
    const label = resolveEntityName(key, cp, m.raw_description, "vendor")
    let g = groups.get(label)
    if (!g) { g = { amounts: [], dates: [] }; groups.set(label, g) }
    g.amounts.push(m.amount)
    g.dates.push(toDateStr(m.occurred_at))
  }

  const result: BehavioralModels["recurring_fixed"] = []
  for (const [label, g] of groups) {
    if (g.amounts.length < 2) continue
    const monthlyAmount = g.amounts.reduce((a, b) => a + b, 0) / Math.max(1, new Set(g.dates.map(monthKey)).size)
    const sortedDates = g.dates.sort()
    result.push({
      label,
      monthly_amount: r2(monthlyAmount),
      last_date: sortedDates[sortedDates.length - 1],
    })
  }

  return result.sort((a, b) => b.monthly_amount - a.monthly_amount)
}

// ─── Step 2 aggregate: Build all behavioral models ──────────────────

function buildInvoiceSignal(invoices: OutstandingInvoice[]): InvoiceSignal {
  if (invoices.length === 0) {
    return { invoices: [], total_outstanding: 0, total_overdue: 0, overdue_count: 0, avg_days_to_due: null }
  }
  const total = invoices.reduce((s, i) => s + i.amount_due, 0)
  const overdue = invoices.filter((i) => i.status === "overdue")
  const overdueTotal = overdue.reduce((s, i) => s + i.amount_due, 0)
  const dueDays = invoices.filter((i) => i.days_until_due != null).map((i) => i.days_until_due!)
  const avgDue = dueDays.length > 0 ? dueDays.reduce((a, b) => a + b, 0) / dueDays.length : null
  return {
    invoices, total_outstanding: r2(total), total_overdue: r2(overdueTotal),
    overdue_count: overdue.length, avg_days_to_due: avgDue != null ? r2(avgDue) : null,
  }
}

// ─── Seasonality Detection ───────────────────────────────────────────
//
// Detect month-over-month revenue patterns from historical movements.
// Returns peak/low months and monthly weights for forecast adjustment.

function detectSeasonality(movements: TaggedMovement[], cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): SeasonalityPattern | undefined {
  const sc = cal.seasonality_config
  const inflowMovements = movements.filter((m) => isInflow(m) && m.tag?.state_inclusion_policy !== "exclude_and_review")
  if (inflowMovements.length < sc.min_inflow_movements) return undefined

  // Group inflows by month
  const monthlyTotals = new Map<string, number>()
  for (const m of inflowMovements) {
    const key = monthKey(m.occurred_at)
    monthlyTotals.set(key, (monthlyTotals.get(key) ?? 0) + m.amount)
  }

  // Need at least 6 distinct months
  if (monthlyTotals.size < sc.min_distinct_months) return undefined

  // Calculate average monthly revenue
  const monthValues = [...monthlyTotals.values()]
  const avgMonthly = monthValues.reduce((a, b) => a + b, 0) / monthValues.length

  // Group by calendar month (1-12) to detect seasonal patterns
  const byCalendarMonth = new Map<number, number[]>()
  for (const [key, total] of monthlyTotals) {
    const month = parseInt(key.split("-")[1], 10)
    const existing = byCalendarMonth.get(month) ?? []
    existing.push(total)
    byCalendarMonth.set(month, existing)
  }

  // Calculate average for each calendar month
  const monthWeights: number[] = new Array(12).fill(1)
  const monthAverages: number[] = new Array(12).fill(0)
  
  for (let m = 1; m <= 12; m++) {
    const values = byCalendarMonth.get(m)
    if (values && values.length > 0) {
      const avg = values.reduce((a, b) => a + b, 0) / values.length
      monthAverages[m - 1] = avg
      // Weight is ratio to overall average (capped between 0.5 and 2.0)
      monthWeights[m - 1] = avgMonthly > 0 ? Math.max(sc.weight_floor, Math.min(sc.weight_ceiling, avg / avgMonthly)) : 1
    }
  }

  // Identify peak and low months (>20% above/below average)
  const peakMonths: number[] = []
  const lowMonths: number[] = []
  
  for (let m = 1; m <= 12; m++) {
    const weight = monthWeights[m - 1]
    if (weight > sc.peak_threshold) peakMonths.push(m)
    else if (weight < sc.low_threshold) lowMonths.push(m)
  }

  // Only return seasonality if there's meaningful variation
  const hasSeasonality = peakMonths.length > 0 || lowMonths.length > 0
  if (!hasSeasonality) return undefined

  return {
    peak_months: peakMonths,
    low_months: lowMonths,
    month_weights: monthWeights.map((w) => r2(w)),
  }
}

export function buildBehavioralModels(
  movements: TaggedMovement[],
  invoices: OutstandingInvoice[] = [],
  bills: OutstandingBill[] = [],
  entityProfiles: EntityPaymentProfile[] = [],
): BehavioralModels {
  // Build profile lookup maps for use during model creation
  const profileByEntityId = new Map<string, EntityPaymentProfile>()
  const profileByNormalizedName = new Map<string, EntityPaymentProfile>()
  for (const p of entityProfiles) {
    profileByEntityId.set(p.entity_id, p)
    // Also index by entity name from context if available
    const displayName = _ctx.entityNames.get(p.entity_id)
    if (displayName) {
      const nk = displayName.toLowerCase().replace(/[^a-z0-9]/g, "")
      if (nk.length >= 3) profileByNormalizedName.set(nk, p)
    }
  }

  const customers = buildCustomerModels(movements, invoices, undefined, profileByEntityId, profileByNormalizedName)
  const seasonality = detectSeasonality(movements)
  return {
    customers,
    vendors: buildVendorModels(movements, bills, profileByEntityId, profileByNormalizedName),
    settlement: buildSettlementModel(movements),
    transfers: buildTransferModel(movements),
    recurring_fixed: buildRecurringFixed(movements),
    invoice_signal: buildInvoiceSignal(invoices),
    seasonality,
  }
}

/**
 * Blend reconciled AR/AP models with raw behavioral models to improve confidence.
 * Reconciled models provide high-confidence signals from matched invoices/bills.
 * Raw models provide broader coverage but lower confidence.
 */
export function blendReconciledModels(
  rawModels: BehavioralModels,
  reconciledCustomers: Array<{
    entity_id: string
    entity_name: string
    stats: any
    movements: any[]
  }>,
  reconciledVendors: Array<{
    entity_id: string
    entity_name: string
    stats: any
    movements: any[]
  }>,
  entityGraph?: EntityGraphMap,
  clustering?: ClusteringResult,
): BehavioralModels {
  // Create lookup maps for reconciled models
  const reconCustomerMap = new Map(reconciledCustomers.map((c) => [c.entity_id, c]))
  const reconVendorMap = new Map(reconciledVendors.map((v) => [v.entity_id, v]))

  // Enhance customer models with reconciled data
  let enhancedCustomers = rawModels.customers.map((customer) => {
    const reconData = reconCustomerMap.get(customer.entity_id)
    if (!reconData) return customer

    // Determine confidence boost based on reconciled payment count and reliability
    let newConfidence: "high" | "medium" | "low" = customer.confidence
    let confidenceReason = ""

    if (reconData.stats.payment_count >= 5) {
      newConfidence = "high"
      confidenceReason = `High confidence: ${reconData.stats.payment_count} reconciled AR payments with ${Math.round(reconData.stats.reliability_score * 100)}% reliability`
    } else if (reconData.stats.payment_count >= 3) {
      newConfidence = customer.confidence === "low" ? "medium" : customer.confidence
      confidenceReason = `Medium confidence: ${reconData.stats.payment_count} reconciled AR payments`
    } else if (reconData.stats.payment_count >= 2) {
      if (customer.confidence === "low") {
        newConfidence = "medium"
        confidenceReason = `Upgraded to medium: ${reconData.stats.payment_count} reconciled AR payments`
      }
    }

    return {
      ...customer,
      confidence: newConfidence,
      payment_count: Math.max(customer.payment_count, reconData.stats.payment_count),
    }
  })

  // Enhance vendor models with reconciled data
  let enhancedVendors = rawModels.vendors.map((vendor) => {
    const reconData = reconVendorMap.get(vendor.entity_id)
    if (!reconData) return vendor

    // Determine confidence boost based on reconciled payment count and recurrence
    let newConfidence: "high" | "medium" | "low" = vendor.confidence
    let confidenceReason = ""

    if (reconData.stats.payment_count >= 5) {
      newConfidence = "high"
      confidenceReason = `High confidence: ${reconData.stats.payment_count} reconciled AP payments with ${Math.round(reconData.stats.recurrence_score * 100)}% recurrence`
    } else if (reconData.stats.payment_count >= 3) {
      newConfidence = vendor.confidence === "low" ? "medium" : vendor.confidence
      confidenceReason = `Medium confidence: ${reconData.stats.payment_count} reconciled AP payments`
    } else if (reconData.stats.payment_count >= 2) {
      if (vendor.confidence === "low") {
        newConfidence = "medium"
        confidenceReason = `Upgraded to medium: ${reconData.stats.payment_count} reconciled AP payments`
      }
    }

    return {
      ...vendor,
      confidence: newConfidence,
      payment_count: Math.max(vendor.payment_count, reconData.stats.payment_count),
    }
  })

  // Apply entity graph boosting if available
  if (entityGraph && clustering) {
    const customerModelMap = new Map(enhancedCustomers.map((c) => [c.entity_id, c]))
    const vendorModelMap = new Map(
      enhancedVendors.map((v) => [
        v.entity_id,
        {
          confidence: v.confidence,
          payment_count: v.payment_count,
          archetype: v.archetype || "episodic",
        },
      ])
    )

    const customerBoosts = enhancedCustomers.map((customer) =>
      boostCustomerConfidenceFromGraph(
        customer.entity_id,
        customer.confidence,
        customer.payment_count,
        entityGraph,
        clustering.anchorMap,
        customerModelMap
      )
    )

    const vendorBoosts = enhancedVendors.map((vendor) =>
      boostVendorConfidenceFromGraph(
        vendor.entity_id,
        vendor.confidence,
        vendor.payment_count,
        vendor.archetype || "episodic",
        entityGraph,
        clustering.anchorMap,
        vendorModelMap
      )
    )

    // Apply boosts to customers
    enhancedCustomers = enhancedCustomers.map((customer) => {
      const boost = customerBoosts.find((b) => b.entity_id === customer.entity_id)
      if (!boost || boost.boost_amount === 0) return customer

      return {
        ...customer,
        confidence: boost.boosted_confidence,
      }
    })

    // Apply boosts to vendors
    enhancedVendors = enhancedVendors.map((vendor) => {
      const boost = vendorBoosts.find((b) => b.entity_id === vendor.entity_id)
      if (!boost || boost.boost_amount === 0) return vendor

      return {
        ...vendor,
        confidence: boost.boosted_confidence,
      }
    })

    logEntityGraphBoosting(customerBoosts, vendorBoosts)
  }

  return {
    ...rawModels,
    customers: enhancedCustomers,
    vendors: enhancedVendors,
  }
}

/**
 * Enhance behavioral models with pre-computed entity payment profiles.
 * This uses rich historical data (avg_days_to_pay, on_time_rate, risk_score, etc.)
 * to improve forecast accuracy.
 */
function normalizeForecastEntityName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Invoice forecast reasoning is built before profile enhancement; refresh copy when profile adds payment history. */
function refreshInvoiceForecastsAfterProfileEnhance(c: CustomerModel): InvoiceForecast[] {
  if (c.payment_count <= 0 || c.invoice_forecasts.length === 0) return c.invoice_forecasts
  return c.invoice_forecasts.map((fc) => {
    if (!fc.reasoning.includes("no payment history") && !fc.reasoning.includes("Insufficient payment history")) {
      return fc
    }
    const tail = ` · ${c.payment_count} cash movements attributed to this customer (entity profile)`
    const stripped = fc.reasoning
      .replace(/\s*·\s*no payment history\.?/gi, "")
      .replace(/Insufficient payment history/gi, "Limited movement-tagged history")
    return { ...fc, reasoning: stripped + tail }
  })
}

function enhanceModelsWithProfiles(
  models: BehavioralModels,
  profiles: EntityPaymentProfile[],
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): BehavioralModels {
  if (profiles.length === 0) return models

  const profileByEntityId = new Map<string, EntityPaymentProfile>()
  const profileByNormalizedName = new Map<string, EntityPaymentProfile>()

  for (const p of profiles) {
    profileByEntityId.set(p.entity_id, p)
    const displayName = _ctx.entityNames.get(p.entity_id)
    if (displayName) {
      const nk = normalizeForecastEntityName(displayName)
      if (nk.length >= 3) profileByNormalizedName.set(nk, p)
    }
  }

  function resolveCustomerProfile(c: CustomerModel): EntityPaymentProfile | undefined {
    const byId = profileByEntityId.get(c.entity_id)
    if (byId) {
      if (byId.entity_type === "vendor") return undefined
      return byId
    }
    const byName = profileByNormalizedName.get(normalizeForecastEntityName(c.name))
    if (byName && byName.entity_type !== "vendor") return byName
    return undefined
  }

  function resolveVendorProfile(v: VendorModel): EntityPaymentProfile | undefined {
    const byId = profileByEntityId.get(v.entity_id)
    if (byId) {
      if (byId.entity_type === "customer") return undefined
      return byId
    }
    const byName = profileByNormalizedName.get(normalizeForecastEntityName(v.name))
    if (byName && byName.entity_type !== "customer") return byName
    return undefined
  }

  // Enhance customer models
  const enhancedCustomers = models.customers.map((c) => {
    const profile = resolveCustomerProfile(c)
    if (!profile) return c

    // Use profile's archetype if it has more data
    let archetype = c.archetype
    if (profile.transaction_count > c.payment_count && profile.archetype) {
      const archetypeMap: Record<string, CustomerArchetype> = {
        clockwork: "clockwork",
        slow_reliable: "slow_reliable",
        bursty: "bursty",
        volatile: "volatile",
        low_data: "low_data",
        episodic: "episodic",
      }
      archetype = archetypeMap[profile.archetype] ?? c.archetype
    }

    const txCount = Math.max(c.payment_count, profile.transaction_count ?? 0)
    const features = { ...c.features }
    if (txCount > c.features.payment_count) {
      features.payment_count = txCount
    }
    if (profile.avg_days_to_pay !== null) {
      features.avg_days_to_pay = profile.avg_days_to_pay
    }
    if (profile.std_days_to_pay !== null) {
      features.std_days_to_pay = profile.std_days_to_pay
    }
    if (profile.interval_cv !== null) {
      features.interval_cv = profile.interval_cv
    }
    if (profile.on_time_payment_rate !== null) {
      features.pct_overdue_paid = profile.on_time_payment_rate
    }

    let probability = c.probability_of_next
    const pe = cal.profile_enhancement
    if (profile.reliability_score !== null && profile.reliability_score > 0) {
      const profileProb = pe.reliability_boost_offset + profile.reliability_score * pe.reliability_boost_scale * 2.5
      probability = probability * pe.blend_model_weight + profileProb * pe.blend_profile_weight
    }
    if (profile.on_time_payment_rate !== null) {
      if (profile.on_time_payment_rate > pe.on_time_good_threshold) {
        probability = Math.min(pe.on_time_good_cap, probability * pe.on_time_good_mult)
      } else if (profile.on_time_payment_rate < pe.on_time_bad_threshold) {
        probability = probability * pe.on_time_bad_mult
      }
    }

    let confidence = c.confidence
    if (profile.transaction_count >= pe.high_conf_count && profile.reliability_score !== null && profile.reliability_score > pe.high_conf_reliability) {
      confidence = "high"
    } else if (profile.transaction_count >= pe.medium_conf_count && profile.reliability_score !== null && profile.reliability_score > pe.medium_conf_reliability) {
      confidence = confidence === "low" ? "medium" : confidence
    }

    let paymentIntervalDays = c.payment_interval_days
    if (profile.avg_interval_days !== null && profile.transaction_count > c.payment_count) {
      paymentIntervalDays = Math.round(profile.avg_interval_days)
    }

    return {
      ...c,
      archetype,
      features,
      payment_count: txCount,
      probability_of_next: r2(Math.max(cal.customer_probability.floor, Math.min(cal.customer_probability.ceiling, probability))),
      confidence,
      payment_interval_days: paymentIntervalDays,
    }
  })

  const enhancedVendors = models.vendors.map((v) => {
    const profile = resolveVendorProfile(v)
    if (!profile) return v

    const recurrence = { ...v.recurrence }
    if (profile.interval_cv !== null && profile.transaction_count >= 3) {
      const cvBasedConf = Math.max(0, 1 - profile.interval_cv)
      recurrence.recurrence_confidence = Math.max(recurrence.recurrence_confidence, cvBasedConf * 0.8)

      if (profile.interval_cv < cal.vendor_hard_recurrence_cv_max) {
        recurrence.recurrence_type = "hard"
      } else if (profile.interval_cv < cal.vendor_soft_recurrence_cv_max) {
        recurrence.recurrence_type = recurrence.recurrence_type === "unknown" ? "soft" : recurrence.recurrence_type
      }
    }

    let cadenceIntervalDays = v.cadence_interval_days
    if (profile.avg_interval_days !== null && profile.transaction_count > v.payment_count) {
      cadenceIntervalDays = Math.round(profile.avg_interval_days)
    }

    const vendTx = Math.max(v.payment_count, profile.transaction_count ?? 0)

    return {
      ...v,
      payment_count: vendTx,
      recurrence,
      cadence_interval_days: cadenceIntervalDays,
    }
  })

  return {
    ...models,
    customers: enhancedCustomers,
    vendors: enhancedVendors,
  }
}

// ─── Step 3: Event Generation Engine (next 30 days) ─────────────────
//
// Generate discrete future cash events from behavioral models.
// Each event has a date, type, entity, amount, probability, and confidence.

function getSeasonalWeight(date: string, seasonality: SeasonalityPattern | undefined): number {
  if (!seasonality) return 1
  const month = new Date(date).getMonth() // 0-indexed
  return seasonality.month_weights[month] ?? 1
}

function generateEvents30d(models: BehavioralModels, components: CashflowComponent[], cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): ForecastEvent[] {
  const events: ForecastEvent[] = []
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const horizon = addDays(today, 30)
  const seasonality = models.seasonality

  function generateRepeating(
    lastDate: string,
    intervalDays: number,
    maxOccurrences: number,
    emitFn: (date: string, offset: number) => void,
  ) {
    if (intervalDays <= 0) return
    let nextDate = addDays(lastDate, intervalDays)
    // If next date is past, advance by full intervals until we're in the future
    while (nextDate < today) {
      nextDate = addDays(nextDate, intervalDays)
    }
    let count = 0
    while (nextDate <= horizon && count < maxOccurrences) {
      const offset = daysBetween(today, nextDate)
      if (offset >= 1) emitFn(nextDate, offset)
      nextDate = addDays(nextDate, intervalDays)
      count++
    }
  }

  // Customer payment events — invoice-aware with archetype reasoning
  for (const c of models.customers) {
    if (c.probability_of_next < cal.event_generation.min_customer_prob) continue

    const openInvs = c.outstanding_invoices.filter((i) => i.amount_due > 0)
    const baseReasoning: EventReasoning = {
      basis: `${c.archetype} archetype, ${c.payment_count} prior payments`,
      payment_history: c.payment_count > 0
        ? `${c.payment_count} payments, avg $${c.avg_amount.toLocaleString()}, interval ~${c.payment_interval_days}d`
        : c.features.invoice_count > 0
          ? `Invoice-only in movement tags — ${c.features.invoice_count} open invoice(s); entity profile may still reflect bank history`
        : "No payment history — invoice-only customer",
      interval_info: c.payment_interval_days > 0
        ? `avg ${c.payment_interval_days}d (std ${c.interval_variance.toFixed(1)}d)`
        : undefined,
      amount_range: c.features.amount_std > 0
        ? `$${Math.max(0, c.features.amount_mean - c.features.amount_std).toLocaleString()} – $${(c.features.amount_mean + c.features.amount_std).toLocaleString()}`
        : `~$${c.avg_amount.toLocaleString()}`,
      recurrence_info: c.archetype === "clockwork" ? "Highly regular payer"
        : c.archetype === "bursty" ? "Clusters payments then pauses"
        : c.archetype === "slow_reliable" ? "Pays consistently but late"
        : c.archetype === "low_data" ? "Insufficient history — anchored to invoices"
        : c.archetype === "volatile" ? "Erratic timing and amounts"
        : "Project-based, opportunity-weighted",
    }

    if (openInvs.length > 0) {
      // Use invoice forecasts when available
      const invForecasts = c.invoice_forecasts.length > 0 ? c.invoice_forecasts : []

      for (let ii = 0; ii < openInvs.length; ii++) {
        const inv = openInvs[ii]
        const invFc = invForecasts.find((f) => f.invoice_id === inv.invoice_id)
        const dueDate = invFc?.expected_collection_date ?? inv.due_date ?? c.next_expected_date ?? addDays(today, 14)
        // Spread overdue invoices across days 2-7 instead of clustering on D+1
        let eventDate = dueDate < today ? addDays(today, Math.min(7, 2 + ii * 2)) : dueDate
        if (eventDate > horizon) continue
        const offset = daysBetween(today, eventDate)
        if (offset < 1) continue

        const prob = invFc
          ? (offset <= 7 ? invFc.probability_7d : offset <= 14 ? invFc.probability_14d : invFc.probability_30d)
          : inv.status === "overdue"
            ? Math.min(cal.event_generation.overdue_invoice_prob_cap, c.probability_of_next + cal.event_generation.overdue_invoice_prob_boost)
            : c.probability_of_next

        events.push({
          date: eventDate, day_offset: offset, type: "customer_payment",
          entity: c.name, amount: r2(inv.amount_due),
          direction: "in", probability: r2(prob),
          confidence: c.confidence === "low" ? "medium" : c.confidence,
          source_model: "customer",
          invoice_id: inv.invoice_id,
          reasoning: {
            ...baseReasoning,
            invoice_info: `Invoice $${inv.amount_due.toLocaleString()}, ${inv.status}${inv.days_overdue ? ` (${inv.days_overdue}d overdue)` : inv.days_until_due != null ? ` (due in ${inv.days_until_due}d)` : ""}`,
            basis: invFc?.reasoning ?? baseReasoning.basis,
          },
        })
      }
    } else {
      generateRepeating(c.last_payment_date, c.payment_interval_days, 5, (date, offset) => {
        const seasonalWeight = getSeasonalWeight(date, seasonality)
        events.push({
          date, day_offset: offset, type: "customer_payment",
          entity: c.name, amount: r2(c.avg_amount * seasonalWeight),
          direction: "in", probability: c.probability_of_next,
          confidence: c.confidence, source_model: "customer",
          reasoning: {
            ...baseReasoning,
            seasonality_info: seasonalWeight !== 1 ? `Seasonal adjustment: ${(seasonalWeight * 100).toFixed(0)}%` : undefined,
          },
        })
      })
    }
  }

  // Vendor payment events with recurrence reasoning
  const vendorBillEntities = new Set<string>()
  for (const v of models.vendors) {
    const vendReasoning: EventReasoning = {
      basis: `${v.recurrence.recurrence_type} recurrence (conf ${r2(v.recurrence.recurrence_confidence)}), ${v.payment_count} payments`,
      payment_history: `${v.payment_count} payments, avg $${v.avg_amount.toLocaleString()}`,
      interval_info: v.cadence_interval_days > 0 ? `${v.cadence} cadence (~${v.cadence_interval_days}d)` : undefined,
      amount_range: v.recurrence.amount_std && v.recurrence.amount_mean
        ? `$${Math.max(0, v.recurrence.amount_mean - v.recurrence.amount_std).toLocaleString()} – $${(v.recurrence.amount_mean + v.recurrence.amount_std).toLocaleString()}`
        : `~$${v.avg_amount.toLocaleString()}`,
      recurrence_info: v.recurrence.recurrence_type === "hard" ? "Tight recurring obligation"
        : v.recurrence.recurrence_type === "soft" ? "Somewhat regular payments"
        : v.recurrence.recurrence_type === "seasonal" ? "Seasonal payment pattern"
        : v.recurrence.recurrence_type === "episodic" ? "Irregular/project payments"
        : "Unknown recurrence pattern",
      risk_factors: v.recurrence.recurrence_type === "episodic" ? ["Timing uncertain — episodic vendor"] : undefined,
    }

    if (v.outstanding_bills.length > 0) {
      vendorBillEntities.add(v.entity_id)
      for (let bi = 0; bi < v.outstanding_bills.length; bi++) {
        const bill = v.outstanding_bills[bi]
        const dueDate =
          bill.due_date
          ?? (bill.days_until_due != null ? addDays(today, Math.max(1, bill.days_until_due)) : addDays(today, 7 + bi * 2))
        let rawOffset = daysBetween(today, dueDate)
        if (rawOffset < 1) rawOffset = 1
        // Bills due after the 30d UI window still matter for cash — map to horizon edge instead of dropping
        const beyond30 = rawOffset > 30
        const offset = beyond30 ? 30 : rawOffset
        // Stagger bills landing on the same date: spread by vendor to avoid cliff
        const stagger = bi * 1
        const adjustedOffset = Math.min(30, offset + stagger)
        const adjustedDate = addDays(today, adjustedOffset)
        const baseProb = bill.status === "overdue" ? cal.vendor_event_probability.bill_overdue_prob : cal.vendor_event_probability.bill_not_overdue_prob
        const prob = beyond30 ? Math.max(cal.event_generation.beyond_30d_prob_floor, baseProb * cal.event_generation.beyond_30d_prob_mult) : baseProb
        events.push({
          date: adjustedDate, day_offset: adjustedOffset, type: "vendor_payment",
          entity: v.name, amount: r2(bill.amount_due),
          direction: "out", probability: r2(prob),
          confidence: "high", source_model: "vendor",
          bill_id: bill.bill_id,
          reasoning: {
            ...vendReasoning,
            invoice_info: `Bill $${bill.amount_due.toLocaleString()}, ${bill.status}${bill.days_overdue ? ` (${bill.days_overdue}d overdue)` : ""}`,
            basis: beyond30
              ? `AP due ${dueDate} (beyond 30d — shown at D+30 for horizon summary)`
              : `AP bill due ${dueDate}`,
          },
        })
      }
      continue
    }

    if (!v.is_recurring && v.payment_count < cal.event_generation.vendor_min_payment_count) continue
    const recConf = v.recurrence.recurrence_confidence
    const recType = v.recurrence.recurrence_type
    // Don't generate repeating events for episodic/unknown vendors
    if (recType === "episodic" || recType === "unknown") continue
    if (recConf < cal.vendor_min_recurrence_confidence) continue
    const vep = cal.vendor_event_probability
    const prob = recType === "hard" ? Math.min(vep.hard_cap, vep.hard_base + recConf * vep.hard_conf_scale)
      : recType === "soft" ? Math.min(vep.soft_cap, vep.soft_base + recConf * vep.soft_conf_scale)
      : recType === "seasonal" ? Math.min(vep.seasonal_cap, vep.seasonal_base + recConf * vep.seasonal_conf_scale)
      : v.is_recurring ? vep.recurring_fallback : vep.non_recurring_fallback

    generateRepeating(v.last_payment_date, v.cadence_interval_days, 5, (date, offset) => {
      events.push({
        date, day_offset: offset, type: "vendor_payment",
        entity: v.name, amount: r2(v.avg_amount),
        direction: "out", probability: r2(prob),
        confidence: v.confidence, source_model: "vendor",
        reasoning: vendReasoning,
      })
    })
  }

  // Recurring fixed obligation events
  const vendorNames = new Set(models.vendors.map((v) => v.name.toLowerCase()))
  for (const rf of models.recurring_fixed) {
    if (vendorNames.has(rf.label.toLowerCase())) continue
    generateRepeating(rf.last_date, 30, 2, (date, offset) => {
      events.push({
        date, day_offset: offset, type: "recurring_expense",
        entity: rf.label, amount: r2(rf.monthly_amount),
        direction: "out", probability: cal.vendor_event_probability.recurring_fixed_prob,
        confidence: "high", source_model: "recurring",
        reasoning: {
          basis: `Fixed recurring obligation, $${rf.monthly_amount.toLocaleString()}/mo`,
          recurrence_info: "Monthly fixed cost",
        },
      })
    })
  }

  // Settlement events — per-processor when available
  if (models.settlement.confidence !== "insufficient" && models.settlement.sample_count >= cal.event_generation.settlement_min_samples) {
    if (models.settlement.by_processor.length > 0) {
      for (const proc of models.settlement.by_processor) {
        if (proc.sample_count < cal.event_generation.processor_min_samples) continue
        const monthlyAvg = components.find((c) => c.category === "processor_payouts" && c.direction === "in")?.monthly_avg ?? 0
        const procShare = proc.sample_count / Math.max(1, models.settlement.sample_count)
        const weeklyAmount = (monthlyAvg * procShare) / 4
        if (weeklyAmount < 1) continue
        for (let week = 0; week < 4; week++) {
          const offset = Math.round(7 * week + proc.avg_delay_days + 1)
          if (offset > 30) break
          events.push({
            date: addDays(today, offset), day_offset: offset, type: "settlement",
            entity: proc.processor, amount: r2(weeklyAmount),
            direction: "in", probability: cal.transfer_model.settlement_event_prob,
            confidence: proc.sample_count >= cal.event_generation.processor_high_conf_samples ? "high" : "medium",
            source_model: "settlement",
            reasoning: {
              basis: `${proc.processor}: avg ${proc.avg_delay_days.toFixed(1)}d delay, ${proc.sample_count} samples`,
              interval_info: `Settlement cadence ~${proc.avg_delay_days.toFixed(1)}d (std ${proc.delay_std.toFixed(1)}d)`,
              risk_factors: proc.fee_rate ? [`Fee rate ~${(proc.fee_rate * 100).toFixed(1)}%`] : undefined,
            },
          })
        }
      }
    } else {
      const settlementComp = components.find((c) => c.category === "processor_payouts" && c.direction === "in")
      if (settlementComp && settlementComp.monthly_avg > 0) {
        const weeklyAmount = settlementComp.monthly_avg / 4
        for (let week = 0; week < 4; week++) {
          const offset = Math.round(7 * week + models.settlement.avg_delay_days + 1)
          if (offset > 30) break
          events.push({
            date: addDays(today, offset), day_offset: offset, type: "settlement",
            entity: "Processor settlement", amount: r2(weeklyAmount),
            direction: "in", probability: cal.transfer_model.settlement_agg_prob,
            confidence: models.settlement.confidence === "high" ? "high" : "medium",
            source_model: "settlement",
            reasoning: {
              basis: `Aggregated settlement: avg ${models.settlement.avg_delay_days.toFixed(1)}d delay, ${models.settlement.sample_count} samples`,
            },
          })
        }
      }
    }
  }

  // Transfer events
  if (models.transfers.transfer_count >= cal.event_generation.transfer_min_count && models.transfers.trigger_pattern !== "unknown") {
    const transferEntity = models.transfers.primary_account ?? "Internal transfer"
    const transferReasoning: EventReasoning = {
      basis: `${models.transfers.trigger_pattern} pattern, ${models.transfers.transfer_count} historical transfers`,
      amount_range: `~$${models.transfers.avg_transfer_amount.toLocaleString()}`,
      interval_info: models.transfers.avg_interval_days ? `avg interval ~${models.transfers.avg_interval_days}d` : undefined,
    }

    if (models.transfers.trigger_pattern === "periodic" && models.transfers.avg_interval_days) {
      generateRepeating(
        addDays(today, -models.transfers.avg_interval_days),
        models.transfers.avg_interval_days, 3,
        (date, offset) => {
          events.push({
            date, day_offset: offset, type: "transfer",
            entity: transferEntity, amount: r2(models.transfers.avg_transfer_amount),
            direction: "in", probability: cal.transfer_model.periodic_event_prob,
            confidence: models.transfers.confidence as "high" | "medium" | "low",
            source_model: "transfer", reasoning: transferReasoning,
          })
        },
      )
    } else if (models.transfers.trigger_pattern === "low_balance") {
      const outflowDays = new Map<number, number>()
      for (const e of events) {
        if (e.direction === "out") outflowDays.set(e.day_offset, (outflowDays.get(e.day_offset) ?? 0) + e.amount * e.probability)
      }
      const sortedOutflowDays = [...outflowDays.entries()].sort((a, b) => b[1] - a[1])
      let transfersPlaced = 0
      for (const [outDay] of sortedOutflowDays) {
        if (transfersPlaced >= 2) break
        const triggerDay = Math.min(30, outDay + 2)
        events.push({
          date: addDays(today, triggerDay), day_offset: triggerDay, type: "transfer",
          entity: transferEntity, amount: r2(models.transfers.avg_transfer_amount),
          direction: "in", probability: cal.transfer_model.low_balance_event_prob, confidence: "medium", source_model: "transfer",
          reasoning: { ...transferReasoning, basis: `Reactive transfer: triggered by outflow cluster at D+${outDay}` },
        })
        transfersPlaced++
      }
    } else if (models.transfers.trigger_pattern === "irregular") {
      events.push({
        date: addDays(today, 15), day_offset: 15, type: "transfer",
        entity: transferEntity, amount: r2(models.transfers.avg_transfer_amount),
        direction: "in", probability: cal.transfer_model.irregular_event_prob, confidence: "low", source_model: "transfer",
        reasoning: { ...transferReasoning, risk_factors: ["Irregular pattern — low predictability"] },
      })
    }
  }

  // Deduplicate 1: same entity, day, direction, source, amount
  const deduped: ForecastEvent[] = []
  const seen = new Map<string, number>()
  for (const e of events) {
    const key = `${e.entity}|${e.day_offset}|${e.direction}|${e.source_model}|${r2(e.amount)}`
    const existing = seen.get(key)
    if (existing != null) {
      if (e.probability > deduped[existing].probability) deduped[existing] = e
      continue
    }
    seen.set(key, deduped.length)
    deduped.push(e)
  }

  // Deduplicate 2: same invoice/bill must appear once (one event with time distribution)
  // Merge duplicate events for same invoice_id or bill_id — keep highest-probability day
  const byLogicalPayment = new Map<string, ForecastEvent>()
  for (const e of deduped) {
    const invId = "invoice_id" in e ? (e as ForecastEvent & { invoice_id?: string }).invoice_id : undefined
    const billId = "bill_id" in e ? (e as ForecastEvent & { bill_id?: string }).bill_id : undefined
    if (e.type === "customer_payment" && invId) {
      const key = `inv:${invId}`
      const existing = byLogicalPayment.get(key)
      if (!existing || e.probability > existing.probability) byLogicalPayment.set(key, e)
      continue
    }
    if (e.type === "vendor_payment" && billId) {
      const key = `bill:${billId}`
      const existing = byLogicalPayment.get(key)
      if (!existing || e.probability > existing.probability) byLogicalPayment.set(key, e)
      continue
    }
    byLogicalPayment.set(`${e.entity}|${e.day_offset}|${e.direction}|${r2(e.amount)}`, e)
  }

  const final = [...byLogicalPayment.values()]
  return final.sort((a, b) => a.day_offset - b.day_offset || b.amount - a.amount)
}

// ─── Step 4: Aggregate component models (for scenario simulation) ───

type BucketedMovement = { amount: number; date: string; entity: string; is_recurring: boolean }
type ComponentBucket = { category: ComponentCategory; direction: "in" | "out"; label: string; movements: BucketedMovement[] }

function decomposeMovements(movements: TaggedMovement[]): ComponentBucket[] {
  const buckets = new Map<string, ComponentBucket>()
  for (const m of movements) {
    const cat = categorize(m)
    if (!cat) continue
    const key = `${cat.category}_${cat.direction}`
    let bucket = buckets.get(key)
    if (!bucket) { bucket = { ...cat, movements: [] }; buckets.set(key, bucket) }
    bucket.movements.push({
      amount: m.amount, date: toDateStr(m.occurred_at),
      entity: resolveEntityId(m),
      is_recurring: m.tag.is_recurring ?? false,
    })
  }
  return [...buckets.values()].filter((b) => b.movements.length > 0)
}

function detectBehavior(bucket: ComponentBucket, totalMonths: number, cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): ComponentBehavior {
  const cd = cal.component_detection
  const months = new Set(bucket.movements.map((m) => monthKey(m.date)))
  const coverage = months.size / Math.max(1, totalMonths)
  const recurringPct = bucket.movements.filter((m) => m.is_recurring).length / bucket.movements.length

  if (months.size >= 6) {
    const byCalMonth = new Map<number, number[]>()
    for (const m of bucket.movements) {
      const cm = new Date(m.date).getMonth()
      let arr = byCalMonth.get(cm)
      if (!arr) { arr = []; byCalMonth.set(cm, arr) }
      arr.push(m.amount)
    }
    const allAmounts = bucket.movements.map((m) => m.amount)
    const overallMean = allAmounts.reduce((a, b) => a + b, 0) / allAmounts.length
    if (overallMean > 0) {
      let peakMonths = 0
      let troughMonths = 0
      for (const [, amounts] of byCalMonth) {
        if (amounts.length < 2) continue
        const monthMean = amounts.reduce((a, b) => a + b, 0) / amounts.length
        const ratio = monthMean / overallMean
        if (ratio > cd.peak_deviation) peakMonths++
        else if (ratio < cd.trough_deviation) troughMonths++
      }
      if (peakMonths >= 1 && troughMonths >= 1) return "seasonal"
      if (peakMonths >= 2 || troughMonths >= 2) return "seasonal"
    }
  }

  if (recurringPct > cd.recurring_pct || coverage > cd.recurring_coverage) return "recurring"
  if (bucket.movements.length <= 2) return "one_time"
  if (coverage > cd.episodic_coverage) return "episodic"
  return "one_time"
}

function buildComponent(bucket: ComponentBucket, dataSpanDays: number, cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): CashflowComponent {
  const cd = cal.component_detection
  const totalMonths = Math.max(1, dataSpanDays / 30)
  const totalAmount = bucket.movements.reduce((s, m) => s + m.amount, 0)
  const monthlyAvg = totalAmount / totalMonths
  const monthlyCount = bucket.movements.length / totalMonths

  const monthTotals = new Map<string, number>()
  for (const m of bucket.movements) {
    const mk = monthKey(m.date)
    monthTotals.set(mk, (monthTotals.get(mk) ?? 0) + m.amount)
  }
  const monthValues = [...monthTotals.values()]
  const mean = monthValues.length > 0 ? monthValues.reduce((a, b) => a + b, 0) / monthValues.length : 0
  const volatility = mean > 0 ? std(monthValues) / mean : 0

  let trend = 0
  if (monthValues.length >= cd.min_trend_months) {
    const mid = Math.floor(monthValues.length / 2)
    const firstHalf = monthValues.slice(0, mid).reduce((a, b) => a + b, 0) / mid
    const secondHalf = monthValues.slice(mid).reduce((a, b) => a + b, 0) / (monthValues.length - mid)
    trend = firstHalf > 0 ? (secondHalf - firstHalf) / firstHalf : 0
  }

  const behavior = detectBehavior(bucket, totalMonths, cal)

  // Compute seasonal index: ratio of calendar-month average to overall mean
  let seasonal_index: Record<number, number> | null = null
  if (behavior === "seasonal" && mean > 0) {
    const calMonthTotals = new Map<number, number[]>()
    for (const m of bucket.movements) {
      const cm = new Date(m.date).getMonth()
      let arr = calMonthTotals.get(cm)
      if (!arr) { arr = []; calMonthTotals.set(cm, arr) }
      arr.push(m.amount)
    }
    seasonal_index = {}
    for (let cm = 0; cm < 12; cm++) {
      const vals = calMonthTotals.get(cm)
      if (vals && vals.length > 0) {
        const monthMean = vals.reduce((a, b) => a + b, 0) / vals.length
        seasonal_index[cm] = r2(monthMean / mean)
      } else {
        seasonal_index[cm] = 1.0
      }
    }
  }

  let confidence: "high" | "medium" | "low" = "low"
  if ((behavior === "recurring" || behavior === "seasonal") && monthValues.length >= cd.min_high_months && volatility < cd.high_conf_volatility) confidence = "high"
  else if (monthValues.length >= cd.min_medium_months && volatility < cd.medium_conf_volatility) confidence = "medium"

  const cappedTrend = Math.max(-cd.trend_cap, Math.min(cd.trend_cap, trend))
  const cappedVolatility = Math.min(cd.volatility_cap, volatility)

  return {
    id: `${bucket.category}_${bucket.direction}`,
    label: bucket.label, direction: bucket.direction, category: bucket.category,
    behavior, monthly_avg: r2(monthlyAvg), monthly_count: Math.round(monthlyCount * 10) / 10,
    trend: Math.round(cappedTrend * 1000) / 1000, volatility: Math.round(cappedVolatility * 1000) / 1000, confidence,
    seasonal_index,
  }
}

// ─── Step 4: Behavioral Simulation ──────────────────────────────────
//
// Instead of flat monthly_avg × multiplier, we now simulate from
// entity-level models with next-payment timing and probability.

function simulateMonthFromModels(
  models: BehavioralModels,
  components: CashflowComponent[],
  monthStart: string,
  monthEnd: string,
  scenarioMult: { inflow: number; outflow: number },
  monthIndex: number = 0,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): { inflows: number; outflows: number; componentAmounts: { component_id: string; amount: number }[] } {
  let inflows = 0
  let outflows = 0
  const componentAmounts: { component_id: string; amount: number }[] = []
  const mp = cal.monthly_projection

  // Customer receipts: bottom-up from entity models
  let customerTotal = 0
  
  // First, compute total expected from all customers with invoices
  // This represents the "invoice pipeline" that should convert to cash over time
  let totalInvoicePipeline = 0
  for (const c of models.customers) {
    if (c.outstanding_invoices.length > 0) {
      totalInvoicePipeline += c.outstanding_invoices.reduce((sum, inv) => sum + inv.amount_due, 0)
    }
  }
  
  for (const c of models.customers) {
    const dataQuality = Math.min(1, c.payment_count / mp.data_quality_count_norm) * (c.confidence === "high" ? 1 : c.confidence === "medium" ? mp.data_quality_conf_high : mp.data_quality_conf_low)
    const monthDecay = 1 / (1 + monthIndex * (cal.customer_decay_base - dataQuality * cal.customer_decay_data_quality_factor))

    if (c.next_expected_date && c.next_expected_date >= monthStart && c.next_expected_date < monthEnd) {
      // Expected payment falls in this month
      customerTotal += c.avg_amount * c.probability_of_next
    } else if (c.payment_interval_days > 0 && c.payment_interval_days <= 60) {
      // Has regular payment cadence
      const paymentsInMonth = Math.min(4, 30 / c.payment_interval_days)
      customerTotal += c.avg_amount * c.probability_of_next * paymentsInMonth * monthDecay
    } else if (c.outstanding_invoices.length > 0) {
      // Has invoices but no payment history - project based on invoice value
      // Use a conversion rate that decays over time (invoices get collected eventually)
      const totalOutstanding = c.outstanding_invoices.reduce((sum, inv) => sum + inv.amount_due, 0)
      // Month 0: expect 40% collection, Month 1: 30%, Month 2: 20%, etc.
      const collectionRate = Math.max(mp.invoice_collection_floor, mp.invoice_collection_base - monthIndex * mp.invoice_collection_decay)
      customerTotal += totalOutstanding * c.probability_of_next * collectionRate
    } else if (c.payment_count >= 2 && c.avg_amount > 0) {
      // Has some payment history but no invoices
      customerTotal += c.avg_amount * c.probability_of_next * monthDecay * mp.no_invoice_mult
    }
  }
  
  // If we have invoice pipeline but no customer total, use pipeline as fallback
  // This handles the case where all customers are invoice-only
  if (customerTotal === 0 && totalInvoicePipeline > 0) {
    // Assume invoices convert to cash over ~3 months with decay
    const pipelineConversion = Math.max(mp.pipeline_conversion_floor, mp.pipeline_conversion_base - monthIndex * mp.pipeline_conversion_decay)
    customerTotal = totalInvoicePipeline * pipelineConversion
  }

  // Portfolio floor: use historical data to set a minimum projection
  // The floor decays based on how much historical data we have
  const custComp = components.find((c) => c.category === "customer_receipts" && c.direction === "in")
  if (custComp && custComp.monthly_avg > 0) {
    const historicalAvg = custComp.monthly_avg
    // Compute floor decay from data: more volatile history = faster decay
    const volatilityFactor = Math.min(1, custComp.volatility ?? mp.default_volatility)
    const floorDecay = (1 - volatilityFactor * mp.floor_decay_volatility_coeff) / (1 + monthIndex * (cal.component_decay_base + volatilityFactor * cal.component_decay_volatility_factor))
    const portfolioFloor = historicalAvg * floorDecay
    if (customerTotal < portfolioFloor) {
      // Blend toward floor when bottom-up is weak
      const blendWeight = Math.min(1, customerTotal / portfolioFloor)
      customerTotal = customerTotal * blendWeight + portfolioFloor * (1 - blendWeight)
    }
  }

  if (customerTotal > 0) {
    customerTotal *= scenarioMult.inflow
    inflows += customerTotal
    componentAmounts.push({ component_id: "customer_receipts_in", amount: r2(customerTotal) })
  }

  // Track vendor entity IDs projected here to avoid double-counting with recurring_fixed
  const projectedVendorNames = new Set<string>()

  // Vendor payments: only project vendors with real recurrence evidence
  let vendorTotal = 0
  for (const v of models.vendors) {
    const recConf = v.recurrence?.recurrence_confidence ?? 0.3
    const recType = v.recurrence?.recurrence_type ?? "unknown"

    // Skip episodic/unknown vendors from monthly projection — they are noise
    if (recType === "episodic" || recType === "unknown") continue
    // Require minimum confidence to project
    if (recConf < mp.vendor_min_recurrence_conf) continue

    // Compute decay based on vendor's recurrence confidence
    const vendorDecay = 1 / (1 + monthIndex * (cal.vendor_decay_base - recConf * cal.vendor_decay_recurrence_factor))

    if (v.next_expected_date && v.next_expected_date >= monthStart && v.next_expected_date < monthEnd) {
      vendorTotal += v.avg_amount * Math.max(0.5, recConf)
      projectedVendorNames.add(v.name.toLowerCase())
    } else if ((recType === "hard" || recType === "soft" || recType === "seasonal") && v.cadence_interval_days > 0 && v.cadence_interval_days <= 45) {
      const paymentsInMonth = Math.min(4, 30 / v.cadence_interval_days)
      vendorTotal += v.avg_amount * paymentsInMonth * recConf * vendorDecay
      projectedVendorNames.add(v.name.toLowerCase())
    }
  }
  // Recurring fixed obligations — exclude those already counted via vendor models
  let recurringTotal = 0
  for (const rf of models.recurring_fixed) {
    if (projectedVendorNames.has(rf.label.toLowerCase())) continue
    recurringTotal += rf.monthly_amount
  }

  // Portfolio floor for vendor outflows: many "episodic" vendors are actually monthly
  // but have too few data points to classify as recurring. Use historical average as floor.
  const vendComp = components.find((c) => c.category === "vendor_payments" && c.direction === "out")
  const combinedVendorProjection = vendorTotal + recurringTotal
  if (vendComp && vendComp.monthly_avg > 0) {
    const historicalVendorAvg = vendComp.monthly_avg
    const vendorFloorDecay = mp.vendor_floor_base / (1 + monthIndex * mp.vendor_floor_decay)
    const vendorFloor = historicalVendorAvg * vendorFloorDecay
    if (combinedVendorProjection < vendorFloor) {
      // Scale up vendor projection to meet the floor
      const gap = vendorFloor - combinedVendorProjection
      vendorTotal += gap
    }
  }

  if (vendorTotal > 0) {
    vendorTotal *= scenarioMult.outflow
    outflows += vendorTotal
    componentAmounts.push({ component_id: "vendor_payments_out", amount: r2(vendorTotal) })
  }

  if (recurringTotal > 0) {
    recurringTotal *= scenarioMult.outflow
    outflows += recurringTotal
    componentAmounts.push({ component_id: "recurring_expenses_out", amount: r2(recurringTotal) })
  }

  // Non-entity components: use aggregate models for remaining categories
  const targetMonth = new Date(monthStart).getMonth()
  for (const comp of components) {
    if (comp.category === "customer_receipts" && comp.direction === "in") continue
    if (comp.category === "vendor_payments" && comp.direction === "out") continue
    if (comp.category === "recurring_expenses" && comp.direction === "out") continue

    let amount = comp.monthly_avg
    if (comp.behavior === "one_time") continue
    
    // Compute decay based on component's volatility
    const compVolatility = comp.volatility ?? mp.default_volatility
    const compDecay = 1 / (1 + monthIndex * (cal.component_decay_base + compVolatility * cal.component_decay_volatility_factor))
    if (comp.behavior === "episodic") amount *= mp.episodic_component_mult * compDecay

    if (comp.behavior === "seasonal" && comp.seasonal_index) {
      const idx = comp.seasonal_index[targetMonth]
      if (idx != null) amount *= idx
    }

    const mult = comp.direction === "in" ? scenarioMult.inflow : scenarioMult.outflow
    amount *= mult

    if (amount > 0) {
      if (comp.direction === "in") inflows += amount
      else outflows += amount
      componentAmounts.push({ component_id: comp.id, amount: r2(amount) })
    }
  }

  return { inflows: r2(inflows), outflows: r2(outflows), componentAmounts }
}

// ─── Step 5: Daily Cashflow Simulator ────────────────────────────────
//
// cash[t+1] = cash[t] + inflows[t] - outflows[t]
// Runs day-by-day for 30 days using generated events.
//
// Uses expected value: amount × probability for each event.
// High-probability events (≥0.8) contribute near full amount.
// Low-probability events still contribute proportionally rather than
// being zeroed out, which gives a more accurate deterministic projection.
// Monte Carlo handles the full distribution of outcomes.

function simulateDaily(events: ForecastEvent[], startingCash: number): DailySimulation {
  const today = new Date().toISOString().slice(0, 10)

  const eventsByDay = new Map<number, ForecastEvent[]>()
  for (const e of events) {
    const day = e.day_offset
    let list = eventsByDay.get(day)
    if (!list) { list = []; eventsByDay.set(day, list) }
    list.push(e)
  }

  const days: DailySimDay[] = []
  let cash = startingCash
  let minCash = startingCash
  let minCashDay = 0

  for (let d = 1; d <= 30; d++) {
    const dayEvents = eventsByDay.get(d) ?? []
    let dayInflows = 0
    let dayOutflows = 0
    const eventSummaries: DailySimDay["events"] = []

    for (const e of dayEvents) {
      const ev = r2(e.amount * e.probability)
      if (ev < 1) continue
      if (e.direction === "in") dayInflows += ev
      else dayOutflows += ev
      eventSummaries.push({ entity: e.entity, amount: ev, direction: e.direction })
    }

    cash = r2(cash + dayInflows - dayOutflows)

    if (cash < minCash) { minCash = cash; minCashDay = d }

    days.push({
      day: d,
      date: addDays(today, d),
      cash,
      inflows: r2(dayInflows),
      outflows: r2(dayOutflows),
      events: eventSummaries,
    })
  }

  return {
    starting_cash: r2(startingCash),
    days,
    min_cash: r2(minCash),
    min_cash_day: minCashDay,
    ending_cash: r2(cash),
  }
}

function computeSeparatedForecast(events: ForecastEvent[], today: string): SeparatedForecast {
  const eventsByDay = new Map<number, ForecastEvent[]>()
  for (const e of events) {
    const day = e.day_offset
    if (day < 1 || day > 30) continue
    let list = eventsByDay.get(day)
    if (!list) { list = []; eventsByDay.set(day, list) }
    list.push(e)
  }

  const days: SeparatedForecastDay[] = []
  let opIn = 0, opOut = 0, settIn = 0, settOut = 0, treasIn = 0, treasOut = 0, ownerIn = 0, ownerOut = 0

  for (let d = 1; d <= 30; d++) {
    const dayEvents = eventsByDay.get(d) ?? []
    let dOpIn = 0, dOpOut = 0, dSettIn = 0, dSettOut = 0, dTreasIn = 0, dTreasOut = 0, dOwnerIn = 0, dOwnerOut = 0

    for (const e of dayEvents) {
      const ev = r2(e.amount * e.probability)
      if (ev < 1) continue

      if (e.type === "settlement") {
        if (e.direction === "in") { dSettIn += ev; settIn += ev } else { dSettOut += ev; settOut += ev }
      } else if (e.type === "transfer") {
        if (e.direction === "in") { dTreasIn += ev; treasIn += ev } else { dTreasOut += ev; treasOut += ev }
      } else if (e.type === "customer_payment" || e.type === "vendor_payment" || e.type === "recurring_expense" || e.type === "processor_fee" || e.type === "debt_payment") {
        if (e.direction === "in") { dOpIn += ev; opIn += ev } else { dOpOut += ev; opOut += ev }
      } else {
        if (e.direction === "in") { dOwnerIn += ev; ownerIn += ev } else { dOwnerOut += ev; ownerOut += ev }
      }
    }

    days.push({
      day: d,
      date: addDays(today, d),
      operating_in: r2(dOpIn),
      operating_out: r2(dOpOut),
      settlement_in: r2(dSettIn),
      settlement_out: r2(dSettOut),
      treasury_in: r2(dTreasIn),
      treasury_out: r2(dTreasOut),
      owner_in: r2(dOwnerIn),
      owner_out: r2(dOwnerOut),
    })
  }

  return {
    days,
    operating_30d_in: r2(opIn),
    operating_30d_out: r2(opOut),
    settlement_30d_in: r2(settIn),
    settlement_30d_out: r2(settOut),
    treasury_30d_in: r2(treasIn),
    treasury_30d_out: r2(treasOut),
    owner_30d_in: r2(ownerIn),
    owner_30d_out: r2(ownerOut),
  }
}

// ─── Step 6: Monte Carlo Simulation ─────────────────────────────────
//
// Run N simulations with randomness:
//   - Payment delays (shift events ±days)
//   - Amount variance (gaussian noise around avg)
//   - Missed payments (bernoulli based on probability)
//
// Output: percentile bands + probability queries

function gaussianRandom(): number {
  // Box-Muller transform for normal distribution (using seeded PRNG)
  let u = 0, v = 0
  while (u === 0) u = seededRandom()
  while (v === 0) v = seededRandom()
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

type MCScenarioBias = {
  inflow_prob_mult: number
  outflow_prob_mult: number
  inflow_amount_mult: number
  outflow_amount_mult: number
  inflow_delay_bias: number
  outflow_delay_bias: number
}

function getMCScenarioBiases(cal: ForecastCalibrationParams): Record<string, MCScenarioBias> {
  return {
  base: {
    inflow_prob_mult: 1.0, outflow_prob_mult: 1.0,
    inflow_amount_mult: 1.0, outflow_amount_mult: 1.0,
    inflow_delay_bias: 0, outflow_delay_bias: 0,
  },
    conservative: cal.monte_carlo_config.scenario_biases.conservative,
    aggressive: cal.monte_carlo_config.scenario_biases.aggressive,
  }
}

function runSingleMonteCarlo(events: ForecastEvent[], startingCash: number, bias: MCScenarioBias, cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): number[] {
  const cashByDay = new Array<number>(31).fill(0)
  let cash = startingCash
  const dailyFlows = new Array<number>(31).fill(0)
  const mc = cal.monte_carlo_config

  for (const e of events) {
    const isIn = e.direction === "in"
    const probMult = isIn ? bias.inflow_prob_mult : bias.outflow_prob_mult
    const effectiveProb = Math.min(1, e.probability * probMult)

    if (seededRandom() > effectiveProb) continue

    const amountMult = isIn ? bias.inflow_amount_mult : bias.outflow_amount_mult
    const noiseFactor = e.confidence === "high" ? mc.noise_high : e.confidence === "medium" ? mc.noise_medium : mc.noise_low
    const amountNoise = 1 + gaussianRandom() * noiseFactor
    const amount = Math.max(0, e.amount * amountMult * amountNoise)

    const delayBias = isIn ? bias.inflow_delay_bias : bias.outflow_delay_bias
    const delayRange = e.confidence === "high" ? mc.delay_high : e.confidence === "medium" ? mc.delay_medium : mc.delay_low
    const delay = Math.round(gaussianRandom() * delayRange * mc.delay_mult + delayBias)
    const adjustedDay = Math.max(1, Math.min(30, e.day_offset + delay))

    if (isIn) dailyFlows[adjustedDay] += amount
    else dailyFlows[adjustedDay] -= amount
  }

  for (let d = 1; d <= 30; d++) {
    cash += dailyFlows[d]
    cashByDay[d] = cash
  }

  return cashByDay
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function runMonteCarlo(events: ForecastEvent[], startingCash: number, numSims: number = 500, cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): MonteCarloResult {
  const scenarioBiases = getMCScenarioBiases(cal)
  const baseBias = scenarioBiases.base
  const mc = cal.monte_carlo_config

  // Run base simulations for percentile bands + probability queries
  const allRuns: number[][] = []
  for (let i = 0; i < numSims; i++) {
    allRuns.push(runSingleMonteCarlo(events, startingCash, baseBias, cal))
  }

  const percentiles: MonteCarloPercentile[] = []
  for (let d = 1; d <= 30; d++) {
    const dayValues = allRuns.map((run) => run[d]).sort((a, b) => a - b)
    percentiles.push({
      day: d,
      p5: r2(percentile(dayValues, mc.percentile_worst)),
      p25: r2(percentile(dayValues, 25)),
      p50: r2(percentile(dayValues, 50)),
      p75: r2(percentile(dayValues, 75)),
      p95: r2(percentile(dayValues, mc.percentile_best)),
    })
  }

  const cash14d = allRuns.map((r) => r[14])
  const cash30d = allRuns.map((r) => r[30])

  const probBelowZero14d = r2(cash14d.filter((c) => c < 0).length / numSims)
  const probBelowZero30d = r2(cash30d.filter((c) => c < 0).length / numSims)
  const probAboveStarting30d = r2(cash30d.filter((c) => c > startingCash).length / numSims)

  const sorted30d = [...cash30d].sort((a, b) => a - b)
  const expected30d = cash30d.reduce((a, b) => a + b, 0) / numSims
  const worst30d = sorted30d[Math.floor(numSims * mc.percentile_worst / 100)]
  const best30d = sorted30d[Math.floor(numSims * mc.percentile_best / 100)]

  const scenarioSims = mc.biased_sim_count
  const day_scenarios: DayScenarioSnapshot[] = []

  const scenarioDefs: { key: string; scenario: DayScenarioSnapshot["scenario"]; label: string }[] = [
    { key: "base", scenario: "base", label: "Normal behavior" },
    { key: "conservative", scenario: "conservative", label: "Delayed collections, higher outflows" },
    { key: "aggressive", scenario: "aggressive", label: "Faster collections, reduced spend" },
  ]

  for (const def of scenarioDefs) {
    const bias = scenarioBiases[def.key]
    const runs: number[][] = []
    for (let i = 0; i < scenarioSims; i++) {
      runs.push(runSingleMonteCarlo(events, startingCash, bias, cal))
    }

    const vals14 = runs.map((r) => r[14]).sort((a, b) => a - b)
    const vals30 = runs.map((r) => r[30]).sort((a, b) => a - b)
    const median14 = percentile(vals14, 50)
    const median30 = percentile(vals30, 50)

    // Find worst day across median path
    const medianPath = new Array<number>(31)
    for (let d = 1; d <= 30; d++) {
      const dayVals = runs.map((r) => r[d]).sort((a, b) => a - b)
      medianPath[d] = percentile(dayVals, 50)
    }
    let minCash = startingCash
    let minDay = 0
    for (let d = 1; d <= 30; d++) {
      if (medianPath[d] < minCash) { minCash = medianPath[d]; minDay = d }
    }

    day_scenarios.push({
      scenario: def.scenario,
      label: def.label,
      cash_14d: r2(median14),
      cash_30d: r2(median30),
      min_cash: r2(minCash),
      min_cash_day: minDay,
    })
  }

  return {
    simulations: numSims,
    percentiles,
    prob_below_zero_14d: probBelowZero14d,
    prob_below_zero_30d: probBelowZero30d,
    prob_above_starting_30d: probAboveStarting30d,
    expected_cash_30d: r2(expected30d),
    worst_case_cash_30d: r2(worst30d),
    best_case_cash_30d: r2(best30d),
    day_scenarios,
  }
}

// ─── Step 7: Scenario Engine ────────────────────────────────────────
//
// Monthly scenarios now use behavioral biases consistent with Monte Carlo
// instead of flat percentage multipliers.

type ScenarioConfig = {
  scenario: "base" | "optimistic" | "pessimistic"
  label: string
  customer_prob_mult: number
  inflow_amount_mult: number
  outflow_amount_mult: number
  trend_dampening: number
}

function buildScenarios(ctx: ForecastContext | null, cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): ScenarioConfig[] {
  const ms = cal.monthly_scenarios
  const riskScore = ctx?.risk_score ?? 0
  const concRisk = ctx?.concentration_risk_score ?? 0
  const depRisk = ctx?.dependency_risk_score ?? 0
  const regime = ctx?.liquidity_regime ?? "stable"
  const hasTransitions = (ctx?.transitions ?? []).some((t) => t.regime_change)

  const pessInflowMult = ms.pess_inflow_base - (concRisk > 50 ? ms.pess_inflow_conc_penalty : 0) - (hasTransitions ? ms.pess_inflow_transition_penalty : 0)
  const pessOutflowMult = ms.pess_outflow_base + (depRisk > 50 ? ms.pess_outflow_dep_penalty : 0) + (regime === "tightening" ? ms.pess_outflow_regime_penalty : 0)
  const pessCustProb = ms.pess_cust_prob_base - (riskScore > 60 ? ms.pess_cust_prob_risk_high : riskScore > 40 ? ms.pess_cust_prob_risk_mid : 0)

  return [
    {
      scenario: "base", label: "Base case",
      customer_prob_mult: 1.0, inflow_amount_mult: 1.0,
      outflow_amount_mult: 1.0, trend_dampening: 1.0,
    },
    {
      scenario: "optimistic", label: "Optimistic — faster collections, stable costs",
      customer_prob_mult: ms.opt_cust_prob, inflow_amount_mult: ms.opt_inflow_mult,
      outflow_amount_mult: ms.opt_outflow_mult, trend_dampening: ms.opt_trend_dampening,
    },
    {
      scenario: "pessimistic", label: `Pessimistic — risk-adjusted${riskScore > 50 ? " (elevated risk)" : ""}`,
      customer_prob_mult: r2(pessCustProb), inflow_amount_mult: r2(pessInflowMult),
      outflow_amount_mult: r2(pessOutflowMult), trend_dampening: ms.pess_trend_dampening,
    },
  ]
}

function runScenario(
  models: BehavioralModels,
  components: CashflowComponent[],
  horizonMonths: number,
  startingCash: number,
  config: ScenarioConfig,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): ScenarioResult {
  const months: ForecastMonth[] = []
  let cumulativeNet = startingCash
  const now = new Date()

  for (let i = 0; i < horizonMonths; i++) {
    const futureDate = new Date(now.getFullYear(), now.getMonth() + i + 1, 1)
    const monthLabel = `${futureDate.getFullYear()}-${String(futureDate.getMonth() + 1).padStart(2, "0")}`
    const monthStart = futureDate.toISOString().slice(0, 10)
    const monthEndDate = new Date(futureDate.getFullYear(), futureDate.getMonth() + 1, 0)
    const monthEnd = monthEndDate.toISOString().slice(0, 10)

    // trend_dampening affects how quickly projections decay over time
    // Higher values = slower decay = more optimistic about future months
    // Base: 1.0, Optimistic: 1.2 (slower decay), Pessimistic: 0.5 (faster decay)
    const decayFactor = 1 / (1 + i * cal.monthly_scenarios.decay_coefficient / config.trend_dampening)

    const { inflows, outflows, componentAmounts } = simulateMonthFromModels(
      models, components, monthStart, monthEnd,
      { inflow: config.inflow_amount_mult * decayFactor, outflow: config.outflow_amount_mult },
      i,
      cal,
    )

    // Adjust customer inflows by probability multiplier
    const customerComp = componentAmounts.find((c) => c.component_id === "customer_receipts_in")
    if (customerComp && config.customer_prob_mult !== 1.0) {
      const delta = customerComp.amount * (config.customer_prob_mult - 1)
      customerComp.amount = r2(customerComp.amount + delta)
      // Recompute total inflows
    }

    let adjInflows = 0
    let adjOutflows = 0
    for (const ca of componentAmounts) {
      // Determine direction from component_id suffix or lookup in components
      const comp = components.find((c) => c.id === ca.component_id)
      const isInflow = comp?.direction === "in" || ca.component_id.endsWith("_in")
      if (isInflow) adjInflows += ca.amount
      else adjOutflows += ca.amount
    }

    const net = adjInflows - adjOutflows
    cumulativeNet += net

    months.push({
      month: monthLabel,
      inflows: r2(adjInflows), outflows: r2(adjOutflows),
      net: r2(net),
      cumulative_net: r2(cumulativeNet),
      components: componentAmounts,
    })
  }

  let runwayMonths: number | null = null
  for (let i = 0; i < months.length; i++) {
    if (months[i].cumulative_net < 0) { runwayMonths = i; break }
  }

  return {
    scenario: config.scenario, label: config.label, months,
    runway_months: runwayMonths, ending_cash: r2(cumulativeNet),
  }
}

// ─── Step 8: Narrative Generator ─────────────────────────────────────
//
// Deterministic rules that turn simulation outputs into
// Forecast / Risk / Insight / Action statements.

function money(n: number): string {
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function generateNarrative(
  mc: MonteCarloResult,
  sim: DailySimulation,
  models: BehavioralModels,
  events: ForecastEvent[],
  startingCash: number,
  ctx: ForecastContext | null = null,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): ForecastNarrative {
  // Guard: if no events or no simulation data, return safe defaults
  if (events.length === 0 || mc.percentiles.length === 0) {
    return {
      forecast: `Current cash position: ${money(startingCash)} — insufficient data to project forward`,
      risk: "Insufficient transaction history to quantify risk",
      insight: "More transaction data is needed for meaningful cash flow analysis",
      action: "Connect additional bank accounts or wait for more transaction history",
      severity: "caution",
    }
  }

  const base = mc.day_scenarios.find((s) => s.scenario === "base")
  const cash14 = base?.cash_14d ?? mc.percentiles[13]?.p50 ?? startingCash
  const cash30 = base?.cash_30d ?? mc.expected_cash_30d

  // ── Forecast ──
  const delta14 = cash14 - startingCash
  const absDelta = money(Math.abs(delta14))
  const nr = cal.narrative

  let forecast: string
  if (Math.abs(delta14) < startingCash * nr.flat_threshold) {
    forecast = `Projected cash in 14 days: ${money(cash14)} (roughly flat from ${money(startingCash)})`
  } else if (delta14 >= 0) {
    forecast = `Projected cash in 14 days: ${money(cash14)} (+${absDelta} from ${money(startingCash)})`
  } else {
    forecast = `Projected cash in 14 days: ${money(cash14)} (-${absDelta} from ${money(startingCash)})`
  }

  // ── Risk ──
  let risk: string
  const safeStarting = Math.max(1, startingCash)
  const threshold50 = safeStarting * nr.risk_50pct
  const probBelowThreshold14 = mc.percentiles[13]
    ? (mc.percentiles[13].p5 < threshold50 ? "elevated" : "low")
    : "unknown"

  if (mc.prob_below_zero_14d > nr.risk_prob_threshold) {
    risk = `${Math.round(mc.prob_below_zero_14d * 100)}% chance of running out of cash in 14 days`
  } else if (mc.prob_below_zero_30d > nr.risk_prob_threshold) {
    risk = `${Math.round(mc.prob_below_zero_30d * 100)}% chance of running out of cash in 30 days`
  } else if (sim.min_cash < threshold50 && sim.min_cash_day > 0 && startingCash > 0) {
    const dropPct = Math.round(((startingCash - sim.min_cash) / safeStarting) * 100)
    risk = `Cash could drop to ${money(sim.min_cash)} around day ${sim.min_cash_day} — ${dropPct}% below current position`
  } else if (probBelowThreshold14 === "elevated") {
    risk = `5th-percentile scenario drops below ${money(threshold50)} within 14 days`
  } else {
    const spread = mc.best_case_cash_30d - mc.worst_case_cash_30d
    risk = `Cash range in 30 days: ${money(mc.worst_case_cash_30d)} to ${money(mc.best_case_cash_30d)} (${money(spread)} spread)`
  }

  // Enrich risk with state context
  if (ctx) {
    if (ctx.concentration_risk_score > nr.concentration_risk_threshold) {
      risk += ` · Revenue concentration elevated (top customer ${ctx.top_customer_pct}%)`
    }
    if (ctx.dependency_risk_score > nr.dependency_risk_threshold) {
      risk += ` · Operating dependency only ${Math.round(ctx.operating_dependency_ratio * 100)}%`
    }
  }

  // ── Insight ──
  let insight: string
  const inflowEvents = events.filter((e) => e.direction === "in")
  const outflowEvents = events.filter((e) => e.direction === "out")
  const inflowTotal = inflowEvents.reduce((s, e) => s + e.amount, 0)
  const outflowTotal = outflowEvents.reduce((s, e) => s + e.amount, 0)
  const lowConfInflows = inflowEvents.filter((e) => e.confidence === "low")

  const topCustomer = models.customers[0]
  const customerTotal = models.customers.reduce((s, c) => s + c.avg_amount * c.payment_count, 0)
  const topCustomerShare = topCustomer && customerTotal > 0
    ? (topCustomer.avg_amount * topCustomer.payment_count) / customerTotal
    : 0

  if (inflowEvents.length > 0 && lowConfInflows.length > inflowEvents.length * nr.low_conf_inflow_fraction) {
    insight = `Cash volatility is driven by irregular customer payments — ${lowConfInflows.length} of ${inflowEvents.length} expected inflows are low confidence`
  } else if (topCustomerShare > nr.top_customer_share && topCustomer) {
    insight = `${Math.round(topCustomerShare * 100)}% of expected inflows come from ${topCustomer.name} — cash position is sensitive to their payment timing`
  } else if (models.transfers.trigger_pattern === "irregular" && models.transfers.transfer_count >= 5) {
    insight = `Liquidity relies on irregular transfers (${models.transfers.transfer_count} observed with no clear pattern) — cash position depends on manual intervention`
  } else if (inflowTotal > 0 && outflowTotal > inflowTotal * nr.outflow_excess_ratio) {
    insight = `Expected outflows exceed inflows by ${Math.round(((outflowTotal - inflowTotal) / inflowTotal) * 100)}% — net cash position will tighten`
  } else if (models.settlement.avg_delay_days > nr.settlement_delay_threshold && models.settlement.confidence !== "insufficient") {
    insight = `Settlement cadence averaging ${models.settlement.avg_delay_days.toFixed(1)} days between payouts affects cash arrival timing`
  } else if (outflowTotal > 0) {
    const recurringVendorNames = new Set(models.vendors.filter((v) => v.is_recurring).map((v) => v.name))
    const recurringAmount = outflowEvents.filter((e) =>
      e.type === "recurring_expense" || (e.type === "vendor_payment" && recurringVendorNames.has(e.entity))
    ).reduce((s, e) => s + e.amount, 0)
    const recurringPct = recurringAmount / outflowTotal
    const pctRound = Math.round(recurringPct * 100)
    if (recurringPct >= nr.recurring_high) {
      insight = `Near-term outflows are dominated by recurring obligations (~${pctRound}% of modeled spend) — spend base is highly fixed`
    } else if (recurringPct > nr.recurring_moderate) {
      insight = `~${pctRound}% of expected outflows come from recurring patterns — spend base is largely fixed with some variable spend`
    } else {
      insight = `~${pctRound}% of expected outflows are recurring — spend base is moderately flexible`
    }
  } else {
    insight = "Cash position is primarily driven by inflow timing — outflow obligations are minimal"
  }

  // Enrich insight with state-level context
  if (ctx) {
    if (ctx.repeat_revenue_ratio < nr.repeat_revenue_threshold && ctx.repeat_revenue_ratio > 0) {
      insight += ` · Revenue retention is weak (${Math.round(ctx.repeat_revenue_ratio * 100)}% repeat)`
    }
    if (ctx.recurring_spend_ratio > nr.recurring_spend_threshold) {
      insight += ` · Spend base is ${Math.round(ctx.recurring_spend_ratio * 100)}% fixed obligations`
    }
    const regimeTransition = ctx.transitions.find((t) => t.regime_change)
    if (regimeTransition) {
      insight += ` · ${regimeTransition.description}`
    }
  }

  // ── Action ──
  let action: string
  const topCustomers = models.customers.slice(0, 2).filter((c) => c.probability_of_next > nr.action_prob_threshold)
  const topCustomerCash = topCustomers.reduce((s, c) => s + c.avg_amount, 0)

  const conservative = mc.day_scenarios.find((s) => s.scenario === "conservative")
  const conservativeGap = conservative ? Math.max(0, cash14 - conservative.cash_14d) : 0

  if (topCustomers.length >= 1 && topCustomerCash > safeStarting * nr.action_cash_significance) {
    const riskReduction = conservativeGap > 0
      ? Math.min(nr.risk_reduction_cap, Math.round((topCustomerCash / Math.max(1, conservativeGap)) * 100))
      : nr.risk_reduction_default
    const names = topCustomers.map((c) => c.name).join(" and ")
    action = `Accelerating payments from ${names} (~${money(topCustomerCash)}) reduces downside risk by ~${riskReduction}%`
  } else if (models.recurring_fixed.length > nr.obligation_count_threshold && models.recurring_fixed[0] && models.recurring_fixed[0].monthly_amount > safeStarting * nr.obligation_significance) {
    const topObligation = models.recurring_fixed[0]
    action = `Review top recurring obligation (${topObligation.label}: ${money(topObligation.monthly_amount)}/mo) for cost reduction opportunity`
  } else if (models.transfers.trigger_pattern === "irregular" && models.transfers.transfer_count >= 5) {
    action = `Set up a regular transfer schedule — current transfers are irregular, making cash position harder to predict`
  } else if (mc.prob_below_zero_30d > nr.credit_line_threshold) {
    action = `Secure a credit line or prepay arrangements to cover the ${Math.round(mc.prob_below_zero_30d * 100)}% scenario where cash goes negative`
  } else {
    action = `Cash position is stable — focus on accelerating top customer collections to build buffer`
  }

  // ── Severity ──
  let severity: ForecastNarrative["severity"] = "healthy"
  if (mc.prob_below_zero_14d > nr.severity_danger_prob || sim.min_cash < 0) {
    severity = "danger"
  } else if (
    mc.prob_below_zero_30d > nr.severity_caution_prob ||
    (startingCash > 0 && sim.min_cash < startingCash * nr.severity_caution_drop) ||
    (startingCash > 0 && cash14 < startingCash * nr.severity_caution_14d)
  ) {
    severity = "caution"
  }

  return { forecast, risk, insight, action, severity }
}

// ─── Step 9: Forecast Confidence ─────────────────────────────────────

function computeForecastConfidence(
  models: BehavioralModels,
  components: CashflowComponent[],
  events: ForecastEvent[],
  dataSpanDays: number,
  backtest: BacktestResult | null,
  movements?: TaggedMovement[],
  bills: OutstandingBill[] = [],
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
  settlementTimingConfidence: any = null,
): ForecastConfidence {
  const reasons: string[] = []
  const by_component: ComponentConfidence[] = []
  const cw = cal.confidence_weights
  const cs = cal.confidence_scoring

  // ── 0. Transaction tagging & unresolved (from movements) ──
  let transactionTaggingScore = 1
  let unresolvedExposureScore = 1
  let hasUnresolvedOrExcluded = false
  if (movements && movements.length > 0) {
    const unknownCount = movements.filter((m) => m.tag?.economic_class === "unknown").length
    const excludedCount = movements.filter((m) => m.tag?.state_inclusion_policy === "exclude_and_review").length
    transactionTaggingScore = Math.max(0, 1 - unknownCount / movements.length)
    const unresolvedPct = unknownCount / movements.length
    unresolvedExposureScore = Math.max(0, 1 - unresolvedPct * 2) // heavy penalty for many unknown
    if (unknownCount > 0 || excludedCount > 0) hasUnresolvedOrExcluded = true
  }

  // ── 1. Inflow model confidence (weight: 0.20) ──
  // Revenue-weighted: high-value customers with strong archetypes matter more
  const custTotal = models.customers.length
  let inflowScore = 0
  if (custTotal > 0) {
    const totalRevenue = models.customers.reduce((s, c) => s + c.avg_amount * c.payment_count, 0)
    if (totalRevenue > 0) {
      let weightedConf = 0
      for (const c of models.customers) {
        const weight = (c.avg_amount * c.payment_count) / totalRevenue
        const archetypeBonus = cs.archetype_bonus[c.archetype] ?? 0.15
        const confMult = cs.confidence_mult[c.confidence] ?? 0.25
        weightedConf += weight * archetypeBonus * confMult
      }
      inflowScore = weightedConf
    } else {
      const custHigh = models.customers.filter((c) => c.confidence === "high").length
      const custMed = models.customers.filter((c) => c.confidence === "medium").length
      inflowScore = (custHigh * 1 + custMed * 0.6) / custTotal
    }
  }
  if (inflowScore < cs.inflow_low_threshold) reasons.push("Top inflows are sparse or episodic")
  const inflowLabel: ComponentConfidence["label"] = inflowScore >= cs.inflow_low_label_threshold ? "high" : inflowScore >= 0.4 ? "medium" : "low"
  const archetypeBreakdown = custTotal > 0 ? (() => {
    const counts: Record<string, number> = {}
    models.customers.forEach((c) => { counts[c.archetype] = (counts[c.archetype] ?? 0) + 1 })
    return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")
  })() : "No customers"
  by_component.push({
    area: "Inflow models", score: r2(inflowScore), label: inflowLabel,
    reason: `${custTotal} customers (${archetypeBreakdown}) — revenue-weighted`,
  })

  // ── 2. Outflow model confidence (weight: 0.20) ──
  const vendTotal = models.vendors.length
  const apOpenBills = bills.filter((b) => b.amount_due > 0)
  const apOutComp = components.find((c) => c.category === "vendor_payments" && c.direction === "out")
  let outflowScore = 0
  if (vendTotal > 0) {
    const totalSpend = models.vendors.reduce((s, v) => s + v.avg_amount * Math.max(1, v.payment_count), 0)
    if (totalSpend > 0) {
      let weightedConf = 0
      for (const v of models.vendors) {
        const weight = (v.avg_amount * Math.max(1, v.payment_count)) / totalSpend
        const recBonus = v.recurrence.recurrence_confidence
        const confMult = cs.vendor_conf_mult[v.confidence] ?? 0.25
        weightedConf += weight * recBonus * confMult
      }
      outflowScore = weightedConf
    } else {
      const vendHigh = models.vendors.filter((v) => v.confidence === "high").length
      const vendMed = models.vendors.filter((v) => v.confidence === "medium").length
      outflowScore = (vendHigh * 1 + vendMed * 0.6) / vendTotal
    }
  }
  if (vendTotal === 0 && (apOpenBills.length > 0 || (apOutComp && apOutComp.monthly_avg > 0))) {
    const base = cs.outflow_fallback_base
    const compBoost = apOutComp && apOutComp.monthly_avg > 0 ? Math.min(cs.outflow_fallback_comp_cap, Math.log10(1 + apOutComp.monthly_avg) / cs.outflow_fallback_comp_divisor) : 0
    const billBoost = Math.min(cs.outflow_fallback_bill_cap, apOpenBills.length * cs.outflow_fallback_bill_scale)
    outflowScore = Math.min(cs.outflow_fallback_total_cap, base + compBoost + billBoost)
  }
  if (outflowScore < cs.outflow_weak_threshold) reasons.push("Outflow models are weak — vendor recurrence uncertain")
  const outflowLabel: ComponentConfidence["label"] = outflowScore >= cs.outflow_label_high ? "high" : outflowScore >= cs.outflow_label_medium ? "medium" : "low"
  const recurrenceBreakdown = vendTotal > 0 ? (() => {
    const counts: Record<string, number> = {}
    models.vendors.forEach((v) => { counts[v.recurrence.recurrence_type] = (counts[v.recurrence.recurrence_type] ?? 0) + 1 })
    return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")
  })() : apOpenBills.length > 0 ? `AP from ${apOpenBills.length} open bill(s)` : "No vendors"
  by_component.push({
    area: "Outflow models", score: r2(outflowScore), label: outflowLabel,
    reason: vendTotal > 0
      ? `${vendTotal} vendors (${recurrenceBreakdown}) — spend-weighted`
      : apOpenBills.length > 0 || apOutComp
        ? `${recurrenceBreakdown}${apOutComp ? ` · component ~$${apOutComp.monthly_avg.toLocaleString()}/mo` : ""}`
        : `${vendTotal} vendors (${recurrenceBreakdown}) — spend-weighted`,
  })

  // ── 3. Settlement confidence (weight: 0.10) ──
  // Use settlement timing data from reconciled movements if available
  let settScore = cs.settlement_score_map[models.settlement.confidence as keyof typeof cs.settlement_score_map] ?? 0.1
  let settReason = models.settlement.sample_count === 0
    ? "No settlement data"
    : `${models.settlement.sample_count} samples across ${models.settlement.by_processor.length} processor(s), avg ${models.settlement.avg_delay_days.toFixed(1)}d`
  
  // Boost settlement confidence if we have empirical settlement timing data
  if (settlementTimingConfidence && settlementTimingConfidence.overall_confidence > 0) {
    const empiricalConfidence = settlementTimingConfidence.overall_confidence
    settScore = Math.max(settScore, empiricalConfidence * 0.9) // Cap at 90% to leave room for uncertainty
    settReason = `Empirical settlement timing: AR ${(settlementTimingConfidence.ar_confidence * 100).toFixed(0)}% (${settlementTimingConfidence.ar_count} entities), AP ${(settlementTimingConfidence.ap_confidence * 100).toFixed(0)}% (${settlementTimingConfidence.ap_count} entities)`
  }
  
  by_component.push({
    area: "Settlement timing", score: r2(settScore),
    label: settScore >= 0.7 ? "high" : settScore >= 0.4 ? "medium" : "low",
    reason: settReason,
  })

  // ── 4. Identity coverage confidence (weight: 0.10) ──
  const totalEntities = models.customers.length + models.vendors.length
  const allEntities = [...models.customers, ...models.vendors]
  const highConf = allEntities.filter((e) =>
    !e.name.startsWith("Customer #") && !e.name.startsWith("Vendor #") && !e.name.startsWith("Entity #")
    && !e.name.startsWith("Unknown") && !e.name.includes("unnamed")
  ).length
  const weakInferred = allEntities.filter((e) =>
    e.name.startsWith("Customer #") || e.name.startsWith("Vendor #") || e.name.startsWith("Entity #")
  ).length
  const unresolved = allEntities.filter((e) =>
    e.name.startsWith("Unknown") || e.name.includes("unnamed")
  ).length
  const identityScore = totalEntities > 0 ? highConf / totalEntities : 0
  const identity_breakdown: IdentityBreakdown | undefined = totalEntities > 0 ? {
    high_confidence_canonical_pct: r2((highConf / totalEntities) * 100),
    weak_inferred_pct: r2((weakInferred / totalEntities) * 100),
    unresolved_pct: r2((unresolved / totalEntities) * 100),
  } : undefined
  if (identityScore < 0.7) reasons.push("Many entities unresolved — identity coverage gaps")
  const identityReason = identity_breakdown
    ? `High-confidence: ${highConf} · Weak/inferred: ${weakInferred} · Unresolved: ${unresolved}`
    : `${highConf}/${totalEntities} entities resolved`
  by_component.push({
    area: "Identity coverage", score: r2(identityScore),
    label: identityScore >= 0.8 ? "high" : identityScore >= 0.6 ? "medium" : "low",
    reason: identityReason,
  })

  // ── 5. Recurrence confidence (weight: 0.10) ──
  let recurrenceScore = 0
  if (vendTotal > 0) {
    const totalRecConf = models.vendors.reduce((s, v) => s + v.recurrence.recurrence_confidence, 0)
    recurrenceScore = totalRecConf / vendTotal
  } else if (apOpenBills.length > 0) {
    recurrenceScore = Math.min(cs.recurrence_fallback_cap, cs.recurrence_fallback_base + Math.min(cs.recurrence_fallback_cap - cs.recurrence_fallback_base, apOpenBills.length * cs.recurrence_fallback_bill_scale))
  }
  by_component.push({
    area: "Recurrence quality", score: r2(recurrenceScore),
    label: recurrenceScore >= cs.recurrence_label_high ? "high" : recurrenceScore >= cs.recurrence_label_medium ? "medium" : "low",
    reason: vendTotal === 0 && apOpenBills.length === 0
      ? "No vendor recurrence data"
      : vendTotal === 0
        ? `AP obligations from ${apOpenBills.length} open bill(s) (due-date cadence)`
        : `Avg recurrence confidence: ${(recurrenceScore * 100).toFixed(0)}%`,
  })

  // ── 6. Data span confidence (weight: 0.10) ──
  const monthsOfData = Math.max(1, dataSpanDays / 30)
  const dataSpanScore = Math.min(1, monthsOfData / cs.data_span_target_months)
  if (monthsOfData < 3) reasons.push("Less than 3 months of data")
  if (monthsOfData < 1) reasons.push("Less than 1 month of data — forecast is speculative")
  by_component.push({
    area: "Data span", score: r2(dataSpanScore),
    label: dataSpanScore >= 0.7 ? "high" : dataSpanScore >= 0.4 ? "medium" : "low",
    reason: `${monthsOfData.toFixed(1)} months of history (target: 6+)`,
  })

  // ── 7. Variance penalty (weight: 0.10) ──
  const avgVolatility = components.length > 0
    ? components.reduce((s, c) => s + c.volatility, 0) / components.length : 0
  const variancePenalty = Math.min(cs.variance_penalty_base, avgVolatility * cs.variance_penalty_scale)
  const varianceScore = Math.max(0, 1 - variancePenalty * 2)
  if (avgVolatility > 0.8) reasons.push("High volatility in cashflow components")
  by_component.push({
    area: "Stability", score: r2(varianceScore),
    label: varianceScore >= 0.7 ? "high" : varianceScore >= 0.4 ? "medium" : "low",
    reason: `Avg component volatility: ${(avgVolatility * 100).toFixed(0)}%`,
  })

  // ── 8. Backtest confidence (weight: 0.10) ──
  // accuracy_score is 0-100, normalize to 0-1 for the composite
  const hasBacktest = backtest !== null
  const backtestScore = hasBacktest ? Math.min(1, backtest.accuracy_score / 100) : 0
  by_component.push({
    area: "Backtest accuracy", score: r2(backtestScore),
    label: hasBacktest ? (backtestScore >= 0.7 ? "high" : backtestScore >= 0.4 ? "medium" : "low") : "low",
    reason: hasBacktest
      ? `${backtest.days_tested}d tested, direction accuracy ${(backtest.direction_accuracy * 100).toFixed(0)}%, MAE $${backtest.mean_absolute_error.toLocaleString()}`
      : "No backtest data available",
  })

  // ── 9. Entity graph coverage (weight: 0.05) ──
  // Bonus confidence from entity relationships
  const customerIds = models.customers.map((c) => c.entity_id)
  const vendorIds = models.vendors.map((v) => v.entity_id)
  let entityGraphScore = 0
  let entityGraphReason = "No entity relationships available"
  
  // This will be populated if entity graph is available during forecast computation
  // For now, we use a conservative default
  if (customerIds.length > 0 || vendorIds.length > 0) {
    // Placeholder: actual score will be computed in forecast engine
    entityGraphScore = 0.3
    entityGraphReason = "Entity relationships not yet analyzed"
  }
  
  by_component.push({
    area: "Entity relationships", score: r2(entityGraphScore),
    label: entityGraphScore >= 0.7 ? "high" : entityGraphScore >= 0.4 ? "medium" : "low",
    reason: entityGraphReason,
  })

  // ── Weighted composite score ──
  // When backtest is unavailable, redistribute its weight proportionally to other components
  const backtestWeight = hasBacktest ? cw.backtest : 0
  const redistributionScale = hasBacktest ? 1 : 1 / (1 - cw.backtest)
  const weightedScore =
    inflowScore * cw.inflow * redistributionScale +
    outflowScore * cw.outflow * redistributionScale +
    settScore * cw.settlement * redistributionScale +
    identityScore * cw.identity * redistributionScale +
    recurrenceScore * cw.recurrence * redistributionScale +
    dataSpanScore * cw.dataSpan * redistributionScale +
    varianceScore * cw.stability * redistributionScale +
    entityGraphScore * 0.05 +
    backtestScore * backtestWeight

  const score = Math.max(cs.composite_floor, Math.min(hasUnresolvedOrExcluded ? cs.composite_ceiling : 1, weightedScore))
  const label: ForecastConfidence["label"] = score >= cs.label_high ? "high" : score >= cs.label_medium ? "medium" : "low"
  if (reasons.length === 0) reasons.push("Forecast based on sufficient data and stable models")

  const modelCoverage = components.length > 0
    ? components.filter((c) => c.confidence !== "low").length / components.length : 0
  const dataCompleteness = dataSpanScore

  // Explicit 8-component breakdown for programmatic use
  const componentsOut: ForecastConfidenceComponents = {
    transaction_tagging: r2(transactionTaggingScore),
    entity_resolution: r2(identityScore),
    inflow_model: r2(inflowScore),
    outflow_model: r2(outflowScore),
    recurrence: r2(recurrenceScore),
    calibration: r2(backtestScore),
    horizon_penalty: r2(dataSpanScore),
    unresolved_exposure: r2(unresolvedExposureScore),
  }

  // Build diagnostic sentence
  const weakest = by_component.reduce((min, c) => c.score < min.score ? c : min, by_component[0])
  const strongest = by_component.reduce((max, c) => c.score > max.score ? c : max, by_component[0])
  const diagnosis = score < cs.label_medium
    ? `Forecast is ${label} confidence because ${weakest.area.toLowerCase()} is weak (${(weakest.score * 100).toFixed(0)}%) — ${weakest.reason}`
    : `Forecast is ${label} confidence — strongest: ${strongest.area.toLowerCase()} (${(strongest.score * 100).toFixed(0)}%), weakest: ${weakest.area.toLowerCase()} (${(weakest.score * 100).toFixed(0)}%)`

  // Trust engine: why low, how to improve, what would make wrong
  const weakComponents = by_component.filter((c) => c.score < 0.5).sort((a, b) => a.score - b.score)
  const why_confidence_low = weakComponents.slice(0, 4).map((c) => `${c.area}: ${(c.score * 100).toFixed(0)}% — ${c.reason}`)
  const how_to_improve: string[] = []
  if (dataSpanScore < 0.5) how_to_improve.push("Track 2+ more months of transaction history")
  if (identityScore < 0.7) how_to_improve.push("Resolve entity names — confirm top 5 receivables/payables manually")
  if (recurrenceScore < 0.4) how_to_improve.push("Track 2 more cycles of vendor payments for recurrence patterns")
  if (inflowScore < 0.5) how_to_improve.push("Add invoice due dates or confirm customer payment cadence")
  if (outflowScore < 0.5) how_to_improve.push("Link AP or confirm vendor payment schedules")
  if (backtestScore < 0.5 && hasBacktest) how_to_improve.push("Backtest accuracy is low — more stable transaction patterns would help")
  if (backtestScore < 0.5 && !hasBacktest) how_to_improve.push("Need 10+ training transactions for backtest validation")
  if (how_to_improve.length === 0) how_to_improve.push("Forecast is already well-supported by data")

  const what_would_make_wrong = score < 0.6
    ? `Prediction could be wrong if: ${weakComponents.slice(0, 2).map((c) => c.area.toLowerCase()).join(" worsens, or ")} — or if a key customer/vendor deviates from pattern`
    : "Main risk: key customer delays payment or vendor demands earlier payment than modeled"

  return {
    score: r2(score), label,
    model_coverage: r2(modelCoverage),
    data_completeness: r2(dataCompleteness),
    variance_penalty: r2(variancePenalty),
    reasons, by_component, components: componentsOut, identity_breakdown, diagnosis,
    why_confidence_low: why_confidence_low.length > 0 ? why_confidence_low : undefined,
    how_to_improve: how_to_improve.length > 0 ? how_to_improve : undefined,
    what_would_make_wrong,
  }
}

// ─── Step 10: Cash Runway ────────────────────────────────────────────

function computeCashRunway(
  scenarios: ScenarioResult[],
  startingCash: number,
  dataSpanDays: number,
): CashRunway {
  const baseScenario = scenarios.find((s) => s.scenario === "base")
  const pessScenario = scenarios.find((s) => s.scenario === "pessimistic")

  // Monthly burn rate from base scenario
  const baseMonths = baseScenario?.months ?? []
  const totalNet = baseMonths.reduce((s, m) => s + m.net, 0)
  const avgMonthlyNet = baseMonths.length > 0 ? totalNet / baseMonths.length : 0
  const monthlyBurn = avgMonthlyNet < 0 ? Math.abs(avgMonthlyNet) : 0

  let baseRunway: number | null = null
  if (monthlyBurn > 0) {
    baseRunway = r2(startingCash / monthlyBurn)
  } else if (avgMonthlyNet >= 0) {
    baseRunway = null // cash positive — no runway concern
  }

  let pessRunway: number | null = pessScenario?.runway_months ?? null
  if (pessRunway === null && pessScenario) {
    const pessMonths = pessScenario.months
    const pessNet = pessMonths.reduce((s, m) => s + m.net, 0) / Math.max(1, pessMonths.length)
    if (pessNet < 0) pessRunway = r2(startingCash / Math.abs(pessNet))
  }

  return {
    base_months: baseRunway,
    pessimistic_months: pessRunway,
    monthly_burn_rate: r2(monthlyBurn),
    months_of_data: r2(dataSpanDays / 30),
  }
}

// ─── Step 11: Sensitivity Analysis ───────────────────────────────────

function computeSensitivity(
  events: ForecastEvent[],
  models: BehavioralModels,
  mc: MonteCarloResult,
  startingCash: number,
): SensitivityAnalysis {
  const drivers: SensitivityDriver[] = []
  const seenEntities = new Set<string>()
  const baseCash30 = mc.expected_cash_30d

  // Aggregate inflows by entity name to deduplicate
  const inflowByEntity = new Map<string, number>()
  const outflowByEntity = new Map<string, number>()
  for (const e of events) {
    const key = e.entity.toLowerCase()
    const expected = e.amount * e.probability
    if (e.direction === "in") {
      inflowByEntity.set(key, (inflowByEntity.get(key) ?? 0) + expected)
    } else {
      outflowByEntity.set(key, (outflowByEntity.get(key) ?? 0) + expected)
    }
  }

  // Customer impact: deduplicated by name
  for (const c of models.customers.slice(0, 8)) {
    const key = c.name.toLowerCase()
    if (seenEntities.has(key)) continue
    seenEntities.add(key)
    const customerCash = inflowByEntity.get(key) ?? 0
    if (customerCash <= 0) continue
    const impactPct = r2((customerCash / Math.max(1, Math.abs(baseCash30))) * 100)
    drivers.push({
      entity: c.name,
      type: "customer",
      impact_pct: Math.min(100, impactPct),
      direction: "positive",
      description: `${c.name} contributes ~$${Math.round(customerCash).toLocaleString()} in expected inflows`,
    })
  }

  // Vendor impact: deduplicated by name
  for (const v of models.vendors.slice(0, 8)) {
    const key = v.name.toLowerCase()
    if (seenEntities.has(key)) continue
    seenEntities.add(key)
    const vendorCash = outflowByEntity.get(key) ?? 0
    if (vendorCash <= 0) continue
    const impactPct = r2((vendorCash / Math.max(1, Math.abs(baseCash30))) * 100)
    drivers.push({
      entity: v.name,
      type: "vendor",
      impact_pct: Math.min(100, impactPct),
      direction: "negative",
      description: `${v.name} drains ~$${Math.round(vendorCash).toLocaleString()} in expected outflows`,
    })
  }

  // Transfer impact
  const transferEvents = events.filter((e) => e.type === "transfer")
  if (transferEvents.length > 0) {
    const transferCash = transferEvents.reduce((s, e) => s + e.amount * e.probability, 0)
    const impactPct = r2((transferCash / Math.max(1, Math.abs(baseCash30))) * 100)
    drivers.push({
      entity: "Internal transfers",
      type: "transfer",
      impact_pct: Math.min(100, impactPct),
      direction: "positive",
      description: `Transfers contribute ~$${Math.round(transferCash).toLocaleString()} — driven by ${models.transfers.trigger_pattern} pattern`,
    })
  }

  // Recurring obligations impact
  const recurringCash = models.recurring_fixed.reduce((s, r) => s + r.monthly_amount, 0)
  if (recurringCash > 0) {
    const impactPct = r2((recurringCash / Math.max(1, Math.abs(baseCash30))) * 100)
    drivers.push({
      entity: "Recurring obligations",
      type: "recurring",
      impact_pct: Math.min(100, impactPct),
      direction: "negative",
      description: `${models.recurring_fixed.length} recurring obligations total ~$${Math.round(recurringCash).toLocaleString()}/mo`,
    })
  }

  drivers.sort((a, b) => b.impact_pct - a.impact_pct)

  const topRisk = drivers.find((d) => d.direction === "negative")?.entity ?? "None identified"
  const topOpp = drivers.find((d) => d.direction === "positive")?.entity ?? "None identified"

  return {
    drivers: drivers.slice(0, 8),
    top_risk_driver: topRisk,
    top_opportunity_driver: topOpp,
  }
}

// ─── Step 12: Intervention Engine ────────────────────────────────────

function computeInterventions(
  events: ForecastEvent[],
  models: BehavioralModels,
  mc: MonteCarloResult,
  startingCash: number,
  dailySim?: DailySimulation,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): Intervention[] {
  const iv = cal.interventions
  const interventions: Intervention[] = []
  const baseCash14 = mc.day_scenarios.find((s) => s.scenario === "base")?.cash_14d ?? mc.expected_cash_30d
  const baseCash30 = mc.expected_cash_30d
  const baseRisk30 = mc.prob_below_zero_30d
  const baseLowPoint = dailySim?.min_cash ?? baseCash14 * iv.base_low_point_fallback
  const stressProb = mc.prob_below_zero_14d > iv.stress_prob_threshold ? mc.prob_below_zero_14d : mc.prob_below_zero_30d

  // Accelerate top customer collections
  for (const c of models.customers.slice(0, 3)) {
    if (c.probability_of_next < iv.accel_min_prob) continue
    const expectedCash = c.avg_amount * c.probability_of_next
    if (expectedCash < iv.accel_min_cash) continue
    const impact14 = r2(expectedCash * iv.accel_impact_14d)
    const impact30 = r2(expectedCash * iv.accel_impact_30d)
    const riskReduction = baseRisk30 > 0 ? r2(Math.min(iv.accel_risk_cap, (expectedCash / Math.max(1, startingCash)) * 100)) : 0

    const simImpact: ActionSimulationImpact = {
      low_point_before: baseLowPoint,
      low_point_after: r2(baseLowPoint + impact14 * iv.accel_low_point),
      stress_prob_before: stressProb,
      stress_prob_after: r2(Math.max(0, stressProb - riskReduction / 100)),
    }
    interventions.push({
      id: `accel_${c.entity_id}`,
      label: `Accelerate ${c.name} by ${iv.accel_days} days`,
      type: "accelerate_collection",
      entity: c.name,
      parameter_days: iv.accel_days,
      parameter_pct: null,
      impact_cash_14d: impact14,
      impact_cash_30d: impact30,
      impact_risk_reduction: riskReduction,
      description: `If ${c.name} pays ${iv.accel_days} days earlier, expected cash improves by ~$${Math.round(impact14).toLocaleString()} at day 14`,
      plausible_range_low: r2(impact14 * iv.plausible_low),
      plausible_range_high: r2(impact14 * iv.plausible_high),
      confidence_band: c.confidence === "high" ? "medium" : "low-medium",
      assumptions: ["Customer agrees to accelerate payment", "No discount required"],
      simulation_impact: simImpact,
    })
  }

  // Delay top vendor payments
  for (const v of models.vendors.slice(0, 3)) {
    if (!v.is_recurring && v.payment_count < iv.delay_min_count) continue
    const monthlyCash = v.avg_amount
    if (monthlyCash < iv.delay_min_cash) continue
    const impact14 = r2(monthlyCash * iv.delay_impact_14d)
    const impact30 = r2(monthlyCash * iv.delay_impact_30d)
    const riskReduction = baseRisk30 > 0 ? r2(Math.min(iv.delay_risk_cap, (monthlyCash / Math.max(1, startingCash)) * iv.delay_risk_mult)) : 0

    const simImpact: ActionSimulationImpact = {
      low_point_before: baseLowPoint,
      low_point_after: r2(baseLowPoint + impact14 * iv.delay_low_point),
      stress_prob_before: stressProb,
      stress_prob_after: r2(Math.max(0, stressProb - riskReduction / 100)),
    }
    const lateFeeP = v.outstanding_bills.length > 0 ? iv.late_fee_with_bills : iv.late_fee_without
    const relRisk = v.recurrence.recurrence_type === "hard" ? iv.rel_risk_hard : iv.rel_risk_other
    const nextTrough = r2(-monthlyCash * iv.vendor_trough_mult)
    interventions.push({
      id: `delay_${v.entity_id}`,
      label: `Delay ${v.name} by ${iv.delay_days} days`,
      type: "delay_payment",
      entity: v.name,
      parameter_days: iv.delay_days,
      parameter_pct: null,
      impact_cash_14d: impact14,
      impact_cash_30d: impact30,
      impact_risk_reduction: riskReduction,
      description: `Delaying ${v.name} payments by ${iv.delay_days} days frees ~$${Math.round(impact14).toLocaleString()} in the near term`,
      vendor_relationship_risk: relRisk,
      late_fee_probability: lateFeeP,
      impact_on_next_month_trough: nextTrough,
      cascade_crunch_probability: startingCash < monthlyCash * 2 ? iv.cascade_high : iv.cascade_low,
      expected_impact: impact14,
      plausible_range_low: r2(impact14 * iv.plausible_low),
      plausible_range_high: r2(impact14 * iv.plausible_high),
      confidence_band: "medium",
      assumptions: [`Vendor accepts ${iv.delay_days}-day delay`, "No late fees incurred", "AP load shifts to next month"],
      simulation_impact: simImpact,
      second_order_risks: {
        late_fee: lateFeeP > 0.1 ? `~${Math.round(lateFeeP * 100)}% chance of late fee if terms are strict` : undefined,
        relationship: relRisk > 0.1 ? `Vendor relationship risk (${v.recurrence.recurrence_type === "hard" ? "tight recurring" : "regular"})` : undefined,
        next_period: `Next-period trough: ${nextTrough < 0 ? `-$${Math.abs(nextTrough).toLocaleString()} compressed` : "neutral"}`,
      },
    })
  }

  // Reduce overall spend
  const totalOutflowEvents = events.filter((e) => e.direction === "out")
  const totalOutflow30 = totalOutflowEvents.reduce((s, e) => s + e.amount * e.probability, 0)
  if (totalOutflow30 > 0) {
    const savings = r2(totalOutflow30 * iv.spend_reduction_pct)
    const riskRed = baseRisk30 > 0 ? r2(Math.min(iv.spend_risk_cap, (savings / Math.max(1, startingCash)) * 100)) : 0
    const simImpact: ActionSimulationImpact = {
      low_point_before: baseLowPoint,
      low_point_after: r2(baseLowPoint + savings * iv.spend_sim_low_point),
      stress_prob_before: stressProb,
      stress_prob_after: r2(Math.max(0, stressProb - riskRed / 100)),
      runway_months_change: startingCash > 0 && savings > 0 ? r2((savings / 30) / (startingCash / 90)) : undefined,
    }
    interventions.push({
      id: "reduce_spend_10",
      label: `Reduce overall spend by ${Math.round(iv.spend_reduction_pct * 100)}%`,
      type: "reduce_spend",
      entity: null,
      parameter_days: null,
      parameter_pct: Math.round(iv.spend_reduction_pct * 100),
      impact_cash_14d: r2(savings * iv.spend_14d_fraction),
      impact_cash_30d: savings,
      impact_risk_reduction: riskRed,
      description: `A ${Math.round(iv.spend_reduction_pct * 100)}% spend reduction saves ~$${Math.round(savings).toLocaleString()} over 30 days`,
      plausible_range_low: r2(savings * iv.spend_14d_fraction * iv.spend_plausible_low),
      plausible_range_high: r2(savings * iv.spend_14d_fraction * iv.spend_plausible_high),
      confidence_band: "low-medium",
      assumptions: ["Spend reduction is achievable without affecting operations"],
      simulation_impact: simImpact,
    })
  }

  // Sort by risk reduction first (when stress prob > 0), else by cash impact; assign rank
  interventions.sort((a, b) => {
    if (baseRisk30 > iv.sort_risk_threshold && Math.abs(a.impact_risk_reduction - b.impact_risk_reduction) > iv.sort_risk_diff) {
      return b.impact_risk_reduction - a.impact_risk_reduction
    }
    return b.impact_cash_14d - a.impact_cash_14d
  })
  const top = interventions.slice(0, iv.max_interventions)
  top.forEach((iv, i) => { iv.rank = i + 1 })
  return top
}

// ─── Step 12b: Combined Strategies (best 2-action combos) ─────────────

function computeCombinedStrategies(
  interventions: Intervention[],
  baseLowPoint: number,
  stressProb: number,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): CombinedStrategy[] {
  const iv = cal.interventions
  const strategies: CombinedStrategy[] = []
  const accel = interventions.filter((i) => i.type === "accelerate_collection")
  const delay = interventions.filter((i) => i.type === "delay_payment")
  const reduce = interventions.filter((i) => i.type === "reduce_spend")

  if (delay.length > 0 && accel.length > 0) {
    const d = delay[0]
    const a = accel[0]
    const combinedLow = r2(baseLowPoint + (d.impact_cash_14d + a.impact_cash_14d) * iv.delay_low_point)
    const newStress = Math.max(0, stressProb - (d.impact_risk_reduction + a.impact_risk_reduction) / 100)
    strategies.push({
      id: "strat_delay_accel",
      actions: [d, a],
      low_point: combinedLow,
      stress_prob: r2(newStress),
      risk_level: newStress < iv.risk_level_low ? "low" : newStress < iv.risk_level_medium ? "medium" : "high",
      summary: `Delay ${d.entity} ${iv.delay_days}d + accelerate ${a.entity} ${iv.accel_days}d → low point $${Math.round(combinedLow).toLocaleString()}, stress prob ${(newStress * 100).toFixed(0)}%`,
    })
  }

  if (delay.length > 0 && reduce.length > 0) {
    const d = delay[0]
    const r = reduce[0]
    const combinedLow = r2(baseLowPoint + d.impact_cash_14d * iv.delay_low_point + r.impact_cash_14d * iv.delay_low_point)
    const newStress = Math.max(0, stressProb - (d.impact_risk_reduction + r.impact_risk_reduction) / 100)
    strategies.push({
      id: "strat_delay_reduce",
      actions: [d, r],
      low_point: combinedLow,
      stress_prob: r2(newStress),
      risk_level: newStress < iv.risk_level_low ? "low" : newStress < iv.risk_level_medium ? "medium" : "high",
      summary: `Delay ${d.entity} ${iv.delay_days}d + reduce spend ${Math.round(iv.spend_reduction_pct * 100)}% → low point $${Math.round(combinedLow).toLocaleString()}, stress prob ${(newStress * 100).toFixed(0)}%`,
    })
  }

  if (accel.length >= 2) {
    const a1 = accel[0]
    const a2 = accel[1]
    const combinedLow = r2(baseLowPoint + (a1.impact_cash_14d + a2.impact_cash_14d) * iv.accel_low_point)
    const newStress = Math.max(0, stressProb - (a1.impact_risk_reduction + a2.impact_risk_reduction) / 100)
    strategies.push({
      id: "strat_accel_accel",
      actions: [a1, a2],
      low_point: combinedLow,
      stress_prob: r2(newStress),
      risk_level: newStress < iv.risk_level_low ? "low" : newStress < iv.risk_level_medium ? "medium" : "high",
      summary: `Accelerate ${a1.entity} + ${a2.entity} → low point $${Math.round(combinedLow).toLocaleString()}, stress prob ${(newStress * 100).toFixed(0)}%`,
    })
  }

  return strategies.slice(0, 3)
}

// ─── Step 13: Scenario Drivers (WHY pessimistic is bad) ──────────────

function computeScenarioDrivers(
  models: BehavioralModels,
  events: ForecastEvent[],
  baseResult: ScenarioResult,
  pessResult: ScenarioResult,
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
): ScenarioDriver[] {
  const sd = cal.monthly_scenarios
  const drivers: ScenarioDriver[] = []
  const baseEnding = baseResult.ending_cash
  const pessEnding = pessResult.ending_cash
  const gap = baseEnding - pessEnding
  if (gap <= 0) return drivers

  const customerInflows = events.filter((e) => e.direction === "in" && e.source_model === "customer")
  const customerTotal = customerInflows.reduce((s, e) => s + e.amount * e.probability, 0)
  if (customerTotal > 0) {
    const delayedAmount = r2(customerTotal * sd.driver_customer_delay)
    drivers.push({
      factor: `Delayed customer payments (top ${Math.min(3, models.customers.length)} customers)`,
      impact_amount: delayedAmount,
      direction: "negative",
    })
  }

  const vendorOutflows = events.filter((e) => e.direction === "out" && e.source_model === "vendor")
  const vendorTotal = vendorOutflows.reduce((s, e) => s + e.amount * e.probability, 0)
  if (vendorTotal > 0) {
    const higherCost = r2(vendorTotal * sd.driver_vendor_stress)
    drivers.push({
      factor: `Higher vendor costs (+${Math.round(sd.driver_vendor_stress * 100)}% stress)`,
      impact_amount: higherCost,
      direction: "negative",
    })
  }

  if (models.settlement.sample_count > 0) {
    const settlementEvents = events.filter((e) => e.type === "settlement")
    const settlementCash = settlementEvents.reduce((s, e) => s + e.amount * e.probability, 0)
    if (settlementCash > 0) {
      drivers.push({
        factor: "Settlement timing delays",
        impact_amount: r2(settlementCash * sd.driver_settlement_delay),
        direction: "negative",
      })
    }
  }

  const recurringIn = events.filter((e) => e.direction === "in" && e.probability >= sd.driver_recurring_prob)
  if (recurringIn.length === 0) {
    drivers.push({
      factor: "No highly predictable inflows to offset",
      impact_amount: 0,
      direction: "negative",
    })
  }

  drivers.sort((a, b) => b.impact_amount - a.impact_amount)
  return drivers
}

// ─── Backtesting ────────────────────────────────────────────────────
//
// Replay: take historical movements up to N days ago, build a forecast,
// then compare predicted vs actual for the next N days.
// This gives a real accuracy metric, not a heuristic.

function runBaselineNaiveCarryForward(
  training: TaggedMovement[],
  cutoffDate: string,
  testDays: number,
): number[] {
  const windowStart = addDays(cutoffDate, -7)
  const lastDays = training.filter((m) => {
    const d = toDateStr(m.occurred_at)
    return d >= windowStart && d <= cutoffDate
  })
  let lastNet = 0
  for (const m of lastDays) {
    lastNet += isInflow(m) ? m.amount : -m.amount
  }
  const dailyNet = lastDays.length > 0 ? lastNet / 7 : 0
  return new Array(testDays + 1).fill(0).map((_, i) => (i >= 1 ? dailyNet : 0))
}

function runBaselineRollingAverage(
  training: TaggedMovement[],
  cutoffDate: string,
  testDays: number,
  lookbackDays: number,
): number[] {
  const windowStart = addDays(cutoffDate, -lookbackDays)
  const byDay = new Map<number, number>()
  for (const m of training) {
    const d = toDateStr(m.occurred_at)
    if (d < windowStart || d > cutoffDate) continue
    const offset = daysBetween(windowStart, d)
    if (offset >= 1 && offset <= lookbackDays) {
      byDay.set(offset, (byDay.get(offset) ?? 0) + (isInflow(m) ? m.amount : -m.amount))
    }
  }
  let total = 0
  for (let i = 1; i <= lookbackDays; i++) total += byDay.get(i) ?? 0
  const avg = total / Math.max(1, lookbackDays)
  return new Array(testDays + 1).fill(0).map((_, i) => (i >= 1 ? avg : 0))
}

function runBaselineDueDateOnly(
  _training: TaggedMovement[],
  _cutoffDate: string,
  testDays: number,
): number[] {
  return new Array(testDays + 1).fill(0)
}

function runBaselineLastCycleRepeat(
  training: TaggedMovement[],
  cutoffDate: string,
  testDays: number,
): number[] {
  const prevCycleStart = addDays(cutoffDate, -testDays)
  const prevCycleNet = new Array(testDays + 1).fill(0)
  for (const m of training) {
    const d = toDateStr(m.occurred_at)
    const offset = daysBetween(prevCycleStart, d)
    if (offset >= 1 && offset <= testDays) {
      prevCycleNet[offset] += isInflow(m) ? m.amount : -m.amount
    }
  }
  return prevCycleNet
}

function mergeLowSampleBuckets(
  buckets: { range: string; predicted_prob: number; actual_rate: number; count: number }[],
  minCount: number,
): { range: string; predicted_prob: number; actual_rate: number; count: number }[] {
  if (buckets.length <= 1) return buckets
  const result: { range: string; predicted_prob: number; actual_rate: number; count: number }[] = []
  let i = 0
  while (i < buckets.length) {
    const b = buckets[i]
    if (b.count >= minCount) {
      result.push(b)
      i++
      continue
    }
    let merged = { ...b }
    let j = i + 1
    while (j < buckets.length && merged.count < minCount) {
      const next = buckets[j]
      const totalCount = merged.count + next.count
      merged = {
        range: `${merged.range.split("-")[0]}-${next.range.split("-")[1]}`,
        predicted_prob: r2((merged.predicted_prob * merged.count + next.predicted_prob * next.count) / totalCount),
        actual_rate: r2((merged.actual_rate * merged.count + next.actual_rate * next.count) / totalCount),
        count: totalCount,
      }
      j++
    }
    result.push(merged)
    i = j
  }
  return result
}

function runCalibration(events: ForecastEvent[], testSet: TaggedMovement[], cutoffDate: string, testDays: number, cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION): CalibrationResult | null {
  // Group forecast events into probability buckets and check if they actually occurred
  const buckets = [
    { range: "0-20%", lo: 0, hi: 0.2, predicted: 0, actual: 0, count: 0 },
    { range: "20-40%", lo: 0.2, hi: 0.4, predicted: 0, actual: 0, count: 0 },
    { range: "40-60%", lo: 0.4, hi: 0.6, predicted: 0, actual: 0, count: 0 },
    { range: "60-80%", lo: 0.6, hi: 0.8, predicted: 0, actual: 0, count: 0 },
    { range: "80-100%", lo: 0.8, hi: 1.01, predicted: 0, actual: 0, count: 0 },
  ]

  // Build actual daily entity events for matching.
  // Store both the resolved display name AND the entity ID so we can match
  // forecast events (which use display names) against actual movements.
  const actualByDay = new Map<string, Set<string>>()
  for (const m of testSet) {
    const d = toDateStr(m.occurred_at)
    const offset = daysBetween(cutoffDate, d)
    if (offset < 1 || offset > testDays) continue
    const key = `${offset}`
    if (!actualByDay.has(key)) actualByDay.set(key, new Set())
    const daySet = actualByDay.get(key)!

    const entityId = resolveEntityId(m)
    daySet.add(entityId.toLowerCase().replace(/[^a-z0-9]/g, ""))

    const cp = observedCounterparty(m)
    if (cp) daySet.add(cp.toLowerCase().replace(/[^a-z0-9]/g, ""))

    // Also add the display name (what forecast events use)
    const displayName = resolveEntityName(entityId, cp, m.raw_description, "unknown")
    daySet.add(displayName.toLowerCase().replace(/[^a-z0-9]/g, ""))

    // Add the economic class direction as a matchable key
    const dir = isInflow(m) ? "in" : "out"
    daySet.add(`${displayName.toLowerCase().replace(/[^a-z0-9]/g, "")}_${dir}`)
  }

  let totalEvents = 0
  for (const e of events) {
    if (e.day_offset < 1 || e.day_offset > testDays) continue
    totalEvents++

    const bucket = buckets.find((b) => e.probability >= b.lo && e.probability < b.hi)
    if (!bucket) continue
    bucket.count++
    bucket.predicted += e.probability

    // Check if an event with similar entity actually occurred within ±1 day
    const entityKey = e.entity.toLowerCase().replace(/[^a-z0-9]/g, "")
    const dirKey = `${entityKey}_${e.direction}`
    let occurred = false
    for (let delta = -1; delta <= 1; delta++) {
      const checkDay = `${e.day_offset + delta}`
      const dayEntities = actualByDay.get(checkDay)
      if (!dayEntities) continue
      // Prefer direction-aware match, then name-only match
      if (dayEntities.has(dirKey) || dayEntities.has(entityKey)) {
        occurred = true
        break
      }
      // Fuzzy: check if any actual entity contains the forecast entity name (3+ chars)
      if (entityKey.length >= 3) {
        for (const ae of dayEntities) {
          if (ae.length >= 3 && (ae.includes(entityKey) || entityKey.includes(ae))) {
            occurred = true
            break
          }
        }
      }
      if (occurred) break
    }
    if (occurred) bucket.actual++
  }

  if (totalEvents < 5) return null

  const calibrationBuckets = buckets
    .filter((b) => b.count > 0)
    .map((b) => ({
      range: b.range,
      predicted_prob: r2(b.predicted / b.count),
      actual_rate: r2(b.actual / b.count),
      count: b.count,
    }))

  // Expected Calibration Error (ECE): weighted average of |predicted - actual| per bucket
  let ece = 0
  for (const b of calibrationBuckets) {
    const weight = b.count / totalEvents
    ece += weight * Math.abs(b.predicted_prob - b.actual_rate)
  }
  const calibrationError = r2(ece)

  const avgPredicted = calibrationBuckets.reduce((s, b) => s + b.predicted_prob * b.count, 0) / totalEvents
  const avgActual = calibrationBuckets.reduce((s, b) => s + b.actual_rate * b.count, 0) / totalEvents

  const isOverconfident = avgPredicted > avgActual + cal.backtest_scoring.overconfidence_gap
  const isUnderconfident = avgActual > avgPredicted + cal.backtest_scoring.overconfidence_gap

  let details = `Calibration across ${totalEvents} events: ECE ${(calibrationError * 100).toFixed(1)}%`
  if (isOverconfident) details += " — probabilities are overconfident (predicted > actual)"
  else if (isUnderconfident) details += " — probabilities are underconfident (actual > predicted)"
  else details += " — probabilities are reasonably calibrated"

  const suggested_interpretation = isOverconfident && calibrationError > cal.backtest_scoring.interpretation_high_threshold
    ? "Model is overconfident: interpret a 70% prediction as ~50–55% in practice. Use ranges, not point estimates."
    : isOverconfident
      ? "Slight overconfidence: treat high probabilities (80%+) with some caution."
      : undefined

  // Temperature scaling: p_adj = p^T with T>1 pulls high probs down (reduces overconfidence)
  const probability_temperature = isOverconfident && calibrationError > cal.backtest_scoring.temperature_threshold
    ? r2(1 + calibrationError * cal.backtest_scoring.temperature_mult)
    : undefined

  // Merge low-sample buckets (n < 5) with adjacent buckets for more stable display
  const mergedBuckets = mergeLowSampleBuckets(calibrationBuckets, cal.backtest_scoring.merge_min_sample)

  return { total_events_evaluated: totalEvents, buckets: mergedBuckets, calibration_error: calibrationError, is_overconfident: isOverconfident, is_underconfident: isUnderconfident, details, suggested_interpretation, probability_temperature }
}

const BACKTEST_HORIZONS = [7, 14, 30, 60, 90] as const

export function runSingleBacktestWithCalibration(
  movements: TaggedMovement[],
  invoices: OutstandingInvoice[],
  bills: OutstandingBill[],
  testDays: number,
  allDates: string[],
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
  entityProfiles: EntityPaymentProfile[] = [],
): {
  score: number
  mae: number
  directionAccuracy: number
  eventOccurrenceAccuracy: number | null
  lowPointAccuracy: number | null
  calibration: CalibrationResult | null
  events: ForecastEvent[]
  models: BehavioralModels
} | null {
  return runSingleBacktest(movements, invoices, bills, testDays, allDates, cal, entityProfiles)
}

function runSingleBacktest(
  movements: TaggedMovement[],
  invoices: OutstandingInvoice[],
  bills: OutstandingBill[],
  testDays: number,
  allDates: string[],
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
  entityProfiles: EntityPaymentProfile[] = [],
): {
  score: number
  mae: number
  directionAccuracy: number
  eventOccurrenceAccuracy: number | null
  lowPointAccuracy: number | null
  calibration: CalibrationResult | null
  events: ForecastEvent[]
  models: BehavioralModels
} | null {
  const lastDate = allDates[allDates.length - 1]
  const cutoffDate = addDays(lastDate, -testDays)

  const training = movements.filter((m) => toDateStr(m.occurred_at) <= cutoffDate)
  const testSet = movements.filter((m) => toDateStr(m.occurred_at) > cutoffDate)

  if (training.length < cal.backtest_min_training_movements || testSet.length < cal.backtest_min_test_movements) {
    log("backtest.skip.insufficient_split", {
      training_count: training.length,
      test_count: testSet.length,
      min_training: cal.backtest_min_training_movements,
      min_test: cal.backtest_min_test_movements,
      test_days: testDays,
    })
    return null
  }

  const models = buildBehavioralModels(training, invoices, bills, entityProfiles)
  const buckets = decomposeMovements(training)
  const dataSpan = daysBetween(allDates[0], cutoffDate)
  const components = buckets.map((b) => buildComponent(b, dataSpan, cal))
  const events = generateEvents30d(models, components)

  const predictedDailyNet = new Array<number>(testDays + 1).fill(0)
  for (const e of events) {
    if (e.day_offset < 1 || e.day_offset > testDays) continue
    const ev = e.amount * e.probability
    predictedDailyNet[e.day_offset] += e.direction === "in" ? ev : -ev
  }

  const actualDailyNet = new Array<number>(testDays + 1).fill(0)
  for (const m of testSet) {
    const d = toDateStr(m.occurred_at)
    const offset = daysBetween(cutoffDate, d)
    if (offset >= 1 && offset <= testDays) {
      actualDailyNet[offset] += isInflow(m) ? m.amount : -m.amount
    }
  }

  let absErrorSum = 0
  let directionMatches = 0
  let activeDays = 0

  for (let d = 1; d <= testDays; d++) {
    const pred = predictedDailyNet[d]
    const actual = actualDailyNet[d]
    if (Math.abs(actual) < 1 && Math.abs(pred) < 1) continue
    activeDays++
    absErrorSum += Math.abs(pred - actual)
    if ((pred >= 0 && actual >= 0) || (pred < 0 && actual < 0)) directionMatches++
  }

  if (activeDays < cal.backtest_min_active_days) {
    log("backtest.skip.insufficient_active_days", {
      active_days: activeDays,
      min_active: cal.backtest_min_active_days,
      test_days: testDays,
      total_days_checked: testDays,
    })
    return null
  }

  const mae = absErrorSum / activeDays
  const directionAccuracy = directionMatches / activeDays

  const totalPredicted = predictedDailyNet.reduce((s, v) => s + v, 0)
  const totalActual = actualDailyNet.reduce((s, v) => s + v, 0)
  const totalScale = Math.max(Math.abs(totalActual), 1)
  const relativeError = Math.abs(totalPredicted - totalActual) / totalScale

  const score = Math.round(
    Math.max(0, Math.min(100,
      (directionAccuracy * 60) + ((1 - Math.min(1, relativeError)) * 40)
    ))
  )

  const calibration = runCalibration(events, testSet, cutoffDate, testDays, cal)

  // Event occurrence accuracy: of events with prob >= 0.5, what fraction actually occurred?
  let eventOccurrenceAccuracy: number | null = null
  const highProbEvents = events.filter((e) => e.day_offset >= 1 && e.day_offset <= testDays && e.probability >= 0.5)
  if (highProbEvents.length >= 3) {
    const actualByDay = new Map<number, Set<string>>()
    for (const m of testSet) {
      const offset = daysBetween(cutoffDate, toDateStr(m.occurred_at))
      if (offset < 1 || offset > testDays) continue
      const key = resolveEntityId(m).toLowerCase().replace(/[^a-z0-9]/g, "")
      if (!actualByDay.has(offset)) actualByDay.set(offset, new Set())
      actualByDay.get(offset)!.add(key)
    }
    let occurred = 0
    for (const e of highProbEvents) {
      const entityKey = e.entity.toLowerCase().replace(/[^a-z0-9]/g, "")
      let found = false
      for (let delta = -1; delta <= 1; delta++) {
        const daySet = actualByDay.get(e.day_offset + delta)
        if (daySet?.has(entityKey)) { found = true; break }
      }
      if (found) occurred++
    }
    eventOccurrenceAccuracy = r2(occurred / highProbEvents.length)
  }

  // Low-point accuracy: did we predict the cash trough correctly?
  let lowPointAccuracy: number | null = null
  let predCum = 0
  let actualCum = 0
  let predMin = 0
  let actualMin = 0
  for (let d = 1; d <= testDays; d++) {
    predCum += predictedDailyNet[d]
    actualCum += actualDailyNet[d]
    predMin = Math.min(predMin, predCum)
    actualMin = Math.min(actualMin, actualCum)
  }
  const minScale = Math.max(Math.abs(actualMin), Math.abs(predMin), 1)
  lowPointAccuracy = r2(1 - Math.min(1, Math.abs(actualMin - predMin) / minScale))

  return {
    score,
    mae,
    directionAccuracy,
    eventOccurrenceAccuracy,
    lowPointAccuracy,
    calibration,
    events,
    models,
  }
}

function runBacktest(
  movements: TaggedMovement[],
  invoices: OutstandingInvoice[],
  bills: OutstandingBill[],
  cal: ForecastCalibrationParams = DEFAULT_FORECAST_CALIBRATION,
  entityProfiles: EntityPaymentProfile[] = [],
): BacktestResult | null {
  const allDates = movements.map((m) => toDateStr(m.occurred_at)).filter(Boolean).sort()
  const minMovements = cal.backtest_min_training_movements + cal.backtest_min_test_movements
  if (allDates.length < minMovements) {
    log("backtest.skip.insufficient_total_movements", {
      total_movements: allDates.length,
      min_required: minMovements,
    })
    return null
  }

  const totalSpanDays = daysBetween(allDates[0], allDates[allDates.length - 1])

  // Primary backtest at 14 days
  const primary = runSingleBacktest(movements, invoices, bills, 14, allDates, cal, entityProfiles)
  if (!primary) {
    log("backtest.skip.primary_14d_failed", {
      total_movements: allDates.length,
      total_span_days: totalSpanDays,
    })
    return null
  }

  const by_horizon: BacktestByHorizon[] = []
  for (const h of cal.backtest_horizons) {
    if (h > totalSpanDays * 0.4) continue
    const r = runSingleBacktest(movements, invoices, bills, h, allDates, cal, entityProfiles)
    if (!r) continue
    by_horizon.push({
      horizon_days: h,
      accuracy_score: r.score,
      days_tested: h,
      mean_absolute_error: r2(r.mae),
      direction_accuracy: r2(r.directionAccuracy),
      event_occurrence_accuracy: r.eventOccurrenceAccuracy,
      low_point_accuracy: r.lowPointAccuracy,
    })
  }

  // Segment-level metrics (from primary run models)
  const by_segment: BacktestBySegment[] = []
  for (const c of primary.models.customers) {
    const seg = `customer_${c.archetype}`
    const existing = by_segment.find((s) => s.segment === seg)
    if (existing) existing.entity_count++
    else by_segment.push({ segment: seg, entity_count: 1, direction_accuracy: r2(primary.directionAccuracy), mean_absolute_error: r2(primary.mae) })
  }
  for (const v of primary.models.vendors) {
    const seg = `vendor_${v.recurrence.recurrence_type}`
    const existing = by_segment.find((s) => s.segment === seg)
    if (existing) existing.entity_count++
    else by_segment.push({ segment: seg, entity_count: 1, direction_accuracy: r2(primary.directionAccuracy), mean_absolute_error: r2(primary.mae) })
  }

  let details: string
  if (primary.score >= 75) details = `Strong backtest: ${primary.directionAccuracy * 100 | 0}% direction accuracy, MAE $${Math.round(primary.mae)}`
  else if (primary.score >= 50) details = `Moderate backtest: ${primary.directionAccuracy * 100 | 0}% direction accuracy, MAE $${Math.round(primary.mae)}`
  else details = `Weak backtest: ${primary.directionAccuracy * 100 | 0}% direction accuracy, MAE $${Math.round(primary.mae)} — forecast may be unreliable`

  if (primary.calibration) {
    details += `. ${primary.calibration.details}`
  }

  // Baseline comparison
  const lastDate = allDates[allDates.length - 1]
  const cutoffDate = addDays(lastDate, -14)
  const training = movements.filter((m) => toDateStr(m.occurred_at) <= cutoffDate)
  const testSet = movements.filter((m) => toDateStr(m.occurred_at) > cutoffDate)
  const actualDailyNet = new Array(15).fill(0)
  for (const m of testSet) {
    const offset = daysBetween(cutoffDate, toDateStr(m.occurred_at))
    if (offset >= 1 && offset <= 14) actualDailyNet[offset] += isInflow(m) ? m.amount : -m.amount
  }

  const baseline_comparison: BaselineComparison[] = []
  for (const [name, fn] of [
    ["naive_carry_forward", () => runBaselineNaiveCarryForward(training, cutoffDate, 14)],
    ["rolling_average", () => runBaselineRollingAverage(training, cutoffDate, 14, 14)],
    ["due_date_only", () => runBaselineDueDateOnly(training, cutoffDate, 14)],
    ["last_cycle_repeat", () => runBaselineLastCycleRepeat(training, cutoffDate, 14)],
  ] as const) {
    const pred = fn()
    let absErr = 0, dirMatch = 0, active = 0
    for (let d = 1; d <= 14; d++) {
      if (Math.abs(actualDailyNet[d]) < 1 && Math.abs(pred[d]) < 1) continue
      active++
      absErr += Math.abs(pred[d] - actualDailyNet[d])
      if ((pred[d] >= 0 && actualDailyNet[d] >= 0) || (pred[d] < 0 && actualDailyNet[d] < 0)) dirMatch++
    }
    const mae = active > 0 ? absErr / active : 0
    const dirAcc = active > 0 ? dirMatch / active : 0
    const totalPred = pred.slice(1).reduce((a, b) => a + b, 0)
    const totalActual = actualDailyNet.slice(1).reduce((a, b) => a + b, 0)
    const relErr = Math.abs(totalPred - totalActual) / Math.max(Math.abs(totalActual), 1)
    const blScore = Math.round(Math.max(0, Math.min(100, dirAcc * 60 + (1 - Math.min(1, relErr)) * 40)))
    baseline_comparison.push({
      baseline: name,
      accuracy_score: blScore,
      mean_absolute_error: r2(mae),
      direction_accuracy: r2(dirAcc),
      beats_engine: blScore > primary.score,
    })
  }

  return {
    accuracy_score: primary.score,
    days_tested: 14,
    mean_absolute_error: r2(primary.mae),
    direction_accuracy: r2(primary.directionAccuracy),
    details,
    calibration: primary.calibration,
    by_horizon: by_horizon.length > 0 ? by_horizon : undefined,
    by_segment: by_segment.length > 0 ? by_segment : undefined,
    event_occurrence_accuracy: primary.eventOccurrenceAccuracy ?? undefined,
    low_point_accuracy: primary.lowPointAccuracy ?? undefined,
    baseline_comparison,
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export async function computeCashflowForecast(
  movements: TaggedMovement[],
  startingCash: number,
  horizonMonths: number = 6,
  invoices: OutstandingInvoice[] = [],
  identityCtx: IdentityContext = { entityNames: new Map(), entityTypes: new Map(), aliasToEntityId: new Map(), counterpartyByMovement: new Map(), familyMembers: new Map() },
  bills: OutstandingBill[] = [],
  forecastCtx: ForecastContext | null = null,
  bridgeEvents30d: ForecastEvent[] | null = null,
  entityProfiles: EntityPaymentProfile[] = [],
  calibrationOverride: Partial<ForecastCalibrationParams> = {},
  reconciledARMovements: any[] = [],
  reconciledAPMovements: any[] = [],
  arSettlementTiming: any[] = [],
  apSettlementTiming: any[] = [],
  settlementTimingConfidence: any = null,
  userId: string = "",
): Promise<CashflowForecast> {
  // Merge calibration: defaults + any user/fitted overrides
  const cal = mergeCalibration(DEFAULT_FORECAST_CALIBRATION, calibrationOverride)
  const calibrationHash = computeCalibrationHash(cal)

  setIdentityContext(identityCtx)
  
  // Calculate data span from movements AND invoices/bills (using due_date as proxy).
  // Include "today" so single-day snapshots don't collapse to 0d; floor at 1d when any signal exists.
  const movementDates = movements.map((m) => toDateStr(m.occurred_at)).filter(Boolean)
  const invoiceDates = invoices
    .map((inv) => inv.due_date ? toDateStr(inv.due_date) : null)
    .filter(Boolean) as string[]
  const billDates = bills
    .map((b) => b.due_date ? toDateStr(b.due_date) : null)
    .filter(Boolean) as string[]
  const todayStr = new Date().toISOString().slice(0, 10)
  const allDates = [...movementDates, ...invoiceDates, ...billDates, todayStr].filter(Boolean).sort()
  const periodStart = allDates[0] ?? todayStr
  const periodEnd = allDates[allDates.length - 1] ?? todayStr
  const rawSpan = daysBetween(periodStart, periodEnd)
  const hasAnyDateSignal =
    movementDates.length > 0 || invoiceDates.length > 0 || billDates.length > 0
  const dataSpanDays = rawSpan > 0 ? rawSpan : hasAnyDateSignal ? 1 : 0

  // Aggregate component models (for non-entity categories)
  const buckets = decomposeMovements(movements)
  let components = buckets.map((b) => buildComponent(b, dataSpanDays, cal))
  
  // If no movement-based components but we have invoices/bills, create synthetic components
  // This ensures invoice-only users still see meaningful component data
  if (components.length === 0 && (invoices.length > 0 || bills.length > 0)) {
    const syntheticComponents: CashflowComponent[] = []
    
    if (invoices.length > 0) {
      const totalAR = invoices.reduce((sum, inv) => sum + inv.amount_due, 0)
      const avgInvoice = totalAR / invoices.length
      const monthlyCount = invoices.length / Math.max(1, dataSpanDays / 30)
      syntheticComponents.push({
        id: "ar_collections_in",
        label: "AR Collections",
        direction: "in",
        category: "customer_receipts",
        behavior: "episodic",
        monthly_avg: r2(avgInvoice * monthlyCount),
        monthly_count: r2(monthlyCount),
        volatility: 0.4,
        confidence: "medium",
        trend: 0,
        seasonal_index: null,
      })
    }
    
    if (bills.length > 0) {
      const totalAP = bills.reduce((sum, b) => sum + b.amount_due, 0)
      const avgBill = totalAP / bills.length
      const monthlyCount = bills.length / Math.max(1, dataSpanDays / 30)
      syntheticComponents.push({
        id: "ap_payments_out",
        label: "AP Payments",
        direction: "out",
        category: "vendor_payments",
        behavior: "episodic",
        monthly_avg: r2(avgBill * monthlyCount),
        monthly_count: r2(monthlyCount),
        volatility: 0.3,
        confidence: "medium",
        trend: 0,
        seasonal_index: null,
      })
    }
    
    components = syntheticComponents
  }

  // Entity-level behavioral models (enhanced with invoice + bill data + entity profiles)
  // Pass entity profiles directly to buildBehavioralModels so they can be used during
  // initial model creation, not just as a post-hoc enhancement
  let behavioral_models = buildBehavioralModels(movements, invoices, bills, entityProfiles)
  
  // Blend with reconciled AR/AP models for improved confidence
  if (reconciledARMovements.length > 0 || reconciledAPMovements.length > 0) {
    const reconciledCustomers = buildReconciledCustomerModels(reconciledARMovements)
    const reconciledVendors = buildReconciledVendorModels(reconciledAPMovements)
    
    // Build entity graph and clustering for additional confidence boosting
    let entityGraph: EntityGraphMap | undefined
    let clustering: ClusteringResult | undefined
    
    try {
      if (userId) {
        entityGraph = await buildCompleteEntityGraph(userId)
      }
      if (entityGraph && entityGraph.businessEntities.size > 0) {
        // Build payment count maps for clustering
        const customerPaymentCounts = new Map<string, number>()
        const vendorPaymentCounts = new Map<string, number>()
        
        for (const customer of behavioral_models.customers) {
          customerPaymentCounts.set(customer.entity_id, customer.payment_count)
        }
        for (const vendor of behavioral_models.vendors) {
          vendorPaymentCounts.set(vendor.entity_id, vendor.payment_count)
        }
        
        // Build customer and vendor stats maps
        const customerStats = new Map<string, { reliability_score: number }>()
        const vendorStats = new Map<string, { recurrence_score: number }>()
        
        for (const customer of behavioral_models.customers) {
          customerStats.set(customer.entity_id, {
            reliability_score: customer.features?.pct_overdue_paid ?? 0.5,
          })
        }
        for (const vendor of behavioral_models.vendors) {
          vendorStats.set(vendor.entity_id, {
            recurrence_score: vendor.recurrence?.recurrence_confidence ?? 0.5,
          })
        }
        
        // Cluster entities
        const allEntityIds = Array.from(new Set([
          ...behavioral_models.customers.map((c) => c.entity_id),
          ...behavioral_models.vendors.map((v) => v.entity_id),
        ]))
        
        clustering = clusterEntities(
          allEntityIds,
          entityGraph,
          new Map([...customerPaymentCounts, ...vendorPaymentCounts]),
          customerStats,
          vendorStats
        )
        
        log("forecast.entity_clustering.complete", {
          total_clusters: clustering.clusters.length,
          avg_cluster_size: clustering.clusters.length > 0
            ? allEntityIds.length / clustering.clusters.length
            : 0,
        })
      }
    } catch (err) {
      log("forecast.entity_graph.error", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    
    behavioral_models = blendReconciledModels(
      behavioral_models,
      reconciledCustomers,
      reconciledVendors,
      entityGraph,
      clustering
    )
    
    log("forecast.reconciled_models.blended", {
      customers_blended: reconciledCustomers.length,
      vendors_blended: reconciledVendors.length,
      entity_graph_available: !!entityGraph,
      clustering_available: !!clustering,
    })
  }
  
  // Additional enhancement pass for models that were created from movements
  // (invoice-only and bill-only models already used profiles during creation)
  if (entityProfiles.length > 0) {
    behavioral_models = enhanceModelsWithProfiles(behavioral_models, entityProfiles)
    behavioral_models = {
      ...behavioral_models,
      customers: behavioral_models.customers.map((c) => ({
        ...c,
        invoice_forecasts: refreshInvoiceForecastsAfterProfileEnhance(c),
      })),
    }
  }

  // Event generation: discrete 30-day forecast (+ optional cash_events bridge)
  let events_30d = generateEvents30d(behavioral_models, components)
  const mergeBridge = process.env.FORECAST_USE_CASH_EVENTS !== "0"
  if (mergeBridge && bridgeEvents30d && bridgeEvents30d.length > 0) {
    // cash_events is the AP/AR source of truth for entities it covers.
    // Only drop native events for entities that have bridge events to avoid double counting.
    const bridgeEntities = new Set(bridgeEvents30d.map((e) => e.entity).filter(Boolean))
    events_30d = events_30d.filter((e) => {
      if (e.type !== "customer_payment" && e.type !== "vendor_payment") return true
      // Keep native events for entities not covered by the bridge
      return !e.entity || !bridgeEntities.has(e.entity)
    })
    events_30d = [...events_30d, ...bridgeEvents30d]
  }

  // Daily cashflow simulation: cash[t+1] = cash[t] + inflows[t] - outflows[t]
  const daily_simulation = simulateDaily(events_30d, startingCash)

  // Monte Carlo: simulations with payment delays, amount variance, missed payments
  const monte_carlo = runMonteCarlo(events_30d, startingCash, cal.monte_carlo_iterations, cal)

  // Narrative: deterministic Forecast / Risk / Insight / Action (enriched with state context)
  const narrative = generateNarrative(monte_carlo, daily_simulation, behavioral_models, events_30d, startingCash, forecastCtx, cal)

  // Run risk-aware scenarios
  const scenarios = buildScenarios(forecastCtx, cal).map((config) =>
    runScenario(behavioral_models, components, horizonMonths, startingCash, config, cal)
  )

  // Cash runway
  const cash_runway = computeCashRunway(scenarios, startingCash, dataSpanDays)

  // Sensitivity analysis
  const sensitivity = computeSensitivity(events_30d, behavioral_models, monte_carlo, startingCash)

  // Intervention engine
  const interventions = computeInterventions(events_30d, behavioral_models, monte_carlo, startingCash, daily_simulation, cal)
  const combined_strategies = computeCombinedStrategies(
    interventions,
    daily_simulation.min_cash,
    monte_carlo.prob_below_zero_14d > cal.interventions.stress_prob_threshold ? monte_carlo.prob_below_zero_14d : monte_carlo.prob_below_zero_30d,
    cal,
  )

  // Scenario drivers (WHY the pessimistic scenario is bad)
  const baseScenario = scenarios.find((s) => s.scenario === "base")
  const pessScenario = scenarios.find((s) => s.scenario === "pessimistic")
  const pessDrivers = baseScenario && pessScenario
    ? computeScenarioDrivers(behavioral_models, events_30d, baseScenario, pessScenario, cal)
    : []
  if (pessScenario && pessDrivers.length > 0) {
    (pessScenario as ScenarioResult & { drivers?: ScenarioDriver[] }).drivers = pessDrivers
  }

  // Build context for downstream (default if not provided from state API)
  const context: ForecastContext = forecastCtx ?? {
    risk_score: 0, risk_level: "low",
    risk_decomposition: undefined,
    concentration_risk_score: 0, dependency_risk_score: 0, liquidity_risk_score: 0,
    top_customer_pct: 0, repeat_revenue_ratio: 0,
    operating_dependency_ratio: 1, transfer_dependency_ratio: 0,
    recurring_spend_ratio: 0, liquidity_regime: "stable",
    transitions: [], balance_source: "derived", account_balances: [],
  }

  // Backtest: replay last 14 days to measure forecast accuracy
  const backtest = runBacktest(movements, invoices, bills, cal, entityProfiles)

  // Forecast confidence (8-component weighted, with backtest input)
  const forecast_confidence = computeForecastConfidence(behavioral_models, components, events_30d, dataSpanDays, backtest, movements, bills, cal, settlementTimingConfidence)

  // Separated forecast: operating vs settlement vs treasury vs owner
  const today = new Date().toISOString().slice(0, 10)
  const separated_forecast = computeSeparatedForecast(events_30d, today)

  const metadata: ForecastMetadata = {
    model_version: MODEL_VERSION,
    feature_version: MODEL_VERSION,
    calibration_version: FORECAST_ENGINE_VERSION,
    tagging_version: TAGGING_VERSION,
    policy_version: POLICY_VERSION,
    calibration_hash: calibrationHash,
    calibration_source: "default",
  }

  return {
    period_start: periodStart,
    forecast_horizon_months: horizonMonths,
    metadata,
    components,
    behavioral_models,
    events_30d,
    daily_simulation,
    monte_carlo,
    narrative,
    scenarios,
    data_span_days: dataSpanDays,
    computed_at: new Date().toISOString(),
    forecast_confidence,
    cash_runway,
    sensitivity,
    interventions,
    combined_strategies,
    context,
    backtest,
    separated_forecast,
  }
}
