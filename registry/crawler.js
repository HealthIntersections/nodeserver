// registry/crawler.js
// Crawler for gathering server information from terminology servers

const axios = require('axios');
const { 
  ServerRegistries, 
  ServerRegistry, 
  ServerInformation, 
  ServerVersionInformation,
} = require('./model');

const MASTER_URL = 'https://fhir.github.io/ig-registry/tx-servers.json';

class RegistryCrawler {
  log;

  constructor(config = {}) {
    this.config = {
      timeout: config.timeout || 30000, // 30 seconds default
      masterUrl: config.masterUrl || MASTER_URL,
      userAgent: config.userAgent || 'HealthIntersections/FhirServer',
      crawlInterval: config.crawlInterval || 5 * 60 * 1000, // 5 minutes default
      apiKeys: config.apiKeys || {} // Map of server URL or code to API key
    };
    
    this.currentData = new ServerRegistries();
    this.crawlTimer = null;
    this.isCrawling = false;
    this.errors = [];
    this.totalBytes = 0;
    this.log = console;
  }

  useLog(logv) {
    this.log = logv;
  }

  /**
   * Start the crawler with periodic updates
   */
  start() {
    if (this.crawlTimer) {
      return; // Already running
    }
    
    // Initial crawl
    this.crawl();
    
    // Set up periodic crawling
    this.crawlTimer = setInterval(() => {
      this.crawl();
    }, this.config.crawlInterval);
  }

  /**
   * Stop the crawler
   */
  stop() {
    if (this.crawlTimer) {
      clearInterval(this.crawlTimer);
      this.crawlTimer = null;
    }
  }

  /**
   * Main entry point - crawl the registry starting from the master URL
   * @param {string} masterUrl - Optional override for the master URL
   * @returns {Promise<ServerRegistries>} The populated registry data
   */
  async crawl(masterUrl = null) {
    if (this.isCrawling) {
      this.addLogEntry('warn', 'Crawl already in progress, skipping...');
      return this.currentData;
    }

    this.isCrawling = true;
    const startTime = new Date();
    this.errors = [];
    this.totalBytes = 0;
    
    const url = masterUrl || this.config.masterUrl;
    
    try {
      this.addLogEntry('info', `Starting scan from ${url}`);
      
      const newData = new ServerRegistries();
      newData.address = url;
      newData.lastRun = startTime;
      
      // Fetch the master registry list
      const masterJson = await this.fetchJson(url, 'master');
      
      if (masterJson.formatVersion !== '1') {
        throw new Error(`Unable to proceed: registries version is ${masterJson.formatVersion} not "1"`);
      }
      
      newData.doco = masterJson.documentation || '';
      
      // Process each registry
      const registries = masterJson.registries || [];
      for (const registryConfig of registries) {
        const registry = await this.processRegistry(registryConfig);
        if (registry) {
          newData.registries.push(registry);
        }
      }
      
      newData.outcome = `Processed OK - ${this.formatBytes(this.totalBytes)}`;
      
      // Update the current data
      this.currentData = newData;
    } catch (error) {
      this.addLogEntry('error', 'Exception Scanning:', error);
      this.currentData.outcome = `Error: ${error.message}`;
      this.errors.push({
        source: url,
        error: error.message,
        timestamp: new Date()
      });
    } finally {
      this.isCrawling = false;
    }
    
    return this.currentData;
  }

  /**
   * Process a single registry
   */
  async processRegistry(registryConfig) {
    const registry = new ServerRegistry();
    registry.code = registryConfig.code;
    registry.name = registryConfig.name;
    registry.authority = registryConfig.authority || '';
    registry.address = registryConfig.url;
    
    if (!registry.name) {
      this.addLogEntry('error', 'No name provided for registry', registryConfig.url);
      return registry;
    }
    
    if (!registry.address) {
      this.addLogEntry('error', `No url provided for ${registry.name, registry.name}`, '');
      return registry;
    }
    
    try {
      this.addLogEntry('info', ` Registry ${registry.name} from ${registry.address}`);
      
      const registryJson = await this.fetchJson(registry.address, registry.code);
      
      if (registryJson.formatVersion !== '1') {
        throw new Error(`Registry version at ${registry.address} is ${registryJson.formatVersion} not "1"`);
      }
      
      // Process each server in the registry
      const servers = registryJson.servers || [];
      for (const serverConfig of servers) {
        const server = await this.processServer(serverConfig, registry.address);
        if (server) {
          registry.servers.push(server);
        }
      }
      
    } catch (error) {
      registry.error = error.message;
      this.addLogEntry('error', `Exception processing registry ${registry.name}: ${error.message}`, registry.address);
    }
    
    return registry;
  }

  /**
   * Process a single server
   */
  async processServer(serverConfig, source) {
    const server = new ServerInformation();
    server.code = serverConfig.code;
    server.name = serverConfig.name;
    server.address = serverConfig.url || '';
    server.accessInfo = serverConfig.access_info || '';
    
    if (!server.name) {
      this.addLogEntry('error', 'No name provided for server', source);
      return server;
    }
    
    if (!server.address) {
      this.addLogEntry('error', `No url provided for ${server.name}`, source);
      return server;
    }
    
    // Parse authoritative lists
    server.authCSList = (serverConfig.authoritative || []).sort();
    server.authVSList = (serverConfig['authoritative-valuesets'] || []).sort();
    server.usageList = (serverConfig.usage || []).sort();
    
    // Process each FHIR version
    const fhirVersions = serverConfig.fhirVersions || [];
    for (const versionConfig of fhirVersions) {
      const version = await this.processServerVersion(versionConfig, server);
      if (version) {
        server.versions.push(version);
      }
    }
    
    return server;
  }

  /**
   * Process a single server version
   */
  async processServerVersion(versionConfig, server) {
    const version = new ServerVersionInformation();
    version.version = versionConfig.version;
    version.address = versionConfig.url;
    version.security = this.getApiKey(server.code) == null ? "open" : "api-key";
    
    if (!version.address) {
      this.addLogEntry('error', `No URL for version ${version.version} of ${server.name}`, server.address);
      return version;
    }
    
    const startTime = Date.now();
    
    try {
      // this.addLogEntry('info', `  Server ${version.address} (${server.name})`);
      
      // Determine FHIR version from version string
      const majorVersion = this.getMajorVersion(version.version);
      
      switch (majorVersion) {
        case 3:
          await this.processServerVersionR3(version, server);
          break;
        case 4:
          await this.processServerVersionR4(version, server);
          break;
        case 5:
          await this.processServerVersionR5(version, server);
          break;
        default:
          throw new Error(`Version ${version.version} not supported`);
      }
      
      // Sort and deduplicate
      version.codeSystems = [...new Set(version.codeSystems)].sort();
      version.valueSets = [...new Set(version.valueSets)].sort();
      version.lastSuccess = new Date();
      version.lastTat = `${Date.now() - startTime}ms`;

      this.addLogEntry('info', `  Server ${version.address}: ${version.lastTat} for ${version.codeSystems.length} CodeSystems and ${version.valueSets.length} ValueSets`);
      
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.addLogEntry('error', `Server ${version.address}: Error after ${elapsed}ms: ${error.message}`);
      version.error = error.message;
      version.lastTat = `${elapsed}ms`;
    }
    
    return version;
  }

  /**
   * Process an R3 server
   */
  async processServerVersionR3(version, server) {
    // Get capability statement
    const capabilityUrl = `${version.address}/metadata`;
    const capability = await this.fetchJson(capabilityUrl, server.name);
    
    version.version = capability.fhirVersion || '3.0.2';
    version.software = capability.software ? capability.software.name : "unknown";

    // Get terminology capabilities (R3 uses Parameters resource)
    try {
      const termCapUrl = `${version.address}/metadata?mode=terminology`;
      const termCap = await this.fetchJson(termCapUrl, server.name);
      
      if (termCap.parameter) {
        termCap.parameter.forEach(param => {
          if (param.name === 'system') {
            const uri = param.valueUri || param.valueString;
            if (uri) {
              version.codeSystems.push(uri);
              // Look for version parts
              if (param.part) {
                param.part.forEach(part => {
                  if (part.name === 'version' && part.valueString) {
                    version.codeSystems.push(`${uri}|${part.valueString}`);
                  }
                });
              }
            }
          }
        });
      }
    } catch (error) {
      this.addLogEntry('error', `Could not fetch terminology capabilities: ${error.message}`);
    }
    
    // Search for value sets
    await this.fetchValueSets(version, server);
  }

  /**
   * Process an R4 server
   */
  async processServerVersionR4(version, server) {
    // Get capability statement
    const capabilityUrl = `${version.address}/metadata`;
    const capability = await this.fetchJson(capabilityUrl, server.code);
    
    version.version = capability.fhirVersion || '4.0.1';
    version.software = capability.software ? capability.software.name : "unknown";
    
    // Get terminology capabilities
    try {
      const termCapUrl = `${version.address}/metadata?mode=terminology`;
      const termCap = await this.fetchJson(termCapUrl, server.code);
      
      if (termCap.codeSystem) {
        termCap.codeSystem.forEach(cs => {
          if (cs.uri) {
            version.codeSystems.push(cs.uri);
            if (cs.version) {
              cs.version.forEach(v => {
                if (v.code) {
                  version.codeSystems.push(`${cs.uri}|${v.code}`);
                }
              });
            }
          }
        });
      }
    } catch (error) {
      this.addLogEntry('error', `Could not fetch terminology capabilities: ${error.message}`);
    }
    
    // Search for value sets
    await this.fetchValueSets(version,  server);
  }

  /**
   * Process an R5 server
   */
  async processServerVersionR5(version, server) {
    // R5 is essentially the same as R4 for our purposes
    await this.processServerVersionR4(version, server);
    version.version = version.version || '5.0.0';
  }

  /**
   * Fetch value sets from the server
   */
  /**
   * Fetch value sets with pagination support
   * @param {Object} version - The server version information
   * @param {Object} server - The server information
   */
  async fetchValueSets(version, server) {
    // Initial search URL
    let searchUrl = `${version.address}/ValueSet?_elements=url,version`;
    try {
      // Set of URLs to avoid duplicates
      const valueSetUrls = new Set();


      // Continue fetching while we have a URL
      while (searchUrl) {
        this.log.debug(`Fetching value sets from ${searchUrl}`);
        const bundle = await this.fetchJson(searchUrl, server.code);

        // Process entries in this page
        if (bundle.entry) {
          bundle.entry.forEach(entry => {
            if (entry.resource) {
              const vs = entry.resource;
              if (vs.url) {
                valueSetUrls.add(vs.url);
                if (vs.version) {
                  valueSetUrls.add(`${vs.url}|${vs.version}`);
                }
              }
            }
          });
        }

        // Look for next link
        searchUrl = null;
        if (bundle.link) {
          const nextLink = bundle.link.find(link => link.relation === 'next');
          if (nextLink && nextLink.url) {
            searchUrl = this.resolveUrl(nextLink.url, version.address);
          }
        }
      }

      // Convert set to array and sort
      version.valueSets = Array.from(valueSetUrls).sort();

    } catch (error) {
      this.addLogEntry('error', `Could not fetch value sets: ${error.message} from ${searchUrl}`);
    }
  }

  resolveUrl(url, baseUrl) {
    // Check if the URL is already absolute
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }

    // Get the base URL without any path
    const baseUrlObj = new URL(baseUrl);
    const base = `${baseUrlObj.protocol}//${baseUrlObj.host}`;

    // If URL starts with a slash, it's relative to the root
    if (url.startsWith('/')) {
      return `${base}${url}`;
    }

    // Otherwise, it's relative to the base URL path
    // Remove any query parameters or fragments from the base URL
    const basePath = baseUrl.split('?')[0].split('#')[0];

    // If base path ends with a slash, just append the URL
    if (basePath.endsWith('/')) {
      return `${basePath}${url}`;
    }

    // Otherwise, replace the last segment of the path
    const basePathSegments = basePath.split('/');
    basePathSegments.pop(); // Remove the last segment
    return `${basePathSegments.join('/')}/${url}`;
  }

  /**
   * Fetch JSON from a URL
   */
  async fetchJson(url, serverName) {
    try {
      // Add timestamp to bypass cache
      const fetchUrl = url.includes('?') 
        ? `${url}&_ts=${Date.now()}`
        : `${url}?_ts=${Date.now()}`;
      
      // Get API key if configured
      const apiKey = this.getApiKey(serverName);
      const headers = {
        'Accept': 'application/json, application/fhir+json',
        'User-Agent': this.config.userAgent
      };
      
      if (apiKey) {
        headers['Api-Key'] = apiKey;
      }
      
      const response = await axios.get(fetchUrl, {
        timeout: this.config.timeout,
        headers: headers,
        validateStatus: (status) => status < 500 // Don't throw on 4xx
      });
      
      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      // Track bytes downloaded
      const contentLength = response.headers['content-length'];
      if (contentLength) {
        this.totalBytes += parseInt(contentLength);
      } else if (response.data) {
        this.totalBytes += JSON.stringify(response.data).length;
      }
      
      return response.data;
      
    } catch (error) {
      if (error.response) {
        throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
      } else if (error.request) {
        throw new Error(`No response from server: ${error.message}`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Get API key for a given URL
   */
  getApiKey(name) {
    // Check for exact URL match
    if (this.config.apiKeys[name]) {
      return this.config.apiKeys[name];
    }
    
    return null;
  }

  /**
   * Get major version from version string
   * Handles formats like:
   * - 3.0.1, 4.0, 5.0.0
   * - 3, 4, 5
   * - R3, R4, R4B, R5
   * - r3, r4, r4b, r5
   */
   getMajorVersion(versionString) {
    if (!versionString) return 0;

    // Convert to string and uppercase for consistent handling
    const version = String(versionString).toUpperCase();

    // Case 1: Check for R followed by a digit (e.g., R3, R4, R4B)
    const rMatch = version.match(/^R(\d+)/);
    if (rMatch) {
      return parseInt(rMatch[1]);
    }

    // Case 2: Check for digits at the start, possibly followed by period
    const numMatch = version.match(/^(\d+)(?:\.|\b)/);
    if (numMatch) {
      return parseInt(numMatch[1]);
    }

    // No valid version found
    return 0;
  }

  /**
   * Format bytes for display
   */
  formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Get the current registry data
   */
  getData() {
    return this.currentData;
  }

  /**
   * Get crawl metadata
   */
  getMetadata() {
    return {
      lastRun: this.currentData.lastRun,
      outcome: this.currentData.outcome,
      errors: this.errors,
      totalBytes: this.totalBytes,
      isCrawling: this.isCrawling
    };
  }

  /**
   * Load data from JSON
   */
  loadData(json) {
    this.currentData = ServerRegistries.fromJSON(json);
  }

  /**
   * Save data to JSON
   */
  saveData() {
    return this.currentData.toJSON();
  }

  /**
    * Add log entry to the crawler's log history
  * @param {string} level - Log level (info, error, warn, debug)
  * @param {string} message - Log message
  * @param {string} source - Source of the log
  */
  addLogEntry(level, message, source = '') {
    // Create log entry
    const entry = {
      timestamp: new Date(),
      level,
      message,
      source
    };

    // Initialize logs array if it doesn't exist
    if (!this.logs) {
      this.logs = [];
    }

    // Add to logs
    this.logs.push(entry);

    // Keep only the latest 1000 entries to avoid memory issues
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-1000);
    }

    // Also output to the configured logger
    if (this.log) {
      if (level === 'error') {
        this.log.error(message, source);
      } else if (level === 'warn') {
        this.log.warn(message, source);
      } else if (level === 'debug') {
        this.log.debug(message, source);
      } else {
        this.log.info(message, source);
      }
    }
  }

  /**
   * Get the log history
   * @param {number} limit - Maximum number of entries to return
   * @param {string} level - Filter by log level
   * @returns {Array} Array of log entries
   */
  getLogs(limit = 100)
  {
    if (!this.logs) {
      return [];
    }

    // Filter by level if specified
    let filteredLogs = this.logs;

    // Get the latest entries up to the limit
    return filteredLogs.slice(-limit);
  }

}

module.exports = RegistryCrawler;