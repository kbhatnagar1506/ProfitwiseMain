<h1 align="center">Connectors</h1>

<p align="center">
  <strong>Fourteen integrations. One canonical financial model.</strong><br>
  Every connector is independently optional — connect one, or connect all of them.
</p>

---

Profitwise is a **connector platform with a reconciliation engine on top**. Each
integration lands data in one of three canonical tables, and the matching engine
works only against those — so adding a bank, a ledger or a storefront never
changes the reconciliation logic.

```
                  ┌──────────────────────────────────────────┐
  BANKS           │                                          │
  Plaid ─────────▶│  movements      money that actually moved │
                  │                                          │
  LEDGERS         │                                          │
  QuickBooks ────▶│  cash_events    money owed or expected    │──▶ reconciliation
  Xero ──────────▶│                 (AR invoices / AP bills)  │    waterfall
  Gmail ─────────▶│                                          │        │
                  │                                          │        ▼
  COMMERCE        │  entities       who the counterparty is   │  movement_
  Stripe ────────▶│                 across every source       │  attributions
  Shopify ───────▶│                                          │
                  └──────────────────────────────────────────┘
                                      ▲
  INTELLIGENCE                        │
  OpenAI ─────── semantic matching ───┤
  Supermemory ── entity memory ───────┘

  CHANNELS        Slack · WhatsApp (Twilio)  ── ask questions, approve matches
```

**The contract:** a connector's only job is to produce `movements`,
`cash_events` and `entities`. It never decides what matches what.

---

## Contents

**Banking** · [Plaid](#plaid)
**Ledgers** · [QuickBooks](#quickbooks-online) · [Xero](#xero) · [Gmail](#gmail)
**Commerce** · [Stripe](#stripe) · [Shopify](#shopify)
**Intelligence** · [OpenAI](#openai) · [Supermemory](#supermemory)
**Channels** · [Slack](#slack) · [WhatsApp](#whatsapp-via-twilio)
**Infrastructure** · [PostgreSQL](#postgresql) · [Redis](#redis) · [Cloud Storage](#google-cloud-storage) · [reCAPTCHA](#recaptcha)

Then: [three ways to drive them](#three-ways-to-drive-a-connector) ·
[writing a new connector](#writing-a-new-connector) ·
[troubleshooting](#troubleshooting)

---

## Banking

### Plaid

The foundation. Everything else exists to explain what Plaid reports.

Bank transactions become rows in `movements` — the record of money that actually
moved. Without at least one bank connection there is nothing to reconcile
against, so connect this first.

**What you get:** accounts, balances, transactions, item webhooks, and
`/transactions/sync` cursor-based incremental updates.

**Setup**

1. Create a Plaid app and note the client ID and secret.
2. Set `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox` to start).
3. Register the webhook: `<APP_URL>/api/plaid/webhook`.
4. Full walkthrough: [PLAID_SETUP.md](web/docs/PLAID_SETUP.md)

**Use it — from the UI**

Visit `/onboarding`. Plaid Link opens in the browser, the user picks their bank,
and the public token is exchanged server-side automatically.

**Use it — over HTTP**

```bash
# 1. Mint a Link token for the browser
curl -X POST https://your-app/api/plaid/link-token \
  -H "Cookie: $SESSION"

# 2. Exchange the public token Link returns
curl -X POST https://your-app/api/plaid/exchange-token \
  -H "Cookie: $SESSION" -H "Content-Type: application/json" \
  -d '{"public_token":"public-sandbox-..."}'

# 3. Pull transactions
curl -X POST https://your-app/api/plaid/transactions-sync -H "Cookie: $SESSION"

# Also: /api/plaid/items · /api/plaid/balances · /api/plaid/refresh
```

**Use it — in code**

```ts
import { createLinkToken, exchangePublicToken, getAccounts } from "@/lib/plaid"

const { link_token } = await createLinkToken(userId)
const { accessToken, itemId } = await exchangePublicToken(publicToken)
const accounts = await getAccounts(accessToken)
```

**Env:** `PLAID_CLIENT_ID` · `PLAID_SECRET` · `PLAID_ENV`

---

## Ledgers

These supply the other half of the equation: what *should* have been paid.

### QuickBooks Online

**What you get:** invoices (AR), bills (AP), customers, vendors, accounts,
payments. On first connect, a full entity sync runs in the background so the
dashboard has data immediately rather than after the first cron tick.

**Setup**

1. Create an Intuit app; set `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET`.
2. Keep `QUICKBOOKS_SANDBOX=true` until you are ready for real books.
3. Redirect URI: `<APP_URL>/api/quickbooks/oauth/callback`
4. Webhook: `<APP_URL>/api/quickbooks/webhook`, with `QUICKBOOKS_WEBHOOK_VERIFIER`
5. Detail: [QBO_HEROKU_AND_INTUIT_SETUP.md](web/docs/QBO_HEROKU_AND_INTUIT_SETUP.md)

**Use it**

```bash
# Start OAuth (redirects to Intuit)
open https://your-app/api/quickbooks/oauth/authorize

# Trigger a sync, then watch it
curl -X POST https://your-app/api/quickbooks/sync   -H "Cookie: $SESSION"
curl        https://your-app/api/quickbooks/sync/status -H "Cookie: $SESSION"
curl        https://your-app/api/quickbooks/transactions -H "Cookie: $SESSION"
```

```ts
import { getAllForEntity, ENTITY_TYPES } from "@/lib/quickbooks"
import { upsertEntities } from "@/lib/qbo-entity-store"

for (const type of ENTITY_TYPES) {
  const items = await getAllForEntity(realmId, type)
  await upsertEntities(realmId, type, items, { userId })
}
```

**Env:** `QUICKBOOKS_CLIENT_ID` · `QUICKBOOKS_CLIENT_SECRET` ·
`QUICKBOOKS_SANDBOX` · `QUICKBOOKS_WEBHOOK_VERIFIER`

### Xero

The same ledger surface for Xero tenants. Multi-tenant: one connection can span
several Xero organisations, keyed by tenant ID.

**Setup** — create a Xero app, set `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET`,
redirect to `<APP_URL>/api/xero/oauth/callback`, webhook signed with
`XERO_WEBHOOK_KEY`. Detail: [XERO_SETUP.md](web/docs/XERO_SETUP.md)

```bash
open https://your-app/api/xero/oauth/authorize
curl -X POST https://your-app/api/xero/sync   -H "Cookie: $SESSION"
curl        https://your-app/api/xero/status  -H "Cookie: $SESSION"
curl -X POST https://your-app/api/xero/disconnect -H "Cookie: $SESSION"
```

```ts
import { runXeroSyncForUser } from "@/lib/xero-sync"
await runXeroSyncForUser(userId)
```

**Env:** `XERO_CLIENT_ID` · `XERO_CLIENT_SECRET` · `XERO_WEBHOOK_KEY`

### Gmail

For businesses whose invoices arrive as email attachments rather than through a
ledger — which is most small businesses. Messages are fetched, then parsed by
LLM into structured AR/AP records.

This is the connector that makes Profitwise work for companies with no
accounting integration at all.

**Setup** — Google Cloud OAuth credentials, then `GMAIL_OAUTH_CLIENT_ID`,
`GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_ADMIN_EMAIL`, `GMAIL_INBOX_USER_ID`.

```bash
open https://your-app/api/gmail/oauth/authorize
curl https://your-app/api/gmail/status          -H "Cookie: $SESSION"
curl https://your-app/api/gmail/invoice-senders -H "Cookie: $SESSION"

# Scheduled sync + extraction
curl -X POST "https://your-app/api/cron/gmail-sync?q=newer_than:1h&maxMessages=200" \
  -H "x-clean-db-secret: $CLEAN_DB_SECRET"
```

```ts
import { runGmailSync } from "@/lib/gmail-sync"
import { runGmailInvoicePipeline } from "@/lib/gmail-invoice-pipeline"

await runGmailSync({ q: "newer_than:7d", maxMessages: 200 })
await runGmailInvoicePipeline({ limit: 15 })   // LLM extraction into AR/AP
```

There is also a standalone CLI for the OAuth dance:
[`scripts/gmail-oauth-cli.mjs`](web/scripts/README-gmail-oauth.md)

**Env:** `GMAIL_OAUTH_CLIENT_ID` · `GMAIL_OAUTH_CLIENT_SECRET` ·
`GMAIL_ADMIN_EMAIL` · `GMAIL_INBOX_USER_ID`

---

## Commerce

### Stripe

Stripe earns its place twice over.

As an invoice source it behaves like a ledger. But its real value is **fee
recovery**: payouts arrive net of processing fees, so a `$4,200.00` invoice
shows up in the bank as `$4,182.55`. Payout sync expands
`balance_transaction` to recover the exact fee, which is what lets those two
records reconcile instead of sitting unmatched forever.

That single behaviour resolves a large share of the "why doesn't this match"
problem for any business taking card payments.

**Setup** — `STRIPE_SECRET_KEY`, `STRIPE_CLIENT_ID` for Connect OAuth,
`STRIPE_WEBHOOK_SECRET` for `<APP_URL>/api/stripe/webhook`.

```bash
open https://your-app/api/stripe/oauth/authorize
curl -X POST https://your-app/api/stripe/sync   -H "Cookie: $SESSION"
curl        https://your-app/api/stripe/status  -H "Cookie: $SESSION"
```

```ts
import { runStripeSyncForUser } from "@/lib/stripe-sync"
await runStripeSyncForUser(userId)   // invoices, payouts, fees
```

**Env:** `STRIPE_SECRET_KEY` · `STRIPE_CLIENT_ID` · `STRIPE_WEBHOOK_SECRET`

### Shopify

Orders become inflow movements, then get **deduplicated against processor
deposits** — because a Shopify order and the Stripe payout that settles it are
the same money seen twice. `lib/cross-source-dedup.ts` resolves the overlap so
revenue is not double-counted.

**Setup** — `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
`SHOPIFY_REDIRECT_URI`, `SHOPIFY_API_VERSION`, `SHOPIFY_REQUIRED_SCOPES`.

```bash
open https://your-app/api/shopify/oauth/authorize
curl -X POST https://your-app/api/shopify/sync  -H "Cookie: $SESSION"

# Scheduled: sync → movements → dedup, for every connection
curl https://your-app/api/cron/shopify-sync -H "Authorization: Bearer $CRON_SECRET"
```

```ts
import { runShopifySyncForUser, runShopifySyncForAllConnections } from "@/lib/shopify-sync"
import { convertShopifyOrdersToMovements } from "@/lib/shopify-movements"
import { autoResolveDuplicates } from "@/lib/cross-source-dedup"

await runShopifySyncForUser(userId)
await convertShopifyOrdersToMovements(userId, shopDomain)
await autoResolveDuplicates(userId)
```

**Env:** `SHOPIFY_CLIENT_ID` · `SHOPIFY_CLIENT_SECRET` · `SHOPIFY_REDIRECT_URI` ·
`SHOPIFY_API_VERSION` · `SHOPIFY_REQUIRED_SCOPES`

---

## Intelligence

Both are optional. Their absence makes matching **more conservative, never more
permissive** — an unreachable model can only reduce what gets auto-accepted.

### OpenAI

Powers reconciliation **Stage 4** — and only Stage 4. Stages 0–3 are
deterministic and resolve the large majority of matches before any token is
spent. The LLM sees only the residue.

It also drives invoice extraction from email, movement classification and
forecast enrichment.

Any OpenAI-compatible endpoint works — point `FORECAST_LLM_API_URL` at a local
model, a proxy, or another vendor.

```bash
OPENAI_API_KEY=sk-...
OPENAI_COMPANY_CONTEXT_MODEL=gpt-4o
FORECAST_LLM_API_URL=https://api.openai.com/v1/chat/completions   # override freely
```

Guardrails ship with it: `lib/llm-circuit-breaker.ts`,
`lib/llm-rate-limiter.ts`, `lib/llm-prompt-sanitizer.ts`,
`lib/llm-hallucination-detector.ts`.

**Env:** `OPENAI_API_KEY` · `OPENAI_COMPANY_CONTEXT_MODEL` ·
`FORECAST_LLM_API_URL` · `FORECAST_LLM_API_KEY` · `RECON_SCORING_MODEL`

### Supermemory

Entity memory. This is what makes matching improve with use rather than
restarting cold every run.

When a user confirms that `SP NORTHWIND - WHOLESALE` is `Northwind Oat Bars`, that
pattern is written back. Next time the descriptor appears it resolves on the
fast path — no LLM call, no ambiguity. The LLM tier is *grounded* in this graph
rather than guessing from general knowledge.

```bash
curl https://your-app/api/supermemory/status          -H "Cookie: $SESSION"
curl https://your-app/api/supermemory/company-context -H "Cookie: $SESSION"
```

```ts
import { addEntitiesToSupermemory, getUserFinanceTag } from "@/lib/supermemory"
await addEntitiesToSupermemory(userId, entities)
```

**Env:** `SUPERMEMORY_API_KEY` · `SUPERMEMORY_DEFAULT_FINANCE_TAG` ·
`SUPERMEMORY_ON_EVERY_LLM`

---

## Channels

Reconciliation always leaves a residue that needs a human. These are how the
human gets reached where they already are, instead of in a dashboard they have
to remember to open.

### Slack

```bash
open https://your-app/api/slack/oauth/authorize
curl https://your-app/api/slack/status -H "Cookie: $SESSION"
```

Events arrive at `/api/slack/events`, verified with `SLACK_SIGNING_SECRET`
before anything is processed.

```ts
import { verifySlackRequest, getSlackBotToken } from "@/lib/slack"
```

**Env:** `SLACK_CLIENT_ID` · `SLACK_CLIENT_SECRET` · `SLACK_SIGNING_SECRET` ·
`SLACK_BOT_TOKEN` — setup: [SLACK_SETUP.md](web/docs/SLACK_SETUP.md)

### WhatsApp (via Twilio)

Phone-number verification is OTP-based, so a user links WhatsApp without leaving
the app.

```bash
curl -X POST https://your-app/api/whatsapp/request-otp \
  -H "Cookie: $SESSION" -d '{"phone":"+15551234567"}'
curl -X POST https://your-app/api/whatsapp/verify \
  -H "Cookie: $SESSION" -d '{"code":"123456"}'

curl -X POST https://your-app/api/twilio/send-whatsapp \
  -H "Cookie: $SESSION" -d '{"to":"+1...","body":"Payment matched."}'
```

> **The `/api/twillo/…` misspelling is deliberate.** That is the URL registered
> in the Twilio console, and the route exists to serve it. A correctly spelled
> `/api/twilio/webhook/whatsapp` also exists. Repoint Twilio before removing the
> misspelled one, or inbound messages stop arriving.

**Env:** `TWILIO_ACCOUNT_SID` · `TWILIO_AUTH_TOKEN` · `TWILIO_WHATSAPP_FROM` ·
`TWILIO_API_KEY_SID` · `TWILIO_API_KEY_SECRET` —
setup: [TWILIO_WHATSAPP_SETUP.md](web/docs/TWILIO_WHATSAPP_SETUP.md)

---

## Infrastructure

### PostgreSQL

Primary datastore. Two connection modes, checked in this order:

```bash
# Cloud SQL connector — used when all four are present
INSTANCE_CONNECTION_NAME=project:region:instance
DB_USER=  DB_PASS=  DB_NAME=
CLOUD_SQL_IP_TYPE=PUBLIC

# Otherwise, a direct URL
DATABASE_URL=postgresql://user:pass@host:5432/profitwise
```

Schema is applied by fifteen idempotent `ensure*Schema()` functions in
`lib/db.ts`, plus SQL files in `web/migrations/`. Read
[`web/migrations/README.md`](web/migrations/README.md) before changing either —
editing the wrong one is a silent no-op.

### Redis

Bull queue backend. **Configured as host/port/password, not a URL** — a
`REDIS_URL` will be ignored.

```bash
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

Seven job processors run against it: `sync-initial-data`, `process-webhook`,
`tag-movements`, `classify-movements`, `match-customers`, `compute-state`,
`generate-forecast`. See [`web/lib/queue/README.md`](web/lib/queue/README.md).

### Google Cloud Storage

Blob store for raw QuickBooks and Xero entity payloads, keeping large JSON out
of Postgres.

```bash
GCP_SERVICE_KEY_JSON=   # service account JSON, inline
GCP_ENTITY_BUCKET=
```

Setup: [GCP_ENTITY_BUCKET_SETUP.md](web/docs/GCP_ENTITY_BUCKET_SETUP.md)

### reCAPTCHA

Signup protection. `RECAPTCHA_SECRET_KEY`.

---

## Three ways to drive a connector

Every integration is reachable the same three ways. Pick by context.

**1. OAuth through the UI** — what real users do. `/onboarding` walks each
integration in turn. Callbacks at `/api/<provider>/oauth/callback` all validate
a signed `state` cookie against the returned `state` parameter.

**2. HTTP, session-authenticated** — for scripting and testing.

```bash
curl -X POST https://your-app/api/<provider>/sync  -H "Cookie: $SESSION"
curl        https://your-app/api/<provider>/status -H "Cookie: $SESSION"
```

**3. Scheduled, secret-authenticated** — for cron and automation.

```bash
curl https://your-app/api/cron/shopify-sync -H "Authorization: Bearer $CRON_SECRET"
curl -X POST https://your-app/api/cron/gmail-sync -H "x-clean-db-secret: $CLEAN_DB_SECRET"
```

### After the data lands

```ts
import { runFullReconciliation } from "@/lib/full-reconciliation"

const result = await runFullReconciliation(userId)
// { waterfall, llm, totalAttributions, remainingUnmatched, executionTimeMs, warnings }
```

```bash
curl https://your-app/api/ar-ap-reconciliation -H "Cookie: $SESSION"  # cached ~5min
curl -X POST https://your-app/api/brain        -H "Cookie: $SESSION"  # attribution + sync + refresh
```

### Endpoint authentication

| Secret | Guards |
| --- | --- |
| `CRON_SECRET` | `/api/cron/*` — bearer token |
| `CLEAN_DB_SECRET` | `/api/admin/*` — `x-clean-db-secret` header. Also refuses to run unless `NODE_ENV=production`, and rejects the secret in a query string. |

One shared secret currently guards all 16 admin routes, from
`gmail-connection-status` to `wipe-all-user-data`. Splitting it per scope is
tracked in [REVIEW.md](REVIEW.md) §3.7.

---

## Writing a new connector

Every integration follows the same five-file shape. Copy the closest existing
one — `lib/shopify-*.ts` is the most self-contained.

| File | Responsibility |
| --- | --- |
| `lib/<name>.ts` | API client and config helpers |
| `lib/<name>-token-store.ts` | OAuth token persistence and refresh |
| `lib/<name>-sync.ts` | Pull remote records into local tables |
| `lib/<name>-movements.ts` | Translate them into canonical `movements` |
| `app/api/<name>/…` | `oauth/authorize`, `oauth/callback`, `sync`, `status`, `disconnect`, `webhook` |

**Five rules, learned the hard way:**

1. **Land in the canonical model.** Produce `movements`, `cash_events` and
   `entities`. Never teach the reconciliation engine about your provider.
2. **Validate OAuth `state`.** Compare the signed state cookie against the
   returned parameter and fail closed. Every existing callback does this.
3. **Be idempotent.** Webhooks are at-least-once and Bull retries. Running twice
   must not create a second movement.
4. **Degrade, do not guess.** Missing credentials should narrow behaviour, not
   widen it. Never let an unreachable dependency cause more auto-acceptance.
5. **Dedup across sources.** If your provider can report money another connector
   also reports — a Shopify order and its Stripe payout — wire it into
   `lib/cross-source-dedup.ts`.

Conventions: [`web/lib/README.md`](web/lib/README.md) ·
auth tiers: [`web/app/api/README.md`](web/app/api/README.md)

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Connector authorises, no data appears | Worker is not running — sync is a queued job (`npm run worker`) |
| `REDIS_URL` set, queue still down | Not a supported variable. Use `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`. |
| OAuth returns `state_mismatch` | `APP_URL` does not match the redirect URI registered with the provider |
| OAuth returns `session_expired` | State cookie expired mid-flow; restart from `/onboarding` |
| Stripe deposits never match invoices | Payout sync has not run, so the fee is unknown and amounts differ |
| Shopify revenue double-counted | Dedup did not run — see `autoResolveDuplicates` |
| WhatsApp inbound silent | Twilio points at `/api/twillo/…`; confirm that route still exists |
| Everything matches literally, nothing semantically | No `OPENAI_API_KEY` — deterministic-only by design |
| Same descriptor re-asked every run | No `SUPERMEMORY_API_KEY`, so confirmations are not written back |

Full annotated variable list: [`web/.env.example`](web/.env.example).
Getting started: [USAGE.md](USAGE.md). Known defects: [REVIEW.md](REVIEW.md).
