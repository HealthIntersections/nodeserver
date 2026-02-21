'use strict';

const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');
const sqlite3 = require('sqlite3').verbose();

const { BaseTerminologyModule } = require('./tx-import-base');
const { SnomedSqliteV0Importer } = require('./sqlite-v2/import-snomed-v0');

class SnomedSqliteV0Module extends BaseTerminologyModule {
  getName() {
    return 'snomed-sqlite-v0';
  }

  getDescription() {
    return 'SNOMED CT RF2 Snapshot -> SQLite (clean v0 schema)';
  }

  getSupportedFormats() {
    return ['rf2', 'directory'];
  }

  getDefaultConfig() {
    return {
      verbose: true,
      overwrite: false,
      snapshotOnly: true,
      skipRefsets: false,
      skipClosure: false,
      edition: '900000000000207008',
      dest: './data/snomed-v0.db'
    };
  }

  getEstimatedDuration() {
    return '30-180 minutes (depends on edition size and closure)';
  }

  registerCommands(terminologyCommand, globalOptions) {
    terminologyCommand
      .command('import')
      .description('Import SNOMED CT RF2 into SQLite v0 schema')
      .option('-s, --source <directory>', 'Source directory containing RF2 files (ideally Snapshot root)')
      .option('-d, --dest <file>', 'Destination SQLite file')
      .option('-e, --edition <code>', 'Edition code (e.g., 900000000000207008 or 731000124108)')
      .option('--snomed-version <YYYYMMDD>', 'Version date in YYYYMMDD format')
      .option('-u, --uri <uri>', 'Canonical SNOMED URI; overrides edition+version')
      .option('--skip-refsets', 'Skip refset/value-set membership import')
      .option('--skip-closure', 'Deprecated/ignored: closure is always built')
      .option('--include-non-snapshot', 'Include non-Snapshot RF2 files in discovery')
      .option('--overwrite', 'Overwrite destination database if it exists')
      .option('-y, --yes', 'Skip confirmations')
      .action(async (options) => {
        await this.handleImportCommand({ ...globalOptions, ...options });
      });

    terminologyCommand
      .command('validate')
      .description('Validate source path and discover RF2 file classes')
      .option('-s, --source <directory>', 'Source directory')
      .option('--include-non-snapshot', 'Include non-Snapshot RF2 files in discovery')
      .action(async (options) => {
        await this.handleValidateCommand({ ...globalOptions, ...options });
      });

    terminologyCommand
      .command('status')
      .description('Show status of a generated SQLite v0 SNOMED database')
      .option('-d, --dest <file>', 'Database file path', './data/snomed-v0.db')
      .action(async (options) => {
        await this.handleStatusCommand({ ...globalOptions, ...options });
      });
  }

  async handleImportCommand(options) {
    try {
      const config = options.yes
        ? this.buildNonInteractiveConfig(options)
        : await this.gatherConfig(options);

      if (!options.yes) {
        const confirmed = await this.confirmImport(config);
        if (!confirmed) {
          this.logInfo('Import cancelled');
          return;
        }
      }

      this.rememberSuccessfulConfig(config);
      await this.runImportWithoutConfigSaving(config);
    } catch (error) {
      this.logError(`Import command failed: ${error.message}`);
      if (options.verbose) {
        console.error(error.stack);
      }
      throw error;
    }
  }

  async gatherConfig(options) {
    const baseConfig = await this.gatherCommonConfig(options);

    const config = {
      ...baseConfig,
      edition: options.edition || baseConfig.edition || '900000000000207008',
      version: options.snomedVersion || options.version || baseConfig.version,
      uri: options.uri || baseConfig.uri,
      skipRefsets: !!options.skipRefsets,
      skipClosure: false,
      snapshotOnly: !options.includeNonSnapshot
    };

    if (!config.uri && !config.version) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'version',
          message: 'SNOMED version (YYYYMMDD):',
          validate: validateVersion
        }
      ]);
      config.version = answers.version;
    }

    const parsed = parseSnomedUri(config.uri);
    if (!config.version && parsed.version) {
      config.version = parsed.version;
    }
    if (!config.edition && parsed.edition) {
      config.edition = parsed.edition;
    }

    if (!config.uri) {
      config.uri = `http://snomed.info/sct/${config.edition}/version/${config.version}`;
    }

    if (!options.dest && shouldAutoAssignDest(config.dest) && config.version) {
      config.dest = buildDefaultDest(config.edition, config.version);
    }
    if (options.skipClosure) {
      this.logWarning('--skip-closure ignored: closure is always built');
    }

    return config;
  }

  buildNonInteractiveConfig(options) {
    const parsed = parseSnomedUri(options.uri);
    const edition = options.edition || this.getDefaultConfig().edition || parsed.edition;
    const version = options.snomedVersion || options.version || parsed.version;
    const config = {
      ...this.getDefaultConfig(),
      ...options,
      source: options.source,
      dest: options.dest || buildDefaultDest(edition, version),
      edition,
      version,
      uri: options.uri,
      skipRefsets: !!options.skipRefsets,
      skipClosure: false,
      snapshotOnly: !options.includeNonSnapshot,
      overwrite: !!options.overwrite,
      verbose: !!options.verbose
    };

    if (!config.uri && config.edition && config.version) {
      config.uri = `http://snomed.info/sct/${config.edition}/version/${config.version}`;
    }

    if (!config.source) {
      throw new Error('source is required when using --yes');
    }
    if (!config.uri && !config.version) {
      throw new Error('Provide --uri or --snomed-version with --edition when using --yes');
    }
    if (options.skipClosure) {
      this.logWarning('--skip-closure ignored: closure is always built');
    }

    return config;
  }

  async confirmImport(config) {
    console.log('\nSNOMED SQLite v0 Import Configuration:');
    console.log(`  Source:       ${config.source}`);
    console.log(`  Destination:  ${config.dest}`);
    console.log(`  URI:          ${config.uri}`);
    console.log(`  SnapshotOnly: ${config.snapshotOnly ? 'Yes' : 'No'}`);
    console.log(`  Skip Refsets: ${config.skipRefsets ? 'Yes' : 'No'}`);
    console.log(`  Skip Closure: ${config.skipClosure ? 'Yes' : 'No'}`);
    console.log(`  Overwrite:    ${config.overwrite ? 'Yes' : 'No'}`);

    const answer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Proceed with import?',
        default: true
      }
    ]);

    return answer.confirmed;
  }

  async runImportWithoutConfigSaving(config) {
    try {
      const importer = new SnomedSqliteV0Importer(config);
      const result = await importer.run();
      this.logSuccess(`SNOMED SQLite v0 import complete: ${result.uri}`);
      this.logSuccess(`Concepts: ${result.stats.concepts.toLocaleString()}, Descriptions: ${result.stats.descriptions.toLocaleString()}, Relationships: ${result.stats.relationships.toLocaleString()}`);
    } catch (error) {
      this.logError(`SNOMED SQLite v0 import failed: ${error.message}`);
      if (config.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  }

  async handleValidateCommand(options) {
    const source = options.source || (await promptForSource());

    if (!fs.existsSync(source)) {
      this.logError(`Source does not exist: ${source}`);
      return;
    }

    const snapshotOnly = !options.includeNonSnapshot;
    const files = SnomedSqliteV0Importer.discoverRf2Files(source, { snapshotOnly });

    console.log('\nDiscovered RF2 file classes:');
    console.log(`  Concepts:         ${files.concepts.length}`);
    console.log(`  Descriptions:     ${files.descriptions.length}`);
    console.log(`  Relationships:    ${files.relationships.length}`);
    console.log(`  Concrete Values:  ${files.concreteValues.length}`);
    console.log(`  Language Refsets: ${files.languageRefsets.length}`);
    console.log(`  Any Refsets:      ${files.refsets.length}`);

    const ok = files.concepts.length > 0 && files.descriptions.length > 0;
    if (ok) {
      this.logSuccess('Validation passed');
    } else {
      this.logError('Validation failed: concepts and descriptions are required');
    }
  }

  async handleStatusCommand(options) {
    const dbPath = path.resolve(options.dest || './data/snomed-v0.db');

    if (!fs.existsSync(dbPath)) {
      this.logError(`Database not found: ${dbPath}`);
      return;
    }

    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);

    try {
      const codeSystem = await getRow(db, 'SELECT cs_id, canonical_uri, edition_code, version, loaded_at FROM code_system ORDER BY cs_id DESC LIMIT 1', []);
      if (!codeSystem) {
        this.logWarning('No code_system rows found');
        return;
      }

      const [concepts, descriptions, relationships, refsets, closure] = await Promise.all([
        getRow(db, 'SELECT COUNT(*) AS n FROM concept WHERE cs_id = ?', [codeSystem.cs_id]),
        getRow(
          db,
          `SELECT COUNT(*) AS n
           FROM designation d
           JOIN concept c ON c.concept_id = d.concept_id
           WHERE c.cs_id = ?`,
          [codeSystem.cs_id]
        ),
        getRow(
          db,
          `SELECT COUNT(*) AS n
           FROM concept_link l
           JOIN concept c ON c.concept_id = l.source_concept_id
           WHERE c.cs_id = ?`,
          [codeSystem.cs_id]
        ),
        getRow(db, 'SELECT COUNT(*) AS n FROM value_set WHERE cs_id = ?', [codeSystem.cs_id]),
        getRow(
          db,
          `SELECT COUNT(*) AS n
           FROM closure cl
           JOIN concept c ON c.concept_id = cl.ancestor_id
           WHERE c.cs_id = ?`,
          [codeSystem.cs_id]
        )
      ]);

      const [ftsDisplay, ftsDesignation, ftsLiteral] = await Promise.all([
        getCountIfTableExists(db, 'search_fts_display'),
        getCountIfTableExists(db, 'search_fts_designation'),
        getCountIfTableExists(db, 'search_fts_literal')
      ]);

      console.log('\nSNOMED SQLite v0 Status:');
      console.log(`  DB:            ${dbPath}`);
      console.log(`  Canonical URI: ${codeSystem.canonical_uri}`);
      console.log(`  Edition:       ${codeSystem.edition_code || '(none)'}`);
      console.log(`  Version:       ${codeSystem.version || '(none)'}`);
      console.log(`  Loaded At:     ${codeSystem.loaded_at}`);
      console.log(`  Concepts:      ${(concepts?.n || 0).toLocaleString()}`);
      console.log(`  Descriptions:  ${(descriptions?.n || 0).toLocaleString()}`);
      console.log(`  Relationships: ${(relationships?.n || 0).toLocaleString()}`);
      console.log(`  Refsets:       ${(refsets?.n || 0).toLocaleString()}`);
      console.log(`  Closure rows:  ${(closure?.n || 0).toLocaleString()}`);
      console.log(`  FTS display:   ${(ftsDisplay?.n || 0).toLocaleString()}`);
      console.log(`  FTS desig.:    ${(ftsDesignation?.n || 0).toLocaleString()}`);
      console.log(`  FTS literal:   ${(ftsLiteral?.n || 0).toLocaleString()}`);

      this.logSuccess('Status read complete');
    } finally {
      await closeDb(db);
    }
  }
}

function validateVersion(input) {
  if (!input) return 'Version is required';
  if (!/^\d{8}$/.test(input)) return 'Version must be YYYYMMDD';

  const year = Number(input.slice(0, 4));
  const month = Number(input.slice(4, 6));
  const day = Number(input.slice(6, 8));

  if (year < 1900 || year > 2100) return 'Invalid year';
  if (month < 1 || month > 12) return 'Invalid month';
  if (day < 1 || day > 31) return 'Invalid day';

  return true;
}

async function promptForSource() {
  const answer = await inquirer.prompt([
    {
      type: 'input',
      name: 'source',
      message: 'Source directory:',
      validate: (input) => input ? true : 'Source is required'
    }
  ]);

  return answer.source;
}

function getRow(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function getCountIfTableExists(db, tableName) {
  const exists = await getRow(
    db,
    `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    [tableName]
  );
  if (!exists) {
    return { n: 0 };
  }
  return getRow(db, `SELECT COUNT(*) AS n FROM ${tableName}`, []);
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function parseSnomedUri(uri) {
  if (!uri || typeof uri !== 'string') {
    return { edition: null, version: null };
  }
  const m = uri.match(/^https?:\/\/snomed\.info\/sct\/([^/]+)\/version\/(\d{8})$/i);
  if (!m) {
    return { edition: null, version: null };
  }
  return { edition: m[1], version: m[2] };
}

function buildDefaultDest(edition, version) {
  if (!version) {
    return path.resolve('./data/snomed-v0.db');
  }
  const label =
    edition === '900000000000207008'
      ? 'intl'
      : edition === '731000124108'
        ? 'us'
        : String(edition || 'edition');
  return path.resolve(`./data/sct_${label}_${version}.v0.db`);
}

function shouldAutoAssignDest(dest) {
  if (!dest) return true;
  const resolved = path.resolve(dest);
  return (
    resolved === path.resolve('./data/snomed-v0.db') ||
    resolved === path.resolve('./data/snomed-sqlite-v0.db')
  );
}

module.exports = {
  SnomedSqliteV0Module
};
