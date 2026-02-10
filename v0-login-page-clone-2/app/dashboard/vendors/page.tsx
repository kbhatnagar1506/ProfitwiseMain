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
  customers: Vendor[]
  pagination: {
    page: number
    limit: number
    total: number
    total_pages: number
  }
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

export default function VendorsPage() {
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
  
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const refreshState = useEntityRefresh()

  const fetchVendors = useCallback(async (refresh: boolean = false) => {
    try {
      const params = new URLSearchParams()
      params.set("entity_type", "vendor")
      params.set("page", String(page))
      params.set("limit", "50")
      params.set("sort_by", sortBy)
      if (debouncedSearch) params.set("search", debouncedSearch)
      if (archetype) params.set("archetype", archetype)
      if (atRisk) params.set("at_risk", "true")
      if (refresh) params.set("refresh", "true")

      const response = await fetch(`/api/dashboard/entity-profiles?${params}`)
      if (!response.ok) throw new Error("Failed to fetch vendors")
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
    fetchVendors()
  }, [fetchVendors])

  const handleExportCSV = () => {
    if (!data?.customers) return
    
    const headers = ["Name", "Archetype", "Txns", "Lifetime Value", "AP", "Overdue", "Reliability", "Last Active"]
    const rows = data.customers.map(v => [
      v.display_name || v.canonical_name,
      v.archetype,
      v.transaction_count,
      v.lifetime_value,
      v.ar_balance,
      v.overdue_balance,
      v.reliability_score,
      v.last_transaction_date || ""
    ])
    
    const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv" })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `vendors-${new Date().toISOString().split("T")[0]}.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  }

  const handleRefresh = async () => {
    await refreshState.refresh(fetchVendors, {
      onSuccess: () => {
        // Auto-dismiss success message after 3 seconds
        setTimeout(() => refreshState.reset(), 3000)
      },
      onError: (error) => {
        console.error("Refresh failed:", error)
      },
    })
  }

  const handleRowClick = (vendor: Vendor) => {
    setSelectedVendor(vendor)
    setDrawerOpen(true)
  }

  if (error) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Vendors</h1>
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
        <h1 className="text-2xl font-semibold text-white tracking-tight">Vendors</h1>
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
            <p className="text-[12px] text-neutral-500 font-medium uppercase tracking-wide">Total Vendors</p>
            <p className="text-3xl font-semibold text-white mt-3 tracking-tight">
              {summary?.total_vendors || 0}
            </p>
          </div>

          <div className="bg-[#141414] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.1] transition-colors">
            <p className="text-[12px] text-neutral-500 font-medium uppercase tracking-wide">Lifetime Volume</p>
            <p className="text-3xl font-semibold text-emerald-400/90 mt-3 tracking-tight tabular-nums">
              {formatCompactCurrency(summary?.total_lifetime_value || 0)}
            </p>
          </div>

          <div className="bg-[#141414] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.1] transition-colors">
            <p className="text-[12px] text-neutral-500 font-medium uppercase tracking-wide">Outstanding AP</p>
            <p className="text-3xl font-semibold text-white mt-3 tracking-tight tabular-nums">
              {formatCompactCurrency(summary?.total_ar_outstanding || 0)}
            </p>
          </div>

          <div className="bg-[#141414] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.1] transition-colors">
            <p className="text-[12px] text-neutral-500 font-medium uppercase tracking-wide">Overdue AP</p>
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
            placeholder="Search vendors..."
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

      {/* Vendors Table */}
      {loading ? (
        <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-12 text-center">
          <div className="inline-flex items-center justify-center">
            <div className="h-5 w-5 border-2 border-neutral-600 border-t-neutral-300 rounded-full animate-spin" />
            <span className="ml-3 text-neutral-400">Loading vendors...</span>
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
                  <TableHead className="text-[11px] text-neutral-600 font-medium text-right">Lifetime Volume</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium text-right">Open AP</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium text-right">Overdue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.customers.map((vendor) => (
                  <TableRow
                    key={vendor.id}
                    onClick={() => handleRowClick(vendor)}
                    className={`hover:bg-white/[0.03] transition-colors cursor-pointer ${
                      vendor.ar_balance > 0 || vendor.overdue_balance > 0
                        ? "border-l-2 border-l-amber-500/50"
                        : ""
                    }`}
                  >
                    <TableCell className="text-[12px] text-neutral-300 py-2 px-4 truncate max-w-[180px]">
                      {vendor.display_name || vendor.canonical_name}
                    </TableCell>
                    <TableCell className="text-[11px] py-2 px-4">
                      <Badge variant="secondary" className={`text-[10px] h-5 ${getArchetypeColor(vendor.archetype)}`}>
                        {vendor.archetype}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-[11px] py-2 px-4">
                      <ReliabilityBar score={vendor.reliability_score} />
                    </TableCell>
                    <TableCell className="text-[12px] font-medium text-emerald-400/90 py-2 px-4 text-right tabular-nums">
                      {formatCurrency(vendor.lifetime_value)}
                    </TableCell>
                    <TableCell className={`text-[12px] font-medium py-2 px-4 text-right tabular-nums ${
                      vendor.ar_balance > 0 
                        ? "text-zinc-100" 
                        : "text-zinc-500"
                    }`}>
                      {formatCurrency(vendor.ar_balance)}
                    </TableCell>
                    <TableCell className={`text-[12px] font-medium py-2 px-4 text-right tabular-nums ${
                      vendor.overdue_balance > 0 
                        ? "text-red-400/90" 
                        : "text-zinc-500"
                    }`}>
                      {formatCurrency(vendor.overdue_balance)}
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
          <p className="text-neutral-400">No vendors found</p>
          <p className="text-sm text-neutral-600 mt-2">Try adjusting your filters</p>
        </div>
      )}

      {/* Deep Dive Drawer */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent className="bg-[#0A0A0A] border-l border-white/[0.06] w-full sm:w-[520px] overflow-y-auto">
          {selectedVendor && (
            <>
              <SheetHeader className="border-b border-white/[0.06] pb-4 mb-6">
                <SheetTitle className="text-white text-xl font-semibold">
                  {selectedVendor.display_name || selectedVendor.canonical_name}
                </SheetTitle>
              </SheetHeader>

              <div className="space-y-6">
                {/* AI Insight Block (Prominent) */}
                {selectedVendor.ai_insight && (
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-4">
                    <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium mb-2">AI Insight</p>
                    <p className="text-[13px] text-neutral-300 leading-relaxed">
                      {selectedVendor.ai_insight}
                    </p>
                  </div>
                )}

                {/* Mini KPI Grid */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                    <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium">Total Paid</p>
                    <p className="text-lg font-semibold text-emerald-400/90 mt-2 tabular-nums">
                      {formatCompactCurrency(selectedVendor.lifetime_value)}
                    </p>
                  </div>
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                    <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium">Open AP</p>
                    <p className={`text-lg font-semibold mt-2 tabular-nums ${
                      selectedVendor.ar_balance > 0 ? "text-amber-400/90" : "text-zinc-500"
                    }`}>
                      {formatCompactCurrency(selectedVendor.ar_balance)}
                    </p>
                  </div>
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                    <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium">Reliability</p>
                    <p className="text-lg font-semibold text-white mt-2">
                      {selectedVendor.reliability_score}%
                    </p>
                  </div>
                </div>

                {/* Archetype & Transaction Info */}
                <div className="space-y-3">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Profile</p>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Archetype</span>
                      <Badge className={`text-[10px] h-5 ${getArchetypeColor(selectedVendor.archetype)}`}>
                        {selectedVendor.archetype}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Transactions</span>
                      <span className="text-[12px] font-medium text-white">{selectedVendor.transaction_count}</span>
                    </div>
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Last Active</span>
                      <span className="text-[12px] font-medium text-zinc-400">
                        {formatDate(selectedVendor.last_transaction_date)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Overdue Alert */}
                {selectedVendor.overdue_balance > 0 && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                    <p className="text-[12px] text-red-400 font-medium">
                      ⚠ {formatCurrency(selectedVendor.overdue_balance)} overdue
                    </p>
                    <p className="text-[11px] text-red-400/70 mt-1">
                      This vendor has outstanding invoices past their due date.
                    </p>
                  </div>
                )}

                {/* Payment Behavior Section */}
                <div className="space-y-3 border-t border-white/[0.06] pt-6">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Payment Behavior</p>
                  {selectedVendor.payment_count === 0 ? (
                    <div className="bg-white/[0.02] p-3 rounded">
                      <p className="text-[12px] text-neutral-500">Data not yet available - insufficient transaction history</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                        <span className="text-[12px] text-neutral-400">Days to Pay</span>
                        <span className="text-[12px] font-medium text-zinc-100">
                          {selectedVendor.avg_days_to_pay === 0 && selectedVendor.std_days_to_pay === 0
                            ? "Not available"
                            : `${Math.round(selectedVendor.avg_days_to_pay)}d ±${Math.round(selectedVendor.std_days_to_pay)}d`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                        <span className="text-[12px] text-neutral-400">On-Time Rate</span>
                        <span className="text-[12px] font-medium text-emerald-400/90">
                          {selectedVendor.on_time_payment_rate === 0 ? "Not available" : `${Math.round(selectedVendor.on_time_payment_rate)}%`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                        <span className="text-[12px] text-neutral-400">Frequency</span>
                        <span className="text-[12px] font-medium text-white">
                          {Number(selectedVendor.transactions_per_month ?? 0).toFixed(1)}/mo
                        </span>
                      </div>
                      <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                        <span className="text-[12px] text-neutral-400">Avg Amount</span>
                        <span className="text-[12px] font-medium text-white tabular-nums">
                          {formatCurrency(selectedVendor.avg_payment_amount)}
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
                      <p className="text-[12px] text-neutral-300">{selectedVendor.forecast_notes}</p>
                    </div>
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Uncertainty</span>
                      <span className={`text-[12px] font-medium uppercase ${
                        selectedVendor.forecast_uncertainty === "high" ? "text-red-400/90" :
                        selectedVendor.forecast_uncertainty === "medium" ? "text-amber-400/90" :
                        "text-emerald-400/90"
                      }`}>
                        {selectedVendor.forecast_uncertainty}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Risk Signals Section */}
                <div className="space-y-3 border-t border-white/[0.06] pt-6">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Risk Signals</p>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between bg-white/[0.02] p-2.5 rounded">
                      <span className="text-[12px] text-neutral-400">Risk Score</span>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 bg-zinc-700 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all ${
                              selectedVendor.risk_score >= 60 ? "bg-red-400" :
                              selectedVendor.risk_score >= 35 ? "bg-amber-400" :
                              "bg-emerald-400"
                            }`}
                            style={{ width: `${Math.min(selectedVendor.risk_score, 100)}%` }}
                          />
                        </div>
                        <span className="text-[12px] font-medium text-white w-8 text-right">
                          {Math.round(selectedVendor.risk_score)}
                        </span>
                      </div>
                    </div>
                    <div className="bg-white/[0.02] p-3 rounded">
                      <RiskFactorsList factors={selectedVendor.risk_factors} />
                    </div>
                  </div>
                </div>

                {/* Seasonality Section */}
                {selectedVendor.peak_months.length > 0 && (
                  <div className="space-y-3 border-t border-white/[0.06] pt-6">
                    <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">Seasonality</p>
                    <div className="bg-white/[0.02] p-4 rounded">
                      <MonthChart peakMonths={selectedVendor.peak_months} lowMonths={selectedVendor.low_months} />
                    </div>
                  </div>
                )}

                {/* AI Enhancement & Recommendations */}
                <div className="space-y-3 border-t border-white/[0.06] pt-6">
                  <p className="text-[11px] text-neutral-600 uppercase tracking-wide font-medium">AI Recommendations</p>
                  <div className="space-y-2">
                    {/* Payment Optimization - Only show if payment metrics available */}
                    {selectedVendor.avg_days_to_pay !== 0 && selectedVendor.avg_days_to_pay > 30 && (
                      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-emerald-400 font-medium mb-1">💰 Extended Terms Opportunity</p>
                        <p className="text-[11px] text-emerald-400/80">
                          You're paying {Math.round(selectedVendor.avg_days_to_pay)} days on average. Negotiate for longer payment terms to improve cash flow.
                        </p>
                      </div>
                    )}

                    {/* Risk Mitigation */}
                    {selectedVendor.risk_score >= 60 && (
                      <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-red-400 font-medium mb-1">⚠️ Supply Risk Alert</p>
                        <p className="text-[11px] text-red-400/80">
                          This vendor shows high risk. Consider diversifying suppliers or establishing backup sources.
                        </p>
                      </div>
                    )}

                    {/* Reliability Boost - Only show if payment metrics available */}
                    {selectedVendor.reliability_score >= 80 && selectedVendor.on_time_payment_rate > 0 && selectedVendor.on_time_payment_rate >= 90 && (
                      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-blue-400 font-medium mb-1">⭐ Trusted Vendor</p>
                        <p className="text-[11px] text-blue-400/80">
                          Excellent reliability and on-time delivery. Consider increasing order volume or negotiating volume discounts.
                        </p>
                      </div>
                    )}

                    {/* Frequency Insight */}
                    {selectedVendor.transactions_per_month >= 10 && (
                      <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-purple-400 font-medium mb-1">📈 High Volume Supplier</p>
                        <p className="text-[11px] text-purple-400/80">
                          {Number(selectedVendor.transactions_per_month ?? 0).toFixed(1)} transactions per month. This is a critical supplier. Maintain strong relationship.
                        </p>
                      </div>
                    )}

                    {/* Trend Alert */}
                    {selectedVendor.amount_trend === "increasing" && (
                      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-emerald-400 font-medium mb-1">📊 Growing Spend</p>
                        <p className="text-[11px] text-emerald-400/80">
                          Your spending with this vendor is increasing. Monitor for cost optimization opportunities.
                        </p>
                      </div>
                    )}

                    {selectedVendor.amount_trend === "decreasing" && (
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-amber-400 font-medium mb-1">📉 Declining Spend</p>
                        <p className="text-[11px] text-amber-400/80">
                          Your spending with this vendor is decreasing. Ensure you're not losing negotiating power or quality.
                        </p>
                      </div>
                    )}

                    {/* Variability Warning - Only show if payment metrics available */}
                    {selectedVendor.std_days_to_pay > 15 && (
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-amber-400 font-medium mb-1">⏱️ Inconsistent Delivery</p>
                        <p className="text-[11px] text-amber-400/80">
                          High variability in delivery timing (±{Math.round(selectedVendor.std_days_to_pay)} days). Consider establishing SLAs.
                        </p>
                      </div>
                    )}

                    {/* Seasonality Insight */}
                    {selectedVendor.peak_months.length > 0 && (
                      <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg p-3">
                        <p className="text-[11px] text-cyan-400 font-medium mb-1">📅 Seasonal Pattern</p>
                        <p className="text-[11px] text-cyan-400/80">
                          Peak activity in {selectedVendor.peak_months.map(m => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]).join(", ")}. Plan procurement accordingly.
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
