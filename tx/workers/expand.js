//
// Expand Worker - Handles ValueSet $expand operation
//
// GET /ValueSet/{id}/$expand
// GET /ValueSet/$expand?url=...&version=...
// POST /ValueSet/$expand (form body or Parameters with url)
// POST /ValueSet/$expand (body is ValueSet resource)
// POST /ValueSet/$expand (body is Parameters with valueSet parameter)
//

const { TerminologyWorker } = require('./worker');
const {TxParameters} = require("../params");
const {Designations, SearchFilterText} = require("../library/designations");
const {Extensions} = require("../library/extensions");
const {getValuePrimitive, getValueName} = require("../../library/utilities");
const perfCounters = require('../perf-counters');
const {div} = require("../../library/html");
const {Issue, OperationOutcome} = require("../library/operation-outcome");
const crypto = require('crypto');
const ValueSet = require("../library/valueset");
const {VersionUtilities} = require("../../library/version-utilities");

// Expansion limits — raised to 1M to allow full code-system expansions
// (e.g., SNOMED Clinical Findings ~124K codes). The v0 SQLite provider
// handles large expansions efficiently via streaming pagination.
const UPPER_LIMIT_NO_TEXT = 1000000;
const UPPER_LIMIT_TEXT = 1000000;
const INTERNAL_LIMIT = 1000000;
const EXPANSION_DEAD_TIME_SECS = 30;
const CACHE_WHEN_DEBUGGING = false;

/**
 * Total status for expansion
 */
const TotalStatus = {
  Uninitialized: 'uninitialized',
  Set: 'set',
  Off: 'off'
};

/**
 * Wraps an already-expanded ValueSet for fast code lookups
 * Used when importing ValueSets during expansion
 */
class ImportedValueSet {
  /**
   * @param {Object} valueSet - Expanded ValueSet resource
   */
  constructor(valueSet) {
    this.valueSet = valueSet;
    this.url = valueSet.url || '';
    this.version = valueSet.version || '';

    /** @type {Map<string, Object>} Maps system|code -> contains entry */
    this.codeMap = new Map();

    /** @type {Set<string>} Set of systems in this ValueSet */
    this.systems = new Set();

    this._buildCodeMap();
  }

  /**
   * Build the code lookup map from the expansion
   * @private
   */
  _buildCodeMap() {
    if (!this.valueSet.expansion || !this.valueSet.expansion.contains) {
      return;
    }

    this._indexContains(this.valueSet.expansion.contains);
  }

  /**
   * Recursively index contains entries
   * @private
   */
  _indexContains(contains) {
    for (const entry of contains) {
      if (entry.system && entry.code) {
        const key = this._makeKey(entry.system, entry.code);
        this.codeMap.set(key, entry);
        this.systems.add(entry.system);
      }

      // Handle nested contains (hierarchy)
      if (entry.contains && entry.contains.length > 0) {
        this._indexContains(entry.contains);
      }
    }
  }

  /**
   * Make a lookup key from system and code
   * @private
   */
  _makeKey(system, code) {
    return `${system}\x00${code}`;
  }

  /**
   * Check if this ValueSet contains a specific code
   * @param {string} system - Code system URL
   * @param {string} code - Code value
   * @returns {boolean}
   */
  hasCode(system, code) {
    return this.codeMap.has(this._makeKey(system, code));
  }

  /**
   * Get a contains entry for a specific code
   * @param {string} system - Code system URL
   * @param {string} code - Code value
   * @returns {Object|null}
   */
  getCode(system, code) {
    return this.codeMap.get(this._makeKey(system, code)) || null;
  }

  /**
   * Check if this ValueSet contains any codes from a system
   * @param {string} system - Code system URL
   * @returns {boolean}
   */
  hasSystem(system) {
    return this.systems.has(system);
  }

  /**
   * Get total number of codes
   * @returns {number}
   */
  get count() {
    return this.codeMap.size;
  }

  /**
   * Iterate over all codes
   * @yields {{system: string, code: string, entry: Object}}
   */
  *codes() {
    for (const entry of this.codeMap.values()) {
      yield {
        system: entry.system,
        code: entry.code,
        entry
      };
    }
  }
}

/**
 * Special filter context for ValueSet import optimization
 * When a ValueSet can be used as a filter instead of full expansion
 */
class ValueSetFilterContext {
  /**
   * @param {ImportedValueSet} importedVs - The imported ValueSet
   */
  constructor(importedVs) {
    this.importedVs = importedVs;
    this.type = 'valueset';
  }

  /**
   * Check if a code passes this filter
   * @param {string} system - Code system URL
   * @param {string} code - Code value
   * @returns {boolean}
   */
  passesFilter(system, code) {
    return this.importedVs.hasCode(system, code);
  }
}

/**
 * Special filter context for empty filter (nothing matches)
 */
class EmptyFilterContext {
  constructor() {
    this.type = 'empty';
  }

  passesFilter() {
    return false;
  }
}

class ValueSetCounter {
  constructor() {
    this.count = 0;
  }

  increment() {
    this.count++;
  }
}

class ValueSetExpander {
  worker;
  params;
  excluded = new Set();
  hasExclusions = false;
  requiredSupplements = new Set();
  usedSupplements = new Set();

  constructor(worker, params) {
    this.worker = worker;
    this.params = params;

    this.csCounter = new Map();
  }

  addDefinedCode(cs, system, c, imports, parent, excludeInactive, srcURL) {
    this.worker.deadCheck('addDefinedCode');
    let n = null;
    if (!this.params.excludeNotForUI || !cs.isAbstract(c)) {
      const cds = new Designations(this.worker.opContext.i18n.languageDefinitions);
      this.listDisplays(cds, c);
      n = this.includeCode(null, parent, system, '', c.code, cs.isAbstract(c), cs.isInactive(c), cs.isDeprecated(c), cs.codeStatus(c), cds, c.definition, c.itemWeight,
        null, imports, c.getAllExtensionsW(), null, c.properties, null, excludeInactive, srcURL);
    }
    for (let i = 0; i < c.concept.length; i++) {
      this.worker.deadCheck('addDefinedCode');
      this.addDefinedCode(cs, system, c.concept[i], imports, n, excludeInactive, srcURL);
    }
  }

  async listDisplaysFromProvider(displays, cs, context) {
    const langs = this.params.workingLanguages?.();
    if (!this.params.includeDesignations && langs && cs.hasAnyDisplays(langs)) {
      perfCounters.bump('display.fastPath');
      const d = await cs.display(context);
      if (d) {
        displays.addDesignation(true, 'active', null, null, d);
      }
    } else {
      perfCounters.bump('display.fullPath');
      await cs.designations(context, displays);
    }
    displays.source = cs;
  }

  listDisplaysFromConcept(displays, concept) {
    for (const ccd of concept.designations || []) {
      displays.addDesignation(ccd);
    }
  }

  listDisplaysFromIncludeConcept(displays, concept, vs) {
    if (concept.display) {
      if (!VersionUtilities.isR4Plus(this.worker.provider.getFhirVersion())) {
        displays.clear();
      }
      let lang = vs.language ? this.worker.languages.parse(vs.language) : null;
      displays.addDesignation(true, "active", lang, null, concept.display);
      }
    for (const cd of concept.designation || []) {
      displays.addDesignationFromConcept(cd);
    }
  }
  canonical(system, version) {
    if (!version) {
      return system;
    } else {
      return system + '|' + version;
    }
  }

  passesImport(imp, system, code) {
    imp.buildMap();
    return imp.hasCode(system, code);
  }

  passesImports(imports, system, code, offset) {
    if (imports == null) {
      return true;
    }
    for (let i = offset; i < imports.length; i++) {
      if (!this.passesImport(imports[i], system, code)) {
        return false;
      }
    }
    return true;
  }

  useDesignation(cd) {
    if (!this.params.hasDesignations) {
      return true;
    }
    for (const s of this.params.designations) {
      const [l, r] = s.split('|');
      if (cd.use != null && cd.use.system === l && cd.use.code === r) {
        return true;
      }
      if (cd.language != null && l === 'urn:ietf:bcp:47' && r === cd.language.code) {
        return true;
      }
    }
    return false;
  }

  isValidating() {
    return false;
  }

  opName() {
    return 'expansion';
  }

  redundantDisplay(n, lang, use, value) {
    if (!((lang == null) && (!this.valueSet.language)) || ((lang) && lang.code.startsWith(this.valueSet.language))) {
      return false;
    } else if (!((use == null) || (use.code === 'display'))) {
      return false;
    } else {
      return value.asString === n.display;
    }
  }

  includeCode(cs, parent, system, version, code, isAbstract, isInactive, deprecated, status, displays, definition, itemWeight, expansion, imports, csExtList, vsExtList, csProps, expProps, excludeInactive, srcURL) {
    let result = null;
    this.worker.deadCheck('processCode');

    if (!this.passesImports(imports, system, code, 0)) {
      return null;
    }
    if (isInactive && excludeInactive) {
      return null;
    }
    if (this.isExcluded(system, version, code)) {
      return null;
    }

    if (cs != null && cs.expandLimitation > 0) {
      let cnt = this.csCounter.get(cs.system);
      if (cnt == null) {
        cnt = new ValueSetCounter();
        this.csCounter.set(cs.system, cnt);
      }
      cnt.increment();
      if (cnt.count > cs.expandLimitation) {
        return null;
      }
    }

    if (this.limitCount > 0 && this.fullList.length >= this.limitCount && !this.hasExclusions) {
      if (this.count > -1 && this.offset > -1 && this.count + this.offset > 0 && this.fullList.length >= this.count + this.offset) {
        this.noTotal();
        throw new Issue('information', 'informational', null, null, null, null).setFinished();
      } else {
        if (!srcURL) {
          srcURL = '??';
        }
        throw new Issue("error", "too-costly", null, 'VALUESET_TOO_COSTLY', this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages, [srcURL, '>' + this.limitCount]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());
      }
    }

    if (expansion) {
      const s = this.canonical(system, version);
      this.addParamUri(expansion, 'used-codesystem', s);
      if (cs != null) {
        const ts = cs.listSupplements();
        for (const vs of ts) {
          this.addParamUri(expansion, 'used-supplement', vs);
        }
      }
    }

    const s = this.keyS(system, version, code);

    if (!this.map.has(s)) {
      const n = {};
      n.system = system;
      n.code = code;
      if (this.doingVersion) {
        n.version = version;
      }
      if (isAbstract) {
        n.abstract = isAbstract;
      }
      if (isInactive) {
        n.inactive = true;
      }

      if (status && status.toLowerCase() !== 'active') {
        this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#status', 'status', "valueCode", status);
      } else if (deprecated) {
        this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#status', 'status', "valueCode", 'deprecated');
      }

      if (Extensions.has(csExtList, 'http://hl7.org/fhir/StructureDefinition/codesystem-label')) {
        this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#label', 'label', "valueString", Extensions.readString(csExtList, 'http://hl7.org/fhir/StructureDefinition/codesystem-label'));
      }
      if (Extensions.has(vsExtList, 'http://hl7.org/fhir/StructureDefinition/valueset-label')) {
        this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#label', 'label', "valueString", Extensions.readString(vsExtList, 'http://hl7.org/fhir/StructureDefinition/valueset-label'));
      }

      if (Extensions.has(csExtList, 'http://hl7.org/fhir/StructureDefinition/codesystem-conceptOrder')) {
        this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#order', 'order', "valueDecimal", Extensions.readNumber(csExtList, 'http://hl7.org/fhir/StructureDefinition/codesystem-conceptOrder', undefined));
      }
      if (Extensions.has(vsExtList, 'http://hl7.org/fhir/StructureDefinition/valueset-conceptOrder')) {
        this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#order', 'order', "valueDecimal", Extensions.readNumber(vsExtList, 'http://hl7.org/fhir/StructureDefinition/valueset-conceptOrder', undefined));
      }

      if (Extensions.has(csExtList, 'http://hl7.org/fhir/StructureDefinition/itemWeight')) {
        this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#itemWeight', 'weight', "valueDecimal", Extensions.readNumber(csExtList, 'http://hl7.org/fhir/StructureDefinition/itemWeight', undefined));
      }
      if (Extensions.has(vsExtList, 'http://hl7.org/fhir/StructureDefinition/itemWeight')) {
        this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#itemWeight', 'weight', "valueDecimal", Extensions.readNumber(vsExtList, 'http://hl7.org/fhir/StructureDefinition/itemWeight', undefined));
      }

      if (csExtList != null) {
        for (const ext of csExtList) {
          if (['http://hl7.org/fhir/StructureDefinition/coding-sctdescid', 'http://hl7.org/fhir/StructureDefinition/rendering-style',
            'http://hl7.org/fhir/StructureDefinition/rendering-xhtml', 'http://hl7.org/fhir/StructureDefinition/codesystem-alternate'].includes(ext.url)) {
            if (!n.extension) {n.extension = []}
            n.extension.push(ext);
          }
          if (['http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'].includes(ext.url)) {
            this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#status', 'status', "valueCode", getValuePrimitive(ext));
          }
        }
      }

      if (vsExtList != null) {
        for (const ext of vsExtList || []) {
          if (['http://hl7.org/fhir/StructureDefinition/valueset-supplement', 'http://hl7.org/fhir/StructureDefinition/valueset-deprecated',
            'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
            'http://hl7.org/fhir/StructureDefinition/valueset-concept-definition', 'http://hl7.org/fhir/StructureDefinition/coding-sctdescid',
            'http://hl7.org/fhir/StructureDefinition/rendering-style', 'http://hl7.org/fhir/StructureDefinition/rendering-xhtml'].includes(ext.url)) {
            if (!n.extension) {n.extension = []}
            n.extension.push(ext);
          }
        }
      }

      // display and designations
      const pref = displays.preferredDesignation(this.params.workingLanguages());
      if (pref && pref.value) {
        n.display = pref.value;
      }

      if (this.params.includeDesignations) {
        for (const t of displays.designations) {
          if (t !== pref && this.useDesignation(t) && t.value != null && !this.redundantDisplay(n, t.language, t.use, t.value)) {
            if (!n.designation) {
              n.designation = [];
            }
            n.designation.push(t.asObject());
          }
        }
      }

      for (const pn of this.params.properties) {
        if (pn === 'definition') {
          if (definition) {
            this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#definition', pn, "valueString", definition);
          }
        } else if (csProps != null && cs != null) {
          for (const cp of csProps) {
            if (cp.code === pn) {
              let vn = getValueName(cp);
              let v = cp[vn];
              this.defineProperty(expansion, n, this.getPropUrl(cs, pn, cp), pn, vn, v);
            }
          }
        }
      }

      if (!this.map.has(s)) {
        this.fullList.push(n);
        this.map.set(s, n);
        if (parent != null) {
          if (!parent.contains) {
            parent.contains = [];
          }
          parent.contains.push(n);
        } else {
          this.rootList.push(n);
        }
      } else {
        this.canBeHierarchy = false;
      }
      result = n;
    }
    return result;
  }

  excludeCode(cs, system, version, code, expansion, imports, srcURL) {
    this.worker.deadCheck('excludeCode');
    if (!this.passesImports(imports, system, code, 0)) {
      return;
    }

    if (this.limitCount > 0 && this.fullList.length >= this.limitCount && !this.hasExclusions) {
      if (this.count > -1 && this.offset > -1 && this.count + this.offset > 0 && this.fullList.length >= this.count + this.offset) {
        throw new Issue('information', 'informational', null, null, null, null).setFinished();
      } else {
        if (!srcURL) {
          srcURL = '??';
        }
        throw new Issue("error", "too-costly", null, 'VALUESET_TOO_COSTLY', this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages, [srcURL, '>' + this.limitCount]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());
      }
    }

    if (expansion) {
      const s = this.canonical(system, version);
      this.addParamUri(expansion, 'used-codesystem', s);
      if (cs) {
        const ts= cs.listSupplements();
        for (const vs of ts) {
          this.addParamUri(expansion, 'used-supplement', vs);
        }
      }
    }

    this.excluded.add(system + '|' + version + '#' + code);
  }

  async checkCanExpandValueSet(uri, version) {
    const vs = await this.worker.findValueSet(uri, version);
    if (vs == null) {
      if (!version && uri.includes('|')) {
        version = uri.substring(uri.indexOf('|') + 1);
        uri = uri.substring(0, uri.indexOf('|'));
      }
      if (!version) {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK', this.worker.i18n.translate('VS_EXP_IMPORT_UNK', this.params.httpLanguages, [uri]), 'unknown', 422);
      } else {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK_PINNED', this.worker.i18n.translate('VS_EXP_IMPORT_UNK_PINNED', this.params.httpLanguages, [uri, version]), 'not-found', 422);
      }
    } else {
      this.worker.seeSourceVS(vs, uri);
    }
  }

  async expandValueSet(uri, version, filter, notClosed) {

    let vs = await this.worker.findValueSet(uri, version);
    if (!vs) {
      if (version) {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK_PINNED', this.worker.i18n.translate('VS_EXP_IMPORT_UNK_PINNED', this.params.httpLanguages, [uri, version]), "not-found", 422);
      } else if (uri.includes('|')) {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK_PINNED', this.worker.i18n.translate('VS_EXP_IMPORT_UNK_PINNED', this.params.httpLanguages, [uri.substring(0, uri.indexOf("|")), uri.substring(uri.indexOf("|")+1)]), "not-found", 422);
      } else {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK', this.worker.i18n.translate('VS_EXP_IMPORT_UNK', this.params.httpLanguages, [uri]), "not-found", 422);
      }
    }
    let worker = new ExpandWorker(this.worker.opContext, this.worker.log, this.worker.provider, this.worker.languages, this.worker.i18n);
    worker.additionalResources = this.worker.additionalResources;
    // we're going to let this one do more expansion for technical reasons
    let paramsInner = this.params.clone();
    paramsInner.limit = INTERNAL_LIMIT;
    let expander = new ValueSetExpander(worker, paramsInner);
    let result = await expander.expand(vs, filter, false);
    if (result == null) {
      throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK', this.worker.i18n.translate('VS_EXP_IMPORT_UNK', this.params.httpLanguages, [uri]), 'unknown');
    }
    if (Extensions.has(result.expansion, 'http://hl7.org/fhir/params/questionnaire-extensions#closed')) {
      notClosed.value = true;
    }
    return result;
  }

  async importValueSet(vs, expansion, imports, offset) {
    this.canBeHierarchy = false;
    for (let p of vs.expansion.parameter || []) {
      let vn = getValueName(p);
      let v = getValuePrimitive(p);
      this.addParam(expansion, p.name, vn, v);
    }
    this.checkResourceCanonicalStatus(expansion, vs, this.valueSet);

    for (const c of vs.expansion.contains || []) {
      this.worker.deadCheck('importValueSet');
      await this.importValueSetItem(null, c, imports, offset);
    }
  }

  async importValueSetItem(p, c, imports, offset) {
    this.worker.deadCheck('importValueSetItem');
    const s = this.keyC(c);
    if (this.passesImports(imports, c.system, c.code, offset) && !this.map.has(s)) {
      this.fullList.push(c);
      if (p != null) {
        if (!p.contains) {p.contains = [] }
        p.contains.push(c);
      } else {
        this.rootList.push(c);
      }
      this.map.set(s, c);
    }
    for (const cc of c.contains || []) {
      this.worker.deadCheck('importValueSetItem');
      await this.importValueSetItem(c, cc, imports, offset);
    }
  }

  excludeValueSet(vs, expansion, imports, offset) {
    for (const c of vs.expansion.contains) {
      this.worker.deadCheck('excludeValueSet');
      const s = this.keyC(c);
      if (this.passesImports(imports, c.system, c.code, offset) && this.map.has(s)) {
        const idx = this.fullList.indexOf(this.map.get(s));
        if (idx >= 0) {
          this.fullList.splice(idx, 1);
        }
        this.map.delete(s);
        this.decTotal();
      }
    }
  }

  async checkSource(cset, exp, filter, srcURL, ts, vsInfo) {
    this.worker.deadCheck('checkSource');
    Extensions.checkNoModifiers(cset, 'ValueSetExpander.checkSource', 'set');
    let imp = false;
    for (const u of cset.valueSet || []) {
      this.worker.deadCheck('checkSource');
      const s = this.worker.pinValueSet(u);
      await this.checkCanExpandValueSet(s, '');
      imp = true;
    }

    if (ts.has(cset.system)) {
      const v = ts.get(cset.system);
      if (v !== cset.version) {
        this.doingVersion = true;
      }
    } else {
      ts.set(cset.system, cset.version);
    }

    if (cset.system) {
      const cs = await this.worker.findCodeSystem(cset.system, cset.version, this.params, ['complete', 'fragment'],
        false, true, true, null, this.requiredSupplements);
      this.worker.seeSourceProvider(cs, cset.system);
      if (cs == null) {
        // nothing
      } else {
        if (vsInfo && vsInfo.isSimple) {
          vsInfo.csDoExcludes = cs.handlesExcludes();
          vsInfo.csDoOffset = cs.handlesOffset();
        }
        if (cs.contentMode() !== 'complete') {
          if (cs.contentMode() === 'not-present') {
            throw new Issue('error', 'business-rule', null, null, 'The code system definition for ' + cset.system + ' has no content, so this expansion cannot be performed', 'invalid');
          } else if (cs.contentMode() === 'supplement') {
            throw new Issue('error', 'business-rule', null, null, 'The code system definition for ' + cset.system + ' defines a supplement, so this expansion cannot be performed', 'invalid');
          } else {
            this.addParamUri(cs.contentMode(), cs.system + '|' + cs.version);
            Extensions.addString(exp, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed",
              "This extension is based on a fragment of the code system " + cset.system);
          }
        }

        if (!cset.concept && !cset.filter) {
          if (cs.specialEnumeration()) {
            await this.checkCanExpandValueSet(cs.specialEnumeration(), '');
          } else if (filter.isNull) {
            if (cs.isNotClosed()) {
              if (cs.specialEnumeration()) {
                Extensions.addString(exp, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", 'The code System "' + cs.system() + " has a grammar and so has infinite members. This extension is based on " + cs.specialEnumeration());
              } else {
                throw new Issue("error", "too-costly", null, null, 'The code System "' + cs.system() + '" has a grammar, and cannot be enumerated directly', null, 422).withDiagnostics(this.worker.opContext.diagnostics());
              }
            }
            if (!imp && this.limitCount > 0 && cs.totalCount > this.limitCount) {
              throw new Issue("error", "too-costly", null, 'VALUESET_TOO_COSTLY', this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages, [srcURL, '>' + this.limitCount]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());
            }
          }
        }
      }
    }
  }

  async includeCodes(cset, path, vsSrc, filter, expansion, excludeInactive, notClosed, compose, vsInfo) {
    this.worker.deadCheck('processCodes#1');
    const valueSets = [];

    Extensions.checkNoModifiers(cset, 'ValueSetExpander.processCodes', 'set');

    if (cset.valueSet || cset.concept || (cset.filter || []).length > 1) {
      this.canBeHierarchy = false;
    }

    if (!cset.system) {
      for (const u of cset.valueSet) {
        this.worker.deadCheck('processCodes#2');
        const s = this.worker.pinValueSet(u);
        this.worker.opContext.log('import value set ' + s);
        const ivs = new ImportedValueSet(await this.expandValueSet(s, '', filter, notClosed));
        this.checkResourceCanonicalStatus(expansion, ivs.valueSet, this.valueSet);
        this.addParamUri(expansion, 'used-valueset', this.worker.makeVurl(ivs.valueSet));
        valueSets.push(ivs);
      }
      await this.importValueSet(valueSets[0].valueSet, expansion, valueSets, 1);
    } else {
      const filters = [];
      const prep = null;
      const cs = await this.worker.findCodeSystem(cset.system, cset.version, this.params, ['complete', 'fragment'],
        false, false, true, null, this.requiredSupplements);

      if (cs == null) {
        // nothing
      } else {
        this.worker.checkSupplements(cs, cset, this.requiredSupplements, this.usedSupplements);
        this.checkProviderCanonicalStatus(expansion, cs, this.valueSet);
        const sv = this.canonical(await cs.system(), await cs.version());
        this.addParamUri(expansion, 'used-codesystem', sv);

        for (const u of cset.valueSet || []) {
          this.worker.deadCheck('processCodes#3');
          const s = this.pinValueSet(u);
          let f = null;
          this.opContext.log('import2 value set ' + s);
          const vs = this.onGetValueSet(this, s, '');
          if (vs != null) {
            f = this.makeFilterForValueSet(cs, vs);
          }
          if (f != null) {
            filters.push(f);
          } else {
            valueSets.push(new ImportedValueSet(await this.expandValueSet(s, '', filter, notClosed)));
          }
        }

        if (!cset.concept && !cset.filter) {
          if (cs.specialEnumeration() && filters.length === 0) {
            this.worker.opContext.log('import special value set ' + cs.specialEnumeration());
            const base = await this.expandValueSet(cs.specialEnumeration(), '', filter, notClosed);
            Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", 'The code System "' + cs.system() + " has a grammar and so has infinite members. This extension is based on " + cs.specialEnumeration());
            await this.importValueSet(base, expansion, valueSets, 0);
            notClosed.value = true;
          } else if (filter.isNull) {
            this.worker.opContext.log('add whole code system');
            if (cs.isNotClosed()) {
              if (cs.specialEnumeration()) {
                Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", 'The code System "' + cs.system() + " has a grammar and so has infinite members. This extension is based on " + cs.specialEnumeration());
              } else {
                throw new Issue("error", "too-costly", null, null, 'The code System "' + cs.system() + '" has a grammar, and cannot be enumerated directly', null, 422).withDiagnostics(this.worker.opContext.diagnostics());
              }
              notClosed.value = true;
            }

            const iter = await cs.iterator(null);
            if (valueSets.length === 0 && this.limitCount > 0 && (iter && iter.total > this.limitCount) && this.offset < 0)  {
              throw new Issue("error", "too-costly", null, 'VALUESET_TOO_COSTLY', this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages, [vsSrc.vurl, '>' + this.limitCount]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());

            }
            let tcount = 0;
            let c = await cs.nextContext(iter);
            while (c) {
              this.worker.deadCheck('processCodes#3a');
              if (await this.passesFilters(cs, c, prep, filters, 0)) {
                tcount += await this.includeCodeAndDescendants(cs, c, expansion, valueSets, null, excludeInactive, vsSrc.vurl);
              }
              c = await cs.nextContext(iter);
            }
            this.addToTotal(tcount);
          } else {
            this.worker.opContext.log('prepare filters');
            this.noTotal();
            if (cs.isNotClosed(filter)) {
              notClosed.value = true;
            }
            const prep = await cs.getPrepContext(true);
            const ctxt = await cs.searchFilter(prep, filter, false);
            let set = await cs.executeFilters(prep);
            this.worker.opContext.log('iterate filters');
            while (await cs.filterMore(ctxt, set)) {
              const c = await cs.filterConcept(ctxt, set);
              this.worker.deadCheck('processCodes#4');
              if (await this.passesFilters(cs, c, prep, filters, 0)) {
                const cds = new Designations(this.worker.i18n.languageDefinitions);
                await this.listDisplaysFromProvider(cds, cs, c);
                await this.includeCode(cs, null, await cs.system(), await cs.version(), await cs.code(c), await cs.isAbstract(c), await cs.isInactive(c), await cs.deprecated(c), await cs.getStatus(c),
                  cds, await cs.definition(c), await cs.itemWeight(c), expansion, valueSets, await cs.extensions(c), null, await this._propsIfRequested(cs, c), null, excludeInactive, vsSrc.url);
              }
            }
            this.worker.opContext.log('iterate filters done');
          }
        }

        // --- Unified include: register all concepts + filters as intent, execute once ---
        const hasConcepts = cset.concept && cset.concept.length > 0;
        const hasFilters = cset.filter && cset.filter.length > 0;
        const canUnify = hasConcepts && typeof cs.includeConcepts === 'function';

        if (canUnify || hasFilters) {
          this.worker.opContext.log('prepare filters');
          // Per-CS LIMIT is safe: excludes are system-scoped, so excludes from
          // other systems can't drain this CS's results. The worker's overall
          // count management handles cross-system totals.
          const prep = cs.handlesOffset()
            ? await cs.getPrepContext(true, this.params, excludeInactive, this.offset, this.count)
            : await cs.getPrepContext(true, this.params, excludeInactive);
          if (!filter.isNull) {
            await cs.searchFilter(prep, filter, true);
          }

          if (cs.specialEnumeration()) {
            Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", 'The code System "' + cs.system() + " has a grammar and so has infinite members. This extension is based on " + cs.specialEnumeration());
            notClosed.value = true;
          }

          // Register include concepts
          if (canUnify) {
            await cs.includeConcepts(prep, cset.concept.map(c => c.code));
          }

          // Register include filters
          if (hasFilters) {
            const fcl = cset.filter;
            for (let i = 0; i < fcl.length; i++) {
              this.worker.deadCheck('processCodes#4a');
              const fc = fcl[i];
              if (!fc.value) {
                throw new Issue('error', 'invalid', path+".filter["+i+"]", 'UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE', this.worker.i18n.translate('UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE', this.params.httpLanguages, [cs.system(), fc.property, fc.op]), 'vs-invalid', 400);
              }
              Extensions.checkNoModifiers(fc, 'ValueSetExpander.processCodes', 'filter');
              await cs.filter(prep, fc.property, fc.op, fc.value);
            }
          }

          // Register all excludes (concepts + filters) for this system
          if (vsInfo && vsInfo.csDoExcludes && compose) {
            for (const exc of compose.exclude || []) {
              if (exc.system === cset.system) {
                if (exc.concept && exc.concept.length > 0) {
                  await cs.filterExcludeConcepts(prep, exc.concept.map(c => c.code));
                }
                const filterList = (exc.filter || []).map(f => ({ prop: f.property, op: f.op, value: f.value }));
                if (filterList.length > 0) {
                  await cs.filterExcludeFilters(prep, filterList);
                }
              }
            }
          }

          // Execute — provider sees full picture: all concepts, filters, excludes
          const fset = await cs.executeFilters(prep);
          if (await cs.filtersNotClosed(prep)) {
            notClosed.value = true;
          }

          // Build compose concept lookup for metadata merging
          const conceptDefs = new Map();
          if (hasConcepts) {
            for (const cc of cset.concept) {
              conceptDefs.set(cc.code, cc);
            }
          }

          // Iterate concept-list results first (if unified): preserves compose ordering + metadata
          if (canUnify) {
            this.worker.opContext.log('iterate concepts');
            const cds = new Designations(this.worker.i18n.languageDefinitions);
            for (const cc of cset.concept) {
              this.worker.deadCheck('processCodes#3');
              cds.clear();
              Extensions.checkNoModifiers(cc, 'ValueSetExpander.processCodes', 'set concept reference');
              const located = await cs.locate(cc.code);
              const ctx = located?.context || null;
              if (ctx && (!this.params.activeOnly || !await cs.isInactive(ctx))) {
                await this.listDisplaysFromProvider(cds, cs, ctx);
                this.listDisplaysFromIncludeConcept(cds, cc, vsSrc);
                if (filter.passesDesignations(cds) || filter.passes(cc.code)) {
                  let ov = Extensions.readString(cc, 'http://hl7.org/fhir/StructureDefinition/itemWeight');
                  if (!ov) {
                    ov = await cs.itemWeight(ctx);
                  }
                  let added = await this.includeCode(cs, null, cs.system(), cs.version(), cc.code, await cs.isAbstract(ctx), await cs.isInactive(ctx), await cs.isDeprecated(ctx), await cs.getStatus(ctx), cds,
                    await cs.definition(ctx), ov, expansion, valueSets, await cs.extensions(ctx), cc.extension, await this._propsIfRequested(cs, ctx), null, excludeInactive, vsSrc.url);
                  if (added) {
                    this.addToTotal();
                  }
                }
              }
            }
            this.worker.opContext.log('iterate concepts done');
          }

          // Iterate filter results (if any filters were registered)
          if (hasFilters && fset.length > 0) {
            this.worker.opContext.log('iterate filters');
            while (await cs.filterMore(prep, fset[0])) {
              const c = await cs.filterConcept(prep, fset[0]);
              this.worker.deadCheck('processCodes#5');
              // Skip codes already emitted from concept list
              if (canUnify && conceptDefs.has(await cs.code(c))) continue;
              const ok = (!this.params.activeOnly || !await cs.isInactive(c)) && (await this.passesFilters(cs, c, prep, fset, 1));
              if (ok) {
                const cds = new Designations(this.worker.i18n.languageDefinitions);
                if (this.passesImports(valueSets, cs.system(), await cs.code(c), 0)) {
                  await this.listDisplaysFromProvider(cds, cs, c);
                  let parent = null;
                  if (cs.hasParents()) {
                    parent = this.map.get(this.keyS(cs.system(), cs.version(), await cs.parent(c)));
                  } else {
                    this.canBeHierarchy = false;
                  }
                  let added = await this.includeCode(cs, parent, await cs.system(), await cs.version(), await cs.code(c), await cs.isAbstract(c), await cs.isInactive(c),
                    await cs.isDeprecated(c), await cs.getStatus(c), cds, await cs.definition(c), await cs.itemWeight(c),
                    expansion, null, await cs.extensions(c), null, await this._propsIfRequested(cs, c), null, excludeInactive, vsSrc.url);
                  if (added) {
                    this.addToTotal();
                  }
                }
              }
            }
            this.worker.opContext.log('iterate filters done');
          }
        } else if (hasConcepts) {
          // Fallback for providers without includeConcepts (non-v0)
          this.worker.opContext.log('iterate concepts');
          const cds = new Designations(this.worker.i18n.languageDefinitions);
          for (const cc of cset.concept) {
            this.worker.deadCheck('processCodes#3');
            cds.clear();
            Extensions.checkNoModifiers(cc, 'ValueSetExpander.processCodes', 'set concept reference');
            let cctxt = await cs.locate(cc.code, this.allAltCodes);
            if (cctxt && cctxt.context && (!this.params.activeOnly || !await cs.isInactive(cctxt.context)) && await this.passesFilters(cs, cctxt.context, prep, filters, 0)) {
              await this.listDisplaysFromProvider(cds, cs, cctxt.context);
              this.listDisplaysFromIncludeConcept(cds, cc, vsSrc);
              if (filter.passesDesignations(cds) || filter.passes(cc.code)) {
                let ov = Extensions.readString(cc, 'http://hl7.org/fhir/StructureDefinition/itemWeight');
                if (!ov) {
                  ov = await cs.itemWeight(cctxt.context);
                }
                let added = await this.includeCode(cs, null, cs.system(), cs.version(), cc.code, await cs.isAbstract(cctxt.context), await cs.isInactive(cctxt.context), await cs.isDeprecated(cctxt.context), await cs.getStatus(cctxt.context), cds,
                  await cs.definition(cctxt.context), ov, expansion, valueSets, await cs.extensions(cctxt.context), cc.extension, await this._propsIfRequested(cs, cctxt.context), null, excludeInactive, vsSrc.url);
                if (added) {
                  this.addToTotal();
                }
              }
            }
          }
          this.worker.opContext.log('iterate concepts done');
        }
      }
    }
  }

  async passesFilters(cs, c, prep, filters, offset) {
    for (let j = offset; j < filters.length; j++) {
      const f = filters[j];
      // if (f instanceof SpecialProviderFilterContextNothing) {
      //   return false;
      // } else if (f instanceof SpecialProviderFilterContextConcepts) {
      //   let ok = false;
      //   for (const t of f.list) {
      //     if (cs.sameContext(t, c)) {
      //       ok = true;
      //     }
      //   }
      //   if (!ok) return false;
      // } else {
        let ok = await cs.filterCheck(prep, f, c);
        if (ok != true) {
          return false;
        }
      // }
    }
    return true;
  }

  async _propsIfRequested(cs, context) {
    if (this.params.properties.length) {
      perfCounters.bump('props.loaded');
      return await cs.properties(context);
    }
    perfCounters.bump('props.skipped');
    return null;
  }

  async excludeCodes(cset, path, vsSrc, filter, expansion, excludeInactive, notClosed) {
    this.worker.deadCheck('processCodes#1');
    const valueSets = [];

    Extensions.checkNoModifiers(cset, 'ValueSetExpander.processCodes', 'set');

    if (cset.valueSet || cset.concept || (cset.filter || []).length > 1) {
      this.canBeHierarchy = false;
    }

    if (!cset.system) {
      if (cset.valueSet) {
        this.noTotal();
        for (const u of cset.valueSet) {
          const s = this.worker.pinValueSet(u);
          this.worker.deadCheck('processCodes#2');
          const ivs = new ImportedValueSet(await this.expandValueSet(s, '', filter, notClosed));
          this.checkResourceCanonicalStatus(expansion, ivs.valueSet, this.valueSet);
          this.addParamUri(expansion, 'used-valueset', ivs.valueSet.vurl);
          valueSets.push(ivs);
        }
        this.excludeValueSet(valueSets[0].valueSet, expansion, valueSets, 1);
      }
    } else {
      const filters = [];
      const prep = null;
      const cs = await this.worker.findCodeSystem(cset.system, cset.version, this.params, ['complete', 'fragment'], false,
        true, true, null, this.requiredSupplements);

      this.worker.checkSupplements(cs, cset, this.requiredSupplements, this.usedSupplements);
      this.checkResourceCanonicalStatus(expansion, cs, this.valueSet);
      const sv = this.canonical(await cs.system(), await cs.version());
      this.addParamUri(expansion, 'used-codesystem', sv);

      for (const u of cset.valueSet || []) {
        const s = this.pinValueSet(u);
        this.worker.deadCheck('processCodes#3');
        let f = null;
        const vs = this.onGetValueSet(this, s, '');
        if (vs != null) {
          f = this.makeFilterForValueSet(cs, vs);
        }
        if (f != null) {
          filters.push(f);
        } else {
          valueSets.push(new ImportedValueSet(await this.expandValueSet(s, '', filter, notClosed)));
        }
      }

      if (!cset.concept && !cset.filter) {
        this.opContext.log('handle system');
        if (cs.specialEnumeration() && filters.length === 0) {
          const base = await this.expandValueSet(cs.specialEnumeration(), '', filter, notClosed);
          Extensions.addBoolean(expansion, 'http://hl7.org/fhir/StructureDefinition/valueset-toocostly', true);
          this.excludeValueSet(base, expansion, valueSets, 0);
          notClosed.value = true;
        } else if (filter.isNull) {
          if (cs.isNotClosed(filter)) {
            if (cs.specialEnumeration()) {
              Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", 'The code System "' + cs.system() + " has a grammar and so has infinite members. This extension is based on " + cs.specialEnumeration());
            } else {
              throw new Issue("error", "too-costly", null, null, 'The code System "' + cs.system() + '" has a grammar, and cannot be enumerated directly', null, 422).withDiagnostics(this.worker.opContext.diagnostics());
            }
          }

          const iter = await cs.getIterator(null);
          if (valueSets.length === 0 && this.limitCount > 0 && iter.count > this.limitCount) {
            throw new Issue("error", "too-costly", null, 'VALUESET_TOO_COSTLY', this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages, [vsSrc.url, '>' + this.limitCount]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());
          }
          while (iter.more()) {
            this.worker.deadCheck('processCodes#3a');
            const c = await cs.getNextContext(iter);
            if (await this.passesFilters(cs, c, prep, filters, 0)) {
              await this.excludeCodeAndDescendants(cs, c, expansion, valueSets, excludeInactive, vsSrc.url);
            }
          }
        } else {
          this.noTotal();
          if (cs.isNotClosed(filter)) {
            notClosed.value = true;
          }
          const prep = await cs.getPrepContext(true);
          const ctxt = await cs.searchFilter(prep, filter, false);
          await cs.prepare(prep);
          while (await cs.filterMore(ctxt)) {
            this.worker.deadCheck('processCodes#4');
            const c = await cs.filterConcept(ctxt);
            if (await this.passesFilters(cs, c, prep, filters, 0)) {
              this.excludeCode(cs, await cs.system(), await cs.version(), await cs.code(c), expansion, valueSets, vsSrc.url);
            }
          }
        }
      }

      if (cset.concept) {
        this.worker.opContext.log('iterate concepts');
        const cds = new Designations(this.worker.i18n.languageDefinitions);
        for (const cc of cset.concept) {
          this.worker.deadCheck('processCodes#3');
          cds.clear();
          Extensions.checkNoModifiers(cc, 'ValueSetExpander.processCodes', 'set concept reference');
          const cctxt = await cs.locate(cc.code, this.allAltCodes);
          if (cctxt && cctxt.context && (!this.params.activeOnly || !await cs.isInactive(cctxt)) && await this.passesFilters(cs, cctxt, prep, filters, 0)) {
            if (filter.passesDesignations(cds) || filter.passes(cc.code)) {
              let ov = Extensions.readString(cc, 'http://hl7.org/fhir/StructureDefinition/itemWeight');
              if (!ov) {
                ov = await cs.itemWeight(cctxt.context);
              }
              this.excludeCode(cs, await cs.system(), await cs.version(), cc.code, expansion, valueSets, vsSrc.url);
            }
          }
        }
      }

      if (cset.filter) {
        this.worker.opContext.log('prep filters');
        const prep = await cs.getPrepContext(true);
        if (!filter.isNull) {
          await cs.searchFilter(prep, filter, true);
        }

        if (cs.specialEnumeration()) {
          await cs.specialFilter(prep, true);
          Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", 'The code System "' + cs.system() + " has a grammar and so has infinite members. This extension is based on " + cs.specialEnumeration());
        }

        for (let fc of cset.filter) {
          this.worker.deadCheck('processCodes#4a');
          Extensions.checkNoModifiers(fc, 'ValueSetExpander.processCodes', 'filter');
          await cs.filter(prep, fc.property, fc.op, fc.value);
        }

        this.worker.opContext.log('iterate filters');
        const fset = await cs.executeFilters(prep);
        if (await cs.filtersNotClosed(prep)) {
          notClosed.value = true;
        }
        //let count = 0;
        while (await cs.filterMore(prep, fset[0])) {
          this.worker.deadCheck('processCodes#5');
          const c = await cs.filterConcept(prep, fset[0]);
          const ok = (!this.params.activeOnly || !await cs.isInactive(c)) && (await this.passesFilters(cs, c, prep, fset, 1));
          if (ok) {
            //count++;
            if (this.passesImports(valueSets, await cs.system(), await cs.code(c), 0)) {
              this.excludeCode(cs, await cs.system(), await cs.version(), await cs.code(c), expansion, null, vsSrc.url);
            }
          }
        }
        this.worker.opContext.log('iterate filters finished');
      }
    }
  }

  async includeCodeAndDescendants(cs, context, expansion, imports, parent, excludeInactive, srcUrl) {
    let result = 0;
    this.worker.deadCheck('processCodeAndDescendants');

    if (expansion) {
      const vs = this.canonical(await cs.system(), await cs.version());
      this.addParamUri(expansion, 'used-codesystem', vs);
      const ts = cs.listSupplements();
      for (const v of ts) {
        this.worker.deadCheck('processCodeAndDescendants');
        this.addParamUri(expansion, 'used-supplement', v);
      }
    }

    let n = null;
    if ((!this.params.excludeNotForUI || !await cs.isAbstract(context)) && (!this.params.activeOnly || !await cs.isInactive(context))) {
      const cds = new Designations(this.worker.i18n.languageDefinitions);
      await this.listDisplaysFromProvider(cds, cs, context);
      const t = await this.includeCode(cs, parent, await cs.system(), await cs.version(), context.code, await cs.isAbstract(context), await cs.isInactive(context), await cs.isDeprecated(context), await cs.getStatus(context), cds, await cs.definition(context),
        await cs.itemWeight(context), expansion, imports, await cs.extensions(context), null, await this._propsIfRequested(cs, context), null, excludeInactive, srcUrl);
      if (t != null) {
        result++;
      }
      if (n == null) {
        n = t;
      }
    } else {
      n = parent;
    }

    const iter = await cs.iterator(context);
    if (iter) {
      let c = await cs.nextContext(iter);
      while (c) {
        this.worker.deadCheck('processCodeAndDescendants#3');
        result += await this.includeCodeAndDescendants(cs, c, expansion, imports, n, excludeInactive, srcUrl);
        c = await cs.nextContext(iter);
      }
    }
    return result;
  }

  async excludeCodeAndDescendants(cs, context, expansion, imports, excludeInactive, srcUrl) {
    this.worker.deadCheck('processCodeAndDescendants');

    if (expansion) {
      const vs = this.canonical(await cs.system(), await cs.version());
      this.addParamUri(expansion, 'used-codesystem', vs);
      const ts= cs.listSupplements();
      for (const v of ts) {
        this.worker.deadCheck('processCodeAndDescendants');
        this.addParamUri(expansion, 'used-supplement', v);
      }
    }

    if ((!this.params.excludeNotForUI || !await cs.isAbstract(context)) && (!this.params.activeOnly || !await cs.isInactive(context))) {
      const cds = new Designations(this.worker.i18n.languageDefinitions);
      await this.listDisplaysFromProvider(cds, cs, context);
      for (const code of await cs.listCodes(context, this.params.altCodeRules)) {
        this.worker.deadCheck('processCodeAndDescendants#2');
        this.excludeCode(cs, await cs.system(), await cs.version(), code, expansion, imports, srcUrl);
      }
    }

    const iter = await cs.getIterator(context);
    while (iter.more()) {
      this.worker.deadCheck('processCodeAndDescendants#3');
      const c = await cs.getNextContext(iter);
      await this.excludeCodeAndDescendants(cs, c, expansion, imports, excludeInactive, srcUrl);
    }
  }

  async handleCompose(source, filter, expansion, notClosed) {
    this.worker.opContext.log('compose #1');

    const compose = source.jsonObj.compose;
    const vsInfo = this.scanValueSet(compose);

    const ts = new Map();
    for (const c of compose.include || []) {
      this.worker.deadCheck('handleCompose#2');
      await this.checkSource(c, expansion, filter, source.url, ts, vsInfo);
    }
    for (const c of compose.exclude || []) {
      this.worker.deadCheck('handleCompose#3');
      this.hasExclusions = true;
      await this.checkSource(c, expansion, filter, source.url, ts, null);
    }

    this.worker.opContext.log('compose #2');

    const excludeInactive = this.excludeInactives(source);

    // Process excludes — only iterate when the provider does NOT handle excludes itself.
    // When csDoExcludes is true, excludes are handled in SQL via filterExcludeFilters/executeFilters
    // inside includeCodes, so iterating them here would be redundant work.
    if (!vsInfo.csDoExcludes) {
      let j = 0;
      for (const c of compose.exclude || []) {
        this.worker.deadCheck('handleCompose#4');
        await this.excludeCodes(c, "ValueSet.compose.exclude["+j+"]", source, filter, expansion, excludeInactive, notClosed);
        j++;
      }
    }

    let i = 0;
    for (const c of compose.include || []) {
      this.worker.deadCheck('handleCompose#5');
      await this.includeCodes(c, "ValueSet.compose.include["+i+"]", source, filter, expansion, excludeInactive, notClosed, compose, vsInfo);
      i++;
    }
  }

  excludeInactives(source) {
    return source.jsonObj.compose && source.jsonObj.compose.inactive != undefined && !source.jsonObj.compose.inactive;
  }

  async expand(source, filter, noCacheThisOne) {
    this.noCacheThisOne = noCacheThisOne;
    this.totalStatus = 'uninitialised';
    this.total = 0;

    Extensions.checkNoImplicitRules(source,'ValueSetExpander.Expand', 'ValueSet');
    Extensions.checkNoModifiers(source,'ValueSetExpander.Expand', 'ValueSet');
    this.worker.seeValueSet(source, this.params);
    this.valueSet = source;

    const result = structuredClone(source.jsonObj);
    result.id = undefined;
    let table = null;
    let div_ = null;

    if (!this.params.includeDefinition) {
      result.purpose = undefined;
      result.compose = undefined;
      result.description = undefined;
      result.contactList = undefined;
      result.copyright = undefined;
      result.publisher = undefined;
      result.extension = undefined;
      result.text = undefined;
    }

    for (let s of this.params.supplements) this.requiredSupplements.add(s);
    for (const ext of Extensions.list(source.jsonObj, 'http://hl7.org/fhir/StructureDefinition/valueset-supplement')) {
      this.requiredSupplements.add(getValuePrimitive(ext));
    }

    if (result.expansion) {
      return result; // just return the expansion
    }

    if (this.params.generateNarrative) {
      div_ = div();
      table = div_.table("grid");
    } else {
      result.text = undefined;
    }

    this.map = new Map();
    this.rootList = [];
    this.fullList = [];
    this.canBeHierarchy = !this.params.excludeNested;

    if (this.params.limit <= 0) {
      if (!filter.isNull) {
        this.limitCount = UPPER_LIMIT_TEXT;
      } else {
        this.limitCount = UPPER_LIMIT_NO_TEXT;
      }
    } else {
      this.limitCount = Math.min(this.params.limit, INTERNAL_LIMIT);
    }
    this.offset = this.params.offset;
    this.count = this.params.count;

    if (this.params.offset > 0) {
      this.canBeHierarchy = false;
    }

    const exp = {};
    exp.timestamp = new Date().toISOString();
    exp.identifier = 'urn:uuid:' + crypto.randomUUID();
    result.expansion = exp;

    if (!filter.isNull) {
      this.addParamStr(exp, 'filter', filter.filter);
    }

    if (this.params.DisplayLanguages) {
      this.addParamCode(exp, 'displayLanguage', this.params.DisplayLanguages.asString(true));
    } else if (this.params.HTTPLanguages) {
      this.addParamCode(exp, 'displayLanguage', this.params.HTTPLanguages.asString(true));
    }
    if (this.params.designations) {
      for (const s of this.params.designations) {
        this.addParamStr(exp, 'designation', s);
      }
    }
    if (this.params.hasExcludeNested) {
      this.addParamBool(exp, 'excludeNested', this.params.excludeNested);
    }
    if (this.params.hasActiveOnly) {
      this.addParamBool(exp, 'activeOnly', this.params.activeOnly);
    }
    if (this.params.hasIncludeDesignations) {
      this.addParamBool(exp, 'includeDesignations', this.params.includeDesignations);
    }
    if (this.params.hasIncludeDefinition) {
      this.addParamBool(exp, 'includeDefinition', this.params.includeDefinition);
    }
    if (this.params.hasExcludeNotForUI) {
      this.addParamBool(exp, 'excludeNotForUI', this.params.excludeNotForUI);
    }
    if (this.params.hasExcludePostCoordinated) {
      this.addParamBool(exp, 'excludePostCoordinated', this.params.excludePostCoordinated);
    }

    this.checkResourceCanonicalStatus(exp, source, source);

    if (this.offset > -1) {
      this.addParamInt(exp,'offset', this.offset);
      exp.offset = this.offset;
    }
    if (this.count > -1) {
      this.addParamInt(exp, 'count', this.count);
    }
    if (this.count > 0 && this.offset === -1) {
      this.offset = 0;
    }

    this.worker.opContext.log('start working');
    this.worker.deadCheck('expand');

    let notClosed = { value :  false};

    try {
      if (source.jsonObj.compose && Extensions.checkNoModifiers(source.jsonObj.compose, 'ValueSetExpander.Expand', 'compose')
          && this.worker.checkNoLockedDate(source.url, source.jsonObj.compose)) {
        await this.handleCompose(source, filter, exp, notClosed);
      }

      const unused = new Set([...this.requiredSupplements].filter(s => !this.usedSupplements.has(s)));
      if (unused.size > 0) {
        throw new Issue('error', 'not-found', null, 'VALUESET_SUPPLEMENT_MISSING', this.worker.i18n.translatePlural(unused.size, 'VALUESET_SUPPLEMENT_MISSING', this.params.HTTPLanguages, [[...unused].join(',')]), 'not-found').handleAsOO(422);
      }
    } catch (e) {
      if (e instanceof Issue) {
        if (e.finished) {
          // nothing - we're just trapping this
          if (this.totalStatus === 'uninitialised') {
            this.totalStatus = 'off';
          } else if (e.toocostly) {
            Extensions.addBoolean(exp, 'http://hl7.org/fhir/StructureDefinition/valueset-toocostly', 'value', true);
            if (table != null) {
              div_.p().style('color: Maroon').tx(e.message);
            }
          } else {
            // nothing- swallow it
          }
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }

    this.worker.opContext.log('finish up');

    let list;
    if (notClosed.value) {
      if (!Extensions.has(exp, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed')) {
        Extensions.addBoolean(exp, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed', true);
      }
      if (this.totalStatus === 'set' && this.total > -1) {
        exp.total = this.total;
      }
      list = this.fullList;
      for (const c of this.fullList) {
        c.contains = undefined;
      }
      if (table != null) {
        div_.addTag('p').setAttribute('style', 'color: Navy').tx('Because of the way that this value set is defined, not all the possible codes can be listed in advance');
      }
    } else {
      if (this.totalStatus === 'off' || this.total === -1) {
        this.canBeHierarchy = false;
      } else if (this.total > 0) {
        exp.total = this.total;
      } else {
        exp.total = this.fullList.length;
      }

      if (this.canBeHierarchy && (this.count < 0 || this.count > this.fullList.length)) {
        list = this.rootList;
      } else {
        list = this.fullList;
        for (const c of this.fullList) {
          c.contains = undefined;
        }
      }
    }

    if (this.offset + this.count < 0 && this.fullList.length > this.limit) {
      this.log.log('Operation took too long @ expand (' + this.constructor.name + ')');
      throw new Issue("error", "too-costly", null, 'VALUESET_TOO_COSTLY', this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages, [source.vurl, '>' + this.limit]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());
    } else {
      let t = 0;
      let o = 0;
      for (let i = 0; i < list.length; i++) {
        this.worker.deadCheck('expand#1');
        const c = list[i];
        if (this.map.has(this.keyC(c))) {
          o++;
          if (o > this.offset && (this.count < 0 || t < this.count)) {
            t++;
            if (!exp.contains) {
              exp.contains = [];
            }
            exp.contains.push(c);
            if (table != null) {
              const tr = table.tr();
              tr.td().tx(c.system);
              tr.td().tx(c.code);
              tr.td().tx(c.display);
            }
          }
        }
      }
    }

    for (const s of this.worker.foundParameters) {
      const [l, r] = s.split('=');
      if (r != source.vurl) {
        this.addParamUri(exp, l, r);
      }
    }

    return result;
  }

  checkResourceCanonicalStatus(exp, resource, source) {
    if (resource.jsonObj) {
      resource = resource.jsonObj;
    }
    this.checkCanonicalStatus(exp, this.worker.makeVurl(resource), resource.status, Extensions.readString(resource, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'), resource.experimental, source);
  }

  checkProviderCanonicalStatus(exp, cs, source) {
    let status = cs.status();
    this.checkCanonicalStatus(exp, cs.vurl(), status.status, status.standardsStatus, status.experimental, source);
  }

  checkCanonicalStatus(exp, vurl, status, standardsStatus, experimental, source) {
    if (standardsStatus == 'deprecated') {
      this.addParamUri(exp, 'warning-deprecated', vurl);
    } else if (standardsStatus == 'withdrawn') {
      this.addParamUri(exp, 'warning-withdrawn', vurl);
    } else if (status == 'retired') {
      this.addParamUri(exp, 'warning-retired', vurl);
    } else if (experimental && !source.experimental) {
      this.addParamUri(exp, 'warning-experimental', vurl)
    } else if (((status == 'draft') || (standardsStatus == 'draft')) &&
      !((source.status == 'draft') || (Extensions.readString(source, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status') == 'draft'))) {
      this.addParamUri(exp, 'warning-draft', vurl)
    }
  }

  addParamStr(exp, name, value) {
    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      exp.parameter.push({name: name, valueString: value});
    }
  }

  addParamBool(exp, name, value) {
    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      exp.parameter.push({name: name, valueBoolean: value});
    }
  }

  addParamCode(exp, name, value) {
    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      exp.parameter.push({name: name, valueCode: value});
    }
  }

  addParamInt(exp, name, value) {
    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      exp.parameter.push({name: name, valueInteger: value});
    }
  }

  addParamUri(exp, name, value) {
    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      exp.parameter.push({name: name, valueUri: value});
    }
  }

  addParam(exp, name, valueName, value) {
    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      let p = {name: name}
      exp.parameter.push(p);
      p[valueName] = value;
    }
  }


  hasParam(exp, name, value) {
    return (exp.parameter || []).find((ex => ex.name == name && getValuePrimitive(ex) == value));
  }

  isExcluded(system, version, code) {
    return this.excluded.has(system+'|'+version+'#'+code);
  }

  keyS(system, version, code) {
    return system+"~"+(this.doingVersion ? version+"~" : "")+code;
  }

  keyC(contains) {
    return this.keyS(contains.system, contains.version, contains.code);
  }

  defineProperty(expansion, contains, url, code, valueName, value) {
    if (value === undefined || value == null) {
      return;
    }
    // we only define it if the code system has a definition
    if (url) {
      if (!expansion.property) {
        expansion.property = [];
      }
      let pd = expansion.property.find(t1 => t1.uri == url || t1.code == code);
      if (!pd) {
        pd = {};
        expansion.property.push(pd);
        pd.uri = url;
        pd.code = code;
      } else if (!pd.uri) {
        pd.uri = url
      }
      if (pd.uri != url) {
        throw new Error('URL mismatch on expansion: ' + pd.uri + ' vs ' + url + ' for code ' + code);
      } else {
        code = pd.code;
      }
    }

    if (!contains.property) {
      contains.property = [];
    }
    let pdv = contains.property.find(t2 => t2.code == code);
    if (!pdv) {
      pdv = {};
      contains.property.push(pdv);
      pdv.code = code;
    }
    pdv[valueName] = value;
  }

  addToTotal(t = 1) {
    if (this.total > -1 && this.totalStatus != "off") {
      this.total = this.total + t;
      this.totalStatus = 'set';
    }
  }

  decTotal(t= 1) {
    if (this.total > -1 && this.totalStatus != "off") {
      this.total = this.total - t;
      this.totalStatus = 'set';
    }
  }

  noTotal() {
    this.total = -1;
    this.totalStatus = 'off';
  }

  getPropUrl(cs, pn, cp) {
    if (cp.definition?.uri) {
      return cp.definition.uri;
    }
    for (let p of cs.propertyDefinitions()) {
      if (pn == p.code) {
        return p.uri;
      }
    }
    return undefined;
  }

  /**
   * Scan the ValueSet compose to determine if it's "simple" — all one code system
   * with no value set dependencies. This affects whether excludes/offset can be
   * pushed down to the CS provider.
   */
  scanValueSet(compose) {
    const result = { isSimple: false, hasExcludes: false, csset: new Set(), csDoExcludes: false, csDoOffset: false };
    let simple = true;
    for (const inc of compose.include || []) {
      if (!this._isSimpleInclude(inc, result.csset, false)) {
        simple = false;
      }
    }
    for (const exc of compose.exclude || []) {
      if (!this._isSimpleInclude(exc, result.csset, true)) {
        simple = false;
      }
      result.hasExcludes = true;
    }
    if (simple && result.csset.size === 1) {
      result.isSimple = true;
    }
    return result;
  }

  _isSimpleInclude(inc, set, isExclude) {
    set.add(inc.system + '|' + (inc.version || ''));
    return (!inc.valueSet || inc.valueSet.length === 0)
      && ((inc.filter && inc.filter.length > 0) || (isExclude && inc.concept && inc.concept.length > 0));
  }

  excludeFilterList(exc) {
    const results = [];
    for (const f of exc.filter || []) {
      results.push({ prop: f.property, op: f.op, value: f.value });
    }
    return results;
  }
}

class ExpandWorker extends TerminologyWorker {

  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for code systems and resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
  }

  /**
   * Get operation name
   * @returns {string}
   */
  opName() {
    return 'expand';
  }

  /**
   * Handle a type-level $expand request
   * GET/POST /ValueSet/$expand
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handle(req, res) {
    try {
      await this.handleTypeLevelExpand(req, res);
    } catch (error) {
      this.log.error(error);
      this.debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(error.msgId  ? " "+error.msgId : "");
      const statusCode = error.statusCode || 500;
      if (error instanceof Issue) {
        let oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      } else {
        const issueCode = error.issueCode || 'exception';
        return res.status(statusCode).json({
          resourceType: 'OperationOutcome',
          issue: [{
            severity: 'error',
            code: issueCode,
            details: {
              text: error.message
            },
            diagnostics: error.message
          }]
        });
      }
    }
  }

  /**
   * Handle an instance-level $expand request
   * GET/POST /ValueSet/{id}/$expand
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handleInstance(req, res) {
    try {
      await this.handleInstanceLevelExpand(req, res);
    } catch (error) {
      this.log.error(error);
      this.debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(error.msgId  ? " "+error.msgId : "");
      const statusCode = error.statusCode || 500;
      const issueCode = error.issueCode || 'exception';
      return res.status(statusCode).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: issueCode,
          details: {
            text : error.message
          },
          diagnostics: error.message
        }]
      });
    }
  }

  /**
   * Handle type-level expand: /ValueSet/$expand
   * ValueSet identified by url, or provided directly in body
   */
  async handleTypeLevelExpand(req, res) {
    this.deadCheck('expand-type-level');

    // Determine how the request is structured
    let valueSet = null;
    let params = null;

    if (req.method === 'POST' && req.body) {
      if (req.body.resourceType === 'ValueSet') {
        // Body is directly a ValueSet resource
        valueSet = new ValueSet(req.body);
        params = this.queryToParameters(req.query);
        this.seeSourceVS(valueSet);

      } else if (req.body.resourceType === 'Parameters') {
        // Body is a Parameters resource
        params = req.body;

        // Check for valueSet parameter
        const valueSetParam = this.findParameter(params, 'valueSet');
        if (valueSetParam && valueSetParam.resource) {
          valueSet = new ValueSet(valueSetParam.resource);
          this.seeSourceVS(valueSet);
        }

      } else {
        // Assume form body - convert to Parameters
        params = this.formToParameters(req.body, req.query);
      }
    } else {
      // GET request - convert query to Parameters
      params = this.queryToParameters(req.query);
    }
    this.addHttpParams(req, params);

    // Check for context parameter - not supported yet
    const contextParam = this.findParameter(params, 'context');
    if (contextParam) {
      return res.status(400).json(this.operationOutcome('error', 'not-supported',
        'The context parameter is not yet supported'));
    }

    // Handle tx-resource and cache-id parameters
    this.setupAdditionalResources(params);
    const logExtraOutput = this.findParameter(params, 'logExtraOutput');

    let txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n, false);
    txp.readParams(params);

    // If no valueSet yet, try to find by url
    if (!valueSet) {
      const urlParam = this.findParameter(params, 'url');
      const versionParam = this.findParameter(params, 'valueSetVersion');

      if (!urlParam) {
        return res.status(400).json(this.operationOutcome('error', 'invalid',
          'Must provide either a ValueSet resource or a url parameter'));
      }

      const url = this.getParameterValue(urlParam);
      const version = versionParam ? this.getParameterValue(versionParam) : null;

      valueSet = await this.findValueSet(url, version);
      this.seeSourceVS(valueSet, url);
      if (!valueSet) {
        return res.status(422).json(this.operationOutcome('error', 'not-found',
          version ? `ValueSet not found: ${url} version ${version}` : `ValueSet not found: ${url}`));
      }
    }

    // Perform the expansion
    const result = await this.doExpand(valueSet, txp, logExtraOutput);
    req.logInfo = this.usedSources.join("|")+txp.logInfo();
    return res.json(result);
  }
  
  /**
   * Handle instance-level expand: /ValueSet/{id}/$expand
   * ValueSet identified by resource ID
   */
  async handleInstanceLevelExpand(req, res) {
    this.deadCheck('expand-instance-level');

    const { id } = req.params;

    // Find the ValueSet by ID
    const valueSet = await this.provider.getValueSetById(this.opContext, id);

    if (!valueSet) {
      return res.status(422).json(this.operationOutcome('error', 'not-found',
        `ValueSet/${id} not found`));
    }

    // Parse parameters
    let params;
    if (req.method === 'POST' && req.body) {
      if (req.body.resourceType === 'Parameters') {
        params = req.body;
      } else {
        // Form body
        params = this.formToParameters(req.body, req.query);
      }
    } else {
      params = this.queryToParameters(req.query);
    }

    // Check for context parameter - not supported yet
    const contextParam = this.findParameter(params, 'context');
    if (contextParam) {
      return res.status(400).json(this.operationOutcome('error', 'not-supported',
        'The context parameter is not yet supported'));
    }

    // Handle tx-resource and cache-id parameters
    this.setupAdditionalResources(params);
    const logExtraOutput = this.findParameter(params, 'logExtraOutput');

    let txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n, false);
    txp.readParams(params);

    // Perform the expansion
    const result = await this.doExpand(valueSet, txp, logExtraOutput);
    req.logInfo = this.usedSources.join("|")+txp.logInfo();
    return res.json(result);
  }

  // Note: setupAdditionalResources, queryToParameters, formToParameters,
  // findParameter, getParameterValue, and wrapRawResource are inherited
  // from TerminologyWorker base class

  /**
   * Perform the actual expansion operation
   * Uses expansion cache for expensive operations
   * @param {Object} valueSet - ValueSet resource to expand
   * @param {Object} params - Parameters resource with expansion options
   * @returns {Object} Expanded ValueSet resource
   */
  async doExpand(valueSet, params, logExtraOutput) {
    this.deadCheck('doExpand');

    const expansionCache = this.opContext.expansionCache;
    // Compute cache key (only if caching is available and not debugging)
    let cacheKey = null;
    if (expansionCache && (CACHE_WHEN_DEBUGGING || !this.opContext.debugging)) {
      cacheKey = expansionCache.computeKey(valueSet, params, this.additionalResources);

      // Check for cached expansion
      const cached = expansionCache.get(cacheKey);
      if (cached) {
        this.log.debug('Using cached expansion');
        return cached;
      }
    }

    // Perform the actual expansion
    const startTime = performance.now();
    const result = await this.performExpansion(valueSet, params, logExtraOutput);
    const durationMs = performance.now() - startTime;

    // Cache if it took long enough (and not debugging)
    if (cacheKey && expansionCache && (CACHE_WHEN_DEBUGGING || !this.opContext.debugging)) {
      const wasCached = expansionCache.set(cacheKey, result, durationMs);
      if (wasCached) {
        this.log.debug(`Cached expansion (took ${Math.round(durationMs)}ms)`);
      }
    }

    return result;
  }

  /**
   * Perform the actual expansion logic
   * @param {Object} valueSet - ValueSet resource to expand
   * @param {Object} params - Parameters resource with expansion options
   * @returns {Object} Expanded ValueSet resource
   */
  async performExpansion(valueSet, params, logExtraOutput) {
    this.deadCheck('performExpansion');

    // Store params for worker methods
    this.params = params;

    if (params.limit < -1) {
      params.limit = -1;
    } else if (params.limit > UPPER_LIMIT_TEXT) {
      params.limit = UPPER_LIMIT_TEXT; // can't ask for more than this externally, though you can internally
    }

    const filter = new SearchFilterText(params.filter);
    const expander = new ValueSetExpander(this, params);
    expander.logExtraOutput = logExtraOutput;
    return await expander.expand(valueSet, filter);
  }

  /**
   * Generate a UUID
   * @returns {string} UUID
   */
  generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Build an OperationOutcome
   * @param {string} severity - error, warning, information
   * @param {string} code - Issue code
   * @param {string} message - Diagnostic message
   * @returns {Object} OperationOutcome resource
   */
  operationOutcome(severity, code, message) {
    return {
      resourceType: 'OperationOutcome',
      issue: [{
        severity,
        code,
        diagnostics: message
      }]
    };
  }

}

module.exports = {
  ExpandWorker,
  ValueSetExpander,
  ValueSetCounter,
  ImportedValueSet,
  ValueSetFilterContext,
  EmptyFilterContext,
  TotalStatus,
  UPPER_LIMIT_NO_TEXT,
  UPPER_LIMIT_TEXT,
  INTERNAL_LIMIT,
  EXPANSION_DEAD_TIME_SECS
};