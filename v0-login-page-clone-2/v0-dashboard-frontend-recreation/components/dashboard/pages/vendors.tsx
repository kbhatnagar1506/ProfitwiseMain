"use client"

import { ChevronLeft, ChevronRight, Calendar, Eye, Pencil, ChevronDown, Search, Filter, MoreVertical, ChevronRight as ChevronRightSmall, Building2, Users, AlertCircle, ArrowUpDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { useState } from "react"

const vendors = [
  { 
    name: "Airbnb", 
    logo: "bg-gradient-to-br from-red-400 to-red-600",
    icon: "A",
    amount: "$10,790.00", 
    transactions: 5,
    expanded: false
  },
  { 
    name: "Airtable", 
    logo: "bg-gradient-to-br from-yellow-400 to-pink-500",
    icon: "A",
    amount: "$1,425.40", 
    transactions: 5,
    expanded: false
  },
  { 
    name: "Allianz SE", 
    logo: "bg-gradient-to-br from-blue-600 to-blue-800",
    icon: "A",
    amount: "$453.00", 
    transactions: 1,
    expanded: true,
    details: [
      { date: "Aug 19", party: "Allianz SE", detail: "Allianz Insurance. Merchant name: Allianz Insur...", category: "Insurance", amount: "$453.00" }
    ]
  },
  { 
    name: "Apple", 
    logo: "bg-zinc-800",
    icon: "apple",
    amount: "$22,507.84", 
    transactions: 12,
    expanded: true,
    details: [
      { date: "Aug 12", party: "Apple", detail: "Purchase of Apple AirPods Pro for noise cancell...", category: "Computers Expense", amount: "$249.00", sourceIcon: "yellow" },
      { date: "Aug 02", party: "Apple", detail: "APPLE.COM/BILL; Merchant name: Apple", category: "Business Applications & Software", amount: "$24.99" },
      { date: "Jul 18", party: "Apple", detail: "Purcha...", category: "Computers Expense", amount: "$1,299.00", sourceIcon: "yellow" },
    ]
  },
]

export function VendorsPage() {
  const [expandedVendor, setExpandedVendor] = useState<string | null>("Apple")
  
  return (
    <div className="flex-1 flex flex-col bg-black">
      {/* Blue Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-500 px-6 py-4">
        <div className="flex items-center gap-4 mb-3">
          <div className="flex items-center bg-white/20 rounded-lg overflow-hidden">
            <button className="px-4 py-1.5 text-white text-sm bg-white/20">Summary</button>
            <button className="px-4 py-1.5 text-white/70 text-sm hover:bg-white/10">Taxes</button>
          </div>
        </div>
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
              <span className="text-3xl font-bold text-white">59</span>
              <Building2 className="w-5 h-5 text-zinc-500" />
            </div>
            <div className="text-zinc-500 text-xs">Vendors</div>
          </div>

          <div className="bg-zinc-900 rounded-xl p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-zinc-500 text-xs">Spend</div>
              <div className="text-white font-semibold">$511,168</div>
            </div>
            <div className="text-zinc-400 text-xs mb-3">2025 <span className="text-zinc-500">467 transactions</span></div>
            <div className="h-16 flex items-end gap-1">
              {[30, 45, 35, 50, 40, 55, 65, 45, 50, 40, 60, 80].map((h, i) => (
                <div key={i} className="flex-1 bg-teal-500/60 rounded-sm" style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>

          <div className="bg-zinc-900 rounded-xl p-4">
            <div className="flex items-center gap-1 text-zinc-500 text-xs mb-1">
              New Vendors <AlertCircle className="w-3 h-3" />
            </div>
            <div className="text-zinc-400 text-xs mb-2">2025</div>
            <div className="flex items-center gap-2">
              <span className="text-3xl font-bold text-white">15</span>
              <Building2 className="w-5 h-5 text-zinc-500" />
            </div>
            <div className="text-zinc-500 text-xs">Vendors</div>
          </div>

          <div className="bg-zinc-900 rounded-xl p-4">
            <div className="flex items-center gap-1 text-zinc-500 text-xs mb-1">
              Multiple Categories <AlertCircle className="w-3 h-3" />
            </div>
            <div className="text-zinc-400 text-xs mb-2">2025</div>
            <div className="flex items-center gap-2">
              <span className="text-3xl font-bold text-white">4</span>
              <Pencil className="w-5 h-5 text-zinc-500" />
            </div>
            <div className="text-zinc-500 text-xs">Vendors</div>
          </div>
        </div>

        {/* Vendors List */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Search Bar */}
          <div className="p-4 border-b border-zinc-800">
            <div className="flex items-center justify-between">
              <div className="relative flex-1 max-w-lg">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input 
                  type="text"
                  placeholder="Filter 467 transactions..."
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

          {/* Vendors Table */}
          <div className="flex-1 overflow-auto">
            {vendors.map((vendor, index) => (
              <div key={index} className="border-b border-zinc-800/50">
                <button 
                  onClick={() => setExpandedVendor(expandedVendor === vendor.name ? null : vendor.name)}
                  className="w-full flex items-center justify-between px-4 py-4 hover:bg-zinc-900/50"
                >
                  <div className="flex items-center gap-3">
                    <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center text-white font-medium", vendor.logo)}>
                      {vendor.icon === "apple" ? (
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                      ) : vendor.icon}
                    </div>
                    <span className="text-white font-medium">{vendor.name}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-white font-medium">{vendor.amount}</div>
                      <div className="text-zinc-500 text-xs">{vendor.transactions} Transaction{vendor.transactions !== 1 ? "s" : ""}</div>
                    </div>
                    <MoreVertical className="w-4 h-4 text-zinc-500" />
                  </div>
                </button>
                
                {expandedVendor === vendor.name && vendor.details && (
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
                        {vendor.details.map((detail, idx) => (
                          <tr key={idx} className="border-b border-zinc-800/30 hover:bg-zinc-800/30">
                            <td className="py-3 px-4 text-sm text-zinc-400">{detail.date}</td>
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-2">
                                <div className={cn("w-7 h-7 rounded flex items-center justify-center text-white text-xs", vendor.logo)}>
                                  {vendor.icon === "apple" ? (
                                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                                  ) : "A"}
                                </div>
                                <div>
                                  <div className="text-white text-sm">{detail.party}</div>
                                  <div className="text-zinc-500 text-xs truncate max-w-[200px]">{detail.detail}</div>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <div className={cn("w-6 h-6 rounded-full", detail.sourceIcon === "yellow" ? "bg-yellow-500" : "bg-zinc-700")} />
                            </td>
                            <td className="py-3 px-4 text-sm text-zinc-300">{detail.category}</td>
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
