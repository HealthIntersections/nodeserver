const fs = require('fs').promises;
const path = require('path');
const yaml = require('yaml'); // npm install yaml
const { PackageManager, PackageContentLoader } = require('../library/package-manager');
const { CodeSystem } = require("./library/codesystem");
const {CountryCodeFactoryProvider} = require("./cs/cs-country");
const {Iso4217FactoryProvider} = require("./cs/cs-currency");
const {AreaCodeFactoryProvider} = require("./cs/cs-areacode");
const {MimeTypeServicesFactory} = require("./cs/cs-mimetypes");
const {USStateFactoryProvider} = require("./cs/cs-usstates");
const {HGVSServicesFactory} = require("./cs/cs-hgvs");
const {UcumCodeSystemFactory} = require("./cs/cs-ucum");
const {UcumService} = require("./library/ucum-service");
const {readFileSync} = require("fs");
const https = require('https');
const http = require('http');
const {LoincServicesFactory} = require("./cs/cs-loinc");
const {RxNormServicesFactory} = require("./cs/cs-rxnorm");
const {NdcServicesFactory} = require("./cs/cs-ndc");
const {UniiServicesFactory} = require("./cs/cs-unii");
const {SnomedServicesFactory} = require("./cs/cs-snomed");
const {SqliteRuntimeV0FactoryProvider} = require("./cs/cs-sqlite-runtime-v0");
const {CPTServicesFactory} = require("./cs/cs-cpt");
const {OMOPServicesFactory} = require("./cs/cs-omop");
const {PackageValueSetProvider} = require("./vs/vs-package");
const {PackageConceptMapProvider} = require("./cm/cm-package");
const {IETFLanguageCodeFactory} = require("./cs/cs-lang");
const {LanguageDefinitions} = require("../library/languages");
const {VersionUtilities} = require("../library/version-utilities");
const {ListCodeSystemProvider} = require("./cs/cs-provider-list");
const { Provider } = require("./provider");
const {I18nSupport} = require("../library/i18nsupport");
const folders = require('../library/folder-setup');
const {VSACValueSetProvider} = require("./vs/vs-vsac");

/**
 * This class holds all the loaded content ready for processing
 *
 * At the start of every service call, this is turned into a
 * provider structure that holds what's actually in context,
 * based on the stated FHIR version, and the other (optional) context information
 *
 */
class Library {
  /**
   * {Map<String, CodeSystemFactoryProvider>} A list of code system factories that contains all the preloaded native code systems
   */
  codeSystemFactories;

  /**
   * {Lisr<AbstractCodeSystemProvider>} A list of preloaded FHIR code systems
   */
  codeSystemProviders;

  /**
   * {List<AbstractValueSetProvider>} A list of value set providers that know how to provide value sets by request
   */
  valueSetProviders;

  /**
   * {List<AbstractConceptMapProvider>} A list of value set providers that know how to provide value sets by request
   */
  conceptMapProviders;

  contentSources = [];

  baseUrl = null;
  cacheFolder = null;
  startTime = Date.now();
  startMemory = process.memoryUsage();
  lastTime = null;
  totalDownloaded = 0;
  vsacCfg = undefined;

  registerProvider(source, factory, isDefault = false) {
    this.#logSystem(factory.system(), factory.version(), source);
    if (isDefault || !this.codeSystemFactories.has(factory.system())) {
      this.codeSystemFactories.set(factory.system(), factory);
    }
    const ver = factory.version() ?? "";
    this.codeSystemFactories.set(factory.system()+"|"+ver, factory);
    const verMin = factory.getPartialVersion();
    if (verMin) {
      this.codeSystemFactories.set(factory.system()+"|"+verMin, factory);
    }
  }

  constructor(configFile, vsacCfg, log, stats) {
    this.configFile = configFile;
    this.vsacCfg = vsacCfg;
    this.log = log;
    this.stats = stats;

    // Only synchronous initialization here
    this.codeSystemFactories = new Map();
    this.codeSystemProviders = [];
    this.valueSetProviders = [];
    this.conceptMapProviders = [];

    // Create package manager for FHIR packages
    const packageServers = ['https://packages2.fhir.org/packages'];
    this.cacheFolder = folders.subDir('terminology-cache');  // <-- CHANGE
    this.packageManager = new PackageManager(packageServers, this.cacheFolder);
  }

  #logSystemHeader() {
    let time = "Time".padEnd(6);
    // let memory = " MB".padEnd(6);
    let system = "System".padEnd(50);
    let version = "Version".padEnd(62);
    let source = "Source"
    this.log.info(`${time}${system}${version}${source}`);
    this.lastTime = Date.now();
    // this.lastMemory = process.memoryUsage();
  }

  #logSystem(url, ver, source) {
    //const mem = process.memoryUsage();
    let time = Math.floor(Date.now() - this.lastTime).toString().padStart(5)+" ";
    let system = url.padEnd(50);
    let version = (ver == null ? "" : ver).padEnd(62);
    this.log.info(`${time}${system}${version}${source}`);
    this.lastTime = Date.now();
  }

  #logPackagesHeader() {
    let time = "Time".padEnd(6);
    //let memory = " MB".padEnd(6);
    let id = "ID".padEnd(20);
    let ver = "Version".padEnd(20);
    let cs = "CS".padEnd(6);
    let vs = "VS".padEnd(6);
    this.log.info(`${time}${id}${ver}${cs}${vs}`);
    this.lastTime = Date.now();
  }

  #logPackage(idp, verp, csp, vsp) {
    let time = Math.floor(Date.now() - this.lastTime).toString().padStart(5)+" ";
    let id = idp.padEnd(20);
    let ver = verp.padEnd(20);
    let cs = csp.toString().padEnd(6);
    let vs = vsp.toString().padEnd(6);
    this.log.info(`${time}${id}${ver}${cs}${vs}`);
    this.lastTime = Date.now();
  }

  async load() {
    this.startTime = Date.now();
    this.languageDefinitions = await LanguageDefinitions.fromFiles(path.join(__dirname, '../tx/data'));
    this.i18n = new I18nSupport(path.join(__dirname, '../translations'), this.languageDefinitions);
    await this.i18n.load();

    // Read and parse YAML configuration
    const yamlPath = this.configFile ? this.configFile :  path.join(__dirname, '..', 'tx', 'tx.fhir.org.yml');
    const yamlContent = await fs.readFile(yamlPath, 'utf8');
    const config = yaml.parse(yamlContent);
    this.baseUrl = config.base.url;

    this.log.info('Fetching Data from '+this.baseUrl);

    for (const source of config.sources) {
      await this.processSource(source, this.packageManager, "fetch");
    }

    this.log.info("Downloaded "+((this.totalDownloaded + this.packageManager.totalDownloaded)/ 1024)+" kB");

    this.log.info('Loading Code Systems');
    this.#logSystemHeader();

    for (const source of config.sources) {
      await this.processSource(source, this.packageManager, "cs");
    }
    this.log.info('Loading Packages');
    this.#logPackagesHeader();

    for (const source of config.sources) {
      await this.processSource(source, this.packageManager, "npm");
    }

    const endMemory = process.memoryUsage();
    const totalTime = Date.now() - this.startTime;

    const memoryIncrease = {
      rss: endMemory.rss - this.startMemory.rss,
      heapUsed: endMemory.heapUsed - this.startMemory.heapUsed,
      heapTotal: endMemory.heapTotal - this.startMemory.heapTotal,
      external: endMemory.external - this.startMemory.external
    };

    this.log.info(`Loading Time: ${(totalTime / 1000).toLocaleString()}s`);
    this.log.info(`Memory Used: ${(memoryIncrease.rss / 1024 / 1024).toFixed(2)} MB`);

    this.assignIds();
  }

  async processSource(source, packageManager, mode) {
    // Parse the source string
    const colonIndex = source.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`Invalid source format: ${source}`);
    }

    let type = source.substring(0, colonIndex);
    const details = source.substring(colonIndex + 1);

    // Handle special markers (like ! for default)
    let isDefault = false;
    if (type.endsWith('!')) {
      type = type.slice(0, -1);
      isDefault = true;
    }

    // Switch statement for different source types
    switch (type) {
      case 'internal':
        await this.loadInternal(details, isDefault, mode);
        break;

      case 'ucum':
        await this.loadUcum(details, isDefault, mode);
        break;

      case 'loinc':
        await this.loadLoinc(details, isDefault, mode);
        break;

      case 'rxnorm':
        await this.loadRxnorm(details, isDefault, mode);
        break;

      case 'ndc':
        await this.loadNdc(details, isDefault, mode);
        break;

      case 'unii':
        await this.loadUnii(details, isDefault, mode);
        break;

      case 'snomed':
        await this.loadSnomed(details, isDefault, mode);
        break;

      case 'sqlite-v0':
        await this.loadSqliteV0(details, isDefault, mode);
        break;

      case 'cpt':
        await this.loadCpt(details, isDefault, mode);
        break;

      case 'omop':
        await this.loadOmop(details, isDefault, mode);
        break;

      case 'npm':
        await this.loadNpm(packageManager, details, isDefault, mode, false);
        break;

      case 'npm/cs':
        await this.loadNpm(packageManager, details, isDefault, mode, true);
        break;

      case 'url':
        await this.loadUrl(packageManager, details, isDefault, mode, false);
        break;

      case 'url/cs':
        await this.loadUrl(packageManager, details, isDefault, mode, true);
        break;
        
      default:
        throw new Error(`Unknown source type: ${type}`);
    }
  }

  async loadInternal(details, isDefault, mode) {
    if (isDefault) {
      throw new Error("Default is not supported for internal code system providers");
    }
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    switch (details) {
      case "country" : {
        const cc = new CountryCodeFactoryProvider(this.i18n);
        await cc.load();
        this.registerProvider('internal', cc);
        break;
      }
      case "lang" : {
        const langs = new IETFLanguageCodeFactory(this.i18n);
        await langs.load();
        this.registerProvider('internal', langs);
        break;
      }
      case "currency" : {
        const curr = new Iso4217FactoryProvider(this.i18n);
        await curr.load();
        this.registerProvider('internal', curr);
        break;
      }
      case "areacode" : {
        const ac = new AreaCodeFactoryProvider(this.i18n);
        await ac.load();
        this.registerProvider('internal', ac);
        break;
      }
      case "mimetypes" : {
        const mime = new MimeTypeServicesFactory(this.i18n);
        await mime.load();
        this.registerProvider('internal', mime);
        break;
      }
      case "usstates" : {
        const uss = new USStateFactoryProvider(this.i18n);
        await uss.load();
        this.registerProvider('internal', uss);
        break;
      }
      case "hgvs" : {
        const hgvs = new HGVSServicesFactory(this.i18n);
        await hgvs.load();
        this.registerProvider('internal', hgvs);
        break;
      }
      case "vsac" : {
        if (!this.vsacCfg || !this.vsacCfg.apiKey) {
          throw new Error("Unable to load VSAC provider unless vsacCfg is provided in the configuration");
        }
        let vsac = new VSACValueSetProvider(this.vsacCfg, this.stats);
        vsac.initialize();
        this.valueSetProviders.push(vsac);
        //const mem = process.memoryUsage();
        let time = Math.floor(Date.now() - this.lastTime).toString().padStart(5)+" ";
        let system = "vsac".padEnd(50);
        let version = "n/a".padEnd(62);
        this.log.info(`${time}${system}${version}${vsac.baseUrl}`);
        this.lastTime = Date.now();
        break;
      }
      default:
        throw new Error("Unknown Internal Provider "+details);
    }
  }

  async loadUcum(details, isDefault, mode) {
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const source = path.join(__dirname, '..', details);

    const ucumEssenceXml = readFileSync(source, 'utf8');
    const ucumService = new UcumService();
    await ucumService.init(ucumEssenceXml);

    const ucum = new UcumCodeSystemFactory(this.i18n, ucumService);
    await ucum.load();
    this.registerProvider(source, ucum, isDefault);
  }

  async loadLoinc(details, isDefault, mode) {
    const loincFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }

    const loinc = new LoincServicesFactory(this.i18n, loincFN);
    await loinc.load();
    this.registerProvider(loincFN, loinc, isDefault);
  }

  async loadRxnorm(details, isDefault, mode) {
    const rxNormFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const rxn = new RxNormServicesFactory(this.i18n, rxNormFN);
    await rxn.load();
    this.registerProvider(rxNormFN, rxn, isDefault);
  }

  async loadNdc(details, isDefault, mode) {
    const ndcFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const ndc = new NdcServicesFactory(this.i18n, ndcFN);
    await ndc.load();
    this.registerProvider(ndcFN, ndc, isDefault);
  }

  async loadUnii(details, isDefault, mode) {
    const uniFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const unii = new UniiServicesFactory(this.i18n, uniFN);
    await unii.load();
    this.registerProvider(uniFN, unii, isDefault);
  }

  async loadSnomed(details, isDefault, mode) {
    const sctFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const sct = new SnomedServicesFactory(this.i18n, sctFN);
    await sct.load();
    this.registerProvider(sctFN, sct, isDefault);
  }

  async loadSqliteV0(details, isDefault, mode) {
    // Parse optional ?specialization=id or ?specialization=none
    let filePart = details;
    let specialization;
    const qIdx = details.indexOf('?');
    if (qIdx !== -1) {
      filePart = details.substring(0, qIdx);
      const params = new URLSearchParams(details.substring(qIdx + 1));
      specialization = params.get('specialization') || undefined;
    }
    const sqliteFN = await this.getOrDownloadFile(filePart);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const factory = await SqliteRuntimeV0FactoryProvider.createFromMetadata(
      this.i18n, sqliteFN, { idPrefix: 'sqlite-v0', specialization }
    );
    this.registerProvider(sqliteFN, factory, isDefault);
  }

  async loadCpt(details, isDefault, mode) {
    const cptFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const cpt = new CPTServicesFactory(this.i18n, cptFN);
    await cpt.load();
    this.registerProvider(cptFN, cpt, isDefault);
  }

  async loadOmop(details, isDefault, mode) {
    const omopFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const omop = new OMOPServicesFactory(this.i18n, omopFN);
    await omop.load();
    this.registerProvider(omopFN, omop, isDefault);
  }

  async loadNpm(packageManager, details, isDefault, mode, csOnly) {
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
    const fullPackagePath = path.join(this.cacheFolder, packagePath);
    const contentLoader = new PackageContentLoader(fullPackagePath);
    await contentLoader.initialize();

    this.contentSources.push(contentLoader.id()+"#"+contentLoader.version());

    let cp = new ListCodeSystemProvider();
    const resources = await contentLoader.getResourcesByType("CodeSystem");
    let csc = 0;
    for (const resource of resources) {
      const cs = new CodeSystem(await contentLoader.loadFile(resource, contentLoader.fhirVersion()));
      cs.sourcePackage = contentLoader.pid();
      cp.codeSystems.set(cs.url, cs);
      cp.codeSystems.set(cs.vurl, cs);
      csc++;
    }
    this.codeSystemProviders.push(cp);
    let vs = null;
    if (!csOnly) {
      vs = new PackageValueSetProvider(contentLoader);
      await vs.initialize();
      this.valueSetProviders.push(vs);
      const cm = new PackageConceptMapProvider(contentLoader);
      await cm.initialize();
      this.conceptMapProviders.push(cm);
    }

    this.#logPackage(contentLoader.id(), contentLoader.version(), csc, vs ? vs.valueSetMap.size : 0);
  }

  async loadUrl(packageManager, url, isDefault, mode, csOnly) {
    const packagePath = await packageManager.fetchUrl(url);
    if (mode === "fetch" || mode === "cs") {
      return;
    }
    const fullPackagePath = path.join(this.cacheFolder, packagePath);
    const contentLoader = new PackageContentLoader(fullPackagePath);
    await contentLoader.initialize();

    this.contentSources.push(contentLoader.id()+"#"+contentLoader.version());

    let cp = new ListCodeSystemProvider();
    const resources = await contentLoader.getResourcesByType("CodeSystem");
    let csc = 0;
    for (const resource of resources) {
      const cs = new CodeSystem(await contentLoader.loadFile(resource, contentLoader.fhirVersion()));
      cs.sourcePackage = contentLoader.pid();
      cp.codeSystems.set(cs.url, cs);
      cp.codeSystems.set(cs.vurl, cs);
      csc++;
    }
    this.codeSystemProviders.push(cp);
    let vs = null;
    if (!csOnly) {
      vs = new PackageValueSetProvider(contentLoader);
      await vs.initialize();
      this.valueSetProviders.push(vs);
      const cm = new PackageConceptMapProvider(contentLoader);
      await cm.initialize();
      this.conceptMapProviders.push(cm);
    }

    this.#logPackage(contentLoader.id(), contentLoader.version(), csc, vs ? vs.valueSetMap.size : 0);
  }

  /**
   * Gets a file from local folder or downloads it from URL
   * @param {string} fileName - Name of the file
   * @returns {Promise<string>} Full path to the file
   * @throws {Error} If file cannot be downloaded or accessed
   */
  async getOrDownloadFile(fileName) {
    // Ensure folder exists
    await this.ensureFolderExists(this.cacheFolder);

    if (fileName.includes("|")) {
      // in this case, we split it into two. if the first file exists, we go with that. Otherwise
      // fallback to the second.
      let firstName = fileName.substring(0, fileName.indexOf("|"));
      fileName = fileName.substring(fileName.indexOf("|")+1);

      const firstPath = path.join(this.cacheFolder, firstName);
      if (await this.fileExists(firstPath)) {
        return firstPath;
      }
    }
    const filePath = path.join(this.cacheFolder, fileName);

    // Check if file already exists
    if (await this.fileExists(filePath)) {
      return filePath;
    }

    // File doesn't exist, download it
    this.log.info(`Downloading: ${fileName}`);

    const downloadUrl = this.baseUrl.endsWith('/') ? this.baseUrl + fileName : this.baseUrl + '/' + fileName;

    try {
      await this.downloadFile(downloadUrl, filePath);
      return filePath;
    } catch (error) {
      throw new Error(`Failed to download file ${fileName} from ${downloadUrl}: ${error.message}`);
    }
  }

  /**
   * Check if a file exists
   * @param {string} filePath - Path to check
   * @returns {Promise<boolean>} True if file exists
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure a folder exists, create it if it doesn't
   * @param {string} folderPath - Path to folder
   */
  async ensureFolderExists(folderPath) {
    try {
      await fs.mkdir(folderPath, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new Error(`Failed to create folder ${folderPath}: ${error.message}`);
      }
    }
  }

  /**
   * Download a file from URL to local path
   * @param {string} url - URL to download from
   * @param {string} filePath - Local path to save file
   * @returns {Promise<void>}
   */
  async downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https:') ? https : http;

      const request = protocol.get(url, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return this.downloadFile(response.headers.location, filePath)
            .then(resolve)
            .catch(reject);
        }

        // Check for successful response
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          return;
        }

        // Create write stream
        const fileStream = require('fs').createWriteStream(filePath);

        // Handle stream errors
        fileStream.on('error', (error) => {
          reject(new Error(`Failed to write file: ${error.message}`));
        });

        // Handle download completion
        fileStream.on('finish', () => {
          fileStream.close();
          const statsFs = require('fs').statSync(filePath);
          this.totalDownloaded = this.totalDownloaded + statsFs.size;
          resolve();
        });

        // Pipe response to file
        response.pipe(fileStream);

      }).on('error', (error) => {
        reject(new Error(`Download request failed: ${error.message}`));
      });

      // Set timeout for request
      request.setTimeout(30000, () => {
        request.destroy();
        reject(new Error('Download timeout (30 seconds)'));
      });
    });
  }

  /**
   * Creates a provider for the specified version , and context.
   *
   * @param {string} fhirVersion - FHIR version (e.g., '4.0.1', '5.0.0')
   * @param {string} context - other information from the client that sets the context
   * @returns {Promise<Provider>} New provider instance with FHIR packages loaded
   */
  async cloneWithFhirVersion(fhirVersion, context, path) {
    // Create new provider instance
    const provider = new Provider();
    provider.i18n = this.i18n;
    provider.codeSystemFactories = new Map(this.codeSystemFactories); // all of them
    provider.codeSystems = new Map();
    provider.valueSetProviders = [];
    provider.conceptMapProviders = [];
    provider.path = path;
    if (VersionUtilities.isR5Ver(fhirVersion)) {
      provider.fhirVersion = 5;
    } else if (VersionUtilities.isR4Ver(fhirVersion)) {
      provider.fhirVersion = 4;
    } else if (VersionUtilities.isR3Ver(fhirVersion)) {
      provider.fhirVersion = 3;
    } else {
      provider.fhirVersion = 6;
    }



    // Load FHIR core packages first
    const fhirPackages = this.#getFhirPackagesForVersion(fhirVersion);

    this.log.info(`Loading FHIR ${fhirVersion} packages`);
    this.#logPackagesHeader();

    // Load FHIR packages - these will be added to valueSetProviders first
    for (const packageId of fhirPackages) {
      await provider.loadNpm(this.packageManager, this.cacheFolder, packageId, false, "npm", false);
    }


    for (const cp of this.codeSystemProviders) {
      const csMap = await cp.listCodeSystems(fhirVersion, context);
      for (const [key, value] of csMap) {
        provider.codeSystems.set(key, value);
      }
    }
    // Don't clone valueSetProviders yet - we'll build it with correct order

    // Copy other properties
    provider.baseUrl = this.baseUrl;
    provider.cacheFolder = this.cacheFolder;
    provider.startTime = this.startTime;
    provider.startMemory = this.startMemory;
    provider.lastTime = this.lastTime;
    provider.lastMemory = this.lastMemory;
    provider.totalDownloaded = this.totalDownloaded;
    provider.contentSources = this.contentSources;


    // Now add the existing value set providers after the FHIR core packages
    provider.valueSetProviders.push(...this.valueSetProviders);
    provider.conceptMapProviders.push(...this.conceptMapProviders);

    // bind UCUM common value set
    let ucum = provider.codeSystemFactories.get("http://unitsofmeasure.org");
    let vs = await provider.findValueSet(null, "http://hl7.org/fhir/ValueSet/ucum-common", null);
    if (ucum && vs) {
      ucum.processCommonUnits(vs);
    }
    return provider;
  }

  /**
   * Gets the list of FHIR packages for a specific version
   * @param {string} fhirVersion - FHIR version
   * @returns {string} Package Id
   * @private
   */
  #getFhirPackagesForVersion(ver) {
    if (VersionUtilities.isR3Ver(ver)) {
      return ["hl7.fhir.r3.core"];
    }
    if (VersionUtilities.isR4Ver(ver) ||VersionUtilities.isR4BVer(ver)) {
      return ["hl7.fhir.r4.core"];
    }
    if (VersionUtilities.isR5Ver(ver)) {
      return ["hl7.fhir.r5.core"];
    }
    throw new Error(`Unsupported FHIR version: ${ver}. Supported versions: R3, R4, R5`);
  }

  /**
   * all the loaded resources must have unique IDs for the get operation
   * they must be assigned by the library on loading. providers can either assign
   * ids from the global space at start up, or, if they can provide new resources
   * later in an ongoing fashion, allocate them in their own space
   */
  assignIds() {
    let ids = new Set();
    // these don't have ids - not available directly for (const cs of this.codeSystemFactories) { .. }
    let i = 0;
    for (const cp of this.codeSystemProviders) {
      cp.spaceId = String(++i);
      cp.assignIds(ids);
    }
    i = 0;
    for (const vp of this.valueSetProviders) {
      vp.spaceId = String(++i);
      vp.assignIds(ids);
    }
    i = 0;
    for (const cmp of this.conceptMapProviders) {
      cmp.spaceId = String(++i);
      cmp.assignIds(ids);
    }

  }

  async close() {
    for (let csp of this.codeSystemProviders) {
      csp.close();
    }
    for (let csp of this.codeSystemFactories.values()) {
      csp.close();
    }
    for (let vsp of this.valueSetProviders) {
      vsp.close();
    }
    for (let cmp of this.conceptMapProviders) {
      cmp.close();
    }
  }
}

module.exports = { Library };
