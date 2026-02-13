'use strict';

const sqlite3 = require('sqlite3').verbose();
const { CodeSystem } = require('../library/codesystem');
const { CodeSystemProvider, CodeSystemFactoryProvider, FilterExecutionContext } = require('./cs-api');

const SQLITE_RUNTIME_V0_FACTORY_REGISTRY = [];

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
    this.ownsDb = options.ownsDb === true;
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
    this.db.close();
    this.db = null;
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
    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.code : null;
  }

  async display(context) {
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) return null;

    const supplementDisplay = this._displayFromSupplements(ctxt.code);
    if (supplementDisplay) {
      return supplementDisplay;
    }

    return ctxt.display || ctxt.code;
  }

  async definition(context) {
    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.definition : null;
  }

  async isAbstract(context) {
    await this.#ensureContext(context);
    const abstractCfg = this.runtime.status?.abstract;
    if (abstractCfg?.source === 'constant') {
      return !!abstractCfg.value;
    }
    return false;
  }

  async isInactive(context) {
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) return false;
    const inactiveCfg = this.runtime.status?.inactive;
    if (inactiveCfg?.source === 'concept.active') {
      return inactiveCfg.invert === true ? !ctxt.active : !!ctxt.active;
    }
    return !ctxt.active;
  }

  async isDeprecated(context) {
    await this.#ensureContext(context);
    const depCfg = this.runtime.status?.deprecated;
    if (depCfg?.source === 'constant') {
      return !!depCfg.value;
    }
    return false;
  }

  async getStatus(context) {
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) return null;

    const statusPropertyCode = this.runtime?.status?.statusProperty;
    if (statusPropertyCode) {
      const propDef = await this.#resolvePropertyDef(statusPropertyCode);
      if (propDef) {
        const row = await get(
          this.db,
          `SELECT COALESCE(value_text, value_raw) AS value
           FROM concept_literal
           WHERE source_concept_id = ?
             AND property_id = ?
             AND active = 1
             AND COALESCE(value_text, value_raw) IS NOT NULL
           LIMIT 1`,
          [ctxt.conceptId, propDef.property_id]
        );
        if (row?.value) {
          return row.value;
        }
      }
    }

    return ctxt.active ? 'active' : 'inactive';
  }

  async designations(context, displays) {
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) return;

    // Keep legacy behavior where a primary display is always available as a designation.
    displays.addDesignation(
      true,
      ctxt.active ? 'active' : 'inactive',
      this.defLang(),
      CodeSystem.makeUseForDisplay(),
      ctxt.display || ctxt.code
    );

    const designationTableRef = this.meta?.designationOrderIndex
      ? 'designation INDEXED BY idx_designation_concept_pref_term'
      : 'designation';
    const rows = await all(
      this.db,
      `SELECT language_code, use_code, term, preferred, active
       FROM ${designationTableRef}
       WHERE concept_id = ?
       ORDER BY preferred DESC, term`,
      [ctxt.conceptId]
    );

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
    const ctxt = await this.#ensureContext(context);
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
      const rows = await all(
        this.db,
        `SELECT c.code
         FROM concept c
         LEFT JOIN concept_link l
           ON l.source_concept_id = c.concept_id
          AND l.property_id = ?
          AND l.edge_set_id = ?
          AND l.active = 1
         WHERE c.cs_id = ?
           AND c.active = 1
           AND l.edge_id IS NULL
         ORDER BY c.code`,
        [this.meta.hierarchyPropertyId, this.meta.hierarchyEdgeSetId, this.meta.csId]
      );
      return new SqliteRuntimeV0Iterator(
        rows.map(r => r.code).filter(code => this.#allowDefaultIterationCode(code))
      );
    }

    const ctxt = await this.#ensureContext(code);
    if (!ctxt) return null;

    const rows = await all(
      this.db,
      `SELECT c.code
       FROM concept_link l
       JOIN concept c ON c.concept_id = l.source_concept_id
       WHERE l.target_concept_id = ?
         AND l.property_id = ?
         AND l.edge_set_id = ?
         AND l.active = 1
       ORDER BY c.code`,
      [ctxt.conceptId, this.meta.hierarchyPropertyId, this.meta.hierarchyEdgeSetId]
    );

    return new SqliteRuntimeV0Iterator(rows.map(r => r.code));
  }

  async iteratorAll() {
    const rows = await all(
      this.db,
      `SELECT code
       FROM concept
       WHERE cs_id = ? AND active = 1
       ORDER BY code`,
      [this.meta.csId]
    );
    return new SqliteRuntimeV0Iterator(
      rows.map(r => r.code).filter(code => this.#allowDefaultIterationCode(code))
    );
  }

  async nextContext(iteratorContext) {
    if (!iteratorContext || !(iteratorContext instanceof SqliteRuntimeV0Iterator)) {
      return null;
    }
    if (iteratorContext.cursor >= iteratorContext.codes.length) {
      return null;
    }

    const code = iteratorContext.codes[iteratorContext.cursor];
    iteratorContext.cursor += 1;

    const located = await this.locate(code);
    return located.context;
  }

  async subsumesTest(codeA, codeB) {
    const a = await this.#ensureContext(codeA);
    const b = await this.#ensureContext(codeB);
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

  async getPrepContext(iterate) {
    return new FilterExecutionContext(iterate);
  }

  async searchFilter(filterContext, filter, _sort) {
    void _sort;
    const searchText = typeof filter === 'string'
      ? filter
      : (filter && typeof filter.filter === 'string' ? filter.filter : null);

    if (!searchText || !searchText.trim()) {
      throw new Error('Invalid search filter');
    }

    const searchCfg = normalizedSearchConfig(this.runtime.search);
    let codes = [];

    if (this.#canUseFtsSearch(searchCfg)) {
      try {
        codes = await this.#searchCodesWithFts(searchText, searchCfg);
      } catch (error) {
        if (!searchCfg.likeFallback?.enabled) {
          throw error;
        }
        codes = await this.#searchCodesWithLike(searchText, searchCfg);
      }
    } else {
      codes = await this.#searchCodesWithLike(searchText, searchCfg);
    }

    filterContext.filters.push(
      new SqliteRuntimeV0FilterSet(`search:${searchText}`, codes, true)
    );
  }

  async filter(filterContext, prop, op, value) {
    if (prop === 'code' && op === 'regex') {
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
      await this.#filterByProperty(filterContext, propertyCfg, op, value);
      return;
    }

    if (op === '=') {
      if (this.#useMembershipPredicate(filterContext)) {
        filterContext.filters.push(new SqliteRuntimeV0PredicateFilter(
          `concept=${value}`,
          'concept-equals',
          { code: value },
          true
        ));
      } else {
        const located = await this.locate(value);
        const codes = located.context ? [value] : [];
        filterContext.filters.push(new SqliteRuntimeV0FilterSet(`concept=${value}`, codes, true));
      }
      return;
    }

    if (op === 'is-a' || op === 'descendent-of') {
      const includeSelf = op === 'is-a'
        ? (this.runtime?.filters?.concept?.isAIncludesSelf !== false)
        : false;
      if (this.#useMembershipPredicate(filterContext)) {
        const parent = await this.locate(value);
        filterContext.filters.push(new SqliteRuntimeV0PredicateFilter(
          `concept-${op}:${value}`,
          'concept-hierarchy',
          {
            parentCode: value,
            ancestorId: parent.context ? parent.context.conceptId : null,
            includeSelf,
            missingMessage: parent.context ? null : `Parent concept '${value}' not found`
          },
          true
        ));
      } else {
        const parent = await this.locate(value);
        if (parent.context && this.meta.closureRows > 0 && this.meta.useClosure) {
          filterContext.filters.push(new SqliteRuntimeV0PagedDescendantFilter(
            `concept-${op}:${value}`,
            parent.context.conceptId,
            includeSelf
          ));
        } else {
          const codes = await this.#descendantCodes(value, includeSelf);
          filterContext.filters.push(new SqliteRuntimeV0FilterSet(`concept-${op}:${value}`, codes, true));
        }
      }
      return;
    }

    if (op === 'in') {
      const url = resolveInValueSetUrl(this.system(), value, this.runtime);
      if (this.#useMembershipPredicate(filterContext)) {
        filterContext.filters.push(new SqliteRuntimeV0PredicateFilter(
          `concept-in:${value}`,
          'concept-in',
          { valueSetUrl: url, rawValue: value },
          true
        ));
      } else {
        const rows = await all(
          this.db,
          `SELECT c.code
           FROM value_set v
           JOIN value_set_member m ON m.vs_id = v.vs_id
           JOIN concept c ON c.concept_id = m.concept_id
           WHERE v.cs_id = ?
             AND v.url = ?
             AND m.active = 1
           ORDER BY code`,
          [this.meta.csId, url]
        );

        filterContext.filters.push(new SqliteRuntimeV0FilterSet(`concept-in:${value}`, rows.map(r => r.code), true));
      }
      return;
    }

    throw new Error(`Unsupported sqlite runtime filter operator '${op}' for concept`);
  }

  async executeFilters(filterContext) {
    return filterContext.filters || [];
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
    const ctxt = await this.#ensureContext(concept);
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
         WHERE c.cs_id = ?
           AND cl.property_id = ?
           AND cl.active = 1
           AND COALESCE(cl.value_text, cl.value_raw) IS NOT NULL`,
        [this.meta.csId, propertyCfg.propertyId]
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
         WHERE src.cs_id = ?
           AND l.property_id = ?
           AND l.edge_set_id = ?
           AND l.active = 1`,
        [this.meta.csId, propertyCfg.propertyId, this.meta.hierarchyEdgeSetId]
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

    const normalized = caseSensitive
      ? candidates
      : candidates.map(v => String(v).toLowerCase());
    const placeholders = normalized.map(() => '?').join(', ');
    const comparator = caseSensitive
      ? 'COALESCE(cl.value_text, cl.value_raw)'
      : 'LOWER(COALESCE(cl.value_text, cl.value_raw))';

    return all(
      this.db,
      `SELECT DISTINCT c.code AS code
       FROM concept_literal cl
       JOIN concept c ON c.concept_id = cl.source_concept_id
       WHERE c.cs_id = ?
         AND cl.property_id = ?
         AND cl.active = 1
         AND COALESCE(cl.value_text, cl.value_raw) IS NOT NULL
         AND ${comparator} IN (${placeholders})`,
      [this.meta.csId, propertyId, ...normalized]
    );
  }

  async #propertyLinkEqualsRows(propertyCfg, candidates, caseSensitive) {
    if (!propertyCfg?.propertyId || !Array.isArray(candidates) || candidates.length === 0) {
      return [];
    }

    const normalized = caseSensitive
      ? candidates
      : candidates.map(v => String(v).toLowerCase());
    const placeholders = normalized.map(() => '?').join(', ');
    const codeExpr = caseSensitive ? 'tgt.code' : 'LOWER(tgt.code)';
    const displayExpr = caseSensitive ? 'tgt.display' : 'LOWER(tgt.display)';

    const where = propertyCfg.linkMatch === 'code-or-display'
      ? `(${codeExpr} IN (${placeholders}) OR ${displayExpr} IN (${placeholders}))`
      : `${codeExpr} IN (${placeholders})`;

    const params = [this.meta.csId, propertyCfg.propertyId, this.meta.hierarchyEdgeSetId];
    params.push(...normalized);
    if (propertyCfg.linkMatch === 'code-or-display') {
      params.push(...normalized);
    }

    return all(
      this.db,
      `SELECT DISTINCT src.code AS code
       FROM concept_link l
       JOIN concept src ON src.concept_id = l.source_concept_id
       JOIN concept tgt ON tgt.concept_id = l.target_concept_id
       WHERE src.cs_id = ?
         AND l.property_id = ?
         AND l.edge_set_id = ?
         AND l.active = 1
         AND ${where}`,
      params
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
         WHERE c.cs_id = ?
           AND cl.property_id = ?
           AND cl.active = 1`,
        [this.meta.csId, propertyCfg.propertyId]
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
         WHERE src.cs_id = ?
           AND l.property_id = ?
           AND l.edge_set_id = ?
           AND l.active = 1`,
        [this.meta.csId, propertyCfg.propertyId, this.meta.hierarchyEdgeSetId]
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

  async #ensureContext(code) {
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
    const ctxt = await this.#ensureContext(context);
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
    const ancestorContext = await this.#ensureContext(ancestorCode);
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
  static registerSpecializedFactory(definition) {
    if (!definition || typeof definition !== 'object') {
      throw new Error('registerSpecializedFactory requires an object definition');
    }
    if (typeof definition.createFactory !== 'function') {
      throw new Error('registerSpecializedFactory requires createFactory(context) function');
    }
    const matchTags = Array.isArray(definition.matchTags)
      ? definition.matchTags.map((tag) => String(tag || '').trim()).filter(Boolean)
      : [];
    SQLITE_RUNTIME_V0_FACTORY_REGISTRY.push({
      id: String(definition.id || `factory-${SQLITE_RUNTIME_V0_FACTORY_REGISTRY.length + 1}`),
      priority: Number.isFinite(definition.priority) ? definition.priority : 0,
      matchTags,
      createFactory: definition.createFactory
    });
    SQLITE_RUNTIME_V0_FACTORY_REGISTRY.sort((a, b) => {
      if (b.matchTags.length !== a.matchTags.length) {
        return b.matchTags.length - a.matchTags.length;
      }
      return b.priority - a.priority;
    });
  }

  static listSpecializedFactories() {
    return SQLITE_RUNTIME_V0_FACTORY_REGISTRY.map((entry) => ({
      id: entry.id,
      priority: entry.priority,
      matchTags: [...entry.matchTags]
    }));
  }

  static async createFromMetadata(i18n, dbPath, options = {}) {
    const probe = new SqliteRuntimeV0FactoryProvider(i18n, dbPath, options);
    await probe.load();

    const tags = metadataTagsFromRuntime(probe._runtime);
    let selected = null;
    for (const entry of SQLITE_RUNTIME_V0_FACTORY_REGISTRY) {
      if (entry.matchTags.every((tag) => tags.has(tag))) {
        selected = entry;
        break;
      }
    }
    if (!selected) {
      return probe;
    }

    const resolved = await selected.createFactory({
      i18n,
      dbPath,
      options,
      tags,
      runtime: probe._runtime,
      metadata: probe._meta,
      baseFactory: probe
    });

    if (!resolved || resolved === probe) {
      return probe;
    }

    probe.close();
    if (typeof resolved.load === 'function' && !resolved._loaded) {
      await resolved.load();
    }
    return resolved;
  }

  constructor(i18n, dbPath, options = {}) {
    super(i18n);
    this.dbPath = dbPath;
    this.idPrefix = options.idPrefix || 'sqlite-runtime-v0';
    this._loaded = false;
    this._loadPromise = null;
    this._db = null;
    this._meta = null;
    this._runtime = null;
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
    return new SqliteRuntimeV0Provider(opContext, supplements, this._db, this._meta, this._runtime, { ownsDb: false });
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

function metadataTagsFromRuntime(runtime) {
  const flags = runtime?.behaviorFlags || {};
  const tags = new Set();

  if (Array.isArray(flags.tags)) {
    for (const raw of flags.tags) {
      const tag = String(raw || '').trim();
      if (tag) tags.add(tag);
    }
  }

  const legacyAdapter = String(flags.adapter || '').trim();
  if (legacyAdapter) {
    tags.add(`adapter:${legacyAdapter}`);
    tags.add(legacyAdapter);
    if (legacyAdapter === 'loinc-v0') {
      tags.add('loinc');
      tags.add('implicit-vs-path');
    } else if (legacyAdapter === 'snomed-v0') {
      tags.add('snomed');
    } else if (legacyAdapter === 'rxnorm-v0') {
      tags.add('rxnorm');
    }
  }

  return tags;
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

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
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
