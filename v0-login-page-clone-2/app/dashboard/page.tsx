import { redirect } from "next/navigation"

export default function DashboardRoot() {
  // Redirect to home page
  redirect("/dashboard/home")
}
