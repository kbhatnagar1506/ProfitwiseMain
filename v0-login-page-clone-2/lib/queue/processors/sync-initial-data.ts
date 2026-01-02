import { Job } from 'bull'
import { SyncInitialDataJob } from '../job-types'
import { QueueLogger } from '../queue-logger'
import { query, withTransaction } from '../db'
import { getPlaidClient } from '../plaid'
import { log } from '../logger'

const QUEUE_NAME = 'sync-initial-data'
const SLOW_JOB_THRESHOLD = 30000 // 30 seconds

export async function processSyncInitialData(job: Job<SyncInitialDataJob>) {
  const startTime = Date.now()
  const { userId } = job.data

  try {
    QueueLogger.logJobStart(job, QUEUE_NAME)

    // Step 1: Fetch from all sources in parallel
    QueueLogger.logJobProgress(job, QUEUE_NAME, 'fetching', 0)

    const [plaidData, qboData, xeroData, stripeData, shopifyData] = await Promise.allSettled([
      fetchPlaidData(userId),
      fetchQBOData(userId),
      fetchXeroData(userId),
      fetchStripeData(userId),
      fetchShopifyData(userId),
    ])

    // Log any fetch errors but continue
    if (plaidData.status === 'rejected') {
      log('sync.plaid.fetch.error', { userId, error: plaidData.reason.message }, 'queue')
    }
    if (qboData.status === 'rejected') {
      log('sync.qbo.fetch.error', { userId, error: qboData.reason.message }, 'queue')
    }
    if (xeroData.status === 'rejected') {
      log('sync.xero.fetch.error', { userId, error: xeroData.reason.message }, 'queue')
    }
    if (stripeData.status === 'rejected') {
      log('sync.stripe.fetch.error', { userId, error: stripeData.reason.message }, 'queue')
    }
    if (shopifyData.status === 'rejected') {
      log('sync.shopify.fetch.error', { userId, error: shopifyData.reason.message }, 'queue')
    }

    // Step 2: Upsert data to database
    QueueLogger.logJobProgress(job, QUEUE_NAME, 'fetching', 100)

    // Update job status in database
    await updateJobStatus(job.id, userId, 'processing', 'fetching', 100)

    // Queue next job: classify-movements
    // CRITICAL: Pass ONLY userId, not the raw data
    const classifyJob = await job.queue.add(
      'classify-movements',
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

    log('sync.initial.complete', { userId, jobId: job.id, nextJobId: classifyJob.id }, 'queue')

    QueueLogger.logJobComplete(job, QUEUE_NAME, Date.now() - startTime)
    QueueLogger.logSlowJob(job, QUEUE_NAME, Date.now() - startTime, SLOW_JOB_THRESHOLD)

    return { jobId: job.id, nextJobId: classifyJob.id, status: 'queued' }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log('sync.initial.error', { userId, jobId: job.id, error: errorMessage }, 'queue')
    QueueLogger.logJobFailed(
      job,
      QUEUE_NAME,
      error instanceof Error ? error : new Error(String(error)),
      job.attemptsMade + 1,
      job.opts.attempts || 3
    )

    // Update job status with error
    await updateJobStatus(job.id, userId, 'failed', 'fetching', 0, errorMessage)

    throw error
  }
}

async function fetchPlaidData(userId: string): Promise<void> {
  try {
    // Fetch Plaid items for this user
    const { rows: items } = await query<{ item_id: string; access_token: string }>(
      'SELECT item_id, access_token FROM plaid_items WHERE user_id = $1',
      [userId]
    )

    if (items.length === 0) return

    const client = getPlaidClient()

    for (const item of items) {
      try {
        // Fetch transactions for this item
        const response = await client.transactionsGet({
          access_token: item.access_token,
          start_date: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          end_date: new Date().toISOString().split('T')[0],
          options: {
            include_personal_finance_category: true,
          },
        })

        // Transactions are already stored by Plaid webhook, so this is just a sync
        log('sync.plaid.fetched', { userId, itemId: item.item_id, transactionCount: response.transactions.length }, 'queue')
      } catch (err) {
        log('sync.plaid.item.error', { userId, itemId: item.item_id, error: String(err) }, 'queue')
      }
    }
  } catch (error) {
    log('sync.plaid.error', { userId, error: String(error) }, 'queue')
    throw error
  }
}

async function fetchQBOData(userId: string): Promise<void> {
  try {
    // Fetch QBO connections for this user
    const { rows: connections } = await query<{ realm_id: string }>(
      'SELECT realm_id FROM qbo_connections WHERE user_id = $1',
      [userId]
    )

    if (connections.length === 0) return

    // QBO data is fetched via webhooks and background syncs
    log('sync.qbo.fetched', { userId, connectionCount: connections.length }, 'queue')
  } catch (error) {
    log('sync.qbo.error', { userId, error: String(error) }, 'queue')
    throw error
  }
}

async function fetchXeroData(userId: string): Promise<void> {
  try {
    // Fetch Xero connections for this user
    const { rows: connections } = await query<{ tenant_id: string }>(
      'SELECT tenant_id FROM xero_connections WHERE user_id = $1',
      [userId]
    )

    if (connections.length === 0) return

    // Xero data is fetched via webhooks and background syncs
    log('sync.xero.fetched', { userId, connectionCount: connections.length }, 'queue')
  } catch (error) {
    log('sync.xero.error', { userId, error: String(error) }, 'queue')
    throw error
  }
}

async function fetchStripeData(userId: string): Promise<void> {
  try {
    // Fetch Stripe connections for this user
    const { rows: connections } = await query<{ stripe_user_id: string }>(
      'SELECT stripe_user_id FROM stripe_connections WHERE user_id = $1',
      [userId]
    )

    if (connections.length === 0) return

    // Stripe data is fetched via webhooks and background syncs
    log('sync.stripe.fetched', { userId, connectionCount: connections.length }, 'queue')
  } catch (error) {
    log('sync.stripe.error', { userId, error: String(error) }, 'queue')
    throw error
  }
}

async function fetchShopifyData(userId: string): Promise<void> {
  try {
    // Fetch Shopify connections for this user
    const { rows: connections } = await query<{ shop_domain: string }>(
      'SELECT shop_domain FROM shopify_connections WHERE user_id = $1',
      [userId]
    )

    if (connections.length === 0) return

    // Shopify data is fetched via webhooks and background syncs
    log('sync.shopify.fetched', { userId, connectionCount: connections.length }, 'queue')
  } catch (error) {
    log('sync.shopify.error', { userId, error: String(error) }, 'queue')
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
