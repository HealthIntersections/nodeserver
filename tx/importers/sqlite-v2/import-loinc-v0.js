'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const BASE_URI = 'http://loinc.org';
const PARENT_PROPERTY_CODE = 'parent';
const EDGE_SET_PRIMARY = 1;

const MAX_SQL_PARAMS = 900;
const FLUSH_ROW_TARGET = 5000;

const PART_TYPE_PROPERTIES = [
  'COMPONENT',
  'PROPERTY',
  'TIME_ASPCT',
  'SYSTEM',
  'SCALE_TYP',
  'METHOD_TYP',
  'CLASS',
  'DOCUMENT.TYPEOFSETTING',
  'DOCUMENT.TYPEOFSERVICE',
  'DOCUMENT.ROLE',
  'DOCUMENT.SUBJECT',
  'DOCUMENT.KIND',
  'SUPER.SYSTEM',
  'RAD.ANATOMIC.LOCATION',
  'RAD.ANATOMIC.LOCATION.LATERALITY',
  'RAD.ANATOMIC.LOCATION.REGION.IMAGED',
  'RAD.GUIDANCE.FOR.ACTION',
  'RAD.GUIDANCE.FOR.APPROACH',
  'RAD.MANEUVER.MANEUVER.TYPE',
  'RAD.MODALITY.MODALITY.SUBTYPE',
  'RAD.MODALITY.MODALITY.TYPE',
  'RAD.PHARMACEUTICAL.ROUTE',
  'RAD.PHARMACEUTICAL.SUBSTANCE.GIVEN',
  'RAD.REASON.FOR.EXAM',
  'RAD.TIMING',
  'RAD.VIEW.AGGREGATION',
  'RAD.VIEW.VIEW.TYPE',
  'CHALLENGE',
  'ADJUSTMENT',
  'COUNT',
  'DIVISOR',
  'TIME.MODIFIER',
  'SUFFIX'
];

const PART_TYPE_NORMALIZATION = {
  TIME: 'TIME_ASPCT',
  SCALE: 'SCALE_TYP',
  METHOD: 'METHOD_TYP'
};

const LITERAL_COLUMN_MAP = [
  { property: 'CLASS', column: 'CLASS' },
  { property: 'COMPONENT', column: 'COMPONENT' },
  { property: 'PROPERTY', column: 'PROPERTY' },
  { property: 'TIME_ASPCT', column: 'TIME_ASPCT' },
  { property: 'SYSTEM', column: 'SYSTEM' },
  { property: 'SCALE_TYP', column: 'SCALE_TYP' },
  { property: 'METHOD_TYP', column: 'METHOD_TYP' },
  { property: 'ORDER_OBS', column: 'ORDER_OBS' },
  { property: 'CLASSTYPE', column: 'CLASSTYPE' },
  { property: 'STATUS', column: 'STATUS' },
  { property: 'EXAMPLE_UNITS', column: 'EXAMPLE_UNITS' },
  { property: 'EXAMPLE_UCUM_UNITS', column: 'EXAMPLE_UCUM_UNITS' },
  { property: 'UNITSREQUIRED', column: 'UNITSREQUIRED' },
  { property: 'FORMULA', column: 'FORMULA' },
  { property: 'SURVEY_QUEST_TEXT', column: 'SURVEY_QUEST_TEXT' },
  { property: 'DefinitionDescription', column: 'DefinitionDescription' },
  { property: 'EXTERNAL_COPYRIGHT_NOTICE', column: 'EXTERNAL_COPYRIGHT_NOTICE' },
  { property: 'RELATEDNAMES2', column: 'RELATEDNAMES2' }
];

class LoincSqliteV0Importer {
  constructor(config = {}) {
    const detectedVersion = detectVersionFromPath(config.source);
    this.config = {
      source: config.source,
      dest: config.dest,
      version: config.version || detectedVersion || null,
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
    this.classPartByName = new Map();
    this.loincClassByCode = new Map();

    this.nextConceptId = 1;
    this.hierarchyPropertyId = null;

    this.stats = {
      concepts: 0,
      designations: 0,
      relationships: 0,
      literals: 0,
      valueSets: 0,
      valueSetMembers: 0,
      closureRows: 0,
      ftsDisplayRows: 0,
      ftsDesignationRows: 0,
      ftsLiteralRows: 0
    };
  }

  static discoverCsvFiles(source) {
    const files = {
      loinc: null,
      part: null,
      partLink: null,
      hierarchy: null,
      consumerName: null,
      answerList: null,
      answerListLink: null,
      linguisticVariants: []
    };
    scanDirectoryForLoincFiles(source, files);
    return files;
  }

  async run() {
    if (!this.config.source || !this.config.dest) {
      throw new Error('source and dest are required');
    }

    await this.prepareSource();
    const files = LoincSqliteV0Importer.discoverCsvFiles(this.sourceRoot);
    if (!files.loinc) {
      throw new Error('Loinc.csv was not found');
    }

    await this.openDatabase();
    await this.createSchema();

    try {
      await this.startAudit();
      await this.createCodeSystem();
      await this.ensurePropertyDefinitions();

      this.log(
        `Discovered files: Loinc=${bool(files.loinc)}, Part=${bool(files.part)}, ` +
        `PartLink=${bool(files.partLink)}, Hierarchy=${bool(files.hierarchy)}, ` +
        `ConsumerName=${bool(files.consumerName)}, AnswerList=${bool(files.answerList)}, ` +
        `AnswerLink=${bool(files.answerListLink)}, LingVariants=${files.linguisticVariants.length}`
      );

      await this.importConcepts(files);
      await this.importDesignations(files);
      await this.importRelationships(files);
      await this.importLiterals(files);
      await this.buildSearchIndexes();

      if (!this.config.skipClosure) {
        await this.buildClosure(files);
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
      throw new Error('Source must be a LOINC directory or a .zip file');
    }

    this.extractedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loinc-sqlite-v0-'));
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
       VALUES (CURRENT_TIMESTAMP, ?, ?, 'loinc', NULL, ?, 'running')`,
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
       VALUES (?, NULL, ?, ?, 'LOINC', 'loinc-csv')`,
      [BASE_URI, this.config.version || null, this.config.uri]
    );
    this.csId = result.lastID;
  }

  async ensurePropertyDefinitions() {
    this.hierarchyPropertyId = await this.ensureProperty(PARENT_PROPERTY_CODE, 'concept', 1, 'parent');
    for (const partType of PART_TYPE_PROPERTIES) {
      await this.ensureProperty(partType, 'concept', 0, partType);
    }
    for (const item of LITERAL_COLUMN_MAP) {
      await this.ensureProperty(item.property, 'literal', 0, item.property);
    }
    await this.ensureProperty('LIST', 'literal', 0, 'LIST');
    await this.ensureProperty('Answer', 'concept', 0, 'Answer');
    await this.ensureProperty('answers-for', 'concept', 0, 'answers-for');
    await this.ensureProperty('AnswerList', 'concept', 0, 'AnswerList');
  }

  async importConcepts(files) {
    this.log('Importing concepts...');

    const rows = [];
    let loincCount = 0;
    let partCount = 0;
    let hierarchyNodeCount = 0;
    let answerListCount = 0;
    let answerCodeCount = 0;

    for await (const row of readCsv(files.loinc)) {
      const code = trim(row.LOINC_NUM);
      if (!code) continue;

      const display = trim(row.LONG_COMMON_NAME) || trim(row.DisplayName) || trim(row.SHORTNAME) || code;
      const definition = trim(row.DefinitionDescription) || null;
      const active = isActiveLoincStatus(row.STATUS) ? 1 : 0;
      const conceptId = this.nextConceptId++;

      rows.push([conceptId, this.csId, code, active, display, definition]);
      this.conceptIdByCode.set(code, conceptId);

      const className = trim(row.CLASS);
      if (className) {
        this.loincClassByCode.set(code, className.toUpperCase());
      }

      loincCount += 1;
      if (rows.length >= FLUSH_ROW_TARGET) {
        await this.bulkInsert(
          `INSERT INTO concept (concept_id, cs_id, code, active, display, definition)`,
          6,
          rows
        );
        rows.length = 0;
      }
    }

    if (files.part) {
      for await (const row of readCsv(files.part)) {
        const code = trim(row.PartNumber);
        if (!code || this.conceptIdByCode.has(code)) continue;

        // Keep parity with legacy LOINC provider:
        // PartName is the primary display; PartDisplayName is a designation.
        const display = trim(row.PartName) || trim(row.PartDisplayName) || code;
        const active = String(row.Status || '').toUpperCase() === 'ACTIVE' ? 1 : 0;
        const conceptId = this.nextConceptId++;

        rows.push([conceptId, this.csId, code, active, display, null]);
        this.conceptIdByCode.set(code, conceptId);
        partCount += 1;

        const partTypeName = trim(row.PartTypeName);
        const partName = trim(row.PartName);
        if (partTypeName === 'CLASS' && partName) {
          this.classPartByName.set(partName.toUpperCase(), code);
        }

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT INTO concept (concept_id, cs_id, code, active, display, definition)`,
            6,
            rows
          );
          rows.length = 0;
        }
      }
    }

    if (files.hierarchy) {
      for await (const row of readCsv(files.hierarchy)) {
        const code = trim(row.CODE);
        const parent = trim(row.IMMEDIATE_PARENT);

        if (code && !this.conceptIdByCode.has(code)) {
          const conceptId = this.nextConceptId++;
          rows.push([conceptId, this.csId, code, 1, trim(row.CODE_TEXT) || code, null]);
          this.conceptIdByCode.set(code, conceptId);
          hierarchyNodeCount += 1;
        }

        if (parent && !this.conceptIdByCode.has(parent)) {
          const parentId = this.nextConceptId++;
          rows.push([parentId, this.csId, parent, 1, parent, null]);
          this.conceptIdByCode.set(parent, parentId);
          hierarchyNodeCount += 1;
        }

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT INTO concept (concept_id, cs_id, code, active, display, definition)`,
            6,
            rows
          );
          rows.length = 0;
        }
      }
    }

    if (files.answerList) {
      for await (const row of readCsv(files.answerList)) {
        const listCode = trim(row.AnswerListId);
        if (listCode && !this.conceptIdByCode.has(listCode)) {
          const conceptId = this.nextConceptId++;
          const display = trim(row.AnswerListName) || listCode;
          rows.push([conceptId, this.csId, listCode, 1, display, trim(row.Description) || null]);
          this.conceptIdByCode.set(listCode, conceptId);
          answerListCount += 1;
        }

        const answerCode = trim(row.AnswerStringId);
        if (answerCode && !this.conceptIdByCode.has(answerCode)) {
          const conceptId = this.nextConceptId++;
          const display = trim(row.DisplayText) || answerCode;
          rows.push([conceptId, this.csId, answerCode, 1, display, trim(row.Description) || null]);
          this.conceptIdByCode.set(answerCode, conceptId);
          answerCodeCount += 1;
        }

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT INTO concept (concept_id, cs_id, code, active, display, definition)`,
            6,
            rows
          );
          rows.length = 0;
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

    this.stats.concepts = this.conceptIdByCode.size;
    this.log(
      `Concept import complete: loinc=${loincCount.toLocaleString()}, parts=${partCount.toLocaleString()}, ` +
      `extraHierarchy=${hierarchyNodeCount.toLocaleString()}, ` +
      `answerLists=${answerListCount.toLocaleString()}, answers=${answerCodeCount.toLocaleString()}, ` +
      `total=${this.stats.concepts.toLocaleString()}`
    );
  }

  async importDesignations(files) {
    this.log('Importing designations...');

    const rows = [];
    let imported = 0;

    for await (const row of readCsv(files.loinc)) {
      const code = trim(row.LOINC_NUM);
      const conceptId = this.conceptIdByCode.get(code);
      if (!conceptId) continue;

      const active = isActiveLoincStatus(row.STATUS) ? 1 : 0;

      const longName = trim(row.LONG_COMMON_NAME);
      if (longName) {
        rows.push([conceptId, active, 'en-US', 'LONG_COMMON_NAME', longName, 1]);
        imported += 1;
      }

      const shortName = trim(row.SHORTNAME);
      if (shortName) {
        rows.push([conceptId, active, 'en-US', 'SHORTNAME', shortName, 0]);
        imported += 1;
      }

      const displayName = trim(row.DisplayName);
      if (displayName && displayName !== longName) {
        rows.push([conceptId, active, 'en-US', 'DisplayName', displayName, 0]);
        imported += 1;
      }

      const consumerName = trim(row.CONSUMER_NAME);
      if (consumerName) {
        rows.push([conceptId, active, 'en-US', 'ConsumerName', consumerName, 0]);
        imported += 1;
      }

      if (rows.length >= FLUSH_ROW_TARGET) {
        await this.bulkInsert(
          `INSERT INTO designation (concept_id, active, language_code, use_code, term, preferred)`,
          6,
          rows
        );
        rows.length = 0;
      }
    }

    if (files.consumerName) {
      for await (const row of readCsv(files.consumerName)) {
        const code = trim(row.LoincNumber);
        const conceptId = this.conceptIdByCode.get(code);
        const consumer = trim(row.ConsumerName);
        if (!conceptId || !consumer) continue;

        rows.push([conceptId, 1, 'en-US', 'ConsumerName', consumer, 0]);
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
    }

    for (const variantFile of files.linguisticVariants) {
      const lang = languageFromVariantFilename(path.basename(variantFile));
      if (!lang) continue;

      for await (const row of readCsv(variantFile)) {
        const code = trim(row.LOINC_NUM);
        const conceptId = this.conceptIdByCode.get(code);
        if (!conceptId) continue;

        const longName = trim(row.LONG_COMMON_NAME);
        const shortName = trim(row.SHORTNAME);
        const variantDisplay = trim(row.LinguisticVariantDisplayName);
        if (longName) {
          rows.push([conceptId, 1, lang, 'LONG_COMMON_NAME', longName, 0]);
          imported += 1;
        }
        if (shortName) {
          rows.push([conceptId, 1, lang, 'SHORTNAME', shortName, 0]);
          imported += 1;
        }
        if (variantDisplay) {
          rows.push([conceptId, 1, lang, 'LinguisticVariantDisplayName', variantDisplay, 0]);
          imported += 1;
        }

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT INTO designation (concept_id, active, language_code, use_code, term, preferred)`,
            6,
            rows
          );
          rows.length = 0;
        }
      }
    }

    if (files.part) {
      for await (const row of readCsv(files.part)) {
        const code = trim(row.PartNumber);
        const conceptId = this.conceptIdByCode.get(code);
        if (!conceptId) continue;

        const display = trim(row.PartDisplayName) || trim(row.PartName);
        if (!display) continue;

        rows.push([conceptId, 1, 'en-US', 'DisplayName', display, 0]);
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

  async importRelationships(files) {
    this.log('Importing relationships...');

    const rows = [];
    let imported = 0;
    let classLinks = 0;
    let hierarchyLinks = 0;
    let partLinks = 0;
    let answerLinks = 0;
    let answerForLinks = 0;

    if (files.partLink) {
      for await (const row of readCsv(files.partLink)) {
        const sourceCode = trim(row.LoincNumber);
        const targetCode = trim(row.PartNumber);
        const partTypeRaw = trim(row.PartTypeName);
        const partType = PART_TYPE_NORMALIZATION[partTypeRaw] || partTypeRaw;
        if (!sourceCode || !targetCode || !partType) continue;

        const sourceConceptId = this.conceptIdByCode.get(sourceCode);
        const targetConceptId = this.conceptIdByCode.get(targetCode);
        const propertyId = this.propertyIdByCode.get(partType);
        if (!sourceConceptId || !targetConceptId || !propertyId) continue;

        rows.push([EDGE_SET_PRIMARY, sourceConceptId, propertyId, targetConceptId, 0, 1]);
        imported += 1;
        partLinks += 1;

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT OR IGNORE INTO concept_link (edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)`,
            6,
            rows
          );
          rows.length = 0;
        }
      }
    }

    if (files.hierarchy) {
      for await (const row of readCsv(files.hierarchy)) {
        const childCode = trim(row.CODE);
        const parentCode = trim(row.IMMEDIATE_PARENT);
        if (!childCode || !parentCode || childCode === parentCode) continue;

        const childConceptId = this.conceptIdByCode.get(childCode);
        const parentConceptId = this.conceptIdByCode.get(parentCode);
        if (!childConceptId || !parentConceptId) continue;

        rows.push([EDGE_SET_PRIMARY, childConceptId, this.hierarchyPropertyId, parentConceptId, 0, 1]);
        imported += 1;
        hierarchyLinks += 1;

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT OR IGNORE INTO concept_link (edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)`,
            6,
            rows
          );
          rows.length = 0;
        }
      }
    }

    const classPropertyId = this.propertyIdByCode.get('CLASS');
    if (classPropertyId) {
      for (const [loincCode, className] of this.loincClassByCode.entries()) {
        const classPartCode = this.classPartByName.get(className);
        if (!classPartCode) continue;

        const loincConceptId = this.conceptIdByCode.get(loincCode);
        const classConceptId = this.conceptIdByCode.get(classPartCode);
        if (!loincConceptId || !classConceptId) continue;

        rows.push([EDGE_SET_PRIMARY, loincConceptId, classPropertyId, classConceptId, 0, 1]);
        imported += 1;
        classLinks += 1;

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT OR IGNORE INTO concept_link (edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)`,
            6,
            rows
          );
          rows.length = 0;
        }
      }
    }

    const answerPropertyId = this.propertyIdByCode.get('Answer');
    if (answerPropertyId && files.answerList) {
      for await (const row of readCsv(files.answerList)) {
        const listCode = trim(row.AnswerListId);
        const answerCode = trim(row.AnswerStringId);
        if (!listCode || !answerCode) continue;

        const listConceptId = this.conceptIdByCode.get(listCode);
        const answerConceptId = this.conceptIdByCode.get(answerCode);
        if (!listConceptId || !answerConceptId) continue;

        rows.push([EDGE_SET_PRIMARY, listConceptId, answerPropertyId, answerConceptId, 0, 1]);
        imported += 1;
        answerLinks += 1;

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT OR IGNORE INTO concept_link (edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)`,
            6,
            rows
          );
          rows.length = 0;
        }
      }
    }

    const answersForPropertyId = this.propertyIdByCode.get('answers-for');
    if (answersForPropertyId && files.answerListLink) {
      for await (const row of readCsv(files.answerListLink)) {
        const loincCode = trim(row.LoincNumber);
        const listCode = trim(row.AnswerListId);
        if (!loincCode || !listCode) continue;

        const loincConceptId = this.conceptIdByCode.get(loincCode);
        const listConceptId = this.conceptIdByCode.get(listCode);
        if (!loincConceptId || !listConceptId) continue;

        rows.push([EDGE_SET_PRIMARY, listConceptId, answersForPropertyId, loincConceptId, 0, 1]);
        imported += 1;
        answerForLinks += 1;

        if (rows.length >= FLUSH_ROW_TARGET) {
          await this.bulkInsert(
            `INSERT OR IGNORE INTO concept_link (edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)`,
            6,
            rows
          );
          rows.length = 0;
        }
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
    this.log(
      `Relationship import complete: total=${imported.toLocaleString()} ` +
      `(part=${partLinks.toLocaleString()}, hierarchy=${hierarchyLinks.toLocaleString()}, ` +
      `class=${classLinks.toLocaleString()}, answer=${answerLinks.toLocaleString()}, ` +
      `answers-for=${answerForLinks.toLocaleString()})`
    );
  }

  async importLiterals(files) {
    this.log('Importing literal properties...');

    const rows = [];
    let imported = 0;
    for await (const row of readCsv(files.loinc)) {
      const code = trim(row.LOINC_NUM);
      const conceptId = this.conceptIdByCode.get(code);
      if (!conceptId) continue;

      for (const spec of LITERAL_COLUMN_MAP) {
        const raw = trim(row[spec.column]);
        if (!raw) continue;
        const propertyId = this.propertyIdByCode.get(spec.property);
        if (!propertyId) continue;

        const parsed = parseLiteralValue(raw);
        rows.push([
          EDGE_SET_PRIMARY,
          conceptId,
          propertyId,
          0,
          1,
          raw,
          parsed.valueText,
          parsed.valueNum,
          parsed.valueBool
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
    }

    const listPropertyId = this.propertyIdByCode.get('LIST');
    if (listPropertyId && files.answerList) {
      for await (const row of readCsv(files.answerList)) {
        const answerCode = trim(row.AnswerStringId);
        const listCode = trim(row.AnswerListId);
        const conceptId = this.conceptIdByCode.get(answerCode);
        if (!conceptId || !listCode) continue;

        const parsed = parseLiteralValue(listCode);
        rows.push([
          EDGE_SET_PRIMARY,
          conceptId,
          listPropertyId,
          0,
          1,
          listCode,
          parsed.valueText,
          parsed.valueNum,
          parsed.valueBool
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
    }

    if (rows.length > 0) {
      await this.bulkInsert(
        `INSERT INTO concept_literal (edge_set_id, source_concept_id, property_id, group_id, active, value_raw, value_text, value_num, value_bool)`,
        9,
        rows
      );
    }

    this.stats.literals = imported;
    this.log(`Literal import complete: ${imported.toLocaleString()} rows`);
  }

  async buildClosure(files) {
    this.log('Building transitive closure...');
    await this.exec('BEGIN TRANSACTION');
    try {
      await this.exec('DELETE FROM closure');

      await this.runSql(
        `INSERT OR IGNORE INTO closure (ancestor_id, descendant_id)
         SELECT concept_id, concept_id
         FROM concept
         WHERE cs_id = ?`,
        [this.csId]
      );

      let insertedEdges = 0;
      if (files.hierarchy) {
        const rows = [];
        for await (const row of readCsv(files.hierarchy)) {
          const code = trim(row.CODE);
          const pathToRoot = trim(row.PATH_TO_ROOT);
          const descendantId = this.conceptIdByCode.get(code);
          if (!descendantId || !pathToRoot) continue;

          const ancestorCodes = pathToRoot.split('.').map(v => v.trim()).filter(Boolean);
          for (const ancestorCode of ancestorCodes) {
            const ancestorId = this.conceptIdByCode.get(ancestorCode);
            if (!ancestorId || ancestorId === descendantId) continue;
            rows.push([ancestorId, descendantId]);
            insertedEdges += 1;

            if (rows.length >= FLUSH_ROW_TARGET) {
              await this.bulkInsert(
                `INSERT OR IGNORE INTO closure (ancestor_id, descendant_id)`,
                2,
                rows,
                { wrapTransaction: false }
              );
              rows.length = 0;
            }
          }
        }

        if (rows.length > 0) {
          await this.bulkInsert(
            `INSERT OR IGNORE INTO closure (ancestor_id, descendant_id)`,
            2,
            rows,
            { wrapTransaction: false }
          );
        }
      } else {
        await this.runSql(
          `INSERT OR IGNORE INTO closure (ancestor_id, descendant_id)
           SELECT l.target_concept_id, l.source_concept_id
           FROM concept_link l
           JOIN concept c ON c.concept_id = l.source_concept_id
           WHERE c.cs_id = ?
             AND l.active = 1
             AND l.property_id = ?
             AND l.edge_set_id = ?`,
          [this.csId, this.hierarchyPropertyId, EDGE_SET_PRIMARY]
        );

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
        `);

        await this.exec('DELETE FROM _closure_frontier');
        await this.exec('DELETE FROM _closure_next');
        await this.runSql(
          `INSERT OR IGNORE INTO _closure_frontier (ancestor_id, descendant_id, depth)
           SELECT l.target_concept_id, l.source_concept_id, 1
           FROM concept_link l
           JOIN concept c ON c.concept_id = l.source_concept_id
           WHERE c.cs_id = ?
             AND l.active = 1
             AND l.property_id = ?
             AND l.edge_set_id = ?`,
          [this.csId, this.hierarchyPropertyId, EDGE_SET_PRIMARY]
        );

        let keepGoing = true;
        while (keepGoing) {
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
            [this.hierarchyPropertyId, EDGE_SET_PRIMARY]
          );

          const nextRow = await this.get('SELECT COUNT(*) AS n FROM _closure_next', []);
          const n = nextRow ? nextRow.n : 0;
          if (n === 0) {
            keepGoing = false;
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
        }

        await this.exec('DELETE FROM _closure_frontier');
        await this.exec('DELETE FROM _closure_next');
      }

      await this.exec('COMMIT');
      if (this.config.verbose) {
        this.log(`  Closure path edges considered: ${insertedEdges.toLocaleString()}`);
      }
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
      concept: { operators: ['=', 'is-a', 'descendent-of', 'in'], isAIncludesSelf: false },
      code: { operators: ['regex'] },
      properties: {
        allPropertiesFilterable: true,
        defaultOperators: ['='],
        defaultSources: ['literal', 'link'],
        defaultLinkMatch: 'code-or-display',
        defaultValue: { normalizeCase: true },
        aliases: {
          'document-kind': 'DOCUMENT.KIND'
        },
        byCode: {
          CLASS: {
            operators: ['=', 'regex'],
            sources: ['literal', 'link'],
            linkMatch: 'code-or-display'
          },
          COMPONENT: {
            operators: ['=', 'regex'],
            sources: ['literal', 'link'],
            linkMatch: 'code-or-display'
          },
          PROPERTY: {
            operators: ['=', 'regex'],
            sources: ['literal', 'link'],
            linkMatch: 'code-or-display'
          },
          TIME_ASPCT: {
            operators: ['=', 'regex'],
            sources: ['literal', 'link'],
            linkMatch: 'code-or-display'
          },
          SYSTEM: {
            operators: ['=', 'regex'],
            sources: ['literal', 'link'],
            linkMatch: 'code-or-display'
          },
          SCALE_TYP: {
            operators: ['='],
            sources: ['literal', 'link'],
            linkMatch: 'code-or-display',
            value: {
              normalizeCase: true,
              aliases: {
                doc: 'Doc',
                'lp32888-7': 'Doc'
              }
            }
          },
          METHOD_TYP: {
            operators: ['=', 'regex'],
            sources: ['literal', 'link'],
            linkMatch: 'code-or-display'
          },
          ORDER_OBS: {
            operators: ['='],
            sources: ['literal'],
            value: {
              normalizeCase: true,
              aliases: {
                order: 'Order',
                observation: 'Observation',
                both: 'Both'
              }
            }
          },
          CLASSTYPE: {
            operators: ['='],
            sources: ['literal'],
            value: {
              normalizeCase: true,
              aliases: {
                'laboratory class': '1',
                'clinical class': '2',
                'claims attachments': '3',
                surveys: '4'
              }
            }
          },
          STATUS: {
            operators: ['='],
            sources: ['literal'],
            value: {
              normalizeCase: true,
              aliases: {
                active: 'ACTIVE',
                inactive: 'INACTIVE'
              }
            }
          },
          LIST: {
            operators: ['='],
            sources: ['literal']
          },
          'DOCUMENT.KIND': {
            operators: ['=', 'exists'],
            sources: ['link'],
            linkMatch: 'code-or-display'
          },
          'answers-for': {
            operators: ['=', 'in'],
            sources: ['link'],
            specialHandler: {
              kind: 'derived-link-filter',
              seed: {
                // Raw LL* values are already answer-list concept codes.
                directCodePrefixes: ['LL'],
                // Non-LL inputs can be resolved to answer-list codes through inverse links.
                inversePropertyCode: 'answers-for'
              },
              projection: {
                // Then project list -> answer links to produce the final candidate code set.
                propertyCode: 'Answer',
                side: 'target'
              }
            }
          }
        }
      }
    };

    const runtimeImplicitValueSets = {
      all: { queries: ['fhir_vs', 'fhir_vs=all'] },
      isa: { queryPrefix: 'fhir_vs=isa/', filter: { property: 'concept', op: 'is-a', valueFromSuffix: true } }
    };

    const runtimeDesignations = {
      defaultSystem: BASE_URI,
      useMapping: {
        LONG_COMMON_NAME: { system: BASE_URI, code: 'LONG_COMMON_NAME', display: 'Long common name' },
        SHORTNAME: { system: BASE_URI, code: 'SHORTNAME', display: 'Short name' },
        DisplayName: { system: BASE_URI, code: 'DisplayName', display: 'Display name' },
        ConsumerName: { system: BASE_URI, code: 'ConsumerName', display: 'Consumer name' }
      }
    };

    const configRows = [
      ['runtime.versioning', JSON.stringify({ algorithm: 'string', partialMatch: false, output: 'version' })],
      ['runtime.languages', JSON.stringify({ default: 'en-US' })],
      ['runtime.designations', JSON.stringify(runtimeDesignations)],
      ['runtime.hierarchy', JSON.stringify({
        propertyCode: PARENT_PROPERTY_CODE,
        edgeSetId: EDGE_SET_PRIMARY,
        closure: { enabled: true, fallbackRecursive: false }
      })],
      ['runtime.filters', JSON.stringify(runtimeFilters)],
      ['runtime.implicitValueSets', JSON.stringify(runtimeImplicitValueSets)],
      ['runtime.status', JSON.stringify({
        inactive: { source: 'concept.active', invert: true },
        statusProperty: 'STATUS',
        deprecated: { source: 'constant', value: false },
        abstract: { source: 'constant', value: false }
      })],
      ['runtime.iteration', JSON.stringify({
        defaultCodeRegex: '^[0-9]{3,}.*',
        rootMode: 'all'
      })],
      ['runtime.search', JSON.stringify(runtimeSearch)],
      ['runtime.behaviorFlags', JSON.stringify({
        tags: ['loinc', 'implicit-vs-path']
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

  async ensureProperty(propertyCode, valueKind, isHierarchy, display) {
    if (!propertyCode) return null;
    if (this.propertyIdByCode.has(propertyCode)) {
      return this.propertyIdByCode.get(propertyCode);
    }

    await this.runSql(
      `INSERT OR IGNORE INTO property_def (cs_id, property_code, value_kind, is_hierarchy, display)
       VALUES (?, ?, ?, ?, ?)`,
      [this.csId, propertyCode, valueKind, isHierarchy, display || propertyCode]
    );

    const row = await this.get(
      `SELECT property_id
       FROM property_def
       WHERE cs_id = ? AND property_code = ?`,
      [this.csId, propertyCode]
    );
    if (!row) return null;

    this.propertyIdByCode.set(propertyCode, row.property_id);
    return row.property_id;
  }

  async bulkInsert(sqlPrefix, columnCount, rows, options = {}) {
    if (!rows.length) return;

    const chunkSize = Math.max(1, Math.floor(MAX_SQL_PARAMS / columnCount));
    const wrapTransaction = options.wrapTransaction !== false;

    if (wrapTransaction) {
      await this.exec('BEGIN TRANSACTION');
    }

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
      if (wrapTransaction) {
        await this.exec('COMMIT');
      }
    } catch (error) {
      if (wrapTransaction) {
        await this.exec('ROLLBACK');
      }
      throw error;
    }
  }

  async runSql(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function onRun(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes || 0, lastID: this.lastID });
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

function detectVersionFromPath(value) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(/Loinc[_-]?(\d+\.\d+(?:\.\d+)?)/i);
  return match ? match[1] : null;
}

function isActiveLoincStatus(status) {
  const s = String(status || '').toUpperCase();
  return s === 'ACTIVE' || s === 'TRIAL';
}

function parseLiteralValue(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return { valueText: null, valueNum: null, valueBool: null };
  }

  if (text === 'true' || text === 'false') {
    return { valueText: text, valueNum: null, valueBool: text === 'true' ? 1 : 0 };
  }

  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return {
      valueText: text,
      valueNum: Number.isFinite(n) ? n : null,
      valueBool: null
    };
  }

  return { valueText: text, valueNum: null, valueBool: null };
}

function trim(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function scanDirectoryForLoincFiles(dir, files) {
  if (!dir || !fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) {
        scanDirectoryForLoincFiles(fullPath, files);
      }
      continue;
    }
    if (!entry.isFile()) continue;

    const name = entry.name;
    if (name === 'Loinc.csv') files.loinc = fullPath;
    else if (name === 'Part.csv') files.part = fullPath;
    else if (name === 'LoincPartLink_Primary.csv') files.partLink = fullPath;
    else if (name === 'ComponentHierarchyBySystem.csv') files.hierarchy = fullPath;
    else if (name === 'ConsumerName.csv') files.consumerName = fullPath;
    else if (name === 'AnswerList.csv') files.answerList = fullPath;
    else if (name === 'LoincAnswerListLink.csv') files.answerListLink = fullPath;
    else if (name.endsWith('LinguisticVariant.csv')) files.linguisticVariants.push(fullPath);
  }
}

function languageFromVariantFilename(fileName) {
  const match = fileName.match(/^([a-z]{2})([A-Z]{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}`;
}

function parseCsvLine(line) {
  const result = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      result.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  result.push(field);
  return result;
}

async function* readCsv(filePath) {
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headers = null;
  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLine(line).map((h) => h.replace(/^\uFEFF/, ''));
      continue;
    }
    if (!line) continue;

    const values = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = values[i] || '';
    }
    yield row;
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
  LoincSqliteV0Importer,
  constants: {
    BASE_URI,
    PARENT_PROPERTY_CODE,
    EDGE_SET_PRIMARY,
    PART_TYPE_PROPERTIES,
    PART_TYPE_NORMALIZATION,
    LITERAL_COLUMN_MAP
  }
};
