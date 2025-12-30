import { Job } from 'bull'
import { ProcessWebhookJob } from '../job-types'
import { QueueLogger } from '../queue-logger'
import { query } from '../db'
import { log } from '../logger'

const QUEUE_NAME = 'process-webhook'
const SLOW_JOB_THRESHOLD = 30000 // 30 seconds

export async function processProcessWebhook(job: Job<ProcessWebhookJob>) {
  const startTime = Date.now()
  const { userId, source, webhookData } = job.data

  try {
    QueueLogger.logJobStart(job, QUEUE_NAME)

    // Verify webhook signature (placeholder - actual verification would depend on source)
    // verifyWebhookSignature(source, webhookData)

    // Upsert data into source-specific tables
    await upsertWebhookData(userId, source, webhookData)

    // Fetch affected movements from DB (not from payload - CRITICAL!)
    const { rows: affectedMovements } = await query<{ id: string }>(
      `SELECT id FROM movements WHERE user_id = $1 AND provenance = $2 LIMIT 100`,
      [userId, source]
    )

    if (affectedMovements.length > 0) {
      // Reclassify affected movements only
      await reclassifyMovements(userId, affectedMovements.map((m) => m.id))

      // Update movement_tags for affected movements
      await updateMovementTags(userId, affectedMovements.map((m) => m.id))
    }

    // Invalidate forecast cache (set expiresAt to now)
    await query(
      `UPDATE forecast_cache SET expires_at = NOW() WHERE user_id = $1`,
      [userId]
    )

    log('webhook.processed', { userId, jobId: job.id, source, affectedMovements: affectedMovements.length }, 'queue')

    QueueLogger.logJobComplete(job, QUEUE_NAME, Date.now() - startTime)
    QueueLogger.logSlowJob(job, QUEUE_NAME, Date.now() - startTime, SLOW_JOB_THRESHOLD)

    return { jobId: job.id, status: 'complete', affectedMovements: affectedMovements.length }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log('webhook.error', { userId, jobId: job.id, source, error: errorMessage }, 'queue')
    QueueLogger.logJobFailed(
      job,
      QUEUE_NAME,
      error instanceof Error ? error : new Error(String(error)),
      job.attemptsMade + 1,
      job.opts.attempts || 3
    )

    throw error
  }
}

async function upsertWebhookData(userId: string, source: string, webhookData: Record<string, any>): Promise<void> {
  try {
    switch (source) {
      case 'plaid':
        // Plaid webhook data is typically handled by existing webhook handler
        // This is a placeholder for any additional processing
        log('webhook.plaid.upsert', { userId }, 'queue')
        break

      case 'qbo':
        // QBO webhook data upsert
        log('webhook.qbo.upsert', { userId }, 'queue')
        break

      case 'xero':
        // Xero webhook data upsert
        log('webhook.xero.upsert', { userId }, 'queue')
        break

      case 'stripe':
        // Stripe webhook data upsert
        log('webhook.stripe.upsert', { userId }, 'queue')
        break

      case 'shopify':
        // Shopify webhook data upsert
        log('webhook.shopify.upsert', { userId }, 'queue')
        break

      default:
        log('webhook.unknown_source', { userId, source }, 'queue')
    }
  } catch (error) {
    log('webhook.upsert.error', { userId, source, error: String(error) }, 'queue')
    throw error
  }
}

async function reclassifyMovements(userId: string, movementIds: string[]): Promise<void> {
  try {
    // Placeholder: In production, this would call the actual reclassification logic
    // from lib/movement-classify.ts or similar
    log('webhook.reclassify', { userId, movementCount: movementIds.length }, 'queue')
  } catch (error) {
    log('webhook.reclassify.error', { userId, error: String(error) }, 'queue')
    throw error
  }
}

async function updateMovementTags(userId: string, movementIds: string[]): Promise<void> {
  try {
    // Placeholder: In production, this would update tags for affected movements
    log('webhook.update_tags', { userId, movementCount: movementIds.length }, 'queue')
  } catch (error) {
    log('webhook.update_tags.error', { userId, error: String(error) }, 'queue')
    throw error
  }
}
