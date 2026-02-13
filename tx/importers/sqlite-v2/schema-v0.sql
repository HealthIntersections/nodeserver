PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS code_system (
  cs_id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_uri TEXT NOT NULL,
  edition_code TEXT,
  version TEXT,
  canonical_uri TEXT NOT NULL,
  name TEXT,
  source_kind TEXT,
  loaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_code_system_base_version
  ON code_system(base_uri, version);

CREATE TABLE IF NOT EXISTS cs_config (
  cs_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (cs_id, key),
  FOREIGN KEY (cs_id) REFERENCES code_system(cs_id)
);

CREATE TABLE IF NOT EXISTS concept (
  concept_id INTEGER PRIMARY KEY,
  cs_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  display TEXT,
  definition TEXT,
  FOREIGN KEY (cs_id) REFERENCES code_system(cs_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_concept_cs_code
  ON concept(cs_id, code);

CREATE INDEX IF NOT EXISTS idx_concept_active
  ON concept(cs_id, active);

CREATE TABLE IF NOT EXISTS designation (
  designation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  language_code TEXT,
  use_code TEXT,
  term TEXT NOT NULL,
  preferred INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE INDEX IF NOT EXISTS idx_designation_concept
  ON designation(concept_id, active);
CREATE INDEX IF NOT EXISTS idx_designation_concept_pref_term
  ON designation(concept_id, preferred DESC, term);

CREATE TABLE IF NOT EXISTS property_def (
  property_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cs_id INTEGER NOT NULL,
  property_code TEXT NOT NULL,
  value_kind TEXT NOT NULL DEFAULT 'concept',
  is_hierarchy INTEGER NOT NULL DEFAULT 0,
  display TEXT,
  FOREIGN KEY (cs_id) REFERENCES code_system(cs_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_propdef_cs_code
  ON property_def(cs_id, property_code);

CREATE TABLE IF NOT EXISTS concept_link (
  edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_set_id INTEGER NOT NULL DEFAULT 1,
  source_concept_id INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  target_concept_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (source_concept_id) REFERENCES concept(concept_id),
  FOREIGN KEY (target_concept_id) REFERENCES concept(concept_id),
  FOREIGN KEY (property_id) REFERENCES property_def(property_id)
);

CREATE INDEX IF NOT EXISTS idx_concept_link_source
  ON concept_link(source_concept_id, property_id, edge_set_id, active);

CREATE INDEX IF NOT EXISTS idx_concept_link_target
  ON concept_link(target_concept_id, property_id, edge_set_id, active);

CREATE TABLE IF NOT EXISTS concept_literal (
  literal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_set_id INTEGER NOT NULL DEFAULT 1,
  source_concept_id INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  value_raw TEXT,
  value_text TEXT,
  value_num REAL,
  value_bool INTEGER,
  group_id INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (source_concept_id) REFERENCES concept(concept_id),
  FOREIGN KEY (property_id) REFERENCES property_def(property_id)
);

CREATE INDEX IF NOT EXISTS idx_concept_literal_source
  ON concept_literal(source_concept_id, property_id, edge_set_id, active);

-- Broad text search surfaces (rowid-linked, contentless FTS5).
-- These power fast filter text matching across display/designation/literal.
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts_display
  USING fts5(term, tokenize='trigram', content='');

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts_designation
  USING fts5(term, tokenize='trigram', content='');

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts_literal
  USING fts5(term, tokenize='trigram', content='');

CREATE TABLE IF NOT EXISTS closure (
  ancestor_id INTEGER NOT NULL,
  descendant_id INTEGER NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS value_set (
  vs_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cs_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  version TEXT,
  name TEXT,
  FOREIGN KEY (cs_id) REFERENCES code_system(cs_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_value_set_cs_url_version
  ON value_set(cs_id, url, version);

CREATE TABLE IF NOT EXISTS value_set_member (
  member_id INTEGER PRIMARY KEY AUTOINCREMENT,
  vs_id INTEGER NOT NULL,
  concept_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (vs_id) REFERENCES value_set(vs_id),
  FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vsm_unique
  ON value_set_member(vs_id, concept_id);

CREATE INDEX IF NOT EXISTS idx_vsm_vs
  ON value_set_member(vs_id);

CREATE TABLE IF NOT EXISTS load_audit (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_path TEXT,
  target_db TEXT,
  terminology TEXT,
  edition_code TEXT,
  version TEXT,
  status TEXT NOT NULL,
  stats_json TEXT
);
