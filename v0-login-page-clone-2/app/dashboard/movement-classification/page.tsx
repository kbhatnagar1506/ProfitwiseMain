"use client"

import { useState, useEffect } from "react"
import { MovementClassificationTable } from "@/components/shared/movement-classification-table"

interface Movement {
  id: string
  occurred_at: string
  direction: "in" | "out"
  amount: number
  raw_description: string | null
  movement_class: string
  confidence: number
  needs_review: boolean
}

interface MovementClassificationResponse {
  movements: Movement[]
}

export default function MovementClassificationPage() {
  const [data, setData] = useState<MovementClassificationResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch("/api/dashboard/movement-classification")
        if (!response.ok) {
          throw new Error("Failed to fetch movements")
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
        <h1 className="text-3xl font-bold text-white mb-2">Movement Classification</h1>
        <p className="text-gray-400">Every transaction classified and tagged: P&L impact, economic class, cashflow bucket, and counterparty role.</p>
      </div>

      <MovementClassificationTable
        movements={data?.movements || []}
        loading={loading}
        error={error}
      />
    </div>
  )
}
