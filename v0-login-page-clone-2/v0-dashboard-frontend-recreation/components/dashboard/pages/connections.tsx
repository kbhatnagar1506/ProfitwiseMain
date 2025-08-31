"use client"

import { Grid, Link2, Building2, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useState } from "react"

const connections = [
  {
    name: "Banks & Cards",
    description: "Connect 12,000+ financial institutions",
    icon: "bank",
    color: "bg-gradient-to-br from-orange-400 to-amber-500"
  },
  {
    name: "BILL",
    description: "Create and pay bills, send invoices, and manage expenses",
    icon: "bill",
    color: "bg-gradient-to-br from-orange-500 to-orange-600"
  },
  {
    name: "Gusto",
    description: "Payroll, benefits, and HR for modern companies",
    icon: "gusto",
    color: "bg-amber-600"
  },
  {
    name: "Ramp",
    description: "Easy-to-use cards, spend limits, approval flows, and more",
    icon: "ramp",
    color: "bg-yellow-400"
  },
  {
    name: "Stripe",
    description: "Online Payments Facilitator",
    icon: "stripe",
    color: "bg-indigo-500"
  }
]

export function ConnectionsPage() {
  const [activeTab, setActiveTab] = useState("all")
  
  return (
    <div className="flex-1 flex bg-black">
      {/* Connections Sidebar */}
      <div className="w-64 bg-gradient-to-b from-blue-600 to-blue-700 p-6">
        <h2 className="text-2xl font-bold text-white mb-8">Connections</h2>
        
        <nav className="space-y-2">
          <button 
            onClick={() => setActiveTab("all")}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
              activeTab === "all" 
                ? "bg-white/20 text-white" 
                : "text-white/70 hover:bg-white/10 hover:text-white"
            )}
          >
            <Grid className="w-5 h-5" />
            All Connections
          </button>
          <button 
            onClick={() => setActiveTab("my")}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
              activeTab === "my" 
                ? "bg-white/20 text-white" 
                : "text-white/70 hover:bg-white/10 hover:text-white"
            )}
          >
            <Link2 className="w-5 h-5" />
            My Connections
          </button>
        </nav>
      </div>

      {/* Connections List */}
      <div className="flex-1 bg-zinc-900 p-8">
        <h2 className="text-2xl font-bold text-white mb-6">All Connections</h2>
        
        <div className="space-y-4">
          {connections.map((connection, idx) => (
            <div key={idx} className="bg-zinc-800 rounded-xl p-4 flex items-center justify-between hover:bg-zinc-750 transition-colors">
              <div className="flex items-center gap-4">
                <button className="text-zinc-500 hover:text-white">
                  <ChevronRight className="w-4 h-4" />
                </button>
                <div className={cn("w-14 h-14 rounded-xl flex items-center justify-center", connection.color)}>
                  {connection.icon === "bank" && (
                    <div className="text-white">
                      <Building2 className="w-7 h-7" />
                    </div>
                  )}
                  {connection.icon === "bill" && (
                    <span className="text-white text-2xl font-bold">b</span>
                  )}
                  {connection.icon === "gusto" && (
                    <span className="text-white text-2xl font-bold">g</span>
                  )}
                  {connection.icon === "ramp" && (
                    <svg className="w-7 h-7 text-black" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M4 12l8-8v16l-8-8z" />
                    </svg>
                  )}
                  {connection.icon === "stripe" && (
                    <span className="text-white text-2xl font-bold">S</span>
                  )}
                </div>
                <div>
                  <h3 className="text-white font-semibold">{connection.name}</h3>
                  <p className="text-zinc-400 text-sm">{connection.description}</p>
                </div>
              </div>
              <button className="bg-teal-500 hover:bg-teal-400 text-white px-6 py-2 rounded-lg font-medium text-sm">
                Connect
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
