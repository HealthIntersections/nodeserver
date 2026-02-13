'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

const BASE_URI = 'http://snomed.info/sct';

const IS_A_TYPE_ID = '116680003';
const FSN_TYPE_ID = '900000000000003001';
const SYNONYM_TYPE_ID = '900000000000013009';

const CHAR_INFERRED = '900000000000011006';
const CHAR_STATED = '900000000000010007';
const CHAR_ADDITIONAL = '900000000000227009';

const ACCEPTABILITY_PREFERRED = '900000000000548007';

const EDGE_SET_INFERRED = 1;
const EDGE_SET_STATED = 2;
const EDGE_SET_ADDITIONAL = 3;

const MAX_SQL_PARAMS = 900;
const FLUSH_ROW_TARGET = 5000;

class SnomedSqliteV0Importer {
  constructor(config = {}) {
    this.config = {
      source: config.source,
      dest: config.dest,
      edition: config.edition || '900000000000207008',
      version: config.version,
      uri: config.uri,
      snapshotOnly: config.snapshotOnly !== false,
      skipRefsets: !!config.skipRefsets,
      skipClosure: !!config.skipClosure,
      verbose: !!config.verbose,
      overwrite: !!config.overwrite
    };

    this.db = null;
    this.csId = null;
    this.auditRunId = null;

    this.preferredDescriptions = new Set();
    this.seenPropertyCodes = new Set();
    this.propertyIdByCode = new Map();
    this.conceptIdByCode = new Map();
    this.nextConceptId = 1;
    this.isAPropertyId = null;

    this.stats = {
      concepts: 0,
      descriptions: 0,
      relationships: 0,
      concreteValues: 0,
      refsets: 0,
      refsetMembers: 0,
      closureRows: 0,
      ftsDisplayRows: 0,
      ftsDesignationRows: 0,
      ftsLiteralRows: 0
    };

    const parsed = parseEditionAndVersion(this.config.uri);
    if (parsed.edition && !config.edition) {
      this.config.edition = parsed.edition;
    }
    if (parsed.version && !config.version) {
      this.config.version = parsed.version;
    }
    if (!this.config.uri && this.config.edition && this.config.version) {
      this.config.uri = `${BASE_URI}/${this.config.edition}/version/${this.config.version}`;
    }
  }

  static discoverRf2Files(source, { snapshotOnly = true } = {}) {
    const files = {
      concepts: [],
      descriptions: [],
      relationships: [],
      concreteValues: [],
      languageRefsets: [],
      refsets: []
    };

    scanDirectory(source, files, snapshotOnly);
    return files;
  }

  async run() {
    if (!this.config.source || !this.config.dest) {
      throw new Error('source and dest are required');
    }
    if (!this.config.uri) {
      throw new Error('Either uri or (edition + version) is required');
    }
    if (!this.config.version) {
      throw new Error('Version (YYYYMMDD) is required for v0 imports');
    }

    await this.openDatabase();
    await this.createSchema();

    try {
      await this.startAudit();
      await this.createCodeSystem();

      const files = SnomedSqliteV0Importer.discoverRf2Files(this.config.source, {
        snapshotOnly: this.config.snapshotOnly
      });

      this.log(`Discovered files: concepts=${files.concepts.length}, descriptions=${files.descriptions.length}, relationships=${files.relationships.length}, concrete=${files.concreteValues.length}, languageRefsets=${files.languageRefsets.length}, refsets=${files.refsets.length}`);

      if (files.concepts.length === 0) {
        throw new Error('No concept Snapshot files found');
      }
      if (files.descriptions.length === 0) {
        throw new Error('No description Snapshot files found');
      }

      await this.importLanguagePreferences(files.languageRefsets);
      await this.importConcepts(files.concepts);
      await this.importDescriptions(files.descriptions);
      await this.deriveConceptDisplays();
      await this.importRelationships(files.relationships);
      await this.importConcreteValues(files.concreteValues);

      if (!this.config.skipRefsets) {
        await this.importRefsets(files.refsets);
      }

      await this.buildSearchIndexes();

      if (!this.config.skipClosure) {
        await this.buildClosure();
      }

      await this.writeCsConfig();
      await this.finalizeDatabase();
      await this.completeAudit('success', null);
    } catch (error) {
      await this.completeAudit('failed', error);
      throw error;
    } finally {
      await this.closeDatabase();
    }

    return {
      csId: this.csId,
      uri: this.config.uri,
      stats: this.stats
    };
  }

  async openDatabase() {
    const dir = path.dirname(this.config.dest);
    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(this.config.dest)) {
      if (!this.config.overwrite) {
        throw new Error(`Destination exists: ${this.config.dest} (use --overwrite)`);
      }
      fs.unlinkSync(this.config.dest);
    }

    this.db = await openSqlite(this.config.dest);

    await this.exec('PRAGMA foreign_keys = OFF');
    await this.exec('PRAGMA journal_mode = WAL');
    await this.exec('PRAGMA synchronous = OFF');
    await this.exec('PRAGMA cache_size = -64000');
    await this.exec('PRAGMA temp_store = MEMORY');
  }

  async closeDatabase() {
    if (!this.db) return;
    await closeSqlite(this.db);
    this.db = null;
  }

  async createSchema() {
    const schemaPath = path.join(__dirname, 'schema-v0.sql');
    const ddl = fs.readFileSync(schemaPath, 'utf8');
    await this.exec(ddl);
  }

  async startAudit() {
    const result = await this.runSql(
      `INSERT INTO load_audit (started_at, source_path, target_db, terminology, edition_code, version, status)
       VALUES (CURRENT_TIMESTAMP, ?, ?, 'snomed', ?, ?, 'running')`,
      [this.config.source, this.config.dest, this.config.edition || null, this.config.version || null]
    );
    this.auditRunId = result.lastID;
  }

  async completeAudit(status, error) {
    if (!this.auditRunId) return;

    const payload = {
      uri: this.config.uri,
      stats: this.stats
    };

    if (error) {
      payload.error = {
        message: error.message,
        stack: this.config.verbose ? error.stack : undefined
      };
    }

    await this.runSql(
      `UPDATE load_audit
       SET completed_at = CURRENT_TIMESTAMP,
           status = ?,
           stats_json = ?
       WHERE run_id = ?`,
      [status, JSON.stringify(payload), this.auditRunId]
    );
  }

  async createCodeSystem() {
    const result = await this.runSql(
      `INSERT INTO code_system (base_uri, edition_code, version, canonical_uri, name, source_kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        BASE_URI,
        this.config.edition || null,
        this.config.version || null,
        this.config.uri,
        snomedName(this.config.edition),
        'rf2-snapshot'
      ]
    );

    this.csId = result.lastID;

    await this.runSql(
      `INSERT OR IGNORE INTO property_def (cs_id, property_code, value_kind, is_hierarchy, display)
       VALUES (?, ?, 'concept', 1, 'is-a')`,
      [this.csId, IS_A_TYPE_ID]
    );
    this.seenPropertyCodes.add(IS_A_TYPE_ID);
    const isARow = await this.get(
      `SELECT property_id
       FROM property_def
       WHERE cs_id = ? AND property_code = ?`,
      [this.csId, IS_A_TYPE_ID]
    );
    if (!isARow) {
      throw new Error(`Unable to resolve property_id for ${IS_A_TYPE_ID}`);
    }
    this.propertyIdByCode.set(IS_A_TYPE_ID, isARow.property_id);
    this.isAPropertyId = isARow.property_id;
  }

  async importLanguagePreferences(files) {
    if (!files || files.length === 0) {
      this.log('No language refset files found; preferred flags will be limited');
      return;
    }

    this.log(`Importing language preference markers from ${files.length} files...`);

    let count = 0;
    for (const file of files) {
      for await (const cols of readTsv(file)) {
        if (cols.length < 7) continue;
        const active = cols[2] === '1';
        const descriptionId = cols[5];
        const acceptabilityId = cols[6];

        if (!active) continue;
        if (acceptabilityId !== ACCEPTABILITY_PREFERRED) continue;

        this.preferredDescriptions.add(descriptionId);
        count += 1;
      }
    }

    this.log(`Captured ${this.preferredDescriptions.size.toLocaleString()} preferred description ids (${count.toLocaleString()} active rows)`);
  }

  async importConcepts(files) {
    this.log(`Importing concepts from ${files.length} files...`);

    const rows = [];
    let imported = 0;

    for (const file of files) {
      for await (const cols of readTsv(file)) {
        if (cols.length < 5) continue;

        const code = cols[0];
        const active = cols[2] === '1' ? 1 : 0;
        const conceptId = this.nextConceptId++;

        rows.push([
          conceptId,
          this.csId,
          code,
          active,
          null,
          null
        ]);

        this.conceptIdByCode.set(code, conceptId);
        imported += 1;

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT INTO concept (concept_id, cs_id, code, active, display, definition)`,
            6,
            rows
          );
          rows.length = 0;
          this.log(`  concepts imported: ${imported.toLocaleString()}`);
        }
      }
    }

    if (rows.length > 0) {
      await this.bulkInsert(
        `INSERT INTO concept (concept_id, cs_id, code, active, display, definition)`,
        6,
        rows
      );
    }

    this.stats.concepts = imported;
    this.log(`Concept import complete: ${imported.toLocaleString()}`);
  }

  async importDescriptions(files) {
    this.log(`Importing descriptions from ${files.length} files...`);

    const rows = [];
    let imported = 0;

    for (const file of files) {
      for await (const cols of readTsv(file)) {
        if (cols.length < 9) continue;

        const descriptionId = cols[0];
        const active = cols[2] === '1' ? 1 : 0;
        const conceptCode = cols[4];
        const languageCode = cols[5] || null;
        const typeId = cols[6] || null;
        const term = cols[7] || '';
        const conceptId = this.conceptIdByCode.get(conceptCode);

        if (!conceptId) continue;

        const useCode = mapUseCode(typeId);
        const preferred = (typeId === FSN_TYPE_ID || this.preferredDescriptions.has(descriptionId)) ? 1 : 0;

        rows.push([
          conceptId,
          active,
          languageCode,
          useCode,
          term,
          preferred
        ]);

        imported += 1;

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT INTO designation (concept_id, active, language_code, use_code, term, preferred)`,
            6,
            rows
          );
          rows.length = 0;
          this.log(`  descriptions imported: ${imported.toLocaleString()}`);
        }
      }
    }

    if (rows.length > 0) {
      await this.bulkInsert(
        `INSERT INTO designation (concept_id, active, language_code, use_code, term, preferred)`,
        6,
        rows
      );
    }

    this.stats.descriptions = imported;
    this.log(`Description import complete: ${imported.toLocaleString()}`);
  }

  async deriveConceptDisplays() {
    this.log('Deriving concept display values from designations...');

    await this.runSql(
      `UPDATE concept
       SET display = COALESCE(
         (
           SELECT d.term
           FROM designation d
           WHERE d.concept_id = concept.concept_id
             AND d.active = 1
           ORDER BY d.designation_id ASC
           LIMIT 1
         ),
         concept.code
       )
       WHERE cs_id = ?`,
      [this.csId]
    );
  }

  async importRelationships(files) {
    this.log(`Importing relationships from ${files.length} files...`);

    const rows = [];
    let imported = 0;

    for (const file of files) {
      for await (const cols of readTsv(file)) {
        if (cols.length < 10) continue;

        const active = cols[2] === '1' ? 1 : 0;
        const sourceCode = cols[4];
        const targetCode = cols[5];
        const groupId = parseInt(cols[6], 10) || 0;
        const typeId = cols[7] || null;
        const characteristicTypeId = cols[8] || null;
        const sourceConceptId = this.conceptIdByCode.get(sourceCode);
        const targetConceptId = this.conceptIdByCode.get(targetCode);
        if (!sourceConceptId || !targetConceptId) continue;

        const propertyId = await this.ensureProperty(typeId, 'concept', typeId === IS_A_TYPE_ID ? 1 : 0);
        if (!propertyId) continue;

        rows.push([
          edgeSetIdFromCharacteristic(characteristicTypeId),
          sourceConceptId,
          propertyId,
          targetConceptId,
          groupId,
          active,
        ]);

        imported += 1;

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT INTO concept_link (edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)`,
            6,
            rows
          );
          rows.length = 0;
          this.log(`  relationships imported: ${imported.toLocaleString()}`);
        }
      }
    }

    if (rows.length > 0) {
      await this.bulkInsert(
        `INSERT INTO concept_link (edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)`,
        6,
        rows
      );
    }

    this.stats.relationships = imported;
    this.log(`Relationship import complete: ${imported.toLocaleString()}`);
  }

  async importConcreteValues(files) {
    if (!files || files.length === 0) {
      this.log('No concrete value files found; skipping');
      return;
    }

    this.log(`Importing concrete values from ${files.length} files...`);

    const rows = [];
    let imported = 0;

    for (const file of files) {
      for await (const cols of readTsv(file)) {
        if (cols.length < 10) continue;

        const active = cols[2] === '1' ? 1 : 0;
        const sourceCode = cols[4];
        const rawValue = cols[5];
        const groupId = parseInt(cols[6], 10) || 0;
        const typeId = cols[7] || null;
        const characteristicTypeId = cols[8] || null;
        const sourceConceptId = this.conceptIdByCode.get(sourceCode);
        if (!sourceConceptId) continue;

        const propertyId = await this.ensureProperty(typeId, 'literal', 0);
        if (!propertyId) continue;

        const parsed = parseConcreteValue(rawValue);

        rows.push([
          edgeSetIdFromCharacteristic(characteristicTypeId),
          sourceConceptId,
          propertyId,
          groupId,
          active,
          rawValue,
          parsed.valueText,
          parsed.valueNum,
          parsed.valueBool,
        ]);

        imported += 1;

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT INTO concept_literal (edge_set_id, source_concept_id, property_id, group_id, active, value_raw, value_text, value_num, value_bool)`,
            9,
            rows
          );
          rows.length = 0;
          this.log(`  concrete values imported: ${imported.toLocaleString()}`);
        }
      }
    }

    if (rows.length > 0) {
      await this.bulkInsert(
        `INSERT INTO concept_literal (edge_set_id, source_concept_id, property_id, group_id, active, value_raw, value_text, value_num, value_bool)`,
        9,
        rows
      );
    }

    this.stats.concreteValues = imported;
    this.log(`Concrete value import complete: ${imported.toLocaleString()}`);
  }

  async importRefsets(files) {
    if (!files || files.length === 0) {
      this.log('No refset files found; skipping');
      return;
    }

    this.log(`Importing refsets from ${files.length} files...`);

    const memberRows = [];
    const seenRefsets = new Map();
    let memberCount = 0;

    for (const file of files) {
      for await (const cols of readTsv(file)) {
        if (cols.length < 6) continue;

        const active = cols[2] === '1' ? 1 : 0;
        if (!active) continue;

        const refsetId = cols[4];
        const componentId = cols[5];
        const conceptId = this.conceptIdByCode.get(componentId);

        if (!refsetId || !componentId) continue;
        if (!conceptId) continue;

        const vsUrl = `${BASE_URI}?fhir_vs=refset/${refsetId}`;

        if (!seenRefsets.has(vsUrl)) {
          await this.runSql(
            `INSERT OR IGNORE INTO value_set (cs_id, url, version, name)
             VALUES (?, ?, ?, ?)`,
            [this.csId, vsUrl, this.config.version || null, `SNOMED Refset ${refsetId}`]
          );
          const row = await this.get(
            `SELECT vs_id
             FROM value_set
             WHERE cs_id = ? AND url = ? AND version = ?`,
            [this.csId, vsUrl, this.config.version || null]
          );
          if (!row) continue;
          seenRefsets.set(vsUrl, row.vs_id);
        }

        memberRows.push([
          seenRefsets.get(vsUrl),
          conceptId,
          1
        ]);
        memberCount += 1;

        if (memberRows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT OR IGNORE INTO value_set_member (vs_id, concept_id, active)`,
            3,
            memberRows
          );
          memberRows.length = 0;
          this.log(`  refset members imported: ${memberCount.toLocaleString()}`);
        }
      }
    }

    if (memberRows.length > 0) {
      await this.bulkInsert(
        `INSERT OR IGNORE INTO value_set_member (vs_id, concept_id, active)`,
        3,
        memberRows
      );
    }

    this.stats.refsets = seenRefsets.size;
    this.stats.refsetMembers = memberCount;
    this.log(`Refset import complete: ${seenRefsets.size.toLocaleString()} refsets, ${memberCount.toLocaleString()} members`);
  }

  async buildClosure() {
    this.log('Building transitive closure (is-a, inferred)...');
    if (!this.isAPropertyId) {
      throw new Error('Cannot build closure: is-a property_id not resolved');
    }

    await this.exec('BEGIN TRANSACTION');
    try {
      await this.exec('DELETE FROM closure');

      // Temp frontier tables for iterative breadth expansion.
      await this.exec(`
        CREATE TEMP TABLE IF NOT EXISTS _closure_frontier (
          ancestor_id INTEGER NOT NULL,
          descendant_id INTEGER NOT NULL,
          depth INTEGER NOT NULL,
          PRIMARY KEY (ancestor_id, descendant_id)
        ) WITHOUT ROWID;

        CREATE TEMP TABLE IF NOT EXISTS _closure_next (
          ancestor_id INTEGER NOT NULL,
          descendant_id INTEGER NOT NULL,
          depth INTEGER NOT NULL,
          PRIMARY KEY (ancestor_id, descendant_id)
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS _idx_closure_frontier_desc
          ON _closure_frontier(descendant_id, ancestor_id);
      `);

      await this.exec('DELETE FROM _closure_frontier');
      await this.exec('DELETE FROM _closure_next');

      // Self rows (depth 0) go directly into closure.
      await this.runSql(
        `INSERT OR IGNORE INTO closure (ancestor_id, descendant_id)
         SELECT concept_id, concept_id
         FROM concept
         WHERE cs_id = ?`,
        [this.csId]
      );

      // Direct is-a edges (depth 1) populate closure + initial frontier.
      await this.runSql(
        `INSERT OR IGNORE INTO closure (ancestor_id, descendant_id)
         SELECT target_concept_id, source_concept_id
         FROM concept_link
         WHERE active = 1
           AND property_id = ?
           AND edge_set_id = ?`,
        [this.isAPropertyId, EDGE_SET_INFERRED]
      );

      await this.runSql(
        `INSERT OR IGNORE INTO _closure_frontier (ancestor_id, descendant_id, depth)
         SELECT target_concept_id, source_concept_id, 1
         FROM concept_link
         WHERE active = 1
           AND property_id = ?
           AND edge_set_id = ?`,
        [this.isAPropertyId, EDGE_SET_INFERRED]
      );

      let iteration = 0;
      let cumulativeNew = 0;
      while (true) {
        await this.exec('DELETE FROM _closure_next');

        await this.runSql(
          `INSERT OR IGNORE INTO _closure_next (ancestor_id, descendant_id, depth)
           SELECT f.ancestor_id, l.source_concept_id, f.depth + 1
           FROM _closure_frontier f
           JOIN concept_link l
             ON l.property_id = ?
            AND l.edge_set_id = ?
            AND l.active = 1
            AND l.target_concept_id = f.descendant_id
           WHERE NOT EXISTS (
             SELECT 1
             FROM closure c
             WHERE c.ancestor_id = f.ancestor_id
               AND c.descendant_id = l.source_concept_id
           )`,
          [this.isAPropertyId, EDGE_SET_INFERRED]
        );

        const nextCountRow = await this.get(`SELECT COUNT(*) AS n FROM _closure_next`);
        const nextCount = nextCountRow ? nextCountRow.n : 0;
        if (nextCount === 0) {
          if (this.config.verbose) {
            this.log(`  closure iteration ${iteration + 1}: +0 rows`);
          }
          break;
        }

        await this.runSql(
          `INSERT OR IGNORE INTO closure (ancestor_id, descendant_id)
           SELECT ancestor_id, descendant_id
           FROM _closure_next`,
          []
        );

        await this.exec('DELETE FROM _closure_frontier');
        await this.exec(
          `INSERT OR IGNORE INTO _closure_frontier (ancestor_id, descendant_id, depth)
           SELECT ancestor_id, descendant_id, depth
           FROM _closure_next`
        );

        iteration += 1;
        cumulativeNew += nextCount;
        if (this.config.verbose || iteration % 5 === 0) {
          this.log(`  closure iteration ${iteration}: +${nextCount.toLocaleString()} rows (cumulative ${cumulativeNew.toLocaleString()})`);
        }
      }

      await this.exec('DELETE FROM _closure_frontier');
      await this.exec('DELETE FROM _closure_next');

      await this.exec('COMMIT');
    } catch (error) {
      await this.exec('ROLLBACK');
      throw error;
    }

    const row = await this.get(
      `SELECT COUNT(*) AS n FROM closure`,
      []
    );

    this.stats.closureRows = row ? row.n : 0;
    this.log(`Closure complete: ${this.stats.closureRows.toLocaleString()} rows`);
  }

  async writeCsConfig() {
    const runtimeFilters = {
      concept: { operators: ['=', 'is-a', 'descendent-of', 'in'] },
      code: { operators: ['regex'] }
    };

    const runtimeSearch = {
      mode: 'fts-broad',
      activeOnly: true,
      designationActiveOnly: true,
      literalActiveOnly: true,
      sources: ['display', 'designation', 'literal'],
      ftsTables: {
        display: 'search_fts_display',
        designation: 'search_fts_designation',
        literal: 'search_fts_literal'
      },
      likeFallback: { enabled: true, caseInsensitive: true }
    };

    const configRows = [
      ['runtime.versioning', JSON.stringify({ algorithm: 'date', partialMatch: true })],
      ['runtime.languages', JSON.stringify({ default: 'en' })],
      ['runtime.designations', JSON.stringify({
        useMapping: {
          fsn: { system: BASE_URI, code: FSN_TYPE_ID, display: 'Fully specified name' },
          synonym: { system: BASE_URI, code: SYNONYM_TYPE_ID, display: 'Synonym (core metadata concept)' }
        },
        primaryDisplay: {
          source: 'designation',
          strategy: 'first-active',
          activeOnly: true,
          order: 'designation_id_asc'
        }
      })],
      ['runtime.hierarchy', JSON.stringify({
        propertyCode: IS_A_TYPE_ID,
        edgeSetId: EDGE_SET_INFERRED,
        closure: { enabled: true, fallbackRecursive: false }
      })],
      ['runtime.filters', JSON.stringify(runtimeFilters)],
      ['runtime.implicitValueSets', JSON.stringify({
        all: { queries: ['fhir_vs', 'fhir_vs=all'] },
        isa: { queryPrefix: 'fhir_vs=isa/', filter: { property: 'concept', op: 'is-a', valueFromSuffix: true } },
        refset: { queryPrefix: 'fhir_vs=refset/', filter: { property: 'concept', op: 'in', valueFromSuffix: true } }
      })],
      ['runtime.status', JSON.stringify({
        inactive: { source: 'concept.active', invert: true },
        deprecated: { source: 'constant', value: false },
        abstract: { source: 'constant', value: false }
      })],
      ['runtime.search', JSON.stringify(runtimeSearch)],
      ['runtime.behaviorFlags', JSON.stringify({
        tags: ['snomed']
      })]
    ];

    for (const [key, value] of configRows) {
      await this.runSql(
        `INSERT OR REPLACE INTO cs_config (cs_id, key, value) VALUES (?, ?, ?)`,
        [this.csId, key, typeof value === 'string' ? value : JSON.stringify(value)]
      );
    }
  }

  async finalizeDatabase() {
    this.log('Finalizing SQLite database...');
    await this.exec('ANALYZE');
    await this.exec('PRAGMA journal_mode = DELETE');
    await this.exec('PRAGMA synchronous = NORMAL');
    await this.exec('VACUUM');
  }

  async buildSearchIndexes() {
    this.log('Building broad text search indexes (display/designation/literal)...');

    await this.exec('BEGIN TRANSACTION');
    try {
      await this.exec('DELETE FROM search_fts_display');
      await this.exec('DELETE FROM search_fts_designation');
      await this.exec('DELETE FROM search_fts_literal');

      const display = await this.runSql(
        `INSERT INTO search_fts_display(rowid, term)
         SELECT concept_id, trim(display)
         FROM concept
         WHERE cs_id = ?
           AND display IS NOT NULL
           AND trim(display) <> ''`,
        [this.csId]
      );

      const designation = await this.runSql(
        `INSERT INTO search_fts_designation(rowid, term)
         SELECT d.designation_id, trim(d.term)
         FROM designation d
         JOIN concept c ON c.concept_id = d.concept_id
         WHERE c.cs_id = ?
           AND d.term IS NOT NULL
           AND trim(d.term) <> ''`,
        [this.csId]
      );

      const literal = await this.runSql(
        `INSERT INTO search_fts_literal(rowid, term)
         SELECT literal_id, txt
         FROM (
           SELECT cl.literal_id AS literal_id,
                  trim(COALESCE(NULLIF(cl.value_text, ''), NULLIF(cl.value_raw, ''))) AS txt
           FROM concept_literal cl
           JOIN concept c ON c.concept_id = cl.source_concept_id
           WHERE c.cs_id = ?
         ) x
         WHERE txt IS NOT NULL
           AND txt <> ''`,
        [this.csId]
      );

      await this.exec(`INSERT INTO search_fts_display(search_fts_display) VALUES ('optimize')`);
      await this.exec(`INSERT INTO search_fts_designation(search_fts_designation) VALUES ('optimize')`);
      await this.exec(`INSERT INTO search_fts_literal(search_fts_literal) VALUES ('optimize')`);

      await this.exec('COMMIT');

      this.stats.ftsDisplayRows = display.changes || 0;
      this.stats.ftsDesignationRows = designation.changes || 0;
      this.stats.ftsLiteralRows = literal.changes || 0;

      this.log(
        `Search index complete: display=${this.stats.ftsDisplayRows.toLocaleString()}, ` +
        `designation=${this.stats.ftsDesignationRows.toLocaleString()}, ` +
        `literal=${this.stats.ftsLiteralRows.toLocaleString()}`
      );
    } catch (error) {
      await this.exec('ROLLBACK');
      throw error;
    }
  }

  async ensureProperty(propertyCode, valueKind, isHierarchy) {
    if (!propertyCode) return null;
    if (this.propertyIdByCode.has(propertyCode)) {
      return this.propertyIdByCode.get(propertyCode);
    }

    await this.runSql(
      `INSERT OR IGNORE INTO property_def (cs_id, property_code, value_kind, is_hierarchy)
       VALUES (?, ?, ?, ?)`,
      [this.csId, propertyCode, valueKind, isHierarchy]
    );

    const row = await this.get(
      `SELECT property_id
       FROM property_def
       WHERE cs_id = ? AND property_code = ?`,
      [this.csId, propertyCode]
    );
    if (!row) return null;

    this.propertyIdByCode.set(propertyCode, row.property_id);
    this.seenPropertyCodes.add(propertyCode);
    return row.property_id;
  }

  async bulkInsert(sqlPrefix, columnCount, rows) {
    if (!rows.length) return;

    const chunkSize = Math.max(1, Math.floor(MAX_SQL_PARAMS / columnCount));
    await this.exec('BEGIN TRANSACTION');

    try {
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => `(${new Array(columnCount).fill('?').join(',')})`).join(',');
        const flat = [];
        for (const row of chunk) {
          for (const value of row) flat.push(value);
        }

        await this.runSql(`${sqlPrefix} VALUES ${placeholders}`, flat);
      }

      await this.exec('COMMIT');
    } catch (error) {
      await this.exec('ROLLBACK');
      throw error;
    }
  }

  async runSql(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function onRun(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ changes: this.changes || 0, lastID: this.lastID });
        }
      });
    });
  }

  async get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async exec(sql) {
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  log(message) {
    if (!this.config.verbose) return;
    console.log(message);
  }
}

function parseEditionAndVersion(uri) {
  if (!uri) return { edition: null, version: null };

  const match = uri.match(/\/sct\/(\d+)\/version\/(\d{8})/);
  if (!match) return { edition: null, version: null };

  return {
    edition: match[1],
    version: match[2]
  };
}

function snomedName(editionCode) {
  if (!editionCode) return 'SNOMED CT';
  if (editionCode === '900000000000207008') return 'SNOMED CT International';
  if (editionCode === '731000124108') return 'SNOMED CT US Edition';
  return `SNOMED CT ${editionCode}`;
}

function edgeSetIdFromCharacteristic(characteristicTypeId) {
  if (characteristicTypeId === CHAR_STATED) return EDGE_SET_STATED;
  if (characteristicTypeId === CHAR_ADDITIONAL) return EDGE_SET_ADDITIONAL;
  if (characteristicTypeId === CHAR_INFERRED) return EDGE_SET_INFERRED;
  return EDGE_SET_INFERRED;
}

function mapUseCode(typeId) {
  if (typeId === FSN_TYPE_ID) return 'fsn';
  if (typeId === SYNONYM_TYPE_ID) return 'synonym';
  return typeId || null;
}

function parseConcreteValue(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return { valueText: null, valueNum: null, valueBool: null };
  }

  if (rawValue.startsWith('#')) {
    const n = Number(rawValue.slice(1));
    return {
      valueText: null,
      valueNum: Number.isFinite(n) ? n : null,
      valueBool: null
    };
  }

  if (rawValue === 'true' || rawValue === 'false') {
    return {
      valueText: null,
      valueNum: null,
      valueBool: rawValue === 'true' ? 1 : 0
    };
  }

  if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
    return {
      valueText: rawValue.slice(1, -1),
      valueNum: null,
      valueBool: null
    };
  }

  return {
    valueText: rawValue,
    valueNum: null,
    valueBool: null
  };
}

function classifyRf2File(filePath, firstLine, files) {
  if (!firstLine) return;

  if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId')) {
    files.concepts.push(filePath);
    return;
  }

  if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\tconceptId\tlanguageCode\ttypeId\tterm\tcaseSignificanceId')) {
    files.descriptions.push(filePath);
    return;
  }

  if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\tsourceId\tdestinationId\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId')) {
    if (filePath.toLowerCase().includes('statedrelationship')) {
      return;
    }
    files.relationships.push(filePath);
    return;
  }

  if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\tsourceId\tvalue\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId')) {
    files.concreteValues.push(filePath);
    return;
  }

  if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\tacceptabilityId')) {
    files.languageRefsets.push(filePath);
    files.refsets.push(filePath);
    return;
  }

  if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId')) {
    files.refsets.push(filePath);
  }
}

function scanDirectory(dir, files, snapshotOnly) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) {
        scanDirectory(fullPath, files, snapshotOnly);
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;

    if (snapshotOnly && !fullPath.toLowerCase().includes('snapshot')) {
      continue;
    }

    const firstLine = readFirstLine(fullPath);
    classifyRf2File(fullPath, firstLine, files);
  }
}

function readFirstLine(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const count = fs.readSync(fd, buf, 0, buf.length, 0);
    if (count <= 0) return '';

    const text = buf.toString('utf8', 0, count);
    const index = text.indexOf('\n');
    if (index < 0) return text.trim();
    return text.slice(0, index).replace(/\r$/, '');
  } finally {
    fs.closeSync(fd);
  }
}

async function* readTsv(filePath) {
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (lineNumber === 1) continue;
    if (!line) continue;
    yield line.split('\t');
  }
}

function openSqlite(filePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function closeSqlite(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = {
  SnomedSqliteV0Importer,
  constants: {
    BASE_URI,
    IS_A_TYPE_ID,
    FSN_TYPE_ID,
    SYNONYM_TYPE_ID,
    CHAR_INFERRED,
    CHAR_STATED,
    CHAR_ADDITIONAL,
    ACCEPTABILITY_PREFERRED,
    EDGE_SET_INFERRED,
    EDGE_SET_STATED,
    EDGE_SET_ADDITIONAL
  }
};
