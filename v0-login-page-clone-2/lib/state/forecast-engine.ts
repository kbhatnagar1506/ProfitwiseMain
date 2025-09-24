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

import type { CanonicalMovement, MovementTag } from "@/lib/movement-types"
import type {
  CashflowComponent,
  ComponentBehavior,
  ComponentConfidence,
  CustomerModel,
  VendorModel,
  SettlementModel,
  TransferBehaviorModel,
  BehavioralModels,
  OutstandingInvoice,
  OutstandingBill,
  InvoiceSignal,
  ForecastEvent,
  DailySimDay,
  DailySimulation,
  MonteCarloPercentile,
  DayScenarioSnapshot,
  MonteCarloResult,
  ForecastNarrative,
  ForecastMonth,
  ScenarioResult,
  CashflowForecast,
  ForecastConfidence,
  ForecastContext,
  CashRunway,
  SensitivityDriver,
  SensitivityAnalysis,
  Intervention,
  ScenarioDriver,
  BacktestResult,
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

function setIdentityContext(ctx: IdentityContext) { _ctx = ctx }

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

  // 3. Counterparty from observation/metadata (if clean)
  if (counterparty && !UUID_RE.test(counterparty)) {
    const cleaned = cleanDescriptor(counterparty)
    if (cleaned.length >= 2) return cleaned
  }

  // 4. Cleaned descriptor
  if (rawDesc && !UUID_RE.test(rawDesc)) {
    const cleaned = cleanDescriptor(rawDesc)
    if (cleaned.length >= 2) return cleaned
  }

  // 5. Role-based fallback with short ID fragment (never "Unnamed entity")
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

// ─── Step 2a: Customer Behavioral Models ────────────────────────────
//
// Probability model:
//   - Sigmoid decay: probability drops smoothly as overdue ratio increases
//   - Payment count weighting: more history → higher base probability
//   - Amount trend: declining payments dampen probability (churn signal)

function sigmoidDecay(overdueRatio: number): number {
  // S-curve: 0.95 when on-time, drops through 0.5 at 2x overdue, ~0.05 at 5x
  return 1 / (1 + Math.exp(2.5 * (overdueRatio - 2)))
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

    // Filter anomalous/outlier amounts for a stable average; weight by confidence
    const normalPayments = payments.filter((p) => !p.isAnomaly && !p.isOutlier)
    const usePayments = normalPayments.length >= 2 ? normalPayments : payments
    let weightedSum = 0, weightSum = 0
    for (const p of usePayments) {
      const w = Math.max(0.1, Math.min(1, p.confidence))
      weightedSum += p.amount * w
      weightSum += w
    }
    const avgAmount = weightSum > 0 ? weightedSum / weightSum : usePayments.reduce((s, p) => s + p.amount, 0) / usePayments.length

    const isFirstSeenOnly = payments.length === 1 && payments[0].isFirstSeen

    const intervals: number[] = []
    for (let i = 1; i < payments.length; i++) {
      intervals.push(daysBetween(payments[i - 1].date, payments[i].date))
    }

    const avgInterval = intervals.length > 0
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length
      : 0
    const intervalVariance = std(intervals)

    const lastDate = payments[payments.length - 1].date
    const daysSinceLast = daysBetween(lastDate, now)

    // Smooth sigmoid decay based on overdue ratio
    let probability: number
    if (intervals.length >= 1 && avgInterval > 0) {
      const overdueRatio = daysSinceLast / avgInterval
      probability = sigmoidDecay(overdueRatio)
    } else if (payments.length === 1) {
      probability = daysSinceLast < 60 ? 0.3 : daysSinceLast < 120 ? 0.15 : 0.05
    } else {
      probability = 0.5
    }

    // Payment count weighting: more history → stronger base
    const countBoost = Math.min(1, payments.length / 8)
    probability = probability * (0.6 + 0.4 * countBoost)

    // Amount trend: if recent payments are declining, dampen probability
    if (payments.length >= 4) {
      const mid = Math.floor(payments.length / 2)
      const amounts = payments.map((p) => p.amount)
      const firstHalfAvg = amounts.slice(0, mid).reduce((a, b) => a + b, 0) / mid
      const secondHalfAvg = amounts.slice(mid).reduce((a, b) => a + b, 0) / (amounts.length - mid)
      if (firstHalfAvg > 0) {
        const amountTrend = secondHalfAvg / firstHalfAvg
        if (amountTrend < 0.5) probability *= 0.6
        else if (amountTrend < 0.8) probability *= 0.85
      }
    }

    // First-seen counterparty with single payment: lower probability until pattern established
    if (isFirstSeenOnly) probability *= 0.4

    probability = Math.max(0.02, Math.min(0.98, probability))

    let nextDate: string | null = null
    if (avgInterval > 0 && probability > 0.1) {
      nextDate = addDays(lastDate, avgInterval)
      if (nextDate < now) nextDate = addDays(now, Math.max(1, avgInterval * 0.3))
    }

    let confidence: "high" | "medium" | "low" = "low"
    if (payments.length >= 5 && intervalVariance < avgInterval * 0.5) confidence = "high"
    else if (payments.length >= 3) confidence = "medium"

    // Collect invoice_ids from tag_data for this customer's movements (T9: direct linkage)
    const linkedInvoiceIds = new Set<string>()
    for (const m of movements) {
      if (m.tag.economic_class !== "customer_receipt") continue
      if (resolveEntityId(m) !== entityId) continue
      if (m.tag.invoice_id) linkedInvoiceIds.add(m.tag.invoice_id)
    }

    // Match outstanding invoices: tag-linked, entity_id, or name match
    const normName = data.name.toLowerCase().replace(/[^a-z0-9]/g, "")
    const customerInvoices = invoices.filter((inv) => {
      if (linkedInvoiceIds.has(inv.invoice_id)) return true
      if (inv.entity_id && inv.entity_id === entityId) return true
      const invName = inv.customer_name.toLowerCase().replace(/[^a-z0-9]/g, "")
      return invName.length >= 3 && (normName.includes(invName) || invName.includes(normName))
    })

    // Invoice boost: if customer has outstanding invoices, override predictions
    if (customerInvoices.length > 0) {
      const earliestDue = customerInvoices
        .filter((i) => i.due_date)
        .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""))[0]

      // Boost probability: an outstanding invoice is strong evidence of upcoming payment
      if (probability < 0.8) probability = Math.min(0.98, probability + 0.3)
      if (confidence === "low") confidence = "medium"

      // Override next_expected_date with earliest invoice due date (if within 30 days)
      if (earliestDue?.due_date && earliestDue.due_date >= now) {
        const dueOffset = daysBetween(now, earliestDue.due_date)
        if (dueOffset <= 30) nextDate = earliestDue.due_date
      } else if (earliestDue?.status === "overdue") {
        nextDate = addDays(now, 3)
        probability = Math.min(0.98, probability + 0.1)
      }
    }

    models.push({
      entity_id: entityId,
      name: data.name,
      avg_amount: r2(avgAmount),
      payment_interval_days: Math.round(avgInterval),
      interval_variance: r2(intervalVariance),
      last_payment_date: lastDate,
      payment_count: payments.length,
      probability_of_next: r2(probability),
      next_expected_date: nextDate,
      confidence,
      outstanding_invoices: customerInvoices,
    })
  }

  // Also create models for invoice customers who have no payment history yet
  const existingEntities = new Set(models.map((m) => m.entity_id))
  const existingNames = new Set(models.map((m) => m.name.toLowerCase().replace(/[^a-z0-9]/g, "")))

  const unmatchedInvoices = invoices.filter((inv) => {
    if (inv.entity_id && existingEntities.has(inv.entity_id)) return false
    const invName = inv.customer_name.toLowerCase().replace(/[^a-z0-9]/g, "")
    return !existingNames.has(invName)
  })

  // Group unmatched invoices by customer name
  const byCustomer = new Map<string, OutstandingInvoice[]>()
  for (const inv of unmatchedInvoices) {
    const key = inv.customer_name.toLowerCase().replace(/[^a-z0-9]/g, "")
    let arr = byCustomer.get(key)
    if (!arr) { arr = []; byCustomer.set(key, arr) }
    arr.push(inv)
  }

  for (const [, custInvs] of byCustomer) {
    const totalDue = custInvs.reduce((s, i) => s + i.amount_due, 0)
    const earliest = custInvs.filter((i) => i.due_date).sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""))[0]

    models.push({
      entity_id: custInvs[0].entity_id ?? `inv_${custInvs[0].invoice_id}`,
      name: custInvs[0].customer_name,
      avg_amount: r2(totalDue / custInvs.length),
      payment_interval_days: 0,
      interval_variance: 0,
      last_payment_date: now,
      payment_count: 0,
      probability_of_next: custInvs.some((i) => i.status === "overdue") ? 0.7 : 0.85,
      next_expected_date: earliest?.due_date ?? addDays(now, 14),
      confidence: "medium",
      outstanding_invoices: custInvs,
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

function buildVendorModels(movements: TaggedMovement[], bills: OutstandingBill[] = []): VendorModel[] {
  const byEntity = new Map<string, { name: string; payments: { amount: number; date: string; recurring: boolean; isAnomaly: boolean; isOutlier: boolean; confidence: number; familyKey: string | null }[] }>()

  for (const m of movements) {
    const ec = m.tag.economic_class
    if (ec !== "vendor_payment" && ec !== "payroll" && ec !== "processor_fee" && ec !== "debt_payment") continue
    if (m.tag.state_inclusion_policy === "exclude_and_review") continue

    const key = resolveEntityId(m)
    const cp = observedCounterparty(m)
    const name = resolveEntityName(key, cp, m.raw_description, "vendor")
    let entry = byEntity.get(key)
    if (!entry) { entry = { name, payments: [] }; byEntity.set(key, entry) }
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

    // Filter anomalies/outliers; confidence-weight the rest
    const normalPayments = payments.filter((p) => !p.isAnomaly && !p.isOutlier)
    const usePayments = normalPayments.length >= 2 ? normalPayments : payments
    let vWeightedSum = 0, vWeightTotal = 0
    for (const p of usePayments) {
      const w = Math.max(0.1, Math.min(1, p.confidence))
      vWeightedSum += p.amount * w
      vWeightTotal += w
    }
    const avgAmount = vWeightTotal > 0 ? vWeightedSum / vWeightTotal : usePayments.reduce((s, p) => s + p.amount, 0) / usePayments.length
    const taggedRecurring = payments.filter((p) => p.recurring).length > payments.length * 0.5

    // Use movement family data for stronger recurrence signal
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

    const avgInterval = intervals.length > 0
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length
      : 0

    // Detect cadence regularity: if interval CV is low, payments are effectively recurring
    const intervalStdDev = intervals.length > 1
      ? Math.sqrt(intervals.reduce((s, v) => s + (v - avgInterval) ** 2, 0) / intervals.length)
      : avgInterval
    const intervalCV = avgInterval > 0 ? intervalStdDev / avgInterval : 999
    const cadenceRegular = intervals.length >= 2 && intervalCV < 0.5
    const isRecurring = taggedRecurring || cadenceRegular || familyRecurring

    const lastDate = payments[payments.length - 1].date
    const cadence = detectCadence(avgInterval)

    let nextDate: string | null = null
    if (avgInterval > 0 && (isRecurring || payments.length >= 3)) {
      nextDate = addDays(lastDate, avgInterval)
      const now = new Date().toISOString().slice(0, 10)
      if (nextDate < now) nextDate = addDays(now, Math.max(1, avgInterval * 0.5))
    }

    // Vendor confidence: cadence regularity + family knowledge + payment count
    let confidence: "high" | "medium" | "low" = "low"
    if (payments.length >= 5 && isRecurring) confidence = "high"
    else if (payments.length >= 4 && cadenceRegular) confidence = "high"
    else if (payments.length >= 3 && familyRecurring) confidence = "high"
    else if (payments.length >= 3 && isRecurring) confidence = "medium"
    else if (payments.length >= 3) confidence = "medium"
    else if (payments.length >= 2 && (taggedRecurring || familyRecurring)) confidence = "medium"

    // Collect bill_ids from tag_data for this vendor's movements (T9: direct linkage)
    const linkedBillIds = new Set<string>()
    for (const m of movements) {
      const ec = m.tag.economic_class
      if (ec !== "vendor_payment" && ec !== "payroll" && ec !== "processor_fee" && ec !== "debt_payment") continue
      if (resolveEntityId(m) !== entityId) continue
      if (m.tag.bill_id) linkedBillIds.add(m.tag.bill_id)
    }

    // Match outstanding bills: tag-linked, entity_id, or name match
    const normName = data.name.toLowerCase().replace(/[^a-z0-9]/g, "")
    const vendorBills = bills.filter((b) => {
      if (linkedBillIds.has(b.bill_id)) return true
      if (b.entity_id && b.entity_id === entityId) return true
      const bName = b.vendor_name.toLowerCase().replace(/[^a-z0-9]/g, "")
      return bName.length >= 3 && (normName.includes(bName) || bName.includes(normName))
    })

    // Bill boost: if vendor has outstanding bills, override next_expected_date with due date
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

    models.push({
      entity_id: entityId,
      name: data.name,
      avg_amount: r2(avgAmount),
      cadence,
      cadence_interval_days: Math.round(avgInterval),
      is_recurring: isRecurring,
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
// Measures the gap between processor payouts (settlement bucket) by
// grouping them per processor entity and computing the interval between
// consecutive payouts. This is a reliable proxy for settlement cadence
// without needing to link individual sales to specific payouts.

function buildSettlementModel(movements: TaggedMovement[]): SettlementModel {
  // Group settlement events by processor entity
  const byProcessor = new Map<string, number[]>()

  for (const m of movements) {
    const t = m.tag
    if (t.state_inclusion_policy === "exclude_and_review") continue
    if (t.cashflow_bucket !== "settlement" || !isInflow(m)) continue
    const d = m.occurred_at
    if (!d) continue
    const ts = new Date(d).getTime()
    if (isNaN(ts)) continue

    const processor = resolveEntityId(m)
    let dates = byProcessor.get(processor)
    if (!dates) { dates = []; byProcessor.set(processor, dates) }
    dates.push(ts)
  }

  // Compute inter-payout intervals per processor, then aggregate
  const allIntervals: number[] = []

  for (const [, dates] of byProcessor) {
    dates.sort((a, b) => a - b)
    for (let i = 1; i < dates.length; i++) {
      const gap = Math.round((dates[i] - dates[i - 1]) / 86_400_000)
      if (gap >= 1 && gap <= 90) allIntervals.push(gap)
    }
  }

  const n = allIntervals.length
  const avg = n > 0 ? allIntervals.reduce((a, b) => a + b, 0) / n : 0
  const delayStd = std(allIntervals)
  const confidence: SettlementModel["confidence"] =
    n >= 20 ? "high" : n >= 10 ? "medium" : n >= 3 ? "low" : "insufficient"

  return { avg_delay_days: r2(avg), delay_std: r2(delayStd), sample_count: n, confidence }
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

function buildBehavioralModels(movements: TaggedMovement[], invoices: OutstandingInvoice[] = [], bills: OutstandingBill[] = []): BehavioralModels {
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

  // Generate all occurrences of a repeating entity within the 30d window
  function generateRepeating(
    lastDate: string,
    intervalDays: number,
    maxOccurrences: number,
    emitFn: (date: string, offset: number) => void,
  ) {
    if (intervalDays <= 0) return
    let nextDate = addDays(lastDate, intervalDays)
    if (nextDate < today) nextDate = addDays(today, Math.max(1, Math.round(intervalDays * 0.3)))
    let count = 0
    while (nextDate <= horizon && count < maxOccurrences) {
      const offset = daysBetween(today, nextDate)
      if (offset >= 0) emitFn(nextDate, offset)
      nextDate = addDays(nextDate, intervalDays)
      count++
    }
  }

  // Customer payment events — prefer invoice-driven events when available
  for (const c of models.customers) {
    if (c.probability_of_next < 0.15) continue

    const openInvs = c.outstanding_invoices.filter((i) => i.amount_due > 0)

    if (openInvs.length > 0) {
      // Generate events from actual outstanding invoices (high precision)
      for (const inv of openInvs) {
        const dueDate = inv.due_date ?? c.next_expected_date ?? addDays(today, 14)
        let eventDate = dueDate < today ? addDays(today, 2) : dueDate
        if (eventDate > horizon) continue
        const offset = daysBetween(today, eventDate)
        if (offset < 0) continue
        const prob = inv.status === "overdue"
          ? Math.min(0.95, c.probability_of_next + 0.1)
          : c.probability_of_next
        events.push({
          date: eventDate, day_offset: offset, type: "customer_payment",
          entity: c.name, amount: r2(inv.amount_due),
          direction: "in", probability: r2(prob),
          confidence: c.confidence === "low" ? "medium" : c.confidence,
          source_model: "customer",
        })
      }
    } else {
      // Fall back to behavioral model
      generateRepeating(c.last_payment_date, c.payment_interval_days, 5, (date, offset) => {
        events.push({
          date, day_offset: offset, type: "customer_payment",
          entity: c.name, amount: r2(c.avg_amount),
          direction: "in", probability: c.probability_of_next,
          confidence: c.confidence, source_model: "customer",
        })
      })
    }
  }

  // Vendor payment events
  const vendorBillEntities = new Set<string>()
  for (const v of models.vendors) {
    // Bill-driven events: use actual due dates and amounts from AP bills
    if (v.outstanding_bills.length > 0) {
      vendorBillEntities.add(v.entity_id)
      for (const bill of v.outstanding_bills) {
        if (!bill.due_date) continue
        const offset = daysBetween(today, bill.due_date)
        if (offset < 0 || offset > 30) continue
        events.push({
          date: bill.due_date, day_offset: offset, type: "vendor_payment",
          entity: v.name, amount: r2(bill.amount_due),
          direction: "out", probability: bill.status === "overdue" ? 0.95 : 0.9,
          confidence: "high", source_model: "vendor",
        })
      }
      continue
    }
    if (!v.is_recurring && v.payment_count < 3) continue
    const prob = v.is_recurring ? 0.9 : 0.6
    generateRepeating(v.last_payment_date, v.cadence_interval_days, 5, (date, offset) => {
      events.push({
        date, day_offset: offset, type: "vendor_payment",
        entity: v.name, amount: r2(v.avg_amount),
        direction: "out", probability: prob,
        confidence: v.confidence, source_model: "vendor",
      })
    })
  }

  // Recurring fixed obligation events (monthly) — skip if already covered by vendor model
  const vendorNames = new Set(models.vendors.map((v) => v.name.toLowerCase()))
  for (const rf of models.recurring_fixed) {
    if (vendorNames.has(rf.label.toLowerCase())) continue
    generateRepeating(rf.last_date, 30, 2, (date, offset) => {
      events.push({
        date, day_offset: offset, type: "recurring_expense",
        entity: rf.label, amount: r2(rf.monthly_amount),
        direction: "out", probability: 0.95,
        confidence: "high", source_model: "recurring",
      })
    })
  }

  // Settlement events: if settlement model has data, generate expected settlement arrivals
  if (models.settlement.confidence !== "insufficient" && models.settlement.sample_count >= 3) {
    const settlementComp = components.find((c) => c.category === "processor_payouts" && c.direction === "in")
    if (settlementComp && settlementComp.monthly_avg > 0) {
      const weeklyAmount = settlementComp.monthly_avg / 4
      for (let week = 0; week < 4; week++) {
        const offset = Math.round(7 * week + models.settlement.avg_delay_days + 1)
        if (offset > 30) break
        const date = addDays(today, offset)
        events.push({
          date, day_offset: offset, type: "settlement",
          entity: "Processor settlement", amount: r2(weeklyAmount),
          direction: "in", probability: 0.8,
          confidence: models.settlement.confidence === "high" ? "high" : "medium",
          source_model: "settlement",
        })
      }
    }
  }

  // Transfer events: conditional based on trigger pattern
  if (models.transfers.transfer_count >= 3 && models.transfers.trigger_pattern !== "unknown") {
    const transferEntity = models.transfers.primary_account ?? "Internal transfer"
    if (models.transfers.trigger_pattern === "periodic" && models.transfers.avg_interval_days) {
      generateRepeating(
        addDays(today, -models.transfers.avg_interval_days),
        models.transfers.avg_interval_days,
        3,
        (date, offset) => {
          events.push({
            date, day_offset: offset, type: "transfer",
            entity: transferEntity,
            amount: r2(models.transfers.avg_transfer_amount),
            direction: "in", probability: 0.7,
            confidence: models.transfers.confidence as "high" | "medium" | "low",
            source_model: "transfer",
          })
        },
      )
    } else if (models.transfers.trigger_pattern === "low_balance") {
      // Reactive transfers: place after large outflow clusters in the forecast
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
          entity: transferEntity,
          amount: r2(models.transfers.avg_transfer_amount),
          direction: "in", probability: 0.6,
          confidence: "medium", source_model: "transfer",
        })
        transfersPlaced++
      }
    } else if (models.transfers.trigger_pattern === "irregular") {
      const offset = 15
      events.push({
        date: addDays(today, offset), day_offset: offset, type: "transfer",
        entity: transferEntity,
        amount: r2(models.transfers.avg_transfer_amount),
        direction: "in", probability: 0.4,
        confidence: "low", source_model: "transfer",
      })
    }
  }

  return events.sort((a, b) => a.day_offset - b.day_offset || b.amount - a.amount)
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
): { inflows: number; outflows: number; componentAmounts: { component_id: string; amount: number }[] } {
  let inflows = 0
  let outflows = 0
  const componentAmounts: { component_id: string; amount: number }[] = []

  // Customer receipts: simulate from entity models
  let customerTotal = 0
  for (const c of models.customers) {
    if (!c.next_expected_date) continue
    if (c.next_expected_date >= monthStart && c.next_expected_date < monthEnd) {
      customerTotal += c.avg_amount * c.probability_of_next
    } else if (c.payment_interval_days > 0 && c.payment_interval_days <= 31) {
      // High-frequency: might pay multiple times in the month
      const paymentsInMonth = 30 / c.payment_interval_days
      customerTotal += c.avg_amount * c.probability_of_next * paymentsInMonth
    }
  }
  if (customerTotal > 0) {
    customerTotal *= scenarioMult.inflow
    inflows += customerTotal
    componentAmounts.push({ component_id: "customer_receipts_in", amount: r2(customerTotal) })
  }

  // Vendor payments: simulate from entity models
  let vendorTotal = 0
  for (const v of models.vendors) {
    if (!v.next_expected_date) {
      if (v.is_recurring && v.cadence_interval_days > 0 && v.cadence_interval_days <= 45) {
        vendorTotal += v.avg_amount * (30 / v.cadence_interval_days)
      }
      continue
    }
    if (v.next_expected_date >= monthStart && v.next_expected_date < monthEnd) {
      vendorTotal += v.avg_amount
    } else if (v.is_recurring && v.cadence_interval_days > 0 && v.cadence_interval_days <= 31) {
      vendorTotal += v.avg_amount * (30 / v.cadence_interval_days)
    }
  }
  if (vendorTotal > 0) {
    vendorTotal *= scenarioMult.outflow
    outflows += vendorTotal
    componentAmounts.push({ component_id: "vendor_payments_out", amount: r2(vendorTotal) })
  }

  // Recurring fixed obligations
  let recurringTotal = 0
  for (const rf of models.recurring_fixed) {
    recurringTotal += rf.monthly_amount
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
    if (comp.behavior === "episodic") amount *= 0.7

    // Apply seasonal adjustment if this component has a seasonal index
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

    // Apply trend decay per month: further out months converge toward mean
    const trendFactor = 1 + (config.trend_dampening * (1 / (1 + i * 0.3)))

    const { inflows, outflows, componentAmounts } = simulateMonthFromModels(
      models, components, monthStart, monthEnd,
      { inflow: config.inflow_amount_mult * trendFactor, outflow: config.outflow_amount_mult },
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
): ForecastConfidence {
  const reasons: string[] = []

  // Model coverage: what % of cashflow categories have at least a medium-confidence model?
  const totalCategories = components.length
  const coveredCategories = components.filter((c) => c.confidence !== "low").length
  const modelCoverage = totalCategories > 0 ? coveredCategories / totalCategories : 0

  // Data completeness: how many months of history, entity coverage
  const monthsOfData = Math.max(1, dataSpanDays / 30)
  const dataCompleteness = Math.min(1, monthsOfData / 6)
  if (monthsOfData < 3) reasons.push("Less than 3 months of transaction history")
  if (monthsOfData < 1) reasons.push("Less than 1 month of data — forecast is speculative")

  // Variance penalty: high-volatility components reduce confidence
  const avgVolatility = components.length > 0
    ? components.reduce((s, c) => s + c.volatility, 0) / components.length
    : 0
  const variancePenalty = Math.min(0.4, avgVolatility * 0.3)
  if (avgVolatility > 0.8) reasons.push("High volatility in cashflow components")

  // Customer model quality
  const highConfCustomers = models.customers.filter((c) => c.confidence === "high").length
  const customerCoverage = models.customers.length > 0 ? highConfCustomers / models.customers.length : 0
  if (customerCoverage < 0.3) reasons.push("Most customer payment models are low confidence")

  // Event density
  if (events.length < 5) reasons.push("Very few predicted events in next 30 days")

  const rawScore = (modelCoverage * 0.3 + dataCompleteness * 0.35 + customerCoverage * 0.15 + 0.2) - variancePenalty
  const score = Math.max(0.05, Math.min(0.99, rawScore))

  const label: ForecastConfidence["label"] = score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low"
  if (reasons.length === 0) reasons.push("Forecast is based on sufficient data and stable models")

  // Per-component confidence
  const by_component: ComponentConfidence[] = []

  // Customer forecast confidence
  const custHigh = models.customers.filter((c) => c.confidence === "high").length
  const custMed = models.customers.filter((c) => c.confidence === "medium").length
  const custTotal = models.customers.length
  const custScore = custTotal > 0 ? (custHigh * 1 + custMed * 0.6) / custTotal : 0
  const custLabel: ComponentConfidence["label"] = custScore >= 0.7 ? "high" : custScore >= 0.4 ? "medium" : "low"
  by_component.push({
    area: "Customer forecasts",
    score: r2(custScore),
    label: custLabel,
    reason: custTotal === 0 ? "No customer models" : `${custHigh} high / ${custMed} medium / ${custTotal - custHigh - custMed} low confidence models`,
  })

  // Vendor forecast confidence — weighted by spend impact (top vendors matter more)
  const vendHigh = models.vendors.filter((v) => v.confidence === "high").length
  const vendMed = models.vendors.filter((v) => v.confidence === "medium").length
  const vendTotal = models.vendors.length
  const totalVendorSpend = models.vendors.reduce((s, v) => s + v.avg_amount * v.payment_count, 0)
  let vendScore: number
  if (vendTotal === 0) {
    vendScore = 0
  } else if (totalVendorSpend > 0) {
    // Spend-weighted confidence: high-spend vendors with high confidence matter more
    let weightedConf = 0
    for (const v of models.vendors) {
      const weight = (v.avg_amount * v.payment_count) / totalVendorSpend
      const conf = v.confidence === "high" ? 1 : v.confidence === "medium" ? 0.6 : 0.2
      weightedConf += weight * conf
    }
    vendScore = weightedConf
  } else {
    vendScore = (vendHigh * 1 + vendMed * 0.6) / vendTotal
  }
  const vendLabel: ComponentConfidence["label"] = vendScore >= 0.7 ? "high" : vendScore >= 0.4 ? "medium" : "low"
  const vendLow = vendTotal - vendHigh - vendMed
  by_component.push({
    area: "Vendor forecasts",
    score: r2(vendScore),
    label: vendLabel,
    reason: vendTotal === 0
      ? "No vendor models"
      : `${vendHigh} high / ${vendMed} medium / ${vendLow} low confidence — spend-weighted`,
  })

  // Settlement confidence
  const settConf = models.settlement.confidence
  const settScore = settConf === "high" ? 0.9 : settConf === "medium" ? 0.65 : settConf === "low" ? 0.35 : 0.1
  by_component.push({
    area: "Settlement timing",
    score: r2(settScore),
    label: settConf === "high" ? "high" : settConf === "medium" ? "medium" : "low",
    reason: models.settlement.sample_count === 0
      ? "No settlement data — processor payouts not modeled"
      : `${models.settlement.sample_count} samples, avg ${models.settlement.avg_delay_days.toFixed(1)}d cadence`,
  })

  // Intervention confidence (derived from model coverage)
  const intervScore = Math.min(1, (custScore * 0.5 + vendScore * 0.3 + dataCompleteness * 0.2))
  const intervLabel: ComponentConfidence["label"] = intervScore >= 0.6 ? "high" : intervScore >= 0.35 ? "medium" : "low"
  by_component.push({
    area: "Intervention estimates",
    score: r2(intervScore),
    label: intervLabel,
    reason: intervScore < 0.35 ? "Weak underlying models reduce intervention accuracy" : "Based on entity-level behavioral models",
  })

  return {
    score: r2(score),
    label,
    model_coverage: r2(modelCoverage),
    data_completeness: r2(dataCompleteness),
    variance_penalty: r2(variancePenalty),
    reasons,
    by_component,
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
): Intervention[] {
  const interventions: Intervention[] = []
  const baseCash14 = mc.day_scenarios.find((s) => s.scenario === "base")?.cash_14d ?? mc.expected_cash_30d
  const baseCash30 = mc.expected_cash_30d
  const baseRisk30 = mc.prob_below_zero_30d

  // Accelerate top customer collections (3 days earlier)
  for (const c of models.customers.slice(0, 3)) {
    if (c.probability_of_next < 0.3) continue
    const expectedCash = c.avg_amount * c.probability_of_next
    if (expectedCash < 100) continue
    const impact14 = r2(expectedCash * 0.7)
    const impact30 = r2(expectedCash * 0.5)
    const riskReduction = baseRisk30 > 0 ? r2(Math.min(50, (expectedCash / Math.max(1, startingCash)) * 100)) : 0

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
    })
  }

  // Reduce overall spend by 10%
  const totalOutflowEvents = events.filter((e) => e.direction === "out")
  const totalOutflow30 = totalOutflowEvents.reduce((s, e) => s + e.amount * e.probability, 0)
  if (totalOutflow30 > 0) {
    const savings = r2(totalOutflow30 * 0.1)
    interventions.push({
      id: "reduce_spend_10",
      label: "Reduce overall spend by 10%",
      type: "reduce_spend",
      entity: null,
      parameter_days: null,
      parameter_pct: 10,
      impact_cash_14d: r2(savings * 0.5),
      impact_cash_30d: savings,
      impact_risk_reduction: baseRisk30 > 0 ? r2(Math.min(40, (savings / Math.max(1, startingCash)) * 100)) : 0,
      description: `A 10% spend reduction saves ~$${Math.round(savings).toLocaleString()} over 30 days`,
    })
  }

  // Sort by impact
  interventions.sort((a, b) => b.impact_cash_14d - a.impact_cash_14d)
  return interventions.slice(0, 6)
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

function runBacktest(movements: TaggedMovement[], invoices: OutstandingInvoice[], bills: OutstandingBill[]): BacktestResult | null {
  const testDays = 14
  const allDates = movements.map((m) => toDateStr(m.occurred_at)).filter(Boolean).sort()
  if (allDates.length < 30) return null

  const lastDate = allDates[allDates.length - 1]
  const cutoffDate = addDays(lastDate, -testDays)

  // Split: training set (before cutoff) and test set (after cutoff)
  const training = movements.filter((m) => toDateStr(m.occurred_at) <= cutoffDate)
  const testSet = movements.filter((m) => toDateStr(m.occurred_at) > cutoffDate)

  if (training.length < 20 || testSet.length < 5) return null

  // Build behavioral models from training data only
  const models = buildBehavioralModels(training, invoices, bills)

  // Compute starting cash at cutoff
  let startCash = 0
  for (const m of training) {
    startCash += isInflow(m) ? m.amount : -m.amount
  }

  // Generate forecast from cutoff point
  const buckets = decomposeMovements(training)
  const dataSpan = daysBetween(allDates[0], cutoffDate)
  const components = buckets.map((b) => buildComponent(b, dataSpan))
  const events = generateEvents30d(models, components)

  // Simulate predicted daily cash
  const predictedDailyNet = new Array<number>(testDays + 1).fill(0)
  for (const e of events) {
    if (e.day_offset < 1 || e.day_offset > testDays) continue
    const ev = e.amount * e.probability
    predictedDailyNet[e.day_offset] += e.direction === "in" ? ev : -ev
  }

  // Compute actual daily net from test set
  const actualDailyNet = new Array<number>(testDays + 1).fill(0)
  for (const m of testSet) {
    const d = toDateStr(m.occurred_at)
    const offset = daysBetween(cutoffDate, d)
    if (offset >= 1 && offset <= testDays) {
      actualDailyNet[offset] += isInflow(m) ? m.amount : -m.amount
    }
  }

  // Compute accuracy metrics
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

  // Total predicted vs actual for the period
  const totalPredicted = predictedDailyNet.reduce((s, v) => s + v, 0)
  const totalActual = actualDailyNet.reduce((s, v) => s + v, 0)
  const totalScale = Math.max(Math.abs(totalActual), 1)
  const relativeError = Math.abs(totalPredicted - totalActual) / totalScale

  // Accuracy score: 0-100, combining direction accuracy and relative error
  const score = Math.round(
    Math.max(0, Math.min(100,
      (directionAccuracy * 60) + ((1 - Math.min(1, relativeError)) * 40)
    ))
  )

  let details: string
  if (score >= 75) details = `Strong backtest: ${activeDays}d tested, ${Math.round(directionAccuracy * 100)}% direction accuracy, MAE $${Math.round(mae)}`
  else if (score >= 50) details = `Moderate backtest: ${activeDays}d tested, ${Math.round(directionAccuracy * 100)}% direction accuracy, MAE $${Math.round(mae)}`
  else details = `Weak backtest: ${activeDays}d tested, ${Math.round(directionAccuracy * 100)}% direction accuracy, MAE $${Math.round(mae)} — forecast may be unreliable`

  return {
    accuracy_score: score,
    days_tested: activeDays,
    mean_absolute_error: r2(mae),
    direction_accuracy: r2(directionAccuracy),
    details,
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

  // Forecast confidence
  const forecast_confidence = computeForecastConfidence(behavioral_models, components, events_30d, dataSpanDays)

  // Cash runway
  const cash_runway = computeCashRunway(scenarios, startingCash, dataSpanDays)

  // Sensitivity analysis
  const sensitivity = computeSensitivity(events_30d, behavioral_models, monte_carlo, startingCash)

  // Intervention engine
  const interventions = computeInterventions(events_30d, behavioral_models, monte_carlo, startingCash)

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
    concentration_risk_score: 0, dependency_risk_score: 0, liquidity_risk_score: 0,
    top_customer_pct: 0, repeat_revenue_ratio: 0,
    operating_dependency_ratio: 1, transfer_dependency_ratio: 0,
    recurring_spend_ratio: 0, liquidity_regime: "stable",
    transitions: [], balance_source: "derived", account_balances: [],
  }

  // Backtest: replay last 14 days to measure forecast accuracy
  const backtest = runBacktest(movements, invoices, bills)

  return {
    period_start: periodStart,
    forecast_horizon_months: horizonMonths,
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
    context,
    backtest,
  }
}
