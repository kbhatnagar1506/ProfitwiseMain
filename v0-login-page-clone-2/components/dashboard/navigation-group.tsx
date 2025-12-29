"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { NavGroup } from "@/lib/dashboard-navigation"
import { cn } from "@/lib/utils"

interface NavigationGroupProps {
  group: NavGroup
  isFirst?: boolean
}

const badgeColors = {
  red: "bg-red-500/90 text-white",
  green: "bg-emerald-600/90 text-white",
  amber: "bg-amber-500/90 text-white",
}

export function NavigationGroup({ group, isFirst }: NavigationGroupProps) {
  const pathname = usePathname()

  return (
    <div>
      <div className={cn("px-4 pb-1", isFirst ? "pt-2" : "pt-5")}>
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-neutral-500">
          {group.label}
        </span>
      </div>
      <div className="space-y-0.5">
        {group.items.map((item) => {
          const isActive = pathname === item.href
          const Icon = item.icon

          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "group flex items-center gap-2.5 px-3 py-[7px] mx-2 rounded-md text-[13px] transition-colors duration-100 cursor-pointer",
                  isActive
                    ? "bg-white/[0.1] text-white"
                    : "text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.05]",
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 flex-shrink-0",
                    isActive ? "text-neutral-300" : "text-neutral-600 group-hover:text-neutral-400"
                  )}
                  strokeWidth={1.75}
                />
                <span className="flex-1 leading-none">{item.label}</span>
                {item.badge !== undefined && (
                  <span
                    className={cn(
                      "flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold leading-none",
                      badgeColors[item.badgeColor ?? "red"]
                    )}
                  >
                    {item.badge}
                  </span>
                )}
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
