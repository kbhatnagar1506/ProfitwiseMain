"use client"

import { Badge } from "@/components/ui/badge"
import { FileText } from "lucide-react"

interface SupermemoryContext {
  contractTerms: string | null
  relationshipNotes: string | null
  paymentTerms: string | null
  rawContext: string
}

interface SupermemoryContextCardProps {
  context: SupermemoryContext
}

function classifyRelationship(context: string): "Strategic" | "Preferred" | "New" | "At-Risk" {
  if (!context) return "New"

  const lowerContext = context.toLowerCase()

  if (
    lowerContext.includes("strategic") ||
    lowerContext.includes("key account") ||
    lowerContext.includes("major customer") ||
    lowerContext.includes("long-term")
  ) {
    return "Strategic"
  }

  if (
    lowerContext.includes("preferred") ||
    lowerContext.includes("priority") ||
    lowerContext.includes("important")
  ) {
    return "Preferred"
  }

  if (
    lowerContext.includes("at risk") ||
    lowerContext.includes("delinquent") ||
    lowerContext.includes("overdue") ||
    lowerContext.includes("problem")
  ) {
    return "At-Risk"
  }

  return "New"
}

function getRelationshipColor(relationship: string): string {
  const colors: Record<string, string> = {
    Strategic: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    Preferred: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    "At-Risk": "bg-red-500/20 text-red-300 border-red-500/30",
    New: "bg-neutral-500/20 text-neutral-300 border-neutral-500/30",
  }
  return colors[relationship] || colors.New
}

export function SupermemoryContextCard({
  context,
}: SupermemoryContextCardProps) {
  const relationship = classifyRelationship(context.rawContext)

  return (
    <div className="space-y-3">
      {/* Relationship Classification */}
      <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
        <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium mb-2">
          Relationship Type
        </p>
        <Badge className={`text-[10px] h-5 ${getRelationshipColor(relationship)}`}>
          {relationship}
        </Badge>
      </div>

      {/* Payment Terms */}
      {context.paymentTerms && (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
          <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium mb-2">
            Payment Terms
          </p>
          <p className="text-[12px] text-neutral-300 font-medium">
            {context.paymentTerms}
          </p>
        </div>
      )}

      {/* Contract Terms */}
      {context.contractTerms && (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
          <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium mb-2">
            Contract Terms
          </p>
          <p className="text-[12px] text-neutral-300 line-clamp-3">
            {context.contractTerms}
          </p>
        </div>
      )}

      {/* Relationship Notes */}
      {context.relationshipNotes && (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
          <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium mb-2">
            Relationship Notes
          </p>
          <p className="text-[12px] text-neutral-300 line-clamp-3">
            {context.relationshipNotes}
          </p>
        </div>
      )}

      {/* Document Context Preview */}
      {context.rawContext && (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-4 h-4 text-neutral-600" />
            <p className="text-[10px] text-neutral-600 uppercase tracking-wide font-medium">
              Document Context
            </p>
          </div>
          <p className="text-[11px] text-neutral-400 line-clamp-4">
            {context.rawContext.slice(0, 300)}
            {context.rawContext.length > 300 ? "..." : ""}
          </p>
        </div>
      )}

      {/* No Context Available */}
      {!context.contractTerms &&
        !context.relationshipNotes &&
        !context.paymentTerms &&
        !context.rawContext && (
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
            <p className="text-[12px] text-neutral-500">
              No contract or relationship information found in company documents.
            </p>
          </div>
        )}
    </div>
  )
}
