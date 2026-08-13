# Using this repository

Practical guide: get it running, connect data, work on it, deploy it. For what
Profitwise *is*, see the [README](README.md). For every connector and its
variables, see [CONNECTORS.md](CONNECTORS.md).

---

## 1. Run it locally

**Prerequisites:** Node 20+, PostgreSQL, Redis.

```bash
git clone https://github.com/kbhatnagar1506/ProfitwiseMain.git
cd ProfitwiseMain/web
npm install
cp .env.example .env.local
```

At minimum, fill in `DATABASE_URL` (or the four Cloud SQL variables) and
`REDIS_HOST` / `REDIS_PORT`. Everything else can stay blank to start — the app
runs with no connectors, it just has nothing to reconcile.

Apply the SQL migrations from the repository root:

```bash
cd .. && ./run-migrations.sh     # needs DATABASE_URL and psql
```

Then, in two terminals:

```bash
cd web && npm run dev        # http://localhost:3000
cd web && npm run worker     # background jobs — required for sync and forecasting
```

**The worker is not optional in practice.** Ingestion, classification, entity
matching, state computation and forecasting all run as queued jobs. Without it
the UI loads but data never moves past ingestion.

### A note on local auth

`lib/auth.ts` gates signup, login and session lookup on
`NODE_ENV === "production"`. Locally, `createSession` throws and
`getUserBySessionToken` returns `null`, so the normal login flow does not
complete. This is deliberate — it keeps the production auth tables from being
written by a dev instance — but it does mean local work on authenticated
surfaces needs either a production-like `NODE_ENV` or a seeded session.

---

## 2. Connect data

Users connect their own accounts through `/onboarding`, which walks each OAuth
integration in turn. Each provider needs its credentials in `.env.local` and its
redirect URI registered as `<APP_URL>/api/<provider>/oauth/callback`.

Order that gets you to something useful fastest:

1. **Plaid** — bank movements. Nothing reconciles without these.
2. **QuickBooks or Xero** — invoices and bills to match movements against.
3. **Stripe** — if you take card payments; this is what recovers processor fees
   so a net deposit can match a gross invoice.
4. **OpenAI + Supermemory** — enables the semantic matching tier. Optional;
   without them matching is deterministic-only and more conservative.

Everything else (Shopify, Gmail, Slack, WhatsApp) is additive.

---

## 3. How data flows

```
connect → sync → tag → classify → match → attribute → forecast
```

1. **Sync** pulls from each connected provider into `movements`, `cash_events`
   and the entity tables.
2. **Tag** assigns an economic class (`processor_payout`, `customer_cash_in`,
   `vendor_cash_out`, …).
3. **Classify** assigns a movement class with confidence, flagging low-evidence
   rows for review.
4. **Match** runs the five-stage reconciliation waterfall — stages 0–3
   deterministic, stage 4 LLM on whatever remains.
5. **Attribute** writes `movement_attributions`, the canonical per-movement
   decomposition, and updates `cash_events.status`.
6. **Forecast** projects forward from behavioural models per entity.

Triggered by `GET /api/ar-ap-reconciliation` (cached ~5 minutes; the client
polls until ready), or `POST /api/brain` to run attribution, cash-event sync and
profile refresh in one call.

Detail: [HOW_IT_WORKS.md](web/docs/HOW_IT_WORKS.md) ·
[RECONCILIATION_LAYER.md](web/docs/RECONCILIATION_LAYER.md)

---

## 4. Working on the code

```bash
cd web
npm test              # 213 tests, hermetic — no network, no database
npm run test:watch
npm run test:coverage
npm run typecheck
npm run lint
```

**Where things live.** Every significant directory has a README covering its
conventions: [`lib/`](web/lib/README.md) ·
[`lib/state/`](web/lib/state/README.md) · [`lib/queue/`](web/lib/queue/README.md) ·
[`app/api/`](web/app/api/README.md) · [`components/`](web/components/README.md) ·
[`migrations/`](web/migrations/README.md) · [`scripts/`](web/scripts/README.md)

**Four conventions worth knowing before your first change:**

1. **Pass the type argument to `query<T>()`.** It defaults to `unknown`.
   Omitting it is how a renamed column becomes a silently wrong number instead
   of a compile error.
2. **Only `lib/ar-ap-status.ts` writes `cash_events.status`.** There are six
   permitted write paths. A seventh breaks the single source of truth.
3. **Pick an auth tier deliberately for every new route.** There are five;
   `app/api/README.md` lists which routes use each. "No check" is never right.
4. **Never render a raw bank descriptor.** Go through
   `displayLabelForCounterparty()` — it handles owner redaction, invoice sludge
   and brand spacing.

**Adding a schema change?** Read [`web/migrations/README.md`](web/migrations/README.md)
first. There are two schema paths and editing the wrong one is a silent no-op.

**Tests marked `CHARACTERISATION` or `KNOWN GAP`** pin behaviour that is known
to be wrong, so it cannot drift before someone decides how it should work. They
are not endorsements. If one fails, do not "fix" it without reading the
corresponding entry in [REVIEW.md](REVIEW.md).

---

## 5. Deploy

Two processes, defined in the root `Procfile`:

```
web:    npm start                  # Next.js
worker: cd web && npm run worker   # Bull queue consumer
```

The root `package.json` handles the `web/` subdirectory for you, so a
platform building from the repository root needs no extra configuration.

> **If your platform has a Root Directory setting, it must point at `web`.**
> This directory was renamed from `v0-login-page-clone-2`; a stale setting is
> the single most likely cause of a failed deploy after pulling these changes.

Scheduled work is driven by hitting the `/api/cron/*` routes on a schedule with
`CRON_SECRET` as a bearer token.

**Branches:** `main` is the working branch. `production` is a curated history
that carries the same content; it shares no ancestor with `main`, so updates to
it are made as explicit merges rather than fast-forwards.

---

## 6. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Deploy fails, app not found | Root Directory still points at `v0-login-page-clone-2` |
| Data syncs but nothing reconciles | Worker is not running |
| Login does nothing locally | Auth is production-gated — see §1 |
| Everything matches deterministically, nothing semantic | No `OPENAI_API_KEY`; the matcher falls back to stricter thresholds by design |
| Entity names render split ("Quick Books") | Something is bypassing `displayLabelForCounterparty()` |
| `rowCount` is 0 when rows clearly changed | Pre-2026 code path; `query()` now returns `{ rows, rowCount }` |
| Redis connection refused | Config is `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`, not `REDIS_URL` |

**Before changing confidence scoring or the reconciliation waterfall, read
[REVIEW.md](REVIEW.md).** It documents known-open defects — including two
confidence builders that return different scores for identical inputs — that
will otherwise look like bugs you just introduced.

---

## 7. Where to look next

| Question | Document |
| --- | --- |
| What does this do, and how does matching work? | [README.md](README.md) |
| What connects to it, and how do I configure that? | [CONNECTORS.md](CONNECTORS.md) |
| What's broken, and what should I work on? | [REVIEW.md](REVIEW.md) |
| How does data actually flow end to end? | [HOW_IT_WORKS.md](web/docs/HOW_IT_WORKS.md) |
| How is AR/AP status decided? | [ar-ap-architecture.md](web/docs/ar-ap-architecture.md) |
