# SQLite Microbenchmark Plan

## Motivation

We're designing a new `expandForValueSet(spec)` method on `CodeSystemProvider`
that lets SQL-backed providers (RxNorm, LOINC, future generic-sqlite) handle
entire include/exclude blocks in a single call. Key design questions:

1. **Lazy vs eager iteration** — should the provider return a lazy iterable
   (cursor-backed) or a materialized array? This determines whether the worker
   can benefit from early termination (stop after offset+count rows).

2. **Package choice** — the codebase uses async `sqlite3` (`db.all()` loads
   everything into memory). `better-sqlite3` offers synchronous `stmt.iterate()`
   with lazy cursors. Is migration worth it?

3. **SQL-level optimizations** — should multi-include ValueSets become one
   UNION/IN query? Should excludes be pushed into SQL? Does LIMIT/OFFSET
   actually help given SQLite's scan behavior?

4. **Cost breakdown** — where is time spent: in SQLite I/O, JS object
   construction, or the async callback overhead?

## Test Database

RxNorm Feb 2025 (`rxnorm_02032025-a.db`, 1.8GB).

Key table: `rxnconso` with indexes on `(SAB, TTY, RXCUI)`.

Representative TTY counts (SAB='RXNORM', TTY<>'SY'):
- SBD: 23,254 rows
- SCD: 39,161 rows
- IN: 14,503 rows

## Benchmarks

### B1: `db.all()` full materialization — baseline

```sql
SELECT RXCUI, STR, SUPPRESS FROM rxnconso
WHERE SAB='RXNORM' AND TTY='SBD'
```

Loads all ~23k rows into a JS array. This is what the current provider does
in `#executeFilter()`. Measures total wall time and peak memory.

**Design question:** What's the floor cost of getting filter results today?

### B2: `db.all()` with LIMIT/OFFSET

Same query + `LIMIT 100 OFFSET N` for N = 0, 100, 1000, 10000.

**Design question:** If we stay on async `sqlite3`, can we push paging to SQL?
Does it actually help, or does SQLite scan to OFFSET anyway?

### B3: `db.each()` with early abort

Same query via `db.each(sql, callback)`. Count rows in the callback; after N
rows, stop processing (check if `db.interrupt()` or completion callback work
for early exit).

**Design question:** Can `db.each()` serve as a lazy iterator with the
current `sqlite3` package? What's the per-callback overhead? Can we abort
early without loading all rows?

### B4: `better-sqlite3` `stmt.iterate()` — lazy cursor

Same query via `better-sqlite3`'s synchronous `stmt.iterate()`. Break out
of the loop after N rows (100, 1100).

**Design question:** How fast is the ideal lazy cursor? Is it worth
migrating packages? Does break actually avoid reading remaining rows?

### B5: `better-sqlite3` `stmt.all()` vs `stmt.iterate()` for full results

Both approaches for the complete ~23k result set. No early termination.

**Design question:** When we need ALL results, does `iterate()` add
per-row overhead vs `all()`?

### B6: `better-sqlite3` prepared statement reuse

Prepare statement once, run `.iterate()` with different TTY params across
multiple calls.

**Design question:** How much does statement compilation cost? Relevant for
the `expandForValueSet` path which would prepare queries once and reuse.

### B7: UNION vs multiple queries vs IN()

- A: `SELECT ... WHERE TTY='SBD' UNION ALL SELECT ... WHERE TTY='SCD'`
- B: Two separate queries, merge arrays in JS
- C: `SELECT ... WHERE TTY IN ('SBD','SCD')`

All return ~62k rows (SBD+SCD).

**Design question:** For multi-include ValueSets (TTY=SBD + TTY=SCD), should
the provider combine into one SQL query? We found IN() was slow for
locateMany (individual RXCUI lookups) — is it also slow for filter-style
queries where the IN set is tiny (2-3 TTY values)?

### B8: NOT IN for excludes

- A: `SELECT ... WHERE TTY='SBD' AND RXCUI NOT IN ('12345','67890',...50 codes)`
- B: `SELECT ... WHERE TTY='SBD'` then filter out 50 codes in JS

**Design question:** Should the provider push excludes into SQL? For small
exclude lists this should be fine, but at what size does NOT IN degrade?

### B9: Row construction cost

Iterate all ~23k SBD rows from `stmt.iterate()`:
- A: Just count rows (no object construction)
- B: Build a minimal JS object per row: `{ code, display, suppress }`
- C: Build a rich object mimicking FHIR expansion entry (code, display,
  system, version, inactive flag, status, designations array)

**Design question:** Where is time actually spent — SQL cursor stepping
or JS object construction? If construction dominates, lazy iteration
saves nothing for offset-skipped rows unless we can also skip construction.

### B10: OFFSET scan cost

`SELECT ... WHERE TTY<>'SY' AND SAB='RXNORM' LIMIT 100 OFFSET N`
for N = 0, 100, 1000, 10000, 50000, 100000.

Uses the full ~250k row result set (all TTYs except SY).

**Design question:** Is SQLite OFFSET O(N)? If so, pushing OFFSET to
SQL only saves JS-side work, not DB scan time.

## Decision Matrix

| Benchmark | Design question |
|-----------|----------------|
| B1 vs B2  | Is LIMIT/OFFSET worth pushing to SQL? |
| B3        | Can we do lazy iteration with current `sqlite3` package? |
| B4 vs B1  | Is `better-sqlite3` migration worth it? |
| B5        | Overhead of lazy iteration when all rows needed? |
| B6        | Statement compilation cost (amortized)? |
| B7        | Merge multi-include into one query? |
| B8        | Push excludes into SQL? |
| B9        | SQL vs JS cost breakdown per row? |
| B10       | OFFSET scan cost — O(1) or O(N)? |

## Expected Outcomes → Interface Design

- If **B4 shows big wins** → migrate to `better-sqlite3`, design around lazy
  iterables, paging push-down becomes "nice to have" not "essential"
- If **B3 is viable** → lazy iteration possible without package migration
- If **B10 shows OFFSET is O(N)** → paging push-down only saves JS object
  construction, not DB work. Still useful but less critical.
- If **B7 shows UNION/IN is efficient** → `expandForValueSet` should merge
  all includes for one CS into a single query
- If **B9 shows JS construction dominates** → the lazy iterable must also
  skip object construction for offset rows (return raw row, let worker decide
  whether to construct)
