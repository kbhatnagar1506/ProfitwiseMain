import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

async function getUser() {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  return getUserBySessionToken(sessionToken ?? "")
}

export async function POST() {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await (await import("next/server")).NextRequest.prototype.json.call(
      new (await import("next/server")).NextRequest(new Request("http://localhost", { method: "POST" }))
    )

    const { form_type, draft_data } = body

    if (!form_type || !draft_data) {
      return NextResponse.json(
        { error: "Missing required fields: form_type, draft_data" },
        { status: 400 }
      )
    }

    // Save or update form draft
    const result = await query<{ id: string; saved_at: string }>(
      `INSERT INTO form_drafts (user_id, form_type, draft_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, form_type) DO UPDATE SET
         draft_data = $3,
         saved_at = NOW()
       RETURNING id, saved_at`,
      [user.id, form_type, JSON.stringify(draft_data)]
    )

    log("form.draft.saved", {
      userId: user.id,
      formType: form_type,
    })

    return NextResponse.json({
      success: true,
      draft_id: result.rows[0].id,
      saved_at: result.rows[0].saved_at,
    })
  } catch (err) {
    log("form.draft.error", { error: String(err) })
    return NextResponse.json(
      { error: "Failed to save form draft" },
      { status: 500 }
    )
  }
}

export async function GET(request: Request) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const formType = searchParams.get("form_type")

    if (!formType) {
      return NextResponse.json(
        { error: "Missing required parameter: form_type" },
        { status: 400 }
      )
    }

    // Get form draft
    const result = await query<{ draft_data: any; saved_at: string }>(
      `SELECT draft_data, saved_at
       FROM form_drafts
       WHERE user_id = $1 AND form_type = $2`,
      [user.id, formType]
    )

    if (result.rows.length === 0) {
      return NextResponse.json({
        draft: null,
      })
    }

    return NextResponse.json({
      draft: result.rows[0].draft_data,
      saved_at: result.rows[0].saved_at,
    })
  } catch (err) {
    log("form.draft.fetch_error", { error: String(err) })
    return NextResponse.json(
      { error: "Failed to fetch form draft" },
      { status: 500 }
    )
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const formType = searchParams.get("form_type")

    if (!formType) {
      return NextResponse.json(
        { error: "Missing required parameter: form_type" },
        { status: 400 }
      )
    }

    // Delete form draft
    await query(
      `DELETE FROM form_drafts WHERE user_id = $1 AND form_type = $2`,
      [user.id, formType]
    )

    log("form.draft.deleted", {
      userId: user.id,
      formType,
    })

    return NextResponse.json({
      success: true,
    })
  } catch (err) {
    log("form.draft.delete_error", { error: String(err) })
    return NextResponse.json(
      { error: "Failed to delete form draft" },
      { status: 500 }
    )
  }
}
