"use client"

import Link from "next/link"
import { bottomBarItems } from "@/lib/dashboard-navigation"
import { cn } from "@/lib/utils"

interface BottomBarProps {
  isCollapsed: boolean
}

export function BottomBar({ isCollapsed }: BottomBarProps) {
  return (
    <div className="border-t border-white/[0.06] pt-2">
      <div className="space-y-0.5 px-1">
        {bottomBarItems.map((item) => {
          const Icon = item.icon
          const isLink = item.href.startsWith("/")

          const content = (
            <div
              className={cn(
                "group flex items-center gap-2.5 px-3 py-[6px] mx-0 rounded-md text-[13px] text-neutral-500 hover:text-neutral-300 hover:bg-white/[0.05] transition-all duration-150 cursor-pointer",
                isCollapsed && "justify-center px-2"
              )}
              title={isCollapsed ? item.label : undefined}
            >
              <Icon className="h-4 w-4 flex-shrink-0 text-neutral-600 group-hover:text-neutral-400 transition-colors" />
              {!isCollapsed && <span>{item.label}</span>}
            </div>
          )

          if (isLink) {
            return (
              <Link key={item.label} href={item.href}>
                {content}
              </Link>
            )
          }

          return <div key={item.label}>{content}</div>
        })}
      </div>
    </div>
  )
}
