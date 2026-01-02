import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/require-session'
import { query } from '@/lib/db'
import { addSyncInitialDataJob } from '@/lib/queue/queue-wrapper'

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.userId

    // Check if user already has data (movements exist)
    const { rows } = await query<{ count: number }>(
      `SELECT COUNT(*) as count FROM movements WHERE user_id = $1`,
      [userId]
    )

    const hasExistingData = rows[0]?.count > 0

    if (hasExistingData) {
      return NextResponse.json(
        {
          jobId: null,
          status: 'skipped',
          message: 'User already has data, skipping initial sync',
        },
        { status: 200 }
      )
    }

    // Queue sync-initial-data job
    const job = await addSyncInitialDataJob(userId)

    // Create initial job status record
    await query(
      `INSERT INTO job_status (job_id, user_id, status, step, progress, created_at, updated_at)
       VALUES ($1, $2, 'queued', 'fetching', 0, NOW(), NOW())`,
      [job.id, userId]
    )

    return NextResponse.json({
      jobId: job.id,
      status: 'queued',
      message: 'Initial sync queued',
    })
  } catch (error) {
    console.error('[sync-initial] Error:', error)
    return NextResponse.json(
      { error: 'Failed to queue initial sync' },
      { status: 500 }
    )
  }
}
