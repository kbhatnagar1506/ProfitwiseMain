# Wipe all user data (for testing)

To reset the app to a clean state (no users, no connections, no transactions, etc.) so you can test signup and onboarding again:

## Endpoint

**`POST /api/admin/wipe-all-user-data`**

- **Auth**: Send your admin secret via header **`x-clean-db-secret`** (or in JSON body as `{ "secret": "YOUR_SECRET" }`).
- **Env**: Set `CLEAN_DB_SECRET` in production to the same value.
- **Availability**: Only runs when `NODE_ENV === "production"`.

## What it does

1. Deletes QBO and Xero entity files from the GCP bucket (if `GCP_ENTITY_BUCKET` is set).
2. Truncates all user-related tables in dependency order:
   - Plaid: `plaid_transactions`, `plaid_accounts`, `plaid_webhook_last`, `plaid_items`
   - QBO: `qbo_entities`, `qbo_sync_status`, `qbo_connections`
   - Xero: `xero_entities`, `xero_connections`
   - Other: `merchant_tags`, `user_whatsapp`, `user_slack`, `slack_events_seen`, `sessions`, `users`

After a successful wipe, you can sign up again and go through onboarding from step 1.

## Example (production)

```bash
# Replace YOUR_APP_URL and YOUR_CLEAN_DB_SECRET with real values.
curl -X POST "https://YOUR_APP_URL/api/admin/wipe-all-user-data" \
  -H "Content-Type: application/json" \
  -H "x-clean-db-secret: YOUR_CLEAN_DB_SECRET"
```

Or with secret in body:

```bash
curl -X POST "https://YOUR_APP_URL/api/admin/wipe-all-user-data" \
  -H "Content-Type: application/json" \
  -d '{"secret":"YOUR_CLEAN_DB_SECRET"}'
```

**Do not** put the secret in the URL (e.g. `?secret=...`) — the endpoint rejects that for security.

## Local / non-production

The endpoint returns **403** when `NODE_ENV !== "production"`. To wipe data locally you would need to either:

- Run SQL directly against your local DB (same `TRUNCATE ... CASCADE` as in the route), or
- Temporarily set `NODE_ENV=production` and `CLEAN_DB_SECRET` when calling the endpoint (not recommended if your local DB is shared).
