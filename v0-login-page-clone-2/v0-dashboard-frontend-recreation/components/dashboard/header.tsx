"use client"

import { Search, Bell, ChevronDown,Building2, Receipt, FileText, Users, UserCircle, BarChart3, ClipboardList, BookOpen, RefreshCcw, FolderOpen, Link2 } from "lucide-react"

const pageIcons: Record<string, React.ElementType> = {
  "Banks & Cards": Building2,
  "Bills": Receipt,
  "Invoices": FileText,
  "Vendors": Users,
  "Customers": UserCircle,
  "Financials": BarChart3,
  "Custom Reports": ClipboardList,
  "Ledger": BookOpen,
  "Reconciliations": RefreshCcw,
  "Documents": FolderOpen,
  "Connections": Link2,
}

interface HeaderProps {
  activePage?: string
}

export function Header({ activePage = "Banks & Cards" }: HeaderProps) {
  const PageIcon = pageIcons[activePage] || Building2

  return (
    <header className="h-14 bg-black border-b border-zinc-800 flex items-center justify-between px-4">
      {/* Logo */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-teal-400 to-emerald-500 rounded-lg flex items-center justify-center">
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
            </svg>
          </div>
          <span className="text-white font-semibold text-lg">Digits</span>
        </div>
        
        {/* Page Title - shown in blue gradient area on actual pages */}
        <div className="hidden md:flex items-center gap-2 bg-gradient-to-r from-blue-600 to-blue-500 rounded-lg px-3 py-1.5">
          <PageIcon className="w-4 h-4 text-white" />
          <span className="text-white text-sm font-medium">{activePage}</span>
        </div>
      </div>

      {/* Search */}
      <div className="flex-1 max-w-xl mx-8">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Search transactions, accounts, reports..."
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-teal-500/50 focus:border-teal-500"
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 text-xs bg-zinc-800 text-zinc-400 rounded">⌘</kbd>
            <kbd className="px-1.5 py-0.5 text-xs bg-zinc-800 text-zinc-400 rounded">K</kbd>
          </div>
        </div>
      </div>

      {/* Account */}
      <div className="flex items-center gap-4">
        <button className="relative text-zinc-400 hover:text-white">
          <Bell className="w-5 h-5" />
          <span className="absolute -top-1 -right-1 w-2 h-2 bg-teal-500 rounded-full" />
        </button>
        <button className="flex items-center gap-2 hover:bg-zinc-900 rounded-lg px-2 py-1.5 transition-colors">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center text-white text-sm font-medium">
            JD
          </div>
          <div className="text-left hidden sm:block">
            <div className="text-sm text-white font-medium">John Doe</div>
            <div className="text-xs text-zinc-500">Admin</div>
          </div>
          <ChevronDown className="w-4 h-4 text-zinc-400" />
        </button>
      </div>
    </header>
  )
}
