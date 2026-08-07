import { PrismaClient } from '@prisma/client'

const MAX_CONNECTIONS = 500
const WARNING_THRESHOLD = 0.8 // 80%

export class ConnectionPoolMonitor {
  private prisma: PrismaClient
  private monitorInterval: NodeJS.Timeout | null = null

  constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  start() {
    // Monitor connection pool every 30 seconds
    this.monitorInterval = setInterval(() => {
      this.checkConnectionPool()
    }, 30000)
  }

  stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval)
      this.monitorInterval = null
    }
  }

  private async checkConnectionPool() {
    try {
      // Query to get current connection count
      const result = await this.prisma.$queryRaw<[{ count: number }]>`
        SELECT count(*) as count FROM pg_stat_activity WHERE datname = current_database()
      `

      const activeConnections = result[0]?.count || 0
      const usagePercent = (activeConnections / MAX_CONNECTIONS) * 100

      console.log(`[ConnectionPool] Active connections: ${activeConnections}/${MAX_CONNECTIONS} (${usagePercent.toFixed(1)}%)`)

      if (activeConnections > MAX_CONNECTIONS * WARNING_THRESHOLD) {
        console.warn(
          `⚠️ CONNECTION POOL CHOKEHOLD: ${activeConnections} connections (${usagePercent.toFixed(1)}% of max)`,
          `Consider reducing Bull concurrency or scaling database connections`
        )
      }
    } catch (error) {
      console.error('[ConnectionPool] Failed to check connection pool:', error)
    }
  }
}
