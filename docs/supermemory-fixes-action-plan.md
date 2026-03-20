# Supermemory Integration Fixes - Action Plan

## Critical Issues Found (13 integration points)

### CRITICAL SEVERITY (Fix Immediately)

#### 1. Fire-and-Forget Patterns in Reconciliation (5 locations)
**Impact**: Pattern cache not being built, reconciliation accuracy degrading over time

**Locations**:
- `reconciliation-fusion-engine.ts:149` - Fast path write-back
- `reconciliation-fusion-engine.ts:260` - Fusion match write-back  
- `reconciliation-waterfall.ts:846` - Direct link write-back
- `reconciliation-waterfall.ts:1144` - Stage 2 write-back
- `reconciliation-waterfall.ts:1233` - Stage 2 partial write-back

**Fix**: Remove `void` and await with error handling
```typescript
// BEFORE
void recordConfirmedBankPattern(userId, entity_id, entityName, bankDesc)

// AFTER
try {
  await recordConfirmedBankPattern(userId, entity_id, entityName, bankDesc)
} catch (err) {
  console.error("[reconciliation] Failed to record bank pattern:", err)
  // Log to monitoring system
}
```

#### 2. Missing customId in storeEntityProfileInSupermemory
**Impact**: Entity profiles duplicate in Supermemory, bloating knowledge base

**Location**: `supermemory-entity-profiles.ts:231`

**Fix**: 
```typescript
// BEFORE
await sm.memories.add({
  content,
  metadata: { type: "entity_reconciliation_profile", entity_id: profile.entity_id, ... },
  containerTags: [tag],
})

// AFTER
await sm.add({
  content,
  customId: `entity_profile_${profile.entity_id}`,
  metadata: { 
    type: "entity_reconciliation_profile", 
    entity_id: profile.entity_id,
    timestamp: new Date().toISOString(),
    version: 1,
  },
  containerTags: [tag],
})
```

#### 3. Inconsistent API Usage
**Impact**: Unpredictable behavior, maintenance burden

**Issue**: `sm.memories.add()` vs `sm.add()` used inconsistently

**Fix**: Standardize to `sm.add()` everywhere

---

### HIGH SEVERITY (Fix Soon)

#### 4. Missing Temporal Metadata in All Writes
**Impact**: Can't track staleness, audit trail missing

**Locations**:
- `supermemory.ts:180` - `addFinalContextToSupermemory`
- `supermemory.ts:208` - `addEntitiesToSupermemory`
- `supermemory.ts:417` - `addEntityProfileToSupermemory`
- `supermemory.ts:456` - `addMerchantOverrideToSupermemory`
- `reconciliation-entity-validator.ts:737` - `recordConfirmedBankPattern`

**Fix**: Add to all metadata objects:
```typescript
metadata: {
  // Existing fields...
  timestamp: new Date().toISOString(),
  user_id: userId,
  version: 1,
  source_function: "functionName",
  // Function-specific fields:
  // - recordConfirmedBankPattern: confirmed_at, confidence_score, match_count
  // - addEntityProfileToSupermemory: profile_version, last_matched_at, success_rate
  // - addEntitiesToSupermemory: entity_count, last_updated
}
```

#### 5. Missing Error Handling in recordConfirmedBankPattern
**Impact**: Failures silently ignored, pattern cache not built

**Location**: `reconciliation-entity-validator.ts:707-754`

**Fix**: Add try-catch with proper logging
```typescript
try {
  await sm.add({
    content,
    customId: `recon_pattern_${safeEntityId}_${safeBankDesc}`.slice(0, 100),
    metadata: {
      type: "reconciliation_bank_pattern",
      entity_id: entityId,
      entity_name: entityName,
      bank_description: bankDescription,
      confirmed_at: new Date().toISOString(),
      confidence_score: 0.95,
      source: "reconciliation",
    },
  })
} catch (err) {
  console.error("[reconciliation-entity-validator] Failed to record bank pattern:", err)
  // Don't throw - reconciliation should continue
}
```

---

### MEDIUM SEVERITY (Fix in Next Sprint)

#### 6. Validate customId Before Use
**Location**: `supermemory.ts:183`

**Issue**: Falls back to `Date.now()` creating new documents instead of updating

**Fix**:
```typescript
const safeId = id?.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)
if (!safeId) {
  throw new Error("customId cannot be empty after sanitization")
}
await client.add({
  content,
  containerTag,
  customId: safeId,
  metadata: { source: "profitwise_final_context", timestamp: new Date().toISOString() },
})
```

#### 7. Add Logging for Search Failures
**Locations**:
- `reconciliation-fusion-engine.ts:488` - `scoreAIBatch`
- `reconciliation-entity-validator.ts:119` - `getMemoryContext`

**Fix**: Log when Supermemory context is unavailable
```typescript
try {
  supermemoryContext = await searchEntityContextFromSupermemory(userId, bankDesc)
} catch (err) {
  console.warn("[fusion-engine] Supermemory context fetch failed, proceeding without context:", err)
  // Log to monitoring: track how often this happens
}
```

#### 8. Standardize Metadata Schema
**Impact**: Inconsistent metadata makes queries unreliable

**Create standard metadata for each operation type**:
```typescript
// Bank Pattern Metadata
{
  type: "reconciliation_bank_pattern",
  entity_id: string,
  entity_name: string,
  bank_description: string,
  confirmed_at: ISO8601,
  confidence_score: 0-1,
  match_count: number,
  last_used: ISO8601,
  source: "reconciliation_fusion" | "reconciliation_waterfall",
}

// Entity Profile Metadata
{
  type: "entity_reconciliation_profile",
  entity_id: string,
  entity_name: string,
  entity_type: "customer" | "vendor",
  timestamp: ISO8601,
  profile_version: number,
  last_matched_at: ISO8601,
  success_rate: 0-1,
  source: "entity_profile_ai",
}

// Entity Metadata
{
  type: "entity_canonical",
  entity_id: string,
  canonical_name: string,
  aliases: string[],
  timestamp: ISO8601,
  entity_count: number,
  last_updated: ISO8601,
  source: "identity_seed",
}
```

---

## Implementation Order

### Phase 1: Critical Fixes (1-2 days)
1. Remove `void` from all `recordConfirmedBankPattern` calls
2. Add `customId` to `storeEntityProfileInSupermemory`
3. Switch to `sm.add()` API

### Phase 2: High Priority (2-3 days)
1. Add temporal metadata to all writes
2. Add error handling to `recordConfirmedBankPattern`
3. Validate customId before use

### Phase 3: Medium Priority (1 week)
1. Add logging for search failures
2. Standardize metadata schema
3. Add monitoring for Supermemory availability

---

## Testing Strategy

### Unit Tests
- Test `recordConfirmedBankPattern` with Supermemory unavailable
- Test `storeEntityProfileInSupermemory` idempotency (same customId)
- Test metadata validation

### Integration Tests
- Run reconciliation with Supermemory mocked as unavailable
- Verify pattern cache is built after successful reconciliation
- Verify duplicate profiles are not created

### Monitoring
- Track Supermemory API latency
- Track pattern cache hit rate
- Track reconciliation accuracy over time (should improve as patterns accumulate)

---

## Files to Modify

1. `reconciliation-fusion-engine.ts` - Remove void from recordConfirmedBankPattern calls
2. `reconciliation-waterfall.ts` - Remove void from recordConfirmedBankPattern calls
3. `reconciliation-entity-validator.ts` - Add error handling, temporal metadata
4. `supermemory-entity-profiles.ts` - Add customId, switch to sm.add()
5. `supermemory.ts` - Add temporal metadata to all calls
6. Create `lib/supermemory-metadata-schema.ts` - Standardized metadata types

---

## Success Metrics

- ✓ All Supermemory writes are awaited (no fire-and-forget)
- ✓ All writes include temporal metadata
- ✓ All writes use customId for idempotency
- ✓ Entity profiles don't duplicate
- ✓ Reconciliation accuracy improves over time as pattern cache grows
- ✓ Supermemory failures don't block reconciliation
