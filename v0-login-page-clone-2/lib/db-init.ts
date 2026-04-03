import { query } from "@/lib/db"

/**
 * Initialize database schema for refresh jobs
 * Run this once during deployment or app startup
 */
export async function initializeRefreshJobsTable() {
  try {
    // Create refresh_jobs table if it doesn't exist
    await query(`
      CREATE TABLE IF NOT EXISTS refresh_jobs (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        error_message TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)

    // Create indexes
    await query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_jobs_user_id ON refresh_jobs(user_id)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_jobs_status ON refresh_jobs(status)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_jobs_created_at ON refresh_jobs(created_at DESC)
    `)

    console.log("[db-init] refresh_jobs table initialized successfully")
  } catch (error) {
    console.error("[db-init] Error initializing refresh_jobs table:", error)
    throw error
  }
}
