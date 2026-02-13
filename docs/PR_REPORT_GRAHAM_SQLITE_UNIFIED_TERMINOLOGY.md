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

8. Shared `ValueSet/$validate-code` crash fix:
- fixed missing `messages` propagation in exclude-branch `checkConceptSet(...)` call in `tx/workers/validate.js`
- removes `undefined.push` crash path observed in sampled replay

9. SNOMED display text alignment with main behavior:
- SNOMED importer now derives `concept.display` as first active designation in source order (`designation_id ASC`)
- metadata now documents this in `runtime.designations.primaryDisplay`
- reduces FSN-heavy display drift in sampled validation responses

## 4. Results

## 4.1 Correctness

Mini official terminology subset (R4) with all-sqlite config:

- total: 54
- raw: 42 pass / 12 fail
- xfail: 10
- effective: 52 pass / 2 fail

The 2 non-xfail failures are SNOMED `xsct` version-fixture scope issues (`20250814`) not loaded in this focused all-sqlite config.

Post-fix verification rerun (after crash/display changes):
- artifact: `captured/official-term-mini-results-r4.all-sqlitev0-20260213-postdisplayfix.json`
- effective result unchanged: `52 pass / 2 fail`
- interpretation unchanged: both failures remain fixture-version scope (`xsct`) rather than runtime crash/behavior regressions

Sampled replay (180 requests each):

- SNOMED: 143 intended-pass / 37 intended-fail
- LOINC: 163 intended-pass / 17 intended-fail
- RxNorm: 161 intended-pass / 19 intended-fail

Most intended-fail rows are attributable to harness scope/input constraints (R5 endpoints excluded, missing request bodies in capture, external ValueSets not loaded, etc.), not core runtime defects.

Additional SNOMED replay verification after latest fixes:
- artifact: `captured/snomed-replay-allsqlite-v0-20260213-postdisplayfix.json`
- no server `500` responses observed
- remaining intended-status mismatches were primarily:
  - external CTS ValueSet URLs not locally resolvable in focused config (`200 -> 422`)
  - replay-input quality defects (`requestBodyMissing` / `requestBodyParseError` -> `415`)
  - small `400` vs `422` error-class differences

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

Performance was re-run with the sampled harness comparing `main` vs this branch (`generic-sqlite-provider`) using current code after the iterator/bulk-lookup optimization passes.

Run shape:
- sampled NDJSON per terminology (180 requests each)
- repeats: `6`
- warmup: `1`
- both expansion-cache modes (`on` and `off`)
- target endpoint: `/r4`

Artifacts:
- SNOMED:
  - `captured/perf-snomed-main-vs-generic-20260213h.json` (cache on/off)
- LOINC:
  - `captured/perf-loinc-main-vs-generic-20260213h.json` (cache on/off)
- RxNorm:
  - `captured/perf-rxnorm-main-vs-generic-20260213h.json` (cache on/off)

### Overall timing table (current)

| Vocabulary | Cache | Main p50 ms | Main p95 ms | Main mean ms | Main max ms | Branch p50 ms | Branch p95 ms | Branch mean ms | Branch max ms | Branch faster queries |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SNOMED | on | 1.504 | 5.424 | 6.687 | 770.464 | 2.079 | 8.383 | 3.294 | 47.523 | 41 / 180 |
| SNOMED | off | 1.289 | 4.810 | 7.853 | 1071.855 | 1.777 | 7.381 | 2.882 | 48.263 | 38 / 180 |
| LOINC | on | 3.139 | 45.741 | 7.733 | 143.219 | 1.292 | 4.415 | 2.885 | 64.279 | 177 / 180 |
| LOINC | off | 1.960 | 28.817 | 5.087 | 125.875 | 1.451 | 7.029 | 3.322 | 103.865 | 135 / 180 |
| RxNorm | on | 0.985 | 2.265 | 1.174 | 7.061 | 1.189 | 6.597 | 2.101 | 53.907 | 40 / 180 |
| RxNorm | off | 0.733 | 1.403 | 0.847 | 5.656 | 0.860 | 3.592 | 1.383 | 13.948 | 32 / 180 |

### Operation-level p50 delta summary (branch minus main, uncached)

| Vocabulary | Operation | Requests | Median p50 delta ms | Interpretation |
|---|---|---:|---:|---|
| SNOMED | `ValueSet/$validate-code` | 83 | +0.343 | slightly slower |
| SNOMED | `CodeSystem/$validate-code` | 73 | +0.348 | slightly slower |
| SNOMED | `ValueSet/$expand` | 18 | +0.180 | near parity |
| SNOMED | `ValueSet/$batch-validate-code` | 4 | +2.943 | slower |
| LOINC | `ValueSet/$validate-code` | 100 | -0.440 | faster |
| LOINC | `CodeSystem/$validate-code` | 66 | -0.481 | faster |
| LOINC | `ValueSet/$expand` | 12 | +0.581 | slightly slower |
| RxNorm | `CodeSystem/$validate-code` | 154 | +0.134 | near parity |
| RxNorm | `ValueSet/$validate-code` | 14 | -0.035 | parity |
| RxNorm | `ValueSet/$expand` | 12 | +9.121 | slower (`_incomplete` pattern) |

### Largest remaining main wins (uncached)

1. SNOMED:
- `d1ccb6e6...` (`ValueSet/$expand` medication-codes with text filter): `+17.254ms`
- batch-validate paths: ~`+6.46ms` to `+4.25ms`

2. LOINC:
- `6d4753d3...` (`$expand?_limit=1000&_incomplete=true`): `+31.455ms`
- `2bda54c4...` (`$expand?_limit=1000&_incomplete=true`): `+24.084ms`
- `227d1960...` (`POST $expand`): `+21.460ms`

3. RxNorm:
- `_limit=1000&_incomplete=true` expand group: ~`+9.1ms` to `+10.8ms`

Interpretation:
- LOINC remains strongly improved in the sampled set. Branch p50/p95 are better than `main` in both cache modes; largest residual gaps are a small number of `_incomplete`/large-expand patterns.
- SNOMED remains close but slower on p50 in this sampled set, while avoiding the very large max outliers seen in `main` during uncached runs.
- RxNorm remains close on validate paths; remaining gap is concentrated in `_incomplete` expand patterns.

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
