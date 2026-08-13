"use client"

import { money } from "@/lib/dashboard-helpers"

interface Invoice {
  id: string
  customer_name: string
  amount: number
  outstanding_amount: number
  status: "open" | "partially_paid" | "paid"
  due_date: string
}

interface ARAPReconciliationTableProps {
  invoices: Invoice[]
  bills: Invoice[]
  loading?: boolean
  error?: string | null
}

function statusBadge(status: string): string {
  switch (status) {
    case "paid":
      return "bg-emerald-500/20 text-emerald-400 border-emerald-400/30"
    case "partially_paid":
      return "bg-amber-500/20 text-amber-400 border-amber-400/30"
    case "open":
      return "bg-red-500/20 text-red-400 border-red-400/30"
    default:
      return "bg-zinc-500/20 text-zinc-400 border-zinc-400/30"
  }
}

export function ARAPReconciliationTable({
  invoices,
  bills,
  loading = false,
  error = null,
}: ARAPReconciliationTableProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-gray-400">
          <div className="h-5 w-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          <span>Loading reconciliation data...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-4 py-3">
        <p className="text-red-300 text-sm">{error}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* AR Section */}
      {invoices.length > 0 && (
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10 bg-white/[0.02]">
            <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider">Accounts Receivable</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.02]">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Customer</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider tabular-nums">Amount</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider tabular-nums">Outstanding</th>
                  <th className="px-4 py-2 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Due Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-white/[0.03] transition-colors">
                    <td className="px-4 py-2 text-white truncate">{inv.customer_name}</td>
                    <td className="px-4 py-2 text-right text-gray-300 tabular-nums">{money(inv.amount)}</td>
                    <td className="px-4 py-2 text-right text-emerald-400 font-medium tabular-nums">{money(inv.outstanding_amount)}</td>
                    <td className="px-4 py-2 text-center">
                      <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium border ${statusBadge(inv.status)}`}>
                        {inv.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs">
                      {new Date(inv.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* AP Section */}
      {bills.length > 0 && (
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10 bg-white/[0.02]">
            <h3 className="text-sm font-semibold text-purple-400 uppercase tracking-wider">Accounts Payable</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.02]">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Vendor</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider tabular-nums">Amount</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider tabular-nums">Outstanding</th>
                  <th className="px-4 py-2 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Due Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {bills.map((bill) => (
                  <tr key={bill.id} className="hover:bg-white/[0.03] transition-colors">
                    <td className="px-4 py-2 text-white truncate">{bill.customer_name}</td>
                    <td className="px-4 py-2 text-right text-gray-300 tabular-nums">{money(bill.amount)}</td>
                    <td className="px-4 py-2 text-right text-red-400 font-medium tabular-nums">{money(bill.outstanding_amount)}</td>
                    <td className="px-4 py-2 text-center">
                      <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium border ${statusBadge(bill.status)}`}>
                        {bill.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs">
                      {new Date(bill.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {invoices.length === 0 && bills.length === 0 && (
        <div className="rounded-lg border border-white/20 bg-white/5 px-4 py-3">
          <p className="text-gray-400 text-sm">No AR/AP data available.</p>
        </div>
      )}
    </div>
  )
}
