"use client"

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { ChevronDown, ChevronLeft, ChevronRight, AlertCircle, CheckCircle2, Clock, TrendingUp } from "lucide-react"
import { StatusBadge } from "@/components/StatusBadge"

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
  pagination: {
    page: number
    limit: number
    total: number
    pages: number
  }
}

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([])
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
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [limit] = useState(20)
  const [status, setStatus] = useState("all")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  // Fetch invoices
  const fetchInvoices = async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        ...(status !== "all" && { status }),
        ...(debouncedSearch && { search: debouncedSearch }),
      })

      const response = await fetch(`/api/dashboard/invoices?${params}`)
      if (!response.ok) throw new Error("Failed to fetch invoices")

      const data: ApiResponse = await response.json()
      setInvoices(data.invoices)
      setTotals(data.totals)
      setSummaryByStatus(data.summary_by_status)
      setTotalPages(data.pagination?.pages ?? 1)
    } catch (error) {
      console.error("Error fetching invoices:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchInvoices()
  }, [page, status, debouncedSearch])

  const toggleExpandedRow = (id: string) => {
    const newExpanded = new Set(expandedRows)
    if (newExpanded.has(id)) {
      newExpanded.delete(id)
    } else {
      newExpanded.add(id)
    }
    setExpandedRows(newExpanded)
  }

  const getStatusColor = (status: string, daysOverdue: number | null) => {
    if (status === "paid") return "text-emerald-400/90"
    if (status === "overdue") return "text-red-400/80"
    if (status === "partially_paid") return "text-amber-400/80"
    return "text-neutral-300"
  }

  const getStatusBadgeVariant = (status: string, daysOverdue: number | null) => {
    if (status === "paid") return "bg-emerald-400/10 text-emerald-300 border-emerald-400/20"
    if (status === "overdue") return "bg-red-400/10 text-red-300 border-red-400/20"
    if (status === "partially_paid") return "bg-amber-400/10 text-amber-300 border-amber-400/20"
    return "bg-white/5 text-zinc-300 border-white/10"
  }

  return (
    <div className="min-h-screen bg-[#141414]">
      {/* Header */}
      <div className="border-b border-white/[0.06] px-8 py-6">
        <h1 className="text-2xl font-semibold text-white mb-1">Invoices</h1>
        <p className="text-sm text-neutral-500">Manage your accounts receivable</p>
      </div>

      {/* Summary Cards */}
      <div className="px-8 py-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Total Outstanding */}
        <div className="bg-gradient-to-br from-blue-500/10 to-blue-500/5 border border-blue-500/20 rounded-lg p-4 hover:border-blue-500/40 transition-colors">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] text-blue-400/70 font-medium uppercase tracking-wide mb-2">Outstanding</p>
              <p className="text-2xl font-bold text-white tabular-nums">{formatCurrency(totals.total_outstanding)}</p>
              <p className="text-[11px] text-blue-400/50 mt-2">{totals.invoice_count} invoices</p>
            </div>
            <TrendingUp size={20} className="text-blue-400/40" />
          </div>
        </div>

        {/* Overdue */}
        <div className={`bg-gradient-to-br ${totals.total_overdue > 0 ? 'from-red-500/10 to-red-500/5 border-red-500/20 hover:border-red-500/40' : 'from-zinc-500/10 to-zinc-500/5 border-zinc-500/20 hover:border-zinc-500/40'} border rounded-lg p-4 transition-colors`}>
          <div className="flex items-start justify-between">
            <div>
              <p className={`text-[11px] ${totals.total_overdue > 0 ? 'text-red-400/70' : 'text-zinc-400/70'} font-medium uppercase tracking-wide mb-2`}>Overdue</p>
              <p className={`text-2xl font-bold tabular-nums ${totals.total_overdue > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{formatCurrency(totals.total_overdue)}</p>
              <p className={`text-[11px] ${totals.total_overdue > 0 ? 'text-red-400/50' : 'text-emerald-400/50'} mt-2`}>{totals.overdue_count} overdue</p>
            </div>
            <AlertCircle size={20} className={totals.total_overdue > 0 ? 'text-red-400/40' : 'text-emerald-400/40'} />
          </div>
        </div>

        {/* Open */}
        <div className="bg-gradient-to-br from-amber-500/10 to-amber-500/5 border border-amber-500/20 rounded-lg p-4 hover:border-amber-500/40 transition-colors">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] text-amber-400/70 font-medium uppercase tracking-wide mb-2">Open</p>
              <p className="text-2xl font-bold text-white tabular-nums">{summaryByStatus.open}</p>
              <p className="text-[11px] text-amber-400/50 mt-2">awaiting payment</p>
            </div>
            <Clock size={20} className="text-amber-400/40" />
          </div>
        </div>

        {/* Partially Paid */}
        <div className="bg-gradient-to-br from-cyan-500/10 to-cyan-500/5 border border-cyan-500/20 rounded-lg p-4 hover:border-cyan-500/40 transition-colors">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] text-cyan-400/70 font-medium uppercase tracking-wide mb-2">Partial</p>
              <p className="text-2xl font-bold text-white tabular-nums">{summaryByStatus.partially_paid}</p>
              <p className="text-[11px] text-cyan-400/50 mt-2">in progress</p>
            </div>
            <TrendingUp size={20} className="text-cyan-400/40" />
          </div>
        </div>

        {/* Paid */}
        <div className="bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border border-emerald-500/20 rounded-lg p-4 hover:border-emerald-500/40 transition-colors">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] text-emerald-400/70 font-medium uppercase tracking-wide mb-2">Paid</p>
              <p className="text-2xl font-bold text-white tabular-nums">{summaryByStatus.paid}</p>
              <p className="text-[11px] text-emerald-400/50 mt-2">completed</p>
            </div>
            <CheckCircle2 size={20} className="text-emerald-400/40" />
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="px-8 py-4 border-b border-white/[0.06] space-y-4">
        <div className="flex gap-4 items-center flex-wrap">
          <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1); }}>
            <SelectTrigger className="w-48 bg-white/[0.02] border-white/[0.06] text-neutral-300 hover:border-white/[0.1] transition-colors">
              <SelectValue placeholder="Filter by status" />
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
            placeholder="Search by customer name or invoice ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[300px] bg-white/[0.02] border-white/[0.06] text-neutral-300 placeholder:text-neutral-600 hover:border-white/[0.1] transition-colors"
          />

          {(status !== "all" || search) && (
            <button
              onClick={() => { setStatus("all"); setSearch(""); }}
              className="px-3 py-2 text-[12px] text-neutral-400 hover:text-neutral-300 border border-white/[0.06] rounded hover:border-white/[0.1] transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
        <p className="text-[11px] text-neutral-600">
          Showing {invoices.length} of {totals.invoice_count} invoices
        </p>
      </div>

      {/* Invoices Table */}
      <div className="px-8 py-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-2 border-neutral-600 border-t-neutral-300 mb-4"></div>
            <p className="text-neutral-500 text-sm">Loading invoices...</p>
          </div>
        ) : invoices.length === 0 ? (
          <div className="text-center py-16 border border-white/[0.06] rounded-lg bg-white/[0.01]">
            <AlertCircle size={32} className="mx-auto text-neutral-600 mb-3" />
            <p className="text-neutral-400 font-medium">No invoices found</p>
            <p className="text-neutral-600 text-sm mt-1">Try adjusting your filters or search terms</p>
          </div>
        ) : (
          <div className="border border-white/[0.06] rounded-lg overflow-hidden bg-white/[0.01]">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.06] bg-white/[0.03]">
                    <th className="px-4 py-3 text-left w-8"></th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Customer</th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Amount</th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Outstanding</th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Paid</th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Due Date</th>
                    <th className="px-4 py-3 text-center text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Days</th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice, idx) => {
                    const paidAmount = invoice.amount - invoice.outstanding_amount
                    const paidPercentage = (paidAmount / invoice.amount) * 100
                    return (
                      <div key={invoice.id}>
                        <tr className={`border-b border-white/[0.06] hover:bg-white/[0.04] transition-colors ${idx % 2 === 0 ? 'bg-white/[0.01]' : ''}`}>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => toggleExpandedRow(invoice.id)}
                              className="text-neutral-500 hover:text-neutral-300 transition-colors"
                            >
                              <ChevronDown
                                size={16}
                                className={`transition-transform ${expandedRows.has(invoice.id) ? "rotate-180" : ""}`}
                              />
                            </button>
                          </td>
                          <td className="px-4 py-3">
                            <p className="text-sm font-medium text-white">{invoice.customer_name}</p>
                            <p className="text-[11px] text-neutral-600 font-mono">{invoice.id.slice(0, 8)}...</p>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <p className="text-sm font-semibold text-white tabular-nums">{formatCurrency(invoice.amount)}</p>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <p className={`text-sm font-semibold tabular-nums ${
                              invoice.outstanding_amount > 0 ? 'text-amber-400' : 'text-emerald-400'
                            }`}>
                              {formatCurrency(invoice.outstanding_amount)}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <div className="w-16 h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
                                <div
                                  className={`h-full transition-all ${
                                    paidPercentage === 100 ? 'bg-emerald-500' :
                                    paidPercentage > 0 ? 'bg-cyan-500' : 'bg-neutral-600'
                                  }`}
                                  style={{ width: `${paidPercentage}%` }}
                                />
                              </div>
                              <span className="text-[11px] text-neutral-600 w-8 text-right">{Math.round(paidPercentage)}%</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-sm text-neutral-400">{invoice.due_date}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={`text-sm font-mono ${
                              invoice.days_overdue !== null && invoice.days_overdue > 0
                                ? 'text-red-400 font-semibold'
                                : 'text-neutral-400'
                            }`}>
                              {invoice.days_overdue !== null ? `-${invoice.days_overdue}` : `+${invoice.days_until_due}`}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge status={invoice.status} />
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className="text-[10px] bg-white/[0.05] border-white/[0.1] text-neutral-400">
                              {invoice.source}
                            </Badge>
                          </td>
                        </tr>
                        {expandedRows.has(invoice.id) && (
                          <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                            <td colSpan={9} className="px-4 py-4">
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-sm">
                                <div>
                                  <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wide">Invoice ID</p>
                                  <p className="text-neutral-300 font-mono text-xs break-all">{invoice.id}</p>
                                </div>
                                <div>
                                  <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wide">Entity ID</p>
                                  <p className="text-neutral-300 font-mono text-xs break-all">{invoice.entity_id}</p>
                                </div>
                                <div>
                                  <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wide">Full Amount</p>
                                  <p className="text-neutral-300 font-semibold tabular-nums">{formatCurrency(invoice.amount)}</p>
                                </div>
                                <div>
                                  <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wide">Outstanding</p>
                                  <p className={`font-semibold tabular-nums ${
                                    invoice.outstanding_amount > 0 ? 'text-amber-400' : 'text-emerald-400'
                                  }`}>
                                    {formatCurrency(invoice.outstanding_amount)}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wide">Paid Amount</p>
                                  <p className="text-emerald-400 font-semibold tabular-nums">{formatCurrency(paidAmount)}</p>
                                </div>
                                <div>
                                  <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wide">Payment %</p>
                                  <p className="text-neutral-300 font-semibold">{Math.round(paidPercentage)}%</p>
                                </div>
                                <div>
                                  <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wide">Due Date</p>
                                  <p className="text-neutral-300">{invoice.due_date}</p>
                                </div>
                                <div>
                                  <p className="text-[11px] text-neutral-600 font-medium mb-2 uppercase tracking-wide">Status</p>
                                  <StatusBadge status={invoice.status} />
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </div>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-white/[0.06] mt-4 rounded-b-lg bg-white/[0.01]">
            <p className="text-[12px] text-zinc-500">
              Page <span className="font-semibold text-zinc-300">{page}</span> of <span className="font-semibold text-zinc-300">{totalPages}</span>
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[12px] text-zinc-300 hover:bg-white/10 hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[12px] text-zinc-300 hover:bg-white/10 hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
