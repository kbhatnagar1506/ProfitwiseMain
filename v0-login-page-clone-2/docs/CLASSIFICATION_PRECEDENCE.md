# Classification precedence (money movements)

Deterministic rules run **before** `classifyNonPnl` → `classifyOperating` → LLM in `lib/movement-classify.ts`.

## Order

1. **Text scrub** (`lib/text-cleaner.ts`) — URLs, order IDs, ACH/wire boilerplate removed for matching only; raw descriptions in DB unchanged.
2. **Processor interceptor** (`lib/processor-rules.ts`) — Merchant / POS / `SHOPIFY ST-` style rails → `processor_payout` (inflow) or fee/refund outflow types.
3. **Zelle / Venmo** — If scrubbed text contains `ZELLE` or `VENMO`, classify as `cash_in_customer` (inflow) or `cash_out_vendor` (outflow); avoids generic “transfer” confusion. Skipped for structural `cross_account` / `qbo_transfer`.
4. **Canonical alias map** (`lib/entity-resolution.ts`) — Longest signature match → role-based type (customer/owner/vendor/bank/processor).

If none match, the **legacy** pipeline runs unchanged.

## Disable

Set `CLASSIFICATION_PRECEDENCE=false` to skip this layer (not recommended in production).

## Metadata

Successful precedence rows include `metadata.classification_precedence` with a short source tag (e.g. `processor_interceptor:processor_rail_inflow`, `canonical_alias:sarah_katz_marlins`).

## Extending aliases

Edit `CANONICAL_ALIAS_MAP` in `lib/entity-resolution.ts` (or later: load from DB per tenant).

## Related: graph maintainer + LLM flags

Human-approved **entity aliases** and optional **identity gate** / **two-phase LLM** (entity-scoped DB history) are documented in [`IDENTITY_GRAPH_MAINTAINER.md`](./IDENTITY_GRAPH_MAINTAINER.md).
