"use client"

import {
  Home,
  Inbox,
  Building2,
  FileText,
  Receipt,
  Users,
  UserCircle,
  BarChart3,
  ClipboardList,
  BookOpen,
  RefreshCcw,
  FolderOpen,
  Link2,
} from "lucide-react"
import { cn } from "@/lib/utils"

const navItems = [
  { icon: Home, label: "Home" },
  { icon: Inbox, label: "Inbox" },
  { icon: Building2, label: "Banks & Cards" },
  { icon: Receipt, label: "Bills" },
  { icon: FileText, label: "Invoices" },
  { icon: Users, label: "Vendors" },
  { icon: UserCircle, label: "Customers" },
  { icon: BarChart3, label: "Financials" },
  { icon: ClipboardList, label: "Custom Reports" },
  { icon: BookOpen, label: "Ledger" },
  { icon: RefreshCcw, label: "Reconciliations" },
  { icon: FolderOpen, label: "Documents" },
  { icon: Link2, label: "Connections" },
]

interface SidebarProps {
  activePage: string
  setActivePage: (page: string) => void
}

export function Sidebar({ activePage, setActivePage }: SidebarProps) {
  return (
    <aside className="w-56 bg-black border-r border-zinc-800 flex flex-col py-4">
      <nav className="flex-1 px-3">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const isActive = item.label === activePage
            return (
              <li key={item.label}>
                <button
                  onClick={() => setActivePage(item.label)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                    isActive
                      ? "bg-teal-500/10 text-teal-400"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-white"
                  )}
                >
                  <item.icon className={cn("w-5 h-5", isActive ? "text-teal-400" : "text-zinc-500")} />
                  {item.label}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
    </aside>
  )
}
