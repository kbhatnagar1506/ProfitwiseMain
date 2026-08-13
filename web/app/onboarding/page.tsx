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
        setInitialStep(Math.min(Math.max(data.step ?? 1, 1), 14))
      )
      .catch(() => setInitialStep(1))
  }, [])

  if (initialStep === null) {
    return (
      <div className="min-h-screen flex bg-black font-sans items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 rounded-full border-2 border-white/20 border-t-emerald-400 animate-spin" />
          <p className="text-sm text-gray-400">Loading your progress…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex bg-black font-sans bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(16,185,129,0.08),transparent)]">
      <div className="flex-1 flex items-center justify-center p-4 md:p-6 py-4">
        <OnboardingFlow qboError={error} initialStep={initialStep} />
      </div>
    </div>
  )
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex bg-black items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="h-8 w-8 rounded-full border-2 border-white/20 border-t-emerald-400 animate-spin" />
            <p className="text-sm text-gray-400">Loading…</p>
          </div>
        </div>
      }
    >
      <OnboardingContent />
    </Suspense>
  )
}
