<h1 align="center">Profitwise — Complete Technical Reference</h1>

<p align="center">
  Every subsystem, every table, every route, every model.<br>
  Written from the source, not from memory.
</p>

---

## Contents

1. [What this system is](#1-what-this-system-is)
2. [By the numbers](#2-by-the-numbers)
3. [The canonical data model](#3-the-canonical-data-model)
4. [End-to-end data flow](#4-end-to-end-data-flow)
5. [Ingestion — the connector layer](#5-ingestion--the-connector-layer)
6. [Normalization — classification and identity](#6-normalization--classification-and-identity)
7. [Reconciliation — the five-stage waterfall](#7-reconciliation--the-five-stage-waterfall)
8. [Confidence scoring](#8-confidence-scoring)
9. [Forecasting](#9-forecasting)
10. [Business state — risk and insight](#10-business-state--risk-and-insight)
11. [The API surface](#11-the-api-surface--169-routes)
12. [Background jobs](#12-background-jobs)
13. [Frontend surfaces](#13-frontend-surfaces)
14. [Database schema](#14-database-schema--60-tables)
15. [Security model](#15-security-model)
16. [Testing](#16-testing)
17. [Known defects](#17-known-defects)
18. [Build and deploy](#18-build-and-deploy)
19. [Appendix: environment variables](#19-appendix-environment-variables)
20. [Appendix: glossary](#20-appendix-glossary)

---

## 1. What this system is

A business with a bank account, an accounting ledger and a card processor holds
three partial, differently-shaped views of the same money. None of them answers
the operator's actual question:

> *This $4,182.55 landed on Tuesday. What was it for?*

The bank says `ACH CREDIT SP NORTHWIND - WHOLESALE`. The ledger has an open
invoice for `Northwind Oat Bars` at `$4,200.00`. Same transaction — but four
things disagree:

| Dimension | Why it disagrees |
| --- | --- |
| **Name** | Bank descriptors are truncated, processor-prefixed, and rarely match a ledger contact |
| **Amount** | The processor deducted its fee before the money landed |
| **Date** | Settlement lags invoicing by days or weeks |
| **Cardinality** | One deposit may settle three invoices; one invoice may arrive as two partials |

Profitwise resolves all four automatically, attaches an auditable confidence
score to every decision, and escalates to a human only when evidence is weak.
It then forecasts forward from the reconciled history.

**Two products, one dataset.** Reconciliation produces a clean ledger of what
happened; forecasting projects it forward. The second is only as good as the
first, which is why roughly two-thirds of the domain layer is matching logic.

---

## 2. By the numbers

| Metric | Value |
| --- | ---: |
| TypeScript, total | **107,168 lines** |
| `lib/` — domain layer | 53,618 lines — 143 top-level modules, 171 including `state/` and `queue/` |
| `app/` — routes and pages | 31,314 lines |
| `components/` — UI | 20,622 lines |
| API route handlers | **169** across 37 groups |
| Database tables | **60** |
| Dashboard surfaces | 34 |
| External integrations | 14 |
| Background job processors | 7 |
| Runtime dependencies | 69 (+7 dev) |
| Tests | 213 across 9 files |
| Commits | ~950, since August 2025 |

### Largest modules

| Lines | Module |
| ---: | --- |
| 6,837 | `components/onboarding-flow.tsx` |
| 5,811 | `lib/state/forecast-engine.ts` |
| 2,832 | `lib/movement-classify.ts` |
| 1,943 | `lib/db.ts` |
| 1,759 | `app/dashboard/reconciliation/page.tsx` |
| 1,647 | `app/dashboard/reconciliation-candidates/page.tsx` |
| 1,497 | `lib/reconciliation-waterfall.ts` |
| 1,281 | `lib/identity-seed.ts` |
| 1,098 | `lib/state/forecast-calibration.ts` |
| 1,079 | `lib/reconciliation-fusion-engine.ts` |
| 1,076 | `lib/reconciliation-case-classifier.ts` |

Those top two are the honest weak points: a 6,800-line component and a
5,800-line engine are both past the size where anyone reasons about them whole.

---

## 3. The canonical data model

Everything reduces to three concepts. Fourteen connectors exist to populate
them, and the reconciliation engine reads nothing else.

```
┌──────────────────┬────────────────────────────────────────────────────┐
│ movements        │ Money that actually moved. The bank's version of    │
│                  │ events. Immutable fact.                             │
├──────────────────┼────────────────────────────────────────────────────┤
│ cash_events      │ Money owed or expected — AR invoices, AP bills.      │
│                  │ The ledger's version. Has a lifecycle status.        │
├──────────────────┼────────────────────────────────────────────────────┤
│ entities         │ Who the counterparty is, resolved to one identity    │
│                  │ across every source.                                │
└──────────────────┴────────────────────────────────────────────────────┘
                                    │
                                    ▼
                        movement_attributions
        The join. Which movement paid which cash_event, how much,
        by what method, with what confidence, and why.
```

**`movement_attributions` is the output of the entire system.** Everything
upstream exists to produce correct rows in it; everything downstream reads it.

### The connector contract

> A connector's only job is to produce `movements`, `cash_events` and
> `entities`. It never decides what matches what.

This is why adding a fifteenth integration does not touch reconciliation.

---

## 4. End-to-end data flow

```
  connect → sync → tag → classify → resolve → match → attribute → forecast
     │        │      │       │         │        │         │           │
   OAuth   provider  economic movement entity  5-stage  movement_  behavioural
           APIs      class    class    graph   waterfall attributions  models
```

| Step | Module | Produces |
| --- | --- | --- |
| **Connect** | `app/api/<provider>/oauth/*` | Stored token, signed `state` validated |
| **Sync** | `lib/<provider>-sync.ts` | Raw provider records |
| **Translate** | `lib/<provider>-movements.ts` | Canonical `movements` rows |
| **Tag** | `lib/movement-tag-enrich.ts` | `economic_class` per movement |
| **Classify** | `lib/movement-classify.ts` | `movement_class`, confidence, review flags |
| **Resolve** | `lib/entity-resolution.ts`, `lib/identity-seed.ts` | Canonical `entity_id` |
| **Match** | `lib/reconciliation-waterfall.ts` | Candidate pairings |
| **Attribute** | `lib/attribution-persist.ts` | `movement_attributions` rows |
| **Status** | `lib/ar-ap-status.ts` | `cash_events.status` transitions |
| **Forecast** | `lib/state/forecast-engine.ts` | Cash projection, runway, interventions |

**Entry points**

```ts
import { runFullReconciliation } from "@/lib/full-reconciliation"
const result = await runFullReconciliation(userId)
// { waterfall, llm, totalAttributions, remainingUnmatched, executionTimeMs, warnings }
```

```bash
GET  /api/ar-ap-reconciliation   # cached ~5 min; client polls until ready
POST /api/brain                  # attribution + cash_events sync + profile refresh
POST /api/state/compute          # derived business state
GET  /api/forecast               # cash forecast
```

---

## 5. Ingestion — the connector layer

Fourteen integrations, each independently optional. Absence degrades
capability; it never crashes the app.

### Data sources

| Connector | Provides | Lands in |
| --- | --- | --- |
| **Plaid** | Accounts, balances, transactions, cursor-based `/transactions/sync`, item webhooks | `movements` |
| **QuickBooks** | Invoices, bills, customers, vendors, accounts, payments | `cash_events`, `entities` |
| **Xero** | Same ledger surface, multi-tenant by tenant ID | `cash_events`, `entities` |
| **Stripe** | Invoices, payouts, balance transactions, charges | `cash_events`, `movements` |
| **Shopify** | Orders → inflow movements, deduped against payouts | `movements` |
| **Gmail** | Invoice/bill extraction from email via LLM | `cash_events` |

**Stripe deserves special attention.** Payout sync expands
`balance_transaction` to recover the exact processing fee. Without that number,
no card deposit ever equals its invoice and the whole waterfall falls through to
manual review. Fee recovery is a precondition for the product working at all,
not a nicety.

**Shopify's role is subtractive.** A Shopify order and the Stripe payout that
settles it are the same money seen twice. `lib/cross-source-dedup.ts` resolves
the overlap so revenue is reconciled rather than double-counted.

**Gmail is the reach extender.** Most small businesses have no accounting
integration. Their invoices are PDFs in an inbox. This connector is what makes
the product addressable to them.

### Intelligence

| Connector | Role |
| --- | --- |
| **OpenAI** | Reconciliation Stage 4 only; invoice extraction; movement classification; forecast narrative |
| **Supermemory** | Entity memory — grounds the LLM in the user's own entity graph |

**Supermemory is the compounding loop.** When a user confirms
`SP NORTHWIND - WHOLESALE` is `Northwind Oat Bars`, that pattern is written
back. Next occurrence resolves on the fast path — no model call. Matching gets
cheaper and more accurate with use rather than restarting cold.

### Channels

| Connector | Surface |
| --- | --- |
| **Slack** | `/api/slack/events`, signature-verified |
| **Twilio (WhatsApp)** | OTP-verified phone linking, inbound webhook |

> **`/api/twillo/…` is deliberately misspelled.** That is the URL registered in
> the Twilio console. A correctly-spelled `/api/twilio/webhook/whatsapp` also
> exists. Repoint Twilio before removing the misspelled one.

### Infrastructure

| Service | Role |
| --- | --- |
| **PostgreSQL** | Primary datastore — `DATABASE_URL` or GCP Cloud SQL connector |
| **Redis** | Bull queue backend — host/port/password, *not* a URL |
| **Google Cloud Storage** | Blob store for raw QBO/Xero entity payloads |
| **reCAPTCHA** | Signup protection |

Full setup per connector: [CONNECTORS.md](CONNECTORS.md).

---

## 6. Normalization — classification and identity

Between ingestion and matching sits the layer that makes matching possible at
all.

### Movement classification

Every movement receives a `MovementClass` (`lib/movement-types.ts`):

```
customer_cash_in     vendor_cash_out      internal_transfer
processor_fee        processor_payout     merchant_deposit
owner_contribution   owner_draw           credit_card_payment
bank_fee             bank_fee_refund      refund
interest             opening_balance
```

Plus a coarser `economic_class` used for filtering and merchant-deposit
detection:

```
customer_cash_in   vendor_cash_out   processor_payout   payroll
owner_contribution owner_draw        debt_payment       tax_authority
owner_contribution_candidate         owner_vs_processor_conflict
unknown
```

**Provenance** records where a movement came from:
`bank_observed` · `accounting_observed` · `coalesced`.

### The review queue

Classification is not binary. Low-confidence rows are flagged with a
`ReviewReason` rather than silently guessed:

```
low_classification_confidence   weak_classification    weak_entity_match
direction_type_mismatch         provisional_classification
llm_fallback                    low_evidence           owner_vs_processor_conflict
transfer_endpoint_unknown       duplicate_candidate    synthetic_label
settlement_adjustment_ambiguous
```

Each maps to a specific human question. `owner_vs_processor_conflict` means the
system cannot tell an owner contribution from a processor settlement — a
distinction that changes the P&L, so it asks rather than assumes.

A `StateInclusionPolicy` (`include` / `include_provisional` /
`exclude_and_review`) then governs whether a movement reaches derived state.

### Entity resolution

Bank descriptors, ledger contacts and processor payouts rarely agree on a name.
This layer converges them.

| Technique | Module | Handles |
| --- | --- | --- |
| Alias normalization | `alias-normalize.ts` | Case, punctuation, camelCase splitting |
| Edit distance | `levenshtein.ts` | Typos — `Whitfield` vs `Whitfiel` |
| Token overlap | `levenshtein.ts` | Jaccard — word-order and suffix variation |
| Org-qualifier stripping | `reconciliation-entity-validator.ts` | `Marcus Feld (Eastgate Football)` → `Marcus Feld` |
| Clustering | `entity-clustering.ts` | Anchor/satellite entities, archetype inheritance |
| Identity graph | `identity-seed.ts` | Seeded graph, alias refresh from accounting |
| Semantic validation | `reconciliation-entity-validator.ts` | LLM tier grounded in Supermemory |
| Canonical URIs | `entity-uri.ts` | `ar://invoice/qbo/123`, `ap://bill/xero/b9` |

Similarity is a weighted blend — **40% Levenshtein, 60% token overlap** — because
token overlap handles partial matches (`Summit Provisions` vs
`Summit Provisions Foods`) far better than pure edit distance.

Clustering functions: `clusterEntities`, `selectAnchorEntity`,
`getSatelliteEntities`, `calculateSatelliteConfidenceBoost`,
`shouldInheritArchetype`, `shouldMergeModels`, `getClusterStats`.

### Display normalization

`displayLabelForCounterparty()` is the only sanctioned path to a user-visible
counterparty name. It handles owner redaction, invoice sludge (`INV-123`,
`Payment for invoice`), Plaid's `(deleted)` suffix, and canonical brand spacing.
Rendering a raw descriptor bypasses all of it.

---

## 7. Reconciliation — the five-stage waterfall

`lib/reconciliation-waterfall.ts` (1,497 lines). Stages run cheapest and most
certain first, so the expensive tier only ever sees the residue.

```
runFullReconciliation(userId)
│
├─ Stage 0   AI semantic entity validation      (line ~682)
│            Pre-filter: which candidates are even the same entity?
│
├─ Stage 0b  Direct link                        (line ~759)
│            tag_data already carries invoice_id / bill_id
│
├─ Stage 1   Exact amount match                 (line ~855)
│            Including processor-fee-aware matching for inflows
│
├─ Stage 2   Processor fee band                 (line ~933)
│            AR inflows from processor-like movements
│
├─ Stage 3   FIFO with tolerance                (line ~999)
│            Oldest-open-first, with greedy-sweep prevention
│
└─ Stage 4   Large leftover → review            (line ~1259)
             Flags for LLM/batch review; does NOT auto-apply
```

**Stage 4 does not auto-apply.** It records review hints on movements. The LLM
match is a separate, explicit call (`batchLLMMatch` in
`reconciliation-llm-match.ts`). A model is never given unsupervised authority to
book money.

**Greedy-sweep prevention** in Stage 3 matters: naive FIFO lets one large
deposit consume every open invoice in sequence, producing a tidy-looking and
completely wrong ledger.

### Supporting engines

| Module | Lines | Role |
| --- | ---: | --- |
| `reconciliation-fusion-engine.ts` | 1,079 | `runFusionReconciliation` — multi-signal fusion |
| `reconciliation-case-classifier.ts` | 1,076 | Classifies the *kind* of reconciliation case |
| `reconciliation-entity-validator.ts` | 801 | Fast-path + memory + LLM entity validation |
| `reconciliation-ai-matcher.ts` | 783 | LLM-assisted matching |
| `reconciliation-llm-match.ts` | 757 | Stage 4 batch LLM |
| `reconciliation-customer-matcher.ts` | 239 | Movement → customer attribution |
| `reconciliation-audit-log.ts` | — | Every decision recorded |
| `reconciliation-monitoring.ts` | — | Metrics |

The case classifier recognises: `auto_match`, `review`, `manual`, `exclude`,
`duplicate`, `chargeback`, `dispute`, `refund`, `reversal`, `return`, `credit`,
`charge`, `processor_fee`, `processor_payout`, `bank_fee`, `bank_fee_refund`,
`interest`, `opening_balance`, `owner_contribution`, `owner_draw`,
`account_verification`.

### The entity validator's three tiers

`validateEntitiesForBankDescription()`:

1. **Memory pattern** — Supermemory knows this descriptor → `memory_pattern_accept`
2. **Fast path** — string similarity decides
   - `≥ 0.65` → `fast_accept`
   - `< 0.08` → `fast_reject`
   - between → defer
3. **LLM** — grounded in memory context → `llm_accept` / `llm_reject`
   - unavailable → strict deterministic fallback at `≥ 0.70`

The fallback is stricter than the fast-path accept bar. An LLM outage narrows
what gets accepted; it can never widen it.

### Attribution model

```ts
type AllocationTargetType = "ar" | "ap" | "fee" | "transfer" | "unknown"
type MatchMethod = "exact" | "tolerance" | "llm_suggested" | "manual" | "stripe_payout_match"
```

Each attribution records `gross_applied`, `fee_amount`, `net_applied`,
`confidence`, `match_method`, and a `confidence_detail` JSONB blob carrying the
full breakdown for audit replay.

### AR/AP status — single source of truth

`cash_events.status` is canonical. **Exactly six write paths**, all routed
through `lib/ar-ap-status.ts`.

| Status | Meaning | Computed |
| --- | --- | --- |
| `open` | Outstanding = full amount | Server, stored |
| `partially_paid` | 0 < outstanding < amount | Server, stored |
| `paid` | Outstanding ≤ $0.01 | Server, stored |
| `void` | `voided_at IS NOT NULL` | Server, stored |
| `overdue` | `open` AND past `expected_date` | **Query time only — never stored** |

`display_status` is a stored generated column. `overdue` is deliberately not
persisted: a stored value is wrong the next morning.

---

## 8. Confidence scoring

`lib/confidence-scoring.ts`. Every match carries a component breakdown, not a
bare number, so a decision can be audited after the fact.

| Component | Weight | Detail |
| --- | ---: | --- |
| Amount agreement | 0.30 | Banded, see below |
| Entity name (heuristic) | 0.20 | 0.4·Levenshtein + 0.6·Jaccard |
| Entity name (AI validation) | 0.25 | Semantic check; falls back to heuristic |
| Date proximity | 0.15 | Banded, see below |
| Historical behaviour | 0.05 | Has this pair matched before? |
| Category | 0.03 | Same economic class |
| Match sequence | 0.02 | Penalty for the Nth match on one movement |

Weights sum to 1.00 — pinned by a test.

### Amount bands (`computeAmountScore`)

| Deviation | Score |
| --- | ---: |
| < 0.1% | 1.00 |
| < 1% | 0.97 |
| < 3% | 0.92 |
| < 5% | 0.88 |
| < 10% | 0.80 |
| < 20% | 0.65 |
| Beyond, underpayment | 0.60 |
| Beyond, overpayment | 0.40 |

Underpayment scores above overpayment: a partial settlement is plausible, an
overpayment past 20% usually means the wrong invoice. A non-positive target
returns 0 rather than dividing by zero.

### Date bands (`computeDateProximityScore`)

| Gap | Score |
| --- | ---: |
| ≤ 1 day | 1.00 |
| ≤ 7 days | 0.93 |
| ≤ 14 days | 0.87 |
| ≤ 30 days | 0.80 |
| ≤ 60 days | 0.72 |
| ≤ 90 days | 0.65 |
| Beyond | 0.50 |
| Missing / unparseable | 0.75 (neutral) |

Symmetric — paying early scores identically to paying late.

### Labels and clamp

```
≥ 0.88  high      ≥ 0.75  medium      ≥ 0.60  low      else  very_low
```

Final score is clamped to **[0.40, 0.99]**. Nothing is ever certain, and nothing
is ever hopeless.

> **Known defect.** `buildConfidenceBreakdown` (async) and
> `buildSyncConfidenceBreakdown` (sync) return *different scores for identical
> inputs*. The async path adds `historyAdj`, `categoryAdjustment` and the
> sequence penalty as raw offsets after the weighted sum; the sync path folds
> them through their declared weights. `categoryAdjustment: 0.2` moves the sync
> path by +0.006 and the async path by +0.200 — a ~33× divergence. See §17.

---

## 9. Forecasting

`lib/state/forecast-engine.ts` (5,811 lines), entry point
`computeCashflowForecast()`.

### What it delivers

| Output | Detail |
| --- | --- |
| **30-day daily simulation** | Day-by-day cash balance |
| **`events_30d`** | Discrete events — which entity, which day, what probability |
| **6-month projection** | Configurable horizon, three scenarios |
| **Monte Carlo** | Percentile bands + probability queries |
| **Cash runway** | Base and pessimistic months, monthly burn rate |
| **Sensitivity** | Ranked drivers; top risk and top opportunity |
| **Interventions** | Simulated actions with before/after low point |
| **Backtest** | Accuracy vs. four naive baselines |
| **Narrative** | LLM-written summary — text only, never numbers |

Headline outputs are probabilistic: `prob_below_zero_14d`,
`prob_below_zero_30d`, `prob_above_starting_30d`, and p5/p25/p50/p75/p95 per day.

### Per-entity behavioural models

Not a single time series — every counterparty is classified into an archetype,
and the archetype selects the model.

**Customers** (`CustomerArchetype`):

| Archetype | Model |
| --- | --- |
| `clockwork` | Tight interval, low variance — cadence model |
| `bursty` | Payments cluster then go silent — hazard model |
| `episodic` | Project-based, large irregular — opportunity-weighted |
| `slow_reliable` | Always late but pays — invoice-aging model |
| `volatile` | Erratic amounts and timing |
| `low_data` | Under 3 payments — invoice-driven |

**Vendors** (`VendorArchetype`): `hard_due_date`, `soft_recurring`, `one_off_ap`,
`spend_on_demand`, `batch_supplier`, `treasury_linked`.

**Inflow event classes**: `clockwork_receivable`, `likely_receivable`,
`overdue_receivable`, `sporadic_receivable`, `processor_settlement`,
`owner_support`, `treasury_transfer`, `unknown`.

**Recurrence types**: `hard`, `soft`, `episodic`, `seasonal`,
`invoice_triggered`, `unknown`.

### Monte Carlo

`runMonteCarlo()` — **500 simulations** by default. Each run perturbs three
things per event:

| Dimension | Method | Parameters |
| --- | --- | --- |
| **Occurrence** | Bernoulli against event probability | Floor 0.02, ceiling 0.95 |
| **Amount** | Gaussian noise (Box-Muller) | 8% / 15% / 25% by confidence |
| **Timing** | Gaussian delay | ±1 / ±3 / ±5 days by confidence, ×0.5 multiplier |

Scenario biases (`base`, `conservative`, `aggressive`) shift inflow/outflow
probability, amount and delay independently.

**Seeded PRNG** (`mulberry32`, seeded on user + date). A given user and date
reproduce identically — a refresh cannot silently change the number, which
matters for a financial product.

Next-payment timing uses a **normal CDF** (`normalCdf` at 7/14/30 days against
the entity's interval and variance). Anomalous payments are **excluded from the
interval estimate** when at least two normal ones remain.

### Settlement timing from reconciliation

`lib/settlement-timing.ts` extracts empirical days-to-pay from *reconciled*
AR/AP movements and feeds it back as the timing prior.

This is the loop that ties the two halves of the product together: the forecast
learns from matches the reconciliation engine confirmed. Better matching
produces better forecasting, mechanically.

### Calibration and backtesting

`DEFAULT_FORECAST_CALIBRATION` (`forecast-calibration.ts`, 1,098 lines) holds
every constant — probability bounds, archetype multipliers and fallbacks,
Monte Carlo noise, scenario biases, seasonality, transfer model, confidence
weights, narrative and intervention parameters, portfolio priors, settlement
timing. Tunable per user via `/api/cron/forecast-calibration-tune`.

Backtests report `accuracy_score`, `mean_absolute_error`, `direction_accuracy`,
`event_occurrence_accuracy`, `low_point_accuracy`, and breakdowns by horizon and
segment.

**They also benchmark against four naive baselines**, each with a `beats_engine`
flag:

```
naive_carry_forward   rolling_average   due_date_only   last_cycle_repeat
```

The engine measures whether it is actually better than doing nothing clever.
That is unusual and worth noting.

### Forecast confidence

Composite of eight components: `transaction_tagging`, `entity_resolution`,
`inflow_model`, `outflow_model`, `recurrence`, `calibration`, `horizon_penalty`,
`unresolved_exposure` — plus an identity breakdown
(`high_confidence_canonical_pct`, `weak_inferred_pct`, `unresolved_pct`).

### What the LLM does *not* do

It does not produce the numbers. Forecast LLM surface is narrative and identity
only: `generateNarrativeWithLLM`, `canonicalizeEntitiesBatch`,
`disambiguateEntity`, `generateExecutionSuggestions`. The one path touching
models — `enhanceModelsWithAI` — writes `_ai_confidence_boost`, adjusting
*confidence* only, never an amount or a date.

**Cash numbers are fully deterministic given a seed.**

---

## 10. Business state — risk and insight

`computeBusinessState()` assembles a `BusinessState`:

```ts
{ revenue, spend, liquidity, risk, transitions, insights,
  state_confidence, insight_block, computed_at }
```

- `lib/state/risk-engine.ts` → `computeRiskState`
- `lib/state/insight-engine.ts` → `computeInsights`
- `lib/state/ar-ap-from-attributions.ts` → AR/AP position derived from
  attributions, not from the ledger directly
- `lib/state/behavioral-timing-ar.ts` → per-entity payment timing

Entity-level scoring lives in `lib/dashboard-calculations.ts`: percentile
ranking, data-quality scoring (transaction count 30%, data span 30%, due-date
coverage 20%, consistency 20%), trend velocity, and peer statistics grouped by
archetype.

---

## 11. The API surface — 169 routes

37 groups. Handlers stay thin: parse, authorise, delegate to `lib/`, shape the
response.

| Group | Routes | Purpose |
| --- | ---: | --- |
| `dashboard/` | 31 | Read models for every dashboard surface |
| `admin/` | 16 | Destructive/operational — shared-secret, production-only |
| `books/` | 12 | General ledger, P&L, chart of accounts, journal entries, period locks |
| `movements/` | 10 | Listing, tagging, classification, explain, merge/unmerge |
| `plaid/` | 7 | Link token, exchange, sync, balances, items, webhook |
| `xero/` `stripe/` `quickbooks/` | 18 | OAuth, sync, status, disconnect, webhook |
| `ar-reconciliation/` | 6 | Candidates, invoices, matches, stats, summary |
| `cron/` | 6 | Scheduled sync and maintenance |
| `shopify/` `slack/` | 10 | OAuth, sync/events, status, disconnect |
| `supermemory/` | 4 | Company context, connections, status |
| `whatsapp/` `twilio/` `twillo/` | 7 | OTP verification, send, inbound webhooks |
| `forecast/` | 5 | Forecast, status, cache clear, user decisions, strategy |
| `context/` | 5 | Financial context build/merge/save |
| `entities/` `entity-*` | 6 | Entity CRUD, alias suggestions, relationships, profile feedback |
| `auth/` | 4 | Login, logout, signup, session |
| `onboarding/` | 4 | Progress, company form, autofill, post-identity |
| `identity/` | 3 | Graph read, seed, wipe |
| `reconciliation/` `dedup/` `brain/` `state/` `drafts/` `explain-match/` `raw-data/` `v1/` | — | Cross-cutting |

### Notable individual routes

| Route | What it does |
| --- | --- |
| `POST /api/brain` | Attribution + cash_events sync + profile refresh in one call |
| `GET /api/ar-ap-reconciliation` | Cached ~5 min; sets `processing`, client polls to `ready` |
| `POST /api/dashboard/reconciliation/split-match` | One movement across several invoices |
| `DELETE /api/dashboard/reconciliation/unmatch` | Reverse an attribution |
| `POST /api/explain-match` | Human-readable justification for a match |
| `POST /api/movements/override-policy` | Manual `StateInclusionPolicy` override |
| `GET /api/books/ai-auditor` | LLM review of the ledger |
| `POST /api/admin/wipe-all-user-data` | Truncates everything; production-only, secret-gated |

---

## 12. Background jobs

Bull over Redis, running as a separate `worker` process. Nothing here executes
inside a request.

```bash
npm run worker    # tsx lib/queue/worker.ts
```

| Processor | Work |
| --- | --- |
| `sync-initial-data` | First full pull after an integration connects |
| `process-webhook` | Provider webhook payloads, off the request path |
| `tag-movements` | Assign economic class |
| `classify-movements` | Movement class, confidence, review flags |
| `match-customers` | Entity resolution against the customer graph |
| `compute-state` | Derived AR/AP and liquidity state |
| `generate-forecast` | Forecast runs |

Roughly the ingestion pipeline in order: sync → tag → classify → match →
compute → forecast.

Supporting: `bull-client.ts`, `bull-config.ts`, `job-types.ts` (the
producer/consumer contract), `queue-wrapper.ts`, `queue-logger.ts`,
`connection-monitor.ts`, `redis-monitor.ts`.

**Jobs must be idempotent** — Bull retries, and webhook delivery is
at-least-once. A processor running twice must not double an attribution.

`bull` and `redis` are marked as server externals in `next.config.js` so they
are never bundled.

---

## 13. Frontend surfaces

**34 dashboard pages:**

```
home              cashflow          forecast          runway
scenarios         business-state    reconciliation    reconciliation-candidates
ar-reconciliation review-queue      chase-queue       invoices
bills             transactions      transfers         payment-timing
customers         vendors           contacts          entities
entity-graph      entity-profiles   bank-accounts     books
p-and-l           spend-analysis    tax-prep          generate-report
movement-classification             gmail-intelligence
memory-layer      activity-log      alerts            settings
```

**Public/auth pages:** `/` (login screen — there is no marketing landing page in
this repo), `/onboarding`,
`/oauth/[integration]`, `/entities`, `/payments`, `/reconciliation`,
`/privacy`, `/terms`.

**Component structure:** `components/ui/` is shadcn/ui over Radix (generated —
prefer configuring over editing); `components/dashboard/` is the app shell;
`components/shared/` holds cross-surface domain widgets; the top level holds
feature components.

---

## 14. Database schema — 60 tables

Schema is applied by **15 idempotent `ensure*Schema()` functions** in
`lib/db.ts`, called on demand by routes, plus standalone SQL files in
`web/migrations/`.

| Schema function | Domain |
| --- | --- |
| `ensureAuthSchema` | `users`, `sessions` |
| `ensurePlaidSchema` | `plaid_items`, `plaid_accounts`, `plaid_transactions`, `plaid_webhook_last` |
| `ensureQBOSchema` | `qbo_connections`, `qbo_entities`, `qbo_sync_status` |
| `ensureXeroSchema` | `xero_connections`, `xero_entities` |
| `ensureStripeSchema` | `stripe_connections`, `stripe_entities` |
| `ensureShopifySchema` | `shopify_connections`, `shopify_entities`, `shopify_sync_state` |
| `ensureGmailSchema` | `gmail_connections`, `gmail_synced_messages` |
| `ensureMerchantTagsSchema` | `merchant_tags` |
| `ensureWhatsAppSchema` | `user_whatsapp` |
| `ensureSlackSchema` | `user_slack`, `slack_events_seen` |
| `ensureIdentitySchema` | `identity_assertions`, `identity_resolution_decisions`, `account_ownership` |
| `ensureMovementsSchema` | `movements`, `movement_attributions`, `cash_events`, `entities`, … |
| `ensureJobStatusSchema` | `job_status` |
| `ensureUserDecisionsSchema` | `user_intervention_decisions`, `user_strategy_selections` |
| `ensureARMatchesSchema` | `ar_reconciliation_matches` |

### Tables by domain

**Core ledger**
`movements` · `movement_attributions` · `movement_allocations` *(legacy, no
longer written)* · `movement_tags` · `movement_families` ·
`movement_observations` · `movement_explanations_cache` · `cash_events` ·
`ar_ap_status_log` · `period_locks`

**Entities and identity**
`entities` · `entity_aliases` · `entity_alias_suggestions` ·
`entity_alias_blacklist` · `entity_relationships` · `entity_transactions` ·
`entity_payment_profiles` · `entity_profile_feedback` · `identity_assertions` ·
`identity_resolution_decisions` · `account_ownership`

**Reconciliation**
`ar_reconciliation_matches` · `reconciliation_audit_log` ·
`reconciliation_cache` · `reconciliation_locks` · `reconciliation_metrics` ·
`reconciliation_test_cases`

**Forecast and state**
`forecast_cache` · `forecast_calibration_overrides` · `forecast_history` ·
`state_snapshots` · `user_intervention_decisions` · `user_strategy_selections` ·
`user_classification_signatures`

**Connectors**
`plaid_items` · `plaid_accounts` · `plaid_transactions` · `plaid_webhook_last` ·
`qbo_connections` · `qbo_entities` · `qbo_sync_status` · `xero_connections` ·
`xero_entities` · `stripe_connections` · `stripe_entities` ·
`shopify_connections` · `shopify_entities` · `shopify_sync_state` ·
`gmail_connections` · `gmail_synced_messages` · `merchant_tags`

**Platform**
`users` · `sessions` · `user_whatsapp` · `user_slack` · `slack_events_seen` ·
`job_status` · `schema_migrations` · `onboarding_audit` · `form_drafts` ·
`context_refinement_history`

### Two schema paths — read this before changing anything

1. **`ensure*Schema()`** — idempotent `CREATE TABLE IF NOT EXISTS` / guarded
   `ALTER TABLE`, run at request time. Where the large majority of the schema
   lives.
2. **SQL files** in `web/migrations/`, applied by `run-migrations.sh` in
   filename order.

Editing the wrong one is a silent no-op. Rollback steps in `lib/db-rollback.ts`
pair with `ensureMovementsSchema()` **by hand — nothing enforces the pairing**,
so an unpaired change is a rollback that quietly does not undo what you added.

**There is no migration ledger.** `run-migrations.sh` replays every file each
time, which is safe only while they stay idempotent.

```bash
npm run db:list-migrations
npm run db:rollback -- <version>
```

---

## 15. Security model

### Five authentication tiers

Every route sits in exactly one. "No check" is never correct.

| Tier | Mechanism | Used by |
| --- | --- | --- |
| **User session** | `getSession()` / `requireSession()` | The great majority |
| **Admin secret** | `x-clean-db-secret` vs `CLEAN_DB_SECRET` | All 16 `/api/admin/*` |
| **Cron secret** | `CRON_SECRET` bearer, or `x-clean-db-secret` | `/api/cron/*` |
| **Webhook signature** | Provider-specific | `/api/*/webhook` |
| **OAuth state** | Signed state cookie vs `state` param | `/api/*/oauth/callback` |

### Authentication

- **Argon2id**, memory cost 64 MB, time cost 3, parallelism 1
- Sessions are **opaque 32-byte random tokens** stored server-side with expiry —
  not JWTs in a cookie
- Edge middleware checks cookie *presence* only; verification happens in Node
  against the database
- Signup, login and session lookup are gated on `NODE_ENV === "production"`,
  which is why local auth does not complete

### Hardening already in place

- **Destructive routes refuse to run outside production** — a misfired local
  call cannot truncate tables
- **Secrets rejected in query strings** — routes explicitly reject `?secret=`
  because URLs leak into logs, proxies and referrers
- **All queries parameterised** through `query<T>()`; no string-interpolated SQL
- **OAuth callbacks fail closed** on state mismatch
- **LLM guardrails**: `llm-prompt-sanitizer`, `llm-circuit-breaker`,
  `llm-rate-limiter`, `llm-hallucination-detector`
- **Rate limiting** (`rate-limiter.ts`), **request size limiting**
  (`request-size-limiter.ts`), **request IDs** (`request-id-middleware.ts`)
- **reCAPTCHA** on signup
- **Audit logging** — `reconciliation_audit_log`, `ar_ap_status_log`,
  `onboarding_audit`, `identity_resolution_decisions`

### Known weaknesses

- **One shared admin secret** guards all 16 admin routes, from
  `gmail-connection-status` to `wipe-all-user-data`. One leak grants destructive
  access to everything. `cron/shopify-sync` already uses a separate
  `CRON_SECRET` — standardising per scope would be an improvement.
- **Suppressed type errors** weaken the guarantees a reviewer can rely on (§17).
- **LLM validation fails open** on omitted candidates (§17).

Full posture: [SECURITY.md](SECURITY.md).

---

## 16. Testing

**213 tests, 9 files, all hermetic** — no network, no database. Vitest with v8
coverage.

| File | Tests |
| --- | ---: |
| `alias-normalize.test.ts` | 44 |
| `levenshtein.test.ts` | 34 |
| `dashboard-calculations.test.ts` | 27 |
| `reconciliation-entity-validator.test.ts` | 23 |
| `confidence-scoring.test.ts` | 21 |
| `entity-uri.test.ts` | 19 |
| `confidence-recalculation.test.ts` | 16 |
| `reconciliation-entity-validator.llm.test.ts` | 14 |
| `password-strength.test.ts` | 10 |

### Coverage

| Module | Stmts | Branch |
| --- | ---: | ---: |
| `confidence-scoring.ts` | 100% | 84.9% |
| `dashboard-calculations.ts` | 100% | 100% |
| `password-strength.ts` | 100% | 100% |
| `levenshtein.ts` | 97.3% | 95.1% |
| `entity-uri.ts` | 96.9% | 95.0% |
| `alias-normalize.ts` | 95.2% | 93.9% |
| `confidence-recalculation.ts` | 71.9% | 58.1% |
| `reconciliation-entity-validator.ts` | 61.9% | 54.5% |

**Repository-wide: 3.4%** — 8 modules of 171. Published rather than hidden.

### Two conventions

**Hermetic by construction.** The LLM tier is tested by stubbing the environment
and mocking `fetch`, then dynamically importing the module fresh — because it
reads its API key into a module-level const at import time.

**`CHARACTERISATION` and `KNOWN GAP` tests pin bugs, not specifications.** They
exist so known-wrong behaviour cannot drift before someone decides how it should
work. They are not endorsements. If one fails, read the matching `REVIEW.md`
entry before changing anything.

### The blocker to more coverage

`db.ts` and the Supermemory clients open connections at import time, so modules
depending on them cannot be unit tested as they stand. **Introducing a seam
around `query<T>()` is the single highest-leverage refactor available** — it
unlocks the whole reconciliation layer, the forecast engine and route testing.

### Where to go next

1. `reconciliation-waterfall.ts` (1,497) — the FIFO allocation engine
2. `movement-classify.ts` (2,832) — start with `classification-precedence.ts`
3. `state/forecast-engine.ts` (5,811) — extract pure helpers, property-test them
4. `reconciliation-fusion-engine.ts` + `-case-classifier.ts` (~2,100, already
   dependency-light)
5. API route contract tests — 169 handlers, zero coverage

---

## 17. Known defects

Published deliberately. Full detail in [REVIEW.md](REVIEW.md).

### HIGH — confidence builders disagree

`buildConfidenceBreakdown` (async, LLM stage) and
`buildSyncConfidenceBreakdown` (sync, FIFO hot path) return different scores for
identical inputs.

| Input | Sync | Async | Ratio |
| --- | ---: | ---: | ---: |
| All neutral | — | — | 0.01 absolute gap |
| `categoryAdjustment: 0.2` | +0.006 | +0.200 | ~33× |
| `matchSequenceIndex: 1` | −0.004 | −0.050 | ~12× |

Confidence drives auto-confirmation, and the label bands sit at 0.88/0.75/0.60 —
well inside these gaps. The same movement can auto-book or land in review
depending only on which code path scored it. Characterised by tests; unfixed
pending a decision on intended semantics.

### HIGH — 349 suppressed type errors

`next.config.js` sets `typescript.ignoreBuildErrors: true`. Down from a baseline
of 411.

- **~104 `TS18046`** — `'row' is of type 'unknown'`. `query<T = unknown>()`
  defaults to `unknown` and many callers omit the type argument, so every field
  read off those rows is unchecked. In a reconciliation engine this is exactly
  where a renamed column becomes a silently wrong number.
- **~106 `TS2339`** — property does not exist.
- **5 `TS2304`** — cannot find name, including the live bug below.

### MEDIUM — `identifyPaymentRisks` references an undeclared `client`

`lib/ai-payment-patterns.ts:154` calls `client.messages.create({ model:
"claude-3-5-sonnet-20241022" })`. `client` is never declared, imported or
assigned — that line is its only occurrence — and no Anthropic SDK is installed.
It throws `ReferenceError` the moment it runs.

Not firing today: `ai-forecast-enhancement.ts` imports it but only calls
`analyzePaymentPatterns`. Dead code with a latent crash, reachable via an import
that already exists. The compiler already reports it; `ignoreBuildErrors`
discards the warning.

### MEDIUM — LLM validation fails open

```ts
result.set(c.entity_id, parsed.matches?.[c.entity_id] ?? true)
```

A well-formed response that *omits* a candidate defaults it to accepted. The
genuinely-failed paths (non-2xx, throw, unparseable JSON) correctly fall back to
strict thresholds — only "parsed but incomplete" fails open.

### MEDIUM — matcher precision gaps

- `areSameEntity` substring rule has no minimum length:
  `areSameEntity("Inc", "Incredible Foods") === true`
- `matchEntityName`'s contains-fallback ignores the caller's `threshold` — a
  caller passing 0.99 still receives a 0.85 substring match

### MEDIUM — ~32 leftover debug blocks

`#region agent log` console-logging blocks remain in
`reconciliation-fusion-engine.ts` (~13) and `reconciliation-waterfall.ts` (~11).
The three that made network calls to `localhost:7742` have been removed. Several
of the remainder wrap live `try`/`catch` logic, so they need removing by hand,
not mechanically.

---

## 18. Build and deploy

### Processes

```
web:    npm start                  # Next.js
worker: cd web && npm run worker    # Bull queue consumer
```

The root `package.json` handles the `web/` subdirectory, so a platform building
from the repository root needs no extra configuration.

> **If your platform has a Root Directory setting, it must point at `web`.**
> This directory was renamed from `v0-login-page-clone-2`; a stale setting is
> the most likely cause of a failed deploy.

### Commands

```bash
npm run dev              npm run build            npm start
npm run worker           npm test                 npm run test:watch
npm run test:coverage    npm run typecheck        npm run lint
npm run db:list-migrations                        npm run db:rollback -- <v>
npm run seed:classification-signatures
npm run canary:health-check                       npm run deploy:full-rollout
```

Note `test:reconciliation`, `test:load-reconciliation` and
`test:chaos-reconciliation` are **operational harnesses against a real
environment**, not the unit suite. The unit suite is `npm test`.

### CI

`.github/workflows/ci.yml` — two jobs:

- **Unit tests** — gates merges, uploads the coverage artifact
- **Typecheck** — reports the error count without gating
  (`continue-on-error: true`); flip it once the backlog reaches zero

### Branches

`main` is the working branch. `production` is a curated 19-commit history
(01 Project scaffold → 18 Documentation) that **shares no ancestor with `main`**.
Updates to it are explicit two-parent merges with `main`'s tree, never
fast-forwards — an ordinary merge would leave both directory layouts present,
since git cannot detect deletions without a merge base.

---

## 19. Appendix: environment variables

Every variable the code actually reads. Names taken from source — several are
non-obvious.

### Required

```bash
DATABASE_URL                 # or the four Cloud SQL variables below
REDIS_HOST  REDIS_PORT  REDIS_PASSWORD    # host/port/password, NOT a URL
APP_URL  NEXT_PUBLIC_APP_URL
```

### Cloud SQL alternative

```bash
INSTANCE_CONNECTION_NAME  DB_USER  DB_PASS  DB_NAME
CLOUD_SQL_IP_TYPE  GOOGLE_APPLICATION_CREDENTIALS  GOOGLE_APPLICATION_CREDENTIALS_JSON
```

### Connectors

```bash
PLAID_CLIENT_ID  PLAID_SECRET  PLAID_ENV
QUICKBOOKS_CLIENT_ID  QUICKBOOKS_CLIENT_SECRET  QUICKBOOKS_SANDBOX  QUICKBOOKS_WEBHOOK_VERIFIER
XERO_CLIENT_ID  XERO_CLIENT_SECRET  XERO_WEBHOOK_KEY
STRIPE_SECRET_KEY  STRIPE_CLIENT_ID  STRIPE_WEBHOOK_SECRET
SHOPIFY_CLIENT_ID  SHOPIFY_CLIENT_SECRET  SHOPIFY_REDIRECT_URI
SHOPIFY_API_VERSION  SHOPIFY_REQUIRED_SCOPES
GMAIL_OAUTH_CLIENT_ID  GMAIL_OAUTH_CLIENT_SECRET  GMAIL_ADMIN_EMAIL  GMAIL_INBOX_USER_ID
SLACK_CLIENT_ID  SLACK_CLIENT_SECRET  SLACK_SIGNING_SECRET  SLACK_BOT_TOKEN
TWILIO_ACCOUNT_SID  TWILIO_AUTH_TOKEN  TWILIO_WHATSAPP_FROM
TWILIO_API_KEY_SID  TWILIO_API_KEY_SECRET
SUPERMEMORY_API_KEY  SUPERMEMORY_DEFAULT_FINANCE_TAG  SUPERMEMORY_ON_EVERY_LLM
GCP_SERVICE_KEY_JSON  GCP_ENTITY_BUCKET
RECAPTCHA_SECRET_KEY
```

### LLM

```bash
OPENAI_API_KEY  OPENAI_COMPANY_CONTEXT_MODEL
FORECAST_LLM_API_URL  FORECAST_LLM_API_KEY  RECON_SCORING_MODEL
```

### Endpoint auth

```bash
CRON_SECRET  CLEAN_DB_SECRET
```

### Feature flags

```bash
RECONCILIATION_ENTITY_FILTER   RECONCILIATION_ENGINE   ENABLE_LLM_STAGE4
AR_LLM_ENABLED  AP_LLM_ENABLED  FORECAST_LLM_ENABLED  FORECAST_USE_CASH_EVENTS
TWO_PHASE_LLM   CLASSIFICATION_PRECEDENCE   MOVEMENT_LLM_HISTORY_N
IDENTITY_GATE_LLM  IDENTITY_GATE_MIN_SCORE  IDENTITY_GATE_MIN_ENTITY_CONF
```

Annotated: [`web/.env.example`](web/.env.example).

---

## 20. Appendix: glossary

| Term | Meaning |
| --- | --- |
| **Movement** | A single money event observed at the bank or ledger. Immutable. |
| **Cash event** | An AR invoice or AP bill — money owed or expected. Has a status lifecycle. |
| **Attribution** | The join: this movement paid that cash event, this much, this confidently. |
| **Entity** | A counterparty, resolved to one identity across every source. |
| **Economic class** | Coarse category — `customer_cash_in`, `processor_payout`, … |
| **Movement class** | Fine classification — `merchant_deposit`, `bank_fee_refund`, … |
| **Archetype** | Behavioural pattern selecting a forecast model — `clockwork`, `bursty`, … |
| **Waterfall** | The five-stage matching pipeline, cheapest-first. |
| **Fast path** | String-similarity entity validation that avoids an LLM call. |
| **Fails open / closed** | Whether a failure permits or denies. This system fails **closed**. |
| **Anchor / satellite** | Cluster roles — the canonical entity and its variants. |
| **Greedy sweep** | The FIFO failure mode where one deposit consumes every open invoice. |
| **Characterisation test** | Pins current behaviour known to be wrong, so it cannot drift silently. |
| **Provenance** | Where a movement came from — `bank_observed`, `accounting_observed`, `coalesced`. |
| **Sludge** | Uninformative descriptor text (`INV-123`) excluded from display. |

---

<p align="center">
  <a href="README.md">README</a> ·
  <a href="ABOUT.md">About</a> ·
  <a href="USAGE.md">Usage</a> ·
  <a href="CONNECTORS.md">Connectors</a> ·
  <a href="REVIEW.md">Review</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>
