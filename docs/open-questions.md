# Open Questions

## Batch Designation Fetching

**Status**: Implemented via `getPrepContext(iterate, params, ...)` — designation hints extracted from `params`  
**Discovered**: 2026-02-21, during v0 query profiling  
**Resolved**: 2026-02-21, batch pre-fetch in `executeFilters()`

### Problem

The worker iterates each included code individually, calling `designations(context)` per code, which runs a separate `SELECT FROM designation WHERE concept_id=?` query for each. For RxNorm SBD+SCD (27K codes), that's 27K individual queries; for SNOMED Clinical Findings (124K codes), 124K queries. This was the dominant cost in large expansions.

The root cause: the worker's `listDisplaysFromProvider()` has a fast path (use `display` from context, no DB) and a full path (call `designations()`, per-code DB query). The fast path requires `workingLanguages` to be truthy. When no language header is sent (the default), every code takes the full path.

### Solution

Added designation hint extraction to `getPrepContext()` — when the worker passes `params` (TxParameters), the v0 provider reads `params.includeDesignations`, `params.workingLanguages()`, and `params.designations` to determine what designation data will be needed during iteration. The provider batch-fetches all designations in one query (batched in chunks of 500) and attaches them to the filter set. During iteration, `designations()` reads from the pre-fetched data instead of hitting the DB.

### Results

| Query | Before (per-code DB) | After (batch) | Speedup |
|-------|---------------------|---------------|---------|
| RxNorm SBD (9.7K codes) | ~2.2s | 0.24s | **9x** |
| RxNorm SBD+SCD (27K codes) | ~7s | 0.53s | **14x** |
| SNOMED Clinical Findings (124K codes) | ~7s | 2.4s | **3x** |

## Worker-to-Provider Limit Passdown

**Status**: Implemented  
**Discovered**: 2026-02-21, during v0 query profiling  
**Resolved**: 2026-02-21, expanded LIMIT passdown to all providers

### Problem

The worker's `getPrepContext(iterate, offset, count)` only passed offset/count when `vsInfo.csDoOffset` was true — which required the ValueSet to be "simple" (single code system). Cross-system ValueSets never got LIMIT, so providers fetched all matching rows even when the client asked for 10.

### Solution

Changed the gate from `vsInfo.csDoOffset` (only true for simple single-CS ValueSets) to `cs.handlesOffset()` (true for any provider that supports offset/count). Per-CS LIMIT is safe for cross-system ValueSets because excludes are system-scoped — an exclude on system B can't drain results from system A. The worker's overall count management handles cross-system totals.

### Result

Cross-system ValueSet expansion (e.g., RxNorm + LOINC include) dropped from ~1800ms to ~21ms (85x faster) with `count=10`.

## Active vs Inactive Concepts in v0 Databases

**Status**: Resolved  
**Discovered**: 2026-02-21, during v0 vs upstream baseline comparison  
**Resolved**: 2026-02-22

### What works now

All three importers import inactive concepts with `active=0`:
- **RxNorm**: Suppressed atoms (SUPPRESS='O'|'E') → `active=0`. Non-suppressed → `active=1`. Archived/merged concepts imported from RXNATOMARCHIVE as `active=0` leaf nodes.
- **SNOMED**: RF2 `active` column mapped directly. Both active and inactive concepts imported.
- **LOINC**: STATUS column mapped via `isActiveLoincStatus()`. Deprecated/Discouraged → `active=0`.

The v0 provider combines `excludeInactive` (from `ValueSet.compose.inactive=false`) and `params.activeOnly` (from `$expand?activeOnly=true`) in `getPrepContext()`. "Exclude" wins — client can narrow but not widen. Applied as `AND c.active = 1` in SQL.

### Resolved items

1. **RxNorm archived/merged concepts**: ✅ `importArchivedConcepts()` reads RXNATOMARCHIVE. For each RXCUI not already in `concept` table, inserts as `active=0` with best display. Current test dataset had 0 archive-only RXCUIs (all also in RXNCONSO), but the code handles full-release data where archived RXCUIs are absent from RXNCONSO.

2. **RxNorm STY registered as filterable**: ✅ Added to `runtime.filters.properties.byCode` with `operators: ['=', 'in'], sources: ['literal']` plus lowercase alias. Cross-system STY exclude tests now pass.

3. **SNOMED inactive relationships** (import-snomed-v0.js line 556): ✅ Confirmed matches upstream. The binary importer's `listChildren()` (line 2037) also uses `rel.active && rel.defining` — only active relationships are used for closure. Our `if (!active) continue` is consistent.

## SQLite Effort-Based Query Breaker

**Status**: Open — needs upstream contribution or workaround  
**Discovered**: 2026-02-21, during regex filter implementation

### Problem

A single malicious or pathological query (e.g., a catastrophic-backtracking regex, or a huge cross-join) can block the Node.js event loop indefinitely because better-sqlite3 executes synchronously. There's no way to interrupt a running query from JavaScript once it starts.

### Root Cause

SQLite's C API provides `sqlite3_progress_handler(db, N, callback, context)` which invokes a callback every N virtual machine instructions. If the callback returns non-zero, the statement is interrupted with `SQLITE_INTERRUPT`. This is the standard way to implement query timeouts or effort limits in SQLite.

However, better-sqlite3 does not expose this API. The native C++ addon (`database.cpp`) never calls `sqlite3_progress_handler`.

### Current Mitigation

- REGEXP function has an effort counter (500k evaluation limit) that throws on exceeded
- Row iteration in `executeFilters()` could add a row-count cap

### Proper Solution

Contribute a PR to [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) exposing `sqlite3_progress_handler` — e.g., `db.setProgressHandler(stepInterval, callback)`. This would allow:

```js
const MAX_STEPS = 10_000_000; // ~10M VM instructions
let steps = 0;
syncDb.setProgressHandler(1000, () => {
  if (++steps > MAX_STEPS) return 1; // interrupt
  return 0;
});
```

### Alternatives

- Use a worker_thread for SQLite queries with a timeout on the main thread
- Fork better-sqlite3 and add `sqlite3_progress_handler` binding
- Switch to a different SQLite binding that exposes it (e.g., `sql.js` via Wasm, but that has its own perf tradeoffs)

## CS Provider Interface Changes Beyond PR #133

**Status**: Documenting — these changes should be proposed upstream  
**Discovered**: 2026-02-21, during v0 provider implementation

### Context

Grahame's PR #133 decomposed the CS provider API into a filter pipeline: `filter()` → `filterExcludeFilters()`/`filterExcludeConcepts()` → `executeFilters()` → `filterMore()`/`filterConcept()`. His updated branch also passes `params` (TxParameters) to `getPrepContext()`, giving the provider access to operation parameters. Our v0 provider builds on this but required additional interface methods. All changes are backward-compatible.

### New Provider Methods

#### 1. `includeConcepts(filterContext, codes: string[])`

**Why**: PR #133 has no way for the provider to know about explicit concept lists from `compose.include[].concept`. The worker handles these in a separate per-code `locate()` loop, completely outside the filter pipeline. This means the provider can't batch-optimize concept lookups (one SQL query vs N).

**What it does**: Records intent to include specific codes. No SQL execution — `executeFilters()` incorporates these as `WHERE code IN (...)` in the combined query.

**Backward compatibility**: The worker checks `typeof cs.includeConcepts === 'function'` before calling. If absent, falls back to the original per-code `locate()` loop.

### Worker Changes

#### Unified concept + filter block

**Why**: PR #133's worker has separate `if (cset.concept)` and `if (cset.filter)` blocks. The provider never sees the complete picture. This prevents the provider from building one optimal query.

**What changed**: When the provider supports `includeConcepts`, the worker creates one prep context and registers all intent (concepts + filters + excludes) before calling `executeFilters()` once. It then iterates concept-list results first (preserving compose ordering + designation merging), then filter results (deduping codes already emitted from the concept list).

**Backward compatibility**: When the provider doesn't support `includeConcepts`, the worker falls back to the original separate-block behavior.

#### Skip `excludeCodes()` when `csDoExcludes` is true

**Why**: The worker's `handleCompose()` iterated all excluded codes individually via `excludeCodes()` → `isExcluded()` per code — even when the provider's `handlesExcludes()` returned true and `filterExcludeFilters()`/`executeFilters()` handled excludes in SQL. For 14k+ excluded codes at ~0.05ms each, this added ~700ms of pure overhead.

**What changed**: When `csDoExcludes` is true, `handleCompose()` skips the `excludeCodes()` iteration. If `filterExcludeFilters()` throws (unsupported exclude), the catch block runs `excludeCodes()` at that point as fallback.

#### LIMIT passdown for cross-system ValueSets

**Why**: PR #133's worker only passes `offset`/`count` to `getPrepContext()` when `vsInfo.csDoOffset` is true — which requires the ValueSet to be "simple" (single code system). Cross-system ValueSets (multiple includes with different systems) never got LIMIT, so every provider fetched its full result set even when the client requested `count=10`.

**What changed**: The gate was changed from `vsInfo.csDoOffset` to `cs.handlesOffset()`. Per-CS LIMIT is safe because excludes are system-scoped (an exclude on system B can't drain results from system A), and the worker's overall count management handles cross-system totals.

**Result**: Cross-system ValueSet expansion dropped from ~1800ms to ~21ms (85x) with `count=10`.

#### Designation batch pre-fetch via `getPrepContext()`

**Why**: The worker's `listDisplaysFromProvider()` calls `designations(context)` per code. For v0 providers this means one DB query per code. The provider had no way to know upfront whether designations would be needed.

**What changed**: Grahame's updated `getPrepContext(iterate, params, excludeInactive, offset, count)` passes the full `TxParameters`. The v0 provider reads `params.includeDesignations`, `params.workingLanguages()`, and `params.designations` to determine designation needs, then `executeFilters()` batch-fetches them.

#### Active-only filtering

The v0 provider combines two sources of "exclude inactive" logic in `getPrepContext()`:
- `excludeInactive` (from `ValueSet.compose.inactive = false`)
- `params.activeOnly` (from `$expand?activeOnly=true`)

Per FHIR semantics, "exclude" wins — the client can narrow but can't widen beyond the ValueSet's rule. The combined flag is applied as `AND c.active = 1` in SQL.

### Summary Table

| Method | PR #133 | Our addition | Why |
|--------|---------|--------------|-----|
| `getPrepContext()` | ✅ (updated signature) | Use `params` for designation hints + `excludeInactive` for active filtering | Subsumes `prepareDesignations()` |
| `filter()` | ✅ | Modified: pure intent, no SQL | Defer all execution to `executeFilters()` |
| `filterExcludeFilters()` | ✅ | Unchanged | — |
| `filterExcludeConcepts()` | ✅ | Unchanged | — |
| `executeFilters()` | ✅ | Modified: builds combined SQL from all intent + batch designation pre-fetch | One query instead of separate materialization |
| `includeConcepts()` | ❌ | New | Provider needs to see concept lists for batch SQL |

## Expansion Size Limits (UPPER_LIMIT / INTERNAL_LIMIT)

**Status**: Open — needs production tuning  
**Changed**: 2026-02-21, raised from 100K to 1M for development/testing

### Background

The worker has three constants that cap expansion size:
- `UPPER_LIMIT_NO_TEXT` — max codes returned when no text filter is provided
- `UPPER_LIMIT_TEXT` — max codes returned with a text filter
- `INTERNAL_LIMIT` — hard internal cap passed to sub-expansions

Upstream had these at 100,000. This blocks legitimate real-world ValueSets like FHIR R4 Clinical Findings (124K codes) and IPS Problems (132K codes) with a `too-costly` error.

We raised all three to 1,000,000 for development to avoid failing on these cases. With our SQL-backed provider and batch designation pre-fetch, 124K codes expand in ~2.4s (down from ~7s before batch designations).

### Questions

1. **What should production limits be?** Options:
   - **Keep 1M**: allows any realistic FHIR ValueSet. Memory concern: 124K codes × ~1KB each ≈ 120MB per response.
   - **Make configurable**: server config or per-request parameter. The FHIR `count` parameter already handles client-side limiting.
   - **Tiered**: higher limit for SQL-backed providers (fast), lower for legacy iterate-based providers (slow).

2. **Should the limit apply to SQL row fetch or only to response size?** Currently the SQL uses `LIMIT` from the `count` parameter, but the worker's `limitCount` check applies to the accumulated `fullList` after iteration. With SQL providers, we could let SQL return all rows and only cap the response.

3. **Memory pressure**: a 1M-code expansion would be ~1GB of JSON. Should we add a memory-based check instead of (or in addition to) a count-based one?
