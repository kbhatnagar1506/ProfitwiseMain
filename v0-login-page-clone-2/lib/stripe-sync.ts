/**
 * Shared Stripe sync logic: pull invoices, customers, subscriptions, etc. into stripe_entities.
 * Used by POST /api/stripe/sync and by Stripe OAuth callback (background sync after connect).
 */

import { log } from "./logger"
import { listStripeAccountIdsByUserId, getToken } from "./stripe-token-store"
import { upsertStripeEntities } from "./stripe-entity-store"

export type StripeEntityType =
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

const DEFAULT_ENTITY_TYPES: StripeEntityType[] = [
  "customer",
  "invoice",
  "subscription",
  "payment_intent",
  "payout",
  "balance_transaction",
]

async function fetchAllStripeList(
  accessToken: string,
  path: string,
  expand?: string[]
): Promise<unknown[]> {
  const baseUrl = "https://api.stripe.com"
  const out: unknown[] = []
  let startingAfter: string | undefined
  for (;;) {
    const params = new URLSearchParams({ limit: "100" })
    if (startingAfter) params.set("starting_after", startingAfter)
    if (expand?.length) expand.forEach((e) => params.append("expand[]", e))
    const url = `${baseUrl}${path}?${params.toString()}`
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Stripe list failed ${path}: ${res.status} ${body.slice(0, 300)}`)
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

export type StripeSyncResult = Record<
  string,
  { entityType: StripeEntityType; fetched: number; upserted: number; error?: string }[]
>

export type RunStripeSyncOptions = {
  accountIds?: string[] | null
  entityTypes?: StripeEntityType[] | null
}

/**
 * Run full Stripe sync for a user: fetch all configured entity types for each connected account
 * and upsert into stripe_entities. Returns results per account.
 */
export async function runStripeSyncForUser(
  userId: string,
  options: RunStripeSyncOptions = {}
): Promise<{ ok: boolean; results: StripeSyncResult }> {
  const userAccountIds = await listStripeAccountIdsByUserId(userId)
  if (userAccountIds.length === 0) {
    return { ok: false, results: {} }
  }

  const accountIdsToSync = options.accountIds?.length
    ? options.accountIds.filter((id) => userAccountIds.includes(id))
    : userAccountIds
  const entityTypesToSync =
    (options.entityTypes?.length ?? 0) > 0
      ? (options.entityTypes as StripeEntityType[])
      : DEFAULT_ENTITY_TYPES

  log(
    "stripe.sync.started",
    { userId, accounts: accountIdsToSync, entityTypes: entityTypesToSync },
    "stripe"
  )

  const results: StripeSyncResult = {}

  for (const accountId of accountIdsToSync) {
    const tokenPayload = await getToken(accountId)
    if (!tokenPayload?.accessToken) {
      log("stripe.sync.skipped_missing_token", { stripeAccountId: accountId, userId }, "stripe")
      continue
    }

    const perAccount: { entityType: StripeEntityType; fetched: number; upserted: number; error?: string }[] = []

    for (const entityType of entityTypesToSync) {
      const cfg = STRIPE_ENTITY_CONFIG[entityType]
      try {
        const expand = entityType === "payout" ? ["data.balance_transaction"] : undefined
        let data = await fetchAllStripeList(tokenPayload.accessToken, cfg.path, expand)
        if (entityType === "payout" && Array.isArray(data)) {
          data = data.map((p) => {
            const payout = p as Record<string, unknown>
            const bt = payout.balance_transaction
            if (bt && typeof bt === "object" && "fee" in bt && typeof (bt as { fee?: number }).fee === "number") {
              return { ...payout, fee: (bt as { fee: number }).fee }
            }
            return payout
          })
        }
        const upserted = await upsertStripeEntities(accountId, entityType, data, { userId })
        perAccount.push({ entityType, fetched: data.length, upserted })
        log(
          "stripe.sync.entity.succeeded",
          { stripeAccountId: accountId, entityType, fetched: data.length, upserted },
          "stripe"
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        perAccount.push({ entityType, fetched: 0, upserted: 0, error: message })
        log("stripe.sync.entity.failed", { stripeAccountId: accountId, entityType, error: message }, "stripe")
      }
    }

    results[accountId] = perAccount
  }

  log("stripe.sync.completed", { userId, accounts: Object.keys(results) }, "stripe")
  return { ok: true, results }
}
