<h1 align="center">About Profitwise</h1>

<p align="center">
  <strong>Automated cash reconciliation and forecasting for operating businesses.</strong>
</p>

---

## The problem

A business with a bank account, an accounting ledger and a card processor has
three systems that each hold a partial, differently-shaped view of the same
money. None of them can answer the question the operator actually has:

> *This $4,182.55 landed on Tuesday. What was it for?*

The bank says `ACH CREDIT SP BOBOS - WHOLESALE`. The ledger has an open invoice
for `Bobo's Oat Bars` at `$4,200.00`. Those are the same transaction, but nothing
links them:

- **The names disagree.** Bank descriptors are truncated, prefixed by the
  processor, and often bear no resemblance to the ledger's contact name.
- **The amounts disagree.** The processor took its fee before the money landed.
- **The dates disagree.** Settlement lags invoicing by days or weeks.
- **The counts disagree.** One deposit may settle three invoices; one invoice may
  arrive as two partial payments.

So somebody reconciles it by hand, in a spreadsheet, monthly. That work is slow,
error-prone, and — because it happens weeks late — useless for deciding whether
payroll clears next Friday.

Profitwise closes that gap automatically, shows its reasoning, and escalates to a
human only when the evidence is genuinely weak.

---

## How it works

### Fourteen connectors, one canonical model

Each integration lands data in one of three tables, and the matching engine works
only against those. Adding a bank, a ledger or a storefront never changes the
reconciliation logic.

| Table | Holds |
| --- | --- |
| `movements` | Money that actually moved — the bank's version of events |
| `cash_events` | Money owed or expected — AR invoices, AP bills |
| `entities` | Who the counterparty is, resolved across every source |

Sources: **Plaid** (banks) · **QuickBooks**, **Xero**, **Gmail** (ledgers) ·
**Stripe**, **Shopify** (commerce) · **OpenAI**, **Supermemory** (intelligence) ·
**Slack**, **WhatsApp** (channels).

### A five-stage waterfall

Matching runs cheapest-and-most-certain first, so the expensive tier only ever
sees what the deterministic tiers could not resolve.

```
Stage 0  Direct link        movement_id → cash_event_id already known
Stage 1  Exact amount       unambiguous amount + entity agreement
Stage 2  Category           economic class narrows the candidate set
Stage 3  FIFO + tolerance   oldest-open-first, with greedy-sweep guards
Stage 4  LLM semantic       only the residue — grounded in the user's own
                            entity graph, not general world knowledge
```

Most matches never reach Stage 4. When the model is unreachable, the matcher
applies *stricter* deterministic thresholds — an outage can only reduce what gets
auto-accepted, never widen it.

### Explainable confidence

Every match carries a component breakdown rather than a bare score, so a decision
can be audited after the fact:

| Signal | Weight |
| --- | ---: |
| Amount agreement | 0.30 |
| Entity name (Levenshtein + Jaccard) | 0.20 |
| Entity name (AI semantic validation) | 0.25 |
| Date proximity | 0.15 |
| Historical behaviour | 0.05 |
| Category | 0.03 |
| Match sequence | 0.02 |

Below the floor, a match lands in a review queue instead of being booked.

### Memory that compounds

When someone confirms `SP BOBOS - WHOLESALE` is `Bobo's Oat Bars`, that pattern
is written back. Next time the descriptor appears it resolves on the fast path —
no model call, no ambiguity. Matching gets cheaper and more accurate with use
rather than restarting cold every run.

---

## Engineering notes

The parts a reviewer might find interesting.

**Entity resolution is its own layer.** Bank descriptors, ledger contacts and
processor payouts rarely agree on a name. Alias normalisation, camelCase
splitting, parenthetical org-qualifier stripping, and a memory-backed entity
graph converge them onto one canonical entity. `"RachelSuba"`, `"Rachel Suba"`
and `"SP RACHEL SUBA - WHOLESALE"` are one counterparty.

**Fee recovery is why anything matches at all.** Stripe payout sync expands
`balance_transaction` to recover the exact processing fee. Without it, no card
deposit would ever equal its invoice, and the whole waterfall would fall through
to manual review.

**Cross-source deduplication.** A Shopify order and the Stripe payout that settles
it are the same money seen twice. Revenue is reconciled, not double-counted.

**One writer for payment state.** `cash_events.status` has exactly six permitted
write paths, all routed through a single module. `overdue` is computed at query
time and never persisted, because a stored value would be wrong the next morning.

**Guardrails around every model call.** Prompt sanitisation, circuit breaker,
rate limiting and hallucination detection — and the fail-closed rule above.

**Two processes.** Web serves requests; a Bull/Redis worker runs ingestion,
classification, entity matching, state computation and forecasting off the
request path.

### Scale

~104k lines of TypeScript · 169 API route handlers · ~140 domain modules ·
34 dashboard surfaces · 14 integrations.

---

## Status, honestly

This is a working product, not a finished one, and the repository says so out
loud. [`REVIEW.md`](REVIEW.md) is a standing engineering review that documents
what is broken as clearly as what works:

- **Two confidence builders return different scores for identical inputs** —
  `categoryAdjustment` applied on scales ~33× apart. Since confidence drives
  auto-confirmation, the same movement can auto-book or land in review depending
  only on which code path scored it. It is characterised by tests rather than
  fixed, because changing it shifts live match rates and needs a deliberate
  decision on the intended semantics.
- **349 TypeScript errors** are suppressed by `ignoreBuildErrors`. Around 104 are
  untyped database rows — the exact place a renamed column becomes a silently
  wrong number rather than a crash.
- **Repository-wide test coverage is 3.4%** — 213 tests over 8 modules of ~140.
  The covered ones are the money-critical primitives, at 95–100%.

Some tests are marked `CHARACTERISATION` or `KNOWN GAP`. They pin behaviour that
is known to be wrong so it cannot drift silently before someone decides how it
should work. They are not endorsements, and the distinction is deliberate.

Publishing the defect list alongside the feature list is the point. A
reconciliation engine that hides its uncertainty is worse than one that reports
it.

---

## Where to go next

| You want | Read |
| --- | --- |
| To run it | [USAGE.md](USAGE.md) |
| The integration surface | [CONNECTORS.md](CONNECTORS.md) |
| What's broken and what to fix | [REVIEW.md](REVIEW.md) |
| End-to-end data flow | [HOW_IT_WORKS.md](web/docs/HOW_IT_WORKS.md) |
| The matching waterfall in detail | [RECONCILIATION_LAYER.md](web/docs/RECONCILIATION_LAYER.md) |
| Security posture | [SECURITY.md](SECURITY.md) |
| What you may do with this code | [CONTRIBUTING.md](CONTRIBUTING.md) · [LICENSE](LICENSE) |

---

<p align="center">
  Built by <a href="https://github.com/kbhatnagar1506">Krishna Bhatnagar</a> ·
  MIT licensed
</p>
