"use client"

import { useEffect, useState, useCallback } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { ChevronDown, ChevronUp, AlertCircle, Repeat2, TrendingUp, Flag } from "lucide-react"

interface Classification {
  economic_class: string | null
  cashflow_bucket: string | null
  counterparty_role: string | null
  hits_pnl: boolean
  is_operating: boolean
  is_financing: boolean
  is_recurring: boolean
  is_anomaly: boolean
  is_large_outlier: boolean
  is_first_seen_counterparty: boolean
  policy_status: string | null
  classification_confidence: number
  evidence_strength: number
  expense_subtype: string | null
  settlement_subtype: string | null
  needs_review: boolean
  review_reasons: string[]
}

interface Transaction {
  id: string
  date: string
  description: string
  counterparty: string | null
  entity_name: string | null
  display_name: string
  amount: number
  direction: "inflow" | "outflow"
  currency: string
  movement_type: string
  account_name: string | null
  account_mask: string | null
  pnl_eligible: boolean
  review_needed: boolean
  classification: Classification
}

interface TransactionsResponse {
  transactions: Transaction[]
  pagination: {
    page: number
    limit: number
    total: number
    total_pages: number
  }
  summary: {
    total_inflow: number
    total_outflow: number
    net: number
    txn_count: number
    pnl_count: number
    review_needed_count: number
    by_economic_class: Record<string, number>
    by_cashflow_bucket: Record<string, number>
  }
}

interface BankAccount {
  account_id: string
  name: string | null
  mask: string | null
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const percentage = Math.round(confidence * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-12 bg-zinc-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-zinc-400 transition-all"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-[11px] text-neutral-600 w-6 text-right">{percentage}%</span>
    </div>
  )
}

function FlagsCell({ transaction }: { transaction: Transaction }) {
  const flags = []
  if (transaction.classification.is_recurring) flags.push("recurring")
  if (transaction.classification.is_anomaly) flags.push("anomaly")
  if (transaction.classification.is_large_outlier) flags.push("outlier")
  if (transaction.classification.is_first_seen_counterparty) flags.push("new")
  if (transaction.review_needed) flags.push("review")
  if (transaction.classification.expense_subtype) flags.push(transaction.classification.expense_subtype)
  if (transaction.classification.settlement_subtype) flags.push(transaction.classification.settlement_subtype)

  if (flags.length === 0) return <span className="text-[11px] text-neutral-700">—</span>

  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge
          key={flag}
          variant="secondary"
          className={`text-[10px] h-5 px-1.5 ${
            flag === "review"
              ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
              : "bg-white/5 text-zinc-300 border-white/10"
          }`}
        >
          {flag}
        </Badge>
      ))}
    </div>
  )
}

function ExpandableRow({ transaction }: { transaction: Transaction }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <TableRow
        className={`hover:bg-white/[0.03] transition-colors ${
          transaction.review_needed ? "border-l-2 border-l-amber-500/50" : ""
        }`}
      >
        <TableCell className="w-8 p-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-neutral-600 hover:text-neutral-400"
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </TableCell>
        <TableCell className="text-[13px] text-neutral-400 font-medium">
          {formatDate(transaction.date)}
        </TableCell>
        <TableCell className="text-[13px] text-neutral-300 max-w-xs truncate">
          {transaction.display_name}
        </TableCell>
        <TableCell className="text-[11px] text-neutral-600">
          {transaction.account_name ? `${transaction.account_name}` : "—"}
        </TableCell>
        <TableCell
          className={`text-[13px] font-medium tabular-nums text-right ${
            transaction.direction === "inflow" ? "text-emerald-400/90" : "text-zinc-400"
          }`}
        >
          {transaction.direction === "inflow" ? "+" : "−"}{formatCurrency(transaction.amount)}
        </TableCell>
        <TableCell className="text-[11px]">
          <Badge
            variant="secondary"
            className="bg-white/5 text-zinc-300 border-white/10"
          >
            {transaction.classification.economic_class || "unclassified"}
          </Badge>
        </TableCell>
        <TableCell className="text-[11px]">
          <Badge
            variant="secondary"
            className="bg-white/5 text-zinc-300 border-white/10"
          >
            {transaction.classification.cashflow_bucket || "—"}
          </Badge>
        </TableCell>
        <TableCell className="text-[11px]">
          <ConfidenceBar confidence={transaction.classification.classification_confidence} />
        </TableCell>
        <TableCell className="text-[11px]">
          <FlagsCell transaction={transaction} />
        </TableCell>
      </TableRow>

      {expanded && (
        <TableRow className="bg-white/[0.02]">
          <TableCell colSpan={9} className="p-4">
            <div className="grid grid-cols-2 gap-6 text-[12px]">
              <div>
                <h4 className="font-semibold text-neutral-300 mb-3">Classification</h4>
                <div className="space-y-2 text-neutral-400">
                  <div>
                    <span className="text-neutral-600">Economic Class:</span>{" "}
                    <span className="text-neutral-300">{transaction.classification.economic_class || "—"}</span>
                  </div>
                  <div>
                    <span className="text-neutral-600">Cashflow Bucket:</span>{" "}
                    <span className="text-neutral-300">{transaction.classification.cashflow_bucket || "—"}</span>
                  </div>
                  <div>
                    <span className="text-neutral-600">Counterparty Role:</span>{" "}
                    <span className="text-neutral-300">{transaction.classification.counterparty_role || "—"}</span>
                  </div>
                  <div>
                    <span className="text-neutral-600">Policy Status:</span>{" "}
                    <span className="text-neutral-300">{transaction.classification.policy_status || "—"}</span>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="font-semibold text-neutral-300 mb-3">Confidence & Flags</h4>
                <div className="space-y-2 text-neutral-400">
                  <div>
                    <span className="text-neutral-600">Classification Confidence:</span>{" "}
                    <span className="text-neutral-300">
                      {Math.round(transaction.classification.classification_confidence * 100)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-neutral-600">Evidence Strength:</span>{" "}
                    <span className="text-neutral-300">
                      {Math.round(transaction.classification.evidence_strength * 100)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-neutral-600">Hits P&L:</span>{" "}
                    <span className="text-neutral-300">{transaction.classification.hits_pnl ? "Yes" : "No"}</span>
                  </div>
                  <div>
                    <span className="text-neutral-600">Operating:</span>{" "}
                    <span className="text-neutral-300">{transaction.classification.is_operating ? "Yes" : "No"}</span>
                  </div>
                </div>
              </div>

              {transaction.classification.review_reasons.length > 0 && (
                <div className="col-span-2">
                  <h4 className="font-semibold text-neutral-300 mb-2">Review Reasons</h4>
                  <div className="flex flex-wrap gap-1">
                    {transaction.classification.review_reasons.map((reason) => (
                      <Badge
                        key={reason}
                        variant="secondary"
                        className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-[11px]"
                      >
                        {reason}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

export default function TransactionsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [data, setData] = useState<TransactionsResponse | null>(null)
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(parseInt(searchParams.get("page") || "1", 10))
  const [accountId, setAccountId] = useState(searchParams.get("account_id") || "")
  const [direction, setDirection] = useState(searchParams.get("direction") || "")
  const [economicClass, setEconomicClass] = useState(searchParams.get("economic_class") || "")
  const [cashflowBucket, setCashflowBucket] = useState(searchParams.get("cashflow_bucket") || "")
  const [reviewNeeded, setReviewNeeded] = useState(searchParams.get("review_needed") === "true")
  const [search, setSearch] = useState(searchParams.get("search") || "")
  const [debouncedSearch, setDebouncedSearch] = useState(search)

  const fetchAccounts = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard/bank-accounts")
      if (response.ok) {
        const json = await response.json()
        setAccounts(json.accounts)
      }
    } catch (err) {
      console.error("Failed to fetch accounts:", err)
    }
  }, [])

  const fetchTransactions = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      params.set("page", String(page))
      params.set("limit", "50")
      if (accountId) params.set("account_id", accountId)
      if (direction) params.set("direction", direction)
      if (economicClass) params.set("economic_class", economicClass)
      if (cashflowBucket) params.set("cashflow_bucket", cashflowBucket)
      if (reviewNeeded) params.set("review_needed", "true")
      if (debouncedSearch) params.set("search", debouncedSearch)

      const response = await fetch(`/api/dashboard/transactions?${params}`)
      if (!response.ok) throw new Error("Failed to fetch transactions")
      const json = await response.json()
      setData(json)
      setError(null)
      setLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
      setLoading(false)
    }
  }, [page, accountId, direction, economicClass, cashflowBucket, reviewNeeded, debouncedSearch])

  useEffect(() => {
    fetchAccounts()
  }, [fetchAccounts])

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    fetchTransactions()
  }, [fetchTransactions])

  const handleFilterChange = () => {
    setPage(1)
  }

  if (error) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Transactions</h1>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400 text-sm">
          {error}
        </div>
      </div>
    )
  }

  const summary = data?.summary

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground tracking-tight">Transactions</h1>
        {summary && (
          <div className="flex gap-6 mt-3 text-[13px]">
            <div>
              <span className="text-neutral-600">Inflows:</span>{" "}
              <span className="text-emerald-400/90 font-medium tabular-nums">
                {formatCurrency(summary.total_inflow)}
              </span>
            </div>
            <div>
              <span className="text-neutral-600">Outflows:</span>{" "}
              <span className="text-zinc-400 font-medium tabular-nums">
                {formatCurrency(summary.total_outflow)}
              </span>
            </div>
            <div>
              <span className="text-neutral-600">Net:</span>{" "}
              <span className="text-neutral-300 font-medium tabular-nums">
                {formatCurrency(summary.net)}
              </span>
            </div>
            {summary.review_needed_count > 0 && (
              <div className="flex items-center gap-1 text-amber-400">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>{summary.review_needed_count} need review</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <Select value={accountId || "__all__"} onValueChange={(v) => { setAccountId(v === "__all__" ? "" : v); handleFilterChange() }}>
            <SelectTrigger className="bg-white/5 border-white/10 text-neutral-300">
              <SelectValue placeholder="All accounts" />
            </SelectTrigger>
            <SelectContent className="bg-[#1a1a1a] border-white/10">
              <SelectItem value="__all__">All accounts</SelectItem>
              {accounts.map((acc) => (
                <SelectItem key={acc.account_id} value={acc.account_id}>
                  {acc.name || "Account"} {acc.mask && `...${acc.mask}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={direction || "__all__"} onValueChange={(v) => { setDirection(v === "__all__" ? "" : v); handleFilterChange() }}>
            <SelectTrigger className="bg-white/5 border-white/10 text-neutral-300">
              <SelectValue placeholder="All directions" />
            </SelectTrigger>
            <SelectContent className="bg-[#1a1a1a] border-white/10">
              <SelectItem value="__all__">All directions</SelectItem>
              <SelectItem value="inflow">Inflows</SelectItem>
              <SelectItem value="outflow">Outflows</SelectItem>
            </SelectContent>
          </Select>

          <Select value={economicClass || "__all__"} onValueChange={(v) => { setEconomicClass(v === "__all__" ? "" : v); handleFilterChange() }}>
            <SelectTrigger className="bg-white/5 border-white/10 text-neutral-300">
              <SelectValue placeholder="All classes" />
            </SelectTrigger>
            <SelectContent className="bg-[#1a1a1a] border-white/10">
              <SelectItem value="__all__">All classes</SelectItem>
              {summary && Object.keys(summary.by_economic_class).map((ec) => (
                <SelectItem key={ec} value={ec}>
                  {ec} ({summary.by_economic_class[ec]})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={cashflowBucket || "__all__"} onValueChange={(v) => { setCashflowBucket(v === "__all__" ? "" : v); handleFilterChange() }}>
            <SelectTrigger className="bg-white/5 border-white/10 text-neutral-300">
              <SelectValue placeholder="All buckets" />
            </SelectTrigger>
            <SelectContent className="bg-[#1a1a1a] border-white/10">
              <SelectItem value="__all__">All buckets</SelectItem>
              {summary && Object.keys(summary.by_cashflow_bucket).map((cb) => (
                <SelectItem key={cb} value={cb}>
                  {cb} ({summary.by_cashflow_bucket[cb]})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-2">
          <Input
            placeholder="Search description or counterparty..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); handleFilterChange() }}
            className="bg-white/5 border-white/10 text-neutral-300 placeholder:text-neutral-700"
          />
          <Button
            variant={reviewNeeded ? "default" : "outline"}
            onClick={() => { setReviewNeeded(!reviewNeeded); handleFilterChange() }}
            className={reviewNeeded ? "bg-amber-500/20 text-amber-400 border-amber-500/30" : "bg-white/5 border-white/10 text-neutral-400"}
          >
            <Flag className="h-4 w-4 mr-2" />
            Review
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-12 text-center">
          <div className="inline-flex items-center justify-center">
            <div className="h-5 w-5 border-2 border-neutral-600 border-t-neutral-300 rounded-full animate-spin" />
            <span className="ml-3 text-neutral-400">Loading transactions...</span>
          </div>
        </div>
      ) : data && data.transactions.length > 0 ? (
        <>
          <div className="bg-[#141414] border border-white/[0.06] rounded-xl overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-white/[0.06] hover:bg-transparent">
                  <TableHead className="w-8 p-2 text-[11px] text-neutral-600 font-medium" />
                  <TableHead className="text-[11px] text-neutral-600 font-medium">Date</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium">Description</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium">Account</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium text-right">Amount</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium">Class</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium">Bucket</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium">Confidence</TableHead>
                  <TableHead className="text-[11px] text-neutral-600 font-medium">Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.transactions.map((txn) => (
                  <ExpandableRow key={txn.id} transaction={txn} />
                ))}
              </TableBody>
            </Table>
          </div>

          {data.pagination.total_pages > 1 && (
            <div className="flex items-center justify-between">
              <div className="text-[12px] text-neutral-600">
                Page {data.pagination.page} of {data.pagination.total_pages} ({data.pagination.total} total)
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                  className="bg-white/5 border-white/10 text-neutral-400 disabled:opacity-50"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.min(data.pagination.total_pages, page + 1))}
                  disabled={page === data.pagination.total_pages}
                  className="bg-white/5 border-white/10 text-neutral-400 disabled:opacity-50"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-8 text-center">
          <p className="text-neutral-400">No transactions found</p>
          <p className="text-sm text-neutral-600 mt-2">Try adjusting your filters</p>
        </div>
      )}
    </div>
  )
}
