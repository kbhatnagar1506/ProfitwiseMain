"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronRight } from "lucide-react"
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
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer",
          isCollapsed && "justify-center px-0",
        )}
      >
        {!isCollapsed && <span>{group.label}</span>}
        {!isCollapsed && (
          <ChevronRight
            className={cn(
              "h-3 w-3 transition-transform duration-200",
              isExpanded && "rotate-90"
            )}
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden transition-all duration-200 ease-in-out data-[state=closed]:animate-out data-[state=open]:animate-in">
        <div className="space-y-0.5 pb-2">
          {group.items.map((item) => {
            const isActive = pathname === item.href
            const Icon = item.icon

            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "group flex items-center gap-2.5 px-3 py-[6px] mx-1 rounded-md text-[13px] transition-all duration-150 cursor-pointer",
                    isActive
                      ? "bg-white/[0.1] text-white font-medium"
                      : "text-neutral-400 hover:text-white hover:bg-white/[0.05]",
                    isCollapsed && "justify-center px-2 mx-0"
                  )}
                  title={isCollapsed ? item.label : undefined}
                >
                  <Icon className={cn(
                    "h-4 w-4 flex-shrink-0 transition-colors",
                    isActive ? "text-white" : "text-neutral-500 group-hover:text-neutral-300"
                  )} />
                  {!isCollapsed && <span>{item.label}</span>}
                </div>
              </Link>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
