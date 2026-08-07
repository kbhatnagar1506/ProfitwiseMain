import { requireSession } from "@/lib/require-session"
import { DashboardLayout } from "@/components/dashboard/dashboard-layout"

export default async function RootDashboardLayout({
  children,
}: { children: React.ReactNode }) {
  await requireSession()
  return <DashboardLayout>{children}</DashboardLayout>
}
