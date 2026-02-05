import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Eye, EyeOff, RotateCcw } from "lucide-react"

export interface ColumnConfig {
  id: string
  label: string
  visible: boolean
}

interface ConfigurableColumnsProps {
  columns: ColumnConfig[]
  onColumnsChange: (columns: ColumnConfig[]) => void
  onReset: () => void
}

export function ConfigurableColumns({
  columns,
  onColumnsChange,
  onReset,
}: ConfigurableColumnsProps) {
  const [isOpen, setIsOpen] = useState(false)

  const handleToggleColumn = (columnId: string) => {
    const updated = columns.map((col) =>
      col.id === columnId ? { ...col, visible: !col.visible } : col
    )
    onColumnsChange(updated)
  }

  const visibleCount = columns.filter((c) => c.visible).length

  return (
    <div className="relative">
      <Button
        onClick={() => setIsOpen(!isOpen)}
        variant="outline"
        size="sm"
        className="bg-white/5 border-white/10 text-neutral-300 h-8 px-3 text-xs gap-2"
      >
        <Eye className="w-3.5 h-3.5" />
        Columns ({visibleCount})
      </Button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-56 bg-[#1a1a1a] border border-white/[0.06] rounded-lg shadow-lg z-50">
          <div className="p-3 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-neutral-500">Show/Hide Columns</p>
              <button
                onClick={onReset}
                className="text-xs text-neutral-500 hover:text-neutral-400 flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            </div>

            {/* Column List */}
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {columns.map((column) => (
                <label
                  key={column.id}
                  className="flex items-center gap-2 cursor-pointer hover:bg-white/[0.03] p-2 rounded transition-colors"
                >
                  <Checkbox
                    checked={column.visible}
                    onCheckedChange={() => handleToggleColumn(column.id)}
                    className="w-4 h-4"
                  />
                  <span className="text-xs text-neutral-400">{column.label}</span>
                </label>
              ))}
            </div>

            {/* Footer */}
            <div className="border-t border-white/[0.06] pt-2 flex gap-2">
              <Button
                onClick={() => setIsOpen(false)}
                size="sm"
                className="flex-1 bg-white/5 hover:bg-white/10 text-neutral-300 border border-white/10 h-7 text-xs"
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
