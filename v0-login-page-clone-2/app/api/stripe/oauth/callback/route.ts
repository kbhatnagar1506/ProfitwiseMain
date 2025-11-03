import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { log, error as logError } from "@/lib/logger"
import { exchangeCodeForTokens } from "@/lib/stripe"
import { setToken } from "@/lib/stripe-token-store"
import { runStripeSyncForUser } from "@/lib/stripe-sync"
import { convertAllStripeToMovements } from "@/lib/stripe-movements"
import { autoResolveDuplicates } from "@/lib/cross-source-dedup"

const STATE_COOKIE = "stripe_oauth_state"

function redirectBase(request: NextRequest): string {
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) return appUrl.replace(/\/$/, "")
  return request.nextUrl.origin
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const errorParam = searchParams.get("error")
  const base = redirectBase(request)

  if (errorParam) {
    logError("stripe.oauth.callback.failed", new Error(errorParam), "stripe")
    return NextResponse.redirect(new URL(`/onboarding?error=stripe_${errorParam}`, base), 302)
  }

  if (!code) {
    logError("stripe.oauth.callback.failed", new Error("missing_code"), "stripe")
    return NextResponse.redirect(new URL("/onboarding?error=stripe_missing_code", base), 302)
  }

  const cookieStore = await cookies()
  const stateCookie = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)

  let userId: string | undefined
  if (stateCookie) {
    try {
      const parsed = JSON.parse(stateCookie) as { state?: string; userId?: string }
      if (parsed.state && state !== parsed.state) {
        logError("stripe.oauth.callback.failed", new Error("state_mismatch"), "stripe")
        return NextResponse.redirect(new URL("/onboarding?error=stripe_state_mismatch", base), 302)
      }
      userId = parsed.userId
    } catch {
      if (state && stateCookie && state !== stateCookie) {
        logError("stripe.oauth.callback.failed", new Error("state_mismatch"), "stripe")
        return NextResponse.redirect(new URL("/onboarding?error=stripe_state_mismatch", base), 302)
      }
    }
  }

  if (!userId) {
    logError("stripe.oauth.callback.failed", new Error("session_expired_no_user"), "stripe")
    return NextResponse.redirect(new URL("/onboarding?error=session_expired", base), 302)
  }

  try {
    const { accessToken, refreshToken, scope, stripeUserId } = await exchangeCodeForTokens(code)
    await setToken(
      stripeUserId,
      { accessToken, refreshToken, scope },
      { userId }
    )
    log("stripe.oauth.callback.succeeded", { stripeUserId, hasScope: !!scope }, "stripe")

    // Run full Stripe sync in background so invoices/customers/etc. are pulled without user action
    void (async () => {
      try {
        await runStripeSyncForUser(userId)
        // Convert to movements after sync
        await convertAllStripeToMovements(userId)
        // Auto-resolve duplicates
        await autoResolveDuplicates(userId)
        log("stripe.oauth.callback.sync_complete", { userId }, "stripe")
      } catch (e) {
        logError("stripe.oauth.callback.sync_failed", e, "stripe")
      }
    })()
  } catch (err) {
    logError("stripe.oauth.callback.failed", err, "stripe")
    return NextResponse.redirect(new URL("/onboarding?error=stripe_token_exchange", base), 302)
  }

  return NextResponse.redirect(new URL("/onboarding", base), 302)
}

