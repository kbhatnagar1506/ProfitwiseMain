import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { listStripeAccountIdsByUserId, getToken } from "@/lib/stripe-token-store"
import { upsertStripeEntities } from "@/lib/stripe-entity-store"

type StripeEntityType =
  | "customer"
  | "invoice"
  | "subscription"
  | "payment_intent"
  | "payout"
  | "balance_transaction"

const STRIPE_ENTITY_CONFIG: Record<StripeEntityType, { path: string }> = {
  customer: { path: "/v1/customers" },
  invoice: { path: "/v1/invoices" },
  subscription: { path: "/v1/subscriptions" },
  payment_intent: { path: "/v1/payment_intents" },
  payout: { path: "/v1/payouts" },
  balance_transaction: { path: "/v1/balance_transactions" },
}

async function fetchAllStripeList(
  accessToken: string,
  path: string
): Promise<unknown[]> {
  const baseUrl = "https://api.stripe.com"
  const out: unknown[] = []
  let startingAfter: string | undefined

  // Stripe max limit is 100; we use 100 to minimize requests.
  for (;;) {
    const params = new URLSearchParams({ limit: "100" })
    if (startingAfter) params.set("starting_after", startingAfter)
    const url = `${baseUrl}${path}?${params.toString()}`
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(
        `Stripe list call failed for ${path}: ${res.status} ${body.slice(0, 300)}`
      )
    }
    const json = (await res.json()) as { data?: unknown[]; has_more?: boolean }
    const data = json.data ?? []
    out.push(...data)
    if (!json.has_more || data.length === 0) break
    const last = data[data.length - 1] as { id?: string }
    if (!last?.id) break
    startingAfter = last.id
  }

  return out
}

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
    // ignore malformed body; fall back to defaults
  }

  const userAccountIds = await listStripeAccountIdsByUserId(user.id)
  if (userAccountIds.length === 0) {
    return NextResponse.json(
      { error: "No Stripe accounts connected for this user" },
      { status: 400 }
    )
  }

  if (requestedAccountId && !userAccountIds.includes(requestedAccountId)) {
    log(
      "stripe.sync.forbidden",
      { stripeAccountId: requestedAccountId, userId: user.id },
      "stripe"
    )
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const accountIdsToSync = requestedAccountId ? [requestedAccountId] : userAccountIds
  const entityTypesToSync: StripeEntityType[] =
    requestedTypes && requestedTypes.length > 0
      ? requestedTypes
      : [
          "customer",
          "invoice",
          "subscription",
          "payment_intent",
          "payout",
          "balance_transaction",
        ]

  log(
    "stripe.sync.started",
    {
      userId: user.id,
      accounts: accountIdsToSync,
      entityTypes: entityTypesToSync,
    },
    "stripe"
  )

  const results: Record<
    string,
    {
      entityType: StripeEntityType
      fetched: number
      upserted: number
      error?: string
    }[]
  > = {}

  for (const accountId of accountIdsToSync) {
    const tokenPayload = await getToken(accountId)
    if (!tokenPayload?.accessToken) {
      log(
        "stripe.sync.skipped_missing_token",
        { stripeAccountId: accountId, userId: user.id },
        "stripe"
      )
      continue
    }

    const perAccount: {
      entityType: StripeEntityType
      fetched: number
      upserted: number
      error?: string
    }[] = []

    for (const entityType of entityTypesToSync) {
      const cfg = STRIPE_ENTITY_CONFIG[entityType]
      try {
        const data = await fetchAllStripeList(tokenPayload.accessToken, cfg.path)
        const upserted = await upsertStripeEntities(accountId, entityType, data, {
          userId: user.id,
        })
        perAccount.push({
          entityType,
          fetched: data.length,
          upserted,
        })
        log(
          "stripe.sync.entity.succeeded",
          {
            stripeAccountId: accountId,
            entityType,
            fetched: data.length,
            upserted,
          },
          "stripe"
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        perAccount.push({
          entityType,
          fetched: 0,
          upserted: 0,
          error: message,
        })
        log(
          "stripe.sync.entity.failed",
          {
            stripeAccountId: accountId,
            entityType,
            error: message,
          },
          "stripe"
        )
      }
    }

    results[accountId] = perAccount
  }

  log(
    "stripe.sync.completed",
    {
      userId: user.id,
      accounts: Object.keys(results),
    },
    "stripe"
  )

  return NextResponse.json({ ok: true, results })
}

