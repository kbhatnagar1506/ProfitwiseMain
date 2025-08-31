"use client"

import { ChevronLeft, ChevronRight, Calendar, Eye, Pencil, ChevronDown, Search, Filter, MoreVertical, Users, AlertCircle, ArrowUpDown, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { useState } from "react"

const customers = [
  { name: "Alex Petrov", amount: "$24,175.98", transactions: 7, color: "bg-blue-500" },
  { name: "Amanda Thompson", amount: "$19,199.00", transactions: 4, color: "bg-blue-500" },
  { name: "Andrew Garcia", amount: "$18,277.98", transactions: 4, color: "bg-blue-500" },
  { 
    name: "Aria Hassan", 
    amount: "$6,198.00", 
    transactions: 3, 
    color: "bg-blue-500",
    expanded: true,
    details: [
      { date: "Aug 01", description: "Monthly Subscription: Enterprise Plan from Aria...", category: "Subscription Revenue", amount: "$2,499.00" },
      { date: "Jul 23", description: "Monthly Subscription: Advanced Plan from Aria...", category: "Subscription Revenue", amount: "$699.00" },
      { date: "Jan 25", description: "Monthly Subscription: Enterprise Plan from Aria...", category: "Subscription Revenue", amount: "$3,000.00" },
    ]
  },
  { name: "Atlas Williams", amount: "$5,898.00", transactions: 4, color: "bg-blue-500" },
]

export function CustomersPage() {
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>("Aria Hassan")
  
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
              2025
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
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Stats Sidebar */}
        <div className="w-56 border-r border-zinc-800 p-4 space-y-6">
          <div className="text-zinc-400 text-xs uppercase tracking-wide">Insights</div>
          
          <div className="bg-zinc-900 rounded-xl p-4">
            <div className="text-zinc-500 text-xs mb-1">Total</div>
            <div className="text-zinc-400 text-xs">2025</div>
            <div className="flex items-center gap-2 mt-2">
              <span className="text-3xl font-bold text-white">66</span>
              <Users className="w-5 h-5 text-zinc-500" />
            </div>
            <div className="text-zinc-500 text-xs">Customers</div>
          </div>

          <div className="bg-zinc-900 rounded-xl p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-zinc-500 text-xs">Revenue</div>
              <div className="text-white font-semibold">$714,932</div>
            </div>
            <div className="text-zinc-400 text-xs mb-3">2025 <span className="text-zinc-500">174 transactions</span></div>
            <div className="h-16 flex items-end gap-1">
              {[40, 55, 45, 60, 50, 65, 75, 55, 60, 50, 70, 90].map((h, i) => (
                <div key={i} className="flex-1 bg-teal-500/60 rounded-sm" style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>

          <div className="bg-zinc-900 rounded-xl p-4">
            <div className="flex items-center gap-1 text-zinc-500 text-xs mb-1">
              New Customers <AlertCircle className="w-3 h-3" />
            </div>
            <div className="text-zinc-400 text-xs mb-2">2025</div>
            <div className="flex items-center gap-2">
              <span className="text-3xl font-bold text-white">2</span>
              <Users className="w-5 h-5 text-zinc-500" />
              <span className="text-zinc-500 text-lg">+</span>
            </div>
            <div className="text-zinc-500 text-xs">Customers</div>
          </div>

          <div className="bg-zinc-900 rounded-xl p-4">
            <div className="flex items-center gap-1 text-zinc-500 text-xs mb-1">
              Multiple Categories <AlertCircle className="w-3 h-3" />
            </div>
            <div className="text-zinc-400 text-xs mb-2">2025</div>
            <div className="flex items-center gap-2">
              <span className="text-3xl font-bold text-white">0</span>
              <Pencil className="w-5 h-5 text-zinc-500" />
            </div>
            <div className="text-zinc-500 text-xs">Customers</div>
          </div>
        </div>

        {/* Customers List */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Search Bar */}
          <div className="p-4 border-b border-zinc-800">
            <div className="flex items-center justify-between">
              <div className="relative flex-1 max-w-lg">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input 
                  type="text"
                  placeholder="Filter 174 transactions..."
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white placeholder:text-zinc-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <button className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400">
                  <Filter className="w-4 h-4" />
                </button>
                <button className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400">
                  <ArrowUpDown className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Customers Table */}
          <div className="flex-1 overflow-auto">
            {customers.map((customer, index) => (
              <div key={index} className="border-b border-zinc-800/50">
                <button 
                  onClick={() => setExpandedCustomer(expandedCustomer === customer.name ? null : customer.name)}
                  className="w-full flex items-center justify-between px-4 py-4 hover:bg-zinc-900/50"
                >
                  <div className="flex items-center gap-3">
                    <div className={cn("w-10 h-10 rounded flex items-center justify-center text-white font-medium", customer.color)}>
                      {customer.name[0]}
                    </div>
                    <span className="text-white font-medium">{customer.name}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-white font-medium">{customer.amount}</div>
                      <div className="text-zinc-500 text-xs">{customer.transactions} Transactions</div>
                    </div>
                    <MoreVertical className="w-4 h-4 text-zinc-500" />
                  </div>
                </button>
                
                {expandedCustomer === customer.name && customer.details && (
                  <div className="bg-zinc-900/30">
                    <table className="w-full">
                      <thead>
                        <tr className="text-xs text-zinc-500 border-b border-zinc-800">
                          <th className="text-left py-2 px-4 font-medium">Date</th>
                          <th className="text-left py-2 px-4 font-medium">Party</th>
                          <th className="text-left py-2 px-4 font-medium">Source</th>
                          <th className="text-left py-2 px-4 font-medium">Category</th>
                          <th className="text-right py-2 px-4 font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {customer.details.map((detail, idx) => (
                          <tr key={idx} className="border-b border-zinc-800/30 hover:bg-zinc-800/30">
                            <td className="py-3 px-4 text-sm text-zinc-400">{detail.date}</td>
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-2">
                                <div className={cn("w-7 h-7 rounded flex items-center justify-center text-white text-xs", customer.color)}>
                                  {customer.name[0]}
                                </div>
                                <div>
                                  <div className="text-white text-sm">{customer.name}</div>
                                  <div className="text-zinc-500 text-xs truncate max-w-[200px]">{detail.description}</div>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="w-6 h-6 rounded-full bg-purple-500 flex items-center justify-center text-white text-xs">S</div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-1.5 text-sm text-zinc-300">
                                <RefreshCw className="w-4 h-4 text-zinc-500" />
                                {detail.category}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-right text-sm text-white">{detail.amount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
