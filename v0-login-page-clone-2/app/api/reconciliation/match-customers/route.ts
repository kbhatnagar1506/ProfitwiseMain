import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/require-session'
import { query } from '@/lib/db'

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.id

    // Use eval-based require to fully prevent Turbopack static analysis
    const _require = eval('require') as NodeRequire
    const path = eval('require')('path') as typeof import('path')
    const clientPath = path.join(process.cwd(), 'lib', 'queue', 'bull-client')
    const { queues } = _require(clientPath)
    
    // Queue match-customers job
    const job = await queues.matchCustomers.add(
      { userId },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
      }
    )

    // Create initial job status record
    await query(
      `INSERT INTO job_status (job_id, user_id, status, step, progress, created_at, updated_at)
       VALUES ($1, $2, 'queued', 'matching-customers', 0, NOW(), NOW())
       ON CONFLICT (job_id) DO UPDATE SET
         status = 'queued',
         step = 'matching-customers',
         progress = 0,
         updated_at = NOW()`,
      [job.id, userId]
    )

    return NextResponse.json({
      jobId: job.id,
      status: 'queued',
      message: 'Customer matching job queued',
    })
  } catch (error) {
    console.error('[match-customers] Error:', error)
    return NextResponse.json(
      { error: 'Failed to queue customer matching job' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.id

    // Get latest job status
    const { rows } = await query(
      `SELECT job_id, status, step, progress, error, created_at, updated_at
       FROM job_status
       WHERE user_id = $1 AND step = 'matching-customers'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    )

    if (rows.length === 0) {
      return NextResponse.json({
        status: 'none',
        message: 'No customer matching job found',
      })
    }

    const job = rows[0]

    // Get match count
    const { rows: matchRows } = await query(
      `SELECT COUNT(*) as count FROM movement_customer_matches WHERE user_id = $1`,
      [userId]
    )

    return NextResponse.json({
      jobId: job.job_id,
      status: job.status,
      step: job.step,
      progress: job.progress,
      error: job.error,
      matchCount: parseInt(matchRows[0]?.count || '0'),
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    })
  } catch (error) {
    console.error('[match-customers] Error:', error)
    return NextResponse.json(
      { error: 'Failed to get job status' },
      { status: 500 }
    )
  }
}
