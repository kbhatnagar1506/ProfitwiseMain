import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { buildFinancialContext } from "@/lib/financial-context"

/** GET /api/context/financial — Major expenses, vendors, payments from last 60 days (Plaid DB), pre-tagged by OpenAI. */
export async function GET(_req: NextRequest) {
  const token = _req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const financialContext = await buildFinancialContext(user.id)
  return NextResponse.json(financialContext)
}
