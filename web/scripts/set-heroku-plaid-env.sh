#!/usr/bin/env bash
# Set Plaid PRODUCTION keys and app env vars on Heroku for dashboard.profitwise.app
# Uses Client ID + Production secret from dashboard.plaid.com/developers/keys
# Usage: export PLAID_SECRET="your-production-secret"; ./scripts/set-heroku-plaid-env.sh

set -e
APP="${HEROKU_APP_NAME:-profitwise-login-page}"

echo "Setting config for Heroku app: $APP (Plaid production)"

heroku config:set APP_URL=https://dashboard.profitwise.app --app "$APP"
heroku config:set PLAID_CLIENT_ID=691d68e9b91788001eb997c8 --app "$APP"
heroku config:set PLAID_SECRET="${PLAID_SECRET:?Set PLAID_SECRET (e.g. export PLAID_SECRET=your-production-secret)}" --app "$APP"
# Production: do not set PLAID_ENV (or unset). For sandbox only: heroku config:set PLAID_ENV=sandbox --app "$APP"

echo "Done. Restarting app..."
heroku restart --app "$APP"
echo "Plaid env vars are set. Webhook URL: https://dashboard.profitwise.app/api/plaid/webhook"
