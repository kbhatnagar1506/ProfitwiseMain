import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getUserBySessionToken } from "./auth"
import { SESSION_COOKIE_NAME } from "./session-cookie"

// Test user for development mode
const DEV_TEST_USER = {
  id: "test-user-dev-123",
  email: "test@profitwise.dev",
}

/**
 * Call from Server Components (e.g. protected layouts). Validates session via DB; redirects to / if missing or invalid.
 * In development mode, returns a test user without requiring authentication.
 */
export async function requireSession(): Promise<{ id: string; email: string }> {
  // In development mode, bypass auth and return test user
  if (process.env.NODE_ENV !== "production") {
    return DEV_TEST_USER
  }

  const store = await cookies()
  const token = store.get(SESSION_COOKIE_NAME)?.value
  if (!token) redirect("/")
  const user = await getUserBySessionToken(token)
  if (!user) redirect("/")
  return user
}
