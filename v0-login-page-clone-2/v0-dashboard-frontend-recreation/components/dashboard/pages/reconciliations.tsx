"use client"

import { ChevronLeft, ChevronRight, Pencil, Plus, ArrowUpDown, Check, Clock, FileText, Building2, CreditCard, Download } from "lucide-react"
import { cn } from "@/lib/utils"

const stats = [
  { value: "0", label: "No Activity", bgColor: "bg-zinc-800" },
  { value: "2", label: "Not Started for October", bgColor: "bg-gradient-to-br from-cyan-500/30 to-blue-500/30", icon: Clock },
  { value: "1", label: "Drafts for October", bgColor: "bg-gradient-to-br from-teal-500/30 to-cyan-500/30", icon: Pencil },
  { value: "1", label: "Finalized for October", fraction: "/3", bgColor: "bg-gradient-to-br from-teal-500/30 to-emerald-500/30", icon: Check },
]

const months = ["Dec", "Jan", "Feb", "Mar", "April", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]

const accounts = [
  {
    name: "Pasadena Area Schools Credit Union",
    icon: Building2,
    months: ["complete", "complete", "complete", "complete", "complete", "complete", "complete", "complete", "complete", "current", "pending", "pending"],
    currentMonth: "September 2025",
    action: "Reconciling..."
  },
  {
    name: "Chase Sapphire (4184)",
    icon: CreditCard,
    months: ["complete", "pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending"],
    currentMonth: "October 2025",
    action: "Add Statement"
  },
  {
    name: "Chase Checking",
    icon: CreditCard,
    months: ["pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending"],
    currentMonth: "October 2025",
    action: "Finalize..."
  },
]

export function ReconciliationsPage() {
  return (
    <div className="flex-1 flex flex-col bg-black">
      {/* Blue Header */}
      <div className="bg-gradient-to-br from-teal-500 via-cyan-500 to-blue-500 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button className="p-1 hover:bg-white/10 rounded">
              <ChevronLeft className="w-5 h-5 text-white" />
            </button>
            <button className="flex items-center gap-2 bg-white/20 hover:bg-white/30 rounded-lg px-3 py-1.5 text-white text-sm">
              <Pencil className="w-4 h-4" />
              Q4 2025
            </button>
            <button className="p-1 hover:bg-white/10 rounded">
              <ChevronRight className="w-5 h-5 text-white" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-2 bg-teal-600 hover:bg-teal-500 text-white px-4 py-2 rounded-lg text-sm font-medium">
              <Plus className="w-4 h-4" />
              New Reconciliation
            </button>
            <button className="p-2 hover:bg-white/10 rounded text-white">
              <ArrowUpDown className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="bg-gradient-to-r from-cyan-500/20 via-teal-500/10 to-blue-500/20 px-6 py-4">
        <div className="grid grid-cols-4 gap-4">
          {stats.map((stat, idx) => (
            <div key={idx} className={cn("rounded-xl p-4", stat.bgColor)}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-4xl font-bold text-white">
                    {stat.value}
                    {stat.fraction && <span className="text-zinc-400 text-lg">{stat.fraction}</span>}
                  </div>
                  <div className="text-zinc-400 text-sm mt-1">{stat.label}</div>
                </div>
                {stat.icon && (
                  <stat.icon className="w-6 h-6 text-teal-400" />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div className="flex-1 p-6 overflow-auto">
        <div className="space-y-6">
          {accounts.map((account, idx) => (
            <div key={idx} className="bg-zinc-900 rounded-xl p-4">
              <div className="flex items-center gap-4 mb-4">
                <div className="flex items-center gap-2">
                  <account.icon className="w-5 h-5 text-blue-400" />
                  <span className="text-white font-medium">{account.name}</span>
                </div>
              </div>

              {/* Month Timeline */}
              <div className="flex items-center gap-2">
                <div className="w-24" />
                {months.map((month, mIdx) => (
                  <div key={mIdx} className="flex-1 text-center text-xs text-zinc-500">
                    {month}
                  </div>
                ))}
                <div className="w-32" />
              </div>
              
              <div className="flex items-center gap-2 mt-2">
                <div className="w-24" />
                <div className="flex-1 flex items-center">
                  {months.map((_, mIdx) => (
                    <div key={mIdx} className="flex-1 flex items-center justify-center">
                      <div className={cn(
                        "w-6 h-6 rounded-full flex items-center justify-center border-2",
                        account.months[mIdx] === "complete" 
                          ? "bg-teal-500 border-teal-500" 
                          : account.months[mIdx] === "current"
                          ? "bg-zinc-700 border-teal-400"
                          : "border-zinc-600 bg-transparent"
                      )}>
                        {account.months[mIdx] === "complete" && (
                          <Check className="w-3 h-3 text-white" />
                        )}
                      </div>
                      {mIdx < months.length - 1 && (
                        <div className={cn(
                          "flex-1 h-0.5",
                          account.months[mIdx] === "complete" && account.months[mIdx + 1] !== "pending"
                            ? "bg-teal-500"
                            : "bg-zinc-700"
                        )} />
                      )}
                    </div>
                  ))}
                </div>
                <div className="w-32 flex flex-col items-end gap-1">
                  <span className="text-zinc-400 text-xs">{account.currentMonth}</span>
                  <button className="text-teal-400 text-sm flex items-center gap-1 bg-zinc-800 px-2 py-1 rounded">
                    {account.action.includes("Reconciling") && <Clock className="w-3 h-3" />}
                    {account.action.includes("Add") && <Plus className="w-3 h-3" />}
                    {account.action.includes("Finalize") && <FileText className="w-3 h-3" />}
                    {account.action}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Popup Card (simulated) */}
        <div className="fixed right-8 top-1/2 -translate-y-1/2 bg-zinc-800 rounded-xl p-4 w-72 shadow-xl border border-zinc-700">
          <h4 className="text-white font-semibold text-center mb-4">August 2025</h4>
          
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-teal-500 flex items-center justify-center mt-0.5">
                <Check className="w-3 h-3 text-white" />
              </div>
              <div>
                <div className="text-white text-sm font-medium">Finalized by <span className="text-teal-400">by Jane S.</span></div>
                <div className="text-zinc-500 text-xs">August 16, 2025</div>
              </div>
            </div>
            
            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-zinc-600 flex items-center justify-center mt-0.5">
                <Pencil className="w-3 h-3 text-zinc-400" />
              </div>
              <div>
                <div className="text-white text-sm">Edited <span className="text-zinc-400">by Digits AI and Jane S.</span></div>
                <div className="text-zinc-500 text-xs">August 11, 2025</div>
              </div>
            </div>
            
            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-zinc-600 flex items-center justify-center mt-0.5">
                <Clock className="w-3 h-3 text-zinc-400" />
              </div>
              <div>
                <div className="text-white text-sm">Auto-Reconciliation Started <span className="text-zinc-400">by Digits AI</span></div>
                <div className="text-zinc-500 text-xs">August 10, 2025</div>
              </div>
            </div>
            
            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-zinc-600 flex items-center justify-center mt-0.5">
                <FileText className="w-3 h-3 text-zinc-400" />
              </div>
              <div>
                <div className="text-white text-sm">Statement Uploaded <span className="text-zinc-400">by Jane S</span></div>
                <div className="text-zinc-500 text-xs">August 5, 2025</div>
              </div>
            </div>
          </div>

          <button className="w-full mt-4 flex items-center justify-center gap-2 text-zinc-400 hover:text-white text-sm py-2 border border-zinc-700 rounded-lg">
            <Download className="w-4 h-4" />
            Download PDF
          </button>
        </div>
      </div>
    </div>
  )
}
