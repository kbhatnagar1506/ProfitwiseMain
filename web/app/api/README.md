# `app/api/` — HTTP surface

169 route handlers across 37 groups. Handlers stay thin: parse, authorise,
delegate to `lib/`, shape the response. Domain logic belongs in `lib/`.

---

## Authentication tiers

Every route sits in exactly one tier. **When adding a route, pick its tier
deliberately** — the default of "no check" is never correct.

| Tier | Mechanism | Used by |
| --- | --- | --- |
| **User session** | `getSession()` / `requireSession()` from `lib/require-session.ts` | The great majority of routes. Returns `null` in handlers so they can answer 401 as JSON; redirects in Server Components. |
| **Admin secret** | `x-clean-db-secret` header matched against `CLEAN_DB_SECRET` | All 16 `/api/admin/*` routes |
| **Cron secret** | `CRON_SECRET` bearer token, or `x-clean-db-secret` | `/api/cron/*` |
| **Webhook signature** | Provider-specific signature verification | `/api/*/webhook` |
| **OAuth state** | Signed state cookie compared against the `state` query parameter | `/api/*/oauth/callback` |

Two rules the destructive routes already follow and any new one must:

- **Refuse outside production.** `/api/admin/*` returns 403 unless
  `NODE_ENV === "production"`, so a misfired local call cannot truncate tables.
- **Never accept a secret in the query string.** Routes explicitly reject
  `?secret=` and require the header or JSON body, because URLs leak into logs,
  proxies and referrers.

> The admin tier is a **single shared secret** guarding everything from
> `gmail-connection-status` to `wipe-all-user-data`. One leaked value grants
> destructive access to all of it. Splitting it per scope is tracked in
> `REVIEW.md` §3.7.

---

## Route groups

| Group | Routes | Purpose |
| --- | ---: | --- |
| `dashboard/` | 31 | Read models backing the dashboard surfaces |
| `admin/` | 16 | Destructive and operational tooling — shared-secret gated, production only |
| `books/` | 12 | Ledger views |
| `movements/` | 10 | Bank movement listing, tagging, classification |
| `plaid/` `xero/` `stripe/` `quickbooks/` `shopify/` | 30 | Per-integration OAuth, sync and webhooks |
| `cron/` | 6 | Scheduled sync and maintenance |
| `ar-reconciliation/` `ar-ap-reconciliation/` `reconciliation/` | — | Matching, candidates, confirmation |
| `slack/` `twilio/` `whatsapp/` | — | Conversational surfaces |
| `brain/` `context/` `state/` `forecast/` | — | Derived financial state and forecasting |
| `v1/` | — | Versioned public surface |

---

## Conventions

**Error envelopes** come from `lib/api-utils.ts` (`createErrorResponse`). Do not
hand-roll error JSON — the shape is consumed by the client.

**Structured logging** uses `log()` from `lib/logger.ts` with a dotted event
name and a scope, e.g. `log("qbo.sync.failed", { realmId, error }, "qbo")`.
Never `console.log` in a handler.

**Long-running work** belongs on the Bull queue (`lib/queue/`), not in the
request path. Routes that kick off syncs should enqueue and return, or write a
status row the client polls.

**`twillo/` is not a typo to delete.** It is a deliberate alias of `twilio/`;
`docs/TWILIO_WHATSAPP_SETUP.md` documents that misspelled URL as the webhook
actually configured in the Twilio console. Retire it by repointing Twilio first.

---

## Testing

These handlers have **no automated coverage** — the largest single gap in the
repo. A shared harness asserting auth-required/401, response shape and error
envelope would cover a lot of surface cheaply. See `REVIEW.md` §4.
