# Identity graph maintainer (alias suggestions)

LLM-proposed **entity alias** rows are stored in `entity_alias_suggestions` until a user approves them. Approved rows insert into `entity_aliases` (and optionally create a new `entities` row), so future `classifyMovements` runs resolve counterparties deterministically without extra LLM cost.

## Flow

1. **Cron / worker:** `POST /api/cron/graph-maintainer?userId=<uuid>` (header `x-clean-db-secret`, production only). Runs [`runGraphMaintainer`](../lib/graph-maintainer.ts): selects unresolved movement rows, dedupes by scrubbed fingerprint, calls OpenAI with a **closed-world** entity list, inserts **pending** suggestions.
2. **Review:** `GET /api/entity-alias-suggestions` — list pending for the signed-in user. `POST` body `{ "action": "approve" | "reject", "suggestion_id": "<uuid>" }` — approve applies the alias (and creates an entity if `create_new_entity` was proposed).

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | Required for the maintainer job and movement LLM. |
| `OPENAI_COMPANY_CONTEXT_MODEL` | `gpt-4o` | Model for graph maintainer + classification. |
| `CLEAN_DB_SECRET` | — | Required for cron routes. |
| `SUPERMEMORY_API_KEY` | — | Required for Supermemory-backed prompts (see below). |

## Supermemory on every LLM call

ProfitWise uses **Supermemory** as the primary memory layer for LLM prompts (company docs, indexed entities, connectors). **No separate “RAG model”** is required: the search API returns relevant snippets into the system prompt.

- **Movement classify** (`lib/movement-classify.ts`): each OpenAI round-trip includes Supermemory context — **normalize** (noisy descriptions), **link** (when `TWO_PHASE_LLM=true`), and **classify** — using a query derived from the current batch’s movement text.
- **Graph maintainer** (`lib/graph-maintainer.ts`): each proposal batch appends Supermemory context to the system prompt.

Set `SUPERMEMORY_ON_EVERY_LLM=false` to disable Supermemory injection (rules-only / offline testing).

## Identity gate + two-phase classification

See [`CLASSIFICATION_PRECEDENCE.md`](./CLASSIFICATION_PRECEDENCE.md) for rule order. Additional movement-classify flags:

| Variable | Default | Description |
|----------|---------|-------------|
| `IDENTITY_GATE_LLM` | on (`false` disables) | Skip LLM upgrade when identity + score are already decisive (processor family, cross-account transfer, high confidence). |
| `IDENTITY_GATE_MIN_ENTITY_CONF` | `0.55` | Minimum identity confidence for gate. |
| `IDENTITY_GATE_MIN_SCORE` | `0.6` | Minimum classification score for gate (with resolved identity). |
| `TWO_PHASE_LLM` | off (`true` enables) | Phase A: link to entity from closed list; Phase B: add **DB** last-N movements per resolved entity **in addition to** Supermemory. |
| `MOVEMENT_LLM_HISTORY_N` | `5` | Prior movements pulled per entity from Postgres when two-phase is on (max 12). |
| `SUPERMEMORY_ON_EVERY_LLM` | on (`false` disables) | Append Supermemory search results to every movement + graph-maintainer LLM system prompt. |

## Operator notes

- Re-run **movement classify** after approving aliases so `buildMovementIdentityContext` picks up new keys (or trigger classify from the app).
- Tune `candidateLimit` on the cron query string (default `40` in code) to control cost per user per run.
