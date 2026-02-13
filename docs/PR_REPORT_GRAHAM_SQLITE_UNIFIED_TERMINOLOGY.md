# PR Report: Unified SQLite Terminology Runtime (SNOMED / LOINC / RxNorm)

Date: 2026-02-13  
Branch: `generic-sqlite-provider`

## 0. Executive summary

1. SNOMED/LOINC/RxNorm are running from a shared SQLite format with closure + FTS and runtime-driven `runtime.*` metadata.
2. Rebuild-from-raw was repeated end-to-end on 2026-02-13; measured times/sizes are recorded here and in `captured/sqlite-rebuild-20260213-summary.json`.
3. Filenames/config were normalized to `.v0.db` for consistency (`sample-all-sqlite-v0.yml` and related docs updated).
4. Post-rebuild mini official terminology run remains stable at `52/54` effective pass with the same two SNOMED `xsct`-fixture-dependent failures.

## 1. Scope and intent

This report summarizes a clean-start `generic-sqlite-provider` effort from `upstream/main` to support SNOMED, LOINC, and RxNorm through a consistent SQLite format and a metadata-driven runtime path.

This report is intended to show:

1. What was built.
2. How it behaves versus current mainline behavior.
3. Where it is better, where it is worse, and why.
4. What changes are DB-specific vs core pipeline behavior.

## 1.1 Key code changes (concise)

1. Generic SQLite loader/runtime path:
- `tx/library.js` now routes sqlite sources through the generic runtime factory path.
- legacy terminology-specific loader branching was removed.

2. Minimal-specialization model:
- behavior selection is metadata/tag-driven in `cs_config` (`runtime.behaviorFlags.tags`).
- specialization registration is centralized (`tx/cs/cs-sqlite-v0-specializers.js`), rather than hardcoded loader branches.

3. Legacy terminology classes/importers removed:
- legacy SNOMED/LOINC/RxNorm runtime classes and non-sqlite import modules were removed.
- sqlite-v0 importers are now the maintained path for these vocabularies.

4. Optional batched provider capability without breaking existing abstractions:
- `tx/cs/cs-api.js` adds optional `filterPage(filterContext, set, count)` defaulting to `null` (unsupported).
- `tx/workers/expand.js` uses batched iteration when available via `iteratePrimaryFilterSet(...)`.
- fallback remains the existing `filterMore`/`filterConcept` loop, preserving compatibility with providers that do not implement batching.

5. Runtime/provider performance hardening in shared worker path:
- request-scope memoization for code-system provider resolution in `tx/workers/worker.js` (`codeSystemProviderCache`).
- this is abstraction-safe and applies to all providers.

6. Correctness fixes discovered during convergence:
- `searchFilter(...)` argument-order bug fixed in `tx/workers/expand.js`.
- RxNorm sqlite importer corrected to preserve all `RXCUI+TTY` pairs (no single-TTY collapse), enabling correct TTY filters.

## 2. Explicit test configurations used

### A) All-v0 unified SQLite config (new baseline)

File: `tx/fixtures/sample-all-sqlite-v0.yml`

Sources of interest:

- `sqlite-v0!:sct_intl_20250201.v0.db`
- `sqlite-v0:sct_us_20250301.v0.db`
- `sqlite-v0:loinc_281_full.v0.db`
- `sqlite-v0:rxnorm_02022026.v0.db`

Canonical source type is `sqlite-v0`. Alias source types (`snomed-sqlite-v0`, `loinc-sqlite-v0`, `rxnorm-sqlite-v0`) resolve through the same generic sqlite loader path.
`!` marks the default version when multiple versions of the same code system are loaded.

### B) Official-fixture compatibility config used in prior mini-official checks

File: `tx/fixtures/test-cases-loinc-sqlite-v0.yml`

Sources of interest:

- `sqlite-v0:loinc_281_full.v0.db`
- `sqlite-v0!:sct_intl_20250201.v0.db`
- `sqlite-v0:sct_us_20250301.v0.db`

Note: with legacy SNOMED cache loaders removed, this fixture now uses sqlite-v0 SNOMED sources only.

### C) How to run server tests with updated all-v0 YAML

1. Ensure these rebuilt DB files are present in your terminology-cache location:
- `sct_intl_20250201.v0.db`
- `sct_us_20250301.v0.db`
- `loinc_281_full.v0.db`
- `rxnorm_02022026.v0.db`
2. Run the minimal official terminology runner (no Jest/Java pipeline):

```bash
bun scripts/official-terminology-mini-runner.ts \
  --path /r4 \
  --setup tx/fixtures/test-cases-setup-all-sqlite-v0.json \
  --out captured/official-term-mini-results-r4.all-sqlitev0-latest.json
```

## 3. Architecture and modeling choices

### 3.1 Unified SQLite shape

Core schema (`tx/importers/sqlite-v2/schema-v0.sql`) uses shared structures across vocabularies:

- `code_system`
- `concept`
- `designation`
- `property_def`
- `concept_link`
- `concept_literal`
- `value_set`, `value_set_member`
- `closure`
- `cs_config`

### 3.2 Precomputed closure and broad FTS

Importer output includes:

- transitive closure in `closure`
- FTS5 trigram tables:
  - `search_fts_display`
  - `search_fts_designation`
  - `search_fts_literal`

### 3.3 Metadata-driven runtime

Runtime behavior is driven from `cs_config` (`runtime.*`) and schema metadata. This includes hierarchy/filter/search/implicit-ValueSet behavior.

Current metadata policy in this branch is runtime-only keys; legacy duplicate config keys are intentionally not emitted by importers.

Resulting runtime shape:

- generic loader path: `loadSqliteV0(...)` in `tx/library.js`
- generic provider path: `tx/cs/cs-sqlite-runtime-v0.js`
- metadata-tag factory registry in generic runtime:
  - `SqliteRuntimeV0FactoryProvider.registerSpecializedFactory(...)`
  - `SqliteRuntimeV0FactoryProvider.createFromMetadata(...)`
- no terminology-specific branching in the loader
- specialized behavior (when needed) selected by matching `runtime.behaviorFlags.tags`

## 4. Importers and runtime status by vocabulary

- SNOMED: raw RF2 Snapshot importer in use, closure + broad FTS enabled, runtime active.
- LOINC: full importer active, closure + broad FTS enabled, runtime active; implicit `/vs/*` URL semantics are provided by a minimal tag-registered specialized sqlite factory.
- RxNorm: importer/runtime path implemented and tested under all-v0 config; generic runtime provider path.

## 5. File-size comparison (apples-to-apples by vocabulary/version)

Compared `generic-sqlite-provider` SQLite artifacts (closure + FTS) vs corresponding mainline cache DB artifacts used for the same vocabulary/version token.

| Vocabulary | Generic SQLite DB | Main cache DB | Generic SQLite size | Main size | Delta |
|---|---|---|---:|---:|---:|
| SNOMED intl 20250201 | `sct_intl_20250201.v0.db` | `sct_intl_20250201.cache` | 929,325,056 | 861,602,379 | +7.9% |
| LOINC 2.81 | `loinc_281_full.v0.db` | `loinc-2.81-b.db` | 657,887,232 | 887,808,000 | -25.9% |
| RxNorm 02022026 | `rxnorm_02022026.v0.db` | `rxnorm_02022026.db` | 308,232,192 | 214,675,456 | +43.6% |

All three `generic-sqlite-provider` DBs above include closure + FTS tables.

### 5.1 Fresh rebuild verification (2026-02-13)

Fresh imports were rerun from raw source payloads after clearing active generated DBs.

| Vocabulary/version | Source payload | Output DB | Real import time (s) | Output size (bytes) |
|---|---|---|---:|---:|
| SNOMED INT 20250201 | RF2 Snapshot directory | `sct_intl_20250201.v0.db` | 169.956 | 929,325,056 |
| SNOMED US 20250301 | RF2 Snapshot directory | `sct_us_20250301.v0.db` | 166.129 | 941,453,312 |
| LOINC 2.81 | `Loinc_2.81.zip` | `loinc_281_full.v0.db` | 98.762 | 657,887,232 |
| RxNorm 02022026 | `RxNorm_full_02022026.zip` | `rxnorm_02022026.v0.db` | 74.316 | 308,232,192 |

Observations:

1. Runtime metadata keys are now runtime-only (`runtime.*`), no legacy duplicate keys emitted.
2. `runtime.hierarchy.closure.fallbackRecursive` is `false` in all rebuilt DBs.
3. All rebuilt DBs include closure and all three FTS tables (`search_fts_display`, `search_fts_designation`, `search_fts_literal`).
4. RxNorm zip extraction required overriding temp directory due `/tmp` capacity limits during import (`env TMPDIR=/home/jmandel/hobby/tmp ...`).

## 6. Correctness

### 6.1 Official mini runner (terminology-touching subset)

Artifacts:

- `captured/official-term-mini-results-r4.all-sqlitev0-20260213.json`
- `captured/official-term-mini-results-r4.all-sqlitev0-20260213-rerun.json`
- `captured/official-term-mini-results-r4.all-sqlitev0-20260213-postrebuild.json`

All-v0 result (including post-rebuild rerun):

- total: 54
- raw: 42 pass / 12 fail
- xfail: 10 (same upstream-consistent expected-failure set)
- effective: 52 pass / 2 fail

The 2 non-xfail failures are SNOMED tests requiring `xsct 20250814` fixture content:

- `snomed::snomed-inactive-display`
- `snomed::snomed-expand-inactive`

Failure reason is explicit unknown-version (`http://snomed.info/xsct/.../20250814`) in an all-v0 config that intentionally includes only intl/us SQLite SNOMED versions.

Post-loader-refactor and post-rebuild reruns produced the same pass/fail counts and the same two non-xfail failure identities.

Reference compatibility run (with `sct_test_20250814.cache` present):

- `captured/official-term-mini-results-r4.loinc-sqlitev0-afterfix4.json`
- effective 54/54 (with 10 expected xfails)

### 6.2 Sampled real-world replay (all-v0 config)

Artifacts:

- `captured/snomed-replay-allsqlite-v0-20260213.json`
- `captured/loinc-replay-allsqlite-v0-20260213.json`
- `captured/rxnorm-replay-allsqlite-v0-20260213.json`
- `captured/snomed-replay-allsqlite-v0-20260213-rerun.json`
- `captured/loinc-replay-allsqlite-v0-20260213-rerun.json`
- `captured/rxnorm-replay-allsqlite-v0-20260213-rerun.json`

Status-match summary (intended source = `prodStatus`):

| Vocabulary | Total | Intended pass | Intended fail |
|---|---:|---:|---:|
| SNOMED | 180 | 143 | 37 |
| LOINC | 180 | 163 | 17 |
| RxNorm | 180 | 161 | 19 |

Post-loader-refactor rerun produced identical status/pass totals for all three vocabularies (differences only in request timing variance).

RxNorm-specific note versus prior legacy-rxnorm run:

- Previous run: 164/180.
- All-v0 run: 161/180.
- Changed-status rows: 9 total.
- 3 rows improved (`500 -> 422`, intended `422`).
- 6 rows regressed (3 rows `500 -> 422` where intended was `500`; 3 rows `200 -> 400` on `ValueSet/$validate-code` requests carrying a SNOMED `system-version` parameter in an RxNorm coding context).

### 6.3 Intended-status mismatch adjudication (sampled replay)

Classifier script:

- `scripts/classify-replay-intended-failures.js`

Classified artifacts:

- `captured/snomed-replay-allsqlite-v0-20260213-rerun.classified.json`
- `captured/loinc-replay-allsqlite-v0-20260213-fix4.classified.json`
- `captured/rxnorm-replay-allsqlite-v0-20260213-fix4.classified.json`

Combined breakdown across all 64 intended mismatches:

| Category | Count | Interpretation |
|---|---:|---|
| `endpoint_r5_not_enabled` | 20 | Replay run used `/r4` endpoint only; sampled requests included `/r5/*` paths (expected 404 in this harness). |
| `captured_post_body_unparsed_or_missing` | 12 | Captured request had no replayable JSON body (`requestBodyParseError=true` or missing body), so POST replay becomes 415. |
| `external_cts_valueset_not_loaded` | 10 | Requests reference external CTS value sets not present in this isolated all-v0 local stack. |
| `invalid_displayLanguage_english` | 8 | Payload uses `displayLanguage=\"english\"` (invalid token); server returns 400. |
| `upstream_prod_dev_disagree` | 8 | Captured prod/dev statuses already disagree; local status aligns with one side or returns a third code. |
| `too_costly_422_replaces_legacy_500` | 3 | Local runtime returns explicit `VALUESET_TOO_COSTLY` (422) where sampled upstream returned 500. |
| `grammar_code_system_not_enumerable` | 2 | BCP-13 MIME-type grammar cannot be enumerated as a normal code list in these requests. |
| `snomed_module_version_not_loaded` | 1 | Request explicitly asks for SNOMED module/version not loaded in this stack (`83821000000107`). |

Adjudication:

- First 5 categories above are replay-harness/input-scope artifacts, not direct regressions in the core SQLite runtime.
- `grammar_code_system_not_enumerable` is expected from current behavior for grammar-backed systems (e.g. BCP-13 MIME types).
- `snomed_module_version_not_loaded` is expected under the explicit two-SNOMED-version focus config.
- `too_costly_422_replaces_legacy_500` is behavior-improving normalization (typed OperationOutcome instead of generic 500), but remains a status difference.
- Previously observed categories `rxnorm_filter_tty_in_not_supported` and `tx_resource_dependency_not_resolved` were fixed and no longer appear in the current classified replay outputs.

### 6.4 Body-diff audit (main vs generic-sqlite-provider; sampled LOINC/RxNorm)

Artifact: `captured/compare-main-vs-convergence-body-diff-analysis-20260213.v3.json`

Summary:

- compared: 352 requests (LOINC 172, RxNorm 180)
- status-same: 351
- meaningful differences after suppressing timestamp/identifier noise: 2

Meaningful rows:

1. `POST /CodeSystem/$lookup`: main `500`, generic-sqlite-provider `200`.
2. one LOINC expansion concept detail difference (`inactive` flag on a deprecated code).

### 6.5 How to interpret test differences vs main

Differences observed in this report fall into three buckets:

1. Fixture/scope differences:
- e.g. SNOMED `xsct` version-specific tests in all-v0 config without `xsct` content loaded.
2. Behavioral hardening:
- e.g. explicit `422 VALUESET_TOO_COSTLY` instead of generic `500` in some expensive expansion paths.
3. Bug fixes in core pipeline code (not DB-specific):
- `searchFilter` argument-order bug fixed in `tx/workers/expand.js`; this changes outcomes for affected filtered operations.
- `searchFilter` object-shape handling fixed in runtime; prevents failures on valid structured filter inputs.
- sampled body-diff case shows `POST /CodeSystem/$lookup` where main returned `500` and generic-sqlite-provider returned `200`.
- diagnostics quality improved from ambiguous `Filter undefined` traces to explicit property/filter diagnostics.

In short: not all differences are regressions; several are corrections in shared worker/runtime logic.

### 6.6 Concrete RxNorm query delta (works in generic-sqlite-provider, fails in main)

Query shape (R4 `ValueSet/$expand`):

- include system: `http://www.nlm.nih.gov/research/umls/rxnorm`
- include filter: `property=TTY`, `op==`, `value=SBD`
- text filter: `tylenol`

Observed behavior:

1. `main` local run (legacy RxNorm provider path) returns:
- HTTP `500`
- `OperationOutcome.issue[0].diagnostics = "Invalid search filter"`
2. generic-sqlite-provider all-v0 run returns:
- HTTP `200`
- `expansion.total = 13`
- expected active SBD Tylenol products are returned.

Why this changed:

1. Core worker bug fix: `searchFilter` argument order fixed in `tx/workers/expand.js`.
2. RxNorm sqlite importer fix: preserve all `RXCUI+TTY` pairs (instead of collapsing to one TTY per concept), so TTY property filters are semantically correct for multi-TTY concepts.

Parity check for the importer fix (RxNorm 02022026 raw zip vs sqlite-v0 DB):

- distinct `RXCUI+TTY`: source `336,306`, DB `336,306`
- distinct active `RXCUI+TTY`: source `189,814`, DB `189,814`

## 7. Performance

Performance results below are sample-based (captured traffic subset), not exhaustive load/perf characterization.

### 7.1 Sampled SNOMED perf (all-v0 config)

Artifact: `captured/perf-snomed-main-vs-allsqlitev0-20260213.json`

Overall:

- cache on: main p50 1.359ms, generic-sqlite-provider p50 1.661ms
- cache off: main p50 1.165ms, generic-sqlite-provider p50 1.743ms
- compared queries:
  - cache on: generic-sqlite-provider faster 56, main faster 103
  - cache off: generic-sqlite-provider faster 12, main faster 147

Interpretation: with this explicit all-v0 config, SNOMED sampled perf is currently behind main on most sampled requests.

### 7.2 Sampled LOINC perf (all-v0 config)

Artifact: `captured/perf-loinc-main-vs-allsqlitev0-20260213.json`

Overall:

- cache on: main p50 2.557ms, generic-sqlite-provider p50 1.879ms, but generic-sqlite-provider has heavier tail (p95 189ms vs 38.6ms)
- cache off: main p50 2.569ms, generic-sqlite-provider p50 1.95ms, with heavier tail again (p95 245.7ms vs 47.2ms)

Compared queries:

- cache on: generic-sqlite-provider faster 133, main faster 39
- cache off: generic-sqlite-provider faster 116, main faster 56

Interpretation: lower median for many requests, but a small number of slow outliers dominate mean/tail.

### 7.3 Sampled RxNorm perf (all-v0 config)

Artifact: `captured/perf-rxnorm-main-vs-allsqlitev0-20260213.json`

Overall:

- cache on: main p50 1.534ms, generic-sqlite-provider p50 1.346ms
- cache off: main p50 1.479ms, generic-sqlite-provider p50 1.22ms
- generic-sqlite-provider has much lower p95/mean in this run, but statuses differ materially (main has `500` where generic-sqlite-provider returns `422/400` in several paths)

Compared queries:

- cache on: generic-sqlite-provider faster 113, main faster 67
- cache off: generic-sqlite-provider faster 114, main faster 66

Interpretation: better aggregate perf for generic-sqlite-provider in this sample, with semantic/status-shape differences that must be interpreted before treating as strict parity.

## 8. Core-pipeline findings not specific to a single DB

### Fixed in generic-sqlite-provider work (and relevant to test deltas vs main):

1. `searchFilter` call-order bug in `tx/workers/expand.js` (reversed args at several call sites).
2. runtime acceptance of filter object shape in `searchFilter` path (`SearchFilterText` object handling).
3. request-scope memoization in `TerminologyWorker.findCodeSystem()` to reduce repeated provider resolution inside validate/batch-validate flows.

### Found during this work (still important to track explicitly):

1. Expansion-cache key correctness risk: `filter` omitted from hash source, allowing filtered/unfiltered collisions.
2. tx-dev behavior discrepancy (`filter.toLowerCase is not a function`) on some filtered expand requests, reproducible with non-SNOMED examples.
3. Sampled LOINC/RxNorm body-diff audit found one concrete status issue where main returned `500` and generic-sqlite-provider returned `200` for `POST /CodeSystem/$lookup`.
4. Diagnostics quality issue in main traces (`Filter undefined`) appears in sampled runs; generic-sqlite-provider emits explicit property/filter labels instead.

## 9. Trade-offs and current gaps

1. Size trade-off is vocabulary-dependent: SQLite v0 is smaller than main for LOINC, slightly larger for SNOMED intl, larger for RxNorm 02022026.
2. Official SNOMED inactive fixture tests require explicit `xsct` content; all-v0 config intentionally omits it and therefore fails those two tests.
3. LOINC tail latency still needs targeted work despite good median behavior.
4. RxNorm all-v0 replay shows mixed status changes; some are improvements, some are behavior shifts needing explicit acceptance criteria.

## 10. Recommended PR framing

Suggested framing for review:

1. Accept the architecture direction: shared SQLite schema + metadata-driven runtime behavior.
2. Evaluate merge readiness with explicit parity criteria per vocabulary (SNOMED, LOINC, RxNorm).
3. Keep expected-failure cataloging explicit for upstream-consistent fixture drift.
4. Track remaining semantic/performance gaps as follow-up work items, not hidden regressions.
