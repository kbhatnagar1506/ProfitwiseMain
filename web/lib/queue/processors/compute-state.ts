import { Job } from 'bull'
import { ComputeStateJob } from '../job-types'
import { QueueLogger } from '../queue-logger'
import { query } from '../../db'
import { log } from '../../logger'
import { computeRevenueState, computeSpendState, computeLiquidityState } from '../../state/compute'

const QUEUE_NAME = 'compute-state'
const SLOW_JOB_THRESHOLD = 30000

export async function processComputeState(job: Job<ComputeStateJob>) {
  const startTime = Date.now()
  const { userId } = job.data

  try {
    QueueLogger.logJobStart(job, QUEUE_NAME)
    QueueLogger.logJobProgress(job, QUEUE_NAME, 'computing-state', 0)

    log('compute.start', { userId, jobId: job.id }, 'queue')

    const { rows: rawMovements } = await query<{
      id: string
      user_id: string
      date: string
      direction: string
      amount: string
      movement_type: string
      counterparty_entity_id: string | null
      counterparty_entity_type: string | null
      counterparty_name: string | null
      source: string | null
      source_tx_id: string | null
      account_id: string | null
      account_name: string | null
    }>(
      `SELECT m.id, m.user_id, m.date, m.direction, m.amount, m.movement_type,
              m.counterparty_entity_id, m.counterparty_entity_type,
              m.counterparty_name, m.source, m.source_tx_id,
              m.account_id, m.account_name
       FROM movements m
       WHERE m.user_id = $1
       ORDER BY m.date ASC`,
      [userId]
    )

    if (rawMovements.length === 0) {
      log('compute.no_movements', { userId }, 'queue')
      QueueLogger.logJobProgress(job, QUEUE_NAME, 'computing-state', 100)
      await updateJobStatus(job.id, userId, 'processing', 'computing-state', 100)

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

    const { rows: tags } = await query<{
      movement_id: string
      economic_class: string
      cashflow_bucket: string
      counterparty_role: string
      tag_data: any
    }>(
      `SELECT movement_id, economic_class, cashflow_bucket, counterparty_role, tag_data
       FROM movement_tags
       WHERE movement_id = ANY($1::text[])`,
      [rawMovements.map(m => m.id)]
    )

    const tagMap = new Map(tags.map(t => [t.movement_id, t]))

    const taggedMovements = rawMovements
      .filter(m => tagMap.has(m.id))
      .map(m => {
        const t = tagMap.get(m.id)!
        const td = typeof t.tag_data === 'string' ? JSON.parse(t.tag_data) : (t.tag_data || {})
        return {
          id: m.id,
          user_id: m.user_id,
          date: m.date,
          direction: m.direction as 'in' | 'out',
          amount: parseFloat(m.amount),
          movement_type: m.movement_type,
          counterparty_entity_id: m.counterparty_entity_id,
          counterparty_entity_type: m.counterparty_entity_type,
          counterparty_name: m.counterparty_name ?? '',
          source: m.source ?? '',
          source_tx_id: m.source_tx_id ?? '',
          account_id: m.account_id ?? undefined,
          account_name: m.account_name ?? undefined,
          tag: {
            economic_class: t.economic_class,
            cashflow_bucket: t.cashflow_bucket,
            counterparty_role: t.counterparty_role,
            state_inclusion_policy: td.state_inclusion_policy ?? 'include',
            confidence: td.confidence ?? 1,
            state_scope: td.state_scope ?? {
              affects_revenue: true,
              affects_spend: true,
              affects_liquidity: true,
            },
          },
        }
      }) as any[]

    const dates = taggedMovements.map(m => m.date).sort()
    const periodStart = dates[0]
    const periodEnd = dates[dates.length - 1]

    const revenue = computeRevenueState(taggedMovements, periodStart, periodEnd)
    const spend = computeSpendState(taggedMovements, periodStart, periodEnd)
    const liquidity = computeLiquidityState(taggedMovements, periodStart, periodEnd)

    await query(
      `INSERT INTO state_snapshots (user_id, snapshot_at, revenue_state, spend_state, liquidity_state, created_at)
       VALUES ($1, NOW(), $2, $3, $4, NOW())`,
      [userId, JSON.stringify(revenue), JSON.stringify(spend), JSON.stringify(liquidity)]
    )

    log('compute.complete', { userId, jobId: job.id, movementCount: taggedMovements.length }, 'queue')

    QueueLogger.logJobProgress(job, QUEUE_NAME, 'computing-state', 100)
    await updateJobStatus(job.id, userId, 'processing', 'computing-state', 100)

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
  jobId: string | number,
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
      [String(jobId), userId, status, step, progress, error || null]
    )
  } catch (err) {
    log('job_status.update.error', { jobId, userId, error: String(err) }, 'queue')
  }
}
