import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query } from "@/lib/db"
import { log } from "@/lib/logger"

type CorrectClassificationRequest = {
  transaction_id: string
  correct_classification: string
  description: string
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")

  if (!user) {
    log("reconciliation.correct_classification.unauthorized", { reason: "no_session" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const userId = user.id
    const body: CorrectClassificationRequest = await request.json()
    const { transaction_id, correct_classification, description } = body

    if (!transaction_id || !correct_classification) {
      return NextResponse.json(
        { error: "Missing required fields: transaction_id, correct_classification" },
        { status: 400 }
      )
    }

    // Validate classification
    const validClassifications = ["ar_invoice", "ap_bill", "internal_transfer", "fee", "operational_expense", "adjustment", "unclassified"]
    if (!validClassifications.includes(correct_classification)) {
      return NextResponse.json(
        { error: `Invalid classification. Must be one of: ${validClassifications.join(", ")}` },
        { status: 400 }
      )
    }

    // Get the transaction to extract pattern
    const transaction = await query<{ raw_description: string }>(
      `SELECT raw_description FROM movements WHERE id = $1 AND user_id = $2`,
      [transaction_id, userId]
    ).then((r) => r.rows[0])

    if (!transaction) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 })
    }

    // Extract a pattern from the description (first 20 chars or first word)
    const desc = transaction.raw_description || ""
    const pattern = desc.substring(0, Math.min(20, desc.length)).trim() || description

    // Create or update classification rule based on the correction
    if (pattern) {
      await query(
        `INSERT INTO classification_rules (user_id, pattern, classification, confidence, priority)
         VALUES ($1, $2, $3, 0.90, 110)
         ON CONFLICT (user_id, pattern) DO UPDATE SET
           classification = $3,
           confidence = 0.90,
           priority = 110,
           updated_at = NOW()`,
        [userId, pattern, correct_classification]
      )
    }

    // Update the transaction classification
    await query(
      `UPDATE movements SET transaction_classification = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3`,
      [correct_classification, transaction_id, userId]
    )

    log("reconciliation.correct_classification.success", {
      userId,
      transaction_id,
      correct_classification,
      pattern,
    })

    return NextResponse.json({
      success: true,
      message: "Classification corrected and rule created",
      pattern,
      classification: correct_classification,
    })
  } catch (error) {
    log("reconciliation.correct_classification.error", { error: String(error) })
    return NextResponse.json(
      { error: "Failed to correct classification" },
      { status: 500 }
    )
  }
}
