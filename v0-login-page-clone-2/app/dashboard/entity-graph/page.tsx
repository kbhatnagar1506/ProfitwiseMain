"use client"

import { useState, useEffect } from "react"
import { EntityGraphDisplay } from "@/components/shared/entity-graph-display"

interface IdentityEntity {
  id: string
  entity_type: string
  canonical_name: string
  display_name: string | null
  domain: string | null
  confidence: number
  metadata: Record<string, unknown>
  created_at: string
  source_count: number
  evidence_count: number
  sources: string[]
}

interface IdentityAlias {
  id: string
  entity_id: string
  alias: string
  alias_type: string
  source: string
  source_id: string | null
  confidence: number
}

interface IdentityAssertionCount {
  entity_id: string
  assertion_type: string
  source: string
  count: number
  avg_score: number
}

interface EntityGraphResponse {
  entities: IdentityEntity[]
  aliases: IdentityAlias[]
  assertionCounts: IdentityAssertionCount[]
}

export default function EntityGraphPage() {
  const [data, setData] = useState<EntityGraphResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch("/api/dashboard/entity-graph")
        if (!response.ok) {
          throw new Error("Failed to fetch entity graph")
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
        <h1 className="text-3xl font-bold text-white mb-2">Entity Graph</h1>
        <p className="text-gray-400">See every vendor, customer, and entity we've resolved across all your connected sources.</p>
      </div>

      <EntityGraphDisplay
        entities={data?.entities || []}
        aliases={data?.aliases || []}
        assertionCounts={data?.assertionCounts || []}
        loading={loading}
        error={error}
      />
    </div>
  )
}
