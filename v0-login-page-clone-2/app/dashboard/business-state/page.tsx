"use client"

import { useState, useEffect } from "react"
import { BusinessStateDisplay } from "@/components/shared/business-state-display"

interface BusinessStateData {
  revenue: {
    period_start: string
    period_end: string
    gross_revenue: number
    contra_revenue: number
    net_revenue: number
    customer_count: number
    avg_receipt: number
    top_customer_pct: number
    repeat_revenue_ratio: number
    revenue_by_customer: { entity_id: string | null; name: string; total: number; count: number }[]
  }
  spend: {
    period_start: string
    period_end: string
    total_opex: number
    total_cogs: number
    total_spend: number
    payroll: number
    recurring_obligations: number
    top_vendor_pct: number
    vendor_count: number
    spend_by_vendor: { entity_id: string | null; name: string; total: number; count: number; pct_of_spend: number }[]
  }
  liquidity: {
    period_start: string
    period_end: string
    ending_cash: number
    period_net_cash_flow: number
    operating_inflows: number
    operating_outflows: number
    net_operating: number
    financing_inflows: number
    financing_outflows: number
    net_financing: number
    owner_inflows: number
    owner_outflows: number
    net_owner: number
    liquidity_regime: "strong" | "stable" | "tightening"
    runway_days: number | null
    burn_rate: number
    period_days: number
  }
  risk: {
    liquidity_risk: { level: "low" | "medium" | "high"; score: number; reason: string }
    concentration_risk: { level: "low" | "medium" | "high"; score: number; reason: string }
    dependency_risk: { level: "low" | "medium" | "high"; score: number; reason: string }
    anomaly_risk: { level: "low" | "medium" | "high"; score: number; reason: string }
    uncertainty_risk: { level: "low" | "medium" | "high"; score: number; reason: string }
    overall: "low" | "medium" | "high"
    overall_score: number
  }
  state_confidence: {
    revenue_confidence: number
    spend_confidence: number
    liquidity_confidence: number
  }
  insight_block?: string
  computed_at?: string
}

export default function BusinessStatePage() {
  const [data, setData] = useState<BusinessStateData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch("/api/dashboard/business-state")
        if (!response.ok) {
          throw new Error("Failed to fetch business state")
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
        <h1 className="text-3xl font-bold text-white mb-2">Business State</h1>
        <p className="text-gray-400">Real-time financial health: revenue, spend, liquidity, and risk signals all in one view.</p>
      </div>

      <BusinessStateDisplay data={data} loading={loading} error={error} />
    </div>
  )
}
