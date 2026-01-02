import { Job } from 'bull'
import { GenerateForecastJob } from '../job-types'
import { QueueLogger } from '../queue-logger'
import { query } from '../db'
import { log } from '../logger'

const QUEUE_NAME = 'generate-forecast'
const SLOW_JOB_THRESHOLD = 60000 // 60 seconds (forecasts can be slow)

export async function processGenerateForecast(job: Job<GenerateForecastJob>) {
  const startTime = Date.now()
  const { userId } = job.data

  try {
    QueueLogger.logJobStart(job, QUEUE_NAME)
    QueueLogger.logJobProgress(job, QUEUE_NAME, 'generating-forecast', 0)

    // Fetch all needed data from DB (not from job payload - CRITICAL!)
    const { rows: movements } = await query<{
      id: string
      amount: number
      direction: string
      date: string
    }>(
      `SELECT id, amount, direction, date FROM movements 
       WHERE user_id = $1
       ORDER BY date DESC`,
      [userId]
    )

    const { rows: tags } = await query<{
      movement_id: string
      economic_class: string
      cashflow_bucket: string
    }>(
      `SELECT movement_id, economic_class, cashflow_bucket FROM movement_tags 
       WHERE user_id = $1`,
      [userId]
    )

    const { rows: arItems } = await query<{
      entity_id: string
      amount: number
      expected_date: string
    }>(
      `SELECT entity_id, amount, expected_date FROM cash_events 
       WHERE user_id = $1 AND event_type = 'ar'`,
      [userId]
    )

    const { rows: apItems } = await query<{
      entity_id: string
      amount: number
      expected_date: string
    }>(
      `SELECT entity_id, amount, expected_date FROM cash_events 
       WHERE user_id = $1 AND event_type = 'ap'`,
      [userId]
    )

    // Generate forecast
    const forecast = await generateForecastLogic(userId, movements, tags, arItems, apItems)

    // Store in forecast_cache table with TTL
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
    await query(
      `INSERT INTO forecast_cache (user_id, forecast_data, computed_at, expires_at, movement_count, invoice_count, bill_count, starting_cash)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         forecast_data = $2,
         computed_at = NOW(),
         expires_at = $3,
         movement_count = $4,
         invoice_count = $5,
         bill_count = $6,
         starting_cash = $7`,
      [
        userId,
        JSON.stringify(forecast),
        expiresAt,
        movements.length,
        arItems.length,
        apItems.length,
        0, // starting_cash placeholder
      ]
    )

    log('forecast.complete', { userId, jobId: job.id, movementCount: movements.length }, 'queue')

    QueueLogger.logJobProgress(job, QUEUE_NAME, 'generating-forecast', 100)
    await updateJobStatus(job.id, userId, 'complete', 'complete', 100)

    QueueLogger.logJobComplete(job, QUEUE_NAME, Date.now() - startTime)
    QueueLogger.logSlowJob(job, QUEUE_NAME, Date.now() - startTime, SLOW_JOB_THRESHOLD)

    return { jobId: job.id, status: 'complete' }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log('forecast.error', { userId, jobId: job.id, error: errorMessage }, 'queue')
    QueueLogger.logJobFailed(
      job,
      QUEUE_NAME,
      error instanceof Error ? error : new Error(String(error)),
      job.attemptsMade + 1,
      job.opts.attempts || 3
    )

    await updateJobStatus(job.id, userId, 'failed', 'generating-forecast', 0, errorMessage)
    throw error
  }
}

async function generateForecastLogic(
  userId: string,
  movements: Array<{ id: string; amount: number; direction: string; date: string }>,
  tags: Array<{ movement_id: string; economic_class: string; cashflow_bucket: string }>,
  arItems: Array<{ entity_id: string; amount: number; expected_date: string }>,
  apItems: Array<{ entity_id: string; amount: number; expected_date: string }>
): Promise<Record<string, any>> {
  // Placeholder: In production, this would call the actual forecast generation logic
  // from lib/state/forecast-engine.ts or similar
  // For now, return a basic structure
  return {
    scenarios: [
      {
        name: 'Base Case',
        probability: 0.5,
        cashflow: [],
      },
    ],
    summary: {
      runway_days: 90,
      min_cash: 0,
      max_cash: 0,
    },
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
