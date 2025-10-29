"use client"

import { useState, useEffect } from "react"
import { X, RefreshCw, TrendingUp, TrendingDown, Minus, Calendar, DollarSign, Clock, AlertTriangle } from "lucide-react"

type EntityProfile = {
  entity_id: string
  entity_type: "customer" | "vendor" | null
  archetype: string | null
  transaction_count: number
  avg_days_to_pay: number | null
  std_days_to_pay: number | null
  on_time_payment_rate: number | null
  avg_payment_amount: number | null
  lifetime_value: number | null
  outstanding_amount: number | null
  overdue_amount: number | null
  reliability_score: number
  risk_score: number | null
  risk_factors: string[] | null
  recent_trend: string | null
  peak_months: number[] | null
  month_weights: number[] | null
  first_transaction_date: string | null
  last_transaction_date: string | null
}

type EntityTransaction = {
  id: string
  transaction_type: string
  direction: string | null
  amount: number
  transaction_date: string
  days_to_pay: number | null
  was_on_time: boolean | null
}

type EntityNarratives = {
  ai_summary: string
  ai_forecast_notes: string
  ai_risk_explanation: string
}

type EntityDetail = {
  entity: {
    id: string
    canonical_name: string
    display_name: string | null
    entity_type: string
    domain: string | null
  }
  profile: EntityProfile
  narratives: EntityNarratives | null
  transactions: EntityTransaction[]
}

function formatCurrency(amount: number | null): string {
  if (amount === null || amount === undefined) return "$0"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatPercent(value: number | string | null): string {
  if (value === null || value === undefined) return "—"
  const num = typeof value === "string" ? parseFloat(value) : value
  if (isNaN(num)) return "—"
  return `${(num * 100).toFixed(0)}%`
}

function getRiskColor(riskScore: number | null): string {
  if (riskScore === null) return "text-gray-400"
  if (riskScore > 0.6) return "text-red-400"
  if (riskScore > 0.4) return "text-yellow-400"
  return "text-green-400"
}

function getRiskLabel(riskScore: number | null): string {
  if (riskScore === null) return "Unknown"
  if (riskScore > 0.6) return "High"
  if (riskScore > 0.4) return "Moderate"
  return "Low"
}

function getArchetypeLabel(archetype: string | null): string {
  const labels: Record<string, string> = {
    clockwork: "CLOCKWORK",
    slow_reliable: "SLOW RELIABLE",
    bursty: "BURSTY",
    volatile: "VOLATILE",
    low_data: "LOW DATA",
  }
  return archetype ? labels[archetype] || archetype.toUpperCase() : "—"
}

function getArchetypeColor(archetype: string | null): string {
  const colors: Record<string, string> = {
    clockwork: "bg-green-500/20 text-green-400",
    slow_reliable: "bg-blue-500/20 text-blue-400",
    bursty: "bg-yellow-500/20 text-yellow-400",
    volatile: "bg-red-500/20 text-red-400",
    low_data: "bg-gray-500/20 text-gray-400",
  }
  return archetype ? colors[archetype] || "bg-gray-500/20 text-gray-400" : "bg-gray-500/20 text-gray-400"
}

function TrendIcon({ trend }: { trend: string | null }) {
  if (trend === "improving" || trend === "accelerating") {
    return <TrendingUp className="w-4 h-4 text-green-400" />
  }
  if (trend === "deteriorating" || trend === "decelerating") {
    return <TrendingDown className="w-4 h-4 text-red-400" />
  }
  return <Minus className="w-4 h-4 text-gray-400" />
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function EntityDetailPanel({
  entityId,
  onClose,
}: {
  entityId: string
  onClose: () => void
}) {
  const [data, setData] = useState<EntityDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshingNarratives, setRefreshingNarratives] = useState(false)

  useEffect(() => {
    async function fetchEntity() {
      setLoading(true)
      try {
        const res = await fetch(`/api/entities/${entityId}`)
        if (res.ok) {
          const json = await res.json()
          setData(json)
        }
      } catch (e) {
        console.error("Failed to fetch entity:", e)
      } finally {
        setLoading(false)
      }
    }
    fetchEntity()
  }, [entityId])

  const refreshNarratives = async () => {
    setRefreshingNarratives(true)
    try {
      const res = await fetch(`/api/entities/${entityId}?refresh_narratives=true`)
      if (res.ok) {
        const json = await res.json()
        setData(json)
      }
    } catch (e) {
      console.error("Failed to refresh narratives:", e)
    } finally {
      setRefreshingNarratives(false)
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-y-0 right-0 w-[480px] bg-gray-900 border-l border-gray-800 shadow-xl z-50 flex items-center justify-center">
        <RefreshCw className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="fixed inset-y-0 right-0 w-[480px] bg-gray-900 border-l border-gray-800 shadow-xl z-50 p-4">
        <div className="flex justify-end">
          <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded">
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>
        <div className="text-center text-gray-500 mt-8">Entity not found</div>
      </div>
    )
  }

  const { entity, profile, narratives, transactions } = data

  return (
    <div className="fixed inset-y-0 right-0 w-[480px] bg-gray-900 border-l border-gray-800 shadow-xl z-50 overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 bg-gray-900 border-b border-gray-800 p-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-white">
                {entity.display_name || entity.canonical_name}
              </h2>
              <span className={`text-[10px] px-2 py-0.5 rounded ${getArchetypeColor(profile.archetype)}`}>
                {getArchetypeLabel(profile.archetype)}
              </span>
            </div>
            <div className="text-xs text-gray-400 mt-0.5">
              {profile.entity_type === "customer" ? "Customer" : "Vendor"}
              {profile.first_transaction_date && ` · Since ${new Date(profile.first_transaction_date).toLocaleDateString()}`}
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded">
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* AI Insight */}
        {narratives && (
          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-gray-400">AI INSIGHT</span>
              <button
                onClick={refreshNarratives}
                disabled={refreshingNarratives}
                className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
              >
                <RefreshCw className={`w-3 h-3 ${refreshingNarratives ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
            <p className="text-sm text-gray-200 leading-relaxed">
              {narratives.ai_summary}
            </p>
            {narratives.ai_forecast_notes && (
              <p className="text-xs text-gray-400 mt-2 italic">
                {narratives.ai_forecast_notes}
              </p>
            )}
          </div>
        )}

        {/* Financial Summary */}
        <div>
          <h3 className="text-xs font-medium text-gray-400 mb-2">FINANCIAL SUMMARY</h3>
          <div className="grid grid-cols-4 gap-2">
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-[10px] text-gray-500">Lifetime</div>
              <div className="text-sm font-medium text-white">{formatCurrency(profile.lifetime_value)}</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-[10px] text-gray-500">Outstanding</div>
              <div className="text-sm font-medium text-white">{formatCurrency(profile.outstanding_amount)}</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-[10px] text-gray-500">Overdue</div>
              <div className={`text-sm font-medium ${(profile.overdue_amount || 0) > 0 ? "text-red-400" : "text-white"}`}>
                {formatCurrency(profile.overdue_amount)}
              </div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-[10px] text-gray-500">Risk</div>
              <div className={`text-sm font-medium ${getRiskColor(profile.risk_score)}`}>
                {getRiskLabel(profile.risk_score)}
              </div>
            </div>
          </div>
        </div>

        {/* Payment Behavior */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <h3 className="text-xs font-medium text-gray-400 mb-2">PAYMENT BEHAVIOR</h3>
            <div className="bg-gray-800/50 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Avg days to pay
                </span>
                <span className="text-sm text-white">
                  {profile.avg_days_to_pay != null ? Number(profile.avg_days_to_pay).toFixed(0) : "—"}
                  {profile.std_days_to_pay != null && <span className="text-gray-500 text-xs"> ±{Number(profile.std_days_to_pay).toFixed(0)}</span>}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">On-time rate</span>
                <span className="text-sm text-white">{formatPercent(profile.on_time_payment_rate)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Transactions</span>
                <span className="text-sm text-white">{profile.transaction_count}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Trend</span>
                <span className="text-sm text-white flex items-center gap-1">
                  <TrendIcon trend={profile.recent_trend} />
                  {profile.recent_trend || "Stable"}
                </span>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-medium text-gray-400 mb-2">FORECAST FEATURES</h3>
            <div className="bg-gray-800/50 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Archetype</span>
                <span className="text-sm text-white">{getArchetypeLabel(profile.archetype)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Reliability</span>
                <span className="text-sm text-white">{(Number(profile.reliability_score) || 0).toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Avg amount</span>
                <span className="text-sm text-white">{formatCurrency(profile.avg_payment_amount)}</span>
              </div>
              {profile.peak_months && profile.peak_months.length > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-400">Peak months</span>
                  <span className="text-sm text-white">
                    {profile.peak_months.map((m) => MONTH_NAMES[m - 1]).join(", ")}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Risk Factors */}
        {profile.risk_factors && profile.risk_factors.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> RISK FACTORS
            </h3>
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <ul className="space-y-1">
                {profile.risk_factors.map((factor, i) => (
                  <li key={i} className="text-xs text-red-300 flex items-center gap-2">
                    <span className="w-1 h-1 bg-red-400 rounded-full" />
                    {factor.replace(/_/g, " ")}
                  </li>
                ))}
              </ul>
              {narratives?.ai_risk_explanation && (
                <p className="text-xs text-gray-400 mt-2 italic">
                  {narratives.ai_risk_explanation}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Seasonality */}
        {profile.month_weights && profile.month_weights.some((w) => w !== 1) && (
          <div>
            <h3 className="text-xs font-medium text-gray-400 mb-2">SEASONALITY</h3>
            <div className="bg-gray-800/50 rounded-lg p-3">
              <div className="flex items-end gap-1 h-12">
                {profile.month_weights.map((weight, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center">
                    <div
                      className="w-full bg-blue-500/50 rounded-t"
                      style={{ height: `${Math.min(100, weight * 50)}%` }}
                    />
                    <span className="text-[8px] text-gray-500 mt-1">{MONTH_NAMES[i].slice(0, 1)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Transaction History */}
        <div>
          <h3 className="text-xs font-medium text-gray-400 mb-2">TRANSACTION HISTORY</h3>
          <div className="bg-gray-800/50 rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left text-gray-500 font-medium px-3 py-2">Date</th>
                  <th className="text-left text-gray-500 font-medium px-3 py-2">Type</th>
                  <th className="text-right text-gray-500 font-medium px-3 py-2">Amount</th>
                  <th className="text-right text-gray-500 font-medium px-3 py-2">DTP</th>
                  <th className="text-center text-gray-500 font-medium px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {transactions.slice(0, 15).map((t) => (
                  <tr key={t.id} className="border-b border-gray-800 last:border-0">
                    <td className="px-3 py-2 text-gray-300">
                      {new Date(t.transaction_date).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 text-gray-400 capitalize">{t.transaction_type}</td>
                    <td className="px-3 py-2 text-right text-white">{formatCurrency(t.amount)}</td>
                    <td className="px-3 py-2 text-right text-gray-400">
                      {t.days_to_pay !== null ? `${t.days_to_pay}d` : "—"}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {t.was_on_time === true && <span className="text-green-400">✓</span>}
                      {t.was_on_time === false && <span className="text-red-400">✗</span>}
                      {t.was_on_time === null && <span className="text-gray-500">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {transactions.length === 0 && (
              <div className="text-center py-4 text-gray-500">No transactions</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
