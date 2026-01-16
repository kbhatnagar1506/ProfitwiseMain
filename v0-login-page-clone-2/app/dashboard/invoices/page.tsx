"use client"

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { ChevronDown } from "lucide-react"

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

  return (
    <div className="min-h-screen bg-[#141414]">
      {/* Header */}
      <div className="border-b border-white/[0.06] px-8 py-6">
        <h1 className="text-2xl font-semibold text-white mb-1">Invoices</h1>
        <p className="text-sm text-neutral-500">Manage your accounts receivable</p>
      </div>

      {/* Summary Cards */}
      <div className="px-8 py-6 grid grid-cols-4 gap-4">
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
          <p className="text-[11px] text-neutral-600 font-medium mb-2">Total Outstanding</p>
          <p className="text-lg font-semibold text-white tabular-nums">{formatCurrency(totals.total_outstanding)}</p>
          <p className="text-[11px] text-neutral-600 mt-2">{totals.invoice_count} invoices</p>
        </div>

        <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
          <p className="text-[11px] text-neutral-600 font-medium mb-2">Total Overdue</p>
          <p className="text-lg font-semibold text-red-400/90 tabular-nums">{formatCurrency(totals.total_overdue)}</p>
          <p className="text-[11px] text-neutral-600 mt-2">{totals.overdue_count} overdue</p>
        </div>

        <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
          <p className="text-[11px] text-neutral-600 font-medium mb-2">Open</p>
          <p className="text-lg font-semibold text-neutral-300 tabular-nums">{summaryByStatus.open}</p>
        </div>

        <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
          <p className="text-[11px] text-neutral-600 font-medium mb-2">Paid</p>
          <p className="text-lg font-semibold text-emerald-400/90 tabular-nums">{summaryByStatus.paid}</p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="px-8 py-4 border-b border-white/[0.06] flex gap-4 items-center">
        <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1); }}>
          <SelectTrigger className="w-40 bg-white/[0.02] border-white/[0.06] text-neutral-300">
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
          className="flex-1 bg-white/[0.02] border-white/[0.06] text-neutral-300 placeholder:text-neutral-600"
        />
      </div>

      {/* Invoices Table */}
      <div className="px-8 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-neutral-600 border-t-neutral-300"></div>
            <span className="ml-3 text-neutral-500">Loading invoices...</span>
          </div>
        ) : invoices.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-neutral-500">No invoices found</p>
          </div>
        ) : (
          <div className="border border-white/[0.06] rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-600 uppercase tracking-wider"></th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Customer</th>
                  <th className="px-4 py-3 text-right text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Amount</th>
                  <th className="px-4 py-3 text-right text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Outstanding</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Due Date</th>
                  <th className="px-4 py-3 text-right text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Days</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Source</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <div key={invoice.id}>
                    <tr className="border-b border-white/[0.06] hover:bg-white/[0.02] transition-colors">
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
                      <td className="px-4 py-3 text-sm text-neutral-300">{invoice.customer_name}</td>
                      <td className="px-4 py-3 text-sm text-neutral-300 text-right tabular-nums">{formatCurrency(invoice.amount)}</td>
                      <td className={`px-4 py-3 text-sm text-right tabular-nums ${getStatusColor(invoice.status, invoice.days_overdue)}`}>
                        {formatCurrency(invoice.outstanding_amount)}
                      </td>
                      <td className="px-4 py-3 text-sm text-neutral-400">{invoice.due_date}</td>
                      <td className={`px-4 py-3 text-sm text-right tabular-nums ${getStatusColor(invoice.status, invoice.days_overdue)}`}>
                        {invoice.days_overdue !== null ? `-${invoice.days_overdue}` : `${invoice.days_until_due}`}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="secondary"
                          className={`text-[11px] font-medium border ${getStatusBadgeVariant(invoice.status, invoice.days_overdue)}`}
                        >
                          {invoice.status === "overdue" || (invoice.days_overdue !== null && invoice.days_overdue > 0)
                            ? "Overdue"
                            : invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-neutral-500 capitalize">{invoice.source}</td>
                    </tr>
                    {expandedRows.has(invoice.id) && (
                      <tr className="border-b border-white/[0.06] bg-white/[0.01]">
                        <td colSpan={8} className="px-4 py-4">
                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <p className="text-[11px] text-neutral-600 font-medium mb-1">Invoice ID</p>
                              <p className="text-neutral-300 font-mono text-xs">{invoice.id}</p>
                            </div>
                            <div>
                              <p className="text-[11px] text-neutral-600 font-medium mb-1">Entity ID</p>
                              <p className="text-neutral-300 font-mono text-xs">{invoice.entity_id}</p>
                            </div>
                            <div>
                              <p className="text-[11px] text-neutral-600 font-medium mb-1">Full Amount</p>
                              <p className="text-neutral-300 tabular-nums">{formatCurrency(invoice.amount)}</p>
                            </div>
                            <div>
                              <p className="text-[11px] text-neutral-600 font-medium mb-1">Outstanding</p>
                              <p className="text-neutral-300 tabular-nums">{formatCurrency(invoice.outstanding_amount)}</p>
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
      </div>
    </div>
  )
}
