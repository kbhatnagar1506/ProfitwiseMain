import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { NextResponse } from "next/server"
import { query } from "@/lib/db"

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    const user = await getUserBySessionToken(sessionToken ?? "")

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = user.id
    const url = new URL(request.url)
    const jobId = url.searchParams.get("jobId")

    if (!jobId) {
      return NextResponse.json({ error: "jobId parameter required" }, { status: 400 })
    }

    // Get job status from database
    const result = await query(
      `SELECT job_id, status, step, progress, error, created_at, updated_at
       FROM job_status
       WHERE job_id = $1 AND user_id = $2`,
      [jobId, userId]
    )

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    const jobStatus = result.rows[0]

    return NextResponse.json({
      jobId: jobStatus.job_id,
      status: jobStatus.status,
      step: jobStatus.step,
      progress: jobStatus.progress,
      error: jobStatus.error,
      createdAt: jobStatus.created_at,
      updatedAt: jobStatus.updated_at,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error("[job-status] Error:", errorMessage)
    return NextResponse.json(
      { error: "Failed to fetch job status", details: errorMessage },
      { status: 500 }
    )
  }
}
