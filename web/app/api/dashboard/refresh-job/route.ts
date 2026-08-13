import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/require-session"
import { query } from "@/lib/db"
import { buildEntityProfiles } from "@/lib/entity-profiles"
import { refreshEntityNarratives } from "@/lib/entity-profile-ai"
import { initializeRefreshJobsTable } from "@/lib/db-init"
import { v4 as uuidv4 } from "uuid"

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Initialize table on first use
    try {
      await initializeRefreshJobsTable()
    } catch (err) {
      console.error("[refresh-job] Error initializing table:", err)
      // Continue anyway, table might already exist
    }

    const userId = session.id
    const jobId = uuidv4()

    // Create refresh job record
    await query(
      `INSERT INTO refresh_jobs (id, user_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [jobId, userId, "pending"]
    )

    // Start background job (fire and forget)
    startRefreshJob(jobId, userId).catch((err) => {
      console.error(`[refresh-job] Error in background job ${jobId}:`, err)
    })

    return NextResponse.json({
      job_id: jobId,
      status: "pending",
      message: "Refresh job started",
    })
  } catch (error) {
    console.error("[refresh-job] Error creating job:", error)
    return NextResponse.json(
      { error: "Failed to start refresh job" },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = session.id
    const jobId = request.nextUrl.searchParams.get("job_id")

    if (!jobId) {
      return NextResponse.json(
        { error: "job_id parameter required" },
        { status: 400 }
      )
    }

    // Get job status
    const result = await query<{
      id: string
      status: string
      error_message: string | null
      created_at: string
      updated_at: string
    }>(
      `SELECT id, status, error_message, created_at, updated_at
       FROM refresh_jobs
       WHERE id = $1 AND user_id = $2`,
      [jobId, userId]
    )

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    const job = result.rows[0]

    return NextResponse.json({
      job_id: job.id,
      status: job.status,
      error_message: job.error_message,
      created_at: job.created_at,
      updated_at: job.updated_at,
    })
  } catch (error) {
    console.error("[refresh-job] Error fetching job status:", error)
    return NextResponse.json(
      { error: "Failed to fetch job status" },
      { status: 500 }
    )
  }
}

async function startRefreshJob(jobId: string, userId: string) {
  try {
    // Update status to running
    await query(
      `UPDATE refresh_jobs SET status = $1, updated_at = NOW() WHERE id = $2`,
      ["running", jobId]
    )

    console.log(`[refresh-job] Starting refresh job ${jobId} for user ${userId}`)

    // Run the refresh operations
    await buildEntityProfiles(userId)
    await refreshEntityNarratives(userId, { maxEntities: 100 })

    // Update status to completed
    await query(
      `UPDATE refresh_jobs SET status = $1, updated_at = NOW() WHERE id = $2`,
      ["completed", jobId]
    )

    console.log(`[refresh-job] Completed refresh job ${jobId}`)
  } catch (error) {
    console.error(`[refresh-job] Error in job ${jobId}:`, error)

    // Update status to failed with error message
    const errorMessage = error instanceof Error ? error.message : String(error)
    await query(
      `UPDATE refresh_jobs SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3`,
      ["failed", errorMessage, jobId]
    )
  }
}
