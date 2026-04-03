import { query } from "@/lib/db"

/**
 * Initialize database schema for refresh jobs and customer matches
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

/**
 * Initialize movement_customer_matches table for storing LLM customer matching results
 */
export async function initializeCustomerMatchesTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS movement_customer_matches (
        movement_id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        matched_customer VARCHAR(255) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_customer_matches_user_id ON movement_customer_matches(user_id)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_customer_matches_created_at ON movement_customer_matches(created_at DESC)
    `)

    console.log("[db-init] movement_customer_matches table initialized successfully")
  } catch (error) {
    console.error("[db-init] Error initializing movement_customer_matches table:", error)
    throw error
  }
}
