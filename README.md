<h1 align="center">Profitwise</h1>

<p align="center">
  <strong>Automated cash reconciliation and forecasting for operating businesses.</strong>
</p>

<p align="center">
  <img alt="tests" src="https://img.shields.io/badge/tests-213%20passing-brightgreen">
  <img alt="coverage" src="https://img.shields.io/badge/covered%20modules-95--100%25-brightgreen">
  <img alt="connectors" src="https://img.shields.io/badge/connectors-14-blue">
  <img alt="stack" src="https://img.shields.io/badge/Next.js%2016-React%2019-black">
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="licence" src="https://img.shields.io/badge/licence-MIT-green">
</p>

<p align="center">
  <a href="ABOUT.md">About</a> ·
  <a href="USAGE.md">Usage</a> ·
  <a href="CONNECTORS.md">Connectors</a> ·
  <a href="REVIEW.md">Engineering review</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="LICENSE">MIT License</a>
</p>

---

Profitwise connects a company's bank accounts, accounting ledger, payment
processors and invoice email, then answers the question those systems can't
answer on their own: *which invoice does this deposit actually pay for?*

Bank feeds give you `ACH CREDIT SP NORTHWIND - WHOLESALE 4,182.55`. The ledger has
an open invoice for `Northwind Oat Bars` at `4,200.00`. Nothing links them — the
names differ, the amounts differ by a processor fee, and the dates are a week
apart. Profitwise closes that gap automatically, shows its reasoning, and only
escalates to a human when the evidence is genuinely weak.

---

## How reconciliation works

Matching runs as a five-stage waterfall. Each stage is strictly cheaper and more
certain than the one after it, so the expensive semantic tier only ever sees what
the deterministic tiers could not resolve.

```
runFullReconciliation(userId)
│
├─ Stage 0  Direct link          movement_id → cash_event_id already known
├─ Stage 1  Exact amount         unambiguous amount + entity agreement
├─ Stage 2  Category             economic class narrows the candidate set
├─ Stage 3  FIFO + tolerance     oldest-open-first, with greedy-sweep guards
│
└─ Stage 4  LLM semantic match   only the residue reaches here
   └─ grounded in Supermemory: the user's own entity graph and
      previously-confirmed bank-descriptor patterns
```

Every match carries a **component-based confidence breakdown** rather than a
bare number, so a decision can be explained after the fact:

| Signal | Weight | Example |
| --- | ---: | --- |
| Amount agreement | 0.30 | within 1% → 0.97, within 5% → 0.88 |
| Entity name (heuristic) | 0.20 | Levenshtein + Jaccard token blend |
| Entity name (AI validation) | 0.25 | semantic check against the entity graph |
| Date proximity | 0.15 | same day → 1.00, within a quarter → 0.65 |
| Historical behaviour | 0.05 | has this pair matched before? |
| Category | 0.03 | same economic class |
| Match sequence | 0.02 | penalty for the Nth match on one movement |

Scores below the confidence floor land in a review queue instead of being booked.

---

## Architecture

```
Ingestion            Normalization           Reconciliation         Surface
─────────            ─────────────           ──────────────         ───────
Plaid       ─┐      ┌ entity resolution ┐   ┌ waterfall 0-3 ┐      dashboard
QuickBooks  ─┤      │ alias normalize   │   │ LLM stage 4   │      forecast
Xero        ─┼─────▶│ movement classify │──▶│ attribution   │─────▶review queue
Stripe      ─┤      │ economic class    │   │ confidence    │      entity graph
Shopify     ─┤      │ cross-source dedup│   │ audit log     │      Slack/WhatsApp
Gmail       ─┘      └───────────────────┘   └───────────────┘
```

**Single source of truth.** `cash_events.status` is the canonical AR/AP payment
state, with exactly six permitted write paths, all routed through
`lib/ar-ap-status.ts`. `display_status` is a stored generated column; `overdue`
is computed at query time and never persisted. See
[`ar-ap-architecture.md`](web/docs/ar-ap-architecture.md).

**Entity resolution** is its own layer — bank descriptors, ledger contacts and
processor payouts rarely agree on a name. Alias normalization, camelCase
splitting, org-qualifier stripping and a Supermemory-backed entity graph converge
them onto one canonical entity.

**Background work** runs on Bull/Redis with a separate worker dyno: movement
tagging, classification, customer matching, state computation, forecast
generation and webhook processing.

---

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS 4, Radix UI primitives |
| Data | PostgreSQL (`pg`, GCP Cloud SQL connector), GCS for entity blobs |
| Queue | Bull + Redis, separate worker process |
| Auth | Argon2id password hashing, DB-backed sessions, edge middleware |
| Testing | Vitest + v8 coverage |
| Charts | Recharts |

**Integrations:** Plaid · QuickBooks · Xero · Stripe · Shopify · Gmail ·
Slack · Twilio (WhatsApp) · Supermemory

---

## Repository layout

```
.
├── README.md                    you are here
├── REVIEW.md                    engineering review: findings, known gaps, roadmap
├── Procfile                     web + worker dynos
├── docs/                        cross-cutting operational docs
└── web/                         the application
    ├── app/
    │   ├── api/                 169 route handlers across 37 groups
    │   ├── dashboard/           34 dashboard surfaces
    │   ├── onboarding/          connect-your-accounts flow
    │   └── oauth/               per-integration OAuth callbacks
    ├── lib/                     ~140 modules — the domain layer
    │   ├── reconciliation-*     the matching waterfall
    │   ├── entity-*             identity resolution and the entity graph
    │   ├── confidence-*         scoring and explanation
    │   ├── state/               forecast engine
    │   └── queue/               Bull workers and processors
    ├── components/              UI, including shadcn/ui primitives
    ├── migrations/              SQL migrations
    └── docs/                    setup guides and architecture references
```

---

## Getting started

**Prerequisites:** Node 20+, PostgreSQL, Redis.

```bash
cd web
npm install
cp .env.example .env.local     # then fill in the values below
npm run dev
```

Run the migrations from the repository root:

```bash
./run-migrations.sh            # requires DATABASE_URL
```

The background worker runs separately:

```bash
npm run worker
```

### Environment

At minimum you need a database and Redis. Every integration is independently
optional — the app degrades gracefully when one is unconfigured.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (or the four `INSTANCE_CONNECTION_NAME` / `DB_*` variables for Cloud SQL) |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Bull queue backend — host/port/password, **not** a URL |
| `APP_URL` | Public base URL, used to build OAuth redirect URIs |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | Bank movement sync |
| `QUICKBOOKS_CLIENT_ID` / `_CLIENT_SECRET` | QuickBooks OAuth |
| `XERO_CLIENT_ID` / `_CLIENT_SECRET` | Xero OAuth |
| `STRIPE_SECRET_KEY` | Stripe invoices and payouts |
| `OPENAI_API_KEY` | LLM matching tier (Stage 4) |
| `SUPERMEMORY_API_KEY` | Entity memory grounding |
| `CRON_SECRET` / `CLEAN_DB_SECRET` | Scheduled and admin endpoint auth |

**[CONNECTORS.md](CONNECTORS.md) is the complete reference** — every external
system, what it contributes, and its exact variable names. Several are
non-obvious (`GMAIL_OAUTH_CLIENT_ID`, not `GMAIL_CLIENT_ID`;
`TWILIO_WHATSAPP_FROM`, not `_NUMBER`). The full annotated list lives in
[`web/.env.example`](web/.env.example).

Per-integration setup lives in
[`web/docs/`](web/docs/) —
[Plaid](web/docs/PLAID_SETUP.md),
[QuickBooks](web/docs/QBO_HEROKU_AND_INTUIT_SETUP.md),
[Xero](web/docs/XERO_SETUP.md),
[Slack](web/docs/SLACK_SETUP.md),
[Twilio/WhatsApp](web/docs/TWILIO_WHATSAPP_SETUP.md),
[database](web/docs/DATABASE_SETUP.md),
[GCS bucket](web/docs/GCP_ENTITY_BUCKET_SETUP.md).

---

## Testing

```bash
npm test              # run the suite
npm run test:watch    # watch mode
npm run test:coverage # coverage report
npm run typecheck     # tsc --noEmit
```

213 tests cover the money-critical primitives — string matching, entity URIs,
confidence scoring, amount and date bands, and the entity validator's LLM tier
(mocked; no test touches the network).

| Module | Stmts | Branch |
| --- | ---: | ---: |
| `confidence-scoring.ts` | 100% | 84.9% |
| `dashboard-calculations.ts` | 100% | 100% |
| `password-strength.ts` | 100% | 100% |
| `levenshtein.ts` | 97.3% | 95.1% |
| `entity-uri.ts` | 96.9% | 95.0% |
| `alias-normalize.ts` | 95.2% | 93.9% |

Repository-wide coverage is **3.4%** — 8 modules of ~140. That number is
deliberately published rather than hidden; [`REVIEW.md`](REVIEW.md) ranks what to
cover next and why.

Some tests are marked `CHARACTERISATION` or `KNOWN GAP`. Those **pin current
behaviour that looks wrong** so it cannot drift silently, rather than asserting
it is correct. Each is cross-referenced in `REVIEW.md`.

---

## Engineering notes

[`REVIEW.md`](REVIEW.md) is a standing review of this codebase: what was fixed,
what is knowingly still broken, and what to do next. Current highlights:

- The sync and async confidence builders return **different scores for identical
  inputs**, applying `categoryAdjustment` on scales ~33× apart. Characterised by
  tests; unfixed pending a decision on the intended semantics, because changing
  it shifts which matches auto-confirm.
- **349 TypeScript errors** are currently suppressed by
  `typescript.ignoreBuildErrors`. ~104 are untyped database rows — the exact
  place a renamed column becomes a silently wrong number.
- The LLM validator **fails open** on candidates the model omits from its
  response.

---

## Documentation

| Document | Contents |
| --- | --- |
| **[About](ABOUT.md)** | The problem, how it works, engineering notes, and an honest status |
| **[Usage](USAGE.md)** | **Start here** — run it, connect data, work on it, deploy it, troubleshoot |
| **[Connectors](CONNECTORS.md)** | All 14 integrations, with HTTP and code examples for each |
| [Contributing](CONTRIBUTING.md) | What you may do with this repository, and how changes land |
| [Security](SECURITY.md) | Reporting, the defences in place, and known weaknesses |
| [How it works](web/docs/HOW_IT_WORKS.md) | End-to-end flow, ingestion → UI |
| [Reconciliation layer](web/docs/RECONCILIATION_LAYER.md) | The waterfall in detail |
| [AR/AP architecture](web/docs/ar-ap-architecture.md) | Status SSOT and its write paths |
| [Classification precedence](web/docs/CLASSIFICATION_PRECEDENCE.md) | How movement classes are decided |
| [Entity graph](web/docs/ENTITY_GRAPH_INTEGRATION.md) | Identity resolution |
| [Queue](web/docs/BULL_QUEUE_IMPLEMENTATION.md) | Background job processing |
| [Quick start](docs/QUICK_START_GUIDE.md) | Fast local setup |
| [Review](REVIEW.md) | Findings, known gaps, testing roadmap |

Each significant directory also carries its own README, covering the conventions
that apply there — these sit next to the code and are the most likely to stay
accurate:

[`web/lib/`](web/lib/README.md) — the domain layer and its module families ·
[`web/lib/state/`](web/lib/state/README.md) — forecasting and derived state ·
[`web/lib/queue/`](web/lib/queue/README.md) — background jobs ·
[`web/app/api/`](web/app/api/README.md) — **the five authentication tiers** ·
[`web/components/`](web/components/README.md) ·
[`web/migrations/`](web/migrations/README.md) — the two schema paths ·
[`web/scripts/`](web/scripts/README.md)
