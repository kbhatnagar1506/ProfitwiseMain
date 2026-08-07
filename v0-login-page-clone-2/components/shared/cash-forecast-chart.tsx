"use client"

import { money, pct } from "@/lib/dashboard-helpers"

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

interface CashForecastChartProps {
  data: ForecastData | null
  loading?: boolean
  error?: string | null
}

export function CashForecastChart({
  data,
  loading = false,
  error = null,
}: CashForecastChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-gray-400">
          <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          <span>Computing forecast...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-4 py-3">
        <p className="text-red-300 text-sm">{error}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
        <p className="text-gray-400 text-sm">No forecast data available.</p>
      </div>
    )
  }

  const confColor =
    data.confidence_score >= 90
      ? "text-emerald-400"
      : data.confidence_score >= 70
        ? "text-amber-400"
        : "text-red-400"

  const confBg =
    data.confidence_score >= 90
      ? "bg-emerald-500/10"
      : data.confidence_score >= 70
        ? "bg-amber-500/10"
        : "bg-red-500/10"

  return (
    <div className="space-y-6">
      {/* Forecast Confidence */}
      <div className={`border border-white/10 rounded-xl p-5 ${confBg}`}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Forecast Confidence</h3>
          <span className={`text-2xl font-bold tabular-nums ${confColor}`}>{Math.round(data.confidence_score)}%</span>
        </div>
        <div className="relative w-full h-2 bg-white/10 rounded-full overflow-hidden">
          <div
            className={`absolute left-0 top-0 h-full rounded-full transition-all ${
              data.confidence_score >= 90
                ? "bg-emerald-400"
                : data.confidence_score >= 70
                  ? "bg-amber-400"
                  : "bg-red-400"
            }`}
            style={{ width: `${Math.min(data.confidence_score, 100)}%` }}
          />
        </div>
        <div className="text-xs text-gray-400 mt-2">{data.confidence_label}</div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className="text-2xl font-bold text-emerald-400/90 tabular-nums">{money(data.expected_inflows)}</div>
          <div className="text-xs text-gray-400 mt-1">Expected Inflows</div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className="text-2xl font-bold text-zinc-400 tabular-nums">{money(data.expected_outflows)}</div>
          <div className="text-xs text-gray-400 mt-1">Expected Outflows</div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className={`text-2xl font-bold tabular-nums ${data.net_expected >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {data.net_expected >= 0 ? "+" : ""}
            {money(data.net_expected)}
          </div>
          <div className="text-xs text-gray-400 mt-1">Net Expected</div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className="text-2xl font-bold text-blue-400 tabular-nums">{data.horizon_days}</div>
          <div className="text-xs text-gray-400 mt-1">Forecast Horizon</div>
        </div>
      </div>

      {/* Risk Probabilities */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">Risk Probabilities</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="text-center">
            <div className={`text-2xl font-bold tabular-nums ${data.probability_negative_14d > 0.3 ? "text-red-400" : data.probability_negative_14d > 0.1 ? "text-amber-400" : "text-emerald-400"}`}>
              {pct(data.probability_negative_14d)}
            </div>
            <div className="text-xs text-gray-400 mt-1">P(Cash &lt; 0) in 14d</div>
          </div>
          <div className="text-center">
            <div className={`text-2xl font-bold tabular-nums ${data.probability_negative_30d > 0.3 ? "text-red-400" : data.probability_negative_30d > 0.1 ? "text-amber-400" : "text-emerald-400"}`}>
              {pct(data.probability_negative_30d)}
            </div>
            <div className="text-xs text-gray-400 mt-1">P(Cash &lt; 0) in 30d</div>
          </div>
          <div className="text-center">
            <div className={`text-2xl font-bold tabular-nums ${data.probability_above_start_30d > 0.7 ? "text-emerald-400" : data.probability_above_start_30d > 0.5 ? "text-amber-400" : "text-red-400"}`}>
              {pct(data.probability_above_start_30d)}
            </div>
            <div className="text-xs text-gray-400 mt-1">P(Cash &gt; Start) in 30d</div>
          </div>
        </div>
      </div>

      {/* Percentile Distribution */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">Percentile Distribution (30d)</h3>
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-400">P95 (Best Case)</span>
              <span className="text-xs font-semibold text-emerald-400 tabular-nums">{money(data.percentile_p95)}</span>
            </div>
            <div className="relative w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="absolute left-0 top-0 h-full bg-emerald-400 rounded-full" style={{ width: "100%" }} />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-400">P75</span>
              <span className="text-xs font-semibold text-blue-400 tabular-nums">{money(data.percentile_p75)}</span>
            </div>
            <div className="relative w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="absolute left-0 top-0 h-full bg-blue-400 rounded-full" style={{ width: "75%" }} />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-400">P50 (Median)</span>
              <span className="text-xs font-semibold text-white tabular-nums">{money(data.percentile_p50)}</span>
            </div>
            <div className="relative w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="absolute left-0 top-0 h-full bg-white rounded-full" style={{ width: "50%" }} />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-400">P25</span>
              <span className="text-xs font-semibold text-amber-400 tabular-nums">{money(data.percentile_p25)}</span>
            </div>
            <div className="relative w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="absolute left-0 top-0 h-full bg-amber-400 rounded-full" style={{ width: "25%" }} />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-400">P5 (Worst Case)</span>
              <span className="text-xs font-semibold text-red-400 tabular-nums">{money(data.percentile_p5)}</span>
            </div>
            <div className="relative w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="absolute left-0 top-0 h-full bg-red-400 rounded-full" style={{ width: "5%" }} />
            </div>
          </div>
        </div>
      </div>

      {/* Scenario Comparison */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">Scenario Comparison (30d)</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-emerald-500/10 border border-emerald-400/20 rounded-lg p-4 text-center">
            <div className="text-sm font-semibold text-emerald-400 mb-1">Aggressive</div>
            <div className="text-2xl font-bold text-emerald-400 tabular-nums">{money(data.scenario_aggressive_30d)}</div>
          </div>
          <div className="bg-blue-500/10 border border-blue-400/20 rounded-lg p-4 text-center">
            <div className="text-sm font-semibold text-blue-400 mb-1">Base</div>
            <div className="text-2xl font-bold text-blue-400 tabular-nums">{money(data.scenario_base_30d)}</div>
          </div>
          <div className="bg-red-500/10 border border-red-400/20 rounded-lg p-4 text-center">
            <div className="text-sm font-semibold text-red-400 mb-1">Conservative</div>
            <div className="text-2xl font-bold text-red-400 tabular-nums">{money(data.scenario_conservative_30d)}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
