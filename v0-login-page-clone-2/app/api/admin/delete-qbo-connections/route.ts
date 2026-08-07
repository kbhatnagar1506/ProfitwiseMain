import { NextRequest, NextResponse } from "next/server"
import { ensureQBOSchema, query } from "@/lib/db"
import { log } from "@/lib/logger"

/** DELETE all QBO connections (for testing reconnect). Auth: x-clean-db-secret header. Production only. */
export async function DELETE(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ error: "Only available in production" }, { status: 403 })
  }
  if (req.nextUrl.searchParams.has("secret")) {
    return NextResponse.json(
      { error: "Do not send the secret in the URL. Use the x-clean-db-secret header." },
      { status: 400 }
    )
  }
  const secret = req.headers.get("x-clean-db-secret") ?? ""
  const expected = process.env.CLEAN_DB_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    await ensureQBOSchema()
    const result = await query<{ id: string }>("DELETE FROM qbo_connections RETURNING id")
    const deleted = result.rows.length
    log("admin.delete-qbo-connections.done", { deleted }, "db")
    return NextResponse.json({ ok: true, deleted })
  } catch (err) {
    log("admin.delete-qbo-connections.failed", { error: String(err) }, "db")
    return NextResponse.json({ error: "Delete failed" }, { status: 500 })
  }
}
