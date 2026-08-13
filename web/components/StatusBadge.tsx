/**
 * StatusBadge — single source of truth for all AR/AP status colors and labels.
 *
 * RULES:
 * - This is the ONLY place status label strings and colors are defined.
 * - No page may invent its own status color or label.
 * - No client-side "overdue" computation — the server sends the status string.
 *   The server computes overdue dynamically: display_status = 'open' AND expected_date < CURRENT_DATE.
 *
 * Valid status values: 'paid' | 'partially_paid' | 'overdue' | 'open' | 'void'
 * Any unknown value falls back to 'open' styling.
 */

import { Badge } from "@/components/ui/badge"

type Status = "paid" | "partially_paid" | "overdue" | "open" | "void" | string

interface StatusConfig {
  label: string
  className: string
}

const CONFIG: Record<string, StatusConfig> = {
  paid:           { label: "Paid",    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  partially_paid: { label: "Partial", className: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  overdue:        { label: "Overdue", className: "bg-red-500/10 text-red-400 border-red-500/20" },
  open:           { label: "Open",    className: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  void:           { label: "Void",    className: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20" },
}

export function StatusBadge({ status }: { status: Status }) {
  const cfg = CONFIG[status] ?? CONFIG.open
  return (
    <Badge className={`${cfg.className} text-[10px] px-1.5 py-0 border font-mono uppercase tracking-wide`}>
      {cfg.label}
    </Badge>
  )
}
