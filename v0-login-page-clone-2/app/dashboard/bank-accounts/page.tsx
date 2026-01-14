"use client"

import { useEffect, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown } from "lucide-react"

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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-[#141414] border border-white/[0.06] rounded-xl p-5">
              <Skeleton className="h-4 w-24 mb-3" />
              <Skeleton className="h-8 w-32 mb-4" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>

        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-[#141414] border border-white/[0.06] rounded-xl p-5">
              <Skeleton className="h-5 w-40 mb-4" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
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
          Total balance: <span className="text-emerald-400/90 font-medium tabular-nums">{formatCurrency(totals.total_balance)}</span>
        </p>
      </div>

      {accounts.length === 0 ? (
        <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-8 text-center">
          <p className="text-neutral-400">No bank accounts connected</p>
          <p className="text-sm text-neutral-600 mt-2">Connect a bank account to get started</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-5 hover:border-white/[0.1] transition-colors">
              <p className="text-[13px] text-neutral-500 font-medium">Total Balance</p>
              <p className="text-2xl font-semibold text-foreground mt-2 tracking-tight tabular-nums">
                {formatCurrency(totals.total_balance)}
              </p>
            </div>

            <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-5 hover:border-white/[0.1] transition-colors">
              <p className="text-[13px] text-neutral-500 font-medium">Available Balance</p>
              <p className="text-2xl font-semibold text-foreground mt-2 tracking-tight tabular-nums">
                {formatCurrency(totals.total_available)}
              </p>
            </div>

            <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-5 hover:border-white/[0.1] transition-colors">
              <p className="text-[13px] text-neutral-500 font-medium">Accounts</p>
              <p className="text-2xl font-semibold text-foreground mt-2 tracking-tight">
                {totals.account_count}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {accounts.map((account) => (
              <div
                key={account.account_id}
                className="bg-[#141414] border border-white/[0.06] rounded-xl p-5 hover:border-white/[0.1] transition-colors"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-[13px] font-semibold text-foreground truncate">
                        {account.normalized_name || account.name || "Account"}
                      </h3>
                      {account.mask && (
                        <span className="text-[11px] text-neutral-600 flex-shrink-0">
                          ...{account.mask}
                        </span>
                      )}
                    </div>
                    {account.normalized_name && account.name && account.normalized_name !== account.name && (
                      <p className="text-[11px] text-neutral-600 mb-2 truncate">
                        {account.name}
                      </p>
                    )}
                    <Badge
                      variant="secondary"
                      className="bg-white/5 text-zinc-300 border-white/10 text-[11px] h-5"
                    >
                      {getAccountTypeLabel(account.type, account.subtype)}
                    </Badge>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <p className="text-[11px] text-neutral-600 font-medium mb-1">Current Balance</p>
                    <p className="text-lg font-semibold text-foreground tabular-nums">
                      {formatCurrency(account.current_balance)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-600 font-medium mb-1">Available</p>
                    <p className="text-lg font-semibold text-foreground tabular-nums">
                      {formatCurrency(account.available_balance)}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3 pt-4 border-t border-white/[0.06]">
                  <div>
                    <p className="text-[11px] text-neutral-600 font-medium mb-1">Inflows</p>
                    <p className="text-[13px] font-medium text-emerald-400/90 tabular-nums">
                      {formatCurrency(account.total_inflow)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-600 font-medium mb-1">Outflows</p>
                    <p className="text-[13px] font-medium text-zinc-400 tabular-nums">
                      {formatCurrency(account.total_outflow)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-600 font-medium mb-1">Transactions</p>
                    <p className="text-[13px] font-medium text-neutral-300">
                      {account.txn_count}
                    </p>
                  </div>
                </div>

                {account.internal_transfer_count > 0 && (
                  <div className="mt-3 pt-3 border-t border-white/[0.06]">
                    <p className="text-[11px] text-neutral-600 font-medium">
                      Internal Transfers: <span className="text-neutral-400">{account.internal_transfer_count}</span>
                    </p>
                  </div>
                )}

                {account.last_txn_date && (
                  <p className="text-[11px] text-neutral-600 mt-3">
                    Last activity: {formatDate(account.last_txn_date)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
