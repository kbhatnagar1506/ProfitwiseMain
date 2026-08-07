"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { NavGroup } from "@/lib/dashboard-navigation"
import { cn } from "@/lib/utils"

interface NavigationGroupProps {
  group: NavGroup
  isFirst?: boolean
}

export function NavigationGroup({ group, isFirst }: NavigationGroupProps) {
  const pathname = usePathname()

  return (
    <div>
      <div className={cn("px-3 pb-1", isFirst ? "pt-3" : "pt-5")}>
        <span className="text-[10px] font-semibold tracking-[0.15em] text-zinc-600 uppercase">
          {group.label}
        </span>
      </div>
      <div className="space-y-px">
        {group.items.map((item) => {
          const isActive = pathname === item.href
          const Icon = item.icon

          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "group flex items-center gap-2.5 px-3 py-[7px] text-[13px] transition-colors duration-100 cursor-pointer",
                  isActive
                    ? "text-white bg-white/[0.04] border-l-2 border-zinc-300"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04] border-l-2 border-transparent",
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 flex-shrink-0 transition-colors",
                    isActive ? "text-white" : "text-zinc-400 group-hover:text-zinc-200"
                  )}
                  strokeWidth={1.5}
                />
                <span className="flex-1 leading-none">{item.label}</span>
                {item.badge !== undefined && (
                  <span
                    className={cn(
                      "ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-medium leading-none",
                      item.badgeColor === "amber"
                        ? "bg-amber-500/10 text-amber-500/90"
                        : item.badgeColor === "green"
                          ? "bg-emerald-500/10 text-emerald-500/90"
                          : item.badgeColor === "red"
                            ? "bg-red-500/10 text-red-500/90"
                            : "bg-white/5 text-zinc-500"
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
