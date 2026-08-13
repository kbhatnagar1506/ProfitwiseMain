/**
 * Authentication Middleware
 * Centralized authentication logic for all API endpoints
 */

import { cookies } from "next/headers"
import { getSessionCookieName, getUserBySessionToken } from "@/lib/auth"
import { NextResponse } from "next/server"

export interface AuthContext {
  userId: string
  sessionToken: string
}

/**
 * Get authenticated user from request
 * Returns null if not authenticated
 */
export async function getAuthenticatedUser(): Promise<AuthContext | null> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get(getSessionCookieName())?.value
    
    if (!sessionToken) {
      return null
    }

    const user = await getUserBySessionToken(sessionToken)
    if (!user) {
      return null
    }

    return {
      userId: user.id,
      sessionToken
    }
  } catch (err) {
    return null
  }
}

/**
 * Require authentication - returns error response if not authenticated
 */
export async function requireAuth(): Promise<{ auth: AuthContext | null; error: NextResponse | null }> {
  const auth = await getAuthenticatedUser()
  
  if (!auth) {
    return {
      auth: null,
      error: NextResponse.json(
        { error: "Unauthorized", timestamp: new Date().toISOString() },
        { status: 401 }
      )
    }
  }

  return { auth, error: null }
}

/**
 * Middleware wrapper for authenticated endpoints
 */
export async function withAuth<T>(
  handler: (auth: AuthContext) => Promise<T>
): Promise<T | NextResponse> {
  const { auth, error } = await requireAuth()
  
  if (error) {
    return error
  }

  if (!auth) {
    return NextResponse.json(
      { error: "Unauthorized", timestamp: new Date().toISOString() },
      { status: 401 }
    )
  }

  try {
    return await handler(auth)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: "Internal server error", details: message, timestamp: new Date().toISOString() },
      { status: 500 }
    )
  }
}
