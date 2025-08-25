# Webhook and refresh logic audit

How each integration’s webhooks trigger (or don’t trigger) data refresh, and how that fits with UI refresh.

---

## 1. Plaid

### Webhook: `POST /api/plaid/webhook`

- **Verification**: Optional. If `Plaid-Verification` header is present, verifies JWT (Plaid’s key) and body SHA-256; otherwise accepts payload.
- **Handled event**: `webhook_type === "TRANSACTIONS"` and `webhook_code === "SYNC_UPDATES_AVAILABLE"` and valid `item_id`.
- **Refresh logic**:
  1. **Transactions**: For that `item_id`, in a loop:
     - `getPlaidItem(itemId)` → get `access_token` and `cursor`
     - Call Plaid `transactionsSync` with that token and cursor
     - `mapAndUpsert(itemId, added, modified)` and `mapAndDelete(itemId, removed)` (DB)
     - `updatePlaidItemCursor(itemId, nextCursor)`
     - Repeat while `has_more`
  2. **Balances** (after change below): After transaction sync completes for that item, call `getAccounts(access_token)` and `saveAccounts(itemId, accounts)` so `plaid_accounts` (balances) stay in sync when new transactions arrive.

- **User scoping**: Webhook has no session; it uses `item_id` from Plaid. That item is already tied to a user in `plaid_items`. No cross-user risk.
- **Other refresh**: User can call `GET /api/plaid/balances?refresh=1` to refresh all their items’ balances; exchange-token also saves accounts on link.

### Summary

- Transactions: kept up to date by webhook.
- Balances: now also refreshed in webhook after transaction sync (see code change); otherwise only on link or on `?refresh=1`.

---

## 2. QuickBooks Online (QBO)

### Webhook: `POST /api/quickbooks/webhook`

- **Verification**: `GET` returns `QUICKBOOKS_WEBHOOK_VERIFIER` for challenge. `POST`: if `intuit-signature` header present, verifies HMAC-SHA256 with `QUICKBOOKS_CLIENT_SECRET` or `QUICKBOOKS_WEBHOOK_VERIFIER`; otherwise no verification (relies on secrecy of URL).
- **Payload**: Supports:
  - Legacy: array of objects with `intuitaccountid` (realm) and `eventNotifications[]` with `realmId` and `dataChangeEvent.entities[]` (name, id, operation).
  - CloudEvents-style: array of events with `intuitaccountid`, `intuitentityid`, `type` (e.g. `qbo.invoice.*.v1`).
- **Refresh logic** (runs in fire-and-forget `void async()` after 200 response):
  1. **Per-entity**: For each parsed change (`realmId`, entity `name`, `id`, `operation`):
     - If `operation === "Delete"`: `deleteEntity(realmId, name, id)` (DB/GCP).
     - Else: `getEntityById(realmId, name, id)` then `upsertEntities(realmId, name, [entity])` (DB/GCP). No `userId` passed; store uses `getUserIdByRealmId(realmId)` for GCP.
  2. **Invoice resync**: For every realm that had any event, fetch all invoices for that realm and upsert: `getAllForEntity(realmId, "Invoice")` then `upsertEntities(realmId, "Invoice", items)` so the invoice list (and GCP bucket) stays in sync.

- **User scoping**: Webhook has no session; it uses `realmId` from Intuit. Realms are tied to a user in `qbo_connections`. Entity store resolves `userId` from `realm_id` when needed for GCP. No cross-user risk.
- **Other refresh**: User can trigger full sync via `POST /api/quickbooks/sync` with `realmId` (validated against `listRealmIdsByUserId(user.id)`).

### Summary

- QBO refresh logic is solid: per-entity updates for changed entities plus a full invoice resync per touched realm. Background processing avoids timeouts.

---

## 3. Xero

### Webhook: `POST /api/xero/webhook`

- **Verification**: Requires `x-xero-signature` (or `X-Xero-Signature`). Verifies HMAC-SHA256 with `XERO_WEBHOOK_KEY` (raw or base64-decoded). Rejects if signature missing or invalid.
- **Refresh logic**: **None.** The handler only verifies the signature and returns `{ received: true }`. It does **not** parse the body or update `xero_entities` (or GCP). So when an invoice (or contact, etc.) changes in Xero, our stored data is **not** updated until the user triggers `POST /api/xero/sync`.

- **User scoping**: N/A for now (no data update).
- **Other refresh**: User can trigger full sync via `POST /api/xero/sync`, which uses `listTenantIdsByUserId(user.id)` and for each tenant fetches entities and calls `upsertEntities(tenantId, type, items, { userId: user.id })`.

### Summary

- **Gap**: Xero webhook does not refresh data. Xero does send events (e.g. INVOICE, CONTACT with tenantId, resourceId, eventCategory). A future improvement would be to parse the payload and either refresh the affected entity/tenant or trigger a sync for that tenant so Xero data stays in sync without requiring the user to hit “Sync” in the UI.

---

## 4. Summary table

| Integration | Webhook verifies | Webhook refreshes | User-triggered refresh |
|-------------|------------------|-------------------|-------------------------|
| **Plaid**   | Optional (JWT + body hash) | Transactions + balances (after change) for the item | Balances: `GET /api/plaid/balances?refresh=1`. Transactions: `POST /api/plaid/transactions-sync` with `item_id`. |
| **QBO**     | HMAC (signature header)    | Per-entity upsert/delete + full invoice resync per realm | `POST /api/quickbooks/sync` with `realmId`. |
| **Xero**    | HMAC (signature header)   | **None** – no parsing, no DB update | `POST /api/xero/sync` (all user’s tenants). |

---

## 5. Recommended change (implemented)

- **Plaid**: After `runTransactionsSync(itemId)` completes, refresh balances for that item: get the item again, call `getAccounts(item.access_token)`, then `saveAccounts(itemId, accounts)`. That way balances stay updated when Plaid sends SYNC_UPDATES_AVAILABLE.

## 6. Optional future change

- **Xero**: Parse webhook body (e.g. `tenantId`, `eventCategory`, `resourceId`, `eventType`), and for each event either fetch that entity and upsert, or trigger a sync for that tenant so Xero entities (invoices, etc.) stay in sync without user action.
