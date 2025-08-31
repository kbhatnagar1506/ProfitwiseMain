"use client"

import { CalendarDays, Plus } from "lucide-react"

export function AskDigits() {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
      <div className="flex items-center gap-4 bg-zinc-900 border border-zinc-700 rounded-full shadow-lg shadow-black/40 px-6 py-3 min-w-[500px]">
        <div className="w-9 h-9 bg-gradient-to-br from-teal-400 to-emerald-500 rounded-full flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </svg>
        </div>
        <span className="text-zinc-400 text-sm flex-1">Ask Digits...</span>
        <div className="flex items-center gap-1">
          <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
        </div>
        <button className="text-zinc-500 hover:text-white">
          <CalendarDays className="w-5 h-5" />
        </button>
        <button className="text-zinc-500 hover:text-white">
          <Plus className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
