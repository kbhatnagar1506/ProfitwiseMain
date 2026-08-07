"use client"

import { useEffect, useState, useCallback } from "react"
import { Badge } from "@/components/ui/badge"
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
import { ChevronDown, ChevronUp, ArrowRight, RotateCcw, Link2, Unlink } from "lucide-react"

interface AccountRef {
  id: string | null
  name: string | null
  mask: string | null
}

interface Transfer {
  id: string
  date: string
  amount: number
  direction: "inflow" | "outflow"
  description: string
  display_name: string
  currency: string
  is_paired: boolean
  confidence: number
  source_account: AccountRef
  destination_account: AccountRef
}

interface TransfersResponse {
  transfers: Transfer[]
  pagination: {
    page: number
    limit: number
    total: number
    total_pages: number
  }
  summary: {
    total_count: number
    total_volume: number
    paired_count: number
    unpaired_count: number
    net_flow_by_account: { account_id: string; account_name: string | null; mask: string | null; net: number }[]
  }
}

function formatCurrency(n: number): string {
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function accountLabel(acct: AccountRef): string {
  if (acct.name && acct.mask) return `${acct.name} ...${acct.mask}`
  if (acct.name) return acct.name
  if (acct.mask) return `...${acct.mask}`
  if (acct.id) return `Account ${acct.id.slice(-6)}`
  return "Unknown"
}

export default function TransfersPage() {
  const [data, setData] = useState<TransfersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [accountFilter, setAccountFilter] = useState("")
  const [search, setSearch] = useState("")
  const [searchDebounced, setSearchDebounced] = useState("")

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const fetchTransfers = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      params.set("page", String(page))
      params.set("limit", "50")
      if (accountFilter) params.set("account_id", accountFilter)
      if (searchDebounced) params.set("search", searchDebounced)

      const res = await fetch(`/api/dashboard/transfers?${params}`)
      if (!res.ok) throw new Error(res.statusText)
      const json: TransfersResponse = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch transfers")
    } finally {
      setLoading(false)
    }
  }, [page, accountFilter, searchDebounced])

  useEffect(() => {
    fetchTransfers()
  }, [fetchTransfers])

  useEffect(() => {
    setPage(1)
  }, [accountFilter, searchDebounced])

  const accounts = data?.summary.net_flow_by_account ?? []
  const transfers = data?.transfers ?? []
  const pagination = data?.pagination
  const summary = data?.summary

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1400px] mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Transfers</h1>
        <p className="text-sm text-zinc-500 mt-1">Internal movements between your bank accounts</p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white/[0.03] border border-white/10 rounded-xl px-4 py-3">
          <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Total Transfers</div>
          <div className="text-xl font-bold text-white tabular-nums mt-1">{summary?.total_count ?? 0}</div>
        </div>
        <div className="bg-white/[0.03] border border-white/10 rounded-xl px-4 py-3">
          <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">Total Volume</div>
          <div className="text-xl font-bold text-zinc-200 tabular-nums mt-1">{formatCurrency(summary?.total_volume ?? 0)}</div>
        </div>
        <div className="bg-white/[0.03] border border-white/10 rounded-xl px-4 py-3">
          <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />Paired
          </div>
          <div className="text-xl font-bold text-emerald-400/90 tabular-nums mt-1">{summary?.paired_count ?? 0}</div>
        </div>
        <div className="bg-white/[0.03] border border-white/10 rounded-xl px-4 py-3">
          <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />Unpaired
          </div>
          <div className="text-xl font-bold text-amber-400/90 tabular-nums mt-1">{summary?.unpaired_count ?? 0}</div>
        </div>
      </div>

      {/* Net Flow by Account */}
      {accounts.length > 0 && (
        <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4">
          <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium mb-3">Net Transfer Flow by Account</div>
          <div className="flex flex-wrap gap-4">
            {accounts.map((a) => (
              <div key={a.account_id} className="flex items-center gap-2 text-sm">
                <span className="text-zinc-400">{a.account_name ?? "Account"} {a.mask ? `...${a.mask}` : ""}</span>
                <span className={`font-mono tabular-nums font-medium ${a.net >= 0 ? "text-emerald-400/90" : "text-zinc-400"}`}>
                  {a.net >= 0 ? "+" : "-"}{formatCurrency(a.net)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={accountFilter || "__all__"}
          onValueChange={(v) => setAccountFilter(v === "__all__" ? "" : v)}
        >
          <SelectTrigger className="w-[220px] bg-white/5 border-white/10 text-zinc-200">
            <SelectValue placeholder="All accounts" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All accounts</SelectItem>
            {accounts.map((a) => (
              <SelectItem key={a.account_id} value={a.account_id}>
                {a.account_name ?? "Account"} {a.mask ? `...${a.mask}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="text"
          placeholder="Search description..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-[240px] bg-white/5 border-white/10 text-zinc-200 placeholder:text-zinc-600"
        />

        {(accountFilter || search) && (
          <button
            onClick={() => { setAccountFilter(""); setSearch("") }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16 gap-3 text-zinc-500">
          <div className="h-5 w-5 rounded-full border-2 border-white/10 border-t-zinc-400 animate-spin" />
          <span className="text-sm">Loading transfers...</span>
        </div>
      )}

      {/* Table */}
      {!loading && transfers.length > 0 && (
        <div className="bg-white/[0.02] border border-white/10 rounded-xl overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider font-medium w-[100px]">Date</TableHead>
                <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider font-medium">From</TableHead>
                <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider font-medium w-[40px]" />
                <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider font-medium">To</TableHead>
                <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider font-medium text-right">Amount</TableHead>
                <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider font-medium text-center w-[90px]">Status</TableHead>
                <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider font-medium w-[30px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfers.map((t) => {
                const isExpanded = expandedId === t.id
                return (
                  <>
                    <TableRow
                      key={t.id}
                      className="border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : t.id)}
                    >
                      <TableCell className="text-zinc-400 text-sm tabular-nums">
                        {new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm text-zinc-200">{accountLabel(t.source_account)}</div>
                      </TableCell>
                      <TableCell className="text-center">
                        <ArrowRight className="h-3.5 w-3.5 text-zinc-600 mx-auto" />
                      </TableCell>
                      <TableCell>
                        <div className="text-sm text-zinc-200">{accountLabel(t.destination_account)}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="text-zinc-200 font-mono text-sm tabular-nums tracking-tight">
                          {formatCurrency(t.amount)}
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        {t.is_paired ? (
                          <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-400/90 border-emerald-500/20 text-[10px] gap-1">
                            <Link2 className="h-2.5 w-2.5" />Paired
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-amber-500/10 text-amber-400/90 border-amber-500/20 text-[10px] gap-1">
                            <Unlink className="h-2.5 w-2.5" />Unpaired
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {isExpanded
                          ? <ChevronUp className="h-3.5 w-3.5 text-zinc-600" />
                          : <ChevronDown className="h-3.5 w-3.5 text-zinc-600" />}
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow key={`${t.id}-detail`} className="border-white/5 hover:bg-transparent">
                        <TableCell colSpan={7} className="bg-white/[0.02] px-6 py-4">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                            <div>
                              <div className="text-zinc-600 mb-0.5">Description</div>
                              <div className="text-zinc-300">{t.description}</div>
                            </div>
                            <div>
                              <div className="text-zinc-600 mb-0.5">Display Name</div>
                              <div className="text-zinc-300">{t.display_name}</div>
                            </div>
                            <div>
                              <div className="text-zinc-600 mb-0.5">Confidence</div>
                              <div className="flex items-center gap-1.5">
                                <div className={`w-1.5 h-1.5 rounded-full ${t.confidence >= 0.9 ? "bg-emerald-400" : t.confidence >= 0.7 ? "bg-amber-400" : "bg-red-400"}`} />
                                <span className="text-zinc-300 font-mono">{Math.round(t.confidence * 100)}%</span>
                              </div>
                            </div>
                            <div>
                              <div className="text-zinc-600 mb-0.5">Movement ID</div>
                              <div className="text-zinc-500 font-mono text-[10px] break-all">{t.id}</div>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Empty state */}
      {!loading && transfers.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
          <RotateCcw className="h-8 w-8 mb-3 text-zinc-600" />
          <p className="text-sm">No internal transfers found</p>
          <p className="text-xs text-zinc-600 mt-1">Transfers between your linked accounts will appear here</p>
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.total_pages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-zinc-600">
            Showing {((pagination.page - 1) * pagination.limit) + 1}–{Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 text-xs rounded-md bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Previous
            </button>
            <span className="text-xs text-zinc-500 tabular-nums">
              Page {pagination.page} of {pagination.total_pages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pagination.total_pages, p + 1))}
              disabled={page >= pagination.total_pages}
              className="px-3 py-1.5 text-xs rounded-md bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
