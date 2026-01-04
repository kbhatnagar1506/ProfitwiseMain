import { Job } from 'bull'
import { ClassifyMovementsJob } from '../job-types'
import { QueueLogger } from '../queue-logger'
import { query } from '../db'
import { log } from '../logger'
import { classifyMovements } from '../movement-classify'

const QUEUE_NAME = 'classify-movements'
const SLOW_JOB_THRESHOLD = 60000 // 60 seconds (classification can be slow)

export async function processClassifyMovements(job: Job<ClassifyMovementsJob>) {
  const startTime = Date.now()
  const { userId } = job.data

  try {
    QueueLogger.logJobStart(job, QUEUE_NAME)
    QueueLogger.logJobProgress(job, QUEUE_NAME, 'classifying', 0)

    log('classify.start', { userId, jobId: job.id }, 'queue')

    // Run the full classification pipeline
    // This calls the existing classifyMovements function which handles:
    // - Extract observations from all sources
    // - Coalesce into canonical movements
    // - Resolve counterparty identity with entity graph
    // - Classify movement types
    // - Persist to movements table
    await classifyMovements(userId)

    log('classify.complete', { userId, jobId: job.id }, 'queue')

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
