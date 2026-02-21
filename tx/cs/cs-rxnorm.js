const sqlite3 = require('sqlite3').verbose();
let BetterSqlite3;
try { BetterSqlite3 = require('better-sqlite3'); } catch (e) { /* optional */ }
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const { CodeSystemProvider, CodeSystemFactoryProvider } = require('./cs-api');
const {Designations} = require("../library/designations");
const {validateArrayParameter} = require("../../library/utilities");

// Context for RxNorm concepts
class RxNormConcept {
  constructor(code, display) {
    this.code = code;
    this.display = display;
    this.others = []; // Array of alternative displays (SY terms, etc.)
    this.archived = false;
    this.suppress = false; // Eagerly loaded from locate() to avoid redundant queries
  }
}

// Filter holder for query building and iteration
class RxNormFilterHolder {
  constructor() {
    this.sql = '';
    this.text = false; // Whether this is a text search filter
    this.params = {}; // Parameters for the SQL query
    this.cursor = 0;
    this.results = null; // Will hold query results for iteration
    this.executed = false;
  }
}

// Filter preparation context
class RxNormPrep {
  constructor() {
    this.filters = [];
  }
}

// Iterator context
class RxNormIteratorContext {
  constructor(query, params = {}) {
    this.query = query;
    this.params = params;
    this.cursor = 0;
    this.results = null;
    this.executed = false;
  }

  more() {
    return this.cursor < (this.results ? this.results.length : 0);
  }

  next() {
    this.cursor++;
  }
}

class RxNormServices extends CodeSystemProvider {
  constructor(opContext, supplements, db, sharedData, isNCI = false, dbPath = null) {
    super(opContext, supplements);
    this.db = db;
    this.isNCI = isNCI;
    this.dbPath = dbPath;
    this._syncDb = null; // Lazy better-sqlite3 connection

    // Shared data from factory
    this.dbVersion = sharedData.version;
    this.rels = sharedData.rels;
    this.reltypes = sharedData.reltypes;
    this.totalCodeCount = sharedData.totalCodeCount;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    if (this._syncDb) {
      this._syncDb.close();
      this._syncDb = null;
    }
  }

  // Metadata methods
  system() {
    return this.isNCI ? 'http://ncimeta.nci.nih.gov' : 'http://www.nlm.nih.gov/research/umls/rxnorm';
  }

  version() {
    return this.dbVersion;
  }

  description() {
    return this.isNCI ? 'NCI Metathesaurus' : 'RxNorm';
  }

  name() {
    return this.isNCI ? 'NCI' : 'RxNorm';
  }

  async totalCount() {
    return this.totalCodeCount;
  }

  getSAB() {
    return this.isNCI ? 'NCI' : 'RXNORM';
  }

  getCodeField() {
    return this.isNCI ? 'SCUI' : 'RXCUI';
  }

  hasParents() {
    return true; // RxNorm has relationships
  }

  // Core concept methods
  async code(context) {
    
    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.code : null;
  }

  async display(context) {
    
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return null;
    }

    // Check supplements first
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }

    return ctxt.display || '';
  }

  async definition(context) {
    await this.#ensureContext(context);
    return null; // RxNorm doesn't provide definitions
  }

  async isAbstract(context) {
    await this.#ensureContext(context);

    return false; // RxNorm codes are not abstract
  }

  async getStatus(context) {

    const ctxt = await this.#ensureContext(context);

    if (ctxt && ctxt.archived) {
      return 'archived';
    }

    // Use cached suppress flag from locate() if available
    if (ctxt) {
      return ctxt.suppress ? 'suppressed' : null;
    }
    return null;
  }

  async isInactive(context) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt && ctxt.archived) {
      return true;
    }

    // Use cached suppress flag from locate()
    return ctxt ? ctxt.suppress : false;
  }

  async isDeprecated(context) {
    
    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.archived : false;
  }

  async designations(context, displays) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt) {
      // Add main display
      displays.addDesignation(true, 'active', 'en-US', CodeSystem.makeUseForDisplay(), ctxt.display);

      // Add other displays
      for (const other of ctxt.others) {
        displays.addDesignation(false, 'active', 'en-US', null, other);
      }

      // Add supplement designations
      this._listSupplementDesignations(ctxt.code, displays);
    }
  }

  async #ensureContext(context) {
    if (!context) {
      return null;
    }
    if (typeof context === 'string') {
      const ctxt = await this.locate(context);
      if (!ctxt.context) {
        throw new Error(ctxt.message);
      } else {
        return ctxt.context;
      }
    }
    if (context instanceof RxNormConcept) {
      return context;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof context));
  }

  // Lookup methods
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    return new Promise((resolve, reject) => {
      let sql = `SELECT STR, TTY, SUPPRESS FROM rxnconso WHERE ${this.getCodeField()} = ? AND SAB = ?`;

      this.db.all(sql, [code, this.getSAB()], (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        if (rows.length === 0) {
          // Try archive
          sql = `SELECT STR, TTY FROM RXNATOMARCHIVE WHERE ${this.getCodeField()} = ? AND SAB = ?`;
          this.db.all(sql, [code, this.getSAB()], (err, archiveRows) => {
            if (err) {
              reject(err);
              return;
            }

            if (archiveRows.length === 0) {
              resolve({ context: null, message: undefined});
              return;
            }

            const concept = this.#createConceptFromRows(code, archiveRows, true);
            resolve({ context: concept, message: null });
          });
        } else {
          const concept = this.#createConceptFromRows(code, rows, false);
          resolve({ context: concept, message: null });
        }
      });
    });
  }

  // locateMany intentionally not overridden: SQLite's prepared-statement
  // index lookups are faster than a single IN(...) query with many codes.
  // The base class fallback (N individual locate() calls) wins here.

  #createConceptFromRows(code, rows, archived) {
    const concept = new RxNormConcept(code);
    concept.archived = archived;

    for (const row of rows) {
      if (row.TTY === 'SY' || concept.display && concept.display) {
        concept.others.push(row.STR.trim());
      } else {
        concept.display = row.STR.trim();
      }
      // Cache suppress flag from locate() query to avoid redundant SQL
      if (row.SUPPRESS !== undefined) {
        concept.suppress = row.SUPPRESS === '1';
      }
    }

    return concept;
  }

  // Iterator methods
  async iterator(context) {
    

    if (!context) {
      // Iterate all codes
      const query = `SELECT ${this.getCodeField()}, STR FROM rxnconso WHERE SAB = ? AND TTY <> 'SY' ORDER BY ${this.getCodeField()}`;
      return new RxNormIteratorContext(query, { sab: this.getSAB() });
    } else {
      // No hierarchical iteration for specific contexts in this implementation
      return new RxNormIteratorContext('', {});
    }
  }

  async nextContext(iteratorContext) {
    

    if (!iteratorContext.executed) {
      await this.#executeIterator(iteratorContext);
    }

    if (!iteratorContext.more()) {
      return null;
    }

    const row = iteratorContext.results[iteratorContext.cursor];
    iteratorContext.next();

    const concept = new RxNormConcept(row[this.getCodeField()], row.STR);
    return concept;
  }

  async #executeIterator(iteratorContext) {
    return new Promise((resolve, reject) => {
      this.db.all(iteratorContext.query, Object.values(iteratorContext.params), (err, rows) => {
        if (err) {
          reject(err);
        } else {
          iteratorContext.results = rows;
          iteratorContext.executed = true;
          resolve();
        }
      });
    });
  }

  // Filter support
  async doesFilter(prop, op, value) {
    

    prop = prop.toUpperCase();

    // TTY filters
    if (prop === 'TTY' && ['=', 'in'].includes(op)) {
      return true;
    }

    // STY filter
    if (prop === 'STY' && op === '=') {
      return true;
    }

    // SAB filter
    if (prop === 'SAB' && op === '=') {
      return true;
    }

    // Relationship filters (REL values like 'SY', 'RN', etc.)
    if (this.rels.includes(prop) && op === '=' && (value.startsWith('CUI:') || value.startsWith('AUI:'))) {
      return true;
    }

    // Relationship type filters (RELA values)
    if (this.reltypes.includes(prop) && op === '=' && (value.startsWith('CUI:') || value.startsWith('AUI:'))) {
      return true;
    }

    return false;
  }

  // eslint-disable-next-line no-unused-vars
  async getPrepContext(iterate) {
    return new RxNormPrep();
  }

  async filter(filterContext, prop, op, value) {
    

    const filter = new RxNormFilterHolder();
    prop = prop.toUpperCase();

    let sql = '';
    let params = {};

    if (op === 'in' && prop === 'TTY') {
      const values = value.split(',').map(v => v.trim()).filter(v => v);
      const placeholders = values.map((_, i) => `$tty${i}`).join(',');
      sql = `AND TTY IN (${placeholders})`;
      values.forEach((val, i) => {
        params[`tty${i}`] = this.#sqlWrapString(val);
      });
    } else if (op === '=') {
      if (prop === 'STY') {
        sql = `AND ${this.getCodeField()} IN (SELECT RXCUI FROM rxnsty WHERE TUI = $sty)`;
        params.sty = this.#sqlWrapString(value);
      } else if (prop === 'SAB') {
        sql = `AND ${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE SAB = $sab)`;
        params.sab = this.#sqlWrapString(value);
      } else if (prop === 'TTY') {
        sql = `AND TTY = $tty`;
        params.tty = this.#sqlWrapString(value);
      } else if (this.rels.includes(prop)) {
        if (value.startsWith('CUI:')) {
          const cui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXCUI IN (SELECT RXCUI1 FROM rxnrel WHERE REL = $rel AND RXCUI2 = $cui2)))`;
          params.rel = this.#sqlWrapString(prop);
          params.cui2 = this.#sqlWrapString(cui);
        } else if (value.startsWith('AUI:')) {
          const aui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXAUI IN (SELECT RXAUI1 FROM rxnrel WHERE REL = $rel AND RXAUI2 = $aui2)))`;
          params.rel = this.#sqlWrapString(prop);
          params.aui2 = this.#sqlWrapString(aui);
        }
      } else if (this.reltypes.includes(prop)) {
        if (value.startsWith('CUI:')) {
          const cui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXCUI IN (SELECT RXCUI1 FROM rxnrel WHERE RELA = $rela AND RXCUI2 = $cui2)))`;
          params.rela = this.#sqlWrapString(prop);
          params.cui2 = this.#sqlWrapString(cui);
        } else if (value.startsWith('AUI:')) {
          const aui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXAUI IN (SELECT RXAUI1 FROM rxnrel WHERE RELA = $rela AND RXAUI2 = $aui2)))`;
          params.rela = this.#sqlWrapString(prop);
          params.aui2 = this.#sqlWrapString(aui);
        }
      }
    }

    if (!sql) {
      throw new Error(`Unknown filter "${prop} ${op} ${value}"`);
    }

    filter.sql = sql;
    filter.params = params;
    filterContext.filters.push(filter);
  }

  async searchFilter(filterContext, filter, sort) {
    

    if (!filter || !filter.stems || filter.stems.length === 0) {
      throw new Error('Invalid search filter');
    }

    for (let i = 0; i < filter.stems.length; i++) {
      const stem = filter.stems[i];
      const rxnormFilter = new RxNormFilterHolder();
      rxnormFilter.text = true;
      rxnormFilter.sql = ` AND (${this.getCodeField()} = s${i}.CUI AND s${i}.stem LIKE $stem${i})`;
      rxnormFilter.params[`stem${i}`] = this.#sqlWrapString(stem) + '%';

      filterContext.filters.push(rxnormFilter);
    }
    if (sort) {
      // TODO
    }
  }

  async executeFilters(filterContext) {
    

    if (filterContext.filters.length === 0) {
      return [];
    }

    // Build the complete query
    let sql1 = '';
    let sql2 = 'FROM rxnconso';
    let allParams = {};

    let stemIndex = 0;

    // Add non-text filters first
    for (const filter of filterContext.filters) {
      if (!filter.text) {
        sql1 += ' ' + filter.sql;
        Object.assign(allParams, filter.params);
      }
    }

    // Add text search joins and filters
    for (const filter of filterContext.filters) {
      if (filter.text) {
        sql2 += `, rxnstems as s${stemIndex}`;
        const stemSql = filter.sql.replace(/s\d+/g, `s${stemIndex}`);
        sql1 += ' ' + stemSql;

        // Update parameter keys to match stem index
        for (const [key, value] of Object.entries(filter.params)) {
          const newKey = key.replace(/\d+/, stemIndex.toString());
          allParams[newKey] = value;
        }
        stemIndex++;
      }
    }

    const fullQuery = `SELECT ${this.getCodeField()}, STR, SUPPRESS ${sql2} WHERE SAB = $sab AND TTY <> 'SY' ${sql1} ORDER BY ${this.getCodeField()}`;
    allParams.sab = this.getSAB();

    // Create a single filter holder with the combined query
    const combinedFilter = new RxNormFilterHolder();
    combinedFilter.sql = fullQuery;
    combinedFilter.params = allParams;

    return [combinedFilter];
  }

  async filterSize(filterContext, set) {
    

    if (!set.executed) {
      await this.#executeFilter(set);
    }

    return set.results ? set.results.length : 0;
  }

  async filterMore(filterContext, set) {
    

    if (!set.executed) {
      await this.#executeFilter(set);
    }

    return set.cursor < (set.results ? set.results.length : 0);
  }

  async filterConcept(filterContext, set) {
    

    if (!set.executed) {
      await this.#executeFilter(set);
    }

    if (set.cursor >= set.results.length) {
      return null;
    }

    const row = set.results[set.cursor];
    set.cursor++;

    const concept = new RxNormConcept(row[this.getCodeField()], row.STR);
    return concept;
  }

  async filterLocate(filterContext, set, code) {
    

    return new Promise((resolve, reject) => {
      // Build query to check if code exists in filter
      const checkQuery = `SELECT ${this.getCodeField()}, STR FROM rxnconso WHERE SAB = $sab AND TTY <> 'SY' AND ${this.getCodeField()} = $code ${set.sql.replace(/SELECT.*?FROM rxnconso/, '').replace(/WHERE SAB = \$sab AND TTY <> 'SY'/, '')}`;

      const params = { ...set.params, code };

      this.db.get(checkQuery, this.#buildParamArray(checkQuery, params), (err, row) => {
        if (err) {
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          const concept = new RxNormConcept(row[this.getCodeField()], row.STR);
          resolve(concept);
        }
      });
    });
  }

  async filterCheck(filterContext, set, concept) {
    

    if (!(concept instanceof RxNormConcept)) {
      return false;
    }

    if (!set.executed) {
      await this.#executeFilter(set);
    }

    return set.results.some(row => row[this.getCodeField()] === concept.code);
  }

  async #executeFilter(filter) {
    return new Promise((resolve, reject) => {
      const paramArray = this.#buildParamArray(filter.sql, filter.params);

      this.db.all(filter.sql, paramArray, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          filter.results = rows;
          filter.executed = true;
          resolve();
        }
      });
    });
  }

  // Helper method to build parameter arrays for sqlite3
  #buildParamArray(sql, params) {
    const paramArray = [];
    const paramOrder = [];

    // Extract parameter names from SQL in order
    const paramMatches = sql.match(/\$\w+/g) || [];
    paramMatches.forEach(match => {
      const paramName = match.substring(1); // Remove $
      if (!paramOrder.includes(paramName)) {
        paramOrder.push(paramName);
      }
    });

    // Build array in correct order
    paramOrder.forEach(paramName => {
      if (Object.prototype.hasOwnProperty.call(params, paramName)) {
        paramArray.push(params[paramName]);
      }
    });

    return paramArray;
  }

  #sqlWrapString(str) {
    return str.replace(/'/g, "''");
  }

  // --- expandForValueSet: single-query expansion for ValueSet operations ---

  #getSyncDb() {
    if (!this._syncDb) {
      if (!BetterSqlite3 || !this.dbPath) return null;
      this._syncDb = new BetterSqlite3(this.dbPath, { readonly: true });
    }
    return this._syncDb;
  }

  /**
   * Build SQL WHERE fragments from a spec's filter array.
   * Returns { sql, params } or null if unsupported filter encountered.
   */
  #buildFilterSql(filters, paramPrefix) {
    let sql = '';
    let joins = '';
    const params = {};
    const codeField = this.getCodeField();
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      const prop = f.property.toUpperCase();
      const pfx = `${paramPrefix}_f${i}`;

      if (f.op === '=' && prop === 'TTY') {
        sql += ` AND rxnconso.TTY = @${pfx}_tty`;
        params[`${pfx}_tty`] = f.value;
      } else if (f.op === 'in' && prop === 'TTY') {
        const values = f.value.split(',').map(v => v.trim()).filter(v => v);
        const placeholders = values.map((_, j) => `@${pfx}_tty${j}`).join(',');
        sql += ` AND rxnconso.TTY IN (${placeholders})`;
        values.forEach((val, j) => { params[`${pfx}_tty${j}`] = val; });
      } else if (f.op === '=' && prop === 'STY') {
        const alias = `_sty${pfx}`;
        joins += ` JOIN rxnsty ${alias} ON ${alias}.RXCUI = rxnconso.${codeField} AND ${alias}.TUI = @${pfx}_sty`;
        params[`${pfx}_sty`] = f.value;
      } else if (f.op === '=' && prop === 'SAB') {
        sql += ` AND rxnconso.${codeField} IN (SELECT ${codeField} FROM rxnconso WHERE SAB = @${pfx}_sab)`;
        params[`${pfx}_sab`] = f.value;
      } else {
        return null; // Unsupported filter — fall back
      }
    }
    return { sql, joins, params, needsGroupBy: joins.length > 0 };
  }

  /**
   * Build a NOT EXISTS WHERE clause for an exclude filter group.
   * Multiple filters on the same exclude are conjunctive (AND) — exclude only
   * codes matching ALL filters. Uses a single correlated subquery.
   */
  #buildExcludeWhereSql(filters, paramPrefix, codeField) {
    const params = {};
    const outerRef = `t.${codeField}`;

    // Categorize filters by which table they need
    const ttyFilters = [];  // need rxnconso
    const styFilters = [];  // need rxnsty only
    const otherFilters = []; // need rxnconso (SAB etc)

    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      const prop = f.property.toUpperCase();
      const pfx = `${paramPrefix}_f${i}`;

      if ((f.op === '=' || f.op === 'in') && prop === 'TTY') {
        ttyFilters.push({ f, pfx });
      } else if (f.op === '=' && prop === 'STY') {
        styFilters.push({ f, pfx });
      } else if (f.op === '=' && prop === 'SAB') {
        otherFilters.push({ f, pfx });
      } else {
        return null; // Unsupported filter
      }
    }

    // STY-only: correlate directly against rxnsty (no rxnconso scan)
    if (styFilters.length > 0 && ttyFilters.length === 0 && otherFilters.length === 0) {
      const conditions = styFilters.map(({ f, pfx }) => {
        params[`${pfx}_sty`] = f.value;
        return `NOT EXISTS (SELECT 1 FROM rxnsty _sty${pfx}`
          + ` WHERE _sty${pfx}.RXCUI = ${outerRef} AND _sty${pfx}.TUI = @${pfx}_sty)`;
      });
      return { sql: conditions.join(' AND '), params };
    }

    // TTY-only (no STY): correlate against rxnconso
    if (ttyFilters.length > 0 && styFilters.length === 0 && otherFilters.length === 0) {
      let where = '';
      for (const { f, pfx } of ttyFilters) {
        if (f.op === '=') {
          where += ` AND _ex.TTY = @${pfx}_tty`;
          params[`${pfx}_tty`] = f.value;
        } else { // op === 'in'
          const values = f.value.split(',').map(v => v.trim()).filter(v => v);
          const placeholders = values.map((_, j) => `@${pfx}_tty${j}`).join(',');
          where += ` AND _ex.TTY IN (${placeholders})`;
          values.forEach((val, j) => { params[`${pfx}_tty${j}`] = val; });
        }
      }
      const sql = `NOT EXISTS (SELECT 1 FROM rxnconso _ex INDEXED BY X_RXNCONSO_1`
        + ` WHERE _ex.${codeField} = ${outerRef} AND _ex.SAB = @_sab${where})`;
      return { sql, params };
    }

    // Mixed filters: need rxnconso with JOINs — build carefully
    let where = '';
    let joins = '';
    for (const { f, pfx } of ttyFilters) {
      if (f.op === '=') {
        where += ` AND _ex.TTY = @${pfx}_tty`;
        params[`${pfx}_tty`] = f.value;
      } else {
        const values = f.value.split(',').map(v => v.trim()).filter(v => v);
        const placeholders = values.map((_, j) => `@${pfx}_tty${j}`).join(',');
        where += ` AND _ex.TTY IN (${placeholders})`;
        values.forEach((val, j) => { params[`${pfx}_tty${j}`] = val; });
      }
    }
    for (const { f, pfx } of styFilters) {
      joins += ` JOIN rxnsty _sty${pfx} ON _sty${pfx}.RXCUI = _ex.${codeField} AND _sty${pfx}.TUI = @${pfx}_sty`;
      params[`${pfx}_sty`] = f.value;
    }
    for (const { f, pfx } of otherFilters) {
      where += ` AND _ex.${codeField} IN (SELECT ${codeField} FROM rxnconso WHERE SAB = @${pfx}_sab)`;
      params[`${pfx}_sab`] = f.value;
    }
    const sql = `NOT EXISTS (SELECT 1 FROM rxnconso _ex INDEXED BY X_RXNCONSO_1${joins}`
      + ` WHERE _ex.${codeField} = ${outerRef} AND _ex.SAB = @_sab AND _ex.TTY <> 'SY'${where})`;
    return { sql, params };
  }
  async expandForValueSet(spec) {
    // Bypass flag: set RxNormServices.bypassExpandForValueSet = true to skip
    if (RxNormServices.bypassExpandForValueSet) return null;

    const syncDb = this.#getSyncDb();
    if (!syncDb) return null;

    const codeField = this.getCodeField();
    const sab = this.getSAB();
    const sys = this.system();
    const ver = this.version();

    // Build each include/exclude as a SELECT, combine with UNION/EXCEPT.
    // Archive fallback for retired concept codes is folded into the SQL via
    // UNION against RXNATOMARCHIVE — no JS-side tracking needed.
    const selectParts = [];
    const allParams = { _sab: sab };

    // Collect all included concept code placeholders for archive UNION
    const conceptPlaceholders = [];

    const baseCols = `rxnconso.${codeField}, rxnconso.STR, rxnconso.SUPPRESS`;

    for (let i = 0; i < spec.includes.length; i++) {
      const inc = spec.includes[i];
      if (inc.concepts && inc.concepts.length > 0) {
        const placeholders = inc.concepts.map((_, j) => `@_ic${i}_${j}`).join(',');
        const indexHint = ' INDEXED BY X_RXNCONSO_1';
        selectParts.push(`SELECT ${baseCols} FROM rxnconso${indexHint} WHERE rxnconso.SAB = @_sab AND rxnconso.TTY <> 'SY' AND rxnconso.${codeField} IN (${placeholders})`);
        inc.concepts.forEach((cc, j) => {
          allParams[`_ic${i}_${j}`] = cc.code;
          conceptPlaceholders.push(`@_ic${i}_${j}`);
        });
      } else if (inc.filters && inc.filters.length > 0) {
        const result = this.#buildFilterSql(inc.filters, `_i${i}`);
        if (!result) return null;
        selectParts.push(`SELECT ${baseCols} FROM rxnconso${result.joins || ''} WHERE rxnconso.SAB = @_sab AND rxnconso.TTY <> 'SY'${result.sql}`);
        Object.assign(allParams, result.params);
      } else {
        return null; // Bare "whole code system" — fall back
      }
    }

    if (selectParts.length === 0) return null;

    // Archive fallback: concept codes not in rxnconso may be retired.
    // UNION them in from RXNATOMARCHIVE so SQL handles it in one pass.
    // Index hints ensure RXCUI-based lookups instead of partial scans.
    if (conceptPlaceholders.length > 0) {
      const archIn = conceptPlaceholders.join(',');
      selectParts.push(
        `SELECT a.${codeField}, a.STR, '1' AS SUPPRESS FROM RXNATOMARCHIVE a INDEXED BY idx_rxnatomarchive_rxcui_sab`
        + ` WHERE a.${codeField} IN (${archIn}) AND a.SAB = @_sab AND a.TTY <> 'SY'`
        + ` AND NOT EXISTS (SELECT 1 FROM rxnconso c INDEXED BY X_RXNCONSO_1 WHERE c.${codeField} = a.${codeField} AND c.SAB = @_sab AND c.TTY <> 'SY')`
        + ` GROUP BY a.${codeField}`
      );
    }

    // Combine includes (+ archive) with UNION
    let sql = selectParts.length === 1
      ? selectParts[0]
      : selectParts.join(' UNION ');

    // Build excludes as WHERE conditions on the outer query.
    // Using NOT EXISTS instead of EXCEPT lets SQLite short-circuit
    // with LIMIT — it doesn't need to materialize the full exclude set.
    const excludeWhere = [];
    for (let i = 0; i < spec.excludes.length; i++) {
      const exc = spec.excludes[i];
      if (exc.concepts && exc.concepts.length > 0) {
        const placeholders = exc.concepts.map((_, j) => `@_ec${i}_${j}`).join(',');
        excludeWhere.push(`${codeField} NOT IN (${placeholders})`);
        exc.concepts.forEach((cc, j) => { allParams[`_ec${i}_${j}`] = cc.code; });
      } else if (exc.filters && exc.filters.length > 0) {
        const result = this.#buildExcludeWhereSql(exc.filters, `_e${i}`, codeField);
        if (!result) continue; // Can't push — worker's isExcluded will handle
        excludeWhere.push(result.sql);
        Object.assign(allParams, result.params);
      }
    }

    // activeOnly
    let activeSql = '';
    if (spec.activeOnly) {
      activeSql = ` AND SUPPRESS <> '1'`;
    }

    // searchText (basic LIKE match on STR)
    if (spec.searchText) {
      activeSql += ` AND STR LIKE @_searchText`;
      allParams._searchText = `%${spec.searchText}%`;
    }

    // Wrap with outer query for ordering, filtering, paging
    const excludeSql = excludeWhere.length > 0 ? ' AND ' + excludeWhere.join(' AND ') : '';
    sql = `SELECT ${codeField}, STR, SUPPRESS FROM (${sql}) AS t WHERE 1=1${activeSql}${excludeSql} ORDER BY ${codeField}`;

    // Paging — SQL handles offset directly so the framework doesn't re-skip
    if (spec.count != null && spec.count > 0) {
      const limit = spec.count;
      const offset = (spec.offset != null && spec.offset > 0) ? spec.offset : 0;
      sql += ` LIMIT ${limit} OFFSET ${offset}`;
    }

    // Return a generator backed by better-sqlite3's lazy cursor
    const self = this;
    return (function* () {
      const stmt = syncDb.prepare(sql);
      const seen = new Set();
      for (const row of stmt.iterate(allParams)) {
        const code = row[codeField];
        if (seen.has(code)) continue;
        seen.add(code);
        const isArchived = row.SUPPRESS === '1';
        yield {
          code,
          display: row.STR,
          system: sys,
          version: ver,
          isAbstract: false,
          isInactive: isArchived,
          isDeprecated: false,
          status: isArchived ? 'inactive' : 'active',
          definition: null,
          designations: [],
          properties: null,
          extensions: null,
        };
      }
    })();
  }

  // Subsumption testing
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    return 'not-subsumed'; // Not implemented yet
  }

  // Extension for lookup operation
  async extendLookup(ctxt, props, params) {
    validateArrayParameter(props, 'props', String);
    validateArrayParameter(params, 'params', Object);


    if (typeof ctxt === 'string') {
      const located = await this.locate(ctxt);
      if (!located.context) {
        throw new Error(located.message);
      }
      ctxt = located.context;
    }

    if (!(ctxt instanceof RxNormConcept)) {
      throw new Error('Invalid context for RxNorm lookup');
    }

    // Set abstract status
    params.abstract = false;

    // Add designations
    const designations =  new Designations(this.opContext.i18n.languageDefinitions);
    await this.designations(ctxt, designations);
    for (const designation of designations) {
      this.#addProperty(params, 'designation', 'display', designation.value, designation.language);
    }
  }

  #addProperty(params, type, name, value, language = null) {
    if (!params.parameter) {
      params.parameter = [];
    }

    const property = {
      name: type,
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueString: value }
      ]
    };

    if (language) {
      property.part.push({ name: 'language', valueCode: language });
    }

    params.parameter.push(property);
  }

  versionAlgorithm() {
    return 'date';
  }
}

class RxNormTypeServicesFactory extends CodeSystemFactoryProvider {
  constructor(i18n, dbPath, isNCI = false) {
    super(i18n);
    this.dbPath = dbPath;
    this.isNCI = isNCI;
    this._loaded = false;
    this._sharedData = null;
  }

  system() {
    return this.isNCI ? 'http://ncimeta.nci.nih.gov' : 'http://www.nlm.nih.gov/research/umls/rxnorm';
  }

  version() {
    return this._sharedData.version;
  }

  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  async #ensureLoaded() {
    if (!this._loaded) {
      await this.load();
    }
  }

  async load() {
    const db = new sqlite3.Database(this.dbPath);

    try {
      this._sharedData = {
        version: '',
        rels: [],
        reltypes: [],
        totalCodeCount: 0
      };

      // Load version
      this._sharedData.version = await this.#readVersion(db);

      // Load relationship types
      this._sharedData.rels = await this.#loadList(db, 'SELECT DISTINCT REL FROM RXNREL');

      // Load relationship attributes
      this._sharedData.reltypes = await this.#loadList(db, 'SELECT DISTINCT RELA FROM RXNREL');

      // Get total count
      const sab = this.isNCI ? 'NCI' : 'RXNORM';
      this._sharedData.totalCodeCount = await this.#getCount(db, `SELECT COUNT(RXCUI) FROM rxnconso WHERE SAB = ? AND TTY <> 'SY'`, [sab]);

    } finally {
      db.close();
    }
    this._loaded = true;
  }

  async #readVersion(db) {
    return new Promise((resolve) => {
      db.get('SELECT version FROM RXNVer', (err, row) => {
        if (err || !row) {
          // Fallback: try to extract version from database path
          const dbDetails = this.dbPath;
          let version = '??';

          if (dbDetails.includes('.db')) {
            let d = dbDetails.substring(0, dbDetails.indexOf('.db'));
            if (d.includes('_')) {
              d = d.substring(d.lastIndexOf('_') + 1);
            }
            if (/^\d+$/.test(d)) {
              version = d;
            }
          }
          resolve(version);
        } else {
          resolve(row.version.toString());
        }
      });
    });
  }

  async #loadList(db, sql) {
    return new Promise((resolve, reject) => {
      db.all(sql, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.map(row => Object.values(row)[0]));
        }
      });
    });
  }

  async #getCount(db, sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? Object.values(row)[0] : 0);
        }
      });
    });
  }

  defaultVersion() {
    return this._sharedData?.version || 'unknown';
  }

  async build(opContext, supplements) {
    await this.#ensureLoaded();
    this.recordUse();

    // Create fresh database connection for this provider instance
    const db = new sqlite3.Database(this.dbPath);

    return new RxNormServices(opContext, supplements, db, this._sharedData, this.isNCI, this.dbPath);
  }

  name() {
    return this.isNCI ? 'NCI' : 'RxNorm';
  }

  id() {
    return this.name();
  }

}

// Specific RxNorm implementation
class RxNormServicesFactory extends RxNormTypeServicesFactory {
  constructor(languageDefinitions, dbPath) {
    super(languageDefinitions, dbPath, false);
  }
}

// NCI Meta implementation
class NCIServicesFactory extends RxNormTypeServicesFactory {
  constructor(languageDefinitions, dbPath) {
    super(languageDefinitions, dbPath, true);
  }
}

module.exports = {
  RxNormServices,
  RxNormServicesFactory,
  NCIServicesFactory,
  RxNormConcept
};