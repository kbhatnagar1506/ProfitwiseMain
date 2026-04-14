import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/require-session'
import { query } from '@/lib/db'
import { matchCustomersWithLLM } from '@/lib/reconciliation-customer-matcher'

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.id

    // Create job status record
    const jobId = `manual-${Date.now()}`
    await query(
      `INSERT INTO job_status (job_id, user_id, status, step, progress, created_at, updated_at)
       VALUES ($1, $2, 'processing', 'matching-customers', 0, NOW(), NOW())
       ON CONFLICT (job_id) DO UPDATE SET
         status = 'processing',
         step = 'matching-customers',
         progress = 0,
         updated_at = NOW()`,
      [jobId, userId]
    )

    // Run customer matching directly (non-blocking response)
    // Start the matching in background
    runCustomerMatching(userId, jobId).catch(err => {
      console.error('[match-customers] Background job failed:', err)
    })

    return NextResponse.json({
      jobId,
      status: 'processing',
      message: 'Customer matching started',
    })
  } catch (error) {
    console.error('[match-customers] Error:', error)
    return NextResponse.json(
      { error: 'Failed to start customer matching' },
      { status: 500 }
    )
  }
}

async function runCustomerMatching(userId: string, jobId: string) {
  try {
    // Fetch AR movements
    const movementsResult = await query(
      `SELECT m.id, m.counterparty
       FROM movements m
       LEFT JOIN movement_tags mt ON mt.movement_id = m.id
       WHERE m.user_id = $1
         AND m.direction = 'inflow'
       ORDER BY m.date DESC`,
      [userId]
    )
    const movements = movementsResult.rows

    // Fetch known customers from invoices
    const customersResult = await query(
      `SELECT DISTINCT metadata->>'customer_name' as customer_name
       FROM cash_events
       WHERE user_id = $1
         AND event_type = 'ar'
         AND metadata->>'customer_name' IS NOT NULL
       ORDER BY customer_name`,
      [userId]
    )
    const knownCustomers = customersResult.rows.map((r: { customer_name: string }) => r.customer_name).filter(Boolean)

    console.log(`[match-customers] Processing ${movements.length} movements with ${knownCustomers.length} known customers`)

    if (movements.length === 0 || knownCustomers.length === 0) {
      await query(
        `UPDATE job_status SET status = 'complete', progress = 100, updated_at = NOW() WHERE job_id = $1`,
        [jobId]
      )
      return
    }

    // Run customer matching
    const customerMatches = await matchCustomersWithLLM(
      movements.map((m: { id: string; counterparty: string | null }) => ({ id: m.id, counterparty: m.counterparty })),
      knownCustomers
    )

    // Store results
    let storedCount = 0
    for (const [movementId, matchedCustomer] of customerMatches.entries()) {
      if (matchedCustomer) {
        await query(
          `INSERT INTO movement_customer_matches (user_id, movement_id, matched_customer, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (movement_id) DO UPDATE SET
             matched_customer = $3,
             created_at = NOW()`,
          [userId, movementId, matchedCustomer]
        )
        storedCount++
      }
    }

    console.log(`[match-customers] Stored ${storedCount} customer matches`)

    // Update job status
    await query(
      `UPDATE job_status SET status = 'complete', progress = 100, updated_at = NOW() WHERE job_id = $1`,
      [jobId]
    )
  } catch (error) {
    console.error('[match-customers] Job failed:', error)
    const errorMsg = error instanceof Error ? error.message : String(error)
    await query(
      `UPDATE job_status SET status = 'failed', error = $2, updated_at = NOW() WHERE job_id = $1`,
      [jobId, errorMsg]
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
