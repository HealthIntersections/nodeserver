# SQLite v0 Importers

This folder contains clean-start terminology import pipelines targeting the shared SQLite v0 schema.

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

Use `--skip-closure` only when you need a faster build for iteration. Runtime now supports both:
- precomputed `closure` table (preferred for speed)
- fallback recursive hierarchy evaluation when closure is absent

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
  --dest /path/to/rxnorm_02022026.v0i.db \
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
  --dest /path/to/loinc_2.81.v0i.db \
  --loinc-version 2.81 \
  --overwrite
```

Use `--skip-closure` for faster iteration imports.

## Runtime source type

`Library` now accepts:

- `snomed-sqlite-v0:<file>`
- `loinc-sqlite-v0:<file>`
- `rxnorm-sqlite-v0:<file>`

Example config: `tx/tx.snomed-v0.yml`.
