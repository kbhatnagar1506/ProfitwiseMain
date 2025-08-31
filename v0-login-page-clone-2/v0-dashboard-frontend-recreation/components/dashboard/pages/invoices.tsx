"use client"

import { ChevronLeft, ChevronRight, Calendar, Plus, ChevronDown, MoreVertical, FileText, Send, Clock, CheckCircle, CalendarDays, DollarSign } from "lucide-react"
import { cn } from "@/lib/utils"

const columns = [
  {
    id: "draft",
    title: "Draft",
    icon: FileText,
    invoices: []
  },
  {
    id: "sent",
    title: "Sent",
    icon: Send,
    invoices: [
      { customer: "Emily Johnson", invoiceNo: "#INV-1006", amount: "$5,000.00", dueDate: "Jan 14", color: "bg-orange-500" }
    ],
    total: "$5,000.00"
  },
  {
    id: "overdue",
    title: "Overdue",
    icon: Clock,
    invoices: [
      { customer: "Digits", invoiceNo: "#INV-1005", amount: "$10,000.00", dueDate: "Mar 2", color: "bg-purple-500" },
      { customer: "Emily Johnson", invoiceNo: "#INV-1004", amount: "$20,000.00", dueDate: "Oct 31", color: "bg-orange-500" },
      { customer: "Acme", invoiceNo: "#INV-1003", amount: "$10,000.00", dueDate: "Aug 31", color: "bg-teal-500", badge: "Manual Send" }
    ],
    total: "$40,000.00"
  },
  {
    id: "paid",
    title: "Paid",
    icon: CheckCircle,
    invoices: [
      { customer: "Acme", invoiceNo: "#INV-1001", amount: "$30,000.00", paidDate: "May 22", color: "bg-teal-500" }
    ],
    total: "$30,000.00"
  }
]

export function InvoicesPage() {
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
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-2 bg-teal-500 hover:bg-teal-400 text-white px-4 py-2 rounded-lg text-sm font-medium">
              <Plus className="w-4 h-4" />
              New Invoice
            </button>
            <button className="text-white/80 hover:text-white">
              <MoreVertical className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex-1 p-6 overflow-auto">
        <div className="flex gap-4 h-full">
          {columns.map((column) => (
            <div key={column.id} className="flex-1 min-w-[260px] max-w-[300px]">
              {/* Column Header */}
              <div className="flex items-center gap-2 text-zinc-400 text-sm mb-4">
                <column.icon className="w-4 h-4" />
                <span>{column.title}</span>
              </div>

              {/* Column Content */}
              <div className="bg-zinc-900/50 rounded-xl p-3 min-h-[400px]">
                {column.invoices.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full py-16">
                    <div className="w-16 h-16 rounded-xl bg-zinc-800 flex items-center justify-center mb-4">
                      <FileText className="w-8 h-8 text-blue-400" />
                      <DollarSign className="w-4 h-4 text-blue-400 absolute translate-x-3 translate-y-3" />
                    </div>
                    <p className="text-blue-400 font-medium mb-4">{"Let's create an invoice!"}</p>
                    <button className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-sm">
                      New Invoice
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {column.invoices.map((invoice, idx) => (
                      <div key={idx} className="bg-zinc-800 rounded-lg p-3">
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className={cn("w-7 h-7 rounded flex items-center justify-center text-white text-xs font-bold", invoice.color)}>
                              {invoice.customer[0]}
                            </div>
                            <div>
                              <div className="text-white text-sm font-medium">{invoice.customer}</div>
                              <div className="text-zinc-500 text-xs">{invoice.invoiceNo}</div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-white text-sm font-medium">{invoice.amount}</div>
                            {invoice.badge && (
                              <span className="text-xs bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded">{invoice.badge}</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 text-zinc-500 text-xs">
                          {invoice.paidDate ? (
                            <>
                              <CheckCircle className="w-3 h-3" />
                              Marked as Paid {invoice.paidDate}
                            </>
                          ) : (
                            <>
                              <CalendarDays className="w-3 h-3" />
                              Due {invoice.dueDate}
                            </>
                          )}
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
