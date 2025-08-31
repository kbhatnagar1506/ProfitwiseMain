"use client"

import { ChevronLeft, ChevronRight, Calendar, Upload, FileText, Plus, Clock, CircleDollarSign, CheckCircle, CalendarDays } from "lucide-react"
import { cn } from "@/lib/utils"

const columns = [
  {
    id: "review",
    title: "In Review",
    icon: FileText,
    bills: []
  },
  {
    id: "pending",
    title: "Pending Approval",
    icon: Clock,
    bills: [
      { vendor: "Ruby Landscape M...", invoiceNo: "#INV 123458", amount: "$3,050.00", dueDate: "Sept 20", avatar: "A" }
    ],
    total: "$3,050.00"
  },
  {
    id: "awaiting",
    title: "Awaiting Payment",
    icon: CircleDollarSign,
    bills: [
      { vendor: "Google Cloud", invoiceNo: "#INV 123458", amount: "$1,456.75", dueDate: "Sept 20", avatar: "N" },
      { vendor: "Slack", invoiceNo: "#INV-1001", amount: "$2,400.00", dueDate: "Oct 02", avatar: "A" },
      { vendor: "Home Depot", invoiceNo: "#INV0004492", amount: "$1,600.00", dueDate: "Oct 01", avatar: "A" }
    ],
    total: "$5,456.75"
  },
  {
    id: "paid",
    title: "Scheduled & Paid",
    icon: CheckCircle,
    filterLabel: "Past 30 Days",
    bills: [
      { vendor: "Google Cloud", invoiceNo: "#INV-00153", amount: "$800.00", deliveredDate: "Aug 4", avatar: "A" }
    ],
    total: "$800.00"
  }
]

const vendorColors: Record<string, string> = {
  "Ruby Landscape M...": "bg-gradient-to-br from-blue-400 to-blue-600",
  "Google Cloud": "bg-gradient-to-br from-blue-400 via-red-400 to-yellow-400",
  "Slack": "bg-gradient-to-br from-purple-500 to-pink-500",
  "Home Depot": "bg-gradient-to-br from-orange-500 to-orange-600"
}

export function BillsPage() {
  return (
    <div className="flex-1 flex flex-col bg-black">
      {/* Blue Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-500 px-6 py-4">
        <div className="flex items-center gap-4 mb-3">
          <div className="flex items-center bg-white/20 rounded-lg overflow-hidden">
            <button className="px-4 py-1.5 text-white text-sm bg-white/20">Summary</button>
            <button className="px-4 py-1.5 text-white/70 text-sm hover:bg-white/10">Aging</button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button className="p-1 hover:bg-white/10 rounded">
              <ChevronLeft className="w-5 h-5 text-white" />
            </button>
            <button className="flex items-center gap-2 bg-white/20 hover:bg-white/30 rounded-lg px-3 py-1.5 text-white text-sm">
              <Calendar className="w-4 h-4" />
              August
            </button>
            <button className="p-1 hover:bg-white/10 rounded">
              <ChevronRight className="w-5 h-5 text-white" />
            </button>
          </div>
          <button className="flex items-center gap-2 bg-teal-500 hover:bg-teal-400 text-white px-4 py-2 rounded-lg text-sm font-medium">
            <Upload className="w-4 h-4" />
            Upload Bill
          </button>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex-1 p-6 overflow-auto">
        <div className="flex gap-4 h-full">
          {columns.map((column) => (
            <div key={column.id} className="flex-1 min-w-[260px] max-w-[300px]">
              {/* Column Header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2 text-zinc-400 text-sm">
                  <column.icon className="w-4 h-4" />
                  <span>{column.title}</span>
                </div>
                {column.filterLabel && (
                  <div className="flex items-center gap-1 text-zinc-500 text-xs">
                    <CalendarDays className="w-3 h-3" />
                    {column.filterLabel}
                  </div>
                )}
              </div>

              {/* Column Content */}
              <div className="bg-zinc-900/50 rounded-xl p-3 min-h-[400px]">
                {column.bills.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full py-16">
                    <div className="w-16 h-16 rounded-xl bg-zinc-800 flex items-center justify-center mb-4">
                      <FileText className="w-8 h-8 text-blue-400" />
                      <Plus className="w-4 h-4 text-blue-400 absolute translate-x-4 translate-y-4" />
                    </div>
                    <p className="text-blue-400 font-medium mb-4">Upload your bills</p>
                    <button className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-sm">
                      Browse
                    </button>
                    <p className="text-zinc-500 text-xs mt-2">or Drag & Drop</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {column.bills.map((bill, idx) => (
                      <div key={idx} className="bg-zinc-800 rounded-lg p-3">
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className={cn("w-8 h-8 rounded-lg", vendorColors[bill.vendor] || "bg-zinc-700")} />
                            <div>
                              <div className="text-white text-sm font-medium">{bill.vendor}</div>
                              <div className="text-zinc-500 text-xs">{bill.invoiceNo}</div>
                            </div>
                          </div>
                          <div className="text-white text-sm font-medium">{bill.amount}</div>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1 text-zinc-500 text-xs">
                            <CalendarDays className="w-3 h-3" />
                            {bill.dueDate ? `Due ${bill.dueDate}` : bill.deliveredDate ? `Delivered ${bill.deliveredDate}` : ""}
                          </div>
                          <div className={cn(
                            "w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-medium",
                            bill.avatar === "A" ? "bg-blue-500" : "bg-teal-500"
                          )}>
                            {bill.avatar}
                          </div>
                        </div>
                      </div>
                    ))}
                    {column.total && (
                      <div className="flex items-center justify-between pt-2 border-t border-zinc-700">
                        <span className="text-zinc-500 text-sm">Total</span>
                        <span className="text-white text-sm font-medium">{column.total}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
