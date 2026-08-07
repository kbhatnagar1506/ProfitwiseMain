import Redis from 'redis'

const WARNING_THRESHOLD = 0.8 // 80%

export class RedisMonitor {
  private client: Redis.RedisClient | null = null
  private monitorInterval: NodeJS.Timeout | null = null

  async connect(redisConfig: { host: string; port: number; password?: string }) {
    this.client = Redis.createClient({
      host: redisConfig.host,
      port: redisConfig.port,
      password: redisConfig.password,
    })

    this.client.on('error', (err) => {
      console.error('[RedisMonitor] Redis client error:', err)
    })

    return new Promise<void>((resolve, reject) => {
      this.client!.on('ready', () => {
        console.log('[RedisMonitor] Connected to Redis')
        resolve()
      })
      this.client!.on('error', reject)
    })
  }

  start() {
    if (!this.client) {
      console.warn('[RedisMonitor] Redis client not connected, skipping monitor')
      return
    }

    // Monitor Redis memory every 30 seconds
    this.monitorInterval = setInterval(() => {
      this.checkMemoryUsage()
    }, 30000)
  }

  stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval)
      this.monitorInterval = null
    }

    if (this.client) {
      this.client.quit()
      this.client = null
    }
  }

  private checkMemoryUsage() {
    if (!this.client) return

    this.client.info('memory', (err, info) => {
      if (err) {
        console.error('[RedisMonitor] Failed to get Redis info:', err)
        return
      }

      const lines = info.split('\r\n')
      const memoryUsed = this.parseRedisInfo(lines, 'used_memory')
      const memoryMax = this.parseRedisInfo(lines, 'maxmemory')

      if (memoryUsed && memoryMax) {
        const usagePercent = (memoryUsed / memoryMax) * 100
        console.log(
          `[RedisMonitor] Memory usage: ${this.formatBytes(memoryUsed)}/${this.formatBytes(memoryMax)} (${usagePercent.toFixed(1)}%)`
        )

        if (usagePercent > WARNING_THRESHOLD * 100) {
          console.warn(
            `⚠️ REDIS MEMORY TRAP: ${usagePercent.toFixed(1)}% of max memory used`,
            `Verify job payloads are small (< 1KB each) and not passing raw data`
          )
        }
      }
    })
  }

  private parseRedisInfo(lines: string[], key: string): number | null {
    const line = lines.find((l) => l.startsWith(key))
    if (!line) return null
    const value = line.split(':')[1]
    return value ? parseInt(value, 10) : null
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }
}
