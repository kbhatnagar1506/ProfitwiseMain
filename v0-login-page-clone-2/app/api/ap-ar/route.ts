import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { getApArList } from "@/lib/ap-ar"

/**
 * GET /api/ap-ar?side=AR|AP
 * Returns AP/AR list for the logged-in user. AR = receivables (invoices), AP = payables (bills).
 */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const side = req.nextUrl.searchParams.get("side") as "AR" | "AP" | null
  if (side !== "AR" && side !== "AP") {
    return NextResponse.json({ error: "side must be AR or AP" }, { status: 400 })
  }

  try {
    const rows = await getApArList(user.id, side)
    return NextResponse.json({ items: rows })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch" },
      { status: 500 }
    )
  }
}
