/**
 * Xero OAuth2 and API helpers. Uses env XERO_CLIENT_ID, XERO_CLIENT_SECRET, APP_URL.
 */

import { log } from "./logger"
import { getToken, setToken } from "./xero-token-store"

const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize"
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token"
const XERO_CONNECTIONS_URL = "https://api.xero.com/Connections"
const XERO_API_BASE = "https://api.xero.com/api.xro/2.0"

const XERO_SCOPES = "openid profile email accounting.transactions offline_access"
const TOKEN_BUFFER_MS = 60 * 1000

function getConfig() {
  const clientId = process.env.XERO_CLIENT_ID
  const clientSecret = process.env.XERO_CLIENT_SECRET
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  const redirectUri = appUrl ? `${appUrl.replace(/\/$/, "")}/api/xero/oauth/callback` : undefined
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Xero not configured: XERO_CLIENT_ID, XERO_CLIENT_SECRET, APP_URL required")
  }
  return { clientId, clientSecret, redirectUri }
}

export function getAuthUrl(state: string): string {
  const { clientId, redirectUri } = getConfig()
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: XERO_SCOPES,
    state,
  })
  return `${XERO_AUTH_URL}?${params.toString()}`
}

export async function exchangeCodeForTokens(code: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const { clientId, clientSecret, redirectUri } = getConfig()
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
  })
  if (!res.ok) {
    log("oauth.token_exchange.failed", { status: res.status }, "xero")
    throw new Error(`Xero token exchange failed: ${res.status}`)
  }
  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : 1800,
  }
}

export async function getConnections(accessToken: string): Promise<Array<{ tenantId: string; tenantName: string }>> {
  const res = await fetch(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    log("connections.fetch.failed", { status: res.status }, "xero")
    throw new Error("Xero connections failed")
  }
  const data = (await res.json()) as Array<{ tenantId: string; tenantName: string }>
  return data
}

export async function exchangeCodeAndStore(code: string, userId?: string): Promise<void> {
  const { accessToken, refreshToken, expiresIn } = await exchangeCodeForTokens(code)
  const connections = await getConnections(accessToken)
  const expiresAt = Date.now() + expiresIn * 1000
  for (const conn of connections) {
    await setToken(
      conn.tenantId,
      { refreshToken, accessToken, expiresAt },
      userId ? { userId, tenantName: conn.tenantName } : undefined
    )
  }
  log("oauth.token_store.succeeded", { tenantCount: connections.length }, "xero")
}

export function isXeroConfigured(): boolean {
  return !!(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET)
}

export async function getValidAccessToken(tenantId: string): Promise<string> {
  const stored = await getToken(tenantId)
  if (!stored) throw new Error(`No token for tenant ${tenantId}`)
  const now = Date.now()
  if (stored.accessToken && stored.expiresAt != null && stored.expiresAt > now + TOKEN_BUFFER_MS) {
    return stored.accessToken
  }
  const { clientId, clientSecret } = getConfig()
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    }).toString(),
  })
  if (!res.ok) {
    log("oauth.token_refresh.failed", { tenantId, status: res.status }, "xero")
    throw new Error(`Xero token refresh failed: ${res.status}`)
  }
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 1800
  const expiresAt = Date.now() + expiresIn * 1000
  await setToken(tenantId, {
    refreshToken: data.refresh_token ?? stored.refreshToken,
    accessToken: data.access_token,
    expiresAt,
  })
  return data.access_token
}

/** Fetch a list endpoint; returns the first key's array (e.g. Invoices, Contacts). */
export async function fetchXeroList<T>(
  accessToken: string,
  tenantId: string,
  path: string
): Promise<T[]> {
  const url = `${XERO_API_BASE}${path}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Xero-Tenant-Id": tenantId,
      Accept: "application/json",
    },
  })
  if (!res.ok) {
    if (res.status === 404) {
      log("xero.api.skipped", { tenantId, path, reason: "not_available" }, "xero")
      return []
    }
    log("xero.api.fetch.failed", { tenantId, path, status: res.status }, "xero")
    throw new Error(`Xero API ${path} failed: ${res.status}`)
  }
  const json = (await res.json()) as Record<string, T[]>
  const key = Object.keys(json).find((k) => Array.isArray(json[k]))
  const list = key ? json[key] : []
  return Array.isArray(list) ? list : []
}

export const XERO_ENTITY_PATHS = [
  { type: "Invoice", path: "/Invoices" },
  { type: "Contact", path: "/Contacts" },
  { type: "Account", path: "/Accounts" },
  { type: "Payment", path: "/Payments" },
  { type: "CreditNote", path: "/CreditNotes" },
  { type: "BankTransaction", path: "/BankTransactions" },
  { type: "ManualJournal", path: "/ManualJournals" },
  { type: "Bill", path: "/Bills" },
] as const
