"use client"

import { useState, useEffect, useCallback } from "react"
import { X, Search, ShieldAlert, ShieldCheck, Sparkles, BarChart2, Clock, Calendar } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { AreaChart, BarChart, Area, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from "recharts"

interface Vendor {
  id: string
  canonical_name: string
  display_name: string | null
  entity_type: "customer" | "vendor"
  transaction_count: number
  lifetime_value: number
  ar_balance: number
  overdue_balance: number
  reliability_score: number
  archetype: "Clockwork" | "Bursty" | "Volatile" | "New"
  last_transaction_date: string | null
  ai_insight: string | null
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

interface RecentTransaction {
  id: string
  date: string
  description: string
  amount: number
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—"
  const date = new Date(dateStr)
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-1.5 w-full bg-white/[0.06] rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${color}`}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] text-neutral-500 uppercase tracking-widest font-semibold">
      {children}
    </p>
  )
}

function Row({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-3 border-b border-white/[0.04] last:border-0">
      <span className="text-[13px] text-neutral-500 flex-shrink-0">{label}</span>
      <span className={`text-[13px] font-medium text-right ${accent ? "text-white" : "text-neutral-300"}`}>
        {value}
      </span>
    </div>
  )
}

function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean
  payload?: Array<{ value: number }>
  label?: string
  formatter?: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-[#1a1a1a] border border-white/[0.1] rounded-lg p-2 shadow-lg">
      <p className="text-[11px] text-neutral-400">{label}</p>
      <p className="text-[12px] font-semibold text-white">
        {formatter ? formatter(payload[0].value) : formatCurrency(payload[0].value)}
      </p>
    </div>
  )
}

const RISK_FACTOR_LABELS: Record<string, string> = {
  payment_slowing: "Payment timing is slowing down",
  high_variability: "High variability in payment timing",
  declining_volume: "Transaction volume is declining",
  increasing_overdue: "Overdue balance is increasing",
  missed_payments: "Missed or late payments",
  unusual_patterns: "Unusual payment patterns detected",
}

function formatRiskFactor(factor: string): string {
  return RISK_FACTOR_LABELS[factor] || factor
}

function getArchetypeStyle(archetype: string) {
  switch (archetype) {
    case "Clockwork":
      return { badge: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/25" }
    case "Bursty":
      return { badge: "bg-blue-500/15 text-blue-300 border border-blue-500/25" }
    case "Volatile":
      return { badge: "bg-amber-500/15 text-amber-300 border border-amber-500/25" }
    case "New":
      return { badge: "bg-zinc-500/15 text-zinc-300 border border-zinc-500/25" }
    default:
      return { badge: "bg-white/5 text-zinc-400 border border-white/10" }
  }
}

function getRiskColor(score: number) {
  if (score < 0.3) return { text: "text-emerald-400", bar: "bg-emerald-500" }
  if (score < 0.6) return { text: "text-amber-400", bar: "bg-amber-500" }
  return { text: "text-red-400", bar: "bg-red-500" }
}

export function VendorDetailDrawer({
  vendor,
  open,
  onOpenChange,
}: {
  vendor: Vendor | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [searchQuery, setSearchQuery] = useState("")
  const [transactions, setTransactions] = useState<RecentTransaction[]>([])
  const [amountSparkData, setAmountSparkData] = useState<Array<{ date: string; amount: number }>>([])
  const [monthlyData, setMonthlyData] = useState<Array<{ month: string; count: number }>>([])
  const [dtpData, setDtpData] = useState<Array<{ label: string; dtp: number }>>([])

  const riskScore = Math.min(1, (vendor?.risk_score ?? 0) / 100)
  const riskStyle = getRiskColor(riskScore)
  const archetypeStyle = getArchetypeStyle(vendor?.archetype || "")
  const name = vendor?.display_name || vendor?.canonical_name || ""

  const fetchTransactions = useCallback(async () => {
    if (!vendor?.id) return
    try {
      const response = await fetch(`/api/dashboard/vendor-detail/${vendor.id}`)
      if (!response.ok) return
      const data = await response.json()
      setTransactions(data.transactions || [])
      setAmountSparkData(data.amountSparkData || [])
      setMonthlyData(data.monthlyData || [])
      setDtpData(data.dtpData || [])
    } catch (err) {
      console.error("Failed to fetch vendor transactions:", err)
    }
  }, [vendor?.id])

  useEffect(() => {
    if (open && vendor?.id) {
      fetchTransactions()
    }
  }, [open, vendor?.id, fetchTransactions])

  if (!vendor) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="bg-[#0a0a0a] border border-white/[0.08] shadow-2xl fixed inset-0 m-[2.5vh_2.5vw] p-0 overflow-hidden flex flex-col rounded-2xl [&>button]:hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97] duration-200 !max-w-none"
      >
        {/* ── Header bar ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-white/[0.07] bg-[#0a0a0a] flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <DialogTitle className="text-white text-[20px] font-semibold leading-tight truncate">
              {name}
            </DialogTitle>
            <Badge className={`text-[10px] px-1.5 border flex-shrink-0 ${archetypeStyle.badge}`}>
              {vendor.archetype}
            </Badge>
            {vendor.overdue_balance > 0 && (
              <Badge className="text-[10px] px-1.5 bg-red-500/15 text-red-300 border border-red-500/25 flex-shrink-0">
                {formatCurrency(vendor.overdue_balance)} overdue
              </Badge>
            )}
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="flex items-center gap-1.5 text-neutral-600 hover:text-neutral-300 transition-colors flex-shrink-0 group"
          >
            <kbd className="text-[9px] border border-white/10 rounded px-1 py-0.5 font-mono group-hover:border-white/20 transition-colors">
              ESC
            </kbd>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Full-width search bar ───────────────────────────────────── */}
        <div className="flex-shrink-0 border-b border-white/[0.07] px-6 py-3">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
            <Input
              type="text"
              placeholder="Search transactions, invoices, documents… (AI-powered)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-10 bg-white/[0.03] border border-white/[0.07] text-neutral-200 text-[13px] placeholder:text-neutral-600 focus-visible:ring-0 focus-visible:border-white/25 rounded-xl"
            />
          </div>
        </div>

        {/* ── 3-column body ──────────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden grid min-h-0" style={{ gridTemplateColumns: "340px 1fr 360px" }}>

          {/* ── LEFT: Identity · Risk · AI Recommendations ──── */}
          <div className="overflow-y-auto p-5 space-y-5 border-r border-white/[0.06]">

            {/* Identity KPIs */}
            <div className="space-y-2">
              {[
                { label: "Lifetime Volume", value: formatCurrency(vendor.lifetime_value), color: "text-emerald-400" },
                { label: "Open AP",        value: formatCurrency(vendor.ar_balance),     color: vendor.ar_balance > 0 ? "text-amber-400" : "text-neutral-400" },
                { label: "Reliability",    value: `${vendor.reliability_score}%`,        color: "text-white" },
              ].map(({ label, value, color }) => (
                <div key={label} className={`bg-white/[0.03] border border-white/[0.06] border-l-2 rounded-xl p-4 ${color === "text-emerald-400" ? "border-l-emerald-500/60" : color === "text-amber-400" ? "border-l-amber-500/60" : "border-l-white/20"}`}>
                  <p className="text-[11px] text-neutral-500 uppercase tracking-widest font-semibold mb-2">{label}</p>
                  <p className={`text-[28px] font-bold tabular-nums leading-none ${color}`}>{value}</p>
                </div>
              ))}
            </div>

            {/* Risk Profile */}
            <div>
              <div className="flex items-center gap-2 mb-2.5 border-b border-white/[0.04] pb-2">
                {riskScore > 0.5
                  ? <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                  : <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                }
                <SectionLabel>Risk Profile</SectionLabel>
              </div>
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-neutral-400">Risk Score</span>
                  <span className={`text-[12px] font-semibold ${riskStyle.text}`}>
                    {riskStyle.text === "text-emerald-400" ? "Low" : riskStyle.text === "text-amber-400" ? "Medium" : "High"} · {(riskScore * 100).toFixed(0)}%
                  </span>
                </div>
                <ScoreBar value={riskScore} color={riskStyle.bar} />
                <div className="space-y-1.5 pt-1">
                  {vendor.risk_factors?.length > 0
                    ? vendor.risk_factors.map((f, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <div className="w-1 h-1 rounded-full bg-amber-400/60 mt-1.5 flex-shrink-0" />
                          <span className="text-[11px] text-neutral-400">{formatRiskFactor(f)}</span>
                        </div>
                      ))
                    : <p className="text-[11px] text-neutral-500">No risk factors identified</p>
                  }
                </div>
              </div>
            </div>

            {/* Action Items */}
            {vendor.forecast_notes && (
              <div>
                <div className="flex items-center gap-2 mb-2.5 border-b border-white/[0.04] pb-2">
                  <Sparkles className="w-3.5 h-3.5 text-violet-400" />
                  <SectionLabel>Action Items</SectionLabel>
                </div>
                <div className="bg-violet-500/[0.07] border border-violet-500/[0.15] rounded-xl p-4 space-y-2">
                  <p className="text-[12.5px] text-neutral-300 leading-relaxed">{vendor.forecast_notes}</p>
                </div>
              </div>
            )}

          </div>

          {/* ── CENTER: Charts & Trends ──────────────────────────────── */}
          <div className="overflow-y-auto p-5 space-y-5 border-r border-white/[0.06]">

            {/* Amount Sparkline */}
            {amountSparkData.length >= 3 && (
              <div>
                <div className="flex items-center gap-2 mb-2.5 border-b border-white/[0.04] pb-2">
                  <BarChart2 className="w-3.5 h-3.5 text-neutral-500" />
                  <SectionLabel>Transaction Amounts</SectionLabel>
                </div>
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                  <ResponsiveContainer width="100%" height={150}>
                    <AreaChart data={amountSparkData} margin={{ top: 2, right: 0, left: -28, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorAmount" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#525252" }} axisLine={false} tickLine={false} />
                      <YAxis hide />
                      <Tooltip content={({ active, payload, label }) => (
                        <ChartTooltip active={active} payload={payload as Array<{ value: number }>} label={label} formatter={formatCurrency} />
                      )} />
                      <Area type="monotone" dataKey="amount" stroke="#3b82f6" strokeWidth={1.5} fillOpacity={1} fill="url(#colorAmount)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Days to Pay Trend */}
            {dtpData.length >= 3 && (
              <div>
                <div className="flex items-center gap-2 mb-2.5 border-b border-white/[0.04] pb-2">
                  <Clock className="w-3.5 h-3.5 text-neutral-500" />
                  <SectionLabel>Days to Pay · Trend</SectionLabel>
                </div>
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                  <ResponsiveContainer width="100%" height={130}>
                    <BarChart data={dtpData} margin={{ top: 2, right: 0, left: -28, bottom: 0 }} barCategoryGap="25%">
                      <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#525252" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                      <YAxis hide />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.08)" strokeDasharray="3 3" />
                      <Tooltip content={({ active, payload, label }) => (
                        <ChartTooltip active={active} payload={payload as Array<{ value: number }>} label={label} formatter={(v) => `${v > 0 ? "+" : ""}${v}d vs avg`} />
                      )} />
                      <Bar dataKey="dtp" radius={[2, 2, 0, 0]}>
                        {dtpData.map((e, i) => (
                          <Cell key={i} fill={e.dtp <= 0 ? "#34d399" : e.dtp <= 7 ? "#fbbf24" : "#f87171"} fillOpacity={0.75} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="flex items-center gap-4 mt-2">
                    {[["bg-emerald-400/50","Early / on-time"],["bg-amber-400/50","≤7 days late"],["bg-red-400/50","Late"]].map(([bg, lbl]) => (
                      <div key={lbl} className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-sm ${bg}`} />
                        <span className="text-[10px] text-neutral-500">{lbl}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Seasonality */}
            {(vendor.peak_months?.length > 0 || vendor.low_months?.length > 0 || monthlyData.some(m => m.count > 0)) && (
              <div>
                <div className="flex items-center gap-2 mb-2.5 border-b border-white/[0.04] pb-2">
                  <Calendar className="w-3.5 h-3.5 text-neutral-500" />
                  <SectionLabel>Seasonality</SectionLabel>
                </div>
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-4">
                  {monthlyData.some(m => m.count > 0) && (
                    <div>
                      <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold mb-3">Monthly Activity</p>
                      <ResponsiveContainer width="100%" height={130}>
                        <BarChart data={monthlyData} margin={{ top: 2, right: 0, left: -28, bottom: 0 }} barCategoryGap="20%">
                          <XAxis dataKey="month" tick={{ fontSize: 9, fill: "#525252" }} axisLine={false} tickLine={false} />
                          <YAxis hide allowDecimals={false} />
                          <Tooltip content={({ active, payload, label }) => (
                            <ChartTooltip active={active} payload={payload as Array<{ value: number }>} label={label} formatter={(v) => `${v} txn${v !== 1 ? "s" : ""}`} />
                          )} />
                          <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                            {monthlyData.map((_, i) => {
                              const isLow = vendor.low_months?.includes(i + 1)
                              const isPeak = vendor.peak_months?.includes(i + 1)
                              return <Cell key={i} fill={isPeak ? "#3b82f6" : isLow ? "#525252" : "#6b7280"} fillOpacity={0.6} />
                            })}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  <div className="flex items-center gap-4 text-[10px]">
                    {vendor.peak_months?.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-sm bg-blue-500" />
                        <span className="text-neutral-500">Peak: {vendor.peak_months.map(m => ["J","F","M","A","M","J","J","A","S","O","N","D"][m-1]).join("")}</span>
                      </div>
                    )}
                    {vendor.low_months?.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-sm bg-zinc-600" />
                        <span className="text-neutral-500">Low: {vendor.low_months.map(m => ["J","F","M","A","M","J","J","A","S","O","N","D"][m-1]).join("")}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

          </div>

          {/* ── RIGHT: Payment Metrics · Transaction Profile · Recent Txns ──── */}
          <div className="overflow-y-auto p-5 space-y-5">

            {/* Payment Metrics */}
            <div>
              <div className="flex items-center gap-2 mb-2.5 border-b border-white/[0.04] pb-2">
                <Clock className="w-3.5 h-3.5 text-neutral-500" />
                <SectionLabel>Payment Metrics</SectionLabel>
              </div>
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-0">
                <Row label="Avg Days to Pay" value={`${Number(vendor.avg_days_to_pay ?? 0).toFixed(0)}d ±${Number(vendor.std_days_to_pay ?? 0).toFixed(0)}`} />
                <Row label="On-Time Rate" value={`${Number(vendor.on_time_payment_rate ?? 0).toFixed(0)}%`} accent />
                <Row label="Early Payment Rate" value={`${Number(vendor.early_payment_rate ?? 0).toFixed(0)}%`} />
                <Row label="Avg Transaction" value={formatCurrency(Number(vendor.avg_payment_amount ?? 0))} />
                <Row label="Amount Trend" value={vendor.amount_trend} />
                <Row label="Txns / Month" value={`${Number(vendor.transactions_per_month ?? 0).toFixed(1)}`} />
              </div>
            </div>

            {/* Transaction Profile */}
            <div>
              <div className="flex items-center gap-2 mb-2.5 border-b border-white/[0.04] pb-2">
                <BarChart2 className="w-3.5 h-3.5 text-neutral-500" />
                <SectionLabel>Transaction Profile</SectionLabel>
              </div>
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-0">
                <Row label="Total Transactions" value={vendor.transaction_count} />
                <Row label="Archetype" value={vendor.archetype} />
                <Row label="Last Active" value={formatDate(vendor.last_transaction_date)} />
                <Row label="Avg Interval" value={`${Number(vendor.avg_interval_days ?? 0).toFixed(0)}d`} />
                <Row label="Regularity (CV)" value={`${Number(vendor.interval_cv ?? 0).toFixed(1)}`} />
              </div>
            </div>

            {/* Recent Transactions */}
            {transactions.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2.5 border-b border-white/[0.04] pb-2">
                  <BarChart2 className="w-3.5 h-3.5 text-neutral-500" />
                  <SectionLabel>Recent Transactions</SectionLabel>
                </div>
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
                  {transactions.slice(0, 8).map((t) => (
                    <div key={t.id} className="flex items-center justify-between px-4 py-3 border-b border-white/[0.04] last:border-0">
                      <div className="min-w-0 mr-3">
                        <p className="text-[12px] text-neutral-300 truncate">{t.description || "Transaction"}</p>
                        <p className="text-[11px] text-neutral-600">{formatDate(t.date)}</p>
                      </div>
                      <span className="text-[12px] font-semibold text-white tabular-nums flex-shrink-0">{formatCurrency(t.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>

        </div>
      </DialogContent>
    </Dialog>
  )
}
