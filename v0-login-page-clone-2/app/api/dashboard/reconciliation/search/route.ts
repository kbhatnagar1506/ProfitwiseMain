import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"

export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(request.url)
  const searchQuery = url.searchParams.get("q") || ""
  const type = url.searchParams.get("type") || "ar" // "ar" or "ap"
  const limit = parseInt(url.searchParams.get("limit") || "20")

  if (type !== "ar" && type !== "ap") {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 })
  }

  try {
    if (type === "ar") {
      // Search open invoices
      const { rows } = await query<{
        id: string
        entity_name: string
        amount: string
        amount_due: string
        due_date: string
        status: string
        reconciliation_status: string
        matched_amount: string | null
      }>(
        `SELECT 
           i.invoice_id AS id,
           i.customer_name AS entity_name,
           i.amount::text,
           i.amount_due::text,
           i.due_date::text,
           i.status,
           i.reconciliation_status,
           COALESCE(SUM(a.net_amount::float)::text, NULL) AS matched_amount
         FROM invoices i
         LEFT JOIN movement_attributions a ON a.reference_id = i.invoice_id 
           AND a.component_type = 'ar' AND a.user_id = i.user_id
         WHERE i.user_id = $1 
           AND i.status != 'paid'
           AND (i.customer_name ILIKE $2 OR i.invoice_id ILIKE $2)
         GROUP BY i.invoice_id, i.customer_name, i.amount, i.amount_due, i.due_date, i.status, i.reconciliation_status
         ORDER BY i.amount_due DESC
         LIMIT $3`,
        [user.id, `%${searchQuery}%`, limit]
      )

      return NextResponse.json({
        results: rows.map(r => ({
          id: r.id,
          entity_name: r.entity_name,
          amount: parseFloat(r.amount),
          amount_due: parseFloat(r.amount_due),
          due_date: r.due_date,
          status: r.status,
          reconciliation_status: r.reconciliation_status,
          matched_amount: r.matched_amount ? parseFloat(r.matched_amount) : undefined,
        })),
      })
    } else {
      // Search open bills
      const { rows } = await query<{
        id: string
        entity_name: string
        amount: string
        amount_due: string
        due_date: string
        status: string
        reconciliation_status: string
        matched_amount: string | null
      }>(
        `SELECT 
           b.bill_id AS id,
           b.vendor_name AS entity_name,
           b.amount::text,
           b.amount_due::text,
           b.due_date::text,
           b.status,
           b.reconciliation_status,
           COALESCE(SUM(a.net_amount::float)::text, NULL) AS matched_amount
         FROM bills b
         LEFT JOIN movement_attributions a ON a.reference_id = b.bill_id 
           AND a.component_type = 'ap' AND a.user_id = b.user_id
         WHERE b.user_id = $1 
           AND b.status != 'paid'
           AND (b.vendor_name ILIKE $2 OR b.bill_id ILIKE $2)
         GROUP BY b.bill_id, b.vendor_name, b.amount, b.amount_due, b.due_date, b.status, b.reconciliation_status
         ORDER BY b.amount_due DESC
         LIMIT $3`,
        [user.id, `%${searchQuery}%`, limit]
      )

      return NextResponse.json({
        results: rows.map(r => ({
          id: r.id,
          entity_name: r.entity_name,
          amount: parseFloat(r.amount),
          amount_due: parseFloat(r.amount_due),
          due_date: r.due_date,
          status: r.status,
          reconciliation_status: r.reconciliation_status,
          matched_amount: r.matched_amount ? parseFloat(r.matched_amount) : undefined,
        })),
      })
    }
  } catch (err) {
    console.error("[reconciliation/search] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
