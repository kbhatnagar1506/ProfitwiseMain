"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { bottomBarItems } from "@/lib/dashboard-navigation"
import { cn } from "@/lib/utils"

interface BottomBarProps {
  isCollapsed: boolean
}

export function BottomBar({ isCollapsed }: BottomBarProps) {
  return (
    <div className="border-t border-sidebar-accent/20">
      <Separator className="my-2 bg-sidebar-accent/20" />
      <div className="space-y-1 px-2 pb-2">
        {bottomBarItems.map((item) => {
          const Icon = item.icon
          const isLink = item.href.startsWith("/")

          const buttonContent = (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "w-full justify-start px-2 py-1.5 text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/30 transition-colors",
                isCollapsed && "justify-center"
              )}
              title={isCollapsed ? item.label : undefined}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {!isCollapsed && <span className="ml-2">{item.label}</span>}
            </Button>
          )

          if (isLink) {
            return (
              <Link key={item.label} href={item.href}>
                {buttonContent}
              </Link>
            )
          }

          return (
            <div key={item.label}>
              {buttonContent}
            </div>
          )
        })}
      </div>
    </div>
  )
}
