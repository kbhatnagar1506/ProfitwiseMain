# `lib/` — the domain layer

~152 modules holding everything that is not a route handler or a React
component. This is where the actual reconciliation logic lives.

The directory is flat by convention rather than by design. Grouping it into
domain folders would read better, but 169 route handlers import across it, so
that change is sequenced in [`REVIEW.md`](../../REVIEW.md) rather than done
piecemeal.

---

## Module families

Names are prefix-grouped. `ls lib/ | grep '^reconciliation'` is the fastest way
to see one family whole.

| Prefix | Count | Responsibility |
| --- | ---: | --- |
| `reconciliation-*` | 11 | The matching waterfall: fusion engine, case classifier, entity validator, customer matcher, audit log, monitoring |
| `entity-*` | 13 | Identity resolution — clustering, graph analysis, payment profiles, alias suggestion, URI canonicalisation |
| `movement-*` | 7 | Bank movement classification, tagging, pattern analysis, backtesting |
| `confidence-*` | 4 | Component scoring, recalculation, boost engine, human-readable explanation |
| `ar-*` / `ap-*` | 8 | Receivable and payable matching, status transitions, LLM-assisted decisions |
| `llm-*` | 5 | Circuit breaker, rate limiter, prompt sanitiser, hallucination detector, logging |
| `forecast-*` | 4 | Forecast calibration, tuning, LLM enhancement |
| `supermemory-*` | 3 | Entity memory: profiles and decision history |

### Integrations

`plaid-*` (3) · `stripe-*` (5) · `xero-*` (5) · `shopify-*` (4) ·
`quickbooks-*` + `qbo-*` (3) · `gmail-*` (4) · `slack-*` (2) · `twilio-*` (2)

Each follows the same shape: a client wrapper, a token store, a sync routine
and — where the provider emits transactions — a `*-movements.ts` translator into
the canonical `movements` model.

### Subdirectories

| Path | Contents |
| --- | --- |
| `state/` | Forecast engine (the largest module in the repo), calibration, risk and insight engines, AR/AP state derivation |
| `queue/` | Bull client and config, worker entrypoint, connection and Redis monitors, and 7 job processors |
| `migrations/` | Programmatic migration helpers (SQL files live in `../migrations/`) |

---

## Conventions that matter

**`db.ts` is the only database entrypoint.** `query<T>()` returns
`{ rows, rowCount }`. Always pass the type argument — the default is `unknown`,
and omitting it is how a renamed column becomes a silently wrong number rather
than a compile error. This is the single largest category of suppressed type
errors in the repo; see `REVIEW.md` §3.2.

**`ar-ap-status.ts` owns `cash_events.status`.** There are exactly six write
paths and all of them import from that module. Adding a seventh writer without
going through it breaks the single source of truth — see
[`ar-ap-architecture.md`](../docs/ar-ap-architecture.md).

**LLM calls degrade, they do not guess.** Every LLM tier has a deterministic
fallback that applies *stricter* thresholds when the model is unavailable. If
you add a call, match that: an unreachable model must never widen what gets
auto-accepted.

**Modules that connect on import cannot be unit tested.** `db.ts` and the
Supermemory clients open connections at module scope, which is why the tested
modules are the pure ones. Introducing a seam around `query<T>()` is the
highest-leverage refactor available and unlocks the whole reconciliation layer.

---

## Tested modules

Tests sit next to their subject as `*.test.ts`. Currently covered:

`levenshtein` · `entity-uri` · `alias-normalize` · `password-strength` ·
`dashboard-calculations` · `confidence-scoring` · `confidence-recalculation` ·
`reconciliation-entity-validator` (including a hermetic LLM-tier suite)

Tests marked `CHARACTERISATION` or `KNOWN GAP` pin behaviour that is known to be
wrong, so it cannot drift before someone decides how it should work. They are not
endorsements — each is cross-referenced in `REVIEW.md`.
