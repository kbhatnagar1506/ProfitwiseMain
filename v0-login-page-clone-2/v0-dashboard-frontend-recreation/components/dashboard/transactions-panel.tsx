"use client"

import { Search, Eye, Pencil, Plus, ChevronLeft, ChevronRight, Filter, MoreVertical, ChevronDown, Building2, ArrowRightLeft, Users2, CreditCard } from "lucide-react"

const transactions = [
  {
    date: "Aug 10",
    party: { name: "Gusto", description: "Net Pay", logo: "G", bgColor: "bg-amber-600" },
    source: { logo: "G", bgColor: "bg-amber-600" },
    category: { icon: ArrowRightLeft, label: "Payroll Clearing" },
    amount: "-$14,276.24",
    balance: "$1,082,821.81",
  },
  {
    date: "Aug 10",
    party: { name: "Gusto", description: "Taxes", logo: "G", bgColor: "bg-amber-600" },
    source: { logo: "G", bgColor: "bg-amber-600" },
    category: { icon: ArrowRightLeft, label: "Payroll Clearing" },
    amount: "-$6,966.95",
    balance: "$1,097,098.05",
  },
  {
    date: "Aug 10",
    party: { name: "Org Sub Fee", description: "ORG SUB FEE. Merchant name: O...", logo: "O", bgColor: "bg-orange-500" },
    source: null,
    category: { icon: Users2, label: "Memberships & Dues" },
    amount: "-$79.00",
    balance: "$1,104,065.00",
  },
  {
    date: "Aug 10",
    party: { name: "UnitedHealthcare", description: "UNITED HEALTHCAR; EDI PAYMT...", logo: "U", bgColor: "bg-blue-800" },
    source: null,
    category: { icon: Users2, label: "Employee Benefits" },
    amount: "-$2,228.27",
    balance: "$1,104,144.00",
  },
  {
    date: "Aug 09",
    party: { name: "Mercury", description: "IO AUTOPAY. Merchant name: M...", logo: "M", bgColor: "bg-zinc-600" },
    source: { logo: "$", bgColor: "bg-emerald-500" },
    category: { icon: CreditCard, label: "Mercury Credit Card 1..." },
    amount: "-$328.11",
    balance: "$1,106,372.27",
  },
  {
    date: "Aug 09",
    party: { name: "Swift Courier Services", description: "Payment to Swift Courier Services...", logo: "S", bgColor: "bg-purple-600" },
    source: { logo: "✓", bgColor: "bg-emerald-500" },
    category: { icon: ArrowRightLeft, label: "Accounts Payable" },
    amount: "-$2,340.00",
    balance: "$1,106,700.38",
  },
  {
    date: "Aug 07",
    party: { name: "Ramp", description: "RAMP STATEMENT; i1Qu7y4wA...", logo: "R", bgColor: "bg-yellow-400", textColor: "text-black" },
    source: null,
    category: { icon: CreditCard, label: "Ramp Card" },
    amount: "-$12,141.99",
    balance: "$1,109,040.38",
  },
]

export function TransactionsPanel() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Blue Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Building2 className="w-6 h-6 text-white" />
            <h1 className="text-white text-lg font-semibold">Banks & Cards</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-blue-300" />
              <input
                type="text"
                placeholder=""
                className="w-48 bg-blue-500/30 border-0 rounded-lg pl-9 pr-4 py-2 text-white placeholder:text-blue-200 focus:outline-none focus:ring-2 focus:ring-white/30"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-200 text-xs">⌘K</span>
            </div>
            <button className="text-white/80 hover:text-white">
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            </button>
          </div>
        </div>

        {/* Month Selector and Actions */}
        <div className="flex items-center justify-between mt-4">
          <div className="flex items-center gap-2">
            <button className="text-white/80 hover:text-white">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button className="flex items-center gap-2 bg-blue-500/30 hover:bg-blue-500/40 text-white px-4 py-1.5 rounded-lg text-sm">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              August
            </button>
            <button className="text-white/80 hover:text-white">
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex bg-blue-500/30 rounded-lg">
              <button className="flex items-center gap-1.5 px-3 py-1.5 text-white text-sm rounded-lg">
                <Eye className="w-4 h-4" />
                View
              </button>
              <button className="flex items-center gap-1.5 px-3 py-1.5 text-white/80 hover:text-white text-sm">
                <Pencil className="w-4 h-4" />
                Edit
              </button>
            </div>
            <button className="flex items-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium">
              <Plus className="w-4 h-4" />
              New Transaction
              <ChevronDown className="w-4 h-4 ml-1" />
            </button>
            <button className="text-white/80 hover:text-white">
              <MoreVertical className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 bg-black overflow-auto">
        {/* Filter Bar */}
        <div className="px-6 py-3 border-b border-zinc-800">
          <div className="flex items-center justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                placeholder="Filter 7 transactions..."
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-9 pr-4 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500"
              />
            </div>
            <button className="text-zinc-500 hover:text-white">
              <Filter className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Account Header */}
        <div className="px-6 py-4 border-b border-zinc-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-zinc-900 rounded-lg flex items-center justify-center">
                <Building2 className="w-5 h-5 text-zinc-400" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-orange-400">Assets</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white">Mercury Checking 1231</span>
                  <span className="text-zinc-500 text-sm">11100</span>
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="font-semibold text-white">$1,082,821.81</div>
              <div className="text-sm text-zinc-500">7 Transactions</div>
            </div>
            <button className="text-zinc-500 hover:text-white ml-2">
              <MoreVertical className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Transactions Table */}
        <div className="px-6">
          {/* Table Header */}
          <div className="grid grid-cols-12 gap-4 py-3 text-xs text-zinc-500 border-b border-zinc-800">
            <div className="col-span-1 flex items-center gap-1">
              Date
              <ChevronDown className="w-3 h-3" />
            </div>
            <div className="col-span-3">Party</div>
            <div className="col-span-1">Source</div>
            <div className="col-span-3">Category</div>
            <div className="col-span-2 text-right">Amount</div>
            <div className="col-span-2 text-right">Balance</div>
          </div>

          {/* Transaction Rows */}
          {transactions.map((tx, index) => (
            <div
              key={index}
              className="grid grid-cols-12 gap-4 py-3 items-center border-b border-zinc-800/50 hover:bg-zinc-900/50 cursor-pointer group"
            >
              <div className="col-span-1 text-sm text-zinc-400">{tx.date}</div>
              <div className="col-span-3 flex items-center gap-3">
                <div className={`w-8 h-8 ${tx.party.bgColor} ${tx.party.textColor || 'text-white'} rounded-lg flex items-center justify-center text-sm font-semibold`}>
                  {tx.party.logo}
                </div>
                <div>
                  <div className="text-sm font-medium text-white">{tx.party.name}</div>
                  <div className="text-xs text-zinc-500 truncate max-w-[180px]">{tx.party.description}</div>
                </div>
              </div>
              <div className="col-span-1">
                {tx.source ? (
                  <div className="flex items-center gap-1">
                    <div className={`w-6 h-6 ${tx.source.bgColor} text-white rounded-full flex items-center justify-center text-xs font-semibold`}>
                      {tx.source.logo}
                    </div>
                    <div className="w-6 h-6 bg-amber-600 text-white rounded-full flex items-center justify-center text-xs font-semibold">
                      9
                    </div>
                  </div>
                ) : (
                  <div className="w-6 h-6 bg-zinc-800 rounded-full" />
                )}
              </div>
              <div className="col-span-3 flex items-center gap-2">
                <tx.category.icon className="w-4 h-4 text-zinc-500" />
                <span className="text-sm text-zinc-400">{tx.category.label}</span>
              </div>
              <div className={`col-span-2 text-right text-sm font-medium ${tx.amount.startsWith('-') ? 'text-orange-400' : 'text-emerald-400'}`}>
                {tx.amount}
              </div>
              <div className="col-span-2 text-right flex items-center justify-end gap-2">
                <span className="text-sm text-white">{tx.balance}</span>
                <ChevronRight className="w-4 h-4 text-zinc-600 opacity-0 group-hover:opacity-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
