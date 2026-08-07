/**
 * Forecast Calibration Tuner
 *
 * Evaluates calibration parameters against historical data and
 * performs bounded grid-search optimization to find better settings.
 */

import { query } from "./db"
import { log } from "./logger"
import {
  DEFAULT_FORECAST_CALIBRATION,
  mergeCalibration,
  CALIBRATION_BOUNDS,
  type ForecastCalibrationParams,
} from "./state/forecast-calibration"
import {
  saveForecastCalibrationOverride,
  invalidateForecastCacheForUser,
} from "./forecast-calibration-load"
import { runSingleBacktestWithCalibration } from "./state/forecast-engine"
import type { TaggedMovement, OutstandingInvoice, OutstandingBill, EntityPaymentProfile } from "./state/types"

export interface CalibrationEvalResult {
  mae: number
  score: number
  directionAccuracy: number
}

export interface TunerResult {
  improved: boolean
  bestParams: Partial<ForecastCalibrationParams>
  trainLoss: number
  valLoss: number | null
  iterations: number
  fitWindowDays: number
}

// Tunable knobs (subset of ForecastCalibrationParams)
const TUNABLE_KNOBS: (keyof ForecastCalibrationParams)[] = [
  "global_event_probability_scale",
  "portfolio_prior_scale",
  "customer_decay_base",
  "vendor_decay_base",
]

// Grid search step sizes
const GRID_STEPS: Partial<Record<keyof ForecastCalibrationParams, number[]>> = {
  global_event_probability_scale: [0.7, 0.85, 1.0, 1.15, 1.3],
  portfolio_prior_scale: [0.7, 0.85, 1.0, 1.15, 1.3],
  customer_decay_base: [0.08, 0.12, 0.15, 0.18, 0.22],
  vendor_decay_base: [0.06, 0.08, 0.10, 0.12, 0.15],
}

/**
 * Evaluate a calibration configuration against historical data.
 * Uses the backtest infrastructure to compute loss metrics.
 */
export async function evaluateCalibrationOnHistory(
  movements: TaggedMovement[],
  invoices: OutstandingInvoice[],
  bills: OutstandingBill[],
  params: Partial<ForecastCalibrationParams>,
  entityProfiles: EntityPaymentProfile[] = [],
): Promise<CalibrationEvalResult | null> {
  const cal = mergeCalibration(DEFAULT_FORECAST_CALIBRATION, params)
  const allDates = movements.map((m) => m.occurred_at.slice(0, 10)).filter(Boolean).sort()
  
  if (allDates.length < 30) return null
  
  const result = runSingleBacktestWithCalibration(movements, invoices, bills, 14, allDates, cal, entityProfiles)
  if (!result) return null
  
  return {
    mae: result.mae,
    score: result.score,
    directionAccuracy: result.directionAccuracy,
  }
}

/**
 * Compute a loss value from evaluation results.
 * Lower is better.
 */
function computeLoss(result: CalibrationEvalResult, avgDailyFlow: number): number {
  const normalizedMae = result.mae / Math.max(avgDailyFlow, 100)
  const directionPenalty = 1 - result.directionAccuracy
  return normalizedMae + directionPenalty * 0.5
}

/**
 * Run bounded grid-search tuning for a user's forecast calibration.
 */
export async function tuneForecastCalibration(
  userId: string,
  movements: TaggedMovement[],
  invoices: OutstandingInvoice[],
  bills: OutstandingBill[],
  entityProfiles: EntityPaymentProfile[] = [],
): Promise<TunerResult | null> {
  if (movements.length < 50) {
    log("calibration.tune.insufficient_data", { userId, count: movements.length }, "forecast")
    return null
  }

  // Compute average daily flow for normalization
  const totalFlow = movements.reduce((sum, m) => sum + m.amount, 0)
  const allDates = movements.map((m) => m.occurred_at.slice(0, 10)).filter(Boolean).sort()
  const spanDays = Math.max(1, daysBetween(allDates[0], allDates[allDates.length - 1]))
  const avgDailyFlow = totalFlow / spanDays

  // Evaluate baseline (default calibration)
  const baselineResult = await evaluateCalibrationOnHistory(movements, invoices, bills, {}, entityProfiles)
  if (!baselineResult) {
    log("calibration.tune.baseline_failed", { userId }, "forecast")
    return null
  }
  const baselineLoss = computeLoss(baselineResult, avgDailyFlow)

  let bestParams: Partial<ForecastCalibrationParams> = {}
  let bestLoss = baselineLoss
  let iterations = 0

  // Grid search over tunable knobs
  for (const knob of TUNABLE_KNOBS) {
    const steps = GRID_STEPS[knob]
    if (!steps) continue

    const bounds = CALIBRATION_BOUNDS[knob]
    for (const value of steps) {
      if (bounds && (value < bounds.min || value > bounds.max)) continue

      const testParams = { ...bestParams, [knob]: value }
      const result = await evaluateCalibrationOnHistory(movements, invoices, bills, testParams, entityProfiles)
      iterations++

      if (result) {
        const loss = computeLoss(result, avgDailyFlow)
        if (loss < bestLoss) {
          bestLoss = loss
          bestParams = testParams
        }
      }
    }
  }

  const improved = bestLoss < baselineLoss * 0.95 // Require 5% improvement
  
  log("calibration.tune.complete", {
    userId,
    improved,
    baselineLoss: baselineLoss.toFixed(4),
    bestLoss: bestLoss.toFixed(4),
    iterations,
    knobsChanged: Object.keys(bestParams).length,
  }, "forecast")

  return {
    improved,
    bestParams,
    trainLoss: bestLoss,
    valLoss: null, // Walk-forward validation not implemented yet
    iterations,
    fitWindowDays: spanDays,
  }
}

/**
 * Run tuning for a user and save results if improved.
 */
export async function runCalibrationTuneJob(userId: string): Promise<{
  success: boolean
  improved: boolean
  message: string
}> {
  try {
    // Fetch user's movement data
    const { rows: movements } = await query<TaggedMovement>(
      `SELECT m.id, m.user_id, m.date AS occurred_at, m.direction, m.amount::float,
              m.currency, m.raw_description, m.counterparty_entity_id AS entity_id
       FROM movements m
       JOIN movement_tags mt ON mt.movement_id = m.id
       WHERE m.user_id = $1 AND m.duplicate_of IS NULL
       ORDER BY m.date ASC`,
      [userId]
    )

    // Fetch invoices and bills using proper queries
    const { rows: invoices } = await query<OutstandingInvoice>(
      `SELECT id as invoice_id, customer_id, amount, due_date, created_at
       FROM outstanding_invoices 
       WHERE user_id = $1 AND due_date >= CURRENT_DATE - INTERVAL '180 days'
       ORDER BY due_date DESC`,
      [userId]
    )
    const { rows: bills } = await query<OutstandingBill>(
      `SELECT id as bill_id, vendor_id, amount, due_date, created_at
       FROM outstanding_bills 
       WHERE user_id = $1 AND due_date >= CURRENT_DATE - INTERVAL '180 days'
       ORDER BY due_date DESC`,
      [userId]
    )

    const result = await tuneForecastCalibration(userId, movements, invoices, bills)
    
    if (!result) {
      return { success: true, improved: false, message: "Insufficient data for tuning" }
    }

    if (result.improved && Object.keys(result.bestParams).length > 0) {
      await saveForecastCalibrationOverride(userId, result.bestParams, "fitted", {
        trainLoss: result.trainLoss,
        valLoss: result.valLoss ?? undefined,
        fitWindowDays: result.fitWindowDays,
        notes: `Grid search over ${result.iterations} iterations`,
      })
      await invalidateForecastCacheForUser(userId)
      return { success: true, improved: true, message: "Calibration improved and saved" }
    }

    return { success: true, improved: false, message: "No improvement found" }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("calibration.tune.error", { userId, error: message }, "error")
    return { success: false, improved: false, message }
  }
}

function daysBetween(a: string, b: string): number {
  const d1 = new Date(a)
  const d2 = new Date(b)
  return Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24))
}
