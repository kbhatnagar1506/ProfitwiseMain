# Slack connector setup

## Heroku / env vars

Set these in Heroku (Settings → Config Vars); never commit secrets.

| Variable | Description |
|----------|-------------|
| `SLACK_CLIENT_ID` | From Slack API app → Basic Information → App Credentials |
| `SLACK_CLIENT_SECRET` | Same page |
| `SLACK_SIGNING_SECRET` | Same page — used to verify requests from Slack |
| `SLACK_BOT_TOKEN` | From OAuth & Permissions after **Install App** (starts with `xoxb-`). Optional if every user connects via OAuth (we store per-user token); set it for the fallback “connect in dashboard” reply. |

## Slack app configuration

1. **OAuth & Permissions**
   - Redirect URL: `https://dashboard.profitwise.app/api/slack/oauth/callback`
   - Bot Token Scopes: `chat:write`, `im:read`, `im:write`, `im:history`

2. **Event Subscriptions**
   - Enable Events: On
   - Request URL: `https://dashboard.profitwise.app/api/slack/events`
   - Subscribe to bot events: `message.im`

3. **Install App** to your workspace and copy the Bot User OAuth Token into `SLACK_BOT_TOKEN` (optional; used when the message is from an unlinked user so we can still reply “connect in dashboard”).

## Flow

- User clicks Slack on Communication Channels (step 5) → redirects to `/api/slack/oauth/authorize` → Slack OAuth → callback stores `(user_id, slack_user_id, slack_team_id, bot_token)`.
- When the user DMs the bot in Slack, we look up by `slack_user_id` + `slack_team_id`, then reply with the same AI context as WhatsApp (company, Supermemory, transactions, balances).
