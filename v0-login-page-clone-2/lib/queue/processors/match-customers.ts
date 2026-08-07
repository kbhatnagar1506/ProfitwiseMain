import { Job } from 'bull'
import { MatchCustomersJob } from '../job-types'
import { QueueLogger } from '../queue-logger'
import { query } from '../../db'
import { log } from '../../logger'
import { matchCustomersWithLLM } from '../../reconciliation-customer-matcher'

const QUEUE_NAME = 'match-customers'
const SLOW_JOB_THRESHOLD = 120000 // 120 seconds (LLM calls can be slow)

export async function processMatchCustomers(job: Job<MatchCustomersJob>) {
  const startTime = Date.now()
  const { userId } = job.data

  try {
    QueueLogger.logJobStart(job, QUEUE_NAME)
    QueueLogger.logJobProgress(job, QUEUE_NAME, 'matching-customers', 0)

    log('match-customers.start', { userId, jobId: job.id }, 'queue')

    // Fetch AR movements and invoices
    const movements = await fetchARMovements(userId)
    const knownCustomers = await fetchKnownCustomers(userId)

    console.log(`[match-customers] Processing ${movements.length} movements with ${knownCustomers.length} known customers`)

    if (movements.length === 0 || knownCustomers.length === 0) {
      console.log(`[match-customers] Skipping: no movements or customers`)
      QueueLogger.logJobProgress(job, QUEUE_NAME, 'matching-customers', 100)
      await updateJobStatus(job.id, userId, 'processing', 'matching-customers', 100)
      return { jobId: job.id, status: 'complete', matchedCount: 0 }
    }

    // Run customer matching
    const customerMatches = await matchCustomersWithLLM(
      movements.map(m => ({ id: m.id, counterparty: m.counterparty })),
      knownCustomers
    )

    // Store results in database
    let storedCount = 0
    for (const [movementId, matchedCustomer] of customerMatches.entries()) {
      if (matchedCustomer) {
        await storeCustomerMatch(userId, movementId, matchedCustomer)
        storedCount++
      }
    }

    console.log(`[match-customers] Stored ${storedCount} customer matches`)

    log('match-customers.complete', { userId, jobId: job.id, matchedCount: storedCount }, 'queue')

    QueueLogger.logJobProgress(job, QUEUE_NAME, 'matching-customers', 100)
    await updateJobStatus(job.id, userId, 'processing', 'matching-customers', 100)

    QueueLogger.logJobComplete(job, QUEUE_NAME, Date.now() - startTime)
    QueueLogger.logSlowJob(job, QUEUE_NAME, Date.now() - startTime, SLOW_JOB_THRESHOLD)

    return { jobId: job.id, status: 'complete', matchedCount: storedCount }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log('match-customers.error', { userId, jobId: job.id, error: errorMessage }, 'queue')
    QueueLogger.logJobFailed(
      job,
      QUEUE_NAME,
      error instanceof Error ? error : new Error(String(error)),
      job.attemptsMade + 1,
      job.opts.attempts || 3
    )

    await updateJobStatus(job.id, userId, 'failed', 'matching-customers', 0, errorMessage)
    throw error
  }
}

async function fetchARMovements(userId: string): Promise<Array<{ id: string; counterparty: string | null }>> {
  const result = await query(
    `SELECT m.id, m.counterparty
     FROM movements m
     LEFT JOIN movement_tags mt ON mt.movement_id = m.id
     WHERE m.user_id = $1
       AND m.direction = 'inflow'
       AND mt.economic_class = 'customer_receipt'
     ORDER BY m.date DESC`,
    [userId]
  )
  return result.rows
}

async function fetchKnownCustomers(userId: string): Promise<string[]> {
  const result = await query(
    `SELECT DISTINCT metadata->>'customer_name' as customer_name
     FROM cash_events
     WHERE user_id = $1
       AND event_type = 'ar'
       AND metadata->>'customer_name' IS NOT NULL
     ORDER BY customer_name`,
    [userId]
  )
  return result.rows.map(r => r.customer_name).filter(Boolean)
}

async function storeCustomerMatch(userId: string, movementId: string, matchedCustomer: string): Promise<void> {
  await query(
    `INSERT INTO movement_customer_matches (user_id, movement_id, matched_customer, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (movement_id) DO UPDATE SET
       matched_customer = $3,
       created_at = NOW()`,
    [userId, movementId, matchedCustomer]
  )
}

async function updateJobStatus(
  jobId: string,
  userId: string,
  status: 'queued' | 'processing' | 'complete' | 'failed',
  step: 'fetching' | 'classifying' | 'tagging' | 'computing-state' | 'generating-forecast' | 'matching-customers' | 'complete',
  progress: number,
  error?: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO job_status (job_id, user_id, status, step, progress, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (job_id) DO UPDATE SET
         status = $3,
         step = $4,
         progress = $5,
         error = $6,
         updated_at = NOW()`,
      [jobId, userId, status, step, progress, error || null]
    )
  } catch (err) {
    console.error('[match-customers] Failed to update job status:', err)
  }
}
