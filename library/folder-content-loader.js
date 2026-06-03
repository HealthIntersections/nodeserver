const fs = require('fs').promises;
const path = require('path');
const { PackageContentLoader } = require('./package-manager');

/**
 * A content loader that scans a folder for JSON FHIR terminology resources
 * (CodeSystem, ValueSet, ConceptMap). It synthesizes the package layout that
 * PackageContentLoader expects so the existing PackageValueSetProvider /
 * PackageConceptMapProvider machinery can be reused without modification.
 *
 * The user's source folder is treated as read-only. Any SQLite caches built
 * by the Package*Provider classes are written to the cacheFolder passed in,
 * not to the source folder.
 */
class FolderContentLoader extends PackageContentLoader {
  /**
   * @param {string} sourceFolder - Folder to scan for JSON resources
   * @param {string} cacheFolder - Folder where Package*Provider DBs may live
   */
  constructor(sourceFolder, cacheFolder) {
    super(cacheFolder);
    this.sourceFolder = sourceFolder;
    // Resources are read directly from the source folder rather than from
    // <packageFolder>/package as PackageContentLoader assumes.
    this.packageSubfolder = sourceFolder;
  }

  /**
   * Replaces the standard initialize: there is no package.json or .index.json
   * to read, so we synthesize an index from the JSON files in the folder.
   */
  async initialize() {
    if (this.loaded) {
      return;
    }

    try {
      const stat = await fs.stat(this.sourceFolder);
      if (!stat.isDirectory()) {
        throw new Error(`Folder source path is not a directory: ${this.sourceFolder}`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Folder source path does not exist: ${this.sourceFolder}`);
      }
      throw err;
    }

    // Synthesize package metadata so id()/version()/pid() return something usable.
    this.package = {
      name: 'folder.' + path.basename(this.sourceFolder),
      version: '0.0.0',
      fhirVersions: ['5.0.0']
    };

    const files = [];
    const entries = await fs.readdir(this.sourceFolder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.json')) continue;

      const fullPath = path.join(this.sourceFolder, entry.name);
      let json;
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        json = JSON.parse(content);
      } catch {
        // Skip unreadable / non-JSON files rather than failing the whole load.
        continue;
      }

      if (!json || typeof json !== 'object') continue;
      const rt = json.resourceType;
      if (rt !== 'CodeSystem' && rt !== 'ValueSet' && rt !== 'ConceptMap') continue;

      files.push({
        filename: entry.name,
        resourceType: rt,
        id: json.id,
        url: json.url,
        version: json.version
      });
    }

    this.index = { files, 'index-version': 2 };
    this.buildIndexes();
    this.loaded = true;
  }
}

module.exports = { FolderContentLoader };
