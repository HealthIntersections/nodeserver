const fs = require('fs');
const os = require('os');

/**
 * Language part types for matching depth
 */
const LanguagePartType = {
  NONE: 0,
  LANGUAGE: 1,
  EXTLANG: 2,
  SCRIPT: 3,
  REGION: 4,
  VARIANT: 5,
  EXTENSION: 6
};

/**
 * Base class for language entries
 */
class LanguageEntry {
  constructor() {
    this.code = '';
    this.displays = [];
  }
}

/**
 * Language definition entry
 */
class LanguageLanguage extends LanguageEntry {
  constructor() {
    super();
    this.suppressScript = '';
    this.scope = '';
  }
}

/**
 * Extended language definition entry
 */
class LanguageExtLang extends LanguageEntry {}

/**
 * Script definition entry
 */
class LanguageScript extends LanguageEntry {}

/**
 * Region definition entry
 */
class LanguageRegion extends LanguageEntry {}

/**
 * Variant definition entry
 */
class LanguageVariant extends LanguageEntry {}

/**
 * Individual language representation based on BCP 47
 */
class Language {
  constructor(code = '') {
    this.code = code;
    this.language = '';
    this.extLang = [];
    this.script = '';
    this.region = '';
    this.variant = '';
    this.extension = '';
    this.privateUse = [];
    this.quality = 1.0; // For Accept-Language header quality values

    if (this.code) {
      this._parse();
    }
  }

  /**
   * Get system default language, fallback to en-US
   */
  static _getDefaultLanguage() {
    try {
      // Try to get system locale
      const locale = Intl.DateTimeFormat().resolvedOptions().locale ||
      process.env.LANG ||
      process.env.LANGUAGE ||
      os.platform() === 'win32' ? 'en-US' : 'en-US';

      return locale.replace('_', '-'); // Convert underscore to hyphen
    } catch (error) {
      return 'en-US';
    }
  }

  /**
   * Create Language from xml:lang attribute
   */
  static fromXmlLang(xmlLang) {
    return new Language(xmlLang || 'en-US');
  }

  /**
   * Create Language from system default
   */
  static fromSystemDefault() {
    return new Language(this._getDefaultLanguage());
  }

  /**
   * Parse the language code according to BCP 47
   */
  _parse() {
    if (!this.code) return;

    const parts = this.code.split('-');
    let index = 0;

    // Language (required)
    if (index < parts.length) {
      this.language = parts[index];
      index++;
    }

    // Extended language (up to 3)
    for (let i = 0; i < 3 && index < parts.length; i++) {
      const part = parts[index];
      if (part.length === 3 && /^[a-zA-Z]{3}$/.test(part)) {
        this.extLang.push(part.toLowerCase());
        index++;
      } else {
        break;
      }
    }

    // Script (4 letters)
    if (index < parts.length) {
      const part = parts[index];
      if (part.length === 4 && /^[a-zA-Z]{4}$/.test(part)) {
        this.script = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        index++;
      }
    }

    // Region (2 letters or 3 digits)
    if (index < parts.length) {
      const part = parts[index];
      if ((part.length === 2 && /^[a-zA-Z]{2}$/.test(part)) ||
        (part.length === 3 && /^[0-9]{3}$/.test(part))) {
        this.region = part.toUpperCase();
        index++;
      }
    }

    // Variant (5-8 chars or 4 chars starting with digit)
    if (index < parts.length) {
      const part = parts[index];
      if ((part.length >= 5 && part.length <= 8) ||
        (part.length === 4 && /^[0-9]/.test(part))) {
        this.variant = part.toLowerCase();
        index++;
      }
    }

    // Extensions and private use
    while (index < parts.length) {
      const part = parts[index];
      if (part === 'x') {
        // Private use
        index++;
        while (index < parts.length) {
          this.privateUse.push(parts[index]);
          index++;
        }
      } else if (part.length === 1 && part !== 'x') {
        // Extension
        this.extension = part + '-' + parts.slice(index + 1).join('-');
        break;
      } else {
        index++;
      }
    }
  }

  /**
   * Check if this language matches another to a given depth
   */
  matches(other, depth = LanguagePartType.LANGUAGE) {
    if (!other) return false;

    if (depth >= LanguagePartType.EXTENSION) {
      if (this.extension !== other.extension) return false;
    }

    if (depth >= LanguagePartType.VARIANT) {
      if (this.variant !== other.variant) return false;
    }

    if (depth >= LanguagePartType.REGION) {
      if (this.region !== other.region) return false;
    }

    if (depth >= LanguagePartType.SCRIPT) {
      if (this.script !== other.script) return false;
    }

    if (depth >= LanguagePartType.EXTLANG) {
      if (JSON.stringify(this.extLang) !== JSON.stringify(other.extLang)) return false;
    }

    if (depth >= LanguagePartType.LANGUAGE) {
      return this.language === other.language;
    }

    return true;
  }

  /**
   * Simple matching (all non-empty parts must match)
   */
  matchesSimple(other) {
    if (!other) return false;

    if (this.extension && this.extension !== other.extension) return false;
    if (this.variant && this.variant !== other.variant) return false;
    if (this.region && this.region !== other.region) return false;
    if (this.script && this.script !== other.script) return false;
    if (this.extLang.length > 0 &&
      JSON.stringify(this.extLang) !== JSON.stringify(other.extLang)) return false;

    return this.language === other.language;
  }

  /**
   * Check if this is a simple language-region tag
   */
  isLangRegion() {
    return (this.language !== '' && this.region !== '' &&
      this.extLang.length === 0 && this.script === '' &&
      this.variant === '' && this.extension === '' && this.privateUse.length === 0);
  }

  /**
   * Check if this language matches another according to display matching rules:
   * - Same language (e.g. en = en)
   * - This language has more details than the target (e.g. en-AU matches en)
   * - Either is blank and the other is en or en-US
   */
  matchesForDisplay(other) {
    if (!other) return false;

    const thisLang = typeof other === 'string' ? new Language(other) : other;

    // Handle blank languages - match only if other is exactly 'en' or 'en-US'
    if (!this.language || this.language === '') {
      return thisLang.code === 'en' || thisLang.code === 'en-US';
    }
    if (!thisLang.language || thisLang.language === '') {
      return this.code === 'en' || this.code === 'en-US';
    }

    // Must match at language level
    if (this.language !== thisLang.language) {
      return false;
    }

    // Check each component: if target specifies it, this must match exactly
    // If target doesn't specify it, this can have any value (more specific is OK)

    // Check script
    if (thisLang.script && thisLang.script !== '') {
      if (this.script !== thisLang.script) {
        return false;
      }
    }

    // Check region
    if (thisLang.region && thisLang.region !== '') {
      if (this.region !== thisLang.region) {
        return false;
      }
    }

    // Check variant
    if (thisLang.variant && thisLang.variant !== '') {
      if (this.variant !== thisLang.variant) {
        return false;
      }
    }

    return true;
  }

  toString() {
    const parts = [];

    if (this.language) parts.push(this.language);
    parts.push(...this.extLang);
    if (this.script) parts.push(this.script);
    if (this.region) parts.push(this.region);
    if (this.variant) parts.push(this.variant);
    if (this.extension) parts.push(this.extension);
    if (this.privateUse.length > 0) {
      parts.push('x');
      parts.push(...this.privateUse);
    }

    return parts.join('-');
  }
}

/**
 * Collection of languages with preference ordering
 */
class Languages {
  constructor() {
    this.languages = [];
  }

  /**
   * Parse Accept-Language header
   * Format: "en-US,en;q=0.9,fr;q=0.8"
   */
  static fromAcceptLanguage(acceptLanguageHeader) {
    const languages = new Languages();

    if (!acceptLanguageHeader) {
      languages.add(Language.fromSystemDefault());
      return languages;
    }

    const entries = acceptLanguageHeader.split(',').map(s => s.trim());
    const parsed = [];

    for (const entry of entries) {
      const [langCode, qValue] = entry.split(';');
      const quality = qValue ? parseFloat(qValue.split('=')[1]) || 1.0 : 1.0;

      const lang = new Language(langCode.trim());
      lang.quality = quality;
      parsed.push(lang);
    }

    // Sort by quality (descending)
    parsed.sort((a, b) => b.quality - a.quality);

    for (const lang of parsed) {
      languages.add(lang);
    }

    return languages;
  }

  /**
   * Add a language to the collection
   */
  add(language) {
    this.languages.push(language);
  }

  /**
   * Get iterator for languages in preference order
   */
  [Symbol.iterator]() {
    return this.languages[Symbol.iterator]();
  }

  /**
   * Get language by index
   */
  get(index) {
    return this.languages[index];
  }

  /**
   * Get number of languages
   */
  get length() {
    return this.languages.length;
  }

  /**
   * Find best match for a given language
   */
  findBestMatch(target, depth = LanguagePartType.LANGUAGE) {
    for (const lang of this.languages) {
      if (lang.matches(target, depth)) {
        return lang;
      }
    }
    return null;
  }

  /**
   * Check if any language matches the target
   */
  matches(target, depth = LanguagePartType.LANGUAGE) {
    return this.findBestMatch(target, depth) !== null;
  }

  /**
   * Get primary language (first in preference order)
   */
  getPrimary() {
    return this.languages.length > 0 ? this.languages[0] : new Language('en-US');
  }
}

/**
 * Global language definitions loaded from IETF registry
 */
class LanguageDefinitions {
  constructor() {
    this.languages = new Map();
    this.extLanguages = new Map();
    this.scripts = new Map();
    this.regions = new Map();
    this.variants = new Map();
    this.parsed = new Map(); // Cache for parsed languages
  }

  /**
   * Load definitions from IETF language subtag registry file
   */
  static async fromFile(filePath) {
    const definitions = new LanguageDefinitions();
    const content = fs.readFileSync(filePath, 'utf8');
    definitions._load(content);
    return definitions;
  }

  /**
   * Load definitions from content string
   */
  static fromContent(content) {
    const definitions = new LanguageDefinitions();
    definitions._load(content);
    return definitions;
  }

  /**
   * Check if source content is valid
   */
  static checkSource(source) {
    return source.startsWith('%%') ? 'Ok' : 'Invalid';
  }

  /**
   * Parse the IETF registry format
   */
  _load(source) {
    const lines = source.split('\n');
    let i = 0;

    while (i < lines.length) {
      if (lines[i].trim() === '%%') {
        i++;
        const [vars, nextIndex] = this._readVars(lines, i);
        i = nextIndex;

        switch (vars.Type) {
          case 'language':
            this._loadLanguage(vars);
            break;
          case 'extlang':
            this._loadExtLang(vars);
            break;
          case 'script':
            this._loadScript(vars);
            break;
          case 'region':
            this._loadRegion(vars);
            break;
          case 'variant':
            this._loadVariant(vars);
            break;
          case 'grandfathered':
          case 'redundant':
            // Skip these for now
            break;
          default:
            throw new Error(`Unknown type: ${vars.Type} at line ${i + 1}`);
        }
      } else {
        i++;
      }
    }
  }

  /**
   * Read variables from the registry format
   */
  _readVars(lines, startIndex) {
    const vars = {};
    let i = startIndex;

    while (i < lines.length && lines[i].trim() !== '%%') {
      const line = lines[i].trim();
      if (line && !line.startsWith(' ')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim();
          const value = line.substring(colonIndex + 1).trim();

          if (vars[key]) {
            vars[key] += '|' + value;
          } else {
            vars[key] = value;
          }
        }
      }
      i++;
    }

    return [vars, i];
  }

  /**
   * Load language entry
   */
  _loadLanguage(vars) {
    const lang = new LanguageLanguage();
    lang.code = vars.Subtag;
    lang.displays = vars.Description ? vars.Description.split('|') : [];
    lang.suppressScript = vars['Suppress-Script'] || '';
    lang.scope = vars.Scope || '';

    if (this.languages.has(lang.code)) {
      throw new Error(`Duplicate language code: ${lang.code}`);
    }

    this.languages.set(lang.code, lang);
  }

  /**
   * Load extended language entry
   */
  _loadExtLang(vars) {
    const extLang = new LanguageExtLang();
    extLang.code = vars.Subtag;
    extLang.displays = vars.Description ? vars.Description.split('|') : [];

    if (this.extLanguages.has(extLang.code)) {
      throw new Error(`Duplicate extlang code: ${extLang.code}`);
    }

    this.extLanguages.set(extLang.code, extLang);
  }

  /**
   * Load script entry
   */
  _loadScript(vars) {
    const script = new LanguageScript();
    script.code = vars.Subtag;
    script.displays = vars.Description ? vars.Description.split('|') : [];

    if (this.scripts.has(script.code)) {
      throw new Error(`Duplicate script code: ${script.code}`);
    }

    this.scripts.set(script.code, script);
  }

  /**
   * Load region entry
   */
  _loadRegion(vars) {
    const region = new LanguageRegion();
    region.code = vars.Subtag;
    region.displays = vars.Description ? vars.Description.split('|') : [];

    if (this.regions.has(region.code)) {
      throw new Error(`Duplicate region code: ${region.code}`);
    }

    this.regions.set(region.code, region);
  }

  /**
   * Load variant entry
   */
  _loadVariant(vars) {
    const variant = new LanguageVariant();
    variant.code = vars.Subtag;
    variant.displays = vars.Description ? vars.Description.split('|') : [];

    if (this.variants.has(variant.code)) {
      throw new Error(`Duplicate variant code: ${variant.code}`);
    }

    this.variants.set(variant.code, variant);
  }

  /**
   * Parse and validate a language code
   */
  parse(code) {
    if (!code) return null;

    // Check cache first
    if (this.parsed.has(code)) {
      return this.parsed.get(code);
    }

    const parts = code.split('-');
    let index = 0;

    // Validate language
    if (index >= parts.length) return null;
    const langCode = parts[index].toLowerCase();
    if (!this.languages.has(langCode) && langCode !== '*') {
      return null; // Invalid language code
    }

    const lang = new Language(code);

    // Cache the result
    this.parsed.set(code, lang);
    return lang;
  }

  /**
   * Get display name for language
   */
  getDisplayForLang(code, displayIndex = 0) {
    const lang = this.languages.get(code);
    return lang && lang.displays[displayIndex] ? lang.displays[displayIndex] : code;
  }

  /**
   * Get display name for region
   */
  getDisplayForRegion(code, displayIndex = 0) {
    const region = this.regions.get(code);
    return region && region.displays[displayIndex] ? region.displays[displayIndex] : code;
  }

  /**
   * Get display name for script
   */
  getDisplayForScript(code, displayIndex = 0) {
    const script = this.scripts.get(code);
    return script && script.displays[displayIndex] ? script.displays[displayIndex] : code;
  }

  /**
   * Present a language with full display names
   */
  present(lang, displayIndex = 0, template = null) {
    if (!lang) return '';

    if (template) {
      return template
        .replace('{{lang}}', this.getDisplayForLang(lang.language, displayIndex))
        .replace('{{region}}', this.getDisplayForRegion(lang.region, displayIndex))
        .replace('{{script}}', this.getDisplayForScript(lang.script, displayIndex));
    }

    let result = this.getDisplayForLang(lang.language, displayIndex);

    const parts = [];
    if (lang.script) {
      parts.push(`Script=${this.getDisplayForScript(lang.script, 0)}`);
    }
    if (lang.region) {
      parts.push(`Region=${this.getDisplayForRegion(lang.region, 0)}`);
    }
    if (lang.variant) {
      const variant = this.variants.get(lang.variant);
      const variantDisplay = variant && variant.displays[0] ? variant.displays[0] : lang.variant;
      parts.push(`Variant=${variantDisplay}`);
    }

    if (parts.length > 0) {
      result += ` (${parts.join(', ')})`;
    }

    return result;
  }

  /**
   * Get number of available displays for a language
   */
  displayCount(lang) {
    if (!lang) return 0;
    const language = this.languages.get(lang.language);
    return language ? language.displays.length : 0;
  }
}

module.exports = {
  Language,
  Languages,
  LanguageDefinitions,
  LanguagePartType,
  LanguageEntry,
  LanguageLanguage,
  LanguageExtLang,
  LanguageScript,
  LanguageRegion,
  LanguageVariant
};
