'use strict';

const {
  SqliteRuntimeV0FactoryProvider,
  SqliteRuntimeV0Provider,
  SqliteRuntimeV0Context,
  SqliteRuntimeV0FilterSet
} = require('./cs-sqlite-runtime-v0');

class LoincSqliteV0FactoryProvider extends SqliteRuntimeV0FactoryProvider {
  constructor(i18n, dbPath) {
    super(i18n, dbPath, { idPrefix: 'loinc-sqlite-v0' });
  }

  async buildKnownValueSet(url, version) {
    if (!this._loaded) {
      await this.load();
    }

    const system = this.system();
    if (!url || !system || !url.startsWith(`${system}/vs`)) {
      return null;
    }

    if (version && this._meta.canonicalUri && !this._meta.canonicalUri.startsWith(version)) {
      return null;
    }

    const vsBase = `${system}/vs`;
    if (url === vsBase || url === `${vsBase}/`) {
      return makeAllValueSet(url, this._meta.version, this.name(), system);
    }

    if (!url.startsWith(`${vsBase}/`)) {
      return null;
    }

    const token = decodeURIComponent(url.substring(vsBase.length + 1));

    if (token.startsWith('LL')) {
      return {
        resourceType: 'ValueSet',
        url,
        version: this._meta.version,
        status: 'active',
        name: `LOINCAnswerList${sanitizeName(token)}`,
        compose: {
          include: [{
            system,
            filter: [{ property: 'LIST', op: '=', value: token }]
          }]
        }
      };
    }

    if (token.startsWith('LP')) {
      return {
        resourceType: 'ValueSet',
        url,
        version: this._meta.version,
        status: 'active',
        name: `LOINCPart${sanitizeName(token)}`,
        compose: {
          include: [{
            system,
            filter: [{ property: 'concept', op: 'is-a', value: token }]
          }]
        }
      };
    }

    return null;
  }
}

function makeAllValueSet(url, version, name, system) {
  return {
    resourceType: 'ValueSet',
    url,
    version,
    status: 'active',
    name: `${sanitizeName(name)}All`,
    description: `All concepts from ${name}`,
    compose: { include: [{ system }] }
  };
}

function sanitizeName(value) {
  return String(value || 'LOINC').replace(/[^A-Za-z0-9]/g, '').slice(0, 60) || 'LOINC';
}

module.exports = {
  LoincSqliteV0FactoryProvider,
  LoincSqliteV0Provider: SqliteRuntimeV0Provider,
  LoincSqliteV0Context: SqliteRuntimeV0Context,
  LoincSqliteV0FilterSet: SqliteRuntimeV0FilterSet
};
