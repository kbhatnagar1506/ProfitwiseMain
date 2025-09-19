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
