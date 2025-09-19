# Gmail OAuth

Connect a Google Workspace mailbox so you can read emails (e.g. for invoice extraction) via the Gmail API.

## Production (Heroku)

Use the in-app flow so tokens are stored on the server:

1. In Google Cloud Console, create OAuth client (Web application) and add **Authorized redirect URI**:  
   `https://dashboard.profitwise.app/api/gmail/oauth/callback`
2. Set Heroku config: `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`. Optionally set `GMAIL_ADMIN_EMAIL` (e.g. `krishna@profitwise.app`) so only that user can connect or reconnect the single system inbox; others will see "Inbox connection is managed by admin."
3. In the app, go to Gmail setup (`/oauth/gmail`) and click **Connect inbox** (only if you are the admin). Sign in with the Workspace email that receives forwards; tokens are saved in the production DB once.

---

## Terminal (local script)

## 1. Google Cloud Console

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select your project (or create one).
2. **Enable Gmail API**: APIs & Services → Library → search “Gmail API” → Enable.
3. **Create OAuth credentials**: APIs & Services → Credentials → Create Credentials → OAuth client ID.
   - If prompted, configure the OAuth consent screen (Internal is fine for Workspace).
   - Application type: **Desktop app** (or **Web application** if you prefer).
   - For Web application, add **Authorized redirect URI**: `http://localhost:3232/callback`.
   - Copy the **Client ID** and **Client secret** (you need the secret for the script; the API key is separate and not used for this OAuth flow).

## 2. Run the script

From the repo root (or from `v0-login-page-clone-2`):

```bash
cd v0-login-page-clone-2

GMAIL_OAUTH_CLIENT_ID="252652300630-j91n5kui0pdgnilvgt3t22bhtkeg6tns.apps.googleusercontent.com" \
GMAIL_OAUTH_CLIENT_SECRET="your-client-secret-from-console" \
node scripts/gmail-oauth-cli.mjs
```

- A browser window opens; sign in with the **Workspace email** you want to use for extraction.
- After consent, tokens are written to `scripts/gmail-tokens.json` (do not commit this file).

## 3. Use the tokens

- `gmail-tokens.json` contains `access_token`, `refresh_token`, `expiry_date`, and optionally `email`.
- Use the **refresh_token** in your server to get new access tokens and call the Gmail API (e.g. list messages, get body/attachments for invoice extraction).
- You can store the refresh token in your DB or env and use it from a backend job or webhook handler.

## Optional: custom output path

```bash
GMAIL_OAUTH_CLIENT_ID=... GMAIL_OAUTH_CLIENT_SECRET=... \
node scripts/gmail-oauth-cli.mjs --out=./my-tokens.json
```
