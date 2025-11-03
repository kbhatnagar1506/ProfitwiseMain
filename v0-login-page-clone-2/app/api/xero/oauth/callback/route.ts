import { NextRequest, NextResponse } from "next/server"
import { log, error as logError } from "@/lib/logger"
import { cookies } from "next/headers"
import { exchangeCodeAndStore } from "@/lib/xero"
import { runXeroSyncForUser } from "@/lib/xero-sync"
import { convertAllXeroToMovements } from "@/lib/xero-movements"
import { autoResolveDuplicates } from "@/lib/cross-source-dedup"

async function handleCallback(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  let code = searchParams.get("code")
  let state = searchParams.get("state")
  let errorParam = searchParams.get("error")
  if (!code && request.method === "POST") {
    try {
      const body = await request.formData()
      code = body.get("code")?.toString() ?? searchParams.get("code")
      state = body.get("state")?.toString() ?? searchParams.get("state")
      errorParam = errorParam ?? body.get("error")?.toString() ?? null
    } catch {
      // keep from URL
    }
  }
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "")

  if (errorParam) {
    logError("oauth.callback.failed", new Error(errorParam), "xero")
    return NextResponse.redirect(new URL(`/onboarding?error=xero_${errorParam}`, base), 302)
  }

  if (!code) {
    logError("oauth.callback.failed", new Error("missing_code"), "xero")
    return NextResponse.redirect(new URL("/onboarding?error=xero_missing_params", base), 302)
  }

  const cookieStore = await cookies()
  const stateCookie = cookieStore.get("xero_oauth_state")?.value
  cookieStore.delete("xero_oauth_state")

  let userId: string | undefined
  if (stateCookie) {
    try {
      const parsed = JSON.parse(stateCookie) as { state?: string; userId?: string }
      if (parsed.state && state !== parsed.state) {
        logError("oauth.callback.failed", new Error("state_mismatch"), "xero")
        return NextResponse.redirect(new URL("/onboarding?error=xero_state_mismatch", base), 302)
      }
      userId = parsed.userId
    } catch {
      // legacy: cookie was plain state
      if (state !== stateCookie) {
        logError("oauth.callback.failed", new Error("state_mismatch"), "xero")
        return NextResponse.redirect(new URL("/onboarding?error=xero_state_mismatch", base), 302)
      }
    }
  }

  if (!userId) {
    logError("oauth.callback.failed", new Error("session_expired_no_user"), "xero")
    return NextResponse.redirect(new URL("/onboarding?error=session_expired", base), 302)
  }

  try {
    await exchangeCodeAndStore(code, userId)
    log("oauth.callback.succeeded", { hasState: !!state, hasUserId: !!userId }, "xero")

    // Run full Xero sync in background so invoices/contacts/etc. are pulled without user action
    void (async () => {
      try {
        await runXeroSyncForUser(userId)
        // Convert to movements after sync
        await convertAllXeroToMovements(userId)
        // Auto-resolve duplicates
        await autoResolveDuplicates(userId)
        log("xero.oauth.callback.sync_complete", { userId }, "xero")
      } catch (e) {
        logError("xero.oauth.callback.sync_failed", e, "xero")
      }
    })()
  } catch (err) {
    logError("oauth.callback.failed", err, "xero")
    return NextResponse.redirect(new URL("/onboarding?error=xero_token_exchange", base), 302)
  }

  return NextResponse.redirect(new URL("/onboarding", base), 302)
}

export async function GET(request: NextRequest) {
  return handleCallback(request)
}

export async function POST(request: NextRequest) {
  return handleCallback(request)
}
