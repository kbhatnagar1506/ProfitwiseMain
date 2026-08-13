# Connectors

Every external system Profitwise talks to, what it contributes, and how it is
configured. Variable names are taken from the code — several are non-obvious.

Every connector is **independently optional**. The app degrades rather than
crashes when one is absent, and the LLM tiers fall back to stricter
deterministic thresholds rather than guessing.

---

## Data sources

These produce the records that reconciliation matches against.

### Plaid — bank accounts and transactions
The primary source of truth for money actually moving. Transactions become rows
in `movements`, which everything downstream reconciles against.

- **Provides:** accounts, balances, transactions, item webhooks
- **Env:** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`
- **Flow:** Plaid Link in the browser → `/api/plaid/*` → `movements`
- **Webhook:** `/api/plaid/webhook`
- **Setup:** [PLAID_SETUP.md](web/docs/PLAID_SETUP.md)

### QuickBooks Online — invoices, bills, contacts
- **Provides:** invoices (AR), bills (AP), customers, vendors, accounts
- **Env:** `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_SANDBOX`, `QUICKBOOKS_WEBHOOK_VERIFIER`
- **Flow:** OAuth 2 via `intuit-oauth`; a full entity sync kicks off in the background on first connect
- **Setup:** [QBO_HEROKU_AND_INTUIT_SETUP.md](web/docs/QBO_HEROKU_AND_INTUIT_SETUP.md)

### Xero — invoices, bills, contacts
- **Provides:** the same ledger surface as QuickBooks, for Xero tenants
- **Env:** `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_WEBHOOK_KEY`
- **Setup:** [XERO_SETUP.md](web/docs/XERO_SETUP.md)

### Stripe — invoices, payouts, processor fees
Stripe matters twice: as an invoice source, and because payouts arrive net of
fees. Payout sync expands `balance_transaction` to recover the fee, which is
what lets a `4,182.55` deposit reconcile against a `4,200.00` invoice.

- **Provides:** invoices, payouts, balance transactions, charges
- **Env:** `STRIPE_SECRET_KEY`, `STRIPE_CLIENT_ID`, `STRIPE_WEBHOOK_SECRET`
- **Webhook:** `/api/stripe/webhook`

### Shopify — orders
- **Provides:** orders, converted to inflow movements and deduplicated against
  processor deposits
- **Env:** `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_REDIRECT_URI`, `SHOPIFY_API_VERSION`, `SHOPIFY_REQUIRED_SCOPES`
- **Sync:** `/api/cron/shopify-sync`, authorised with `CRON_SECRET`

### Gmail — invoices and bills from email
For businesses whose invoices arrive as PDFs and email bodies rather than
through a ledger. Messages are fetched, then parsed by LLM into AR/AP records.

- **Provides:** invoice and bill extraction from the inbox
- **Env:** `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_ADMIN_EMAIL`, `GMAIL_INBOX_USER_ID`
- **Sync:** `/api/cron/gmail-sync`
- **CLI:** `scripts/gmail-oauth-cli.mjs` — see [README-gmail-oauth.md](web/scripts/README-gmail-oauth.md)

---

## Intelligence

### OpenAI — reconciliation Stage 4
Only the residue that stages 0–3 could not resolve deterministically reaches
this tier. Also drives invoice extraction, movement classification and forecast
enrichment.

- **Env:** `OPENAI_API_KEY`, `OPENAI_COMPANY_CONTEXT_MODEL`, and optionally
  `FORECAST_LLM_API_URL` / `FORECAST_LLM_API_KEY` to point at any
  OpenAI-compatible endpoint
- **Without a key:** the matcher applies stricter deterministic thresholds
  rather than accepting more. Absence makes it more conservative, not less.

### Supermemory — entity memory
Grounds the LLM in the user's own entity graph. It is why `SP BOBOS - WHOLESALE`
resolves to `Bobo's` — that pattern was confirmed before and written back.

- **Env:** `SUPERMEMORY_API_KEY`, `SUPERMEMORY_DEFAULT_FINANCE_TAG`, `SUPERMEMORY_ON_EVERY_LLM`

---

## Channels

### Slack
- **Env:** `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`
- **Events:** `/api/slack/events`
- **Setup:** [SLACK_SETUP.md](web/docs/SLACK_SETUP.md)

### Twilio (WhatsApp)
- **Env:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`
- **Webhook:** `/api/twillo/webhook/whatsapp` — **the misspelling is deliberate.**
  That is the URL registered in the Twilio console. A correctly spelled
  `/api/twilio/...` route also exists. Do not delete the misspelled one without
  repointing Twilio first.
- **Setup:** [TWILIO_WHATSAPP_SETUP.md](web/docs/TWILIO_WHATSAPP_SETUP.md)

---

## Infrastructure

| Service | Purpose | Env |
| --- | --- | --- |
| **PostgreSQL** | Primary datastore | `DATABASE_URL`, or Cloud SQL via `INSTANCE_CONNECTION_NAME` + `DB_USER` + `DB_PASS` + `DB_NAME` |
| **Redis** | Bull queue backend | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (host/port/password — *not* a URL) |
| **Google Cloud Storage** | Entity blob store for QBO/Xero payloads | `GCP_SERVICE_KEY_JSON`, `GCP_ENTITY_BUCKET` |
| **reCAPTCHA** | Signup protection | `RECAPTCHA_SECRET_KEY` |

---

## Endpoint authentication

Not connectors, but required for the scheduled and administrative surface:

| Variable | Guards |
| --- | --- |
| `CRON_SECRET` | `/api/cron/*` — bearer token |
| `CLEAN_DB_SECRET` | `/api/admin/*` — `x-clean-db-secret` header. These routes additionally refuse to run unless `NODE_ENV=production`, and reject the secret in a query string. |

One shared secret currently guards all 16 admin routes, from
`gmail-connection-status` to `wipe-all-user-data`. Splitting it per scope is
tracked in [REVIEW.md](REVIEW.md) §3.7.

---

## Connecting them

Users connect their own accounts through the onboarding flow at `/onboarding`,
which walks each OAuth integration in turn. OAuth callbacks live at
`/api/<provider>/oauth/callback` and all validate a signed `state` cookie
against the returned `state` parameter.

Full variable list with inline notes: [`web/.env.example`](web/.env.example).
