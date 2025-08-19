# Shopify connector setup

## Heroku / env vars

| Variable | Description |
|----------|-------------|
| `SHOPIFY_CLIENT_ID` | App API key (Client ID) from Shopify Partner Dashboard. |
| `SHOPIFY_CLIENT_SECRET` | Client secret (e.g. `shpss_...`). Store securely; never commit. |
| `APP_URL` | Base URL of the app, e.g. `https://dashboard.profitwise.app` (used for OAuth redirect). |

Optional:

| Variable | Description |
|----------|-------------|
| `SHOPIFY_SCOPES` | Comma-separated scopes. Default: `read_orders,read_products,read_customers`. |

## Shopify Partner Dashboard

1. **App setup → URLs**
   - **Allowed redirection URL(s):**  
     `https://dashboard.profitwise.app/api/shopify/oauth/callback`  
     (or your production base URL + `/api/shopify/oauth/callback`.)

2. **API access**  
   Ensure the app has the scopes you need (e.g. read_orders, read_products, read_customers). Request more in the Dashboard if needed.

## Flow

1. User clicks **Shopify** on the “Connect your accounting institution” step → `/oauth/shopify`.
2. User enters store domain (e.g. `mystore` or `mystore.myshopify.com`) → redirect to `/api/shopify/oauth/authorize?shop=...`.
3. App redirects to Shopify consent → user approves → Shopify redirects to `/api/shopify/oauth/callback` with `code`.
4. App exchanges `code` for an access token and stores it in `shopify_connections` (per user + shop).
5. User is redirected back to `/onboarding`; Shopify appears as connected in the connections list.

## Webhooks (optional)

For orders or app uninstall events you can add HTTPS webhook routes (e.g. `POST /api/shopify/webhooks/orders-create`) and register them in the Partner Dashboard. For high volume, consider Google Cloud Pub/Sub as in Shopify’s docs.
