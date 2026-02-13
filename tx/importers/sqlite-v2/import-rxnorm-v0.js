'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const BASE_URI = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const IS_A_PROPERTY_CODE = 'isa';
const TTY_PROPERTY_CODE = 'TTY';

const EDGE_SET_INFERRED = 1;

const MAX_SQL_PARAMS = 900;
const FLUSH_ROW_TARGET = 5000;

const TTY_PRIORITY = ['PSN', 'SCD', 'SBD', 'GPCK', 'BPCK', 'IN', 'MIN', 'PIN', 'BN'];
const PREFERRED_TTYS = new Set(['PSN', 'SCD', 'SBD']);

const IMPORTABLE_ATNS = new Set([
  'NDC',
  'RXN_AVAILABLE_STRENGTH',
  'RXN_HUMAN_DRUG',
  'RXN_VET_DRUG',
  'RXN_STRENGTH',
  'RXN_QUANTITY',
  'RXTERM_FORM',
  'RXN_ACTIVATED',
  'RXN_OBSOLETED',
  'RXN_QUALITATIVE_DISTINCTION',
  'RXN_BN_CARDINALITY',
  'RXN_IN_EXPRESSED_FLAG',
  'RXCUI_STATUS'
]);

class RxNormSqliteV0Importer {
  constructor(config = {}) {
    this.config = {
      source: config.source,
      dest: config.dest,
      version: normalizeVersion(config.version) || detectVersionFromPath(config.source),
      uri: config.uri,
      skipClosure: !!config.skipClosure,
      verbose: !!config.verbose,
      overwrite: !!config.overwrite
    };

    if (!this.config.uri) {
      this.config.uri = this.config.version ? `${BASE_URI}|${this.config.version}` : BASE_URI;
    }

    this.db = null;
    this.csId = null;
    this.auditRunId = null;

    this.sourceRoot = null;
    this.extractedTempDir = null;

    this.propertyIdByCode = new Map();
    this.conceptIdByCode = new Map();
    this.nextConceptId = 1;
    this.isAPropertyId = null;
    this.ttyPropertyId = null;

    this.stats = {
      concepts: 0,
      designations: 0,
      relationships: 0,
      literals: 0,
      closureRows: 0,
      ftsDisplayRows: 0,
      ftsDesignationRows: 0,
      ftsLiteralRows: 0
    };
  }

  static discoverRrfFiles(source) {
    const files = {
      rxnconso: null,
      rxnrel: null,
      rxnsat: null,
      rxnsab: null
    };
    scanDirectoryForRrf(source, files);
    return files;
  }

  async run() {
    if (!this.config.source || !this.config.dest) {
      throw new Error('source and dest are required');
    }

    await this.prepareSource();
    const files = RxNormSqliteV0Importer.discoverRrfFiles(this.sourceRoot);

    if (!files.rxnconso) {
      throw new Error('RXNCONSO.RRF was not found');
    }

    if (!this.config.version) {
      this.config.version = await detectVersionFromRxnSab(files.rxnsab);
      if (this.config.version && this.config.uri === BASE_URI) {
        this.config.uri = `${BASE_URI}|${this.config.version}`;
      }
    }

    await this.openDatabase();
    await this.createSchema();

    try {
      await this.startAudit();
      await this.createCodeSystem();

      this.log(
        `Discovered files: RXNCONSO=${bool(files.rxnconso)}, RXNREL=${bool(files.rxnrel)}, ` +
        `RXNSAT=${bool(files.rxnsat)}, RXNSAB=${bool(files.rxnsab)}`
      );

      await this.importConcepts(files.rxnconso);
      await this.importDesignations(files.rxnconso);
      await this.importRelationships(files.rxnrel);
      await this.importAttributes(files.rxnsat);
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
      await this.cleanupSource();
    }

    return {
      csId: this.csId,
      uri: this.config.uri,
      stats: this.stats
    };
  }

  async prepareSource() {
    const src = path.resolve(this.config.source);
    if (!fs.existsSync(src)) {
      throw new Error(`Source does not exist: ${src}`);
    }

    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      this.sourceRoot = src;
      return;
    }

    if (!stat.isFile()) {
      throw new Error(`Unsupported source type: ${src}`);
    }

    if (!src.toLowerCase().endsWith('.zip')) {
      throw new Error('Source must be an RXNORM directory or a .zip file');
    }

    this.extractedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rxnorm-sqlite-v0-'));
    this.log(`Extracting ${src} to ${this.extractedTempDir} ...`);

    try {
      execFileSync('unzip', ['-q', src, '-d', this.extractedTempDir], {
        stdio: 'pipe'
      });
    } catch (error) {
      throw new Error(`Failed to extract zip '${src}': ${error.message}`);
    }

    this.sourceRoot = this.extractedTempDir;
  }

  async cleanupSource() {
    if (this.extractedTempDir && fs.existsSync(this.extractedTempDir)) {
      fs.rmSync(this.extractedTempDir, { recursive: true, force: true });
      this.log(`Removed temporary extraction directory: ${this.extractedTempDir}`);
    }
    this.extractedTempDir = null;
    this.sourceRoot = null;
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
       VALUES (CURRENT_TIMESTAMP, ?, ?, 'rxnorm', NULL, ?, 'running')`,
      [this.config.source, this.config.dest, this.config.version || null]
    );
    this.auditRunId = result.lastID;
  }

  async completeAudit(status, error) {
    if (!this.auditRunId) return;

    const payload = {
      uri: this.config.uri,
      version: this.config.version || null,
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
       VALUES (?, NULL, ?, ?, 'RxNorm', 'rrf')`,
      [BASE_URI, this.config.version || null, this.config.uri]
    );
    this.csId = result.lastID;

    await this.runSql(
      `INSERT OR IGNORE INTO property_def (cs_id, property_code, value_kind, is_hierarchy, display)
       VALUES (?, ?, 'concept', 1, 'is-a')`,
      [this.csId, IS_A_PROPERTY_CODE]
    );
    const isARow = await this.get(
      `SELECT property_id
       FROM property_def
       WHERE cs_id = ? AND property_code = ?`,
      [this.csId, IS_A_PROPERTY_CODE]
    );
    if (!isARow) {
      throw new Error(`Unable to resolve property_id for '${IS_A_PROPERTY_CODE}'`);
    }
    this.isAPropertyId = isARow.property_id;
    this.propertyIdByCode.set(IS_A_PROPERTY_CODE, isARow.property_id);

    await this.runSql(
      `INSERT OR IGNORE INTO property_def (cs_id, property_code, value_kind, is_hierarchy, display)
       VALUES (?, ?, 'literal', 0, 'TTY')`,
      [this.csId, TTY_PROPERTY_CODE]
    );
    const ttyRow = await this.get(
      `SELECT property_id
       FROM property_def
       WHERE cs_id = ? AND property_code = ?`,
      [this.csId, TTY_PROPERTY_CODE]
    );
    if (!ttyRow) {
      throw new Error(`Unable to resolve property_id for '${TTY_PROPERTY_CODE}'`);
    }
    this.ttyPropertyId = ttyRow.property_id;
    this.propertyIdByCode.set(TTY_PROPERTY_CODE, ttyRow.property_id);
  }

  async importConcepts(rxnconsoFile) {
    this.log('Importing concepts from RXNCONSO.RRF...');

    const concepts = new Map();
    let scanned = 0;
    let matched = 0;

    for await (const cols of readRrf(rxnconsoFile)) {
      if (cols.length < 17) continue;

      scanned += 1;

      const rxcui = cols[0];
      const sab = cols[11];
      const tty = cols[12];
      const str = (cols[14] || '').trim();
      const suppress = cols[16];

      if (sab !== 'RXNORM' || !rxcui) continue;
      matched += 1;

      const rank = ttyRank(tty);
      const active = isSuppressed(suppress) ? 0 : 1;
      const existing = concepts.get(rxcui);
      if (!existing) {
        const ttys = new Map();
        if (tty) {
          ttys.set(tty, active);
        }
        concepts.set(rxcui, {
          display: str || rxcui,
          active,
          tty: tty || null,
          rank,
          ttys
        });
      } else {
        if (active === 1) {
          existing.active = 1;
        }
        if (tty) {
          const prev = existing.ttys.get(tty) || 0;
          if (!existing.ttys.has(tty) || active > prev) {
            existing.ttys.set(tty, active);
          }
        }

        // Keep the best display according to configured TTY priority.
        if ((str && rank < existing.rank) || !existing.display) {
          existing.display = str || rxcui;
          existing.rank = rank;
          existing.tty = tty || existing.tty;
        }
      }
    }

    this.log(`  scanned rows: ${scanned.toLocaleString()}, RXNORM rows: ${matched.toLocaleString()}`);
    this.log(`  unique RXCUIs: ${concepts.size.toLocaleString()}`);

    const conceptRows = [];
    const ttyLiteralRows = [];
    let ttyLiteralCount = 0;
    let imported = 0;

    for (const [rxcui, info] of concepts.entries()) {
      const conceptId = this.nextConceptId++;
      this.conceptIdByCode.set(rxcui, conceptId);

      conceptRows.push([
        conceptId,
        this.csId,
        rxcui,
        info.active,
        info.display || rxcui,
        null
      ]);

      for (const [ttyValue, ttyActive] of info.ttys.entries()) {
        ttyLiteralRows.push([
          EDGE_SET_INFERRED,
          conceptId,
          this.ttyPropertyId,
          0,
          ttyActive,
          ttyValue,
          ttyValue,
          null,
          null
        ]);
        ttyLiteralCount += 1;
      }

      imported += 1;

      if (conceptRows.length >= FLUSH_ROW_TARGET) {
        await this.bulkInsert(
          `INSERT INTO concept (concept_id, cs_id, code, active, display, definition)`,
          6,
          conceptRows
        );
        conceptRows.length = 0;
      }

      if (ttyLiteralRows.length >= FLUSH_ROW_TARGET) {
        await this.bulkInsert(
          `INSERT INTO concept_literal (edge_set_id, source_concept_id, property_id, group_id, active, value_raw, value_text, value_num, value_bool)`,
          9,
          ttyLiteralRows
        );
        ttyLiteralRows.length = 0;
      }
    }

    if (conceptRows.length > 0) {
      await this.bulkInsert(
        `INSERT INTO concept (concept_id, cs_id, code, active, display, definition)`,
        6,
        conceptRows
      );
    }
    if (ttyLiteralRows.length > 0) {
      await this.bulkInsert(
        `INSERT INTO concept_literal (edge_set_id, source_concept_id, property_id, group_id, active, value_raw, value_text, value_num, value_bool)`,
        9,
        ttyLiteralRows
      );
    }

    this.stats.concepts = imported;
    this.stats.literals += ttyLiteralCount;
    this.log(`Concept import complete: ${imported.toLocaleString()} concepts`);
  }

  async importDesignations(rxnconsoFile) {
    this.log('Importing designations from RXNCONSO.RRF...');

    const rows = [];
    let imported = 0;

    for await (const cols of readRrf(rxnconsoFile)) {
      if (cols.length < 17) continue;

      const rxcui = cols[0];
      const sab = cols[11];
      const tty = cols[12];
      const str = (cols[14] || '').trim();
      const suppress = cols[16];

      if (sab !== 'RXNORM' || !rxcui || !str) continue;

      const conceptId = this.conceptIdByCode.get(rxcui);
      if (!conceptId) continue;

      rows.push([
        conceptId,
        isSuppressed(suppress) ? 0 : 1,
        'en',
        tty || null,
        str,
        PREFERRED_TTYS.has(tty) ? 1 : 0
      ]);
      imported += 1;

      if (rows.length >= FLUSH_ROW_TARGET) {
        await this.bulkInsert(
          `INSERT INTO designation (concept_id, active, language_code, use_code, term, preferred)`,
          6,
          rows
        );
        rows.length = 0;
      }
    }

    if (rows.length > 0) {
      await this.bulkInsert(
        `INSERT INTO designation (concept_id, active, language_code, use_code, term, preferred)`,
        6,
        rows
      );
    }

    this.stats.designations = imported;
    this.log(`Designation import complete: ${imported.toLocaleString()} rows`);
  }

  async importRelationships(rxnrelFile) {
    if (!rxnrelFile) {
      this.log('RXNREL.RRF not found; skipping relationships');
      return;
    }

    this.log('Importing relationships from RXNREL.RRF...');

    const relaCodes = new Set();
    for await (const cols of readRrf(rxnrelFile)) {
      if (cols.length < 15) continue;
      const sab = cols[10];
      const rela = cols[7];
      if (sab === 'RXNORM' && rela) {
        relaCodes.add(rela);
      }
    }

    for (const rela of relaCodes) {
      await this.ensureProperty(rela, 'concept', rela === IS_A_PROPERTY_CODE ? 1 : 0);
    }

    const rows = [];
    let imported = 0;
    let skipped = 0;

    for await (const cols of readRrf(rxnrelFile)) {
      if (cols.length < 15) continue;

      const rxcui1 = cols[0];
      const rxcui2 = cols[4];
      const rela = cols[7];
      const sab = cols[10];
      const suppress = cols[14];

      if (sab !== 'RXNORM' || !rela) {
        skipped += 1;
        continue;
      }

      const sourceConceptId = this.conceptIdByCode.get(rxcui2);
      const targetConceptId = this.conceptIdByCode.get(rxcui1);
      const propertyId = this.propertyIdByCode.get(rela);

      if (!sourceConceptId || !targetConceptId || !propertyId) {
        skipped += 1;
        continue;
      }

      rows.push([
        EDGE_SET_INFERRED,
        sourceConceptId,
        propertyId,
        targetConceptId,
        0,
        isSuppressed(suppress) ? 0 : 1
      ]);
      imported += 1;

      if (rows.length >= FLUSH_ROW_TARGET) {
        await this.bulkInsert(
          `INSERT OR IGNORE INTO concept_link (edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)`,
          6,
          rows
        );
        rows.length = 0;
      }
    }

    if (rows.length > 0) {
      await this.bulkInsert(
        `INSERT OR IGNORE INTO concept_link (edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)`,
        6,
        rows
      );
    }

    this.stats.relationships = imported;
    this.log(`Relationship import complete: ${imported.toLocaleString()} rows (skipped ${skipped.toLocaleString()})`);
  }

  async importAttributes(rxnsatFile) {
    if (!rxnsatFile) {
      this.log('RXNSAT.RRF not found; skipping attributes');
      return;
    }

    this.log('Importing attributes from RXNSAT.RRF...');

    const atnCodes = new Set();
    for await (const cols of readRrf(rxnsatFile)) {
      if (cols.length < 13) continue;
      const atn = cols[8];
      const sab = cols[9];
      if (sab === 'RXNORM' && atn && IMPORTABLE_ATNS.has(atn)) {
        atnCodes.add(atn);
      }
    }

    for (const atn of atnCodes) {
      await this.ensureProperty(atn, 'literal', 0);
    }

    const rows = [];
    let imported = 0;

    for await (const cols of readRrf(rxnsatFile)) {
      if (cols.length < 13) continue;

      const rxcui = cols[0];
      const atn = cols[8];
      const sab = cols[9];
      const atv = (cols[10] || '').trim();
      const suppress = cols[11];

      if (sab !== 'RXNORM' || !IMPORTABLE_ATNS.has(atn) || !atv) continue;

      const conceptId = this.conceptIdByCode.get(rxcui);
      const propertyId = this.propertyIdByCode.get(atn);
      if (!conceptId || !propertyId) continue;

      const value = parseAttributeLiteral(atv);
      rows.push([
        EDGE_SET_INFERRED,
        conceptId,
        propertyId,
        0,
        isSuppressed(suppress) ? 0 : 1,
        atv,
        value.valueText,
        value.valueNum,
        value.valueBool
      ]);
      imported += 1;

      if (rows.length >= FLUSH_ROW_TARGET) {
        await this.bulkInsert(
          `INSERT INTO concept_literal (edge_set_id, source_concept_id, property_id, group_id, active, value_raw, value_text, value_num, value_bool)`,
          9,
          rows
        );
        rows.length = 0;
      }
    }

    if (rows.length > 0) {
      await this.bulkInsert(
        `INSERT INTO concept_literal (edge_set_id, source_concept_id, property_id, group_id, active, value_raw, value_text, value_num, value_bool)`,
        9,
        rows
      );
    }

    this.stats.literals += imported;
    this.log(`Attribute import complete: ${imported.toLocaleString()} rows`);
  }

  async buildClosure() {
    this.log('Building transitive closure (is-a)...');
    if (!this.isAPropertyId) {
      this.log('No is-a property id found; skipping closure');
      return;
    }

    await this.exec('BEGIN TRANSACTION');
    try {
      await this.exec('DELETE FROM closure');

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

      await this.runSql(
        `INSERT OR IGNORE INTO closure (ancestor_id, descendant_id)
         SELECT concept_id, concept_id
         FROM concept
         WHERE cs_id = ?`,
        [this.csId]
      );

      await this.runSql(
        `INSERT OR IGNORE INTO closure (ancestor_id, descendant_id)
         SELECT l.target_concept_id, l.source_concept_id
         FROM concept_link l
         JOIN concept c ON c.concept_id = l.source_concept_id
         WHERE c.cs_id = ?
           AND l.active = 1
           AND l.property_id = ?
           AND l.edge_set_id = ?`,
        [this.csId, this.isAPropertyId, EDGE_SET_INFERRED]
      );

      await this.runSql(
        `INSERT OR IGNORE INTO _closure_frontier (ancestor_id, descendant_id, depth)
         SELECT l.target_concept_id, l.source_concept_id, 1
         FROM concept_link l
         JOIN concept c ON c.concept_id = l.source_concept_id
         WHERE c.cs_id = ?
           AND l.active = 1
           AND l.property_id = ?
           AND l.edge_set_id = ?`,
        [this.csId, this.isAPropertyId, EDGE_SET_INFERRED]
      );

      let iteration = 0;
      let cumulativeNew = 0;
      let hasNext = true;
      while (hasNext) {
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

        const nextRow = await this.get('SELECT COUNT(*) AS n FROM _closure_next', []);
        const nextCount = nextRow ? nextRow.n : 0;
        if (nextCount === 0) {
          hasNext = false;
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

    const row = await this.get('SELECT COUNT(*) AS n FROM closure', []);
    this.stats.closureRows = row ? row.n : 0;
    this.log(`Closure complete: ${this.stats.closureRows.toLocaleString()} rows`);
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

  async writeCsConfig() {
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

    const runtimeFilters = {
      concept: { operators: ['=', 'is-a', 'descendent-of'] },
      code: { operators: ['regex'] },
      properties: {
        aliases: {
          tty: TTY_PROPERTY_CODE,
          TTY: TTY_PROPERTY_CODE
        },
        byCode: {
          [TTY_PROPERTY_CODE]: {
            operators: ['=', 'in'],
            sources: ['literal'],
            value: {
              normalizeCase: true
            }
          }
        }
      }
    };

    const runtimeDesignations = {
      defaultSystem: BASE_URI,
      useMapping: {
        PSN: { system: BASE_URI, code: 'PSN', display: 'Prescribable Name' },
        SCD: { system: BASE_URI, code: 'SCD', display: 'Semantic Clinical Drug' },
        SBD: { system: BASE_URI, code: 'SBD', display: 'Semantic Branded Drug' },
        SY: { system: BASE_URI, code: 'SY', display: 'Synonym' }
      }
    };

    const configRows = [
      ['runtime.versioning', JSON.stringify({ algorithm: 'string', partialMatch: false })],
      ['runtime.languages', JSON.stringify({ default: 'en' })],
      ['runtime.designations', JSON.stringify(runtimeDesignations)],
      ['runtime.hierarchy', JSON.stringify({
        propertyCode: IS_A_PROPERTY_CODE,
        edgeSetId: EDGE_SET_INFERRED,
        closure: { enabled: true, fallbackRecursive: false }
      })],
      ['runtime.filters', JSON.stringify(runtimeFilters)],
      ['runtime.implicitValueSets', JSON.stringify({
        all: { queries: ['fhir_vs', 'fhir_vs=all'] },
        isa: { queryPrefix: 'fhir_vs=isa/', filter: { property: 'concept', op: 'is-a', valueFromSuffix: true } }
      })],
      ['runtime.status', JSON.stringify({
        inactive: { source: 'concept.active', invert: true },
        deprecated: { source: 'constant', value: false },
        abstract: { source: 'constant', value: false }
      })],
      ['runtime.search', JSON.stringify(runtimeSearch)],
      ['runtime.behaviorFlags', JSON.stringify({
        tags: ['rxnorm']
      })]
    ];

    for (const [key, value] of configRows) {
      await this.runSql(
        `INSERT OR REPLACE INTO cs_config (cs_id, key, value)
         VALUES (?, ?, ?)`,
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
    if (propertyCode === IS_A_PROPERTY_CODE) {
      this.isAPropertyId = row.property_id;
    }
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

function normalizeVersion(version) {
  if (!version) return null;
  const text = String(version).trim();
  if (/^\d{8}$/.test(text)) {
    return text;
  }
  return null;
}

function detectVersionFromPath(value) {
  if (!value) return null;
  const text = String(value);
  const specific = text.match(/RxNorm[_-]full[_-](\d{8})/i);
  if (specific) {
    return specific[1];
  }
  const generic = text.match(/(\d{8})/);
  return generic ? generic[1] : null;
}

async function detectVersionFromRxnSab(rxnsabFile) {
  if (!rxnsabFile || !fs.existsSync(rxnsabFile)) {
    return null;
  }

  for await (const cols of readRrf(rxnsabFile)) {
    if (cols.length < 7) continue;
    const rsab = cols[3];
    const sver = cols[6] || '';
    if (rsab !== 'RXNORM') continue;

    // Typical form: 20AA_250804F -> YYMMDD embedded.
    const yyMMdd = sver.match(/(\d{6})/);
    if (yyMMdd) {
      const y = yyMMdd[1].slice(0, 2);
      const m = yyMMdd[1].slice(2, 4);
      const d = yyMMdd[1].slice(4, 6);
      return `${m}${d}20${y}`;
    }
  }
  return null;
}

function ttyRank(tty) {
  const idx = TTY_PRIORITY.indexOf(tty);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function isSuppressed(suppressFlag) {
  return suppressFlag === 'O' || suppressFlag === 'E';
}

function parseAttributeLiteral(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return {
      valueText: null,
      valueNum: null,
      valueBool: null
    };
  }

  if (text === 'true' || text === 'false') {
    return {
      valueText: text,
      valueNum: null,
      valueBool: text === 'true' ? 1 : 0
    };
  }

  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return {
      valueText: text,
      valueNum: Number.isFinite(n) ? n : null,
      valueBool: null
    };
  }

  return {
    valueText: text,
    valueNum: null,
    valueBool: null
  };
}

function scanDirectoryForRrf(dir, files) {
  if (!dir || !fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) {
        scanDirectoryForRrf(fullPath, files);
      }
      continue;
    }
    if (!entry.isFile()) continue;

    const name = entry.name.toUpperCase();
    if (name === 'RXNCONSO.RRF') files.rxnconso = fullPath;
    else if (name === 'RXNREL.RRF') files.rxnrel = fullPath;
    else if (name === 'RXNSAT.RRF') files.rxnsat = fullPath;
    else if (name === 'RXNSAB.RRF') files.rxnsab = fullPath;
  }
}

async function* readRrf(filePath) {
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    yield line.split('|');
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

function bool(value) {
  return value ? 'yes' : 'no';
}

module.exports = {
  RxNormSqliteV0Importer,
  constants: {
    BASE_URI,
    IS_A_PROPERTY_CODE,
    TTY_PROPERTY_CODE,
    EDGE_SET_INFERRED,
    TTY_PRIORITY,
    PREFERRED_TTYS,
    IMPORTABLE_ATNS
  }
};
