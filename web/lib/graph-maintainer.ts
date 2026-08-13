/**
 * Async graph maintainer: proposes entity_aliases rows from ambiguous movements (LLM + closed-world entities).
 * Suggestions are stored as pending until approved via API (never auto-writes entity_aliases).
 */

import { query, ensureMovementsSchema } from "./db"
import { log } from "./logger"
import { normalizeForMatch } from "./alias-normalize"
import { scrubMovementText } from "./text-cleaner"
import { searchEntityContextFromSupermemory } from "./supermemory"

const OPENAI_MODEL = process.env.OPENAI_COMPANY_CONTEXT_MODEL ?? "gpt-4o"

async function supermemoryForGraphMaintainer(userId: string, searchQuery: string): Promise<string> {
  if (process.env.SUPERMEMORY_ON_EVERY_LLM === "false" || !searchQuery.trim()) return ""
  if (!process.env.SUPERMEMORY_API_KEY) return ""
  try {
    return await searchEntityContextFromSupermemory(userId, searchQuery.slice(0, 500))
  } catch {
    return ""
  }
}

export type GraphMaintainerResult = {
  candidates_scanned: number
  llm_batches: number
  suggestions_inserted: number
  skipped_duplicate: number
  errors: number
}

function fingerprint(raw: string | null, counterparty: string | null): string {
  const scrubbed = scrubMovementText(raw ?? "", counterparty ?? "")
  return normalizeForMatch(scrubbed) || normalizeForMatch(`${raw ?? ""}|${counterparty ?? ""}`)
}

export async function runGraphMaintainer(
  userId: string,
  options?: { candidateLimit?: number; minConfidence?: number },
): Promise<GraphMaintainerResult> {
  const candidateLimit = Math.min(80, Math.max(1, options?.candidateLimit ?? 40))
  const minConf = options?.minConfidence ?? 0.45

  const result: GraphMaintainerResult = {
    candidates_scanned: 0,
    llm_batches: 0,
    suggestions_inserted: 0,
    skipped_duplicate: 0,
    errors: 0,
  }

  await ensureMovementsSchema()
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    log("graph_maintainer.skip_no_api_key", { userId }, "movements")
    return result
  }

  const { rows: candidates } = await query<{
    id: string
    raw_description: string | null
    counterparty: string | null
    movement_type: string
    counterparty_entity_id: string | null
    review_needed: boolean
    date: string
  }>(
    `SELECT id, raw_description, counterparty, movement_type, counterparty_entity_id, review_needed, date
     FROM movements
     WHERE user_id = $1
       AND (
         counterparty_entity_id IS NULL
         OR (
           review_needed = true
           AND (
             movement_type LIKE 'unknown%'
             OR movement_type LIKE '%unresolved%'
             OR movement_type LIKE '%candidate%'
           )
         )
       )
     ORDER BY date DESC
     LIMIT $2`,
    [userId, candidateLimit],
  )

  result.candidates_scanned = candidates.length
  if (candidates.length === 0) {
    log("graph_maintainer.no_candidates", { userId }, "movements")
    return result
  }

  // Dedupe by fingerprint — one representative movement per fingerprint
  const byFp = new Map<string, (typeof candidates)[0]>()
  for (const c of candidates) {
    const fp = fingerprint(c.raw_description, c.counterparty)
    if (!fp || fp.length < 4) continue
    if (!byFp.has(fp)) byFp.set(fp, c)
  }

  const unique = Array.from(byFp.values())
  if (unique.length === 0) return result

  const { rows: entities } = await query<{ id: string; canonical_name: string; entity_type: string }>(
    `SELECT id, canonical_name, entity_type FROM entities WHERE user_id = $1 ORDER BY canonical_name`,
    [userId],
  )

  const entityLines = entities.map((e) => `- ${e.id} | ${e.entity_type} | ${e.canonical_name}`).join("\n")
  const batchSize = 12

  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize)
    result.llm_batches++

    const numbered = batch
      .map((c, j) => {
        const desc = `${c.raw_description ?? ""}`.slice(0, 400)
        const cp = `${c.counterparty ?? ""}`.slice(0, 120)
        return `${j + 1}. movement_id=${c.id} type=${c.movement_type} | desc: ${desc} | counterparty: ${cp}`
      })
      .join("\n")

    const systemPrompt = `You map bank transaction text to existing business entities OR propose a new entity.

Known entities (pick entity_id ONLY from this list, or null):
${entityLines.length > 0 ? entityLines : "(no entities yet — you may only propose create_new_entity)"}

Rules:
- Return JSON array only. Each element:
  {"index": 1, "entity_id": "<uuid from list or null>", "create_new_entity": false, "canonical_name_hint": null, "suggested_entity_type": "vendor"|"customer"|"processor"|"unknown", "alias": "short string to add as merchant_string alias", "confidence": 0.0-1.0, "rationale": "one sentence"}
- If a clear match exists, set entity_id and create_new_entity false.
- If no match but the counterparty is identifiable, set create_new_entity true and canonical_name_hint to the best business/person name (not the raw ACH blob).
- alias must be a substring or normalized form useful for future string matching (e.g. "ACME CORP" not the full 200-char description).
- If completely ambiguous, return entity_id null, create_new_entity false, confidence under 0.3.

Output ONLY valid JSON array. No markdown.`

    const sm = await supermemoryForGraphMaintainer(userId, `${entityLines.slice(0, 300)}\n${numbered}`)
    const systemWithMemory = sm ? `${systemPrompt}\n\n${sm}` : systemPrompt

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: systemWithMemory },
            { role: "user", content: `Propose alias links:\n${numbered}` },
          ],
          max_tokens: 2048,
          temperature: 0.05,
        }),
      })

      if (!res.ok) {
        result.errors++
        log("graph_maintainer.llm_error", { status: res.status, userId }, "movements")
        continue
      }

      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content ?? ""
      const jsonStr = content.replace(/```json?\s*/gi, "").replace(/```/g, "").trim()
      const parsed = JSON.parse(jsonStr) as Array<{
        index: number
        entity_id: string | null
        create_new_entity?: boolean
        canonical_name_hint?: string | null
        suggested_entity_type?: string | null
        alias?: string
        confidence?: number
        rationale?: string
      }>

      if (!Array.isArray(parsed)) continue

      for (const p of parsed) {
        const idx = (p.index ?? 1) - 1
        if (idx < 0 || idx >= batch.length) continue
        const mov = batch[idx]
        const conf = Math.min(1, Math.max(0, p.confidence ?? 0))
        if (conf < minConf) continue

        const alias = (p.alias ?? "").trim()
        if (alias.length < 2 || alias.length > 512) continue

        const fp = fingerprint(mov.raw_description, mov.counterparty)
        const createNew = Boolean(p.create_new_entity)
        const suggestedEntityId: string | null =
          p.entity_id && entities.some((e) => e.id === p.entity_id) ? p.entity_id : null
        let entityIdForRow: string | null = suggestedEntityId
        if (createNew && entityIdForRow) entityIdForRow = null
        if (!createNew && !entityIdForRow) continue
        if (createNew && !(p.canonical_name_hint ?? "").trim()) continue

        const hint = (p.canonical_name_hint ?? "").trim()

        try {
          const { rows: dup } = await query<{ id: string }>(
            `SELECT id FROM entity_alias_suggestions
             WHERE user_id = $1 AND raw_fingerprint = $2 AND status = 'pending' LIMIT 1`,
            [userId, fp],
          )
          if (dup.length > 0) {
            result.skipped_duplicate++
            continue
          }

          await query(
            `INSERT INTO entity_alias_suggestions (
              user_id, movement_id, raw_fingerprint, suggested_entity_id, suggested_alias,
              alias_type, confidence, rationale, status, source,
              canonical_name_hint, create_new_entity, suggested_entity_type
            ) VALUES ($1, $2, $3, $4, $5, 'merchant_string', $6, $7::jsonb, 'pending', 'llm_graph_maintainer', $8, $9, $10)`,
            [
              userId,
              mov.id,
              fp,
              entityIdForRow,
              alias,
              conf,
              JSON.stringify({ rationale: p.rationale ?? "", batch_index: p.index }),
              createNew ? hint : null,
              createNew,
              p.suggested_entity_type ?? "unknown",
            ],
          )
          result.suggestions_inserted++
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes("duplicate") || msg.includes("unique") || msg.includes("idx_entity_alias")) {
            result.skipped_duplicate++
          } else {
            result.errors++
            log("graph_maintainer.insert_error", { userId, error: msg }, "movements")
          }
        }
      }
    } catch (err) {
      result.errors++
      log("graph_maintainer.batch_error", { userId, error: err instanceof Error ? err.message : String(err) }, "movements")
    }
  }

  log("graph_maintainer.done", { userId, ...result }, "movements")
  return result
}
