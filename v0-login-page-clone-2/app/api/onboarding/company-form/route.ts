import { NextRequest, NextResponse } from "next/server"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { ensureAuthSchema, query } from "@/lib/db"

export type CompanyFormData = Record<string, string>

/** GET /api/onboarding/company-form — Return saved company form for the user. */
export async function GET(_req: NextRequest) {
  const token = _req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    await ensureAuthSchema()
    const { rows } = await query<{ company_form: CompanyFormData | null }>(
      "SELECT company_form FROM users WHERE id = $1",
      [user.id]
    )
    const form = rows[0]?.company_form ?? {}
    return NextResponse.json({ form: form && typeof form === "object" ? form : {} })
  } catch {
    return NextResponse.json({ form: {} })
  }
}

/** PATCH /api/onboarding/company-form — Save company form to DB. */
export async function PATCH(req: NextRequest) {
  const token = req.cookies.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(token ?? "")
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  let body: { form?: CompanyFormData }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const form = body.form && typeof body.form === "object" ? body.form : {}
  const sanitized: CompanyFormData = {}
  for (const [k, v] of Object.entries(form)) {
    if (typeof k === "string" && typeof v === "string") sanitized[k] = v
  }
  try {
    await ensureAuthSchema()
    await query(
      "UPDATE users SET company_form = $1, updated_at = NOW() WHERE id = $2",
      [JSON.stringify(sanitized), user.id]
    )
    return NextResponse.json({ form: sanitized })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: "Failed to save form", details: message }, { status: 500 })
  }
}
