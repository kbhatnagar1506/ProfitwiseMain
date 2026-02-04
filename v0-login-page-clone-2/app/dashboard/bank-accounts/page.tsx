"use client"

import { useEffect, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"

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
}

interface BankAccountsResponse {
  accounts: BankAccount[]
  totals: {
    total_balance: number
    total_available: number
    account_count: number
  }
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—"
  const date = new Date(dateStr)
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function getAccountTypeLabel(type: string | null, subtype: string | null): string {
  if (!type) return "Account"
  if (type === "depository") {
    if (subtype === "checking") return "Checking"
    if (subtype === "savings") return "Savings"
    return "Depository"
  }
  if (type === "credit") return "Credit Card"
  if (type === "investment") return "Investment"
  return type.charAt(0).toUpperCase() + type.slice(1)
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
          <p className="text-sm text-neutral-500 mt-1">Manage your bank accounts</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2].map((i) => (
            <div key={i} className="flex flex-col justify-between p-6 bg-[#141414] border border-white/[0.08] rounded-xl min-h-[220px]">
              <div className="flex items-start justify-between">
                <div>
                  <Skeleton className="h-3.5 w-32 mb-1.5" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-9 w-44" />
              <div className="grid grid-cols-3 gap-3 pt-4 border-t border-white/[0.06]">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const { accounts, totals } = data

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-foreground tracking-tight">Bank Accounts</h1>
        <p className="text-sm text-neutral-500 mt-1">
          {totals.account_count} account{totals.account_count !== 1 ? "s" : ""} · Total balance{" "}
          <span className="text-emerald-400/90 font-medium tabular-nums">{formatCurrency(totals.total_balance)}</span>
        </p>
      </div>

      {accounts.length === 0 ? (
        <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-8 text-center">
          <p className="text-neutral-400">No bank accounts connected</p>
          <p className="text-sm text-neutral-600 mt-2">Connect a bank account to get started</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {accounts.map((account) => (
            <div
              key={account.account_id}
              className="flex flex-col justify-between p-6 bg-[#141414] border border-white/[0.08] rounded-xl shadow-lg hover:border-white/[0.15] transition-colors min-h-[220px]"
            >
              {/* Top: Name + mask + type badge */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-[13px] font-semibold text-foreground truncate leading-tight">
                    {account.normalized_name || account.name || "Account"}
                  </h3>
                  {account.mask && (
                    <p className="text-[11px] text-zinc-600 mt-0.5">...{account.mask}</p>
                  )}
                </div>
                <Badge
                  variant="secondary"
                  className="bg-white/5 text-zinc-400 border-white/10 text-[10px] h-5 flex-shrink-0"
                >
                  {getAccountTypeLabel(account.type, account.subtype)}
                </Badge>
              </div>

              {/* Middle: Balance hero */}
              <div className="py-4">
                <p className="text-[10px] uppercase tracking-[0.12em] text-zinc-600 font-medium mb-1">Current Balance</p>
                <p className="text-[28px] font-semibold text-foreground tabular-nums tracking-tight leading-none">
                  {formatCurrency(account.current_balance)}
                </p>
                {account.available_balance !== account.current_balance && (
                  <p className="text-[11px] text-zinc-600 mt-1.5 tabular-nums">
                    {formatCurrency(account.available_balance)} available
                  </p>
                )}
              </div>

              {/* Bottom: Stats mini-grid */}
              <div className="grid grid-cols-3 gap-3 pt-4 border-t border-white/[0.06]">
                <div>
                  <p className="text-[10px] text-zinc-600 font-medium mb-0.5">Inflows</p>
                  <p className="text-[12px] font-medium text-emerald-400/90 tabular-nums">
                    {formatCurrency(account.total_inflow)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-600 font-medium mb-0.5">Outflows</p>
                  <p className="text-[12px] font-medium text-zinc-400 tabular-nums">
                    {formatCurrency(account.total_outflow)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-600 font-medium mb-0.5">Txns</p>
                  <p className="text-[12px] font-medium text-zinc-300 tabular-nums">
                    {account.txn_count}
                  </p>
                </div>
              </div>

              {/* Footer: Last activity */}
              {account.last_txn_date && (
                <p className="text-[10px] text-zinc-600 mt-3">
                  Last activity {formatDate(account.last_txn_date)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
