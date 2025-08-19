/**
 * Twilio client for WhatsApp (and SMS if needed).
 *
 * Env vars (set on Heroku; never commit secrets):
 * - TWILIO_ACCOUNT_SID (required) — main account SID (starts with AC)
 * - Either:
 *   - TWILIO_AUTH_TOKEN — classic auth, or
 *   - TWILIO_API_KEY_SID (SK...) + TWILIO_API_KEY_SECRET — API Key auth
 * - TWILIO_WHATSAPP_FROM — e.g. whatsapp:+18772696161 (your Twilio WhatsApp number)
 *
 * Webhook signature validation uses TWILIO_AUTH_TOKEN when set.
 */

import Twilio from "twilio"

export type TwilioClient = InstanceType<typeof Twilio>

function getTwilioClient(): TwilioClient | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  if (!accountSid) return null

  const apiKeySid = process.env.TWILIO_API_KEY_SID
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET
  if (apiKeySid && apiKeySecret) {
    return Twilio(apiKeySid, apiKeySecret, { accountSid })
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (authToken) {
    return Twilio(accountSid, authToken)
  }

  return null
}

let cached: TwilioClient | null | undefined = undefined

export function getTwilio(): TwilioClient | null {
  if (cached === undefined) cached = getTwilioClient()
  return cached
}

export function getWhatsAppFrom(): string | null {
  const from = process.env.TWILIO_WHATSAPP_FROM
  if (!from || typeof from !== "string") return null
  const trimmed = from.trim()
  return trimmed.startsWith("whatsapp:") ? trimmed : `whatsapp:${trimmed}`
}

export function getTwilioAuthToken(): string | null {
  return process.env.TWILIO_AUTH_TOKEN ?? null
}
