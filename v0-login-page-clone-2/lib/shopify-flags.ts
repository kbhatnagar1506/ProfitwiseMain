function envFlag(name: string, defaultValue = true): boolean {
  const raw = process.env[name]
  if (raw == null) return defaultValue
  return raw === "1" || raw.toLowerCase() === "true"
}

export function isShopifyOAuthEnabled(): boolean {
  return envFlag("SHOPIFY_OAUTH_ENABLED", true)
}

export function isShopifyWebhookIntakeEnabled(): boolean {
  return envFlag("SHOPIFY_WEBHOOK_INTAKE_ENABLED", true)
}

export function isShopifySyncWorkerEnabled(): boolean {
  return envFlag("SHOPIFY_SYNC_WORKER_ENABLED", true)
}
