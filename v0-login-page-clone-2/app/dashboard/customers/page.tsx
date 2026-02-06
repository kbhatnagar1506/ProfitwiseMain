"use client"

import { useEffect, useState, useCallback } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ChevronDown, ChevronUp, AlertCircle, Download, ChevronRight } from "lucide-react"
import {
  PaymentBehaviorCell,
  OnTimeRateCell,
  TrendIndicator,
  RiskBadge,
  RiskFactorsList,
  MonthChart,
} from "@/components/entity-intelligence"
import { RefreshButton } from "@/components/refresh-button"
import { useEntityRefresh } from "@/hooks/useEntityRefresh"
import { RiskGauge } from "@/components/risk-gauge"
import { ArchetypeInsights } from "@/components/archetype-insights"
import { DataQualityScore } from "@/components/data-quality-score"
import { PeerComparisonCard } from "@/components/peer-comparison-card"
import { SeasonalityHeatmap } from "@/components/seasonality-heatmap"
import { TrendSparkline } from "@/components/trend-sparkline"
import { PaymentBehaviorTimeline } from "@/components/payment-behavior-timeline"
import { PriorityRecommendations } from "@/components/priority-recommendations"
import { generatePriorityRecommendations } from "@/lib/dashboard-calculations"

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
  archetype: "Clockwork" | "Bursty" | "Volatile" | "New"
  last_transaction_date: string | null
  ai_insight: string | null
  metadata?: Record<string, any>
  // Enriched payment behavior
  avg_days_to_pay: number
  std_days_to_pay: number
  on_time_payment_rate: number
  early_payment_rate: number
  payment_count: number
  avg_payment_amount: number
  std_transaction_amount: number
  // Trends
  amount_trend: "increasing" | "decreasing" | "stable"
  transactions_per_month: number
  avg_interval_days: number
  interval_cv: number
  // Seasonality
  peak_months: number[]
  low_months: number[]
  // Risk
  risk_score: number
  risk_factors: string[]
  // Forecast
  forecast_uncertainty: "low" | "medium" | "high"
  forecast_notes: string
  // Peer comparison - Phase 1
  peer_percentiles?: {
    reliability_score: number
    risk_score: number
    avg_days_to_pay: number
    transactions_per_month: number
  }
}

interface EntityProfilesResponse {
  summary: {
    total_customers: number
    total_vendors: number
    total_lifetime_value: number
    total_ar_outstanding: number
    total_overdue: number
    at_risk_count: number
  }
  customers: Customer[]
  pagination: {
    page: number
    limit: number
    total: number
    total_pages: number
  }
  refresh_status?: "none" | "completed"
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatCompactCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—"
  const date = new Date(dateStr)
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function getArchetypeColor(archetype: string): string {
  switch (archetype) {
    case "Clockwork":
      return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
    case "Bursty":
      return "bg-blue-500/10 text-blue-400 border-blue-500/20"
    case "Volatile":
      return "bg-amber-500/10 text-amber-400 border-amber-500/20"
    case "New":
      return "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"
    default:
      return "bg-white/5 text-zinc-400 border-white/10"
  }
}

function ReliabilityBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 bg-zinc-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-emerald-400 transition-all"
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-[11px] text-neutral-600 w-8 text-right">{score}%</span>
    </div>
  )
}

export default function CustomersPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [data, setData] = useState<EntityProfilesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(parseInt(searchParams.get("page") || "1", 10))
  const [search, setSearch] = useState(searchParams.get("search") || "")
  const [debouncedSearch, setDebouncedSearch] = useState(search)
  const [sortBy, setSortBy] = useState(searchParams.get("sort_by") || "lifetime_value")
  const [archetype, setArchetype] = useState(searchParams.get("archetype") || "")
  const [atRisk, setAtRisk] = useState(searchParams.get("at_risk") === "true")
  
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const refreshState = useEntityRefresh()

  const fetchCustomers = useCallback(async (refresh: boolean = false) => {
    try {
      const params = new URLSearchParams()
      params.set("entity_type", "customer")
      params.set("page", String(page))
      params.set("limit", "50")
      params.set("sort_by", sortBy)
      if (debouncedSearch) params.set("search", debouncedSearch)
      if (archetype) params.set("archetype", archetype)
      if (atRisk) params.set("at_risk", "true")
      if (refresh) params.set("refresh", "true")

      const response = await fetch(`/api/dashboard/entity-profiles?${params}`)
      if (!response.ok) throw new Error("Failed to fetch customers")
      const json = await response.json()
      setData(json)
      setError(null)
      setLoading(false)
      return json
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
      setLoading(false)
      throw err
    }
  }, [page, sortBy, debouncedSearch, archetype, atRisk])

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    fetchCustomers()
  }, [fetchCustomers])

  const handleExportCSV = () => {
    if (!data?.customers) return
    
    const headers = ["Name", "Archetype", "Txns", "Lifetime Value", "AR", "Overdue", "Reliability", "Last Active"]
    const rows = data.customers.map(c => [
      c.display_name || c.canonical_name,
      c.archetype,
      c.transaction_count,
      c.lifetime_value,
      c.ar_balance,
      c.overdue_balance,
      c.reliability_score,
      c.last_transaction_date || ""
    ])
    
    const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv" })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `customers-${new Date().toISOString().split("T")[0]}.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  }

  const handleRefresh = async () => {
    await refreshState.refresh(fetchCustomers, {
      onSuccess: () => {
        // Auto-dismiss success message after 3 seconds
        setTimeout(() => refreshState.reset(), 3000)
      },
      onError: (error) => {
        console.error("Refresh failed:", error)
      },
    })
  }

  const handleRowClick = (customer: Customer) => {
    setSelectedCustomer(customer)
    setDrawerOpen(true)
  }

  if (error) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Customers</h1>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400 text-sm">
          {error}
        </div>
      </div>
    )
  }

  const summary = data?.summary

  return (
    <div className="space-y-6">
      {/* Header with Title, Refresh, and Export */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-white tracking-tight">Customers</h1>
        <div className="flex items-center gap-3">
          <RefreshButton
            isRefreshing={refreshState.isRefreshing}
            status={refreshState.status}
            progress={refreshState.progress}
            message={refreshState.message}
            onClick={handleRefresh}
          />
          <Button
            onClick={handleExportCSV}
            disabled={!data?.customers || data.customers.length === 0}
            className="bg-white/5 hover:bg-white/10 text-white border border-white/10 h-8 px-3 text-sm"
          >
            <Download className="h-3.5 w-3.5 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Macro KPI Row */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-[#141414] border border-white/[0.06] rounded-xl p-5">
              <Skeleton className="h-3 w-20 mb-3" />
              <Skeleton className="h-7 w-24" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-[#141414] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.1] transition-colors">
            <p className="text-[12px] text-neutral-500 font-medium uppercase tracking-wide">Total Customers</p>
            <p className="text-3xl font-semibold text-white mt-3 tracking-tight">
              {summary?.total_customers || 0}
            </p>
          </div>

          <div className="bg-[#141414] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.1] transition-colors">
            <p className="text-[12px] text-neutral-500 font-medium uppercase tracking-wide">Lifetime Volume</p>
            <p className="text-3xl font-semibold text-emerald-400/90 mt-3 tracking-tight tabular-nums">
              {formatCompactCurrency(summary?.total_lifetime_value || 0)}
            </p>
          </div>

          <div className="bg-[#141414] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.1] transition-colors">
            <p className="text-[12px] text-neutral-500 font-medium uppercase tracking-wide">Outstanding AR</p>
            <p className="text-3xl font-semibold text-white mt-3 tracking-tight tabular-nums">
              {formatCompactCurrency(summary?.total_ar_outstanding || 0)}
            </p>
          </div>

          <div className="bg-[#141414] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.1] transition-colors">
            <p className="text-[12px] text-neutral-500 font-medium uppercase tracking-wide">Overdue AR</p>
            <p className={`text-3xl font-semibold mt-3 tracking-tight tabular-nums ${
              (summary?.total_overdue || 0) > 0 ? "text-red-400/90" : "text-zinc-500"
            }`}>
              {formatCompactCurrency(summary?.total_overdue || 0)}
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <Input
            placeholder="Search customers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-white/5 border-white/10 text-neutral-300 placeholder:text-neutral-700"
          />

          <Select value={sortBy || "lifetime_value"} onValueChange={(v) => { setSortBy(v); setPage(1) }}>
            <SelectTrigger className="bg-white/5 border-white/10 text-neutral-300">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent className="bg-[#1a1a1a] border-white/10">
              <SelectItem value="lifetime_value">Lifetime Value</SelectItem>
              <SelectItem value="reliability">Reliability Score</SelectItem>
              <SelectItem value="txn_count">Transaction Count</SelectItem>
            </SelectContent>
          </Select>

          <Select value={archetype || "__all__"} onValueChange={(v) => { setArchetype(v === "__all__" ? "" : v); setPage(1) }}>
            <SelectTrigger className="bg-white/5 border-white/10 text-neutral-300">
              <SelectValue placeholder="All archetypes" />
            </SelectTrigger>
            <SelectContent className="bg-[#1a1a1a] border-white/10">
              <SelectItem value="__all__">All archetypes</SelectItem>
              <SelectItem value="Clockwork">Clockwork</SelectItem>
              <SelectItem value="Bursty">Bursty</SelectItem>
              <SelectItem value="Volatile">Volatile</SelectItem>
              <SelectItem value="New">New</SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant={atRisk ? "default" : "outline"}
            onClick={() => { setAtRisk(!atRisk); setPage(1) }}
            className={atRisk ? "bg-amber-500/20 text-amber-400 border-amber-500/30" : "bg-white/5 border-white/10 text-neutral-400"}
          >
            <AlertCircle className="h-4 w-4 mr-2" />
            At Risk
          </Button>
        </div>
      </div>

      {/* Customers Table */}
      {loading ? (
        <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-12 text-center">
          <div className="inline-flex items-center justify-center">
            <div className="h-5 w-5 border-2 border-neutral-600 border-t-neutral-300 rounded-full animate-spin" />
            <span className="ml-3 text-neutral-400">Loading customers...</span>
          </div>
        </div>
      ) : data && data.customers.length > 0 ? (
        <>
          <div className="bg-[#141414] border border-white/[0.06] rounded-xl overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-white/[0.06] hover:bg-transparent">
                  <TableHead className="text-[11px] text-neutral-600 font-medium">Name</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium">Archetype</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium">Reliability</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium text-right">Lifetime Value</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium text-right">Open AR</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium text-right">Overdue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.customers.map((customer) => (
                  <TableRow
                    key={customer.id}
                    onClick={() => handleRowClick(customer)}
                    className={`hover:bg-white/[0.03] transition-colors cursor-pointer ${
                      customer.ar_balance > 0 || customer.overdue_balance > 0
                        ? "border-l-2 border-l-amber-500/50"
                        : ""
                    }`}
                  >
                    <TableCell className="text-[12px] text-neutral-300 py-2 px-4 truncate max-w-[180px]">
                      {customer.display_name || customer.canonical_name}
                    </TableCell>
                    <TableCell className="text-[11px] py-2 px-4">
                      <Badge variant="secondary" className={`text-[10px] h-5 ${getArchetypeColor(customer.archetype)}`}>
                        {customer.archetype}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-[11px] py-2 px-4">
                      <ReliabilityBar score={customer.reliability_score} />
                    </TableCell>
                    <TableCell className="text-[12px] font-medium text-emerald-400/90 py-2 px-4 text-right tabular-nums">
                      {formatCurrency(customer.lifetime_value)}
                    </TableCell>
                    <TableCell className={`text-[12px] font-medium py-2 px-4 text-right tabular-nums ${
                      customer.ar_balance > 0 
                        ? "text-zinc-100" 
                        : "text-zinc-500"
                    }`}>
                      {formatCurrency(customer.ar_balance)}
                    </TableCell>
                    <TableCell className={`text-[12px] font-medium py-2 px-4 text-right tabular-nums ${
                      customer.overdue_balance > 0 
                        ? "text-red-400/90" 
                        : "text-zinc-500"
                    }`}>
                      {formatCurrency(customer.overdue_balance)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {data.pagination.total_pages > 1 && (
            <div className="flex items-center justify-between">
              <div className="text-[12px] text-neutral-600">
                Page {data.pagination.page} of {data.pagination.total_pages} ({data.pagination.total} total)
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                  className="bg-white/5 border-white/10 text-neutral-400 disabled:opacity-50"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.min(data.pagination.total_pages, page + 1))}
                  disabled={page === data.pagination.total_pages}
                  className="bg-white/5 border-white/10 text-neutral-400 disabled:opacity-50"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-8 text-center">
          <p className="text-neutral-400">No customers found</p>
          <p className="text-sm text-neutral-600 mt-2">Try adjusting your filters</p>
        </div>
      )}

      {/* Deep Dive Drawer */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent className="bg-[#0A0A0A] border-l border-white/[0.06] w-full sm:w-[520px] overflow-y-auto">
          {selectedCustomer && (
            <>
              <SheetHeader className="border-b border-white/[0.06] pb-4 mb-6">
                <SheetTitle className="text-white text-xl font-semibold">
                  {selectedCustomer.display_name || selectedCustomer.canonical_name}
                </SheetTitle>
              </SheetHeader>

              <div className="space-y-6">
                {/* AI Insight Block (Prominent) */}
                {selectedCustomer.ai_insight && (
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-4">
                    <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium mb-2">AI Insight</p>
                    <p className="text-[13px] text-neutral-300 leading-relaxed">
                      {selectedCustomer.ai_insight}
                    </p>
                  </div>
                )}

                {/* Archetype Insights - Phase 1 */}
                <ArchetypeInsights archetype={selectedCustomer.archetype as any} />

                {/* Mini KPI Grid */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                    <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium">Total Invoiced</p>
                    <p className="text-lg font-semibold text-emerald-400/90 mt-2 tabular-nums">
                      {formatCompactCurrency(selectedCustomer.lifetime_value)}
                    </p>
                  </div>
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                    <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium">Open AR</p>
                    <p className={`text-lg font-semibold mt-2 tabular-nums ${
                      selectedCustomer.ar_balance > 0 ? "text-amber-400/90" : "text-zinc-500"
                    }`}>
                      {formatCompactCurrency(selectedCustomer.ar_balance)}
                    </p>
                  </div>
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                    <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium">Reliability</p>
                    <p className="text-lg font-semibold text-white mt-2">
                      {selectedCustomer.reliability_score}%
                    </p>
                  </div>
                </div>

                {/* Archetype & Transaction Info */}
                <div className="space-y-3">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Profile</p>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Archetype</span>
                      <Badge className={`text-[10px] h-5 ${getArchetypeColor(selectedCustomer.archetype)}`}>
                        {selectedCustomer.archetype}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Transactions</span>
                      <span className="text-[12px] font-medium text-white">{selectedCustomer.transaction_count}</span>
                    </div>
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Last Active</span>
                      <span className="text-[12px] font-medium text-zinc-400">
                        {formatDate(selectedCustomer.last_transaction_date)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Overdue Alert */}
                {selectedCustomer.overdue_balance > 0 && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                    <p className="text-[12px] text-red-400 font-medium">
                      ⚠ {formatCurrency(selectedCustomer.overdue_balance)} overdue
                    </p>
                    <p className="text-[11px] text-red-400/70 mt-1">
                      This customer has outstanding invoices past their due date.
                    </p>
                  </div>
                )}

                {/* Payment Behavior Section */}
                <div className="space-y-3 border-t border-white/[0.06] pt-6">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Payment Behavior</p>
                  {selectedCustomer.payment_count === 0 ? (
                    <div className="bg-white/[0.02] p-3 rounded">
                      <p className="text-[12px] text-neutral-500">Data not yet available - insufficient transaction history</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                        <span className="text-[12px] text-neutral-400">Days to Pay</span>
                        <span className="text-[12px] font-medium text-zinc-100">
                          {selectedCustomer.avg_days_to_pay === 0 && selectedCustomer.std_days_to_pay === 0
                            ? "Not available"
                            : `${Math.round(selectedCustomer.avg_days_to_pay)}d ±${Math.round(selectedCustomer.std_days_to_pay)}d`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                        <span className="text-[12px] text-neutral-400">On-Time Rate</span>
                        <span className="text-[12px] font-medium text-emerald-400/90">
                          {selectedCustomer.on_time_payment_rate === 0 ? "Not available" : `${Math.round(selectedCustomer.on_time_payment_rate)}%`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                        <span className="text-[12px] text-neutral-400">Frequency</span>
                        <span className="text-[12px] font-medium text-white">
                          {(selectedCustomer.transactions_per_month ?? 0).toFixed(1)}/mo
                        </span>
                      </div>
                      <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                        <span className="text-[12px] text-neutral-400">Avg Amount</span>
                        <span className="text-[12px] font-medium text-white tabular-nums">
                          {formatCurrency(selectedCustomer.avg_payment_amount)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Forecast Signals Section */}
                <div className="space-y-3 border-t border-white/[0.06] pt-6">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Forecast Signals</p>
                  <div className="space-y-2">
                    <div className="bg-white/[0.02] p-3 rounded">
                      <p className="text-[12px] text-neutral-300">{selectedCustomer.forecast_notes}</p>
                    </div>
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Uncertainty</span>
                      <span className={`text-[12px] font-medium uppercase ${
                        selectedCustomer.forecast_uncertainty === "high" ? "text-red-400/90" :
                        selectedCustomer.forecast_uncertainty === "medium" ? "text-amber-400/90" :
                        "text-emerald-400/90"
                      }`}>
                        {selectedCustomer.forecast_uncertainty}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Data Quality Score - Phase 1 */}
                <div className="border-t border-white/[0.06] pt-6">
                  <DataQualityScore
                    transactionCount={selectedCustomer.transaction_count}
                    dataSpanMonths={Math.max(1, Math.floor((new Date().getTime() - new Date(selectedCustomer.last_transaction_date || new Date()).getTime()) / (1000 * 60 * 60 * 24 * 30)))}
                    dueDateCoverage={selectedCustomer.payment_count > 0 ? 0.8 : 0}
                    consistencyScore={Math.max(0, 1 - (selectedCustomer.interval_cv || 0) / 100)}
                  />
                </div>

                {/* Peer Comparison - Phase 1 */}
                <div className="border-t border-white/[0.06] pt-6">
                  <PeerComparisonCard
                    entityName={selectedCustomer.display_name || selectedCustomer.canonical_name}
                    archetype={selectedCustomer.archetype}
                    metrics={{
                      reliabilityScore: selectedCustomer.reliability_score,
                      riskScore: selectedCustomer.risk_score,
                      avgDaysToPay: selectedCustomer.avg_days_to_pay,
                      transactionsPerMonth: selectedCustomer.transactions_per_month,
                    }}
                    peerPercentiles={selectedCustomer.peer_percentiles || {
                      reliability_score: 50,
                      risk_score: 50,
                      avg_days_to_pay: 50,
                      transactions_per_month: 50,
                    }}
                  />
                </div>

                {/* Risk Signals Section - Phase 1 with RiskGauge */}
                <div className="space-y-3 border-t border-white/[0.06] pt-6">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Risk Assessment</p>
                  <RiskGauge
                    score={selectedCustomer.risk_score}
                    factors={selectedCustomer.risk_factors}
                  />
                </div>

                {/* Seasonality Section */}
                {selectedCustomer.peak_months.length > 0 && (
                  <div className="space-y-3 border-t border-white/[0.06] pt-6">
                    <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Seasonality</p>
                    <div className="bg-white/[0.02] p-4 rounded">
                      <SeasonalityHeatmap
                        peakMonths={selectedCustomer.peak_months}
                        lowMonths={selectedCustomer.low_months}
                      />
                    </div>
                  </div>
                )}

                {/* Trends Section - Phase 2 */}
                <div className="space-y-3 border-t border-white/[0.06] pt-6">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Trends</p>
                  <div className="space-y-3">
                    <TrendSparkline
                      label="Amount Trend"
                      currentValue={selectedCustomer.avg_payment_amount}
                      trend={selectedCustomer.amount_trend}
                      unit="USD"
                      format={(v) => `$${Math.round(v).toLocaleString()}`}
                    />
                    <TrendSparkline
                      label="Frequency"
                      currentValue={selectedCustomer.transactions_per_month}
                      trend={selectedCustomer.transactions_per_month > 5 ? "increasing" : selectedCustomer.transactions_per_month < 1 ? "decreasing" : "stable"}
                      unit="/month"
                      format={(v) => v.toFixed(1)}
                    />
                  </div>
                </div>

                {/* Payment Behavior Timeline - Phase 2 */}
                <div className="space-y-3 border-t border-white/[0.06] pt-6">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Payment Behavior Summary</p>
                  <PaymentBehaviorTimeline
                    avgDaysToPay={selectedCustomer.avg_days_to_pay}
                    stdDaysToPay={selectedCustomer.std_days_to_pay}
                    onTimeRate={selectedCustomer.on_time_payment_rate}
                    earlyRate={selectedCustomer.early_payment_rate}
                    transactionsPerMonth={selectedCustomer.transactions_per_month}
                    amountTrend={selectedCustomer.amount_trend}
                  />
                </div>

                {/* Priority Recommendations - Phase 2 */}
                <div className="space-y-3 border-t border-white/[0.06] pt-6">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Recommended Actions</p>
                  <PriorityRecommendations
                    recommendations={generatePriorityRecommendations({
                      id: selectedCustomer.id,
                      archetype: selectedCustomer.archetype,
                      reliability_score: selectedCustomer.reliability_score,
                      risk_score: selectedCustomer.risk_score,
                      avg_days_to_pay: selectedCustomer.avg_days_to_pay,
                      transactions_per_month: selectedCustomer.transactions_per_month,
                      on_time_payment_rate: selectedCustomer.on_time_payment_rate,
                      early_payment_rate: selectedCustomer.early_payment_rate,
                      amount_trend: selectedCustomer.amount_trend,
                      risk_factors: selectedCustomer.risk_factors,
                      transaction_count: selectedCustomer.transaction_count,
                      avg_interval_days: selectedCustomer.avg_interval_days,
                      interval_cv: selectedCustomer.interval_cv,
                    })}
                  />
                </div>

                {/* AI Enhancement & Recommendations */}
                <div className="space-y-3 border-t border-white/[0.06] pt-6">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">AI Recommendations</p>
                  <div className="space-y-2">
                    {/* Payment Optimization - Only show if payment metrics available */}
                    {selectedCustomer.avg_days_to_pay !== 0 && selectedCustomer.avg_days_to_pay < -30 && (
                      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-emerald-400 font-medium mb-1">💰 Early Payer Opportunity</p>
                        <p className="text-[11px] text-emerald-400/80">
                          This customer pays {Math.abs(Math.round(selectedCustomer.avg_days_to_pay))} days early on average. Consider offering early payment discounts to improve cash flow.
                        </p>
                      </div>
                    )}

                    {/* Risk Mitigation */}
                    {selectedCustomer.risk_score >= 60 && (
                      <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-red-400 font-medium mb-1">⚠️ High Risk Alert</p>
                        <p className="text-[11px] text-red-400/80">
                          This customer shows high payment risk. Consider tightening payment terms or requiring deposits on future orders.
                        </p>
                      </div>
                    )}

                    {/* Reliability Boost - Only show if payment metrics available */}
                    {selectedCustomer.reliability_score >= 80 && selectedCustomer.on_time_payment_rate > 0 && selectedCustomer.on_time_payment_rate >= 90 && (
                      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-blue-400 font-medium mb-1">⭐ VIP Customer</p>
                        <p className="text-[11px] text-blue-400/80">
                          Excellent payment history and reliability. Consider offering volume discounts or extended payment terms to strengthen the relationship.
                        </p>
                      </div>
                    )}

                    {/* Frequency Insight */}
                    {selectedCustomer.transactions_per_month >= 10 && (
                      <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-purple-400 font-medium mb-1">📈 High Activity</p>
                        <p className="text-[11px] text-purple-400/80">
                          {(selectedCustomer.transactions_per_month ?? 0).toFixed(1)} transactions per month. This is a high-value, active customer. Prioritize relationship management.
                        </p>
                      </div>
                    )}

                    {/* Trend Alert */}
                    {selectedCustomer.amount_trend === "increasing" && (
                      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-emerald-400 font-medium mb-1">📊 Growing Customer</p>
                        <p className="text-[11px] text-emerald-400/80">
                          Transaction amounts are trending upward. This customer is expanding their business with you. Nurture this growth opportunity.
                        </p>
                      </div>
                    )}

                    {selectedCustomer.amount_trend === "decreasing" && (
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-amber-400 font-medium mb-1">📉 Declining Activity</p>
                        <p className="text-[11px] text-amber-400/80">
                          Transaction amounts are trending downward. Reach out to understand if there are issues or if they're shifting to competitors.
                        </p>
                      </div>
                    )}

                    {/* Variability Warning - Only show if payment metrics available */}
                    {selectedCustomer.std_days_to_pay > 15 && (
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-amber-400 font-medium mb-1">⏱️ Unpredictable Payments</p>
                        <p className="text-[11px] text-amber-400/80">
                          High variability in payment timing (±{Math.round(selectedCustomer.std_days_to_pay)} days). Consider automated payment reminders or stricter terms.
                        </p>
                      </div>
                    )}

                    {/* Seasonality Insight */}
                    {selectedCustomer.peak_months.length > 0 && (
                      <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-cyan-400 font-medium mb-1">📅 Seasonal Pattern</p>
                        <p className="text-[11px] text-cyan-400/80">
                          Peak activity in {selectedCustomer.peak_months.map(m => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]).join(", ")}. Plan inventory and cash flow accordingly.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
