import { Job } from 'bull'

const MAX_PAYLOAD_SIZE = 1024 // 1KB - alert if exceeded

export class QueueLogger {
  static logJobStart(job: Job, queueName: string) {
    const payloadSize = JSON.stringify(job.data).length
    
    if (payloadSize > MAX_PAYLOAD_SIZE) {
      console.warn(
        `⚠️ REDIS PAYLOAD TRAP: Job ${job.id} in ${queueName} has payload size ${payloadSize}B (max: ${MAX_PAYLOAD_SIZE}B)`,
        `This could cause Redis to run out of memory!`
      )
    }

    console.log(`[${queueName}] Job ${job.id} started`, {
      payloadSize: `${payloadSize}B`,
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts,
    })
  }

  static logJobProgress(job: Job, queueName: string, step: string, progress: number) {
    console.log(`[${queueName}] Job ${job.id} progress: ${step} (${progress}%)`)
  }

  static logJobComplete(job: Job, queueName: string, duration: number) {
    console.log(`[${queueName}] Job ${job.id} completed in ${duration}ms`)
  }

  static logJobFailed(job: Job, queueName: string, error: Error, attempt: number, maxAttempts: number) {
    console.error(
      `[${queueName}] Job ${job.id} failed (attempt ${attempt}/${maxAttempts}):`,
      error.message
    )
  }

  static logJobRetry(job: Job, queueName: string, attempt: number, maxAttempts: number) {
    console.log(`[${queueName}] Job ${job.id} retrying (attempt ${attempt}/${maxAttempts})`)
  }

  static logSlowJob(job: Job, queueName: string, duration: number, threshold: number) {
    if (duration > threshold) {
      console.warn(
        `⚠️ SLOW JOB: Job ${job.id} in ${queueName} took ${duration}ms (threshold: ${threshold}ms)`
      )
    }
  }
}
