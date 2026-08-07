import { requireSession } from "@/lib/require-session"

export default async function OnboardingLayout({
  children,
}: { children: React.ReactNode }) {
  await requireSession()
  return <>{children}</>
}
