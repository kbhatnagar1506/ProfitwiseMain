#!/usr/bin/env node
/**
 * One-off check: did we receive and save the Gmail connection?
 * Uses DATABASE_URL only (same SSL behavior as lib/db.ts for direct URL).
 * If you use GCP Cloud SQL Connector (INSTANCE_CONNECTION_NAME, etc.) with no DATABASE_URL,
 * check the dashboard Gmail section or /api/gmail/status while logged in.
 * Run locally: DATABASE_URL="..." node scripts/check-gmail-connection.mjs
 */
import pg from "pg"
const { Pool } = pg

let conn = process.env.DATABASE_URL
if (!conn) {
  console.error("DATABASE_URL not set (app may use GCP Cloud SQL Connector instead; check dashboard Gmail section).")
  process.exit(1)
}

// Match lib/db.ts: for non-local, add uselibpqcompat and sslmode so Cloud SQL / GCP DB works
const isLocal = conn.includes("localhost") || conn.includes("127.0.0.1")
if (!isLocal) {
  if (!conn.includes("uselibpqcompat=true")) conn = conn.includes("?") ? `${conn}&uselibpqcompat=true` : `${conn}?uselibpqcompat=true`
  if (!conn.includes("sslmode=")) conn = conn.includes("?") ? `${conn}&sslmode=require` : `${conn}?sslmode=require`
}
const pool = new Pool({ connectionString: conn, ssl: isLocal ? false : { rejectUnauthorized: false } })
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
