import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { listRealmIdsByUserId } from "@/lib/quickbooks-token-store"
import { listTenantIdsByUserId } from "@/lib/xero-token-store"
import { listStripeAccountIdsByUserId } from "@/lib/stripe-token-store"
import { getEntitiesFromDb as getQboEntities } from "@/lib/qbo-entity-store"
import { getEntitiesFromDb as getXeroEntities } from "@/lib/xero-entity-store"
import { getStripeEntitiesFromDb } from "@/lib/stripe-entity-store"
import { getUnifiedInvoices, backfillUnifiedInvoicesForUser } from "@/lib/unified-invoices"

export type InvoiceRow = {
  unique_id: string
  id: string
  number: string
  date: string | null
  total: number | null
  customer: string | null
  email: string | null
  source: "qbo" | "xero" | "stripe"
  amount_paid: number | null
  amount_due: number | null
  status: string | null
  paid: boolean
  updated_at: string | null
}

/** GET /api/onboarding/invoices — returns unified invoices from Postgres (QBO + Xero + Stripe). */
export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let rows = await getUnifiedInvoices(user.id)
  const hasConnections =
    (await listRealmIdsByUserId(user.id)).length > 0 ||
    (await listTenantIdsByUserId(user.id)).length > 0 ||
    (await listStripeAccountIdsByUserId(user.id)).length > 0

  if (rows.length === 0 && hasConnections) {
    await backfillUnifiedInvoicesForUser(user.id, {
      realmIds: await listRealmIdsByUserId(user.id),
      tenantIds: await listTenantIdsByUserId(user.id),
      stripeAccountIds: await listStripeAccountIdsByUserId(user.id),
      getQboInvoices: async (realmId) => {
        const out = await getQboEntities(realmId, "Invoice", { userId: user.id })
        return (out.Invoice ?? []) as unknown[]
      },
      getXeroInvoices: async (tenantId) => {
        const out = await getXeroEntities(tenantId, "Invoice", { userId: user.id })
        return (out.Invoice ?? []) as unknown[]
      },
      getStripeInvoices: async (stripeAccountId) => {
        const out = await getStripeEntitiesFromDb(stripeAccountId, "invoice", { userId: user.id })
        return (out.invoice ?? []) as unknown[]
      },
    })
    rows = await getUnifiedInvoices(user.id)
  }

  const invoices: InvoiceRow[] = rows.map((r) => {
    const amount_due = r.amount_due ?? null
    const amount_paid = r.amount_paid ?? null
    const status = r.status ?? null
    const paid =
      (amount_due != null && amount_due === 0) ||
      (status != null && String(status).toLowerCase() === "paid") ||
      (amount_paid != null && r.total != null && amount_paid >= r.total)
    return {
      unique_id: r.unique_id,
      id: r.id,
      number: r.invoice_number ?? "",
      date: r.invoice_date ?? null,
      total: r.total ?? null,
      customer: r.customer_name ?? null,
      email: r.email ?? null,
      source: r.source as "qbo" | "xero" | "stripe",
      amount_paid,
      amount_due,
      status,
      paid,
      updated_at: r.updated_at ?? null,
    }
  })

  return NextResponse.json({ invoices })
}
