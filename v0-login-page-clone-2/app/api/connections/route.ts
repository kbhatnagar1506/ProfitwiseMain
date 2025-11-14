import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { listRealmIdsByUserId } from "@/lib/quickbooks-token-store"
import { listTenantIdsByUserId } from "@/lib/xero-token-store"
import { listStripeAccountIdsByUserId } from "@/lib/stripe-token-store"
import { listShopDomainsByUserId } from "@/lib/shopify-token-store"

/** GET /api/connections — returns which accounting integrations are connected and their IDs (for triggering sync). */

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const connected: string[] = []
  let realmIds: string[] = []
  let tenantIds: string[] = []
  let stripeAccountIds: string[] = []
  let shopifyShops: string[] = []
  try {
    const [xeroTenants, qboRealms, stripeAccounts, shops] = await Promise.all([
      listTenantIdsByUserId(user.id),
      listRealmIdsByUserId(user.id),
      listStripeAccountIdsByUserId(user.id),
      listShopDomainsByUserId(user.id),
    ])
    tenantIds = xeroTenants
    realmIds = qboRealms
    stripeAccountIds = stripeAccounts
    shopifyShops = shops
    if (xeroTenants.length > 0) connected.push("Xero")
    if (qboRealms.length > 0) connected.push("QuickBooks Online")
    if (stripeAccounts.length > 0) connected.push("Stripe")
    if (shops.length > 0) connected.push("Shopify")
  } catch {
    // return whatever we have
  }

  return NextResponse.json({ connected, realmIds, tenantIds, stripeAccountIds, shopifyShops })
}
