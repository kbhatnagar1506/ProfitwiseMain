"use client"

import { ChevronLeft, ChevronRight, Calendar, Edit3, AlertTriangle, Plus, Settings, Users, Plane, Home as HomeIcon, DollarSign } from "lucide-react"

const expenseChanges = [
  { amount: "$21,243.19", vendor: "Gusto", color: "bg-orange-500" },
  { amount: "$4,500.00", vendor: "Google Cloud Platform", color: "bg-blue-500" },
  { amount: "$2,750.00", vendor: "Midwest Insurance Brokers", color: "bg-indigo-600" },
  { amount: "$2,228.27", vendor: "UnitedHealthcare", color: "bg-blue-700" },
]

const revenueChanges = [
  { amount: "$30,000.00", vendor: "Luna Rodriguez", color: "bg-indigo-600" },
  { amount: "$18,000.00", vendor: "Alex Petrov", color: "bg-yellow-500" },
  { amount: "$16,200.00", vendor: "Olivia Martinez", color: "bg-teal-500" },
  { amount: "$15,079.98", vendor: "Carson Lee", color: "bg-green-500" },
]

const topExpenseCategories = [
  { icon: Users, name: "Salaries", amount: "$20,728", change: "-$20,728" },
  { icon: Plane, name: "Airfare", amount: "$2,518", change: "-$140" },
  { icon: HomeIcon, name: "Lodging", amount: "$2,500", change: "-$1,740", hasSettings: true },
  { icon: Users, name: "Employer Payroll Taxes", amount: "$1,639", change: "-$1,657" },
  { icon: Users, name: "Employee Benefits", amount: "$1,085", change: "-$1,085" },
]

export function HomePage() {
  return (
    <div className="flex-1 flex flex-col bg-black overflow-auto">
      {/* Blue Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-500 px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-white">
            <HomeIcon className="w-5 h-5" />
            <span className="text-lg font-semibold">Home</span>
          </div>
          <div className="flex items-center gap-3">
            <button className="flex items-center gap-2 bg-white/20 hover:bg-white/30 text-white px-3 py-1.5 rounded-lg text-sm">
              Agents
              <ChevronRight className="w-4 h-4 rotate-90" />
            </button>
            <div className="flex items-center gap-2 bg-white/20 rounded-lg px-3 py-1.5">
              <span className="text-white/70 text-sm">Search Rob&apos;s Demo Client...</span>
              <kbd className="text-white/50 text-xs">⌘K</kbd>
            </div>
          </div>
        </div>
        
        {/* Tabs */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-white/20 rounded-lg p-1">
            <button className="px-4 py-1.5 bg-white/30 rounded-md text-white text-sm font-medium">Overview</button>
            <button className="px-4 py-1.5 text-white/80 text-sm hover:text-white">Expenses</button>
            <button className="px-4 py-1.5 text-white/80 text-sm hover:text-white">Revenue</button>
          </div>
          <button className="w-8 h-8 flex items-center justify-center bg-white/20 rounded-lg text-white hover:bg-white/30">
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Sub Header */}
      <div className="bg-gradient-to-r from-blue-500 to-blue-400 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button className="text-white/80 hover:text-white">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button className="flex items-center gap-2 bg-white/20 rounded-lg px-3 py-1.5 text-white text-sm">
            <Calendar className="w-4 h-4" />
            September 2025
          </button>
          <button className="text-white/80 hover:text-white">
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
        <button className="flex items-center gap-2 text-white text-sm hover:bg-white/10 px-3 py-1.5 rounded-lg">
          <Edit3 className="w-4 h-4" />
          Edit
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-6 space-y-6 overflow-auto">
        {/* Analysis Cards */}
        <div className="grid grid-cols-2 gap-6">
          {/* Expenses Analysis */}
          <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <h2 className="text-xl font-semibold text-white mb-1">Expenses Analysis</h2>
            <p className="text-zinc-500 text-sm mb-4">September 2025</p>
            
            <div className="flex items-center gap-2 text-zinc-400 text-sm mb-4">
              <AlertTriangle className="w-4 h-4" />
              <span>This month is in-flight so insights may change</span>
            </div>
            
            <p className="text-white mb-4">
              You spent <span className="text-green-400 font-semibold">52% ($33k)</span> less on{" "}
              <span className="text-blue-400">Operating Expenses</span> in September compared to the prior month.
            </p>
            
            <p className="text-zinc-400 text-sm mb-2">Notable changes include:</p>
            <ol className="space-y-2">
              {expenseChanges.map((item, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span className="text-zinc-500">{i + 1}.</span>
                  <span className="text-white">a</span>
                  <span className="text-orange-400 font-medium">{item.amount}</span>
                  <span className="text-white">decrease with</span>
                  <span className={`w-5 h-5 ${item.color} rounded flex items-center justify-center text-white text-xs font-bold`}>
                    {item.vendor.charAt(0)}
                  </span>
                  <span className="text-white font-medium">{item.vendor}</span>
                </li>
              ))}
            </ol>
          </div>

          {/* Revenue Analysis */}
          <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <h2 className="text-xl font-semibold text-white mb-1">Revenue Analysis</h2>
            <p className="text-zinc-500 text-sm mb-4">September 2025</p>
            
            <div className="flex items-center gap-2 text-zinc-400 text-sm mb-4">
              <AlertTriangle className="w-4 h-4" />
              <span>This month is in-flight so insights may change</span>
            </div>
            
            <p className="text-white mb-4">
              You earned <span className="text-green-400 font-semibold">73% ($153k)</span> less from{" "}
              <span className="text-purple-400">Revenue</span> in September compared to the prior month.
            </p>
            
            <p className="text-zinc-400 text-sm mb-2">Notable changes include:</p>
            <ol className="space-y-2">
              {revenueChanges.map((item, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span className="text-zinc-500">{i + 1}.</span>
                  <span className="text-white">a</span>
                  <span className="text-orange-400 font-medium">{item.amount}</span>
                  <span className="text-white">decrease with</span>
                  <span className={`w-5 h-5 ${item.color} rounded flex items-center justify-center text-white text-xs font-bold`}>
                    {item.vendor.charAt(0)}
                  </span>
                  <span className="text-white font-medium">{item.vendor}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        {/* Total Cash Chart */}
        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold text-white">Total Cash</h2>
                <span className="w-4 h-4 rounded-full bg-zinc-700 flex items-center justify-center text-zinc-400 text-xs">?</span>
              </div>
              <p className="text-zinc-500 text-sm">as of Today</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-semibold text-white">$1,219,308.71</p>
              <p className="text-red-400 text-sm">-3%</p>
            </div>
          </div>
          
          {/* Chart Area */}
          <div className="h-48 relative">
            <div className="absolute left-0 top-0 bottom-0 flex flex-col justify-between text-xs text-zinc-500 pr-4">
              <span>$1.2M</span>
              <span>$1M</span>
              <span>$800K</span>
              <span>$600K</span>
              <span>$400K</span>
              <span>$200K</span>
              <span>$0</span>
            </div>
            <div className="ml-12 h-full bg-gradient-to-b from-emerald-400/30 to-emerald-400/5 rounded-lg relative">
              <div className="absolute top-4 left-0 right-0 h-0.5 bg-emerald-400/50" />
              <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
                <path
                  d="M0,20 Q100,20 200,25 T400,20 T600,15 T800,30 T1000,10"
                  fill="none"
                  stroke="#34d399"
                  strokeWidth="2"
                />
              </svg>
            </div>
            <div className="ml-12 flex justify-between text-xs text-zinc-500 mt-2">
              <span>OCT<br/>2024</span>
              <span>NOV</span>
              <span>DEC</span>
              <span>JAN<br/>2025</span>
              <span>FEB</span>
              <span>MAR</span>
              <span>APR</span>
              <span>MAY</span>
              <span>JUN</span>
              <span>JUL</span>
              <span>AUG</span>
              <span>SEP</span>
            </div>
          </div>
        </div>

        {/* Metric Cards Row */}
        <div className="grid grid-cols-3 gap-6">
          {/* Gross Income */}
          <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold text-white">Gross Income</h3>
                <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-xs rounded">CASH</span>
              </div>
              <p className="text-xl font-semibold text-white">$55,954.96</p>
            </div>
            <div className="flex items-center justify-between mb-4">
              <p className="text-zinc-500 text-sm">as of Today</p>
              <p className="text-red-400 text-sm">-73%</p>
            </div>
            <div className="h-24 flex items-end gap-1">
              {[40, 55, 60, 65, 80, 95, 120, 140, 180, 220, 85, 50].map((h, i) => (
                <div key={i} className="flex-1 bg-zinc-600 rounded-t" style={{ height: `${h * 0.4}%` }} />
              ))}
            </div>
            <div className="flex justify-between text-xs text-zinc-500 mt-2">
              <span>NOV<br/>&apos;24</span>
              <span>JAN<br/>&apos;25</span>
              <span>MAR</span>
              <span>MAY</span>
              <span>JUL</span>
              <span>SEP</span>
            </div>
          </div>

          {/* Net Burn */}
          <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold text-white">Net Burn</h3>
                <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-xs rounded">CASH</span>
              </div>
              <p className="text-xl font-semibold text-white">-$37,345.38</p>
            </div>
            <div className="flex items-center justify-between mb-4">
              <p className="text-zinc-500 text-sm">as of Today</p>
              <p className="text-emerald-400 text-sm">+127%</p>
            </div>
            <div className="h-24 flex items-center gap-1">
              {[10, 15, 12, 8, 5, -20, -15, -10, 70, 80, -30, -25].map((h, i) => (
                <div 
                  key={i} 
                  className={`flex-1 rounded ${h >= 0 ? 'bg-zinc-600' : 'bg-orange-500'}`}
                  style={{ 
                    height: `${Math.abs(h) * 0.8}%`,
                    marginTop: h < 0 ? '50%' : undefined,
                    marginBottom: h >= 0 ? '50%' : undefined,
                  }} 
                />
              ))}
            </div>
            <div className="flex justify-between text-xs text-zinc-500 mt-2">
              <span>NOV<br/>&apos;24</span>
              <span>JAN<br/>&apos;25</span>
              <span>MAR</span>
              <span>MAY</span>
              <span>JUL</span>
              <span>SEP</span>
            </div>
          </div>

          {/* Live Runway */}
          <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-semibold text-white">Live Runway</h3>
              <div className="flex items-center gap-2">
                <span className="text-emerald-400 font-semibold">Profitable!</span>
                <Settings className="w-4 h-4 text-zinc-500" />
              </div>
            </div>
            <p className="text-zinc-500 text-sm mb-4">as of Today</p>
            <div className="h-24 relative">
              <div className="absolute left-0 top-0 bottom-0 flex flex-col justify-between text-xs text-zinc-500">
                <span>$2M</span>
                <span>$1.5M</span>
                <span>$1M</span>
                <span>$500K</span>
                <span>$0</span>
              </div>
              <div className="ml-8 h-full bg-gradient-to-t from-emerald-400/10 to-emerald-400/30 rounded relative overflow-hidden">
                <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
                  <path
                    d="M0,80 Q50,75 100,60 T200,50 T300,30 T400,20"
                    fill="none"
                    stroke="#34d399"
                    strokeWidth="2"
                    strokeDasharray="4,2"
                  />
                </svg>
              </div>
            </div>
            <div className="flex justify-between text-xs text-zinc-500 mt-2 ml-8">
              <span>JAN<br/>&apos;25</span>
              <span>JUL</span>
              <span>JAN</span>
              <span>JUL</span>
            </div>
          </div>
        </div>

        {/* Cash Flow & Top Expense Categories */}
        <div className="grid grid-cols-2 gap-6">
          {/* Cash Flow */}
          <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold text-white">Cash Flow</h3>
                <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-xs rounded">CASH</span>
              </div>
              <p className="text-xl font-semibold text-white">$1,219,308.71</p>
            </div>
            <div className="flex items-center justify-between mb-4">
              <p className="text-zinc-500 text-sm">as of Today</p>
              <p className="text-red-400 text-sm">-3%</p>
            </div>
            <div className="h-40 flex items-end gap-1 relative">
              {/* Bars */}
              {[
                { in: 30, out: 40 },
                { in: 35, out: 45 },
                { in: 25, out: 35 },
                { in: 40, out: 30 },
                { in: 50, out: 35 },
                { in: 45, out: 40 },
                { in: 55, out: 45 },
                { in: 65, out: 50 },
                { in: 60, out: 55 },
                { in: 70, out: 45 },
                { in: 80, out: 35 },
                { in: 55, out: 60 },
              ].map((item, i) => (
                <div key={i} className="flex-1 flex flex-col gap-0.5">
                  <div className="bg-emerald-400 rounded-t" style={{ height: `${item.in}%` }} />
                  <div className="bg-orange-400 rounded-b" style={{ height: `${item.out * 0.5}%` }} />
                </div>
              ))}
              {/* Line overlay */}
              <svg className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="none">
                <path
                  d="M20,120 Q60,115 100,110 T200,100 T300,90 T400,70 T500,50"
                  fill="none"
                  stroke="#8b5cf6"
                  strokeWidth="2"
                />
              </svg>
            </div>
            <div className="flex justify-between text-xs text-zinc-500 mt-2">
              <span>OCT<br/>2024</span>
              <span>NOV</span>
              <span>DEC</span>
              <span>JAN<br/>2025</span>
              <span>FEB</span>
              <span>MAR</span>
              <span>APR</span>
              <span>MAY</span>
              <span>JUN</span>
              <span>JUL</span>
              <span>AUG</span>
              <span>SEP</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-500 mt-2 justify-end">
              <span className="text-zinc-300">$1.2M</span>
              <span>$1M</span>
              <span>$800K</span>
              <span>$600K</span>
              <span>$400K</span>
              <span>$200K</span>
              <span>$0</span>
            </div>
          </div>

          {/* Top Expense Categories */}
          <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <h3 className="text-lg font-semibold text-white mb-1">Top Expense Categories</h3>
            <p className="text-zinc-500 text-sm mb-4">September 2025</p>
            
            <div className="space-y-3">
              {topExpenseCategories.map((cat, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-zinc-800 last:border-0">
                  <div className="flex items-center gap-3">
                    <cat.icon className="w-5 h-5 text-zinc-500" />
                    <span className="text-white">{cat.name}</span>
                    {cat.hasSettings && <Settings className="w-4 h-4 text-zinc-600" />}
                  </div>
                  <div className="text-right">
                    <p className="text-white font-medium">{cat.amount}</p>
                    <p className="text-zinc-500 text-sm">{cat.change}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
