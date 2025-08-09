const CodeSystem = require('../library/codesystem');
const { CodeSystemProvider, CodeSystemFactoryProvider} = require('./cs-api');
const { Language, Languages } = require('../../tx/library/languages');

/**
 * Code system provider for URIs
 * This is a simple provider that treats any URI as a valid code
 * Uses strings directly as context since URIs have no additional metadata
 * Enhanced to support supplements for display and definition lookup
 */
class UriServices extends CodeSystemProvider {
  /**
   * @type {CodeSystem[]}
   */
  supplements;

  constructor(supplements) {
    super();
    this.supplements = supplements;
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

  // ============================================================================
  // Metadata for the code system
  // ============================================================================

  system() {
    return 'urn:ietf:rfc:3986'; // URI_URIs constant equivalent
  }

  version() {
    return 'n/a';
  }

  description() {
    return 'URIs';
  }

  totalCount() {
    return -1; // Infinite/unknown count
  }

  name() {
    return 'Internal URI services';
  }

  defLang() {
    return 'en';
  }

  hasAnyDisplays(languages) {
    // Convert input to Languages instance if needed
    const langs = languages instanceof Languages ? languages :
      Array.isArray(languages) ? Languages.fromAcceptLanguage(languages.join(',')) :
        Languages.fromAcceptLanguage(languages || '');

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

    return false; // URIs don't have displays by default
  }

  hasParents() {
    return false; // URIs don't have hierarchy
  }

  // ============================================================================
  // Getting Information about concepts
  // ============================================================================

  code(opContext, code) {
    return code; // For URIs, the code is the context
  }

  async display(opContext, code) {
    // Check supplements for display
    if (this.supplements) {
      for (const supplement of this.supplements) {
        const concept = supplement.getConceptByCode(code);
        if (concept && concept.display) {
          return concept.display;
        }
      }
    }

    return ''; // URIs don't have displays by default
  }

  async definition(opContext, code) {
    // Check supplements for definition
    if (this.supplements) {
      for (const supplement of this.supplements) {
        if (supplement.concept) {
          const concept = supplement.concept.find(c => c.code === code);
          if (concept && concept.definition) {
            return concept.definition;
          }
        }
      }
    }

    return ''; // URIs don't have definitions by default
  }

  isAbstract(opContext, code) {
    return false; // URIs are not abstract
  }

  isInactive(opContext, code) {
    return false; // URIs are not inactive
  }

  isDeprecated(opContext, code) {
    return false; // URIs are not deprecated
  }

  getStatus(opContext, code) {
    return null;
  }

  async designations(opContext, code) {
    let allDesignations = [];

    if (this.supplements) {
      for (const supplement of this.supplements) {
        const concept = supplement.getConceptByCode(code);  // ← Uses CodeSystem API
        if (concept && concept.designation) {
          allDesignations = allDesignations.concat(concept.designation);
        }
      }
    }

    return allDesignations.length > 0 ? allDesignations : null;
  }

  properties(opContext, code) {
    // Collect properties from all supplements
    let allProperties = [];

    if (this.supplements) {
      for (const supplement of this.supplements) {
        const concept = supplement.getConceptByCode(code);  // ← Uses CodeSystem API
        if (concept && concept.property) {
          // Add all properties from this concept
          allProperties = allProperties.concat(concept.property);
        }
      }
    }

    return allProperties.length > 0 ? allProperties : null;
  }

  sameConcept(opContext, a, b) {
    return a === b; // For URIs, direct string comparison
  }

  // ============================================================================
  // Finding concepts
  // ============================================================================

  async locate(opContext, code) {
    // For URIs, any string is potentially valid
    // But we can check if it exists in supplements for better validation
    if (this.supplements) {
      for (const supplement of this.supplements) {
        if (supplement.concept) {
          const concept = supplement.concept.find(c => c.code === code);
          if (concept) {
            return {
              context: code,
              message: null
            };
          }
        }
      }
    }

    // Even if not in supplements, URIs are still valid
    return {
      context: code, // Use the string directly as context
      message: null
    };
  }

  async locateIsA(opContext, code, parent, disallowParent) {
    // URIs don't have formal subsumption properties
    return {
      context: null,
      message: `URIs do not have parents`
    };
  }

  iterator(opContext, code) {
    return null; // Cannot iterate URIs
  }

  nextContext(opContext, context) {
    return null; // No iteration support
  }

  subsumesTest(opContext, codeA, codeB) {
    return false; // No subsumption for URIs
  }

  // ============================================================================
  // Filtering (not supported for URIs)
  // ============================================================================

  doesFilter(opContext, prop, op, value) {
    return false; // No filters supported
  }

  getPrepContext(opContext, iterate) {
    return null; // No filtering context needed
  }

  async searchFilter(opContext, filterContext, filter, sort) {
    throw new Error('Search filtering not supported for URI code system');
  }

  async specialFilter(opContext, filterContext, filter, sort) {
    throw new Error('Special filtering not supported for URI code system');
  }

  async executeFilters(opContext, filterContext) {
    throw new Error('Filter execution not supported for URI code system');
  }

  filterSize(opContext, filterContext, set) {
    throw new Error('Filter size not supported for URI code system');
  }

  filtersNotClosed(opContext, filterContext) {
    return true; // URI space is not closed
  }

  filterMore(opContext, filterContext, set) {
    throw new Error('Filter iteration not supported for URI code system');
  }

  filterConcept(opContext, filterContext, set) {
    throw new Error('Filter concept access not supported for URI code system');
  }

  filterLocate(opContext, filterContext, set, code) {
    throw new Error('Filter locate not supported for URI code system');
  }

  filterCheck(opContext, filterContext, set, concept) {
    throw new Error('Filter check not supported for URI code system');
  }

  filterFinish(opContext, filterContext) {
    // Nothing to clean up
  }

  // ============================================================================
  // Translations and concept maps
  // ============================================================================

  registerConceptMaps(list) {
    // No concept maps for URIs
  }

  getTranslations(opContext, coding, target) {
    return null; // No translations available
  }
}

/**
 * Factory for creating URI code system providers
 */
class UriServicesFactory extends CodeSystemFactoryProvider {

  defaultVersion() {
    return 'n/a';
  }

  async build(opContext, supplements) {
    this.recordUse();
    return new UriServices(supplements);
  }
}

module.exports = {
  UriServices,
  UriServicesFactory
};