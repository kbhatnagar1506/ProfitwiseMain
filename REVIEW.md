# Codebase review — Profitwise

Reviewed against `cursor-branch`. Scope of the
codebase: ~104k lines of TypeScript (51k `lib/`, 31k `app/`, 21k `components/`),
169 API route handlers, ~140 `lib/` modules.

This document records what was found, what was changed, and what was
deliberately left alone. It is written to be read top-to-bottom by someone
deciding what to fix next.

---

## 1. What changed in this pass

### Test infrastructure (new)

There was no test runner. A single test file, `lib/reconciliation-entity-validator.test.ts`,
had been written in Jest/Vitest style but **no runner was installed**, so it had
never executed once. Its assertions had drifted from the implementation.

Added:

- **Vitest** (`vitest.config.mts`) with v8 coverage, path aliases matching
  `tsconfig.json`, and `globals: true` to match the existing test file's style.
- `npm test`, `npm run test:watch`, `npm run test:coverage`, `npm run typecheck`.
- `vitest-globals.d.ts` so `describe`/`it`/`expect` typecheck. This uses a
  triple-slash reference rather than `compilerOptions.types`, because setting
  that array would disable automatic inclusion of every other `@types` package.
- `.github/workflows/ci.yml` — tests gate merges; the typecheck job reports the
  error count without gating (see §3).

**213 tests across 9 files, all passing.**

Coverage on the modules under test:

| Module | Stmts | Branch | Funcs |
| --- | ---: | ---: | ---: |
| `confidence-scoring.ts` | 100% | 84.9% | 100% |
| `dashboard-calculations.ts` | 100% | 100% | 100% |
| `password-strength.ts` | 100% | 100% | 100% |
| `levenshtein.ts` | 97.3% | 95.1% | 100% |
| `entity-uri.ts` | 96.9% | 95.0% | 100% |
| `alias-normalize.ts` | 95.2% | 93.9% | 100% |
| `confidence-recalculation.ts` | 71.9% | 58.1% | 40% |
| `reconciliation-entity-validator.ts` | 61.9% | 54.5% | 66.7% |

Repository-wide statement coverage is **3.4%**. That number is honest and it is
the headline gap: 8 modules of ~140 are covered. §4 lists what to test next.

### Bugs fixed (each with a regression test)

**a. `cleanDisplay` silently discarded every canonical brand name**
`lib/alias-normalize.ts`

The `CANONICAL_SPACING` table (QuickBooks, DocuSign, MacLean, …) ran *before* two
PascalCase-splitting regexes that re-split exactly what it had just joined. The
entire table was dead code:

```
"QuickBooks" -> "Quick Books"
"DocuSign"   -> "Docu Sign"
"MacLean"    -> "Mac Lean"
```

Every branded counterparty rendered split in the UI. Fixed by moving the
canonical-spacing pass to run last.

**b. `calculateTrendVelocity` reported deceleration as acceleration**
`lib/dashboard-calculations.ts`

Both direction branches returned `"accelerating"`, so an entity swinging from
`increasing` to `decreasing` — the single most important negative signal on the
dashboard — was labelled as accelerating. Rewritten to rank trends on one axis
and compare, which is now covered by an antisymmetry property test.

**c. `levenshteinSimilarity` inflated scores for padded strings**
`lib/levenshtein.ts`

Edit distance was computed on trimmed strings while the length denominator used
the raw strings. `("hello   ", "world")` scored 0.43 where `("hello", "world")`
scored 0.20 — the same pair, different answer depending on incidental whitespace.
Both now derive from the same normalized strings, with a zero-length guard.

**d. Debug beacons phoning `localhost:7742` from the reconciliation hot path**
`lib/attribution-persist.ts`, `lib/db.ts`

Leftover instrumentation from a past debugging session shipped to production —
hardcoded `sessionId: 'fee5c4'`, `runId: 'debug-run-1'`, `hypothesisId: 'A'`:

```ts
await fetch('http://127.0.0.1:7742/ingest/b0bb6c9e-…', { … })
```

In `insertAttributionWithClient` this ran **on every attribution insert**, and it
was `await`ed. In production nothing listens on port 7742, so every insert in the
reconciliation engine blocked on a TCP connection failing before it could
proceed. The blocks also serialised movement IDs, vendor IDs and category data
out to an arbitrary local endpoint. All three call sites removed and replaced
with the project's existing structured `log()`.

**e. `query()` discarded pg's `rowCount`**
`lib/db.ts`

`query()` returned only `{ rows }`, so three callers destructuring `rowCount`
read `undefined`: `lib/cash-events-build.ts` (orphaned-attribution cleanup),
`lib/shopify-movements.ts` (insert result) and `lib/vendor-credit-match.ts`
(`return result.rowCount ?? 0`, which therefore always returned 0 regardless of
how many rows were updated). `query()` now returns `{ rows, rowCount }`.

**f. Two never-executed tests corrected**
`lib/reconciliation-entity-validator.test.ts`

One asserted `results.size === 0` for an empty bank description while its own
comment claimed the opposite; the real behaviour is a `fast_reject` entry per
candidate. The other depended on a live LLM API key and failed without one — it
now pins the documented no-LLM fallback, and the LLM behaviour moved to a
hermetic file that mocks `fetch` (`reconciliation-entity-validator.llm.test.ts`).

### Structural cleanup

- **Removed `next.config.mjs`.** Two Next configs existed. Next resolves
  `CONFIG_FILES` in order — `next.config.js` first — so `next.config.mjs` was
  never loaded and its `images: { unoptimized: true }` had **never applied**.
  Deleting it changes no behaviour. If that setting was intended, add it to
  `next.config.js` deliberately.
- **Deleted 23 MB of unreferenced media** — three screen-recording `.mp4` files
  committed at the app root with zero code references. (This removes them going
  forward; it does not shrink git history. See §4.)
- **Moved two screenshots into `assets/`** with real names
  (`whatsapp-qr.png`, `shopify-logo.png`). These *are* imported — previously as
  `import whatsappQr from "../../../Screenshot 2026-03-08 at 03.57.15.png"`.
  All four import sites now use `@/assets/…`.
- **Moved 23 analysis documents** out of the repo root into `docs/`, and three
  more out of the app root. The root now holds 5 entries instead of 28.
- **Moved stray root scripts** `check_status.mjs` and `query_jack.js` into
  `scripts/`.
- `.gitignore`: added `/coverage`.

---

## 2. Deliberately NOT changed

**`app/api/twillo/webhook/whatsapp/route.ts` is not a typo to delete.**
It looks like a misspelling of the adjacent `twilio` route, but
`docs/TWILIO_WHATSAPP_SETUP.md` documents that misspelled URL as the webhook
actually configured in the Twilio console. Deleting it breaks inbound WhatsApp.
It should be retired by first repointing Twilio at the correctly spelled route.

**The confidence-scoring divergence (§3.1) was characterised, not fixed.**
Correcting it changes which financial matches auto-confirm. That is your call to
make, not a silent refactor.

**No wholesale `lib/` reorganisation.** `lib/` is a flat directory of ~140
modules and would read better grouped by domain (`lib/reconciliation/`,
`lib/integrations/`, `lib/entities/`, `lib/forecast/`). I did not do it: with
169 route handlers importing across it, the result is a 500-file diff that
cannot be meaningfully reviewed, landing on a codebase whose typecheck does not
currently pass. Sequence it after §3.2 instead, one domain per PR.

---

## 3. Open findings, by priority

### 3.1 The two confidence builders disagree for identical inputs — HIGH

`lib/confidence-scoring.ts` exposes `buildConfidenceBreakdown` (async, used by
the LLM stage) and `buildSyncConfidenceBreakdown` (sync, used by the Stage 3
FIFO hot path). They are presented as one scoring model with two execution
strategies. They are not the same model.

The async path adds `historyAdj`, `categoryAdjustment` and the sequence penalty
as **raw offsets after** the weighted sum. The sync path folds the same signals
in **through their declared weights**:

| Input | Sync effect | Async effect | Ratio |
| --- | ---: | ---: | ---: |
| all signals neutral | — | — | 0.01 absolute gap |
| `categoryAdjustment: 0.2` | +0.006 | +0.200 | ~33× |
| `matchSequenceIndex: 1` | −0.004 | −0.050 | ~12× |

Confidence drives auto-confirmation, so the same movement/invoice pair can land
in the review queue or be booked automatically depending only on which code path
scored it. `confidenceLabel` bands at 0.88/0.75/0.60 sit well inside these gaps.

This is pinned by `describe("CHARACTERISATION: sync and async paths disagree")`
in `lib/confidence-scoring.test.ts` — **those tests document the defect, they do
not endorse it.** Decide the intended semantics (the sync path's weighted
treatment is the more defensible one), fix both, and convert those tests to
specifications.

### 3.2 411 type errors suppressed by `ignoreBuildErrors: true` — HIGH

`next.config.js` sets `typescript: { ignoreBuildErrors: true }`, so none of these
surface at build time. Current count: **349**, down from a baseline of **411**;
59 of the resolved errors were untyped test globals and 3 were the real
`rowCount` bug above. None of the remaining 349 come from code added in this
pass, and no file's error count increased.

The two dominant categories are the concerning ones:

- **`TS18046` — `'row' is of type 'unknown'`** (~104). `query<T = unknown>()` in
  `lib/db.ts` defaults its row type to `unknown`, and many callers omit the type
  argument. Every field read off those rows is unchecked at compile time. In a
  reconciliation engine this is precisely where a renamed column becomes a
  silently wrong number rather than a crash.
- **`TS2339` — property does not exist** (~106), e.g.
  `Property 'total_in' does not exist on type 'LiquidityState'` and
  `Property 'rowCount' does not exist on type '{ rows: ... }'` — the latter is a
  real bug at 3 call sites, since `lib/db.ts`'s `query()` returns only `{ rows }`
  and never `rowCount`, so those reads are `undefined` at runtime.

Suggested sequence: type the `query<T>()` call sites in the money paths first
(`lib/reconciliation-*`, `lib/ar-*`, `lib/ap-*`), then flip
`continue-on-error: false` in the CI typecheck job to stop the backlog growing.

`grep -c 'rowCount' lib/*.ts app/api/**/route.ts` is a good five-minute audit
for the second category.

### 3.3 `identifyPaymentRisks` references an undeclared `client` — MEDIUM

`lib/ai-payment-patterns.ts:154` calls:

```ts
const response = await client.messages.create({
  model: "claude-3-5-sonnet-20241022", …
})
```

`client` is **never declared, imported or assigned** — that line is its only
occurrence in the file. No Anthropic SDK is in `package.json` or installed. The
function throws `ReferenceError: client is not defined` the moment it runs.

It is not currently firing: `lib/ai-forecast-enhancement.ts` imports
`identifyPaymentRisks` alongside `analyzePaymentPatterns`, but only calls the
latter. So this is dead code with a latent crash, reachable the instant someone
wires up the import that already exists.

This is the clearest illustration of what §3.2 costs. The compiler already knows
— `error TS2304: Cannot find name 'client'` — and `ignoreBuildErrors` discards
it. Four other `TS2304` errors are outstanding; each is the same class of defect.

Fix by either deleting the function or rewriting it against the same `fetch`
pattern the rest of the codebase uses for LLM calls. Adding `@anthropic-ai/sdk`
would also work but introduces a second provider, so it warrants a deliberate
decision.

### 3.4 LLM entity validation fails open — MEDIUM

`lib/reconciliation-entity-validator.ts`, in the LLM result mapping:

```ts
result.set(c.entity_id, parsed.matches?.[c.entity_id] ?? true)
```

A well-formed response that simply **omits** a candidate defaults that candidate
to `true` — accepted. A truncated or partial completion silently approves entity
matches nobody validated. Note the contrast with the genuinely-failed paths
(non-2xx, throw, unparseable JSON), which correctly fall back to a strict
deterministic threshold. Only the "parsed but incomplete" case fails open.
Recommend defaulting to `null` (validation skipped) so it joins the strict path.

Pinned by `describe("KNOWN GAP: candidates omitted by the LLM default to accepted")`.

### 3.5 Matcher precision gaps — MEDIUM

Both in `lib/levenshtein.ts`, both pinned by tests marked `KNOWN`:

- **`areSameEntity` substring rule has no minimum length.**
  `areSameEntity("Inc", "Incredible Foods") === true`. Any short generic token
  contained in a longer name is treated as the same entity.
- **`matchEntityName`'s contains-fallback ignores the caller's `threshold`.**
  A caller passing `0.99` for near-exact precision still receives a `0.85`
  substring match. The threshold only governs the direct and alias tiers.

### 3.6 ~32 remaining `#region agent log` debug blocks — MEDIUM

The three that made network calls are gone (§1.d). Roughly 32 `console.log`-only
debug regions remain, concentrated in the two largest reconciliation modules:

| File | Regions |
| --- | ---: |
| `lib/reconciliation-fusion-engine.ts` | ~13 |
| `lib/reconciliation-waterfall.ts` | ~11 |

They are noisy rather than harmful, so they were **not** mass-deleted: several
(`hypothesis C/D/E`) wrap live `try`/`catch` logic around real queries, and
stripping them mechanically in untested money code risks removing working
behaviour. Remove them file by file once §4.1 gives the waterfall test coverage —
or immediately if you are confident reading the diffs.

`grep -rn "#region agent log" lib/` lists them all.

### 3.7 Operational notes — LOW

- **Admin/cron auth is a single shared secret.** All 16 `/api/admin/*` routes and
  five of six `/api/cron/*` routes authenticate with the same `CLEAN_DB_SECRET`
  header, including `wipe-all-user-data` and `clean-auth-db`. They are correctly
  gated to `NODE_ENV === "production"` and reject the secret in a query string —
  this is better than it first looks — but one leaked value grants destructive
  access to everything. `cron/shopify-sync` already uses a separate `CRON_SECRET`
  bearer token; standardising on per-scope secrets would be an improvement.
  *(OAuth callbacks were checked and do validate `state` correctly.)*
- **Fast-reject is conservative, so most pairs pay for an LLM round-trip.**
  `"Sanzo"` vs `"CocoTaps"` rejects locally, but `"Sanzo"` vs
  `"Completely Unrelated Vendor Inc"` escalates. Pinned as a cost note in the LLM
  test file; worth revisiting if the OpenAI bill matters.
- **23 MB of deleted media still lives in git history.** The working tree is
  clean, but clone size is unchanged. Rewriting history with `git filter-repo`
  would fix it and would invalidate every existing clone and PR — only worth it
  if clone size is actually hurting.
- **No root `README.md`.** The repository root has no entry point explaining what
  Profitwise is or how to run it. For a repo being shown to other engineers, this
  is the cheapest high-value addition available.

---

## 4. Where to take testing next

Ranked by risk-per-line, given that the covered 8 modules are the small pure
ones and the large stateful ones are untouched:

1. **`lib/reconciliation-waterfall.ts` (1,497 lines)** — the FIFO allocation
   engine. Highest-value untested code in the repo; decides how cash is applied
   to invoices. Needs the DB boundary behind a seam before it can be unit tested.
2. **`lib/movement-classify.ts` (2,832 lines)** — classification precedence. Pure
   enough to test directly; start with `lib/classification-precedence.ts`.
3. **`lib/state/forecast-engine.ts` (5,811 lines)** — the single largest module.
   Worth extracting pure calculation helpers first, then property-testing them.
4. **`lib/reconciliation-fusion-engine.ts` / `-case-classifier.ts`** — ~2,100
   lines combined, already dependency-light and testable today.
5. **API route contract tests** — 169 handlers with zero coverage. A shared
   harness asserting auth-required/401, shape, and error envelope would cover a
   large surface cheaply.

The `query<T>()` seam is the recurring blocker for 1, 3 and 5: introducing a
small injectable database interface unlocks unit testing across the whole
reconciliation layer, and is the highest-leverage refactor available.
