"use client"

import { useState, useEffect } from "react"
import {
  X, RefreshCw, TrendingUp, TrendingDown, Minus, Clock, Calendar,
  DollarSign, AlertTriangle, Sparkles, Shield, Activity, Users,
  Building2, ChevronDown, ChevronUp, BarChart3,
} from "lucide-react"

type EntityProfile = {
  entity_id: string
  entity_type: "customer" | "vendor" | null
  archetype: string | null
  transaction_count: number
  avg_days_to_pay: number | null
  std_days_to_pay: number | null
  on_time_payment_rate: number | null
  early_payment_rate: number | null
  avg_payment_amount: number | null
  std_transaction_amount: number | null
  largest_transaction: number | null
  smallest_transaction: number | null
  avg_interval_days: number | null
  interval_cv: number | null
  transactions_per_month: number | null
  lifetime_value: number | null
  outstanding_amount: number | null
  overdue_amount: number | null
  reliability_score: number
  risk_score: number | null
  risk_factors: string[] | null
  recent_trend: string | null
  amount_trend: string | null
  peak_months: number[] | null
  low_months: number[] | null
  month_weights: number[] | null
  first_transaction_date: string | null
  last_transaction_date: string | null
  days_since_last_transaction: number | null
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
  entity: { id: string; canonical_name: string; display_name: string | null; entity_type: string; domain: string | null }
  profile: EntityProfile
  narratives: EntityNarratives | null
  transactions: EntityTransaction[]
}

function fmt(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "$0"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount)
}

function fmtCompact(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "$0"
  if (Math.abs(amount) >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`
  if (Math.abs(amount) >= 1000) return `$${(amount / 1000).toFixed(1)}K`
  return `$${amount.toFixed(0)}`
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return `${(value * 100).toFixed(0)}%`
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function getArchetypeConfig(archetype: string | null) {
  const c: Record<string, { label: string; color: string; bg: string; desc: string }> = {
    clockwork: { label: "Clockwork", color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", desc: "Highly consistent payment patterns" },
    slow_reliable: { label: "Reliable", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", desc: "Reliable but longer payment cycles" },
    bursty: { label: "Bursty", color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20", desc: "Irregular timing, active overall" },
    volatile: { label: "Volatile", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20", desc: "Unpredictable payment behavior" },
    low_data: { label: "New", color: "text-gray-400", bg: "bg-gray-500/10 border-gray-500/20", desc: "Limited transaction history" },
  }
  return c[archetype || ""] || { label: "Unknown", color: "text-gray-400", bg: "bg-gray-500/10 border-gray-500/20", desc: "" }
}

const RISK_LABELS: Record<string, string> = {
  payment_slowing: "Payment times increasing",
  amount_declining: "Transaction amounts declining",
  low_on_time_rate: "Low on-time payment rate",
  high_timing_variance: "Highly variable timing",
  frequency_dropping: "Transaction frequency dropping",
}

export function EntityDetailPremium({ entityId, onClose }: { entityId: string; onClose: () => void }) {
  const [data, setData] = useState<EntityDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [showAllTxns, setShowAllTxns] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/entities/${entityId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [entityId])

  const refresh = () => {
    setRefreshing(true)
    fetch(`/api/entities/${entityId}?refresh_narratives=true`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setData(d) })
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="relative ml-auto w-full max-w-lg bg-gray-950 border-l border-gray-800 flex items-center justify-center">
          <div className="w-10 h-10 rounded-full border-2 border-gray-700 border-t-emerald-500 animate-spin" />
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="fixed inset-0 z-50 flex">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="relative ml-auto w-full max-w-lg bg-gray-950 border-l border-gray-800 p-6">
          <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-lg hover:bg-gray-800"><X className="w-5 h-5 text-gray-400" /></button>
          <p className="text-gray-500 mt-16 text-center">Entity not found</p>
        </div>
      </div>
    )
  }

  const { entity, profile, narratives, transactions } = data
  const archetype = getArchetypeConfig(profile.archetype)
  const isCustomer = profile.entity_type === "customer"
  const visibleTxns = showAllTxns ? transactions : transactions.slice(0, 8)

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-lg bg-gray-950 border-l border-gray-800 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-gray-950/90 backdrop-blur-xl border-b border-gray-800/50 p-5">
          <div className={`absolute top-0 left-0 right-0 h-1 ${isCustomer ? "bg-gradient-to-r from-emerald-500 via-emerald-400 to-teal-500" : "bg-gradient-to-r from-violet-500 via-purple-400 to-fuchsia-500"}`} />
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${isCustomer ? "bg-emerald-500/10 text-emerald-400" : "bg-violet-500/10 text-violet-400"}`}>
                {isCustomer ? <Users className="w-6 h-6" /> : <Building2 className="w-6 h-6" />}
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">{entity.display_name || entity.canonical_name}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded border ${archetype.bg} ${archetype.color}`}>
                    {archetype.label}
                  </span>
                  <span className="text-xs text-gray-500">{isCustomer ? "Customer" : "Vendor"}</span>
                  {profile.first_transaction_date && (
                    <span className="text-xs text-gray-600">since {new Date(profile.first_transaction_date).toLocaleDateString("en-US", { month: "short", year: "numeric" })}</span>
                  )}
                </div>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-800 transition-colors"><X className="w-5 h-5 text-gray-400" /></button>
          </div>
        </div>

        <div className="p-5 space-y-5">
          {/* AI Insight Card */}
          {narratives && (
            <div className="relative rounded-xl bg-gradient-to-br from-violet-500/5 via-gray-900/50 to-fuchsia-500/5 border border-violet-500/10 p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-400">
                  <Sparkles className="w-3.5 h-3.5" />
                  AI Analysis
                </div>
                <button onClick={refresh} disabled={refreshing} className="text-[10px] text-gray-500 hover:text-gray-300 flex items-center gap-1 transition-colors">
                  <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
                  {refreshing ? "Analyzing..." : "Refresh"}
                </button>
              </div>
              <p className="text-sm text-gray-200 leading-relaxed">{narratives.ai_summary}</p>
              {narratives.ai_forecast_notes && (
                <div className="mt-3 pt-3 border-t border-violet-500/10">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Forecast Signal</p>
                  <p className="text-xs text-gray-400 leading-relaxed">{narratives.ai_forecast_notes}</p>
                </div>
              )}
            </div>
          )}

          {/* Financial Summary */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: "Lifetime", value: fmtCompact(profile.lifetime_value), color: "text-white" },
              { label: isCustomer ? "AR" : "AP", value: fmtCompact(profile.outstanding_amount), color: (profile.outstanding_amount || 0) > 0 ? (isCustomer ? "text-emerald-400" : "text-amber-400") : "text-gray-400" },
              { label: "Overdue", value: fmtCompact(profile.overdue_amount), color: (profile.overdue_amount || 0) > 0 ? "text-red-400" : "text-gray-400" },
              { label: "Risk", value: !profile.risk_score ? "—" : profile.risk_score > 0.6 ? "High" : profile.risk_score > 0.4 ? "Med" : "Low", color: !profile.risk_score ? "text-gray-400" : profile.risk_score > 0.6 ? "text-red-400" : profile.risk_score > 0.4 ? "text-amber-400" : "text-emerald-400" },
            ].map((s) => (
              <div key={s.label} className="rounded-xl bg-gray-800/40 border border-gray-700/30 p-3 text-center">
                <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Behavior + Forecast Grid */}
          <div className="grid grid-cols-2 gap-3">
            {/* Payment Behavior */}
            <div className="rounded-xl bg-gray-800/40 border border-gray-700/30 p-4">
              <h3 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Payment Behavior</h3>
              <div className="space-y-3">
                {[
                  { icon: <Clock className="w-3.5 h-3.5 text-gray-500" />, label: "Days to pay", value: profile.avg_days_to_pay != null ? `${profile.avg_days_to_pay.toFixed(0)}d` : "—", sub: profile.std_days_to_pay != null ? `±${profile.std_days_to_pay.toFixed(0)}d` : "" },
                  { icon: <Shield className="w-3.5 h-3.5 text-gray-500" />, label: "On-time", value: pct(profile.on_time_payment_rate), sub: "" },
                  { icon: <Activity className="w-3.5 h-3.5 text-gray-500" />, label: "Frequency", value: profile.transactions_per_month != null ? `${profile.transactions_per_month.toFixed(1)}/mo` : "—", sub: "" },
                  { icon: <BarChart3 className="w-3.5 h-3.5 text-gray-500" />, label: "Transactions", value: String(profile.transaction_count), sub: "" },
                ].map((r) => (
                  <div key={r.label} className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-xs text-gray-400">{r.icon}{r.label}</span>
                    <span className="text-xs font-medium text-white">{r.value} {r.sub && <span className="text-gray-500">{r.sub}</span>}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Forecast Features */}
            <div className="rounded-xl bg-gray-800/40 border border-gray-700/30 p-4">
              <h3 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Forecast Features</h3>
              <div className="space-y-3">
                {[
                  { label: "Archetype", value: archetype.label, color: archetype.color },
                  { label: "Reliability", value: `${(profile.reliability_score * 100).toFixed(0)}%`, color: profile.reliability_score > 0.7 ? "text-emerald-400" : profile.reliability_score > 0.4 ? "text-amber-400" : "text-red-400" },
                  { label: "Avg amount", value: fmtCompact(profile.avg_payment_amount), color: "text-white" },
                  { label: "Trend", value: profile.amount_trend || "stable", color: profile.amount_trend === "increasing" ? "text-emerald-400" : profile.amount_trend === "decreasing" ? "text-red-400" : "text-gray-300" },
                ].map((r) => (
                  <div key={r.label} className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">{r.label}</span>
                    <span className={`text-xs font-medium capitalize ${r.color}`}>{r.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Reliability Bar */}
          <div className="rounded-xl bg-gray-800/40 border border-gray-700/30 p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400">Reliability Score</span>
              <span className={`text-sm font-bold ${profile.reliability_score > 0.7 ? "text-emerald-400" : profile.reliability_score > 0.4 ? "text-amber-400" : "text-red-400"}`}>
                {(profile.reliability_score * 100).toFixed(0)}%
              </span>
            </div>
            <div className="h-2 bg-gray-700/50 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${profile.reliability_score > 0.7 ? "bg-gradient-to-r from-emerald-500 to-teal-400" : profile.reliability_score > 0.4 ? "bg-gradient-to-r from-amber-500 to-yellow-400" : "bg-gradient-to-r from-red-500 to-orange-400"}`}
                style={{ width: `${profile.reliability_score * 100}%` }}
              />
            </div>
            <p className="text-[10px] text-gray-500 mt-1.5">{archetype.desc}</p>
          </div>

          {/* Risk Factors */}
          {profile.risk_factors && profile.risk_factors.length > 0 && (
            <div className="rounded-xl bg-red-500/5 border border-red-500/15 p-4">
              <h3 className="text-[10px] font-semibold text-red-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> Risk Signals
              </h3>
              <div className="space-y-2">
                {profile.risk_factors.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-red-300">
                    <span className="w-1.5 h-1.5 bg-red-400 rounded-full flex-shrink-0" />
                    {RISK_LABELS[f] || f.replace(/_/g, " ")}
                  </div>
                ))}
              </div>
              {narratives?.ai_risk_explanation && (
                <p className="text-xs text-gray-400 mt-3 pt-3 border-t border-red-500/10 italic">{narratives.ai_risk_explanation}</p>
              )}
            </div>
          )}

          {/* Seasonality */}
          {profile.month_weights && profile.month_weights.length === 12 && profile.month_weights.some((w) => Math.abs(w - 1) > 0.2) && (
            <div className="rounded-xl bg-gray-800/40 border border-gray-700/30 p-4">
              <h3 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Seasonality</h3>
              <div className="flex items-end gap-1 h-16">
                {profile.month_weights.map((w, i) => {
                  const maxW = Math.max(...(profile.month_weights || [1]))
                  const heightPct = maxW > 0 ? (w / maxW) * 100 : 50
                  const isPeak = profile.peak_months?.includes(i + 1)
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1">
                      <div
                        className={`w-full rounded-t transition-all ${isPeak ? "bg-gradient-to-t from-emerald-600 to-emerald-400" : "bg-gray-600/50"}`}
                        style={{ height: `${Math.max(4, heightPct)}%` }}
                      />
                      <span className={`text-[8px] ${isPeak ? "text-emerald-400 font-semibold" : "text-gray-500"}`}>{MONTHS[i].charAt(0)}</span>
                    </div>
                  )
                })}
              </div>
              {profile.peak_months && profile.peak_months.length > 0 && (
                <p className="text-[10px] text-gray-500 mt-2">Peak: {profile.peak_months.map((m) => MONTHS[m - 1]).join(", ")}</p>
              )}
            </div>
          )}

          {/* Transaction History */}
          <div className="rounded-xl bg-gray-800/40 border border-gray-700/30 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-700/30">
              <h3 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Transaction History</h3>
            </div>
            {transactions.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">No transactions recorded</p>
            ) : (
              <>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-700/30 text-[10px] text-gray-500 uppercase tracking-wider">
                      <th className="text-left font-medium px-4 py-2">Date</th>
                      <th className="text-left font-medium px-4 py-2">Type</th>
                      <th className="text-right font-medium px-4 py-2">Amount</th>
                      <th className="text-right font-medium px-4 py-2">DTP</th>
                      <th className="text-center font-medium px-4 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTxns.map((t) => (
                      <tr key={t.id} className="border-b border-gray-800/30 last:border-0 hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-2.5 text-gray-300">{new Date(t.transaction_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
                        <td className="px-4 py-2.5 text-gray-400 capitalize">{t.transaction_type}</td>
                        <td className="px-4 py-2.5 text-right text-white font-medium">{fmt(t.amount)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-400">{t.days_to_pay != null ? `${t.days_to_pay}d` : "—"}</td>
                        <td className="px-4 py-2.5 text-center">
                          {t.was_on_time === true && <span className="inline-block w-5 h-5 rounded-full bg-emerald-500/10 text-emerald-400 leading-5 text-[10px]">✓</span>}
                          {t.was_on_time === false && <span className="inline-block w-5 h-5 rounded-full bg-red-500/10 text-red-400 leading-5 text-[10px]">✗</span>}
                          {t.was_on_time === null && <span className="text-gray-600">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {transactions.length > 8 && (
                  <button
                    onClick={() => setShowAllTxns(!showAllTxns)}
                    className="w-full flex items-center justify-center gap-1 py-2.5 text-xs text-gray-400 hover:text-white hover:bg-gray-800/30 transition-colors border-t border-gray-700/30"
                  >
                    {showAllTxns ? <><ChevronUp className="w-3 h-3" /> Show less</> : <><ChevronDown className="w-3 h-3" /> Show all {transactions.length} transactions</>}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
