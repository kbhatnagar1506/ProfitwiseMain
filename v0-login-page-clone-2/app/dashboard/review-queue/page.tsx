"use client"

import { useState, useEffect, useCallback } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RefreshCw, Search, CheckCircle2, XCircle, Clock, AlertCircle, Info, ChevronRight } from "lucide-react"

interface PendingMatch {
  id: string
  movement_id: string
  cash_event_id: string
  bank_date: string
  bank_description: string | null
  bank_counterparty: string | null
  bank_amount: number
  invoice_id: string
  invoice_number: string | null
  customer_name: string
  invoice_amount: number
  invoice_date: string | null
  due_date: string | null
  match_type: string
  confidence: number
  fee_amount: number
  matched_amount: number
  reasoning: string | null
  status: string
  created_at: string
}

interface UnmatchedInvoice {
  id: string
  invoice_id: string
  invoice_number: string | null
  customer_name: string
  invoice_amount: number
  invoice_date: string | null
  due_date: string | null
  status: string
}

interface ReviewQueueStats {
  pending_matches: number
  pending_amount: number
  unmatched_invoices: number
  unmatched_amount: number
  high_confidence_pending: number
  low_confidence_pending: number
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

function formatDate(d: string | null) {
  if (!d) return "—"
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function getMatchTypeColor(matchType: string): string {
  switch (matchType) {
    case "EXACT": return "bg-emerald-400/10 text-emerald-400"
    case "FEE": return "bg-amber-400/10 text-amber-400"
    case "PARTIAL": return "bg-purple-400/10 text-purple-400"
    case "AGGREGATION": return "bg-cyan-400/10 text-cyan-400"
    default: return "bg-zinc-400/10 text-zinc-400"
  }
}

function InfoButton({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="ml-1 text-zinc-500 hover:text-zinc-300 transition-colors">
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 bg-zinc-900 border-zinc-800 text-zinc-300 p-3" side="bottom" align="start">
        <h4 className="font-semibold text-white text-sm mb-2">{title}</h4>
        <div className="text-xs space-y-1.5 text-zinc-400">{children}</div>
      </PopoverContent>
    </Popover>
  )
}

export default function ReviewQueuePage() {
  const [pendingMatches, setPendingMatches] = useState<PendingMatch[]>([])
  const [unmatchedInvoices, setUnmatchedInvoices] = useState<UnmatchedInvoice[]>([])
  const [stats, setStats] = useState<ReviewQueueStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"pending" | "unmatched">("pending")
  const [searchQuery, setSearchQuery] = useState("")
  const [processingId, setProcessingId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      
      // Fetch pending matches
      const matchesRes = await fetch("/api/ar-reconciliation/matches?status=pending&limit=500")
      if (!matchesRes.ok) throw new Error("Failed to fetch pending matches")
      const matchesJson = await matchesRes.json()
      setPendingMatches(matchesJson.matches || [])

      // Fetch unmatched invoices
      const invoicesRes = await fetch("/api/ar-reconciliation/invoices?filter=unmatched&limit=500")
      if (!invoicesRes.ok) throw new Error("Failed to fetch unmatched invoices")
      const invoicesJson = await invoicesRes.json()
      setUnmatchedInvoices(invoicesJson.invoices || [])

      // Calculate stats
      const pending = matchesJson.matches || []
      const unmatched = invoicesJson.invoices || []
      setStats({
        pending_matches: pending.length,
        pending_amount: pending.reduce((s: number, m: PendingMatch) => s + m.invoice_amount, 0),
        unmatched_invoices: unmatched.length,
        unmatched_amount: unmatched.reduce((s: number, i: UnmatchedInvoice) => s + i.invoice_amount, 0),
        high_confidence_pending: pending.filter((m: PendingMatch) => m.confidence >= 0.85).length,
        low_confidence_pending: pending.filter((m: PendingMatch) => m.confidence < 0.70).length,
      })

      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading review queue")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleConfirmMatch = async (matchId: string) => {
    setProcessingId(matchId)
    try {
      const res = await fetch(`/api/ar-reconciliation/matches/${matchId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "confirmed" }),
      })
      if (res.ok) {
        setPendingMatches(prev => prev.filter(m => m.id !== matchId))
        if (stats) {
          setStats({
            ...stats,
            pending_matches: stats.pending_matches - 1,
          })
        }
      }
    } catch (err) {
      console.error("Failed to confirm match:", err)
    } finally {
      setProcessingId(null)
    }
  }

  const handleRejectMatch = async (matchId: string) => {
    setProcessingId(matchId)
    try {
      const res = await fetch(`/api/ar-reconciliation/matches/${matchId}`, {
        method: "DELETE",
      })
      if (res.ok) {
        setPendingMatches(prev => prev.filter(m => m.id !== matchId))
        if (stats) {
          setStats({
            ...stats,
            pending_matches: stats.pending_matches - 1,
          })
        }
      }
    } catch (err) {
      console.error("Failed to reject match:", err)
    } finally {
      setProcessingId(null)
    }
  }

  const filteredPendingMatches = pendingMatches.filter(m => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      m.customer_name?.toLowerCase().includes(q) ||
      m.invoice_id?.toLowerCase().includes(q) ||
      m.bank_counterparty?.toLowerCase().includes(q) ||
      m.bank_description?.toLowerCase().includes(q)
    )
  })

  const filteredUnmatchedInvoices = unmatchedInvoices.filter(i => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      i.customer_name?.toLowerCase().includes(q) ||
      i.invoice_id?.toLowerCase().includes(q) ||
      i.invoice_number?.toLowerCase().includes(q)
    )
  })

  if (loading) {
    return (
      <div className="p-8 space-y-4 bg-black min-h-screen">
        <div className="h-8 w-48 bg-zinc-900 rounded animate-pulse" />
        <div className="h-32 bg-zinc-900 rounded animate-pulse" />
        <div className="h-96 bg-zinc-900 rounded animate-pulse" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8 bg-black min-h-screen">
        <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-6 text-rose-400">
          <p className="font-semibold">Error loading review queue</p>
          <p className="text-sm mt-2">{error}</p>
          <Button onClick={() => fetchData()} className="mt-4 bg-rose-600 hover:bg-rose-700">
            Retry
          </Button>
        </div>
      </div>
    )
  }

  const totalItems = (stats?.pending_matches || 0) + (stats?.unmatched_invoices || 0)
  const totalAmount = (stats?.pending_amount || 0) + (stats?.unmatched_amount || 0)

  return (
    <div className="p-8 space-y-5 bg-black min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Review Queue</h1>
          <p className="text-sm text-zinc-500 mt-1">Items requiring human review before reconciliation is complete</p>
        </div>
        <Button
          onClick={() => fetchData()}
          disabled={loading}
          className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats Banner */}
      <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-5">
        <div className="flex items-center divide-x divide-zinc-800">
          {/* Total Needs Review */}
          <div className="flex-1 pr-6">
            <div className="flex items-center">
              <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Total Needs Review</p>
              <InfoButton title="Review Queue">
                <p>Items that need human verification before being finalized.</p>
                <p className="mt-1">Includes pending AI matches and unmatched invoices.</p>
              </InfoButton>
            </div>
            <p className="text-3xl font-semibold tracking-tight text-white tabular-nums mt-1">{totalItems}</p>
            <p className="text-sm text-zinc-500">{formatCurrency(totalAmount)}</p>
          </div>

          {/* Pending Matches */}
          <div className="flex-1 px-6">
            <div className="flex items-center">
              <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Pending Matches</p>
              <InfoButton title="Pending Matches">
                <p>AI-suggested matches that need confirmation.</p>
                <p className="mt-1">Review the match and confirm or reject.</p>
              </InfoButton>
            </div>
            <p className="text-2xl font-semibold tracking-tight text-amber-400 tabular-nums mt-1">{stats?.pending_matches || 0}</p>
            <p className="text-sm text-zinc-500">{formatCurrency(stats?.pending_amount || 0)}</p>
          </div>

          {/* Unmatched Invoices */}
          <div className="flex-1 px-6">
            <div className="flex items-center">
              <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Unmatched Invoices</p>
              <InfoButton title="Unmatched Invoices">
                <p>Invoices with no matching bank payment found.</p>
                <p className="mt-1">May need manual matching or are awaiting payment.</p>
              </InfoButton>
            </div>
            <p className="text-2xl font-semibold tracking-tight text-rose-400 tabular-nums mt-1">{stats?.unmatched_invoices || 0}</p>
            <p className="text-sm text-zinc-500">{formatCurrency(stats?.unmatched_amount || 0)}</p>
          </div>

          {/* Confidence Breakdown */}
          <div className="flex-1 pl-6">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Confidence Breakdown</p>
            <div className="flex items-center gap-4 mt-2">
              <div>
                <p className="text-lg font-semibold text-emerald-400 tabular-nums">{stats?.high_confidence_pending || 0}</p>
                <p className="text-[10px] text-zinc-500">High ≥85%</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-amber-400 tabular-nums">{stats?.low_confidence_pending || 0}</p>
                <p className="text-[10px] text-zinc-500">Low &lt;70%</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs and Search */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab("pending")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === "pending"
                ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                : "bg-zinc-900/50 text-zinc-400 border border-zinc-800/50 hover:text-zinc-300"
            }`}
          >
            <Clock className="h-4 w-4 inline mr-2" />
            Pending Matches ({stats?.pending_matches || 0})
          </button>
          <button
            onClick={() => setActiveTab("unmatched")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === "unmatched"
                ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                : "bg-zinc-900/50 text-zinc-400 border border-zinc-800/50 hover:text-zinc-300"
            }`}
          >
            <AlertCircle className="h-4 w-4 inline mr-2" />
            Unmatched Invoices ({stats?.unmatched_invoices || 0})
          </button>
        </div>

        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-zinc-500" />
          <Input
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-zinc-900/50 border-zinc-800/50 pl-9 h-9 text-sm text-zinc-300 placeholder:text-zinc-600"
          />
        </div>
      </div>

      {/* Content */}
      {totalItems === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-16 text-center">
          <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="h-6 w-6 text-emerald-400" />
          </div>
          <p className="text-white font-medium text-lg">All Clear!</p>
          <p className="text-zinc-500 text-sm mt-1">No items need review. All reconciliation is complete.</p>
        </div>
      ) : activeTab === "pending" ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
          {filteredPendingMatches.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-zinc-500">No pending matches found.</p>
            </div>
          ) : (
            <div className="max-h-[600px] overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-zinc-900">
                  <tr className="border-b border-zinc-800">
                    <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Bank Payment</th>
                    <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Invoice</th>
                    <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Match Type</th>
                    <th className="text-center text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Confidence</th>
                    <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Reasoning</th>
                    <th className="text-center text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPendingMatches.map((match) => (
                    <tr key={match.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-sm text-zinc-200">{match.bank_counterparty || "Bank deposit"}</p>
                        <p className="text-xs text-zinc-500">{formatDate(match.bank_date)}</p>
                        <p className="text-sm font-medium text-emerald-400 tabular-nums mt-1">+{formatCurrency(match.bank_amount)}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm text-zinc-200">{match.customer_name}</p>
                        <p className="text-xs text-zinc-500">#{match.invoice_id}</p>
                        <p className="text-sm text-zinc-400 tabular-nums mt-1">{formatCurrency(match.invoice_amount)}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-1 rounded ${getMatchTypeColor(match.match_type)}`}>
                          {match.match_type}
                        </span>
                        {match.fee_amount > 0 && (
                          <p className="text-[10px] text-amber-400 mt-1">Fee: {formatCurrency(match.fee_amount)}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`text-sm font-medium tabular-nums ${
                          match.confidence >= 0.85 ? "text-emerald-400" :
                          match.confidence >= 0.70 ? "text-amber-400" :
                          "text-rose-400"
                        }`}>
                          {Math.round(match.confidence * 100)}%
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-xs text-zinc-500 max-w-[200px] truncate" title={match.reasoning || ""}>
                          {match.reasoning || "—"}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => handleConfirmMatch(match.id)}
                            disabled={processingId === match.id}
                            className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                            title="Confirm match"
                          >
                            <CheckCircle2 className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleRejectMatch(match.id)}
                            disabled={processingId === match.id}
                            className="p-1.5 rounded-lg bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition-colors disabled:opacity-50"
                            title="Reject match"
                          >
                            <XCircle className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
          {filteredUnmatchedInvoices.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-zinc-500">No unmatched invoices found.</p>
            </div>
          ) : (
            <div className="max-h-[600px] overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-zinc-900">
                  <tr className="border-b border-zinc-800">
                    <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Invoice</th>
                    <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Customer</th>
                    <th className="text-right text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Amount</th>
                    <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Invoice Date</th>
                    <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Due Date</th>
                    <th className="text-left text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUnmatchedInvoices.map((invoice) => (
                    <tr key={invoice.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-sm text-zinc-200">#{invoice.invoice_number || invoice.invoice_id}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm text-zinc-200">{invoice.customer_name}</p>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <p className="text-sm font-medium text-zinc-200 tabular-nums">{formatCurrency(invoice.invoice_amount)}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm text-zinc-400">{formatDate(invoice.invoice_date)}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm text-zinc-400">{formatDate(invoice.due_date)}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs px-2 py-1 rounded bg-rose-500/10 text-rose-400">
                          No match found
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
