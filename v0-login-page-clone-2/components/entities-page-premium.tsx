"use client"

import { useState, useEffect, useCallback } from "react"
import {
  RefreshCw,
  Users,
  Building2,
  AlertTriangle,
  Search,
  TrendingUp,
  TrendingDown,
  Minus,
  DollarSign,
  Clock,
  Calendar,
  ChevronRight,
  Sparkles,
  Shield,
  Activity,
  BarChart3,
  Filter,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react"

type EntitySummary = {
  id: string
  canonical_name: string
  display_name: string | null
  entity_type: "customer" | "vendor" | null
  archetype: string | null
  lifetime_value: number | null
  outstanding_amount: number | null
  overdue_amount: number | null
  reliability_score: number
  risk_score: number | null
  transaction_count: number
  last_transaction_date: string | null
  ai_summary: string | null
  avg_days_to_pay?: number | null
  on_time_payment_rate?: number | null
  transactions_per_month?: number | null
}

type Summary = {
  total_entities: number
  total_customers: number
  total_vendors: number
  total_ar_outstanding: number
  total_ap_outstanding: number
  total_lifetime_value: number
  at_risk_count: number
}

type FilterType = "all" | "customer" | "vendor" | "at_risk"
type SortType = "lifetime_value" | "transaction_count" | "risk_score" | "last_transaction_date" | "reliability_score"

function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "$0"
  if (Math.abs(amount) >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`
  if (Math.abs(amount) >= 1000) return `$${(amount / 1000).toFixed(1)}K`
  return `$${amount.toFixed(0)}`
}

function formatCompactCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "$0"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return `${(value * 100).toFixed(0)}%`
}

function getArchetypeConfig(archetype: string | null): { label: string; color: string; bg: string; icon: React.ReactNode } {
  const configs: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
    clockwork: { label: "Clockwork", color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", icon: <Clock className="w-3 h-3" /> },
    slow_reliable: { label: "Reliable", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", icon: <Shield className="w-3 h-3" /> },
    bursty: { label: "Bursty", color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20", icon: <Activity className="w-3 h-3" /> },
    volatile: { label: "Volatile", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20", icon: <AlertTriangle className="w-3 h-3" /> },
    low_data: { label: "New", color: "text-gray-400", bg: "bg-gray-500/10 border-gray-500/20", icon: <Sparkles className="w-3 h-3" /> },
  }
  return configs[archetype || ""] || { label: "Unknown", color: "text-gray-400", bg: "bg-gray-500/10 border-gray-500/20", icon: null }
}

function getRiskConfig(riskScore: number | null): { label: string; color: string; bg: string; dot: string } {
  if (riskScore === null) return { label: "Unknown", color: "text-gray-400", bg: "bg-gray-500/10", dot: "bg-gray-500" }
  if (riskScore > 0.6) return { label: "High Risk", color: "text-red-400", bg: "bg-red-500/10", dot: "bg-red-500" }
  if (riskScore > 0.4) return { label: "Moderate", color: "text-amber-400", bg: "bg-amber-500/10", dot: "bg-amber-500" }
  return { label: "Low Risk", color: "text-emerald-400", bg: "bg-emerald-500/10", dot: "bg-emerald-500" }
}

function TrendIndicator({ value, suffix = "" }: { value: number | null | undefined; suffix?: string }) {
  if (value === null || value === undefined) return <span className="text-gray-500">—</span>
  const isPositive = value > 0
  return (
    <span className={`flex items-center gap-0.5 ${isPositive ? "text-emerald-400" : "text-red-400"}`}>
      {isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
      {Math.abs(value).toFixed(0)}{suffix}
    </span>
  )
}

function StatCard({ label, value, subValue, icon, trend }: { 
  label: string
  value: string | number
  subValue?: string
  icon: React.ReactNode
  trend?: "up" | "down" | "neutral"
}) {
  return (
    <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-gray-800/80 to-gray-900/80 border border-gray-700/50 p-4">
      <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-to-br from-white/5 to-transparent rounded-bl-full" />
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</p>
          <p className="text-2xl font-bold text-white mt-1">{value}</p>
          {subValue && <p className="text-xs text-gray-500 mt-0.5">{subValue}</p>}
        </div>
        <div className={`p-2 rounded-lg ${
          trend === "up" ? "bg-emerald-500/10 text-emerald-400" :
          trend === "down" ? "bg-red-500/10 text-red-400" :
          "bg-gray-700/50 text-gray-400"
        }`}>
          {icon}
        </div>
      </div>
    </div>
  )
}

function EntityCard({ entity, onClick }: { entity: EntitySummary; onClick: () => void }) {
  const archetype = getArchetypeConfig(entity.archetype)
  const risk = getRiskConfig(entity.risk_score)
  const isCustomer = entity.entity_type === "customer"

  return (
    <div
      onClick={onClick}
      className="group relative overflow-hidden rounded-xl bg-gradient-to-br from-gray-800/60 to-gray-900/60 border border-gray-700/40 hover:border-gray-600/60 transition-all duration-300 cursor-pointer hover:shadow-lg hover:shadow-black/20"
    >
      {/* Gradient accent based on entity type */}
      <div className={`absolute top-0 left-0 right-0 h-0.5 ${
        isCustomer ? "bg-gradient-to-r from-emerald-500 via-emerald-400 to-teal-500" : "bg-gradient-to-r from-violet-500 via-purple-400 to-fuchsia-500"
      }`} />
      
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
              isCustomer ? "bg-emerald-500/10 text-emerald-400" : "bg-violet-500/10 text-violet-400"
            }`}>
              {isCustomer ? <Users className="w-5 h-5" /> : <Building2 className="w-5 h-5" />}
            </div>
            <div>
              <h3 className="font-semibold text-white group-hover:text-gray-100 transition-colors line-clamp-1">
                {entity.display_name || entity.canonical_name}
              </h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${archetype.bg} ${archetype.color}`}>
                  {archetype.icon}
                  {archetype.label}
                </span>
                <span className="text-[10px] text-gray-500">
                  {entity.transaction_count} txns
                </span>
              </div>
            </div>
          </div>
          <div className={`w-2 h-2 rounded-full ${risk.dot} ring-2 ring-offset-2 ring-offset-gray-900 ${risk.dot.replace('bg-', 'ring-')}/30`} />
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="text-center p-2 rounded-lg bg-gray-800/50">
            <p className="text-lg font-bold text-white">{formatCurrency(entity.lifetime_value)}</p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Lifetime</p>
          </div>
          <div className="text-center p-2 rounded-lg bg-gray-800/50">
            <p className={`text-lg font-bold ${(entity.outstanding_amount || 0) > 0 ? (isCustomer ? "text-emerald-400" : "text-amber-400") : "text-gray-400"}`}>
              {formatCurrency(entity.outstanding_amount)}
            </p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">{isCustomer ? "AR" : "AP"}</p>
          </div>
          <div className="text-center p-2 rounded-lg bg-gray-800/50">
            <p className={`text-lg font-bold ${(entity.overdue_amount || 0) > 0 ? "text-red-400" : "text-gray-400"}`}>
              {formatCurrency(entity.overdue_amount)}
            </p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Overdue</p>
          </div>
        </div>

        {/* Performance Bar */}
        <div className="mb-3">
          <div className="flex items-center justify-between text-[10px] mb-1">
            <span className="text-gray-400">Reliability Score</span>
            <span className={`font-medium ${entity.reliability_score > 0.7 ? "text-emerald-400" : entity.reliability_score > 0.4 ? "text-amber-400" : "text-red-400"}`}>
              {(entity.reliability_score * 100).toFixed(0)}%
            </span>
          </div>
          <div className="h-1.5 bg-gray-700/50 rounded-full overflow-hidden">
            <div 
              className={`h-full rounded-full transition-all duration-500 ${
                entity.reliability_score > 0.7 ? "bg-gradient-to-r from-emerald-500 to-teal-400" :
                entity.reliability_score > 0.4 ? "bg-gradient-to-r from-amber-500 to-yellow-400" :
                "bg-gradient-to-r from-red-500 to-orange-400"
              }`}
              style={{ width: `${entity.reliability_score * 100}%` }}
            />
          </div>
        </div>

        {/* AI Summary */}
        {entity.ai_summary && (
          <div className="relative p-2.5 rounded-lg bg-gradient-to-br from-gray-800/80 to-gray-900/50 border border-gray-700/30">
            <div className="absolute -top-1.5 left-2 px-1.5 py-0.5 bg-gray-900 rounded text-[9px] font-medium text-violet-400 flex items-center gap-1">
              <Sparkles className="w-2.5 h-2.5" />
              AI Insight
            </div>
            <p className="text-xs text-gray-300 leading-relaxed line-clamp-2 mt-1">
              {entity.ai_summary}
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-700/30">
          <div className="flex items-center gap-3 text-[10px] text-gray-500">
            {entity.last_transaction_date && (
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {new Date(entity.last_transaction_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
            {entity.on_time_payment_rate !== null && entity.on_time_payment_rate !== undefined && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatPercent(entity.on_time_payment_rate)} on-time
              </span>
            )}
          </div>
          <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-gray-400 group-hover:translate-x-0.5 transition-all" />
        </div>
      </div>
    </div>
  )
}

export function EntitiesPagePremium({
  onSelectEntity,
}: {
  onSelectEntity?: (entityId: string) => void
}) {
  const [entities, setEntities] = useState<EntitySummary[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<FilterType>("all")
  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState<SortType>("lifetime_value")

  const fetchEntities = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)

    try {
      const params = new URLSearchParams({
        sort: sortBy,
        min_transactions: "1",
      })
      if (refresh) params.set("refresh", "true")

      const res = await fetch(`/api/entities?${params}`)
      if (res.ok) {
        const data = await res.json()
        setEntities(data.entities || [])
        setSummary(data.summary || null)
      }
    } catch (e) {
      console.error("Failed to fetch entities:", e)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [sortBy])

  useEffect(() => {
    fetchEntities()
  }, [fetchEntities])

  const filteredEntities = entities.filter((e) => {
    if (filter === "customer" && e.entity_type !== "customer") return false
    if (filter === "vendor" && e.entity_type !== "vendor") return false
    if (filter === "at_risk" && (e.risk_score === null || e.risk_score <= 0.5)) return false

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      const name = (e.display_name || e.canonical_name).toLowerCase()
      if (!name.includes(query)) return false
    }

    return true
  })

  const customers = filteredEntities.filter((e) => e.entity_type === "customer")
  const vendors = filteredEntities.filter((e) => e.entity_type === "vendor")

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <div className="w-12 h-12 rounded-full border-2 border-gray-700 border-t-emerald-500 animate-spin" />
            <div className="absolute inset-0 w-12 h-12 rounded-full border-2 border-transparent border-b-violet-500 animate-spin" style={{ animationDirection: "reverse", animationDuration: "1.5s" }} />
          </div>
          <p className="text-sm text-gray-400">Loading entity profiles...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-gray-950/80 backdrop-blur-xl border-b border-gray-800/50">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white">Entity Profiles</h1>
              <p className="text-sm text-gray-400 mt-0.5">AI-powered customer and vendor intelligence</p>
            </div>
            <button
              onClick={() => fetchEntities(true)}
              disabled={refreshing}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 rounded-lg text-white text-sm font-medium transition-all disabled:opacity-50 shadow-lg shadow-emerald-500/20"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "Rebuilding..." : "Rebuild Profiles"}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Summary Stats */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Total Customers"
              value={summary.total_customers}
              subValue={`${formatCurrency(summary.total_ar_outstanding)} outstanding`}
              icon={<Users className="w-5 h-5" />}
              trend="up"
            />
            <StatCard
              label="Total Vendors"
              value={summary.total_vendors}
              subValue={`${formatCurrency(summary.total_ap_outstanding)} payable`}
              icon={<Building2 className="w-5 h-5" />}
              trend="neutral"
            />
            <StatCard
              label="Lifetime Value"
              value={formatCurrency(summary.total_lifetime_value)}
              subValue="All-time transaction volume"
              icon={<BarChart3 className="w-5 h-5" />}
              trend="up"
            />
            <StatCard
              label="At Risk"
              value={summary.at_risk_count}
              subValue="Entities needing attention"
              icon={<AlertTriangle className="w-5 h-5" />}
              trend={summary.at_risk_count > 0 ? "down" : "neutral"}
            />
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 p-4 rounded-xl bg-gray-900/50 border border-gray-800/50">
          <div className="flex bg-gray-800/50 rounded-lg p-1">
            {(["all", "customer", "vendor", "at_risk"] as FilterType[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-1.5 text-xs font-medium rounded-md transition-all ${
                  filter === f
                    ? "bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg"
                    : "text-gray-400 hover:text-white hover:bg-gray-700/50"
                }`}
              >
                {f === "all" ? "All" : f === "customer" ? "Customers" : f === "vendor" ? "Vendors" : "At Risk"}
              </button>
            ))}
          </div>

          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              placeholder="Search entities..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm bg-gray-800/50 border border-gray-700/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-all"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-500" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortType)}
              className="px-3 py-2 text-xs bg-gray-800/50 border border-gray-700/50 rounded-lg text-gray-300 focus:outline-none focus:border-emerald-500/50"
            >
              <option value="lifetime_value">Lifetime Value</option>
              <option value="transaction_count">Transaction Count</option>
              <option value="reliability_score">Reliability</option>
              <option value="risk_score">Risk Level</option>
              <option value="last_transaction_date">Recent Activity</option>
            </select>
          </div>
        </div>

        {/* Results Count */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">
            Showing <span className="text-white font-medium">{filteredEntities.length}</span> entities
            {filter !== "all" && ` (${filter === "at_risk" ? "at risk" : filter + "s"})`}
          </p>
        </div>

        {/* Entity Grid */}
        {filteredEntities.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-gray-800/50 flex items-center justify-center mb-4">
              <Users className="w-8 h-8 text-gray-600" />
            </div>
            <h3 className="text-lg font-medium text-gray-300">No entities found</h3>
            <p className="text-sm text-gray-500 mt-1">Try adjusting your filters or run reconciliation to build profiles</p>
          </div>
        ) : (
          <>
            {/* Customers Section */}
            {(filter === "all" || filter === "customer" || filter === "at_risk") && customers.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                    <Users className="w-4 h-4 text-emerald-400" />
                  </div>
                  <h2 className="text-lg font-semibold text-white">Customers</h2>
                  <span className="text-sm text-gray-500">({customers.length})</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {customers.map((entity) => (
                    <EntityCard
                      key={entity.id}
                      entity={entity}
                      onClick={() => onSelectEntity?.(entity.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Vendors Section */}
            {(filter === "all" || filter === "vendor" || filter === "at_risk") && vendors.length > 0 && (
              <div className={customers.length > 0 && filter === "all" ? "mt-8" : ""}>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center">
                    <Building2 className="w-4 h-4 text-violet-400" />
                  </div>
                  <h2 className="text-lg font-semibold text-white">Vendors</h2>
                  <span className="text-sm text-gray-500">({vendors.length})</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {vendors.map((entity) => (
                    <EntityCard
                      key={entity.id}
                      entity={entity}
                      onClick={() => onSelectEntity?.(entity.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
