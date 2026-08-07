# Multi-user and database audit

This document describes how multiple users are isolated in the DB and application logic, and what was verified/fixed.

---

## 1. Database schema (user-scoped tables)

All tables that store user-specific data either have a `user_id` column referencing `users(id)` or are reachable only via a user-owned parent row.

### 1.1 Auth (`ensureAuthSchema`)

| Table     | Key columns | Multi-user |
|-----------|-------------|------------|
| `users`   | `id` (PK), `email` UNIQUE, `password_hash`, `onboarding_step`, `final_context`, `company_form` | One row per user. Step, context, and form are per user. |
| `sessions`| `id`, `user_id` → users(id), `token` UNIQUE, `expires_at` | One row per session; `user_id` ties session to user. |

- Login/signup create sessions with `user_id`. `getUserBySessionToken(token)` joins `sessions` and `users` and returns the correct user.

### 1.2 Plaid (`ensurePlaidSchema`)

| Table                 | Key columns | Multi-user |
|-----------------------|-------------|------------|
| `plaid_items`         | `user_id` → users(id), `item_id` UNIQUE, `access_token`, `cursor` | Each item belongs to one user. |
| `plaid_accounts`      | `item_id` → plaid_items(item_id) | Scoped by item → user. |
| `plaid_transactions`  | `item_id` → plaid_items(item_id) | Scoped by item → user. |
| `plaid_webhook_last`  | Singleton (id=1) | Global; only stores last webhook metadata, not user data. |

- All reads that need “current user’s data” join through `plaid_items` and filter `WHERE pi.user_id = $1` (or use `listPlaidItemIds(userId)` and then only those items).

### 1.3 QuickBooks (`ensureQBOSchema`)

| Table              | Key columns | Multi-user |
|--------------------|-------------|------------|
| `qbo_connections`  | `user_id` → users(id), `realm_id` UNIQUE | One realm can be linked to only one user (last writer wins). |
| `qbo_entities`     | `realm_id` → qbo_connections(realm_id) | Scoped by realm → connection → user. |
| `qbo_sync_status`  | `realm_id` PK → qbo_connections(realm_id) | Per realm, hence per owner. |

- APIs that return QBO data use `listRealmIdsByUserId(user.id)` and only touch those `realm_id`s; any `realmId` from the client is checked against that list (403 if not in list).

### 1.4 Xero (`ensureXeroSchema`)

| Table               | Key columns | Multi-user |
|---------------------|-------------|------------|
| `xero_connections`  | `user_id` → users(id), `tenant_id` UNIQUE | One tenant per user (last writer wins). |
| `xero_entities`     | `tenant_id` → xero_connections(tenant_id) | Scoped by tenant → connection → user. |

- Same pattern as QBO: `listTenantIdsByUserId(user.id)` and only those tenants are used; client-supplied `tenantId` is validated.

### 1.5 Merchant tags (`ensureMerchantTagsSchema`)

| Table            | Key columns | Multi-user |
|------------------|-------------|------------|
| `merchant_tags`  | `user_id` → users(id), UNIQUE(user_id, account_id, raw_name) | All rows keyed by `user_id`. |

### 1.6 WhatsApp (`ensureWhatsAppSchema`)

| Table           | Key columns | Multi-user |
|----------------|-------------|------------|
| `user_whatsapp`| `user_id` PK → users(id), `phone_e164` UNIQUE | One row per user; phone is unique globally. |

- Request-OTP checks that the phone is either unlinked or linked to the current user (`existing[0].user_id !== user.id` → reject).

### 1.7 Slack (`ensureSlackSchema`)

| Table                | Key columns | Multi-user |
|----------------------|-------------|------------|
| `user_slack`         | `user_id` PK → users(id), (slack_team_id, slack_user_id) UNIQUE | One Slack link per app user. |
| `slack_events_seen`  | `event_id` PK | Global; idempotency only, no user data. |

---

## 2. API and logic audit (per-user behavior)

### 2.1 Auth and session

- **Login/signup**: Create session with `user_id`; set session cookie. No cross-user leakage.
- **All protected APIs**: Use `getSessionCookieName()` and `getUserBySessionToken(token)`; then use `user.id` for any DB read/write. No APIs were found that use a different user id than the session user.

### 2.2 Plaid

- **Exchange token**: Stores item with `user.id` in `plaid_items` (user-scoped).
- **Items list**: `listPlaidItemIds(user.id)` only.
- **Balances**: `getAccountsWithBalancesByUserId(user.id)` (JOINs `plaid_items` with `user_id`).
- **Transactions sync**: **Fixed.** Previously accepted any `item_id` from the client. Now: only allow sync if `itemId` is in `listPlaidItemIds(user.id)`; otherwise 403.
- **Persistence**: `getTransactionsByUserId(userId, ...)` and `getAccountsWithBalancesByUserId(userId)` both filter by `pi.user_id`.
- **Webhook**: Uses `item_id` from Plaid; updates that item’s transactions. Item is already owned by a user in `plaid_items`; no user parameter needed and no cross-user access.

### 2.3 QuickBooks

- **OAuth authorize**: Puts `userId: user.id` in state cookie.
- **OAuth callback**: **Fixed.** If state cookie is missing or has no `userId`, redirect to `/onboarding?error=session_expired` and do **not** call `setToken`. Ensures we never persist a QBO connection without a user.
- **Sync / transactions / sync status**: All use `listRealmIdsByUserId(user.id)`; any `realmId` from the client is checked against this list (403 if not allowed).
- **Entity store**: QBO entities are stored by `realm_id`; realm is owned by one user via `qbo_connections.user_id`. Reads/writes are only for realms the current user is allowed to see (enforced at API layer). **Fixed:** Postgres insert no longer references non-existent `payload` column; uses only `data` to match `lib/db.ts` schema.

### 2.4 Xero

- **OAuth authorize**: Puts `userId: user.id` in state cookie.
- **OAuth callback**: **Fixed.** Same as QBO: if no `userId` in state cookie, redirect to `/onboarding?error=session_expired` and do not call `exchangeCodeAndStore`.
- **Sync**: Uses `listTenantIdsByUserId(user.id)` and only syncs those tenants; `userId` is passed to entity store for GCP when used.
- **Entity store**: Same pattern as QBO; tenant is owned by one user via `xero_connections.user_id`.

### 2.5 Onboarding and context

- **Progress**: GET/PATCH use `user.id`; read/update `users.onboarding_step` and `users` row by `id`.
- **Company form**: GET/PATCH use `user.id`; read/update `users.company_form` by `id`.
- **Context save**: GET/POST use `user.id`; read/update `users.final_context` and Supermemory with user-scoped tag.
- **Invoices**: Uses `listRealmIdsByUserId(user.id)` and `listTenantIdsByUserId(user.id)`; only fetches entities for those realms/tenants; passes `userId` to entity getters when using GCP.
- **Merchants (transactions, suggest, normalize-and-tag, update)**: All filter or key by `user.id` (and `merchant_tags.user_id` / `plaid_items.user_id` where applicable).
- **Connections**: Returns only `listRealmIdsByUserId(user.id)` and `listTenantIdsByUserId(user.id)`.
- **Disconnect accounting**: Deletes only `qbo_connections` and `xero_connections` where `user_id = user.id`.

### 2.6 Supermemory and AI

- **Supermemory**: Per-user tag (e.g. `getUserFinanceTag(user.id)`) is used for connections, company context, context save, merchant overrides, and AI reply (Slack/WhatsApp) so each user’s context is isolated.

### 2.7 WhatsApp / Slack

- **WhatsApp**: OTP and linking use `user_whatsapp.user_id`; request-OTP rejects if phone is linked to another user.
- **Slack**: Link and status use `user_slack` keyed by `user_id`; AI reply uses user-scoped Supermemory context.

---

## 3. Summary of code changes from this audit

| Area | Change |
|------|--------|
| **Plaid transactions-sync** | Only allow sync for `item_id` in `listPlaidItemIds(user.id)`; otherwise return 403. |
| **QBO OAuth callback** | If state cookie has no `userId`, redirect to `/onboarding?error=session_expired` and do not call `setToken`. |
| **Xero OAuth callback** | Same: no `userId` → redirect to `/onboarding?error=session_expired`, do not call `exchangeCodeAndStore`. |
| **QBO entity store (Postgres)** | Insert/update use only `data` column; removed references to non-existent `payload` column so schema matches `lib/db.ts`. |

---

## 4. Development vs production

- **Auth**: In non-production, `getUserBySessionToken` returns `null`, so all protected APIs return 401. Multi-user behavior is only fully exercised in production with real DB and sessions.
- **Plaid/QBO/Xero stores**: In dev, in-memory stores are shared (no `user_id` in memory). Production uses Postgres with `user_id` and realm/tenant ownership; multi-user isolation is enforced there.

---

## 5. Display logic (multiple users on the frontend)

### 5.1 How the UI gets "current user" data

- **No user id in URLs or client state**: The app never passes `userId` or `user_id` in the URL or request body to mean "show me this user's data." The only identifier for "who am I?" is the **session cookie** on every request.
- **Same-origin API calls**: All fetches to `/api/*` are same-origin; the browser sends the session cookie automatically. The server resolves the user via `getUserBySessionToken(cookie)` and filters all data by `user.id`.
- **Session endpoint**: `GET /api/auth/session` returns `{ user: { id, email } }` for the current session only, or `{ user: null }` if unauthenticated. No API accepts a target user id to show another user's data.

### 5.2 APIs that return display data (all session-scoped)

- **auth/session** – current user id/email from token.
- **onboarding/progress, company-form, context/save** – read/write `users` by `user.id`.
- **context/financial, context/final** – `buildFinancialContext(user.id)` and per-user company context.
- **connections** – `listRealmIdsByUserId(user.id)`, `listTenantIdsByUserId(user.id)`.
- **plaid/items, plaid/balances** – `listPlaidItemIds(user.id)`, `getAccountsWithBalancesByUserId(user.id)`.
- **onboarding/merchants/transactions, invoices** – queries filter by `pi.user_id` / `mt.user_id` or user's realms/tenants.
- **supermemory/status, company-context** – per-user tag. **whatsapp/status** – `user_whatsapp` for `user.id`.
- **quickbooks/sync/status** – only realms in `listRealmIdsByUserId(user.id)`; 403 if client sends another `realmId`.

### 5.3 Frontend flows

- **Onboarding**: All fetches are cookie-only; no `userId` or `realmId`/`tenantId` from URL. Only `error` param is used (OAuth errors).
- **Sync**: When the UI sends `realmId` or `item_id`, the server validates ownership and returns 403 if not the current user's.
- **OAuth pages**: Use `params.integration` only; status/disconnect/verify are session-based.

**Summary**: Single source of identity for display is the session cookie; all returned data is filtered by `user.id`. No "view as" or cross-user display. Admin routes (e.g. admin/db-data) are the only cross-user endpoints and are gated separately.

---

## 6. Optional frontend improvement

- When the app redirects to `/onboarding?error=session_expired`, the onboarding flow receives `qboError === "session_expired"`. You can show a short message like: “Your session expired. Please sign in again and retry connecting.” to improve UX.
