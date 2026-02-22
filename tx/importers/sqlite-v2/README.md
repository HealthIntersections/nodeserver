# SQLite v0 Importers

This folder contains clean-start terminology import pipelines targeting the shared SQLite v0 schema.

Naming note:
- `v0i` was used for some earlier local artifacts during indexing/closure experiments.
- Schema version is still SQLite `v0`; there is no separate `v0i` schema.
- Keep one canonical full DB per terminology/version (closure + FTS) and avoid keeping experimental side files in active cache paths.

Developer docs:
- `docs/SQLITE_RUNTIME_CONFIG_CONTRACT.md` (contract-level key reference)
- `docs/SQLITE_METADATA_DEVELOPER_GUIDE.md` (annotated SNOMED/LOINC/RxNorm examples)

Metadata policy:
- Importers now emit runtime-driving metadata only (`runtime.*` keys).
- Legacy duplicate keys (`schemaVersion`, `sourceKind`, `display`, etc.) are intentionally not emitted.

## SNOMED import command

Use `tx-import`:

```bash
tx-import snomed-sqlite-v0 import \
  --yes \
  --source /path/to/Snapshot \
  --dest /path/to/sct_intl_20250201.v0.db \
  --edition 900000000000207008 \
  --snomed-version 20250201 \
  --overwrite
```

Use `--skip-closure` only for importer bring-up/debug. Production builds should include full closure.
Recursive fallback is available but now opt-in (`runtime.hierarchy.closure.fallbackRecursive=true`); default is fail-closed.

Importer now also builds broad trigram FTS tables used by runtime text filtering:
- `search_fts_display`
- `search_fts_designation`
- `search_fts_literal`

Runtime is configured FTS-first with LIKE fallback via `runtime.search` in `cs_config`.

## RxNorm import command

Use `tx-import`:

```bash
tx-import rxnorm-sqlite-v0 import \
  --yes \
  --source /path/to/RxNorm_full_02022026.zip \
  --dest /path/to/rxnorm_02022026.v0.db \
  --rxnorm-version 02022026 \
  --overwrite
```

Use `--skip-closure` for faster iteration imports.

## LOINC import command

Use `tx-import`:

```bash
tx-import loinc-sqlite-v0 import \
  --yes \
  --source /path/to/Loinc_2.81.zip \
  --dest /path/to/loinc_2.81.v0.db \
  --loinc-version 2.81 \
  --overwrite
```

Use `--skip-closure` for faster iteration imports.

## Runtime source type

`Library` now accepts:

- `sqlite-v0:<file>` (preferred generic source type)
- `snomed-sqlite-v0:<file>` (alias to `sqlite-v0`)
- `loinc-sqlite-v0:<file>` (alias to `sqlite-v0`)
- `rxnorm-sqlite-v0:<file>` (alias to `sqlite-v0`)

Loader behavior is generic. If specialized factory behavior is needed, metadata tags
(`runtime.behaviorFlags.tags`) are matched against factories registered through
`SqliteRuntimeV0FactoryProvider.registerSpecializedFactory(...)`.

Use `!` after the type to mark the default for a code system when multiple versions are loaded:

- `sqlite-v0!:sct_intl_20250201.v0.db` (default)
- `sqlite-v0:sct_us_20250301.v0.db` (additional version)

Example config: `tx/tx.snomed-v0.yml`.
