/**
 * GCP Cloud Storage backend for QBO and Xero entity data.
 * When GCP_ENTITY_BUCKET is set, entity payloads are stored as JSON files in the bucket
 * instead of Postgres, avoiding schema mismatches (e.g. user_id, payload columns).
 *
 * Paths: accounting/qbo/{realmId}/{entityType}.json, accounting/xero/{tenantId}/{entityType}.json
 * Env: GCP_ENTITY_BUCKET (required), GCP_SERVICE_KEY_JSON (optional, for Heroku) or GOOGLE_APPLICATION_CREDENTIALS
 */

import { Storage } from "@google-cloud/storage"
import { log } from "./logger"

const BUCKET_NAME = process.env.GCP_ENTITY_BUCKET ?? ""
const PREFIX_QBO = "accounting/qbo"
const PREFIX_XERO = "accounting/xero"

let storage: Storage | null = null

function getStorage(): Storage | null {
  if (!BUCKET_NAME) return null
  if (storage) return storage
  try {
    const keyJson = process.env.GCP_SERVICE_KEY_JSON
    if (keyJson) {
      const credentials = JSON.parse(keyJson) as { project_id?: string; [k: string]: unknown }
      storage = new Storage({
        credentials,
        projectId: credentials.project_id ?? undefined,
      })
    } else {
      storage = new Storage()
    }
    return storage
  } catch (e) {
    log("entity_store_gcp.init.failed", { error: e instanceof Error ? e.message : String(e) }, "gcp")
    return null
  }
}

export function isGcpEntityStoreEnabled(): boolean {
  return Boolean(BUCKET_NAME && getStorage())
}

function objectPath(provider: "qbo" | "xero", scopeId: string, entityType: string): string {
  const prefix = provider === "qbo" ? PREFIX_QBO : PREFIX_XERO
  return `${prefix}/${scopeId}/${entityType}.json`
}

function listPrefix(provider: "qbo" | "xero", scopeId: string): string {
  const prefix = provider === "qbo" ? PREFIX_QBO : PREFIX_XERO
  return `${prefix}/${scopeId}/`
}

export type GetEntityIdFn = (item: unknown) => string | null

/**
 * Merge items into existing JSON file for (provider, scopeId, entityType), then upload.
 */
export async function gcpUpsertEntities(
  provider: "qbo" | "xero",
  scopeId: string,
  entityType: string,
  items: unknown[],
  getEntityId: GetEntityIdFn
): Promise<number> {
  const client = getStorage()
  if (!client) return 0
  if (items.length === 0) return 0

  const bucket = client.bucket(BUCKET_NAME)
  const path = objectPath(provider, scopeId, entityType)
  const file = bucket.file(path)

  let existing: unknown[] = []
  try {
    const [buf] = await file.download()
    const parsed = JSON.parse(buf.toString("utf8"))
    existing = Array.isArray(parsed) ? parsed : []
  } catch {
    // no file or invalid JSON => start fresh
  }

  const byId = new Map<string, unknown>()
  for (const item of existing) {
    const id = getEntityId(item)
    if (id) byId.set(id, item)
  }
  let inserted = 0
  for (const item of items) {
    const id = getEntityId(item)
    if (!id) continue
    byId.set(id, item)
    inserted++
  }

  const payload = JSON.stringify(Array.from(byId.values()))
  await file.save(payload, {
    contentType: "application/json",
    metadata: { cacheControl: "private, max-age=60" },
  })

  log("entity_store_gcp.upsert.succeeded", { provider, scopeId, entityType, count: inserted }, "gcp")
  return inserted
}

/**
 * Read entities from GCP. If entityType is set, return only that type; otherwise all types under scope.
 */
export async function gcpGetEntities(
  provider: "qbo" | "xero",
  scopeId: string,
  entityType?: string
): Promise<Record<string, unknown[]>> {
  const client = getStorage()
  if (!client) return {}

  const bucket = client.bucket(BUCKET_NAME)

  if (entityType) {
    const path = objectPath(provider, scopeId, entityType)
    const file = bucket.file(path)
    try {
      const [buf] = await file.download()
      const parsed = JSON.parse(buf.toString("utf8"))
      const arr = Array.isArray(parsed) ? parsed : []
      log("entity_store_gcp.read.succeeded", { provider, scopeId, entityType, count: arr.length }, "gcp")
      return { [entityType]: arr }
    } catch {
      log("entity_store_gcp.read.miss", { provider, scopeId, entityType }, "gcp")
      return { [entityType]: [] }
    }
  }

  const prefix = listPrefix(provider, scopeId)
  const [files] = await bucket.getFiles({ prefix })
  const out: Record<string, unknown[]> = {}
  for (const f of files) {
    const name = f.name
    const match = name.match(/\.json$/)
    if (!match) continue
    const typeName = name.slice(prefix.length, -5) // strip prefix and .json
    if (!typeName) continue
    try {
      const [buf] = await f.download()
      const parsed = JSON.parse(buf.toString("utf8"))
      out[typeName] = Array.isArray(parsed) ? parsed : []
    } catch {
      out[typeName] = []
    }
  }
  const total = Object.values(out).reduce((s, a) => s + a.length, 0)
  log("entity_store_gcp.read.succeeded", { provider, scopeId, total }, "gcp")
  return out
}

/**
 * Delete one entity by id (read file, filter out id, write back).
 */
export async function gcpDeleteEntity(
  provider: "qbo" | "xero",
  scopeId: string,
  entityType: string,
  entityId: string,
  getEntityId: GetEntityIdFn
): Promise<boolean> {
  const client = getStorage()
  if (!client) return false

  const bucket = client.bucket(BUCKET_NAME)
  const path = objectPath(provider, scopeId, entityType)
  const file = bucket.file(path)

  let existing: unknown[] = []
  try {
    const [buf] = await file.download()
    const parsed = JSON.parse(buf.toString("utf8"))
    existing = Array.isArray(parsed) ? parsed : []
  } catch {
    return true
  }

  const filtered = existing.filter((item) => getEntityId(item) !== entityId)
  if (filtered.length === existing.length) return true

  await file.save(JSON.stringify(filtered), {
    contentType: "application/json",
    metadata: { cacheControl: "private, max-age=60" },
  })
  log("entity_store_gcp.delete.succeeded", { provider, scopeId, entityType, entityId }, "gcp")
  return true
}
