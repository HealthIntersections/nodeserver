const { CodeSystemProvider, TxOperationContext, Designation } = require('./cs-api');
const { Language, LanguageDefinitions, Languages} = require('../library/languages');
const CodeSystem = require("../library/codesystem");

/**
 * Language component types for filtering
 */
const LanguageComponent = {
  LANG: 'language',
  EXTLANG: 'ext-lang',
  SCRIPT: 'script',
  REGION: 'region',
  VARIANT: 'variant',
  EXTENSION: 'extension',
  PRIVATE_USE: 'private-use'
};

const CODES_LanguageComponent = Object.values(LanguageComponent);

/**
 * Filter context for language component filters
 */
class IETFLanguageCodeFilter {
  constructor(component, status) {
    this.component = component; // LanguageComponent
    this.status = status; // boolean - true if component must exist, false if must not exist
  }
}

/**
 * Filter preparation context (empty for now)
 */
class IETFLanguageCodeFilterPrep {
  constructor() {
    // Empty preparation context
  }
}

/**
 * IETF Language CodeSystem Provider
 * Provides validation and lookup for BCP 47 language tags
 */
class IETFLanguageCodeProvider extends CodeSystemProvider {

  /**
   * @type {CodeSystem[]}
   */
  supplements;

  constructor(languageDefinitions, supplements = null) {
    super();
    this.languageDefinitions = languageDefinitions; // LanguageDefinitions instance
    this.supplements = supplements; // Array of supplement CodeSystems
    this._validateSupplements();
  }

  /**
   * Validates that supplements are CodeSystem instances
   * @private
   */
  _validateSupplements() {
    if (!this.supplements) return;

    if (!Array.isArray(this.supplements)) {
      throw new Error('Supplements must be an array');
    }

    this.supplements.forEach((supplement, index) => {
      if (!(supplement instanceof CodeSystem)) {
        throw new Error(`Supplement ${index} must be a CodeSystem instance, got ${typeof supplement}`);
      }
    });
  }

  // ========== Metadata Methods ==========

  system() {
    return 'urn:ietf:bcp:47'; // BCP 47 URI
  }

  version() {
    return ''; // No specific version for BCP 47. Could be date?
  }

  description() {
    return 'IETF language codes (BCP 47)';
  }

  totalCount() {
    return -1; // Unbounded - grammar-based system
  }

  hasParents() {
    return false; // No hierarchy in language codes
  }

  contentMode() {
    return 'complete'
  }

  hasSupplement(url) {
    if (!this.supplements) return false;
    return this.supplements.some(supp => supp.jsonObj.url === url || supp.jsonObj.versionedUrl === url);
  }

  listSupplements() {
    return this.supplements ? this.supplements.map(s => s.jsonObj.url) : [];
  }

  listFeatures() {
    // not sure about this?

    // // Return supported filter features
    // return CODES_LanguageComponent.map(component => ({
    //   feature: `rest.Codesystem:${this.system()}.filter`,
    //   value: `${component}:exists`
    // }));
  }

  hasAnyDisplays(languages) {
    // Convert input to Languages instance if needed
    const langs = languages instanceof Languages ? languages :
      Array.isArray(languages) ? Languages.fromAcceptLanguage(languages.join(',')) :
        Languages.fromAcceptLanguage(languages || '');

    // Language definitions are always in English, so return true if English is requested
    for (const requestedLang of langs) {
      if (requestedLang.language === 'en' || requestedLang.language === '') {
        return true;
      }
    }

    // Check if any supplements have displays in the requested languages
    if (this.supplements) {
      for (const supplement of this.supplements) {
        // Check if supplement language matches and has displays
        if (supplement.jsonObj.language) {
          const supplementLang = new Language(supplement.jsonObj.language);
          for (const requestedLang of langs) {
            if (supplementLang.matchesForDisplay(requestedLang)) {
              // Check if any concept has a display
              const allConcepts = supplement.getAllConcepts();
              if (allConcepts.some(c => c.display)) {
                return true;
              }
            }
          }
        }

        // Check concept designations for display uses
        const allConcepts = supplement.getAllConcepts();
        for (const concept of allConcepts) {
          if (concept.designation) {
            for (const designation of concept.designation) {
              // Check if designation is a display use
              if (CodeSystem.isUseADisplay(designation.use)) {
                if (designation.language) {
                  const designationLang = new Language(designation.language);
                  for (const requestedLang of langs) {
                    if (designationLang.matchesForDisplay(requestedLang)) {
                      return true;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    return false;
  }

  // ========== Code Information Methods ==========

  code(opContext, context) {
    if (typeof context === 'string') return context;
    if (context instanceof Language) {
      return context.code;
    }
    throw new Error('Invalid context type');
  }

  async display(opContext, context) {
    const code = this.code(opContext, context);
    return this.getDisplay(opContext, code);
  }

  async definition(opContext, context) {
    return ''; // No definitions for language codes
  }

  isAbstract(opContext, context) {
    return false; // Language codes are not abstract
  }

  isInactive(opContext, context) {
    return false; // We don't track inactive language codes
  }

  isDeprecated(opContext, context) {
    return false; // We don't track deprecated language codes
  }

  getStatus(opContext, context) {
    return null; // No status information
  }

  async designations(opContext, context) {
    const concept = typeof context === 'string' ?
      await this.locate(opContext, context) : { context: context };

    if (!concept.context) return [];

    const designations = [];
    const lang = concept.context;

    // Add primary display
    const primaryDisplay = this.languageDefinitions.present(lang).trim();
    if (primaryDisplay) {
      designations.push({
        lang: 'en',
        use: null,
        value: primaryDisplay
      });
    }

    // Add language-region variants if applicable
    if (lang.isLangRegion()) {
      const langDisplay = this.languageDefinitions.getDisplayForLang(lang.language);
      const regionDisplay = this.languageDefinitions.getDisplayForRegion(lang.region);
      
      const regionVariant = `${langDisplay} (${regionDisplay})`;
      designations.push({
        lang: 'en',
        use: null,
        value: regionVariant
      });

      const regionVariant2 = `${langDisplay} (Region=${regionDisplay})`;
      designations.push({
        lang: 'en',
        use: null,
        value: regionVariant2
      });
    }

    // Add alternative displays if available
    const displayCount = this.languageDefinitions.displayCount(lang);
    for (let i = 0; i < displayCount; i++) {
      const altDisplay = this.languageDefinitions.present(lang, i).trim();
      if (altDisplay && altDisplay !== primaryDisplay) {
        designations.push({
          lang: 'en',
          use: null,
          value: altDisplay
        });

        // Add region variants for alternatives too
        if (lang.isLangRegion()) {
          const langDisplay = this.languageDefinitions.getDisplayForLang(lang.language, i);
          const regionDisplay = this.languageDefinitions.getDisplayForRegion(lang.region);
          
          const altRegionVariant = `${langDisplay} (${regionDisplay})`;
          designations.push({
            lang: 'en',
            use: null,
            value: altRegionVariant
          });
        }
      }
    }

    // Add supplement designations if available
    if (this.supplements) {
      for (const supp of this.supplements) {
        const suppConcept = supp.getCode(lang.code);
        if (suppConcept && suppConcept.designation) {
          for (const designation of suppConcept.designation) {
            designations.push({
              lang: designation.language,
              use: designation.use,
              value: designation.value
            });
          }
        }
      }
    }

    return designations;
  }

  // ========== Lookup Methods ==========

  async locate(opContext, code) {
    if (!code) return { context: null, message: 'Empty code' };

    const language = this.languageDefinitions.parse(code);
    if (!language) {
      return { context: null, message: `Invalid language code: ${code}` };
    }

    return { context: language, message: null };
  }

  async locateIsA(opContext, code, parent, disallowParent = false) {
    return { context: null, message: 'Language codes do not have subsumption relationships' };
  }

  // ========== Helper Methods ==========

  /**
   * Get display name for a language code
   */
  getDisplay(opContext, code) {
    if (!code) return '??';

    // Check supplements first
    if (this.supplements) {
      for (const supp of this.supplements) {
        const concept = supp.getCode(code);
        if (concept) {
          // Try to find display in requested language
          if (concept.display) return concept.display;

          // Check designations
          if (concept.designation && concept.designation.length > 0) {
            // For now, just return first designation
            // TODO: Implement proper language matching
            return concept.designation[0].value;
          }
        }
      }
    }

    // Use language definitions
    const language = this.languageDefinitions.parse(code);
    if (language) {
      const display = this.languageDefinitions.present(language).trim();
      return display || '??';
    }

    return '??';
  }

  // ========== Filter Methods ==========

  doesFilter(opContext, prop, op, value) {
    // Support exists filters for language components
    if (op === 'exists' && (value === 'true' || value === 'false')) {
      return CODES_LanguageComponent.includes(prop);
    }
    return false;
  }

  getPrepContext(opContext, iterate) {
    return new IETFLanguageCodeFilterPrep();
  }

  async filter(opContext, filterContext, prop, op, value) {
    if (op !== 'exists') {
      throw new Error(`Unsupported filter operator: ${op}`);
    }

    if (value !== 'true' && value !== 'false') {
      throw new Error(`Invalid exists value: ${value}, must be 'true' or 'false'`);
    }

    const componentIndex = CODES_LanguageComponent.indexOf(prop);
    if (componentIndex < 0) {
      throw new Error(`Unsupported filter property: ${prop}`);
    }

    const component = CODES_LanguageComponent[componentIndex];
    const status = value === 'true';

    return new IETFLanguageCodeFilter(component, status);
  }

  async executeFilters(opContext, filterContext) {
    // Return any filters that were created
    return filterContext.filters || [];
  }

  filterSize(opContext, filterContext, set) {
    throw new Error('Language valuesets cannot be expanded as they are based on a grammar');
  }

  filtersNotClosed(opContext, filterContext) {
    return true; // Grammar-based system is not closed
  }

  filterMore(opContext, filterContext, set) {
    throw new Error('Language valuesets cannot be expanded as they are based on a grammar');
  }

  filterConcept(opContext, filterContext, set) {
    throw new Error('Language valuesets cannot be expanded as they are based on a grammar');
  }

  async filterLocate(opContext, filterContext, set, code) {
    if (!(set instanceof IETFLanguageCodeFilter)) {
      throw new Error('Invalid filter set type');
    }

    const language = this.languageDefinitions.parse(code);
    if (!language) {
      return `Invalid language code: ${code}`;
    }

    const filter = set;
    let hasComponent = false;

    switch (filter.component) {
      case LanguageComponent.LANG:
        hasComponent = language.language !== '';
        break;
      case LanguageComponent.EXTLANG:
        hasComponent = language.extLang.length > 0;
        break;
      case LanguageComponent.SCRIPT:
        hasComponent = language.script !== '';
        break;
      case LanguageComponent.REGION:
        hasComponent = language.region !== '';
        break;
      case LanguageComponent.VARIANT:
        hasComponent = language.variant !== '';
        break;
      case LanguageComponent.EXTENSION:
        hasComponent = language.extension !== '';
        break;
      case LanguageComponent.PRIVATE_USE:
        hasComponent = language.privateUse.length > 0;
        break;
      default:
        return `Unknown language component: ${filter.component}`;
    }

    if (hasComponent === filter.status) {
      return language;
    } else {
      const action = filter.status ? 'does not contain' : 'contains';
      const requirement = filter.status ? 'required' : 'not allowed';
      return `The language code ${code} ${action} a ${filter.component}, and it is ${requirement}`;
    }
  }

  filterCheck(opContext, filterContext, set, concept) {
    if (!(set instanceof IETFLanguageCodeFilter)) {
      throw new Error('Invalid filter set type');
    }

    if (!(concept instanceof Language)) {
      throw new Error('Invalid concept type');
    }

    const filter = set;
    let hasComponent = false;

    switch (filter.component) {
      case LanguageComponent.LANG:
        hasComponent = concept.language !== '';
        break;
      case LanguageComponent.EXTLANG:
        hasComponent = concept.extLang.length > 0;
        break;
      case LanguageComponent.SCRIPT:
        hasComponent = concept.script !== '';
        break;
      case LanguageComponent.REGION:
        hasComponent = concept.region !== '';
        break;
      case LanguageComponent.VARIANT:
        hasComponent = concept.variant !== '';
        break;
      case LanguageComponent.EXTENSION:
        hasComponent = concept.extension !== '';
        break;
      case LanguageComponent.PRIVATE_USE:
        hasComponent = concept.privateUse.length > 0;
        break;
      default:
        return `Unknown language component: ${filter.component}`;
    }

    return hasComponent === filter.status;
  }

  filterFinish(opContext, filterContext) {
    // Nothing to clean up
  }

  // ========== Iterator Methods ==========

  iterator(opContext, context) {
    return null; // Cannot iterate language codes (grammar-based)
  }

  nextContext(opContext, iterator) {
    return null; // Cannot iterate language codes
  }

  // ========== Additional Methods ==========

  sameConcept(opContext, a, b) {
    const codeA = this.code(opContext, a);
    const codeB = this.code(opContext, b);
    return codeA === codeB;
  }

  subsumesTest(opContext, codeA, codeB) {
    return false; // No subsumption in language codes
  }

  async searchFilter(opContext, filterContext, filter, sort) {
    throw new Error('Text search not supported for language codes');
  }

  async specialFilter(opContext, filterContext, filter, sort) {
    throw new Error('Special filters not supported for language codes');
  }

  extendLookup(opContext, ctxt, props, params) {
    // No additional properties to add
  }

  registerConceptMaps(list) {
    // No concept maps for language codes
  }

  async getTranslations(opContext, coding, target) {
    return null; // No translations available
  }
}

/**
 * Factory for creating IETF Language CodeSystem providers
 */
class IETFLanguageCodeFactory {
  constructor(languageDefinitions) {
    this.languageDefinitions = languageDefinitions;
    this.uses = 0;
  }

  defaultVersion() {
    return ''; // No versioning for BCP 47
  }

  build(opContext, supplements) {
    this.recordUse();
    return new IETFLanguageCodeProvider(this.languageDefinitions, supplements);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }
}

module.exports = {
  IETFLanguageCodeProvider,
  IETFLanguageCodeFactory,
  IETFLanguageCodeFilter,
  LanguageComponent
};