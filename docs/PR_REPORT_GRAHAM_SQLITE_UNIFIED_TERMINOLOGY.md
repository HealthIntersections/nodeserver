# PR Report: Generic SQLite Provider for SNOMED, LOINC, and RxNorm

Date: 2026-02-13  
Branch: `generic-sqlite-provider`

## 1. Goals

This work had four concrete goals.

1. Move SNOMED, LOINC, and RxNorm onto one consistent SQLite model and runtime path.
2. Keep worker-level compatibility so existing operations can use the new provider without terminology-specific branching.
3. Improve correctness where legacy behavior failed on real requests.
4. Measure trade-offs (correctness, performance, database size) clearly and non-promotionally.

## 2. Approach

The branch uses a single schema + importer/runtime pattern and keeps terminology-specific logic minimal.

1. Unified schema/runtime:
- shared schema (`concept`, `designation`, `property_def`, `concept_link`, `concept_literal`, `closure`, `cs_config`, etc.)
- precomputed closure tables
- broad FTS (`display`, `designation`, `literal`)

2. Metadata-driven behavior:
- runtime behavior encoded in `cs_config` (`runtime.*` keys)
- generic factory/provider reads metadata and executes behavior without loader hardcoding by terminology name
- specialization is tag-driven and optional (`runtime.behaviorFlags.tags`)

3. Compatibility-first worker integration:
- existing worker/provider abstraction remains valid
- optional capability extension added (`filterPage`) for providers that can return batched filter results efficiently
- fallback stays on existing per-item iteration (`filterMore`/`filterConcept`) when batching is unsupported

4. Importers are source-specific; runtime is generic:
- SNOMED, LOINC, RxNorm importers parse their native source formats
- imported output shape is normalized so runtime behavior can be generic

## 3. Major code changes

1. Generic sqlite loading path:
- `tx/library.js` now routes sqlite terminology sources through generic runtime factory logic
- legacy SNOMED/LOINC/RxNorm loader branching removed

2. Legacy terminology classes removed:
- removed legacy runtime classes for SNOMED/LOINC/RxNorm in favor of generic sqlite runtime

3. Legacy import modules removed:
- removed non-sqlite legacy importer modules for SNOMED/LOINC/RxNorm

4. Optional batched provider capability:
- `tx/cs/cs-api.js` optional `filterPage(filterContext, set, count)` method
- `tx/workers/expand.js` uses `filterPage` opportunistically and falls back automatically to existing iteration

5. Shared worker-path hardening:
- request-scope provider memoization in `tx/workers/worker.js` (`codeSystemProviderCache`)

6. Correctness fixes in expand/filter paths:
- `searchFilter(...)` argument-order bug fixed in `tx/workers/expand.js`
- runtime/filter behavior fixes for structured filter handling used in sampled queries

7. RxNorm importer correctness fix:
- no longer collapses to a single TTY per concept
- preserves all distinct `RXCUI + TTY` pairs with active flags

## 4. Results

## 4.1 Correctness

Mini official terminology subset (R4) with all-sqlite config:

- total: 54
- raw: 42 pass / 12 fail
- xfail: 10
- effective: 52 pass / 2 fail

The 2 non-xfail failures are SNOMED `xsct` version-fixture scope issues (`20250814`) not loaded in this focused all-sqlite config.

Sampled replay (180 requests each):

- SNOMED: 143 intended-pass / 37 intended-fail
- LOINC: 163 intended-pass / 17 intended-fail
- RxNorm: 161 intended-pass / 19 intended-fail

Most intended-fail rows are attributable to harness scope/input constraints (R5 endpoints excluded, missing request bodies in capture, external ValueSets not loaded, etc.), not core runtime defects.

## 4.2 Concrete RxNorm behavior improvement

One representative query demonstrates a real improvement.

Query shape:
- `ValueSet/$expand` (R4)
- include `system=http://www.nlm.nih.gov/research/umls/rxnorm`
- include filter `property=TTY`, `op==`, `value=SBD`
- text filter `tylenol`

Observed behavior:

1. `main` (legacy provider path):
- HTTP 500
- `OperationOutcome.diagnostics = "Invalid search filter"`

2. `generic-sqlite-provider`:
- HTTP 200
- `expansion.total = 13`
- returns expected active Tylenol SBD products

Reason this changed:
- worker `searchFilter` call-order fix
- RxNorm importer fix preserving all `RXCUI+TTY` rows (no single-TTY collapse)

Parity check after RxNorm importer fix (source zip vs DB):
- distinct `RXCUI+TTY`: source `336,306`, DB `336,306`
- distinct active `RXCUI+TTY`: source `189,814`, DB `189,814`
- distinct `RXCUI+NDC`: source `253,875`, DB `253,875`

## 4.3 Performance

Performance was measured with sampled traffic harnesses comparing `main` vs this branch.

High-level summary:

1. SNOMED sampled performance remains behind `main` on most requests in this run.
2. LOINC shows better median but heavier tail on some requests.
3. RxNorm shows better aggregate timing in sampled runs, with some status-shape differences that must be interpreted alongside correctness notes.

Artifacts:
- `captured/perf-snomed-main-vs-allsqlitev0-20260213.json`
- `captured/perf-loinc-main-vs-allsqlitev0-20260213.json`
- `captured/perf-rxnorm-main-vs-allsqlitev0-20260213.json`

## 4.4 Database size and import time

Fresh rebuilds were run from raw inputs on 2026-02-13.

- SNOMED INT 20250201: `169.956s`, `929,325,056` bytes
- SNOMED US 20250301: `166.129s`, `941,453,312` bytes
- LOINC 2.81: `98.762s`, `657,887,232` bytes
- RxNorm 02022026: `74.316s`, `308,232,192` bytes

Observed trade-off:
- LOINC DB is smaller than mainline cache equivalent.
- SNOMED and RxNorm DBs are larger than mainline cache equivalents for the compared versions.

## 5. Upstream/main bugs found along the way

The following issues were identified while running real requests and official-test subsets.

1. Filter execution bug in expand path:
- reversed `searchFilter` argument order in affected paths
- manifested as `Invalid search filter` failures on valid requests

2. Generic 500 where typed behavior is preferable:
- some expensive expansions returned generic 500 in sampled behavior, while this branch returns explicit `422 VALUESET_TOO_COSTLY`

3. Mainline failure where branch returns successful response:
- sampled body-diff found a `POST /CodeSystem/$lookup` case with `main=500` and `branch=200`

4. Diagnostics clarity issue:
- ambiguous `Filter undefined` traces in baseline paths
- branch emits explicit property/filter diagnostics in affected flows

## 6. Known gaps and current limitations

1. All-sqlite focus config does not include every SNOMED test fixture edition/version, so two `xsct`-dependent tests remain outside scope in that run.
2. LOINC tail latency needs additional tuning.
3. Some sampled status differences remain and should be adjudicated explicitly as acceptable behavior changes vs regressions.

## 7. How to run the same baseline

Use:
- `tx/fixtures/sample-all-sqlite-v0.yml`
- `tx/fixtures/test-cases-setup-all-sqlite-v0.json`

Run:

```bash
bun scripts/official-terminology-mini-runner.ts \
  --path /r4 \
  --setup tx/fixtures/test-cases-setup-all-sqlite-v0.json \
  --out captured/official-term-mini-results-r4.all-sqlitev0-latest.json
```

## 8. Recommendation

The architecture direction is sound: one generic sqlite runtime path with metadata-driven behavior and minimal optional specialization.

Recommended merge posture:

1. Accept the unified sqlite/provider direction.
2. Keep explicit parity criteria per vocabulary (SNOMED, LOINC, RxNorm).
3. Treat known fixture-scope differences and status-shape differences explicitly, not implicitly.
4. Continue targeted follow-up on SNOMED performance parity and LOINC tail behavior.
