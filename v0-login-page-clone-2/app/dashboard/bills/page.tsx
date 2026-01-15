"use client"

import { useEffect, useState, useMemo, Fragment } from "react"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { ChevronDown, ArrowUpDown, TrendingDown, AlertCircle, CheckCircle2, Clock } from "lucide-react"

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

interface Bill {
  id: string
  entity_id: string
  vendor_name: string
  amount: number
  outstanding_amount: number
  due_date: string
  status: "open" | "overdue" | "partially_paid" | "paid"
  source: "invoice" | "inferred" | "model" | "attribution"
  days_until_due: number
  days_overdue: number | null
  metadata: Record<string, unknown>
}

interface ApiResponse {
  bills: Bill[]
  totals: {
    total_outstanding: number
    total_overdue: number
    bill_count: number
    overdue_count: number
  }
  summary_by_status: {
    open: number
    overdue: number
    partially_paid: number
    paid: number
  }
}

type SortField = "amount" | "due_date" | "days_overdue"
type SortOrder = "asc" | "desc"

function deriveDisplayStatus(bill: Bill): "paid" | "overdue" | "partially_paid" | "open" {
  if (bill.outstanding_amount <= 0) return "paid"
  if (bill.days_overdue !== null && bill.days_overdue > 0) return "overdue"
  if (bill.status === "partially_paid") return "partially_paid"
  return "open"
}

export default function BillsPage() {
  const [allBills, setAllBills] = useState<Bill[]>([])
  const [totals, setTotals] = useState({
    total_outstanding: 0,
    total_overdue: 0,
    bill_count: 0,
    overdue_count: 0,
  })
  const [summaryByStatus, setSummaryByStatus] = useState({
    open: 0,
    overdue: 0,
    partially_paid: 0,
    paid: 0,
  })
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState("all")
  const [search, setSearch] = useState("")
  const [sortField, setSortField] = useState<SortField>("due_date")
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc")
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  useEffect(() => {
    const fetchBills = async () => {
      try {
        setLoading(true)
        const response = await fetch(`/api/dashboard/bills`)
        if (!response.ok) throw new Error("Failed to fetch bills")

        const data: ApiResponse = await response.json()
        setAllBills(data.bills)
        setTotals(data.totals)
        setSummaryByStatus(data.summary_by_status)
      } catch (error) {
        console.error("Error fetching bills:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchBills()
  }, [])

  const displayedBills = useMemo(() => {
    let filtered = allBills

    if (status !== "all") {
      filtered = filtered.filter((bill) => {
        const ds = deriveDisplayStatus(bill)
        if (status === "overdue") return ds === "overdue"
        return ds === status
      })
    }

    if (search) {
      const q = search.toLowerCase()
      filtered = filtered.filter((bill) => bill.vendor_name.toLowerCase().includes(q))
    }

    filtered = [...filtered].sort((a, b) => {
      let aVal: number, bVal: number
      if (sortField === "amount") {
        aVal = a.amount; bVal = b.amount
      } else if (sortField === "due_date") {
        aVal = new Date(a.due_date).getTime(); bVal = new Date(b.due_date).getTime()
      } else {
        aVal = a.days_overdue ?? -a.days_until_due; bVal = b.days_overdue ?? -b.days_until_due
      }
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal
    })

    return filtered
  }, [allBills, status, search, sortField, sortOrder])

  const toggleExpandedRow = (id: string) => {
    const next = new Set(expandedRows)
    if (next.has(id)) next.delete(id); else next.add(id)
    setExpandedRows(next)
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortOrder("asc")
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
        <h1 className="text-2xl font-semibold text-white tracking-tight">Bills</h1>
        <p className="text-sm text-neutral-500 mt-1">Accounts payable &middot; reconciled</p>
      </div>

      {/* KPI Cards */}
      <div className="px-8 py-6 grid grid-cols-4 gap-4">
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-neutral-500 font-medium uppercase tracking-wider">Total Outstanding</p>
            <TrendingDown size={14} className="text-neutral-600" />
          </div>
          <p className="text-2xl font-semibold text-white tabular-nums tracking-tight">{formatCurrency(totals.total_outstanding)}</p>
          <p className="text-[11px] text-neutral-600 mt-2">{totals.bill_count} bills</p>
        </div>

        <div className={`border rounded-xl p-5 ${hasOverdue ? "bg-red-500/[0.06] border-red-500/[0.15]" : "bg-white/[0.02] border-white/[0.06]"}`}>
          <div className="flex items-start justify-between mb-3">
            <p className={`text-[11px] font-medium uppercase tracking-wider ${hasOverdue ? "text-red-400/70" : "text-neutral-500"}`}>Total Overdue</p>
            <AlertCircle size={14} className={hasOverdue ? "text-red-400/60" : "text-neutral-600"} />
          </div>
          <p className={`text-2xl font-semibold tabular-nums tracking-tight ${hasOverdue ? "text-red-400" : "text-neutral-500"}`}>{formatCurrency(totals.total_overdue)}</p>
          <p className={`text-[11px] mt-2 ${hasOverdue ? "text-red-400/50" : "text-neutral-600"}`}>{totals.overdue_count} overdue</p>
        </div>

        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-neutral-500 font-medium uppercase tracking-wider">Due Soon</p>
            <Clock size={14} className="text-neutral-600" />
          </div>
          <p className="text-2xl font-semibold text-neutral-300 tabular-nums tracking-tight">{summaryByStatus.open + summaryByStatus.overdue}</p>
          <p className="text-[11px] text-neutral-600 mt-2">awaiting payment</p>
        </div>

        <div className="bg-emerald-500/[0.04] border border-emerald-500/[0.12] rounded-xl p-5">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-emerald-500/70 font-medium uppercase tracking-wider">Paid</p>
            <CheckCircle2 size={14} className="text-emerald-500/50" />
          </div>
          <p className="text-2xl font-semibold text-emerald-400/90 tabular-nums tracking-tight">{summaryByStatus.paid}</p>
          <p className="text-[11px] text-emerald-500/40 mt-2">fully reconciled</p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="px-8 py-3 border-b border-white/[0.06] flex gap-3 items-center">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44 bg-white/[0.03] border-white/[0.06] text-neutral-300 rounded-lg h-9 text-sm">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent className="bg-[#1a1a1a] border-white/[0.08]">
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
            <SelectItem value="partially_paid">Partially Paid</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
          </SelectContent>
        </Select>

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
            <p className="text-neutral-500 text-sm">Loading bills&hellip;</p>
          </div>
        ) : displayedBills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <AlertCircle size={20} className="text-neutral-600 mb-3" />
            <p className="text-neutral-500 text-sm">No bills match your filters</p>
          </div>
        ) : (
          <div className="border border-white/[0.06] rounded-lg overflow-hidden">
            <table className="w-full table-fixed">
              <colgroup>
                <col className="w-10" />
                <col />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-24" />
                <col className="w-24" />
                <col className="w-20" />
              </colgroup>
              <thead>
                <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                  <th className="px-3 py-3" />
                  <th className="px-3 py-3 text-left text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Vendor</th>
                  <th className="px-3 py-3 text-right text-[11px] font-medium text-neutral-500 uppercase tracking-wider"><SortHeader field="amount" label="Amount" /></th>
                  <th className="px-3 py-3 text-right text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Outstanding</th>
                  <th className="px-3 py-3 text-left text-[11px] font-medium text-neutral-500 uppercase tracking-wider"><SortHeader field="due_date" label="Due Date" /></th>
                  <th className="px-3 py-3 text-right text-[11px] font-medium text-neutral-500 uppercase tracking-wider"><SortHeader field="days_overdue" label="Days Overdue" /></th>
                  <th className="px-3 py-3 text-center text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Status</th>
                  <th className="px-3 py-3 text-left text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Source</th>
                </tr>
              </thead>
              <tbody>
                {displayedBills.map((bill) => {
                  const ds = deriveDisplayStatus(bill)
                  const isPaid = ds === "paid"
                  const isOverdue = ds === "overdue"
                  const isPartial = ds === "partially_paid"

                  const outstandingColor = bill.outstanding_amount <= 0
                    ? "text-zinc-500"
                    : isOverdue ? "text-red-400" : isPartial ? "text-amber-400/80" : "text-neutral-300"

                  const badgeClasses = isPaid
                    ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/20"
                    : isOverdue
                      ? "bg-red-400/10 text-red-400 border-red-400/20"
                      : isPartial
                        ? "bg-amber-400/10 text-amber-400 border-amber-400/20"
                        : "bg-white/5 text-zinc-400 border-white/10"

                  const badgeLabel = isPaid ? "Paid" : isOverdue ? "Overdue" : isPartial ? "Partial" : "Open"

                  const daysDisplay = isPaid
                    ? "\u2014"
                    : bill.days_overdue !== null
                      ? String(Math.abs(bill.days_overdue))
                      : String(bill.days_until_due)

                  const daysColor = isPaid
                    ? "text-zinc-600"
                    : isOverdue ? "text-red-400" : "text-neutral-400"

                  return (
                    <Fragment key={bill.id}>
                      <tr className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors">
                        <td className="px-3 py-3">
                          <button
                            onClick={() => toggleExpandedRow(bill.id)}
                            className="text-neutral-600 hover:text-neutral-400 transition-colors"
                          >
                            <ChevronDown
                              size={14}
                              className={`transition-transform duration-150 ${expandedRows.has(bill.id) ? "rotate-180" : ""}`}
                            />
                          </button>
                        </td>
                        <td className="px-3 py-3 text-sm text-neutral-200 truncate">{bill.vendor_name}</td>
                        <td className="px-3 py-3 text-sm text-neutral-300 text-right tabular-nums tracking-tight">{formatCurrency(bill.amount)}</td>
                        <td className={`px-3 py-3 text-sm text-right tabular-nums tracking-tight ${outstandingColor}`}>{formatCurrency(bill.outstanding_amount)}</td>
                        <td className="px-3 py-3 text-sm text-neutral-400 tabular-nums">{bill.due_date.split("T")[0]}</td>
                        <td className={`px-3 py-3 text-sm text-right tabular-nums tracking-tight ${daysColor}`}>{daysDisplay}</td>
                        <td className="px-3 py-3 text-center">
                          <Badge variant="secondary" className={`text-[11px] font-medium border ${badgeClasses}`}>
                            {badgeLabel}
                          </Badge>
                        </td>
                        <td className="px-3 py-3 text-[11px] text-neutral-600 capitalize">{bill.source}</td>
                      </tr>
                      {expandedRows.has(bill.id) && (
                        <tr className="border-b border-white/[0.04] bg-white/[0.015]">
                          <td colSpan={8} className="px-6 py-4">
                            <div className="grid grid-cols-4 gap-4 text-sm">
                              <div>
                                <p className="text-[11px] text-neutral-600 font-medium mb-1 uppercase tracking-wider">Bill ID</p>
                                <p className="text-neutral-400 font-mono text-xs truncate">{bill.id}</p>
                              </div>
                              <div>
                                <p className="text-[11px] text-neutral-600 font-medium mb-1 uppercase tracking-wider">Entity ID</p>
                                <p className="text-neutral-400 font-mono text-xs truncate">{bill.entity_id}</p>
                              </div>
                              <div>
                                <p className="text-[11px] text-neutral-600 font-medium mb-1 uppercase tracking-wider">Full Amount</p>
                                <p className="text-neutral-300 tabular-nums">{formatCurrency(bill.amount)}</p>
                              </div>
                              <div>
                                <p className="text-[11px] text-neutral-600 font-medium mb-1 uppercase tracking-wider">Outstanding</p>
                                <p className={`tabular-nums ${outstandingColor}`}>{formatCurrency(bill.outstanding_amount)}</p>
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

        {!loading && displayedBills.length > 0 && (
          <p className="mt-4 text-[12px] text-neutral-600">
            Showing {displayedBills.length} of {allBills.length} bills
          </p>
        )}
      </div>
    </div>
  )
}
