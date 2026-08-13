/**
 * Server-side password strength validation for signup.
 * Rules: 8–128 chars, at least one letter and one number.
 */

const MIN_LEN = 8
const MAX_LEN = 128
const HAS_LETTER = /[a-zA-Z]/
const HAS_NUMBER = /\d/

export function validatePassword(password: string): { ok: true } | { ok: false; error: string } {
  if (typeof password !== "string") {
    return { ok: false, error: "Password must be a string" }
  }
  if (password.length < MIN_LEN) {
    return { ok: false, error: "Password must be at least 8 characters" }
  }
  if (password.length > MAX_LEN) {
    return { ok: false, error: "Password must be at most 128 characters" }
  }
  if (!HAS_LETTER.test(password)) {
    return { ok: false, error: "Password must contain at least one letter" }
  }
  if (!HAS_NUMBER.test(password)) {
    return { ok: false, error: "Password must contain at least one number" }
  }
  return { ok: true }
}
