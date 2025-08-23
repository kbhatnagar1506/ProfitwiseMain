import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { listRealmIdsByUserId } from "@/lib/quickbooks-token-store"
import { listTenantIdsByUserId } from "@/lib/xero-token-store"
import { getEntitiesFromDb as getQboEntities } from "@/lib/qbo-entity-store"
import { getEntitiesFromDb as getXeroEntities } from "@/lib/xero-entity-store"

export type InvoiceRow = {
  id: string
  number: string
  date: string | null
  total: number | null
  customer: string | null
  source: "qbo" | "xero"
}

/** GET /api/onboarding/invoices — returns invoices from GCP (and DB fallback) for the current user's QBO and Xero connections. */
export async function GET() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const realmIds = await listRealmIdsByUserId(user.id)
  const tenantIds = await listTenantIdsByUserId(user.id)

  const rows: InvoiceRow[] = []

  for (const realmId of realmIds) {
    const out = await getQboEntities(realmId, "Invoice", { userId: user.id })
    const list = (out.Invoice ?? []) as Record<string, unknown>[]
    for (const inv of list) {
      const id = typeof inv.Id === "string" ? inv.Id : inv.Id != null ? String(inv.Id) : ""
      const docNum = inv.DocNumber != null ? String(inv.DocNumber) : ""
      const txnDate = inv.TxnDate != null ? String(inv.TxnDate) : null
      const totalAmt = typeof inv.TotalAmt === "number" ? inv.TotalAmt : inv.TotalAmt != null ? Number(inv.TotalAmt) : null
      const customerRef = inv.CustomerRef as { name?: string } | undefined
      const customer = customerRef?.name != null ? String(customerRef.name) : null
      if (id) rows.push({ id, number: docNum, date: txnDate, total: totalAmt, customer, source: "qbo" })
    }
  }

  for (const tenantId of tenantIds) {
    const out = await getXeroEntities(tenantId, "Invoice", { userId: user.id })
    const list = (out.Invoice ?? []) as Record<string, unknown>[]
    for (const inv of list) {
      const id = inv.InvoiceID != null ? String(inv.InvoiceID) : inv.Id != null ? String(inv.Id) : ""
      const num = inv.InvoiceNumber != null ? String(inv.InvoiceNumber) : ""
      const d = inv.Date != null ? String(inv.Date) : null
      const total = typeof inv.Total === "number" ? inv.Total : inv.Total != null ? Number(inv.Total) : null
      const contact = inv.Contact as { Name?: string } | undefined
      const customer = contact?.Name != null ? String(contact.Name) : null
      if (id) rows.push({ id, number: num, date: d, total, customer, source: "xero" })
    }
  }

  rows.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0
    const db = b.date ? new Date(b.date).getTime() : 0
    return db - da
  })

  return NextResponse.json({ invoices: rows })
}
