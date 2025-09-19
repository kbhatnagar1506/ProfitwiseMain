#!/usr/bin/env node
/**
 * One-off check: did we receive and save the Gmail connection?
 * Run locally: DATABASE_URL="..." node scripts/check-gmail-connection.mjs
 * On Heroku:  heroku run "cd v0-login-page-clone-2 && node scripts/check-gmail-connection.mjs" --app profitwise-login-page
 */
import pg from "pg"
const { Pool } = pg

const conn = process.env.DATABASE_URL
if (!conn) {
  console.error("DATABASE_URL not set")
  process.exit(1)
}

const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: true } })
try {
  const res = await pool.query(
    "SELECT id, email, refresh_token IS NOT NULL AS has_refresh, access_token IS NOT NULL AS has_access, expires_at FROM gmail_connections"
  )
  if (res.rows.length === 0) {
    console.log("No Gmail connection stored yet (gmail_connections is empty).")
  } else {
    console.log("Gmail connection(s):")
    for (const row of res.rows) {
      console.log(JSON.stringify({ id: row.id, email: row.email, has_refresh: row.has_refresh, has_access: row.has_access, expires_at: row.expires_at }, null, 2))
    }
  }
} catch (e) {
  if (e.code === "42P01") {
    console.log("Table gmail_connections does not exist yet (no connection attempted or schema not run).")
  } else {
    console.error(e)
    process.exit(1)
  }
} finally {
  await pool.end()
}
