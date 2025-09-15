export type LogChannel =
  | "qbo"
  | "plaid"
  | "xero"
  | "supermemory"
  | "db"
  | "auth"
  | "system"
  | "gcp"
  | "stripe"
  | "identity"
  | "movements"

/**
 * Emoji for filtering in log viewers (e.g. Heroku):
 * 🔴 = act (failure/error) — filter when you need to act
 * ⚠️ = warning (skipped, rejected, unauth)
 * ✅ = success
 * ℹ️ = info (started, received, redirecting)
 */
function emojiFor(message: string): string {
  const m = message.toLowerCase()
  if (m.includes("failed") || m.includes("error") || m.includes("mismatch") || m.includes(".failed")) return "🔴"
  if (m.includes("rejected") || m.includes("skipped") || m.includes("unauthorized") || m.includes("forbidden")) return "⚠️"
  if (m.includes("succeeded") || m.includes("done") || m.includes("responded") || m.includes(".succeeded") || m.includes("processed")) return "✅"
  return "ℹ️"
}

function prefix(channel?: LogChannel): string {
  switch (channel) {
    case "plaid":
      return "[Plaid]"
    case "xero":
      return "[Xero]"
    case "stripe":
      return "[Stripe]"
    case "supermemory":
      return "[Supermemory]"
    case "db":
      return "[DB]"
    case "auth":
      return "[Auth]"
    case "system":
      return "[System]"
    case "gcp":
      return "[GCP]"
    case "identity":
      return "[Identity]"
    case "movements":
      return "[Movements]"
    default:
      return "[QBO]"
  }
}

const REDACTED = "[REDACTED]"
const MAX_VALUE_LEN = 300
const SENSITIVE_KEY_REGEX = /(token|secret|password|authorization|signature|cookie|code|key)/i

function sanitizeValue(value: unknown, keyHint?: string): unknown {
  if (keyHint && SENSITIVE_KEY_REGEX.test(keyHint)) {
    return REDACTED
  }
  if (value == null) return value
  if (typeof value === "string") {
    return value.length > MAX_VALUE_LEN ? `${value.slice(0, MAX_VALUE_LEN)}...` : value
  }
  if (typeof value === "number" || typeof value === "boolean") return value
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    }
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry))
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeValue(v, k)
    }
    return out
  }
  return String(value)
}

function formatMeta(meta: Record<string, unknown>): string {
  const parts = Object.entries(meta)
    .map(([k, v]) => {
      const safeValue = sanitizeValue(v, k)
      return `${k}=${typeof safeValue === "string" ? safeValue : JSON.stringify(safeValue)}`
    })
  return parts.length ? `  ${parts.join(" ")}` : ""
}

export function log(
  message: string,
  meta?: Record<string, unknown>,
  channel?: LogChannel
): void {
  const emoji = emojiFor(message)
  const p = prefix(channel)
  const extra = meta ? formatMeta(meta) : ""
  if (process.env.NODE_ENV === "production") {
    console.log(`${emoji} ${p} ${message}${extra}`)
  } else {
    console.log(`${emoji} ${p} ${message}`, meta ?? "")
  }
}

export function error(
  message: string,
  err?: unknown,
  channel?: LogChannel
): void {
  const p = prefix(channel)
  const safeErr = sanitizeValue(err)
  const errMsg = typeof safeErr === "string" ? safeErr : JSON.stringify(safeErr)
  if (process.env.NODE_ENV === "production") {
    console.error(`🔴 ${p} ${message}  error=${errMsg}`)
  } else {
    console.error(`🔴 ${p} ${message}`, safeErr ?? "")
  }
}

/** ⚠️ Warning: rejected, skipped, unauthorized, etc. */
export function warn(
  message: string,
  meta?: Record<string, unknown>,
  channel?: LogChannel
): void {
  const p = prefix(channel)
  const extra = meta ? formatMeta(meta) : ""
  if (process.env.NODE_ENV === "production") {
    console.warn(`⚠️ ${p} ${message}${extra}`)
  } else {
    console.warn(`⚠️ ${p} ${message}`, meta ?? "")
  }
}
