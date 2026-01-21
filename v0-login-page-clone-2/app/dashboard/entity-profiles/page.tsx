"use client"

import { useState, useEffect } from "react"
import { EntityProfilesSummary } from "@/components/shared/entity-profiles-summary"

interface EntityProfile {
  id: string
  entity_type: "customer" | "vendor"
  canonical_name: string
  display_name: string | null
  archetype: string | null
  transaction_count: number
  lifetime_value: number
}

interface EntityProfilesSummaryData {
  total_customers: number
  total_vendors: number
  total_lifetime_value: number
  at_risk_count: number
}

interface EntityProfilesResponse {
  summary: EntityProfilesSummaryData
  profiles: EntityProfile[]
}

export default function EntityProfilesPage() {
  const [data, setData] = useState<EntityProfilesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch("/api/dashboard/entity-profiles")
        if (!response.ok) {
          throw new Error("Failed to fetch entity profiles")
        }
        const result = await response.json()
        setData(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred")
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Entity Profiles</h1>
        <p className="text-gray-400">AI-powered customer and vendor intelligence with payment behavior analysis and risk scoring.</p>
      </div>

      <EntityProfilesSummary
        summary={data?.summary || null}
        profiles={data?.profiles || []}
        loading={loading}
        error={error}
      />
    </div>
  )
}
