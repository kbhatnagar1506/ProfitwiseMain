"use client"

import { ChevronLeft, ChevronRight, Calendar, Plus, ChevronDown, MoreVertical, MessageSquare, UserPlus } from "lucide-react"

const reports = [
  {
    month: "March",
    type: "Monthly Report",
    publisher: "Tyler O.",
    comments: 2,
    image: "https://images.unsplash.com/photo-1511497584788-876760111969?w=400&h=300&fit=crop",
    gradient: "from-slate-700 to-slate-900"
  },
  {
    month: "April",
    type: "Monthly Report", 
    publisher: "Dakota M.",
    comments: 2,
    image: "https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=400&h=300&fit=crop",
    gradient: "from-amber-700 to-amber-900"
  },
  {
    month: "May",
    type: "Investor Report",
    publisher: "Jessie D.",
    comments: 0,
    image: "https://images.unsplash.com/photo-1505118380757-91f5f5632de0?w=400&h=300&fit=crop",
    gradient: "from-teal-700 to-teal-900"
  }
]

export function CustomReportsPage() {
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
              August
            </button>
            <button className="p-1 hover:bg-white/10 rounded">
              <ChevronRight className="w-5 h-5 text-white" />
            </button>
          </div>
          <button className="flex items-center gap-2 bg-teal-500 hover:bg-teal-400 text-white px-4 py-2 rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" />
            New Report
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Reports Grid */}
      <div className="flex-1 p-6 overflow-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {reports.map((report, index) => (
            <div 
              key={index}
              className="relative rounded-xl overflow-hidden h-80 group cursor-pointer"
            >
              <img 
                src={report.image} 
                alt={report.month}
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className={`absolute inset-0 bg-gradient-to-b ${report.gradient} opacity-60`} />
              
              {/* Card Content */}
              <div className="absolute inset-0 p-5 flex flex-col">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-2xl font-bold text-white">{report.month}</h3>
                    <p className="text-white/80 text-sm">{report.type}</p>
                    <p className="text-white/60 text-xs mt-1">Published by {report.publisher}</p>
                  </div>
                  <button className="text-white/60 hover:text-white">
                    <MoreVertical className="w-5 h-5" />
                  </button>
                </div>
                
                <div className="mt-auto flex items-center gap-3">
                  {report.comments > 0 && (
                    <div className="flex items-center gap-1 bg-white/20 rounded-full px-2 py-1">
                      <MessageSquare className="w-4 h-4 text-white" />
                      <span className="text-white text-xs">{report.comments}</span>
                    </div>
                  )}
                  <div className="flex -space-x-2">
                    <div className="w-7 h-7 rounded-full bg-teal-500 border-2 border-white/20" />
                    <div className="w-7 h-7 rounded-full bg-amber-500 border-2 border-white/20 flex items-center justify-center">
                      <UserPlus className="w-3 h-3 text-white" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
