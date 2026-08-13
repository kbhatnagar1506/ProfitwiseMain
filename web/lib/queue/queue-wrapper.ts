/**
 * Bull Queue Client Wrapper
 * 
 * This file provides a runtime-only interface to Bull queues.
 * It uses dynamic import to avoid being analyzed by Turbopack at build time.
 */

export async function getQueues() {
  // Use dynamic import to avoid bundling Bull at build time
  const module = await import('./bull-client')
  return module.queues
}

export async function addSyncInitialDataJob(userId: string) {
  const queues = await getQueues()
  const job = await queues.syncInitialData.add(
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
  return job
}

export async function addMatchCustomersJob(userId: string) {
  const queues = await getQueues()
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
  return job
}
