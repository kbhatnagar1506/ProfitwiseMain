#!/usr/bin/env node
/**
 * Inspect recently synced Gmail messages in gmail_synced_messages.
 * Uses DATABASE_URL (direct URL to your GCP Postgres).
 *
 * Run on Heroku:
 *   heroku run "cd web && node scripts/peek-gmail-synced.mjs" --app profitwise-login-page
 */

import pg from "pg"
const { Pool } = pg

let conn = process.env.DATABASE_URL
if (!conn) {
  console.error("DATABASE_URL not set")
  process.exit(1)
}

const isLocal = conn.includes("localhost") || conn.includes("127.0.0.1")
if (!isLocal) {
  if (!conn.includes("uselibpqcompat=true")) {
    conn = conn.includes("?") ? `${conn}&uselibpqcompat=true` : `${conn}?uselibpqcompat=true`
  }
  if (!conn.includes("sslmode=")) {
    conn = conn.includes("?") ? `${conn}&sslmode=require` : `${conn}?sslmode=require`
  }
}

const pool = new Pool({
  connectionString: conn,
  ssl: isLocal ? false : { rejectUnauthorized: false },
})

try {
  const res = await pool.query(
    `SELECT message_id, from_email, to_emails, subject, date_sent, snippet, synced_at
     FROM gmail_synced_messages
     ORDER BY synced_at DESC
     LIMIT 5`
  )
  if (res.rows.length === 0) {
    console.log("No rows in gmail_synced_messages yet.")
  } else {
    console.log(JSON.stringify(res.rows, null, 2))
  }
} catch (e) {
  console.error("Error querying gmail_synced_messages:", e)
  process.exit(1)
} finally {
  await pool.end()
}

