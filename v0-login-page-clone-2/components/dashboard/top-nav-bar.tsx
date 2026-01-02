"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Bell, Search, LogOut, Settings, User } from "lucide-react"

interface TopNavBarProps {
  userName?: string
  userEmail?: string
}

export function TopNavBar({ userName = "John Doe", userEmail = "john@example.com" }: TopNavBarProps) {
  const router = useRouter()
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  const handleLogout = async () => {
    setIsLoggingOut(true)
    try {
      await fetch("/api/auth/logout", { method: "POST" })
      router.push("/")
    } catch (error) {
      console.error("Logout failed:", error)
      setIsLoggingOut(false)
    }
  }

  const initials = userName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()

  return (
    <header className="sticky top-0 z-50 bg-[#0a0a0a] h-16 shrink-0 border-b border-white/[0.06]">
      <div className="flex h-full items-center px-4 pt-1 gap-6">
        <Link href="/dashboard/home" className="flex items-center h-full flex-shrink-0 pl-1">
          <img src="/profitwise-logo.png" alt="ProfitWise" className="h-12 w-auto object-contain" />
        </Link>

        <div className="flex-1 max-w-lg hidden md:flex">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-400" />
            <input
              type="text"
              placeholder="Search transactions, accounts, reports..."
              className="w-full h-8 pl-9 pr-3 text-[13px] bg-white/[0.07] text-white placeholder:text-neutral-500 rounded-md border border-white/[0.08] outline-none focus:border-white/20 focus:bg-white/[0.1] transition-all"
            />
          </div>
        </div>

        <div className="flex items-center gap-1 ml-auto flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="relative h-8 w-8 hover:bg-white/[0.06] text-neutral-400 hover:text-white transition-colors"
            title="Notifications"
          >
            <Bell className="h-4 w-4" />
            <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 bg-red-500 rounded-full" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-white/[0.06]">
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="bg-indigo-600 text-white text-[11px] font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <div className="flex flex-col space-y-1 p-2">
                <p className="text-sm font-medium text-foreground">{userName}</p>
                <p className="text-xs text-muted-foreground">{userEmail}</p>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/dashboard/settings" className="cursor-pointer">
                  <Settings className="mr-2 h-4 w-4" />
                  <span>Settings</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="#" className="cursor-pointer">
                  <User className="mr-2 h-4 w-4" />
                  <span>Profile</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleLogout} disabled={isLoggingOut}>
                <LogOut className="mr-2 h-4 w-4" />
                <span>{isLoggingOut ? "Logging out..." : "Logout"}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}
