# Xero: OAuth & Webhook

Use this checklist to wire the Xero connector to **dashboard.profitwise.app** (Heroku app: `profitwise-login-page`).

---

## 1. URLs to use in Xero Developer Portal

Configure your Xero app at [developer.xero.com](https://developer.xero.com) with these values.

### Redirect URI (OAuth 2.0)

**Redirect URI:**

```
https://dashboard.profitwise.app/api/xero/oauth/callback
```

Add this exact URL under your app’s **Configuration** → **Redirect URIs**. No trailing slash.

### Webhook endpoint

**Webhook URL:**

```
https://dashboard.profitwise.app/api/xero/webhook
```

When creating a webhook in the Xero Developer Portal, use this URL. You will set a **Signing key**; store the same value in Heroku as `XERO_WEBHOOK_KEY` (see below).

---

## 2. Heroku config vars

Set these on the app that serves **https://dashboard.profitwise.app**:

```bash
# Base URL (used for redirect URI)
heroku config:set APP_URL=https://dashboard.profitwise.app --app profitwise-login-page

# Xero app credentials from developer.xero.com (never commit the secret)
heroku config:set XERO_CLIENT_ID="B5581EFEB8E84E9580A1C5B6D7349F3C" --app profitwise-login-page
heroku config:set XERO_CLIENT_SECRET="<your-client-secret>" --app profitwise-login-page

# Webhook signing key: use the same value you set as "Signing key" when creating the webhook in Xero
heroku config:set XERO_WEBHOOK_KEY="<your-webhook-signing-key>" --app profitwise-login-page
```

**Required:**

| Variable | Description |
|----------|-------------|
| `APP_URL` | Base URL of the app, e.g. `https://dashboard.profitwise.app`. |
| `XERO_CLIENT_ID` | Xero app Client ID from developer.xero.com. |
| `XERO_CLIENT_SECRET` | Xero app Client secret (you were shown once at creation). |
| `XERO_WEBHOOK_KEY` | Webhook signing key; must match the key you set in the Xero portal for your webhook. |

**Database:**  
Xero tokens are stored in the `xero_tokens` table. Ensure `DATABASE_URL` is set (e.g. Heroku Postgres). The app creates `xero_tokens` on first use.

After changing config:

```bash
heroku restart --app profitwise-login-page
```

---

## 3. Summary

| Purpose | URL |
|--------|-----|
| **Redirect URI** (OAuth callback) | `https://dashboard.profitwise.app/api/xero/oauth/callback` |
| **Webhook endpoint** | `https://dashboard.profitwise.app/api/xero/webhook` |

---

## 4. Flow

1. User clicks Xero on the “Connect your accounting institution” step → redirects to `/api/xero/oauth/authorize` → Xero login → callback to `/api/xero/oauth/callback` → tokens stored per tenant → redirect to `/onboarding`.
2. Xero sends webhooks to `/api/xero/webhook`. The app verifies the `x-xero-signature` header (HMAC-SHA256 with `XERO_WEBHOOK_KEY`) and returns 200 for valid payloads, 401 for invalid.
