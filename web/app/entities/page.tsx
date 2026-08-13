"use client"

import { useState } from "react"
import { EntitiesPagePremium } from "@/components/entities-page-premium"
import { EntityDetailPremium } from "@/components/entity-detail-premium"

export default function EntitiesRoute() {
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null)

  return (
    <>
      <EntitiesPagePremium onSelectEntity={(id) => setSelectedEntityId(id)} />
      {selectedEntityId && (
        <EntityDetailPremium
          entityId={selectedEntityId}
          onClose={() => setSelectedEntityId(null)}
        />
      )}
    </>
  )
}
