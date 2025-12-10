"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import type { CashflowForecast } from "@/lib/state/types"

function money(n: number): string {
  if (n === 0) return "$0"
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

function signedMoney(n: number): string {
  return n >= 0 ? `+${money(n)}` : money(n)
}

function cashDisplay(n: number): string {
  if (n < 0) return `-${money(Math.abs(n))}`
  return money(n)
}

export default function DashboardPage() {
  const router = useRouter()
  const [forecastData, setForecastData] = useState<CashflowForecast | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchForecast = async () => {
      try {
        setLoading(true)
        const res = await fetch("/api/forecast")
        if (!res.ok) {
          if (res.status === 401) {
            router.push("/onboarding")
            return
          }
          throw new Error("Failed to load forecast")
        }
        const data = await res.json()
        setForecastData(data)
        setError(null)

        // Start polling for enriched data
        if (process.env.NEXT_PUBLIC_FORECAST_LLM_ENABLED) {
          let pollCount = 0
          const maxPolls = 60
          const pollInterval = setInterval(async () => {
            pollCount++
            try {
              const enrichedRes = await fetch("/api/forecast", { method: "POST" })
              if (enrichedRes.ok) {
                const enrichedData = await enrichedRes.json()
                if (enrichedData.ready && enrichedData.enriched_interventions) {
                  clearInterval(pollInterval)
                  setForecastData((prev) =>
                    prev
                      ? {
                          ...prev,
                          enriched_interventions: enrichedData.enriched_interventions,
                          ranked_strategies: enrichedData.ranked_strategies,
                          execution_plans: enrichedData.execution_plans,
                          intervention_anomalies: enrichedData.intervention_anomalies,
                        }
                      : null
                  )
                }
              }
            } catch (err) {
              // Silently fail
            }
            if (pollCount >= maxPolls) {
              clearInterval(pollInterval)
            }
          }, 5000)

          return () => clearInterval(pollInterval)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load forecast")
        setLoading(false)
      }
    }

    fetchForecast()
  }, [router])

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-black flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block">
            <div className="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin"></div>
          </div>
          <p className="text-gray-400 text-sm mt-4">Loading forecast...</p>
        </div>
      </div>
    )
  }

  if (error || !forecastData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-black flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 text-sm mb-4">{error || "No forecast data available"}</p>
          <button
            onClick={() => router.push("/onboarding")}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Back to Onboarding
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-black">
      {/* Header */}
      <div className="border-b border-cyan-500/20 bg-black/40 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Cashflow Forecast</h1>
            <p className="text-xs text-gray-500 mt-1">
              {forecastData.period_start} • {forecastData.forecast_horizon_months} month projection
            </p>
          </div>
          <button
            onClick={() => router.push("/onboarding")}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Edit
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          {/* Confidence */}
          <div className="bg-gradient-to-br from-cyan-500/10 to-cyan-600/5 border border-cyan-500/20 rounded-xl p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2">Forecast Confidence</div>
            <div className="text-3xl font-bold text-cyan-400">{(forecastData.forecast_confidence * 100).toFixed(0)}%</div>
            <div className="text-xs text-gray-400 mt-2">
              {forecastData.forecast_confidence >= 0.7
                ? "High confidence"
                : forecastData.forecast_confidence >= 0.4
                  ? "Medium confidence"
                  : "Low confidence"}
            </div>
          </div>

          {/* Low Point */}
          <div className="bg-gradient-to-br from-red-500/10 to-red-600/5 border border-red-500/20 rounded-xl p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2">Lowest Cash Point</div>
            <div className={`text-3xl font-bold ${forecastData.daily_simulation.min_cash < 0 ? "text-red-400" : "text-emerald-400"}`}>
              {cashDisplay(Math.round(forecastData.daily_simulation.min_cash))}
            </div>
            <div className="text-xs text-gray-400 mt-2">Day {forecastData.daily_simulation.min_cash_day}</div>
          </div>

          {/* Stress Probability */}
          <div className="bg-gradient-to-br from-amber-500/10 to-amber-600/5 border border-amber-500/20 rounded-xl p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2">Stress Probability</div>
            <div className="text-3xl font-bold text-amber-400">{(forecastData.monte_carlo.prob_below_zero_30d * 100).toFixed(0)}%</div>
            <div className="text-xs text-gray-400 mt-2">Chance of negative cash</div>
          </div>

          {/* Runway */}
          <div className="bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border border-emerald-500/20 rounded-xl p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2">Cash Runway</div>
            <div className="text-3xl font-bold text-emerald-400">
              {forecastData.cash_runway.months_until_depletion !== null
                ? `${forecastData.cash_runway.months_until_depletion.toFixed(1)}mo`
                : "∞"}
            </div>
            <div className="text-xs text-gray-400 mt-2">Until depletion</div>
          </div>
        </div>

        {/* Daily Simulation Chart */}
        <div className="bg-gradient-to-br from-slate-800/40 to-slate-900/20 border border-cyan-500/20 rounded-xl p-6 mb-8">
          <h2 className="text-lg font-bold text-white mb-4">Daily Cash Position (30 days)</h2>
          <div className="h-64 bg-black/20 rounded-lg flex items-end justify-between gap-1 p-4">
            {forecastData.daily_simulation.daily_positions.slice(0, 30).map((pos, idx) => {
              const maxCash = Math.max(...forecastData.daily_simulation.daily_positions.slice(0, 30).map((p) => p.cash))
              const minCash = Math.min(...forecastData.daily_simulation.daily_positions.slice(0, 30).map((p) => p.cash))
              const range = maxCash - minCash || 1
              const normalized = (pos.cash - minCash) / range
              const height = Math.max(normalized * 100, 2)
              const isNegative = pos.cash < 0

              return (
                <div
                  key={idx}
                  className="flex-1 rounded-t transition-all hover:opacity-80 cursor-pointer group relative"
                  style={{
                    height: `${height}%`,
                    backgroundColor: isNegative ? "rgb(239, 68, 68)" : "rgb(34, 197, 94)",
                  }}
                  title={`Day ${idx + 1}: ${cashDisplay(Math.round(pos.cash))}`}
                >
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                    {cashDisplay(Math.round(pos.cash))}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-4">
            <span>Day 1</span>
            <span>Day 30</span>
          </div>
        </div>

        {/* Scenarios */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {forecastData.scenarios.map((scenario) => (
            <div
              key={scenario.scenario}
              className={`border rounded-xl p-6 ${
                scenario.scenario === "base"
                  ? "bg-gradient-to-br from-cyan-500/5 to-cyan-600/5 border-cyan-500/20"
                  : scenario.scenario === "optimistic"
                    ? "bg-gradient-to-br from-emerald-500/5 to-emerald-600/5 border-emerald-500/20"
                    : "bg-gradient-to-br from-red-500/5 to-red-600/5 border-red-500/20"
              }`}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className={`text-sm font-semibold uppercase tracking-wider ${
                    scenario.scenario === "base"
                      ? "text-cyan-400"
                      : scenario.scenario === "optimistic"
                        ? "text-emerald-400"
                        : "text-red-400"
                  }`}>
                    {scenario.scenario} case
                  </h3>
                  <p className="text-xs text-gray-500 mt-1">{scenario.label}</p>
                </div>
                <div className="text-right">
                  <div className={`text-2xl font-bold font-mono ${scenario.ending_cash >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {signedMoney(scenario.ending_cash)}
                  </div>
                  <div className="text-xs text-gray-500">ending cash</div>
                </div>
              </div>

              {scenario.runway_months !== null && (
                <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                  <div className="text-xs text-red-400 font-semibold">⚠ Runway Warning</div>
                  <div className="text-xs text-gray-400 mt-1">
                    Cash runs out in ~{scenario.runway_months} month{scenario.runway_months !== 1 ? "s" : ""}
                  </div>
                </div>
              )}

              {/* Monthly table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-white/10">
                      <th className="text-left py-2 pr-3">Month</th>
                      <th className="text-right py-2 px-2">Inflows</th>
                      <th className="text-right py-2 px-2">Outflows</th>
                      <th className="text-right py-2 pl-2">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scenario.months.slice(0, 6).map((m) => (
                      <tr key={m.month} className="border-b border-white/5">
                        <td className="py-2 pr-3 text-gray-400 font-mono text-xs">{m.month}</td>
                        <td className="py-2 px-2 text-right text-emerald-400 font-mono">{money(m.inflows)}</td>
                        <td className="py-2 px-2 text-right text-red-400 font-mono">{money(m.outflows)}</td>
                        <td className={`py-2 pl-2 text-right font-mono font-semibold ${m.net >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                          {signedMoney(m.net)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>

        {/* Top Actions */}
        {forecastData.interventions && forecastData.interventions.length > 0 && (
          <div className="bg-gradient-to-br from-slate-800/40 to-slate-900/20 border border-cyan-500/20 rounded-xl p-6 mb-8">
            <h2 className="text-lg font-bold text-white mb-4">Top Actions (by impact)</h2>
            <div className="space-y-3">
              {(forecastData.enriched_interventions ?? forecastData.interventions).slice(0, 5).map((iv, idx) => {
                const enriched = iv as any
                return (
                  <div key={iv.id} className="bg-black/20 border border-cyan-500/10 rounded-lg p-4 hover:border-cyan-500/30 transition-colors">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <span className="text-xs bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-bold w-6 h-6 rounded-full flex items-center justify-center">
                          #{idx + 1}
                        </span>
                        <div>
                          <div className="text-sm font-bold text-white">{iv.label}</div>
                          {enriched.feasibility_score != null && (
                            <div className="flex items-center gap-2 mt-1">
                              <div className="w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    enriched.feasibility_score >= 0.7
                                      ? "bg-emerald-500"
                                      : enriched.feasibility_score >= 0.4
                                        ? "bg-amber-500"
                                        : "bg-red-500"
                                  }`}
                                  style={{ width: `${enriched.feasibility_score * 100}%` }}
                                ></div>
                              </div>
                              <span className="text-[10px] text-gray-400">{(enriched.feasibility_score * 100).toFixed(0)}%</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-emerald-400 font-mono font-bold text-sm">+{money(iv.impact_cash_14d)}</div>
                        <div className="text-[10px] text-gray-500">@14d</div>
                      </div>
                    </div>
                    {enriched.ai_reasoning && (
                      <div className="text-xs text-gray-300 italic border-l-2 border-cyan-500/40 pl-3 py-1 bg-cyan-500/5 rounded-r">
                        {enriched.ai_reasoning}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Refresh Button */}
        <div className="flex justify-center mb-8">
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Refresh Forecast
          </button>
        </div>
      </div>
    </div>
  )
}
