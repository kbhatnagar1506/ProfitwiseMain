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

function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function getDaysOverdue(dueDate: string): number {
  const due = new Date(dueDate)
  const today = new Date()
  const diffTime = today.getTime() - due.getTime()
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
  return diffDays
}

function exportToCSV(data: any[], filename: string) {
  const headers = Object.keys(data[0] || {})
  const csv = [
    headers.join(","),
    ...data.map(row =>
      headers.map(header => {
        const value = row[header]
        if (typeof value === "string" && value.includes(",")) {
          return `"${value}"`
        }
        return value
      }).join(",")
    )
  ].join("\n")

  const blob = new Blob([csv], { type: "text/csv" })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  window.URL.revokeObjectURL(url)
}

interface ReconciliationSummary {
  ar_total_invoiced: number
  ar_total_outstanding: number
  ar_total_matched: number
  ar_match_rate: number
  ar_suspicious_count: number
  ar_suspicious_amount: number
  ap_total_billed: number
  ap_total_outstanding: number
  ap_total_matched: number
  ap_match_rate: number
  ap_suspicious_count: number
  ap_suspicious_amount: number
  net_outstanding: number
  overall_match_rate: number
  total_fees: number
  bank_reconciled_count: number
  bank_unreconciled_count: number
  bank_partial_count: number
  transfer_count: number
  fee_count: number
  operational_expense_count: number
  adjustment_count: number
  unclassified_count: number
  ar_invoices: ARInvoice[]
  ap_bills: APBill[]
}

interface ARInvoice {
  id: string
  customer_name: string
  source: string
  due_date: string
  status: "open" | "paid" | "overdue"
  bank_match: "matched" | "partial" | "unmatched"
  amount: number
  matched_amount: number
}

interface APBill {
  id: string
  vendor_name: string
  source: string
  due_date: string
  status: "open" | "paid" | "overdue"
  bank_match: "matched" | "partial" | "unmatched"
  amount: number
  matched_amount: number
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
  classification: "ar_invoice" | "ap_bill" | "internal_transfer" | "fee" | "operational_expense" | "adjustment" | "unclassified"
}

interface ApiResponse {
  summary: ReconciliationSummary
  transactions: ReconciliationDetail[]
}

export default function ReconciliationPage() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<"all" | "reconciled" | "not_reconciled">("all")
  const [arFilter, setArFilter] = useState<"all" | "open" | "overdue" | "paid">("all")
  const [apFilter, setApFilter] = useState<"all" | "open" | "overdue" | "paid">("all")
  const [currentPage, setCurrentPage] = useState(1)
  const [isRunning, setIsRunning] = useState(false)
  const [markModalOpen, setMarkModalOpen] = useState(false)
  const [selectedTransaction, setSelectedTransaction] = useState<ReconciliationDetail | null>(null)
  const [selectedARAPIds, setSelectedARAPIds] = useState<string[]>([])
  const [isMarking, setIsMarking] = useState(false)
  const [markStatus, setMarkStatus] = useState<"paid" | "unpaid">("paid")
  const [searchQuery, setSearchQuery] = useState("")
  const [classificationFilter, setClassificationFilter] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<"date" | "amount" | "status">("date")
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [selectedAuditTransaction, setSelectedAuditTransaction] = useState<string | null>(null)
  const [dataQualityDetails, setDataQualityDetails] = useState<any>(null)
  const itemsPerPage = 25

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        const response = await fetch(`/api/dashboard/reconciliation`)
        if (!response.ok) throw new Error("Failed to fetch reconciliation data")

        const result: ApiResponse = await response.json()
        setData(result)

        // Fetch data quality details
        const qualityResponse = await fetch(`/api/dashboard/reconciliation/data-quality`)
        if (qualityResponse.ok) {
          const qualityData = await qualityResponse.json()
          setDataQualityDetails(qualityData)
        }
      } catch (error) {
        console.error("Error fetching reconciliation data:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  const runReconciliation = async () => {
    try {
      setIsRunning(true)
      const response = await fetch(`/api/ar-ap-step?run=true`)
      if (!response.ok) throw new Error("Failed to run reconciliation")
      
      // Wait for reconciliation to complete by polling the lock status
      // Initial wait of 5 seconds before polling starts
      await new Promise(resolve => setTimeout(resolve, 5000))
      
      let attempts = 0
      const maxAttempts = 360 // 6 minutes total with 1-second intervals
      let reconciliationComplete = false
      
      while (attempts < maxAttempts && !reconciliationComplete) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        attempts++
        
        // Check if reconciliation is done by checking lock status
        try {
          const lockResponse = await fetch(`/api/ar-ap-step?status=true`)
          if (lockResponse.ok) {
            const lockStatus = await lockResponse.json()
            // If not running and last status is completed, we're done
            if (!lockStatus.is_running && lockStatus.last_status === "completed") {
              // Now fetch the updated data
              const reconciliationResponse = await fetch(`/api/dashboard/reconciliation`)
              if (reconciliationResponse.ok) {
                const result: ApiResponse = await reconciliationResponse.json()
                setData(result)
                reconciliationComplete = true
              }
            }
          }
        } catch (e) {
          // Continue polling
        }
      }
      
      if (!reconciliationComplete) {
        console.warn("Reconciliation polling timeout - displaying latest data")
        // Fetch data anyway after timeout
        try {
          const reconciliationResponse = await fetch(`/api/dashboard/reconciliation`)
          if (reconciliationResponse.ok) {
            const result: ApiResponse = await reconciliationResponse.json()
            setData(result)
          }
        } catch (e) {
          console.error("Error fetching reconciliation data after timeout:", e)
        }
      }
    } catch (error) {
      console.error("Error running reconciliation:", error)
    } finally {
      setIsRunning(false)
    }
  }

  const handleMarkTransaction = async () => {
    if (!selectedTransaction) return
    
    try {
      setIsMarking(true)
      const response = await fetch(`/api/dashboard/reconciliation/mark-transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction_id: selectedTransaction.id,
          status: markStatus,
          linked_ar_ap_ids: markStatus === "paid" ? selectedARAPIds : undefined,
        }),
      })
      
      if (!response.ok) throw new Error("Failed to mark transaction")
      
      // Refresh data
      const reconciliationResponse = await fetch(`/api/dashboard/reconciliation`)
      if (reconciliationResponse.ok) {
        const result: ApiResponse = await reconciliationResponse.json()
        setData(result)
      }
      
      setMarkModalOpen(false)
      setSelectedTransaction(null)
      setSelectedARAPIds([])
    } catch (error) {
      console.error("Error marking transaction:", error)
      alert("Failed to mark transaction")
    } finally {
      setIsMarking(false)
    }
  }

  const openMarkModal = (tx: ReconciliationDetail, status: "paid" | "unpaid") => {
    setSelectedTransaction(tx)
    setMarkStatus(status)
    setSelectedARAPIds([])
    setMarkModalOpen(true)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#141414] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block">
            <div className="w-8 h-8 border-2 border-neutral-600 border-t-white rounded-full animate-spin mb-4"></div>
            <p className="text-neutral-400 text-sm">Loading reconciliation data...</p>
          </div>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[#141414] flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-4" />
          <p className="text-neutral-400 text-sm">Failed to load reconciliation data</p>
        </div>
      </div>
    )
  }

  const { summary, transactions } = data
  const filteredTransactions = transactions
    .filter((t) => {
      // Status filter
      if (filter !== "all" && t.status !== filter) return false
      
      // Classification filter
      if (classificationFilter && t.classification !== classificationFilter) return false
      
      // Search filter
      if (searchQuery && !t.description.toLowerCase().includes(searchQuery.toLowerCase())) return false
      
      return true
    })
    .sort((a, b) => {
      let compareValue = 0
      
      if (sortBy === "date") {
        compareValue = new Date(a.date).getTime() - new Date(b.date).getTime()
      } else if (sortBy === "amount") {
        compareValue = a.amount - b.amount
      } else if (sortBy === "status") {
        compareValue = a.status.localeCompare(b.status)
      }
      
      return sortOrder === "asc" ? compareValue : -compareValue
    })

  const filteredARInvoices = (summary.ar_invoices || []).filter((inv) => {
    if (arFilter === "all") return true
    return inv.status === arFilter
  })

  const filteredAPBills = (summary.ap_bills || []).filter((bill) => {
    if (apFilter === "all") return true
    return bill.status === apFilter
  })

  return (
    <div className="min-h-screen bg-[#141414]">
      {/* Sticky Header with Key Metrics */}
      <div className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#141414]/95 backdrop-blur-sm px-8 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Reconciliation</h1>
            <p className="text-xs text-neutral-500 mt-1">Bank payments matched to invoices &middot; Gross − Fee = Net</p>
          </div>
          <div className="flex items-center gap-6">
            {/* Data Quality Score */}
            <div className="text-right">
              <p className="text-xs text-neutral-600 mb-1">Data Quality</p>
              <div className="flex items-center gap-2">
                <p className="text-xl font-bold text-white tabular-nums">{summary.data_quality_score.toFixed(1)}/10</p>
                {summary.data_quality_score < 7 && (
                  <AlertCircle className="w-4 h-4 text-amber-400" />
                )}
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-neutral-600 mb-1">AR Match Rate</p>
              <p className="text-xl font-bold text-emerald-400 tabular-nums">{summary.ar_match_rate}%</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-neutral-600 mb-1">AP Match Rate</p>
              <p className="text-xl font-bold text-purple-400 tabular-nums">{summary.ap_match_rate}%</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-neutral-600 mb-1">Overall</p>
              <p className="text-xl font-bold text-white tabular-nums">{summary.overall_match_rate}%</p>
            </div>
            <button
              onClick={() => setSettingsOpen(true)}
              className="px-3 py-2 rounded-lg text-sm font-medium bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05] transition-all"
              title="Settings"
            >
              ⚙️
            </button>
            <button
              onClick={runReconciliation}
              disabled={isRunning}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500/[0.15] text-emerald-300 border border-emerald-500/[0.3] hover:bg-emerald-500/[0.25] disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2 whitespace-nowrap"
            >
              {isRunning ? (
                <>
                  <div className="w-4 h-4 border-2 border-emerald-300 border-t-transparent rounded-full animate-spin"></div>
                  Running...
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  Run Reconciliation
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="px-8 py-6">
        {/* Lifetime Overview */}
        <div className="mb-6 border border-white/[0.06] rounded-lg p-6 bg-white/[0.01]">
          <h2 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Lifetime Overview</h2>
        <div className="grid grid-cols-6 gap-4">
          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Accounts Receivable</p>
            <p className="text-lg font-semibold text-white tabular-nums">{formatCurrency(summary.ar_total_invoiced)}</p>
            <p className="text-[11px] text-neutral-600 mt-1">lifetime invoiced</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Collected</p>
            <p className="text-lg font-semibold text-emerald-400/90 tabular-nums">{formatCurrency(summary.ar_total_invoiced - summary.ar_total_outstanding)}</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Outstanding</p>
            <p className="text-lg font-semibold text-white tabular-nums">{formatCurrency(summary.ar_total_outstanding)}</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Accounts Payable</p>
            <p className="text-lg font-semibold text-white tabular-nums">{formatCurrency(summary.ap_total_billed)}</p>
            <p className="text-[11px] text-neutral-600 mt-1">lifetime billed</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Paid</p>
            <p className="text-lg font-semibold text-emerald-400/90 tabular-nums">{formatCurrency(summary.ap_total_billed - summary.ap_total_outstanding)}</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Outstanding</p>
            <p className="text-lg font-semibold text-white tabular-nums">{formatCurrency(summary.ap_total_outstanding)}</p>
          </div>
        </div>
      </div>

      {/* Match Rates */}
      <div className="mb-6 border border-white/[0.06] rounded-lg p-6 bg-white/[0.01]">
        <h2 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Reconciliation Overview</h2>
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-gradient-to-br from-emerald-500/[0.1] to-emerald-500/[0.05] border border-emerald-500/[0.15] rounded-lg p-4">
            <p className="text-[11px] text-emerald-600 mb-2">AR Match Rate</p>
            <p className="text-2xl font-bold text-emerald-400 tabular-nums">{summary.ar_match_rate}%</p>
            <div className="w-full bg-white/[0.05] rounded-full h-1.5 mt-3">
              <div className="bg-emerald-400 h-1.5 rounded-full" style={{ width: `${Math.min(summary.ar_match_rate, 100)}%` }}></div>
            </div>
            <p className="text-[11px] text-neutral-600 mt-2">{formatCurrency(summary.ar_total_matched)} matched</p>
          </div>

          <div className="bg-gradient-to-br from-purple-500/[0.1] to-purple-500/[0.05] border border-purple-500/[0.15] rounded-lg p-4">
            <p className="text-[11px] text-purple-600 mb-2">AP Match Rate</p>
            <p className="text-2xl font-bold text-purple-400 tabular-nums">{summary.ap_match_rate}%</p>
            <div className="w-full bg-white/[0.05] rounded-full h-1.5 mt-3">
              <div className="bg-purple-400 h-1.5 rounded-full" style={{ width: `${Math.min(summary.ap_match_rate, 100)}%` }}></div>
            </div>
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
      <div className="mb-6 border border-white/[0.06] rounded-lg p-6 bg-white/[0.01]">
        <h2 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Bank Transaction Reconciliation</h2>
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-emerald-500/[0.06] border border-emerald-500/[0.15] rounded-lg p-4">
            <p className="text-[11px] text-emerald-600 mb-2">Fully Matched</p>
            <p className="text-2xl font-bold text-emerald-400 tabular-nums">{summary.bank_reconciled_count}</p>
            <p className="text-[11px] text-emerald-600 mt-2">100% reconciled</p>
          </div>

          <div className="bg-amber-500/[0.06] border border-amber-500/[0.15] rounded-lg p-4">
            <p className="text-[11px] text-amber-600 mb-2">Partially Matched</p>
            <p className="text-2xl font-bold text-amber-400 tabular-nums">{summary.bank_partial_count}</p>
            <p className="text-[11px] text-amber-600 mt-2">needs review</p>
          </div>

          <div className="bg-red-500/[0.06] border border-red-500/[0.15] rounded-lg p-4">
            <p className="text-[11px] text-red-600 mb-2">Unmatched</p>
            <p className="text-2xl font-bold text-red-400 tabular-nums">{summary.bank_unreconciled_count}</p>
            <p className="text-[11px] text-red-600 mt-2">needs matching</p>
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-2">Total Fees</p>
            <p className="text-2xl font-bold text-white tabular-nums">{formatCurrency(summary.total_fees)}</p>
            <p className="text-[11px] text-neutral-600 mt-2">identified</p>
          </div>
        </div>
      </div>

      {/* Transaction Classification Breakdown */}
      <div className="mb-6 border border-white/[0.06] rounded-lg p-6 bg-white/[0.01]">
        <h2 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Transaction Classification</h2>
        <div className="grid grid-cols-5 gap-4">
          {summary.transfer_count > 0 && (
            <div className="bg-slate-500/[0.06] border border-slate-500/[0.15] rounded-lg p-4">
              <p className="text-[11px] text-slate-600 mb-2">Internal Transfers</p>
              <p className="text-2xl font-bold text-slate-400 tabular-nums">{summary.transfer_count}</p>
            </div>
          )}
          {summary.fee_count > 0 && (
            <div className="bg-orange-500/[0.06] border border-orange-500/[0.15] rounded-lg p-4">
              <p className="text-[11px] text-orange-600 mb-2">Fees</p>
              <p className="text-2xl font-bold text-orange-400 tabular-nums">{summary.fee_count}</p>
            </div>
          )}
          {summary.operational_expense_count > 0 && (
            <div className="bg-blue-500/[0.06] border border-blue-500/[0.15] rounded-lg p-4">
              <p className="text-[11px] text-blue-600 mb-2">Operational</p>
              <p className="text-2xl font-bold text-blue-400 tabular-nums">{summary.operational_expense_count}</p>
            </div>
          )}
          {summary.adjustment_count > 0 && (
            <div className="bg-yellow-500/[0.06] border border-yellow-500/[0.15] rounded-lg p-4">
              <p className="text-[11px] text-yellow-600 mb-2">Adjustments</p>
              <p className="text-2xl font-bold text-yellow-400 tabular-nums">{summary.adjustment_count}</p>
            </div>
          )}
          {summary.unclassified_count > 0 && (
            <div className="bg-red-500/[0.06] border border-red-500/[0.15] rounded-lg p-4">
              <p className="text-[11px] text-red-600 mb-2">Unclassified</p>
              <p className="text-2xl font-bold text-red-400 tabular-nums">{summary.unclassified_count}</p>
            </div>
          )}
        </div>
      </div>

      {/* AR (Accounts Receivable) Section */}
      <div className="mb-6 border border-white/[0.06] rounded-lg p-6 bg-white/[0.01]">
        <h2 className="text-sm font-semibold text-white mb-2 uppercase tracking-wider">AR (Accounts Receivable)</h2>
        <p className="text-xs text-neutral-500 mb-4">Expected inflow — money you are owed. From invoices (QBO, Xero, Stripe, Gmail).</p>
        
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Total Outstanding</p>
            <p className="text-lg font-semibold text-white tabular-nums">{formatCurrency(summary.ar_total_outstanding)}</p>
          </div>
          <div className="bg-red-500/[0.06] border border-red-500/[0.15] rounded-lg p-4">
            <p className="text-[11px] text-red-600 mb-1">Overdue</p>
            <p className="text-lg font-semibold text-red-400 tabular-nums">{formatCurrency(summary.ar_suspicious_amount)}</p>
            <p className="text-[11px] text-red-600 mt-1">({summary.ar_suspicious_count})</p>
          </div>
          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Match Rate</p>
            <p className="text-lg font-semibold text-white tabular-nums">{summary.ar_match_rate}%</p>
          </div>
        </div>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setArFilter("all")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              arFilter === "all"
                ? "bg-white/[0.1] text-white border border-white/[0.2]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            All ({(summary.ar_invoices || []).length})
          </button>
          <button
            onClick={() => setArFilter("open")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              arFilter === "open"
                ? "bg-blue-400/[0.15] text-blue-300 border border-blue-400/[0.3]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            Open ({(summary.ar_invoices || []).filter(i => i.status === "open").length})
          </button>
          <button
            onClick={() => setArFilter("overdue")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              arFilter === "overdue"
                ? "bg-red-400/[0.15] text-red-300 border border-red-400/[0.3]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            Overdue ({(summary.ar_invoices || []).filter(i => i.status === "overdue").length})
          </button>
          <button
            onClick={() => setArFilter("paid")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              arFilter === "paid"
                ? "bg-emerald-400/[0.15] text-emerald-300 border border-emerald-400/[0.3]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            Paid ({(summary.ar_invoices || []).filter(i => i.status === "paid").length})
          </button>
        </div>

        <div className="border border-white/[0.06] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Customer</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Source</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Due Date</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Bank Match</th>
                <th className="px-4 py-3 text-right text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Amount</th>
              </tr>
            </thead>
            <tbody>
              {filteredARInvoices.slice(0, 20).map((inv) => (
                <tr key={inv.id} className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors">
                  <td className="px-4 py-3 text-neutral-300">{inv.customer_name}</td>
                  <td className="px-4 py-3 text-neutral-500 text-xs">{inv.source}</td>
                  <td className="px-4 py-3 text-neutral-400 text-xs">
                    {formatDate(inv.due_date)}
                    {inv.status === "overdue" && (
                      <span className="ml-2 text-red-500 text-[10px]">{getDaysOverdue(inv.due_date)}d overdue</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {inv.status === "paid" && (
                      <Badge className="bg-emerald-400/10 text-emerald-400 border-emerald-400/20 text-[11px]">Paid</Badge>
                    )}
                    {inv.status === "overdue" && (
                      <Badge className="bg-red-400/10 text-red-400 border-red-400/20 text-[11px]">Overdue</Badge>
                    )}
                    {inv.status === "open" && (
                      <Badge className="bg-blue-400/10 text-blue-400 border-blue-400/20 text-[11px]">Open</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {inv.bank_match === "matched" && (
                      <Badge className="bg-emerald-400/10 text-emerald-400 border-emerald-400/20 text-[11px]">Matched</Badge>
                    )}
                    {inv.bank_match === "partial" && (
                      <Badge className="bg-amber-400/10 text-amber-400 border-amber-400/20 text-[11px]">Partial</Badge>
                    )}
                    {inv.bank_match === "unmatched" && (
                      <Badge className="bg-red-400/10 text-red-400 border-red-400/20 text-[11px]">Unmatched</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-emerald-400/90">
                    {formatCurrency(inv.amount)}
                    {inv.matched_amount > 0 && (
                      <div className="text-[11px] text-neutral-500">matched: {formatCurrency(inv.matched_amount)}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[12px] text-neutral-600">{filteredARInvoices.length} invoices total</p>
      </div>

      {/* AP (Accounts Payable) Section */}
      <div className="mb-6 border border-white/[0.06] rounded-lg p-6 bg-white/[0.01]">
        <h2 className="text-sm font-semibold text-white mb-2 uppercase tracking-wider">AP (Accounts Payable)</h2>
        <p className="text-xs text-neutral-500 mb-4">Expected outflow — money you are expected to pay.</p>
        
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Next 30 Days</p>
            <p className="text-lg font-semibold text-white tabular-nums">{formatCurrency(summary.ap_total_outstanding)}</p>
          </div>
          <div className="bg-red-500/[0.06] border border-red-500/[0.15] rounded-lg p-4">
            <p className="text-[11px] text-red-600 mb-1">Overdue</p>
            <p className="text-lg font-semibold text-red-400 tabular-nums">{formatCurrency(summary.ap_suspicious_amount)}</p>
            <p className="text-[11px] text-red-600 mt-1">({summary.ap_suspicious_count})</p>
          </div>
          <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-4">
            <p className="text-[11px] text-neutral-600 mb-1">Match Rate</p>
            <p className="text-lg font-semibold text-white tabular-nums">{summary.ap_match_rate}%</p>
          </div>
        </div>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setApFilter("all")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              apFilter === "all"
                ? "bg-white/[0.1] text-white border border-white/[0.2]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            All ({(summary.ap_bills || []).length})
          </button>
          <button
            onClick={() => setApFilter("open")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              apFilter === "open"
                ? "bg-blue-400/[0.15] text-blue-300 border border-blue-400/[0.3]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            Open ({(summary.ap_bills || []).filter(b => b.status === "open").length})
          </button>
          <button
            onClick={() => setApFilter("overdue")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              apFilter === "overdue"
                ? "bg-red-400/[0.15] text-red-300 border border-red-400/[0.3]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            Overdue ({(summary.ap_bills || []).filter(b => b.status === "overdue").length})
          </button>
          <button
            onClick={() => setApFilter("paid")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              apFilter === "paid"
                ? "bg-emerald-400/[0.15] text-emerald-300 border border-emerald-400/[0.3]"
                : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
            }`}
          >
            Paid ({(summary.ap_bills || []).filter(b => b.status === "paid").length})
          </button>
        </div>

        <div className="border border-white/[0.06] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Vendor</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Source</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Due Date</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Bank Match</th>
                <th className="px-4 py-3 text-right text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Amount</th>
              </tr>
            </thead>
            <tbody>
              {filteredAPBills.slice(0, 20).map((bill) => (
                <tr key={bill.id} className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors">
                  <td className="px-4 py-3 text-neutral-300">{bill.vendor_name}</td>
                  <td className="px-4 py-3 text-neutral-500 text-xs">{bill.source}</td>
                  <td className="px-4 py-3 text-neutral-400 text-xs">
                    {formatDate(bill.due_date)}
                    {bill.status === "overdue" && (
                      <span className="ml-2 text-red-500 text-[10px]">{getDaysOverdue(bill.due_date)}d overdue</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {bill.status === "paid" && (
                      <Badge className="bg-emerald-400/10 text-emerald-400 border-emerald-400/20 text-[11px]">Paid</Badge>
                    )}
                    {bill.status === "overdue" && (
                      <Badge className="bg-red-400/10 text-red-400 border-red-400/20 text-[11px]">Overdue</Badge>
                    )}
                    {bill.status === "open" && (
                      <Badge className="bg-blue-400/10 text-blue-400 border-blue-400/20 text-[11px]">Open</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {bill.bank_match === "matched" && (
                      <Badge className="bg-emerald-400/10 text-emerald-400 border-emerald-400/20 text-[11px]">Matched</Badge>
                    )}
                    {bill.bank_match === "partial" && (
                      <Badge className="bg-amber-400/10 text-amber-400 border-amber-400/20 text-[11px]">Partial</Badge>
                    )}
                    {bill.bank_match === "unmatched" && (
                      <Badge className="bg-red-400/10 text-red-400 border-red-400/20 text-[11px]">Unmatched</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-400">
                    {formatCurrency(bill.amount)}
                    {bill.matched_amount > 0 && (
                      <div className="text-[11px] text-neutral-500">matched: {formatCurrency(bill.matched_amount)}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[12px] text-neutral-600">{filteredAPBills.length} bills outstanding</p>
      </div>

      {/* Bank Transactions */}
      <div className="border border-white/[0.06] rounded-lg p-6 bg-white/[0.01]">
        <h2 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">All Bank Transactions</h2>
        <div className="flex gap-2 mb-4 justify-between items-center">
          <div className="flex gap-2">
            <button
              onClick={() => { setFilter("all"); setCurrentPage(1) }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                filter === "all"
                  ? "bg-white/[0.1] text-white border border-white/[0.2]"
                  : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
              }`}
            >
              All ({transactions.length})
            </button>
            <button
              onClick={() => { setFilter("reconciled"); setCurrentPage(1) }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                filter === "reconciled"
                  ? "bg-emerald-400/[0.15] text-emerald-300 border border-emerald-400/[0.3]"
                  : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
              }`}
            >
              Matched ({transactions.filter(t => t.match_type === "matched").length})
            </button>
            <button
              onClick={() => { setFilter("not_reconciled"); setCurrentPage(1) }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                filter === "not_reconciled"
                  ? "bg-red-400/[0.15] text-red-300 border border-red-400/[0.3]"
                  : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
              }`}
            >
              Unmatched ({transactions.filter(t => t.match_type === "unmatched").length})
            </button>
          </div>
          <div className="flex gap-2 items-center">
            <input
              type="text"
              placeholder="Search transactions..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                setCurrentPage(1)
              }}
              className="px-3 py-1.5 rounded-lg text-sm bg-white/[0.02] text-white border border-white/[0.06] placeholder-neutral-600 focus:outline-none focus:border-white/[0.2] transition-all"
            />
            <select
              value={classificationFilter || ""}
              onChange={(e) => {
                setClassificationFilter(e.target.value || null)
                setCurrentPage(1)
              }}
              className="px-3 py-1.5 rounded-lg text-sm bg-white/[0.02] text-white border border-white/[0.06] focus:outline-none focus:border-white/[0.2] transition-all"
            >
              <option value="">All Classifications</option>
              <option value="ar_invoice">AR Invoice</option>
              <option value="ap_bill">AP Bill</option>
              <option value="internal_transfer">Transfer</option>
              <option value="fee">Fee</option>
              <option value="operational_expense">Operational</option>
              <option value="adjustment">Adjustment</option>
              <option value="unclassified">Unclassified</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "date" | "amount" | "status")}
              className="px-3 py-1.5 rounded-lg text-sm bg-white/[0.02] text-white border border-white/[0.06] focus:outline-none focus:border-white/[0.2] transition-all"
            >
              <option value="date">Sort by Date</option>
              <option value="amount">Sort by Amount</option>
              <option value="status">Sort by Status</option>
            </select>
            <button
              onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
              className="px-3 py-1.5 rounded-lg text-sm bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05] transition-all"
            >
              {sortOrder === "asc" ? "↑" : "↓"}
            </button>
          </div>
        </div>
        <div className="flex gap-2 mb-4 justify-between items-center">
          <div className="flex gap-2">
            <button
              onClick={() => { setFilter("all"); setCurrentPage(1) }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                filter === "all"
                  ? "bg-white/[0.1] text-white border border-white/[0.2]"
                  : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
              }`}
            >
              All ({transactions.length})
            </button>
            <button
              onClick={() => { setFilter("reconciled"); setCurrentPage(1) }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                filter === "reconciled"
                  ? "bg-emerald-400/[0.15] text-emerald-300 border border-emerald-400/[0.3]"
                  : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
              }`}
            >
              Matched ({transactions.filter(t => t.match_type === "matched").length})
            </button>
            <button
              onClick={() => { setFilter("not_reconciled"); setCurrentPage(1) }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                filter === "not_reconciled"
                  ? "bg-red-400/[0.15] text-red-300 border border-red-400/[0.3]"
                  : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
              }`}
            >
              Unmatched ({transactions.filter(t => t.match_type === "unmatched").length})
            </button>
          </div>
          <button
            onClick={() => {
              const exportData = filteredTransactions.map(tx => ({
                Date: new Date(tx.date).toLocaleDateString(),
                Description: tx.description,
                Status: tx.status,
                Direction: tx.direction,
                Gross: formatCurrency(tx.gross_amount),
                Fee: tx.fee_amount > 0 ? formatCurrency(tx.fee_amount) : "—",
                Net: formatCurrency(tx.amount),
                "Match Type": tx.match_type,
                "Linked AR/AP": tx.linked_ar_ap.length > 0 ? `${tx.linked_ar_ap.length} linked` : "—"
              }))
              exportToCSV(exportData, `reconciliation-transactions-${new Date().toISOString().split("T")[0]}.csv`)
            }}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05] transition-all"
          >
            Export CSV
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
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Match Type</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Classification</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Linked AR/AP</th>
                <th className="px-4 py-3 text-left text-[11px] font-medium text-neutral-600 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredTransactions.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage).map((tx) => (
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
                  <td className="px-4 py-3 text-sm">
                    {tx.match_type === "matched" && (
                      <Badge className="bg-emerald-400/10 text-emerald-400 border-emerald-400/20 text-[11px]">Matched</Badge>
                    )}
                    {tx.match_type === "partial" && (
                      <Badge className="bg-amber-400/10 text-amber-400 border-amber-400/20 text-[11px]">Partial</Badge>
                    )}
                    {tx.match_type === "unmatched" && (
                      <Badge className="bg-red-400/10 text-red-400 border-red-400/20 text-[11px]">Unmatched</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {tx.classification === "internal_transfer" && (
                      <Badge className="bg-slate-400/10 text-slate-400 border-slate-400/20 text-[11px]">Transfer</Badge>
                    )}
                    {tx.classification === "fee" && (
                      <Badge className="bg-orange-400/10 text-orange-400 border-orange-400/20 text-[11px]">Fee</Badge>
                    )}
                    {tx.classification === "operational_expense" && (
                      <Badge className="bg-blue-400/10 text-blue-400 border-blue-400/20 text-[11px]">Operational</Badge>
                    )}
                    {tx.classification === "ar_invoice" && (
                      <Badge className="bg-emerald-400/10 text-emerald-400 border-emerald-400/20 text-[11px]">AR Invoice</Badge>
                    )}
                    {tx.classification === "ap_bill" && (
                      <Badge className="bg-purple-400/10 text-purple-400 border-purple-400/20 text-[11px]">AP Bill</Badge>
                    )}
                    {tx.classification === "adjustment" && (
                      <Badge className="bg-yellow-400/10 text-yellow-400 border-yellow-400/20 text-[11px]">Adjustment</Badge>
                    )}
                    {tx.classification === "unclassified" && (
                      <Badge className="bg-red-400/10 text-red-400 border-red-400/20 text-[11px]">Unclassified</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-neutral-500">{tx.linked_ar_ap.length > 0 ? `${tx.linked_ar_ap.length} linked` : "—"}</td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex gap-2">
                      {tx.status === "not_reconciled" && (
                        <button
                          onClick={() => openMarkModal(tx, "paid")}
                          className="px-2 py-1 rounded text-[11px] bg-emerald-400/10 text-emerald-400 border border-emerald-400/20 hover:bg-emerald-400/20 transition-all"
                        >
                          Mark Paid
                        </button>
                      )}
                      {tx.status === "reconciled" && (
                        <button
                          onClick={() => openMarkModal(tx, "unpaid")}
                          className="px-2 py-1 rounded text-[11px] bg-red-400/10 text-red-400 border border-red-400/20 hover:bg-red-400/20 transition-all"
                        >
                          Mark Unpaid
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-[12px] text-neutral-600">
            Showing {Math.min((currentPage - 1) * itemsPerPage + 1, filteredTransactions.length)}–{Math.min(currentPage * itemsPerPage, filteredTransactions.length)} of {filteredTransactions.length} transactions
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              Previous
            </button>
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.ceil(filteredTransactions.length / itemsPerPage) }).map((_, i) => (
                <button
                  key={i + 1}
                  onClick={() => setCurrentPage(i + 1)}
                  className={`px-2 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    currentPage === i + 1
                      ? "bg-white/[0.1] text-white border border-white/[0.2]"
                      : "bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05]"
                  }`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            <button
              onClick={() => setCurrentPage(Math.min(Math.ceil(filteredTransactions.length / itemsPerPage), currentPage + 1))}
              disabled={currentPage === Math.ceil(filteredTransactions.length / itemsPerPage)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>

      {/* Mark Transaction Modal */}
      {markModalOpen && selectedTransaction && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#1a1a1a] border border-white/[0.06] rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-lg font-semibold text-white mb-4">
              Mark Transaction as {markStatus === "paid" ? "Paid" : "Unpaid"}
            </h2>
            
            <div className="mb-4 p-3 bg-white/[0.02] border border-white/[0.06] rounded">
              <p className="text-sm text-neutral-400 mb-2">Transaction:</p>
              <p className="text-sm text-white font-medium">{selectedTransaction.description}</p>
              <p className="text-sm text-neutral-500 mt-1">
                {selectedTransaction.direction === "inflow" ? "+" : "-"}{formatCurrency(selectedTransaction.amount)}
              </p>
            </div>

            {markStatus === "paid" && (
              <div className="mb-4">
                <p className="text-sm text-neutral-400 mb-2">Link to AR/AP items (optional):</p>
                <div className="max-h-48 overflow-y-auto space-y-2">
                  {data?.summary.ar_invoices.map((inv) => (
                    <label key={inv.id} className="flex items-center gap-2 p-2 hover:bg-white/[0.02] rounded cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedARAPIds.includes(inv.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedARAPIds([...selectedARAPIds, inv.id])
                          } else {
                            setSelectedARAPIds(selectedARAPIds.filter(id => id !== inv.id))
                          }
                        }}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-neutral-300">{inv.customer_name}</span>
                      <span className="text-sm text-neutral-500 ml-auto">{formatCurrency(inv.amount)}</span>
                    </label>
                  ))}
                  {data?.summary.ap_bills.map((bill) => (
                    <label key={bill.id} className="flex items-center gap-2 p-2 hover:bg-white/[0.02] rounded cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedARAPIds.includes(bill.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedARAPIds([...selectedARAPIds, bill.id])
                          } else {
                            setSelectedARAPIds(selectedARAPIds.filter(id => id !== bill.id))
                          }
                        }}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-neutral-300">{bill.vendor_name}</span>
                      <span className="text-sm text-neutral-500 ml-auto">{formatCurrency(bill.amount)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setMarkModalOpen(false)
                  setSelectedTransaction(null)
                  setSelectedARAPIds([])
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05] transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleMarkTransaction}
                disabled={isMarking}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-400/10 text-emerald-400 border border-emerald-400/20 hover:bg-emerald-400/20 disabled:opacity-50 transition-all"
              >
                {isMarking ? "Marking..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#1a1a1a] border border-white/[0.06] rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-lg font-semibold text-white mb-4">Reconciliation Settings</h2>
            
            <div className="space-y-4 mb-6">
              <div>
                <label className="text-sm text-neutral-400 mb-2 block">Stage 4 Review Threshold ($)</label>
                <input
                  type="number"
                  defaultValue="1000"
                  className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.1] text-white text-sm"
                  placeholder="1000"
                />
              </div>
              
              <div>
                <label className="text-sm text-neutral-400 mb-2 block">Processor Fee Tolerance (0-1)</label>
                <input
                  type="number"
                  defaultValue="0.08"
                  min="0"
                  max="1"
                  step="0.01"
                  className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.1] text-white text-sm"
                  placeholder="0.08"
                />
              </div>
              
              <div>
                <label className="text-sm text-neutral-400 mb-2 block">Minimum Confidence (0-1)</label>
                <input
                  type="number"
                  defaultValue="0.80"
                  min="0"
                  max="1"
                  step="0.01"
                  className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.1] text-white text-sm"
                  placeholder="0.80"
                />
              </div>
              
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" defaultChecked className="w-4 h-4" />
                <span className="text-sm text-neutral-400">Auto-reconcile exact matches</span>
              </label>
            </div>

            {/* Data Quality Issues */}
            {dataQualityDetails && (
              <div className="mb-6 p-3 bg-white/[0.02] border border-white/[0.06] rounded">
                <p className="text-sm font-medium text-white mb-2">Data Quality Issues:</p>
                {dataQualityDetails.duplicates?.length > 0 && (
                  <p className="text-xs text-amber-400 mb-1">• {dataQualityDetails.duplicates.length} duplicate groups</p>
                )}
                {dataQualityDetails.over_matched?.length > 0 && (
                  <p className="text-xs text-amber-400 mb-1">• {dataQualityDetails.over_matched.length} over-matched items</p>
                )}
                {dataQualityDetails.status_anomalies?.length > 0 && (
                  <p className="text-xs text-amber-400">• {dataQualityDetails.status_anomalies.length} status anomalies</p>
                )}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setSettingsOpen(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.02] text-neutral-400 border border-white/[0.06] hover:bg-white/[0.05] transition-all"
              >
                Close
              </button>
              <button
                className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-400/10 text-emerald-400 border border-emerald-400/20 hover:bg-emerald-400/20 transition-all"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Data Quality Warnings */}
      {data && (data.summary.duplicate_count > 0 || data.summary.over_matched_count > 0 || data.summary.status_anomaly_count > 0) && (
        <div className="fixed bottom-4 right-4 bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 max-w-sm">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-400 mb-2">Data Quality Issues Detected</p>
              <ul className="text-xs text-amber-300 space-y-1">
                {data.summary.duplicate_count > 0 && <li>• {data.summary.duplicate_count} duplicate transactions</li>}
                {data.summary.over_matched_count > 0 && <li>• {data.summary.over_matched_count} over-matched items</li>}
                {data.summary.status_anomaly_count > 0 && <li>• {data.summary.status_anomaly_count} status anomalies</li>}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
