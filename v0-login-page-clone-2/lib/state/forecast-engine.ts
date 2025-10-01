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

const FORECAST_ENGINE_VERSION = "2.1"
const MODEL_VERSION = "2.0"
const TAGGING_VERSION = "1.0"
const CALIBRATION_VERSION = "1.0"
const POLICY_VERSION = "1.0"

import { extractEntityFromRawDescriptor } from "@/lib/alias-normalize"
import type { CanonicalMovement, MovementTag } from "@/lib/movement-types"
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
} from "./types"

type TaggedMovement = CanonicalMovement & { tag: MovementTag }
type ComponentCategory = CashflowComponent["category"]

function isInflow(m: TaggedMovement): boolean {
  return m.direction === "inflow" || m.direction === ("in" as string)
}
function isOutflow(m: TaggedMovement): boolean {
  return m.direction === "outflow" || m.direction === ("out" as string)
}

// ─── Utilities ──────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  return Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000))
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
        const td = (m.tag.tag_data ?? {}) as { invoice_status?: string }
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
      case "vendor_payment":
      case "ap_payment": {
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
        const td = (m.tag.tag_data ?? {}) as { recurrence_type?: string; has_bill?: boolean }
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

function sigmoidDecay(overdueRatio: number): number {
  return 1 / (1 + Math.exp(2.5 * (overdueRatio - 2)))
}

function getCohortPrior(archetype: string): { prob: number; interval: number } {
  const defaults: Record<string, { prob: number; interval: number }> = {
    clockwork: { prob: 0.6, interval: 30 },
    bursty: { prob: 0.4, interval: 45 },
    episodic: { prob: 0.2, interval: 60 },
    slow_reliable: { prob: 0.5, interval: 45 },
    volatile: { prob: 0.25, interval: 50 },
    low_data: { prob: 0.3, interval: 30 },
  }
  return defaults[archetype] ?? { prob: 0.3, interval: 30 }
}

function classifyCustomerArchetype(
  paymentCount: number,
  intervalCv: number,
  avgDaysToPay: number,
  amountCv: number,
  recentTrend: "accelerating" | "decelerating" | "stable" | "insufficient",
): CustomerArchetype {
  if (paymentCount < 3) return "low_data"
  if (intervalCv < 0.25 && amountCv < 0.3) return "clockwork"
  if (intervalCv > 0.8 && paymentCount >= 3) return "volatile"
  if (avgDaysToPay > 30 && intervalCv < 0.5) return "slow_reliable"
  if (intervalCv > 0.5 && intervalCv <= 0.8) return "bursty"
  if (paymentCount >= 3 && paymentCount <= 6 && intervalCv > 0.4) return "episodic"
  if (intervalCv < 0.5) return "clockwork"
  return "bursty"
}

function computeCustomerFeatures(
  payments: { amount: number; date: string; confidence: number }[],
  invoiceCount: number,
  overdueCount: number,
  now: string,
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

  let recentTrend: CustomerFeatures["recent_trend"] = "insufficient"
  if (payments.length >= 4) {
    const mid = Math.floor(payments.length / 2)
    const firstAvg = amounts.slice(0, mid).reduce((a, b) => a + b, 0) / mid
    const secondAvg = amounts.slice(mid).reduce((a, b) => a + b, 0) / (amounts.length - mid)
    if (firstAvg > 0) {
      const ratio = secondAvg / firstAvg
      recentTrend = ratio > 1.15 ? "accelerating" : ratio < 0.85 ? "decelerating" : "stable"
    }
  }

  const lastDate = payments[payments.length - 1].date
  const recencyDays = daysBetween(lastDate, now)

  const dayOfWeek = payments.map((p) => new Date(p.date).getDay())
  const dayCounts = new Array(7).fill(0)
  dayOfWeek.forEach((d) => dayCounts[d]++)
  const maxDay = Math.max(...dayCounts)
  const weekdayBias = payments.length >= 5 && maxDay / payments.length > 0.4
    ? dayOfWeek[dayCounts.indexOf(maxDay)]
    : null

  const avg_dso = avgInterval
  const dso_variance = stdInterval
  const pct_overdue_paid = overdueCount > 0 && invoiceCount > 0 ? r2(1 - overdueCount / Math.max(invoiceCount, 1)) : 1
  const amount_elasticity = amountMean > 0 && amountStd > 0 ? r2(amountStd / amountMean) : 0
  const dataSpanMonths = payments.length >= 2 ? daysBetween(payments[0].date, payments[payments.length - 1].date) / 30 : 1
  const monthly_cadence = dataSpanMonths > 0 ? r2(payments.length / dataSpanMonths) : 0
  const last_3_intervals = intervals.slice(-3)
  const payer_reliability_cluster = intervalCv < 0.3 ? "reliable" : intervalCv < 0.6 ? "moderate" : "volatile"

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
): InvoiceForecast[] {
  const forecasts: InvoiceForecast[] = []
  const dso = features.avg_days_to_pay

  for (const inv of customerInvoices) {
    const daysOverdue = inv.days_overdue ?? 0
    const daysUntilDue = inv.days_until_due ?? 0

    let p7 = 0, p14 = 0, p30 = 0
    let expectedDate: string
    let reasoning: string

    if (archetype === "clockwork") {
      const expectedDelay = dso > 0 ? dso : 5
      if (daysOverdue > 0) {
        // Overdue clockwork: high probability of payment in window, but not near-certain
        p7 = Math.min(0.75, 0.4 + daysOverdue * 0.04)
        p14 = Math.min(0.85, p7 + 0.12)
        p30 = Math.min(0.90, p14 + 0.08)
        expectedDate = addDays(now, Math.max(2, Math.round(expectedDelay - daysOverdue)))
        reasoning = `Clockwork payer, ${daysOverdue}d overdue — expect payment soon (DSO ${r2(dso)}d)`
      } else {
        const daysToExpected = daysUntilDue + expectedDelay
        p7 = daysToExpected <= 7 ? 0.65 : daysToExpected <= 10 ? 0.35 : 0.08
        p14 = daysToExpected <= 14 ? 0.75 : daysToExpected <= 20 ? 0.45 : 0.15
        p30 = daysToExpected <= 30 ? 0.82 : 0.35
        expectedDate = inv.due_date ? addDays(inv.due_date, Math.round(expectedDelay)) : addDays(now, daysToExpected)
        reasoning = `Clockwork payer, due in ${daysUntilDue}d — expected ${Math.round(expectedDelay)}d after due (DSO ${r2(dso)}d)`
      }
    } else if (archetype === "slow_reliable") {
      const expectedDelay = Math.max(dso, 15)
      if (daysOverdue > 0) {
        p7 = 0.2 + Math.min(0.3, daysOverdue * 0.02)
        p14 = Math.min(0.65, p7 + 0.2)
        p30 = Math.min(0.78, p14 + 0.15)
        expectedDate = addDays(now, Math.max(3, Math.round(expectedDelay - daysOverdue)))
        reasoning = `Slow but reliable payer, ${daysOverdue}d overdue — historical DSO ${r2(dso)}d`
      } else {
        p7 = 0.04
        p14 = daysUntilDue <= 5 ? 0.18 : 0.08
        p30 = daysUntilDue <= 15 ? 0.4 : 0.22
        expectedDate = inv.due_date ? addDays(inv.due_date, Math.round(expectedDelay)) : addDays(now, 30)
        reasoning = `Slow but reliable — typically pays ${Math.round(expectedDelay)}d after due`
      }
    } else if (archetype === "bursty" || archetype === "volatile") {
      const spread = archetype === "volatile" ? 0.7 : 0.5
      if (daysOverdue > 0) {
        p7 = 0.22
        p14 = 0.38
        p30 = 0.55
      } else {
        p7 = daysUntilDue <= 3 ? 0.18 : 0.07
        p14 = daysUntilDue <= 10 ? 0.28 : 0.12
        p30 = 0.4
      }
      p7 *= (1 - spread * 0.3)
      p14 *= (1 - spread * 0.2)
      expectedDate = inv.due_date ? addDays(inv.due_date, Math.round(dso > 0 ? dso : 10)) : addDays(now, 14)
      reasoning = `${archetype} payer — wide timing variance (CV ${r2(features.interval_cv)}), probability spread across horizon`
    } else if (archetype === "low_data") {
      if (daysOverdue > 0) {
        p7 = 0.12; p14 = 0.22; p30 = 0.32
        expectedDate = addDays(now, 7)
        reasoning = `Low-data customer, ${daysOverdue}d overdue — sparse history penalty applied`
      } else {
        p7 = daysUntilDue <= 5 ? 0.1 : 0.04
        p14 = daysUntilDue <= 10 ? 0.18 : 0.08
        p30 = 0.25
        expectedDate = inv.due_date ?? addDays(now, 14)
        reasoning = `Low-data customer (<3 payments) — anchored to invoice due date with confidence haircut`
      }
    } else {
      if (daysOverdue > 0) {
        p7 = 0.25; p14 = 0.4; p30 = 0.6
        expectedDate = addDays(now, 5)
      } else {
        p7 = daysUntilDue <= 5 ? 0.3 : 0.1
        p14 = daysUntilDue <= 10 ? 0.42 : 0.22
        p30 = 0.55
        expectedDate = inv.due_date ?? addDays(now, 14)
      }
      reasoning = `Episodic payer — opportunity-weighted, not cadence-driven`
    }

    forecasts.push({
      invoice_id: inv.invoice_id,
      customer_name: inv.customer_name,
      amount_due: inv.amount_due,
      due_date: inv.due_date,
      days_overdue: inv.days_overdue,
      customer_dso: r2(dso),
      probability_7d: r2(Math.min(0.99, p7)),
      probability_14d: r2(Math.min(0.99, p14)),
      probability_30d: r2(Math.min(0.99, p30)),
      expected_collection_date: expectedDate,
      expected_amount: r2(inv.amount_due),
      reasoning,
    })
  }

  return forecasts
}

function buildCustomerModels(movements: TaggedMovement[], invoices: OutstandingInvoice[] = []): CustomerModel[] {
  const byEntity = new Map<string, { name: string; payments: { amount: number; date: string; isAnomaly: boolean; isOutlier: boolean; isFirstSeen: boolean; confidence: number }[] }>()

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

    // Archetype-driven probability
    let probability: number
    if (archetype === "clockwork") {
      const overdueRatio = avgInterval > 0 ? daysSinceLast / avgInterval : 0
      probability = sigmoidDecay(overdueRatio) * (0.55 + 0.25 * Math.min(1, payments.length / 6))
    } else if (archetype === "bursty") {
      const overdueRatio = avgInterval > 0 ? daysSinceLast / avgInterval : 0
      probability = sigmoidDecay(overdueRatio) * 0.6
    } else if (archetype === "episodic") {
      probability = daysSinceLast < 45 ? 0.25 : daysSinceLast < 90 ? 0.15 : 0.06
    } else if (archetype === "slow_reliable") {
      const overdueRatio = avgInterval > 0 ? daysSinceLast / avgInterval : 0
      probability = sigmoidDecay(overdueRatio * 0.7) * 0.65
    } else if (archetype === "volatile") {
      probability = daysSinceLast < 30 ? 0.22 : daysSinceLast < 60 ? 0.12 : 0.06
    } else {
      // low_data: shrink to cohort prior (hierarchical)
      const prior = getCohortPrior("low_data")
      if (customerInvoices.length > 0) {
        const raw = customerInvoices.some((i) => i.status === "overdue") ? 0.4 : 0.3
        probability = raw * 0.6 + prior.prob * 0.4
      } else {
        const raw = payments.length === 1 && daysSinceLast < 60 ? 0.15 : 0.08
        probability = raw * 0.5 + prior.prob * 0.5
      }
    }

    // Amount trend dampening
    if (features.recent_trend === "decelerating") probability *= 0.8
    if (payments.length === 1 && payments[0].isFirstSeen) probability *= 0.4

    probability = Math.max(0.02, Math.min(0.98, probability))

    let nextDate: string | null = null
    if (archetype === "clockwork" || archetype === "slow_reliable" || archetype === "bursty") {
      if (avgInterval > 0 && probability > 0.1) {
        nextDate = addDays(lastDate, avgInterval)
        // Advance by full intervals until we're in the future, not a fractional snap
        while (nextDate < now && avgInterval > 0) {
          nextDate = addDays(nextDate, avgInterval)
        }
        // Ensure we don't cluster on D+1
        if (daysBetween(now, nextDate) < 2) nextDate = addDays(now, Math.max(2, Math.round(avgInterval * 0.5)))
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

    // Invoice boost — scaled by archetype and history quality
    if (customerInvoices.length > 0) {
      const earliestDue = customerInvoices
        .filter((i) => i.due_date)
        .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""))[0]

      // Boost is smaller for low-data/volatile customers (we don't know if they'll pay)
      const invoiceBoost = archetype === "clockwork" ? 0.2
        : archetype === "slow_reliable" ? 0.15
        : archetype === "bursty" ? 0.1
        : archetype === "low_data" ? 0.08
        : archetype === "volatile" ? 0.05
        : 0.1
      if (probability < 0.8) probability = Math.min(0.9, probability + invoiceBoost)
      if (confidence === "low" && payments.length >= 2) confidence = "medium"

      if (earliestDue?.due_date && earliestDue.due_date >= now) {
        const dueOffset = daysBetween(now, earliestDue.due_date)
        if (dueOffset <= 30) nextDate = earliestDue.due_date
      } else if (earliestDue?.status === "overdue") {
        nextDate = addDays(now, 3)
        probability = Math.min(0.9, probability + 0.05)
      }
    }

    probability = Math.max(0.02, Math.min(0.98, probability))

    const invoiceForecasts = buildInvoiceForecasts(customerInvoices, features, archetype, now)

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

    const features: CustomerFeatures = {
      payment_count: 0, invoice_count: custInvs.length, paid_vs_unpaid_ratio: 0,
      avg_days_to_pay: 0, std_days_to_pay: 0, amount_mean: r2(totalDue / custInvs.length),
      amount_std: 0, interval_cv: 999, recent_trend: "insufficient",
      last_payment_recency_days: 999, overdue_count: overdueCount, weekday_bias: null,
    }

    const invoiceForecasts = buildInvoiceForecasts(custInvs, features, "low_data", now)

    const invCustomerName = custInvs[0].customer_name
    const canonicalName = extractEntityFromRawDescriptor(invCustomerName)
      ?? (invCustomerName && invCustomerName.length >= 2 ? cleanDescriptor(invCustomerName) : null)
      ?? `Customer (${custInvs.length} invoice${custInvs.length > 1 ? "s" : ""})`

    models.push({
      entity_id: custInvs[0].entity_id ?? `inv_${custInvs[0].invoice_id}`,
      name: canonicalName,
      archetype: "low_data",
      inflow_event_class: custInvs.some((i) => i.status === "overdue") ? "overdue_receivable" : "sporadic_receivable",
      features,
      avg_amount: r2(totalDue / custInvs.length),
      payment_interval_days: 0,
      interval_variance: 0,
      last_payment_date: now,
      payment_count: 0,
      probability_of_next: custInvs.some((i) => i.status === "overdue") ? 0.4 : 0.3,
      next_expected_date: earliest?.due_date ?? addDays(now, 14),
      confidence: "low",
      outstanding_invoices: custInvs,
      invoice_forecasts: invoiceForecasts,
    })
  }

  return models.sort((a, b) => b.avg_amount * b.payment_count - a.avg_amount * a.payment_count)
}

// ─── Step 2b: Vendor Behavioral Models ──────────────────────────────

function detectCadence(avgInterval: number): VendorModel["cadence"] {
  if (avgInterval <= 10) return "weekly"
  if (avgInterval <= 18) return "biweekly"
  if (avgInterval <= 45) return "monthly"
  if (avgInterval <= 120) return "quarterly"
  return "irregular"
}

function computeVendorFeatures(
  payments: { amount: number; date: string }[],
  vendorBills: { due_date: string | null }[],
  intervalCV: number,
  amountCV: number,
  archetype: VendorArchetype,
): VendorFeatures {
  const due_date_adherence = vendorBills.length > 0 ? 0.7 : 0.5
  const monthKeys = new Set(payments.map((p) => p.date.slice(0, 7)))
  const dataSpanMonths = monthKeys.size || 1
  const skipped_month_freq = dataSpanMonths > 1 ? r2(1 - payments.length / dataSpanMonths) : 0
  const payment_batching = payments.length >= 3 && intervalCV < 0.4 ? 0.8 : 0.3
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
): VendorArchetype {
  if (economicClass === "transfer") return "treasury_linked"
  if (hasBills && paymentCount < 3) return "one_off_ap"
  if (hasBills && recurrenceType !== "hard" && recurrenceType !== "soft") return "hard_due_date"
  if (recurrenceType === "hard" && intervalCV < 0.2) return "soft_recurring"
  if (recurrenceType === "soft") return "soft_recurring"
  if (recurrenceType === "episodic" && paymentCount >= 4 && amountCV > 0.5) return "spend_on_demand"
  if (recurrenceType === "seasonal" || (paymentCount >= 5 && intervalCV < 0.4)) return "batch_supplier"
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
): RecurrenceModel {
  const n = payments.length
  const intervalStd = std(intervals)

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
    interval_stability_score * 0.35 +
    amount_stability_score * 0.25 +
    counterparty_consistency * 0.15 +
    due_date_consistency * 0.15 +
    class_consistency * 0.1
  )

  if (n <= 2 && !taggedRecurring && !familyRecurring) {
    return {
      recurrence_type: n === 0 ? "unknown" : "episodic",
      recurrence_confidence: r2(n === 0 ? 0 : Math.min(0.15, componentConfidence * 0.3)),
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
        recurrence_confidence: r2(Math.min(0.85, componentConfidence * 1.1)),
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

  if (intervals.length >= 3 && intervalCV < 0.25) {
    return {
      recurrence_type: "hard",
      recurrence_confidence: r2(Math.min(0.95, componentConfidence * 1.1)),
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

  if (intervals.length >= 2 && intervalCV < 0.5 && (taggedRecurring || familyRecurring || n >= 3)) {
    return {
      recurrence_type: "soft",
      recurrence_confidence: r2(Math.min(0.8, componentConfidence)),
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
      recurrence_confidence: r2(Math.min(0.5, componentConfidence * 0.7)),
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

  return {
    recurrence_type: taggedRecurring || familyRecurring ? "soft" : "unknown",
    recurrence_confidence: r2(Math.min(0.3, componentConfidence * 0.5)),
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

function buildVendorModels(movements: TaggedMovement[], bills: OutstandingBill[] = []): VendorModel[] {
  const byEntity = new Map<string, { name: string; ecCounts: Record<string, number>; payments: { amount: number; date: string; recurring: boolean; isAnomaly: boolean; isOutlier: boolean; confidence: number; familyKey: string | null }[] }>()

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
    const taggedRecurring = payments.filter((p) => p.recurring).length > payments.length * 0.5

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
    )
    recurrence.amount_mean = r2(avgAmount)
    recurrence.amount_std = r2(amountStd)

    const lastDate = payments[payments.length - 1].date
    const cadence = detectCadence(avgInterval)

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
    )

    const features = computeVendorFeatures(
      usePayments,
      vendorBills,
      intervalCV,
      amountCV,
      archetype,
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

  return models.sort((a, b) => b.avg_amount * b.payment_count - a.avg_amount * a.payment_count)
}

// ─── Step 2c: Settlement Delay Model ────────────────────────────────
//
// Per-processor settlement profiles with weekday effects, fee netting,
// and aggregated overall cadence.

function buildSettlementModel(movements: TaggedMovement[]): SettlementModel {
  const byProcessor = new Map<string, { timestamps: number[]; amounts: number[]; fees: number[] }>()

  for (const m of movements) {
    const t = m.tag
    if (t.state_inclusion_policy === "exclude_and_review") continue
    if (t.cashflow_bucket !== "settlement") continue
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

  const n = allIntervals.length
  const avg = n > 0 ? allIntervals.reduce((a, b) => a + b, 0) / n : 0
  const delayStd = std(allIntervals)
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

function buildTransferModel(movements: TaggedMovement[]): TransferBehaviorModel {
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

  let triggerPattern: TransferBehaviorModel["trigger_pattern"] = "unknown"
  if (avgInterval && cv < 0.3 && intervals.length >= 3) {
    triggerPattern = "periodic"
  } else if (intervals.length >= 3 && cv < 0.7) {
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
      if (priorNet < -avgAmount * 0.3) lowBalanceTriggers++
    }
    if (sorted.length >= 3 && lowBalanceTriggers / sorted.length > 0.5) {
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

export function buildBehavioralModels(movements: TaggedMovement[], invoices: OutstandingInvoice[] = [], bills: OutstandingBill[] = []): BehavioralModels {
  const customers = buildCustomerModels(movements, invoices)
  return {
    customers,
    vendors: buildVendorModels(movements, bills),
    settlement: buildSettlementModel(movements),
    transfers: buildTransferModel(movements),
    recurring_fixed: buildRecurringFixed(movements),
    invoice_signal: buildInvoiceSignal(invoices),
  }
}

// ─── Step 3: Event Generation Engine (next 30 days) ─────────────────
//
// Generate discrete future cash events from behavioral models.
// Each event has a date, type, entity, amount, probability, and confidence.

function generateEvents30d(models: BehavioralModels, components: CashflowComponent[]): ForecastEvent[] {
  const events: ForecastEvent[] = []
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const horizon = addDays(today, 30)

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
    if (c.probability_of_next < 0.15) continue

    const openInvs = c.outstanding_invoices.filter((i) => i.amount_due > 0)
    const baseReasoning: EventReasoning = {
      basis: `${c.archetype} archetype, ${c.payment_count} prior payments`,
      payment_history: c.payment_count > 0
        ? `${c.payment_count} payments, avg $${c.avg_amount.toLocaleString()}, interval ~${c.payment_interval_days}d`
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
            ? Math.min(0.95, c.probability_of_next + 0.1)
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
        events.push({
          date, day_offset: offset, type: "customer_payment",
          entity: c.name, amount: r2(c.avg_amount),
          direction: "in", probability: c.probability_of_next,
          confidence: c.confidence, source_model: "customer",
          reasoning: baseReasoning,
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
        if (!bill.due_date) continue
        let offset = daysBetween(today, bill.due_date)
        if (offset < 0) offset = 1
        if (offset > 30) continue
        // Stagger bills landing on the same date: spread by vendor to avoid cliff
        const stagger = bi * 1
        const adjustedOffset = Math.min(30, offset + stagger)
        const adjustedDate = addDays(today, adjustedOffset)
        events.push({
          date: adjustedDate, day_offset: adjustedOffset, type: "vendor_payment",
          entity: v.name, amount: r2(bill.amount_due),
          direction: "out", probability: bill.status === "overdue" ? 0.8 : 0.7,
          confidence: "high", source_model: "vendor",
          bill_id: bill.bill_id,
          reasoning: {
            ...vendReasoning,
            invoice_info: `Bill $${bill.amount_due.toLocaleString()}, ${bill.status}${bill.days_overdue ? ` (${bill.days_overdue}d overdue)` : ""}`,
            basis: `AP bill due ${bill.due_date}`,
          },
        })
      }
      continue
    }

    if (!v.is_recurring && v.payment_count < 3) continue
    const recConf = v.recurrence.recurrence_confidence
    const recType = v.recurrence.recurrence_type
    // Don't generate repeating events for episodic/unknown vendors
    if (recType === "episodic" || recType === "unknown") continue
    if (recConf < 0.2) continue
    const prob = recType === "hard" ? Math.min(0.92, 0.8 + recConf * 0.1)
      : recType === "soft" ? Math.min(0.8, 0.55 + recConf * 0.2)
      : recType === "seasonal" ? Math.min(0.7, 0.4 + recConf * 0.2)
      : v.is_recurring ? 0.6 : 0.35

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
        direction: "out", probability: 0.8,
        confidence: "high", source_model: "recurring",
        reasoning: {
          basis: `Fixed recurring obligation, $${rf.monthly_amount.toLocaleString()}/mo`,
          recurrence_info: "Monthly fixed cost",
        },
      })
    })
  }

  // Settlement events — per-processor when available
  if (models.settlement.confidence !== "insufficient" && models.settlement.sample_count >= 3) {
    if (models.settlement.by_processor.length > 0) {
      for (const proc of models.settlement.by_processor) {
        if (proc.sample_count < 2) continue
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
            direction: "in", probability: 0.8,
            confidence: proc.sample_count >= 10 ? "high" : "medium",
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
            direction: "in", probability: 0.8,
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
  if (models.transfers.transfer_count >= 3 && models.transfers.trigger_pattern !== "unknown") {
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
            direction: "in", probability: 0.7,
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
          direction: "in", probability: 0.6, confidence: "medium", source_model: "transfer",
          reasoning: { ...transferReasoning, basis: `Reactive transfer: triggered by outflow cluster at D+${outDay}` },
        })
        transfersPlaced++
      }
    } else if (models.transfers.trigger_pattern === "irregular") {
      events.push({
        date: addDays(today, 15), day_offset: 15, type: "transfer",
        entity: transferEntity, amount: r2(models.transfers.avg_transfer_amount),
        direction: "in", probability: 0.4, confidence: "low", source_model: "transfer",
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

function detectBehavior(bucket: ComponentBucket, totalMonths: number): ComponentBehavior {
  const months = new Set(bucket.movements.map((m) => monthKey(m.date)))
  const coverage = months.size / Math.max(1, totalMonths)
  const recurringPct = bucket.movements.filter((m) => m.is_recurring).length / bucket.movements.length

  // Seasonality detection: need at least 6 months of data and check if same
  // calendar months consistently spike or dip relative to the mean
  if (months.size >= 6) {
    const byCalMonth = new Map<number, number[]>()
    for (const m of bucket.movements) {
      const cm = new Date(m.date).getMonth()
      let arr = byCalMonth.get(cm)
      if (!arr) { arr = []; byCalMonth.set(cm, arr) }
      arr.push(m.amount)
    }
    // Check if any calendar months deviate >50% from overall mean
    const allAmounts = bucket.movements.map((m) => m.amount)
    const overallMean = allAmounts.reduce((a, b) => a + b, 0) / allAmounts.length
    if (overallMean > 0) {
      let peakMonths = 0
      let troughMonths = 0
      for (const [, amounts] of byCalMonth) {
        if (amounts.length < 2) continue
        const monthMean = amounts.reduce((a, b) => a + b, 0) / amounts.length
        const ratio = monthMean / overallMean
        if (ratio > 1.5) peakMonths++
        else if (ratio < 0.5) troughMonths++
      }
      if (peakMonths >= 1 && troughMonths >= 1) return "seasonal"
      if (peakMonths >= 2 || troughMonths >= 2) return "seasonal"
    }
  }

  if (recurringPct > 0.6 || coverage > 0.7) return "recurring"
  if (bucket.movements.length <= 2) return "one_time"
  if (coverage > 0.4) return "episodic"
  return "one_time"
}

function buildComponent(bucket: ComponentBucket, dataSpanDays: number): CashflowComponent {
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
  if (monthValues.length >= 4) {
    const mid = Math.floor(monthValues.length / 2)
    const firstHalf = monthValues.slice(0, mid).reduce((a, b) => a + b, 0) / mid
    const secondHalf = monthValues.slice(mid).reduce((a, b) => a + b, 0) / (monthValues.length - mid)
    trend = firstHalf > 0 ? (secondHalf - firstHalf) / firstHalf : 0
  }

  const behavior = detectBehavior(bucket, totalMonths)

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
  if ((behavior === "recurring" || behavior === "seasonal") && monthValues.length >= 3 && volatility < 0.5) confidence = "high"
  else if (monthValues.length >= 2 && volatility < 1.0) confidence = "medium"

  const cappedTrend = Math.max(-2, Math.min(2, trend))
  const cappedVolatility = Math.min(3, volatility)

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
): { inflows: number; outflows: number; componentAmounts: { component_id: string; amount: number }[] } {
  let inflows = 0
  let outflows = 0
  const componentAmounts: { component_id: string; amount: number }[] = []

  // Time decay: further-out months are less certain, but not dramatically
  const monthDecay = 1 / (1 + monthIndex * 0.08)

  // Customer receipts: bottom-up from entity models
  let customerTotal = 0
  for (const c of models.customers) {
    const archDecay = c.archetype === "clockwork" ? 0.92
      : c.archetype === "slow_reliable" ? 0.8
      : c.archetype === "bursty" ? 0.55
      : c.archetype === "episodic" ? 0.3
      : c.archetype === "volatile" ? 0.2
      : 0.15 // low_data

    if (c.next_expected_date && c.next_expected_date >= monthStart && c.next_expected_date < monthEnd) {
      customerTotal += c.avg_amount * c.probability_of_next
    } else if (c.payment_interval_days > 0 && c.payment_interval_days <= 60) {
      const paymentsInMonth = Math.min(4, 30 / c.payment_interval_days)
      customerTotal += c.avg_amount * c.probability_of_next * paymentsInMonth * archDecay * monthDecay
    } else if (c.archetype === "low_data" && c.outstanding_invoices.length > 0) {
      const lowDataDecay = monthIndex === 0 ? 0.5 : monthIndex <= 2 ? 0.2 : 0.08
      customerTotal += c.avg_amount * c.probability_of_next * lowDataDecay
    } else if (c.payment_count >= 2 && c.avg_amount > 0) {
      customerTotal += c.avg_amount * c.probability_of_next * archDecay * monthDecay * 0.3
    }
  }

  // Portfolio floor: individually unreliable customers are collectively reliable.
  // The historical monthly average from the component aggregate sets a floor
  // that decays gently, preventing the bottom-up model from cliff-dropping.
  const custComp = components.find((c) => c.category === "customer_receipts" && c.direction === "in")
  if (custComp && custComp.monthly_avg > 0) {
    const historicalAvg = custComp.monthly_avg
    // Floor decays: month 0 = 80% of historical, month 5 = ~55%
    const floorDecay = 0.8 / (1 + monthIndex * 0.1)
    const portfolioFloor = historicalAvg * floorDecay
    if (customerTotal < portfolioFloor) {
      // Blend: use the higher of bottom-up or floor, weighted toward floor when bottom-up is weak
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
    if (recConf < 0.25) continue

    if (v.next_expected_date && v.next_expected_date >= monthStart && v.next_expected_date < monthEnd) {
      vendorTotal += v.avg_amount * Math.max(0.5, recConf)
      projectedVendorNames.add(v.name.toLowerCase())
    } else if ((recType === "hard" || recType === "soft" || recType === "seasonal") && v.cadence_interval_days > 0 && v.cadence_interval_days <= 45) {
      const paymentsInMonth = Math.min(4, 30 / v.cadence_interval_days)
      vendorTotal += v.avg_amount * paymentsInMonth * recConf * monthDecay
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
    const vendorFloorDecay = 0.85 / (1 + monthIndex * 0.06)
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
    if (comp.behavior === "episodic") amount *= 0.5 * monthDecay

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
  // Box-Muller transform for normal distribution
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

type ScenarioBias = {
  inflow_prob_mult: number
  outflow_prob_mult: number
  inflow_amount_mult: number
  outflow_amount_mult: number
  inflow_delay_bias: number
  outflow_delay_bias: number
}

const SCENARIO_BIASES: Record<string, ScenarioBias> = {
  base: {
    inflow_prob_mult: 1.0, outflow_prob_mult: 1.0,
    inflow_amount_mult: 1.0, outflow_amount_mult: 1.0,
    inflow_delay_bias: 0, outflow_delay_bias: 0,
  },
  conservative: {
    inflow_prob_mult: 0.75, outflow_prob_mult: 1.0,
    inflow_amount_mult: 0.9, outflow_amount_mult: 1.1,
    inflow_delay_bias: 3, outflow_delay_bias: -1,
  },
  aggressive: {
    inflow_prob_mult: 1.0, outflow_prob_mult: 0.85,
    inflow_amount_mult: 1.1, outflow_amount_mult: 0.92,
    inflow_delay_bias: -2, outflow_delay_bias: 1,
  },
}

function runSingleMonteCarlo(events: ForecastEvent[], startingCash: number, bias: ScenarioBias): number[] {
  const cashByDay = new Array<number>(31).fill(0)
  let cash = startingCash
  const dailyFlows = new Array<number>(31).fill(0)

  for (const e of events) {
    const isIn = e.direction === "in"
    const probMult = isIn ? bias.inflow_prob_mult : bias.outflow_prob_mult
    const effectiveProb = Math.min(1, e.probability * probMult)

    if (Math.random() > effectiveProb) continue

    const amountMult = isIn ? bias.inflow_amount_mult : bias.outflow_amount_mult
    const noiseFactor = e.confidence === "high" ? 0.08 : e.confidence === "medium" ? 0.15 : 0.25
    const amountNoise = 1 + gaussianRandom() * noiseFactor
    const amount = Math.max(0, e.amount * amountMult * amountNoise)

    const delayBias = isIn ? bias.inflow_delay_bias : bias.outflow_delay_bias
    const delayRange = e.confidence === "high" ? 1 : e.confidence === "medium" ? 3 : 5
    const delay = Math.round(gaussianRandom() * delayRange * 0.5 + delayBias)
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

function runMonteCarlo(events: ForecastEvent[], startingCash: number, numSims: number = 500): MonteCarloResult {
  const baseBias = SCENARIO_BIASES.base

  // Run base simulations for percentile bands + probability queries
  const allRuns: number[][] = []
  for (let i = 0; i < numSims; i++) {
    allRuns.push(runSingleMonteCarlo(events, startingCash, baseBias))
  }

  const percentiles: MonteCarloPercentile[] = []
  for (let d = 1; d <= 30; d++) {
    const dayValues = allRuns.map((run) => run[d]).sort((a, b) => a - b)
    percentiles.push({
      day: d,
      p5: r2(percentile(dayValues, 5)),
      p25: r2(percentile(dayValues, 25)),
      p50: r2(percentile(dayValues, 50)),
      p75: r2(percentile(dayValues, 75)),
      p95: r2(percentile(dayValues, 95)),
    })
  }

  const cash14d = allRuns.map((r) => r[14])
  const cash30d = allRuns.map((r) => r[30])

  const probBelowZero14d = r2(cash14d.filter((c) => c < 0).length / numSims)
  const probBelowZero30d = r2(cash30d.filter((c) => c < 0).length / numSims)
  const probAboveStarting30d = r2(cash30d.filter((c) => c > startingCash).length / numSims)

  const sorted30d = [...cash30d].sort((a, b) => a - b)
  const expected30d = cash30d.reduce((a, b) => a + b, 0) / numSims
  const worst30d = sorted30d[Math.floor(numSims * 0.05)]
  const best30d = sorted30d[Math.floor(numSims * 0.95)]

  // Run 3 biased day-level scenarios (each 200 sims, take median)
  const scenarioSims = 200
  const day_scenarios: DayScenarioSnapshot[] = []

  const scenarioDefs: { key: string; scenario: DayScenarioSnapshot["scenario"]; label: string }[] = [
    { key: "base", scenario: "base", label: "Normal behavior" },
    { key: "conservative", scenario: "conservative", label: "Delayed collections, higher outflows" },
    { key: "aggressive", scenario: "aggressive", label: "Faster collections, reduced spend" },
  ]

  for (const def of scenarioDefs) {
    const bias = SCENARIO_BIASES[def.key]
    const runs: number[][] = []
    for (let i = 0; i < scenarioSims; i++) {
      runs.push(runSingleMonteCarlo(events, startingCash, bias))
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

function buildScenarios(ctx: ForecastContext | null): ScenarioConfig[] {
  // Risk-aware scenario biases: higher risk → more aggressive pessimistic stress
  const riskScore = ctx?.risk_score ?? 0
  const concRisk = ctx?.concentration_risk_score ?? 0
  const depRisk = ctx?.dependency_risk_score ?? 0
  const regime = ctx?.liquidity_regime ?? "stable"
  const hasTransitions = (ctx?.transitions ?? []).some((t) => t.regime_change)

  // Pessimistic multipliers get worse with higher risk
  const pessInflowMult = 0.88 - (concRisk > 50 ? 0.08 : 0) - (hasTransitions ? 0.05 : 0)
  const pessOutflowMult = 1.12 + (depRisk > 50 ? 0.06 : 0) + (regime === "tightening" ? 0.04 : 0)
  const pessCustProb = 0.75 - (riskScore > 60 ? 0.10 : riskScore > 40 ? 0.05 : 0)

  return [
    {
      scenario: "base", label: "Base case",
      customer_prob_mult: 1.0, inflow_amount_mult: 1.0,
      outflow_amount_mult: 1.0, trend_dampening: 1.0,
    },
    {
      scenario: "optimistic", label: "Optimistic — faster collections, stable costs",
      customer_prob_mult: 1.15, inflow_amount_mult: 1.08,
      outflow_amount_mult: 0.95, trend_dampening: 1.2,
    },
    {
      scenario: "pessimistic", label: `Pessimistic — risk-adjusted${riskScore > 50 ? " (elevated risk)" : ""}`,
      customer_prob_mult: r2(pessCustProb), inflow_amount_mult: r2(pessInflowMult),
      outflow_amount_mult: r2(pessOutflowMult), trend_dampening: 0.5,
    },
  ]
}

function runScenario(
  models: BehavioralModels,
  components: CashflowComponent[],
  horizonMonths: number,
  startingCash: number,
  config: ScenarioConfig,
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

    const trendFactor = 1 + (config.trend_dampening * (1 / (1 + i * 0.3)))

    const { inflows, outflows, componentAmounts } = simulateMonthFromModels(
      models, components, monthStart, monthEnd,
      { inflow: config.inflow_amount_mult * trendFactor, outflow: config.outflow_amount_mult },
      i,
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
      const comp = components.find((c) => c.id === ca.component_id)
      if (comp?.direction === "in") adjInflows += ca.amount
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
  let forecast: string
  if (Math.abs(delta14) < startingCash * 0.01) {
    forecast = `Projected cash in 14 days: ${money(cash14)} (roughly flat from ${money(startingCash)})`
  } else if (delta14 >= 0) {
    forecast = `Projected cash in 14 days: ${money(cash14)} (+${absDelta} from ${money(startingCash)})`
  } else {
    forecast = `Projected cash in 14 days: ${money(cash14)} (-${absDelta} from ${money(startingCash)})`
  }

  // ── Risk ──
  let risk: string
  const safeStarting = Math.max(1, startingCash)
  const threshold50 = safeStarting * 0.5
  const probBelowThreshold14 = mc.percentiles[13]
    ? (mc.percentiles[13].p5 < threshold50 ? "elevated" : "low")
    : "unknown"

  if (mc.prob_below_zero_14d > 0.1) {
    risk = `${Math.round(mc.prob_below_zero_14d * 100)}% chance of running out of cash in 14 days`
  } else if (mc.prob_below_zero_30d > 0.1) {
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
    if (ctx.concentration_risk_score > 50) {
      risk += ` · Revenue concentration elevated (top customer ${ctx.top_customer_pct}%)`
    }
    if (ctx.dependency_risk_score > 50) {
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

  if (inflowEvents.length > 0 && lowConfInflows.length > inflowEvents.length * 0.4) {
    insight = `Cash volatility is driven by irregular customer payments — ${lowConfInflows.length} of ${inflowEvents.length} expected inflows are low confidence`
  } else if (topCustomerShare > 0.3 && topCustomer) {
    insight = `${Math.round(topCustomerShare * 100)}% of expected inflows come from ${topCustomer.name} — cash position is sensitive to their payment timing`
  } else if (models.transfers.trigger_pattern === "irregular" && models.transfers.transfer_count >= 5) {
    insight = `Liquidity relies on irregular transfers (${models.transfers.transfer_count} observed with no clear pattern) — cash position depends on manual intervention`
  } else if (inflowTotal > 0 && outflowTotal > inflowTotal * 1.2) {
    insight = `Expected outflows exceed inflows by ${Math.round(((outflowTotal - inflowTotal) / inflowTotal) * 100)}% — net cash position will tighten`
  } else if (models.settlement.avg_delay_days > 3 && models.settlement.confidence !== "insufficient") {
    insight = `Settlement cadence averaging ${models.settlement.avg_delay_days.toFixed(1)} days between payouts affects cash arrival timing`
  } else if (outflowTotal > 0) {
    const recurringVendorNames = new Set(models.vendors.filter((v) => v.is_recurring).map((v) => v.name))
    const recurringAmount = outflowEvents.filter((e) =>
      e.type === "recurring_expense" || (e.type === "vendor_payment" && recurringVendorNames.has(e.entity))
    ).reduce((s, e) => s + e.amount, 0)
    const recurringPct = recurringAmount / outflowTotal
    const pctRound = Math.round(recurringPct * 100)
    if (recurringPct >= 0.95) {
      insight = `Near-term outflows are dominated by recurring obligations (~${pctRound}% of modeled spend) — spend base is highly fixed`
    } else if (recurringPct > 0.6) {
      insight = `~${pctRound}% of expected outflows come from recurring patterns — spend base is largely fixed with some variable spend`
    } else {
      insight = `~${pctRound}% of expected outflows are recurring — spend base is moderately flexible`
    }
  } else {
    insight = "Cash position is primarily driven by inflow timing — outflow obligations are minimal"
  }

  // Enrich insight with state-level context
  if (ctx) {
    if (ctx.repeat_revenue_ratio < 0.4 && ctx.repeat_revenue_ratio > 0) {
      insight += ` · Revenue retention is weak (${Math.round(ctx.repeat_revenue_ratio * 100)}% repeat)`
    }
    if (ctx.recurring_spend_ratio > 0.8) {
      insight += ` · Spend base is ${Math.round(ctx.recurring_spend_ratio * 100)}% fixed obligations`
    }
    const regimeTransition = ctx.transitions.find((t) => t.regime_change)
    if (regimeTransition) {
      insight += ` · ${regimeTransition.description}`
    }
  }

  // ── Action ──
  let action: string
  const topCustomers = models.customers.slice(0, 2).filter((c) => c.probability_of_next > 0.3)
  const topCustomerCash = topCustomers.reduce((s, c) => s + c.avg_amount, 0)

  const conservative = mc.day_scenarios.find((s) => s.scenario === "conservative")
  const conservativeGap = conservative ? Math.max(0, cash14 - conservative.cash_14d) : 0

  if (topCustomers.length >= 1 && topCustomerCash > safeStarting * 0.03) {
    const riskReduction = conservativeGap > 0
      ? Math.min(90, Math.round((topCustomerCash / Math.max(1, conservativeGap)) * 100))
      : 30
    const names = topCustomers.map((c) => c.name).join(" and ")
    action = `Accelerating payments from ${names} (~${money(topCustomerCash)}) reduces downside risk by ~${riskReduction}%`
  } else if (models.recurring_fixed.length > 3 && models.recurring_fixed[0] && models.recurring_fixed[0].monthly_amount > safeStarting * 0.02) {
    const topObligation = models.recurring_fixed[0]
    action = `Review top recurring obligation (${topObligation.label}: ${money(topObligation.monthly_amount)}/mo) for cost reduction opportunity`
  } else if (models.transfers.trigger_pattern === "irregular" && models.transfers.transfer_count >= 5) {
    action = `Set up a regular transfer schedule — current transfers are irregular, making cash position harder to predict`
  } else if (mc.prob_below_zero_30d > 0.05) {
    action = `Secure a credit line or prepay arrangements to cover the ${Math.round(mc.prob_below_zero_30d * 100)}% scenario where cash goes negative`
  } else {
    action = `Cash position is stable — focus on accelerating top customer collections to build buffer`
  }

  // ── Severity ──
  let severity: ForecastNarrative["severity"] = "healthy"
  if (mc.prob_below_zero_14d > 0.1 || sim.min_cash < 0) {
    severity = "danger"
  } else if (
    mc.prob_below_zero_30d > 0.05 ||
    (startingCash > 0 && sim.min_cash < startingCash * 0.3) ||
    (startingCash > 0 && cash14 < startingCash * 0.6)
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
): ForecastConfidence {
  const reasons: string[] = []
  const by_component: ComponentConfidence[] = []

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
        const archetypeBonus = c.archetype === "clockwork" ? 1.0
          : c.archetype === "slow_reliable" ? 0.7
          : c.archetype === "bursty" ? 0.5
          : c.archetype === "episodic" ? 0.35
          : c.archetype === "volatile" ? 0.2
          : 0.15
        const confMult = c.confidence === "high" ? 1.0 : c.confidence === "medium" ? 0.6 : 0.25
        weightedConf += weight * archetypeBonus * confMult
      }
      inflowScore = weightedConf
    } else {
      const custHigh = models.customers.filter((c) => c.confidence === "high").length
      const custMed = models.customers.filter((c) => c.confidence === "medium").length
      inflowScore = (custHigh * 1 + custMed * 0.6) / custTotal
    }
  }
  if (inflowScore < 0.3) reasons.push("Top inflows are sparse or episodic")
  const inflowLabel: ComponentConfidence["label"] = inflowScore >= 0.7 ? "high" : inflowScore >= 0.4 ? "medium" : "low"
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
  let outflowScore = 0
  if (vendTotal > 0) {
    const totalSpend = models.vendors.reduce((s, v) => s + v.avg_amount * v.payment_count, 0)
    if (totalSpend > 0) {
      let weightedConf = 0
      for (const v of models.vendors) {
        const weight = (v.avg_amount * v.payment_count) / totalSpend
        const recBonus = v.recurrence.recurrence_confidence
        const confMult = v.confidence === "high" ? 1.0 : v.confidence === "medium" ? 0.6 : 0.25
        weightedConf += weight * recBonus * confMult
      }
      outflowScore = weightedConf
    } else {
      const vendHigh = models.vendors.filter((v) => v.confidence === "high").length
      const vendMed = models.vendors.filter((v) => v.confidence === "medium").length
      outflowScore = (vendHigh * 1 + vendMed * 0.6) / vendTotal
    }
  }
  if (outflowScore < 0.3) reasons.push("Outflow models are weak — vendor recurrence uncertain")
  const outflowLabel: ComponentConfidence["label"] = outflowScore >= 0.7 ? "high" : outflowScore >= 0.4 ? "medium" : "low"
  const recurrenceBreakdown = vendTotal > 0 ? (() => {
    const counts: Record<string, number> = {}
    models.vendors.forEach((v) => { counts[v.recurrence.recurrence_type] = (counts[v.recurrence.recurrence_type] ?? 0) + 1 })
    return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")
  })() : "No vendors"
  by_component.push({
    area: "Outflow models", score: r2(outflowScore), label: outflowLabel,
    reason: `${vendTotal} vendors (${recurrenceBreakdown}) — spend-weighted`,
  })

  // ── 3. Settlement confidence (weight: 0.10) ──
  const settConf = models.settlement.confidence
  const procCount = models.settlement.by_processor.length
  const settScore = settConf === "high" ? 0.9 : settConf === "medium" ? 0.65 : settConf === "low" ? 0.35 : 0.1
  by_component.push({
    area: "Settlement timing", score: r2(settScore),
    label: settConf === "high" ? "high" : settConf === "medium" ? "medium" : "low",
    reason: models.settlement.sample_count === 0
      ? "No settlement data"
      : `${models.settlement.sample_count} samples across ${procCount} processor(s), avg ${models.settlement.avg_delay_days.toFixed(1)}d`,
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
  }
  by_component.push({
    area: "Recurrence quality", score: r2(recurrenceScore),
    label: recurrenceScore >= 0.6 ? "high" : recurrenceScore >= 0.35 ? "medium" : "low",
    reason: vendTotal === 0 ? "No vendor recurrence data" : `Avg recurrence confidence: ${(recurrenceScore * 100).toFixed(0)}%`,
  })

  // ── 6. Data span confidence (weight: 0.10) ──
  const monthsOfData = Math.max(1, dataSpanDays / 30)
  const dataSpanScore = Math.min(1, monthsOfData / 6)
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
  const variancePenalty = Math.min(0.4, avgVolatility * 0.3)
  const varianceScore = Math.max(0, 1 - variancePenalty * 2)
  if (avgVolatility > 0.8) reasons.push("High volatility in cashflow components")
  by_component.push({
    area: "Stability", score: r2(varianceScore),
    label: varianceScore >= 0.7 ? "high" : varianceScore >= 0.4 ? "medium" : "low",
    reason: `Avg component volatility: ${(avgVolatility * 100).toFixed(0)}%`,
  })

  // ── 8. Backtest confidence (weight: 0.10) ──
  // accuracy_score is 0-100, normalize to 0-1 for the composite
  const backtestScore = backtest ? Math.min(1, backtest.accuracy_score / 100) : 0
  by_component.push({
    area: "Backtest accuracy", score: r2(backtestScore),
    label: backtestScore >= 0.7 ? "high" : backtestScore >= 0.4 ? "medium" : "low",
    reason: backtest
      ? `${backtest.days_tested}d tested, direction accuracy ${(backtest.direction_accuracy * 100).toFixed(0)}%, MAE $${backtest.mean_absolute_error.toLocaleString()}`
      : "No backtest data available",
  })

  // ── Weighted composite score ──
  const weightedScore =
    inflowScore * 0.20 +
    outflowScore * 0.20 +
    settScore * 0.10 +
    identityScore * 0.10 +
    recurrenceScore * 0.10 +
    dataSpanScore * 0.10 +
    varianceScore * 0.10 +
    backtestScore * 0.10

  const score = Math.max(0.05, Math.min(hasUnresolvedOrExcluded ? 0.99 : 1, weightedScore))
  const label: ForecastConfidence["label"] = score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low"
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
  const diagnosis = score < 0.45
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
  if (backtestScore < 0.5) how_to_improve.push("More historical data needed for reliable backtest")
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
): Intervention[] {
  const interventions: Intervention[] = []
  const baseCash14 = mc.day_scenarios.find((s) => s.scenario === "base")?.cash_14d ?? mc.expected_cash_30d
  const baseCash30 = mc.expected_cash_30d
  const baseRisk30 = mc.prob_below_zero_30d
  const baseLowPoint = dailySim?.min_cash ?? baseCash14 * 0.85
  const stressProb = mc.prob_below_zero_14d > 0.05 ? mc.prob_below_zero_14d : mc.prob_below_zero_30d

  // Accelerate top customer collections (3 days earlier)
  for (const c of models.customers.slice(0, 3)) {
    if (c.probability_of_next < 0.3) continue
    const expectedCash = c.avg_amount * c.probability_of_next
    if (expectedCash < 100) continue
    const impact14 = r2(expectedCash * 0.7)
    const impact30 = r2(expectedCash * 0.5)
    const riskReduction = baseRisk30 > 0 ? r2(Math.min(50, (expectedCash / Math.max(1, startingCash)) * 100)) : 0

    const simImpact: ActionSimulationImpact = {
      low_point_before: baseLowPoint,
      low_point_after: r2(baseLowPoint + impact14 * 0.6),
      stress_prob_before: stressProb,
      stress_prob_after: r2(Math.max(0, stressProb - riskReduction / 100)),
    }
    interventions.push({
      id: `accel_${c.entity_id}`,
      label: `Accelerate ${c.name} by 3 days`,
      type: "accelerate_collection",
      entity: c.name,
      parameter_days: 3,
      parameter_pct: null,
      impact_cash_14d: impact14,
      impact_cash_30d: impact30,
      impact_risk_reduction: riskReduction,
      description: `If ${c.name} pays 3 days earlier, expected cash improves by ~$${Math.round(impact14).toLocaleString()} at day 14`,
      plausible_range_low: r2(impact14 * 0.6),
      plausible_range_high: r2(impact14 * 1.2),
      confidence_band: c.confidence === "high" ? "medium" : "low-medium",
      assumptions: ["Customer agrees to accelerate payment", "No discount required"],
      simulation_impact: simImpact,
    })
  }

  // Delay top vendor payments (5 days)
  for (const v of models.vendors.slice(0, 3)) {
    if (!v.is_recurring && v.payment_count < 3) continue
    const monthlyCash = v.avg_amount
    if (monthlyCash < 100) continue
    const impact14 = r2(monthlyCash * 0.5)
    const impact30 = r2(monthlyCash * 0.3)
    const riskReduction = baseRisk30 > 0 ? r2(Math.min(30, (monthlyCash / Math.max(1, startingCash)) * 80)) : 0

    const simImpact: ActionSimulationImpact = {
      low_point_before: baseLowPoint,
      low_point_after: r2(baseLowPoint + impact14 * 0.5),
      stress_prob_before: stressProb,
      stress_prob_after: r2(Math.max(0, stressProb - riskReduction / 100)),
    }
    const lateFeeP = v.outstanding_bills.length > 0 ? 0.2 : 0.05
    const relRisk = v.recurrence.recurrence_type === "hard" ? 0.15 : 0.08
    const nextTrough = r2(-monthlyCash * 0.4)
    interventions.push({
      id: `delay_${v.entity_id}`,
      label: `Delay ${v.name} by 5 days`,
      type: "delay_payment",
      entity: v.name,
      parameter_days: 5,
      parameter_pct: null,
      impact_cash_14d: impact14,
      impact_cash_30d: impact30,
      impact_risk_reduction: riskReduction,
      description: `Delaying ${v.name} payments by 5 days frees ~$${Math.round(impact14).toLocaleString()} in the near term`,
      vendor_relationship_risk: relRisk,
      late_fee_probability: lateFeeP,
      impact_on_next_month_trough: nextTrough,
      cascade_crunch_probability: startingCash < monthlyCash * 2 ? 0.12 : 0.03,
      expected_impact: impact14,
      plausible_range_low: r2(impact14 * 0.6),
      plausible_range_high: r2(impact14 * 1.2),
      confidence_band: "medium",
      assumptions: ["Vendor accepts 5-day delay", "No late fees incurred", "AP load shifts to next month"],
      simulation_impact: simImpact,
      second_order_risks: {
        late_fee: lateFeeP > 0.1 ? `~${Math.round(lateFeeP * 100)}% chance of late fee if terms are strict` : undefined,
        relationship: relRisk > 0.1 ? `Vendor relationship risk (${v.recurrence.recurrence_type === "hard" ? "tight recurring" : "regular"})` : undefined,
        next_period: `Next-period trough: ${nextTrough < 0 ? `-$${Math.abs(nextTrough).toLocaleString()} compressed` : "neutral"}`,
      },
    })
  }

  // Reduce overall spend by 10%
  const totalOutflowEvents = events.filter((e) => e.direction === "out")
  const totalOutflow30 = totalOutflowEvents.reduce((s, e) => s + e.amount * e.probability, 0)
  if (totalOutflow30 > 0) {
    const savings = r2(totalOutflow30 * 0.1)
    const riskRed = baseRisk30 > 0 ? r2(Math.min(40, (savings / Math.max(1, startingCash)) * 100)) : 0
    const simImpact: ActionSimulationImpact = {
      low_point_before: baseLowPoint,
      low_point_after: r2(baseLowPoint + savings * 0.4),
      stress_prob_before: stressProb,
      stress_prob_after: r2(Math.max(0, stressProb - riskRed / 100)),
      runway_months_change: startingCash > 0 && savings > 0 ? r2((savings / 30) / (startingCash / 90)) : undefined,
    }
    interventions.push({
      id: "reduce_spend_10",
      label: "Reduce overall spend by 10%",
      type: "reduce_spend",
      entity: null,
      parameter_days: null,
      parameter_pct: 10,
      impact_cash_14d: r2(savings * 0.5),
      impact_cash_30d: savings,
      impact_risk_reduction: riskRed,
      description: `A 10% spend reduction saves ~$${Math.round(savings).toLocaleString()} over 30 days`,
      plausible_range_low: r2(savings * 0.5 * 0.7),
      plausible_range_high: r2(savings * 0.5 * 1.3),
      confidence_band: "low-medium",
      assumptions: ["Spend reduction is achievable without affecting operations"],
      simulation_impact: simImpact,
    })
  }

  // Sort by risk reduction first (when stress prob > 0), else by cash impact; assign rank
  interventions.sort((a, b) => {
    if (baseRisk30 > 0.05 && Math.abs(a.impact_risk_reduction - b.impact_risk_reduction) > 2) {
      return b.impact_risk_reduction - a.impact_risk_reduction
    }
    return b.impact_cash_14d - a.impact_cash_14d
  })
  const top = interventions.slice(0, 6)
  top.forEach((iv, i) => { iv.rank = i + 1 })
  return top
}

// ─── Step 12b: Combined Strategies (best 2-action combos) ─────────────

function computeCombinedStrategies(
  interventions: Intervention[],
  baseLowPoint: number,
  stressProb: number,
): CombinedStrategy[] {
  const strategies: CombinedStrategy[] = []
  const accel = interventions.filter((i) => i.type === "accelerate_collection")
  const delay = interventions.filter((i) => i.type === "delay_payment")
  const reduce = interventions.filter((i) => i.type === "reduce_spend")

  // Strategy A: delay + accelerate (most common founder combo)
  if (delay.length > 0 && accel.length > 0) {
    const d = delay[0]
    const a = accel[0]
    const combinedLow = r2(baseLowPoint + (d.impact_cash_14d + a.impact_cash_14d) * 0.5)
    const newStress = Math.max(0, stressProb - (d.impact_risk_reduction + a.impact_risk_reduction) / 100)
    strategies.push({
      id: "strat_delay_accel",
      actions: [d, a],
      low_point: combinedLow,
      stress_prob: r2(newStress),
      risk_level: newStress < 0.15 ? "low" : newStress < 0.35 ? "medium" : "high",
      summary: `Delay ${d.entity} 5d + accelerate ${a.entity} 3d → low point $${Math.round(combinedLow).toLocaleString()}, stress prob ${(newStress * 100).toFixed(0)}%`,
    })
  }

  // Strategy B: delay + reduce spend
  if (delay.length > 0 && reduce.length > 0) {
    const d = delay[0]
    const r = reduce[0]
    const combinedLow = r2(baseLowPoint + d.impact_cash_14d * 0.5 + r.impact_cash_14d * 0.5)
    const newStress = Math.max(0, stressProb - (d.impact_risk_reduction + r.impact_risk_reduction) / 100)
    strategies.push({
      id: "strat_delay_reduce",
      actions: [d, r],
      low_point: combinedLow,
      stress_prob: r2(newStress),
      risk_level: newStress < 0.15 ? "low" : newStress < 0.35 ? "medium" : "high",
      summary: `Delay ${d.entity} 5d + reduce spend 10% → low point $${Math.round(combinedLow).toLocaleString()}, stress prob ${(newStress * 100).toFixed(0)}%`,
    })
  }

  // Strategy C: accelerate + accelerate (two top customers)
  if (accel.length >= 2) {
    const a1 = accel[0]
    const a2 = accel[1]
    const combinedLow = r2(baseLowPoint + (a1.impact_cash_14d + a2.impact_cash_14d) * 0.5)
    const newStress = Math.max(0, stressProb - (a1.impact_risk_reduction + a2.impact_risk_reduction) / 100)
    strategies.push({
      id: "strat_accel_accel",
      actions: [a1, a2],
      low_point: combinedLow,
      stress_prob: r2(newStress),
      risk_level: newStress < 0.15 ? "low" : newStress < 0.35 ? "medium" : "high",
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
): ScenarioDriver[] {
  const drivers: ScenarioDriver[] = []
  const baseEnding = baseResult.ending_cash
  const pessEnding = pessResult.ending_cash
  const gap = baseEnding - pessEnding
  if (gap <= 0) return drivers

  // Customer delay impact
  const customerInflows = events.filter((e) => e.direction === "in" && e.source_model === "customer")
  const customerTotal = customerInflows.reduce((s, e) => s + e.amount * e.probability, 0)
  if (customerTotal > 0) {
    const delayedAmount = r2(customerTotal * 0.25)
    drivers.push({
      factor: `Delayed customer payments (top ${Math.min(3, models.customers.length)} customers)`,
      impact_amount: delayedAmount,
      direction: "negative",
    })
  }

  // Higher vendor outflows
  const vendorOutflows = events.filter((e) => e.direction === "out" && e.source_model === "vendor")
  const vendorTotal = vendorOutflows.reduce((s, e) => s + e.amount * e.probability, 0)
  if (vendorTotal > 0) {
    const higherCost = r2(vendorTotal * 0.12)
    drivers.push({
      factor: "Higher vendor costs (+12% stress)",
      impact_amount: higherCost,
      direction: "negative",
    })
  }

  // Missing settlements
  if (models.settlement.sample_count > 0) {
    const settlementEvents = events.filter((e) => e.type === "settlement")
    const settlementCash = settlementEvents.reduce((s, e) => s + e.amount * e.probability, 0)
    if (settlementCash > 0) {
      drivers.push({
        factor: "Settlement timing delays",
        impact_amount: r2(settlementCash * 0.15),
        direction: "negative",
      })
    }
  }

  // No offsetting inflows
  const recurringIn = events.filter((e) => e.direction === "in" && e.probability >= 0.9)
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

function runCalibration(events: ForecastEvent[], testSet: TaggedMovement[], cutoffDate: string, testDays: number): CalibrationResult | null {
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

  const isOverconfident = avgPredicted > avgActual + 0.1
  const isUnderconfident = avgActual > avgPredicted + 0.1

  let details = `Calibration across ${totalEvents} events: ECE ${(calibrationError * 100).toFixed(1)}%`
  if (isOverconfident) details += " — probabilities are overconfident (predicted > actual)"
  else if (isUnderconfident) details += " — probabilities are underconfident (actual > predicted)"
  else details += " — probabilities are reasonably calibrated"

  const suggested_interpretation = isOverconfident && calibrationError > 0.25
    ? "Model is overconfident: interpret a 70% prediction as ~50–55% in practice. Use ranges, not point estimates."
    : isOverconfident
      ? "Slight overconfidence: treat high probabilities (80%+) with some caution."
      : undefined

  // Temperature scaling: p_adj = p^T with T>1 pulls high probs down (reduces overconfidence)
  const probability_temperature = isOverconfident && calibrationError > 0.2
    ? r2(1 + calibrationError * 1.5)
    : undefined

  // Merge low-sample buckets (n < 5) with adjacent buckets for more stable display
  const mergedBuckets = mergeLowSampleBuckets(calibrationBuckets, 5)

  return { total_events_evaluated: totalEvents, buckets: mergedBuckets, calibration_error: calibrationError, is_overconfident: isOverconfident, is_underconfident: isUnderconfident, details, suggested_interpretation, probability_temperature }
}

const BACKTEST_HORIZONS = [7, 14, 30, 60, 90] as const

function runSingleBacktest(
  movements: TaggedMovement[],
  invoices: OutstandingInvoice[],
  bills: OutstandingBill[],
  testDays: number,
  allDates: string[],
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

  if (training.length < 20 || testSet.length < 5) return null

  const models = buildBehavioralModels(training, invoices, bills)
  const buckets = decomposeMovements(training)
  const dataSpan = daysBetween(allDates[0], cutoffDate)
  const components = buckets.map((b) => buildComponent(b, dataSpan))
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

  if (activeDays < 3) return null

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

  const calibration = runCalibration(events, testSet, cutoffDate, testDays)

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

function runBacktest(movements: TaggedMovement[], invoices: OutstandingInvoice[], bills: OutstandingBill[]): BacktestResult | null {
  const allDates = movements.map((m) => toDateStr(m.occurred_at)).filter(Boolean).sort()
  if (allDates.length < 30) return null

  const totalSpanDays = daysBetween(allDates[0], allDates[allDates.length - 1])

  // Primary backtest at 14 days
  const primary = runSingleBacktest(movements, invoices, bills, 14, allDates)
  if (!primary) return null

  const by_horizon: BacktestByHorizon[] = []
  for (const h of BACKTEST_HORIZONS) {
    if (h > totalSpanDays * 0.4) continue
    const r = runSingleBacktest(movements, invoices, bills, h, allDates)
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

export function computeCashflowForecast(
  movements: TaggedMovement[],
  startingCash: number,
  horizonMonths: number = 6,
  invoices: OutstandingInvoice[] = [],
  identityCtx: IdentityContext = { entityNames: new Map(), entityTypes: new Map(), aliasToEntityId: new Map(), counterpartyByMovement: new Map(), familyMembers: new Map() },
  bills: OutstandingBill[] = [],
  forecastCtx: ForecastContext | null = null,
): CashflowForecast {
  setIdentityContext(identityCtx)
  const dates = movements.map((m) => toDateStr(m.occurred_at)).filter(Boolean).sort()
  const periodStart = dates[0] ?? new Date().toISOString().slice(0, 10)
  const periodEnd = dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10)
  const dataSpanDays = daysBetween(periodStart, periodEnd)

  // Aggregate component models (for non-entity categories)
  const buckets = decomposeMovements(movements)
  const components = buckets.map((b) => buildComponent(b, dataSpanDays))

  // Entity-level behavioral models (enhanced with invoice + bill data)
  const behavioral_models = buildBehavioralModels(movements, invoices, bills)

  // Event generation: discrete 30-day forecast
  const events_30d = generateEvents30d(behavioral_models, components)

  // Daily cashflow simulation: cash[t+1] = cash[t] + inflows[t] - outflows[t]
  const daily_simulation = simulateDaily(events_30d, startingCash)

  // Monte Carlo: 500 simulations with payment delays, amount variance, missed payments
  const monte_carlo = runMonteCarlo(events_30d, startingCash, 500)

  // Narrative: deterministic Forecast / Risk / Insight / Action (enriched with state context)
  const narrative = generateNarrative(monte_carlo, daily_simulation, behavioral_models, events_30d, startingCash, forecastCtx)

  // Run risk-aware scenarios
  const scenarios = buildScenarios(forecastCtx).map((config) =>
    runScenario(behavioral_models, components, horizonMonths, startingCash, config)
  )

  // Cash runway
  const cash_runway = computeCashRunway(scenarios, startingCash, dataSpanDays)

  // Sensitivity analysis
  const sensitivity = computeSensitivity(events_30d, behavioral_models, monte_carlo, startingCash)

  // Intervention engine
  const interventions = computeInterventions(events_30d, behavioral_models, monte_carlo, startingCash, daily_simulation)
  const combined_strategies = computeCombinedStrategies(
    interventions,
    daily_simulation.min_cash,
    monte_carlo.prob_below_zero_14d > 0.05 ? monte_carlo.prob_below_zero_14d : monte_carlo.prob_below_zero_30d,
  )

  // Scenario drivers (WHY the pessimistic scenario is bad)
  const baseScenario = scenarios.find((s) => s.scenario === "base")
  const pessScenario = scenarios.find((s) => s.scenario === "pessimistic")
  const pessDrivers = baseScenario && pessScenario
    ? computeScenarioDrivers(behavioral_models, events_30d, baseScenario, pessScenario)
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
  const backtest = runBacktest(movements, invoices, bills)

  // Forecast confidence (8-component weighted, with backtest input)
  const forecast_confidence = computeForecastConfidence(behavioral_models, components, events_30d, dataSpanDays, backtest, movements)

  // Separated forecast: operating vs settlement vs treasury vs owner
  const today = new Date().toISOString().slice(0, 10)
  const separated_forecast = computeSeparatedForecast(events_30d, today)

  const metadata: ForecastMetadata = {
    model_version: MODEL_VERSION,
    feature_version: MODEL_VERSION,
    calibration_version: CALIBRATION_VERSION,
    tagging_version: TAGGING_VERSION,
    policy_version: POLICY_VERSION,
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

// ─── LLM Integration (optional, gated) ───────────────────────────────
//
// Use env FORECAST_LLM_ENABLED or feature flag to enable.
// When disabled, system remains deterministic.

export async function generateNarrativeWithLLM(
  narrative: import("./types").ForecastNarrative,
  _context: ForecastContext,
): Promise<string> {
  if (!process.env.FORECAST_LLM_ENABLED) return narrative.forecast
  // Placeholder: call external LLM to enrich narrative
  return narrative.forecast
}

export async function disambiguateEntity(
  counterparty: string,
  candidates: string[],
): Promise<string> {
  if (!process.env.FORECAST_LLM_ENABLED || candidates.length <= 1) return counterparty
  // Placeholder: call LLM to pick best match from candidates
  return candidates[0] ?? counterparty
}

export async function explainAnomaly(
  _movement: TaggedMovement,
  _context: string,
): Promise<string> {
  if (!process.env.FORECAST_LLM_ENABLED) return "Anomaly detected — review recommended."
  // Placeholder: call LLM to explain why vendor payment spiked
  return "Anomaly detected — review recommended."
}
