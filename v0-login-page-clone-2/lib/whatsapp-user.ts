import { ensureWhatsAppSchema, query } from "./db"

/** Normalize Twilio From (e.g. whatsapp:+14155551234) or raw digits to E.164 (+14155551234). */
export function normalizePhoneE164(value: string): string {
  const digits = value.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  if (digits.length >= 10) return `+${digits}`
  return ""
}

/** Get user id and verified status by WhatsApp phone (E.164). */
export async function getUserIdByWhatsAppPhone(
  phoneE164: string
): Promise<{ userId: string; verified: boolean } | null> {
  await ensureWhatsAppSchema()
  const { rows } = await query<{ user_id: string; verified_at: string | null }>(
    "SELECT user_id, verified_at FROM user_whatsapp WHERE phone_e164 = $1",
    [phoneE164]
  )
  const row = rows[0]
  if (!row) return null
  return { userId: row.user_id, verified: !!row.verified_at }
}

/** Get pending OTP row for this phone (for webhook verification). */
export async function getPendingOtpByPhone(phoneE164: string): Promise<{ userId: string; code: string } | null> {
  await ensureWhatsAppSchema()
  const { rows } = await query<{ user_id: string; otp_code: string }>(
    `SELECT user_id, otp_code FROM user_whatsapp
     WHERE phone_e164 = $1 AND otp_expires_at > NOW() AND verified_at IS NULL AND otp_code IS NOT NULL`,
    [phoneE164]
  )
  const row = rows[0]
  if (!row || !row.otp_code) return null
  return { userId: row.user_id, code: row.otp_code }
}

/** Mark phone as verified and clear OTP. */
export async function markWhatsAppVerified(userId: string): Promise<void> {
  await ensureWhatsAppSchema()
  await query(
    `UPDATE user_whatsapp SET verified_at = NOW(), otp_code = NULL, otp_expires_at = NULL, updated_at = NOW() WHERE user_id = $1`,
    [userId]
  )
}

/** Set or update pending OTP for user. */
export async function setPendingOtp(
  userId: string,
  phoneE164: string,
  otpCode: string,
  expiresAt: Date
): Promise<void> {
  await ensureWhatsAppSchema()
  await query(
    `INSERT INTO user_whatsapp (user_id, phone_e164, verified_at, otp_code, otp_expires_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       phone_e164 = EXCLUDED.phone_e164,
       verified_at = NULL,
       otp_code = EXCLUDED.otp_code,
       otp_expires_at = EXCLUDED.otp_expires_at,
       updated_at = NOW()`,
    [userId, phoneE164, otpCode, expiresAt]
  )
}

/** Get WhatsApp status for current user (for UI). */
export async function getWhatsAppStatusByUserId(
  userId: string
): Promise<{ phoneE164: string | null; verified: boolean }> {
  await ensureWhatsAppSchema()
  const { rows } = await query<{ phone_e164: string; verified_at: string | null }>(
    "SELECT phone_e164, verified_at FROM user_whatsapp WHERE user_id = $1",
    [userId]
  )
  const row = rows[0]
  if (!row) return { phoneE164: null, verified: false }
  return { phoneE164: row.phone_e164, verified: !!row.verified_at }
}

/** Remove the user's linked WhatsApp number so they can link a different one. */
export async function disconnectWhatsApp(userId: string): Promise<void> {
  await ensureWhatsAppSchema()
  await query("DELETE FROM user_whatsapp WHERE user_id = $1", [userId])
}
