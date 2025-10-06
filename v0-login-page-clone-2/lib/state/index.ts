// ─── State Engines ───────────────────────────────────────────────────
//
// Revenue, spend, and liquidity state computed from tagged movements.
// Every insight can point to a state object.

export { computeRevenueState } from "./revenue-state"
export type { RevenueState } from "./revenue-state"

export { computeSpendState } from "./spend-state"
export type { SpendState } from "./spend-state"

export { computeLiquidityState } from "./liquidity-state"
export type { LiquidityState } from "./liquidity-state"

export type { TaggedMovementInput, AccountBalanceInput } from "./types"
export { filterIncluded } from "./types"
