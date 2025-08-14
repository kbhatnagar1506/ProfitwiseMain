"use client"

import { Suspense, useEffect, useState } from "react"
import { OnboardingFlow } from "@/components/onboarding-flow"
import { useSearchParams } from "next/navigation"

function OnboardingContent() {
  const searchParams = useSearchParams()
  const error = searchParams.get("error")
  const [initialStep, setInitialStep] = useState<number | null>(null)

  useEffect(() => {
    fetch("/api/onboarding/progress")
      .then((res) => (res.ok ? res.json() : { step: 1 }))
      .then((data: { step?: number }) =>
        setInitialStep(Math.min(Math.max(data.step ?? 1, 1), 11))
      )
      .catch(() => setInitialStep(1))
  }, [])

  if (initialStep === null) {
    return (
      <div className="min-h-screen flex bg-black font-sans items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex bg-black font-sans">
      <div className="flex-1 flex items-center justify-center p-6 py-px">
        <OnboardingFlow qboError={error} initialStep={initialStep} />
      </div>
    </div>
  )
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex bg-black items-center justify-center" />}>
      <OnboardingContent />
    </Suspense>
  )
}
