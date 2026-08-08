/**
 * Levenshtein edit distance for entity name matching.
 *
 * Used for semantic validation: if two entity names have > 85% similarity,
 * they likely refer to the same entity (name variations, abbreviations, etc.)
 *
 * The normalized similarity score ranges from 0.0 (completely different)
 * to 1.0 (identical strings).
 */

/**
 * Compute Levenshtein edit distance between two strings.
 * O(n*m) with O(min(n,m)) space.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Ensure a is the shorter string for memory efficiency
  if (a.length > b.length) {
    ;[a, b] = [b, a]
  }

  const aLen = a.length
  const bLen = b.length

  let prev = Array.from({ length: aLen + 1 }, (_, i) => i)
  let curr = new Array<number>(aLen + 1)

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[i] = Math.min(
        curr[i - 1] + 1,        // insertion
        prev[i] + 1,            // deletion
        prev[i - 1] + cost      // substitution
      )
    }
    ;[prev, curr] = [curr, prev]
  }

  return prev[aLen]
}

/**
 * Normalized Levenshtein similarity score: 0.0 → completely different, 1.0 → identical.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (!a && !b) return 1.0
  if (!a || !b) return 0.0

  // Distance and the length denominator must be derived from the SAME
  // normalized strings. Measuring distance on trimmed input while dividing by
  // the raw length let trailing whitespace inflate the similarity score.
  const na = a.toLowerCase().trim()
  const nb = b.toLowerCase().trim()
  const maxLen = Math.max(na.length, nb.length)
  if (maxLen === 0) return 1.0

  return 1 - levenshteinDistance(na, nb) / maxLen
}

/**
 * Token Similarity: Jaccard similarity on tokenized words.
 * Handles "SPREAD THE LOVE" vs "Spread the Love Foods" better than pure edit distance.
 */
export function tokenSimilarity(a: string, b: string): number {
  if (!a && !b) return 1.0
  if (!a || !b) return 0.0

  const tokA = new Set(
    a.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
  )
  const tokB = new Set(
    b.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
  )

  if (tokA.size === 0 && tokB.size === 0) return 1.0
  if (tokA.size === 0 || tokB.size === 0) return 0.0

  const intersection = new Set([...tokA].filter((t) => tokB.has(t)))
  const union = new Set([...tokA, ...tokB])
  return intersection.size / union.size
}

/**
 * Combined entity name similarity using both Levenshtein and token overlap.
 * Returns a value 0.0 - 1.0.
 *
 * The threshold for "same entity" is 0.85 by default.
 */
export function entityNameSimilarity(a: string, b: string): number {
  const lev = levenshteinSimilarity(a, b)
  const tok = tokenSimilarity(a, b)
  // Weighted blend: token similarity is more important for partial matches
  return 0.4 * lev + 0.6 * tok
}

/** Returns true if two entity names are likely the same entity (>= threshold). */
export function areSameEntity(
  a: string,
  b: string,
  threshold = 0.85
): boolean {
  if (!a || !b) return false
  // Fast path: case-insensitive exact match
  if (a.toLowerCase().trim() === b.toLowerCase().trim()) return true
  // One contains the other
  const aLow = a.toLowerCase().trim()
  const bLow = b.toLowerCase().trim()
  if (aLow.includes(bLow) || bLow.includes(aLow)) return true
  return entityNameSimilarity(a, b) >= threshold
}

/**
 * Check if bankDescription matches entityName using multi-level similarity.
 * Returns { match: boolean, score: number, method: string }
 */
export function matchEntityName(
  bankDescription: string,
  entityName: string,
  aliases: string[] = [],
  threshold = 0.80
): { match: boolean; score: number; method: string } {
  // Try direct match
  const directScore = entityNameSimilarity(bankDescription, entityName)
  if (directScore >= threshold) {
    return { match: true, score: directScore, method: "direct" }
  }

  // Try against aliases
  for (const alias of aliases) {
    const aliasScore = entityNameSimilarity(bankDescription, alias)
    if (aliasScore >= threshold) {
      return { match: true, score: aliasScore, method: "alias" }
    }
  }

  // Try contains check with reasonable length
  const bankLow = bankDescription.toLowerCase().trim()
  const entityLow = entityName.toLowerCase().trim()
  if (entityLow.length >= 4 && bankLow.includes(entityLow)) {
    return { match: true, score: 0.88, method: "contains" }
  }
  if (entityLow.length >= 4 && entityLow.includes(bankLow)) {
    return { match: true, score: 0.85, method: "contains_reverse" }
  }

  return { match: false, score: directScore, method: "none" }
}
