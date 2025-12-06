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

/** Scenario bias multipliers (monthly projection) */
export interface ScenarioBias {
  inflow_prob_mult: number
  outflow_prob_mult: number
  inflow_amount_mult: number
  outflow_amount_mult: number
  trend_dampening: number
}

/** Monte Carlo scenario bias (30-day simulation) */
export interface MCScenarioBias {
  inflow_prob_mult: number
  outflow_prob_mult: number
  inflow_amount_mult: number
  outflow_amount_mult: number
  inflow_delay_bias: number
  outflow_delay_bias: number
}

export interface SigmoidDecayParams {
  steepness: number
  midpoint: number
}

export interface CohortPriorFallbackParams {
  avg_prob_7d: number
  avg_prob_14d: number
  avg_prob_30d: number
  default_variance_mult: number
}

export interface CustomerProbabilityParams {
  payment_count_scale: number
  payment_count_norm: number
  overdue_mult: number
  not_overdue_mult: number
  low_data_mult: number
  decel_mult: number
  first_seen_mult: number
  floor: number
  ceiling: number
  min_prob_for_next_date: number
  min_day_offset: number
  interval_fraction: number
  invoice_boost_offset: number
  invoice_boost_scale: number
  invoice_boost_cap: number
  invoice_boost_max: number
  overdue_invoice_mult: number
  overdue_invoice_cap: number
}

export interface InvoiceOnlyCustomerParams {
  overdue_prob: number
  not_overdue_prob: number
  profile_prob_base: number
  profile_prob_scale: number
  on_time_threshold: number
  on_time_cap: number
  on_time_mult: number
  high_conf_count: number
  high_conf_reliability: number
  cv_clockwork: number
  cv_slow_reliable: number
  cv_bursty: number
}

export interface ProfileEnhancementParams {
  reliability_boost_offset: number
  reliability_boost_scale: number
  blend_model_weight: number
  blend_profile_weight: number
  on_time_good_threshold: number
  on_time_good_mult: number
  on_time_good_cap: number
  on_time_bad_threshold: number
  on_time_bad_mult: number
  high_conf_count: number
  high_conf_reliability: number
  medium_conf_count: number
  medium_conf_reliability: number
  recurrence_conf_increment: number
  data_quality_fallback: number
  data_quality_count_norm: number
  quality_weights: { data: number; archetype: number; reliability: number }
  missing_profile_penalty: number
  upgrade_txn_count: number
  upgrade_base_reliability: number
  upgrade_high_reliability: number
}

export interface CadenceDetectionParams {
  weekly_max: number
  biweekly_max: number
  monthly_max: number
  quarterly_max: number
}

export interface VendorClassificationParams {
  hard_cv_threshold: number
  spend_on_demand_count: number
  spend_on_demand_cv: number
  batch_supplier_count: number
  batch_supplier_cv: number
  due_date_adherence_with_bills: number
  due_date_adherence_without: number
  batching_score_batch: number
  batching_score_non_batch: number
  tagged_recurring_fraction: number
  bill_only_due_date_with: number
  bill_only_due_date_without: number
  bill_only_adherence_fallback: number
  bill_only_amount_volatility: number
}

export interface RecurrenceConfidenceParams {
  component_weights: { interval: number; amount: number; counterparty: number; due_date: number; class_consistency: number }
  bill_soft_cap: number
  bill_soft_base: number
  bill_soft_floor: number
  bill_episodic_cap: number
  bill_episodic_base: number
  bill_episodic_floor: number
  unknown_cap: number
  unknown_base: number
  seasonal_cap: number
  seasonal_mult: number
  hard_cap: number
  hard_mult: number
  soft_cap: number
  episodic_cap: number
  episodic_mult: number
  fallback_cap: number
  fallback_base: number
  bill_only_base_conf: number
  bill_only_cv_mult: number
  bill_only_hard_cv: number
  bill_only_soft_cv: number
  bill_interval_soft_cap: number
  bill_interval_soft_base: number
  bill_interval_episodic_cap: number
  bill_interval_episodic_base: number
}

export interface VendorEventProbabilityParams {
  hard_base: number
  hard_conf_scale: number
  hard_cap: number
  soft_base: number
  soft_conf_scale: number
  soft_cap: number
  seasonal_base: number
  seasonal_conf_scale: number
  seasonal_cap: number
  recurring_fallback: number
  non_recurring_fallback: number
  bill_overdue_prob: number
  bill_not_overdue_prob: number
  recurring_fixed_prob: number
}

export interface CustomerFeaturesParams {
  accel_threshold: number
  decel_threshold: number
  weekday_min_payments: number
  weekday_bias_threshold: number
  reliable_cv: number
  moderate_cv: number
  low_data_payment_count: number
}

export interface ArchetypeResidualParams {
  slow_reliable_cv: number
  episodic_cv: number
  clockwork_cv: number
}

export interface MonteCarloParams {
  noise_high: number
  noise_medium: number
  noise_low: number
  delay_high: number
  delay_medium: number
  delay_low: number
  delay_mult: number
  percentile_worst: number
  percentile_best: number
  biased_sim_count: number
  scenario_biases: {
    conservative: MCScenarioBias
    aggressive: MCScenarioBias
  }
}

export interface MonthlyScenariosParams {
  pess_inflow_base: number
  pess_inflow_conc_penalty: number
  pess_inflow_transition_penalty: number
  pess_outflow_base: number
  pess_outflow_dep_penalty: number
  pess_outflow_regime_penalty: number
  pess_cust_prob_base: number
  pess_cust_prob_risk_high: number
  pess_cust_prob_risk_mid: number
  pess_trend_dampening: number
  opt_cust_prob: number
  opt_inflow_mult: number
  opt_outflow_mult: number
  opt_trend_dampening: number
  decay_coefficient: number
  driver_customer_delay: number
  driver_vendor_stress: number
  driver_settlement_delay: number
  driver_recurring_prob: number
}

export interface MonthlyProjectionParams {
  invoice_collection_base: number
  invoice_collection_decay: number
  invoice_collection_floor: number
  no_invoice_mult: number
  pipeline_conversion_base: number
  pipeline_conversion_decay: number
  pipeline_conversion_floor: number
  default_volatility: number
  floor_decay_volatility_coeff: number
  vendor_min_recurrence_conf: number
  vendor_floor_base: number
  vendor_floor_decay: number
  episodic_component_mult: number
  data_quality_count_norm: number
  data_quality_conf_high: number
  data_quality_conf_low: number
}

export interface SeasonalityParams {
  min_inflow_movements: number
  min_distinct_months: number
  weight_floor: number
  weight_ceiling: number
  peak_threshold: number
  low_threshold: number
}

export interface TransferModelParams {
  periodic_cv: number
  irregular_cv: number
  low_balance_threshold: number
  low_balance_frequency: number
  periodic_event_prob: number
  low_balance_event_prob: number
  irregular_event_prob: number
  settlement_event_prob: number
  settlement_agg_prob: number
}

export interface ConfidenceScoringParams {
  archetype_bonus: Record<CustomerArchetype, number>
  confidence_mult: { high: number; medium: number; low: number }
  vendor_conf_mult: { high: number; medium: number; low: number }
  settlement_score_map: { high: number; medium: number; low: number; insufficient: number }
  data_span_target_months: number
  variance_penalty_base: number
  variance_penalty_scale: number
  composite_floor: number
  composite_ceiling: number
  label_high: number
  label_medium: number
  inflow_low_threshold: number
  inflow_low_label_threshold: number
  outflow_fallback_base: number
  outflow_fallback_comp_cap: number
  outflow_fallback_comp_divisor: number
  outflow_fallback_bill_cap: number
  outflow_fallback_bill_scale: number
  outflow_fallback_total_cap: number
  outflow_weak_threshold: number
  outflow_label_high: number
  outflow_label_medium: number
  recurrence_fallback_base: number
  recurrence_fallback_cap: number
  recurrence_fallback_bill_scale: number
  recurrence_label_high: number
  recurrence_label_medium: number
}

export interface BacktestScoringParams {
  direction_weight: number
  error_weight: number
  temperature_threshold: number
  temperature_mult: number
  overconfidence_gap: number
  interpretation_high_threshold: number
  merge_min_sample: number
}

export interface NarrativeParams {
  flat_threshold: number
  risk_50pct: number
  risk_prob_threshold: number
  low_conf_inflow_fraction: number
  top_customer_share: number
  recurring_high: number
  recurring_moderate: number
  repeat_revenue_threshold: number
  recurring_spend_threshold: number
  action_cash_significance: number
  obligation_significance: number
  credit_line_threshold: number
  severity_danger_prob: number
  severity_caution_prob: number
  severity_caution_drop: number
  severity_caution_14d: number
  outflow_excess_ratio: number
  settlement_delay_threshold: number
  action_prob_threshold: number
  risk_reduction_cap: number
  risk_reduction_default: number
  obligation_count_threshold: number
  concentration_risk_threshold: number
  dependency_risk_threshold: number
}

export interface InterventionParams {
  accel_days: number
  delay_days: number
  accel_impact_14d: number
  accel_impact_30d: number
  accel_low_point: number
  delay_impact_14d: number
  delay_impact_30d: number
  delay_low_point: number
  late_fee_with_bills: number
  late_fee_without: number
  rel_risk_hard: number
  rel_risk_other: number
  cascade_high: number
  cascade_low: number
  vendor_trough_mult: number
  plausible_low: number
  plausible_high: number
  spend_reduction_pct: number
  accel_min_prob: number
  accel_min_cash: number
  accel_risk_cap: number
  delay_min_count: number
  delay_min_cash: number
  delay_risk_cap: number
  delay_risk_mult: number
  spend_risk_cap: number
  spend_14d_fraction: number
  spend_plausible_low: number
  spend_plausible_high: number
  spend_sim_low_point: number
  sort_risk_threshold: number
  sort_risk_diff: number
  max_interventions: number
  base_low_point_fallback: number
  stress_prob_threshold: number
  risk_level_low: number
  risk_level_medium: number
}

export interface PortfolioPriorParams {
  archetype_weights: Record<CustomerArchetype, number>
  p7_cap: number
  p7_linear: number
  p7_floor: number
  p14_cap: number
  p14_linear: number
  p14_floor: number
  p30_cap: number
  p30_linear: number
  p30_floor: number
  collection_delay_clamp_min: number
  collection_delay_clamp_max: number
  days_normalization: number
  due_sigmoid_midpoint: number
  min_receipts: number
  frequency_divisor: number
  frequency_cap: number
  p7_base: number
  p7_freq_mult: number
  p14_offset: number
  p14_freq_mult: number
  p30_offset: number
  p30_freq_mult: number
  min_paid_invoices: number
  min_receipts_interval: number
  delay_base_offset: number
}

export interface SettlementTimingParams {
  // Reconciliation data weight (0-1): how much to trust reconciliation delays vs. processor intervals
  reconciliation_weight: number
  // Minimum reconciliation samples to use reconciliation data
  min_reconciliation_samples: number
  // Confidence boost when reconciliation data is available
  confidence_boost_with_reconciliation: number
  // Default settlement delay (days) when no data available
  default_delay_days: number
  // Standard deviation multiplier for delay uncertainty
  delay_std_multiplier: number
}

export interface ComponentDetectionParams {
  peak_deviation: number
  trough_deviation: number
  recurring_pct: number
  recurring_coverage: number
  episodic_coverage: number
  high_conf_volatility: number
  medium_conf_volatility: number
  min_high_months: number
  min_medium_months: number
  min_trend_months: number
  trend_cap: number
  volatility_cap: number
}

export interface EventGenerationParams {
  min_customer_prob: number
  min_vendor_prob: number
  beyond_30d_prob_floor: number
  beyond_30d_prob_mult: number
  vendor_min_payment_count: number
  settlement_min_samples: number
  processor_min_samples: number
  processor_high_conf_samples: number
  transfer_min_count: number
  overdue_invoice_prob_boost: number
  overdue_invoice_prob_cap: number
}

export interface RouteConfigParams {
  cache_ttl_minutes: number
  profile_stale_ms: number
  horizon_months: number
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

  // ─── Scenario biases (monthly) ───
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

  // ─── Phase 1: Sigmoid, Cohort, Customer Probability ───
  sigmoid_decay: SigmoidDecayParams
  cohort_prior_fallback: CohortPriorFallbackParams
  customer_probability: CustomerProbabilityParams

  // ─── Phase 2: Invoice-Only Customers, Profile Enhancement ───
  invoice_only_customer: InvoiceOnlyCustomerParams
  profile_enhancement: ProfileEnhancementParams

  // ─── Phase 3: Vendor Classification, Recurrence, Cadence ───
  cadence_detection: CadenceDetectionParams
  vendor_classification: VendorClassificationParams
  recurrence_confidence: RecurrenceConfidenceParams

  // ─── Phase 4: Vendor Event Probability, Customer Features ───
  vendor_event_probability: VendorEventProbabilityParams
  customer_features: CustomerFeaturesParams
  archetype_residual: ArchetypeResidualParams

  // ─── Phase 5: Monte Carlo, Monthly Scenarios ───
  monte_carlo_config: MonteCarloParams
  monthly_scenarios: MonthlyScenariosParams

  // ─── Phase 6: 6-Month Projection, Seasonality, Transfers ───
  monthly_projection: MonthlyProjectionParams
  seasonality_config: SeasonalityParams
  transfer_model: TransferModelParams

  // ─── Phase 7: Confidence Scoring, Backtest Scoring ───
  confidence_scoring: ConfidenceScoringParams
  backtest_scoring: BacktestScoringParams

  // ─── Phase 8: Narrative, Interventions ───
  narrative: NarrativeParams
  interventions: InterventionParams

  // ─── Phase 9: Portfolio Prior Computation ───
  portfolio_prior: PortfolioPriorParams

  // ─── Settlement Timing (Reconciliation-based) ───
  settlement_timing: SettlementTimingParams

  // ─── Phase 10: Component Detection, Event Generation, Route ───
  component_detection: ComponentDetectionParams
  event_generation: EventGenerationParams
  route_config: RouteConfigParams
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
  backtest_min_training_movements: 5,
  backtest_min_test_movements: 2,
  backtest_min_active_days: 1,

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

  // Phase 1: Sigmoid, Cohort Prior, Customer Probability
  sigmoid_decay: { steepness: 2.5, midpoint: 2.0 },

  cohort_prior_fallback: {
    avg_prob_7d: 0.3, avg_prob_14d: 0.5, avg_prob_30d: 0.7,
    default_variance_mult: 0.3,
  },

  customer_probability: {
    payment_count_scale: 0.1, payment_count_norm: 6,
    overdue_mult: 1.2, not_overdue_mult: 0.9,
    low_data_mult: 0.5, decel_mult: 0.8, first_seen_mult: 0.4,
    floor: 0.02, ceiling: 0.98, min_prob_for_next_date: 0.1,
    min_day_offset: 2, interval_fraction: 0.5,
    invoice_boost_offset: 0.5, invoice_boost_scale: 0.2,
    invoice_boost_cap: 0.8, invoice_boost_max: 0.9,
    overdue_invoice_mult: 1.1, overdue_invoice_cap: 0.9,
  },

  // Phase 2: Invoice-Only Customers, Profile Enhancement
  invoice_only_customer: {
    overdue_prob: 0.4, not_overdue_prob: 0.3,
    profile_prob_base: 0.3, profile_prob_scale: 0.5,
    on_time_threshold: 0.8, on_time_cap: 0.95, on_time_mult: 1.15,
    high_conf_count: 10, high_conf_reliability: 0.7,
    cv_clockwork: 0.25, cv_slow_reliable: 0.5, cv_bursty: 0.8,
  },

  profile_enhancement: {
    reliability_boost_offset: 0.5, reliability_boost_scale: 0.2,
    blend_model_weight: 0.4, blend_profile_weight: 0.6,
    on_time_good_threshold: 0.8, on_time_good_mult: 1.15, on_time_good_cap: 0.95,
    on_time_bad_threshold: 0.5, on_time_bad_mult: 0.85,
    high_conf_count: 10, high_conf_reliability: 0.7,
    medium_conf_count: 5, medium_conf_reliability: 0.5,
    recurrence_conf_increment: 0.1,
    data_quality_fallback: 0.5, data_quality_count_norm: 10,
    quality_weights: { data: 0.4, archetype: 0.3, reliability: 0.3 },
    missing_profile_penalty: 0.3,
    upgrade_txn_count: 6, upgrade_base_reliability: 0.7, upgrade_high_reliability: 0.85,
  },

  // Phase 3: Vendor Classification, Recurrence, Cadence
  cadence_detection: {
    weekly_max: 10, biweekly_max: 18, monthly_max: 45, quarterly_max: 120,
  },

  vendor_classification: {
    hard_cv_threshold: 0.2, spend_on_demand_count: 4, spend_on_demand_cv: 0.5,
    batch_supplier_count: 5, batch_supplier_cv: 0.4,
    due_date_adherence_with_bills: 0.7, due_date_adherence_without: 0.5,
    batching_score_batch: 0.8, batching_score_non_batch: 0.3,
    tagged_recurring_fraction: 0.5,
    bill_only_due_date_with: 0.85, bill_only_due_date_without: 0.4,
    bill_only_adherence_fallback: 0.65, bill_only_amount_volatility: 0.35,
  },

  recurrence_confidence: {
    component_weights: { interval: 0.35, amount: 0.25, counterparty: 0.15, due_date: 0.15, class_consistency: 0.1 },
    bill_soft_cap: 0.70, bill_soft_base: 0.9, bill_soft_floor: 0.25,
    bill_episodic_cap: 0.50, bill_episodic_base: 0.65, bill_episodic_floor: 0.15,
    unknown_cap: 0.25, unknown_base: 0.4,
    seasonal_cap: 0.90, seasonal_mult: 1.2,
    hard_cap: 0.98, hard_mult: 1.2,
    soft_cap: 0.85,
    episodic_cap: 0.60, episodic_mult: 0.8,
    fallback_cap: 0.40, fallback_base: 0.6,
    bill_only_base_conf: 0.20, bill_only_cv_mult: 0.9,
    bill_only_hard_cv: 0.2, bill_only_soft_cv: 0.5,
    bill_interval_soft_cap: 0.65, bill_interval_soft_base: 0.8,
    bill_interval_episodic_cap: 0.45, bill_interval_episodic_base: 0.6,
  },

  // Phase 4: Vendor Event Probability, Customer Features, Archetype
  vendor_event_probability: {
    hard_base: 0.8, hard_conf_scale: 0.1, hard_cap: 0.92,
    soft_base: 0.55, soft_conf_scale: 0.2, soft_cap: 0.80,
    seasonal_base: 0.4, seasonal_conf_scale: 0.2, seasonal_cap: 0.70,
    recurring_fallback: 0.6, non_recurring_fallback: 0.35,
    bill_overdue_prob: 0.8, bill_not_overdue_prob: 0.7,
    recurring_fixed_prob: 0.8,
  },

  customer_features: {
    accel_threshold: 1.15, decel_threshold: 0.85,
    weekday_min_payments: 5, weekday_bias_threshold: 0.4,
    reliable_cv: 0.3, moderate_cv: 0.6,
    low_data_payment_count: 3,
  },

  archetype_residual: {
    slow_reliable_cv: 0.5, episodic_cv: 0.4, clockwork_cv: 0.5,
  },

  // Phase 5: Monte Carlo, Monthly Scenarios
  monte_carlo_config: {
    noise_high: 0.08, noise_medium: 0.15, noise_low: 0.25,
    delay_high: 1, delay_medium: 3, delay_low: 5,
    delay_mult: 0.5,
    percentile_worst: 5, percentile_best: 95,
    biased_sim_count: 200,
    scenario_biases: {
      conservative: { inflow_prob_mult: 0.75, outflow_prob_mult: 1.0, inflow_amount_mult: 0.9, outflow_amount_mult: 1.1, inflow_delay_bias: 3, outflow_delay_bias: -1 },
      aggressive: { inflow_prob_mult: 1.0, outflow_prob_mult: 0.85, inflow_amount_mult: 1.1, outflow_amount_mult: 0.92, inflow_delay_bias: -2, outflow_delay_bias: 1 },
    },
  },

  monthly_scenarios: {
    pess_inflow_base: 0.88, pess_inflow_conc_penalty: 0.08, pess_inflow_transition_penalty: 0.05,
    pess_outflow_base: 1.12, pess_outflow_dep_penalty: 0.06, pess_outflow_regime_penalty: 0.04,
    pess_cust_prob_base: 0.75, pess_cust_prob_risk_high: 0.10, pess_cust_prob_risk_mid: 0.05,
    pess_trend_dampening: 0.5,
    opt_cust_prob: 1.15, opt_inflow_mult: 1.08,
    opt_outflow_mult: 0.95, opt_trend_dampening: 1.2,
    decay_coefficient: 0.3,
    driver_customer_delay: 0.25, driver_vendor_stress: 0.12,
    driver_settlement_delay: 0.15, driver_recurring_prob: 0.9,
  },

  // Phase 6: 6-Month Projection, Seasonality, Transfers
  monthly_projection: {
    invoice_collection_base: 0.4, invoice_collection_decay: 0.1, invoice_collection_floor: 0.05,
    no_invoice_mult: 0.5,
    pipeline_conversion_base: 0.35, pipeline_conversion_decay: 0.08, pipeline_conversion_floor: 0.05,
    default_volatility: 0.5, floor_decay_volatility_coeff: 0.3,
    vendor_min_recurrence_conf: 0.5,
    vendor_floor_base: 0.85, vendor_floor_decay: 0.06,
    episodic_component_mult: 0.5,
    data_quality_count_norm: 6, data_quality_conf_high: 0.7, data_quality_conf_low: 0.4,
  },

  seasonality_config: {
    min_inflow_movements: 20, min_distinct_months: 6,
    weight_floor: 0.5, weight_ceiling: 2.0,
    peak_threshold: 1.2, low_threshold: 0.8,
  },

  transfer_model: {
    periodic_cv: 0.3, irregular_cv: 0.7,
    low_balance_threshold: 0.3, low_balance_frequency: 0.5,
    periodic_event_prob: 0.7, low_balance_event_prob: 0.6, irregular_event_prob: 0.4,
    settlement_event_prob: 0.8, settlement_agg_prob: 0.8,
  },

  // Phase 7: Confidence Scoring, Backtest Scoring
  confidence_scoring: {
    archetype_bonus: { clockwork: 1.0, slow_reliable: 0.7, bursty: 0.5, episodic: 0.35, volatile: 0.2, low_data: 0.15 },
    confidence_mult: { high: 1.0, medium: 0.6, low: 0.25 },
    vendor_conf_mult: { high: 1.0, medium: 0.6, low: 0.25 },
    settlement_score_map: { high: 0.9, medium: 0.65, low: 0.35, insufficient: 0.1 },
    data_span_target_months: 6,
    variance_penalty_base: 0.4, variance_penalty_scale: 0.3,
    composite_floor: 0.05, composite_ceiling: 0.99,
    label_high: 0.7, label_medium: 0.45,
    inflow_low_threshold: 0.3, inflow_low_label_threshold: 0.7,
    outflow_fallback_base: 0.28, outflow_fallback_comp_cap: 0.22, outflow_fallback_comp_divisor: 25,
    outflow_fallback_bill_cap: 0.12, outflow_fallback_bill_scale: 0.008, outflow_fallback_total_cap: 0.52,
    outflow_weak_threshold: 0.3, outflow_label_high: 0.7, outflow_label_medium: 0.4,
    recurrence_fallback_base: 0.14, recurrence_fallback_cap: 0.38, recurrence_fallback_bill_scale: 0.006,
    recurrence_label_high: 0.6, recurrence_label_medium: 0.35,
  },

  backtest_scoring: {
    direction_weight: 60, error_weight: 40,
    temperature_threshold: 0.2, temperature_mult: 1.5,
    overconfidence_gap: 0.1, interpretation_high_threshold: 0.25,
    merge_min_sample: 5,
  },

  // Phase 8: Narrative, Interventions
  narrative: {
    flat_threshold: 0.01,
    risk_50pct: 0.5, risk_prob_threshold: 0.1,
    low_conf_inflow_fraction: 0.4, top_customer_share: 0.3,
    recurring_high: 0.95, recurring_moderate: 0.6,
    repeat_revenue_threshold: 0.4, recurring_spend_threshold: 0.8,
    action_cash_significance: 0.03, obligation_significance: 0.02,
    credit_line_threshold: 0.05,
    severity_danger_prob: 0.1,
    severity_caution_prob: 0.05, severity_caution_drop: 0.3, severity_caution_14d: 0.6,
    outflow_excess_ratio: 1.2, settlement_delay_threshold: 3,
    action_prob_threshold: 0.3, risk_reduction_cap: 90, risk_reduction_default: 30,
    obligation_count_threshold: 3,
    concentration_risk_threshold: 50, dependency_risk_threshold: 50,
  },

  interventions: {
    accel_days: 3, delay_days: 5,
    accel_impact_14d: 0.7, accel_impact_30d: 0.5, accel_low_point: 0.6,
    delay_impact_14d: 0.5, delay_impact_30d: 0.3, delay_low_point: 0.5,
    late_fee_with_bills: 0.2, late_fee_without: 0.05,
    rel_risk_hard: 0.15, rel_risk_other: 0.08,
    cascade_high: 0.12, cascade_low: 0.03,
    vendor_trough_mult: 0.4, plausible_low: 0.6, plausible_high: 1.2,
    spend_reduction_pct: 0.1,
    accel_min_prob: 0.3, accel_min_cash: 100, accel_risk_cap: 50,
    delay_min_count: 3, delay_min_cash: 100, delay_risk_cap: 30, delay_risk_mult: 80,
    spend_risk_cap: 40, spend_14d_fraction: 0.5,
    spend_plausible_low: 0.7, spend_plausible_high: 1.3,
    spend_sim_low_point: 0.4,
    sort_risk_threshold: 0.05, sort_risk_diff: 2,
    max_interventions: 6,
    base_low_point_fallback: 0.85, stress_prob_threshold: 0.05,
    risk_level_low: 0.15, risk_level_medium: 0.35,
  },

  // Phase 9: Portfolio Prior Computation
  portfolio_prior: {
    archetype_weights: { clockwork: 1.4, slow_reliable: 0.9, bursty: 0.8, episodic: 0.6, volatile: 0.5, low_data: 0.7 },
    p7_cap: 0.6, p7_linear: 0.15, p7_floor: 0.1,
    p14_cap: 0.75, p14_linear: 0.15, p14_floor: 0.05,
    p30_cap: 0.9, p30_linear: 0.15, p30_floor: 0.05,
    collection_delay_clamp_min: 7, collection_delay_clamp_max: 45,
    days_normalization: 30, due_sigmoid_midpoint: 0.5,
    min_receipts: 5, frequency_divisor: 10, frequency_cap: 2,
    p7_base: 0.15, p7_freq_mult: 0.1,
    p14_offset: 0.15, p14_freq_mult: 0.05,
    p30_offset: 0.15, p30_freq_mult: 0.05,
    min_paid_invoices: 3, min_receipts_interval: 10,
    delay_base_offset: 7,
  },

  // Settlement Timing (Reconciliation-based)
  settlement_timing: {
    reconciliation_weight: 0.6,
    min_reconciliation_samples: 3,
    confidence_boost_with_reconciliation: 0.15,
    default_delay_days: 2,
    delay_std_multiplier: 1.2,
  },

  // Phase 10: Component Detection, Event Generation, Route Config
  component_detection: {
    peak_deviation: 1.5, trough_deviation: 0.5,
    recurring_pct: 0.6, recurring_coverage: 0.7,
    episodic_coverage: 0.4, high_conf_volatility: 0.5,
    medium_conf_volatility: 1.0,
    min_high_months: 3, min_medium_months: 2,
    min_trend_months: 4,
    trend_cap: 2, volatility_cap: 3,
  },

  event_generation: {
    min_customer_prob: 0.15, min_vendor_prob: 0.2,
    beyond_30d_prob_floor: 0.35, beyond_30d_prob_mult: 0.75,
    vendor_min_payment_count: 3,
    settlement_min_samples: 3, processor_min_samples: 2, processor_high_conf_samples: 10,
    transfer_min_count: 3,
    overdue_invoice_prob_boost: 0.1, overdue_invoice_prob_cap: 0.95,
  },

  route_config: {
    cache_ttl_minutes: 15, profile_stale_ms: 3600000, horizon_months: 6,
  },
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
