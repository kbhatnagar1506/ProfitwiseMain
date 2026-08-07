# Supermemory Usage Analysis - Abrupt/Incorrect Patterns

## Key Insight from Documentation
**Supermemory is NOT RAG.** It's a **memory system** that:
- Tracks **temporal context** (when facts became true/invalid)
- Understands **relationships** between entities
- Maintains **user/entity-specific state** (not universal knowledge)
- Evolves over time with updates and extensions

## Current Abrupt/Incorrect Usage Patterns

### 1. **searchEntityContextFromSupermemory() - Treating Memory as RAG**
**Location:** `lib/supermemory.ts:221-260`

**Problem:**
```typescript
const searchRes = await client.search.execute({
  q: merchantStrings.slice(0, 500),
  containerTags: [containerTag],
  limit: 25,
  includeSummary: true,
  chunkThreshold: 0.3,
})
```

- Using `search.execute()` which is **RAG-style semantic search**
- Should be using **memory-specific retrieval** for entity context
- Treating entity knowledge as "find similar text" instead of "what do we know about this entity"

**Correct Approach:**
- Use `client.search.memory()` or memory-specific endpoints
- Query should be entity-focused: "What do we know about [entity]?"
- Should retrieve **memories** (temporal, relational) not just **documents**

---

### 2. **recordConfirmedBankPattern() - Fire-and-Forget Write**
**Location:** `lib/reconciliation-waterfall.ts:842` and `lib/reconciliation-fusion-engine.ts:262`

**Problem:**
```typescript
void recordConfirmedBankPattern(userId, bestMatch.entity_id, entityName, resolvedBankForMove)
```

- Using `void` to fire-and-forget
- Not waiting for confirmation
- Not handling failures
- Not tracking **when** this pattern was confirmed (temporal context)

**Correct Approach:**
- Should create a **memory** with temporal metadata
- Should track: `{ bankDescription, entityId, confirmedAt, confidence }`
- Should use `update` relationships if pattern already exists
- Should handle failures gracefully

---

### 3. **recordConfirmedBankPattern() Implementation - Abrupt Storage**
**Location:** `lib/reconciliation-entity-validator.ts:707-754`

**Problem:**
```typescript
const sm = new Supermemory({ apiKey: process.env.SUPERMEMORY_API_KEY })
sm.add({
  content: `Bank description "${bankDescription}" maps to entity "${entityName}"`,
  containerTags: [getUserFinanceTag(userId)],
  metadata: { entity_id: bestMatch.entity_id, ... }
})
```

- Creating a **new document** every time (not updating existing memory)
- No relationship tracking (should use `extends` or `updates` relationships)
- No temporal metadata (when was this confirmed?)
- No deduplication (same pattern added multiple times)

**Correct Approach:**
- Use `customId` to make it idempotent: `customId: "bank_pattern_${userId}_${entityId}_${hash(bankDescription)}"`
- Use `update` relationship if pattern already exists
- Include temporal metadata: `{ confirmedAt, confidence, source: "reconciliation" }`
- Track pattern evolution over time

---

### 4. **storeEntityProfileInSupermemory() - Abrupt Profile Storage**
**Location:** `lib/supermemory-entity-profiles.ts:212-242`

**Problem:**
```typescript
sm.add({
  content: `Entity Profile: ${entityName}...`,
  containerTags: [getUserFinanceTag(userId)],
  metadata: { entity_id, entity_type, ... }
})
```

- Same issues as #3
- No `customId` for idempotency
- No relationship tracking
- No temporal context

---

### 5. **addEntitiesToSupermemory() - Bulk Dump Without Context**
**Location:** `lib/supermemory.ts:193-216`

**Problem:**
```typescript
await client.add({
  content: entityHints.map(e => `${e.canonical_name}: ${e.aliases.join(", ")}`).join("\n"),
  containerTags: [containerTag],
})
```

- Dumping all entities as a single document
- No individual memory entries for each entity
- No relationship tracking between entities
- No temporal context

**Correct Approach:**
- Create individual **memories** for each entity
- Use `customId: "entity_${userId}_${entityId}"`
- Track relationships: customer → vendor, entity → bank_patterns
- Include metadata: `{ entity_type, canonical_name, aliases, lastUpdated }`

---

### 6. **addFinalContextToSupermemory() - Monolithic Context Dump**
**Location:** `lib/supermemory.ts:176-187`

**Problem:**
```typescript
await client.add({
  content: content, // Entire company context as one blob
  customId: customId,
  containerTags: [getOrgFinanceTag()],
})
```

- Storing entire company context as a single document
- Should be broken into **structured memories**
- No relationship tracking between company facts

---

## Correct Supermemory Architecture for Reconciliation

### Memory Structure (NOT Documents)

```typescript
// 1. Entity Memory (per entity)
{
  customId: "entity_${userId}_${entityId}",
  content: "Entity: Stripe Inc, Type: Payment Processor, Aliases: [STRIPE, STRIPE DEPOSIT]",
  containerTags: [getUserFinanceTag(userId)],
  metadata: {
    entity_id: entityId,
    entity_type: "vendor",
    canonical_name: "Stripe Inc",
    lastUpdated: Date.now(),
    source: "identity_seed"
  }
}

// 2. Bank Pattern Memory (per confirmed pattern)
{
  customId: "bank_pattern_${userId}_${entityId}_${hash(bankDesc)}",
  content: "Bank description 'STRIPE DEPOSIT' maps to entity 'Stripe Inc'",
  containerTags: [getUserFinanceTag(userId)],
  metadata: {
    entity_id: entityId,
    bank_description: "STRIPE DEPOSIT",
    confidence: 0.95,
    confirmedAt: Date.now(),
    source: "reconciliation_fusion"
  }
}

// 3. Reconciliation Decision Memory (per match)
{
  customId: "recon_decision_${userId}_${movementId}_${eventId}",
  content: "Movement $5000 matched to Invoice #123 for Stripe Inc",
  containerTags: [getUserFinanceTag(userId)],
  metadata: {
    movement_id: movementId,
    event_id: eventId,
    entity_id: entityId,
    confidence: 0.92,
    matchedAt: Date.now(),
    source: "reconciliation_fusion"
  }
}
```

### Query Pattern (Memory-First)

```typescript
// Query: "What entities do we know about?"
const entities = await client.search.memory({
  q: "entity",
  containerTags: [getUserFinanceTag(userId)],
  filter: { metadata: { source: "identity_seed" } }
})

// Query: "What bank descriptions map to this entity?"
const patterns = await client.search.memory({
  q: `bank patterns for ${entityId}`,
  containerTags: [getUserFinanceTag(userId)],
  filter: { metadata: { entity_id: entityId, source: "reconciliation_fusion" } }
})

// Query: "What's the latest reconciliation decision for this movement?"
const decision = await client.search.memory({
  q: `reconciliation ${movementId}`,
  containerTags: [getUserFinanceTag(userId)],
  filter: { metadata: { movement_id: movementId } }
})
```

---

## Summary of Issues

| Issue | Current | Correct |
|-------|---------|---------|
| **Search Method** | `search.execute()` (RAG) | `search.memory()` (Memory) |
| **Storage Pattern** | Fire-and-forget `void` | Await + error handling |
| **Idempotency** | No `customId` | Use `customId` for updates |
| **Relationships** | None | Use `update`, `extends`, `derives` |
| **Temporal Context** | Missing | Include `confirmedAt`, `lastUpdated` |
| **Granularity** | Bulk documents | Individual memories |
| **Deduplication** | None | Automatic via `customId` |

---

## Action Items

1. **Replace `search.execute()` with memory-specific queries**
2. **Add `customId` to all Supermemory writes for idempotency**
3. **Include temporal metadata in all memories**
4. **Use relationship types (`update`, `extends`) for pattern evolution**
5. **Break bulk documents into individual memories**
6. **Add proper error handling (remove `void` fire-and-forget)**
7. **Query memories by metadata filters, not just semantic search**
