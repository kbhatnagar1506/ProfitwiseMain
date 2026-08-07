"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ChevronDown, ChevronUp, AlertCircle, CheckCircle, Link as LinkIcon } from "lucide-react"
import Link from "next/link"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from "recharts"

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

function pct(n: number, base: number) {
  if (base === 0) return "0%"
  return ((n / base) * 100).toFixed(1) + "%"
}

export default function PAndLPage() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [year, setYear] = useState(new Date().getFullYear())
  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [useCustomRange, setUseCustomRange] = useState(false)
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [expandedSections, setExpandedSections] = useState({
    revenue: true,
    cogs: true,
    opex: true,
    suspense: true,
  })
  const [priorData, setPriorData] = useState<any>(null)
  const [showComparison, setShowComparison] = useState(false)
  const [expandedDetails, setExpandedDetails] = useState({
    revenue: false,
    cogs: false,
    opex: false,
  })

  const fetchPnL = useCallback(async () => {
    setLoading(true)
    try {
      let url = "/api/books/p-and-l?"
      let priorUrl = "/api/books/p-and-l?"

      if (useCustomRange && dateFrom && dateTo) {
        url += `dateFrom=${dateFrom}&dateTo=${dateTo}`
        // Calculate prior period (same length)
        const from = new Date(dateFrom)
        const to = new Date(dateTo)
        const diffTime = Math.abs(to.getTime() - from.getTime())
        const priorFrom = new Date(from.getTime() - diffTime)
        const priorTo = new Date(from.getTime() - 1)
        priorUrl += `dateFrom=${priorFrom.toISOString().split("T")[0]}&dateTo=${priorTo.toISOString().split("T")[0]}`
      } else {
        url += `year=${year}&month=${month}`
        // Prior month
        const priorMonth = month === 1 ? 12 : month - 1
        const priorYear = month === 1 ? year - 1 : year
        priorUrl += `year=${priorYear}&month=${priorMonth}`
      }

      const [res, priorRes] = await Promise.all([fetch(url), fetch(priorUrl)])
      const json = await res.json()
      const priorJson = await priorRes.json()
      setData(json)
      setPriorData(priorJson)
    } catch (err) {
      console.error("Error fetching P&L:", err)
    } finally {
      setLoading(false)
    }
  }, [year, month, useCustomRange, dateFrom, dateTo])

  useEffect(() => {
    fetchPnL()
  }, [fetchPnL])

  if (loading) {
    return <div className="text-zinc-500 text-sm p-6">Loading P&L Statement...</div>
  }

  if (!data) {
    return <div className="text-zinc-500 text-sm p-6">No data available</div>
  }

  const isProvisional = data.period.status === "provisional"
  const suspenseAmount = data.suspense.amount || 0
  const grossRevenue = data.revenue.gross_revenue || 0
  const suspensePct = grossRevenue > 0 ? (Math.abs(suspenseAmount) / grossRevenue) * 100 : 0

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="space-y-4">
          <div>
            <h1 className="text-3xl font-bold">Profit & Loss Statement</h1>
            <p className="text-zinc-600 text-sm mt-1">Revenue - COGS - OpEx = Operating Income</p>
          </div>

          {/* Status Badge */}
          <div className="flex items-center gap-3">
            {isProvisional ? (
              <Badge className="bg-red-500/20 text-red-400 border-red-500/30 flex items-center gap-2">
                <AlertCircle className="w-3 h-3" /> Provisional
              </Badge>
            ) : (
              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 flex items-center gap-2">
                <CheckCircle className="w-3 h-3" /> Final
              </Badge>
            )}
            <span className="text-xs text-zinc-600">
              {new Date(data.period.start).toLocaleDateString()} - {new Date(data.period.end).toLocaleDateString()}
            </span>
          </div>

          {/* Period Selector */}
          <div className="flex gap-3 items-center flex-wrap">
            {!useCustomRange ? (
              <>
                <select
                  value={month}
                  onChange={(e) => setMonth(parseInt(e.target.value))}
                  className="bg-[#0a0a0a] border border-white/[0.07] rounded px-3 py-2 text-sm text-white"
                >
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {new Date(2024, i).toLocaleDateString("en-US", { month: "long" })}
                    </option>
                  ))}
                </select>
                <select
                  value={year}
                  onChange={(e) => setYear(parseInt(e.target.value))}
                  className="bg-[#0a0a0a] border border-white/[0.07] rounded px-3 py-2 text-sm text-white"
                >
                  {Array.from({ length: 5 }, (_, i) => {
                    const y = new Date().getFullYear() - i
                    return (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    )
                  })}
                </select>
              </>
            ) : (
              <>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="bg-[#0a0a0a] border-white/[0.07] text-white h-9 text-sm w-40"
                />
                <span className="text-zinc-600">to</span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="bg-[#0a0a0a] border-white/[0.07] text-white h-9 text-sm w-40"
                />
              </>
            )}
            <Button
              onClick={() => setUseCustomRange(!useCustomRange)}
              variant="outline"
              size="sm"
              className="text-xs"
            >
              {useCustomRange ? "Monthly" : "Custom Range"}
            </Button>
          </div>
        </div>

        {/* Suspense Warning Banner */}
        {isProvisional && (
          <div className="border border-red-500/30 bg-red-500/10 rounded-lg p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-semibold text-red-300">Unreconciled Movements Detected</div>
                  <div className="text-sm text-red-200 mt-1">
                    {fmt(Math.abs(suspenseAmount))} ({suspensePct.toFixed(1)}% of revenue) in unmatched movements. Reconcile these transactions to finalize the P&L.
                  </div>
                </div>
              </div>
              <Link href="/dashboard/reconciliation">
                <Button size="sm" className="bg-red-600 hover:bg-red-500 flex items-center gap-2">
                  <LinkIcon className="w-4 h-4" /> Reconcile
                </Button>
              </Link>
            </div>
          </div>
        )}

        {/* Main P&L Table */}
        <div className="border border-white/[0.07] rounded-lg overflow-hidden">
          <div className="divide-y divide-white/[0.07]">
            {/* REVENUE SECTION */}
            <div>
              <button
                onClick={() => setExpandedSections((p) => ({ ...p, revenue: !p.revenue }))}
                className="w-full px-6 py-4 bg-white/[0.03] hover:bg-white/[0.05] flex items-center justify-between text-left transition-colors group"
              >
                <div className="flex items-center gap-3">
                  {expandedSections.revenue ? (
                    <ChevronUp className="w-4 h-4 text-zinc-500" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-zinc-500" />
                  )}
                  <span className="font-semibold text-white">REVENUE</span>
                </div>
              </button>
              {expandedSections.revenue && (
                <div className="divide-y divide-white/[0.05]">
                  {data.revenue.line_items?.filter((item: any) => Math.abs(item.amount) > 0.01).map((item: any, i: number) => (
                    <div key={i} className="px-6 py-3 flex items-center justify-between text-sm hover:bg-white/[0.02]">
                      <span className="text-zinc-300 ml-8">{item.line_item}</span>
                      <div className="flex items-center gap-8">
                        <span className="text-zinc-600 text-xs">{item.count} txns</span>
                        <span className={`font-mono w-32 text-right ${item.amount < 0 ? "text-red-400" : "text-emerald-400"}`}>{fmt(item.amount)}</span>
                        <span className="text-zinc-600 w-16 text-right">{pct(item.amount, grossRevenue)}</span>
                      </div>
                    </div>
                  ))}
                  {(!data.revenue.line_items || data.revenue.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).length === 0) && (
                    <div className="px-6 py-3 text-sm text-zinc-600">No revenue items</div>
                  )}
                  <div className="px-6 py-3 bg-white/[0.02] flex items-center justify-between text-sm font-semibold border-t border-white/[0.05]">
                    <span className="text-white ml-8">Gross Revenue</span>
                    <div className="flex items-center gap-8">
                      <span className="w-12" />
                      <span className="font-mono text-emerald-400 w-32 text-right">{fmt(grossRevenue)}</span>
                      <span className="text-emerald-400 w-16 text-right">100%</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* COGS SECTION */}
            <div>
              <button
                onClick={() => setExpandedSections((p) => ({ ...p, cogs: !p.cogs }))}
                className="w-full px-6 py-4 bg-white/[0.03] hover:bg-white/[0.05] flex items-center justify-between text-left transition-colors"
              >
                <div className="flex items-center gap-3">
                  {expandedSections.cogs ? (
                    <ChevronUp className="w-4 h-4 text-zinc-500" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-zinc-500" />
                  )}
                  <span className="font-semibold text-white">COST OF GOODS SOLD</span>
                </div>
              </button>
              {expandedSections.cogs && (
                <div className="divide-y divide-white/[0.05]">
                  {data.cogs.line_items?.filter((item: any) => Math.abs(item.amount) > 0.01).map((item: any, i: number) => (
                    <div key={i} className="px-6 py-3 flex items-center justify-between text-sm hover:bg-white/[0.02]">
                      <span className="text-zinc-300 ml-8">{item.line_item}</span>
                      <div className="flex items-center gap-8">
                        <span className="text-zinc-600 text-xs">{item.count} txns</span>
                        <span className="font-mono text-red-400 w-32 text-right">({fmt(Math.abs(item.amount))})</span>
                        <span className="text-zinc-600 w-16 text-right">{pct(Math.abs(item.amount), grossRevenue)}</span>
                      </div>
                    </div>
                  ))}
                  {(!data.cogs.line_items || data.cogs.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).length === 0) && (
                    <div className="px-6 py-3 text-sm text-zinc-600">No COGS items</div>
                  )}
                  <div className="px-6 py-3 bg-white/[0.02] flex items-center justify-between text-sm font-semibold border-t border-white/[0.05]">
                    <span className="text-white ml-8">Total COGS</span>
                    <div className="flex items-center gap-8">
                      <span className="w-12" />
                      <span className="font-mono text-red-400 w-32 text-right">({fmt(Math.abs(data.cogs.total_cogs))})</span>
                      <span className="text-red-400 w-16 text-right">{pct(Math.abs(data.cogs.total_cogs), grossRevenue)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* GROSS PROFIT */}
            <div className="px-6 py-4 bg-emerald-500/5 border-t-2 border-emerald-500/20 flex items-center justify-between">
              <span className="font-bold text-emerald-300">Gross Profit</span>
              <div className="flex items-center gap-8">
                <span className="w-12" />
                <span className="font-mono font-bold text-emerald-400 w-32 text-right">{fmt(data.gross_profit)}</span>
                <span className="text-emerald-400 w-16 text-right font-semibold">{pct(data.gross_profit, grossRevenue)}</span>
              </div>
            </div>

            {/* OPERATING EXPENSES SECTION */}
            <div>
              <button
                onClick={() => setExpandedSections((p) => ({ ...p, opex: !p.opex }))}
                className="w-full px-6 py-4 bg-white/[0.03] hover:bg-white/[0.05] flex items-center justify-between text-left transition-colors"
              >
                <div className="flex items-center gap-3">
                  {expandedSections.opex ? (
                    <ChevronUp className="w-4 h-4 text-zinc-500" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-zinc-500" />
                  )}
                  <span className="font-semibold text-white">OPERATING EXPENSES</span>
                </div>
              </button>
              {expandedSections.opex && (
                <div className="divide-y divide-white/[0.05]">
                  {data.operating_expenses.line_items?.filter((item: any) => Math.abs(item.amount) > 0.01).map((item: any, i: number) => (
                    <div key={i} className="px-6 py-3 flex items-center justify-between text-sm hover:bg-white/[0.02]">
                      <span className="text-zinc-300 ml-8">{item.line_item}</span>
                      <div className="flex items-center gap-8">
                        <span className="text-zinc-600 text-xs">{item.count} txns</span>
                        <span className="font-mono text-red-400 w-32 text-right">({fmt(Math.abs(item.amount))})</span>
                        <span className="text-zinc-600 w-16 text-right">{pct(Math.abs(item.amount), grossRevenue)}</span>
                      </div>
                    </div>
                  ))}
                  {(!data.operating_expenses.line_items || data.operating_expenses.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).length === 0) && (
                    <div className="px-6 py-3 text-sm text-zinc-600">No OpEx items</div>
                  )}
                  <div className="px-6 py-3 bg-white/[0.02] flex items-center justify-between text-sm font-semibold border-t border-white/[0.05]">
                    <span className="text-white ml-8">Total Operating Expenses</span>
                    <div className="flex items-center gap-8">
                      <span className="w-12" />
                      <span className="font-mono text-red-400 w-32 text-right">({fmt(Math.abs(data.operating_expenses.total_opex))})</span>
                      <span className="text-red-400 w-16 text-right">{pct(Math.abs(data.operating_expenses.total_opex), grossRevenue)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* OPERATING INCOME */}
            <div className="px-6 py-4 bg-blue-500/5 border-t-2 border-blue-500/20 flex items-center justify-between">
              <span className="font-bold text-blue-300">Operating Income</span>
              <div className="flex items-center gap-8">
                <span className="w-12" />
                <span className="font-mono font-bold text-blue-400 w-32 text-right">{fmt(data.operating_income)}</span>
                <span className="text-blue-400 w-16 text-right font-semibold">{pct(data.operating_income, grossRevenue)}</span>
              </div>
            </div>

            {/* SUSPENSE SECTION */}
            {isProvisional && (
              <div>
                <button
                  onClick={() => setExpandedSections((p) => ({ ...p, suspense: !p.suspense }))}
                  className="w-full px-6 py-4 bg-red-500/5 hover:bg-red-500/10 flex items-center justify-between text-left transition-colors border-t border-red-500/20"
                >
                  <div className="flex items-center gap-3">
                    {expandedSections.suspense ? (
                      <ChevronUp className="w-4 h-4 text-red-500" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-red-500" />
                    )}
                    <span className="font-semibold text-red-400">⚠️ SUSPENSE / UNRECONCILED</span>
                  </div>
                </button>
                {expandedSections.suspense && (
                  <div className="px-6 py-3 bg-red-500/5 text-sm">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-red-300">{data.suspense.count} unmatched movements</span>
                      <span className="font-mono text-red-400">{fmt(Math.abs(suspenseAmount))}</span>
                    </div>
                    <div className="text-xs text-red-300">
                      Status: <span className="font-semibold">Provisional</span> - Reconcile to finalize
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer Info */}
        <div className="text-xs text-zinc-600 space-y-1">
          <p>• P&L is calculated from reconciled movements only</p>
          <p>• Unmatched movements appear in the Suspense line</p>
          <p>• Status changes to "Final" when Suspense = $0.00</p>
        </div>

        {/* Detail Panels */}
        <div className="space-y-4">
          {/* Revenue Breakdown Panel */}
          <div className="border border-white/[0.07] rounded-lg overflow-hidden">
            <button
              onClick={() => setExpandedDetails((p) => ({ ...p, revenue: !p.revenue }))}
              className="w-full px-6 py-4 bg-white/[0.03] hover:bg-white/[0.05] flex items-center justify-between text-left transition-colors"
            >
              <div className="flex items-center gap-3">
                {expandedDetails.revenue ? (
                  <ChevronUp className="w-4 h-4 text-zinc-500" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-zinc-500" />
                )}
                <span className="font-semibold text-white">Revenue Breakdown by Customer</span>
              </div>
              <span className="text-xs text-zinc-600">{data.revenue.line_items?.length || 0} sources</span>
            </button>
            {expandedDetails.revenue && (
              <div className="divide-y divide-white/[0.05] px-6 py-4 space-y-3">
                {data.revenue.line_items?.filter((item: any) => Math.abs(item.amount) > 0.01).map((item: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <div>
                      <div className="text-white font-medium">{item.line_item}</div>
                      <div className="text-xs text-zinc-600">{item.count} transactions</div>
                    </div>
                    <div className="text-right">
                      <div className={`font-mono ${item.amount < 0 ? "text-red-400" : "text-emerald-400"}`}>{fmt(item.amount)}</div>
                      <div className="text-xs text-zinc-600">Confidence: {(item.confidence * 100).toFixed(0)}%</div>
                    </div>
                  </div>
                ))}
                {(!data.revenue.line_items || data.revenue.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).length === 0) && (
                  <div className="text-xs text-zinc-600">No revenue items</div>
                )}
              </div>
            )}
          </div>

          {/* COGS Breakdown Panel */}
          <div className="border border-white/[0.07] rounded-lg overflow-hidden">
            <button
              onClick={() => setExpandedDetails((p) => ({ ...p, cogs: !p.cogs }))}
              className="w-full px-6 py-4 bg-white/[0.03] hover:bg-white/[0.05] flex items-center justify-between text-left transition-colors"
            >
              <div className="flex items-center gap-3">
                {expandedDetails.cogs ? (
                  <ChevronUp className="w-4 h-4 text-zinc-500" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-zinc-500" />
                )}
                <span className="font-semibold text-white">COGS Breakdown by Vendor</span>
              </div>
              <span className="text-xs text-zinc-600">{data.cogs.line_items?.length || 0} vendors</span>
            </button>
            {expandedDetails.cogs && (
              <div className="divide-y divide-white/[0.05] px-6 py-4 space-y-3">
                {data.cogs.line_items?.filter((item: any) => Math.abs(item.amount) > 0.01).map((item: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <div>
                      <div className="text-white font-medium">{item.line_item}</div>
                      <div className="text-xs text-zinc-600">{item.count} transactions</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-red-400">({fmt(Math.abs(item.amount))})</div>
                      <div className="text-xs text-zinc-600">Confidence: {(item.confidence * 100).toFixed(0)}%</div>
                    </div>
                  </div>
                ))}
                {(!data.cogs.line_items || data.cogs.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).length === 0) && (
                  <div className="text-xs text-zinc-600">No COGS items</div>
                )}
              </div>
            )}
          </div>

          {/* OpEx Breakdown Panel */}
          <div className="border border-white/[0.07] rounded-lg overflow-hidden">
            <button
              onClick={() => setExpandedDetails((p) => ({ ...p, opex: !p.opex }))}
              className="w-full px-6 py-4 bg-white/[0.03] hover:bg-white/[0.05] flex items-center justify-between text-left transition-colors"
            >
              <div className="flex items-center gap-3">
                {expandedDetails.opex ? (
                  <ChevronUp className="w-4 h-4 text-zinc-500" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-zinc-500" />
                )}
                <span className="font-semibold text-white">Operating Expenses Breakdown</span>
              </div>
              <span className="text-xs text-zinc-600">{data.operating_expenses.line_items?.length || 0} categories</span>
            </button>
            {expandedDetails.opex && (
              <div className="divide-y divide-white/[0.05] px-6 py-4 space-y-3">
                {data.operating_expenses.line_items?.filter((item: any) => Math.abs(item.amount) > 0.01).map((item: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <div>
                      <div className="text-white font-medium">{item.line_item}</div>
                      <div className="text-xs text-zinc-600">{item.count} transactions</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-red-400">({fmt(Math.abs(item.amount))})</div>
                      <div className="text-xs text-zinc-600">Confidence: {(item.confidence * 100).toFixed(0)}%</div>
                    </div>
                  </div>
                ))}
                {(!data.operating_expenses.line_items || data.operating_expenses.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).length === 0) && (
                  <div className="text-xs text-zinc-600">No OpEx items</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Visualizations Section */}
        <div className="space-y-4">
          {/* Waterfall Chart */}
          <div className="border border-white/[0.07] rounded-lg p-6 bg-white/[0.02]">
            <h3 className="text-sm font-semibold text-white mb-4">P&L Waterfall</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={[
                  { name: "Revenue", value: data.revenue.gross_revenue, fill: "#10b981" },
                  { name: "COGS", value: -data.cogs.total_cogs, fill: "#ef4444" },
                  { name: "Gross Profit", value: data.gross_profit, fill: "#3b82f6" },
                  { name: "OpEx", value: -data.operating_expenses.total_opex, fill: "#f97316" },
                  { name: "Operating Income", value: data.operating_income, fill: "#06b6d4" },
                ]}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis dataKey="name" stroke="rgba(255,255,255,0.5)" />
                <YAxis stroke="rgba(255,255,255,0.5)" />
                <Tooltip
                  contentStyle={{ backgroundColor: "#1a1a1a", border: "1px solid rgba(255,255,255,0.1)" }}
                  formatter={(value) => fmt(value as number)}
                />
                <Bar dataKey="value" fill="#8884d8" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Revenue Composition Pie */}
          {data.revenue.line_items && data.revenue.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).length > 0 && (
            <div className="border border-white/[0.07] rounded-lg p-6 bg-white/[0.02]">
              <h3 className="text-sm font-semibold text-white mb-4">Revenue Composition</h3>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={data.revenue.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).slice(0, 5)}
                    dataKey="amount"
                    nameKey="line_item"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={({ line_item, amount }) => `${line_item}: ${fmt(amount)}`}
                  >
                    {data.revenue.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).slice(0, 5).map((_, index) => (
                      <Cell key={`cell-${index}`} fill={["#10b981", "#3b82f6", "#f97316", "#06b6d4", "#8b5cf6"][index]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => fmt(value as number)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* OpEx Composition Pie */}
          {data.operating_expenses.line_items && data.operating_expenses.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).length > 0 && (
            <div className="border border-white/[0.07] rounded-lg p-6 bg-white/[0.02]">
              <h3 className="text-sm font-semibold text-white mb-4">Operating Expenses Composition</h3>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={data.operating_expenses.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).slice(0, 5)}
                    dataKey="amount"
                    nameKey="line_item"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={({ line_item, amount }) => `${line_item}: ${fmt(Math.abs(amount))}`}
                  >
                    {data.operating_expenses.line_items.filter((item: any) => Math.abs(item.amount) > 0.01).slice(0, 5).map((_, index) => (
                      <Cell key={`cell-${index}`} fill={["#ef4444", "#f97316", "#fb923c", "#fbbf24", "#fcd34d"][index]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => fmt(Math.abs(value as number))} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Comparison Section */}
        {priorData && (
          <div className="space-y-4">
            <button
              onClick={() => setShowComparison(!showComparison)}
              className="flex items-center gap-2 text-sm font-semibold text-white hover:text-emerald-400 transition-colors"
            >
              {showComparison ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              Prior Period Comparison
            </button>

            {showComparison && (
              <div className="border border-white/[0.07] rounded-lg overflow-hidden">
                <div className="divide-y divide-white/[0.07]">
                  {/* Comparison Header */}
                  <div className="px-6 py-4 bg-white/[0.03] grid grid-cols-5 gap-4 text-sm font-semibold">
                    <div>Metric</div>
                    <div className="text-right">Current</div>
                    <div className="text-right">Prior</div>
                    <div className="text-right">$ Change</div>
                    <div className="text-right">% Change</div>
                  </div>

                  {/* Revenue Comparison */}
                  {(() => {
                    const current = data.revenue.gross_revenue
                    const prior = priorData.revenue.gross_revenue
                    const change = current - prior
                    const pctChange = prior !== 0 ? (change / prior) * 100 : 0
                    const isNegative = change < 0
                    return (
                      <div className="px-6 py-3 grid grid-cols-5 gap-4 text-sm hover:bg-white/[0.02]">
                        <div className="text-white">Gross Revenue</div>
                        <div className="text-right font-mono text-emerald-400">{fmt(current)}</div>
                        <div className="text-right font-mono text-zinc-400">{fmt(prior)}</div>
                        <div className={`text-right font-mono ${isNegative ? "text-red-400" : "text-emerald-400"}`}>
                          {isNegative ? "-" : "+"}{fmt(Math.abs(change))}
                        </div>
                        <div className={`text-right ${isNegative ? "text-red-400" : "text-emerald-400"}`}>
                          {isNegative ? "-" : "+"}{Math.abs(pctChange).toFixed(1)}%
                        </div>
                      </div>
                    )
                  })()}

                  {/* COGS Comparison */}
                  {(() => {
                    const current = Math.abs(data.cogs.total_cogs)
                    const prior = Math.abs(priorData.cogs.total_cogs)
                    const change = current - prior
                    const pctChange = prior !== 0 ? (change / prior) * 100 : 0
                    const isNegative = change < 0
                    return (
                      <div className="px-6 py-3 grid grid-cols-5 gap-4 text-sm hover:bg-white/[0.02]">
                        <div className="text-white">COGS</div>
                        <div className="text-right font-mono text-red-400">{fmt(current)}</div>
                        <div className="text-right font-mono text-zinc-400">{fmt(prior)}</div>
                        <div className={`text-right font-mono ${isNegative ? "text-emerald-400" : "text-red-400"}`}>
                          {isNegative ? "-" : "+"}{fmt(Math.abs(change))}
                        </div>
                        <div className={`text-right ${isNegative ? "text-emerald-400" : "text-red-400"}`}>
                          {isNegative ? "-" : "+"}{Math.abs(pctChange).toFixed(1)}%
                        </div>
                      </div>
                    )
                  })()}

                  {/* Gross Profit Comparison */}
                  {(() => {
                    const current = data.gross_profit
                    const prior = priorData.gross_profit
                    const change = current - prior
                    const pctChange = prior !== 0 ? (change / prior) * 100 : 0
                    const isNegative = change < 0
                    return (
                      <div className="px-6 py-3 grid grid-cols-5 gap-4 text-sm bg-emerald-500/5 font-semibold border-t border-emerald-500/20">
                        <div className="text-emerald-300">Gross Profit</div>
                        <div className="text-right font-mono text-emerald-400">{fmt(current)}</div>
                        <div className="text-right font-mono text-zinc-400">{fmt(prior)}</div>
                        <div className={`text-right font-mono ${isNegative ? "text-red-400" : "text-emerald-400"}`}>
                          {isNegative ? "-" : "+"}{fmt(Math.abs(change))}
                        </div>
                        <div className={`text-right ${isNegative ? "text-red-400" : "text-emerald-400"}`}>
                          {isNegative ? "-" : "+"}{Math.abs(pctChange).toFixed(1)}%
                        </div>
                      </div>
                    )
                  })()}

                  {/* OpEx Comparison */}
                  {(() => {
                    const current = Math.abs(data.operating_expenses.total_opex)
                    const prior = Math.abs(priorData.operating_expenses.total_opex)
                    const change = current - prior
                    const pctChange = prior !== 0 ? (change / prior) * 100 : 0
                    const isNegative = change < 0
                    return (
                      <div className="px-6 py-3 grid grid-cols-5 gap-4 text-sm hover:bg-white/[0.02]">
                        <div className="text-white">Operating Expenses</div>
                        <div className="text-right font-mono text-red-400">{fmt(current)}</div>
                        <div className="text-right font-mono text-zinc-400">{fmt(prior)}</div>
                        <div className={`text-right font-mono ${isNegative ? "text-emerald-400" : "text-red-400"}`}>
                          {isNegative ? "-" : "+"}{fmt(Math.abs(change))}
                        </div>
                        <div className={`text-right ${isNegative ? "text-emerald-400" : "text-red-400"}`}>
                          {isNegative ? "-" : "+"}{Math.abs(pctChange).toFixed(1)}%
                        </div>
                      </div>
                    )
                  })()}

                  {/* Operating Income Comparison */}
                  {(() => {
                    const current = data.operating_income
                    const prior = priorData.operating_income
                    const change = current - prior
                    const pctChange = prior !== 0 ? (change / prior) * 100 : 0
                    const isNegative = change < 0
                    return (
                      <div className="px-6 py-3 grid grid-cols-5 gap-4 text-sm bg-blue-500/5 font-semibold border-t border-blue-500/20">
                        <div className="text-blue-300">Operating Income</div>
                        <div className="text-right font-mono text-blue-400">{fmt(current)}</div>
                        <div className="text-right font-mono text-zinc-400">{fmt(prior)}</div>
                        <div className={`text-right font-mono ${isNegative ? "text-red-400" : "text-emerald-400"}`}>
                          {isNegative ? "-" : "+"}{fmt(Math.abs(change))}
                        </div>
                        <div className={`text-right ${isNegative ? "text-red-400" : "text-emerald-400"}`}>
                          {isNegative ? "-" : "+"}{Math.abs(pctChange).toFixed(1)}%
                        </div>
                      </div>
                    )
                  })()}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
