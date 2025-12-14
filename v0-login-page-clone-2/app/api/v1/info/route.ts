import { NextResponse } from "next/server"
import { API_VERSIONING_DOCS } from "@/lib/api-versioning"

/**
 * API version information endpoint
 * GET /api/v1/info
 */
export async function GET() {
  return NextResponse.json({
    version: "v1",
    status: "stable",
    documentation: {
      base: "https://docs.profitwise.app/api",
      versioning: "https://docs.profitwise.app/api/versioning",
      migration: "https://docs.profitwise.app/api/migration",
    },
    endpoints: {
      movements: "/api/v1/movements",
      entities: "/api/v1/entities",
      forecast: "/api/v1/forecast",
      brain: "/api/v1/brain",
      auth: "/api/v1/auth",
    },
    features: {
      rateLimit: true,
      requestTracking: true,
      performanceMetrics: true,
      versioning: true,
    },
    ...API_VERSIONING_DOCS,
  })
}
