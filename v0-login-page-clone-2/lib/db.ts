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
  await p.query("CREATE INDEX IF NOT EXISTS idx_gmail_synced_unprocessed ON gmail_synced_messages (processed_for_ap_ar) WHERE processed_for_ap_ar = FALSE")
  gmailSchemaEnsured = true
  log("db.gmail.schema.ensured", undefined, "db")
}

const UNIFIED_INVOICES_SQL = `
  CREATE TABLE IF NOT EXISTS unified_invoices (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source           TEXT NOT NULL,
    source_scope     TEXT NOT NULL,
    external_id      TEXT NOT NULL,
    data             JSONB NOT NULL,
    invoice_number   TEXT,
    invoice_date    TEXT,
    total            NUMERIC,
    customer_name    TEXT,
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, source, source_scope, external_id)
  )
`

let unifiedInvoicesSchemaEnsured = false

export async function ensureUnifiedInvoicesSchema(): Promise<void> {
  if (unifiedInvoicesSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(UNIFIED_INVOICES_SQL)
  await p.query("ALTER TABLE unified_invoices ADD COLUMN IF NOT EXISTS amount_paid NUMERIC")
  await p.query("ALTER TABLE unified_invoices ADD COLUMN IF NOT EXISTS amount_due NUMERIC")
  await p.query("ALTER TABLE unified_invoices ADD COLUMN IF NOT EXISTS status TEXT")
  await p.query("ALTER TABLE unified_invoices ADD COLUMN IF NOT EXISTS customer_email TEXT")
  await p.query("ALTER TABLE unified_invoices ADD COLUMN IF NOT EXISTS side TEXT")
  await p.query("ALTER TABLE unified_invoices ADD COLUMN IF NOT EXISTS counterparty_type TEXT")
  await p.query("ALTER TABLE unified_invoices ADD COLUMN IF NOT EXISTS source_summary JSONB")
  unifiedInvoicesSchemaEnsured = true
  log("db.unified_invoices.schema.ensured", undefined, "db")
}

const AP_AR_SQL = `
  CREATE TABLE IF NOT EXISTS ap_ar (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    side                TEXT NOT NULL,
    status              TEXT NOT NULL,
    invoice_number      TEXT,
    issue_date          DATE,
    due_date            DATE,
    currency            TEXT,
    amount_total        NUMERIC NOT NULL DEFAULT 0,
    amount_outstanding  NUMERIC NOT NULL DEFAULT 0,
    counterparty_type   TEXT,
    counterparty_name   TEXT,
    counterparty_email  TEXT,
    description         TEXT,
    source_summary      JSONB DEFAULT '{}'::jsonb,
    document_type       TEXT NOT NULL DEFAULT 'invoice',
    classification_confidence REAL,
    match_confidence    REAL,
    canonical_confidence REAL,
    needs_review        BOOLEAN NOT NULL DEFAULT FALSE,
    resolution_status   TEXT NOT NULL DEFAULT 'auto',
    winning_sources     JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_authority_score REAL,
    counterparty_id     UUID,
    last_verified_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
  )
`

const INVOICE_DOCUMENTS_SQL = `
  CREATE TABLE IF NOT EXISTS invoice_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL,
    provider_invoice_id TEXT NOT NULL,
    ap_ar_id            UUID REFERENCES ap_ar(id) ON DELETE SET NULL,
    normalized          JSONB NOT NULL,
    raw                 JSONB,
    latest_version_id   UUID,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, provider, provider_invoice_id)
  )
`

const INVOICE_DOCUMENT_VERSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS invoice_document_versions (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_document_id       UUID NOT NULL REFERENCES invoice_documents(id) ON DELETE CASCADE,
    normalized                JSONB NOT NULL,
    raw                       JSONB NOT NULL,
    extracted_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    extractor_version         TEXT,
    model_version             TEXT,
    document_type             TEXT NOT NULL,
    candidate_side            TEXT NOT NULL,
    classification_confidence REAL,
    extraction_confidence     REAL,
    source_authority          REAL,
    promotion_status          TEXT NOT NULL DEFAULT 'pending',
    review_reason             TEXT,
    fingerprint_invoice       TEXT,
    fingerprint_binary        TEXT,
    fingerprint_semantic      TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

const COUNTERPARTIES_SQL = `
  CREATE TABLE IF NOT EXISTS counterparties (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    canonical_name  TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    emails          TEXT[] NOT NULL DEFAULT '{}'::text[],
    domains         TEXT[] NOT NULL DEFAULT '{}'::text[],
    aliases         TEXT[] NOT NULL DEFAULT '{}'::text[],
    tax_id          TEXT,
    payment_handles JSONB,
    confidence      REAL NOT NULL DEFAULT 1.0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

const AP_AR_MATCH_CANDIDATES_SQL = `
  CREATE TABLE IF NOT EXISTS ap_ar_match_candidates (
    id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_document_version_id  UUID NOT NULL REFERENCES invoice_document_versions(id) ON DELETE CASCADE,
    ap_ar_id                     UUID REFERENCES ap_ar(id) ON DELETE CASCADE,
    score                        REAL NOT NULL,
    classification_confidence    REAL,
    match_confidence             REAL,
    explanation                  TEXT,
    chosen                       BOOLEAN NOT NULL DEFAULT FALSE,
    needs_review                 BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_by                  UUID,
    reviewed_at                  TIMESTAMPTZ,
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

let apArSchemaEnsured = false
let invoiceDocumentsSchemaEnsured = false

export async function ensureApArSchema(): Promise<void> {
  if (apArSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await p.query(AP_AR_SQL)
  await p.query("ALTER TABLE ap_ar ADD COLUMN IF NOT EXISTS document_type TEXT NOT NULL DEFAULT 'invoice'")
  await p.query("ALTER TABLE ap_ar ADD COLUMN IF NOT EXISTS classification_confidence REAL")
  await p.query("ALTER TABLE ap_ar ADD COLUMN IF NOT EXISTS match_confidence REAL")
  await p.query("ALTER TABLE ap_ar ADD COLUMN IF NOT EXISTS canonical_confidence REAL")
  await p.query("ALTER TABLE ap_ar ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE")
  await p.query("ALTER TABLE ap_ar ADD COLUMN IF NOT EXISTS resolution_status TEXT NOT NULL DEFAULT 'auto'")
  await p.query("ALTER TABLE ap_ar ADD COLUMN IF NOT EXISTS winning_sources JSONB NOT NULL DEFAULT '{}'::jsonb")
  await p.query("ALTER TABLE ap_ar ADD COLUMN IF NOT EXISTS source_authority_score REAL")
  await p.query("ALTER TABLE ap_ar ADD COLUMN IF NOT EXISTS counterparty_id UUID")
  await p.query("ALTER TABLE ap_ar ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ")
  await p.query("CREATE INDEX IF NOT EXISTS idx_ap_ar_user_side ON ap_ar (user_id, side)")
  await p.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_ar_unique_invnum ON ap_ar (user_id, side, invoice_number) WHERE invoice_number IS NOT NULL")
  await p.query(COUNTERPARTIES_SQL)
  await p.query(AP_AR_MATCH_CANDIDATES_SQL)
  apArSchemaEnsured = true
  log("db.ap_ar.schema.ensured", undefined, "db")
}

export async function ensureInvoiceDocumentsSchema(): Promise<void> {
  if (invoiceDocumentsSchemaEnsured) return
  const p = await getPoolAsync()
  if (!p) return
  await ensureAuthSchema()
  await ensureApArSchema()
  await p.query(INVOICE_DOCUMENTS_SQL)
  await p.query("ALTER TABLE invoice_documents ADD COLUMN IF NOT EXISTS ap_ar_id UUID REFERENCES ap_ar(id) ON DELETE SET NULL")
  await p.query("ALTER TABLE invoice_documents ADD COLUMN IF NOT EXISTS latest_version_id UUID")
  await p.query(INVOICE_DOCUMENT_VERSIONS_SQL)
  await p.query("CREATE INDEX IF NOT EXISTS idx_invoice_doc_versions_doc ON invoice_document_versions (invoice_document_id)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_invoice_doc_versions_status ON invoice_document_versions (promotion_status)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_invoice_doc_versions_fingerprint_invoice ON invoice_document_versions (fingerprint_invoice)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_invoice_doc_versions_fingerprint_binary ON invoice_document_versions (fingerprint_binary)")
  await p.query("CREATE INDEX IF NOT EXISTS idx_invoice_documents_ap_ar_id ON invoice_documents (ap_ar_id) WHERE ap_ar_id IS NOT NULL")
  invoiceDocumentsSchemaEnsured = true
  log("db.invoice_documents.schema.ensured", undefined, "db")
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

export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[] }> {
  const p = await getPoolAsync()
  if (!p) throw new Error("Database is only available in production")
  const result = await p.query(text, params)
  return { rows: (result.rows ?? []) as T[] }
}
