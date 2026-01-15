"use client"

import { useEffect, useState, useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ArrowUpDown, Building2, AlertCircle, TrendingDown } from "lucide-react"

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

interface VendorProfile {
  vendor_name: string
  total_bills: number
  total_outstanding: number
  total_overdue: number
  overdue_count: number
  open_count: number
  paid_count: number
  avg_payment_days: number | null
  last_bill_date: string | null
}

interface ApiResponse {
  vendors: VendorProfile[]
  totals: {
    total_vendors: number
    total_outstanding: number
    total_overdue: number
  }
}

type SortField = "vendor_name" | "total_outstanding" | "total_overdue" | "total_bills"
type SortOrder = "asc" | "desc"

export default function VendorProfilesPage() {
  const [allVendors, setAllVendors] = useState<VendorProfile[]>([])
  const [totals, setTotals] = useState({
    total_vendors: 0,
    total_outstanding: 0,
    total_overdue: 0,
  })
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [sortField, setSortField] = useState<SortField>("total_outstanding")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")

  useEffect(() => {
    const fetchVendors = async () => {
      try {
        setLoading(true)
        const response = await fetch(`/api/dashboard/vendors`)
        if (!response.ok) throw new Error("Failed to fetch vendors")

        const data: ApiResponse = await response.json()
        setAllVendors(data.vendors)
        setTotals(data.totals)
      } catch (error) {
        console.error("Error fetching vendors:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchVendors()
  }, [])

  const displayedVendors = useMemo(() => {
    let filtered = allVendors

    if (search) {
      const q = search.toLowerCase()
      filtered = filtered.filter((vendor) => vendor.vendor_name.toLowerCase().includes(q))
    }

    filtered = [...filtered].sort((a, b) => {
      let aVal: number | string, bVal: number | string
      if (sortField === "vendor_name") {
        aVal = a.vendor_name; bVal = b.vendor_name
      } else if (sortField === "total_outstanding") {
        aVal = a.total_outstanding; bVal = b.total_outstanding
      } else if (sortField === "total_overdue") {
        aVal = a.total_overdue; bVal = b.total_overdue
      } else {
        aVal = a.total_bills; bVal = b.total_bills
      }
      
      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortOrder === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      }
      return sortOrder === "asc" ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number)
    })

    return filtered
  }, [allVendors, search, sortField, sortOrder])

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

  const hasOverdue = totals.total_overdue > 0

  return (
    <div className="min-h-screen bg-[#141414]">
      <div className="border-b border-white/[0.06] px-8 py-8">
        <h1 className="text-2xl font-semibold text-white tracking-tight">Vendor Profiles</h1>
        <p className="text-sm text-neutral-500 mt-1">Detailed vendor relationships &middot; payment history</p>
      </div>

      {/* KPI Cards */}
      <div className="px-8 py-6 grid grid-cols-3 gap-4">
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-neutral-500 font-medium uppercase tracking-wider">Total Vendors</p>
            <Building2 size={14} className="text-neutral-600" />
          </div>
          <p className="text-2xl font-semibold text-white tabular-nums tracking-tight">{totals.total_vendors}</p>
          <p className="text-[11px] text-neutral-600 mt-2">active relationships</p>
        </div>

        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-neutral-500 font-medium uppercase tracking-wider">Total Outstanding</p>
            <TrendingDown size={14} className="text-neutral-600" />
          </div>
          <p className="text-2xl font-semibold text-white tabular-nums tracking-tight">{formatCurrency(totals.total_outstanding)}</p>
          <p className="text-[11px] text-neutral-600 mt-2">across all vendors</p>
        </div>

        <div className={`border rounded-xl p-5 ${hasOverdue ? "bg-red-500/[0.06] border-red-500/[0.15]" : "bg-white/[0.02] border-white/[0.06]"}`}>
          <div className="flex items-start justify-between mb-3">
            <p className={`text-[11px] font-medium uppercase tracking-wider ${hasOverdue ? "text-red-400/70" : "text-neutral-500"}`}>Total Overdue</p>
            <AlertCircle size={14} className={hasOverdue ? "text-red-400/60" : "text-neutral-600"} />
          </div>
          <p className={`text-2xl font-semibold tabular-nums tracking-tight ${hasOverdue ? "text-red-400" : "text-neutral-500"}`}>{formatCurrency(totals.total_overdue)}</p>
          <p className={`text-[11px] mt-2 ${hasOverdue ? "text-red-400/50" : "text-neutral-600"}`}>requires attention</p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="px-8 py-3 border-b border-white/[0.06] flex gap-3 items-center">
        <Input
          placeholder="Search vendor..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-white/[0.03] border-white/[0.06] text-neutral-300 placeholder:text-neutral-600 rounded-lg h-9 text-sm"
        />
      </div>

      {/* Grid */}
      <div className="px-8 py-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="relative w-10 h-10 mb-4">
              <div className="absolute inset-0 rounded-full border-2 border-neutral-800" />
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-neutral-400 animate-spin" />
            </div>
            <p className="text-neutral-500 text-sm">Loading vendor profiles&hellip;</p>
          </div>
        ) : displayedVendors.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <AlertCircle size={20} className="text-neutral-600 mb-3" />
            <p className="text-neutral-500 text-sm">No vendors match your search</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {displayedVendors.map((vendor) => {
              const hasOverdueAmount = vendor.total_overdue > 0
              const allPaid = vendor.paid_count === vendor.total_bills
              const paymentRate = vendor.total_bills > 0 ? Math.round((vendor.paid_count / vendor.total_bills) * 100) : 0

              const statusColor = allPaid
                ? "text-emerald-400"
                : hasOverdueAmount
                  ? "text-red-400"
                  : "text-neutral-400"

              const badgeClasses = allPaid
                ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/20"
                : hasOverdueAmount
                  ? "bg-red-400/10 text-red-400 border-red-400/20"
                  : "bg-white/5 text-zinc-400 border-white/10"

              const badgeLabel = allPaid ? "Settled" : hasOverdueAmount ? "Overdue" : "Current"

              return (
                <div key={vendor.vendor_name} className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5 hover:border-white/[0.12] transition-all">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold text-white truncate">{vendor.vendor_name}</h3>
                      <p className="text-[11px] text-neutral-600 mt-1">{vendor.total_bills} bills</p>
                    </div>
                    <Badge variant="secondary" className={`text-[11px] font-medium border ${badgeClasses}`}>
                      {badgeLabel}
                    </Badge>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <p className="text-[11px] text-neutral-600 font-medium uppercase tracking-wider mb-1">Outstanding</p>
                      <p className={`text-lg font-semibold tabular-nums tracking-tight ${statusColor}`}>{formatCurrency(vendor.total_outstanding)}</p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[11px] text-neutral-600 font-medium uppercase tracking-wider mb-1">Overdue</p>
                        <p className={`text-sm font-semibold tabular-nums ${hasOverdueAmount ? "text-red-400" : "text-zinc-500"}`}>{formatCurrency(vendor.total_overdue)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-neutral-600 font-medium uppercase tracking-wider mb-1">Paid Rate</p>
                        <p className="text-sm font-semibold text-emerald-400 tabular-nums">{paymentRate}%</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/[0.06]">
                      <div className="text-center">
                        <p className="text-[11px] text-neutral-600 font-medium mb-1">Open</p>
                        <p className="text-sm font-semibold text-neutral-300">{vendor.open_count}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[11px] text-neutral-600 font-medium mb-1">Overdue</p>
                        <p className={`text-sm font-semibold ${hasOverdueAmount ? "text-red-400" : "text-zinc-500"}`}>{vendor.overdue_count}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[11px] text-neutral-600 font-medium mb-1">Paid</p>
                        <p className="text-sm font-semibold text-emerald-400">{vendor.paid_count}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {!loading && displayedVendors.length > 0 && (
          <p className="mt-6 text-[12px] text-neutral-600">
            Showing {displayedVendors.length} of {allVendors.length} vendors
          </p>
        )}
      </div>
    </div>
  )
}
