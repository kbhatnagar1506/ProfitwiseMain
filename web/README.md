# Profitwise — application

The Next.js application: API routes, domain logic, background workers and UI.
For product context, architecture and the reconciliation model, start with the
[repository README](../README.md).

> **Deploy note.** This directory was previously named `v0-login-page-clone-2`,
> after the project's first scaffold in v0.app. The path is referenced by the
> `Procfile`, the root `package.json` scripts, `run-migrations.sh` and CI — all
> updated — but any **Root Directory** setting configured in Vercel or Heroku
> lives outside the repository and must be repointed to `web` separately.

---

## Layout

```
app/
├── api/            169 route handlers — integrations, reconciliation, dashboard
├── dashboard/      34 surfaces: cashflow, forecast, invoices, entity graph, …
├── onboarding/     connect-your-accounts flow
├── oauth/          per-integration OAuth callbacks
└── page.tsx        marketing + login

lib/                the domain layer, ~140 modules
├── reconciliation-*    matching waterfall, fusion engine, case classifier
├── entity-*            identity resolution, clustering, payment profiles
├── confidence-*        component scoring and human-readable explanation
├── movement-*          classification, tagging, pattern analysis
├── state/              forecast engine and calibration
├── queue/              Bull workers and job processors
└── db.ts               Postgres pool, schema bootstrap, transactions

components/         UI; components/ui/ is shadcn/ui primitives
migrations/         SQL migrations
docs/               setup guides and architecture references
```

---

## Commands

```bash
npm run dev             # development server
npm run build           # production build
npm start               # serve the build
npm run worker          # Bull queue worker (runs as its own process)

npm test                # Vitest suite
npm run test:watch      # watch mode
npm run test:coverage   # coverage report
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
```

Operational scripts:

```bash
npm run seed:classification-signatures
npm run canary:health-check
npm run db:list-migrations
npm run db:rollback -- <version>
```

---

## Testing

Tests sit next to the code they cover (`lib/*.test.ts`) and run on Vitest with
v8 coverage. Configuration is in [`vitest.config.mts`](vitest.config.mts).

Two conventions worth knowing before adding tests:

- **Unit tests are hermetic.** Nothing hits the network or a database. The LLM
  tier is exercised by stubbing the environment and mocking `fetch`, then
  importing the module fresh — see
  [`lib/reconciliation-entity-validator.llm.test.ts`](lib/reconciliation-entity-validator.llm.test.ts).
- **`CHARACTERISATION` / `KNOWN GAP` tests pin bugs, not specifications.** They
  exist so known-wrong behaviour cannot drift unnoticed before someone decides
  how it should work. Do not treat them as endorsements; each is cross-referenced
  in [`REVIEW.md`](../REVIEW.md).

Modules that open a database or Redis connection at import time cannot be unit
tested as they stand. Introducing a seam around `query<T>()` in `lib/db.ts` is
the highest-leverage refactor available and unlocks the reconciliation layer —
see the roadmap in [`REVIEW.md`](../REVIEW.md).

---

## Configuration

Copy [`.env.example`](.env.example) to `.env.local` and fill it in. Every
integration is independently optional; the app degrades gracefully when one is
unconfigured, and the LLM matching tier falls back to strict deterministic
thresholds rather than guessing when no API key is present.

Notable build settings in [`next.config.js`](next.config.js):

- `typescript.ignoreBuildErrors: true` — there is a backlog of pre-existing type
  errors. CI reports the count without gating merges; see `REVIEW.md` §3.2.
- `bull` and `redis` are marked as server externals so they are not bundled.

---

## Setup guides

[Database](docs/DATABASE_SETUP.md) ·
[Plaid](docs/PLAID_SETUP.md) ·
[QuickBooks](docs/QBO_HEROKU_AND_INTUIT_SETUP.md) ·
[Xero](docs/XERO_SETUP.md) ·
[Slack](docs/SLACK_SETUP.md) ·
[Twilio/WhatsApp](docs/TWILIO_WHATSAPP_SETUP.md) ·
[GCS bucket](docs/GCP_ENTITY_BUCKET_SETUP.md)

Architecture: [how it works](docs/HOW_IT_WORKS.md) ·
[reconciliation layer](docs/RECONCILIATION_LAYER.md) ·
[AR/AP status SSOT](docs/ar-ap-architecture.md) ·
[entity graph](docs/ENTITY_GRAPH_INTEGRATION.md) ·
[queue](docs/BULL_QUEUE_IMPLEMENTATION.md)
