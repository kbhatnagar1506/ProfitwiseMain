import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/require-session'
import { query } from '@/lib/db'

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.userId

    // Get the latest job status for this user
    const { rows } = await query<{
      job_id: string
      status: string
      step: string
      progress: number
      error: string | null
      updated_at: string
    }>(
      `SELECT job_id, status, step, progress, error, updated_at FROM job_status 
       WHERE user_id = $1 
       ORDER BY updated_at DESC 
       LIMIT 1`,
      [userId]
    )

    if (rows.length === 0) {
      return NextResponse.json({
        jobId: null,
        status: 'idle',
        step: 'fetching',
        progress: 0,
        error: null,
      })
    }

    const jobStatus = rows[0]

    return NextResponse.json({
      jobId: jobStatus.job_id,
      status: jobStatus.status,
      step: jobStatus.step,
      progress: jobStatus.progress,
      error: jobStatus.error,
      updatedAt: jobStatus.updated_at,
    })
  } catch (error) {
    console.error('[sync-status] Error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch sync status' },
      { status: 500 }
    )
  }
}
