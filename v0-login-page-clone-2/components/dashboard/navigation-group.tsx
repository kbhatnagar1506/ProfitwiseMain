"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import { ChevronDown } from "lucide-react"
import type { NavGroup } from "@/lib/dashboard-navigation"
import { cn } from "@/lib/utils"

interface NavigationGroupProps {
  group: NavGroup
  isExpanded: boolean
  onToggle: () => void
  isCollapsed: boolean
}

export function NavigationGroup({
  group,
  isExpanded,
  onToggle,
  isCollapsed,
}: NavigationGroupProps) {
  const pathname = usePathname()

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "w-full justify-between px-2 py-1.5 text-xs font-semibold text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors",
            isCollapsed && "justify-center",
            isExpanded && "text-sidebar-foreground"
          )}
        >
          {!isCollapsed && group.label}
          {!isCollapsed && (
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform duration-200",
                isExpanded && "rotate-180"
              )}
            />
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1 overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:collapse data-[state=open]:expand">
        {group.items.map((item) => {
          const isActive = pathname === item.href
          const Icon = item.icon

          return (
            <Link key={item.href} href={item.href}>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "w-full justify-start px-2 py-1.5 text-xs transition-colors",
                  isActive
                    ? "bg-sidebar-primary text-sidebar-accent font-medium"
                    : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/30",
                  isCollapsed && "justify-center"
                )}
                title={isCollapsed ? item.label : undefined}
              >
                <Icon className={cn("h-4 w-4 flex-shrink-0", isActive && "text-sidebar-accent")} />
                {!isCollapsed && <span className="ml-2">{item.label}</span>}
              </Button>
            </Link>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}
