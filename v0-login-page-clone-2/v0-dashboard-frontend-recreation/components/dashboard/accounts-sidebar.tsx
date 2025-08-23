"use client"

import { useState } from "react"
import { Building2, CreditCard } from "lucide-react"
import { cn } from "@/lib/utils"

const bankAccounts = [
  { name: "Mercury Checking 1231", count: 7, icon: Building2 },
]

const creditCards = [
  { name: "Mercury Credit Card 1234", count: 4, icon: CreditCard },
  { name: "Ramp Card", count: 12, icon: CreditCard },
]

export function AccountsSidebar() {
  const [selectedAccount, setSelectedAccount] = useState("Mercury Checking 1231")

  return (
    <aside className="w-64 bg-black border-r border-zinc-800 py-4">
      {/* Bank Accounts Section */}
      <div className="px-4 mb-4">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-400 mb-2">
          <Building2 className="w-4 h-4 text-zinc-500" />
          Bank Accounts
        </div>
        <ul className="space-y-1">
          {bankAccounts.map((account) => (
            <li key={account.name}>
              <button
                onClick={() => setSelectedAccount(account.name)}
                className={cn(
                  "w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors",
                  selectedAccount === account.name
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-400 hover:bg-zinc-900/50 hover:text-white"
                )}
              >
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-zinc-500" />
                  <span className="truncate">{account.name}</span>
                </div>
                <span className="text-zinc-500 text-xs">{account.count}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Credit Cards Section */}
      <div className="px-4">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-400 mb-2">
          <CreditCard className="w-4 h-4 text-zinc-500" />
          Credit Cards
        </div>
        <ul className="space-y-1">
          {creditCards.map((card) => (
            <li key={card.name}>
              <button
                onClick={() => setSelectedAccount(card.name)}
                className={cn(
                  "w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors",
                  selectedAccount === card.name
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-400 hover:bg-zinc-900/50 hover:text-white"
                )}
              >
                <div className="flex items-center gap-2">
                  <CreditCard className="w-4 h-4 text-zinc-500" />
                  <span className="truncate">{card.name}</span>
                </div>
                <span className="text-zinc-500 text-xs">{card.count}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
