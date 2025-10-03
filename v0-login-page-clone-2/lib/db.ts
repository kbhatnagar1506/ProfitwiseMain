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
    personal_finance_category JSONB,
    payment_channel TEXT,
    pending         BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(item_id, transaction_id)
  )
`
const PLAID_WEBHOOK_LAST_SQL = `
  CREATE TABLE IF NOT EXISTS plaid_webhook_last (
    id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    received_at     TIMESTAMPTZ NOT NULL,
    webhook_type    TEXT,
    webhook_code    TEXT,
    item_id         TEXT
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
  await p.query(PLAID_WEBHOOK_LAST_SQL)
  // Add columns for Plaid v2 fields if they don't exist yet
  await p.query("ALTER TABLE plaid_transactions ADD COLUMN IF NOT EXISTS personal_finance_category JSONB")
  await p.query("ALTER TABLE plaid_transactions ADD COLUMN IF NOT EXISTS payment_channel TEXT")
  plaidSchemaEnsured = true
  log("plaid.schema.ensured", undefined, "db")
}

export type PlaidWebhookLast = { received_at: Date; webhook_type: string | null; webhook_code: string | null; item_id: string | null }

export async function updatePlaidWebhookLast(
  receivedAt: Date,
  webhookType: string | null,
  webhookCode: string | null,
  itemId: string | null
): Promise<void> {
  await ensurePlaidSchema()
  const p = await getPoolAsync()
  if (!p) return
  await p.query(
    `INSERT INTO plaid_webhook_last (id, received_at, webhook_type, webhook_code, item_id) VALUES (1, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET received_at = $1, webhook_type = $2, webhook_code = $3, item_id = $4`,
    [receivedAt, webhookType, webhookCode, itemId]
  )
}

export async function getPlaidWebhookLast(): Promise<PlaidWebhookLast | null> {
  await ensurePlaidSchema()
  const { rows } = await query<{ received_at: Date; webhook_type: string | null; webhook_code: string | null; item_id: string | null }>(
    "SELECT received_at, webhook_type, webhook_code, item_id FROM plaid_webhook_last WHERE id = 1"
  )
  return rows[0] ?? null
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

const STRIPE_CONNECTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS stripe_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_user_id  TEXT NOT NULL UNIQUE,
    access_token    TEXT NOT NULL,
    refresh_token   TEXT,
    scope           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )
`

const STRIPE_ENTITIES_SQL = `
  CREATE TABLE IF NOT EXISTS stripe_entities (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_account_id TEXT NOT NULL,
    entity_type       TEXT NOT NULL,
    entity_id         TEXT NOT NULL,
    data              JSONB NOT NULL,
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(stripe_account_id, entity_type, entity_id)
  )
`

const GMAIL_CONNECTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS gmail_connections (
    id              TEXT PRIMARY KEY DEFAULT 'inbox',
    email           TEXT,
    refresh_token   TEXT NOT NULL,
    access_token    TEXT,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )
`

const GMAIL_SYNCED_MESSAGES_SQL = `
  CREATE TABLE IF NOT EXISTS gmail_synced_messages (
    message_id      TEXT PRIMARY KEY,
    thread_id       TEXT,
    from_email      TEXT,
    to_emails       TEXT,
    subject         TEXT,
    date_sent       TIMESTAMPTZ,
    snippet         TEXT,
    body_plain      TEXT,
    labels          JSONB DEFAULT '[]'::jsonb,
    synced_at       TIMESTAMPTZ DEFAULT NOW()
  )
`

let xeroSchemaEnsured = false
let qboSchemaEnsured = false
let stripeSchemaEnsured = false

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
  // Ensure columns exist even if table was created before schema updates
  await p.query("ALTER TABLE qbo_entities ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb")
  await p.query("ALTER TABLE qbo_entities ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb")
  await p.query("ALTER TABLE qbo_entities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()")
  qboSchemaEnsured = true
  log("qbo.schema.ensured", undefined, "qbo")
}

export async function ensureStripeSchema(): Promise<void> {
  if (stripeSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(STRIPE_CONNECTIONS_SQL)
  await p.query(STRIPE_ENTITIES_SQL)
  // Ensure columns exist even if table was created before schema updates
  await p.query(
    "ALTER TABLE stripe_entities ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb"
  )
  await p.query(
    "ALTER TABLE stripe_entities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()"
  )
  stripeSchemaEnsured = true
  log("stripe.schema.ensured", undefined, "stripe")
}

let gmailSchemaEnsured = false

export async function ensureGmailSchema(): Promise<void> {
  if (gmailSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(GMAIL_CONNECTIONS_SQL)
  await p.query(GMAIL_SYNCED_MESSAGES_SQL)
  await p.query("ALTER TABLE gmail_synced_messages ADD COLUMN IF NOT EXISTS processed_for_ap_ar BOOLEAN DEFAULT FALSE")
  await p.query("ALTER TABLE gmail_synced_messages ADD COLUMN IF NOT EXISTS extracted_invoice JSONB")
  await p.query("CREATE INDEX IF NOT EXISTS idx_gmail_synced_unprocessed ON gmail_synced_messages (processed_for_ap_ar) WHERE processed_for_ap_ar = FALSE")
  gmailSchemaEnsured = true
  log("db.gmail.schema.ensured", undefined, "db")
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

const USER_SLACK_SQL = `
  CREATE TABLE IF NOT EXISTS user_slack (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    slack_user_id   TEXT NOT NULL,
    slack_team_id   TEXT NOT NULL,
    bot_token       TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(slack_team_id, slack_user_id)
  )
`

const SLACK_EVENTS_SEEN_SQL = `
  CREATE TABLE IF NOT EXISTS slack_events_seen (
    event_id   TEXT PRIMARY KEY,
    seen_at    TIMESTAMPTZ DEFAULT NOW()
  )
`

let slackSchemaEnsured = false

export async function ensureSlackSchema(): Promise<void> {
  if (slackSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(USER_SLACK_SQL)
  await p.query(SLACK_EVENTS_SEEN_SQL)
  slackSchemaEnsured = true
  log("db.slack.schema.ensured", undefined, "db")
}

// ─── Identity Layer ────────────────────────────────────────────────

const ENTITIES_SQL = `
  CREATE TABLE IF NOT EXISTS entities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL,
    canonical_name  TEXT NOT NULL,
    display_name    TEXT,
    domain          TEXT,
    tax_id          TEXT,
    confidence      REAL DEFAULT 0,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, canonical_name, entity_type)
  )
`

const ENTITY_ALIASES_SQL = `
  CREATE TABLE IF NOT EXISTS entity_aliases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias           TEXT NOT NULL,
    alias_type      TEXT NOT NULL,
    source          TEXT NOT NULL,
    source_id       TEXT,
    confidence      REAL DEFAULT 0.5,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(entity_id, alias, alias_type, source)
  )
`

const ENTITY_RELATIONSHIPS_SQL = `
  CREATE TABLE IF NOT EXISTS entity_relationships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_entity_id  UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    to_entity_id    UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relationship    TEXT NOT NULL,
    confidence      REAL DEFAULT 0.5,
    evidence        JSONB DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(from_entity_id, to_entity_id, relationship)
  )
`

const ACCOUNT_OWNERSHIP_SQL = `
  CREATE TABLE IF NOT EXISTS account_ownership (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    account_type    TEXT NOT NULL,
    account_ref     TEXT NOT NULL,
    source          TEXT NOT NULL,
    confidence      REAL DEFAULT 0.5,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(entity_id, account_type, account_ref)
  )
`

const IDENTITY_ASSERTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS identity_assertions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id       UUID REFERENCES entities(id) ON DELETE SET NULL,
    assertion_type  TEXT NOT NULL,
    source          TEXT NOT NULL,
    source_record   JSONB,
    value           TEXT,
    score           REAL DEFAULT 0.5,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )
`

const IDENTITY_RESOLUTION_DECISIONS_SQL = `
  CREATE TABLE IF NOT EXISTS identity_resolution_decisions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_id       UUID REFERENCES entities(id) ON DELETE SET NULL,
    merged_from     UUID[],
    decision_type   TEXT NOT NULL,
    reason          TEXT,
    assertions_used UUID[],
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )
`

let identitySchemaEnsured = false

export async function ensureIdentitySchema(): Promise<void> {
  if (identitySchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(ENTITIES_SQL)
  await p.query(ENTITY_ALIASES_SQL)
  await p.query(ENTITY_RELATIONSHIPS_SQL)
  await p.query(ACCOUNT_OWNERSHIP_SQL)
  await p.query(IDENTITY_ASSERTIONS_SQL)
  await p.query(IDENTITY_RESOLUTION_DECISIONS_SQL)
  await p.query("CREATE INDEX IF NOT EXISTS idx_entities_user ON entities (user_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity ON entity_aliases (entity_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases (alias, alias_type)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_identity_assertions_entity ON identity_assertions (entity_id)")
  identitySchemaEnsured = true
  log("identity.schema.ensured", undefined, "db")
}

// ─── Money Movement Layer (v5 — canonical + observations) ──────────

const MOVEMENTS_V5_MIGRATE_SQL = `
  DO $$
  BEGIN
    -- Drop old monolithic movements table if it has the old schema
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='movements' AND column_name='evidence_hash') THEN
      DROP TABLE IF EXISTS movement_observations CASCADE;
      DROP TABLE IF EXISTS movement_families CASCADE;
      DROP TABLE movements CASCADE;
    END IF;
    -- Also drop the ancient v1 schema
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='movements' AND column_name='movement_class') THEN
      DROP TABLE movements CASCADE;
    END IF;
  END$$;
`

const MOVEMENTS_V5_SQL = `
  CREATE TABLE IF NOT EXISTS movements (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    direction                 TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
    amount                    NUMERIC NOT NULL,
    date                      DATE NOT NULL,
    movement_type             TEXT NOT NULL,
    pnl_eligible              BOOLEAN NOT NULL DEFAULT false,
    provenance                TEXT NOT NULL DEFAULT 'bank_observed',
    cash_account_id           TEXT,
    counterparty              TEXT,
    counterparty_entity_id    UUID REFERENCES entities(id) ON DELETE SET NULL,
    counterparty_entity_type  TEXT,
    linked_internal_account_id TEXT,
    confidence                JSONB NOT NULL DEFAULT '{"score":0.5}'::jsonb,
    review_needed             BOOLEAN NOT NULL DEFAULT false,
    raw_description           TEXT,
    metadata                  JSONB DEFAULT '{}'::jsonb,
    created_at                TIMESTAMPTZ DEFAULT NOW()
  )
`

const MOVEMENT_OBSERVATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS movement_observations (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movement_id       UUID NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
    source            TEXT NOT NULL,
    source_type       TEXT NOT NULL,
    source_id         TEXT NOT NULL,
    amount            NUMERIC NOT NULL,
    date              DATE NOT NULL,
    raw_description   TEXT,
    counterparty      TEXT,
    account_name      TEXT,
    account_id        TEXT,
    account_type      TEXT,
    account_subtype   TEXT,
    metadata          JSONB DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(source, source_id)
  )
`

const MOVEMENT_FAMILIES_SQL = `
  CREATE TABLE IF NOT EXISTS movement_families (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_key        TEXT NOT NULL,
    pattern           TEXT NOT NULL,
    account           TEXT,
    direction         TEXT NOT NULL,
    dominant_type     TEXT NOT NULL,
    dominant_confidence REAL NOT NULL DEFAULT 0.5,
    occurrence_count  INT NOT NULL DEFAULT 0,
    last_seen         DATE,
    metadata          JSONB DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, family_key)
  )
`

let movementsSchemaEnsured = false

export async function ensureMovementsSchema(): Promise<void> {
  if (movementsSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await ensureIdentitySchema()
  await p.query(MOVEMENTS_V5_MIGRATE_SQL)
  await p.query(MOVEMENTS_V5_SQL)
  await p.query(MOVEMENT_OBSERVATIONS_SQL)
  await p.query(MOVEMENT_FAMILIES_SQL)
  // Phase 0 freeze: add currency and coalesced_group_id
  await p.query("ALTER TABLE movements ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD'")
  await p.query("ALTER TABLE movements ADD COLUMN IF NOT EXISTS coalesced_group_id TEXT")
  await p.query("ALTER TABLE movements ADD COLUMN IF NOT EXISTS duplicate_of UUID REFERENCES movements(id) ON DELETE SET NULL")
  await p.query("CREATE INDEX IF NOT EXISTS idx_movements_user ON movements (user_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_movements_type ON movements (user_id, movement_type)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_movements_pnl ON movements (user_id, pnl_eligible)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_movements_entity ON movements (counterparty_entity_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_movements_review ON movements (user_id, review_needed)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_movements_date ON movements (user_id, date)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_movements_provenance ON movements (user_id, provenance)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_obs_movement ON movement_observations (movement_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_obs_source ON movement_observations (source, source_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_families_user ON movement_families (user_id)")
  // Phase 1: movement_tags table
  await p.query(`
    CREATE TABLE IF NOT EXISTS movement_tags (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      movement_id       UUID NOT NULL REFERENCES movements(id) ON DELETE CASCADE UNIQUE,
      economic_class    TEXT NOT NULL,
      cashflow_bucket   TEXT NOT NULL,
      counterparty_role TEXT NOT NULL,
      tag_data          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await p.query("CREATE INDEX IF NOT EXISTS idx_tags_movement ON movement_tags (movement_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_tags_eclass ON movement_tags (economic_class)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_tags_bucket ON movement_tags (cashflow_bucket)")
  // State snapshots for prior-state comparison and rolling averages
  await p.query(`
    CREATE TABLE IF NOT EXISTS state_snapshots (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      period_start      DATE,
      period_end        DATE,
      revenue_state     JSONB,
      spend_state       JSONB,
      liquidity_state   JSONB,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await p.query("CREATE INDEX IF NOT EXISTS idx_state_snapshots_user ON state_snapshots (user_id, snapshot_at DESC)")
  // AR/AP to Payments mapping: allocation records
  await p.query(`
    CREATE TABLE IF NOT EXISTS movement_allocations (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      movement_id       UUID NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
      entity_type       TEXT NOT NULL CHECK (entity_type IN ('ar', 'ap')),
      entity_id         TEXT NOT NULL,
      gross_applied     NUMERIC NOT NULL,
      fee_amount        NUMERIC NOT NULL DEFAULT 0,
      net_applied       NUMERIC NOT NULL,
      confidence        REAL NOT NULL DEFAULT 0.5,
      match_method      TEXT NOT NULL DEFAULT 'tolerance' CHECK (match_method IN ('exact', 'tolerance', 'llm_suggested', 'manual')),
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await p.query("CREATE INDEX IF NOT EXISTS idx_allocations_movement ON movement_allocations (movement_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_allocations_entity ON movement_allocations (entity_type, entity_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_allocations_user ON movement_allocations (user_id)")
  movementsSchemaEnsured = true
  log("movements.schema.ensured", undefined, "db")
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
