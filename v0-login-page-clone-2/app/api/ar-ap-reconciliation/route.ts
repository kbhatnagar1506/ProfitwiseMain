/**
 * AR/AP reconciliation: matched/unmatched payments, fees.
 * Uses background processing: returns immediately with status, client polls until ready.
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { query, ensureMovementsSchema } from "@/lib/db"
import { runReconciliationJob } from "@/lib/reconciliation-run"

const CACHE_FRESH_SEC = 300 // 5 min

export async function GET(req: Request) {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(getSessionCookieName())?.value
  const user = await getUserBySessionToken(sessionToken ?? "")
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const arApOnly = searchParams.get("arApOnly") !== "false"
  const merchantOnly = searchParams.get("merchantOnly") === "true"

  try {
    await ensureMovementsSchema()
  } catch {
    return NextResponse.json({ error: "Movements schema not available" }, { status: 500 })
  }

  try {
    type CacheRow = { status: string; data: unknown; error_message: string | null; updated_at: string }
    const { rows } = await query<CacheRow>(
      `SELECT status, data, error_message, updated_at FROM reconciliation_cache
       WHERE user_id = $1 AND ar_ap_only = $2 AND merchant_only = $3`,
      [user.id, arApOnly, merchantOnly]
    )
    const cached = rows[0]

    if (cached?.status === "ready" && cached.data) {
      const ageSec = (Date.now() - new Date(cached.updated_at).getTime()) / 1000
      if (ageSec < CACHE_FRESH_SEC) {
        return NextResponse.json(cached.data as object)
      }
    }

    if (cached?.status === "processing") {
      return NextResponse.json({ status: "processing" })
    }

    // Start background job
    await query(
      `INSERT INTO reconciliation_cache (user_id, ar_ap_only, merchant_only, status, updated_at, reconcile_at)
       VALUES ($1, $2, $3, 'processing', NOW(), NOW())
       ON CONFLICT (user_id, ar_ap_only, merchant_only) DO UPDATE SET status = 'processing', updated_at = NOW(), reconcile_at = NOW()`,
      [user.id, arApOnly, merchantOnly]
    )

    runReconciliationJob(user.id, { arApOnly, merchantOnly })
      .then(async (result) => {
        await query(
          `UPDATE reconciliation_cache SET status = 'ready', data = $2::jsonb, error_message = NULL, updated_at = NOW(), reconcile_at = NOW()
           WHERE user_id = $1 AND ar_ap_only = $3 AND merchant_only = $4`,
          [user.id, JSON.stringify(result), arApOnly, merchantOnly]
        )
      })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[AR-AP-Reconciliation] job failed:", msg)
        await query(
          `UPDATE reconciliation_cache SET status = 'error', error_message = $2, updated_at = NOW()
           WHERE user_id = $1 AND ar_ap_only = $3 AND merchant_only = $4`,
          [user.id, msg, arApOnly, merchantOnly]
        )
      })

    return NextResponse.json({ status: "processing" })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[AR-AP-Reconciliation] failed:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
