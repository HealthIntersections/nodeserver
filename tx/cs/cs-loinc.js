const sqlite3 = require('sqlite3').verbose();
let BetterSqlite3;
try { BetterSqlite3 = require('better-sqlite3'); } catch (e) { /* optional */ }
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const { Language, Languages} = require('../../library/languages');
const { CodeSystemFactoryProvider} = require('./cs-api');
const { validateOptionalParameter, validateArrayParameter} = require("../../library/utilities");
const {BaseCSServices} = require("./cs-base");

// Context kinds matching Pascal enum
const LoincProviderContextKind = {
  CODE: 0,    // lpckCode
  PART: 1,    // lpckPart
  LIST: 2,    // lpckList
  ANSWER: 3   // lpckAnswer
};

const classTypes = {
  '1': 'Laboratory class',
  '2': 'Clinical class',
  '3': 'Claims attachments',
  '4': 'Surveys',
  'Laboratory class' : '1',
  'Clinical class' : '2',
  'Claims attachments' : '3',
  'Surveys' : '4'
};

class DescriptionCacheEntry {
  constructor(display, lang, value, dtype) {
    this.display = display;
    this.lang = lang;
    this.value = value;
    this.dtype = dtype;
  }
}

class LoincProviderContext {
  constructor(key, kind, code, desc, status) {
    this.key = key;
    this.kind = kind;
    this.code = code;
    this.desc = desc;
    this.status = status;
    this.displays = []; // Array of DescriptionCacheEntry
    this.children = null; // Will be Set of keys if this has children
  }

  addChild(key) {
    if (!this.children) {
      this.children = [];
    }
    this.children.push(key);
  }
}

class LoincDisplay {
  constructor(language, value) {
    this.language = language;
    this.value = value;
  }
}

class LoincIteratorContext {
  constructor(context, keys) {
    this.context = context;
    this.keys = keys || [];
    this.current = 0;
    this.total = this.keys.length;
  }

  more() {
    return this.current < this.total;
  }

  next() {
    this.current++;
  }
}

class LoincFilterHolder {
  constructor() {
    this.keys = [];
    this.cursor = 0;
    this.lsql = '';
  }

  hasKey(key) {
    // Binary search since keys should be sorted
    let l = 0;
    let r = this.keys.length - 1;
    while (l <= r) {
      const m = Math.floor((l + r) / 2);
      if (this.keys[m] < key) {
        l = m + 1;
      } else if (this.keys[m] > key) {
        r = m - 1;
      } else {
        return true;
      }
    }
    return false;
  }
}

class LoincPrep {
  constructor() {
    this.filters = [];
  }
}

class LoincServices extends BaseCSServices {
  constructor(opContext, supplements, db, sharedData, dbPath = null) {
    super(opContext, supplements);
    this.db = db;
    this.dbPath = dbPath;
    this._syncDb = null; // Lazy better-sqlite3 connection

    // Shared data from factory
    this.langs = sharedData.langs;
    this.codes = sharedData.codes;
    this.codeList = sharedData.codeList;
    this.allKeys = sharedData.allKeys;
    this._version = sharedData._version;
    this.root = sharedData.root;
    this.firstCodeKey = sharedData.firstCodeKey;
    this.relationships = sharedData.relationships;
    this.propertyList = sharedData.propertyList;
    this.statusKeys = sharedData.statusKeys;
    this.statusCodes = sharedData.statusCodes;
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
    return 'http://loinc.org';
  }

  version() {
    return this._version;
  }

  name() {
    return 'LOINC';
  }

  description() {
    return 'LOINC';
  }

  async totalCount() {
    return this.codes.size;
  }

  hasParents() {
    return true; // LOINC has hierarchical relationships
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);

    // Check supplements first
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }

    // Check if any requested languages are available in LOINC data
    for (const requestedLang of langs.languages) {
      for (const [loincLangCode] of this.langs) {
        const loincLang = new Language(loincLangCode);
        if (loincLang.matchesForDisplay(requestedLang)) {
          return true;
        }
      }
    }

    return super.hasAnyDisplays(langs);
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

    // Use language-aware display logic
    if (this.opContext.langs && !this.opContext.langs.isEnglishOrNothing()) {
      const displays = await this.#getDisplaysForContext(ctxt, this.opContext.langs);

      // Try to find exact language match
      for (const lang of this.opContext.langs.langs) {
        for (const display of displays) {
          if (lang.matches(display.language, true)) {
            return display.value;
          }
        }
      }

      // Try partial language match
      for (const lang of this.opContext.langs.langs) {
        for (const display of displays) {
          if (lang.matches(display.language, false)) {
            return display.value;
          }
        }
      }
    }

    return ctxt.desc || '';
  }

  async definition(context) {
    await this.#ensureContext(context);
    return null; // LOINC doesn't provide definitions
  }

  async isAbstract(context) {
    await this.#ensureContext(context);
    return false; // LOINC codes are not abstract
  }

  async isInactive(context) {
    await this.#ensureContext(context);
    return context.status == 'DISCOURAGED'; // Handle via status if needed
  }

  async getStatus(context) {
    await this.#ensureContext(context);
    return context.status == 'NotStated' ? null : context.status; // Handle via status if needed
  }

  async isDeprecated(context) {
    await this.#ensureContext(context);
    return false; // Handle via status if needed
  }

  async designations(context, displays) {
    const ctxt = await this.#ensureContext(context);
    if (ctxt) {
      // Add main display
      displays.addDesignation(true, 'active', 'en-US', CodeSystem.makeUseForDisplay(), ctxt.desc.trim());

      // Add cached designations — load into local array then assign atomically.
      // This avoids duplication from concurrent pushes and allows retry if a prior load failed.
      if (ctxt.displays.length === 0) {
        const loaded = await this.#loadDesignationsForContext(ctxt);
        if (ctxt.displays.length === 0) {
          ctxt.displays = loaded;
        }
      }

      for (const entry of ctxt.displays) {
        let use = undefined;
        if (entry.dtype) {
          use = {
            system: 'http://loinc.org',
            code: entry.dtype,
            display: entry.dtype
          }
        }
        if (!use) {
          use = entry.display ? CodeSystem.makeUseForDisplay() : null;
        }
        displays.addDesignation(false, 'active', entry.lang, use, entry.value.trim());
      }

      // Add supplement designations
      this._listSupplementDesignations(ctxt.code, displays);
    }

  }

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

    if (!(ctxt instanceof LoincProviderContext)) {
      throw new Error('Invalid context for LOINC lookup');
    }

    // Run all property queries in parallel — they're independent reads on the same key
    await Promise.all([
      this.#addRelationshipProperties(ctxt, props, params),
      this.#addConceptProperties(ctxt, props,params),
      this.#addStatusProperty(ctxt, props,params),
      this.#addRelatedNames(ctxt, props,params)
    ]);
  }

  #getDesignationUse(kind) {
    switch (kind) {
      case LoincProviderContextKind.CODE:
        return 'LONG_COMMON_NAME';
      case LoincProviderContextKind.PART:
        return 'PartDisplayName';
      default:
        return 'LONG_COMMON_NAME';
    }
  }

  async #addRelationshipProperties(ctxt, props, params) {
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT RelationshipTypes.Description as Relationship, Codes.Code, Codes.Description as Value
          FROM Relationships, RelationshipTypes, Codes
          WHERE Relationships.SourceKey = ?
            AND Relationships.RelationshipTypeKey = RelationshipTypes.RelationshipTypeKey
            AND Relationships.TargetKey = Codes.CodeKey
      `;

      this.db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            if (this._hasProp(props, row.Relationship, true)) {
              this._addCodeProperty(params, 'property', row.Relationship, row.Code);
            }
          }
          resolve();
        }
      });
    });
  }

  async #addConceptProperties(ctxt, props, params) {
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT PropertyTypes.Description, PropertyValues.Value
          FROM Properties, PropertyTypes, PropertyValues
          WHERE Properties.CodeKey = ?
            AND Properties.PropertyTypeKey = PropertyTypes.PropertyTypeKey
            AND Properties.PropertyValueKey = PropertyValues.PropertyValueKey
      `;

      this.db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            if (this._hasProp(props, row.Description, true)) {
              if (row.Description == 'CLASSTYPE') {
                this._addStringProperty(params, 'property', row.Description, classTypes[row.Value])
                  .part.push({name: 'description', valueString: row.Value});
              } else {
                this._addStringProperty(params, 'property', row.Description, row.Value);
              }
            }
          }
          resolve();
        }
      });
    });
  }

  async #addStatusProperty(ctxt, props, params) {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT StatusKey FROM Codes WHERE CodeKey = ? AND StatusKey != 0';

      this.db.get(sql, [ctxt.key], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          const statusDesc = this.statusCodes.get(row.StatusKey.toString());
          if (row.StatusKey && statusDesc) {
            if (this._hasProp(props, 'STATUS', true)) {
              this._addStringProperty(params, 'property', 'STATUS', statusDesc);
            }
          }
          resolve();
        } else {
          resolve();
        }
      });
    });
  }

  async #addRelatedNames(ctxt, props, params) {
    const loaded = await this.#loadRelatedNames(ctxt);
    for (let d of loaded) {
      if (this._hasProp(props, 'RELATEDNAMES2', true)) {
        this._addProperty(params, 'property', 'RELATEDNAMES2', d.value, d.lang);
      }
    }
  }

  async #addAllDesignations(ctxt, props, params) {
    if (!this._hasProp(props, 'designation', true)) {
      return;
    }

    return new Promise((resolve, reject) => {
      const sql = `
          SELECT Languages.Code as Lang, DescriptionTypes.Description as DType, Descriptions.Value
          FROM Descriptions, Languages, DescriptionTypes
          WHERE Descriptions.CodeKey = ?
            AND Descriptions.DescriptionTypeKey != 4 
          AND Descriptions.DescriptionTypeKey = DescriptionTypes.DescriptionTypeKey 
          AND Descriptions.LanguageKey = Languages.LanguageKey
      `;

      this.db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            this._addProperty(params, 'designation', row.dtype, row.value, row.lang);
          }
          resolve();
        }
      });
    });
  }

  async #getDisplaysForContext(ctxt, langs) {
    validateOptionalParameter(langs, "langs", Languages);
    const displays = [new LoincDisplay('en-US', ctxt.desc)];

    return new Promise((resolve, reject) => {
      const sql = `
          SELECT Languages.Code as Lang, Descriptions.Value
          FROM Descriptions, Languages
          WHERE Descriptions.CodeKey = ?
            AND Descriptions.DescriptionTypeKey IN (1,2,5)
            AND Descriptions.LanguageKey = Languages.LanguageKey
          ORDER BY DescriptionTypeKey
      `;

      this.db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            displays.push(new LoincDisplay(row.Lang, row.Value));
          }

          // Add supplement displays
          this.#addSupplementDisplays(displays, ctxt.code);

          resolve(displays);
        }
      });
    });
  }

  #addSupplementDisplays(displays, code) {
    if (this.supplements) {
      for (const supplement of this.supplements) {
        const concept = supplement.getConceptByCode(code);
        if (concept) {
          if (concept.display) {
            displays.push(new LoincDisplay(supplement.jsonObj.language || 'en', concept.display));
          }
          if (concept.designation) {
            for (const designation of concept.designation) {
              const lang = designation.language || supplement.jsonObj.language || 'en';
              displays.push(new LoincDisplay(lang, designation.value));
            }
          }
        }
      }
    }
  }

  async #loadDesignationsForContext(ctxt) {
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT Languages.Code as Lang, DescriptionTypes.Description as DType, Descriptions.Value
          FROM Descriptions, Languages, DescriptionTypes
          WHERE Descriptions.CodeKey = ?
            AND Descriptions.DescriptionTypeKey != 4
            AND Descriptions.DescriptionTypeKey = DescriptionTypes.DescriptionTypeKey
            AND Descriptions.LanguageKey = Languages.LanguageKey
      `;

      this.db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const results = [];
          for (const row of rows) {
            const isDisplay = row.DType === 'LONG_COMMON_NAME';
            results.push(new DescriptionCacheEntry(isDisplay, row.Lang, row.Value, row.DType));
          }
          resolve(results);
        }
      });
    });
  }

  async #loadRelatedNames(ctxt) {
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT Languages.Code as Lang, Descriptions.Value
          FROM Descriptions, Languages
          WHERE Descriptions.CodeKey = ?
            AND Descriptions.DescriptionTypeKey = 4
            AND Descriptions.LanguageKey = Languages.LanguageKey
      `;

      this.db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const results = [];
          for (const row of rows) {
            results.push(new DescriptionCacheEntry(false, row.Lang, row.Value, 'RELATEDNAMES2'));
          }
          resolve(results);
        }
      });
    });
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
    if (context instanceof LoincProviderContext) {
      return context;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof context));
  }

  // Lookup methods
  async locate(code) {

    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const context = this.codes.get(code);
    if (context) {
      return { context: context, message: null };
    }

    return { context: null, message: undefined };
  }

  async locateMany(codes, allAltCodes = false) {
    const results = new Map();
    for (const code of codes) {
      const context = this.codes.get(code);
      results.set(code, context ? { context, message: null } : { context: null, message: undefined });
    }
    return results;
  }

  // Iterator methods
  async iterator(context) {


    if (!context) {
      // Iterate all codes starting from first code
      return new LoincIteratorContext(null, this.allKeys);
    } else {
      const ctxt = await this.#ensureContext(context);
      if (ctxt.kind === LoincProviderContextKind.PART && ctxt.children) {
        return new LoincIteratorContext(ctxt, ctxt.children);
      } else {
        return new LoincIteratorContext(ctxt, []);
      }
    }
  }

  async nextContext(iteratorContext) {


    if (!iteratorContext.more()) {
      return null;
    }

    const key = iteratorContext.keys[iteratorContext.current];
    iteratorContext.next();

    return this.codeList[key];
  }

  // Filter support
  async doesFilter(prop, op, value) {
    // Relationship filters
    if (this.relationships.has(prop) && ['=', 'in', 'exists', 'regex'].includes(op)) {
      return true;
    }

    // Property filters
    if (this.propertyList.has(prop) && ['=', 'in', 'exists', 'regex'].includes(op)) {
      return true;
    }

    // Status filter
    if (prop === 'STATUS' && op === '=' && this.statusKeys.has(value)) {
      return true;
    }

    // LIST filter
    if (prop === 'LIST' && op === '=' && this.codes.has(value)) {
      return true;
    }

    // CLASSSTYPE filter
    if (prop === 'CLASSTYPE' && op === '=' && ["1", "2", "3", "4"].includes(value)) {
      return true;
    }

    // answers-for filter
    if (prop === 'answers-for' && op === '=') {
      return true;
    }

    // concept filters
    if (prop === 'concept' && ['is-a', 'descendent-of', '=', 'in', 'not-in'].includes(op)) {
      return true;
    }

    // code filters (VSAC workaround)
    if (prop === 'code' && ['is-a', 'descendent-of', '='].includes(op)) {
      return true;
    }

    // copyright filter
    if (prop === 'copyright' && op === '=' && ['LOINC', '3rdParty'].includes(value)) {
      return true;
    }

    return false;
  }

  async getPrepContext(iterate) {
    return new LoincPrep(iterate);
  }

  async filter(filterContext, prop, op, value) {


    const filter = new LoincFilterHolder();
    await this.#executeFilterQuery(prop, op, value, filter);
    filterContext.filters.push(filter);
  }

  async #executeFilterQuery(prop, op, value, filter) {
    let sql = '';
    let lsql = '';

    // LIST filter
    if (prop === 'LIST' && op === '=' && this.codes.has(value)) {
      sql = `SELECT DISTINCT TargetKey as Key FROM Relationships
             WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
               AND SourceKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
             ORDER BY SourceKey ASC`;
      lsql = `SELECT COUNT(DISTINCT TargetKey) FROM Relationships
              WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
                AND SourceKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                AND TargetKey = `;
    }
    // answers-for filter
    else if (prop === 'answers-for' && op === '=') {
      if (value.startsWith('LL')) {
        sql = `SELECT DISTINCT TargetKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
                 AND SourceKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT TargetKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
                  AND SourceKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                  AND TargetKey = `;
      } else {
        sql = `SELECT DISTINCT TargetKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
                 AND SourceKey IN (
                   SELECT SourceKey FROM Relationships
                   WHERE RelationshipTypeKey = ${this.relationships.get('answers-for')}
                 AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                   )
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT TargetKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
                  AND SourceKey IN (SELECT SourceKey FROM Relationships
                                    WHERE RelationshipTypeKey = ${this.relationships.get('answers-for')}
                                      AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}'))
                  AND TargetKey = `;
      }
    }
    // Relationship equal filter
    else if (this.relationships.has(prop) && op === '=') {
      if (this.codes.has(value)) {
        sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                 AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                  AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                  AND SourceKey = `;
      } else {
        sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                 AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Description = '${this.#sqlWrapString(value)}' COLLATE NOCASE)
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                  AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Description = '${this.#sqlWrapString(value)}' COLLATE NOCASE)
                  AND SourceKey = `;
      }
    }
    // Relationship 'in' filter
    else if (this.relationships.has(prop) && op === 'in') {
      const codes = this.#commaListOfCodes(value);
      sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
             WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
               AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code IN (${codes}))
             ORDER BY SourceKey ASC`;
      lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
              WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code IN (${codes}))
                AND SourceKey = `;
    }
    // Relationship 'exists' filter
    else if (this.relationships.has(prop) && op === 'exists') {
      if (this.codes.has(value)) {
        sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                 AND EXISTS (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                  AND EXISTS (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                  AND SourceKey = `;
      } else {
        sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                 AND EXISTS (SELECT CodeKey FROM Codes WHERE Description = '${this.#sqlWrapString(value)}' COLLATE NOCASE)
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                  AND EXISTS (SELECT CodeKey FROM Codes WHERE Description = '${this.#sqlWrapString(value)}' COLLATE NOCASE)
                  AND SourceKey = `;
      }
    }
    // Relationship regex filter
    else if (this.relationships.has(prop) && op === 'regex') {
      const matchingKeys = await this.#findRegexMatches(
        `SELECT CodeKey as Key, Description FROM Codes
         WHERE CodeKey IN (SELECT TargetKey FROM Relationships WHERE RelationshipTypeKey = ${this.relationships.get(prop)})`,
        value,
        'Description'
      );
      if (matchingKeys.length > 0) {
        sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                 AND TargetKey IN (${matchingKeys.join(',')})
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                  AND TargetKey IN (${matchingKeys.join(',')})
                  AND SourceKey = `;
      }
    }
    // Property equal filter (with CLASSTYPE handling)
    else if (this.propertyList.has(prop) && op === '=') {
      let actualValue = value;
      if (prop === 'CLASSTYPE' && ['1', '2', '3', '4'].includes(value)) {
        actualValue = classTypes[value];
      }
      sql = `SELECT DISTINCT CodeKey as Key FROM Properties, PropertyValues
             WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
               AND Properties.PropertyValueKey = PropertyValues.PropertyValueKey
               AND PropertyValues.Value = '${this.#sqlWrapString(actualValue)}' COLLATE NOCASE
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(DISTINCT CodeKey) FROM Properties, PropertyValues
              WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
                AND Properties.PropertyValueKey = PropertyValues.PropertyValueKey
                AND PropertyValues.Value = '${this.#sqlWrapString(actualValue)}' COLLATE NOCASE
                AND CodeKey = `;
    }
    // Property 'in' filter
    else if (this.propertyList.has(prop) && op === 'in') {
      const codes = this.#commaListOfCodes(value);
      sql = `SELECT DISTINCT CodeKey as Key FROM Properties, PropertyValues
             WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
               AND Properties.PropertyValueKey = PropertyValues.PropertyValueKey
               AND PropertyValues.Value IN (${codes}) COLLATE NOCASE
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(DISTINCT CodeKey) FROM Properties, PropertyValues
              WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
                AND Properties.PropertyValueKey = PropertyValues.PropertyValueKey
                AND PropertyValues.Value IN (${codes}) COLLATE NOCASE
                AND CodeKey = `;
    }
    // Property 'exists' filter
    else if (this.propertyList.has(prop) && op === 'exists') {
      sql = `SELECT DISTINCT CodeKey as Key FROM Properties
             WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(CodeKey) FROM Properties
              WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
                AND CodeKey = `;
    }
    // Property regex filter
    else if (this.propertyList.has(prop) && op === 'regex') {
      const matchingKeys = await this.#findRegexMatches(
        `SELECT PropertyValueKey, Value FROM PropertyValues
         WHERE PropertyValueKey IN (SELECT PropertyValueKey FROM Properties WHERE PropertyTypeKey = ${this.propertyList.get(prop)})`,
        value,
        'Value',
        'PropertyValueKey'
      );
      if (matchingKeys.length > 0) {
        sql = `SELECT DISTINCT CodeKey as Key FROM Properties
               WHERE PropertyTypeKey = ${this.propertyList.get(prop)}
                 AND PropertyValueKey IN (${matchingKeys.join(',')})
               ORDER BY CodeKey ASC`;
        lsql = `SELECT COUNT(DISTINCT CodeKey) FROM Properties
                WHERE PropertyTypeKey = ${this.propertyList.get(prop)}
                  AND PropertyValueKey IN (${matchingKeys.join(',')})
                  AND CodeKey = `;
      }
    }
    // Status filter
    else if (prop === 'STATUS' && op === '=' && this.statusKeys.has(value)) {
      sql = `SELECT CodeKey as Key FROM Codes
             WHERE StatusKey = ${this.statusKeys.get(value)}
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(CodeKey) FROM Codes
              WHERE StatusKey = ${this.statusKeys.get(value)}
                AND CodeKey = `;
    }
    // Concept hierarchy filters (is-a, descendent-of)
    else if (prop === 'concept' && ['is-a', 'descendent-of'].includes(op)) {
      sql = `SELECT DescendentKey as Key FROM Closure
             WHERE AncestorKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
             ORDER BY DescendentKey ASC`;
      lsql = `SELECT COUNT(DescendentKey) FROM Closure
              WHERE AncestorKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                AND DescendentKey = `;
    }
    // Concept equal filter (workaround for VSAC misuse)
    else if (prop === 'concept' && op === '=') {
      sql = `SELECT CodeKey as Key FROM Codes
             WHERE Code = '${this.#sqlWrapString(value)}'
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(CodeKey) FROM Codes
              WHERE Code = '${this.#sqlWrapString(value)}'
                AND CodeKey = `;
    }
    // Concept 'in' filter (workaround for VSAC misuse)
    else if (prop === 'concept' && op === 'in') {
      const codes = this.#commaListOfCodes(value);
      sql = `SELECT CodeKey as Key FROM Codes
             WHERE Code IN (${codes})
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(CodeKey) FROM Codes
              WHERE Code IN (${codes})
                AND CodeKey = `;
    }
    // Code property filters (workaround for VSAC misuse)
    else if (prop === 'code' && ['is-a', 'descendent-of'].includes(op)) {
      sql = `SELECT DescendentKey as Key FROM Closure
             WHERE AncestorKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
             ORDER BY DescendentKey ASC`;
      lsql = `SELECT COUNT(DescendentKey) FROM Closure
              WHERE AncestorKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                AND DescendentKey = `;
    }
    else if (prop === 'code' && op === '=') {
      sql = `SELECT CodeKey as Key FROM Codes
             WHERE Code = '${this.#sqlWrapString(value)}'
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(CodeKey) FROM Codes
              WHERE Code = '${this.#sqlWrapString(value)}'
                AND CodeKey = `;
    }
    // Copyright filters
    else if (prop === 'copyright' && op === '=') {
      if (value === 'LOINC') {
        sql = `SELECT CodeKey as Key FROM Codes
               WHERE NOT CodeKey IN (SELECT CodeKey FROM Properties WHERE PropertyTypeKey = 9)
               ORDER BY CodeKey ASC`;
        lsql = `SELECT COUNT(CodeKey) FROM Codes
                WHERE NOT CodeKey IN (SELECT CodeKey FROM Properties WHERE PropertyTypeKey = 9)
                  AND CodeKey = `;
      } else if (value === '3rdParty') {
        sql = `SELECT CodeKey as Key FROM Codes
               WHERE CodeKey IN (SELECT CodeKey FROM Properties WHERE PropertyTypeKey = 9)
               ORDER BY CodeKey ASC`;
        lsql = `SELECT COUNT(CodeKey) FROM Codes
                WHERE CodeKey IN (SELECT CodeKey FROM Properties WHERE PropertyTypeKey = 9)
                  AND CodeKey = `;
      }
    }

    if (sql) {
      await this.#executeSQL(sql, filter);
      filter.lsql = lsql;
    } else {
      throw new Error(`The filter "${prop} ${op} ${value}" is not supported for LOINC`);
    }
  }

// Helper method for regex matching
  async #findRegexMatches(sql, pattern, valueColumn, keyColumn = 'Key') {
    return new Promise((resolve, reject) => {
      const regex = new RegExp(pattern);
      const matchingKeys = [];

      this.db.all(sql, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            if (regex.test(row[valueColumn])) {
              matchingKeys.push(row[keyColumn]);
            }
          }
          resolve(matchingKeys);
        }
      });
    });
  }

// Helper method for comma-separated code lists
  #commaListOfCodes(source) {
    const codes = source.split(',')
      .filter(s => this.codes.has(s.trim()))
      .map(s => `'${this.#sqlWrapString(s.trim())}'`);
    return codes.join(',');
  }

  async #executeSQL(sql, filter) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          filter.keys = rows.map(row => row.Key).filter(key => key !== 0);
          resolve();
        }
      });
    });
  }

  #sqlWrapString(str) {
    return str.replace(/'/g, "''");
  }

  async executeFilters(filterContext) {

    return filterContext.filters;
  }

  async filterSize(filterContext, set) {
    return set.keys.length;
  }

  async filterMore(filterContext, set) {

    set.cursor = set.cursor || 0;
    return set.cursor < set.keys.length;
  }

  async filterConcept(filterContext, set) {


    if (set.cursor >= set.keys.length) {
      return null;
    }

    const key = set.keys[set.cursor];
    set.cursor++;

    return this.codeList[key];
  }

  async filterPage(filterContext, set, count) {
    set.cursor = set.cursor || 0;
    if (set.cursor >= set.keys.length) return [];

    const end = Math.min(set.cursor + count, set.keys.length);
    const results = [];
    for (let i = set.cursor; i < end; i++) {
      results.push(this.codeList[set.keys[i]]);
    }
    set.cursor = end;
    return results;
  }

  async filterLocate(filterContext, set, code) {
    const context = this.codes.get(code);
    if (!context) {
      return `Not a valid code: ${code}`;
    }

    if (!set.lsql) {
      return 'Filter not understood';
    }

    // Check if this context's key is in the filter
    if (set.hasKey(context.key)) {
      return context;
    } else {
      return null; // `Code ${code} is not in the specified filter`;
    }
  }

  async filterCheck(filterContext, set, concept) {
    if (!(concept instanceof LoincProviderContext)) {
      return false;
    }

    return set.hasKey(concept.key);
  }

  // Search filter - placeholder for text search
  // eslint-disable-next-line no-unused-vars
  async searchFilter(filterContext, filter, sort) {

    throw new Error('Text search not implemented yet');
  }

  // Subsumption testing
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);

    return 'not-subsumed'; // Not implemented yet
  }

  versionAlgorithm() {
    return 'natural';
  }

  isDisplay(designation) {
    return designation.use.code == "SHORTNAME" || designation.use.code == "LONG_COMMON_NAME" || designation.use.code == "LinguisticVariantDisplayName";
  }

  #getSyncDb() {
    if (!this._syncDb) {
      if (!BetterSqlite3 || !this.dbPath) return null;
      this._syncDb = new BetterSqlite3(this.dbPath, { readonly: true });
    }
    return this._syncDb;
  }

  /**
   * Build SQL fragments for a single filter {property, op, value}.
   * Returns { where, joins, params } or null if unsupported.
   */
  #buildLoincFilterSql(filter, prefix) {
    const prop = filter.property;
    const op = filter.op;
    const value = filter.value;

    // Relationship-based filters (COMPONENT, CLASS, SYSTEM, SCALE_TYP, METHOD_TYP, TIME_ASPCT, etc.)
    if (this.relationships.has(prop) && op === '=') {
      const relKey = this.relationships.get(prop);
      const ctx = this.codes.get(value);
      if (!ctx) return null;
      const alias = `_rel_${prefix}`;
      return {
        where: '',
        joins: ` JOIN Relationships ${alias} ON ${alias}.SourceKey = c.CodeKey AND ${alias}.RelationshipTypeKey = ${relKey} AND ${alias}.TargetKey = @${prefix}_target`,
        params: { [`${prefix}_target`]: ctx.key },
        needsGroupBy: true
      };
    }

    // LIST filter — answers for an answer list
    if (prop === 'LIST' && op === '=') {
      const ctx = this.codes.get(value);
      if (!ctx) return null;
      const answerRelKey = this.relationships.get('Answer');
      if (!answerRelKey) return null;
      const alias = `_ans_${prefix}`;
      // Answer relationships: SourceKey=AnswerList, TargetKey=Answer code
      // We want the target (answer) codes, so join differently
      return {
        where: '',
        joins: ` JOIN Relationships ${alias} ON ${alias}.TargetKey = c.CodeKey AND ${alias}.RelationshipTypeKey = ${answerRelKey} AND ${alias}.SourceKey = @${prefix}_list`,
        params: { [`${prefix}_list`]: ctx.key },
        needsGroupBy: true
      };
    }

    // STATUS filter
    if (prop === 'STATUS' && op === '=') {
      const statusKey = this.statusKeys.get(value);
      if (statusKey === undefined) return null;
      return {
        where: ` AND c.StatusKey = @${prefix}_status`,
        joins: '',
        params: { [`${prefix}_status`]: parseInt(statusKey) },
        needsGroupBy: false
      };
    }

    // CLASSTYPE property filter
    if (prop === 'CLASSTYPE' && op === '=') {
      const ptKey = this.propertyList.get('CLASSTYPE');
      if (!ptKey) return null;
      // PropertyValues stores the raw value; CLASSTYPE '1' = Laboratory, '2' = Clinical, etc.
      const alias = `_prop_${prefix}`;
      return {
        where: '',
        joins: ` JOIN Properties ${alias} ON ${alias}.CodeKey = c.CodeKey AND ${alias}.PropertyTypeKey = ${ptKey}`
             + ` JOIN PropertyValues ${alias}_pv ON ${alias}_pv.PropertyValueKey = ${alias}.PropertyValueKey AND ${alias}_pv.Value = @${prefix}_pval`,
        params: { [`${prefix}_pval`]: classTypes[value] || value },
        needsGroupBy: true
      };
    }

    // Unsupported filter — fall back
    return null;
  }

  async expandForValueSet(spec) {
    if (LoincServices.bypassExpandForValueSet) return null;

    const syncDb = this.#getSyncDb();
    if (!syncDb) return null;

    const sys = this.system();
    const ver = this.version();
    const allParams = {};
    const conceptCodes = new Set();

    // Build a separate SELECT for each include, UNION ALL them
    const selectParts = [];

    for (let i = 0; i < spec.includes.length; i++) {
      const inc = spec.includes[i];

      if (inc.concepts && inc.concepts.length > 0) {
        // Explicit code list — no Type restriction (concepts can be any type)
        const placeholders = inc.concepts.map((_, j) => `@_ic${i}_${j}`).join(',');
        selectParts.push(`SELECT c.CodeKey, c.Code, c.Description, c.StatusKey FROM Codes c WHERE c.Code IN (${placeholders})`);
        inc.concepts.forEach((cc, j) => {
          allParams[`_ic${i}_${j}`] = cc.code;
          conceptCodes.add(cc.code);
        });
      } else if (inc.filters && inc.filters.length > 0) {
        // Filter-based — each include is an independent SELECT with its own JOINs
        let joins = '';
        let where = '';
        let needsGroupBy = false;

        for (let j = 0; j < inc.filters.length; j++) {
          const result = this.#buildLoincFilterSql(inc.filters[j], `i${i}f${j}`);
          if (!result) return null; // Unsupported filter — fall back entirely
          where += result.where;
          if (result.joins) joins += result.joins;
          if (result.needsGroupBy) needsGroupBy = true;
          Object.assign(allParams, result.params);
        }

        // Relationship JOINs naturally scope to the correct code types
        // (e.g., COMPONENT relationship only links from Type=1 LOINC codes).
        // No explicit Type filter needed — the data model handles it.
        let typeSql = '';

        const groupBy = needsGroupBy ? ' GROUP BY c.CodeKey' : '';
        selectParts.push(`SELECT c.CodeKey, c.Code, c.Description, c.StatusKey FROM Codes c${joins} WHERE 1=1${where}${typeSql}${groupBy}`);
      } else {
        return null; // Bare "whole code system" — fall back
      }
    }

    if (selectParts.length === 0) return null;

    // Build excludes — each becomes an EXCEPT SELECT
    const excludeParts = [];
    for (let i = 0; i < spec.excludes.length; i++) {
      const exc = spec.excludes[i];
      if (exc.concepts && exc.concepts.length > 0) {
        const placeholders = exc.concepts.map((_, j) => `@_ec${i}_${j}`).join(',');
        excludeParts.push(`SELECT c.CodeKey, c.Code, c.Description, c.StatusKey FROM Codes c WHERE c.Code IN (${placeholders})`);
        exc.concepts.forEach((cc, j) => { allParams[`_ec${i}_${j}`] = cc.code; });
      } else if (exc.filters && exc.filters.length > 0) {
        let exJoins = '';
        let exWhere = '';
        let exGroupBy = false;
        for (let j = 0; j < exc.filters.length; j++) {
          const result = this.#buildLoincFilterSql(exc.filters[j], `e${i}f${j}`);
          if (!result) return null; // Unsupported exclude filter — fall back entirely
          exWhere += result.where;
          if (result.joins) exJoins += result.joins;
          if (result.needsGroupBy) exGroupBy = true;
          Object.assign(allParams, result.params);
        }
        if (exWhere || exJoins) {
          const gb = exGroupBy ? ' GROUP BY c.CodeKey' : '';
          excludeParts.push(`SELECT c.CodeKey, c.Code, c.Description, c.StatusKey FROM Codes c${exJoins} WHERE 1=1${exWhere}${gb}`);
        }
      }
    }

    // activeOnly — exclude DEPRECATED (2) and DISCOURAGED (4) status codes
    let activeSql = '';
    if (spec.activeOnly) {
      const depKey = this.statusKeys.get('DEPRECATED');
      const discKey = this.statusKeys.get('DISCOURAGED');
      const excludeKeys = [depKey, discKey].filter(k => k !== undefined).map(k => parseInt(k));
      if (excludeKeys.length > 0) {
        activeSql = ` AND StatusKey NOT IN (${excludeKeys.join(',')})`;
      }
    }

    // searchText
    if (spec.searchText) {
      activeSql += ` AND Description LIKE @_searchText COLLATE NOCASE`;
      allParams._searchText = `%${spec.searchText}%`;
    }

    // Combine includes with UNION, excludes with EXCEPT
    let inner = selectParts.length === 1
      ? selectParts[0]
      : selectParts.join(' UNION ');
    for (const ep of excludeParts) {
      inner += ' EXCEPT ' + ep;
    }

    let sql = `SELECT CodeKey, Code, Description, StatusKey FROM (${inner})`
      + ` WHERE 1=1`
      + activeSql
      + ` GROUP BY Code`
      + ` ORDER BY CodeKey`;

    // Paging
    if (spec.count != null && spec.count > 0) {
      const limit = spec.count;
      const offset = (spec.offset != null && spec.offset > 0) ? spec.offset : 0;
      sql += ` LIMIT ${limit} OFFSET ${offset}`;
    }

    const self = this;
    return (function* () {
      const stmt = syncDb.prepare(sql);
      for (const row of stmt.iterate(allParams)) {
        const statusDesc = self.statusCodes.get(row.StatusKey.toString());
        yield {
          code: row.Code,
          display: row.Description,
          system: sys,
          version: ver,
          isAbstract: false,
          isInactive: statusDesc === 'DISCOURAGED',
          isDeprecated: statusDesc === 'DEPRECATED',
          status: statusDesc === 'NotStated' ? null : statusDesc,
          definition: null,
          designations: [],
          properties: null,
          extensions: null,
        };
      }
    })();
  }
}

class LoincServicesFactory extends CodeSystemFactoryProvider {
  constructor(i18n, dbPath) {
    super(i18n);
    this.dbPath = dbPath;
    this.uses = 0;
    this._loaded = false;
    this._sharedData = null;
  }

  system() {
    return 'http://loinc.org';
  }

  version() {
    return this._sharedData._version;
  }

  name() {
    return 'LOINC';
  }

  async #ensureLoaded() {
    if (!this._loaded) {
      await this.load();
    }
  }

  async load() {
    const db = new sqlite3.Database(this.dbPath);

    // Enable performance optimizations
    await this.#optimizeDatabase(db);

    try {
      this._sharedData = {
        langs: new Map(),
        codes: new Map(),
        codeList: [null],
        allKeys: [],
        relationships: new Map(),
        propertyList: new Map(),
        statusKeys: new Map(),
        statusCodes: new Map(),
        _version: '',
        root: '',
        firstCodeKey: 0
      };

      // Load small lookup tables in parallel
      // eslint-disable-next-line no-unused-vars
      const [langs, statusCodes, relationships, propertyList, config] = await Promise.all([
        this.#loadLanguages(db),
        this.#loadStatusCodes(db),
        this.#loadRelationshipTypes(db),
        this.#loadPropertyTypes(db),
        this.#loadConfig(db)
      ]);

      // Load codes (largest operation)
      await this.#loadCodes(db);

      // Load dependent data in parallel
      await Promise.all([
        // this.#loadDesignationsCache(db),
        this.#loadHierarchy(db)
      ]);

    } finally {
      db.close();
    }
    this._loaded = true;
  }

  async #optimizeDatabase(db) {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA synchronous = NORMAL');
        db.run('PRAGMA cache_size = 10000');
        db.run('PRAGMA temp_store = MEMORY');
        db.run('PRAGMA mmap_size = 268435456'); // 256MB

        // Ensure indexes exist for per-request query patterns
        db.run('CREATE INDEX IF NOT EXISTS idx_descriptions_codekey_typkey ON Descriptions(CodeKey, DescriptionTypeKey)');
        db.run('CREATE INDEX IF NOT EXISTS idx_relationships_sourcekey ON Relationships(SourceKey)');
        db.run('CREATE INDEX IF NOT EXISTS idx_properties_codekey ON Properties(CodeKey)', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  async #loadLanguages(db) {
    return new Promise((resolve, reject) => {
      db.all('SELECT LanguageKey, Code FROM Languages', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            this._sharedData.langs.set(row.Code, row.LanguageKey);
          }
          resolve();
        }
      });
    });
  }

  async #loadStatusCodes(db) {
    return new Promise((resolve, reject) => {
      db.all('SELECT StatusKey, Description FROM StatusCodes', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            this._sharedData.statusKeys.set(row.Description, row.StatusKey.toString());
            this._sharedData.statusCodes.set(row.StatusKey.toString(), row.Description);
          }
          resolve();
        }
      });
    });
  }

  async #loadRelationshipTypes(db) {
    return new Promise((resolve, reject) => {
      db.all('SELECT RelationshipTypeKey, Description FROM RelationshipTypes', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            this._sharedData.relationships.set(row.Description, row.RelationshipTypeKey.toString());
          }
          resolve();
        }
      });
    });
  }

  async #loadPropertyTypes(db) {
    return new Promise((resolve, reject) => {
      db.all('SELECT PropertyTypeKey, Description FROM PropertyTypes', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            this._sharedData.propertyList.set(row.Description, row.PropertyTypeKey.toString());
          }
          resolve();
        }
      });
    });
  }

  async #loadCodes(db) {
    return new Promise((resolve, reject) => {
      // First get the count to pre-allocate array
      db.get('SELECT MAX(CodeKey) as maxKey FROM Codes', (err, row) => {
        if (err) return reject(err);

        // Pre-allocate the array to avoid repeated resizing
        const maxKey = row.maxKey || 0;
        this._sharedData.codeList = new Array(maxKey + 1).fill(null);

        // Now load all codes
        db.all('SELECT CodeKey, Code, Type, Codes.Description, StatusCodes.Description as Status FROM Codes, StatusCodes where StatusCodes.StatusKey = Codes.StatusKey order by Type Asc, CodeKey Asc', (err, rows) => {
          if (err) return reject(err);

          // Batch process rows
          for (const row of rows) {
            const context = new LoincProviderContext(
              row.CodeKey,
              row.Type - 1,
              row.Code,
              row.Description,
              row.Status
            );

            this._sharedData.codes.set(row.Code, context);
            this._sharedData.codeList[row.CodeKey] = context;
            this._sharedData.allKeys.push(row.CodeKey);

            if (this._sharedData.firstCodeKey === 0 && context.kind === LoincProviderContextKind.CODE) {
              this._sharedData.firstCodeKey = context.key;
            }
          }
          resolve();
        });
      });
    });
  }

  async #loadDesignationsCache(db) {
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT
              d.CodeKey,
              l.Code as Lang,
              dt.Description as DType,
              d.Value,
              dt.Description = 'LONG_COMMON_NAME' as IsDisplay
          FROM Descriptions d
                   JOIN Languages l ON d.LanguageKey = l.LanguageKey
                   JOIN DescriptionTypes dt ON d.DescriptionTypeKey = dt.DescriptionTypeKey
          WHERE d.DescriptionTypeKey != 4
          ORDER BY d.CodeKey
      `;

      db.all(sql, (err, rows) => {
        if (err) return reject(err);

        // Batch process by CodeKey to reduce lookups
        let currentKey = null;
        let currentContext = null;

        for (const row of rows) {
          if (row.CodeKey !== currentKey) {
            currentKey = row.CodeKey;
            currentContext = this._sharedData.codeList[currentKey];
          }

          if (currentContext) {
            currentContext.displays.push(
              new DescriptionCacheEntry(row.IsDisplay, row.Lang, row.Value, row.DType)
            );
          }
        }
        resolve();
      });
    });
  }

  async #loadHierarchy(db) {
    const childRelKey = this._sharedData.relationships.get('child');
    if (!childRelKey) {
      return; // No child relationships defined
    }

    return new Promise((resolve, reject) => {
      const sql = `
          SELECT SourceKey, TargetKey FROM Relationships
          WHERE RelationshipTypeKey = ${childRelKey}
      `;

      db.all(sql, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            if (row.SourceKey !== 0 && row.TargetKey !== 0) {
              const parentContext = this._sharedData.codeList[row.SourceKey];
              if (parentContext) {
                parentContext.addChild(row.TargetKey);
              }
            }
          }
          resolve();
        }
      });
    });
  }

  async #loadConfig(db) {
    return new Promise((resolve, reject) => {
      db.all('SELECT ConfigKey, Value FROM Config WHERE ConfigKey IN (2, 3)', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            if (row.ConfigKey === 2) {
              this._sharedData._version = row.Value;
            } else if (row.ConfigKey === 3) {
              this._sharedData.root = row.Value;
            }
          }
          resolve();
        }
      });
    });
  }

  defaultVersion() {
    return this._sharedData?._version || 'unknown';
  }

  async build(opContext, supplements) {
    await this.#ensureLoaded();
    this.recordUse();

    // Create read-only database connection for this provider instance
    const db = await new Promise((resolve, reject) => {
      const conn = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) reject(err);
        else resolve(conn);
      });
    });
    // Apply performance PRAGMAs to per-request connection
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('PRAGMA cache_size = 10000');
        db.run('PRAGMA temp_store = MEMORY');
        db.run('PRAGMA mmap_size = 268435456', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

    return new LoincServices(opContext, supplements, db, this._sharedData, this.dbPath);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }

  async buildKnownValueSet(url, version) {

    if (version && version != this.version()) {
      return null;
    }
    if (!url.startsWith('http://loinc.org/vs')) {
      return null;
    }
    if (url == 'http://loinc.org/vs') {
      // All LOINC codes
      return {
        resourceType: 'ValueSet', url: 'http://loinc.org/vs', version: this.version(), status: 'active',
        name: 'LOINC Value Set - all LOINC codes', description: 'All LOINC codes',
        date: new Date().toISOString(), experimental: false,
        compose: { include: [{ system: this.system() }] }
      };
    }

    if (url.startsWith('http://loinc.org/vs/')) {
      const code = url.substring(20);
      const ci = this._sharedData.codes.get(code);
      if (!ci) {
        return null;
      }

      if (ci.kind === LoincProviderContextKind.PART) {
        // Part-based value set with ancestor filter
        return {
          resourceType: 'ValueSet',  url: url, version: this.version(), status: 'active',
          name: 'LOINCValueSetFor' + ci.code.replace(/-/g, '_'), description: 'LOINC value set for code ' + ci.code + ': ' + ci.desc,
          date: new Date().toISOString(),  experimental: false,
          compose: { include: [{ system: this.system(), filter: [{ property: 'ancestor', op: '=', value: code }] }]
          }
        };
      }

      if (ci.kind === LoincProviderContextKind.LIST) {
        // Answer list - enumerate concepts from database
        const concepts = await this.#getAnswerListConcepts(ci.key);
        return {
          resourceType: 'ValueSet', url: url, version: this.version(), status: 'active',
          name: 'LOINCAnswerList' + ci.code.replace(/-/g, '_'),  description: 'LOINC Answer list for code ' + ci.code + ': ' + ci.desc,
          date: new Date().toISOString(), experimental: false,
          compose: { include: [{ system: this.system(), concept: concepts }] }
        };
      }
    }

    return null;
  }

  /**
   * Get answer list concepts from database
   * @param {number} sourceKey - Key of the answer list
   * @returns {Promise<Array>} Array of {code, display} objects
   */
  async #getAnswerListConcepts(sourceKey) {
    return new Promise((resolve, reject) => {
      let db = new sqlite3.Database(this.dbPath);
      const sql = `
          SELECT Code, Description
          FROM Relationships, Codes
          WHERE SourceKey = ?
            AND RelationshipTypeKey = 40
            AND Relationships.TargetKey = Codes.CodeKey
      `;

      db.all(sql, [sourceKey], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const concepts = rows.map(row => ({
            code: row.Code
          }));
          resolve(concepts);
        }
      });
    });
  }

  id() {
    return "loinc"+this.version();
  }
}

module.exports = {
  LoincServices,
  LoincServicesFactory,
  LoincProviderContext,
  LoincProviderContextKind
};