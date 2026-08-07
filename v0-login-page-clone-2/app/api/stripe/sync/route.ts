import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { runStripeSyncForUser, type StripeEntityType } from "@/lib/stripe-sync"
import { convertAllStripeToMovements, convertStripeToMovements } from "@/lib/stripe-movements"
import { autoResolveDuplicates } from "@/lib/cross-source-dedup"

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("stripe.sync.unauthorized", { reason: "no_session" }, "stripe")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let requestedAccountId: string | null = null
  let requestedTypes: StripeEntityType[] | null = null
  try {
    const body = await request.json().catch(() => ({}))
    if (body && typeof body === "object") {
      const accountId =
        (body as { stripeAccountId?: string }).stripeAccountId ??
        (body as { accountId?: string }).accountId
      if (typeof accountId === "string" && accountId.trim()) {
        requestedAccountId = accountId.trim()
      }
      const types = (body as { entityTypes?: string[] }).entityTypes
      if (Array.isArray(types) && types.length > 0) {
        requestedTypes = types
          .map((t) => t.trim())
          .filter((t): t is StripeEntityType =>
            [
              "customer",
              "invoice",
              "subscription",
              "payment_intent",
              "payout",
              "balance_transaction",
            ].includes(t as StripeEntityType)
          )
      }
    }
  } catch {
    // ignore
  }

  try {
    const accountIds = requestedAccountId ? [requestedAccountId] : null
    const { ok, results } = await runStripeSyncForUser(user.id, {
      accountIds: accountIds ?? undefined,
      entityTypes: requestedTypes ?? undefined,
    })

    if (!ok) {
      return NextResponse.json(
        { error: "No Stripe accounts connected for this user" },
        { status: 400 }
      )
    }

    // Convert Stripe entities to movements
    let movementStats
    if (requestedAccountId) {
      movementStats = await convertStripeToMovements(user.id, requestedAccountId)
    } else {
      movementStats = await convertAllStripeToMovements(user.id)
    }

    // Auto-resolve duplicates between Stripe and other sources
    let dedupStats = { resolved: 0, candidates: 0 }
    try {
      dedupStats = await autoResolveDuplicates(user.id)
      log("stripe.sync.dedup", { userId: user.id, ...dedupStats }, "stripe")
    } catch (dedupErr) {
      log("stripe.sync.dedup.error", { userId: user.id, error: String(dedupErr) }, "stripe")
    }

    return NextResponse.json({ ok: true, results, movements: movementStats, deduplication: dedupStats })
  } catch (err) {
    log("stripe.sync.error", { userId: user.id, error: String(err) }, "stripe")
    return NextResponse.json({ error: "Stripe sync failed" }, { status: 500 })
  }
}
