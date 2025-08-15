/**
 * Postgres client for auth (users, sessions). Used only by lib/auth.
 * Supports:
 * - Cloud SQL Node.js Connector (service account): set INSTANCE_CONNECTION_NAME, DB_USER, DB_PASS, DB_NAME, and optionally GOOGLE_APPLICATION_CREDENTIALS_JSON.
 * - Direct URL: set DATABASE_URL (e.g. postgres://user:pass@host:5432/db).
 */

import { Pool } from "pg"
import { Connector } from "@google-cloud/cloud-sql-connector"
import { log } from "./logger"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

let pool: Pool | null = null
let poolPromise: Promise<Pool | null> | null = null
let connector: Connector | null = null

function setupServiceAccountCredentials(): void {
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  if (!json || process.env.GOOGLE_APPLICATION_CREDENTIALS) return
  try {
    const dir = join(tmpdir(), "gcp-credentials")
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 })
    const file = join(dir, "credentials.json")
    writeFileSync(file, json, { mode: 0o600 })
    process.env.GOOGLE_APPLICATION_CREDENTIALS = file
  } catch {
    // ignore
  }
}

async function createPoolWithConnector(): Promise<Pool> {
  const instanceConnectionName = process.env.INSTANCE_CONNECTION_NAME!
  const dbUser = process.env.DB_USER!
  const dbPass = process.env.DB_PASS!
  const dbName = process.env.DB_NAME!
  setupServiceAccountCredentials()
  const c = new Connector()
  connector = c
  const clientOpts = await c.getOptions({
    instanceConnectionName,
    ipType: (process.env.CLOUD_SQL_IP_TYPE as "PUBLIC" | "PRIVATE") || "PUBLIC",
  })
  return new Pool({
    ...clientOpts,
    user: dbUser,
    password: dbPass,
    database: dbName,
    max: 5,
  })
}

function createPoolWithUrl(): Pool | null {
  let url = process.env.DATABASE_URL
  if (!url) return null
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1")
  if (!isLocal) {
    // Ensure libpq-compat SSL so sslmode=require → rejectUnauthorized: false (avoids UNABLE_TO_VERIFY_LEAF_SIGNATURE with Cloud SQL)
    const hasCompat = url.includes("uselibpqcompat=true")
    const hasSsl = url.includes("sslmode=")
    const parts: string[] = []
    if (!hasCompat) parts.push("uselibpqcompat=true")
    if (!hasSsl) parts.push("sslmode=require")
    if (parts.length) {
      const params = parts.join("&")
      url = url.includes("?") ? `${url}&${params}` : `${url}?${params}`
    }
  }
  return new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  })
}

async function getPoolAsync(): Promise<Pool | null> {
  if (process.env.NODE_ENV !== "production") return null
  if (pool) return pool
  if (!poolPromise) {
    poolPromise = (async () => {
      if (process.env.INSTANCE_CONNECTION_NAME && process.env.DB_USER && process.env.DB_PASS && process.env.DB_NAME) {
        try {
          pool = await createPoolWithConnector()
          return pool
        } catch (err) {
          log("db.connector.failed", { pgErr: err && typeof err === "object" && "code" in err ? (err as { code: string }).code : undefined }, "db")
          throw err
        }
      }
      pool = createPoolWithUrl()
      return pool
    })()
  }
  return poolPromise
}

function getPool(): Pool | null {
  return pool
}

const USERS_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )
`

const SESSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token        TEXT UNIQUE NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL
  )
`

let authSchemaEnsured = false

export async function ensureAuthSchema(): Promise<void> {
  if (authSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await p.query(USERS_SQL)
  await p.query(SESSIONS_SQL)
  await p.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_step INTEGER DEFAULT 1")
  await p.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS final_context TEXT")
  await p.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS company_form JSONB DEFAULT '{}'::jsonb")
  authSchemaEnsured = true
  log("auth.schema.ensured", undefined, "db")
}

const PLAID_ITEMS_SQL = `
  CREATE TABLE IF NOT EXISTS plaid_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id       TEXT NOT NULL UNIQUE,
    access_token  TEXT NOT NULL,
    cursor        TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )
`
const PLAID_ACCOUNTS_SQL = `
  CREATE TABLE IF NOT EXISTS plaid_accounts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id            TEXT NOT NULL REFERENCES plaid_items(item_id) ON DELETE CASCADE,
    account_id         TEXT NOT NULL,
    name               TEXT,
    type               TEXT,
    subtype            TEXT,
    mask               TEXT,
    current_balance    NUMERIC,
    available_balance  NUMERIC,
    currency_code      TEXT,
    updated_at         TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(item_id, account_id)
  )
`
const PLAID_TRANSACTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS plaid_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id         TEXT NOT NULL REFERENCES plaid_items(item_id) ON DELETE CASCADE,
    account_id      TEXT NOT NULL,
    transaction_id  TEXT NOT NULL,
    amount          NUMERIC NOT NULL,
    date            DATE NOT NULL,
    name            TEXT,
    merchant_name   TEXT,
    category        JSONB,
    pending         BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(item_id, transaction_id)
  )
`

let plaidSchemaEnsured = false

export async function ensurePlaidSchema(): Promise<void> {
  if (plaidSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(PLAID_ITEMS_SQL)
  await p.query(PLAID_ACCOUNTS_SQL)
  await p.query(PLAID_TRANSACTIONS_SQL)
  plaidSchemaEnsured = true
  log("plaid.schema.ensured", undefined, "db")
}

const XERO_CONNECTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS xero_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id       TEXT NOT NULL UNIQUE,
    tenant_name     TEXT,
    refresh_token   TEXT NOT NULL,
    access_token    TEXT,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )
`
const XERO_ENTITIES_SQL = `
  CREATE TABLE IF NOT EXISTS xero_entities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL REFERENCES xero_connections(tenant_id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    data            JSONB NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, entity_type, entity_id)
  )
`
const QBO_CONNECTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS qbo_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    realm_id        TEXT NOT NULL UNIQUE,
    company_name    TEXT,
    refresh_token   TEXT NOT NULL,
    access_token    TEXT,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )
`
const QBO_ENTITIES_SQL = `
  CREATE TABLE IF NOT EXISTS qbo_entities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    realm_id        TEXT NOT NULL REFERENCES qbo_connections(realm_id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    data            JSONB NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(realm_id, entity_type, entity_id)
  )
`
const QBO_SYNC_STATUS_SQL = `
  CREATE TABLE IF NOT EXISTS qbo_sync_status (
    realm_id           TEXT PRIMARY KEY REFERENCES qbo_connections(realm_id) ON DELETE CASCADE,
    last_full_sync_at  TIMESTAMPTZ,
    status             TEXT NOT NULL DEFAULT 'idle',
    error_message      TEXT,
    updated_at         TIMESTAMPTZ DEFAULT NOW()
  )
`

let xeroSchemaEnsured = false
let qboSchemaEnsured = false

export async function ensureXeroSchema(): Promise<void> {
  if (xeroSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(XERO_CONNECTIONS_SQL)
  await p.query(XERO_ENTITIES_SQL)
  await p.query("ALTER TABLE xero_entities ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb")
  await p.query("ALTER TABLE xero_entities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()")
  // Ensure unique constraint exists for ON CONFLICT (tenant_id, entity_type, entity_id); fixes tables created before UNIQUE was in schema
  await p.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS xero_entities_tenant_type_id_key ON xero_entities (tenant_id, entity_type, entity_id)"
  )
  xeroSchemaEnsured = true
  log("xero.schema.ensured", undefined, "xero")
}

export async function ensureQBOSchema(): Promise<void> {
  if (qboSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(QBO_CONNECTIONS_SQL)
  await p.query(QBO_ENTITIES_SQL)
  await p.query(QBO_SYNC_STATUS_SQL)
  await p.query("ALTER TABLE qbo_entities ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb")
  await p.query("ALTER TABLE qbo_entities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()")
  qboSchemaEnsured = true
  log("qbo.schema.ensured", undefined, "qbo")
}

const MERCHANT_TAGS_SQL = `
  CREATE TABLE IF NOT EXISTS merchant_tags (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id        TEXT NOT NULL,
    raw_name         TEXT NOT NULL,
    normalized_name  TEXT NOT NULL,
    tag              TEXT NOT NULL,
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, account_id, raw_name)
  )
`

let merchantTagsSchemaEnsured = false

export async function ensureMerchantTagsSchema(): Promise<void> {
  if (merchantTagsSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(MERCHANT_TAGS_SQL)
  await p.query("ALTER TABLE merchant_tags ADD COLUMN IF NOT EXISTS transaction_type TEXT NOT NULL DEFAULT 'One-time'")
  await p.query("ALTER TABLE merchant_tags ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 0.5")
  merchantTagsSchemaEnsured = true
  log("db.merchant_tags.schema.ensured", undefined, "db")
}

const USER_WHATSAPP_SQL = `
  CREATE TABLE IF NOT EXISTS user_whatsapp (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    phone_e164    TEXT NOT NULL UNIQUE,
    verified_at   TIMESTAMPTZ,
    otp_code      TEXT,
    otp_expires_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )
`

let whatsappSchemaEnsured = false

export async function ensureWhatsAppSchema(): Promise<void> {
  if (whatsappSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(USER_WHATSAPP_SQL)
  whatsappSchemaEnsured = true
  log("db.whatsapp.schema.ensured", undefined, "db")
}

export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[] }> {
  const p = await getPoolAsync()
  if (!p) throw new Error("Database is only available in production")
  const result = await p.query(text, params)
  return { rows: (result.rows ?? []) as T[] }
}
