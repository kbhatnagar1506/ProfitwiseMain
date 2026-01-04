import { Job } from 'bull'
import { ComputeStateJob } from '../job-types'
import { QueueLogger } from '../queue-logger'
import { query } from '../db'
import { log } from '../logger'
import { computeState } from '../state/compute'

const QUEUE_NAME = 'compute-state'
const SLOW_JOB_THRESHOLD = 30000 // 30 seconds

export async function processComputeState(job: Job<ComputeStateJob>) {
  const startTime = Date.now()
  const { userId } = job.data

  try {
    QueueLogger.logJobStart(job, QUEUE_NAME)
    QueueLogger.logJobProgress(job, QUEUE_NAME, 'computing-state', 0)

    log('compute.start', { userId, jobId: job.id }, 'queue')

    // Fetch tagged movements from DB
    const { rows: taggedMovements } = await query<{
      id: string
      user_id: string
      date: string
      direction: string
      amount: string
      movement_type: string
      counterparty_entity_id: string | null
      counterparty_entity_type: string | null
      economic_class: string
      cashflow_bucket: string
      counterparty_role: string
    }>(
      `SELECT 
        m.id, m.user_id, m.date, m.direction, m.amount, m.movement_type,
        m.counterparty_entity_id, m.counterparty_entity_type,
        mt.economic_class, mt.cashflow_bucket, mt.counterparty_role
       FROM movements m
       LEFT JOIN movement_tags mt ON m.id = mt.movement_id
       WHERE m.user_id = $1
       ORDER BY m.date ASC`,
      [userId]
    )

    if (taggedMovements.length === 0) {
      log('compute.no_movements', { userId }, 'queue')
      QueueLogger.logJobProgress(job, QUEUE_NAME, 'computing-state', 100)
      await updateJobStatus(job.id, userId, 'processing', 'computing-state', 100)

      // Queue next job: generate-forecast
      const forecastJob = await job.queue.add(
        'generate-forecast',
        { userId },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
        }
      )

      return { jobId: job.id, nextJobId: forecastJob.id, status: 'queued' }
    }

    // Compute RevenueState, SpendState, LiquidityState
    // This calls the existing computeState function which handles:
    // - Compute financial state from tagged movements
    // - Integrate with entity graph for entity-level analysis
    // - Persist snapshot to state_snapshots table
    const stateSnapshot = await computeState(userId, taggedMovements as any)

    // Persist snapshot to state_snapshots table
    await query(
      `INSERT INTO state_snapshots (user_id, snapshot_at, revenue_state, spend_state, liquidity_state, created_at)
       VALUES ($1, NOW(), $2, $3, $4, NOW())`,
      [userId, JSON.stringify(stateSnapshot.revenue), JSON.stringify(stateSnapshot.spend), JSON.stringify(stateSnapshot.liquidity)]
    )

    log('compute.complete', { userId, jobId: job.id, movementCount: taggedMovements.length }, 'queue')

    QueueLogger.logJobProgress(job, QUEUE_NAME, 'computing-state', 100)
    await updateJobStatus(job.id, userId, 'processing', 'computing-state', 100)

    // Queue next job: generate-forecast
    const forecastJob = await job.queue.add(
      'generate-forecast',
      { userId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
      }
    )

    QueueLogger.logJobComplete(job, QUEUE_NAME, Date.now() - startTime)
    QueueLogger.logSlowJob(job, QUEUE_NAME, Date.now() - startTime, SLOW_JOB_THRESHOLD)

    return { jobId: job.id, nextJobId: forecastJob.id, status: 'queued' }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log('compute.error', { userId, jobId: job.id, error: errorMessage }, 'queue')
    QueueLogger.logJobFailed(
      job,
      QUEUE_NAME,
      error instanceof Error ? error : new Error(String(error)),
      job.attemptsMade + 1,
      job.opts.attempts || 3
    )

    await updateJobStatus(job.id, userId, 'failed', 'computing-state', 0, errorMessage)
    throw error
  }
}

async function updateJobStatus(
  jobId: string,
  userId: string,
  status: 'queued' | 'processing' | 'complete' | 'failed',
  step: 'fetching' | 'classifying' | 'tagging' | 'computing-state' | 'generating-forecast' | 'complete',
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
    log('job_status.update.error', { jobId, userId, error: String(err) }, 'queue')
  }
}
