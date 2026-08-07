"use client"

import { useEffect, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"

interface BankAccount {
  account_id: string
  name: string | null
  normalized_name: string | null
  type: string | null
  subtype: string | null
  mask: string | null
  current_balance: number
  available_balance: number
  currency_code: string
  item_id: string
  txn_count: number
  internal_transfer_count: number
  total_inflow: number
  total_outflow: number
  last_txn_date: string | null
  balance_history: number[]
}

interface RecentTransaction {
  id: string
  date: string
  direction: string
  amount: number
  display_name: string
  account_name: string | null
  account_mask: string | null
}

interface BankAccountsResponse {
  accounts: BankAccount[]
  totals: {
    total_balance: number
    total_available: number
    account_count: number
  }
  recent_transactions: RecentTransaction[]
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatCompactCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—"
  const date = new Date(dateStr)
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function getAccountShortName(name: string | null): string {
  if (!name) return "ACC"
  const normalized = name.toUpperCase()
  if (normalized.includes("MMA") || normalized.includes("MONEY MARKET")) return "MMA"
  if (normalized.includes("LLC")) return "LLC"
  if (normalized.includes("CHECKING")) return "CHK"
  if (normalized.includes("SAVINGS")) return "SAV"
  if (normalized.includes("CREDIT")) return "CC"
  const words = name.split(/\s+/)
  if (words.length >= 2) {
    return words.slice(0, 2).map(w => w[0]).join("").toUpperCase()
  }
  return name.slice(0, 3).toUpperCase()
}

function getAccountTypeLabel(type: string | null, subtype: string | null): string {
  if (!type) return "ACCOUNT"
  if (type === "depository") {
    if (subtype === "checking") return "CHECKING"
    if (subtype === "savings") return "SAVINGS"
    return "DEPOSITORY"
  }
  if (type === "credit") return "CREDIT"
  if (type === "investment") return "INVESTMENT"
  return type.toUpperCase()
}

function Sparkline({ data, width = 120, height = 32 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x},${y}`
  })

  const trending = data[data.length - 1] >= data[0]
  const strokeColor = trending ? "rgb(52 211 153 / 0.5)" : "rgb(161 161 170 / 0.5)"

  const fillPoints = `0,${height} ${points.join(" ")} ${width},${height}`
  const fillColor = trending ? "url(#sparkGreen)" : "url(#sparkGray)"

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id="sparkGreen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(52 211 153 / 0.12)" />
          <stop offset="100%" stopColor="rgb(52 211 153 / 0)" />
        </linearGradient>
        <linearGradient id="sparkGray" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(161 161 170 / 0.08)" />
          <stop offset="100%" stopColor="rgb(161 161 170 / 0)" />
        </linearGradient>
      </defs>
      <polygon points={fillPoints} fill={fillColor} />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function BankAccountsPage() {
  const [data, setData] = useState<BankAccountsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const response = await fetch("/api/dashboard/bank-accounts")
        if (!response.ok) throw new Error("Failed to fetch accounts")
        const json = await response.json()
        setData(json)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error")
      } finally {
        setLoading(false)
      }
    }

    fetchAccounts()
  }, [])

  if (error) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Bank Accounts</h1>
          <p className="text-sm text-neutral-500 mt-1">Manage your bank accounts</p>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400 text-sm">
          {error}
        </div>
      </div>
    )
  }

  if (loading || !data) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Bank Accounts</h1>
          <p className="text-sm text-zinc-500 mt-1">Manage your bank accounts</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2].map((i) => (
            <div key={i} className="flex flex-col justify-between p-6 bg-zinc-950 border border-zinc-800 rounded-xl min-h-[220px]">
              <div className="flex items-start justify-between">
                <div>
                  <Skeleton className="h-3.5 w-32 mb-1.5" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <Skeleton className="h-5 w-16 rounded" />
              </div>
              <Skeleton className="h-9 w-44" />
              <Skeleton className="h-8 w-full rounded" />
              <div className="grid grid-cols-3 gap-3 pt-4 border-t border-zinc-800/80">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            </div>
          ))}
        </div>

        <div>
          <Skeleton className="h-4 w-40 mb-4" />
          <div className="space-y-0">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="border-b border-zinc-800/80 py-3">
                <Skeleton className="h-5 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const { accounts, totals, recent_transactions } = data
  const hasMultipleAccounts = accounts.length > 1

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-foreground tracking-tight">Bank Accounts</h1>
        <p className="text-sm text-zinc-500 mt-1">
          {totals.account_count} account{totals.account_count !== 1 ? "s" : ""} · Total balance{" "}
          <span className="text-emerald-400 font-medium font-mono tabular-nums tracking-tight">{formatCurrency(totals.total_balance)}</span>
        </p>
      </div>

      {accounts.length === 0 ? (
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-8 text-center">
          <p className="text-zinc-400">No bank accounts connected</p>
          <p className="text-sm text-zinc-600 mt-2">Connect a bank account to get started</p>
        </div>
      ) : (
        <>
          {/* Account Cards - Premium Credit Card Style */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {accounts.map((account) => {
              const hasStats = account.total_inflow > 0 || account.total_outflow > 0 || account.txn_count > 0

              return (
                <div
                  key={account.account_id}
                  className="flex flex-col justify-between p-6 bg-zinc-950 border border-zinc-800 rounded-xl hover:border-zinc-700 transition-colors"
                >
                  {/* Top: Name + mask + type badge */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-semibold text-foreground truncate leading-tight">
                        {account.normalized_name || account.name || "Account"}
                      </h3>
                      {account.mask && (
                        <p className="text-[11px] text-zinc-600 mt-0.5 font-mono tracking-tight">...{account.mask}</p>
                      )}
                    </div>
                    <span className="bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10px] uppercase px-2 py-0.5 rounded font-mono flex-shrink-0">
                      {getAccountTypeLabel(account.type, account.subtype)}
                    </span>
                  </div>

                  {/* Middle: Balance hero + sparkline */}
                  <div className="py-4">
                    <p className="text-[10px] uppercase tracking-[0.12em] text-zinc-600 font-medium mb-1">Current Balance</p>
                    <p className="text-3xl text-white font-mono font-medium tabular-nums tracking-tighter leading-none">
                      {formatCurrency(account.current_balance)}
                    </p>
                    {account.available_balance !== account.current_balance && (
                      <p className="text-[11px] text-zinc-600 mt-1.5 font-mono tabular-nums tracking-tight">
                        {formatCurrency(account.available_balance)} available
                      </p>
                    )}
                    {account.balance_history.length >= 2 && (
                      <div className="mt-3">
                        <Sparkline data={account.balance_history} width={180} height={36} />
                        <p className="text-[9px] text-zinc-700 mt-1">30-day trend</p>
                      </div>
                    )}
                  </div>

                  {/* Bottom: Stats mini-grid (hidden when all zeros) */}
                  {hasStats && (
                    <div className="grid grid-cols-3 gap-3 pt-4 border-t border-zinc-800/80">
                      <div>
                        <p className="text-[10px] text-zinc-600 font-medium mb-0.5">Inflows</p>
                        <p className="text-[12px] font-medium text-emerald-400 font-mono tabular-nums tracking-tight">
                          {formatCompactCurrency(account.total_inflow)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-zinc-600 font-medium mb-0.5">Outflows</p>
                        <p className="text-[12px] font-medium text-zinc-200 font-mono tabular-nums tracking-tight">
                          {formatCompactCurrency(account.total_outflow)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-zinc-600 font-medium mb-0.5">Txns</p>
                        <p className="text-[12px] font-medium text-zinc-300 font-mono tabular-nums">
                          {account.txn_count}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Footer: Last activity */}
                  {account.last_txn_date && (
                    <p className="text-[10px] text-zinc-600 mt-3 font-mono tracking-tight">
                      Last activity {formatDate(account.last_txn_date)}
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          {/* Recent Activity Ledger - Flat, Infinite List Style */}
          {recent_transactions && recent_transactions.length > 0 && (
            <div className="mt-2">
              <p className="text-sm text-zinc-500 mb-4 font-medium tracking-tight">Recent Account Activity</p>
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-zinc-800/80">
                    <th className="text-[10px] text-zinc-600 font-medium uppercase tracking-wider py-2.5 pr-4">Date</th>
                    <th className="text-[10px] text-zinc-600 font-medium uppercase tracking-wider py-2.5 px-4">Description</th>
                    <th className="text-[10px] text-zinc-600 font-medium uppercase tracking-wider py-2.5 px-4">Account</th>
                    <th className="text-[10px] text-zinc-600 font-medium uppercase tracking-wider py-2.5 pl-4 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {recent_transactions.map((txn) => (
                    <tr key={txn.id} className="border-b border-zinc-800/80 last:border-0 hover:bg-zinc-900/40 transition-colors">
                      <td className="text-[12px] text-zinc-500 py-3 pr-4 font-mono tabular-nums tracking-tight">
                        {formatShortDate(txn.date)}
                      </td>
                      <td className="text-[12px] text-zinc-300 py-3 px-4 truncate max-w-[280px]">
                        {txn.display_name}
                      </td>
                      <td className="text-[11px] text-zinc-500 py-3 px-4 font-mono tracking-tight">
                        {txn.account_mask ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600"></span>
                            {getAccountShortName(txn.account_name)} ...{txn.account_mask}
                          </span>
                        ) : txn.account_name ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600"></span>
                            {getAccountShortName(txn.account_name)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={`text-[12px] font-medium font-mono tabular-nums tracking-tight py-3 pl-4 text-right ${
                        txn.direction === "inflow" ? "text-emerald-400" : "text-zinc-200"
                      }`}>
                        {txn.direction === "inflow" ? "+" : "−"}{formatCurrency(txn.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
