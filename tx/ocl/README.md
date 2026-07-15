# OCL Integration in FHIRsmith

## Overview
The `tx/ocl` module integrates [Open Concept Lab (OCL)](https://openconceptlab.org/) as a terminology source inside FHIRsmith.

It provides adapters/providers for:

- `CodeSystem` from OCL Sources
- `ValueSet` from OCL Collections
- `ConceptMap` from OCL Mappings

In FHIRsmith terms, these providers are loaded by `tx/library.js` when a source entry starts with `ocl:`. OCL metadata is discovered from OCL APIs, and heavy content (concept lists/expansions) is loaded lazily and warmed in background jobs.

## Architecture
### Main modules
- `cs-ocl.js`
  - `OCLCodeSystemProvider`: discovers OCL sources and publishes CodeSystem metadata.
  - `OCLSourceCodeSystemFactory`: creates runtime CodeSystem providers with shared caches, cold-cache hydration, and background full-load jobs.
  - `OCLSourceCodeSystemProvider`: runtime concept lookup/filter/search behavior for one source.
- `vs-ocl.js`
  - `OCLValueSetProvider`: discovers OCL collections, resolves compose includes, serves ValueSet metadata, and builds cached expansions in background.
- `cm-ocl.js`
  - `OCLConceptMapProvider`: resolves OCL mappings for fetch/search/translation candidate discovery.

### Supporting modules under `tx/ocl`
- `http/client.js`: Axios client creation, base URL normalization, token auth header (`Token` or `Bearer`).
- `http/pagination.js`: OCL pagination helper (`results/items/data`, `next`, page mode fallback).
- `cache/cache-paths.js`: cold-cache directories and canonical URL to file path mapping.
- `cache/cache-utils.js`: cache directory creation, file age detection, friendly age formatting.
- `fingerprint/fingerprint.js`: deterministic SHA-256 fingerprints for CodeSystem concepts and ValueSet expansions.
- `jobs/background-queue.js`: singleton keyed queue, size-priority ordering, max concurrency = 2, heartbeat logging every 30s.
- `mappers/concept-mapper.js`: maps OCL concept payloads to internal concept context shape.
- `model/concept-filter-context.js`: ranked filter result set used by CodeSystem filters.
- `resolve/reference-resolver.js`: client for OCL's `$resolveReference` — resolves a canonical URL to the repo that holds it. Requires a token; see [Canonical resolution via `$resolveReference`](#canonical-resolution-via-resolvereference).
- `shared/constants.js`: defaults and constants (`PAGE_SIZE`, cache freshness window, etc.).
- `shared/patches.js`:
  - patches search worker so `CodeSystem?url=...&code=...` on OCL resources only returns matching concept subtree.
  - patches `TxParameters.hashSource()` to include `filter` for expansion cache key differentiation.

## Runtime flow
### Metadata discovery
CodeSystems (`cs-ocl.js`):
- discover orgs via `/orgs/`
- for each org, discover sources via `/orgs/{org}/sources/`
- fallback to `/sources/` if org listing is unavailable

ValueSets (`vs-ocl.js`):
- discover orgs via `/orgs/`
- discover collections via `/orgs/{org}/collections/`
- fallback to `/collections/`

ConceptMaps (`cm-ocl.js`):
- fetch by id via `/mappings/{id}/`
- search via `/mappings/` or `/orgs/{org}/mappings/`

### Lazy loading
- CodeSystem concepts are not fully loaded at metadata discovery time.
- ValueSet expansions are not built inline by default.
- Missing concept/page/expansion data triggers background warm-up scheduling.

### Cold cache (disk)
- Base folder: `data/terminology-cache/ocl`
- CodeSystems: `data/terminology-cache/ocl/codesystems`
- ValueSets: `data/terminology-cache/ocl/valuesets`

On startup/initialization:
- CodeSystem factory hydrates concept cache from cold cache file if present.
- ValueSet provider loads cached expansions from cold cache files.

Corrupt cache handling:
- JSON parse/read errors are logged and skipped; provider continues without crashing.

### Hot cache (memory)
- CodeSystems: shared in-memory concept/page caches per factory.
- ValueSets: in-memory expansion cache keyed by ValueSet + params hash.
- ConceptMaps: in-memory map keyed by URL/version/id.

### Background warm-up jobs
Queue behavior (`OCLBackgroundJobQueue`):
- singleton job key (skip duplicate key)
- max concurrency = `2`
- ordering by `jobSize` (smaller concept count first)
- heartbeat log every `30s`
- progress supports `{ processed, total }` and `%`

CodeSystem warm-up:
- skipped when cold-cache file age is `<= 1 hour`
- enqueued when stale/no cold cache
- loads all concept pages
- computes fingerprint from full concept content
- if fingerprint changed, replaces cold cache file

ValueSet warm-up:
- skipped when freshest cold cache age (file mtime or cached timestamp) is `<= 1 hour`
- enqueued when stale/no cold cache
- builds expansion by paging collection concepts
- computes expansion fingerprint
- if fingerprint changed, replaces cold cache file

### Fingerprint/checksum strategy
- OCL source checksum is treated as informational only in `cs-ocl.js` comments.
- Cache replacement decisions use custom fingerprints from concept/expansion content.
- ValueSet cache validity also checks metadata signature and dependency checksums from referenced CodeSystems.

### ValueSet expansion filtering
`vs-ocl.js` supports filtered concept retrieval through `valueSet.oclFetchConcepts(...)`:
- local baseline filtering (code/display/definition text contains)
- `SearchFilterText` token behavior
- remote query hint (`q`) generated from normalized filter tokens
- dedicated smaller page size for filtered calls (`FILTERED_CONCEPT_PAGE_SIZE`)

### `/CodeSystem?url=...&code=...` behavior for OCL
`shared/patches.js` patches search worker to apply concept subtree filtering only for OCL-marked CodeSystems (extension URL `http://fhir.org/FHIRsmith/StructureDefinition/ocl-codesystem`).

## Configuration
## Activation in FHIRsmith
OCL is activated by adding an OCL source line in the TX library YAML (for example `data/library.yml`):

```yaml
sources:
  - ocl:https://oclapi2.ips.hsl.org.br
```

`tx/library.js` loads this via `loadOcl()`.

### Source syntax
`tx/library.js` parses:

```text
ocl:<baseUrl>|org=<orgId>|token=<tokenOrAlias>|timeout=<ms>
```

Parsed keys:
- `baseUrl` (required)
- `org` (optional) — scopes discovery, and derives the `$resolveReference` namespace (`/orgs/{org}/`)
- `token` (optional) — enables `$resolveReference`; without it that operation is not used
- `timeout` (optional positive number)

Unrecognised keys are ignored silently, so a typo (`namepsace=...`) is dropped rather than reported.

Examples:

```yaml
sources:
  - ocl:https://api.openconceptlab.org
  - ocl:https://ocl.example.org|org=my-org
  - ocl:https://ocl.example.org|org=my-org|token=my-ocl-token|timeout=45000
```

### Config value aliasing
`Library.resolveOclConfigValue()` can resolve symbolic values from top-level YAML `ocl:` object loaded into `this.oclConfig`.

Example pattern:

```yaml
ocl:
  ocl-base: https://ocl.example.org
  ocl-token: Token abc123

sources:
  - ocl:ocl-base|org=my-org|token=ocl-token
```

### Credentials and URLs
- Base URL is required (OCL API root).
- Token is optional, sent as `Authorization`:
  - `Token <value>` if no prefix is provided
  - preserved if already `Token ...` or `Bearer ...`
- **A token is what enables `$resolveReference`.** It remains optional and no existing
  configuration needs to change — but see below for what you gain by adding one.

> **Do not commit a real token.** `data/library.yml` is tracked by git and is not
> ignored, and there is no environment-variable interpolation in `tx/library.js`
> (the `ocl:` alias block is read from the same file). A token added there is a live
> credential in your repository history. Keep the edit local and uncommitted.

### Canonical resolution via `$resolveReference`

OCL's [`$resolveReference`](https://docs.openconceptlab.org/en/latest/oclapi/apireference/resolveReference.html)
answers *"which repo holds this canonical URL?"* authoritatively, in one call.
Without it, `cm-ocl.js` has to guess: it derives a search token from the canonical,
pages through `/orgs/{org}/sources/?q=...`, and matches `canonical_url` on whatever
the search happens to surface.

**A token is required, and this is the one thing worth understanding here.**
`$resolveReference` is authenticated on every OCL instance we have probed, while the
`/orgs/` enumeration it replaces is public. So a tokenless server can still discover
and serve OCL content exactly as before, but it cannot use `$resolveReference`.

**Nothing breaks without a token.** The resolver is constructed disabled when no token
is configured, and every caller falls back to the path it used previously. Existing
`ocl:` source lines keep working unchanged; adding a token is opt-in:

| Configuration | Canonical → repo resolution | Behaviour |
| --- | --- | --- |
| `ocl:https://ocl.example.org` | `/orgs/{org}/sources/?q=` search | unchanged from previous versions |
| `ocl:https://ocl.example.org\|token=...` | `$resolveReference` | authoritative, one request, falls back to the search if it fails |

The resolver also disables itself permanently — falling back for the rest of the
process — if the instance answers `404` (operation not implemented) or `401`/`403`
(credentials rejected). A `400` is logged as a bug on our side without disabling.

**Namespace.** `$resolveReference` evaluates a reference within a *namespace*, which
FHIRSmith derives from the source entry:

- `org=X` configured → namespace `/orgs/X/`
- no `org` → `/` (global), which is OCL's own default

A namespace is a *preference*, not a boundary: OCL consults the owner's URL Registry,
then repos in the namespace, then falls through to the **Global URL Registry**. A
resolve scoped to `/orgs/A/` can therefore still return another owner's repo. Confining
resolution to a namespace (the "sandbox" case) would have to be enforced on this side
and is not implemented.

**What it does not do:** `$resolveReference` resolves a *known* reference; it cannot
*list* what exists. Source/collection discovery still uses the `/orgs/` enumeration
described above.

### Enable/disable integration
- Enable by including at least one `ocl:` source entry in TX library YAML.
- Disable by removing/commenting those `ocl:` entries.
- `modules.tx.enabled` must be true in server config to expose TX endpoints.

## Cache behavior details
### Startup hydration
- CodeSystem cold cache is loaded when factory is created (`OCLSourceCodeSystemFactory` constructor path).
- ValueSet cold cache is loaded during `OCLValueSetProvider.initialize()`.

### 1-hour freshness rule
- Fresh threshold constant: `COLD_CACHE_FRESHNESS_MS = 60 * 60 * 1000`.
- If cold cache age is `<= 1 hour`, warm-up scheduling is skipped.

### Hot cache replacing cold cache
- On successful background refresh, new fingerprint is compared to previous cold-cache fingerprint.
- If changed, cold cache is overwritten with the refreshed in-memory state.

## Operational notes
### Logs to expect
Prefixes:
- `[OCL]` for CodeSystem/queue/general OCL flow
- `[OCL-ValueSet]` for ValueSet flow

Typical events:
- fetched org/source/collection counts
- cold cache loaded/saved
- warm-up skipped/enqueued/started/completed
- fingerprint unchanged/changed
- queue status + heartbeat snapshots

### Troubleshooting hints
- If nothing loads, verify OCL base URL and org visibility.
- If cache never warms, check cold-cache timestamps and 1-hour rule.
- If searches by `code` behave unexpectedly, confirm OCL marker extension is present on CodeSystem resources.
- For ValueSet filter behavior, verify `filter` is included in request path through `TxParameters.hashSource` patch and that filter text normalizes as expected.
- If `$resolveReference` seems to be ignored, check for a `[OCL] $resolveReference ...` log line explaining why it disabled itself. Silence usually means no `token=` is configured, in which case it never runs at all.

### Known limitations (from current implementation)
- OCL checksums are not relied on for cache invalidation.
- Some source/collection discovery paths depend on OCL endpoint support and can fallback.
- Missing endpoints returning `404` in some concept fetch paths are treated as empty content for graceful degradation.
- `$resolveReference` is only used for ConceptMap source canonicals (`cm-ocl.js`). `cs-ocl.js`/`vs-ocl.js` still build repo paths by hand, but only as a last resort behind the `concepts_url` / `expansion_url` that OCL supplies in its payloads.
- Namespace sandboxing is not implemented: a namespaced resolve can still fall through to OCL's Global URL Registry and return a repo outside that namespace.
- There is no way to supply a token outside the tracked library YAML.

## Developer notes
### Where to extend
- Add/adjust OCL HTTP behavior: `tx/ocl/http/*`
- Add cache policy/path behavior: `tx/ocl/cache/*`
- Add queue policy: `tx/ocl/jobs/background-queue.js`
- Add mapping logic from OCL payloads: `tx/ocl/mappers/*`
- Add fingerprint strategy: `tx/ocl/fingerprint/*`
- Add canonical-resolution behavior: `tx/ocl/resolve/reference-resolver.js`
- Add provider-specific behavior:
  - CodeSystem: `tx/ocl/cs-ocl.js`
  - ValueSet: `tx/ocl/vs-ocl.js`
  - ConceptMap: `tx/ocl/cm-ocl.js`

### Ownership by concern
- HTTP access: `http/client.js`, `http/pagination.js`
- Canonical URL to OCL repo resolution: `resolve/reference-resolver.js`
- Disk cold cache and pathing: `cache/cache-paths.js`, `cache/cache-utils.js`
- Background jobs and scheduling policy: `jobs/background-queue.js`
- Fingerprints/checksums: `fingerprint/fingerprint.js` and provider compare logic
- Worker/runtime patches: `shared/patches.js`

### Test strategy for future changes
- Keep provider tests deterministic by mocking OCL HTTP responses and cold-cache files.
- Validate stale/fresh transitions with file mtime control.
- Validate queue behavior with isolated static state reset between tests.
- Track coverage with:

```bash
npm test -- --runInBand tests/ocl --coverage --collectCoverageFrom="tx/ocl/**/*.js"
```

> **Read that number carefully.** Most of `tx/ocl` is `.cjs` with a one-line `.js`
> re-export stub beside it, and the glob above (like `collectCoverageFrom` in
> `jest.config.js`) matches `**/*.js` but **not** `**/*.cjs`. So for `cs-ocl`, `vs-ocl`
> and `cm-ocl` it reports on the stubs, not the implementation. Only genuine `.js`
> modules — currently `resolve/reference-resolver.js` — are really measured:
>
> ```bash
> npx jest --testPathPattern "tests/ocl" --coverage --collectCoverageFrom="tx/ocl/resolve/**/*.js"
> ```
