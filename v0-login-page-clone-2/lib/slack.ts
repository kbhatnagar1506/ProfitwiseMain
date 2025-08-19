/**
 * Slack app helpers. Env vars (set on Heroku):
 * - SLACK_CLIENT_ID
 * - SLACK_CLIENT_SECRET
 * - SLACK_SIGNING_SECRET — verify requests from Slack
 * - SLACK_BOT_TOKEN — Bot User OAuth Token (xoxb-...) after Install App
 */

import crypto from "crypto"

export function getSlackSigningSecret(): string | null {
  return process.env.SLACK_SIGNING_SECRET ?? null
}

export function getSlackBotToken(): string | null {
  return process.env.SLACK_BOT_TOKEN ?? null
}

export function getSlackClientId(): string | null {
  return process.env.SLACK_CLIENT_ID ?? null
}

export function getSlackClientSecret(): string | null {
  return process.env.SLACK_CLIENT_SECRET ?? null
}

/** Verify that a request came from Slack using X-Slack-Signature and X-Slack-Request-Timestamp. */
export function verifySlackRequest(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  signingSecret: string | null
): boolean {
  if (!signature || !timestamp || !signingSecret) return false
  if (!signature.startsWith("v0=")) return false
  const baseString = `v0:${timestamp}:${rawBody}`
  const expected = "v0=" + crypto.createHmac("sha256", signingSecret).update(baseString).digest("hex")
  if (signature.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}
