# QuickBooks Online: Heroku Config & Intuit Developer Portal

Use this checklist to wire the QBO connector to **dashboard.profitwise.app** (Heroku app: `profitwise-login-page`).

---

## 1. Heroku Config Vars

Set these on the app that serves **https://dashboard.profitwise.app** (e.g. `profitwise-login-page`).

From the project root, with the correct Heroku remote (e.g. `heroku-login`):

```bash
# Replace YOUR_APP with your Heroku app name if different (e.g. profitwise-login-page)
heroku config:set APP_URL=https://dashboard.profitwise.app --app profitwise-login-page

# Set these with your real values from the Intuit Developer portal (never commit these):
heroku config:set QUICKBOOKS_CLIENT_ID="<your-client-id>" --app profitwise-login-page
heroku config:set QUICKBOOKS_CLIENT_SECRET="<your-client-secret>" --app profitwise-login-page
heroku config:set QUICKBOOKS_WEBHOOK_VERIFIER="<your-webhook-verifier-token>" --app profitwise-login-page

# Optional: use sandbox (true) or production (omit or false)
heroku config:set QUICKBOOKS_SANDBOX=true --app profitwise-login-page
```

**Required vars:**

| Variable | Description |
|----------|-------------|
| `APP_URL` | Base URL of the app, e.g. `https://dashboard.profitwise.app` (used for OAuth redirect URI). |
| `QUICKBOOKS_CLIENT_ID` | OAuth 2.0 Client ID from Intuit Developer portal. |
| `QUICKBOOKS_CLIENT_SECRET` | OAuth 2.0 Client secret from Intuit Developer portal. |
| `QUICKBOOKS_WEBHOOK_VERIFIER` | Webhook verifier token; must match the value you set in the Intuit portal. |

**Optional:**

| Variable | Description |
|----------|-------------|
| `QUICKBOOKS_SANDBOX` | Set to `true` for Intuit sandbox; omit or set to `false` for production. |
| `NEXT_PUBLIC_APP_URL` | Alternative to `APP_URL` for redirect URI if you use this in the frontend. |

**Heroku Postgres (tokens + entities):**  
If you use Heroku Postgres, `DATABASE_URL` is set automatically when you add the addon. The app then stores QBO OAuth tokens and synced entities (transactions, invoices, etc.) in the database instead of in memory.

```bash
heroku addons:create heroku-postgresql:essential-0 --app profitwise-login-page
```

After changing config, redeploy or restart:

```bash
heroku restart --app profitwise-login-page
```

---

## 2. Intuit Developer Portal

Do this in [developer.intuit.com](https://developer.intuit.com) for your app (e.g. **profitwise**).

### Redirect URI

1. Open your app → **Keys & credentials** (or **Configuration**).
2. Under **Redirect URIs**, add (or set as the only one):
   - **https://dashboard.profitwise.app/api/quickbooks/oauth/callback**
3. Save.

### Webhook

1. Open **Webhooks** (or **Keys & credentials** → Webhooks).
2. **Endpoint URL:**  
   **https://dashboard.profitwise.app/api/quickbooks/webhook**
3. **Verifier token:**  
   Use the **exact same** value as in Heroku config var `QUICKBOOKS_WEBHOOK_VERIFIER`. This is used only for the GET verification request (when Intuit validates your endpoint). **POST payloads are signed with your app’s client secret** (HMAC-SHA256); the app verifies using `QUICKBOOKS_CLIENT_SECRET`.
4. Subscribe to the events you need (e.g. Invoice, Payment, Bill, etc.).
5. Save.

### Consistency

- Redirect URI in Intuit **must** match: `https://dashboard.profitwise.app/api/quickbooks/oauth/callback`
- Webhook URL in Intuit **must** match: `https://dashboard.profitwise.app/api/quickbooks/webhook`
- Webhook verifier in Intuit **must** equal the value of `QUICKBOOKS_WEBHOOK_VERIFIER` on Heroku

---

## 3. Other hosts (Vercel, etc.)

For any other host (e.g. Vercel, Railway, Render), set the same variables in that host’s environment / config:

- `APP_URL` = `https://dashboard.profitwise.app` (or the app’s own URL if different)
- `QUICKBOOKS_CLIENT_ID`
- `QUICKBOOKS_CLIENT_SECRET`
- `QUICKBOOKS_WEBHOOK_VERIFIER`
- Optionally `QUICKBOOKS_SANDBOX=true`

Then in the Intuit portal, point Redirect URI and Webhook URL to that host’s URLs if you are not using dashboard.profitwise.app.

---

## 4. “Create a new company” vs connecting an existing company

If Intuit’s OAuth screen keeps asking you to **create a new company** instead of letting you **choose an existing QuickBooks company**, it’s almost always due to **sandbox vs production** and **which keys** you use.

### Connect to your real (existing) QuickBooks company

1. **Use production, not sandbox**  
   Set:
   ```bash
   heroku config:set QUICKBOOKS_SANDBOX=false --app profitwise-login-page
   ```
   (Or leave `QUICKBOOKS_SANDBOX` unset.)

2. **Use Production keys**  
   In [developer.intuit.com](https://developer.intuit.com) → your app → **Keys & credentials**, use the **Production** Client ID and Client Secret (not the Development/Sandbox keys). Copy those into Heroku:
   ```bash
   heroku config:set QUICKBOOKS_CLIENT_ID="<production-client-id>" --app profitwise-login-page
   heroku config:set QUICKBOOKS_CLIENT_SECRET="<production-client-secret>" --app profitwise-login-page
   ```

3. **Redirect URI in Intuit**  
   Under Production (not Development), add:
   `https://dashboard.profitwise.app/api/quickbooks/oauth/callback`

4. **Sign in with the same Intuit account** that owns the existing QuickBooks company. After sign-in, Intuit should show that company (or a list) to authorize.

### If you must use Sandbox (testing)

- Sandbox is for test companies. Intuit often shows “Create a company” first.
- To use an *existing* sandbox company: in the Intuit Developer portal, go to your app → **Sandbox** / **Testing** and create or manage companies there. Then sign in with the **same developer account** when going through OAuth; that sandbox company may appear to select after you’ve created it once.
- You cannot connect a **real** QuickBooks company while using sandbox/Development keys; use production and Production keys for that.

### Already in production but still seeing “Create a company”?

If you’re already using production keys and `QUICKBOOKS_SANDBOX=false` but Intuit still asks to create a new company:

1. **Redirect URI in Production**  
   In the Intuit Developer portal, Redirect URIs are **separate for Development and Production**. Under **Production** → **Keys & OAuth** (or **Keys & credentials**), add:
   `https://dashboard.profitwise.app/api/quickbooks/oauth/callback`  
   If it’s only set under Development, the production OAuth flow can behave oddly (e.g. “create company” instead of “select company”).

2. **Sign in with the right Intuit account**  
   Use the Intuit ID that **owns** the existing QuickBooks Online company (the same account you use at [quickbooks.intuit.com](https://quickbooks.intuit.com)). If you sign in with a different account (e.g. only a developer account with no QBO company), Intuit will correctly show “create a company.”

3. **App production status**  
   Confirm the app is fully in production (e.g. “Go live” or production access completed in the portal). Some apps need an explicit production approval before Intuit associates OAuth with existing companies.

4. **Known Intuit behavior**  
   Intuit has a known issue where, after moving from development to production, OAuth sometimes doesn’t associate the user’s login with their existing company and shows “create a company” instead. If the above checks don’t fix it, contact **Intuit Developer Support** (help.developer.intuit.com) with your app ID and that you need to connect an existing production company; they can check app/company association on their side.
