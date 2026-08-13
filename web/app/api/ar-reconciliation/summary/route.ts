import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureARMatchesSchema } from "@/lib/db"
import { getARReconciliationSummary } from "@/lib/ar-reconciliation-queries"

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Ensure schema exists
    await ensureARMatchesSchema()

    // Get summary
    const summary = await getARReconciliationSummary(user.id)

    return NextResponse.json(summary)
  } catch (error) {
    console.error("[ar-reconciliation/summary] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
