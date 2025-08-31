"use client"

import { ChevronLeft, ChevronRight, Calendar, Download, AlertTriangle, TrendingDown, Users, DollarSign, ChevronDown } from "lucide-react"

const tabs = ["Profit & Loss", "Balance Sheet", "Cash Flow", "AP Aging", "AR Aging"]

const expenseChanges = [
  { amount: "$40,377.75", vendor: "Gusto", color: "bg-amber-600" },
  { amount: "$5,300.00", vendor: "Fo...", color: "bg-zinc-600" },
  { amount: "$4,233.72", vendor: "Un...", color: "bg-blue-600" },
  { amount: "$1,890.00", vendor: "Air...", color: "bg-red-500" },
]

const revenueChanges = [
  { amount: "$30,000.00", customer: "Stephanie Wong", color: "bg-purple-500" },
]

export function FinancialsPage() {
  return (
    <div className="flex-1 flex flex-col bg-black">
      {/* Blue Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-500 px-6 py-4">
        <div className="flex items-center gap-4 mb-3">
          <div className="flex items-center gap-1">
            {tabs.map((tab, idx) => (
              <button 
                key={tab}
                className={`px-3 py-1.5 text-sm rounded-lg ${idx === 0 ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10'}`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button className="p-1 hover:bg-white/10 rounded">
              <ChevronLeft className="w-5 h-5 text-white" />
            </button>
            <button className="flex items-center gap-2 bg-white/20 hover:bg-white/30 rounded-lg px-3 py-1.5 text-white text-sm">
              <Calendar className="w-4 h-4" />
              December
            </button>
            <button className="p-1 hover:bg-white/10 rounded">
              <ChevronRight className="w-5 h-5 text-white" />
            </button>
          </div>
          <button className="flex items-center gap-2 bg-teal-500 hover:bg-teal-400 text-white px-4 py-2 rounded-lg text-sm font-medium">
            <Download className="w-4 h-4" />
            Download Financials
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-6 overflow-auto">
        {/* Analysis Cards */}
        <div className="grid grid-cols-2 gap-6 mb-8">
          {/* Expenses Analysis */}
          <div className="bg-zinc-900 rounded-xl p-6">
            <h3 className="text-xl font-semibold text-white mb-1">Expenses Analysis</h3>
            <p className="text-zinc-500 text-sm mb-4">as of Today</p>
            
            <div className="flex items-center gap-2 text-amber-400 text-sm mb-4">
              <AlertTriangle className="w-4 h-4" />
              This month is in-flight so insights may change
            </div>

            <p className="text-white mb-4">
              <span className="font-semibold">{"Tyler's Demo Client"}</span> spent{" "}
              <span className="text-teal-400">95%</span> (<span className="text-teal-400">$62K</span>) less on{" "}
              <span className="font-medium">Operating Expenses</span> in August compared to the prior month.
            </p>

            <p className="text-zinc-400 text-sm mb-2">Notable changes include:</p>
            <ul className="space-y-2">
              {expenseChanges.map((change, idx) => (
                <li key={idx} className="flex items-center gap-2 text-white">
                  <span className="text-zinc-500">{idx + 1}.</span>
                  <span>a <span className="text-teal-400">{change.amount}</span> decrease with</span>
                  <div className={`w-5 h-5 rounded ${change.color} flex items-center justify-center text-white text-xs`}>
                    {change.vendor[0]}
                  </div>
                  <span className="font-medium">{change.vendor}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Revenue Analysis */}
          <div className="bg-zinc-900 rounded-xl p-6">
            <h3 className="text-xl font-semibold text-white mb-1">Revenue Analysis</h3>
            <p className="text-zinc-500 text-sm mb-4">as of Today</p>
            
            <div className="flex items-center gap-2 text-amber-400 text-sm mb-4">
              <AlertTriangle className="w-4 h-4" />
              This month is in-flight so insights may change
            </div>

            <p className="text-white mb-4">
              <span className="font-semibold">{"Tyler's Demo Client"}</span> earned{" "}
              <span className="text-teal-400">59%</span> (<span className="text-teal-400">$91K</span>) less from{" "}
              <span className="font-medium">Revenue</span> in August compared to the prior month.
            </p>

            <div className="flex items-center justify-between mb-2">
              <p className="text-zinc-400 text-sm">Notable changes include:</p>
              <button className="text-zinc-500 text-sm">
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
            <ul className="space-y-2">
              {revenueChanges.map((change, idx) => (
                <li key={idx} className="flex items-center gap-2 text-white">
                  <span className="text-zinc-500">{idx + 1}.</span>
                  <span>a <span className="text-teal-400">{change.amount}</span> decrease with</span>
                  <div className={`w-5 h-5 rounded ${change.color} flex items-center justify-center text-white text-xs`}>
                    S
                  </div>
                  <span className="font-medium">{change.customer}</span>
                </li>
              ))}
            </ul>
            
            <div className="mt-4 flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-orange-500 flex items-center justify-center text-white text-xs">E</div>
              <span className="text-white">Emily Johnson</span>
              <div className="w-6 h-6 rounded bg-teal-500 flex items-center justify-center text-white text-xs">C</div>
              <span className="text-white">Chloe Thompson</span>
              <div className="w-6 h-6 rounded bg-green-500 flex items-center justify-center text-white text-xs">C</div>
              <span className="text-white">Cole Anderson</span>
            </div>
          </div>
        </div>

        {/* Profit & Loss */}
        <div className="bg-zinc-900 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xl font-semibold text-white">Profit & Loss</h3>
              <p className="text-zinc-500 text-sm">as of Today</p>
            </div>
            <div className="flex items-center gap-2">
              <button className="text-zinc-400 hover:text-white text-sm">Collapse</button>
              <button className="p-2 hover:bg-zinc-800 rounded text-zinc-400">
                <Download className="w-4 h-4" />
              </button>
              <span className="text-zinc-400">Download</span>
            </div>
          </div>

          {/* Search Results Popup (simulated) */}
          <div className="bg-zinc-800 rounded-xl p-4 mb-4 max-w-md">
            <div className="flex items-center justify-between mb-3">
              <span className="text-zinc-400 text-sm">Search Results</span>
              <button className="text-teal-400 text-sm flex items-center gap-1">
                See 45 more
              </button>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Users className="w-5 h-5 text-zinc-500" />
                  <span className="text-white">Payroll Expenses</span>
                </div>
                <div className="text-right">
                  <div className="text-white font-medium">$736,855.00</div>
                  <div className="text-zinc-500 text-xs">Last 12 Months</div>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-5 h-5 text-zinc-500" />
                  <span className="text-white">Payroll Fees</span>
                </div>
                <div className="text-right">
                  <div className="text-white font-medium">$147,000.50</div>
                  <div className="text-zinc-500 text-xs">Last 12 Months</div>
                </div>
              </div>
            </div>
          </div>

          {/* AI Chat */}
          <div className="bg-zinc-800 rounded-xl p-4 max-w-lg">
            <div className="flex items-start gap-3 mb-3">
              <div className="flex-1">
                <div className="flex justify-end mb-2">
                  <div className="bg-zinc-700 rounded-lg px-3 py-2 text-white text-sm">
                    What were my payroll expenses Q4 vs Q3?
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-teal-400 to-emerald-500 flex items-center justify-center">
                    <span className="text-white text-xs font-bold">D</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-white text-sm">
                      Your <span className="font-semibold">payroll expenses</span> were down 9.13% in Q4 at $168,364.99 vs $184,212.53 in Q3. Does that help?
                    </p>
                    <div className="flex items-center gap-2 mt-2 text-zinc-500">
                      <button className="hover:text-white">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                        </svg>
                      </button>
                      <button className="hover:text-white">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
