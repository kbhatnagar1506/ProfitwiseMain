# Shopify Credential Key Rotation Runbook

This runbook rotates `SHOPIFY_CREDENTIALS_ENCRYPTION_KEY` used for encrypting Shopify access tokens.

## Preconditions

- Production DB backup is complete.
- `CLEAN_DB_SECRET` is available for admin endpoints.
- A new 32-byte key has been generated (hex or base64).

## Rotation Steps

1. Set both keys in environment:
   - `SHOPIFY_CREDENTIALS_ENCRYPTION_KEY_OLD`
   - `SHOPIFY_CREDENTIALS_ENCRYPTION_KEY_NEW`
2. Run a one-time re-encryption script/job:
   - Decrypt with old key.
   - Re-encrypt with new key.
   - Update `shopify_connections.access_token_encrypted`.
3. Validate by calling:
   - `GET /api/admin/shopify-health` with `x-clean-db-secret`.
4. Flip app runtime env to use:
   - `SHOPIFY_CREDENTIALS_ENCRYPTION_KEY=<new key>`
5. Remove old key from environment and secret manager.

## Failure Handling

- If re-encryption fails midway, restore from DB backup and rerun.
- Keep old key until verification succeeds.
- If any connection fails post-rotation, set status to `reauth_required` and request reconnect.
