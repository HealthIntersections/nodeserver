// registry-model.js
// Data model for terminology server registry

class ServerVersionInformation {
  constructor() {
    this.version = '';
    this.address = '';
    this.security = '';
    this.error = '';
    this.lastSuccess = null; // Date object
    this.lastTat = '';
    this.software = ''; // what software is running
    this.codeSystems = []; // Array of strings (sorted, unique)
    this.valueSets = []; // Array of strings (sorted, unique)
  }

  update(source) {
    this.address = source.address;
    this.error = source.error;
    if (!source.error) {
      this.security = source.security;
      this.lastSuccess = source.lastSuccess;
      this.codeSystems = [...source.codeSystems];
      this.valueSets = [...source.valueSets];
      this.lastTat = source.lastTat;
    }
  }

  getDetails() {
    let result = this.error ? this.error : 'Server Processed Ok';
    const lastSeenStr = this.lastSuccess ? this.lastSuccess.toISOString() : 'never';
    result += ` (last seen ${lastSeenStr}, last tat = ${this.lastTat})`;
    return result;
  }

  getCsListHtml() {
    if (this.codeSystems.length === 0) return '<ul></ul>';
    return '<ul>' + this.codeSystems.map(cs => 
      `<li>${this._escapeHtml(cs)}</li>`
    ).join('') + '</ul>';
  }

  getVsListHtml() {
    if (this.valueSets.length === 0) return '<ul></ul>';
    return '<ul>' + this.valueSets.map(vs => 
      `<li>${this._escapeHtml(vs)}</li>`
    ).join('') + '</ul>';
  }

  _escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  toJSON() {
    return {
      version: this.version,
      address: this.address,
      security: this.security,
      error: this.error,
      'last-success': this.lastSuccess?.toISOString() || '',
      lastTat: this.lastTat,
      terminologies: this.codeSystems,
      software: this.software,
      valuesets: this.valueSets
    };
  }

  static fromJSON(json) {
    const instance = new ServerVersionInformation();
    instance.version = json.version || '';
    instance.address = json.address || '';
    instance.security =  typeof json.security === 'string' ? json.security : "";
    instance.error = json.error || '';
    instance.lastSuccess = json['last-success'] ? new Date(json['last-success']) : null;
    instance.lastTat = json.lastTat || '';
    instance.software = json.software;
    instance.codeSystems = json.terminologies || [];
    instance.valueSets = json.valuesets || [];
    return instance;
  }
}

class ServerInformation {
  constructor() {
    this.code = '';
    this.name = '';
    this.address = '';
    this.accessInfo = '';
    this.authCSList = []; // Authoritative code systems (with wildcards)
    this.authVSList = []; // Authoritative value sets (with wildcards)
    this.usageList = []; // Usage tags
    this.versions = []; // Array of ServerVersionInformation
  }

  getVersion(ver) {
    return this.versions.find(v => v.version === ver) || null;
  }

  update(source) {
    this.name = source.name;
    this.address = source.address;
    this.accessInfo = source.accessInfo;
    this.authCSList = [...source.authCSList];
    this.authVSList = [...source.authVSList];
    this.usageList = [...source.usageList];
    
    source.versions.forEach(sourceVersion => {
      const existing = this.getVersion(sourceVersion.version);
      if (existing) {
        existing.update(sourceVersion);
      } else {
        this.versions.push(sourceVersion);
      }
    });
  }

  getDetails() {
    return this.accessInfo;
  }

  isAuthCS(codeSystem) {
    return this.authCSList.some(mask => this._passesMask(mask, codeSystem));
  }

  isAuthVS(valueSet) {
    return this.authVSList.some(mask => this._passesMask(mask, valueSet));
  }

  _passesMask(mask, value) {
    if (mask.endsWith('*')) {
      return value.startsWith(mask.slice(0, -1));
    }
    return value === mask;
  }

  getDescription() {
    let result = '';
    
    if (this.usageList.length > 0) {
      result = `Usage Tags: ${this.usageList.join(', ')}`;
    }
    
    if (this.authCSList.length > 0) {
      if (result) result += '. ';
      result += 'Authoritative for the following CodeSystems: <ul>';
      this.authCSList.forEach(cs => {
        const escaped = this._escapeHtml(cs).replace('*', '<b>*</b>');
        result += `<li>${escaped}</li>`;
      });
      result += '</ul>';
    }
    
    if (this.authVSList.length > 0) {
      if (result) result += '. ';
      result += 'Authoritative for the following ValueSets: <ul>';
      this.authVSList.forEach(vs => {
        const escaped = this._escapeHtml(vs).replace('*', '<b>*</b>');
        result += `<li>${escaped}</li>`;
      });
      result += '</ul>';
    }
    
    return result;
  }

  _escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  toJSON() {
    return {
      code: this.code,
      name: this.name,
      address: this.address,
      'access-info': this.accessInfo,
      authoritative: this.authCSList.join(','),
      'authoritative-valuesets': this.authVSList.join(','),
      usageList: this.usageList,
      versions: this.versions.map(v => v.toJSON())
    };
  }

  static fromJSON(json) {
    const instance = new ServerInformation();
    instance.code = json.code || '';
    instance.name = json.name || '';
    instance.address = json.address || '';
    instance.accessInfo = json['access-info'] || '';
    instance.authCSList = json.authoritative 
      ? json.authoritative.split(',').filter(s => s)
      : [];
    instance.authVSList = json['authoritative-valuesets'] 
      ? json['authoritative-valuesets'].split(',').filter(s => s)
      : [];
    instance.usageList = json.usageList || [];
    instance.versions = (json.versions || []).map(v => ServerVersionInformation.fromJSON(v));
    return instance;
  }
}

class ServerRegistry {
  constructor() {
    this.code = '';
    this.name = '';
    this.address = '';
    this.authority = '';
    this.error = '';
    this.servers = []; // Array of ServerInformation
  }

  getServer(code) {
    return this.servers.find(s => s.code === code) || null;
  }

  update(source) {
    this.name = source.name;
    this.address = source.address;
    this.authority = source.authority;
    this.error = source.error;
    
    source.servers.forEach(sourceServer => {
      const existing = this.getServer(sourceServer.code);
      if (existing) {
        existing.update(sourceServer);
      } else {
        this.servers.push(sourceServer);
      }
    });
  }

  toJSON() {
    return {
      code: this.code,
      name: this.name,
      address: this.address,
      authority: this.authority,
      error: this.error,
      servers: this.servers.map(s => s.toJSON())
    };
  }

  static fromJSON(json) {
    const instance = new ServerRegistry();
    instance.code = json.code || '';
    instance.name = json.name || '';
    instance.address = json.address || '';
    instance.authority = json.authority || '';
    instance.error = json.error || '';
    instance.servers = (json.servers || []).map(s => ServerInformation.fromJSON(s));
    return instance;
  }
}

class ServerRegistries {
  constructor() {
    this.address = '';
    this.doco = '';
    this.lastRun = null; // Date object
    this.outcome = '';
    this.registries = []; // Array of ServerRegistry
    this._lockName = null; // For tracking lock state
  }

  lock(name) {
    // In Node.js, we might use async locks or mutexes
    // For now, this is a simple flag-based approach
    this._lockName = name;
  }

  unlock() {
    this._lockName = null;
  }

  getRegistry(code) {
    return this.registries.find(r => r.code === code) || null;
  }

  update(source) {
    this.lastRun = source.lastRun;
    this.outcome = source.outcome;
    this.doco = source.doco;
    
    source.registries.forEach(sourceRegistry => {
      const existing = this.getRegistry(sourceRegistry.code);
      if (existing) {
        existing.update(sourceRegistry);
      } else {
        this.registries.push(sourceRegistry);
      }
    });
  }

  toJSON() {
    return {
      version: '1',
      address: this.address,
      doco: this.doco,
      'last-run': this.lastRun?.toISOString() || '',
      outcome: this.outcome,
      registries: this.registries.map(r => r.toJSON())
    };
  }

  static fromJSON(json) {
    if (json.version !== '1') {
      throw new Error(`Unsupported version ${json.version}`);
    }
    
    const instance = new ServerRegistries();
    instance.address = json.address || '';
    instance.doco = json.doco || '';
    instance.lastRun = json['last-run'] ? new Date(json['last-run']) : null;
    instance.outcome = json.outcome || '';
    instance.registries = (json.registries || []).map(r => ServerRegistry.fromJSON(r));
    return instance;
  }
}

// ServerRow is a flattened representation for API responses
class ServerRow {
  constructor() {
    this.serverName = '';
    this.serverCode = '';
    this.registryName = '';
    this.registryCode = '';
    this.registryUrl = '';
    this.authCSList = [];
    this.authVSList = [];
    this.version = '';
    this.url = '';
    this.error = '';
    this.security = '';
    this.lastSuccess = 0; // milliseconds since last success
    this.systems = 0; // count of code systems
    this.sets = 0; // count of value sets
    this.authoritative = false;
  }

  toJSON() {
    const json = {
      'server-name': this.serverName,
      'server-code': this.serverCode,
      'registry-name': this.registryName,
      'registry-code': this.registryCode,
      'registry-url': this.registryUrl,
      url: this.url,
      version: this.version,
      error: this.error,
      'last-success': this.lastSuccess,
      systems: this.systems,
      security: this.security,
      sets: this.sets
    };
    
    if (this.authoritative) {
      json['is-authoritative'] = true;
    }
    
    if (this.authCSList.length > 0) {
      json.authoritative = this.authCSList;
    }
    
    if (this.authVSList.length > 0) {
      json['authoritative-valuesets'] = this.authVSList;
    }

    
    return json;
  }

  static fromJSON(json) {
    const instance = new ServerRow();
    instance.serverName = json['server-name'] || '';
    instance.serverCode = json['server-code'] || '';
    instance.registryName = json['registry-name'] || '';
    instance.registryCode = json['registry-code'] || '';
    instance.registryUrl = json['registry-url'] || '';
    instance.url = json.url || '';
    instance.version = json.version || '';
    instance.error = json.error || '';
    instance.lastSuccess = json['last-success'] || 0;
    instance.systems = json.systems || 0;
    instance.sets = json.sets || 0;
    instance.authoritative = json['is-authoritative'] || false;
    instance.authCSList = json.authoritative || [];
    instance.authVSList = json['authoritative-valuesets'] || [];
    instance.security = json['security'] || '';

    return instance;
  }
}

// Utility functions (similar to TServerRegistryUtilities)
class ServerRegistryUtilities {
  static passesMask(mask, value) {
    if (mask.endsWith('*')) {
      return value.startsWith(mask.slice(0, -1));
    }
    return value === mask;
  }

  static hasMatchingCodeSystem(cs, list, supportMask) {
    if (!cs || list.length === 0) return false;

    // Handle URLs with pipes - extract base URL
    let baseCs = cs;
    if (cs.includes('|')) {
      baseCs = cs.substring(0, cs.indexOf('|'));
    }

    return list.some(item => {
      // If we support wildcards (masks) and the item ends with "*", do prefix matching
      if (supportMask && item.endsWith('*')) {
        const prefix = item.slice(0, -1);
        return cs.startsWith(prefix) || baseCs.startsWith(prefix);
      }

      // Otherwise do exact matching on both full and base URL
      return item === cs || item === baseCs;
    });
  }

  static hasMatchingValueSet(vs, list, supportMask) {
    let baseVs = vs;
    if (vs.includes('|')) {
      baseVs = vs.substring(0, vs.indexOf('|'));
    }
    
    return list.some(item => {
      if (supportMask && this.passesMask(item, vs)) {
        return true;
      }
      if (!supportMask && (item === vs || item === baseVs)) {
        return true;
      }
      return false;
    });
  }

  static versionMatches(requested, available) {
    // Simple semantic version matching
    if (!requested || !available) return true;
    
    if (requested === available) return true;
    
    // Check if available starts with requested version
    // e.g., "4.0" matches "4.0.1"
    if (available.startsWith(requested + '.')) return true;
    
    // More sophisticated semver matching could be added here
    const requestedParts = requested.split('.');
    const availableParts = available.split('.');
    
    for (let i = 0; i < requestedParts.length; i++) {
      if (i >= availableParts.length) return false;
      if (requestedParts[i] !== availableParts[i]) return false;
    }
    
    return true;
  }

  static createRow(registry, server, version, isAuthoritative) {
    const row = new ServerRow();
    
    row.authoritative = isAuthoritative;
    row.serverName = server.name;
    row.serverCode = server.code;
    row.registryName = registry.name;
    row.registryCode = registry.code;
    row.registryUrl = registry.address;
    
    row.url = version.address;
    row.error = version.error;
    row.version = version.version;
    row.security = version.security;
    row.systems = version.codeSystems.length;
    row.sets = version.valueSets.length;
    row.authCSList = [...server.authCSList];
    row.authVSList = [...server.authVSList];
    
    // Calculate milliseconds since last success
    if (version.lastSuccess) {
      row.lastSuccess = Math.floor(Date.now() - version.lastSuccess.getTime());
    } else {
      row.lastSuccess = 0;
    }
    
    return row;
  }
}

module.exports = {
  ServerVersionInformation,
  ServerInformation,
  ServerRegistry,
  ServerRegistries,
  ServerRow,
  ServerRegistryUtilities
};