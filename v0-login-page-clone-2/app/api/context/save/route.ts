import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureAuthSchema, query } from "@/lib/db"
import { addFinalContextToSupermemory } from "@/lib/supermemory"
import { log } from "@/lib/logger"

/** GET /api/context/save — Return the user's saved final context (one stored value). */
export async function GET(_req: NextRequest) {
  const token = _req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    await ensureAuthSchema()
    const { rows } = await query<{ final_context: string | null }>(
      "SELECT final_context FROM users WHERE id = $1",
      [user.id]
    )
    const finalContext = rows[0]?.final_context ?? null
    return NextResponse.json({ finalContext })
  } catch {
    return NextResponse.json({ finalContext: null })
  }
}

/** POST /api/context/save — Persist final context to PG (users.final_context) and ingest into Supermemory. Only one context per user; call when finishing step. */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { finalContext?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const finalContext = typeof body.finalContext === "string" ? body.finalContext : ""
  if (!finalContext.trim()) {
    return NextResponse.json({ error: "finalContext is required" }, { status: 400 })
  }

  try {
    await ensureAuthSchema()
    await query("UPDATE users SET final_context = $1, updated_at = NOW() WHERE id = $2", [
      finalContext.trim(),
      user.id,
    ])
    log("context.save.db", { userId: user.id }, "db")
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("context.save.db_failed", { userId: user.id, error: message }, "db")
    return NextResponse.json(
      { error: "Failed to save context", details: message },
      { status: 500 }
    )
  }

  try {
    await addFinalContextToSupermemory(finalContext.trim(), `final_context_${user.id}`, user.id)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log("context.save.supermemory_failed", { userId: user.id, error: message }, "supermemory")
    // Non-fatal: context is already saved in PG
  }

  return NextResponse.json({ ok: true })
}
