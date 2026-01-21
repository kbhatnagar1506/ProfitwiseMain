"use client"

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, CheckCircle2, TrendingUp, TrendingDown } from "lucide-react"

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

interface ReconciliationSummary {
  ar_total_outstanding: number
  ar_total_matched: number
  ar_match_rate: number
  ar_suspicious_count: number
  ar_suspicious_amount: number
  ap_total_outstanding: number
  ap_total_matched: number
  ap_match_rate: number
  ap_suspicious_count: number
  ap_suspicious_amount: number
  net_outstanding: number
  overall_match_rate: number
  total_fees: number
  internal_transfers_count: number
  internal_transfers_amount: number
  bank_reconciled_count: number
  bank_unreconciled_count: number
}

interface ReconciliationDetail {
  id: string
  status: "reconciled" | "not_reconciled"
  direction: "inflow" | "outflow"
  amount: number
  gross_amount: number
  fee_amount: number
  date: string
  description: string
  linked_ar_ap: string[]
  match_type: "matched" | "partial" | "unmatched"
}

interface ApiResponse {
  summary: ReconciliationSummary
  transactions: ReconciliationDetail[]
}

export default function ReconciliationPage() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<"all" | "reconciled" | "not_reconciled">("all")

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        const response = await fetch(`/api/dashboard/reconciliation`)
        if (!response.ok) throw new Error("Failed to fetch reconciliation data")

        const result: ApiResponse = await response.json()
        setData(result)
      } catch (error) {
        console.error("Error fetching reconciliation data:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-[#141414] flex items-center justify-center">
        <div className="text-neutral-400">Loading reconciliation data...</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[#141414] flex items-center justify-center">
        <div className="text-neutral-400">Failed to load reconciliation data</div>
      </div>
    )
  }

  const { summary, transactions } = data
  const filteredTransactions = transactions.filter((t) => {
    if (filter === "all") return true
    return t.status === filter
  })

  return (
    <div className="min-h-screen bg-[#141414]">
      <div className="border-b border-white/[0.06] px-8 py-8">
        <h1 className="text-2xl font-semibold text-white tracking-tight">Reconciliation</h1>
        <p className="text-sm text-neutral-500 mt-1">Bank payments matched to invoices &middot; Gross − Fee = Net</p>
      </div>

      {/* Lifetime Overview */}
      <div className="px-8 py-6 border-b border-white/[0.06]">
        <h2 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Lifetime Overview</h2>
        <div className="grid grid-cols-6 gap-4">
          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Accounts Receivable</p>
            <p className="text-lg font-semibold text-white tabular-nums">{formatCurrency(summary.ar_total_outstanding + summary.ar_total_matched)}</p>
            <p className="text-[11px] text-neutral-600 mt-1">lifetime invoiced</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Collected</p>
            <p className="text-lg font-semibold text-emerald-400/90 tabular-nums">{formatCurrency(summary.ar_total_matched)}</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Outstanding</p>
            <p className="text-lg font-semibold text-white tabular-nums">{formatCurrency(summary.ar_total_outstanding)}</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Accounts Payable</p>
            <p className="text-lg font-semibold text-white tabular-nums">{formatCurrency(summary.ap_total_outstanding + summary.ap_total_matched)}</p>
            <p className="text-[11px] text-neutral-600 mt-1">lifetime billed</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Paid</p>
            <p className="text-lg font-semibold text-emerald-400/90 tabular-nums">{formatCurrency(summary.ap_total_matched)}</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Outstanding</p>
            <p className="text-lg font-semibold text-white tabular-nums">{formatCurrency(summary.ap_total_outstanding)}</p>
          </div>
        </div>
      </div>

      {/* Match Rates */}
      <div className="px-8 py-6 border-b border-white/[0.06]">
        <h2 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Reconciliation Overview</h2>
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-2">AR Match Rate</p>
            <p className="text-2xl font-bold text-white tabular-nums">{summary.ar_match_rate}%</p>
            <p className="text-[11px] text-neutral-600 mt-2">{formatCurrency(summary.ar_total_matched)} matched</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-2">AP Match Rate</p>
            <p className="text-2xl font-bold text-white tabular-nums">{summary.ap_match_rate}%</p>
            <p className="text-[11px] text-neutral-600 mt-2">{formatCurrency(summary.ap_total_matched)} matched</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-2">Net Outstanding</p>
            <p className="text-2xl font-bold text-white tabular-nums">{formatCurrency(summary.net_outstanding)}</p>
            <p className="text-[11px] text-neutral-600 mt-2">AR − AP</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-2">Overall Reconciled</p>
            <p className="text-2xl font-bold text-white tabular-nums">{summary.overall_match_rate}%</p>
            <p className="text-[11px] text-neutral-600 mt-2">match rate</p>
          </div>
        </div>
      </div>

      {/* Bank Reconciliation */}
      <div className="px-8 py-6 border-b border-white/[0.06]">
        <h2 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Bank Transaction Reconciliation</h2>
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-emerald-500/[0.06] border border-emerald-500/[0.15] rounded-lg p-4">
            <p className="text-[11px] text-emerald-600 mb-2">Reconciled</p>
            <p className="text-2xl font-bold text-emerald-400 tabular-nums">{summary.bank_reconciled_count}</p>
            <p className="text-[11px] text-emerald-600 mt-2">linked to AR/AP</p>
          </div>

          <div className="bg-red-500/[0.06] border border-red-500/[0.15] rounded-lg p-4">
            <p className="text-[11px] text-red-600 mb-2">Not Reconciled</p>
            <p className="text-2xl font-bold text-red-400 tabular-nums">{summary.bank_unreconciled_count}</p>
            <p className="text-[11px] text-red-600 mt-2">needs matching</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-2">Total Transactions</p>
            <p className="text-2xl font-bold text-white tabular-nums">{transactions.length}</p>
            <p className="text-[11px] text-neutral-600 mt-2">bank movements</p>
          </div>
        </div>
      </div>

      {/* Transactions Table */}
      <div className="px-8 py-6">
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              filter === "all"
                ? "bg-white/[0.1] text-white border border-white/[0.2]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            All ({transactions.length})
          </button>
          <button
            onClick={() => setFilter("reconciled")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              filter === "reconciled"
                ? "bg-emerald-400/[0.15] text-emerald-300 border border-emerald-400/[0.3]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            Reconciled ({summary.bank_reconciled_count})
          </button>
          <button
            onClick={() => setFilter("not_reconciled")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              filter === "not_reconciled"
                ? "bg-red-400/[0.15] text-red-300 border border-red-400/[0.3]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            Not Reconciled ({summary.bank_unreconciled_count})
          </button>
        </div>

        <div className="border border-white/[0.06] rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Date</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Description</th>
                <th className="px-4 py-3 text-right text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Gross</th>
                <th className="px-4 py-3 text-right text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Fee</th>
                <th className="px-4 py-3 text-right text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Net</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Linked AR/AP</th>
              </tr>
            </thead>
            <tbody>
              {filteredTransactions.map((tx) => (
                <tr key={tx.id} className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors">
                  <td className="px-4 py-3">
                    {tx.status === "reconciled" ? (
                      <Badge className="bg-emerald-400/10 text-emerald-400 border-emerald-400/20 text-[11px]">Reconciled</Badge>
                    ) : (
                      <Badge className="bg-red-400/10 text-red-400 border-red-400/20 text-[11px]">Not reconciled</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-neutral-400">{new Date(tx.date).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-sm text-neutral-300 truncate">{tx.description}</td>
                  <td className={`px-4 py-3 text-sm text-right tabular-nums ${tx.direction === "inflow" ? "text-emerald-400" : "text-red-400"}`}>
                    {tx.direction === "inflow" ? "+" : "-"}{formatCurrency(tx.gross_amount)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums text-neutral-500">{tx.fee_amount > 0 ? formatCurrency(tx.fee_amount) : "—"}</td>
                  <td className={`px-4 py-3 text-sm text-right tabular-nums font-medium ${tx.direction === "inflow" ? "text-emerald-400" : "text-red-400"}`}>
                    {tx.direction === "inflow" ? "+" : "-"}{formatCurrency(tx.amount)}
                  </td>
                  <td className="px-4 py-3 text-sm text-neutral-500">{tx.linked_ar_ap.length > 0 ? `${tx.linked_ar_ap.length} linked` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-[12px] text-neutral-600">Showing {filteredTransactions.length} of {transactions.length} bank transactions</p>
      </div>
    </div>
  )
}
