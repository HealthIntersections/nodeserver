'use strict';

const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');
const sqlite3 = require('sqlite3').verbose();

const { BaseTerminologyModule } = require('./tx-import-base');
const { RxNormSqliteV0Importer } = require('./sqlite-v2/import-rxnorm-v0');

class RxNormSqliteV0Module extends BaseTerminologyModule {
  getName() {
    return 'rxnorm-sqlite-v0';
  }

  getDescription() {
    return 'RxNorm RRF -> SQLite (clean v0 schema)';
  }

  getSupportedFormats() {
    return ['rrf', 'directory', 'zip'];
  }

  getDefaultConfig() {
    return {
      verbose: true,
      overwrite: false,
      skipClosure: false,
      dest: './data/rxnorm-v0.db'
    };
  }

  getEstimatedDuration() {
    return '5-45 minutes (depends on source size and closure)';
  }

  registerCommands(terminologyCommand, globalOptions) {
    terminologyCommand
      .command('import')
      .description('Import RxNorm RRF into SQLite v0 schema')
      .option('-s, --source <path>', 'Source directory or RxNorm .zip release')
      .option('-d, --dest <file>', 'Destination SQLite file')
      .option('-v, --rxnorm-version <MMDDYYYY>', 'RxNorm version date (e.g., 02022026)')
      .option('-u, --uri <uri>', 'Canonical URI; overrides default base|version')
      .option('--skip-closure', 'Skip closure table generation')
      .option('--overwrite', 'Overwrite destination database if it exists')
      .option('-y, --yes', 'Skip confirmations')
      .action(async (options) => {
        await this.handleImportCommand({ ...globalOptions, ...options });
      });

    terminologyCommand
      .command('validate')
      .description('Validate source path and discover RxNorm RRF files')
      .option('-s, --source <path>', 'Source directory or zip file')
      .action(async (options) => {
        await this.handleValidateCommand({ ...globalOptions, ...options });
      });

    terminologyCommand
      .command('status')
      .description('Show status of a generated SQLite v0 RxNorm database')
      .option('-d, --dest <file>', 'Database file path', './data/rxnorm-v0.db')
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
      version: options.rxnormVersion || options.version || baseConfig.version,
      uri: options.uri || baseConfig.uri,
      skipClosure: !!options.skipClosure
    };

    if (!config.version && !config.uri) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'version',
          message: 'RxNorm version (MMDDYYYY):',
          validate: validateVersion
        }
      ]);
      config.version = answers.version;
    }

    return config;
  }

  buildNonInteractiveConfig(options) {
    const config = {
      ...this.getDefaultConfig(),
      ...options,
      source: options.source,
      dest: options.dest || this.getDefaultConfig().dest,
      version: options.rxnormVersion || options.version,
      uri: options.uri,
      skipClosure: !!options.skipClosure,
      overwrite: !!options.overwrite,
      verbose: !!options.verbose
    };

    if (!config.source) {
      throw new Error('source is required when using --yes');
    }
    if (!config.version && !config.uri) {
      throw new Error('Provide --rxnorm-version or --uri when using --yes');
    }
    if (config.version) {
      const valid = validateVersion(config.version);
      if (valid !== true) {
        throw new Error(valid);
      }
    }

    return config;
  }

  async confirmImport(config) {
    console.log('\nRxNorm SQLite v0 Import Configuration:');
    console.log(`  Source:       ${config.source}`);
    console.log(`  Destination:  ${config.dest}`);
    console.log(`  Version:      ${config.version || '(auto/none)'}`);
    console.log(`  URI:          ${config.uri || '(auto)'}`);
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
      const importer = new RxNormSqliteV0Importer(config);
      const result = await importer.run();
      this.logSuccess(`RxNorm SQLite v0 import complete: ${result.uri}`);
      this.logSuccess(
        `Concepts: ${result.stats.concepts.toLocaleString()}, ` +
        `Designations: ${result.stats.designations.toLocaleString()}, ` +
        `Relationships: ${result.stats.relationships.toLocaleString()}`
      );
    } catch (error) {
      this.logError(`RxNorm SQLite v0 import failed: ${error.message}`);
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

    let discoverySource = source;
    if (fs.statSync(source).isFile() && source.toLowerCase().endsWith('.zip')) {
      console.log('\nZip source provided. Validation confirms path exists; RRF listing occurs at import-time extraction.');
      this.logSuccess('Validation passed');
      return;
    }

    discoverySource = path.resolve(discoverySource);
    const files = RxNormSqliteV0Importer.discoverRrfFiles(discoverySource);

    console.log('\nDiscovered RRF files:');
    console.log(`  RXNCONSO: ${files.rxnconso ? files.rxnconso : '(missing)'}`);
    console.log(`  RXNREL:   ${files.rxnrel ? files.rxnrel : '(missing)'}`);
    console.log(`  RXNSAT:   ${files.rxnsat ? files.rxnsat : '(missing)'}`);
    console.log(`  RXNSAB:   ${files.rxnsab ? files.rxnsab : '(missing)'}`);

    if (!files.rxnconso) {
      this.logError('Validation failed: RXNCONSO.RRF is required');
      return;
    }
    this.logSuccess('Validation passed');
  }

  async handleStatusCommand(options) {
    const dbPath = path.resolve(options.dest || './data/rxnorm-v0.db');
    if (!fs.existsSync(dbPath)) {
      this.logError(`Database not found: ${dbPath}`);
      return;
    }

    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    try {
      const codeSystem = await getRow(
        db,
        `SELECT cs_id, canonical_uri, version, name, loaded_at
         FROM code_system
         ORDER BY cs_id DESC
         LIMIT 1`,
        []
      );
      if (!codeSystem) {
        this.logWarning('No code_system rows found');
        return;
      }

      const [concepts, designations, relationships, literals, closure] = await Promise.all([
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
        getRow(
          db,
          `SELECT COUNT(*) AS n
           FROM concept_literal cl
           JOIN concept c ON c.concept_id = cl.source_concept_id
           WHERE c.cs_id = ?`,
          [codeSystem.cs_id]
        ),
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

      console.log('\nRxNorm SQLite v0 Status:');
      console.log(`  DB:            ${dbPath}`);
      console.log(`  Canonical URI: ${codeSystem.canonical_uri}`);
      console.log(`  Version:       ${codeSystem.version || '(none)'}`);
      console.log(`  Name:          ${codeSystem.name || 'RxNorm'}`);
      console.log(`  Loaded At:     ${codeSystem.loaded_at}`);
      console.log(`  Concepts:      ${(concepts?.n || 0).toLocaleString()}`);
      console.log(`  Designations:  ${(designations?.n || 0).toLocaleString()}`);
      console.log(`  Relationships: ${(relationships?.n || 0).toLocaleString()}`);
      console.log(`  Literals:      ${(literals?.n || 0).toLocaleString()}`);
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
  if (!/^\d{8}$/.test(input)) return 'Version must be MMDDYYYY';
  return true;
}

async function promptForSource() {
  const answer = await inquirer.prompt([
    {
      type: 'input',
      name: 'source',
      message: 'Source directory or zip:',
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

module.exports = {
  RxNormSqliteV0Module
};
