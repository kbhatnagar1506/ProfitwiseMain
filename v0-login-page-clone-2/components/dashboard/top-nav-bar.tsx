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
    <header className="sticky top-0 z-50 bg-[#0c0c0c] h-14 shrink-0 border-b border-white/[0.06]">
      <div className="flex h-full items-center px-5 gap-4">
        <Link href="/dashboard/home" className="flex items-center h-full flex-shrink-0">
          <img src="/profitwise-logo.png" alt="ProfitWise" className="h-10 w-auto object-contain" />
        </Link>

        <div className="flex-1 flex justify-center">
          <div className="relative w-full max-w-md hidden md:block">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-500" />
            <input
              type="text"
              placeholder="Search transactions, accounts, reports..."
              className="w-full h-8 pl-9 pr-3 text-[13px] bg-white/[0.05] text-white placeholder:text-neutral-600 rounded-lg border border-white/[0.06] outline-none focus:border-white/15 focus:bg-white/[0.08] transition-all"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="relative h-8 w-8 hover:bg-white/[0.06] text-neutral-500 hover:text-neutral-300 transition-colors"
            title="Notifications"
          >
            <Bell className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-white/[0.06]">
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="bg-indigo-600 text-white text-[10px] font-semibold">
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
