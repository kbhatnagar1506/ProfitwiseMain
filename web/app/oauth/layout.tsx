import { requireSession } from "@/lib/require-session"

export default async function OAuthLayout({
  children,
}: { children: React.ReactNode }) {
  await requireSession()
  return <>{children}</>
}
