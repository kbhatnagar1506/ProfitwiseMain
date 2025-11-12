/**
 * Forecast Calibration Module
 *
 * Centralizes all tunable constants for the forecast engine.
 * Provides DEFAULT_FORECAST_CALIBRATION (current behavior) and
 * mergeCalibration for applying user/fitted overrides.
 */

import type { CustomerArchetype } from "./types"

// ─────────────────────────────────────────────────────────────────────────────
// Type definitions
// ─────────────────────────────────────────────────────────────────────────────

/** Archetype-specific probability and interval multipliers */
export type ArchetypeMultipliers = Record<
  CustomerArchetype,
  { probMult: number; intervalMult: number }
>

/** Archetype fallback defaults when no cohort data */
export type ArchetypeFallbacks = Record<
  CustomerArchetype,
  { prob: number; interval: number }
>

/** Confidence composite weights (must sum to 1.0) */
export interface ConfidenceWeights {
  inflow: number
  outflow: number
  settlement: number
  identity: number
  recurrence: number
  dataSpan: number
  stability: number
  backtest: number
}

/** Scenario bias multipliers */
export interface ScenarioBias {
  inflow_prob_mult: number
  outflow_prob_mult: number
  inflow_amount_mult: number
  outflow_amount_mult: number
  trend_dampening: number
}

/** Full calibration parameter set */
export interface ForecastCalibrationParams {
  // ─── Probability bounds ───
  probability_floor: number
  probability_ceiling: number

  // ─── Portfolio prior defaults (when insufficient history) ───
  portfolio_prior_base_p7: number
  portfolio_prior_base_p14: number
  portfolio_prior_base_p30: number
  portfolio_prior_avg_collection_delay: number

  // ─── Global scaling (tunable by backtest) ───
  global_event_probability_scale: number
  portfolio_prior_scale: number
  probability_temperature_override: number | null

  // ─── Archetype multipliers ───
  archetype_multipliers: ArchetypeMultipliers
  archetype_fallbacks: ArchetypeFallbacks

  // ─── Reconciliation boosts ───
  reconciliation_matched_boost_p7: number
  reconciliation_matched_boost_p14: number
  reconciliation_matched_boost_p30: number
  reconciliation_partial_boost_factor: number

  // ─── Invoice probability ladder ───
  invoice_overdue_boost: number
  invoice_dso_factor_min: number
  invoice_dso_factor_max: number
  invoice_volatile_penalty_p7: number
  invoice_volatile_penalty_p14: number
  invoice_volatile_penalty_p30: number

  // ─── Horizon / UI policy ───
  event_horizon_days: number
  ap_beyond_horizon_probability_discount: number
  min_invoice_only_customer_total: number
  min_bill_only_vendor_total: number

  // ─── Monte Carlo ───
  monte_carlo_iterations: number

  // ─── Confidence composite weights ───
  confidence_weights: ConfidenceWeights

  // ─── Scenario biases ───
  scenario_stress: ScenarioBias
  scenario_optimistic: ScenarioBias

  // ─── Backtest thresholds ───
  backtest_horizons: readonly number[]
  backtest_min_training_movements: number
  backtest_min_test_movements: number
  backtest_min_active_days: number

  // ─── Archetype classification thresholds ───
  archetype_clockwork_interval_cv_max: number
  archetype_clockwork_amount_cv_max: number
  archetype_volatile_interval_cv_min: number
  archetype_slow_reliable_avg_days_min: number
  archetype_bursty_interval_cv_range: [number, number]
  archetype_episodic_payment_count_range: [number, number]

  // ─── Decay factors for 6-month projection ───
  customer_decay_base: number
  customer_decay_data_quality_factor: number
  vendor_decay_base: number
  vendor_decay_recurrence_factor: number
  component_decay_base: number
  component_decay_volatility_factor: number

  // ─── Vendor recurrence thresholds ───
  vendor_hard_recurrence_cv_max: number
  vendor_soft_recurrence_cv_max: number
  vendor_min_recurrence_confidence: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Default calibration (matches current engine behavior)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_FORECAST_CALIBRATION: ForecastCalibrationParams = {
  // Probability bounds
  probability_floor: 0.02,
  probability_ceiling: 0.95,

  // Portfolio prior defaults
  portfolio_prior_base_p7: 0.25,
  portfolio_prior_base_p14: 0.45,
  portfolio_prior_base_p30: 0.65,
  portfolio_prior_avg_collection_delay: 21,

  // Global scaling (neutral by default)
  global_event_probability_scale: 1.0,
  portfolio_prior_scale: 1.0,
  probability_temperature_override: null,

  // Archetype multipliers
  archetype_multipliers: {
    clockwork: { probMult: 1.3, intervalMult: 0.8 },
    bursty: { probMult: 0.9, intervalMult: 1.2 },
    episodic: { probMult: 0.6, intervalMult: 1.5 },
    slow_reliable: { probMult: 1.1, intervalMult: 1.3 },
    volatile: { probMult: 0.7, intervalMult: 1.4 },
    low_data: { probMult: 1.0, intervalMult: 1.0 },
  },

  archetype_fallbacks: {
    clockwork: { prob: 0.6, interval: 30 },
    bursty: { prob: 0.4, interval: 45 },
    episodic: { prob: 0.2, interval: 60 },
    slow_reliable: { prob: 0.5, interval: 45 },
    volatile: { prob: 0.25, interval: 50 },
    low_data: { prob: 0.3, interval: 30 },
  },

  // Reconciliation boosts
  reconciliation_matched_boost_p7: 1.5,
  reconciliation_matched_boost_p14: 1.4,
  reconciliation_matched_boost_p30: 1.3,
  reconciliation_partial_boost_factor: 0.3,

  // Invoice probability ladder
  invoice_overdue_boost: 0.1,
  invoice_dso_factor_min: 0.5,
  invoice_dso_factor_max: 1.5,
  invoice_volatile_penalty_p7: 0.7,
  invoice_volatile_penalty_p14: 0.8,
  invoice_volatile_penalty_p30: 0.9,

  // Horizon / UI policy
  event_horizon_days: 30,
  ap_beyond_horizon_probability_discount: 0.75,
  min_invoice_only_customer_total: 100,
  min_bill_only_vendor_total: 50,

  // Monte Carlo
  monte_carlo_iterations: 500,

  // Confidence composite weights (sum = 1.0)
  confidence_weights: {
    inflow: 0.20,
    outflow: 0.20,
    settlement: 0.10,
    identity: 0.10,
    recurrence: 0.10,
    dataSpan: 0.10,
    stability: 0.10,
    backtest: 0.10,
  },

  // Scenario biases
  scenario_stress: {
    inflow_prob_mult: 0.75,
    outflow_prob_mult: 1.0,
    inflow_amount_mult: 0.85,
    outflow_amount_mult: 1.12,
    trend_dampening: 0.6,
  },
  scenario_optimistic: {
    inflow_prob_mult: 1.0,
    outflow_prob_mult: 0.85,
    inflow_amount_mult: 1.1,
    outflow_amount_mult: 0.92,
    trend_dampening: 1.4,
  },

  // Backtest thresholds
  backtest_horizons: [7, 14, 30, 60, 90],
  backtest_min_training_movements: 10,
  backtest_min_test_movements: 3,
  backtest_min_active_days: 2,

  // Archetype classification thresholds
  archetype_clockwork_interval_cv_max: 0.25,
  archetype_clockwork_amount_cv_max: 0.3,
  archetype_volatile_interval_cv_min: 0.8,
  archetype_slow_reliable_avg_days_min: 30,
  archetype_bursty_interval_cv_range: [0.5, 0.8],
  archetype_episodic_payment_count_range: [3, 6],

  // Decay factors for 6-month projection
  customer_decay_base: 0.15,
  customer_decay_data_quality_factor: 0.1,
  vendor_decay_base: 0.1,
  vendor_decay_recurrence_factor: 0.05,
  component_decay_base: 0.05,
  component_decay_volatility_factor: 0.1,

  // Vendor recurrence thresholds
  vendor_hard_recurrence_cv_max: 0.25,
  vendor_soft_recurrence_cv_max: 0.5,
  vendor_min_recurrence_confidence: 0.2,
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation bounds for tunable parameters
// ─────────────────────────────────────────────────────────────────────────────

export const CALIBRATION_BOUNDS: Partial<
  Record<keyof ForecastCalibrationParams, { min: number; max: number }>
> = {
  probability_floor: { min: 0.001, max: 0.1 },
  probability_ceiling: { min: 0.8, max: 0.999 },
  global_event_probability_scale: { min: 0.5, max: 2.0 },
  portfolio_prior_scale: { min: 0.5, max: 2.0 },
  probability_temperature_override: { min: 0.5, max: 3.0 },
  monte_carlo_iterations: { min: 100, max: 2000 },
  ap_beyond_horizon_probability_discount: { min: 0.3, max: 1.0 },
  customer_decay_base: { min: 0.05, max: 0.4 },
  vendor_decay_base: { min: 0.03, max: 0.3 },
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge and validation utilities
// ─────────────────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  partial: Partial<T>
): T {
  const result = { ...base }
  for (const key of Object.keys(partial) as (keyof T)[]) {
    const baseVal = base[key]
    const partialVal = partial[key]
    if (partialVal === undefined) continue
    if (isPlainObject(baseVal) && isPlainObject(partialVal)) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        partialVal as Record<string, unknown>
      ) as T[keyof T]
    } else {
      result[key] = partialVal as T[keyof T]
    }
  }
  return result
}

function clampNumber(
  value: number,
  min: number,
  max: number
): number {
  if (Number.isNaN(value)) return (min + max) / 2
  return Math.max(min, Math.min(max, value))
}

/**
 * Merge a partial calibration override into the base calibration.
 * Validates and clamps numeric values to allowed bounds.
 */
export function mergeCalibration(
  base: ForecastCalibrationParams,
  partial: Partial<ForecastCalibrationParams>
): ForecastCalibrationParams {
  const merged = deepMerge(base, partial)

  // Clamp bounded numeric fields
  for (const [key, bounds] of Object.entries(CALIBRATION_BOUNDS)) {
    const k = key as keyof ForecastCalibrationParams
    const val = merged[k]
    if (typeof val === "number") {
      ;(merged as Record<string, unknown>)[k] = clampNumber(
        val,
        bounds.min,
        bounds.max
      )
    }
  }

  // Validate confidence weights sum to ~1.0
  const weights = merged.confidence_weights
  const sum =
    weights.inflow +
    weights.outflow +
    weights.settlement +
    weights.identity +
    weights.recurrence +
    weights.dataSpan +
    weights.stability +
    weights.backtest
  if (Math.abs(sum - 1.0) > 0.01) {
    const scale = 1.0 / sum
    merged.confidence_weights = {
      inflow: weights.inflow * scale,
      outflow: weights.outflow * scale,
      settlement: weights.settlement * scale,
      identity: weights.identity * scale,
      recurrence: weights.recurrence * scale,
      dataSpan: weights.dataSpan * scale,
      stability: weights.stability * scale,
      backtest: weights.backtest * scale,
    }
  }

  return merged
}

/**
 * Compute a short hash of calibration params for metadata/debugging.
 */
export function computeCalibrationHash(
  params: ForecastCalibrationParams
): string {
  const json = JSON.stringify(params)
  let hash = 0
  for (let i = 0; i < json.length; i++) {
    const char = json.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  return Math.abs(hash).toString(36).slice(0, 8)
}
