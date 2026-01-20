import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type ClassificationRule = {
  id: string
  pattern: string
  classification: string
  confidence: number
  is_regex: boolean
  priority: number
  created_at: string
}

type CreateRuleRequest = {
  pattern: string
  classification: string
  confidence?: number
  is_regex?: boolean
  priority?: number
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("reconciliation.classification_rules.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id

    const rules = await query<ClassificationRule>(
      `SELECT id, pattern, classification, confidence, is_regex, priority, created_at::text
       FROM classification_rules
       WHERE user_id = $1
       ORDER BY priority DESC, created_at DESC`,
      [userId]
    ).then((r) => r.rows)

    return NextResponse.json({ rules })
  } catch (error) {
    log("reconciliation.classification_rules.get_error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to fetch classification rules" },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("reconciliation.classification_rules.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id
    const body: CreateRuleRequest = await request.json()
    const { pattern, classification, confidence = 0.85, is_regex = false, priority = 100 } = body

    if (!pattern || !classification) {
      return NextResponse.json(
        { error: "Missing required fields: pattern, classification" },
        { status: 400 }
      )
    }

    // Validate classification
    const validClassifications = ["ar_invoice", "ap_bill", "internal_transfer", "fee", "operational_expense", "adjustment", "unclassified"]
    if (!validClassifications.includes(classification)) {
      return NextResponse.json(
        { error: `Invalid classification. Must be one of: ${validClassifications.join(", ")}` },
        { status: 400 }
      )
    }

    // Validate confidence
    if (confidence < 0 || confidence > 1) {
      return NextResponse.json(
        { error: "Confidence must be between 0 and 1" },
        { status: 400 }
      )
    }

    // If regex, validate it
    if (is_regex) {
      try {
        new RegExp(pattern)
      } catch (e) {
        return NextResponse.json(
          { error: `Invalid regex pattern: ${String(e)}` },
          { status: 400 }
        )
      }
    }

    const result = await query<{ id: string }>(
      `INSERT INTO classification_rules (user_id, pattern, classification, confidence, is_regex, priority)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, pattern) DO UPDATE SET
         classification = $3,
         confidence = $4,
         is_regex = $5,
         priority = $6,
         updated_at = NOW()
       RETURNING id`,
      [userId, pattern, classification, confidence, is_regex, priority]
    ).then((r) => r.rows[0])

    log("reconciliation.classification_rules.created", {
      userId,
      pattern,
      classification,
    })

    return NextResponse.json({
      success: true,
      rule_id: result.id,
      message: "Classification rule created/updated",
    })
  } catch (error) {
    log("reconciliation.classification_rules.create_error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to create classification rule" },
      { status: 500 }
    )
  }
}
