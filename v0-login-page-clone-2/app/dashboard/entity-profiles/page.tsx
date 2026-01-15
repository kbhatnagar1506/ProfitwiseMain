"use client"

import { useEffect, useState, useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ArrowUpDown, Users, TrendingUp, AlertCircle } from "lucide-react"

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

interface EntityProfile {
  id: string
  canonical_name: string
  entity_type: "customer" | "vendor"
  total_transactions: number
  total_volume: number
  average_transaction: number
  last_transaction_date: string | null
  first_transaction_date: string | null
  payment_status: "on_time" | "late" | "mixed" | "unknown"
  average_days_to_pay: number | null
  outstanding_balance: number
  lifetime_value: number
  relationship_strength: "strong" | "moderate" | "weak"
  aliases: string[]
}

interface ApiResponse {
  profiles: EntityProfile[]
  totals: {
    total_entities: number
    total_customers: number
    total_vendors: number
    total_volume: number
  }
}

type SortField = "canonical_name" | "total_volume" | "total_transactions" | "outstanding_balance"
type SortOrder = "asc" | "desc"

export default function EntityProfilesPage() {
  const [allProfiles, setAllProfiles] = useState<EntityProfile[]>([])
  const [totals, setTotals] = useState({
    total_entities: 0,
    total_customers: 0,
    total_vendors: 0,
    total_volume: 0,
  })
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [entityTypeFilter, setEntityTypeFilter] = useState<"all" | "customer" | "vendor">("all")
  const [sortField, setSortField] = useState<SortField>("total_volume")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")

  useEffect(() => {
    const fetchProfiles = async () => {
      try {
        setLoading(true)
        const response = await fetch(`/api/dashboard/entity-profiles`)
        if (!response.ok) throw new Error("Failed to fetch entity profiles")

        const data: ApiResponse = await response.json()
        setAllProfiles(data.profiles)
        setTotals(data.totals)
      } catch (error) {
        console.error("Error fetching entity profiles:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchProfiles()
  }, [])

  const displayedProfiles = useMemo(() => {
    let filtered = allProfiles

    if (entityTypeFilter !== "all") {
      filtered = filtered.filter((p) => p.entity_type === entityTypeFilter)
    }

    if (search) {
      const q = search.toLowerCase()
      filtered = filtered.filter(
        (p) =>
          p.canonical_name.toLowerCase().includes(q) ||
          p.aliases.some((a) => a.toLowerCase().includes(q))
      )
    }

    filtered = [...filtered].sort((a, b) => {
      let aVal: number | string, bVal: number | string
      if (sortField === "canonical_name") {
        aVal = a.canonical_name; bVal = b.canonical_name
      } else if (sortField === "total_volume") {
        aVal = a.total_volume; bVal = b.total_volume
      } else if (sortField === "total_transactions") {
        aVal = a.total_transactions; bVal = b.total_transactions
      } else {
        aVal = a.outstanding_balance; bVal = b.outstanding_balance
      }

      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortOrder === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      }
      return sortOrder === "asc" ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number)
    })

    return filtered
  }, [allProfiles, search, entityTypeFilter, sortField, sortOrder])

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortOrder("desc")
    }
  }

  const SortHeader = ({ field, label }: { field: SortField; label: string }) => (
    <button
      onClick={() => toggleSort(field)}
      className="inline-flex items-center gap-1.5 hover:text-neutral-200 transition-colors"
    >
      {label}
      <ArrowUpDown size={12} className={`text-neutral-500 ${sortField === field ? "text-neutral-300" : ""} ${sortField === field && sortOrder === "desc" ? "rotate-180" : ""} transition-transform`} />
    </button>
  )

  return (
    <div className="min-h-screen bg-[#141414]">
      <div className="border-b border-white/[0.06] px-8 py-8">
        <h1 className="text-2xl font-semibold text-white tracking-tight">Entity Profiles</h1>
        <p className="text-sm text-neutral-500 mt-1">Customers & vendors &middot; relationship intelligence</p>
      </div>

      {/* KPI Cards */}
      <div className="px-8 py-6 grid grid-cols-4 gap-4">
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-neutral-500 font-medium uppercase tracking-wider">Total Entities</p>
            <Users size={14} className="text-neutral-600" />
          </div>
          <p className="text-2xl font-semibold text-white tabular-nums tracking-tight">{totals.total_entities}</p>
          <p className="text-[11px] text-neutral-600 mt-2">{totals.total_customers} customers, {totals.total_vendors} vendors</p>
        </div>

        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-neutral-500 font-medium uppercase tracking-wider">Total Volume</p>
            <TrendingUp size={14} className="text-neutral-600" />
          </div>
          <p className="text-2xl font-semibold text-white tabular-nums tracking-tight">{formatCurrency(totals.total_volume)}</p>
          <p className="text-[11px] text-neutral-600 mt-2">lifetime transaction value</p>
        </div>

        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-neutral-500 font-medium uppercase tracking-wider">Customers</p>
            <Users size={14} className="text-emerald-600" />
          </div>
          <p className="text-2xl font-semibold text-emerald-400/90 tabular-nums tracking-tight">{totals.total_customers}</p>
          <p className="text-[11px] text-emerald-600/70 mt-2">active relationships</p>
        </div>

        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-neutral-500 font-medium uppercase tracking-wider">Vendors</p>
            <Users size={14} className="text-amber-600" />
          </div>
          <p className="text-2xl font-semibold text-amber-400/90 tabular-nums tracking-tight">{totals.total_vendors}</p>
          <p className="text-[11px] text-amber-600/70 mt-2">active relationships</p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="px-8 py-3 border-b border-white/[0.06] flex gap-3 items-center">
        <div className="flex gap-2">
          <button
            onClick={() => setEntityTypeFilter("all")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              entityTypeFilter === "all"
                ? "bg-white/[0.1] text-white border border-white/[0.2]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            All
          </button>
          <button
            onClick={() => setEntityTypeFilter("customer")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              entityTypeFilter === "customer"
                ? "bg-emerald-400/[0.15] text-emerald-300 border border-emerald-400/[0.3]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            Customers
          </button>
          <button
            onClick={() => setEntityTypeFilter("vendor")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              entityTypeFilter === "vendor"
                ? "bg-amber-400/[0.15] text-amber-300 border border-amber-400/[0.3]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            Vendors
          </button>
        </div>

        <Input
          placeholder="Search by name or alias..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-white/[0.03] border-white/[0.06] text-neutral-300 placeholder:text-neutral-600 rounded-lg h-9 text-sm"
        />
      </div>

      {/* Table */}
      <div className="px-8 py-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="relative w-10 h-10 mb-4">
              <div className="absolute inset-0 rounded-full border-2 border-neutral-800" />
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-neutral-400 animate-spin" />
            </div>
            <p className="text-neutral-500 text-sm">Loading entity profiles&hellip;</p>
          </div>
        ) : displayedProfiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <AlertCircle size={20} className="text-neutral-600 mb-3" />
            <p className="text-neutral-500 text-sm">No entities match your search</p>
          </div>
        ) : (
          <div className="border border-white/[0.06] rounded-lg overflow-hidden">
            <table className="w-full table-fixed">
              <colgroup>
                <col className="w-40" />
                <col className="w-32" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-24" />
                <col />
              </colgroup>
              <thead>
                <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                  <th className="px-3 py-3 text-left text-[11px] font-medium text-neutral-500 uppercase tracking-wider"><SortHeader field="canonical_name" label="Entity" /></th>
                  <th className="px-3 py-3 text-center text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Type</th>
                  <th className="px-3 py-3 text-right text-[11px] font-medium text-neutral-500 uppercase tracking-wider"><SortHeader field="total_transactions" label="Transactions" /></th>
                  <th className="px-3 py-3 text-right text-[11px] font-medium text-neutral-500 uppercase tracking-wider"><SortHeader field="total_volume" label="Volume" /></th>
                  <th className="px-3 py-3 text-right text-[11px] font-medium text-neutral-500 uppercase tracking-wider"><SortHeader field="outstanding_balance" label="Outstanding" /></th>
                  <th className="px-3 py-3 text-center text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Strength</th>
                  <th className="px-3 py-3 text-left text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Aliases</th>
                </tr>
              </thead>
              <tbody>
                {displayedProfiles.map((profile) => {
                  const typeColor = profile.entity_type === "customer" ? "text-emerald-400" : "text-amber-400"
                  const typeBg = profile.entity_type === "customer" ? "bg-emerald-400/10" : "bg-amber-400/10"
                  const strengthColor = profile.relationship_strength === "strong" ? "text-emerald-400" : profile.relationship_strength === "moderate" ? "text-amber-400" : "text-neutral-500"

                  return (
                    <tr key={profile.id} className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors">
                      <td className="px-3 py-3 text-sm font-medium text-neutral-200 truncate">{profile.canonical_name}</td>
                      <td className="px-3 py-3 text-center">
                        <Badge variant="secondary" className={`text-[11px] font-medium border ${typeBg} ${typeColor} border-white/10`}>
                          {profile.entity_type === "customer" ? "Customer" : "Vendor"}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-sm text-neutral-400 text-right tabular-nums">{profile.total_transactions}</td>
                      <td className="px-3 py-3 text-sm text-neutral-300 text-right tabular-nums tracking-tight">{formatCurrency(profile.total_volume)}</td>
                      <td className={`px-3 py-3 text-sm text-right tabular-nums tracking-tight ${profile.outstanding_balance > 0 ? "text-red-400" : "text-zinc-500"}`}>{formatCurrency(profile.outstanding_balance)}</td>
                      <td className="px-3 py-3 text-center">
                        <span className={`text-[11px] font-semibold uppercase tracking-wider ${strengthColor}`}>
                          {profile.relationship_strength}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-[11px] text-neutral-600 truncate">
                        {profile.aliases.length > 0 ? profile.aliases.join(", ") : "—"}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && displayedProfiles.length > 0 && (
          <p className="mt-4 text-[12px] text-neutral-600">
            Showing {displayedProfiles.length} of {allProfiles.length} entities
          </p>
        )}
      </div>
    </div>
  )
}
