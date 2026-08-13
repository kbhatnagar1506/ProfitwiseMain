# `scripts/`

Operational scripts. These are **not** part of the deployed app — they are run
by hand against a configured environment. Most need `DATABASE_URL`, and several
talk to live third-party APIs.

> Anything here can touch production data. Read a script before running it, and
> check which environment your shell is pointed at.

---

## Wired into npm

| Command | Script |
| --- | --- |
| `npm run seed:classification-signatures` | `seed-user-classification-signatures.ts` |
| `npm run seed:reconciliation-test-cases` | `seed-reconciliation-test-cases.ts` |
| `npm run test:reconciliation` | `test-reconciliation.ts` |
| `npm run test:load-reconciliation` | `load-test-reconciliation.ts` |
| `npm run test:chaos-reconciliation` | `chaos-test-reconciliation.ts` |
| `npm run canary:health-check` | `canary-health-check.ts` |
| `npm run deploy:full-rollout` | `full-rollout.ts` |

Note that the `test:*` entries above are **operational harnesses against a real
environment**, not the unit suite. The unit suite is `npm test` (Vitest) and
never touches the network.

## Run directly

Gmail: `gmail-oauth-cli.mjs` (see [README-gmail-oauth.md](README-gmail-oauth.md)),
`check-gmail-connection.mjs`, `peek-gmail-synced.mjs`,
`bucket-by-user-and-extract-invoices.mjs`

Plaid: `trigger-plaid-refresh.js`, `update-webhook-url.js`,
`set-heroku-plaid-env.sh`

GCP: `list-gcp-bucket.mjs`

---

## Unowned leftovers

`check_status.mjs` is an ad-hoc one-off with an unclear name,
referenced by nothing in the codebase. It was moved here from the app root
during cleanup rather than deleted, in case it is still useful. If you do not
recognise it, it is safe to remove. (A sibling script, `query_jack.js`, was
deleted outright: it hardcoded a real customer email address.)

---

## Adding a script

Use `tsx` for TypeScript, import from `@/lib/*` rather than re-implementing
domain logic, and open with a comment block stating what it does, what
environment it expects, and whether it writes. Add a `package.json` entry if it
is meant to be run more than once.
