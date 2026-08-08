# Backend API Audit Report & Fix Plan

## Executive Summary

**Total Endpoints:** 115  
**Critical Issues:** 8  
**High Priority Issues:** 12  
**Medium Priority Issues:** 18  
**Low Priority Issues:** 15  

**Status:** 42 endpoints OK, 58 need fixes, 15 have critical bugs

---

## 🔴 CRITICAL ISSUES TO FIX IMMEDIATELY

### 1. Disabled Cache in Forecast Endpoint
**File:** `app/api/forecast/route.ts` (line 385)
**Issue:** Cache hardcoded to null for debugging
**Fix:** Re-enable cache

### 2. Missing Error Handling in Webhook Handlers
**Files:** 
- `app/api/xero/webhook/route.ts`
- `app/api/quickbooks/webhook/route.ts`
- `app/api/plaid/webhook/route.ts`
**Issue:** Fire-and-forget operations with no retry logic
**Fix:** Add proper error logging and retry mechanism

### 3. Unvalidated Query Parameters
**File:** `app/api/entities/route.ts`
**Issue:** `sortBy` parameter used directly in queries
**Fix:** Whitelist allowed sort fields

### 4. Missing Null Checks
**File:** `app/api/forecast/route.ts` (line 574)
**Issue:** `err.message` accessed without type checking
**Fix:** Add proper error type checking

### 5. Unvalidated Numeric Parameters
**File:** `app/api/entities/route.ts` (line 25)
**Issue:** `minTransactions` can be negative
**Fix:** Add validation: `Math.max(1, minTransactions)`

### 6. Unvalidated Array Length in Batch Operations
**File:** `app/api/movements/explain/batch/route.ts`
**Issue:** No max length validation on arrays
**Fix:** Add max length check (e.g., 100 items)

### 7. Unvalidated Enum Values
**File:** `app/api/movements/override-policy/route.ts`
**Issue:** `override` parameter not validated
**Fix:** Add enum validation

### 8. Missing Null Check Before Array Operations
**File:** `app/api/movements/[id]/detail/route.ts` (line 143)
**Issue:** `movement_type.startsWith()` without null check
**Fix:** Add null check before method call

---

## ⚠️ HIGH PRIORITY ISSUES

1. Inconsistent error response format
2. Missing request body validation
3. Missing type safety in database queries
4. Unhandled edge cases in numeric conversion
5. Missing validation in entity ID parameters
6. Missing error context in catch blocks
7. Unvalidated string trimming
8. Unvalidated JSON stringify
9. Missing timeout on long-running operations
10. Inconsistent authentication check pattern
11. Missing logging in success paths
12. Unvalidated metadata objects

---

## Implementation Plan

**Phase 1 (Critical - This commit):**
- Fix cache re-enabling
- Add input validation helpers
- Fix null checks
- Add error type checking

**Phase 2 (High Priority - Next commit):**
- Standardize error responses
- Add request validation middleware
- Fix webhook error handling

**Phase 3 (Medium Priority - Following commits):**
- Add rate limiting
- Implement request ID tracking
- Add comprehensive logging

---

## Files to Modify

1. `app/api/forecast/route.ts` - Re-enable cache, fix error handling
2. `app/api/entities/route.ts` - Add parameter validation
3. `app/api/movements/explain/batch/route.ts` - Add array length validation
4. `app/api/movements/override-policy/route.ts` - Add enum validation
5. `app/api/movements/[id]/detail/route.ts` - Add null checks
6. `lib/api-utils.ts` - NEW: Create validation helpers
7. `app/api/xero/webhook/route.ts` - Add error handling
8. `app/api/quickbooks/webhook/route.ts` - Add error handling
9. `app/api/plaid/webhook/route.ts` - Add error handling

---

## Success Criteria

- ✅ All critical bugs fixed
- ✅ All endpoints have proper error handling
- ✅ All inputs validated
- ✅ Consistent error response format
- ✅ No unhandled promise rejections
- ✅ All endpoints tested and working
