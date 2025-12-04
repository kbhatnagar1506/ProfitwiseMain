/**
 * Forecast Calibration Loader
 *
 * Loads per-user calibration overrides from the database and merges
 * them with DEFAULT_FORECAST_CALIBRATION.
 */

import { query } from "./db"
import {
  DEFAULT_FORECAST_CALIBRATION,
  mergeCalibration,
  type ForecastCalibrationParams,
} from "./state/forecast-calibration"

export type CalibrationSource = "default" | "fitted" | "manual"

export interface CalibrationOverrideRow {
  user_id: string
  params: Partial<ForecastCalibrationParams>
  source: CalibrationSource
  fitted_at: string | null
  train_loss: number | null
  val_loss: number | null
  fit_window_days: number | null
  notes: string | null
  updated_at: string
}

/**
 * Load the effective calibration for a user.
 * Returns DEFAULT_FORECAST_CALIBRATION merged with any stored overrides.
 */
export async function getForecastCalibrationForUser(
  userId: string
): Promise<{ calibration: ForecastCalibrationParams; source: CalibrationSource }> {
  try {
    const { rows } = await query<CalibrationOverrideRow>(
      `SELECT params, source FROM forecast_calibration_overrides WHERE user_id = $1`,
      [userId]
    )
    if (rows.length > 0 && rows[0].params) {
      const merged = mergeCalibration(DEFAULT_FORECAST_CALIBRATION, rows[0].params)
      return { calibration: merged, source: rows[0].source }
    }
  } catch {
    // Table may not exist yet or query failed; fall back to defaults
  }
  return { calibration: DEFAULT_FORECAST_CALIBRATION, source: "default" }
}

/**
 * Save calibration overrides for a user.
 * Only stores the partial diff from defaults.
 */
export async function saveForecastCalibrationOverride(
  userId: string,
  params: Partial<ForecastCalibrationParams>,
  source: CalibrationSource,
  metrics?: {
    trainLoss?: number
    valLoss?: number
    fitWindowDays?: number
    notes?: string
  }
): Promise<void> {
  const fittedAt = source === "fitted" ? new Date().toISOString() : null
  await query(
    `INSERT INTO forecast_calibration_overrides 
       (user_id, params, source, fitted_at, train_loss, val_loss, fit_window_days, notes, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       params = $2,
       source = $3,
       fitted_at = COALESCE($4, forecast_calibration_overrides.fitted_at),
       train_loss = COALESCE($5, forecast_calibration_overrides.train_loss),
       val_loss = COALESCE($6, forecast_calibration_overrides.val_loss),
       fit_window_days = COALESCE($7, forecast_calibration_overrides.fit_window_days),
       notes = COALESCE($8, forecast_calibration_overrides.notes),
       updated_at = NOW()`,
    [
      userId,
      JSON.stringify(params),
      source,
      fittedAt,
      metrics?.trainLoss ?? null,
      metrics?.valLoss ?? null,
      metrics?.fitWindowDays ?? null,
      metrics?.notes ?? null,
    ]
  )
}

/**
 * Delete calibration overrides for a user (revert to defaults).
 */
export async function deleteForecastCalibrationOverride(userId: string): Promise<void> {
  await query(`DELETE FROM forecast_calibration_overrides WHERE user_id = $1`, [userId])
}

/**
 * Invalidate forecast cache when calibration changes.
 */
export async function invalidateForecastCacheForUser(userId: string): Promise<void> {
  await query(`DELETE FROM forecast_cache WHERE user_id = $1`, [userId])
}
