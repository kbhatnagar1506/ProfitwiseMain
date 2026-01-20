"use client"

import { useEffect, useState, useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { ChevronDown, ArrowUpDown, TrendingUp, AlertCircle, CheckCircle2, Clock } from "lucide-react"

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

interface Invoice {
  id: string
  entity_id: string
  customer_name: string
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
  invoices: Invoice[]
  totals: {
    total_outstanding: number
    total_overdue: number
    invoice_count: number
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

export default function InvoicesPage() {
  const [allInvoices, setAllInvoices] = useState<Invoice[]>([])
  const [totals, setTotals] = useState({
    total_outstanding: 0,
    total_overdue: 0,
    invoice_count: 0,
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

  // Fetch all invoices once on mount
  useEffect(() => {
    const fetchInvoices = async () => {
      try {
        setLoading(true)
        const response = await fetch(`/api/dashboard/invoices`)
        if (!response.ok) throw new Error("Failed to fetch invoices")

        const data: ApiResponse = await response.json()
        setAllInvoices(data.invoices)
        setTotals(data.totals)
        setSummaryByStatus(data.summary_by_status)
      } catch (error) {
        console.error("Error fetching invoices:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchInvoices()
  }, [])

  // Client-side filtering and sorting
  const displayedInvoices = useMemo(() => {
    let filtered = allInvoices

    // Filter by status
    if (status !== "all") {
      if (status === "overdue") {
        filtered = filtered.filter((inv) => inv.status === "overdue" || (inv.days_overdue !== null && inv.days_overdue > 0))
      } else {
        filtered = filtered.filter((inv) => inv.status === status)
      }
    }

    // Filter by search
    if (search) {
      filtered = filtered.filter((inv) => inv.customer_name.toLowerCase().includes(search.toLowerCase()))
    }

    // Sort
    filtered.sort((a, b) => {
      let aVal: number
      let bVal: number

      if (sortField === "amount") {
        aVal = a.amount
        bVal = b.amount
      } else if (sortField === "due_date") {
        aVal = new Date(a.due_date).getTime()
        bVal = new Date(b.due_date).getTime()
      } else {
        // days_overdue
        aVal = a.days_overdue ?? a.days_until_due
        bVal = b.days_overdue ?? b.days_until_due
      }

      return sortOrder === "asc" ? aVal - bVal : bVal - aVal
    })

    return filtered
  }, [allInvoices, status, search, sortField, sortOrder])

  const toggleExpandedRow = (id: string) => {
    const newExpanded = new Set(expandedRows)
    if (newExpanded.has(id)) {
      newExpanded.delete(id)
    } else {
      newExpanded.add(id)
    }
    setExpandedRows(newExpanded)
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortOrder("asc")
    }
  }

  const getStatusColor = (status: string, daysOverdue: number | null) => {
    if (status === "paid") return "text-emerald-400/90"
    if (status === "overdue" || (daysOverdue !== null && daysOverdue > 0)) return "text-red-400/80"
    if (status === "partially_paid") return "text-amber-400/80"
    return "text-neutral-300"
  }

  const getStatusBadgeVariant = (status: string, daysOverdue: number | null) => {
    if (status === "paid") return "bg-emerald-400/10 text-emerald-300 border-emerald-400/20"
    if (status === "overdue" || (daysOverdue !== null && daysOverdue > 0)) return "bg-red-400/10 text-red-300 border-red-400/20"
    if (status === "partially_paid") return "bg-amber-400/10 text-amber-300 border-amber-400/20"
    return "bg-white/5 text-zinc-300 border-white/10"
  }

  const SortHeader = ({ field, label }: { field: SortField; label: string }) => (
    <button
      onClick={() => toggleSort(field)}
      className="flex items-center gap-2 hover:text-neutral-200 transition-colors duration-200 group"
    >
      {label}
      {sortField === field && (
        <ArrowUpDown size={14} className={`transition-transform duration-200 text-neutral-400 group-hover:text-neutral-200 ${sortOrder === "desc" ? "rotate-180" : ""}`} />
      )}
    </button>
  )

  return (
    <div className="min-h-screen bg-[#141414]">
      {/* Header */}
      <div className="border-b border-white/[0.06] px-8 py-8 bg-gradient-to-r from-white/[0.02] to-transparent">
        <h1 className="text-3xl font-bold text-white mb-2">Invoices</h1>
        <p className="text-sm text-neutral-500">Manage your accounts receivable • Real-time reconciliation data</p>
      </div>

      {/* Summary Cards */}
      <div className="px-8 py-6 grid grid-cols-4 gap-4">
        <div className="group bg-gradient-to-br from-white/[0.04] to-white/[0.01] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.12] transition-all duration-300 hover:shadow-lg hover:shadow-white/[0.05]">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-neutral-500 font-medium uppercase tracking-wider">Total Outstanding</p>
            <TrendingUp size={16} className="text-neutral-600 group-hover:text-neutral-400 transition-colors" />
          </div>
          <p className="text-2xl font-bold text-white tabular-nums mb-2">{formatCurrency(totals.total_outstanding)}</p>
          <p className="text-[12px] text-neutral-600">{totals.invoice_count} invoices</p>
        </div>

        <div className="group bg-gradient-to-br from-red-500/[0.08] to-red-500/[0.02] border border-red-500/[0.15] rounded-xl p-5 hover:border-red-500/[0.25] transition-all duration-300 hover:shadow-lg hover:shadow-red-500/[0.1]">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-red-600 font-medium uppercase tracking-wider">Total Overdue</p>
            <AlertCircle size={16} className="text-red-500/70 group-hover:text-red-400 transition-colors" />
          </div>
          <p className="text-2xl font-bold text-red-400/90 tabular-nums mb-2">{formatCurrency(totals.total_overdue)}</p>
          <p className="text-[12px] text-red-600/70">{totals.overdue_count} overdue</p>
        </div>

        <div className="group bg-gradient-to-br from-white/[0.04] to-white/[0.01] border border-white/[0.08] rounded-xl p-5 hover:border-white/[0.12] transition-all duration-300 hover:shadow-lg hover:shadow-white/[0.05]">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-neutral-500 font-medium uppercase tracking-wider">Open</p>
            <Clock size={16} className="text-neutral-600 group-hover:text-neutral-400 transition-colors" />
          </div>
          <p className="text-2xl font-bold text-neutral-300 tabular-nums mb-2">{summaryByStatus.open}</p>
          <p className="text-[12px] text-neutral-600">awaiting payment</p>
        </div>

        <div className="group bg-gradient-to-br from-emerald-500/[0.08] to-emerald-500/[0.02] border border-emerald-500/[0.15] rounded-xl p-5 hover:border-emerald-500/[0.25] transition-all duration-300 hover:shadow-lg hover:shadow-emerald-500/[0.1]">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[11px] text-emerald-600 font-medium uppercase tracking-wider">Paid</p>
            <CheckCircle2 size={16} className="text-emerald-500/70 group-hover:text-emerald-400 transition-colors" />
          </div>
          <p className="text-2xl font-bold text-emerald-400/90 tabular-nums mb-2">{summaryByStatus.paid}</p>
          <p className="text-[12px] text-emerald-600/70">fully reconciled</p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="px-8 py-4 border-b border-white/[0.06] flex gap-3 items-center bg-gradient-to-r from-white/[0.01] to-transparent">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44 bg-white/[0.03] border-white/[0.08] text-neutral-300 hover:bg-white/[0.05] hover:border-white/[0.12] transition-all rounded-lg">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent className="bg-[#1a1a1a] border-white/[0.06]">
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
            <SelectItem value="partially_paid">Partially Paid</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
          </SelectContent>
        </Select>

        <Input
          placeholder="Search customer..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-white/[0.03] border-white/[0.08] text-neutral-300 placeholder:text-neutral-600 hover:bg-white/[0.05] hover:border-white/[0.12] transition-all rounded-lg"
        />
      </div>

      {/* Invoices Table */}
      <div className="px-8 py-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="relative w-12 h-12 mb-4">
              <div className="absolute inset-0 rounded-full border-2 border-neutral-700"></div>
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-neutral-300 animate-spin"></div>
            </div>
            <p className="text-neutral-400 font-medium">Loading invoices...</p>
            <p className="text-neutral-600 text-sm mt-1">Fetching your reconciled data</p>
          </div>
        ) : displayedInvoices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 border border-white/[0.06] rounded-xl bg-gradient-to-b from-white/[0.02] to-white/[0.01]">
            <div className="w-12 h-12 rounded-full bg-white/[0.05] flex items-center justify-center mb-4">
              <AlertCircle size={24} className="text-neutral-600" />
            </div>
            <p className="text-neutral-400 font-medium">No invoices found</p>
            <p className="text-neutral-600 text-sm mt-1">Try adjusting your filters or search</p>
          </div>
        ) : (
          <div className="border border-white/[0.06] rounded-xl overflow-hidden bg-gradient-to-b from-white/[0.02] to-white/[0.01] shadow-lg shadow-black/20">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06] bg-gradient-to-r from-white/[0.04] to-white/[0.01]">
                  <th className="px-4 py-4 text-left text-[11px] font-semibold text-neutral-600 uppercase tracking-wider"></th>
                  <th className="px-4 py-4 text-left text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Customer</th>
                  <th className="px-4 py-4 text-right text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">
                    <SortHeader field="amount" label="Amount" />
                  </th>
                  <th className="px-4 py-4 text-right text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Outstanding</th>
                  <th className="px-4 py-4 text-left text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">
                    <SortHeader field="due_date" label="Due Date" />
                  </th>
                  <th className="px-4 py-4 text-right text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">
                    <SortHeader field="days_overdue" label="Days" />
                  </th>
                  <th className="px-4 py-4 text-left text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-4 text-left text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Source</th>
                </tr>
              </thead>
              <tbody>
                {displayedInvoices.map((invoice, idx) => (
                  <div key={invoice.id}>
                    <tr className="border-b border-white/[0.04] hover:bg-white/[0.04] transition-all duration-200 group">
                      <td className="px-4 py-4">
                        <button
                          onClick={() => toggleExpandedRow(invoice.id)}
                          className="text-neutral-600 hover:text-neutral-400 transition-colors group-hover:text-neutral-400"
                        >
                          <ChevronDown
                            size={16}
                            className={`transition-transform duration-200 ${expandedRows.has(invoice.id) ? "rotate-180" : ""}`}
                          />
                        </button>
                      </td>
                      <td className="px-4 py-4 text-sm font-medium text-neutral-200 group-hover:text-white transition-colors">{invoice.customer_name}</td>
                      <td className="px-4 py-4 text-sm text-neutral-300 text-right tabular-nums font-medium">{formatCurrency(invoice.amount)}</td>
                      <td className={`px-4 py-4 text-sm text-right tabular-nums font-semibold transition-colors ${getStatusColor(invoice.status, invoice.days_overdue)}`}>
                        {formatCurrency(invoice.outstanding_amount)}
                      </td>
                      <td className="px-4 py-4 text-sm text-neutral-400">{invoice.due_date.split("T")[0]}</td>
                      <td className={`px-4 py-4 text-sm text-right tabular-nums font-medium transition-colors ${getStatusColor(invoice.status, invoice.days_overdue)}`}>
                        {invoice.days_overdue !== null ? `-${invoice.days_overdue}` : `${invoice.days_until_due}`}
                      </td>
                      <td className="px-4 py-4">
                        <Badge
                          variant="secondary"
                          className={`text-[11px] font-semibold border transition-all duration-200 ${getStatusBadgeVariant(invoice.status, invoice.days_overdue)}`}
                        >
                          {invoice.status === "overdue" || (invoice.days_overdue !== null && invoice.days_overdue > 0)
                            ? "Overdue"
                            : invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                        </Badge>
                      </td>
                      <td className="px-4 py-4 text-sm text-neutral-500 capitalize">{invoice.source}</td>
                    </tr>
                    {expandedRows.has(invoice.id) && (
                      <tr className="border-b border-white/[0.04] bg-gradient-to-r from-white/[0.02] to-transparent animate-in fade-in duration-200">
                        <td colSpan={8} className="px-4 py-5">
                          <div className="grid grid-cols-4 gap-6 text-sm">
                            <div className="bg-white/[0.02] rounded-lg p-4 border border-white/[0.06]">
                              <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wider">Invoice ID</p>
                              <p className="text-neutral-300 font-mono text-xs break-all">{invoice.id}</p>
                            </div>
                            <div className="bg-white/[0.02] rounded-lg p-4 border border-white/[0.06]">
                              <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wider">Entity ID</p>
                              <p className="text-neutral-300 font-mono text-xs break-all">{invoice.entity_id}</p>
                            </div>
                            <div className="bg-white/[0.02] rounded-lg p-4 border border-white/[0.06]">
                              <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wider">Full Amount</p>
                              <p className="text-neutral-300 tabular-nums font-semibold">{formatCurrency(invoice.amount)}</p>
                            </div>
                            <div className="bg-white/[0.02] rounded-lg p-4 border border-white/[0.06]">
                              <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wider">Outstanding</p>
                              <p className={`tabular-nums font-semibold ${getStatusColor(invoice.status, invoice.days_overdue)}`}>{formatCurrency(invoice.outstanding_amount)}</p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </div>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Results count */}
        {!loading && displayedInvoices.length > 0 && (
          <div className="mt-5 flex items-center justify-between">
            <p className="text-sm text-neutral-500">
              Showing <span className="font-semibold text-neutral-400">{displayedInvoices.length}</span> of <span className="font-semibold text-neutral-400">{allInvoices.length}</span> invoices
            </p>
            <p className="text-xs text-neutral-600">All data is client-side sorted and filtered</p>
          </div>
        )}
      </div>
    </div>
  )
}
