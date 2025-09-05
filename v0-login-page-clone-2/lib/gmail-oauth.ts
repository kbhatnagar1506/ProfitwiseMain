/**
 * Gmail OAuth for production: authorize URL and token exchange.
 * Env: GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET. Redirect URI must be
 * APP_URL + /api/gmail/oauth/callback (add in Google Cloud Console).
 */

import { ensureGmailSchema, query } from "./db"
import { log } from "./logger"

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ")

export function getGmailOAuthConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export function buildGmailAuthUrl(redirectUri: string, state: string): string {
  const config = getGmailOAuthConfig()
  if (!config) throw new Error("Gmail OAuth not configured")
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export async function exchangeGmailCode(
  code: string,
  redirectUri: string
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; error?: string }> {
  const config = getGmailOAuthConfig()
  if (!config) throw new Error("Gmail OAuth not configured")
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }).toString()
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (data.error) {
    log("gmail.oauth.token_error", { error: data.error, description: data.error_description }, "gmail")
    return { access_token: "", error: data.error }
  }
  return {
    access_token: data.access_token ?? "",
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  }
}

export async function saveGmailConnection(
  connectionId: string,
  refreshToken: string,
  accessToken: string,
  expiresIn: number | undefined,
  email: string | null
): Promise<void> {
  await ensureGmailSchema()
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null
  await query(
    `INSERT INTO gmail_connections (id, email, refresh_token, access_token, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       refresh_token = EXCLUDED.refresh_token,
       access_token = EXCLUDED.access_token,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [connectionId, email, refreshToken, accessToken, expiresAt]
  )
  log("gmail.oauth.connection_saved", { connectionId, email }, "gmail")
}

export async function getGmailConnection(connectionId: string): Promise<{
  email: string | null
  refresh_token: string
  access_token: string | null
  expires_at: string | null
} | null> {
  await ensureGmailSchema()
  const { rows } = await query<{
    email: string | null
    refresh_token: string
    access_token: string | null
    expires_at: string | null
  }>("SELECT email, refresh_token, access_token, expires_at FROM gmail_connections WHERE id = $1", [connectionId])
  return rows[0] ?? null
}

/** Refresh access token using refresh_token; updates DB and returns new access_token. */
export async function refreshGmailAccessToken(connectionId: string): Promise<string> {
  const config = getGmailOAuthConfig()
  if (!config) throw new Error("Gmail OAuth not configured")
  const conn = await getGmailConnection(connectionId)
  if (!conn?.refresh_token) throw new Error("No Gmail connection or refresh token")
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: conn.refresh_token,
    grant_type: "refresh_token",
  }).toString()
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  const data = (await res.json()) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (data.error) {
    log("gmail.oauth.refresh_error", { error: data.error, description: data.error_description }, "gmail")
    throw new Error(data.error_description ?? data.error)
  }
  const accessToken = data.access_token ?? ""
  const expiresIn = data.expires_in ?? 3600
  const expiresAt = new Date(Date.now() + expiresIn * 1000)
  await query(
    `UPDATE gmail_connections SET access_token = $1, expires_at = $2, updated_at = NOW() WHERE id = $3`,
    [accessToken, expiresAt, connectionId]
  )
  log("gmail.oauth.token_refreshed", { connectionId }, "gmail")
  return accessToken
}

/** Returns a valid access token for Gmail API; refreshes if expired or missing. */
export async function getValidGmailAccessToken(connectionId: string = "inbox"): Promise<string> {
  const conn = await getGmailConnection(connectionId)
  if (!conn) throw new Error("No Gmail connection")
  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0
  const bufferSeconds = 60
  if (conn.access_token && expiresAt > Date.now() + bufferSeconds * 1000) {
    return conn.access_token
  }
  return refreshGmailAccessToken(connectionId)
}
