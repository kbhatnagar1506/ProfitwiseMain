# Plaid: Bank connection & transaction webhooks

Use this checklist to wire the Plaid connector to **dashboard.profitwise.app** (Heroku app: `profitwise-login-page`).

**Production keys:** Use the **Client ID** and **Production secret** from [dashboard.plaid.com → Developers → Keys](https://dashboard.plaid.com/developers/keys). Do not set `PLAID_ENV` (or leave it unset) so the app uses Plaid’s production API.

**Sync flow:** The app first fetches up to **730 days (2 years)** of transactions (paginated). After that, **webhooks** (`SYNC_UPDATES_AVAILABLE`) are used for all ongoing sync—no polling needed.

---

## 1. Heroku config vars

Set these on the app that serves **https://dashboard.profitwise.app**:

**Option A – script (recommended)**  
From the project root, set your production secret and run:

```bash
export PLAID_SECRET="your-production-secret-from-dashboard-plaid-com"
./scripts/set-heroku-plaid-env.sh
```

To use a different Heroku app: `HEROKU_APP_NAME=my-app ./scripts/set-heroku-plaid-env.sh`

**Option B – manual commands**

```bash
# Base URL (used for Plaid webhook URL)
heroku config:set APP_URL=https://dashboard.profitwise.app --app profitwise-login-page

# Plaid keys from dashboard.plaid.com (never commit the secret)
heroku config:set PLAID_CLIENT_ID=691d68e9b91788001eb997c8 --app profitwise-login-page
heroku config:set PLAID_SECRET="<your-plaid-production-secret>" --app profitwise-login-page

# Optional: use sandbox for testing (omit for production)
heroku config:set PLAID_ENV=sandbox --app profitwise-login-page
```

**Required:**

| Variable | Description |
|----------|-------------|
| `APP_URL` | Base URL of the app, e.g. `https://dashboard.profitwise.app` (used to build the Plaid webhook URL). |
| `PLAID_CLIENT_ID` | Plaid Client ID from [dashboard.plaid.com](https://dashboard.plaid.com). |
| `PLAID_SECRET` | Plaid secret (use **Production** secret for live banks). |

**Optional:**

| Variable | Description |
|----------|-------------|
| `PLAID_ENV` | `sandbox` for testing; omit for production (Plaid uses production by default). |
| `NEXT_PUBLIC_APP_URL` | Alternative to `APP_URL` for building the webhook URL. |

**Storage:**  
Plaid access tokens and sync cursors are stored in memory (Postgres has been removed for a future remake). Data does not persist across app restarts.

After changing config:

```bash
heroku restart --app profitwise-login-page
```

---

## 2. Transaction history (2 years) → then webhooks for sync

The app requests **up to 730 days (2 years)** of transaction history when creating a Link token (`transactions.days_requested: 730`). Plaid may not return it all at once:

- **Initial fetch (730 days):** After the user connects a bank, call `POST /api/plaid/transactions-sync` with the `item_id`. The route **paginates automatically** until all available updates are fetched and the cursor is stored.
- **After that, webhooks only:** Once the initial 730-day sync is done, **all ongoing sync is driven by webhooks.** When Plaid has new or changed transactions, it sends **`SYNC_UPDATES_AVAILABLE`** to `https://dashboard.profitwise.app/api/plaid/webhook`. The app runs a paginated sync for that Item and updates the cursor. No polling required.

---

## 3. Webhook URL (transaction sync)

Plaid does **not** use a separate “webhook registration” page. The webhook URL is passed when you create a Link token (the app does this in `POST /api/plaid/link-token`).

**Webhook endpoint your app exposes:**

- **https://dashboard.profitwise.app/api/plaid/webhook**

This URL is sent to Plaid as the `webhook` parameter in `/link/token/create`. Plaid will send `SYNC_UPDATES_AVAILABLE` (and other transaction webhooks) to this URL. The app:

1. Verifies the request using the `Plaid-Verification` JWT header (optional but recommended).
2. On `SYNC_UPDATES_AVAILABLE`, runs a **paginated** transaction sync for that Item and stores the new cursor.

No need to paste this URL into the Plaid dashboard; it is configured automatically when users connect a bank via Link.

---

## 4. API routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/plaid/link-token` | POST | Returns a `link_token` for initializing Plaid Link (bank connection UI). |
| `/api/plaid/exchange-token` | POST | Body: `{ "public_token": "..." }`. Exchanges the public token for an access token and stores the Item. |
| `/api/plaid/webhook` | POST | Receives Plaid webhooks (e.g. `SYNC_UPDATES_AVAILABLE`). Called by Plaid only. |
| `/api/plaid/transactions-sync` | POST | Body: `{ "item_id": "..." }`. Manually trigger a full (paginated) transaction sync for an Item. Fetches all pages until `has_more` is false. |

---

## 5. Frontend flow (connect bank)

1. Call `POST /api/plaid/link-token` to get `link_token`.
2. Initialize [Plaid Link](https://plaid.com/docs/link/) with that `link_token` (e.g. `react-plaid-link` or Link’s script).
3. In Link’s `onSuccess`, you receive a `public_token`. Call `POST /api/plaid/exchange-token` with `{ "public_token": public_token }`.
4. Call `POST /api/plaid/transactions-sync` with the returned `item_id` to fetch the initial 2 years of transactions (paginated automatically). Alternatively, wait for Plaid to send `SYNC_UPDATES_AVAILABLE` to the webhook; the app will sync then.

---

## 6. Other hosts (Vercel, etc.)

Set the same variables in that host’s environment:

- `APP_URL` (or `NEXT_PUBLIC_APP_URL`) = your app’s base URL
- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_ENV` = `sandbox` if testing

The webhook URL will be `{APP_URL}/api/plaid/webhook`.
