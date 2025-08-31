"use client"

import { Upload, Search, Grid, List, Filter, ArrowUpDown, FileText } from "lucide-react"

const documents = [
  {
    name: "Mercury Bank Statement (M...",
    type: "PDF",
    uploadedAt: "Uploaded today",
    preview: "statement"
  },
  {
    name: "Brex Bank Transactions (Ma...",
    type: "CSV",
    uploadedAt: "Uploaded today",
    preview: "csv"
  },
  {
    name: "Invoice-#INV-1047-AWS.pdf",
    type: "PDF",
    uploadedAt: "Uploaded today",
    preview: "invoice"
  }
]

export function DocumentsPage() {
  return (
    <div className="flex-1 flex flex-col bg-black">
      {/* Blue Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-500 px-6 py-4">
        <div className="flex items-center justify-end">
          <button className="flex items-center gap-2 bg-teal-500 hover:bg-teal-400 text-white px-4 py-2 rounded-lg text-sm font-medium">
            <Upload className="w-4 h-4" />
            Upload Document
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-6 overflow-auto">
        {/* Filter Bar */}
        <div className="flex items-center justify-between mb-6">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input 
              type="text"
              placeholder="Filter 3 documents..."
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white placeholder:text-zinc-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <button className="p-2 hover:bg-zinc-800 rounded-lg text-teal-400 bg-zinc-800">
              <Grid className="w-4 h-4" />
            </button>
            <button className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400">
              <List className="w-4 h-4" />
            </button>
            <button className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400">
              <Filter className="w-4 h-4" />
            </button>
            <button className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400">
              <ArrowUpDown className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Documents Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {documents.map((doc, index) => (
            <div key={index} className="bg-zinc-900 rounded-xl overflow-hidden hover:ring-2 hover:ring-zinc-700 transition-all cursor-pointer">
              {/* Preview */}
              <div className="h-48 bg-zinc-800 flex items-center justify-center relative">
                {doc.preview === "statement" && (
                  <div className="w-3/4 h-3/4 bg-white rounded-lg p-4 text-xs text-zinc-600">
                    <div className="text-zinc-800 font-medium mb-2">Mercury Bank - Checking Statement for May 2026</div>
                    <div className="text-zinc-500 text-[10px] mb-4">Opening Balance | Checking Account #</div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[9px]">
                        <span>May 1</span>
                        <span>Beginning Balance</span>
                        <span>$124,500.00</span>
                      </div>
                      <div className="h-px bg-zinc-200" />
                      <div className="flex justify-between text-[9px]">
                        <span>Transaction History</span>
                      </div>
                    </div>
                  </div>
                )}
                {doc.preview === "csv" && (
                  <div className="w-20 h-24 bg-indigo-100 rounded-lg flex items-center justify-center">
                    <div className="text-indigo-500 font-bold text-lg">CSV</div>
                  </div>
                )}
                {doc.preview === "invoice" && (
                  <div className="w-3/4 h-3/4 bg-white rounded-lg p-3 text-xs text-zinc-600">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="text-teal-500 font-bold text-sm">SmartStream</div>
                      <span className="text-zinc-400 text-[10px]">June 26, 2026</span>
                    </div>
                    <div className="text-lg font-bold text-zinc-800 mb-2">$23,400.00</div>
                    <div className="text-zinc-400 text-[10px] mb-1">Due August 1, 2026</div>
                    <div className="flex items-center gap-1 mb-2">
                      <div className="w-4 h-4 bg-teal-500 rounded-full" />
                      <span className="text-[10px] text-zinc-500">Pending</span>
                    </div>
                    <div className="space-y-1 text-[9px]">
                      <div className="flex justify-between">
                        <span>CloudService</span>
                        <span>$20,500</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Support</span>
                        <span>$2,500</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              
              {/* Info */}
              <div className="p-4">
                <div className="flex items-center gap-2">
                  <div className={`px-2 py-0.5 rounded text-xs font-medium ${doc.type === 'PDF' ? 'bg-red-500/20 text-red-400' : 'bg-green-500/20 text-green-400'}`}>
                    {doc.type}
                  </div>
                  <span className="text-white text-sm font-medium truncate">{doc.name}</span>
                </div>
                <p className="text-zinc-500 text-xs mt-1">{doc.uploadedAt}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
