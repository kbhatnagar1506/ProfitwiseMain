import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureMerchantTagsSchema, query } from "@/lib/db"

/**
 * DELETE /api/onboarding/merchants/tags
 * Removes all merchant tags for the current user so AI can re-run and re-tag from scratch.
 */
export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    await ensureMerchantTagsSchema()
    await query("DELETE FROM merchant_tags WHERE user_id = $1", [user.id])
    return NextResponse.json({ ok: true, message: "Tags cleared. Re-run normalize & tag to reload with AI." })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
