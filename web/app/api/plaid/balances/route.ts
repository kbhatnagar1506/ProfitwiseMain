import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { log } from "@/lib/logger"
import { getAccounts } from "@/lib/plaid"
import { getAccountsWithBalancesByUserId, saveAccounts } from "@/lib/plaid-persistence"
import { getPlaidItem, listPlaidItemIds } from "@/lib/plaid-item-store"

export async function GET(request: NextRequest) {
  const token = request.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    log("plaid.balances.unauthorized", { reason: "no_session" }, "plaid")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const refresh = request.nextUrl.searchParams.get("refresh") === "1"
  if (refresh) {
    const itemIds = await listPlaidItemIds(user.id)
    for (const itemId of itemIds) {
      const item = await getPlaidItem(itemId)
      if (item) {
        try {
          const accounts = await getAccounts(item.access_token)
          await saveAccounts(itemId, accounts)
        } catch {
          // skip failed item
        }
      }
    }
  }

  const accounts = await getAccountsWithBalancesByUserId(user.id)
  return NextResponse.json({
    accounts: accounts.map((a) => ({
      item_id: a.item_id,
      account_id: a.account_id,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      mask: a.mask,
      current_balance: a.current_balance,
      available_balance: a.available_balance,
      currency_code: a.currency_code,
    })),
  })
}
