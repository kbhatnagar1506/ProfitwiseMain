/**
 * Postgres client for auth (users, sessions). Used only by lib/auth.
 * Supports:
 * - Cloud SQL Node.js Connector (service account): set INSTANCE_CONNECTION_NAME, DB_USER, DB_PASS, DB_NAME, and optionally GOOGLE_APPLICATION_CREDENTIALS_JSON.
 * - Direct URL: set DATABASE_URL (e.g. postgres://user:pass@host:5432/db).
 */

import { Pool, type PoolClient } from "pg"
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
      let p: Pool | null = null
      if (process.env.INSTANCE_CONNECTION_NAME && process.env.DB_USER && process.env.DB_PASS && process.env.DB_NAME) {
        try {
          p = await createPoolWithConnector()
        } catch (err) {
          log("db.connector.failed", { pgErr: err && typeof err === "object" && "code" in err ? (err as { code: string }).code : undefined }, "db")
          throw err
        }
      } else {
        p = createPoolWithUrl()
      }
      if (p) {
        p.on("error", (err) => {
          log("db.pool.idle_client_error", { error: err.message }, "db")
        })
      }
      pool = p
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

const SHOPIFY_CONNECTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS shopify_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shop_domain     TEXT NOT NULL,
    access_token    TEXT NOT NULL,
    scope           TEXT,
    granted_scopes  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    missing_scopes  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, shop_domain)
  )
`

const SHOPIFY_ENTITIES_SQL = `
  CREATE TABLE IF NOT EXISTS shopify_entities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shop_domain     TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    data            JSONB NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(shop_domain, entity_type, entity_id)
  )
`

const SHOPIFY_SYNC_STATE_SQL = `
  CREATE TABLE IF NOT EXISTS shopify_sync_state (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shop_domain     TEXT NOT NULL,
    resource        TEXT NOT NULL,
    cursor_at       TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, shop_domain, resource)
  )
`

const GMAIL_CONNECTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS gmail_connections (
    id              TEXT PRIMARY KEY DEFAULT 'inbox',
    user_id         UUID,
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
    user_id         UUID,
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
let shopifySchemaEnsured = false

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

export async function ensureShopifySchema(): Promise<void> {
  if (shopifySchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(SHOPIFY_CONNECTIONS_SQL)
  await p.query(SHOPIFY_ENTITIES_SQL)
  await p.query(SHOPIFY_SYNC_STATE_SQL)
  // Ensure columns/constraints exist for legacy installs
  await p.query("ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS scope TEXT")
  await p.query("ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS granted_scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]")
  await p.query("ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS missing_scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]")
  await p.query("CREATE UNIQUE INDEX IF NOT EXISTS shopify_connections_user_shop_key ON shopify_connections (user_id, shop_domain)")
  await p.query("ALTER TABLE shopify_entities ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb")
  await p.query("ALTER TABLE shopify_entities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()")
  await p.query("CREATE INDEX IF NOT EXISTS idx_shopify_entities_user_shop ON shopify_entities (user_id, shop_domain, entity_type)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_shopify_sync_state_user_shop ON shopify_sync_state (user_id, shop_domain)")
  shopifySchemaEnsured = true
  log("shopify.schema.ensured", undefined, "shopify")
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
  await p.query("ALTER TABLE gmail_synced_messages ADD COLUMN IF NOT EXISTS user_id UUID")
  await p.query("ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS user_id UUID")
  await p.query("CREATE INDEX IF NOT EXISTS idx_gmail_synced_unprocessed ON gmail_synced_messages (processed_for_ap_ar) WHERE processed_for_ap_ar = FALSE")
  await p.query("CREATE INDEX IF NOT EXISTS idx_gmail_synced_user ON gmail_synced_messages (user_id)")
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
      user_id           UUID REFERENCES users(id) ON DELETE CASCADE,
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
  // Add user_id column if it doesn't exist (migration for existing tables)
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE movement_tags ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `)
  // Create index on user_id AFTER ensuring the column exists
  await p.query("CREATE INDEX IF NOT EXISTS idx_tags_user ON movement_tags (user_id)")
  // Backfill user_id from movements table for existing rows
  await p.query(`
    UPDATE movement_tags mt
    SET user_id = m.user_id
    FROM movements m
    WHERE mt.movement_id = m.id AND mt.user_id IS NULL
  `)
  // State snapshots for prior-state comparison and rolling averages
  await p.query(`
    CREATE TABLE IF NOT EXISTS state_snapshots (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      snapshot_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      period_start      DATE,
      period_end        DATE,
      revenue_state     JSONB,
      spend_state       JSONB,
      liquidity_state   JSONB,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // Add unique constraint if it doesn't exist (for existing tables)
  await p.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name = 'state_snapshots' AND constraint_type = 'UNIQUE' AND constraint_name = 'state_snapshots_user_id_key'
      ) THEN
        ALTER TABLE state_snapshots ADD UNIQUE (user_id);
      END IF;
    END $$;
  `)
  await p.query("CREATE INDEX IF NOT EXISTS idx_state_snapshots_user ON state_snapshots (user_id, snapshot_at DESC)")
  // AR/AP/Fee/Transfer allocation records (1 movement → many allocations)
  await p.query(`
    CREATE TABLE IF NOT EXISTS movement_allocations (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      movement_id       UUID NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
      entity_type       TEXT NOT NULL CHECK (entity_type IN ('ar', 'ap', 'fee', 'transfer', 'unknown')),
      entity_id         TEXT NOT NULL,
      gross_applied     NUMERIC NOT NULL DEFAULT 0,
      fee_amount        NUMERIC NOT NULL DEFAULT 0,
      net_applied       NUMERIC NOT NULL,
      confidence        REAL NOT NULL DEFAULT 0.5,
      match_method      TEXT NOT NULL DEFAULT 'tolerance' CHECK (match_method IN ('exact', 'tolerance', 'llm_suggested', 'manual', 'stripe_payout_match')),
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await p.query("ALTER TABLE movement_allocations ADD COLUMN IF NOT EXISTS source_id TEXT")
  await p.query("ALTER TABLE movement_allocations ADD COLUMN IF NOT EXISTS synthetic_invoice BOOLEAN NOT NULL DEFAULT false")
  await p.query("ALTER TABLE movement_allocations ADD COLUMN IF NOT EXISTS reconcile_at TIMESTAMPTZ")
  await p.query("ALTER TABLE movement_allocations DROP CONSTRAINT IF EXISTS movement_allocations_match_method_check")
  try {
    await p.query(`
      ALTER TABLE movement_allocations ADD CONSTRAINT movement_allocations_match_method_check
      CHECK (match_method IN ('exact', 'tolerance', 'llm_suggested', 'manual', 'stripe_payout_match'))
    `)
  } catch (err) {
    // Constraint may already exist, ignore
  }
  await p.query("ALTER TABLE movement_allocations DROP CONSTRAINT IF EXISTS movement_allocations_entity_type_check")
  try {
    await p.query(`
      ALTER TABLE movement_allocations ADD CONSTRAINT movement_allocations_entity_type_check
      CHECK (entity_type IN ('ar', 'ap', 'fee', 'transfer', 'unknown'))
    `)
  } catch (err) {
    // Constraint may already exist, ignore
  }
  // Entity payment memory: per-entity payment behavior for allocation scoring
  await p.query(`
    CREATE TABLE IF NOT EXISTS entity_payment_profiles (
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entity_id         UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      avg_payment_ratio REAL NOT NULL DEFAULT 1,
      avg_delay_days    REAL NOT NULL DEFAULT 0,
      payment_count     INT NOT NULL DEFAULT 0,
      variance          REAL NOT NULL DEFAULT 0,
      last_updated      TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, entity_id)
    )
  `)
  await p.query("CREATE INDEX IF NOT EXISTS idx_allocations_movement ON movement_allocations (movement_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_allocations_entity ON movement_allocations (entity_type, entity_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_allocations_user ON movement_allocations (user_id)")
  // Attribution core: canonical cash decomposition per movement (replaces allocations as SSOT for new writes)
  await p.query(`
    CREATE TABLE IF NOT EXISTS movement_attributions (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      movement_id           UUID NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
      component_type        TEXT NOT NULL CHECK (component_type IN ('ar', 'ap', 'fee', 'transfer', 'settlement', 'unknown')),
      entity_id             TEXT NOT NULL,
      reference_id          TEXT,
      gross_amount          NUMERIC NOT NULL DEFAULT 0,
      net_amount            NUMERIC NOT NULL,
      confidence            REAL NOT NULL DEFAULT 0.5,
      source                TEXT NOT NULL DEFAULT 'rule' CHECK (source IN ('rule', 'model', 'llm', 'user')),
      metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
      confidence_detail     JSONB,
      migrated_from_allocation_id UUID,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await p.query("ALTER TABLE movement_attributions ADD COLUMN IF NOT EXISTS migrated_from_allocation_id UUID")
  await p.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_attributions_migrated_alloc_unique ON movement_attributions (migrated_from_allocation_id) WHERE migrated_from_allocation_id IS NOT NULL",
  )
  await p.query("CREATE INDEX IF NOT EXISTS idx_attributions_movement ON movement_attributions (movement_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_attributions_user ON movement_attributions (user_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_attributions_component_entity ON movement_attributions (component_type, entity_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_attributions_user_component ON movement_attributions (user_id, component_type)")
  // Clean up duplicate attributions before creating unique indexes
  // Keep only the most recent attribution for each (movement_id, component_type, entity_id, source) combination
  try {
    const delResult = await p.query(`
      DELETE FROM movement_attributions a
      USING movement_attributions b
      WHERE a.movement_id = b.movement_id
        AND a.component_type = b.component_type
        AND a.entity_id = b.entity_id
        AND a.source = b.source
        AND (a.reference_id IS NULL AND b.reference_id IS NULL)
        AND a.created_at < b.created_at
    `)
    if (delResult.rowCount && delResult.rowCount > 0) {
      log("attributions.duplicates.cleaned", { removed: delResult.rowCount }, "db")
    }
  } catch (e) {
    log("attributions.duplicates.cleanup.error", { err: String(e) }, "db")
  }
  try {
    const delResult2 = await p.query(`
      DELETE FROM movement_attributions a
      USING movement_attributions b
      WHERE a.movement_id = b.movement_id
        AND a.component_type = b.component_type
        AND a.reference_id = b.reference_id
        AND a.source = b.source
        AND a.reference_id IS NOT NULL
        AND a.created_at < b.created_at
    `)
    if (delResult2.rowCount && delResult2.rowCount > 0) {
      log("attributions.ref.duplicates.cleaned", { removed: delResult2.rowCount }, "db")
    }
  } catch (e) {
    log("attributions.ref.duplicates.cleanup.error", { err: String(e) }, "db")
  }
  // Unique indexes to prevent duplicate attributions
  try {
    await p.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attributions_movement_entity_unique 
      ON movement_attributions (movement_id, component_type, entity_id, source) 
      WHERE reference_id IS NULL
    `)
  } catch (e) {
    log("attributions.unique.index.error", { err: String(e) }, "db")
  }
  try {
    await p.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attributions_movement_ref_unique 
      ON movement_attributions (movement_id, component_type, reference_id, source) 
      WHERE reference_id IS NOT NULL
    `)
  } catch (e) {
    log("attributions.ref.unique.index.error", { err: String(e) }, "db")
  }
  // Cash events bridge (forecast / decisions)
  await p.query(`
    CREATE TABLE IF NOT EXISTS cash_events (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entity_id             TEXT NOT NULL,
      event_type            TEXT NOT NULL CHECK (event_type IN ('ar', 'ap', 'settlement')),
      amount                NUMERIC NOT NULL,
      probability           REAL NOT NULL DEFAULT 1,
      expected_date         DATE NOT NULL,
      source                TEXT NOT NULL CHECK (source IN ('invoice', 'inferred', 'model', 'attribution')),
      movement_id           UUID REFERENCES movements(id) ON DELETE SET NULL,
      attribution_id        UUID REFERENCES movement_attributions(id) ON DELETE SET NULL,
      metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await p.query("CREATE INDEX IF NOT EXISTS idx_cash_events_user_date ON cash_events (user_id, expected_date)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_cash_events_entity ON cash_events (user_id, entity_id)")
  // AR/AP lifecycle + stable upsert key (reconciliation waterfall)
  await p.query("ALTER TABLE cash_events ADD COLUMN IF NOT EXISTS outstanding_amount NUMERIC")
  await p.query("ALTER TABLE cash_events ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open'")
  await p.query("ALTER TABLE cash_events ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ")
  await p.query(`
    UPDATE cash_events SET outstanding_amount = amount WHERE outstanding_amount IS NULL
  `)
  await p.query(`
    UPDATE cash_events SET status = CASE
      WHEN COALESCE(outstanding_amount, amount, 0) <= 0 THEN 'paid'
      WHEN COALESCE(outstanding_amount, amount) < amount THEN 'partially_paid'
      ELSE 'open'
    END
    WHERE status IS NULL OR status = ''
  `)
  try {
    await p.query(`
      ALTER TABLE cash_events ADD CONSTRAINT cash_events_status_check
      CHECK (status IN ('open', 'partially_paid', 'paid'))
    `)
  } catch {
    /* constraint may already exist */
  }
  try {
    const del = await p.query(`
      DELETE FROM cash_events ce
      WHERE EXISTS (
        SELECT 1 FROM cash_events ce2
        WHERE ce2.user_id = ce.user_id AND ce2.event_type = ce.event_type AND ce2.entity_id = ce.entity_id
          AND ce2.id < ce.id
      )
    `)
    if (del.rowCount && del.rowCount > 0) {
      log("cash_events.deduped", { removed: del.rowCount }, "db")
    }
  } catch (e) {
    log("cash_events.dedupe.error", { err: String(e) }, "db")
  }
  await p.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_events_user_event_entity
    ON cash_events (user_id, event_type, entity_id)
  `)
  // Extend entity payment profiles (cash graph v1)
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS total_inflow NUMERIC NOT NULL DEFAULT 0")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS total_outflow NUMERIC NOT NULL DEFAULT 0")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS avg_payment_amount NUMERIC NOT NULL DEFAULT 0")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS reliability_score REAL NOT NULL DEFAULT 0.5")

  // Extended entity profile columns for forecasting (Phase 1 of Entity Profiling)
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS entity_type TEXT")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS archetype TEXT")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS first_transaction_date DATE")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS last_transaction_date DATE")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS days_since_last_transaction INT")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS transaction_count INT DEFAULT 0")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS avg_days_to_pay REAL")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS std_days_to_pay REAL")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS on_time_payment_rate REAL")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS early_payment_rate REAL")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS avg_days_early_late REAL")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS std_transaction_amount NUMERIC")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS largest_transaction NUMERIC")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS smallest_transaction NUMERIC")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS amount_trend TEXT")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS avg_interval_days REAL")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS interval_cv REAL")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS transactions_per_month REAL")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS peak_months INT[]")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS low_months INT[]")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS month_weights REAL[]")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS lifetime_value NUMERIC")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS outstanding_amount NUMERIC")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS overdue_amount NUMERIC")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS credit_utilization REAL")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS risk_score REAL")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS risk_factors TEXT[]")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS recent_trend TEXT")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS ai_summary TEXT")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS ai_forecast_notes TEXT")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS ai_risk_explanation TEXT")
  await p.query("ALTER TABLE entity_payment_profiles ADD COLUMN IF NOT EXISTS ai_updated_at TIMESTAMPTZ")

  // Entity transactions table for detailed history tracking
  await p.query(`
    CREATE TABLE IF NOT EXISTS entity_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      transaction_type TEXT NOT NULL CHECK (transaction_type IN ('payment', 'invoice', 'bill', 'refund')),
      direction TEXT CHECK (direction IN ('inflow', 'outflow')),
      reference_type TEXT CHECK (reference_type IN ('movement', 'invoice', 'bill')),
      reference_id TEXT,
      amount NUMERIC NOT NULL,
      transaction_date DATE NOT NULL,
      due_date DATE,
      days_to_pay INT,
      was_on_time BOOLEAN,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await p.query("CREATE INDEX IF NOT EXISTS idx_entity_transactions_user_entity ON entity_transactions (user_id, entity_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_entity_transactions_user_date ON entity_transactions (user_id, transaction_date DESC)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_entity_transactions_entity_date ON entity_transactions (entity_id, transaction_date DESC)")

  // One-time backfill: allocations → attributions (idempotent)
  try {
    await p.query(`
      INSERT INTO movement_attributions (
        user_id, movement_id, component_type, entity_id, reference_id,
        gross_amount, net_amount, confidence, source, metadata, confidence_detail, migrated_from_allocation_id
      )
      SELECT
        ma.user_id,
        ma.movement_id,
        ma.entity_type,
        ma.entity_id,
        ma.source_id,
        ma.gross_applied,
        ma.net_applied,
        ma.confidence,
        CASE ma.match_method
          WHEN 'llm_suggested' THEN 'llm'
          WHEN 'manual' THEN 'user'
          ELSE 'rule'
        END,
        jsonb_build_object(
          'fee_amount', ma.fee_amount,
          'match_method', ma.match_method,
          'synthetic_invoice', ma.synthetic_invoice,
          'reconcile_at', ma.reconcile_at
        ),
        NULL,
        ma.id
      FROM movement_allocations ma
      WHERE NOT EXISTS (
        SELECT 1 FROM movement_attributions x WHERE x.migrated_from_allocation_id = ma.id
      )
    `)
  } catch (e) {
    log("attributions.backfill.error", { err: String(e) }, "db")
  }
  // Reconciliation cache for background processing
  await p.query(`
    CREATE TABLE IF NOT EXISTS reconciliation_cache (
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ar_ap_only        BOOLEAN NOT NULL DEFAULT true,
      status            TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error')),
      data              JSONB,
      error_message     TEXT,
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, ar_ap_only)
    )
  `)
  await p.query("ALTER TABLE reconciliation_cache ADD COLUMN IF NOT EXISTS merchant_only BOOLEAN NOT NULL DEFAULT false")
  await p.query("ALTER TABLE reconciliation_cache ADD COLUMN IF NOT EXISTS reconcile_at TIMESTAMPTZ")
  // Migrate PK to include merchant_only for split run types
  try {
    await p.query("ALTER TABLE reconciliation_cache DROP CONSTRAINT IF EXISTS reconciliation_cache_pkey")
    await p.query("ALTER TABLE reconciliation_cache ADD PRIMARY KEY (user_id, ar_ap_only, merchant_only)")
  } catch {
    // PK may already be updated
  }
  // Database-backed reconciliation locking (replaces in-memory Map for multi-dyno support)
  await p.query(`
    CREATE TABLE IF NOT EXISTS reconciliation_locks (
      user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
      error_message TEXT,
      completed_at  TIMESTAMPTZ
    )
  `)
  // LLM-suggested entity aliases (human review before insert into entity_aliases)
  await p.query(`
    CREATE TABLE IF NOT EXISTS entity_alias_suggestions (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      movement_id           UUID REFERENCES movements(id) ON DELETE SET NULL,
      raw_fingerprint       TEXT NOT NULL,
      suggested_entity_id   UUID REFERENCES entities(id) ON DELETE CASCADE,
      suggested_alias       TEXT NOT NULL,
      alias_type            TEXT NOT NULL DEFAULT 'merchant_string',
      confidence            REAL NOT NULL DEFAULT 0.5,
      rationale             JSONB DEFAULT '{}'::jsonb,
      status                TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
      source                TEXT NOT NULL DEFAULT 'llm_graph_maintainer',
      canonical_name_hint   TEXT,
      create_new_entity     BOOLEAN NOT NULL DEFAULT false,
      suggested_entity_type TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await p.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_alias_suggestions_pending_fp ON entity_alias_suggestions (user_id, raw_fingerprint) WHERE status = 'pending'",
  )
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_entity_alias_suggestions_user_status ON entity_alias_suggestions (user_id, status, created_at DESC)",
  )
  // Per-tenant classification precedence signatures (substring → role); replaces hardcoded CANONICAL_ALIAS_MAP
  await p.query(`
    CREATE TABLE IF NOT EXISTS user_classification_signatures (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      signature       TEXT NOT NULL,
      alias_role      TEXT NOT NULL CHECK (alias_role IN ('customer', 'owner', 'vendor', 'bank', 'processor')),
      canonical_key   TEXT NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, signature)
    )
  `)
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_user_classification_signatures_user ON user_classification_signatures (user_id)",
  )
  // Blacklist mistaken alias→entity links so identity resolution won't rematch them
  await p.query(`
    CREATE TABLE IF NOT EXISTS entity_alias_blacklist (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      alias           TEXT NOT NULL,
      reason          TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, entity_id, alias)
    )
  `)
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_entity_alias_blacklist_user ON entity_alias_blacklist (user_id, entity_id)",
  )
  // Cached movement explainability (batch generation + auto-refresh in UI)
  await p.query(`
    CREATE TABLE IF NOT EXISTS movement_explanations_cache (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      movement_id     UUID NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'error')),
      explanation     TEXT,
      error_message   TEXT,
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, movement_id)
    )
  `)
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_movement_explanations_cache_user ON movement_explanations_cache (user_id, updated_at DESC)",
  )
  // Forecast cache for expensive Monte Carlo computations
  await p.query(`
    CREATE TABLE IF NOT EXISTS forecast_cache (
      user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      forecast_data     JSONB NOT NULL,
      computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ NOT NULL,
      movement_count    INTEGER NOT NULL DEFAULT 0,
      invoice_count     INTEGER NOT NULL DEFAULT 0,
      bill_count        INTEGER NOT NULL DEFAULT 0,
      starting_cash     NUMERIC(15,2) NOT NULL DEFAULT 0
    )
  `)
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_forecast_cache_expires ON forecast_cache (expires_at)",
  )
  // Forecast calibration overrides (per-user tunable parameters)
  await p.query(`
    CREATE TABLE IF NOT EXISTS forecast_calibration_overrides (
      user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      params            JSONB NOT NULL DEFAULT '{}'::jsonb,
      source            TEXT NOT NULL DEFAULT 'default' CHECK (source IN ('default', 'fitted', 'manual')),
      fitted_at         TIMESTAMPTZ,
      train_loss        REAL,
      val_loss          REAL,
      fit_window_days   INTEGER,
      notes             TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // Backfill allocation URIs (idempotent)
  try {
    const { migrateAllocationUris } = await import("./allocation-migrate-uris")
    const { updated } = await migrateAllocationUris()
    if (updated > 0) log("allocation.uris.migrated", { count: updated }, "db")
  } catch (e) {
    log("allocation.migrate.uris.error", { err: String(e) }, "db")
  }
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

/**
 * Run work inside a single DB transaction (BEGIN / COMMIT / ROLLBACK).
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const p = await getPoolAsync()
  if (!p) throw new Error("Database is only available in production")
  const client = await p.connect()
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

// ─── Job Queue Status Tracking ───
export async function ensureJobStatusSchema(): Promise<void> {
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(`
    CREATE TABLE IF NOT EXISTS job_status (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id          TEXT NOT NULL UNIQUE,
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'complete', 'failed')),
      step            TEXT NOT NULL DEFAULT 'fetching' CHECK (step IN ('fetching', 'classifying', 'tagging', 'computing-state', 'generating-forecast', 'complete')),
      progress        INTEGER NOT NULL DEFAULT 0,
      error           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await p.query("CREATE INDEX IF NOT EXISTS idx_job_status_user ON job_status (user_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_job_status_job_id ON job_status (job_id)")
  log("job_status.schema.ensured", undefined, "db")
}

// ─── User Decisions & Feedback (NEW) ───
export async function ensureUserDecisionsSchema() {
  const p = await pool
  
  // User intervention decisions
  await p.query(`
    CREATE TABLE IF NOT EXISTS user_intervention_decisions (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      forecast_id       TEXT,
      intervention_id   TEXT NOT NULL,
      decision          TEXT NOT NULL CHECK (decision IN ('selected', 'rejected', 'deferred')),
      notes             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_user_intervention_decisions_user ON user_intervention_decisions (user_id, created_at DESC)"
  )

  // User strategy selections
  await p.query(`
    CREATE TABLE IF NOT EXISTS user_strategy_selections (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      forecast_id       TEXT,
      strategy_id       TEXT NOT NULL,
      selected          BOOLEAN DEFAULT false,
      implementation_notes TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_user_strategy_selections_user ON user_strategy_selections (user_id, created_at DESC)"
  )

  // Form drafts (auto-save)
  await p.query(`
    CREATE TABLE IF NOT EXISTS form_drafts (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      form_type         TEXT NOT NULL,
      draft_data        JSONB NOT NULL,
      saved_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, form_type)
    )
  `)
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_form_drafts_user ON form_drafts (user_id)"
  )

  // Forecast history
  await p.query(`
    CREATE TABLE IF NOT EXISTS forecast_history (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      forecast_data     JSONB NOT NULL,
      computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      parameters        JSONB,
      enrichment_status TEXT,
      enrichment_completed_at TIMESTAMPTZ
    )
  `)
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_forecast_history_user ON forecast_history (user_id, computed_at DESC)"
  )

  // Entity profile feedback
  await p.query(`
    CREATE TABLE IF NOT EXISTS entity_profile_feedback (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entity_id         UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      feedback_type     TEXT NOT NULL,
      feedback_value    BOOLEAN,
      notes             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_entity_profile_feedback_user ON entity_profile_feedback (user_id, entity_id)"
  )

  // Onboarding audit trail
  await p.query(`
    CREATE TABLE IF NOT EXISTS onboarding_audit (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      step_number       INT NOT NULL,
      action            TEXT NOT NULL,
      metadata          JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_onboarding_audit_user ON onboarding_audit (user_id, step_number, created_at DESC)"
  )

  // Context refinement history
  await p.query(`
    CREATE TABLE IF NOT EXISTS context_refinement_history (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      refinement_text   TEXT NOT NULL,
      context_version   INT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_context_refinement_history_user ON context_refinement_history (user_id, context_version DESC)"
  )
}
