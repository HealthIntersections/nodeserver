'use strict';

const {
  SqliteRuntimeV0FactoryProvider,
  SqliteRuntimeV0Provider,
  SqliteRuntimeV0Context,
  SqliteRuntimeV0FilterSet
} = require('./cs-sqlite-runtime-v0');

class SnomedSqliteV0FactoryProvider extends SqliteRuntimeV0FactoryProvider {
  constructor(i18n, dbPath) {
    super(i18n, dbPath, { idPrefix: 'snomed-sqlite-v0' });
  }
}

module.exports = {
  SnomedSqliteV0FactoryProvider,
  SnomedSqliteV0Provider: SqliteRuntimeV0Provider,
  SnomedSqliteV0Context: SqliteRuntimeV0Context,
  SnomedSqliteV0FilterSet: SqliteRuntimeV0FilterSet
};
