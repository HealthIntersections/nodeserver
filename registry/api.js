// Enhanced registry-api.js with resolver and HTML rendering functions

const {
  ServerRow,
  ServerRegistryUtilities
} = require('./model');

class RegistryAPI {
  constructor(crawler) {
    this.crawler = crawler;
  }

  /**
   * Build rows for code system queries
   * Matches the Pascal buildRowsCS functionality
   */
  buildRowsForCodeSystem(params = {}) {
    const {
      registryCode = '',
      serverCode = '',
      version = '',
      codeSystem = ''
    } = params;

    const rows = [];
    const data = this.crawler.getData();

    // Lock for thread safety during read
    data.lock('buildRowsCS');
    try {
      data.registries.forEach(registry => {
        if (registryCode && registry.code !== registryCode) return;

        registry.servers.forEach(server => {
          if (serverCode && server.code !== serverCode) return;

          // Check if server is authoritative for this code system
          const isAuth = codeSystem ? ServerRegistryUtilities.hasMatchingCodeSystem(
            codeSystem,
            server.authCSList,
            true // support wildcards
          ) : false;

          server.versions.forEach(versionInfo => {
            if (version && !ServerRegistryUtilities.versionMatches(version, versionInfo.version)) {
              return;
            }

            // Always skip servers with errors - they can't serve requests
            if (versionInfo.error) {
              return;
            }

            // Include if:
            // 1. Authoritative for the requested code system
            // 2. No filter specified
            // 3. Has the code system in its list
            if (isAuth ||
              !codeSystem ||
              (codeSystem && ServerRegistryUtilities.hasMatchingCodeSystem(
                codeSystem,
                versionInfo.codeSystems,
                false // no wildcards for actual content
              ))) {
              const row = ServerRegistryUtilities.createRow(
                registry,
                server,
                versionInfo,
                isAuth
              );
              rows.push(row);
            }
          });
        });
      });
    } finally {
      data.unlock();
    }

    return this._sortAndRankRows(rows);
  }

  /**
   * Build rows for value set queries
   * Matches the Pascal buildRowsVS functionality
   */
  buildRowsForValueSet(params = {}) {
    const {
      registryCode = '',
      serverCode = '',
      version = '',
      valueSet = ''
    } = params;

    const rows = [];
    const data = this.crawler.getData();

    data.lock('buildRowsVS');
    try {
      data.registries.forEach(registry => {
        if (registryCode && registry.code !== registryCode) return;

        registry.servers.forEach(server => {
          if (serverCode && server.code !== serverCode) return;

          // Check if server is authoritative for this value set
          const isAuth = valueSet ? ServerRegistryUtilities.hasMatchingValueSet(
            valueSet,
            server.authVSList,
            true // support wildcards
          ) : false;

          server.versions.forEach(versionInfo => {
            if (version && !ServerRegistryUtilities.versionMatches(version, versionInfo.version)) {
              return;
            }

            // Always skip servers with errors - they can't serve requests
            if (versionInfo.error) {
              return;
            }

            // Include if:
            // 1. No filter specified
            // 2. Authoritative for the value set (even via wildcard)
            // 3. Has the value set in its list
            let includeRow = false;

            if (!valueSet) {
              // No filter, include all working servers
              includeRow = true;
            } else {
              // Check if actually has the value set
              const hasValueSet = ServerRegistryUtilities.hasMatchingValueSet(
                valueSet,
                versionInfo.valueSets,
                false // no wildcards for actual content
              );

              // Include if authoritative OR has the value set
              // This matches the Pascal logic: if auth or hasMatchingValueSet
              if (isAuth || hasValueSet) {
                includeRow = true;
              }
            }

            if (includeRow) {
              const row = ServerRegistryUtilities.createRow(
                registry,
                server,
                versionInfo,
                isAuth
              );
              rows.push(row);
            }
          });
        });
      });
    } finally {
      data.unlock();
    }

    return this._sortAndRankRows(rows);
  }

  /**
   * Get all available registries
   */
  getRegistries() {
    const data = this.crawler.getData();
    return data.registries.map(r => ({
      code: r.code,
      name: r.name,
      address: r.address,
      authority: r.authority,
      error: r.error,
      serverCount: r.servers.length
    }));
  }

  /**
   * Get all servers for a registry
   */
  getServers(registryCode) {
    const data = this.crawler.getData();
    const registry = data.getRegistry(registryCode);

    if (!registry) {
      return null;
    }

    return registry.servers.map(s => ({
      code: s.code,
      name: s.name,
      address: s.address,
      description: s.getDescription(),
      details: s.getDetails(),
      versionCount: s.versions.length,
      authCSCount: s.authCSList.length,
      authVSCount: s.authVSList.length,
      usageTags: s.usageList
    }));
  }

  /**
   * Get server details
   */
  getServerDetails(registryCode, serverCode) {
    const data = this.crawler.getData();
    const registry = data.getRegistry(registryCode);

    if (!registry) {
      return null;
    }

    const server = registry.getServer(serverCode);
    if (!server) {
      return null;
    }

    return {
      ...server.toJSON(),
      versions: server.versions.map(v => ({
        ...v.toJSON(),
        details: v.getDetails(),
        csList: v.getCsListHtml(),
        vsList: v.getVsListHtml()
      }))
    };
  }

  /**
   * Get statistics about the registry
   */
  getStatistics() {
    const data = this.crawler.getData();

    let totalServers = 0;
    let totalVersions = 0;
    let totalCodeSystems = new Set();
    let totalValueSets = new Set();
    let errorCount = 0;
    let workingVersions = 0;

    data.registries.forEach(registry => {
      if (registry.error) errorCount++;

      registry.servers.forEach(server => {
        totalServers++;

        server.versions.forEach(version => {
          totalVersions++;
          if (version.error) {
            errorCount++;
          } else {
            workingVersions++;
          }

          version.codeSystems.forEach(cs => totalCodeSystems.add(cs));
          version.valueSets.forEach(vs => totalValueSets.add(vs));
        });
      });
    });

    return {
      lastRun: data.lastRun,
      outcome: data.outcome,
      registryCount: data.registries.length,
      serverCount: totalServers,
      versionCount: totalVersions,
      workingVersions: workingVersions,
      uniqueCodeSystems: totalCodeSystems.size,
      uniqueValueSets: totalValueSets.size,
      errorCount: errorCount
    };
  }

  /**
   * Sort and rank rows based on various criteria
   */
  _sortAndRankRows(rows) {
    return rows.sort((a, b) => {
      // 1. Authoritative servers first
      if (a.authoritative !== b.authoritative) {
        return a.authoritative ? -1 : 1;
      }

      // 2. No errors before errors
      const aHasError = a.error !== '';
      const bHasError = b.error !== '';
      if (aHasError !== bHasError) {
        return aHasError ? 1 : -1;
      }

      // 3. More recent success first (smaller lastSuccess value)
      if (a.lastSuccess !== b.lastSuccess) {
        // If one has never succeeded, put it last
        if (a.lastSuccess === 0) return 1;
        if (b.lastSuccess === 0) return -1;
        return a.lastSuccess - b.lastSuccess;
      }

      // 4. More resources is better
      const aResources = a.systems + a.sets;
      const bResources = b.systems + b.sets;
      if (aResources !== bResources) {
        return bResources - aResources;
      }

      // 5. Prefer newer versions
      const versionCompare = this._compareVersions(b.version, a.version);
      if (versionCompare !== 0) {
        return versionCompare;
      }

      // 6. Alphabetical by server name as tie-breaker
      return a.serverName.localeCompare(b.serverName);
    });
  }

  _normalizeFhirVersion(version) {
    if (!version) return version;

    // Convert R4 or r4 to 4.0, R5 or r5 to 5.0, etc.
    const rMatch = /^[rR](\d+)$/.exec(version);
    if (rMatch) {
      return `${rMatch[1]}.0`;
    }

    return version;
  }

  /**
   * Compare semantic versions
   */
  _compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(p => parseInt(p) || 0);
    const parts2 = v2.split('.').map(p => parseInt(p) || 0);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 !== p2) {
        return p1 - p2;
      }
    }

    return 0;
  }

  /**
   * Find best server for a given code system/value set
   */
  findBestServer(type, url, version) {
    let rows;

    if (type === 'codesystem') {
      rows = this.buildRowsForCodeSystem({ codeSystem: url, version });
    } else if (type === 'valueset') {
      rows = this.buildRowsForValueSet({ valueSet: url, version });
    } else {
      throw new Error(`Unknown type: ${type}`);
    }

    if (rows.length === 0) {
      return null;
    }

    // Return the top-ranked server
    return rows[0];
  }

  /**
   * Get the current data (for direct access)
   */
  getData() {
    return this.crawler.getData();
  }

  /**
   * Express middleware for handling API requests
   */
  expressMiddleware() {
    return (req, res, next) => {
      // Attach API instance to request
      req.registryAPI = this;
      next();
    };
  }

  /**
   * NEW FUNCTION: Resolve the best server for a code system
   * Based on Pascal resolveCS function
   */
  resolveCodeSystem(fhirVersion, codeSystem, authoritativeOnly, usage = '') {
    if (!fhirVersion) {
      throw new Error('A FHIR version is required');
    }
    if (!codeSystem) {
      throw new Error('A code system URL is required');
    }
    const normalizedVersion = this._normalizeFhirVersion(fhirVersion);

    const result = {
      formatVersion: '1',
      'registry-url': this.getData().address,
      authoritative: [],
      candidates: []
    };

    const matchedServers = [];
    const data = this.crawler.getData();

    // Extract base code system URL (before any pipe)
    let baseCodeSystem = codeSystem;
    if (codeSystem.includes('|')) {
      baseCodeSystem = codeSystem.substring(0, codeSystem.indexOf('|'));
    }

    // Lock for thread safety during read
    data.lock('resolveCS');
    try {
      data.registries.forEach(registry => {
        registry.servers.forEach(server => {
          let added = false;

          // Check if server supports the requested usage tag
          if (server.usageList.length === 0 ||
            (usage && server.usageList.includes(usage))) {

            // Check if server is authoritative for this code system
            const isAuth = server.isAuthCS(codeSystem);

            server.versions.forEach(version => {
              if (ServerRegistryUtilities.versionMatches(normalizedVersion, version.version)) {
                // Check if the server has the code system
                // Test against both the full URL and the base URL
                const hasMatchingCS =
                  ServerRegistryUtilities.hasMatchingCodeSystem(baseCodeSystem, version.codeSystems, false) ||
                  (baseCodeSystem !== codeSystem &&
                    ServerRegistryUtilities.hasMatchingCodeSystem(codeSystem, version.codeSystems, false));

                if (hasMatchingCS) {
                  if (isAuth) {
                    result.authoritative.push(this.createServerEntry(server, version));
                  } else if (!authoritativeOnly) {
                    result.candidates.push(this.createServerEntry(server, version));
                  }
                  added = true;
                }
              }
            });

            if (added) {
              matchedServers.push(server.code);
            }
          }
        });
      });
    } finally {
      data.unlock();
    }

    return {
      result : this._cleanEmptyArrays(result),
      matches: matchedServers.length > 0 ? matchedServers.join(',') : '--'
    };
  }

  /**
   * NEW FUNCTION: Resolve the best server for a value set
   * Based on Pascal resolveVS function
   */
  resolveValueSet(fhirVersion, valueSet, authoritativeOnly, usage = '') {
    if (!fhirVersion) {
      throw new Error('A FHIR version is required');
    }
    if (!valueSet) {
      throw new Error('A value set URL is required');
    }

    const normalizedVersion = this._normalizeFhirVersion(fhirVersion);

    const result = {
      formatVersion: '1',
      'registry-url': this.getData().address,
      authoritative: [],
      candidates: []
    };

    const matchedServers = [];
    const data = this.crawler.getData();

    // Extract base value set URL (before any pipe)
    let baseValueSet = valueSet;
    if (valueSet.includes('|')) {
      baseValueSet = valueSet.substring(0, valueSet.indexOf('|'));
    }

    // Lock for thread safety during read
    data.lock('resolveVS');
    try {
      data.registries.forEach(registry => {
        registry.servers.forEach(server => {
          let added = false;

          // Check if server supports the requested usage tag
          if (server.usageList.length === 0 ||
            (usage && server.usageList.includes(usage))) {

            // Check if server is authoritative for this value set
            const isAuth = server.isAuthVS(baseValueSet);

              server.versions.forEach(version => {
                if (ServerRegistryUtilities.versionMatches(normalizedVersion, version.version)) {
                  // For authoritative servers, we don't need to check if they have the value set
                  if (isAuth) {
                    result.authoritative.push(this.createServerEntry(server, version));
                    added = true;
                  }
                  // For non-authoritative servers, check if they have the value set
                  else if (ServerRegistryUtilities.hasMatchingValueSet(baseValueSet, version.valueSets, false) ||
                    (baseValueSet !== valueSet &&
                      ServerRegistryUtilities.hasMatchingValueSet(valueSet, version.valueSets, false))) {
                    if (!authoritativeOnly) {
                      result.candidates.push(this.createServerEntry(server, version));
                    }
                    added = true;
                  }
                }
              });

            if (added) {
              matchedServers.push(server.code);
            }
          }
        });
      });
    } finally {
      data.unlock();
    }

    return {
      result : this._cleanEmptyArrays(result),
      matches: matchedServers.length > 0 ? matchedServers.join(',') : '--'
    };
  }

  _cleanEmptyArrays(result) {
    const cleanedResult = { ...result };

    // Remove empty arrays
    Object.keys(cleanedResult).forEach(key => {
      if (Array.isArray(cleanedResult[key]) && cleanedResult[key].length === 0) {
        delete cleanedResult[key];
      }
    });

    return cleanedResult;
  }

  /**
   * Helper function to create a server entry for resolve results
   */
  createServerEntry(server, version) {
    const entry = {
      'server-name': server.name,
      url: version.address
    };

    if (version.security) {
      entry.security = version.security;
    }
    if (server.accessInfo) {
      entry.access_info = server.accessInfo;
    }

    return entry;
  }

  /**
   * NEW FUNCTION: Render a JSON result as an HTML table
   * Based on Pascal renderJson function
   */
  renderJsonToHtml(json, path, regCode = '', serverCode = '', versionCode = '') {
    let html = '<table class="grid">\n';
    html += '<tr>\n';
    
    if (!regCode) {
      html += '<td><b>Registry</b></td>\n';
    }
    if (!serverCode) {
      html += '<td><b>Server</b></td>\n';
    }
    if (!versionCode) {
      html += '<td><b>FHIR Version</b></td>\n';
    }
    
    html += '<td><b>Url</b></td>\n';
    html += '<td><b>Status</b></td>\n';
    html += '<td><b>Content</b></td>\n';
    html += '<td><b>Authoritative</b></td>\n';
    html += '<td><b>Security</b></td>\n';
    html += '</tr>\n';

    const results = json.results || [];
    for (const row of results) {
      html += '<tr>\n';
      
      if (!regCode) {
        html += `<td><a href="${path}&registry=${row['registry-code']}">${this._escapeHtml(row['registry-name'])}</a></td>\n`;
      }
      if (!serverCode) {
        html += `<td><a href="${path}&server=${row['server-code']}">${this._escapeHtml(row['server-name'])}</a></td>\n`;
      }
      if (!versionCode) {
        html += `<td><a href="${path}&fhirVersion=${row.fhirVersion}">${row.fhirVersion}</a></td>\n`;
      }
      
      html += `<td><a href="${this._escapeHtml(row.url)}">${this._escapeHtml(row.url)}</a></td>\n`;
      
      if (row.error) {
        html += `<td><span style="color: maroon">Error: ${this._escapeHtml(row.error)}</span> Last OK ${this._formatDuration(row['last-success'])} ago</td>\n`;
      } else {
        html += `<td>Last OK ${this._formatDuration(row['last-success'])} ago</td>\n`;
      }
      
      html += `<td>${row.systems} systems</td>\n`;
      
      html += '<td>';
      if (row['is-authoritative']) {
        html += 'true';
      }
      html += '</td>\n';

      html += `<td>${row.security}/td>\n`;

      html += '</tr>\n';
    }

    html += '</table>\n';
    return html;
  }

  /**
   * NEW FUNCTION: Render registry info as HTML
   * Based on Pascal renderInfo function
   */
  renderInfoToHtml() {
    const data = this.crawler.getData();
    let html = '<table class="grid">';
    
    html += `<tr><td width="130px"><img src="/assets/images/tx-registry-root.gif">&nbsp;Registries</td><td>${data.address} (${this._escapeHtml(data.outcome)})</td></tr>`;
    
    data.registries.forEach(registry => {
      if (registry.error) {
        html += `<tr><td title="${this._escapeHtml(registry.name)}">&nbsp;<img src="/assets/images/tx-registry.png">&nbsp;${registry.code}</td><td><a href="${this._escapeHtml(registry.address)}">${this._escapeHtml(registry.address)}</a>. Error: ${this._escapeHtml(registry.error)}</td></tr>`;
      } else {
        html += `<tr><td title="${this._escapeHtml(registry.name)}">&nbsp;&nbsp;<img src="/assets/images/tx-registry.png">&nbsp;${registry.code}</td><td><a href="${this._escapeHtml(registry.address)}">${this._escapeHtml(registry.address)}</a></td></tr>`;
      }
      
      registry.servers.forEach(server => {
        if (server.authCSList.length > 0 || server.authVSList.length > 0 || server.usageList.length > 0) {
          html += `<tr><td title="${this._escapeHtml(server.name)}">&nbsp;&nbsp;&nbsp;&nbsp;<img src="/assets/images/tx-server.png">&nbsp;${server.code}</td><td><a href="${this._escapeHtml(server.address)}">${this._escapeHtml(server.address)}</a>. ${server.description}</td></tr>`;
        } else {
          html += `<tr><td title="${this._escapeHtml(server.name)}">&nbsp;&nbsp;&nbsp;&nbsp;<img src="/assets/images/tx-server.png">&nbsp;${server.code}</td><td><a href="${this._escapeHtml(server.address)}">${this._escapeHtml(server.address)}</a></td></tr>`;
        }
        
        server.versions.forEach(version => {
          // Get major.minor version only
          const versionParts = version.version.split('.');
          const majorMinor = versionParts.slice(0, 2).join('.');
          
          html += `<tr><td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<img src="/assets/images/tx-version.png">&nbsp;v${majorMinor}</td><td><a href="${this._escapeHtml(version.address)}">${this._escapeHtml(version.address)}</a>. Status: ${this._escapeHtml(version.details)}. ${version.codeSystems.length} CodeSystems, ${version.valueSets.length} ValueSets</td></tr>`;
        });
      });
    });
    
    html += '</table>';
    return html;
  }

  /**
   * Helper function to format a duration in seconds to a human-readable string
   */
  _formatDuration(seconds) {
    if (seconds < 60) {
      return `${seconds} seconds`;
    } else if (seconds < 3600) {
      return `${Math.floor(seconds / 60)} minutes`;
    } else if (seconds < 86400) {
      return `${Math.floor(seconds / 3600)} hours`;
    } else {
      return `${Math.floor(seconds / 86400)} days`;
    }
  }

  /**
   * Helper function to escape HTML special characters
   */
  _escapeHtml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

module.exports = RegistryAPI;