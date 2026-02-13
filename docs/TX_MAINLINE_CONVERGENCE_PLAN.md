# TX Mainline Convergence Plan

Branch: `tx-mainline-convergence`
Base: `upstream/main`

## Goal
Rebuild the SQLite-backed terminology architecture from a clean `main` baseline while preserving the `main` branch runtime abstractions and behavior contracts.

Primary target systems:
- SNOMED CT
- LOINC
- RxNorm

## Direction (agreed)
- Keep the overall architecture direction from `db-refactor` (SQLite-backed terminology services).
- Redesign the data model and implementation from scratch with current understanding of schema and behavior goals.
- Build importers from raw tx source data into SQLite.
- Ensure runtime compatibility with the abstractions expected by current `main`.
- Drive behavior through configuration and generic code; minimize vocabulary-specific subclasses.
- Allow vocabulary-specific logic only where truly required.

## Near-Term Convergence Decisions (2026-02)
- Implement LOINC property filter parity in the generic SQLite v0 runtime (not in a LOINC-specific query path).
- Keep implicit-URL handling as a minimal metadata-tag-registered specialization over the generic sqlite runtime (no loader special-casing).
- Treat materialized implicit ValueSets as an optimization only:
  - semantics must work without precomputed `value_set` membership rows
  - precomputation may be enabled for latency/cost reasons, but not required for correctness
- Explicitly support real-world LOINC filter patterns seen in extracts/harness:
  - `=` on property-backed literals/concepts (e.g., `CLASSTYPE`, `ORDER_OBS`, `SCALE_TYP`, `STATUS`, `CLASS`)
  - `regex` on selected properties (e.g., `CLASS`)
  - dedicated special-handler filters (e.g., `LIST=LL...`)
- Normalize variant filter values via metadata-declared alias maps (e.g., CLASSTYPE label/numeric forms, case variants such as `Doc`/`DOC`).

## Keep / Evolve / Adjust

### Keep
- SQLite as the storage/runtime backend for terminology operations.
- Importer-driven build pipeline from raw source distributions.
- Strong test/triage loop using official tx ecosystem cases plus targeted local suites.
- Performance-conscious approach (indexes, query plans, pagination discipline, cache safety).

### Evolve
- Configuration-driven behavior model for:
  - display selection and language normalization
  - designation shaping and use mapping
  - property mapping and typing
  - hierarchy/link semantics for expand/subsumes/lookup
  - built-in value set behaviors (where applicable)
- Generic provider class that handles most behavior via config + shared query helpers.
- Provider implementations must satisfy the same operational contracts used by existing providers, so worker operations can treat new and old implementations the same way.

### Adjust
- Rewrite schema and provider internals rather than carrying over implementation debt.
- Reduce ad hoc vocabulary-specific branches in runtime path.
- Separate clearly:
  - canonical data model
  - importer transforms
  - provider query behavior
  - policy/config overlays
- Treat terminology edge semantics as first-class contract tests (not incidental behavior).

## Non-Goals (for first pass)
- Broad API redesign in workers/endpoints.
- Replacing existing `main` abstractions before compatibility is proven.
- Premature optimization without parity evidence.

## Confirmed Decision: Broad Text FTS
- We will ship broad trigram FTS for text filtering across:
  - `concept.display`
  - `designation.term`
  - literal text (`concept_literal.value_text`/`value_raw`)
- We accept larger DB artifacts in exchange for latency wins on representative filter workloads.
- Measured on SNOMED INT `20250201` v0 build:
  - size: `520,146,944` -> `833,286,144` bytes (`+60.2%`)
  - LIKE p50/p95: `782.6ms` / `853.9ms`
  - broad FTS p50/p95: `6.8ms` / `23.6ms`
  - count parity on tested representative terms: `24/24`
- Runtime policy:
  - FTS-first search when configured tables are present
  - LIKE fallback retained for safety/portability

## Hindsight Constraints (from db-refactor and triage work)

### Interface/contract constraints
- Do not introduce a parallel worker path that only new providers can use.
- New provider objects must be consumable through the same worker/provider interaction model used in `main`.
- Preserve semantics before structure: status-class behavior and operation outcomes matter more than exact textual diagnostics.

### Schema constraints
- System/version/provenance must be explicit and queryable (including multi-edition SNOMED behavior).
- Model concept state and designation state separately:
  - concept activity/inactivity
  - designation language/use/type and display preferences
- Property model must support typed values and relationship-like links used by lookup/expand filters.
- Expansion model must support paged responses where `count`/`offset` exist and `total` may be omitted.

### Test/parity constraints
- Official fixture expectations can drift from current upstream behavior; classify before treating as local defects.
- Preserve test harness semantics that matter for validity:
  - suite `setup` and test `source` resources are loadable fixtures
  - response fixture templates are matcher artifacts, not loadable terminology content
- Avoid brittle assertions on full message text unless the text itself is contract-critical.

## Iteration Strategy
- Do not try to freeze the full contract up front.
- Define a strong v0 contract for config-driven behavior, implement it, then evolve based on parity evidence.
- Optimize for a short loop:
  - load vocabularies
  - run tests
  - classify gaps
  - adjust schema/config/provider behavior

## Starting Point for Iteration (v0)

### v0 provider contract scope
- Must support worker usage through existing abstraction patterns in `main`.
- Must support core SNOMED/LOINC/RxNorm operations:
  - `$lookup`
  - `$validate-code`
  - `$expand`
  - `$subsumes` (SNOMED first, then broader parity)
- Must support config-driven behavior for:
  - display selection and language normalization
  - designation mapping/filtering
  - property typing and lookup surface
  - hierarchy/link behavior used by expand/subsumes

### v0 data/model scope
- Core normalized concept/description/relationship/property tables.
- Explicit system/version/provenance metadata.
- Minimal value set/member support required for official test execution.
- Indexes focused on lookup/validate/expand/subsumes hot paths.

### v0 test scope
- Use official terminology subset + focused local suites for SNOMED/LOINC/RxNorm.
- Treat known upstream-consistent failures as classified expected outcomes, not blocking regressions.
- Capture parity deltas in machine-readable artifacts each run.

## Architecture Intent

### 1) Canonical SQLite schema (new)
Core principles:
- Stable normalized concept/description/relationship/property/value set/member tables.
- Explicit versioning + provenance for imported source artifacts.
- Clear system/version identity model.
- Query-oriented indexes aligned with expand/lookup/validate/subsumes patterns.

### 2) Importers from raw tx sources
- Deterministic, reproducible import pipeline.
- Vocabulary-specific parser phase -> normalized write phase.
- Validation step after import (counts, referential checks, spot semantics).
- Emit config metadata rows consumed by generic provider behavior.

### 3) Generic provider (main-compatible)
- Implements existing `main` expectations first.
- Uses config-driven strategy for display, designations, properties, hierarchy behavior.
- Provides shared logic for:
  - `$lookup`
  - `$validate-code`
  - `$expand`
  - `$subsumes`
- Hooks for small vocabulary overrides only where config is insufficient.

### 4) Compatibility and parity harness
- Keep official test replay path and targeted suites.
- Track parity in three buckets:
  - matches `tx-dev` / official semantics
  - intentional local policy differences
  - defects/regressions

## Phased Implementation

### Phase A: Bootstrap v0 Contract + Parity Loop
- Define v0 config-driven contract (not full/final) for core operations.
- Capture only the critical worker/provider interaction expectations needed for polymorphic operation in `main`.
- Establish initial parity corpus for SNOMED/LOINC/RxNorm and classify known upstream-consistent failures.

### Phase B: Schema + Config v0
- Draft schema v0 for new branch with explicit upgrade path.
- Draft config v0 spec for designations/properties/hierarchy/behavior flags.
- Review against known SNOMED/LOINC/RxNorm edge cases.

### Phase C: Importers
- Implement SNOMED importer to schema/config v0.
- Implement LOINC importer to schema/config v0.
- Implement RxNorm importer to schema/config v0.
- Add importer validation reports.

### Phase D: Generic Provider on Main Abstractions
- Implement generic provider query engine.
- Plug into existing provider abstractions so workers use the same interaction pattern as with legacy providers.
- Add minimal vocabulary-specific hooks only when required.
- Convergence target for LOINC:
  - remove LOINC-only filter execution behavior once generic property filtering reaches parity
  - retain only URL-shape adapters until implicit URL patterns are fully config-driven

### Phase E: Parity and Hardening
- Run official/targeted suites.
- Classify failures: upstream-consistent vs local defects.
- Fix defects, tighten config/model, preserve evidence.

## Exit Criteria (initial)
- SNOMED/LOINC/RxNorm core operations are parity-acceptable against current mainline expectations.
- Remaining failures are explicitly classified and justified.
- Provider internals are mostly generic/config-driven; vocabulary-specific code is small and justified.
