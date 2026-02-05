import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Download, Tag, Calendar, FileText, Trash2 } from "lucide-react"

interface BulkActionsToolbarProps {
  selectedCount: number
  totalCount: number
  onSelectAll: () => void
  onDeselectAll: () => void
  onExport: () => void
  onTag: () => void
  onSchedule: () => void
  onReport: () => void
  onDelete: () => void
}

export function BulkActionsToolbar({
  selectedCount,
  totalCount,
  onSelectAll,
  onDeselectAll,
  onExport,
  onTag,
  onSchedule,
  onReport,
  onDelete,
}: BulkActionsToolbarProps) {
  const isAllSelected = selectedCount === totalCount && totalCount > 0
  const isIndeterminate = selectedCount > 0 && selectedCount < totalCount

  return (
    <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-4 space-y-3">
      {/* Selection Row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Checkbox
            checked={isAllSelected}
            indeterminate={isIndeterminate}
            onCheckedChange={(checked) => {
              if (checked) {
                onSelectAll()
              } else {
                onDeselectAll()
              }
            }}
            className="w-5 h-5"
          />
          <span className="text-sm text-neutral-400">
            {selectedCount > 0 ? (
              <>
                <span className="font-semibold text-white">{selectedCount}</span> selected
                {selectedCount < totalCount && ` of ${totalCount}`}
              </>
            ) : (
              `Select items (${totalCount} available)`
            )}
          </span>
        </div>

        {selectedCount > 0 && (
          <button
            onClick={onDeselectAll}
            className="text-xs text-neutral-500 hover:text-neutral-400 transition-colors"
          >
            Clear selection
          </button>
        )}
      </div>

      {/* Action Buttons */}
      {selectedCount > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={onExport}
            size="sm"
            className="bg-white/5 hover:bg-white/10 text-neutral-300 border border-white/10 h-8 px-3 text-xs gap-2"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </Button>

          <Button
            onClick={onTag}
            size="sm"
            className="bg-white/5 hover:bg-white/10 text-neutral-300 border border-white/10 h-8 px-3 text-xs gap-2"
          >
            <Tag className="w-3.5 h-3.5" />
            Tag
          </Button>

          <Button
            onClick={onSchedule}
            size="sm"
            className="bg-white/5 hover:bg-white/10 text-neutral-300 border border-white/10 h-8 px-3 text-xs gap-2"
          >
            <Calendar className="w-3.5 h-3.5" />
            Schedule
          </Button>

          <Button
            onClick={onReport}
            size="sm"
            className="bg-white/5 hover:bg-white/10 text-neutral-300 border border-white/10 h-8 px-3 text-xs gap-2"
          >
            <FileText className="w-3.5 h-3.5" />
            Report
          </Button>

          <Button
            onClick={onDelete}
            size="sm"
            className="bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 h-8 px-3 text-xs gap-2 ml-auto"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </Button>
        </div>
      )}
    </div>
  )
}
