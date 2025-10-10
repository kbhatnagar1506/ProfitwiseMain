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
  CustomerModel,
  VendorModel,
  SettlementModel,
  TransferBehaviorModel,
  BehavioralModels,
  OutstandingInvoice,
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
} from "./types"

type TaggedMovement = CanonicalMovement & { tag: MovementTag }
type ComponentCategory = CashflowComponent["category"]

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

// ─── Step 1: Decompose (same as v1) ────────────────────────────────

function categorize(m: TaggedMovement): { category: ComponentCategory; direction: "in" | "out"; label: string } | null {
  const t = m.tag
  if (t.state_inclusion_policy === "exclude_and_review") return null
  const dir = m.direction === "in" ? "in" as const : "out" as const

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
  const byEntity = new Map<string, { name: string; payments: { amount: number; date: string }[] }>()

  for (const m of movements) {
    if (m.tag.economic_class !== "customer_receipt") continue
    if (m.tag.state_inclusion_policy === "exclude_and_review") continue

    const key = m.entity_id ?? m.raw_description ?? "unknown"
    const name = (m.metadata?.counterparty as string) ?? key
    let entry = byEntity.get(key)
    if (!entry) { entry = { name, payments: [] }; byEntity.set(key, entry) }
    entry.payments.push({ amount: m.amount, date: m.occurred_at })
  }

  const models: CustomerModel[] = []
  const now = new Date().toISOString().slice(0, 10)

  for (const [entityId, data] of byEntity) {
    const payments = data.payments.sort((a, b) => a.date.localeCompare(b.date))
    if (payments.length === 0) continue

    const amounts = payments.map((p) => p.amount)
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length

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
      const firstHalfAvg = amounts.slice(0, mid).reduce((a, b) => a + b, 0) / mid
      const secondHalfAvg = amounts.slice(mid).reduce((a, b) => a + b, 0) / (amounts.length - mid)
      if (firstHalfAvg > 0) {
        const amountTrend = secondHalfAvg / firstHalfAvg
        if (amountTrend < 0.5) probability *= 0.6
        else if (amountTrend < 0.8) probability *= 0.85
      }
    }

    probability = Math.max(0.02, Math.min(0.98, probability))

    let nextDate: string | null = null
    if (avgInterval > 0 && probability > 0.1) {
      nextDate = addDays(lastDate, avgInterval)
      if (nextDate < now) nextDate = addDays(now, Math.max(1, avgInterval * 0.3))
    }

    let confidence: "high" | "medium" | "low" = "low"
    if (payments.length >= 5 && intervalVariance < avgInterval * 0.5) confidence = "high"
    else if (payments.length >= 3) confidence = "medium"

    // Match outstanding invoices to this customer by entity_id or name
    const normName = data.name.toLowerCase().replace(/[^a-z0-9]/g, "")
    const customerInvoices = invoices.filter((inv) => {
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

function buildVendorModels(movements: TaggedMovement[]): VendorModel[] {
  const byEntity = new Map<string, { name: string; payments: { amount: number; date: string; recurring: boolean }[] }>()

  for (const m of movements) {
    const ec = m.tag.economic_class
    if (ec !== "vendor_payment" && ec !== "payroll" && ec !== "processor_fee" && ec !== "debt_payment") continue
    if (m.tag.state_inclusion_policy === "exclude_and_review") continue

    const key = m.entity_id ?? m.raw_description ?? "unknown"
    const name = (m.metadata?.counterparty as string) ?? key
    let entry = byEntity.get(key)
    if (!entry) { entry = { name, payments: [] }; byEntity.set(key, entry) }
    entry.payments.push({ amount: m.amount, date: m.occurred_at, recurring: m.tag.is_recurring ?? false })
  }

  const models: VendorModel[] = []

  for (const [entityId, data] of byEntity) {
    const payments = data.payments.sort((a, b) => a.date.localeCompare(b.date))
    if (payments.length === 0) continue

    const amounts = payments.map((p) => p.amount)
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length
    const isRecurring = payments.filter((p) => p.recurring).length > payments.length * 0.5

    const intervals: number[] = []
    for (let i = 1; i < payments.length; i++) {
      intervals.push(daysBetween(payments[i - 1].date, payments[i].date))
    }

    const avgInterval = intervals.length > 0
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length
      : 0

    const lastDate = payments[payments.length - 1].date
    const cadence = detectCadence(avgInterval)

    let nextDate: string | null = null
    if (avgInterval > 0 && (isRecurring || payments.length >= 3)) {
      nextDate = addDays(lastDate, avgInterval)
      const now = new Date().toISOString().slice(0, 10)
      if (nextDate < now) nextDate = addDays(now, Math.max(1, avgInterval * 0.5))
    }

    let confidence: "high" | "medium" | "low" = "low"
    if (payments.length >= 5 && isRecurring) confidence = "high"
    else if (payments.length >= 3) confidence = "medium"

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
    if (t.cashflow_bucket !== "settlement" || m.direction !== "in") continue
    const d = m.occurred_at
    if (!d) continue
    const ts = new Date(d).getTime()
    if (isNaN(ts)) continue

    const processor = m.entity_id ?? t.processor_id ?? "default"
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
    transfers.push({ amount: m.amount, date: m.occurred_at, account: m.account_id ?? null })
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
  // If cv >= 0.7 or too few intervals, stays "unknown" — we don't guess "low_balance"

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
    if (m.direction !== "out") continue
    if (m.tag.state_inclusion_policy === "exclude_and_review") continue

    const label = (m.metadata?.counterparty as string) ?? m.raw_description ?? "unknown"
    let g = groups.get(label)
    if (!g) { g = { amounts: [], dates: [] }; groups.set(label, g) }
    g.amounts.push(m.amount)
    g.dates.push(m.occurred_at)
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

function buildBehavioralModels(movements: TaggedMovement[], invoices: OutstandingInvoice[] = []): BehavioralModels {
  const customers = buildCustomerModels(movements, invoices)
  return {
    customers,
    vendors: buildVendorModels(movements),
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
  for (const v of models.vendors) {
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

  // Recurring fixed obligation events (monthly)
  for (const rf of models.recurring_fixed) {
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
    if (models.transfers.trigger_pattern === "periodic" && models.transfers.avg_interval_days) {
      generateRepeating(
        addDays(today, -models.transfers.avg_interval_days),
        models.transfers.avg_interval_days,
        3,
        (date, offset) => {
          events.push({
            date, day_offset: offset, type: "transfer",
            entity: models.transfers.primary_account ?? "Internal transfer",
            amount: r2(models.transfers.avg_transfer_amount),
            direction: "in", probability: 0.7,
            confidence: models.transfers.confidence as "high" | "medium" | "low",
            source_model: "transfer",
          })
        },
      )
    } else if (models.transfers.trigger_pattern === "irregular") {
      // Irregular transfers: approximate as mid-month event with low confidence
      const offset = 15
      events.push({
        date: addDays(today, offset), day_offset: offset, type: "transfer",
        entity: models.transfers.primary_account ?? "Internal transfer",
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
      amount: m.amount, date: m.occurred_at,
      entity: m.entity_id ?? m.raw_description ?? "unknown",
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

  return {
    id: `${bucket.category}_${bucket.direction}`,
    label: bucket.label, direction: bucket.direction, category: bucket.category,
    behavior, monthly_avg: r2(monthlyAvg), monthly_count: Math.round(monthlyCount * 10) / 10,
    trend: Math.round(trend * 1000) / 1000, volatility: Math.round(volatility * 1000) / 1000, confidence,
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
// Uses the p50 (median) from Monte Carlo for the deterministic view.
// Events with probability >= 0.7 are included at full amount (likely to happen).
// Events with probability < 0.7 are excluded (uncertain — Monte Carlo handles them).
// This avoids the misleading "partial payment" effect of expected-value math.

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
      if (e.probability < 0.7) continue
      const amount = r2(e.amount)
      if (e.direction === "in") dayInflows += amount
      else dayOutflows += amount
      eventSummaries.push({ entity: e.entity, amount, direction: e.direction })
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

const SCENARIOS: ScenarioConfig[] = [
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
    scenario: "pessimistic", label: "Pessimistic — delayed collections, cost pressure",
    customer_prob_mult: 0.75, inflow_amount_mult: 0.88,
    outflow_amount_mult: 1.12, trend_dampening: 0.5,
  },
]

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
    const recurringPct = outflowEvents.filter((e) => e.type === "recurring_expense").reduce((s, e) => s + e.amount, 0) / outflowTotal
    insight = `${Math.round(recurringPct * 100)}% of expected outflows are recurring obligations — spend base is ${recurringPct > 0.6 ? "highly fixed" : "moderately flexible"}`
  } else {
    insight = "Cash position is primarily driven by inflow timing — outflow obligations are minimal"
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

// ─── Public API ─────────────────────────────────────────────────────

export function computeCashflowForecast(
  movements: TaggedMovement[],
  startingCash: number,
  horizonMonths: number = 6,
  invoices: OutstandingInvoice[] = [],
): CashflowForecast {
  const dates = movements.map((m) => m.occurred_at).filter(Boolean).sort()
  const periodStart = dates[0] ?? new Date().toISOString()
  const periodEnd = dates[dates.length - 1] ?? new Date().toISOString()
  const dataSpanDays = daysBetween(periodStart, periodEnd)

  // Aggregate component models (for non-entity categories)
  const buckets = decomposeMovements(movements)
  const components = buckets.map((b) => buildComponent(b, dataSpanDays))

  // Entity-level behavioral models (enhanced with invoice data)
  const behavioral_models = buildBehavioralModels(movements, invoices)

  // Event generation: discrete 30-day forecast
  const events_30d = generateEvents30d(behavioral_models, components)

  // Daily cashflow simulation: cash[t+1] = cash[t] + inflows[t] - outflows[t]
  const daily_simulation = simulateDaily(events_30d, startingCash)

  // Monte Carlo: 500 simulations with payment delays, amount variance, missed payments
  const monte_carlo = runMonteCarlo(events_30d, startingCash, 500)

  // Narrative: deterministic Forecast / Risk / Insight / Action
  const narrative = generateNarrative(monte_carlo, daily_simulation, behavioral_models, events_30d, startingCash)

  // Run scenarios using behavioral simulation
  const scenarios = SCENARIOS.map((config) =>
    runScenario(behavioral_models, components, horizonMonths, startingCash, config)
  )

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
  }
}
