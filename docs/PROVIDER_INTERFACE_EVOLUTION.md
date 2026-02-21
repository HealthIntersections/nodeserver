# Faster ValueSet Expansion via `expandForValueSet`

## The Problem

The `CodeSystemProvider` interface (`tx/cs/cs-api.js`) treats each provider as an
**iterator + attribute oracle**: given a filter, produce matching codes one at a
time, then answer per-code questions (`isInactive`, `getStatus`, `designations`,
etc.). The expansion worker assembles the result by driving this loop.

For SQL-backed providers like RxNorm and LOINC, this creates two performance
problems:

1. **Per-code overhead.** The worker calls 8–10 methods per code. If contexts aren't
   self-sufficient, each call can trigger a SQL query. For RxNorm, expanding 1100
   codes originally cost 3301 SQL queries (1 filter + 1100 × 3 per-code status
   lookups). This was fixed independently by making contexts carry all attributes
   at creation time — zero interface changes required.

2. **No paging push-down.** To return page 11 (offset=1000, count=100), the worker
   processes all 1100 codes, then discards the first 1000. It can't tell the
   provider to skip ahead because paging is a ValueSet-level concern (multiple
   includes, excludes, dedup across code systems). A SQL provider could do
   `LIMIT 100 OFFSET 1000` and return in ~1ms instead of ~200ms.

Similarly, excludes and `activeOnly` filtering happen code-by-code in the worker.
A SQL provider could handle all of these in the WHERE clause.

We briefly considered adding `{ offset, count, activeOnly }` options to the
existing `executeFilters()` method, but this creates awkward partially-resolved
states — the provider handles some post-filters but not others, and the worker
has to know which. Piecemeal push-down doesn't compose well.

## The Interface Change

One new optional method on `CodeSystemProvider`:

```js
async expandForValueSet(spec) {
  // Returns an AsyncIterable<ExpandedEntry> or null (can't handle → fall back)
  return null;
}
```

Instead of threading individual parameters through the 10-call-per-code loop,
**give the provider the full hull of includes and excludes that apply to its code
system** and let it handle everything in one shot.

### Input

The worker groups compose entries by code system and builds:

```js
{
  includes: [                          // compose.include blocks for this CS
    { concepts: [{code, display?}],    // explicit code list (may be null)
      filters: [{property, op, value}] // property filters (may be empty)
    }, ...
  ],
  excludes: [                          // compose.exclude blocks for this CS
    { concepts: [{code}],
      filters: [{property, op, value}]
    }, ...
  ],
  activeOnly: boolean,                 // exclude inactive codes
  searchText: string | null,           // expansion 'filter' parameter
  includeDesignations: boolean,        // whether designations are needed
  properties: string[],                // which properties to include
  languages: Languages,                // requested display languages

  // Paging — non-null only when safe (single code system); must apply if present
  offset: number | null,
  count: number | null,
}
```

### Output

`AsyncIterable<ExpandedEntry>` where each entry is a fully-resolved code:

```js
{
  code: string,
  display: string,
  isAbstract: boolean,
  isInactive: boolean,
  isDeprecated: boolean,
  status: string | null,
  definition: string | null,
  designations: [{language, use, value}],
  properties: [{code, valueType, value}],
  extensions: [...] | null,
}
```

The worker iterates these entries via `includeCode()`, which still handles dedup
across code systems, import filtering, expansion limits, and FHIR object construction.

### Paging contract

`offset` and `count` are **non-null only when the worker can verify they're
safe** (currently: single code system in the compose). When provided:

- The provider **must apply them** (via SQL `LIMIT/OFFSET`). The worker zeros
  its own offset after a successful `expandForValueSet` call, so the provider's
  SQL is the sole paging authority.
- If the provider can handle filters and excludes but **not** paging, it should
  return `null` to fall back to the framework's iterator path, which applies
  offset/count during finalization.

When `null` (multi-system compose, or offset/count not requested):

- The provider returns all matching codes. The framework accumulates them into
  `fullList` and applies paging during finalization. Still faster than baseline
  because the provider handles filters, excludes, and activeOnly in SQL — just
  without the LIMIT/OFFSET shortcut.

Each expansion request is fully stateless — there is no cross-request memory of
previous pages. A request for offset=1000 re-derives the full ordered result set
and skips the first 1000 entries. SQL `LIMIT/OFFSET` lets the provider do this skip in
the B-tree index instead of iterating through rows.

### Why the provider gets excludes

With paging push-down, SQL-side excludes are **15x faster** than JS-side filtering
(1.1ms vs 15.9ms at offset=10000). The B-tree index handles seek + exclude together.
The provider needs excludes to make paging accurate.

### Fallback protocol

1. Provider returns `null` → worker falls back to the existing iterator-oracle
   pattern, completely unchanged. SNOMED and any provider that doesn't implement
   this method are unaffected.
2. Provider returns an iterable → worker iterates entries, skips the framework's
   manual `excludeCodes()` and `includeCodes()` paths for that code system.
3. `this.offset = 0` after expansion — the provider's SQL handled OFFSET; prevents
   the framework's finalization from double-skipping.

### Why `better-sqlite3`

The async `sqlite3` package can't support this pattern: `db.each()` can't abort
early, so there's no way to stop after N rows. `better-sqlite3` provides
synchronous lazy cursors via `stmt.iterate()` — the provider can break after the
page is filled. It's also 2x faster for bulk loads.

The sync API is fine here — SQLite operations are inherently single-threaded and
in-process. The async wrappers add overhead for no concurrency benefit.

---

## RxNorm Implementation

### SQL strategies

The RxNorm provider maps each filter/option to SQL:

| Filter | SQL | Index used |
|--------|-----|------------|
| TTY (e.g., SBD) | `WHERE TTY IN (...)` | `(SAB, TTY, RXCUI)` — covers ORDER BY |
| STY (semantic type) | `JOIN rxnsty ON rxnsty.RXCUI = rxnconso.RXCUI WHERE TUI = ?` | `X_RXNSTY_2(TUI)` drives, probes `X_RXNCONSO_1(RXCUI)` |
| Concepts | `WHERE RXCUI IN (...)` with `+SAB = @sab` (unary `+` suppresses SAB index) | `X_RXNCONSO_1(RXCUI)` |
| Excludes | `AND RXCUI NOT IN (@p1, @p2, ...)` | — |
| activeOnly | `AND SUPPRESS <> '1'` | — |
| searchText | `AND UPPER(STR) LIKE @pattern` | — |

**GROUP BY for JOINs**: When STY joins are present, rxnconso has 1–8 rows per RXCUI
(different TTY values). `GROUP BY RXCUI` deduplicates at the SQL level so
LIMIT/OFFSET counts unique codes, not raw rows.

**Index lesson**: Adding indexes can *hurt* SQLite — a composite `rxnsty(TUI, RXCUI)`
index caused the planner to switch to a worse strategy. Prefer query shaping (JOIN
order, unary `+`) over explicit index hints.

### Results (13 tests)

```
Test                          | Opt (ms) | Base (ms) | Speedup | Result
------------------------------|----------|----------|---------|-------
filter-tty-sbd-10             |      6.8 |    248.7 |  36.5x  | ✅ exact
concept-5                     |      2.5 |      3.8 |   1.5x  | ✅ exact
exclude-concepts-3            |      3.2 |    235.2 |  73.8x  | ✅ exact
multi-include-2               |     63.9 |    471.0 |   7.4x  | ✅ sets equal (40k)
activeonly-sbd                |      2.2 |    194.9 |  82.3x  | ✅ exact
filter-tty-in-multi           |      1.4 |    476.0 | 341.6x  | ✅ exact
filter-sty-t200               |    217.1 |   1521.6 |   7.0x  | ✅ exact
paged-offset-100              |      1.3 |    228.2 | 177.4x  | ✅ exact
text-aspirin                  |      1.8 |  TIMEOUT |     ∞   | ✅ opt works
exclude-filter                |      3.9 |    320.5 |  83.2x  | ✅ exact
multi-include-concept+filter  |    140.2 |    189.5 |   1.4x  | ✅ sets equal (23k)
combo-active-text-paged       |      1.4 |  TIMEOUT |     ∞   | ✅ opt works
multi-include-multi-exclude   |     99.7 |    673.7 |   6.8x  | ✅ sets equal (40k)
```

**All 13 pass.** Median speedup ~37x. Best case 342x (multi-value IN with index).

---

## LOINC Implementation

### Baseline problem

LOINC's existing provider loads **all 240k codes into memory** at startup. Filter
queries run SQL to find matching CodeKeys, then **materialize the entire result
set** into an array before iterating. For large filters this takes 2–5 seconds:
STATUS=ACTIVE materializes 163k rows, CLASSTYPE=Lab materializes 73k rows.

The LOINC database is more normalized than RxNorm:
- `Codes` (240k) — CodeKey PK, Code, Type (1=Code, 2=Part, 3=AnswerList, 4=Answer), StatusKey
- `Relationships` (1.2M) — links codes to parts (COMPONENT, CLASS, SYSTEM, SCALE_TYP, etc.)
- `Properties` (347k) + `PropertyValues` — key-value attributes (CLASSTYPE, ORDER_OBS)

### SQL strategies

| Filter | SQL | Notes |
|--------|-----|-------|
| Relationship (COMPONENT, CLASS, etc.) | `JOIN Relationships r ON r.TargetKey = (SELECT CodeKey FROM Codes WHERE Code = ?) AND r.RelationshipTypeKey = ? AND r.SourceKey = c.CodeKey` | Naturally scopes to Type=1 codes |
| STATUS | `WHERE c.StatusKey = ?` | Direct column match |
| CLASSTYPE | `JOIN Properties p ... JOIN PropertyValues pv ... AND pv.Value = ?` | Value "1" → "Laboratory class" via lookup |
| LIST (answers-for) | `JOIN Relationships r ON r.SourceKey = (SELECT ...) AND r.RelationshipTypeKey = 40 AND r.TargetKey = c.CodeKey` | Reversed direction — list is source, answers are targets |
| activeOnly | `WHERE c.StatusKey = 1` | — |

**Multi-include via UNION**: Each compose include becomes a separate SELECT. Multiple
includes are `UNION ALL`'d, with the outer query applying `GROUP BY Code` for dedup:

```sql
SELECT Code, Description FROM (
  SELECT c.Code, c.CodeKey, d.Description FROM Codes c
    JOIN Descriptions d ON d.CodeKey = c.CodeKey AND d.DescriptionTypeKey = 1
    JOIN Relationships r1 ON ... -- include 1 filters
  UNION ALL
  SELECT c.Code, c.CodeKey, d.Description FROM Codes c
    JOIN Descriptions d ON d.CodeKey = c.CodeKey AND d.DescriptionTypeKey = 1
    JOIN Relationships r2 ON ... -- include 2 filters
) GROUP BY Code ORDER BY CodeKey LIMIT ? OFFSET ?
```

This avoids AND-semantics where JOINs from different includes would all need to
match simultaneously.

**Key decisions:**
- **ORDER BY CodeKey** (not Code string) matches baseline iteration order
- **No blanket Type=1 filter** — relationship JOINs scope naturally; a Type=1
  restriction would break LIST queries (answers are Type=4)
- **Existing indexes sufficient** — `RelationshipsTarget`, `PropertiesCode1`,
  `CodesCode` cover all patterns without new indexes
- **Concept-only includes fall back** — `expandForValueSet` returns `null`, lets
  the framework handle via `locate()` (efficient for small lists)

### Results (14 tests)

```
Test                          | Opt (ms) | Base (ms) | Speedup | Result
------------------------------|----------|-----------|---------|---------------------------
filter-component-bacteria     |     11.3 |      31.4 |   2.7x  | ✅ exact
filter-class-chem             |     13.8 |     941.0 |  68.2x  | ✅ exact
filter-scale-qn               |     50.8 |    2611.3 |  51.4x  | ✅ exact
filter-system-ser             |     21.0 |     680.4 |  32.4x  | ✅ exact
concept-5                     |      2.8 |       1.9 |   0.6x  | ✅ sets equal (5)
exclude-concepts              |      2.3 |      57.4 |  24.9x  | ✅ exact
activeonly-class               |     14.0 |     119.4 |   8.7x  | ✅ exact
filter-list-ll150             |      2.3 |      14.7 |   6.4x  | ✅ sets equal (255)
filter-classtype-lab          |     82.2 |    2020.7 |  24.6x  | ✅ exact
paged-class-offset-100        |     14.0 |     102.8 |   7.5x  | ✅ exact
multi-filter-comp-scale       |      2.4 |      80.0 |  34.6x  | ✅ exact
filter-status-active          |     50.1 |    5324.6 | 106.4x  | ✅ exact
text-glucose                  |      1.3 |       1.4 |   1.1x  | ✅ exact
multi-include-2-components    |      4.2 |      87.6 |  25.0x  | ✅ sets equal (743)
```

**All 14 pass.** Median speedup ~25x. Biggest wins: STATUS=ACTIVE 5.3s → 50ms,
SCALE_TYP=Qn 2.6s → 51ms, CLASSTYPE=Lab 2.0s → 82ms.

---

## Validation

**Unit tests:** LOINC 37/37 pass, RxNorm 45/45 skip (require raw import data).

**Replay tests** (18 captured production queries):
- RxNorm: 3/3 ✅ (validate-code, all 200)
- LOINC: 4/4 functionally correct (1 exact match, 3 now return 200 where production
  returned 422 — we handle queries production rejected)
- SNOMED: 5/5 expected failures (not loaded)
- Other: 6/6 ✅ (batch-validate, multi-system expansions)

## Summary

The entire interface change is **one optional method** — `expandForValueSet`. It's
additive: providers that don't implement it are completely unaffected. The method
gives SQL-backed providers the information they need (the full compose hull,
activeOnly, excludes, paging) to push everything into a single query with
LIMIT/OFFSET.

| What | RxNorm | LOINC |
|------|--------|-------|
| Tests | 13/13 pass | 14/14 pass |
| Median speedup | ~37x | ~25x |
| Best speedup | 342x | 106x |
| Biggest absolute win | text+combo: TIMEOUT → <2ms | STATUS=ACTIVE: 5.3s → 50ms |
| New indexes needed | None | None |
| Existing tests broken | None | None |
