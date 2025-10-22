import crypto from "crypto"

const ALGO = "aes-256-gcm"
const IV_LENGTH = 12

function getKey(): Buffer {
  const raw = process.env.SHOPIFY_CREDENTIALS_ENCRYPTION_KEY ?? ""
  if (!raw) throw new Error("SHOPIFY_CREDENTIALS_ENCRYPTION_KEY is required")
  const asBuffer = /^[A-Fa-f0-9]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64")
  if (asBuffer.length !== 32) throw new Error("SHOPIFY_CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (hex/base64)")
  return asBuffer
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":")
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Invalid encrypted payload")
  const iv = Buffer.from(ivB64, "base64")
  const tag = Buffer.from(tagB64, "base64")
  const encrypted = Buffer.from(dataB64, "base64")
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return decrypted.toString("utf8")
}
