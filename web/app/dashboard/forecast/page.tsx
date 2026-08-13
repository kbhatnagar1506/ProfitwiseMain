"use client"

import { useState, useEffect } from "react"
import { CashForecastChart } from "@/components/shared/cash-forecast-chart"

interface ForecastData {
  confidence_score: number
  confidence_label: string
  horizon_days: number
  expected_inflows: number
  expected_outflows: number
  net_expected: number
  low_point_cash: number
  low_point_day: number
  probability_negative_14d: number
  probability_negative_30d: number
  probability_above_start_30d: number
  percentile_p5: number
  percentile_p25: number
  percentile_p50: number
  percentile_p75: number
  percentile_p95: number
  scenario_aggressive_30d: number
  scenario_base_30d: number
  scenario_conservative_30d: number
}

export default function ForecastPage() {
  const [data, setData] = useState<ForecastData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch("/api/dashboard/forecast")
        if (!response.ok) {
          throw new Error("Failed to fetch forecast data")
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
        <h1 className="text-3xl font-bold text-white mb-2">Cash Forecast</h1>
        <p className="text-gray-400">Simulate future cash based on behavioral component models, not simple time-series prediction.</p>
      </div>

      <CashForecastChart data={data} loading={loading} error={error} />
    </div>
  )
}
