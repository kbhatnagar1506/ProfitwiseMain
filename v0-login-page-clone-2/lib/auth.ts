import argon2 from "argon2"
import crypto from "crypto"
import { ensureAuthSchema, query } from "./db"
import { SESSION_COOKIE_NAME } from "./session-cookie"

export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7 // 7 days

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    timeCost: 3,
    memoryCost: 64 * 1024,
    parallelism: 1,
  })
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

export async function findUserByEmail(email: string): Promise<{ id: string; password_hash: string } | null> {
  if (!isProduction()) return null
  await ensureAuthSchema()
  const { rows } = await query<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE email = $1",
    [email.toLowerCase()]
  )
  return rows[0] ?? null
}

export async function createUser(
  email: string,
  password: string
): Promise<{ id: string }> {
  if (!isProduction()) throw new Error("Signup is only available in production")
  await ensureAuthSchema()
  const passwordHash = await hashPassword(password)
  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id`,
    [email.toLowerCase(), passwordHash]
  )
  if (!rows[0]) throw new Error("createUser failed")
  return rows[0]
}

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex")
}

export async function createSession(userId: string): Promise<{ token: string }> {
  if (!isProduction()) throw new Error("Login is only available in production")
  await ensureAuthSchema()
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SEC * 1000)
  await query(
    `INSERT INTO sessions (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  )
  return { token }
}

export async function getUserBySessionToken(
  token: string
): Promise<{ id: string; email: string } | null> {
  if (!isProduction()) return null
  await ensureAuthSchema()
  const { rows } = await query<{ id: string; email: string }>(
    `SELECT u.id, u.email
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  )
  return rows[0] ?? null
}

export async function deleteSessionToken(token: string): Promise<void> {
  if (!isProduction()) return
  await query("DELETE FROM sessions WHERE token = $1", [token])
}
