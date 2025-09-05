/**
 * Gmail sync: fetch messages from the connected inbox and store in gmail_synced_messages.
 * Used by cron job (e.g. every hour). Uses getValidGmailAccessToken for auth.
 */

import { convert as htmlToText } from "html-to-text"
import { ensureGmailSchema, query } from "./db"
import { getValidGmailAccessToken } from "./gmail-oauth"
import { log } from "./logger"

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(base64, "base64").toString("utf-8")
}

function getHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string | null {
  if (!headers) return null
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h?.value ?? null
}

function extractPlainBody(payload: GmailPayload | undefined): string {
  if (!payload) return ""
  // 1. Direct body
  if (payload.body?.data) return decodeBase64Url(payload.body.data)
  if (!payload.parts || payload.parts.length === 0) return ""

  // 2. Look for text/plain in any level
  const queue: GmailPayload[] = [...payload.parts]
  while (queue.length) {
    const part = queue.shift()!
    if (part.body?.data && (part as any).mimeType === "text/plain") {
      return decodeBase64Url(part.body.data)
    }
    if (part.parts && part.parts.length) queue.push(...part.parts)
  }

  // 3. Fallback: first text/html we can find, convert to clean plain text
  const htmlQueue: GmailPayload[] = [...payload.parts]
  while (htmlQueue.length) {
    const part = htmlQueue.shift()!
    if (part.body?.data && (part as any).mimeType === "text/html") {
      const html = decodeBase64Url(part.body.data)
      return htmlToText(html, { wordwrap: false }).trim()
    }
    if (part.parts && part.parts.length) htmlQueue.push(...part.parts)
  }

  return ""
}

interface GmailPayload {
  headers?: Array<{ name: string; value: string }>
  body?: { data?: string }
  parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: GmailPayload[] }>
}

interface GmailMessage {
  id: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  payload?: GmailPayload
  internalDate?: string
}

async function gmailFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GMAIL_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Gmail API ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

/** List message IDs (optional q e.g. "after:2025/1/1"). */
async function listMessages(accessToken: string, options: { maxResults?: number; q?: string; pageToken?: string } = {}): Promise<{ messages: Array<{ id: string; threadId?: string }>; nextPageToken?: string }> {
  const params = new URLSearchParams()
  params.set("maxResults", String(options.maxResults ?? 100))
  if (options.q) params.set("q", options.q)
  if (options.pageToken) params.set("pageToken", options.pageToken)
  const data = (await gmailFetch<{ messages?: Array<{ id: string; threadId?: string }>; nextPageToken?: string }>(
    accessToken,
    `/messages?${params.toString()}`
  )) as { messages?: Array<{ id: string; threadId?: string }>; nextPageToken?: string }
  return { messages: data.messages ?? [], nextPageToken: data.nextPageToken }
}

/** Get full message. */
async function getMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  return gmailFetch<GmailMessage>(accessToken, `/messages/${messageId}?format=full`)
}

function parseDate(dateStr: string | null): Date | null {
  if (!dateStr) return null
  const d = new Date(dateStr)
  return isNaN(d.getTime()) ? null : d
}

/** Upsert one message into gmail_synced_messages. */
async function upsertMessage(msg: GmailMessage): Promise<void> {
  await ensureGmailSchema()
  const payload = msg.payload
  const from = getHeader(payload?.headers, "From")
  const to = getHeader(payload?.headers, "To")
  const subject = getHeader(payload?.headers, "Subject")
  const dateHeader = getHeader(payload?.headers, "Date")
  const dateSent = parseDate(dateHeader) ?? (msg.internalDate ? parseDate(msg.internalDate) : null)
  const bodyPlain = payload ? extractPlainBody(payload) : ""
  const labels = JSON.stringify(msg.labelIds ?? [])

  await query(
    `INSERT INTO gmail_synced_messages (message_id, thread_id, from_email, to_emails, subject, date_sent, snippet, body_plain, labels, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
     ON CONFLICT (message_id) DO UPDATE SET
       thread_id = EXCLUDED.thread_id,
       from_email = EXCLUDED.from_email,
       to_emails = EXCLUDED.to_emails,
       subject = EXCLUDED.subject,
       date_sent = EXCLUDED.date_sent,
       snippet = EXCLUDED.snippet,
       body_plain = EXCLUDED.body_plain,
       labels = EXCLUDED.labels,
       synced_at = NOW()`,
    [
      msg.id,
      msg.threadId ?? null,
      from ?? null,
      to ?? null,
      subject ?? null,
      dateSent,
      msg.snippet ?? null,
      bodyPlain.slice(0, 500000), // cap size
      labels,
    ]
  )
}

/** Run sync: fetch recent messages and store in DB. Optionally pass q (e.g. "after:2025/2/1") and maxMessages. */
export async function runGmailSync(options: { q?: string; maxMessages?: number } = {}): Promise<{ synced: number; errors: number }> {
  const maxMessages = options.maxMessages ?? 200
  let synced = 0
  let errors = 0

  const accessToken = await getValidGmailAccessToken("inbox")
  let pageToken: string | undefined
  const seenIds = new Set<string>()

  do {
    const { messages, nextPageToken } = await listMessages(accessToken, {
      maxResults: Math.min(100, maxMessages - seenIds.size),
      q: options.q,
      pageToken,
    })
    pageToken = nextPageToken

    for (const m of messages) {
      if (seenIds.has(m.id)) continue
      if (seenIds.size >= maxMessages) break
      seenIds.add(m.id)
      try {
        const full = await getMessage(accessToken, m.id)
        await upsertMessage(full)
        synced++
      } catch (err) {
        log("gmail.sync.message_error", { messageId: m.id, error: err instanceof Error ? err.message : String(err) }, "gmail")
        errors++
      }
    }
  } while (pageToken && seenIds.size < maxMessages)

  log("gmail.sync.done", { synced, errors }, "gmail")
  return { synced, errors }
}
