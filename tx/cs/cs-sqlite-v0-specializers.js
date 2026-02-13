'use strict';

const { SqliteRuntimeV0FactoryProvider } = require('./cs-sqlite-runtime-v0');

class LoincImplicitValueSetFactory extends SqliteRuntimeV0FactoryProvider {
  async buildKnownValueSet(url, version) {
    if (!this._loaded) {
      await this.load();
    }

    const system = this.system();
    if (!url || !system || !url.startsWith(`${system}/vs`)) {
      return super.buildKnownValueSet(url, version);
    }

    if (version && this._meta.canonicalUri && !this._meta.canonicalUri.startsWith(version)) {
      return null;
    }

    const vsBase = `${system}/vs`;
    if (url === vsBase || url === `${vsBase}/`) {
      return {
        resourceType: 'ValueSet',
        url,
        version: this._meta.version,
        status: 'active',
        name: `${sanitizeName(this.name())}All`,
        description: `All concepts from ${this.name()}`,
        compose: { include: [{ system }] }
      };
    }

    if (!url.startsWith(`${vsBase}/`)) {
      return super.buildKnownValueSet(url, version);
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

    return super.buildKnownValueSet(url, version);
  }
}

function sanitizeName(value) {
  return String(value || 'CS').replace(/[^A-Za-z0-9]/g, '').slice(0, 60) || 'CS';
}

SqliteRuntimeV0FactoryProvider.registerSpecializedFactory({
  id: 'loinc-implicit-valuesets',
  matchTags: ['loinc', 'implicit-vs-path'],
  priority: 100,
  createFactory: ({ i18n, dbPath, options }) => new LoincImplicitValueSetFactory(i18n, dbPath, options)
});

module.exports = {
  LoincImplicitValueSetFactory
};
