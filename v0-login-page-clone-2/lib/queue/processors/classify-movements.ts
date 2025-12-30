import { Job } from 'bull'
import { ClassifyMovementsJob } from '../job-types'
import { QueueLogger } from '../queue-logger'
import { query } from '../db'
import { log } from '../logger'

const QUEUE_NAME = 'classify-movements'
const SLOW_JOB_THRESHOLD = 30000 // 30 seconds

export async function processClassifyMovements(job: Job<ClassifyMovementsJob>) {
  const startTime = Date.now()
  const { userId } = job.data

  try {
    QueueLogger.logJobStart(job, QUEUE_NAME)
    QueueLogger.logJobProgress(job, QUEUE_NAME, 'classifying', 0)

    // Fetch movements from DB (not from job payload - CRITICAL!)
    const { rows: movements } = await query<{
      id: string
      amount: number
      date: string
      raw_description: string
      counterparty: string
    }>(
      `SELECT id, amount, date, raw_description, counterparty FROM movements 
       WHERE user_id = $1 AND movement_type IS NULL OR movement_type = ''
       ORDER BY date DESC`,
      [userId]
    )

    if (movements.length === 0) {
      log('classify.no_movements', { userId }, 'queue')
      QueueLogger.logJobProgress(job, QUEUE_NAME, 'classifying', 100)
      await updateJobStatus(job.id, userId, 'processing', 'classifying', 100)

      // Queue next job: tag-movements
      const tagJob = await job.queue.add(
        'tag-movements',
        { userId },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
        }
      )

      return { jobId: job.id, nextJobId: tagJob.id, status: 'queued' }
    }

    // Classify movements (placeholder - actual classification logic would go here)
    // For now, just mark them as classified
    const classifiedCount = await classifyMovementsLogic(userId, movements)

    log('classify.complete', { userId, jobId: job.id, classifiedCount }, 'queue')

    QueueLogger.logJobProgress(job, QUEUE_NAME, 'classifying', 100)
    await updateJobStatus(job.id, userId, 'processing', 'classifying', 100)

    // Queue next job: tag-movements
    const tagJob = await job.queue.add(
      'tag-movements',
      { userId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
      }
    )

    QueueLogger.logJobComplete(job, QUEUE_NAME, Date.now() - startTime)
    QueueLogger.logSlowJob(job, QUEUE_NAME, Date.now() - startTime, SLOW_JOB_THRESHOLD)

    return { jobId: job.id, nextJobId: tagJob.id, status: 'queued' }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log('classify.error', { userId, jobId: job.id, error: errorMessage }, 'queue')
    QueueLogger.logJobFailed(
      job,
      QUEUE_NAME,
      error instanceof Error ? error : new Error(String(error)),
      job.attemptsMade + 1,
      job.opts.attempts || 3
    )

    await updateJobStatus(job.id, userId, 'failed', 'classifying', 0, errorMessage)
    throw error
  }
}

async function classifyMovementsLogic(
  userId: string,
  movements: Array<{ id: string; amount: number; date: string; raw_description: string; counterparty: string }>
): Promise<number> {
  // Placeholder: In production, this would call the actual classification logic
  // from lib/movement-classify.ts or similar
  // For now, just return the count
  return movements.length
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
