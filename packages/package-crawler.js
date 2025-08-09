//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const axios = require('axios');
const {XMLParser} = require('fast-xml-parser');
const crypto = require('crypto');
const tar = require('tar');
const fs = require('fs');
const path = require('path');

class PackageCrawler {
  log;
  
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.totalBytes = 0;
    this.crawlerLog = {};
    this.errors = '';
  }

  async crawl(log) {
    this.log = log;
    
    const startTime = Date.now();
    this.crawlerLog = {
      startTime: new Date().toISOString(),
      master: this.config.masterUrl,
      feeds: [],
      totalBytes: 0,
      errors: ''
    };

    this.log.info('Running web crawler for packages using master URL: '+ this.config.masterUrl);

    try {
      // Fetch the master JSON file
      const masterResponse = await this.fetchJson(this.config.masterUrl);

      if (!masterResponse.feeds || !Array.isArray(masterResponse.feeds)) {
        throw new Error('Invalid master JSON: missing feeds array');
      }

      // Process package restrictions if available
      const packageRestrictions = masterResponse['package-restrictions'] || [];

      // Process each feed
      for (const feedConfig of masterResponse.feeds) {
        if (!feedConfig.url) {
          this.log.info('Skipping feed with no URL: '+ feedConfig);
          continue;
        }

        try {
          await this.updateTheFeed(
            this.fixUrl(feedConfig.url),
            this.config.masterUrl,
            feedConfig.errors ? feedConfig.errors.replace(/\|/g, '@').replace(/_/g, '.') : '',
            packageRestrictions
          );
        } catch (feedError) {
          this.log.error(`Failed to process feed ${feedConfig.url}: `+ feedError.message);
          // Continue with next feed even if this one fails
        }
      }

      const runTime = Date.now() - startTime;
      this.crawlerLog.runTime = `${runTime}ms`;
      this.crawlerLog.endTime = new Date().toISOString();
      this.crawlerLog.totalBytes = this.totalBytes;

      this.log.info(`Web crawler completed successfully in ${runTime}ms`);
      this.log.info(`Total bytes processed: ${this.totalBytes}`);

      return this.crawlerLog;

    } catch (error) {
      const runTime = Date.now() - startTime;
      this.crawlerLog.runTime = `${runTime}ms`;
      this.crawlerLog.fatalException = error.message;
      this.crawlerLog.endTime = new Date().toISOString();

      this.log.error('Web crawler failed: '+ error);
      throw error;
    }
  }

  fixUrl(url) {
    return url.replace(/^http:/, 'https:');
  }

  async fetchJson(url) {
    try {
      const response = await axios.get(url, {
        timeout: 30000,
        headers: {
          'User-Agent': 'FHIR Package Crawler/1.0'
        }
      });
      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 429) {
        throw new Error(`RATE_LIMITED: Server returned 429 Too Many Requests for ${url}`);
      }
      throw new Error(`Failed to fetch JSON from ${url}: ${error.message}`);
    }
  }

  async fetchXml(url) {
    try {
      const response = await axios.get(url, {
        timeout: 30000,
        headers: {
          'User-Agent': 'FHIR Package Crawler/1.0'
        }
      });

      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '#text'
      });

      return parser.parse(response.data);
    } catch (error) {
      if (error.response && error.response.status === 429) {
        throw new Error(`RATE_LIMITED: Server returned 429 Too Many Requests for ${url}`);
      }
      throw new Error(`Failed to fetch XML from ${url}: ${error.message}`);
    }
  }

  async fetchUrl(url, expectedContentType = null) {
    try {
      const response = await axios.get(url, {
        timeout: 60000,
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'FHIR Package Crawler/1.0'
        }
      });

      this.totalBytes += response.data.byteLength;
      return Buffer.from(response.data);
    } catch (error) {
      if (error.response && error.response.status === 429) {
        throw new Error(`RATE_LIMITED: Server returned 429 Too Many Requests for ${url}`);
      }
      throw new Error(`Failed to fetch ${url}: ${error.message}`);
    }
  }

  async updateTheFeed(url, source, email, packageRestrictions) {
    const feedLog = {
      url: url,
      items: []
    };
    this.crawlerLog.feeds.push(feedLog);

    this.log.info('Processing feed: '+ url);
    const startTime = Date.now();

    try {
      const xmlData = await this.fetchXml(url);
      feedLog.fetchTime = `${Date.now() - startTime}ms`;

      // Navigate the RSS structure
      let items = [];
      if (xmlData.rss && xmlData.rss.channel) {
        const channel = xmlData.rss.channel;
        items = Array.isArray(channel.item) ? channel.item : [channel.item].filter(Boolean);
      }

      this.log.info(`Found ${items.length} items in feed`);

      for (let i = 0; i < items.length; i++) {
        try {
          await this.updateItem(url, items[i], i, packageRestrictions, feedLog);
        } catch (itemError) {
          // Check if this is a 429 error on package download
          if (itemError.message.includes('RATE_LIMITED')) {
            this.log.info(`Rate limited while downloading package from ${url}, stopping feed processing`);
            feedLog.rateLimited = true;
            feedLog.rateLimitedAt = `item ${i}`;
            feedLog.rateLimitMessage = itemError.message;
            break; // Stop processing this feed
          }
          // For other errors, log and continue with next item
          this.log.error(`Error processing item ${i} from ${url}:`+ itemError.message);
        }
      }

      // TODO: Send email if there were errors and email is provided
      if (this.errors && email && !feedLog.rateLimited) {
        this.log.info(`Would send error email to ${email} for feed ${url}`);
      }

    } catch (error) {
      // Check if this is a 429 error on feed fetch
      if (error.message.includes('RATE_LIMITED')) {
        this.log.info(`Rate limited while fetching feed ${url}, skipping this feed`);
        feedLog.rateLimited = true;
        feedLog.rateLimitMessage = error.message;
        feedLog.failTime = `${Date.now() - startTime}ms`;
        return; // Skip this feed entirely
      }

      feedLog.exception = error.message;
      feedLog.failTime = `${Date.now() - startTime}ms`;
      this.log.error(`Exception processing feed ${url}:`+ error.message);

      // TODO: Send email notification for non-rate-limit errors
      if (email) {
        this.log.info(`Would send exception email to ${email} for feed ${url}`);
      }
    }
  }

  async updateItem(source, item, index, packageRestrictions, feedLog) {
    const itemLog = {
      status: '??'
    };
    feedLog.items.push(itemLog);

    try {
      // Extract GUID
      if (!item.guid || !item.guid['#text']) {
        const error = `Error processing item from ${source}#item[${index}]: no guid provided`;
        this.log.info(error);
        itemLog.error = 'no guid provided';
        itemLog.status = 'error';
        return;
      }

      const guid = item.guid['#text'];
      itemLog.guid = guid;

      // Extract title (package ID)
      const id = item.title;
      itemLog.id = id;

      if (!id) {
        itemLog.error = 'no title/id provided';
        itemLog.status = 'error';
        return;
      }

      // Check if not for publication
      if (item.notForPublication && item.notForPublication['#text'] === 'true') {
        itemLog.status = 'not for publication';
        itemLog.error = 'not for publication';
        return;
      }

      // Check package restrictions (simplified for now)
      if (!this.isPackageAllowed(id, source, packageRestrictions)) {
        if (!source.includes('simplifier.net')) {
          const error = `The package ${id} is not allowed to come from ${source}`;
          this.log.info(error);
          itemLog.error = error;
          itemLog.status = 'prohibited source';
        } else {
          itemLog.status = 'ignored';
          itemLog.error = `The package ${id} is published through another source`;
        }
        return;
      }

      // Check if already processed
      if (await this.hasStored(guid)) {
        itemLog.status = 'Already Processed';
        return;
      }

      // Parse publication date
      let pubDate;
      try {
        let pd = item.pubDate;
        pubDate = this.parsePubDate(pd);
      } catch (error) {
        itemLog.error = `Invalid date format '{pd}': ${error.message}`;
        itemLog.status = 'error';
        return;
      }

      // Extract URL and fetch package
      const url = this.fixUrl(item.link);
      if (!url) {
        itemLog.error = 'no link provided';
        itemLog.status = 'error';
        return;
      }

      itemLog.url = url;
      this.log.info('Fetching package: '+ url);

      const packageContent = await this.fetchUrl(url, 'application/tar+gzip');
      await this.store(source, url, guid, pubDate, packageContent, id, itemLog);

      itemLog.status = 'Fetched';

    } catch (error) {
      this.log.error(`Exception processing item ${itemLog.guid || index}:`+ error.message);
      itemLog.status = 'Exception';
      itemLog.error = error.message;
      if (error.message.includes('RATE_LIMITED')) {
        throw error;
      }
    }
  }

  isPackageAllowed(packageId, source, restrictions) {
    // Simplified package restriction logic
    // TODO: Implement proper restriction checking based on the restrictions array
    return true;
  }

  async hasStored(guid) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM PackageVersions WHERE GUID = ?', [guid], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row.count > 0);
        }
      });
    });
  }

  parsePubDate(dateStr) {
    // Handle various RSS date formats
    let cleanDate = dateStr.toLowerCase().replace(/\s+/g, ' ').trim();

    // Remove day of week if present
    if (cleanDate.includes(',')) {
      cleanDate = cleanDate.substring(cleanDate.indexOf(',') + 1).trim();
    } else if (/^(mon|tue|wed|thu|fri|sat|sun)/.test(cleanDate)) {
      cleanDate = cleanDate.substring(cleanDate.indexOf(' ') + 1).trim();
    }

    // Pad single digit day
    if (cleanDate.length > 2 && cleanDate[1] === ' ' && /^\d$/.test(cleanDate[0])) {
      cleanDate = '0' + cleanDate;
    }

    // Try to parse the date
    const date = new Date(cleanDate);
    if (isNaN(date.getTime())) {
      throw new Error(`Cannot parse date: ${dateStr}`);
    }

    return date;
  }

  async store(source, url, guid, date, packageBuffer, idver, itemLog) {
    try {
      // Extract and parse the NPM package
      const npmPackage = await this.extractNpmPackage(packageBuffer, `${source}#${guid}`);

      const {id, version} = npmPackage;

      if (`${id}#${version}` !== idver) {
        const warning = `Warning processing ${idver}: actually found ${id}#${version} in the package`;
        this.log.info(warning);
        itemLog.warning = warning;
      }

      // Save to mirror if configured
      if (this.config.mirrorPath) {
        const filename = `${id}-${version}.tgz`;
        const filepath = path.join(this.config.mirrorPath, filename);
        fs.writeFileSync(filepath, packageBuffer);
      }

      // Validate package data
      if (!this.isValidPackageId(id)) {
        throw new Error(`NPM Id "${id}" is not valid from ${source}`);
      }

      if (!this.isValidSemVersion(version)) {
        throw new Error(`NPM Version "${version}" is not valid from ${source}`);
      }

      let canonical = npmPackage.canonical || `http://simplifier.net/packages/${id}`;
      if (!this.isAbsoluteUrl(canonical)) {
        throw new Error(`NPM Canonical "${canonical}" is not valid from ${source}`);
      }

      // Extract URLs from package (simplified)
      const urls = this.processPackageUrls(npmPackage);

      // Commit to database
      await this.commit(packageBuffer, npmPackage, date, guid, id, version, canonical, urls);

    } catch (error) {
      this.log.error(`Error storing package ${guid}:`+ error.message);
      throw error;
    }
  }

  async extractNpmPackage(packageBuffer, source) {
    try {
      const files = {};
      const zlib = require('zlib');
      const {Readable} = require('stream');

      // First decompress the gzip
      const decompressed = zlib.gunzipSync(packageBuffer);

      // Parse tar manually without any file system operations
      let offset = 0;

      while (offset < decompressed.length) {
        // Read tar header (512 bytes)
        if (offset + 512 > decompressed.length) break;

        const header = decompressed.slice(offset, offset + 512);

        // Check if this is the end (null header)
        if (header[0] === 0) break;

        // Extract filename (first 100 bytes, null-terminated)
        let filename = '';
        for (let i = 0; i < 100; i++) {
          if (header[i] === 0) break;
          filename += String.fromCharCode(header[i]);
        }

        // Extract file size (12 bytes starting at offset 124, octal)
        let sizeStr = '';
        for (let i = 124; i < 136; i++) {
          if (header[i] === 0 || header[i] === 32) break; // null or space
          sizeStr += String.fromCharCode(header[i]);
        }
        const fileSize = parseInt(sizeStr, 8) || 0;

        // Move past header
        offset += 512;

        // Extract file content if we need this file
        if (fileSize > 0) {
          const cleanFilename = filename.replace(/^package\//, ''); // Remove package/ prefix

          if (cleanFilename === 'package.json' || cleanFilename === '.index.json' || cleanFilename === 'ig.ini') {
            const fileContent = decompressed.slice(offset, offset + fileSize);
            files[cleanFilename] = fileContent.toString('utf8');
          }
        }

        // Move to next file (files are padded to 512-byte boundaries)
        const paddedSize = Math.ceil(fileSize / 512) * 512;
        offset += paddedSize;
      }

      // Parse package.json (required)
      if (!files['package.json']) {
        throw new Error('package.json not found in extracted package');
      }

      const packageJson = JSON.parse(files['package.json']);

      // Extract basic NPM fields
      const id = packageJson.name || '';
      const version = packageJson.version || '';
      const description = packageJson.description || '';
      const author = this.extractAuthor(packageJson.author);
      const license = packageJson.license || '';
      const homepage = packageJson.homepage || packageJson.url || '';

      // Extract dependencies
      const dependencies = [];
      if (packageJson.dependencies) {
        for (const [dep, ver] of Object.entries(packageJson.dependencies)) {
          dependencies.push(`${dep}@${ver}`);
        }
      }

      // Extract FHIR-specific metadata
      let fhirVersion = '';
      let fhirVersionList = '';
      let canonical = '';
      let kind = 1; // Default to IG
      let notForPublication = false;

      // Check for FHIR metadata in package.json
      if (packageJson.fhirVersions) {
        if (Array.isArray(packageJson.fhirVersions)) {
          fhirVersionList = packageJson.fhirVersions.join(',');
          fhirVersion = packageJson.fhirVersions[0] || '';
        } else {
          fhirVersion = packageJson.fhirVersions;
          fhirVersionList = packageJson.fhirVersions;
        }
      } else if (packageJson['fhir-version']) {
        fhirVersion = packageJson['fhir-version'];
        fhirVersionList = packageJson['fhir-version'];
      }

      if (packageJson.canonical) {
        canonical = packageJson.canonical;
      }

      if (packageJson.type === 'fhir.core') {
        kind = 0; // Core
      } else if (packageJson.type === 'fhir.template') {
        kind = 2; // Template
      } else {
        kind = 1; // IG (Implementation Guide)
      }

      if (packageJson.notForPublication === true) {
        notForPublication = true;
      }

      // Parse .index.json if present
      if (files['.index.json']) {
        try {
          const indexJson = JSON.parse(files['.index.json']);

          // Extract additional metadata from .index.json
          if (indexJson['fhir-version'] && !fhirVersion) {
            fhirVersion = indexJson['fhir-version'];
            fhirVersionList = indexJson['fhir-version'];
          }

          if (indexJson.canonical && !canonical) {
            canonical = indexJson.canonical;
          }
        } catch (indexError) {
          this.log.this.warn(`Warning: Could not parse .index.json for ${id}: ${indexError.message}`);
        }
      }

      // Parse ig.ini if present
      if (files['ig.ini']) {
        try {
          const iniData = this.parseIniFile(files['ig.ini']);

          if (iniData.IG && iniData.IG.canonical && !canonical) {
            canonical = iniData.IG.canonical;
          }

          if (iniData.IG && iniData.IG['fhir-version'] && !fhirVersion) {
            fhirVersion = iniData.IG['fhir-version'];
            fhirVersionList = iniData.IG['fhir-version'];
          }
        } catch (iniError) {
          this.log.warn(`Warning: Could not parse ig.ini for ${id}: ${iniError.message}`);
        }
      }

      // Default fhirVersion if not found
      if (!fhirVersion) {
        fhirVersion = '4.0.1'; // Default to R4
        fhirVersionList = '4.0.1';
      }

      return {
        id,
        version,
        description,
        canonical,
        fhirVersion,
        fhirVersionList,
        author,
        license,
        url: homepage,
        dependencies,
        kind,
        notForPublication
      };

    } catch (error) {
      throw new Error(`Failed to extract NPM package from ${source}: ${error.message}`);
    }
  }

  extractAuthor(author) {
    if (typeof author === 'string') {
      return author;
    } else if (typeof author === 'object' && author.name) {
      return author.name;
    }
    return '';
  }

  parseIniFile(content) {
    const result = {};
    let currentSection = null;

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
        continue;
      }

      // Check for section header
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        result[currentSection] = {};
        continue;
      }

      // Check for key=value pair
      const keyValueMatch = trimmed.match(/^([^=]+)=(.*)$/);
      if (keyValueMatch && currentSection) {
        const key = keyValueMatch[1].trim();
        const value = keyValueMatch[2].trim();
        result[currentSection][key] = value;
      }
    }

    return result;
  }

  isValidPackageId(id) {
    // Simple package ID validation
    return /^[a-z0-9][a-z0-9._-]*$/.test(id);
  }

  isValidSemVersion(version) {
    // Simple semantic version validation
    return /^\d+\.\d+\.\d+/.test(version);
  }

  isAbsoluteUrl(url) {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  processPackageUrls(npmPackage) {
    // Extract URLs from package - simplified implementation
    const urls = [];
    if (npmPackage.url) {
      urls.push(npmPackage.url);
    }
    return urls;
  }

  genHash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  async commit(packageBuffer, npmPackage, date, guid, id, version, canonical, urls) {
    return new Promise((resolve, reject) => {
      // Get next version key
      this.db.get('SELECT MAX(PackageVersionKey) as maxKey FROM PackageVersions', (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        const vkey = (row?.maxKey || 0) + 1;
        const hash = this.genHash(packageBuffer);

        // Insert package version
        const insertVersionSql = `
            INSERT INTO PackageVersions
            (PackageVersionKey, GUID, PubDate, Indexed, Id, Version, Kind, DownloadCount,
             Canonical, FhirVersions, UploadCount, Description, ManualToken, Hash,
             Author, License, HomePage, Content)
            VALUES (?, ?, ?, datetime('now'), ?, ?, ?, 0, ?, ?, 1, ?, '', ?, ?, ?, ?, ?)
        `;

        this.db.run(insertVersionSql, [
          vkey, guid, date.toISOString(), id, version, npmPackage.kind,
          canonical, npmPackage.fhirVersionList, npmPackage.description,
          hash, npmPackage.author, npmPackage.license, npmPackage.url,
          packageBuffer
        ], (err) => {
          if (err) {
            reject(err);
            return;
          }

          // Insert FHIR versions, dependencies, and URLs
          this.insertRelatedData(vkey, npmPackage, urls).then(() => {
            // Handle package table (insert or update)
            this.upsertPackage(id, vkey, canonical).then(resolve).catch(reject);
          }).catch(reject);
        });
      });
    });
  }

  async insertRelatedData(vkey, npmPackage, urls) {
    const promises = [];

    // Insert FHIR versions
    if (npmPackage.fhirVersionList) {
      const fhirVersions = npmPackage.fhirVersionList.split(',');
      for (const fver of fhirVersions) {
        promises.push(new Promise((resolve, reject) => {
          this.db.run('INSERT INTO PackageFHIRVersions (PackageVersionKey, Version) VALUES (?, ?)',
            [vkey, fver.trim()], (err) => err ? reject(err) : resolve());
        }));
      }
    }

    // Insert dependencies
    for (const dep of npmPackage.dependencies) {
      promises.push(new Promise((resolve, reject) => {
        this.db.run('INSERT INTO PackageDependencies (PackageVersionKey, Dependency) VALUES (?, ?)',
          [vkey, dep], (err) => err ? reject(err) : resolve());
      }));
    }

    // Insert URLs
    for (const url of urls) {
      promises.push(new Promise((resolve, reject) => {
        this.db.run('INSERT INTO PackageURLs (PackageVersionKey, URL) VALUES (?, ?)',
          [vkey, url], (err) => err ? reject(err) : resolve());
      }));
    }

    return Promise.all(promises);
  }

  async upsertPackage(id, vkey, canonical) {
    return new Promise((resolve, reject) => {
      // Check if package exists
      this.db.get('SELECT MAX(PackageKey) as pkey FROM Packages WHERE Id = ?', [id], (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        if (!row?.pkey) {
          // Insert new package
          this.db.get('SELECT MAX(PackageKey) as maxKey FROM Packages', (err, maxRow) => {
            if (err) {
              reject(err);
              return;
            }

            const pkey = (maxRow?.maxKey || 0) + 1;
            this.db.run('INSERT INTO Packages (PackageKey, Id, CurrentVersion, DownloadCount, Canonical) VALUES (?, ?, ?, 0, ?)',
              [pkey, id, vkey, canonical], (err) => err ? reject(err) : resolve());
          });
        } else {
          // Update existing package - check if this is the most recent version
          this.db.get(`
              SELECT PackageVersionKey
              FROM PackageVersions
              WHERE Id = ?
                AND Version != 'current'
              ORDER BY PubDate DESC, Version DESC LIMIT 1
          `, [id], (err, latestRow) => {
            if (err) {
              reject(err);
              return;
            }

            if (latestRow?.PackageVersionKey === vkey) {
              // This is the most recent version, update the package
              this.db.run('UPDATE Packages SET Canonical = ?, CurrentVersion = ? WHERE Id = ?',
                [canonical, vkey, id], (err) => err ? reject(err) : resolve());
            } else {
              resolve(); // Not the most recent, no update needed
            }
          });
        }
      });
    });
  }
}

module.exports = PackageCrawler;