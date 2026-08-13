"use client"

import { useState, useEffect, useCallback } from "react"
import { RefreshCw, Users, Building2, AlertTriangle, Search, ChevronRight } from "lucide-react"

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

function formatCurrency(amount: number | string | null): string {
  if (amount === null || amount === undefined) return "$0"
  const num = typeof amount === "string" ? parseFloat(amount) : amount
  if (isNaN(num)) return "$0"
  if (num >= 1000000) return `$${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `$${(num / 1000).toFixed(1)}K`
  return `$${num.toFixed(0)}`
}

function getRiskColor(riskScore: number | null): string {
  if (riskScore === null) return "text-gray-400"
  if (riskScore > 0.6) return "text-red-400"
  if (riskScore > 0.4) return "text-yellow-400"
  return "text-green-400"
}

function getRiskIcon(riskScore: number | null): string {
  if (riskScore === null) return "bg-gray-500"
  if (riskScore > 0.6) return "bg-red-500"
  if (riskScore > 0.4) return "bg-yellow-500"
  return "bg-green-500"
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

export function EntitiesPage({
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
  const [sortBy, setSortBy] = useState("lifetime_value")

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">Customers & Vendors</h2>
        <button
          onClick={() => fetchEntities(true)}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-300 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-4 gap-3">
          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="text-xs text-gray-400">Total Entities</div>
            <div className="text-lg font-semibold text-white">{summary.total_entities}</div>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="text-xs text-gray-400 flex items-center gap-1">
              <Users className="w-3 h-3" /> Customers
            </div>
            <div className="text-lg font-semibold text-white">{summary.total_customers}</div>
            <div className="text-xs text-green-400">{formatCurrency(summary.total_ar_outstanding)} AR</div>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="text-xs text-gray-400 flex items-center gap-1">
              <Building2 className="w-3 h-3" /> Vendors
            </div>
            <div className="text-lg font-semibold text-white">{summary.total_vendors}</div>
            <div className="text-xs text-red-400">{formatCurrency(summary.total_ap_outstanding)} AP</div>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="text-xs text-gray-400 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> At Risk
            </div>
            <div className="text-lg font-semibold text-yellow-400">{summary.at_risk_count}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="flex bg-gray-800 rounded-lg p-0.5">
          {(["all", "customer", "vendor", "at_risk"] as FilterType[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                filter === f
                  ? "bg-gray-700 text-white"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {f === "all" ? "All" : f === "customer" ? "Customers" : f === "vendor" ? "Vendors" : "At Risk"}
            </button>
          ))}
        </div>

        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-gray-600"
          />
        </div>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none"
        >
          <option value="lifetime_value">Sort: Lifetime Value</option>
          <option value="transaction_count">Sort: Transactions</option>
          <option value="risk_score">Sort: Risk</option>
          <option value="last_transaction_date">Sort: Last Activity</option>
        </select>
      </div>

      {/* Entity List */}
      <div className="space-y-2">
        {filteredEntities.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            No entities found
          </div>
        ) : (
          filteredEntities.map((entity) => (
            <div
              key={entity.id}
              onClick={() => onSelectEntity?.(entity.id)}
              className="bg-gray-800/50 hover:bg-gray-800 rounded-lg p-3 cursor-pointer transition-colors group"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className={`w-2 h-2 rounded-full mt-2 ${getRiskIcon(entity.risk_score)}`} />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white">
                        {entity.display_name || entity.canonical_name}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-gray-700 rounded text-gray-400">
                        {getArchetypeLabel(entity.archetype)}
                      </span>
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {formatCurrency(entity.lifetime_value)} lifetime · {entity.transaction_count} transactions
                      {entity.last_transaction_date && ` · Last: ${new Date(entity.last_transaction_date).toLocaleDateString()}`}
                    </div>
                    {entity.ai_summary && (
                      <div className="text-xs text-gray-500 mt-1 italic line-clamp-1">
                        {entity.ai_summary}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    {entity.outstanding_amount !== null && entity.outstanding_amount > 0 && (
                      <div className="text-xs text-gray-400">
                        {formatCurrency(entity.outstanding_amount)} outstanding
                      </div>
                    )}
                    {entity.outstanding_amount !== null && entity.outstanding_amount < 0 && (
                      <div className="text-xs text-blue-400">
                        {formatCurrency(Math.abs(entity.outstanding_amount))} credit
                      </div>
                    )}
                    {entity.overdue_amount !== null && entity.overdue_amount > 0 && (
                      <div className="text-xs text-red-400">
                        {formatCurrency(entity.overdue_amount)} overdue
                      </div>
                    )}
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition-colors" />
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
