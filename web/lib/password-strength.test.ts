/**
 * Unit tests for password-strength.ts — server-side signup validation.
 * This is the only gate between the signup route and argon2 hashing, so the
 * boundaries are pinned exactly.
 */

import { validatePassword } from "./password-strength"

describe("validatePassword", () => {
  it("accepts a password with a letter, a number and 8+ characters", () => {
    expect(validatePassword("abcdefg1")).toEqual({ ok: true })
  })

  it("rejects passwords shorter than 8 characters", () => {
    const r = validatePassword("abcdef1")
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ error: "Password must be at least 8 characters" })
  })

  it("accepts exactly 8 characters (lower boundary is inclusive)", () => {
    expect(validatePassword("abcdefg1").ok).toBe(true)
  })

  it("accepts exactly 128 characters and rejects 129", () => {
    const at128 = "a1" + "x".repeat(126)
    const at129 = "a1" + "x".repeat(127)
    expect(at128).toHaveLength(128)
    expect(at129).toHaveLength(129)
    expect(validatePassword(at128).ok).toBe(true)
    expect(validatePassword(at129)).toMatchObject({
      ok: false,
      error: "Password must be at most 128 characters",
    })
  })

  it("requires at least one letter", () => {
    expect(validatePassword("12345678")).toMatchObject({
      ok: false,
      error: "Password must contain at least one letter",
    })
  })

  it("requires at least one number", () => {
    expect(validatePassword("abcdefgh")).toMatchObject({
      ok: false,
      error: "Password must contain at least one number",
    })
  })

  it("accepts uppercase-only letters and symbols alongside a digit", () => {
    expect(validatePassword("ABCDEFG9").ok).toBe(true)
    expect(validatePassword("!@#$%^&A1").ok).toBe(true)
  })

  it("checks length before composition so short input reports the length error", () => {
    // "abc" fails both length and digit rules; length must win for a stable message.
    expect(validatePassword("abc")).toMatchObject({
      error: "Password must be at least 8 characters",
    })
  })

  it("rejects non-string input defensively", () => {
    // Route handlers pass unvalidated JSON, so this guard is load-bearing.
    for (const bad of [null, undefined, 12345678, {}, []]) {
      expect(validatePassword(bad as unknown as string).ok).toBe(false)
    }
  })

  it("counts whitespace toward length rather than trimming it", () => {
    expect(validatePassword("a1      ").ok).toBe(true)
  })
})
