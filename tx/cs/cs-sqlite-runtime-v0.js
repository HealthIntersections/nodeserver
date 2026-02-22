'use strict';

/**
 * Generic SQLite v0 terminology provider.
 *
 * This module provides a generic code system provider backed by a normalized
 * SQLite schema (concept / concept_property / concept_relationship / etc.).
 * Any terminology can be loaded through the v0 schema — RxNorm, LOINC, SNOMED,
 * or custom code systems — using the corresponding v0 importer.
 *
 * ## Architecture: Factory and Provider
 *
 * FHIRsmith separates long-lived factories from per-request providers:
 *
 *   - **SqliteRuntimeV0FactoryProvider** (extends CodeSystemFactoryProvider):
 *     Loaded once at startup per database file. Stays in memory to answer
 *     runtime queries like `buildKnownValueSet()` (synthesizing ValueSet
 *     resources from URLs like `http://loinc.org/vs/LP1234`). Creates
 *     per-request provider instances via `build()`.
 *
 *   - **SqliteRuntimeV0Provider** (extends CodeSystemProvider):
 *     Created fresh for each request. Handles terminology operations:
 *     locate, filter, executeFilters, subsumesTest, etc.
 *
 * ## Specialization system
 *
 * Some terminologies need behavior beyond what the generic provider offers.
 * For example, SNOMED needs post-coordinated expression support and LOINC
 * needs implicit value set generation from URL patterns. Rather than
 * hardcoding these in the base, specializations register themselves.
 *
 * **How it works:**
 *
 * 1. Specialization modules (e.g. `cs-sqlite-snomed-v0.js`) define a factory
 *    subclass and call `registerSpecialization()` at require-time:
 *
 *      SqliteRuntimeV0FactoryProvider.registerSpecialization({
 *        id: 'snomed-expressions',
 *        systemPrefix: 'http://snomed.info/sct',
 *        tags: ['snomed'],
 *        FactoryClass: SnomedSqliteV0Factory
 *      });
 *
 * 2. At startup, `createFromMetadata()` probes the database's metadata
 *    (canonical URI and behaviorFlags.tags) and matches against the registry.
 *    The first matching entry (by priority) determines the factory class.
 *
 * 3. The specialized factory controls everything — it can override
 *    `buildKnownValueSet()` for factory-level behavior, and/or override
 *    `build()` to return a specialized provider class.
 *
 * **Matching rules:**
 *
 *   - `systemPrefix`: matched against the db's canonical URI (prefix match)
 *   - `tags`: all listed tags must be present in the db's `behaviorFlags.tags`
 *   - Both conditions must be satisfied (when specified)
 *   - Higher `priority` wins when multiple entries match
 *
 * **Discovery:** Specialization modules are auto-discovered at require-time
 * by scanning for `cs-sqlite-*.js` files in this directory. Each file is
 * required, and if it calls `registerSpecialization()`, the entry is added
 * to the registry. No explicit enumeration of subclass files is needed.
 *
 * ## YAML configuration
 *
 * Databases are loaded via the `sqlite-v0:` source type in YAML config:
 *
 *     sources:
 *       - sqlite-v0:rxnorm.v0.db                        # auto-match (default)
 *       - sqlite-v0:loinc.v0.db?specialization=none      # force generic base
 *       - sqlite-v0:snomed.v0.db?specialization=snomed-expressions  # force specific
 *
 * The `specialization` query parameter overrides automatic matching:
 *
 *   - Omitted: automatic tag/URL matching from the registry (the default)
 *   - `none`: skip the registry entirely, use the generic base factory
 *   - `<id>`: select a specific registered specialization by its id
 *
 * This lets operators control behavior without rebuilding databases. For
 * example, to debug whether a specialization is causing issues, temporarily
 * add `?specialization=none` to isolate the generic behavior.
 */

const sqlite3 = require('sqlite3').verbose();
let BetterSqlite3;
try { BetterSqlite3 = require('better-sqlite3-with-progress'); } catch (_) {
  try { BetterSqlite3 = require('better-sqlite3'); } catch (_) { BetterSqlite3 = null; }
}
const { CodeSystem } = require('../library/codesystem');
const { CodeSystemProvider, CodeSystemFactoryProvider, FilterExecutionContext } = require('./cs-api');

// Specialization registry — populated by subclass modules at require-time.
const V0_SPECIALIZATION_REGISTRY = [];

class SqliteRuntimeV0Context {
  constructor(conceptId, code, display, definition, active) {
    this.conceptId = conceptId;
    this.code = code;
    this.display = display;
    this.definition = definition;
    this.active = active;
  }
}

class SqliteRuntimeV0Iterator {
  constructor(codes) {
    this.codes = codes || [];
    this.cursor = 0;
  }
}

class SqliteRuntimeV0QueryIterator {
  constructor(mode, options = {}) {
    this.mode = mode;
    this.pageSize = Number(options.pageSize) > 0 ? Number(options.pageSize) : 512;
    this.targetConceptId = options.targetConceptId || null;
    this.rows = [];
    this.cursor = 0;
    this.lastCode = null;
    this.done = false;
  }
}

class SqliteRuntimeV0FilterSet {
  constructor(name, codes, closed = true) {
    this.name = name;
    this.summary = name;
    this.codes = codes || [];
    this.cursor = -1;
    this.closed = closed;
    this._set = null;
  }

  has(code) {
    if (!this._set) {
      this._set = new Set(this.codes);
    }
    return this._set.has(code);
  }
}

class SqliteRuntimeV0PredicateFilter {
  constructor(name, kind, details = {}, closed = true) {
    this.name = name;
    this.summary = name;
    this.kind = kind;
    this.closed = closed;
    this.cursor = -1;
    Object.assign(this, details || {});
  }
}

class SqliteRuntimeV0PagedDescendantFilter {
  constructor(name, ancestorId, includeSelf, pageSize = 512) {
    this.name = name;
    this.summary = name;
    this.ancestorId = ancestorId;
    this.includeSelf = includeSelf;
    this.pageSize = pageSize;
    this.closed = true;
    this.cursor = -1;
    this.rows = [];
    this.done = false;
    this.lastCode = null;
    this.strategy = null;
    this.descendantCount = null;
  }
}

class SqliteRuntimeV0Provider extends CodeSystemProvider {
  constructor(opContext, supplements, db, metadata, runtime, options = {}) {
    super(opContext, supplements);
    this.db = db;
    this.meta = metadata;
    this.runtime = runtime || {};
    this.propertyDefs = new Map();
    this.sharedState = options.sharedState || null;
    this.statusCache = null;
    this.ownsDb = options.ownsDb === true;
    this.dbPath = options.dbPath || null;
    this.effortLimitMs = options.effortLimitMs || 1000;
    this._syncDb = null;
    this.defaultIterationRegex = null;
    const regexSource = this.runtime?.iteration?.defaultCodeRegex;
    if (regexSource) {
      try {
        this.defaultIterationRegex = new RegExp(String(regexSource));
      } catch (_error) {
        this.defaultIterationRegex = null;
      }
    }
  }

  close() {
    if (!this.db || !this.ownsDb) return;
    this.statusCache = null;
    this.db.close();
    this.db = null;
  }

  handlesExcludes() {
    return !!this.#getSyncDb();
  }

  handlesOffset() {
    return !!this.#getSyncDb();
  }

  // --- SQL query building for filter pipeline ---

  #getSyncDb() {
    if (this._syncDb) return this._syncDb;
    if (!BetterSqlite3 || !this.dbPath) return null;
    this._syncDb = new BetterSqlite3(this.dbPath, { readonly: true });
    // REGEXP with effort-based breaker: cache compiled regex, limit evaluations
    const regexpCache = new Map();
    const REGEXP_EFFORT_LIMIT = 500000;
    let regexpCalls = 0;
    this._syncDb.function('regexp', (pattern, value) => {
      if (++regexpCalls > REGEXP_EFFORT_LIMIT) {
        throw new Error(`REGEXP effort limit exceeded (${REGEXP_EFFORT_LIMIT} evaluations)`);
      }
      let re = regexpCache.get(pattern);
      if (!re) {
        re = new RegExp(pattern);
        regexpCache.set(pattern, re);
      }
      return re.test(value) ? 1 : 0;
    });
    // Reset counter before each statement execution via a helper
    this._syncDb._resetRegexpEffort = () => { regexpCalls = 0; regexpCache.clear(); };
    // Install progress handler for query effort limiting (if available)
    if (typeof this._syncDb.progressHandler === 'function') {
      const effortLimitMs = this.effortLimitMs;
      let startTime = 0;
      this._syncDb.progressHandler(10000, () => {
        return performance.now() - startTime > effortLimitMs;
      });
      this._syncDb._resetEffort = () => { startTime = performance.now(); };
    }
    return this._syncDb;
  }

  /** Protected accessor for subclasses that need the sync db. */
  _getOrCreateSyncDb() {
    return this.#getSyncDb();
  }

  /**
   * Build a SQL condition for a single filter {property, op, value}.
   * Returns { sql, params, joins } or null if unsupported.
   * @param {string} alias - concept table alias (e.g. 'c' or 'c2')
   */
  #buildV0FilterSql(filter, paramPrefix, alias = 'c') {
    const { property, op, value } = filter;
    const csId = this.meta.csId;
    const params = {};

    if (property === 'concept') {
      if (op === '=') {
        params[`${paramPrefix}_code`] = value;
        return {
          sql: ` AND ${alias}.code = @${paramPrefix}_code`,
          params,
          joins: '',
        };
      }

      if (op === 'is-a' || op === 'descendent-of') {
        const includeSelf = op === 'is-a'
          ? (this.runtime?.filters?.concept?.isAIncludesSelf !== false)
          : false;
        // Use closure table for hierarchy
        params[`${paramPrefix}_anc_code`] = value;
        params[`${paramPrefix}_cs`] = csId;
        const selfClause = includeSelf ? '' : ` AND cl_${paramPrefix}.descendant_id != cl_${paramPrefix}.ancestor_id`;
        return {
          sql: selfClause,
          params,
          joins: ` JOIN closure cl_${paramPrefix} ON cl_${paramPrefix}.descendant_id = ${alias}.concept_id`
            + ` AND cl_${paramPrefix}.ancestor_id = (SELECT concept_id FROM concept WHERE code = @${paramPrefix}_anc_code AND cs_id = @${paramPrefix}_cs)`,
        };
      }

      if (op === 'in') {
        const url = resolveInValueSetUrl(this.system(), value, this.runtime);
        params[`${paramPrefix}_vs_url`] = url;
        params[`${paramPrefix}_cs`] = csId;
        return {
          sql: '',
          params,
          joins: ` JOIN value_set_member vsm_${paramPrefix} ON vsm_${paramPrefix}.concept_id = ${alias}.concept_id AND vsm_${paramPrefix}.active = 1`
            + ` JOIN value_set vs_${paramPrefix} ON vs_${paramPrefix}.vs_id = vsm_${paramPrefix}.vs_id AND vs_${paramPrefix}.cs_id = @${paramPrefix}_cs AND vs_${paramPrefix}.url = @${paramPrefix}_vs_url`,
        };
      }

      return null; // Unsupported concept operator
    }

    if (property === 'code' && op === 'regex') {
      params[`${paramPrefix}_re`] = value;
      return {
        sql: ` AND ${alias}.code REGEXP @${paramPrefix}_re`,
        params,
        joins: '',
      };
    }

    // Property filter: resolve via property_def → concept_link or concept_literal
    const syncDb = this.#getSyncDb();
    if (!syncDb) return null;

    const propDef = syncDb.prepare(
      'SELECT property_id, value_kind FROM property_def WHERE cs_id = ? AND property_code = ? LIMIT 1'
    ).get(csId, property);
    if (!propDef) return null;

    if (propDef.value_kind === 'concept') {
      if (op === '=' || op === 'in') {
        const values = op === 'in' ? splitFilterValueList(value) : [value];
        params[`${paramPrefix}_prop`] = propDef.property_id;
        params[`${paramPrefix}_val_cs`] = csId;
        params[`${paramPrefix}_eset`] = this.meta.hierarchyEdgeSetId || 1;
        const placeholders = values.map((v, j) => {
          params[`${paramPrefix}_vc${j}`] = v;
          return `@${paramPrefix}_vc${j}`;
        }).join(',');
        return {
          sql: '',
          params,
          joins: ` JOIN concept_link lnk_${paramPrefix}`
            + ` ON lnk_${paramPrefix}.source_concept_id = ${alias}.concept_id`
            + ` AND lnk_${paramPrefix}.property_id = @${paramPrefix}_prop`
            + ` AND lnk_${paramPrefix}.edge_set_id = @${paramPrefix}_eset`
            + ` AND lnk_${paramPrefix}.active = 1`
            + ` AND lnk_${paramPrefix}.target_concept_id IN (SELECT concept_id FROM concept WHERE code IN (${placeholders}) AND cs_id = @${paramPrefix}_val_cs)`,
        };
      }
      return null;
    }

    if (propDef.value_kind === 'string' || propDef.value_kind === 'literal') {
      if (op === '=' || op === 'in') {
        const values = op === 'in' ? splitFilterValueList(value) : [value];
        params[`${paramPrefix}_prop`] = propDef.property_id;
        const placeholders = values.map((v, j) => {
          params[`${paramPrefix}_vl${j}`] = v;
          return `@${paramPrefix}_vl${j}`;
        }).join(',');
        return {
          sql: '',
          params,
          joins: ` JOIN concept_literal lit_${paramPrefix}`
            + ` ON lit_${paramPrefix}.source_concept_id = ${alias}.concept_id`
            + ` AND lit_${paramPrefix}.property_id = @${paramPrefix}_prop`
            + ` AND lit_${paramPrefix}.active = 1`
            + ` AND lit_${paramPrefix}.value_text COLLATE NOCASE IN (${placeholders})`,
        };
      }
      return null;
    }

    return null; // Unsupported property type
  }

  /**
   * Build a NOT EXISTS clause for exclude filters by reusing #buildV0FilterSql.
   * Each filter is resolved via the same path as includes (concept hierarchy,
   * property_def lookup, etc.) — no duplicated logic.
   * Returns SQL string or null if any filter is unsupported.
   */
  #buildExcludeClause(filters, paramPrefix, allParams) {
    const alias = `c_${paramPrefix}`;
    const parts = [];
    for (let fi = 0; fi < filters.length; fi++) {
      const result = this.#buildV0FilterSql(filters[fi], `${paramPrefix}f${fi}`, alias);
      if (!result) return null;
      parts.push(result);
    }
    if (parts.length === 0) return null;
    const joins = parts.map(p => p.joins).join('');
    const where = parts.map(p => p.sql).join('');
    for (const p of parts) Object.assign(allParams, p.params);
    allParams[`${paramPrefix}_csId`] = this.meta.csId;
    return `NOT EXISTS (SELECT 1 FROM concept ${alias}${joins}`
      + ` WHERE ${alias}.cs_id = @${paramPrefix}_csId`
      + ` AND ${alias}.concept_id = t.concept_id${where})`;
  }

  system() {
    return this.meta.baseUri || this.meta.canonicalUri || '';
  }

  version() {
    const outputMode = this.runtime?.versioning?.output || 'canonical';
    if (outputMode === 'version') {
      return this.meta.version || this.meta.canonicalUri || null;
    }
    return this.meta.canonicalUri || this.meta.version || null;
  }

  name() {
    return this.meta.name || this.system();
  }

  description() {
    return `${this.name()} (${this.meta.version || 'unknown version'})`;
  }

  async totalCount() {
    return this.meta.totalConcepts || 0;
  }

  hasParents() {
    return !!this.meta.hierarchyPropertyId;
  }

  defLang() {
    return this.runtime.languages?.default || this.meta.defaultLanguage || 'en';
  }

  versionAlgorithm() {
    return this.runtime.versioning?.algorithm || 'string';
  }

  versionIsMoreDetailed(checkVersion, actualVersion) {
    if (!checkVersion || !actualVersion) return false;

    const partialMatch = this.runtime.versioning?.partialMatch !== false;
    if (!partialMatch) {
      return checkVersion === actualVersion;
    }

    return actualVersion.startsWith(checkVersion);
  }

  async code(context) {
    const ctxt = await this._ensureContext(context);
    return ctxt ? ctxt.code : null;
  }

  async display(context) {
    const ctxt = await this._ensureContext(context);
    if (!ctxt) return null;

    const supplementDisplay = this._displayFromSupplements(ctxt.code);
    if (supplementDisplay) {
      return supplementDisplay;
    }

    return ctxt.display || ctxt.code;
  }

  async definition(context) {
    const ctxt = await this._ensureContext(context);
    return ctxt ? ctxt.definition : null;
  }

  async isAbstract(context) {
    await this._ensureContext(context);
    const abstractCfg = this.runtime.status?.abstract;
    if (abstractCfg?.source === 'constant') {
      return !!abstractCfg.value;
    }
    return false;
  }

  async isInactive(context) {
    const ctxt = await this._ensureContext(context);
    if (!ctxt) return false;
    const inactiveCfg = this.runtime.status?.inactive;
    if (inactiveCfg?.source === 'concept.active') {
      return inactiveCfg.invert === true ? !ctxt.active : !!ctxt.active;
    }
    return !ctxt.active;
  }

  async isDeprecated(context) {
    await this._ensureContext(context);
    const depCfg = this.runtime.status?.deprecated;
    if (depCfg?.source === 'constant') {
      return !!depCfg.value;
    }
    return false;
  }

  async getStatus(context) {
    const ctxt = await this._ensureContext(context);
    if (!ctxt) return null;

    const statusValue = await this.#statusValueForConcept(ctxt.conceptId);
    if (statusValue) {
      return statusValue;
    }

    return ctxt.active ? 'active' : 'inactive';
  }

  async #statusValueForConcept(conceptId) {
    const statusPropertyCode = this.runtime?.status?.statusProperty;
    if (!statusPropertyCode) {
      return null;
    }

    const propDef = await this.#resolvePropertyDef(statusPropertyCode);
    if (!propDef?.property_id) {
      return null;
    }

    await this.#ensureStatusCache(propDef.property_id);
    return this.statusCache?.values?.get(conceptId) || null;
  }

  async #ensureStatusCache(propertyId) {
    if (this.statusCache?.propertyId === propertyId && this.statusCache.values instanceof Map) {
      return;
    }

    if (this.sharedState && this.sharedState.statusByPropertyId instanceof Map) {
      const existing = this.sharedState.statusByPropertyId.get(propertyId);
      if (existing instanceof Map) {
        this.statusCache = { propertyId, values: existing };
        return;
      }

      if (!(this.sharedState.statusLoadPromises instanceof Map)) {
        this.sharedState.statusLoadPromises = new Map();
      }

      let promise = this.sharedState.statusLoadPromises.get(propertyId);
      if (!promise) {
        promise = this.#loadStatusMap(propertyId)
          .then((values) => {
            this.sharedState.statusByPropertyId.set(propertyId, values);
            this.sharedState.statusLoadPromises.delete(propertyId);
            return values;
          })
          .catch((error) => {
            this.sharedState.statusLoadPromises.delete(propertyId);
            throw error;
          });
        this.sharedState.statusLoadPromises.set(propertyId, promise);
      }

      const values = await promise;
      this.statusCache = { propertyId, values };
      return;
    }

    const values = await this.#loadStatusMap(propertyId);
    this.statusCache = { propertyId, values };
  }

  async #loadStatusMap(propertyId) {
    const rows = await all(
      this.db,
      `SELECT source_concept_id,
              COALESCE(value_text, value_raw) AS value
       FROM concept_literal
       WHERE property_id = ?
         AND active = 1
         AND COALESCE(value_text, value_raw) IS NOT NULL
       ORDER BY source_concept_id, literal_id`,
      [propertyId]
    );

    const values = new Map();
    for (const row of rows) {
      if (!values.has(row.source_concept_id) && row.value != null) {
        values.set(row.source_concept_id, row.value);
      }
    }
    return values;
  }

  async designations(context, displays) {
    const ctxt = await this._ensureContext(context);
    if (!ctxt) return;

    // Keep legacy behavior where a primary display is always available as a designation.
    displays.addDesignation(
      true,
      ctxt.active ? 'active' : 'inactive',
      this.defLang(),
      CodeSystem.makeUseForDisplay(),
      ctxt.display || ctxt.code
    );

    // Use batch-prefetched designations when available (from executeFilters),
    // otherwise fall back to per-code DB query.
    let rows;
    if (ctxt._v0Designations) {
      rows = ctxt._v0Designations;
    } else {
      const designationTableRef = this.meta?.designationOrderIndex
        ? 'designation INDEXED BY idx_designation_concept_pref_term'
        : 'designation';
      rows = await all(
        this.db,
        `SELECT language_code, use_code, term, preferred, active
         FROM ${designationTableRef}
         WHERE concept_id = ?
         ORDER BY preferred DESC, term`,
        [ctxt.conceptId]
      );
    }

    for (const row of rows) {
      displays.addDesignation(
        row.preferred === 1,
        row.active === 1 ? 'active' : 'inactive',
        row.language_code || this.defLang(),
        useFromDesignation(row, this.runtime, this.system()),
        row.term
      );
    }

    this._listSupplementDesignations(ctxt.code, displays);
  }

  async properties(context) {
    const ctxt = await this._ensureContext(context);
    if (!ctxt) return [];

    const props = [];
    props.push({ code: 'inactive', valueBoolean: !ctxt.active });

    if (!this.meta.hierarchyPropertyId) {
      return props;
    }

    const parentRows = await all(
      this.db,
      `SELECT p.code AS target_code
       FROM concept_link l
       JOIN concept p ON p.concept_id = l.target_concept_id
       WHERE l.source_concept_id = ?
         AND l.property_id = ?
         AND l.edge_set_id = ?
         AND l.active = 1`,
      [ctxt.conceptId, this.meta.hierarchyPropertyId, this.meta.hierarchyEdgeSetId]
    );

    const parentPropCode = this.runtime.hierarchy?.parentPropertyCode || 'parent';
    for (const row of parentRows) {
      props.push({ code: parentPropCode, valueCode: row.target_code });
    }

    return props;
  }

  async locate(code) {
    if (!code) {
      return { context: null, message: 'Empty code' };
    }

    const row = await get(
      this.db,
      `SELECT concept_id, code, display, definition, active
       FROM concept
       WHERE cs_id = ? AND code = ?`,
      [this.meta.csId, code]
    );

    if (!row) {
      return { context: null, message: undefined };
    }

    return {
      context: new SqliteRuntimeV0Context(row.concept_id, row.code, row.display, row.definition, row.active === 1),
      message: null
    };
  }

  async locateMany(codes, allAltCodes = false) {
    void allAltCodes;
    const out = new Map();
    if (!Array.isArray(codes) || codes.length === 0) {
      return out;
    }

    const normalized = [];
    const seen = new Set();
    for (const raw of codes) {
      const code = String(raw || '');
      if (!code || seen.has(code)) {
        continue;
      }
      seen.add(code);
      normalized.push(code);
    }
    if (normalized.length === 0) {
      return out;
    }

    const batchSize = 500;
    for (let i = 0; i < normalized.length; i += batchSize) {
      const batch = normalized.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(', ');
      const rows = await all(
        this.db,
        `SELECT concept_id, code, display, definition, active
         FROM concept
         WHERE cs_id = ?
           AND code IN (${placeholders})`,
        [this.meta.csId, ...batch]
      );

      for (const row of rows) {
        out.set(row.code, {
          context: new SqliteRuntimeV0Context(
            row.concept_id,
            row.code,
            row.display,
            row.definition,
            row.active === 1
          ),
          message: null
        });
      }
    }

    return out;
  }

  // Backward-compat alias while workers migrate to locateMany.
  async locateBatch(codes, allAltCodes = false) {
    return this.locateMany(codes, allAltCodes);
  }

  async locateIsA(code, parent, disallowParent = false) {
    const located = await this.locate(code);
    if (!located.context) {
      return located;
    }

    const parentLocated = await this.locate(parent);
    if (!parentLocated.context) {
      return { context: null, message: `Parent concept '${parent}' not found` };
    }

    const isA = await this.#isA(parentLocated.context.conceptId, located.context.conceptId, !disallowParent);
    if (!isA) {
      return { context: null, message: `Code '${code}' is not in hierarchy of '${parent}'` };
    }

    return located;
  }

  async iterator(code) {
    if (!this.meta.hierarchyPropertyId) {
      return this.iteratorAll();
    }

    if (!code) {
      if (this.runtime?.iteration?.rootMode === 'all') {
        return this.iteratorAll();
      }
      return new SqliteRuntimeV0QueryIterator('roots');
    }

    const ctxt = await this._ensureContext(code);
    if (!ctxt) return null;

    if (this.runtime?.iteration?.children === false) {
      return new SqliteRuntimeV0Iterator([]);
    }

    const hasChildren = await this.#conceptHasHierarchyChildren(ctxt.conceptId);
    if (!hasChildren) {
      return new SqliteRuntimeV0Iterator([]);
    }

    return new SqliteRuntimeV0QueryIterator('children', { targetConceptId: ctxt.conceptId });
  }

  async #conceptHasHierarchyChildren(conceptId) {
    if (!conceptId || !this.meta.hierarchyPropertyId) {
      return false;
    }
    const targets = await this.#getHierarchyChildTargetSet();
    return targets.has(conceptId);
  }

  async #getHierarchyChildTargetSet() {
    if (!this.meta.hierarchyPropertyId) {
      return new Set();
    }

    const key = `${this.meta.hierarchyPropertyId}:${this.meta.hierarchyEdgeSetId}`;
    if (this.sharedState && this.sharedState.childTargetSets instanceof Map) {
      const existing = this.sharedState.childTargetSets.get(key);
      if (existing instanceof Set) {
        return existing;
      }

      if (!(this.sharedState.childTargetLoadPromises instanceof Map)) {
        this.sharedState.childTargetLoadPromises = new Map();
      }

      let promise = this.sharedState.childTargetLoadPromises.get(key);
      if (!promise) {
        promise = this.#loadHierarchyChildTargetSet(
          this.meta.hierarchyPropertyId,
          this.meta.hierarchyEdgeSetId
        ).then((set) => {
          this.sharedState.childTargetSets.set(key, set);
          this.sharedState.childTargetLoadPromises.delete(key);
          return set;
        }).catch((error) => {
          this.sharedState.childTargetLoadPromises.delete(key);
          throw error;
        });
        this.sharedState.childTargetLoadPromises.set(key, promise);
      }
      return promise;
    }

    return this.#loadHierarchyChildTargetSet(this.meta.hierarchyPropertyId, this.meta.hierarchyEdgeSetId);
  }

  async #loadHierarchyChildTargetSet(propertyId, edgeSetId) {
    const rows = await all(
      this.db,
      `SELECT DISTINCT target_concept_id
       FROM concept_link
       WHERE property_id = ?
         AND edge_set_id = ?
         AND active = 1`,
      [propertyId, edgeSetId]
    );
    return new Set(rows.map((r) => r.target_concept_id));
  }

  async iteratorAll() {
    return new SqliteRuntimeV0QueryIterator('all');
  }

  async nextContext(iteratorContext) {
    if (!iteratorContext) {
      return null;
    }

    if (this.#isQueryIterator(iteratorContext)) {
      while (iteratorContext.cursor >= iteratorContext.rows.length) {
        if (iteratorContext.done) {
          return null;
        }
        await this.#loadNextIteratorPage(iteratorContext);
      }

      const context = iteratorContext.rows[iteratorContext.cursor];
      iteratorContext.cursor += 1;
      return context || null;
    }

    if (!(iteratorContext instanceof SqliteRuntimeV0Iterator)) {
      return null;
    }

    if (iteratorContext.cursor >= iteratorContext.codes.length) {
      return null;
    }

    const entry = iteratorContext.codes[iteratorContext.cursor];
    iteratorContext.cursor += 1;
    if (entry instanceof SqliteRuntimeV0Context) {
      return entry;
    }

    const located = await this.locate(entry);
    return located.context;
  }

  async subsumesTest(codeA, codeB) {
    const a = await this._ensureContext(codeA);
    const b = await this._ensureContext(codeB);
    if (!a || !b) return 'not-subsumed';

    if (a.code === b.code) return 'equivalent';

    if (await this.#isA(a.conceptId, b.conceptId, true)) return 'subsumes';
    if (await this.#isA(b.conceptId, a.conceptId, true)) return 'subsumed-by';
    return 'not-subsumed';
  }

  async doesFilter(prop, op, _value) {
    void _value;
    if (!prop || !op) return false;

    const propCfg = this.runtime.filters?.[prop];
    if (propCfg?.operators && Array.isArray(propCfg.operators)) {
      return propCfg.operators.includes(op);
    }

    if (prop === 'concept') {
      return ['=', 'is-a', 'descendent-of', 'in'].includes(op);
    }
    if (prop === 'code' && op === 'regex') {
      return true;
    }

    const propertyCfg = await this.#resolvePropertyFilterConfig(prop);
    if (propertyCfg?.operators && Array.isArray(propertyCfg.operators)) {
      return propertyCfg.operators.includes(op);
    }

    return false;
  }

  async getPrepContext(iterate, params, excludeInactive, offset = -1, count = -1) {
    const ctx = new FilterExecutionContext(iterate);
    ctx._v0Excludes = [];
    ctx._v0Offset = offset;
    ctx._v0Count = count;
    // Combine compose-level and request-level active filtering:
    // "exclude" wins — client can narrow but can't widen beyond the ValueSet's rule
    ctx._v0ExcludeInactive = excludeInactive || !!(params && params.activeOnly);
    // Extract designation hints from params (replaces separate prepareDesignations call)
    if (params) {
      const langs = typeof params.workingLanguages === 'function' ? params.workingLanguages() : null;
      ctx._v0DesignationHints = {
        includeDesignations: !!params.includeDesignations,
        languages: langs || null,
        designations: params.designations || null,
      };
    }
    return ctx;
  }

  async searchFilter(filterContext, filter, _sort) {
    void _sort;
    const searchText = typeof filter === 'string'
      ? filter
      : (filter && typeof filter.filter === 'string' ? filter.filter : null);

    if (!searchText || !searchText.trim()) {
      throw new Error('Invalid search filter');
    }

    // Record intent only — executeFilters() incorporates text search into combined SQL.
    filterContext._v0SearchText = searchText.trim();
  }

  async filter(filterContext, prop, op, value) {
    // Record raw filter params — all SQL execution defers to executeFilters().
    if (!filterContext._v0IncludeFilters) filterContext._v0IncludeFilters = [];
    filterContext._v0IncludeFilters.push({ property: prop, op, value });

    // Validation-only: check that the property/op combination is supported.
    // No SQL execution here — executeFilters() builds and runs the combined query.

    if (prop === 'code' && op === 'regex') {
      // Regex can't be expressed in SQL builder — must eagerly materialize
      const re = new RegExp(`^${value}$`);
      const rows = await all(
        this.db,
        `SELECT code
         FROM concept
         WHERE cs_id = ?
         ORDER BY code`,
        [this.meta.csId]
      );
      const codes = rows.map(r => r.code).filter(c => re.test(c));
      filterContext.filters.push(new SqliteRuntimeV0FilterSet(`code-regex:${value}`, codes, true));
      return;
    }

    if (prop !== 'concept') {
      const propertyCfg = await this.#resolvePropertyFilterConfig(prop);
      if (!propertyCfg) {
        throw new Error(`Unsupported sqlite runtime filter property '${prop}'`);
      }
      if (!propertyCfg.operators.includes(op)) {
        throw new Error(`Unsupported sqlite runtime filter operator '${op}' for property '${prop}'`);
      }
      // Eagerly materialize only for special handlers and membership predicates;
      // everything else defers to executeFilters.
      if (propertyCfg.specialHandler || this.#useMembershipPredicate(filterContext)) {
        await this.#filterByProperty(filterContext, propertyCfg, op, value);
      } else {
        if (!filterContext._v0Deferred) filterContext._v0Deferred = [];
        filterContext._v0Deferred.push({ propertyCfg, op, value, filterName: `property-${propertyCfg.propertyCode}-${op}:${value}` });
      }
      return;
    }

    // concept filter — defer to executeFilters unless membership predicate needed
    if (this.#useMembershipPredicate(filterContext)) {
      // Membership predicates are used for filterCheck, not iteration — keep eager
      if (op === '=') {
        filterContext.filters.push(new SqliteRuntimeV0PredicateFilter(
          `concept=${value}`, 'concept-equals', { code: value }, true
        ));
      } else if (op === 'is-a' || op === 'descendent-of') {
        const includeSelf = op === 'is-a'
          ? (this.runtime?.filters?.concept?.isAIncludesSelf !== false)
          : false;
        const parent = await this.locate(value);
        filterContext.filters.push(new SqliteRuntimeV0PredicateFilter(
          `concept-${op}:${value}`, 'concept-hierarchy',
          { parentCode: value, ancestorId: parent.context ? parent.context.conceptId : null,
            includeSelf, missingMessage: parent.context ? null : `Parent concept '${value}' not found` },
          true
        ));
      } else if (op === 'in') {
        const url = resolveInValueSetUrl(this.system(), value, this.runtime);
        filterContext.filters.push(new SqliteRuntimeV0PredicateFilter(
          `concept-in:${value}`, 'concept-in', { valueSetUrl: url, rawValue: value }, true
        ));
      } else {
        throw new Error(`Unsupported sqlite runtime filter operator '${op}' for concept`);
      }
      return;
    }

    // For iteration mode: defer to executeFilters which will build combined SQL.
    // Only fall back to eager materialization for ops that #buildV0FilterSql can't handle,
    // or when executeFilters falls back (no syncDb, unsupported filter).
    if (!filterContext._v0Deferred) filterContext._v0Deferred = [];
    filterContext._v0Deferred.push({ property: prop, op, value, isConcept: true });
  }

  /**
   * Accumulate exclude filter groups for later SQL generation in executeFilters.
   * Each call represents one exclude clause; all filters in the array are conjunctive.
   * Throws if any filter is unsupported.
   * @param {FilterExecutionContext} filterContext
   * @param {Object[]} filters - array of {prop, op, value}
   */
  async filterExcludeFilters(filterContext, filters) {
    if (!filterContext._v0Excludes) filterContext._v0Excludes = [];
    // Validate all filters are supported by trying to build SQL for each
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      if (f.prop === 'code' && f.op === 'in') continue; // concept-code excludes always supported
      const result = this.#buildV0FilterSql(
        { property: f.prop, op: f.op, value: f.value }, `_val${i}`
      );
      if (!result) {
        throw new Error(`Unsupported exclude filter: property '${f.prop}' op '${f.op}'`);
      }
    }
    filterContext._v0Excludes.push(filters);
  }

  /**
   * Record intent to include specific concept codes.
   * No SQL — executeFilters() incorporates these into combined SQL.
   */
  async includeConcepts(filterContext, codes) {
    if (!filterContext._v0IncludeConcepts) filterContext._v0IncludeConcepts = [];
    filterContext._v0IncludeConcepts.push(...codes);
  }

  /**
   * Record intent to exclude specific concept codes.
   * No SQL — executeFilters() incorporates these into combined SQL as NOT IN.
   */
  async filterExcludeConcepts(filterContext, codes) {
    if (!filterContext._v0ExcludeConcepts) filterContext._v0ExcludeConcepts = [];
    filterContext._v0ExcludeConcepts.push(...codes);
  }

  async executeFilters(filterContext) {
    const hasIncludeFilters = filterContext._v0IncludeFilters && filterContext._v0IncludeFilters.length > 0;
    const hasIncludeConcepts = filterContext._v0IncludeConcepts && filterContext._v0IncludeConcepts.length > 0;
    const hasExcludeConcepts = filterContext._v0ExcludeConcepts && filterContext._v0ExcludeConcepts.length > 0;
    const syncDb = this.#getSyncDb();

    // Build combined SQL when we have sync DB and something to query.
    if (syncDb && (hasIncludeFilters || hasIncludeConcepts)) {
      const csId = this.meta.csId;
      const allParams = { _csId: csId };

      // Build include filter SQL
      let joins = '';
      let where = '';
      let unsupported = false;
      for (let fi = 0; fi < (filterContext._v0IncludeFilters || []).length; fi++) {
        const result = this.#buildV0FilterSql(filterContext._v0IncludeFilters[fi], `_i0f${fi}`);
        if (!result) { unsupported = true; break; }
        joins += result.joins;
        where += result.sql;
        Object.assign(allParams, result.params);
      }

      // Include concept list → WHERE code IN (...)
      if (!unsupported && hasIncludeConcepts) {
        const placeholders = filterContext._v0IncludeConcepts.map((c, j) => {
          allParams[`_ic${j}`] = c;
          return `@_ic${j}`;
        }).join(',');
        where += ` AND c.code IN (${placeholders})`;
      }

      if (!unsupported) {
        // Exclude inactive codes in SQL when compose or request says to
        const activeClause = filterContext._v0ExcludeInactive ? ' AND c.active = 1' : '';
        const innerSql = `SELECT c.concept_id, c.code, c.display, c.definition, c.active`
          + ` FROM concept c${joins}`
          + ` WHERE c.cs_id = @_csId${where}${activeClause}`;

        // Build exclude SQL
        let excludeSql = '';
        for (let i = 0; i < (filterContext._v0Excludes || []).length; i++) {
          const excFilters = filterContext._v0Excludes[i];
          // Separate concept-code excludes from property/hierarchy excludes
          const codeExclude = excFilters.find(f => f.prop === 'code' && f.op === 'in');
          const propExcludes = excFilters.filter(f => !(f.prop === 'code' && f.op === 'in'));

          if (codeExclude) {
            const codes = codeExclude.value.split(',');
            const placeholders = codes.map((c, j) => {
              allParams[`_ec${i}_${j}`] = c;
              return `@_ec${i}_${j}`;
            }).join(',');
            excludeSql += ` AND t.code NOT IN (${placeholders})`;
          }
          if (propExcludes.length > 0) {
            const mapped = propExcludes.map(f => ({ property: f.prop, op: f.op, value: f.value }));
            const clause = this.#buildExcludeClause(mapped, `_e${i}`, allParams);
            if (clause) {
              excludeSql += ` AND ${clause}`;
            }
          }
        }

        // Exclude concept list → AND code NOT IN (...)
        if (hasExcludeConcepts) {
          const placeholders = filterContext._v0ExcludeConcepts.map((c, j) => {
            allParams[`_xc${j}`] = c;
            return `@_xc${j}`;
          }).join(',');
          excludeSql += ` AND t.code NOT IN (${placeholders})`;
        }

        // Intersect with text search filter if present
        if (filterContext._v0SearchText) {
          const searchText = filterContext._v0SearchText;
          const searchCfg = normalizedSearchConfig(this.runtime.search);
          if (this.#canUseFtsSearch(searchCfg)) {
            const matchText = toFtsMatchText(searchText);
            allParams['_searchMatch'] = matchText;
            allParams['_searchCsId'] = csId;
            // Build UNION of FTS sources → concept_id set
            const ftsParts = [];
            for (const source of searchCfg.sources) {
              if (source === 'display') {
                const table = sqlIdentifier(searchCfg.ftsTables.display, 'search_fts_display');
                ftsParts.push(
                  `SELECT c2.concept_id FROM ${table} f2 JOIN concept c2 ON c2.concept_id = f2.rowid WHERE c2.cs_id = @_searchCsId AND f2.term MATCH @_searchMatch`
                );
              } else if (source === 'designation') {
                const table = sqlIdentifier(searchCfg.ftsTables.designation, 'search_fts_designation');
                ftsParts.push(
                  `SELECT d2.concept_id FROM ${table} f2 JOIN designation d2 ON d2.designation_id = f2.rowid WHERE f2.term MATCH @_searchMatch`
                );
              } else if (source === 'literal') {
                const table = sqlIdentifier(searchCfg.ftsTables.literal, 'search_fts_literal');
                ftsParts.push(
                  `SELECT cl2.source_concept_id FROM ${table} f2 JOIN concept_literal cl2 ON cl2.literal_id = f2.rowid WHERE f2.term MATCH @_searchMatch`
                );
              }
            }
            if (ftsParts.length > 0) {
              excludeSql += ` AND t.concept_id IN (${ftsParts.join(' UNION ')})`;
            }
          } else {
            // LIKE fallback on display
            allParams['_searchLike'] = `%${searchText}%`;
            excludeSql += ` AND t.display LIKE @_searchLike`;
          }
        }

        // Return full context rows so filterConcept can use them directly
        let sql = `SELECT DISTINCT t.concept_id, t.code, t.display, t.definition, t.active FROM (${innerSql}) AS t`
          + ` WHERE 1=1${excludeSql}`
          + ` ORDER BY t.code`;

        if (filterContext._v0Count > 0) {
          sql += ` LIMIT ${filterContext._v0Count}`;
        }
        if (filterContext._v0Offset > 0) {
          sql += ` OFFSET ${filterContext._v0Offset}`;
        }

        if (syncDb._resetRegexpEffort) syncDb._resetRegexpEffort();
        if (syncDb._resetEffort) syncDb._resetEffort();
        const stmt = syncDb.prepare(sql);
        const rows = [];
        for (const row of stmt.iterate(allParams)) {
          rows.push(row);
        }

        // Batch-fetch designations if iteration will need them.
        // The worker takes the full path (per-code designations() call) when:
        //   includeDesignations is true, OR workingLanguages is null/undefined.
        // We batch-fetch here to avoid N individual DB queries during iteration.
        const hints = filterContext._v0DesignationHints;
        const needDesignations = hints && (hints.includeDesignations || !hints.languages);
        const designationMap = new Map();
        if (needDesignations && rows.length > 0) {
          const conceptIds = rows.map(r => r.concept_id);
          const BATCH = 500;
          const designationTableRef = this.meta?.designationOrderIndex
            ? 'designation INDEXED BY idx_designation_concept_pref_term'
            : 'designation';
          for (let i = 0; i < conceptIds.length; i += BATCH) {
            const batch = conceptIds.slice(i, i + BATCH);
            const dPlaceholders = batch.map(() => '?').join(',');
            const dStmt = syncDb.prepare(
              `SELECT concept_id, language_code, use_code, term, preferred, active
               FROM ${designationTableRef}
               WHERE concept_id IN (${dPlaceholders})
               ORDER BY concept_id, preferred DESC, term`
            );
            for (const dRow of dStmt.iterate(batch)) {
              let arr = designationMap.get(dRow.concept_id);
              if (!arr) { arr = []; designationMap.set(dRow.concept_id, arr); }
              arr.push(dRow);
            }
          }
        }

        const combinedSet = new SqliteRuntimeV0FilterSet('v0-combined-sql', rows.map(r => r.code), true);
        // Attach pre-fetched context rows so filterConcept avoids per-code locate()
        combinedSet._v0Rows = rows;
        combinedSet._v0RowIndex = new Map(rows.map((r, i) => [r.code, i]));
        if (needDesignations) {
          combinedSet._v0Designations = designationMap;
        }
        return [combinedSet];
      }
    }

    // Fallback: combined SQL couldn't be built (no syncDb or unsupported filter).
    // Materialize each recorded include filter the old-fashioned way.
    if (hasIncludeFilters) {
      for (const f of filterContext._v0IncludeFilters) {
        await this.#materializeFilter(filterContext, f.property, f.op, f.value);
      }
    }

    return filterContext.filters || [];
  }

  /** Eagerly materialize a single include filter into filterContext.filters (fallback path). */
  async #materializeFilter(filterContext, prop, op, value) {
    if (prop === 'code' && op === 'regex') {
      const re = new RegExp(`^${value}$`);
      const rows = await all(this.db,
        'SELECT code FROM concept WHERE cs_id = ? ORDER BY code', [this.meta.csId]);
      const codes = rows.map(r => r.code).filter(c => re.test(c));
      filterContext.filters.push(new SqliteRuntimeV0FilterSet(`code-regex:${value}`, codes, true));
      return;
    }
    if (prop === 'concept') {
      if (op === '=') {
        const located = await this.locate(value);
        filterContext.filters.push(new SqliteRuntimeV0FilterSet(
          `concept=${value}`, located.context ? [value] : [], true));
      } else if (op === 'is-a' || op === 'descendent-of') {
        const includeSelf = op === 'is-a'
          ? (this.runtime?.filters?.concept?.isAIncludesSelf !== false) : false;
        const parent = await this.locate(value);
        if (parent.context && this.meta.closureRows > 0 && this.meta.useClosure) {
          filterContext.filters.push(new SqliteRuntimeV0PagedDescendantFilter(
            `concept-${op}:${value}`, parent.context.conceptId, includeSelf));
        } else {
          const codes = await this.#descendantCodes(value, includeSelf);
          filterContext.filters.push(new SqliteRuntimeV0FilterSet(`concept-${op}:${value}`, codes, true));
        }
      } else if (op === 'in') {
        const url = resolveInValueSetUrl(this.system(), value, this.runtime);
        const rows = await all(this.db,
          `SELECT c.code FROM value_set v
           JOIN value_set_member m ON m.vs_id = v.vs_id
           JOIN concept c ON c.concept_id = m.concept_id
           WHERE v.cs_id = ? AND v.url = ? AND m.active = 1 ORDER BY code`,
          [this.meta.csId, url]);
        filterContext.filters.push(new SqliteRuntimeV0FilterSet(`concept-in:${value}`, rows.map(r => r.code), true));
      }
      return;
    }
    // Property filter
    const propertyCfg = await this.#resolvePropertyFilterConfig(prop);
    if (propertyCfg) {
      await this.#filterByProperty(filterContext, propertyCfg, op, value);
    }
  }

  capabilities() {
    return {
      filterPage: true
    };
  }

  async filterPage(filterContext, set, count = 256) {
    void filterContext;
    const pageSize = Math.max(1, Number.isFinite(count) ? Math.floor(count) : 256);

    if (this.#isPredicateFilter(set)) {
      return [];
    }

    if (this.#isPagedDescendantFilter(set)) {
      let start = set.cursor + 1;
      while (!set.done && (set.rows.length - start) < pageSize) {
        await this.#loadNextDescendantPage(set);
        start = set.cursor + 1;
      }
      if (start >= set.rows.length) {
        return [];
      }
      const end = Math.min(set.rows.length, start + pageSize);
      const page = set.rows.slice(start, end);
      set.cursor = end - 1;
      return page;
    }

    if (set instanceof SqliteRuntimeV0FilterSet) {
      const start = set.cursor + 1;
      if (start >= set.codes.length) {
        return [];
      }
      const end = Math.min(set.codes.length, start + pageSize);
      const codes = set.codes.slice(start, end);
      set.cursor = end - 1;
      return this.#batchLoadContextsByCodes(codes);
    }

    return null;
  }

  async filterSize(_filterContext, set) {
    if (this.#isPredicateFilter(set)) {
      return 0;
    }
    if (this.#isPagedDescendantFilter(set)) {
      return set.done ? set.rows.length : 0;
    }
    return set.codes.length;
  }

  async filtersNotClosed(filterContext) {
    return (filterContext.filters || []).some(f => !f.closed);
  }

  async filterMore(_filterContext, set) {
    if (this.#isPredicateFilter(set)) {
      return false;
    }
    if (this.#isPagedDescendantFilter(set)) {
      set.cursor += 1;
      while (set.cursor >= set.rows.length) {
        if (set.done) {
          return false;
        }
        await this.#loadNextDescendantPage(set);
      }
      return true;
    }
    set.cursor += 1;
    return set.cursor < set.codes.length;
  }

  async filterConcept(_filterContext, set) {
    if (this.#isPredicateFilter(set)) {
      return null;
    }
    if (this.#isPagedDescendantFilter(set)) {
      if (set.cursor < 0 || set.cursor >= set.rows.length) {
        return null;
      }
      return set.rows[set.cursor];
    }
    if (set.cursor < 0 || set.cursor >= set.codes.length) {
      return null;
    }
    // Use pre-fetched row from executeFilters if available (avoids per-code locate)
    if (set._v0Rows && set._v0RowIndex) {
      const idx = set._v0RowIndex.get(set.codes[set.cursor]);
      if (idx !== undefined) {
        const row = set._v0Rows[idx];
        const ctx = new SqliteRuntimeV0Context(row.concept_id, row.code, row.display, row.definition, row.active);
        if (set._v0Designations) {
          ctx._v0Designations = set._v0Designations.get(row.concept_id) || [];
        }
        return ctx;
      }
    }
    const located = await this.locate(set.codes[set.cursor]);
    return located.context;
  }

  async filterLocate(_filterContext, set, code) {
    if (this.#isPredicateFilter(set)) {
      return this.#filterLocatePredicate(set, code);
    }
    if (this.#isPagedDescendantFilter(set)) {
      const located = await this.locate(code);
      if (!located.context) {
        return `Code '${code}' not found in filter set`;
      }
      const ok = await this.#isA(set.ancestorId, located.context.conceptId, !!set.includeSelf);
      return ok ? located.context : `Code '${code}' not found in filter set`;
    }
    if (!set.has(code)) {
      return `Code '${code}' not found in filter set`;
    }
    const located = await this.locate(code);
    return located.context || `Code '${code}' not found`;
  }

  async filterCheck(_filterContext, set, concept) {
    const ctxt = await this._ensureContext(concept);
    if (!ctxt) return false;
    if (this.#isPredicateFilter(set)) {
      return this.#predicateMatchesContext(set, ctxt);
    }
    if (this.#isPagedDescendantFilter(set)) {
      return this.#isA(set.ancestorId, ctxt.conceptId, !!set.includeSelf);
    }
    return set.has(ctxt.code);
  }

  async buildKnownValueSet(_url, _version) {
    void _url;
    void _version;
    return null;
  }

  async #resolvePropertyDef(propertyCode) {
    if (!propertyCode) return null;
    if (this.propertyDefs.has(propertyCode)) {
      return this.propertyDefs.get(propertyCode);
    }

    const row = await get(
      this.db,
      `SELECT property_id, property_code, value_kind
       FROM property_def
       WHERE cs_id = ?
         AND property_code = ?
       LIMIT 1`,
      [this.meta.csId, propertyCode]
    );
    const result = row || null;
    this.propertyDefs.set(propertyCode, result);
    return result;
  }

  async #resolvePropertyFilterConfig(propertyCode) {
    if (!propertyCode) return null;

    const filtersCfg = this.runtime.filters?.properties;
    if (!filtersCfg) {
      const propertyDef = await this.#resolvePropertyDef(propertyCode);
      if (!propertyDef) {
        return null;
      }
      return {
        propertyId: propertyDef.property_id,
        propertyCode: propertyDef.property_code,
        operators: ['=', 'in'],
        sources: inferSourcesFromValueKind(propertyDef.value_kind),
        linkMatch: 'code-only',
        value: {},
        specialHandler: null
      };
    }

    const aliases = filtersCfg.aliases || {};
    const rawCode = String(propertyCode);
    const aliasTarget = aliases[rawCode] ?? aliases[rawCode.toLowerCase()];
    const resolvedCode = aliasTarget || rawCode;

    const byCode = filtersCfg.byCode || {};
    const specific = byCode[resolvedCode] || byCode[rawCode] || null;
    if (!specific && filtersCfg.allPropertiesFilterable !== true) {
      return null;
    }

    const propertyDef = await this.#resolvePropertyDef(resolvedCode);
    if (!propertyDef) {
      return null;
    }

    const operators = Array.isArray(specific?.operators) && specific.operators.length > 0
      ? specific.operators
      : (Array.isArray(filtersCfg.defaultOperators) && filtersCfg.defaultOperators.length > 0
        ? filtersCfg.defaultOperators
        : ['=']);

    const defaultSources = Array.isArray(filtersCfg.defaultSources)
      ? filtersCfg.defaultSources
      : inferSourcesFromValueKind(propertyDef.value_kind);
    const sources = Array.isArray(specific?.sources) && specific.sources.length > 0
      ? specific.sources
      : defaultSources;

    const cleanedSources = dedupSources(sources, propertyDef.value_kind);
    const linkMatch = specific?.linkMatch || filtersCfg.defaultLinkMatch || 'code-only';
    const value = {
      ...(filtersCfg.defaultValue || {}),
      ...(specific?.value || {})
    };

    return {
      propertyId: propertyDef.property_id,
      propertyCode: resolvedCode,
      operators,
      sources: cleanedSources,
      linkMatch,
      value,
      specialHandler: specific?.specialHandler || null
    };
  }

  async #filterByProperty(filterContext, propertyCfg, op, value) {
    const filterName = `property-${propertyCfg.propertyCode}-${op}:${value}`;

    if (propertyCfg.specialHandler) {
      const codes = await this.#runSpecialPropertyHandler(propertyCfg, op, value);
      filterContext.filters.push(new SqliteRuntimeV0FilterSet(filterName, codes, true));
      return;
    }

    if (this.#useMembershipPredicate(filterContext)) {
      const predicate = await this.#buildPropertyPredicateFilter(filterName, propertyCfg, op, value);
      if (predicate) {
        filterContext.filters.push(predicate);
        return;
      }
    }

    if (op === '=') {
      const candidates = normalizedFilterCandidates(value, propertyCfg.value);
      if (candidates.length === 0) {
        filterContext.filters.push(new SqliteRuntimeV0FilterSet(filterName, [], true));
        return;
      }
      const codes = await this.#propertyEqualsCodes(propertyCfg, candidates);
      filterContext.filters.push(new SqliteRuntimeV0FilterSet(filterName, codes, true));
      return;
    }

    if (op === 'in') {
      const members = splitFilterValueList(value);
      const aggregate = new Set();
      for (const member of members) {
        const candidates = normalizedFilterCandidates(member, propertyCfg.value);
        if (candidates.length === 0) continue;
        const codes = await this.#propertyEqualsCodes(propertyCfg, candidates);
        for (const code of codes) {
          aggregate.add(code);
        }
      }
      filterContext.filters.push(new SqliteRuntimeV0FilterSet(filterName, Array.from(aggregate).sort(), true));
      return;
    }

    if (op === 'exists') {
      const codes = await this.#propertyExistsCodes(propertyCfg, value);
      filterContext.filters.push(new SqliteRuntimeV0FilterSet(filterName, codes, true));
      return;
    }

    if (op === 'regex') {
      const codes = await this.#propertyRegexCodes(propertyCfg, value);
      filterContext.filters.push(new SqliteRuntimeV0FilterSet(filterName, codes, true));
      return;
    }

    throw new Error(`Unsupported sqlite runtime property operator '${op}'`);
  }

  async #buildPropertyPredicateFilter(filterName, propertyCfg, op, value) {
    const caseSensitive = propertyCfg.value?.caseSensitive === true;

    if (op === '=') {
      const candidates = normalizedFilterCandidates(value, propertyCfg.value);
      if (candidates.length === 0) {
        return new SqliteRuntimeV0FilterSet(filterName, [], true);
      }
      return new SqliteRuntimeV0PredicateFilter(
        filterName,
        'property-filter',
        { propertyCfg, op, candidates, caseSensitive },
        true
      );
    }

    if (op === 'in') {
      const members = splitFilterValueList(value);
      const aggregate = new Set();
      for (const member of members) {
        const candidates = normalizedFilterCandidates(member, propertyCfg.value);
        for (const candidate of candidates) {
          aggregate.add(candidate);
        }
      }
      const values = Array.from(aggregate);
      if (values.length === 0) {
        return new SqliteRuntimeV0FilterSet(filterName, [], true);
      }
      return new SqliteRuntimeV0PredicateFilter(
        filterName,
        'property-filter',
        { propertyCfg, op, candidates: values, caseSensitive },
        true
      );
    }

    if (op === 'exists') {
      const expectExists = String(value ?? 'true').toLowerCase() !== 'false';
      return new SqliteRuntimeV0PredicateFilter(
        filterName,
        'property-filter',
        { propertyCfg, op, expectExists },
        true
      );
    }

    if (op === 'regex') {
      try {
        new RegExp(String(value || ''));
      } catch (error) {
        throw new Error(`Invalid regex '${value}': ${error.message}`);
      }
      return new SqliteRuntimeV0PredicateFilter(
        filterName,
        'property-filter',
        { propertyCfg, op, pattern: String(value || '') },
        true
      );
    }

    return null;
  }

  async #propertyEqualsCodes(propertyCfg, candidates) {
    const codeSet = new Set();
    const caseSensitive = propertyCfg.value?.caseSensitive === true;

    if (propertyCfg.sources.includes('literal')) {
      const rows = await this.#propertyLiteralEqualsRows(propertyCfg.propertyId, candidates, caseSensitive);
      for (const row of rows) {
        codeSet.add(row.code);
      }
    }

    if (propertyCfg.sources.includes('link')) {
      const rows = await this.#propertyLinkEqualsRows(propertyCfg, candidates, caseSensitive);
      for (const row of rows) {
        codeSet.add(row.code);
      }
    }

    return Array.from(codeSet).sort();
  }

  async #propertyRegexCodes(propertyCfg, pattern) {
    let regex;
    try {
      regex = new RegExp(String(pattern || ''));
    } catch (error) {
      throw new Error(`Invalid regex '${pattern}': ${error.message}`);
    }

    const codeSet = new Set();

    if (propertyCfg.sources.includes('literal')) {
      const rows = await all(
        this.db,
        `SELECT c.code AS code,
                COALESCE(cl.value_text, cl.value_raw) AS value
         FROM concept_literal cl
         JOIN concept c ON c.concept_id = cl.source_concept_id
         WHERE cl.property_id = ?
           AND cl.active = 1
           AND c.cs_id = ?
           AND COALESCE(cl.value_text, cl.value_raw) IS NOT NULL`,
        [propertyCfg.propertyId, this.meta.csId]
      );
      for (const row of rows) {
        if (regex.test(row.value)) {
          codeSet.add(row.code);
        }
      }
    }

    if (propertyCfg.sources.includes('link')) {
      const rows = await all(
        this.db,
        `SELECT src.code AS code,
                tgt.code AS target_code,
                tgt.display AS target_display
         FROM concept_link l
         JOIN concept src ON src.concept_id = l.source_concept_id
         JOIN concept tgt ON tgt.concept_id = l.target_concept_id
         WHERE l.property_id = ?
           AND l.edge_set_id = ?
           AND l.active = 1
           AND src.cs_id = ?`,
        [propertyCfg.propertyId, this.meta.hierarchyEdgeSetId, this.meta.csId]
      );
      for (const row of rows) {
        const codeMatch = row.target_code && regex.test(row.target_code);
        const displayMatch = propertyCfg.linkMatch === 'code-or-display' &&
          row.target_display && regex.test(row.target_display);
        if (codeMatch || displayMatch) {
          codeSet.add(row.code);
        }
      }
    }

    return Array.from(codeSet).sort();
  }

  async #propertyLiteralEqualsRows(propertyId, candidates, caseSensitive) {
    if (!propertyId || !Array.isArray(candidates) || candidates.length === 0) {
      return [];
    }

    const normalized = candidates.map(v => String(v));
    const placeholders = normalized.map(() => '?').join(', ');
    const textPredicate = caseSensitive
      ? `cl.value_text IN (${placeholders})`
      : `cl.value_text COLLATE NOCASE IN (${placeholders})`;
    const rawPredicate = caseSensitive
      ? `cl.value_raw IN (${placeholders})`
      : `cl.value_raw COLLATE NOCASE IN (${placeholders})`;

    return all(
      this.db,
      `WITH matched_concepts AS (
         SELECT cl.source_concept_id AS concept_id
         FROM concept_literal cl
         WHERE cl.property_id = ?
           AND cl.active = 1
           AND cl.value_text IS NOT NULL
           AND ${textPredicate}
         UNION
         SELECT cl.source_concept_id AS concept_id
         FROM concept_literal cl
         WHERE cl.property_id = ?
           AND cl.active = 1
           AND cl.value_text IS NULL
           AND cl.value_raw IS NOT NULL
           AND ${rawPredicate}
       )
       SELECT DISTINCT c.code AS code
       FROM matched_concepts m
       JOIN concept c ON c.concept_id = m.concept_id
       WHERE c.cs_id = ?
       ORDER BY c.code`,
      [propertyId, ...normalized, propertyId, ...normalized, this.meta.csId]
    );
  }

  async #propertyLinkEqualsRows(propertyCfg, candidates, caseSensitive) {
    if (!propertyCfg?.propertyId || !Array.isArray(candidates) || candidates.length === 0) {
      return [];
    }

    const normalized = candidates.map(v => String(v));
    const placeholders = normalized.map(() => '?').join(', ');
    const codeExpr = caseSensitive
      ? `code IN (${placeholders})`
      : `code COLLATE NOCASE IN (${placeholders})`;
    const displayExpr = caseSensitive
      ? `display IN (${placeholders})`
      : `display COLLATE NOCASE IN (${placeholders})`;

    const targetSql = [
      `SELECT concept_id
       FROM concept
       WHERE cs_id = ?
         AND ${codeExpr}`
    ];
    const params = [this.meta.csId, ...normalized];

    if (propertyCfg.linkMatch === 'code-or-display') {
      targetSql.push(
        `SELECT concept_id
         FROM concept
         WHERE cs_id = ?
           AND ${displayExpr}`
      );
      params.push(this.meta.csId, ...normalized);
    }

    return all(
      this.db,
      `WITH matched_targets AS (
         ${targetSql.join('\nUNION\n')}
       )
       SELECT DISTINCT src.code AS code
       FROM concept_link l
       JOIN matched_targets mt ON mt.concept_id = l.target_concept_id
       JOIN concept src ON src.concept_id = l.source_concept_id
       WHERE src.cs_id = ?
         AND l.property_id = ?
         AND l.edge_set_id = ?
         AND l.active = 1
       ORDER BY src.code`,
      [...params, this.meta.csId, propertyCfg.propertyId, this.meta.hierarchyEdgeSetId]
    );
  }

  async #propertyExistsCodes(propertyCfg, value) {
    const expectExists = String(value ?? 'true').toLowerCase() !== 'false';
    const codeSet = new Set();

    if (propertyCfg.sources.includes('literal')) {
      const rows = await all(
        this.db,
        `SELECT DISTINCT c.code AS code
         FROM concept_literal cl
         JOIN concept c ON c.concept_id = cl.source_concept_id
         WHERE cl.property_id = ?
           AND cl.active = 1
           AND c.cs_id = ?`,
        [propertyCfg.propertyId, this.meta.csId]
      );
      for (const row of rows) {
        codeSet.add(row.code);
      }
    }

    if (propertyCfg.sources.includes('link')) {
      const rows = await all(
        this.db,
        `SELECT DISTINCT src.code AS code
         FROM concept_link l
         JOIN concept src ON src.concept_id = l.source_concept_id
         WHERE l.property_id = ?
           AND l.edge_set_id = ?
           AND l.active = 1
           AND src.cs_id = ?`,
        [propertyCfg.propertyId, this.meta.hierarchyEdgeSetId, this.meta.csId]
      );
      for (const row of rows) {
        codeSet.add(row.code);
      }
    }

    if (expectExists) {
      return Array.from(codeSet).sort();
    }

    const allRows = await all(
      this.db,
      `SELECT code
       FROM concept
       WHERE cs_id = ?`,
      [this.meta.csId]
    );
    return allRows.map(r => r.code).filter(code => !codeSet.has(code)).sort();
  }

  async #runSpecialPropertyHandler(propertyCfg, op, value) {
    const handler = propertyCfg.specialHandler;
    if (handler && typeof handler === 'object' && handler.kind === 'derived-link-filter') {
      return this.#runDerivedLinkPropertyHandler(propertyCfg, handler, op, value);
    }
    throw new Error(`Unsupported sqlite runtime special handler '${JSON.stringify(handler)}'`);
  }

  async #runDerivedLinkPropertyHandler(propertyCfg, handler, op, value) {
    if (!propertyCfg?.propertyId || !handler) {
      return [];
    }

    if (!['=', 'in'].includes(op)) {
      throw new Error(`Unsupported sqlite runtime property operator '${op}' for derived-link-filter`);
    }

    const values = this.#normalizedFilterValuesForSpecialHandler(op, value, propertyCfg.value);
    if (values.length === 0) {
      return [];
    }

    const seedCfg = handler.seed || {};
    const seedCodes = new Set();
    const directPrefixes = Array.isArray(seedCfg.directCodePrefixes)
      ? seedCfg.directCodePrefixes.map(v => String(v || '')).filter(Boolean)
      : [];
    const allowAnyDirect = seedCfg.allowAnyDirect === true;

    for (const raw of values) {
      if (!raw) continue;
      if (allowAnyDirect || directPrefixes.some(prefix => raw.startsWith(prefix))) {
        seedCodes.add(raw);
      }
    }

    let inversePropertyId = null;
    if (seedCfg.useCurrentPropertyAsInverse === true) {
      inversePropertyId = propertyCfg.propertyId;
    } else if (seedCfg.inversePropertyCode) {
      const inversePropertyDef = await this.#resolvePropertyDef(seedCfg.inversePropertyCode);
      inversePropertyId = inversePropertyDef?.property_id || null;
    }

    if (inversePropertyId) {
      const reverseMatches = await this.#sourceCodesForTargetCodes(inversePropertyId, values);
      for (const code of reverseMatches) {
        seedCodes.add(code);
      }
    }

    if (seedCodes.size === 0) {
      return [];
    }

    const projectionCfg = handler.projection || {};
    const projectionPropertyCode = projectionCfg.propertyCode;
    if (!projectionPropertyCode) {
      throw new Error('derived-link-filter handler requires projection.propertyCode');
    }
    const projectionPropertyDef = await this.#resolvePropertyDef(projectionPropertyCode);
    if (!projectionPropertyDef) {
      return [];
    }

    const side = projectionCfg.side === 'source' ? 'source' : 'target';
    return this.#codesFromSourceCodesViaProperty(
      projectionPropertyDef.property_id,
      Array.from(seedCodes),
      side
    );
  }

  #normalizedFilterValuesForSpecialHandler(op, value, valueCfg) {
    const rawValues = op === 'in'
      ? splitFilterValueList(value)
      : [String(value ?? '').trim()];

    const out = new Set();
    for (const raw of rawValues) {
      const normalized = normalizedFilterCandidates(raw, valueCfg);
      for (const entry of normalized) {
        if (entry) out.add(entry);
      }
    }
    return Array.from(out);
  }

  async #sourceCodesForTargetCodes(propertyId, targetCodes) {
    if (!propertyId || !Array.isArray(targetCodes) || targetCodes.length === 0) {
      return [];
    }

    const placeholders = targetCodes.map(() => '?').join(', ');
    const rows = await all(
      this.db,
      `SELECT DISTINCT src.code AS source_code
       FROM concept_link l
       JOIN concept src ON src.concept_id = l.source_concept_id
       JOIN concept tgt ON tgt.concept_id = l.target_concept_id
       WHERE src.cs_id = ?
         AND l.property_id = ?
         AND l.edge_set_id = ?
         AND l.active = 1
         AND tgt.code IN (${placeholders})`,
      [this.meta.csId, propertyId, this.meta.hierarchyEdgeSetId, ...targetCodes]
    );
    return rows.map(row => row.source_code).filter(Boolean);
  }

  async #codesFromSourceCodesViaProperty(propertyId, sourceCodes, resultSide) {
    if (!propertyId || !Array.isArray(sourceCodes) || sourceCodes.length === 0) {
      return [];
    }

    const placeholders = sourceCodes.map(() => '?').join(', ');
    const rows = await all(
      this.db,
      `SELECT DISTINCT src.code AS source_code,
                      tgt.code AS target_code
       FROM concept_link l
       JOIN concept src ON src.concept_id = l.source_concept_id
       JOIN concept tgt ON tgt.concept_id = l.target_concept_id
       WHERE src.cs_id = ?
         AND l.property_id = ?
         AND l.edge_set_id = ?
         AND l.active = 1
         AND src.code IN (${placeholders})`,
      [this.meta.csId, propertyId, this.meta.hierarchyEdgeSetId, ...sourceCodes]
    );

    const picked = rows.map((row) => (resultSide === 'source' ? row.source_code : row.target_code));
    return Array.from(new Set(picked.filter(Boolean))).sort();
  }

  #canUseFtsSearch(searchCfg) {
    if (searchCfg.mode !== 'fts-broad') {
      return false;
    }
    const tables = searchCfg.ftsTables || {};
    const available = this.meta.searchFtsTables || {};

    for (const source of searchCfg.sources) {
      const table = tables[source];
      if (!table) {
        return false;
      }
      if (available[table] !== true) {
        return false;
      }
    }
    return true;
  }

  async #searchCodesWithFts(searchText, searchCfg) {
    const sqlParts = [];
    const params = [];
    const activeClause = searchCfg.activeOnly ? ' AND c.active = 1' : '';
    const matchText = toFtsMatchText(searchText);

    for (const source of searchCfg.sources) {
      if (source === 'display') {
        const table = sqlIdentifier(searchCfg.ftsTables.display, 'search_fts_display');
        sqlParts.push(
          `SELECT c.code AS code
           FROM ${table} f
           JOIN concept c ON c.concept_id = f.rowid
           WHERE c.cs_id = ?${activeClause}
             AND f.term MATCH ?`
        );
        params.push(this.meta.csId, matchText);
        continue;
      }

      if (source === 'designation') {
        const table = sqlIdentifier(searchCfg.ftsTables.designation, 'search_fts_designation');
        const designationClause = searchCfg.designationActiveOnly ? ' AND d.active = 1' : '';
        sqlParts.push(
          `SELECT c.code AS code
           FROM ${table} f
           JOIN designation d ON d.designation_id = f.rowid
           JOIN concept c ON c.concept_id = d.concept_id
           WHERE c.cs_id = ?${activeClause}${designationClause}
             AND f.term MATCH ?`
        );
        params.push(this.meta.csId, matchText);
        continue;
      }

      if (source === 'literal') {
        const table = sqlIdentifier(searchCfg.ftsTables.literal, 'search_fts_literal');
        const literalClause = searchCfg.literalActiveOnly ? ' AND cl.active = 1' : '';
        sqlParts.push(
          `SELECT c.code AS code
           FROM ${table} f
           JOIN concept_literal cl ON cl.literal_id = f.rowid
           JOIN concept c ON c.concept_id = cl.source_concept_id
           WHERE c.cs_id = ?${activeClause}${literalClause}
             AND f.term MATCH ?`
        );
        params.push(this.meta.csId, matchText);
      }
    }

    if (sqlParts.length === 0) {
      return [];
    }

    const rows = await all(
      this.db,
      `SELECT DISTINCT code
       FROM (
         ${sqlParts.join('\nUNION\n')}
       )
       ORDER BY code`,
      params
    );
    return rows.map(r => r.code);
  }

  async #searchCodesWithLike(searchText, searchCfg) {
    const sqlParts = [];
    const params = [];
    const likeText = `%${searchText}%`;
    const activeClause = searchCfg.activeOnly ? ' AND c.active = 1' : '';
    const likeExpr = searchCfg.likeFallback?.caseInsensitive === false
      ? { display: 'c.display LIKE ?', designation: 'd.term LIKE ?', literal: 'COALESCE(cl.value_text, cl.value_raw) LIKE ?' }
      : {
        display: 'LOWER(c.display) LIKE LOWER(?)',
        designation: 'LOWER(d.term) LIKE LOWER(?)',
        literal: 'LOWER(COALESCE(cl.value_text, cl.value_raw)) LIKE LOWER(?)'
      };

    for (const source of searchCfg.sources) {
      if (source === 'display') {
        sqlParts.push(
          `SELECT c.code AS code
           FROM concept c
           WHERE c.cs_id = ?${activeClause}
             AND c.display IS NOT NULL
             AND ${likeExpr.display}`
        );
        params.push(this.meta.csId, likeText);
        continue;
      }

      if (source === 'designation') {
        const designationClause = searchCfg.designationActiveOnly ? ' AND d.active = 1' : '';
        sqlParts.push(
          `SELECT c.code AS code
           FROM designation d
           JOIN concept c ON c.concept_id = d.concept_id
           WHERE c.cs_id = ?${activeClause}${designationClause}
             AND d.term IS NOT NULL
             AND ${likeExpr.designation}`
        );
        params.push(this.meta.csId, likeText);
        continue;
      }

      if (source === 'literal') {
        const literalClause = searchCfg.literalActiveOnly ? ' AND cl.active = 1' : '';
        sqlParts.push(
          `SELECT c.code AS code
           FROM concept_literal cl
           JOIN concept c ON c.concept_id = cl.source_concept_id
           WHERE c.cs_id = ?${activeClause}${literalClause}
             AND COALESCE(cl.value_text, cl.value_raw) IS NOT NULL
             AND ${likeExpr.literal}`
        );
        params.push(this.meta.csId, likeText);
      }
    }

    if (sqlParts.length === 0) {
      return [];
    }

    const rows = await all(
      this.db,
      `SELECT DISTINCT code
       FROM (
         ${sqlParts.join('\nUNION\n')}
       )
       ORDER BY code`,
      params
    );
    return rows.map(r => r.code);
  }

  async _ensureContext(code) {
    if (!code) {
      return null;
    }
    if (typeof code === 'string') {
      const located = await this.locate(code);
      return located.context;
    }
    if (code instanceof SqliteRuntimeV0Context) {
      return code;
    }
    throw new Error(`Unknown context type: ${typeof code}`);
  }

  #useMembershipPredicate(filterContext) {
    return !!filterContext && filterContext.forIterate === false;
  }

  #isPredicateFilter(set) {
    return set instanceof SqliteRuntimeV0PredicateFilter;
  }

  #isPagedDescendantFilter(set) {
    return set instanceof SqliteRuntimeV0PagedDescendantFilter;
  }

  #isQueryIterator(iteratorContext) {
    return iteratorContext instanceof SqliteRuntimeV0QueryIterator;
  }

  async #loadNextIteratorPage(iteratorContext) {
    if (!this.#isQueryIterator(iteratorContext) || iteratorContext.done) {
      return;
    }

    const sql = [];
    const params = [];

    if (iteratorContext.mode === 'all') {
      sql.push(
        `SELECT c.concept_id, c.code, c.display, c.definition, c.active`,
        `FROM concept c`,
        `WHERE c.cs_id = ?`,
        `  AND c.active = 1`
      );
      params.push(this.meta.csId);
    } else if (iteratorContext.mode === 'roots') {
      sql.push(
        `SELECT c.concept_id, c.code, c.display, c.definition, c.active`,
        `FROM concept c`,
        `LEFT JOIN concept_link l`,
        `  ON l.source_concept_id = c.concept_id`,
        ` AND l.property_id = ?`,
        ` AND l.edge_set_id = ?`,
        ` AND l.active = 1`,
        `WHERE c.cs_id = ?`,
        `  AND c.active = 1`,
        `  AND l.edge_id IS NULL`
      );
      params.push(this.meta.hierarchyPropertyId, this.meta.hierarchyEdgeSetId, this.meta.csId);
    } else if (iteratorContext.mode === 'children') {
      if (!iteratorContext.targetConceptId) {
        iteratorContext.done = true;
        return;
      }
      sql.push(
        `SELECT c.concept_id, c.code, c.display, c.definition, c.active`,
        `FROM concept_link l`,
        `JOIN concept c ON c.concept_id = l.source_concept_id`,
        `WHERE l.target_concept_id = ?`,
        `  AND l.property_id = ?`,
        `  AND l.edge_set_id = ?`,
        `  AND l.active = 1`,
        `  AND c.cs_id = ?`
      );
      params.push(
        iteratorContext.targetConceptId,
        this.meta.hierarchyPropertyId,
        this.meta.hierarchyEdgeSetId,
        this.meta.csId
      );
    } else {
      iteratorContext.done = true;
      return;
    }

    if (iteratorContext.lastCode !== null) {
      sql.push(`AND c.code > ?`);
      params.push(iteratorContext.lastCode);
    }

    sql.push(`ORDER BY c.code`);
    sql.push(`LIMIT ?`);
    params.push(iteratorContext.pageSize);

    const rows = await all(this.db, sql.join('\n'), params);
    iteratorContext.rows = [];
    iteratorContext.cursor = 0;

    if (!rows.length) {
      iteratorContext.done = true;
      return;
    }

    for (const row of rows) {
      if (!this.#allowDefaultIterationCode(row.code)) {
        continue;
      }
      iteratorContext.rows.push(
        new SqliteRuntimeV0Context(
          row.concept_id,
          row.code,
          row.display,
          row.definition,
          row.active === 1
        )
      );
    }

    iteratorContext.lastCode = rows[rows.length - 1].code;
    if (rows.length < iteratorContext.pageSize) {
      iteratorContext.done = true;
    }
  }

  async #loadNextDescendantPage(set) {
    if (!this.#isPagedDescendantFilter(set) || set.done) {
      return;
    }

    if (!set.strategy) {
      const countRow = await get(
        this.db,
        `SELECT COUNT(*) AS n
         FROM closure
         WHERE ancestor_id = ?`,
        [set.ancestorId]
      );
      const rawCount = Math.max(0, countRow?.n || 0);
      set.descendantCount = set.includeSelf ? rawCount : Math.max(0, rawCount - 1);
      const threshold = Number(this.runtime?.hierarchy?.closure?.conceptScanThreshold || 25000);
      set.strategy = set.descendantCount >= threshold ? 'concept-scan' : 'closure-join';
    }

    let rows;
    if (set.strategy === 'concept-scan') {
      const sql = [
        `SELECT c.concept_id, c.code, c.display, c.definition, c.active`,
        `FROM concept c`,
        `WHERE c.cs_id = ?`,
        `  AND EXISTS (`,
        `    SELECT 1`,
        `    FROM closure cl`,
        `    WHERE cl.ancestor_id = ?`,
        `      AND cl.descendant_id = c.concept_id`,
        `  )`
      ];
      const params = [this.meta.csId, set.ancestorId];

      if (!set.includeSelf) {
        sql.push(`AND c.concept_id <> ?`);
        params.push(set.ancestorId);
      }
      if (set.lastCode !== null) {
        sql.push(`AND c.code > ?`);
        params.push(set.lastCode);
      }

      sql.push(`ORDER BY c.code`);
      sql.push(`LIMIT ?`);
      params.push(set.pageSize);
      rows = await all(this.db, sql.join('\n'), params);
    } else {
      const sql = [
        `SELECT c.concept_id, c.code, c.display, c.definition, c.active`,
        `FROM closure cl`,
        `JOIN concept c ON c.concept_id = cl.descendant_id`,
        `WHERE cl.ancestor_id = ?`
      ];
      const params = [set.ancestorId];

      if (!set.includeSelf) {
        sql.push(`AND cl.descendant_id <> ?`);
        params.push(set.ancestorId);
      }
      if (set.lastCode !== null) {
        sql.push(`AND c.code > ?`);
        params.push(set.lastCode);
      }

      sql.push(`ORDER BY c.code`);
      sql.push(`LIMIT ?`);
      params.push(set.pageSize);
      rows = await all(this.db, sql.join('\n'), params);
    }

    if (!rows.length) {
      set.done = true;
      return;
    }

    for (const row of rows) {
      set.rows.push(
        new SqliteRuntimeV0Context(
          row.concept_id,
          row.code,
          row.display,
          row.definition,
          row.active === 1
        )
      );
    }

    set.lastCode = rows[rows.length - 1].code;
    if (rows.length < set.pageSize) {
      set.done = true;
    }
  }

  async #filterLocatePredicate(set, code) {
    if (!code) {
      return `Code '${code}' not found in filter set`;
    }
    const located = await this.locate(code);
    if (!located.context) {
      return `Code '${code}' not found in filter set`;
    }
    const ok = await this.#predicateMatchesContext(set, located.context);
    if (ok) {
      return located.context;
    }
    return this.#predicateNotFoundMessage(set, code);
  }

  async #predicateMatchesContext(set, context) {
    const ctxt = await this._ensureContext(context);
    if (!ctxt) return false;

    if (set.kind === 'concept-equals') {
      return ctxt.code === set.code;
    }

    if (set.kind === 'concept-hierarchy') {
      if (!set.ancestorId) return false;
      return this.#isA(set.ancestorId, ctxt.conceptId, !!set.includeSelf);
    }

    if (set.kind === 'concept-in') {
      return this.#isConceptInValueSet(ctxt.conceptId, set.valueSetUrl);
    }

    if (set.kind === 'property-filter') {
      return this.#matchesPropertyPredicate(set, ctxt);
    }

    throw new Error(`Unknown predicate filter kind '${set.kind}'`);
  }

  #predicateNotFoundMessage(set, code) {
    if (set.kind === 'concept-hierarchy') {
      if (set.missingMessage) {
        return set.missingMessage;
      }
      return `Code '${code}' is not in hierarchy of '${set.parentCode}'`;
    }

    if (set.kind === 'concept-in') {
      return `Code '${code}' not found in value set '${set.valueSetUrl}'`;
    }

    if (set.kind === 'concept-equals') {
      return `Code '${code}' does not equal '${set.code}'`;
    }

    return `Code '${code}' not found in filter set`;
  }

  async #matchesPropertyPredicate(set, context) {
    const propertyCfg = set.propertyCfg;
    if (!propertyCfg?.propertyId || !context?.conceptId) {
      return false;
    }

    if (set.op === '=') {
      return this.#conceptMatchesPropertyEquals(
        context.conceptId,
        propertyCfg,
        set.candidates || [],
        set.caseSensitive === true
      );
    }

    if (set.op === 'in') {
      return this.#conceptMatchesPropertyEquals(
        context.conceptId,
        propertyCfg,
        set.candidates || [],
        set.caseSensitive === true
      );
    }

    if (set.op === 'exists') {
      return this.#conceptMatchesPropertyExists(
        context.conceptId,
        propertyCfg,
        set.expectExists !== false
      );
    }

    if (set.op === 'regex') {
      return this.#conceptMatchesPropertyRegex(
        context.conceptId,
        propertyCfg,
        set.pattern || ''
      );
    }

    throw new Error(`Unsupported property predicate operator '${set.op}'`);
  }

  async #conceptMatchesPropertyEquals(conceptId, propertyCfg, candidates, caseSensitive) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return false;
    }

    const values = candidates.map(v => String(v));
    if (propertyCfg.sources.includes('literal')) {
      const literalHit = await this.#conceptHasLiteralEquals(conceptId, propertyCfg.propertyId, values, caseSensitive);
      if (literalHit) {
        return true;
      }
    }

    if (propertyCfg.sources.includes('link')) {
      const linkHit = await this.#conceptHasLinkEquals(conceptId, propertyCfg, values, caseSensitive);
      if (linkHit) {
        return true;
      }
    }

    return false;
  }

  async #conceptHasLiteralEquals(conceptId, propertyId, values, caseSensitive) {
    if (!conceptId || !propertyId || !Array.isArray(values) || values.length === 0) {
      return false;
    }

    const placeholders = values.map(() => '?').join(', ');
    const textPredicate = caseSensitive
      ? `cl.value_text IN (${placeholders})`
      : `cl.value_text COLLATE NOCASE IN (${placeholders})`;
    const rawPredicate = caseSensitive
      ? `cl.value_raw IN (${placeholders})`
      : `cl.value_raw COLLATE NOCASE IN (${placeholders})`;

    const row = await get(
      this.db,
      `SELECT 1 AS found
       FROM concept_literal cl
       WHERE cl.source_concept_id = ?
         AND cl.property_id = ?
         AND cl.active = 1
         AND (
           (cl.value_text IS NOT NULL AND ${textPredicate})
           OR
           (cl.value_text IS NULL AND cl.value_raw IS NOT NULL AND ${rawPredicate})
         )
       LIMIT 1`,
      [conceptId, propertyId, ...values, ...values]
    );
    return !!row;
  }

  async #conceptHasLinkEquals(conceptId, propertyCfg, values, caseSensitive) {
    if (!conceptId || !propertyCfg?.propertyId || !Array.isArray(values) || values.length === 0) {
      return false;
    }

    const placeholders = values.map(() => '?').join(', ');
    const codePredicate = caseSensitive
      ? `tgt.code IN (${placeholders})`
      : `tgt.code COLLATE NOCASE IN (${placeholders})`;
    const displayPredicate = caseSensitive
      ? `tgt.display IN (${placeholders})`
      : `tgt.display COLLATE NOCASE IN (${placeholders})`;
    const where = propertyCfg.linkMatch === 'code-or-display'
      ? `(${codePredicate} OR ${displayPredicate})`
      : `(${codePredicate})`;

    const params = [
      conceptId,
      propertyCfg.propertyId,
      this.meta.hierarchyEdgeSetId,
      this.meta.csId,
      ...values
    ];
    if (propertyCfg.linkMatch === 'code-or-display') {
      params.push(...values);
    }

    const row = await get(
      this.db,
      `SELECT 1 AS found
       FROM concept_link l
       JOIN concept tgt ON tgt.concept_id = l.target_concept_id
       WHERE l.source_concept_id = ?
         AND l.property_id = ?
         AND l.edge_set_id = ?
         AND l.active = 1
         AND tgt.cs_id = ?
         AND ${where}
       LIMIT 1`,
      params
    );
    return !!row;
  }

  async #conceptMatchesPropertyExists(conceptId, propertyCfg, expectExists) {
    let found = false;
    if (propertyCfg.sources.includes('literal')) {
      found = found || await this.#conceptHasLiteralAny(conceptId, propertyCfg.propertyId);
    }
    if (propertyCfg.sources.includes('link')) {
      found = found || await this.#conceptHasLinkAny(conceptId, propertyCfg.propertyId);
    }
    return expectExists ? found : !found;
  }

  async #conceptHasLiteralAny(conceptId, propertyId) {
    const row = await get(
      this.db,
      `SELECT 1 AS found
       FROM concept_literal
       WHERE source_concept_id = ?
         AND property_id = ?
         AND active = 1
       LIMIT 1`,
      [conceptId, propertyId]
    );
    return !!row;
  }

  async #conceptHasLinkAny(conceptId, propertyId) {
    const row = await get(
      this.db,
      `SELECT 1 AS found
       FROM concept_link
       WHERE source_concept_id = ?
         AND property_id = ?
         AND edge_set_id = ?
         AND active = 1
       LIMIT 1`,
      [conceptId, propertyId, this.meta.hierarchyEdgeSetId]
    );
    return !!row;
  }

  async #conceptMatchesPropertyRegex(conceptId, propertyCfg, pattern) {
    let regex;
    try {
      regex = new RegExp(String(pattern || ''));
    } catch (error) {
      throw new Error(`Invalid regex '${pattern}': ${error.message}`);
    }

    if (propertyCfg.sources.includes('literal')) {
      const rows = await all(
        this.db,
        `SELECT COALESCE(value_text, value_raw) AS value
         FROM concept_literal
         WHERE source_concept_id = ?
           AND property_id = ?
           AND active = 1
           AND COALESCE(value_text, value_raw) IS NOT NULL`,
        [conceptId, propertyCfg.propertyId]
      );
      for (const row of rows) {
        if (row.value && regex.test(row.value)) {
          return true;
        }
      }
    }

    if (propertyCfg.sources.includes('link')) {
      const rows = await all(
        this.db,
        `SELECT tgt.code AS target_code,
                tgt.display AS target_display
         FROM concept_link l
         JOIN concept tgt ON tgt.concept_id = l.target_concept_id
         WHERE l.source_concept_id = ?
           AND l.property_id = ?
           AND l.edge_set_id = ?
           AND l.active = 1`,
        [conceptId, propertyCfg.propertyId, this.meta.hierarchyEdgeSetId]
      );
      for (const row of rows) {
        const codeMatch = row.target_code && regex.test(row.target_code);
        const displayMatch = propertyCfg.linkMatch === 'code-or-display' &&
          row.target_display && regex.test(row.target_display);
        if (codeMatch || displayMatch) {
          return true;
        }
      }
    }

    return false;
  }

  async #isConceptInValueSet(conceptId, valueSetUrl) {
    if (!conceptId || !valueSetUrl) return false;
    const row = await get(
      this.db,
      `SELECT 1 AS found
       FROM value_set v
       JOIN value_set_member m ON m.vs_id = v.vs_id
       WHERE v.cs_id = ?
         AND v.url = ?
         AND m.active = 1
         AND m.concept_id = ?
       LIMIT 1`,
      [this.meta.csId, valueSetUrl, conceptId]
    );
    return !!row;
  }

  async #isA(ancestorId, descendantId, includeSelf) {
    if (!this.meta.hierarchyPropertyId) return false;
    if (!ancestorId || !descendantId) return false;
    if (ancestorId === descendantId && includeSelf) return true;

    if (this.meta.closureRows > 0 && this.meta.useClosure) {
      const row = await get(
        this.db,
        `SELECT 1 AS found
         FROM closure
         WHERE ancestor_id = ?
           AND descendant_id = ?
         LIMIT 1`,
        [ancestorId, descendantId]
      );
      if (!row) return false;
      if (!includeSelf && ancestorId === descendantId) return false;
      return true;
    }

    if (!this.#allowRecursiveHierarchyFallback()) {
      return false;
    }

    const row = await get(
      this.db,
      `WITH RECURSIVE descendants(concept_id) AS (
         SELECT ?
         UNION
         SELECT l.source_concept_id
         FROM concept_link l
         JOIN descendants d ON d.concept_id = l.target_concept_id
         WHERE l.property_id = ?
           AND l.edge_set_id = ?
           AND l.active = 1
       )
       SELECT 1 AS found
       FROM descendants
       WHERE concept_id = ?
       LIMIT 1`,
      [ancestorId, this.meta.hierarchyPropertyId, this.meta.hierarchyEdgeSetId, descendantId]
    );

    if (!row) return false;
    if (!includeSelf && ancestorId === descendantId) return false;
    return true;
  }

  async #descendantCodes(ancestorCode, includeSelf) {
    if (!ancestorCode) return [];
    const ancestorContext = await this._ensureContext(ancestorCode);
    if (!ancestorContext) return [];
    const ancestorId = ancestorContext.conceptId;

    if (this.meta.closureRows > 0 && this.meta.useClosure) {
      const rows = await all(
        this.db,
        `SELECT c.code, cl.descendant_id
         FROM closure cl
         JOIN concept c ON c.concept_id = cl.descendant_id
         WHERE cl.ancestor_id = ?
         ORDER BY c.code`,
        [ancestorId]
      );
      return rows
        .filter(r => includeSelf || r.descendant_id !== ancestorId)
        .map(r => r.code);
    }

    if (!this.#allowRecursiveHierarchyFallback()) {
      return [];
    }

    const rows = await all(
      this.db,
      `WITH RECURSIVE descendants(concept_id, depth) AS (
         SELECT ?, 0
         UNION
         SELECT l.source_concept_id, descendants.depth + 1
         FROM concept_link l
         JOIN descendants ON descendants.concept_id = l.target_concept_id
         WHERE l.property_id = ?
           AND l.edge_set_id = ?
           AND l.active = 1
       )
       SELECT c.code, descendants.concept_id
       FROM descendants
       JOIN concept c ON c.concept_id = descendants.concept_id
       ORDER BY c.code`,
      [ancestorId, this.meta.hierarchyPropertyId, this.meta.hierarchyEdgeSetId]
    );

    return rows
      .filter(r => includeSelf || r.concept_id !== ancestorId)
      .map(r => r.code);
  }

  async #batchLoadContextsByCodes(codes) {
    if (!Array.isArray(codes) || codes.length === 0) {
      return [];
    }

    const placeholders = codes.map(() => '?').join(', ');
    const rows = await all(
      this.db,
      `SELECT concept_id, code, display, definition, active
       FROM concept
       WHERE cs_id = ?
         AND code IN (${placeholders})`,
      [this.meta.csId, ...codes]
    );

    const byCode = new Map();
    for (const row of rows) {
      byCode.set(row.code, row);
    }

    const contexts = [];
    for (const code of codes) {
      const row = byCode.get(code);
      if (!row) {
        continue;
      }
      contexts.push(
        new SqliteRuntimeV0Context(
          row.concept_id,
          row.code,
          row.display,
          row.definition,
          row.active === 1
        )
      );
    }

    return contexts;
  }

  #allowDefaultIterationCode(code) {
    if (!this.defaultIterationRegex) {
      return true;
    }
    return this.defaultIterationRegex.test(String(code || ''));
  }

  #allowRecursiveHierarchyFallback() {
    return this.runtime?.hierarchy?.closure?.fallbackRecursive !== false;
  }
}

class SqliteRuntimeV0FactoryProvider extends CodeSystemFactoryProvider {

  /**
   * Register a v0 specialization. Subclass modules call this at require-time
   * to declare interest in specific terminologies.
   *
   * @param {Object} definition
   * @param {string} definition.id - Unique identifier (e.g. 'snomed-expressions')
   * @param {Function} definition.FactoryClass - Subclass of SqliteRuntimeV0FactoryProvider
   * @param {string} [definition.systemPrefix] - URL prefix to match against
   *   the code system's canonical URI (e.g. 'http://snomed.info/sct')
   * @param {string[]} [definition.tags] - All listed tags must be present in
   *   the db's behaviorFlags.tags for a match
   * @param {number} [definition.priority=0] - Higher wins on conflict
   */
  static registerSpecialization(definition) {
    if (!definition || typeof definition !== 'object') {
      throw new Error('registerSpecialization requires an object definition');
    }
    if (typeof definition.FactoryClass !== 'function') {
      throw new Error('registerSpecialization requires a FactoryClass');
    }
    if (!definition.systemPrefix && (!definition.tags || definition.tags.length === 0)) {
      throw new Error('registerSpecialization requires systemPrefix and/or tags');
    }
    V0_SPECIALIZATION_REGISTRY.push({
      id: String(definition.id || `v0-spec-${V0_SPECIALIZATION_REGISTRY.length + 1}`),
      priority: Number.isFinite(definition.priority) ? definition.priority : 0,
      systemPrefix: definition.systemPrefix || null,
      tags: Array.isArray(definition.tags) ? definition.tags : [],
      FactoryClass: definition.FactoryClass
    });
    V0_SPECIALIZATION_REGISTRY.sort((a, b) => b.priority - a.priority);
  }

  static listSpecializations() {
    return V0_SPECIALIZATION_REGISTRY.map(e => ({
      id: e.id, priority: e.priority,
      systemPrefix: e.systemPrefix, tags: [...e.tags]
    }));
  }

  /**
   * Load a v0 database file and return the appropriate factory. Probes the
   * db metadata (canonical URI + tags), checks the specialization registry,
   * and returns a specialized factory if one matches — otherwise the generic.
   *
   * @param {Object} options
   * @param {string} [options.specialization] - Override automatic matching:
   *   'none' forces the generic base factory; a specific id (e.g.
   *   'snomed-expressions') selects that entry from the registry.
   *   Omit to use automatic tag/URL matching (the default).
   */
  static async createFromMetadata(i18n, dbPath, options = {}) {
    const probe = new SqliteRuntimeV0FactoryProvider(i18n, dbPath, options);
    await probe.load();

    const { specialization } = options;

    // 'none' = force generic base, skip registry
    if (specialization === 'none') {
      return probe;
    }

    const system = probe.system() || '';
    const flags = probe._runtime?.behaviorFlags || {};
    const dbTags = new Set(Array.isArray(flags.tags) ? flags.tags : []);

    for (const entry of V0_SPECIALIZATION_REGISTRY) {
      // If a specific specialization was requested, only match that id
      if (specialization && entry.id !== specialization) continue;

      const urlMatch = !entry.systemPrefix || system.startsWith(entry.systemPrefix);
      const tagMatch = entry.tags.length === 0 || entry.tags.every(t => dbTags.has(t));
      if (urlMatch && tagMatch) {
        probe.close();
        const resolved = new entry.FactoryClass(i18n, dbPath, options);
        await resolved.load();
        return resolved;
      }
    }

    return probe;
  }

  constructor(i18n, dbPath, options = {}) {
    super(i18n);
    this.dbPath = dbPath;
    this.idPrefix = options.idPrefix || 'sqlite-runtime-v0';
    this.effortLimitMs = options.effortLimitMs;
    this._loaded = false;
    this._loadPromise = null;
    this._db = null;
    this._meta = null;
    this._runtime = null;
    this._sharedState = {
      statusByPropertyId: new Map(),
      statusLoadPromises: new Map(),
      childTargetSets: new Map(),
      childTargetLoadPromises: new Map()
    };
  }

  system() {
    return this._meta?.baseUri || null;
  }

  version() {
    return this._meta?.canonicalUri || this._meta?.version || null;
  }

  getPartialVersion() {
    const v = this.version();
    if (!v) return null;
    const idx = v.indexOf('/version/');
    if (idx === -1) return null;
    return v.substring(0, idx);
  }

  name() {
    return this._meta?.name || this.system() || 'SQLite Runtime';
  }

  defaultVersion() {
    return this._meta?.version || 'unknown';
  }

  async load() {
    if (this._loaded) {
      return;
    }
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        this._db = await openDb(this.dbPath, true);
        const db = this._db;

        const codeSystem = await get(
          db,
          `SELECT cs_id, base_uri, canonical_uri, edition_code, version, name
           FROM code_system
           ORDER BY cs_id DESC
           LIMIT 1`,
          []
        );

        if (!codeSystem) {
          throw new Error(`No code_system rows found in ${this.dbPath}`);
        }

        const totalRow = await get(
          db,
          'SELECT COUNT(*) AS n FROM concept WHERE cs_id = ?',
          [codeSystem.cs_id]
        );

        const cfgRows = await all(
          db,
          `SELECT key, value
           FROM cs_config
           WHERE cs_id = ?`,
          [codeSystem.cs_id]
        );
        const cfg = {};
        for (const row of cfgRows) {
          cfg[row.key] = parseConfigValue(row.value);
        }

        const runtime = buildRuntimeConfig(cfg, codeSystem.base_uri);
        const searchCfg = normalizedSearchConfig(runtime.search);

        let hierarchyPropertyCode = runtime.hierarchy?.propertyCode || null;
        if (!hierarchyPropertyCode) {
          const hierarchyRow = await get(
            db,
            `SELECT property_code
             FROM property_def
             WHERE cs_id = ? AND is_hierarchy = 1
             ORDER BY property_id
             LIMIT 1`,
            [codeSystem.cs_id]
          );
          hierarchyPropertyCode = hierarchyRow?.property_code || null;
        }

        let hierarchyPropertyId = null;
        if (hierarchyPropertyCode) {
          const hierarchyPropRow = await get(
            db,
            `SELECT property_id
             FROM property_def
             WHERE cs_id = ? AND property_code = ?`,
            [codeSystem.cs_id, hierarchyPropertyCode]
          );
          hierarchyPropertyId = hierarchyPropRow?.property_id || null;
        }

        const closureCountRow = await get(db, `SELECT COUNT(*) AS n FROM closure`, []);
      const searchFtsTables = {};
        for (const source of searchCfg.sources) {
          const configured = searchCfg.ftsTables?.[source];
          if (!configured) continue;
          const table = sqlIdentifier(configured, configured);
          if (!table) continue;
          const exists = await get(
            db,
            `SELECT 1 AS found
             FROM sqlite_master
             WHERE type = 'table' AND name = ?
             LIMIT 1`,
            [table]
          );
          searchFtsTables[table] = !!exists;
      }
      const designationOrderIndex = await get(
        db,
        `SELECT 1 AS found
         FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_designation_concept_pref_term'
         LIMIT 1`,
        []
      );

      this._meta = {
          csId: codeSystem.cs_id,
          baseUri: codeSystem.base_uri,
          canonicalUri: codeSystem.canonical_uri,
          editionCode: codeSystem.edition_code,
          version: codeSystem.version,
          name: codeSystem.name || codeSystem.base_uri,
          totalConcepts: totalRow ? totalRow.n : 0,
          defaultLanguage: runtime.languages?.default || 'en',
          closureRows: closureCountRow ? closureCountRow.n : 0,
        hierarchyPropertyId,
        hierarchyEdgeSetId: runtime.hierarchy?.edgeSetId || 1,
        useClosure: runtime.hierarchy?.closure?.enabled !== false,
        searchFtsTables,
        designationOrderIndex: !!designationOrderIndex
      };
        this._runtime = runtime;
        this._loaded = true;
      })();
    }
    await this._loadPromise;
  }

  async build(opContext, supplements) {
    if (!this._loaded) {
      await this.load();
    }

    this.recordUse();

    return new SqliteRuntimeV0Provider(opContext, supplements, this._db, this._meta, this._runtime, {
      ownsDb: false,
      sharedState: this._sharedState,
      dbPath: this.dbPath,
      effortLimitMs: this.effortLimitMs
    });
  }

  async buildKnownValueSet(url, version) {
    if (!this._loaded) {
      await this.load();
    }

    if (!url || !this.system() || !url.startsWith(this.system())) {
      return null;
    }

    if (version && this._meta.canonicalUri && !this._meta.canonicalUri.startsWith(version)) {
      return null;
    }

    const qIndex = url.indexOf('?');
    if (qIndex < 0) {
      return null;
    }

    const query = url.substring(qIndex + 1);
    const implicit = this._runtime.implicitValueSets || {};

    if (Array.isArray(implicit.all?.queries) && implicit.all.queries.includes(query)) {
      return {
        resourceType: 'ValueSet',
        url,
        version: this._meta.version,
        status: 'active',
        name: `${sanitizeName(this.system())}All`,
        title: `${this.name()} All Concepts`,
        description: `All concepts from ${this.name()}`,
        compose: { include: [{ system: this.system() }] }
      };
    }

    for (const [name, cfg] of Object.entries(implicit)) {
      if (!cfg || !cfg.queryPrefix || !cfg.filter) continue;
      if (!query.startsWith(cfg.queryPrefix)) continue;

      const suffix = query.substring(cfg.queryPrefix.length);
      const filterValue = cfg.filter.valueFromSuffix ? suffix : cfg.filter.value;
      return {
        resourceType: 'ValueSet',
        url,
        version: this._meta.version,
        status: 'active',
        name: `${sanitizeName(this.system())}${name}${suffix}`,
        compose: {
          include: [{
            system: this.system(),
            filter: [{
              property: cfg.filter.property,
              op: cfg.filter.op,
              value: filterValue
            }]
          }]
        }
      };
    }

    return null;
  }

  id() {
    return `${this.idPrefix}:${this._meta?.version || 'unknown'}`;
  }

  close() {
    if (!this._db) {
      return;
    }
    this._db.close();
    this._db = null;
    this._loaded = false;
    this._loadPromise = null;
  }
}

function buildRuntimeConfig(cfg, system) {
  const searchCfg = normalizedSearchConfig(cfg['runtime.search']);

  const runtime = {
    versioning: cfg['runtime.versioning'] || { algorithm: 'string', partialMatch: true },
    languages: cfg['runtime.languages'] || { default: 'en' },
    designations: cfg['runtime.designations'] || {},
    hierarchy: cfg['runtime.hierarchy'] || {
      propertyCode: null,
      edgeSetId: 1,
      closure: { enabled: true, fallbackRecursive: false }
    },
    filters: cfg['runtime.filters'] || {
      concept: { operators: ['=', 'is-a', 'descendent-of', 'in'] },
      code: { operators: ['regex'] }
    },
    implicitValueSets: cfg['runtime.implicitValueSets'] || defaultImplicitValueSets(system),
    status: cfg['runtime.status'] || {
      inactive: { source: 'concept.active', invert: true },
      deprecated: { source: 'constant', value: false },
      abstract: { source: 'constant', value: false }
    },
    iteration: cfg['runtime.iteration'] || {},
    search: searchCfg,
    behaviorFlags: cfg['runtime.behaviorFlags'] || {}
  };

  if (!runtime.hierarchy.edgeSetId) runtime.hierarchy.edgeSetId = 1;
  if (!runtime.languages.default) runtime.languages.default = 'en';

  return runtime;
}

function normalizedSearchConfig(raw) {
  const value = raw || {};

  const sources = Array.isArray(value.sources) && value.sources.length > 0
    ? value.sources.filter(s => ['display', 'designation', 'literal'].includes(s))
    : ['designation'];

  return {
    mode: value.mode || 'like',
    activeOnly: value.activeOnly !== false,
    designationActiveOnly: value.designationActiveOnly !== false,
    literalActiveOnly: value.literalActiveOnly !== false,
    sources,
    ftsTables: {
      display: value.ftsTables?.display || 'search_fts_display',
      designation: value.ftsTables?.designation || 'search_fts_designation',
      literal: value.ftsTables?.literal || 'search_fts_literal'
    },
    likeFallback: {
      enabled: value.likeFallback?.enabled !== false,
      caseInsensitive: value.likeFallback?.caseInsensitive !== false
    }
  };
}

function defaultImplicitValueSets(system) {
  return {
    all: { queries: ['fhir_vs', 'fhir_vs=all'] },
    isa: { queryPrefix: 'fhir_vs=isa/', filter: { property: 'concept', op: 'is-a', valueFromSuffix: true } },
    refset: { queryPrefix: 'fhir_vs=refset/', filter: { property: 'concept', op: 'in', valueFromSuffix: true } },
    _system: system
  };
}

function inferSourcesFromValueKind(valueKind) {
  if (valueKind === 'literal') {
    return ['literal'];
  }
  if (valueKind === 'concept') {
    return ['link'];
  }
  return ['literal', 'link'];
}

function dedupSources(sources, valueKind) {
  const input = Array.isArray(sources) && sources.length > 0
    ? sources
    : inferSourcesFromValueKind(valueKind);
  const cleaned = [];
  for (const source of input) {
    if ((source === 'literal' || source === 'link') && !cleaned.includes(source)) {
      cleaned.push(source);
    }
  }
  if (cleaned.length === 0) {
    return inferSourcesFromValueKind(valueKind);
  }
  return cleaned;
}

function normalizedFilterCandidates(value, valueCfg) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];

  const cfg = valueCfg || {};
  const normalizeCase = cfg.normalizeCase !== false;
  const aliases = cfg.aliases || {};

  const out = new Set();
  out.add(raw);

  const rawKey = normalizeCase ? raw.toLowerCase() : raw;
  let alias = aliases[raw];
  if (alias === undefined) {
    alias = aliases[rawKey];
  }
  if (alias !== undefined && alias !== null && String(alias).trim() !== '') {
    out.add(String(alias).trim());
  }

  return Array.from(out);
}

function splitFilterValueList(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v ?? '').trim()).filter(Boolean);
  }
  return String(value ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function resolveInValueSetUrl(system, value, runtime) {
  if (typeof value === 'string' && value.startsWith('http://')) return value;
  if (typeof value === 'string' && value.startsWith('https://')) return value;

  const refsetCfg = runtime.implicitValueSets?.refset;
  if (refsetCfg?.urlTemplate) {
    return refsetCfg.urlTemplate
      .replace('{system}', system)
      .replace('{value}', extractRefsetId(value));
  }

  return `${system}?fhir_vs=refset/${extractRefsetId(value)}`;
}

function extractRefsetId(value) {
  if (!value) return value;
  const marker = 'refset/';
  const idx = value.indexOf(marker);
  if (idx === -1) return value;
  return value.substring(idx + marker.length);
}

function useFromDesignation(row, runtime, system) {
  const map = runtime.designations?.useMapping;
  if (map && row.use_code && map[row.use_code]) {
    return map[row.use_code];
  }

  if (row.use_code) {
    return {
      system: runtime.designations?.defaultSystem || system,
      code: row.use_code,
      display: row.use_code
    };
  }

  return CodeSystem.makeUseForDisplay();
}

function sanitizeName(system) {
  return (system || 'CS').replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'CS';
}

function toFtsMatchText(text) {
  // Use phrase syntax to avoid accidental MATCH operators from user input.
  return `"${String(text || '').replace(/"/g, '""')}"`;
}

function sqlIdentifier(name, fallback) {
  const primary = typeof name === 'string' ? name : null;
  if (primary && /^[A-Za-z_][A-Za-z0-9_]*$/.test(primary)) {
    return primary;
  }
  if (typeof fallback === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(fallback)) {
    return fallback;
  }
  return null;
}

function parseConfigValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function openDb(dbPath, readOnly) {
  return new Promise((resolve, reject) => {
    const flags = readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE;
    const db = new sqlite3.Database(dbPath, flags, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

module.exports = {
  SqliteRuntimeV0FactoryProvider,
  SqliteRuntimeV0Provider,
  SqliteRuntimeV0Context,
  SqliteRuntimeV0FilterSet
};

// Auto-discover v0 specializations in this directory.
// Any cs-sqlite-*.js file that calls registerSpecialization() will be loaded.
const { readdirSync } = require('fs');
const { join } = require('path');
const _self = 'cs-sqlite-runtime-v0.js';
for (const f of readdirSync(__dirname)) {
  if (f !== _self && f.startsWith('cs-sqlite-') && f.endsWith('.js')) {
    try { require(join(__dirname, f)); } catch (_e) { /* optional specialization */ }
  }
}
