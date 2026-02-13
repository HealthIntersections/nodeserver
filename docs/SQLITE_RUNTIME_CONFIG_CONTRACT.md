# SQLite Runtime Config Contract (Zero Vocab Subclasses)

## Goal
Move runtime behavior out of `cs-*.js` vocabulary subclasses and into:
- normalized SQLite data
- `code_system` identity fields
- `property_def` semantics
- `cs_config` JSON contract

Importers remain vocabulary-specific. Runtime should be generic.

## Current foundation
- `code_system`: canonical identity, edition/version, name.
- `property_def`: property code, value kind, hierarchy hint.
- `cs_config`: key/value JSON per code system.

## Contract v1 (proposed keys in `cs_config`)

Use `runtime.*` namespaced keys.

1. `runtime.versioning`
- `{ "algorithm": "date|semver|string-prefix", "partialMatch": true }`

2. `runtime.languages`
- `{ "default": "en" }`

3. `runtime.designations`
- Use mapping, language behavior, optional use-display metadata.
- Example:
```json
{
  "useMapping": {
    "fsn": { "system": "http://snomed.info/sct", "code": "900000000000003001", "display": "Fully specified name" },
    "synonym": { "system": "http://snomed.info/sct", "code": "900000000000013009", "display": "Synonym (core metadata concept)" }
  }
}
```

4. `runtime.hierarchy`
- Declares which property is hierarchy, which edge set to use, and closure policy.
- Example:
```json
{
  "propertyCode": "116680003",
  "edgeSetId": 1,
  "closure": { "enabled": true, "fallbackRecursive": false }
}
```

`runtime.hierarchy.closure.fallbackRecursive` semantics:
- `true`: if closure rows are missing/unavailable, runtime may use recursive CTE traversal over `concept_link`.
- `false`: runtime will not recurse when closure is unavailable (hierarchy checks requiring traversal return negative/empty results).
- Recommended default for production SNOMED/RxNorm/LOINC DBs: `false` (fail closed on missing closure rather than degrade to expensive traversal).

5. `runtime.filters`
- Declares supported filter properties/operators and execution templates.
- Example:
```json
{
  "concept": {
    "operators": ["=", "is-a", "descendent-of", "in"]
  },
  "code": {
    "operators": ["regex"]
  }
}
```

Property filters can also declare metadata-only derived handlers (still generic runtime, no vocab subclass code). Example:
```json
{
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
```

6. `runtime.implicitValueSets`
- Declarative URL-pattern handling (instead of subclass string switches).
- Example:
```json
{
  "all": { "queries": ["fhir_vs", "fhir_vs=all"] },
  "isa": { "queryPrefix": "fhir_vs=isa/", "filter": { "property": "concept", "op": "is-a", "valueFromSuffix": true } },
  "refset": { "queryPrefix": "fhir_vs=refset/", "filter": { "property": "concept", "op": "in", "valueFromSuffix": true } }
}
```

7. `runtime.status`
- How to derive inactive/deprecated/abstract.
- Example:
```json
{
  "inactive": { "source": "concept.active", "invert": true },
  "deprecated": { "source": "constant", "value": false },
  "abstract": { "source": "constant", "value": false }
}
```

8. `runtime.search`
- Search behavior for `searchFilter`.
- Example:
```json
{
  "mode": "fts-broad",
  "activeOnly": true,
  "designationActiveOnly": true,
  "literalActiveOnly": true,
  "sources": ["display", "designation", "literal"],
  "ftsTables": {
    "display": "search_fts_display",
    "designation": "search_fts_designation",
    "literal": "search_fts_literal"
  },
  "likeFallback": { "enabled": true, "caseInsensitive": true }
}
```

9. `runtime.behaviorFlags`
- Optional runtime tags for metadata-driven specialized factory registration.
- Example:
```json
{
  "tags": ["loinc", "implicit-vs-path"]
}
```
- Loader behavior is generic: `SqliteRuntimeV0FactoryProvider.createFromMetadata(...)` inspects
  metadata tags and selects any registered specialized factory with matching tags.
- Note: bulk filter/expand paging is **not** controlled here; it is a provider capability
  (`filterPage()` implementation), selected by runtime class behavior.

## What becomes metadata-driven
- System/version/name resolution: from `code_system`.
- Hierarchy navigation/subsumption: from `runtime.hierarchy` + `property_def`.
- Filter/operator surface: from `runtime.filters`.
- Implicit value set URL behavior: from `runtime.implicitValueSets`.
- Display and designation handling: from `concept.display` + `runtime.designations`.

## What stays importer-specific
- Parsing source files (RF2, RRF, LOINC release shapes).
- Mapping raw source semantics into normalized tables + config contract.

## Can subclass content go to zero?
Yes for runtime behavior.

Target architecture:
- one generic SQLite runtime provider
- zero vocabulary-specific runtime subclasses for SNOMED/RxNorm/LOINC
- vocabulary differences represented in data + `cs_config`

## Near-term implementation steps
1. Have SNOMED importer emit full `runtime.*` contract (v1).
2. Build generic provider that reads only contract + normalized tables.
3. Port SNOMED runtime to generic provider.
4. Build RxNorm importer to emit same contract.
5. Validate both against official tests and triage captures.
