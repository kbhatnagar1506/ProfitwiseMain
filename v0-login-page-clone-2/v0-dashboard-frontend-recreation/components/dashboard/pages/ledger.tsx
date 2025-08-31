"use client"

import { ChevronLeft, ChevronRight, Calendar, Eye, Pencil, ChevronDown, Search, Filter, MoreVertical, ChevronRight as ChevronRightSmall, ArrowUpRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useState } from "react"

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"]

const accountTree = [
  {
    name: "Assets",
    code: "10000",
    count: 22,
    expanded: true,
    children: [
      { name: "Mercury Checking 12...", code: "11100", count: 7 },
      { 
        name: "Asset Clearing", 
        code: "11500",
        expanded: true,
        children: [
          { name: "Digits - Invoice Cl...", code: "11520" }
        ]
      },
      { 
        name: "Accounts Receivable", 
        code: "12000",
        children: [
          { name: "Accounts Receiva...", code: "12010" }
        ]
      },
      { name: "Stripe Clearing", code: "12100", count: 15 },
      { name: "Prepaid Expenses", code: "13000" },
      { name: "Investments", code: "14000" },
    ]
  },
  {
    name: "Liabilities",
    code: "20000",
    count: 23,
    expanded: true,
    children: [
      { name: "Accounts Payable", code: "21000", count: 2 },
      { name: "Mercury Credit Card ...", code: "22100", count: 4 },
      { name: "Ramp Card", code: "22200", count: 12 },
      { 
        name: "Liability Clearing", 
        code: "23000",
        count: 4,
        children: [
          { name: "Payroll Clearing", code: "23200", count: 4 },
          { name: "Bill Pay Clearing", code: "23300" },
        ]
      },
      { name: "Accrued Expenses", code: "", count: 1 },
    ]
  }
]

const transactions = [
  { date: "Aug 10", party: "Gusto", partyDetail: "Net Pay", source: "gusto", category: "Payroll Clearing", amount: "-$14,276.24", balance: "$1,082,821.81" },
  { date: "Aug 10", party: "Gusto", partyDetail: "Taxes", source: "gusto", category: "Payroll Clearing", amount: "-$6,966.95", balance: "$1,097,098.05" },
  { date: "Aug 10", party: "Org Sub Fee", partyDetail: "ORG SUB FEE. Merchant name: O...", source: "default", category: "Memberships & Dues", amount: "-$79.00", balance: "$1,104,065.00" },
  { date: "Aug 10", party: "UnitedHealthcare", partyDetail: "UNITED HEALTHCAR; EDI PAYMT...", source: "healthcare", category: "Employee Benefits", amount: "-$2,228.27", balance: "$1,104,144.00" },
  { date: "Aug 09", party: "Mercury", partyDetail: "IO AUTOPAY. Merchant name: M...", source: "mercury", category: "Mercury Credit Card 1...", amount: "-$328.11", balance: "$1,106,372.27" },
  { date: "Aug 09", party: "Swift Courier Services", partyDetail: "Payment to Swift Courier Services...", source: "swift", category: "Accounts Payable", amount: "-$2,340.00", balance: "$1,106,700.38" },
  { date: "Aug 07", party: "Ramp", partyDetail: "RAMP STATEMENT; i1Qu7y4wA...", source: "ramp", category: "Ramp Card", amount: "-$12,141.99", balance: "$1,109,040.38" },
]

function AccountItem({ item, level = 0 }: { item: any; level?: number }) {
  const [expanded, setExpanded] = useState(item.expanded || false)
  const hasChildren = item.children && item.children.length > 0
  
  return (
    <div>
      <button 
        onClick={() => hasChildren && setExpanded(!expanded)}
        className={cn(
          "w-full flex items-center justify-between py-1.5 px-2 text-sm hover:bg-zinc-900 rounded text-left",
          level === 0 && "text-white font-medium"
        )}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {hasChildren && (
            <ChevronRightSmall className={cn("w-3 h-3 text-zinc-500 transition-transform", expanded && "rotate-90")} />
          )}
          {!hasChildren && <span className="w-3" />}
          <span className={cn("truncate", level > 0 && "text-zinc-400")}>{item.name}</span>
          {item.code && <span className="text-zinc-600 text-xs ml-1">{item.code}</span>}
        </div>
        {item.count && <span className="text-zinc-500 text-xs">{item.count}</span>}
      </button>
      {expanded && hasChildren && (
        <div>
          {item.children.map((child: any, idx: number) => (
            <AccountItem key={idx} item={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export function LedgerPage() {
  const [selectedMonth, setSelectedMonth] = useState("Aug")
  
  return (
    <div className="flex-1 flex flex-col bg-black">
      {/* Blue Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-500 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button className="p-1 hover:bg-white/10 rounded">
              <ChevronLeft className="w-5 h-5 text-white" />
            </button>
            <button className="flex items-center gap-2 bg-white/20 hover:bg-white/30 rounded-lg px-3 py-1.5 text-white text-sm">
              <Calendar className="w-4 h-4" />
            </button>
            <button className="p-1 hover:bg-white/10 rounded">
              <ChevronRight className="w-5 h-5 text-white" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-white/20 rounded-lg overflow-hidden">
              <button className="flex items-center gap-1.5 px-3 py-1.5 text-white text-sm bg-white/20">
                <Eye className="w-4 h-4" />
                View
              </button>
              <button className="flex items-center gap-1.5 px-3 py-1.5 text-white/70 text-sm hover:bg-white/10">
                <Pencil className="w-4 h-4" />
                Edit
              </button>
            </div>
            <button className="flex items-center gap-2 bg-teal-500 hover:bg-teal-400 text-white px-4 py-2 rounded-lg text-sm font-medium">
              New Transaction
              <ChevronDown className="w-4 h-4" />
            </button>
            <button className="text-white/80 hover:text-white">
              <MoreVertical className="w-5 h-5" />
            </button>
          </div>
        </div>
        
        {/* Month Timeline */}
        <div className="flex items-center gap-6 mt-4 px-4">
          <button className="p-1 hover:bg-white/10 rounded">
            <ChevronLeft className="w-4 h-4 text-white" />
          </button>
          {months.map((month) => (
            <button
              key={month}
              onClick={() => setSelectedMonth(month)}
              className={cn(
                "flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm transition-colors",
                selectedMonth === month 
                  ? "bg-white/20 text-white" 
                  : "text-white/60 hover:text-white"
              )}
            >
              {month}
              <Pencil className="w-3 h-3" />
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Account Tree Sidebar */}
        <div className="w-56 border-r border-zinc-800 p-3 overflow-auto">
          <div className="relative mb-3">
            <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input 
              type="text"
              placeholder="Lookup..."
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-8 pr-3 py-1.5 text-sm text-white placeholder:text-zinc-500"
            />
          </div>
          {accountTree.map((item, idx) => (
            <AccountItem key={idx} item={item} />
          ))}
        </div>

        {/* Transactions */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Search Bar */}
          <div className="p-4 border-b border-zinc-800">
            <div className="flex items-center justify-between">
              <div className="relative flex-1 max-w-lg">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input 
                  type="text"
                  placeholder="Filter 98 transactions..."
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white placeholder:text-zinc-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <button className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400">
                  <Filter className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Account Header */}
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-teal-500/20 rounded-lg flex items-center justify-center">
                <ArrowUpRight className="w-4 h-4 text-teal-400" />
              </div>
              <div>
                <span className="text-teal-400 text-xs">Assets</span>
                <div className="text-white font-medium">Mercury Checking 1231 <span className="text-zinc-500">11100</span></div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-white font-semibold">$1,082,821.81</div>
              <div className="text-zinc-500 text-xs">7 Transactions</div>
            </div>
          </div>

          {/* Transactions Table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-3 px-4 font-medium">Date</th>
                  <th className="text-left py-3 px-4 font-medium">Party</th>
                  <th className="text-left py-3 px-4 font-medium">Source</th>
                  <th className="text-left py-3 px-4 font-medium">Category</th>
                  <th className="text-right py-3 px-4 font-medium">Amount</th>
                  <th className="text-right py-3 px-4 font-medium">Balance</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx, index) => (
                  <tr key={index} className="border-b border-zinc-800/50 hover:bg-zinc-900/50">
                    <td className="py-3 px-4 text-sm text-zinc-400">{tx.date}</td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold",
                          tx.source === "gusto" && "bg-amber-600",
                          tx.source === "healthcare" && "bg-blue-600",
                          tx.source === "mercury" && "bg-zinc-600",
                          tx.source === "swift" && "bg-purple-600",
                          tx.source === "ramp" && "bg-yellow-500",
                          tx.source === "default" && "bg-red-500"
                        )}>
                          {tx.party[0]}
                        </div>
                        <div>
                          <div className="text-white text-sm font-medium">{tx.party}</div>
                          <div className="text-zinc-500 text-xs truncate max-w-[180px]">{tx.partyDetail}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center">
                        <span className="text-zinc-500 text-xs">9</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-sm text-zinc-300">{tx.category}</td>
                    <td className="py-3 px-4 text-right text-sm text-orange-400 font-medium">{tx.amount}</td>
                    <td className="py-3 px-4 text-right text-sm text-white">{tx.balance}</td>
                    <td className="py-3 px-4">
                      <ChevronRight className="w-4 h-4 text-zinc-600" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
