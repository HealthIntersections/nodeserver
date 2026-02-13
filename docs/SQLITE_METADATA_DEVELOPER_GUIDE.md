# SQLite Metadata Developer Guide

This guide explains how the unified SQLite format works in the TX runtime, with
annotated examples from SNOMED, LOINC, and RxNorm.

See also:
- `docs/SQLITE_RUNTIME_CONFIG_CONTRACT.md`
- `tx/importers/sqlite-v2/README.md`

## 1) Runtime model in one sentence

Importers convert source-specific files into a shared schema plus `cs_config`
runtime metadata; `cs-sqlite-runtime-v0.js` executes behavior from that metadata
without vocabulary-specific runtime subclasses.

## 2) Core schema surface

The runtime uses the same tables regardless of vocabulary:

- `code_system`: canonical identity (base URI, canonical URI, version, name)
- `cs_config`: JSON config (`runtime.*` keys)
- `concept`: core code rows (`code`, `display`, `definition`, `active`)
- `designation`: multilingual/synonym/display designation rows
- `property_def`: declares property semantics (`property_code`, `value_kind`)
- `concept_link`: concept-to-concept property links
- `concept_literal`: literal property values
- `closure`: transitive closure for hierarchy/subsumption
- `value_set`, `value_set_member`: precomputed ValueSet membership where available
- `search_fts_*`: optional FTS5 indexes for broad text filtering

The importer is where source-file shape is handled. Runtime expects normalized
rows and metadata.

## 3) Metadata keys that drive runtime behavior

The most important `cs_config` keys:

- `runtime.versioning`
- `runtime.languages`
- `runtime.designations`
- `runtime.hierarchy`
- `runtime.filters`
- `runtime.implicitValueSets`
- `runtime.status`
- `runtime.search`
- `runtime.behaviorFlags`

These are loaded in `buildRuntimeConfig()` and consumed by
`SqliteRuntimeV0Provider`.

Important: bulk paging behavior for filtered expansion is provider-driven
(`filterPage()`), not metadata-driven.

## 4) Annotated examples

### 4.1 SNOMED (hierarchy/subsumption via metadata)

Typical SNOMED metadata (conceptually):

```json
{
  "runtime.designations": {
    "primaryDisplay": {
      "source": "designation",
      "strategy": "first-active",
      "activeOnly": true,
      "order": "designation_id_asc"
    }
  },
  "runtime.hierarchy": {
    "propertyCode": "116680003",
    "edgeSetId": 1,
    "closure": { "enabled": true, "fallbackRecursive": false }
  },
  "runtime.filters": {
    "concept": { "operators": ["=", "is-a", "descendent-of", "in"] }
  }
}
```

What this does:
- `primaryDisplay` documents how importer derived `concept.display` for SNOMED:
  first active designation row in source order (`designation_id ASC`), matching main.
- `propertyCode` selects the "is-a" edge property from `property_def`.
- `closure` enables fast subsumption and descendant checks.
- concept filters (`is-a`, `descendent-of`) run generically from these settings.
- `closure.fallbackRecursive` controls behavior when closure is unavailable:
  - `true`: fallback recursive traversal over `concept_link` (useful for importer bring-up/debug)
  - `false`: no recursive fallback (traversal-dependent checks return negative/empty; preferred for production)

No SNOMED-specific runtime subclass logic is required for hierarchy traversal.

### 4.2 RxNorm (property filters from `property_def` + metadata)

RxNorm stores `TTY` as a literal property and exposes it in metadata:

```json
{
  "runtime.filters": {
    "properties": {
      "aliases": { "tty": "TTY", "TTY": "TTY" },
      "byCode": {
        "TTY": {
          "operators": ["=", "in"],
          "sources": ["literal"],
          "value": { "normalizeCase": true }
        }
      }
    }
  }
}
```

What this does:
- maps user filter aliases (`tty`) to property code (`TTY`)
- enables `=` / `in` operators
- executes against `concept_literal` rows (source=`literal`)
- applies normalization rules defined in metadata

Runtime executes this generically via property filter machinery; no RxNorm
branching in runtime code.

### 4.3 LOINC (derived link behavior via generic handler metadata)

LOINC uses a derived property filter for `answers-for`:

```json
{
  "runtime.filters": {
    "properties": {
      "byCode": {
        "answers-for": {
          "operators": ["=", "in"],
          "sources": ["link"],
          "specialHandler": {
            "kind": "derived-link-filter",
            "seed": {
              "directCodePrefixes": ["LL"],
              "inversePropertyCode": "answers-for"
            },
            "projection": {
              "propertyCode": "Answer",
              "side": "target"
            }
          }
        }
      }
    }
  }
}
```

Interpretation:
- seed set:
  - direct `LL...` values are accepted as answer-list concept codes
  - non-`LL...` values can resolve to list codes via inverse `answers-for` links
- projection:
  - from seed list codes, follow `Answer` links
  - return target-side codes

This is still generic runtime behavior: handler semantics are driven by metadata
fields, not vocabulary-specific hardcoded logic.

## 5) Adding a new vocabulary

Importer responsibilities:

1. map source content into shared tables
2. define property semantics in `property_def` (`value_kind`, hierarchy hints)
3. emit complete `runtime.*` metadata in `cs_config`
4. build closure + FTS tables where needed for performance

Runtime responsibilities:

1. load metadata
2. execute common operations (`$expand`, `$validate-code`, lookup, subsumes)
3. avoid vocabulary-specific assumptions

## 6) Source config and default selection

Runtime source line examples:

- `sqlite-v0!:sct_intl_20250201.v0.db` (`!` marks default for that system)
- `sqlite-v0:sct_us_20250301.v0.db`
- `sqlite-v0:loinc_281_full.v0.db`
- `sqlite-v0:rxnorm_02022026.v0.db`

The `!` default marker is config-level selection, independent of vocabulary.
