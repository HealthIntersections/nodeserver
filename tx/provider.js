const { CodeSystem } = require("./library/codesystem");
const {VersionUtilities} = require("../library/version-utilities");
const { FhirCodeSystemProvider} = require("./cs/cs-cs");
const {OperationContext} = require("./operation-context");
const {TerminologyError} = require("./library/errors");
const {validateParameter, validateOptionalParameter, validateArrayParameter} = require("../library/utilities");
const path = require("path");
const {PackageContentLoader} = require("../library/package-manager");
const {PackageValueSetProvider} = require("./vs/vs-package");
const ValueSet = require("./library/valueset");
const {PackageConceptMapProvider} = require("./cm/cm-package");

/**
 * This class holds what information is in context
 *
 * It is prepared for each operation, and carries 4 sets of information:
 *
 * - The special code system classes supported natively by the system
 * - A list of all the code system resources in scope
 * - a list of value set providers that can provide value set instances
 * - a list of concept map providers that can provide concept map instances
 *
 */
class Provider {
  i18n;
  fhirVersion;
  context;

  /**
   * {Map<String, CodeSystemFactoryProvider>} A list of code system factories that contains all the preloaded native code systems
   */
  codeSystemFactories;

  /**
   * {Map<String, CodeSystem>} A list of preloaded FHIR code systems
   */
  codeSystems;

  /**
   * {List<AbstractCodeSystemProvider>} code system providers, for maintaing the code system list
   */
  codeSystemProviders

  /**
   * {List<AbstractValueSetProvider>} A list of value set providers that know how to provide value sets by request
   */
  valueSetProviders;
  /**
   * {List<AbstractConceptMapProvider>} A list of value set providers that know how to provide value sets by request
   */
  conceptMapProviders;

  packageSources;
  externalSources;

  baseUrl = null;
  path;
  cacheFolder = null;
  startTime = Date.now();
  startMemory = process.memoryUsage();
  lastTime = null;
  requestCount = 0;
  totalDownloaded = 0;

  /**
   * get a code system provider for a known code system
   *
   * @param {OperationContext} opContext - The code system resource
   * @param {String} system - The URL - might include a |version
   * @param {String} version - The version, if seperate from the system
   * @param {String[]} supplements - Applicable supplements
   * @returns {CodeSystemProvider} Provider instance
   */
  async getCodeSystemProvider(opContext, system, version, supplements) {
    validateParameter(opContext, "opContext", OperationContext);
    validateParameter(system, "system", String);
    validateArrayParameter(supplements, "supplements", CodeSystem);
    validateOptionalParameter(version, "version", String);

    if (system.includes("|")) {
      const url = system.substring(0, system.indexOf("|"));
      const v = system.substring(system.indexOf("|")+1);
      if (version == null || v === version) {
        version = v;
      } else {
        throw new TerminologyError(`Version inconsistent in ${system}: ${v} vs ${version}`);
      }
      system = url;
    } else if (!version) {
      version = null;
    }
    const vurl = system+(version ? "|"+version : "");
    const vurlMM = VersionUtilities.isSemVer(version) ? system+"|"+VersionUtilities.getMajMin(version) : null;
    let factory = this.codeSystemFactories.get(vurl);
    if (factory == null && vurlMM) {
      factory = this.codeSystemFactories.get(vurlMM);
    }
    if (factory != null) {
      return factory.build(opContext, supplements);
    }
    let cs = this.codeSystems.get(vurl);
    if (cs == null && vurlMM) {
      cs = this.codeSystems.get(vurlMM);
    }
    if (cs != null) {
      return this.createCodeSystemProvider(opContext, cs, supplements);
    }
    return null;
  }

  loadSupplements(url, version, statedSupplements) {
    let supplements = new Map();
    for (let csp of this.codeSystemFactories.values()) {
      csp.listSupplements(supplements, url, version, statedSupplements);
    }
    for (let cs of this.codeSystems.values()) {
      if (cs.isSupplementFor(url, version)) {
        if (cs.isLangPack() || this.isStatedSupplement(cs, statedSupplements)) {
          supplements.set(cs.vurl, cs);
        }
      }
    }
    return [...supplements.values()];
  }

  isStatedSupplement(cs, statedSupplements) {
    if (statedSupplements == null) {
      return false;
    }
    for (let suppU of statedSupplements) {
      if (suppU === cs.url) {
        return true;
      }
      if (suppU.startsWith(cs.url+"|")) {
        let suppV = suppU.substring(suppU.indexOf('|') + 1);
        return VersionUtilities.versionMatchesByAlgorithm(suppV, cs.version, VersionUtilities.guessVersionAlgorithmFromVersion(cs.version));
      }
    }
    return false;
  }
  /**
   * Create a code system provider from a CodeSystem resource
   * @param {OperationContext} opContext - The code system resource
   * @param {CodeSystem} codeSystem - The code system resource
   * @param {CodeSystem[]} supplements - The code system resource
   * @returns {CodeSystemProvider} Provider instance
   */
  async createCodeSystemProvider(opContext, codeSystem, supplements) {
    validateParameter(opContext, "opContext", OperationContext);
    validateParameter(codeSystem, "codeSystem", CodeSystem);
    validateArrayParameter(supplements, "supplements", CodeSystem);
    return new FhirCodeSystemProvider(opContext, codeSystem, supplements);
  }


  async loadNpm(packageManager, cacheFolder,  details, isDefault, mode) {
    // Parse packageId and version from details (e.g., "hl7.terminology.r4#6.0.2")
    let packageId = details;
    let version = null;
    if (details.includes('#')) {
      const parts = details.split('#');
      packageId = parts[0];
      version = parts[1];
    }
    const packagePath = await packageManager.fetch(packageId, version);
    if (mode === "fetch" || mode === "cs") {
      return;
    }
    const fullPackagePath = path.join(cacheFolder, packagePath);
    const contentLoader = new PackageContentLoader(fullPackagePath);
    await contentLoader.initialize();

    const resources = await contentLoader.getResourcesByType("CodeSystem");
    for (const resource of resources) {
      const cs = new CodeSystem(await contentLoader.loadFile(resource, contentLoader.fhirVersion()));
      cs.sourcePackage = contentLoader.pid();
      const existing = this.codeSystems.get(cs.url);
      if (!existing || cs.isMoreRecent(existing)) {
        this.codeSystems.set(cs.url, cs);
      }
      if (cs.version) {
        this.codeSystems.set(cs.vurl, cs);
      }
    }
    const vs = new PackageValueSetProvider(contentLoader);
    await vs.initialize();
    this.valueSetProviders.push(vs);
    const cm = new PackageConceptMapProvider(contentLoader);
    await cm.initialize();
    this.conceptMapProviders.push(cm);
  }

  getCodeSystemById(opContext, id) {

    // Search through codeSystems map for matching id
    for (const cs of this.codeSystems.values()) {
      if (opContext) opContext.deadCheck('getCodeSystemById');
      if (cs.jsonObj.id === id) {
        return cs;
      }
    }
    return undefined;
  }

  getCodeSystemFactoryById(opContext, id) {
    // Search through codeSystems map for matching id
    for (const cs of this.codeSystemFactories.values()) {
      if (cs.id() == id) {
        return cs;
      }
    }
    return undefined;
  }

  async getValueSetById(opContext, id) {
    for (const vp of this.valueSetProviders) {
      if (opContext) opContext.deadCheck('getValueSetById');
      let vs = await vp.fetchValueSetById(id);
      if (vs) {
        return vs;
      }
    }
    return null;
  }

  async findValueSet(opContext, url, version) {
    for (const vp of this.valueSetProviders) {
      if (opContext) opContext.deadCheck('findValueSet');
      let vs = await vp.fetchValueSet(url, version);
      if (vs) {
        return vs;
      }
    }
    let vs = await this.findKnownValueSet(url, version);
    return vs;
  }

  async getConceptMapById(opContext, id) {
    for (const cmp of this.conceptMapProviders) {
      if (opContext) opContext.deadCheck('getConceptMapById');
      let cm = await cmp.fetchConceptMapById(id);
      if (cm) {
        return cm;
      }
    }
    return null;
  }

  async findConceptMap(opContext, url, version) {
    for (const cmp of this.conceptMapProviders) {
      if (opContext) opContext.deadCheck('findConceptMap');
      let cm = await cmp.fetchConceptMap(url, version);
      if (cm) {
        return cm;
      }
    }

    let uris = new Set();
    for (let csp of this.codeSystemFactories.values()) {
      if (!uris.has(csp.system())) {
        uris.add(csp.system());
        let cm = await csp.findImplicitConceptMap(url, version);
        if (cm) {
          return cm;
        }
      }
    }
  }

  listValueSetSourceCodes() {
    let result = [];
    for (let vsp of this.valueSetProviders) {
      result.push(vsp.sourcePackage());
    }
    result.sort((a, b) => {a.localeCompare(b)});
    return result;
  }

  async listCodeSystemVersions(url) {
    let result = new Set();
    for (let cs of this.codeSystems.values()) {
      if (cs.url == url && cs.version) {
        result.add(cs.version);
      }
    }
    for (let cp of this.codeSystemFactories.values()) {
      if (cp.system() == url) {
        result.add(cp.version());
      }
    }
    return result;
  }

  async findKnownValueSet(url, version) {
    for (let csp of this.codeSystemFactories.values()) {
      let vs = await csp.buildKnownValueSet(url, version);
      if (vs != null) {
        return new ValueSet(vs);
      }
    }
    return null;
  }



  async findConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceScope, targetScope, targetSystem, sourceCode = null) {
    for (let cmp of this.conceptMapProviders) {
      await cmp.findConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceScope, targetScope, targetSystem, sourceCode);
    }
    if (sourceSystem && targetSystem) {
      let uris = new Set();
      for (let csp of this.codeSystemFactories.values()) {
        if (!uris.has(csp.system())) {
          uris.add(csp.system());
          await csp.findImplicitConceptMaps(conceptMaps, sourceSystem, targetSystem);
        }
      }
    }
  }

  getFhirVersion() {
    switch (this.fhirVersion) {
      case 5: return "R5";
      case 4: return "R4";
      case 3: return "R3";
      default: return "R5";
    }
  }

  async listAllValueSets() {
    let result = [];
    for (let vsp of this.valueSetProviders) {
      result.push(... await vsp.listAllValueSets());
    }
    return result;

  }

  async resolveURL(opContext, system, version) {
    validateParameter(opContext, "opContext", OperationContext);
    validateParameter(system, "system", String);
    validateOptionalParameter(version, "version", String);

    if (system.includes("|")) {
      const url = system.substring(0, system.indexOf("|"));
      const v = system.substring(system.indexOf("|")+1);
      if (version == null || v === version) {
        version = v;
      } else {
        throw new TerminologyError(`Version inconsistent in ${system}: ${v} vs ${version}`);
      }
      system = url;
    } else if (!version) {
      version = null;
    }
    const vurl = system+(version ? "|"+version : "");
    const vurlMM = VersionUtilities.isSemVer(version) ? system+"|"+VersionUtilities.getMajMin(version) : null;
    let factory = this.codeSystemFactories.get(vurl);
    if (factory == null && vurlMM) {
      factory = this.codeSystemFactories.get(vurlMM);
    }
    if (factory != null) {
      let vdesc = version == null ? "" : factory.describeVersion(version);
      return {
        link: this.path+"/CodeSystem/x-"+factory.id(),
        description: factory.nameBase()+' '+vdesc
      };
    }
    let cs = this.codeSystems.get(vurl);
    if (cs == null && vurlMM) {
      cs = this.codeSystems.get(vurlMM);
    }
    if (cs != null) {
      return {
        link: this.path+"/CodeSystem/"+cs.id,
        description: (cs.title ? cs.title : cs.name)+(version ? " v"+version : "")
      };
    }

    let vs = await this.findValueSet(opContext, system, version);
    if (vs) {
      return {
        link: this.path+"/ValueSet/"+vs.id,
        description: (vs.title ? vs.title : vs.name)+(version ? " v"+version : "")
      };
    }
    let cm = await this.findConceptMap(opContext, system, version);
    if (cm) {
      return {
        link: this.path+"/ConceptMap/"+cm.id,
        description: (cm.title ? cm.title : cm.name)+(version ? " v"+version : "")
      };
    }
    return null;
  }

  async resolveCode(opContext, system, version, code) {
    validateParameter(opContext, "opContext", OperationContext);
    validateParameter(system, "system", String);
    validateOptionalParameter(version, "version", String);
    validateParameter(code, "code", String);

    if (system.includes("|")) {
      const url = system.substring(0, system.indexOf("|"));
      const v = system.substring(system.indexOf("|")+1);
      if (version == null || v === version) {
        version = v;
      } else {
        throw new TerminologyError(`Version inconsistent in ${system}: ${v} vs ${version}`);
      }
      system = url;
    } else if (!version) {
      version = null;
    }
    const vurl = system+(version ? "|"+version : "");
    const vurlMM = VersionUtilities.isSemVer(version) ? system+"|"+VersionUtilities.getMajMin(version) : null;
    let factory = this.codeSystemFactories.get(vurl);
    if (factory == null && vurlMM) {
      factory = this.codeSystemFactories.get(vurlMM);
    }
    if (factory != null) {
      const csp = await factory.build(opContext, []);
      opContext.registerProvider(csp);
      const c = csp ? csp.locate(code) : null;
      if (c) {
        if (factory.iteratable()) {
          return {
            link: this.path + "/CodeSystem/x-" + factory.id(),
            description: csp.display(c)
          }
        } else {
           const link = factory.codeLink(c);
           if (link) {
             return {
               link: link,
               description: csp.display(c)
             }
           }
        }
      }
    }
    let cs = this.codeSystems.get(vurl);
    if (cs == null && vurlMM) {
      cs = this.codeSystems.get(vurlMM);
    }
    if (cs != null) {
      const c = cs.codeMap.get(code);
      if (c) {
        return {
          link: this.path + "/CodeSystem/" + cs.id + '#' + code,
          description: c.display
        };
      }
    }
    return null;
  }

  async hasCsVersion(system, version) {
    for (let cs of this.codeSystems.values()) {
      if (cs.url == system && cs.version == version) {
        return true;
      }
    }
    for (let cp of this.codeSystemFactories.values()) {
      if (cp.system() == system && cp.version() == version) {
        return true;
      }
    }
    return false;
  }x

  async updateCodeSystemList() {
    for (let csp of this.codeSystemProviders) {
      let changes = await csp.getCodeSystemChanges(this.fhirVersion, this.context);
      if (changes) {
        for (let cs of changes.added || []) {
          this.addCodeSystem(cs);
        }
        for (let cs of changes.changed || []) {
          this.addCodeSystem(cs);
        }
        for (let cs of changes.deleted || []) {
          this.deleteCodeSystem(cs);
        }
      }
    }
  }

  addCodeSystem(cs) {
    const existing = this.codeSystems.get(cs.url);
    if (!existing || cs.isMoreRecent(existing)) {
      this.codeSystems.set(cs.url, cs);
    }
    if (cs.version) {
      this.codeSystems.set(cs.vurl, cs);
    }
  }

  deleteCodeSystem(cs) {
    this.codeSystems.delete(cs.vurl);
    this.codeSystems.delete(cs.url);
    let existing = null;
    for (let t of this.codeSystems.values()) {
      if (!existing || t.isMoreRecent(existing)) {
        existing = t;
      }
    }
    if (existing) {
      this.codeSystems.set(cs.url, cs);
    }
  }

}

module.exports = { Provider };
