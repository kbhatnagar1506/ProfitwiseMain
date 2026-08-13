# Security

Profitwise handles bank connections, accounting ledgers and payment-processor
credentials. Security reports are taken seriously and reviewed promptly.

## Reporting a vulnerability

**Do not open a public issue.** Report privately:

- GitHub → **Security** → **Report a vulnerability** (private advisory), or
- email **krishna@profitwise.app**

Useful to include: what you found, how to reproduce it, which component is
affected, and what an attacker could do with it. If you are unsure whether
something qualifies, report it anyway.

Please do not test against production, access data that is not yours, or run
automated scanners against live infrastructure.

## Scope

In scope: authentication and session handling, the OAuth callbacks, webhook
signature verification, the admin and cron endpoints, SQL injection, tenant
isolation between users, and secret handling.

Out of scope: vulnerabilities in third-party services themselves (report those
to Plaid, Stripe, Intuit, and so on), and findings that require a compromised
developer machine.

## How this codebase is defended

Documented so reviewers know what to expect, and contributors know what not to
break.

**Authentication.** Argon2id password hashing (64 MB memory cost, time cost 3).
Sessions are opaque 32-byte random tokens stored server-side with expiry, never
JWTs in a cookie. Edge middleware checks cookie presence; the actual session is
verified in Node against the database.

**Route authorisation.** Five tiers — user session, admin shared secret, cron
secret, webhook signature, OAuth state. Every route sits in exactly one.
[`web/app/api/README.md`](web/app/api/README.md) lists which.

**OAuth.** Every callback validates a signed `state` cookie against the returned
`state` parameter and fails closed on mismatch.

**Destructive endpoints.** `/api/admin/*` refuses to run unless
`NODE_ENV=production`, requires a shared secret in a header or JSON body, and
explicitly rejects the secret in a query string because URLs leak into logs,
proxies and referrers.

**Database access.** All queries are parameterised through `query<T>()` in
`lib/db.ts`. No string-interpolated SQL.

**LLM boundaries.** Prompt sanitisation, a circuit breaker, rate limiting and a
hallucination detector sit in front of every model call
(`lib/llm-*.ts`). Critically, when a model is unavailable the matcher applies
*stricter* deterministic thresholds — an outage can never widen what gets
auto-accepted.

**Secrets.** `.env*` is gitignored except `.env.example`, which contains only
placeholders. Service-account JSON is passed by environment variable, never
committed. History has been scanned; no credentials have ever been committed.

## Known weaknesses

Published deliberately rather than left for someone to discover:

- **One shared admin secret.** All 16 `/api/admin/*` routes authenticate with
  the same `CLEAN_DB_SECRET`, from `gmail-connection-status` to
  `wipe-all-user-data`. A single leak grants destructive access to everything.
  Tracked in [REVIEW.md](REVIEW.md) §3.7.
- **Suppressed type errors.** `typescript.ignoreBuildErrors` hides 349 errors,
  around 104 of which are untyped database rows. That is a correctness risk more
  than a security one, but it weakens the guarantees a reviewer can rely on.
  [REVIEW.md](REVIEW.md) §3.2.
- **LLM validation fails open** on candidates a model omits from an otherwise
  well-formed response. [REVIEW.md](REVIEW.md) §3.4.

## Rotating a leaked credential

If a key is exposed, rotate at the provider first — revocation is what actually
stops the bleeding, not deleting the commit.

1. Revoke and reissue at the provider (Plaid, Stripe, Intuit, Xero, Google,
   Twilio, Slack, OpenAI).
2. Update the environment variable in the deployment platform.
3. Redeploy so every process picks up the new value.
4. Only then consider history rewriting — and treat the old value as
   permanently compromised regardless, since it may already be cached or cloned.
