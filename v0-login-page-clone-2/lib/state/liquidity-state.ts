// ─── Liquidity State Engine ──────────────────────────────────────────
//
// Reads: all included cash movements, internal transfers, owner contributions,
//        credit card payments, unresolved items, account balances if available.
// Computes: available cash, per-account, unrestricted vs reserved,
//           operating buffer, transfer dependency, owner funding dependency,
//           short-term runway, minimum safe cash threshold.

import type { TaggedMovementInput } from "./types"
import type { AccountBalanceInput } from "./types"
import { filterIncluded } from "./types"

export type LiquidityState = {
  available_cash: number
  by_account: Array<{ account_id: string; balance: number }>
  unrestricted_cash: number
  reserved_cash: number

  operating_buffer_days: number
  transfer_dependency_ratio: number
  owner_dependency_ratio: number
  safe_cash_floor: number

  unresolved_cash_impact: number
  state_confidence: number
}

function netAmount(m: TaggedMovementInput): number {
  return m.direction === "inflow" ? m.amount : -m.amount
}

function normalizer(items: TaggedMovementInput[]): { included: TaggedMovementInput[]; excluded: TaggedMovementInput[] } {
  return filterIncluded(items)
}

function computeNetFlowByAccount(
  included: TaggedMovementInput[],
  days: number,
  now: Date,
): Map<string, number> {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - days)
  const byAccount = new Map<string, number>()
  for (const m of included) {
    const d = new Date(m.occurred_at)
    if (d < cutoff) continue
    const acc = m.account_id ?? "unknown"
    byAccount.set(acc, (byAccount.get(acc) ?? 0) + netAmount(m))
  }
  return byAccount
}

function computeOwnerInflows(included: TaggedMovementInput[], days: number, now: Date): number {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - days)
  let sum = 0
  for (const m of included) {
    if (m.tag.economic_class !== "owner_contribution") continue
    const d = new Date(m.occurred_at)
    if (d >= cutoff && m.direction === "inflow") sum += m.amount
  }
  return sum
}

function computeTransferInflows(included: TaggedMovementInput[], days: number, now: Date): number {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - days)
  let sum = 0
  for (const m of included) {
    if (m.tag.economic_class !== "transfer" || m.tag.cashflow_bucket !== "transfer") continue
    const d = new Date(m.occurred_at)
    if (d >= cutoff && m.direction === "inflow") sum += m.amount
  }
  return sum
}

function computeTotalInflows(included: TaggedMovementInput[], days: number, now: Date): number {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - days)
  let sum = 0
  for (const m of included) {
    const d = new Date(m.occurred_at)
    if (d >= cutoff && m.direction === "inflow") sum += m.amount
  }
  return sum
}

function computeTotalOutflows(included: TaggedMovementInput[], days: number, now: Date): number {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - days)
  let sum = 0
  for (const m of included) {
    const d = new Date(m.occurred_at)
    if (d >= cutoff && m.direction === "outflow") sum += m.amount
  }
  return sum
}

export function computeLiquidityState(
  items: TaggedMovementInput[],
  options?: { asOf?: Date; accountBalances?: AccountBalanceInput[] },
): LiquidityState {
  const now = options?.asOf ?? new Date()
  const balances = options?.accountBalances ?? []
  const { included, excluded } = normalizer(items)

  let availableCash = 0
  const byAccount: Array<{ account_id: string; balance: number }> = []

  if (balances.length > 0) {
    for (const a of balances) {
      const bal = a.available_balance ?? a.current_balance ?? 0
      const num = typeof bal === "string" ? parseFloat(bal) : Number(bal)
      if (!Number.isNaN(num)) {
        availableCash += num
        byAccount.push({ account_id: a.account_id, balance: num })
      }
    }
  }

  const unrestrictedCash = availableCash
  const reservedCash = 0

  const outflows30 = computeTotalOutflows(included, 30, now)
  const inflows30 = computeTotalInflows(included, 30, now)
  const ownerIn30 = computeOwnerInflows(included, 30, now)
  const transferIn30 = computeTransferInflows(included, 30, now)

  const dailyBurn = outflows30 > 0 ? outflows30 / 30 : 0
  const operatingBufferDays = dailyBurn > 0 ? Math.floor(availableCash / dailyBurn) : 999

  const transferDependencyRatio = inflows30 > 0 ? transferIn30 / inflows30 : 0
  const ownerDependencyRatio = inflows30 > 0 ? ownerIn30 / inflows30 : 0

  const monthlyBurn = outflows30
  const safeCashFloor = monthlyBurn * 1.5

  const excludedNet = excluded.reduce((s, m) => s + netAmount(m), 0)
  const totalNet = included.reduce((s, m) => s + netAmount(m), 0) + excludedNet
  const unresolvedCashImpact = totalNet !== 0 ? excludedNet / Math.abs(totalNet) : 0

  const stateConfidence =
    included.length > 0
      ? included.reduce((s, m) => s + (m.tag.classification_confidence ?? 0.5), 0) / included.length
      : 0.5

  return {
    available_cash: Math.round(availableCash * 100) / 100,
    by_account: byAccount.map((a) => ({ ...a, balance: Math.round(a.balance * 100) / 100 })),
    unrestricted_cash: Math.round(unrestrictedCash * 100) / 100,
    reserved_cash: Math.round(reservedCash * 100) / 100,
    operating_buffer_days: operatingBufferDays,
    transfer_dependency_ratio: Math.round(transferDependencyRatio * 1000) / 1000,
    owner_dependency_ratio: Math.round(ownerDependencyRatio * 1000) / 1000,
    safe_cash_floor: Math.round(safeCashFloor * 100) / 100,
    unresolved_cash_impact: Math.round(unresolvedCashImpact * 1000) / 1000,
    state_confidence: Math.round(stateConfidence * 1000) / 1000,
  }
}
