import { NextRequest, NextResponse } from "next/server"
import IntuitOAuth from "intuit-oauth"
import { getToken, setToken } from "@/lib/quickbooks-token-store"
import { log, error as logError } from "@/lib/logger"
import { cookies } from "next/headers"
import { ensureQBOSchema, query } from "@/lib/db"
import { getAllForEntity, ENTITY_TYPES, type QBOEntityType } from "@/lib/quickbooks"
import { upsertEntities } from "@/lib/qbo-entity-store"

const STATE_COOKIE = "qbo_oauth_state"

function redirectBase(): string {
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) return appUrl.replace(/\/$/, "")
  return ""
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get("code")
  const realmId = searchParams.get("realmId") ?? ""
  const state = searchParams.get("state")
  const base = redirectBase() || new URL(request.url).origin

  log("oauth.callback.received", { realmId, hasCode: !!code })

  if (!code || !realmId) {
    logError("oauth.callback.failed", new Error("missing_params"))
    return NextResponse.redirect(new URL("/onboarding?error=missing_params", base), 302)
  }

  const cookieStore = await cookies()
  const stateCookie = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)

  let userId: string | undefined
  if (stateCookie) {
    try {
      const parsed = JSON.parse(stateCookie) as { state?: string; userId?: string }
      if (parsed.state && state !== parsed.state) {
        logError("oauth.callback.failed", new Error("state_mismatch"))
        return NextResponse.redirect(new URL("/onboarding?error=state_mismatch", base), 302)
      }
      userId = parsed.userId
    } catch {
      if (state !== stateCookie) {
        logError("oauth.callback.failed", new Error("state_mismatch"))
        return NextResponse.redirect(new URL("/onboarding?error=state_mismatch", base), 302)
      }
    }
  }

  if (!userId) {
    logError("oauth.callback.failed", new Error("session_expired_no_user"))
    return NextResponse.redirect(new URL("/onboarding?error=session_expired", base), 302)
  }

  const clientId = process.env.QUICKBOOKS_CLIENT_ID
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  const redirectUri = appUrl ? `${appUrl.replace(/\/$/, "")}/api/quickbooks/oauth/callback` : undefined

  if (!clientId || !clientSecret || !redirectUri) {
    logError("oauth.callback.failed", new Error("not_configured"))
    return NextResponse.redirect(new URL("/onboarding?error=config", base), 302)
  }

  const OAuthClient = "default" in IntuitOAuth ? (IntuitOAuth as { default: new (c: object) => { createToken: (u: string) => Promise<{ getToken: () => { refresh_token: string; access_token: string; expires_in: number } }> } }).default : IntuitOAuth
  const oauthClient = new OAuthClient({
    clientId,
    clientSecret,
    redirectUri,
    environment: process.env.QUICKBOOKS_SANDBOX === "true" ? "sandbox" : "production",
  })

  const callbackUrl = `${base}/api/quickbooks/oauth/callback${new URL(request.url).search}`
  try {
    const authResponse = await oauthClient.createToken(callbackUrl)
    const token = authResponse.getToken()
    const expiresIn = typeof token.expires_in === "number" ? token.expires_in : parseInt(String(token.expires_in), 10) || 3600
    await setToken(
      realmId,
      {
        refreshToken: token.refresh_token,
        accessToken: token.access_token,
        expiresAt: Date.now() + expiresIn * 1000,
      },
      userId ? { userId } : undefined
    )
    log("oauth.callback.succeeded", { realmId })

    // Kick off a full QBO sync for this realm in the background so the user has data immediately.
    void (async () => {
      try {
        await ensureQBOSchema()
        await query(
          `INSERT INTO qbo_sync_status (realm_id, status, updated_at) VALUES ($1, 'syncing', NOW())
           ON CONFLICT (realm_id) DO UPDATE SET status = 'syncing', updated_at = NOW()`,
          [realmId]
        )
        log("qbo.sync.started", { realmId, source: "oauth_callback" }, "qbo")
        const synced: Record<string, number> = {}
        for (const type of ENTITY_TYPES) {
          const items = await getAllForEntity(realmId, type as QBOEntityType)
          const count = await upsertEntities(realmId, type, items, { userId })
          synced[type] = count
        }
        const total = Object.values(synced).reduce((s, n) => s + n, 0)
        await query(
          `INSERT INTO qbo_sync_status (realm_id, last_full_sync_at, status, error_message, updated_at)
           VALUES ($1, NOW(), 'success', NULL, NOW())
           ON CONFLICT (realm_id) DO UPDATE SET last_full_sync_at = NOW(), status = 'success', error_message = NULL, updated_at = NOW()`,
          [realmId]
        )
        log("qbo.sync.succeeded", { realmId, total, source: "oauth_callback" }, "qbo")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log("qbo.sync.failed", { realmId, error: message, source: "oauth_callback" }, "qbo")
        try {
          await ensureQBOSchema()
          await query(
            `INSERT INTO qbo_sync_status (realm_id, status, error_message, updated_at) VALUES ($1, 'error', $2, NOW())
             ON CONFLICT (realm_id) DO UPDATE SET status = 'error', error_message = $2, updated_at = NOW()`,
            [realmId, message]
          )
        } catch {
          // ignore status update failure
        }
      }
    })()
  } catch (err) {
    logError("oauth.callback.failed", err)
    return NextResponse.redirect(new URL("/onboarding?error=token_exchange", base), 302)
  }

  return NextResponse.redirect(new URL("/onboarding", base), 302)
}
