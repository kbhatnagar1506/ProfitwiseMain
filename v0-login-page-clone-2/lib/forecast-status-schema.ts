import { query } from "@/lib/db"
import { log } from "@/lib/logger"

/**
 * Ensure forecast_computation_status table exists
 * Tracks the status of forecast computations for polling
 */
export async function ensureForecastStatusSchema() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS forecast_computation_status (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'idle',
        llm_processing_complete BOOLEAN NOT NULL DEFAULT false,
        computed_at TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        error_message TEXT
      )
    `)

    // Create index for faster lookups
    await query(`
      CREATE INDEX IF NOT EXISTS idx_forecast_status_user_id 
      ON forecast_computation_status(user_id)
    `)

    log("forecast.status.schema.ensured")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("forecast.status.schema.error", { error: message })
  }
}
