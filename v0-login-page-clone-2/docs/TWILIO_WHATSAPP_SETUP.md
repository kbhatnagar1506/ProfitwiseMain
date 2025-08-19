# Twilio WhatsApp setup

## Heroku / env vars

Set these in Heroku (Dashboard → App → Settings → Config Vars); **never commit secrets**.

**Required (all four):** `TWILIO_ACCOUNT_SID` (starts with `AC`), `TWILIO_API_KEY_SID` (starts with `SK`), `TWILIO_API_KEY_SECRET`, `TWILIO_WHATSAPP_FROM` (e.g. `whatsapp:+12345678901`). Or use `TWILIO_AUTH_TOKEN` instead of the two API Key vars.

| Variable | Description |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Main account SID (starts with `AC`). From Twilio Console → Account. |
| `TWILIO_WHATSAPP_FROM` | Your Twilio WhatsApp number, e.g. `whatsapp:+18772696161`. |
| **Auth (pick one):** | |
| `TWILIO_AUTH_TOKEN` | Main account Auth Token (for client + webhook signature validation). |
| **Or API Key:** | |
| `TWILIO_API_KEY_SID` | API Key SID (starts with `SK`). |
| `TWILIO_API_KEY_SECRET` | API Key Secret (shown once in Twilio Console; store securely). |

If you use API Key only, webhook signature validation is skipped unless you also set `TWILIO_AUTH_TOKEN` (recommended for production).

## Webhook URL (incoming messages)

1. Twilio Console → **Messaging** → **Try it out** → **Send a WhatsApp message** (or your WhatsApp sender).
2. Under **When a message comes in**, set:
   - **Webhook URL:** `https://dashboard.profitwise.app/api/twillo/webhook/whatsapp`
   - Method: **POST**.

Twilio will POST to this URL for each incoming WhatsApp message. The app can reply with an AI-generated message when `OPENAI_API_KEY` is set.

## Sending from the app

- **POST** `/api/twilio/send-whatsapp` (requires session cookie).
- Body: `{ "to": "whatsapp:+15551234567", "body": "Your message" }`.
