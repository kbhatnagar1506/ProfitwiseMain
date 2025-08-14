/**
 * Google reCAPTCHA v3 server-side verification.
 * Set RECAPTCHA_SECRET_KEY in production to enable. When unset, verification is skipped (dev/local).
 */

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify"
const MIN_SCORE = 0.5

export async function verifyRecaptcha(
  token: string,
  action?: string
): Promise<{ success: boolean; score?: number }> {
  const secret = process.env.RECAPTCHA_SECRET_KEY
  if (!secret || !token) {
    return { success: !secret }
  }

  try {
    const params = new URLSearchParams()
    params.set("secret", secret)
    params.set("response", token)
    if (action) params.set("action", action)

    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    })
    const data = (await res.json()) as {
      success?: boolean
      score?: number
      action?: string
    }
    const ok = data.success === true && (data.score ?? 0) >= MIN_SCORE
    return { success: ok, score: data.score }
  } catch {
    return { success: false }
  }
}
