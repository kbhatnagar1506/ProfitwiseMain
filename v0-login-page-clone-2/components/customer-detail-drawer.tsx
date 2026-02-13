"use client"

import { useEffect, useState, useRef } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Search,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Minus,
  ShieldCheck,
  ShieldAlert,
  CircleDollarSign,
  Calendar,
  Clock,
  BarChart2,
  Zap,
  RefreshCw,
  ChevronRight,
} from "lucide-react"
import { CustomerSearchResults } from "./customer-search-results"

interface Customer {
  id: string
  canonical_name: string
  display_name: string | null
  entity_type: "customer" | "vendor"
  transaction_count: number
  lifetime_value: number
  ar_balance: number
  overdue_balance: number
  reliability_score: number
  archetype: string
  last_transaction_date: string | null
  metadata?: Record<string, any>
  avg_days_to_pay: number
  std_days_to_pay: number
  on_time_payment_rate: number
  early_payment_rate: number
  payment_count: number
  avg_payment_amount: number
  std_transaction_amount: number
  amount_trend: "increasing" | "decreasing" | "stable"
  transactions_per_month: number
  avg_interval_days: number
  interval_cv: number
  peak_months: number[]
  low_months: number[]
  risk_score: number
  risk_factors: string[]
  forecast_uncertainty: "low" | "medium" | "high"
  forecast_notes: string
}

interface AISummary {
  summary: string
  paymentBehavior: string
  riskAssessment: string
  seasonality: string
  trends: string
  recommendations: string[]
  contractContext: string
  generatedAt: string
}

interface CustomerDetailDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  customer: Customer | null
}

function formatCurrency(amount: number): string {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`
  return `$${amount.toFixed(0)}`
}

function formatDate(dateString: string | null): string {
  if (!dateString) return "—"
  try {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  } catch {
    return dateString
  }
}

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

function getArchetypeStyle(archetype: string) {
  const styles: Record<string, { badge: string; dot: string }> = {
    Clockwork:  { badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/25", dot: "bg-emerald-400" },
    Bursty:     { badge: "bg-blue-500/15 text-blue-300 border-blue-500/25",          dot: "bg-blue-400"    },
    Volatile:   { badge: "bg-orange-500/15 text-orange-300 border-orange-500/25",    dot: "bg-orange-400"  },
    "At-Risk":  { badge: "bg-red-500/15 text-red-300 border-red-500/25",             dot: "bg-red-400"     },
    Strategic:  { badge: "bg-violet-500/15 text-violet-300 border-violet-500/25",    dot: "bg-violet-400"  },
    Seasonal:   { badge: "bg-amber-500/15 text-amber-300 border-amber-500/25",       dot: "bg-amber-400"   },
    New:        { badge: "bg-neutral-500/15 text-neutral-300 border-neutral-500/25", dot: "bg-neutral-400" },
  }
  return styles[archetype] || styles.New
}

function getRiskColor(score: number) {
  if (score < 0.3) return { bar: "bg-emerald-500", text: "text-emerald-400", label: "Low" }
  if (score < 0.6) return { bar: "bg-amber-500",   text: "text-amber-400",   label: "Medium" }
  return                 { bar: "bg-red-500",       text: "text-red-400",     label: "High" }
}

function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-1 w-full bg-white/[0.06] rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${color}`}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold mb-3">
      {children}
    </p>
  )
}

function Row({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
      <span className="text-[12px] text-neutral-500">{label}</span>
      <span className={`text-[12px] font-medium ${accent ? "text-white" : "text-neutral-300"}`}>
        {value}
      </span>
    </div>
  )
}

export function CustomerDetailDrawer({
  open,
  onOpenChange,
  customer,
}: CustomerDetailDrawerProps) {
  const [aiSummary, setAiSummary] = useState<AISummary | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const prevCustomerId = useRef<string | null>(null)

  useEffect(() => {
    if (open && customer && customer.id !== prevCustomerId.current) {
      prevCustomerId.current = customer.id
      setAiSummary(null)
      setAiError(null)
      setSearchQuery("")
      generateAISummary(customer.id)
    }
    if (!open) {
      prevCustomerId.current = null
    }
  }, [open, customer?.id])

  const generateAISummary = async (id: string) => {
    setAiLoading(true)
    setAiError(null)
    try {
      const res = await fetch(`/api/dashboard/customer-detail/${id}/ai-summary`, { method: "POST" })
      if (!res.ok) throw new Error("Failed")
      setAiSummary(await res.json())
    } catch {
      setAiError("AI summary unavailable")
    } finally {
      setAiLoading(false)
    }
  }

  if (!customer) return null

  const name = customer.display_name || customer.canonical_name
  const archetypeStyle = getArchetypeStyle(customer.archetype)
  const riskStyle = getRiskColor(customer.risk_score)
  const TrendIcon =
    customer.amount_trend === "increasing" ? TrendingUp :
    customer.amount_trend === "decreasing" ? TrendingDown : Minus
  const trendColor =
    customer.amount_trend === "increasing" ? "text-emerald-400" :
    customer.amount_trend === "decreasing" ? "text-red-400" : "text-neutral-500"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="bg-[#0a0a0a] border-l border-white/[0.07] w-full sm:max-w-[520px] p-0 overflow-y-auto shadow-[-24px_0_48px_rgba(0,0,0,0.6)] backdrop-blur-sm"
        aria-describedby={undefined}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[#0a0a0a]/95 backdrop-blur-sm border-b border-white/[0.07] px-6 py-4">
          <SheetHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <SheetTitle className="text-white text-[17px] font-semibold leading-tight truncate">
                  {name}
                </SheetTitle>
                <div className="flex items-center gap-2 mt-1.5">
                  <Badge className={`text-[10px] h-4.5 px-1.5 border ${archetypeStyle.badge}`}>
                    {customer.archetype}
                  </Badge>
                  {customer.overdue_balance > 0 && (
                    <Badge className="text-[10px] h-4.5 px-1.5 bg-red-500/15 text-red-300 border border-red-500/25">
                      {formatCurrency(customer.overdue_balance)} overdue
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </SheetHeader>
        </div>

        <div className="px-6 py-5 space-y-7">

          {/* KPI Hero Row */}
          <div className="grid grid-cols-3 gap-2.5">
            {[
              { label: "Lifetime Value", value: formatCurrency(customer.lifetime_value), color: "text-emerald-400" },
              { label: "Open AR",        value: formatCurrency(customer.ar_balance),     color: customer.ar_balance > 0 ? "text-amber-400" : "text-neutral-500" },
              { label: "Reliability",    value: `${customer.reliability_score}%`,        color: "text-white" },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3.5">
                <p className="text-[9px] text-neutral-500 uppercase tracking-widest font-semibold">{label}</p>
                <p className={`text-[18px] font-bold mt-1.5 tabular-nums leading-none ${color}`}>{value}</p>
              </div>
            ))}
          </div>

          {/* AI Summary */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-3.5 h-3.5 text-violet-400" />
              <SectionLabel>AI Intelligence</SectionLabel>
              {aiSummary && !aiLoading && (
                <button
                  onClick={() => { setAiSummary(null); generateAISummary(customer.id) }}
                  className="ml-auto text-neutral-600 hover:text-neutral-400 transition-colors"
                  title="Regenerate"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              )}
            </div>

            {aiLoading ? (
              <div className="space-y-2.5">
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-2">
                  <div className="flex items-center gap-2 mb-3">
                    <Sparkles className="w-3.5 h-3.5 text-violet-400 animate-pulse" />
                    <span className="text-[11px] text-violet-400/70">Analyzing {name}…</span>
                  </div>
                  <Skeleton className="h-3 w-full bg-white/[0.06]" />
                  <Skeleton className="h-3 w-5/6 bg-white/[0.06]" />
                  <Skeleton className="h-3 w-4/5 bg-white/[0.06]" />
                </div>
              </div>
            ) : aiError ? (
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                <p className="text-[12px] text-neutral-500">{aiError}</p>
              </div>
            ) : aiSummary ? (
              <div className="space-y-2.5">
                {/* Summary pill */}
                {aiSummary.summary && (
                  <div className="bg-violet-500/[0.07] border border-violet-500/[0.15] rounded-xl p-4">
                    <p className="text-[12.5px] text-neutral-200 leading-relaxed">{aiSummary.summary}</p>
                  </div>
                )}

                {/* Behavior + Risk side-by-side */}
                <div className="grid grid-cols-2 gap-2.5">
                  {aiSummary.paymentBehavior && (
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3.5">
                      <p className="text-[9px] text-neutral-500 uppercase tracking-widest font-semibold mb-2">Payment Behavior</p>
                      <p className="text-[11.5px] text-neutral-300 leading-relaxed">{aiSummary.paymentBehavior}</p>
                    </div>
                  )}
                  {aiSummary.riskAssessment && (
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3.5">
                      <p className="text-[9px] text-neutral-500 uppercase tracking-widest font-semibold mb-2">Risk Assessment</p>
                      <p className="text-[11.5px] text-neutral-300 leading-relaxed">{aiSummary.riskAssessment}</p>
                    </div>
                  )}
                </div>

                {/* Trends + Seasonality side-by-side */}
                {(aiSummary.trends || aiSummary.seasonality) && (
                  <div className="grid grid-cols-2 gap-2.5">
                    {aiSummary.trends && (
                      <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3.5">
                        <p className="text-[9px] text-neutral-500 uppercase tracking-widest font-semibold mb-2">Trends</p>
                        <p className="text-[11.5px] text-neutral-300 leading-relaxed">{aiSummary.trends}</p>
                      </div>
                    )}
                    {aiSummary.seasonality && (
                      <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3.5">
                        <p className="text-[9px] text-neutral-500 uppercase tracking-widest font-semibold mb-2">Seasonality</p>
                        <p className="text-[11.5px] text-neutral-300 leading-relaxed">{aiSummary.seasonality}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Contract context */}
                {aiSummary.contractContext && (
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3.5">
                    <p className="text-[9px] text-neutral-500 uppercase tracking-widest font-semibold mb-2">Contract Context</p>
                    <p className="text-[11.5px] text-neutral-300 leading-relaxed">{aiSummary.contractContext}</p>
                  </div>
                )}

                {/* Recommendations */}
                {aiSummary.recommendations?.length > 0 && (
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3.5">
                    <p className="text-[9px] text-neutral-500 uppercase tracking-widest font-semibold mb-3">Action Items</p>
                    <div className="space-y-2">
                      {aiSummary.recommendations.map((rec, i) => (
                        <div key={i} className="flex items-start gap-2.5">
                          <div className="w-4 h-4 rounded-full bg-violet-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <span className="text-[8px] text-violet-400 font-bold">{i + 1}</span>
                          </div>
                          <p className="text-[11.5px] text-neutral-300 leading-relaxed">{rec}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          {/* Search */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Search className="w-3.5 h-3.5 text-neutral-500" />
              <SectionLabel>Intelligent Search</SectionLabel>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-600" />
              <Input
                type="text"
                placeholder="Search transactions, invoices, documents…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9 bg-white/[0.03] border border-white/[0.07] text-neutral-300 text-[12px] placeholder:text-neutral-600 focus-visible:ring-0 focus-visible:border-white/20"
              />
            </div>
            {searchQuery.length > 1 && (
              <div className="mt-2">
                <CustomerSearchResults customerId={customer.id} query={searchQuery} />
              </div>
            )}
          </div>

          {/* Risk Profile */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              {customer.risk_score > 0.5
                ? <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                : <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              }
              <SectionLabel>Risk Profile</SectionLabel>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-neutral-400">Risk Score</span>
                <span className={`text-[12px] font-semibold ${riskStyle.text}`}>
                  {riskStyle.label} · {(customer.risk_score * 100).toFixed(0)}%
                </span>
              </div>
              <ScoreBar value={customer.risk_score} color={riskStyle.bar} />

              {customer.risk_factors?.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  {customer.risk_factors.map((factor, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <div className="w-1 h-1 rounded-full bg-amber-400/60 mt-1.5 flex-shrink-0" />
                      <span className="text-[11px] text-neutral-400">{factor}</span>
                    </div>
                  ))}
                </div>
              )}

              {customer.risk_factors?.length === 0 && (
                <p className="text-[11px] text-neutral-500">No risk factors identified</p>
              )}
            </div>
          </div>

          {/* Payment Metrics */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-3.5 h-3.5 text-neutral-500" />
              <SectionLabel>Payment Metrics</SectionLabel>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
              <div className="px-4 py-1">
                <Row
                  label="Avg Days to Pay"
                  value={
                    customer.avg_days_to_pay === 0 && customer.std_days_to_pay === 0
                      ? "—"
                      : `${customer.avg_days_to_pay < 0 ? "" : ""}${customer.avg_days_to_pay.toFixed(0)}d ±${customer.std_days_to_pay.toFixed(0)}`
                  }
                  accent
                />
                <Row
                  label="On-Time Rate"
                  value={
                    customer.on_time_payment_rate
                      ? <span className="text-emerald-400">{(customer.on_time_payment_rate * 100).toFixed(0)}%</span>
                      : "—"
                  }
                />
                <Row
                  label="Early Payment Rate"
                  value={
                    customer.early_payment_rate
                      ? <span className="text-blue-400">{(customer.early_payment_rate * 100).toFixed(0)}%</span>
                      : "—"
                  }
                />
                <Row
                  label="Avg Transaction"
                  value={customer.avg_payment_amount ? formatCurrency(customer.avg_payment_amount) : "—"}
                />
                <Row
                  label="Amount Trend"
                  value={
                    <span className={`flex items-center gap-1 ${trendColor}`}>
                      <TrendIcon className="w-3 h-3" />
                      {customer.amount_trend}
                    </span>
                  }
                />
                <Row
                  label="Transactions / Month"
                  value={customer.transactions_per_month ? customer.transactions_per_month.toFixed(1) : "—"}
                />
              </div>
            </div>
          </div>

          {/* Seasonality */}
          {(customer.peak_months?.length > 0 || customer.low_months?.length > 0) && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Calendar className="w-3.5 h-3.5 text-neutral-500" />
                <SectionLabel>Seasonality</SectionLabel>
              </div>
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <div className="grid grid-cols-12 gap-1 mb-3">
                  {MONTH_ABBR.map((m, i) => {
                    const monthNum = i + 1
                    const isPeak = customer.peak_months?.includes(monthNum)
                    const isLow = customer.low_months?.includes(monthNum)
                    return (
                      <div key={m} className="text-center">
                        <div
                          className={`w-full aspect-square rounded text-[7px] flex items-center justify-center font-medium transition-colors ${
                            isPeak ? "bg-emerald-500/30 text-emerald-300" :
                            isLow  ? "bg-red-500/20 text-red-400" :
                            "bg-white/[0.04] text-neutral-600"
                          }`}
                        >
                          {m.slice(0, 1)}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-sm bg-emerald-500/30" />
                    <span className="text-[10px] text-neutral-500">Peak months</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-sm bg-red-500/20" />
                    <span className="text-[10px] text-neutral-500">Low months</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Transaction Profile */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <BarChart2 className="w-3.5 h-3.5 text-neutral-500" />
              <SectionLabel>Transaction Profile</SectionLabel>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
              <div className="px-4 py-1">
                <Row label="Total Transactions" value={customer.transaction_count} accent />
                <Row label="Archetype" value={
                  <Badge className={`text-[10px] px-1.5 py-0 border ${archetypeStyle.badge}`}>
                    {customer.archetype}
                  </Badge>
                } />
                <Row label="Last Active" value={formatDate(customer.last_transaction_date)} />
                <Row
                  label="Avg Interval"
                  value={customer.avg_interval_days ? `${customer.avg_interval_days.toFixed(0)} days` : "—"}
                />
                <Row
                  label="Regularity (CV)"
                  value={
                    customer.interval_cv
                      ? <span className={customer.interval_cv < 0.5 ? "text-emerald-400" : customer.interval_cv < 1 ? "text-amber-400" : "text-red-400"}>
                          {customer.interval_cv < 0.5 ? "Very Regular" : customer.interval_cv < 1 ? "Moderate" : "Irregular"}
                        </span>
                      : "—"
                  }
                />
              </div>
            </div>
          </div>

        </div>
      </SheetContent>
    </Sheet>
  )
}
