import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getUserBySessionToken } from "./auth"
import { SESSION_COOKIE_NAME } from "./session-cookie"

/**
 * Call from Server Components (e.g. protected layouts). Validates session via DB; redirects to / if missing or invalid.
 */
export async function requireSession(): Promise<{ id: string; email: string }> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE_NAME)?.value
  if (!token) redirect("/")
  const user = await getUserBySessionToken(token)
  if (!user) redirect("/")
  return user
}
