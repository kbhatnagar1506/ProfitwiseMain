"use client"

import { useEffect, useState, useMemo, Fragment } from "react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ChevronDown, ArrowUpDown, Building2, AlertCircle } from "lucide-react"

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

interface Vendor {
  vendor_name: string
  total_bills: number
  total_outstanding: number
  total_overdue: number
  overdue_count: number
  open_count: number
  paid_count: number
}

interface ApiResponse {
  vendors: Vendor[]
  totals: {
    total_vendors: number
    total_outstanding: number
    total_overdue: number
  }
}

type SortField = "vendor_name" | "total_outstanding" | "total_overdue"
type SortOrder = "asc" | "desc"

export default function VendorsPage() {
  const [allVendors, setAllVendors] = useState<Vendor[]>([])
  const [totals, setTotals] = useState({
    total_vendors: 0,
    total_outstanding: 0,
    total_overdue: 0,
  })
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [sortField, setSortField] = useState<SortField>("total_outstanding")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

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
      } else {
        aVal = a.total_overdue; bVal = b.total_overdue
      }
      
      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortOrder === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      }
      return sortOrder === "asc" ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number)
    })

    return filtered
  }, [allVendors, search, sortField, sortOrder])

  const toggleExpandedRow = (name: string) => {
    const next = new Set(expandedRows)
    if (next.has(name)) next.delete(name); else next.add(name)
    setExpandedRows(next)
  }

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
        <h1 className="text-2xl font-semibold text-white tracking-tight">Vendors</h1>
        <p className="text-sm text-neutral-500 mt-1">Vendor relationships &middot; payment status</p>
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
            <AlertCircle size={14} className="text-neutral-600" />
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

      {/* Table */}
      <div className="px-8 py-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="relative w-10 h-10 mb-4">
              <div className="absolute inset-0 rounded-full border-2 border-neutral-800" />
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-neutral-400 animate-spin" />
            </div>
            <p className="text-neutral-500 text-sm">Loading vendors&hellip;</p>
          </div>
        ) : displayedVendors.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <AlertCircle size={20} className="text-neutral-600 mb-3" />
            <p className="text-neutral-500 text-sm">No vendors match your search</p>
          </div>
        ) : (
          <div className="border border-white/[0.06] rounded-lg overflow-hidden">
            <table className="w-full table-fixed">
              <colgroup>
                <col className="w-10" />
                <col />
                <col className="w-24" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-24" />
              </colgroup>
              <thead>
                <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                  <th className="px-3 py-3" />
                  <th className="px-3 py-3 text-left text-[11px] font-medium text-neutral-500 uppercase tracking-wider"><SortHeader field="vendor_name" label="Vendor" /></th>
                  <th className="px-3 py-3 text-right text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Bills</th>
                  <th className="px-3 py-3 text-right text-[11px] font-medium text-neutral-500 uppercase tracking-wider"><SortHeader field="total_outstanding" label="Outstanding" /></th>
                  <th className="px-3 py-3 text-right text-[11px] font-medium text-neutral-500 uppercase tracking-wider"><SortHeader field="total_overdue" label="Overdue" /></th>
                  <th className="px-3 py-3 text-center text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody>
                {displayedVendors.map((vendor) => {
                  const hasOverdueAmount = vendor.total_overdue > 0
                  const allPaid = vendor.paid_count === vendor.total_bills

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
                    <Fragment key={vendor.vendor_name}>
                      <tr className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors">
                        <td className="px-3 py-3">
                          <button
                            onClick={() => toggleExpandedRow(vendor.vendor_name)}
                            className="text-neutral-600 hover:text-neutral-400 transition-colors"
                          >
                            <ChevronDown
                              size={14}
                              className={`transition-transform duration-150 ${expandedRows.has(vendor.vendor_name) ? "rotate-180" : ""}`}
                            />
                          </button>
                        </td>
                        <td className="px-3 py-3 text-sm text-neutral-200 truncate">{vendor.vendor_name}</td>
                        <td className="px-3 py-3 text-sm text-neutral-400 text-right tabular-nums">{vendor.total_bills}</td>
                        <td className={`px-3 py-3 text-sm text-right tabular-nums tracking-tight ${statusColor}`}>{formatCurrency(vendor.total_outstanding)}</td>
                        <td className={`px-3 py-3 text-sm text-right tabular-nums tracking-tight ${hasOverdueAmount ? "text-red-400" : "text-zinc-500"}`}>{formatCurrency(vendor.total_overdue)}</td>
                        <td className="px-3 py-3 text-center">
                          <Badge variant="secondary" className={`text-[11px] font-medium border ${badgeClasses}`}>
                            {badgeLabel}
                          </Badge>
                        </td>
                      </tr>
                      {expandedRows.has(vendor.vendor_name) && (
                        <tr className="border-b border-white/[0.04] bg-white/[0.015]">
                          <td colSpan={6} className="px-6 py-4">
                            <div className="grid grid-cols-4 gap-4 text-sm">
                              <div>
                                <p className="text-[11px] text-neutral-600 font-medium mb-1 uppercase tracking-wider">Total Bills</p>
                                <p className="text-neutral-300 tabular-nums">{vendor.total_bills}</p>
                              </div>
                              <div>
                                <p className="text-[11px] text-neutral-600 font-medium mb-1 uppercase tracking-wider">Open</p>
                                <p className="text-neutral-300 tabular-nums">{vendor.open_count}</p>
                              </div>
                              <div>
                                <p className="text-[11px] text-neutral-600 font-medium mb-1 uppercase tracking-wider">Overdue</p>
                                <p className={`tabular-nums ${hasOverdueAmount ? "text-red-400" : "text-zinc-500"}`}>{vendor.overdue_count}</p>
                              </div>
                              <div>
                                <p className="text-[11px] text-neutral-600 font-medium mb-1 uppercase tracking-wider">Paid</p>
                                <p className="text-emerald-400 tabular-nums">{vendor.paid_count}</p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && displayedVendors.length > 0 && (
          <p className="mt-4 text-[12px] text-neutral-600">
            Showing {displayedVendors.length} of {allVendors.length} vendors
          </p>
        )}
      </div>
    </div>
  )
}
