# Classification precedence (money movements)

Deterministic rules run **before** `classifyNonPnl` → `classifyOperating` → LLM in `lib/movement-classify.ts`.

## Order

1. **Text scrub** (`lib/text-cleaner.ts`) — URLs, order IDs, ACH/wire boilerplate removed for matching only; raw descriptions in DB unchanged.
2. **Processor interceptor** (`lib/processor-rules.ts`) — Merchant / POS / `SHOPIFY ST-` style rails → `processor_payout` (inflow) or fee/refund outflow types.
3. **Zelle / Venmo** — If scrubbed text contains `ZELLE` or `VENMO`, classify as `cash_in_customer` (inflow) or `cash_out_vendor` (outflow); avoids generic “transfer” confusion. Skipped for structural `cross_account` / `qbo_transfer`.
4. **Tenant canonical signatures** — Rows in Postgres `user_classification_signatures` (per `user_id`): longest substring match on scrubbed text → role-based type (customer/owner/vendor/bank/processor). Loaded once per `classifyMovements` via `loadUserClassificationSignatures` in `lib/entity-resolution.ts`.

If none match, the **legacy** pipeline runs unchanged.

## Disable

Set `CLASSIFICATION_PRECEDENCE=false` to skip this layer (not recommended in production).

## Metadata

Successful precedence rows include `metadata.classification_precedence` with a short source tag (e.g. `processor_interceptor:processor_rail_inflow`, `canonical_alias:erin_delgado_riverside`).

## Extending aliases (per tenant)

- **Insert** rows into `user_classification_signatures` (`signature` stored uppercase; `alias_role`, `canonical_key`). Unique on `(user_id, signature)`.
- **Seed script:** from `web`, with DB env configured:  
  `USER_ID=<users.id uuid> npm run seed:classification-signatures`  
  Seeds the former default signatures for that user (idempotent `ON CONFLICT DO NOTHING`).
- Empty set for a user → step 4 is a no-op (same as an empty map).

## Related: graph maintainer + LLM flags

Human-approved **entity aliases** and optional **identity gate** / **two-phase LLM** (entity-scoped DB history) are documented in [`IDENTITY_GRAPH_MAINTAINER.md`](./IDENTITY_GRAPH_MAINTAINER.md).
