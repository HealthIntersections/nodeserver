/**
 * Represents a FHIR CodeSystem resource with version conversion support
 * @class
 */
class CodeSystem {
  /**
   * The original JSON object (always stored in R5 format internally)
   * @type {Object}
   */
  jsonObj = null;

  /**
   * FHIR version of the loaded CodeSystem
   * @type {string}
   */
  version = 'R5';

  /**
   * Map of code to concept object for fast lookup
   * @type {Map<string, Object>}
   */
  codeMap = new Map();

  /**
   * Map of display text to concept object for fast lookup
   * @type {Map<string, Object>}
   */
  displayMap = new Map();

  /**
   * Map of parent code to array of child codes
   * @type {Map<string, string[]>}
   */
  parentToChildrenMap = new Map();

  /**
   * Map of child code to array of parent codes
   * @type {Map<string, string[]>}
   */
  childToParentsMap = new Map();

  /**
   * Static factory method for convenience
   * @param {string} jsonString - JSON string representation of CodeSystem
   * @param {string} [version='R5'] - FHIR version ('R3', 'R4', or 'R5')
   * @returns {CodeSystem} New CodeSystem instance
   */
  static fromJSON(jsonString, version = 'R5') {
    return new CodeSystem(JSON.parse(jsonString), version);
  }

  /**
   * Creates a new CodeSystem instance
   * @param {Object} jsonObj - The JSON object containing CodeSystem data
   * @param {string} [version='R5'] - FHIR version ('R3', 'R4', or 'R5')
   * @param {string} jsonObj.resourceType - Must be "CodeSystem"
   * @param {string} jsonObj.url - Canonical URL for the code system
   * @param {string} [jsonObj.version] - Version of the code system
   * @param {string} jsonObj.name - Name for this code system
   * @param {string} jsonObj.status - Publication status (draft|active|retired|unknown)
   * @param {Object[]} [jsonObj.concept] - Array of concept definitions
   */
  constructor(jsonObj, version = 'R5') {
    this.version = version;
    // Convert to R5 format internally (modifies input for performance)
    this.jsonObj = this._convertToR5(jsonObj, version);
    this.validate();
    this.buildMaps();
  }

  /**
   * Returns JSON string representation
   * @param {string} [version='R5'] - Target FHIR version ('R3', 'R4', or 'R5')
   * @returns {string} JSON string
   */
  toJSONString(version = 'R5') {
    const outputObj = this._convertFromR5(this.jsonObj, version);
    return JSON.stringify(outputObj);
  }

  /**
   * Converts input CodeSystem to R5 format (modifies input object for performance)
   * @param {Object} jsonObj - The input CodeSystem object
   * @param {string} version - Source FHIR version
   * @returns {Object} The same object, potentially modified to R5 format
   * @private
   */
  _convertToR5(jsonObj, version) {
    if (version === 'R5') {
      return jsonObj; // Already R5, no conversion needed
    }

    if (version === 'R3') {
      // R3 to R5: Convert identifier from single object to array
      if (jsonObj.identifier && !Array.isArray(jsonObj.identifier)) {
        jsonObj.identifier = [jsonObj.identifier];
      }
      return jsonObj;
    }

    if (version === 'R4') {
      // R4 to R5: identifier is already an array, no conversion needed
      return jsonObj;
    }

    throw new Error(`Unsupported FHIR version: ${version}`);
  }

  /**
   * Converts R5 CodeSystem to target version format (clones object first)
   * @param {Object} r5Obj - The R5 format CodeSystem object
   * @param {string} targetVersion - Target FHIR version
   * @returns {Object} New object in target version format
   * @private
   */
  _convertFromR5(r5Obj, targetVersion) {
    if (targetVersion === 'R5') {
      return r5Obj; // No conversion needed
    }

    // Clone the object to avoid modifying the original
    const cloned = JSON.parse(JSON.stringify(r5Obj));

    if (targetVersion === 'R4') {
      return this._convertR5ToR4(cloned);
    } else if (targetVersion === 'R3') {
      return this._convertR5ToR3(cloned);
    }

    throw new Error(`Unsupported target FHIR version: ${targetVersion}`);
  }

  /**
   * Converts R5 CodeSystem to R4 format
   * @param {Object} r5Obj - Cloned R5 CodeSystem object
   * @returns {Object} R4 format CodeSystem
   * @private
   */
  _convertR5ToR4(r5Obj) {
    // Remove R5-specific elements that don't exist in R4
    if (r5Obj.versionAlgorithmString) {
      delete r5Obj.versionAlgorithmString;
    }
    if (r5Obj.versionAlgorithmCoding) {
      delete r5Obj.versionAlgorithmCoding;
    }

    // Filter out R5-only filter operators
    if (r5Obj.filter && Array.isArray(r5Obj.filter)) {
      r5Obj.filter = r5Obj.filter.map(filter => {
        if (filter.operator && Array.isArray(filter.operator)) {
          // Remove R5-only operators like 'generalizes'
          filter.operator = filter.operator.filter(op =>
            !this._isR5OnlyFilterOperator(op)
          );
        }
        return filter;
      }).filter(filter =>
        // Remove filters that have no valid operators left
        !filter.operator || filter.operator.length > 0
      );
    }

    return r5Obj;
  }

  /**
   * Converts R5 CodeSystem to R3 format
   * @param {Object} r5Obj - Cloned R5 CodeSystem object
   * @returns {Object} R3 format CodeSystem
   * @private
   */
  _convertR5ToR3(r5Obj) {
    // First apply R4 conversions
    const r4Obj = this._convertR5ToR4(r5Obj);

    // R5/R4 to R3: Convert identifier from array back to single object
    if (r4Obj.identifier && Array.isArray(r4Obj.identifier)) {
      if (r4Obj.identifier.length > 0) {
        // Take the first identifier if multiple exist
        r4Obj.identifier = r4Obj.identifier[0];
      } else {
        // Remove empty array
        delete r4Obj.identifier;
      }
    }

    // Remove additional R4-specific elements that don't exist in R3
    if (r4Obj.supplements) {
      delete r4Obj.supplements;
    }

    // R3 has more limited filter operator support
    if (r4Obj.filter && Array.isArray(r4Obj.filter)) {
      r4Obj.filter = r4Obj.filter.map(filter => {
        if (filter.operator && Array.isArray(filter.operator)) {
          // Keep only R3-compatible operators
          filter.operator = filter.operator.filter(op =>
            this._isR3CompatibleFilterOperator(op)
          );
        }
        return filter;
      }).filter(filter =>
        // Remove filters that have no valid operators left
        !filter.operator || filter.operator.length > 0
      );
    }

    return r4Obj;
  }

  /**
   * Checks if a filter operator is R5-only
   * @param {string} operator - Filter operator code
   * @returns {boolean} True if operator is R5-only
   * @private
   */
  _isR5OnlyFilterOperator(operator) {
    const r5OnlyOperators = [
      'generalizes',  // Added in R5
      // Add other R5-only operators as they're identified
    ];
    return r5OnlyOperators.includes(operator);
  }

  /**
   * Checks if a filter operator is compatible with R3
   * @param {string} operator - Filter operator code
   * @returns {boolean} True if operator is R3-compatible
   * @private
   */
  _isR3CompatibleFilterOperator(operator) {
    const r3CompatibleOperators = [
      '=',           // Equal
      'is-a',        // Is-A relationship
      'descendent-of', // Descendant of (note: R3 spelling)
      'is-not-a',    // Is-Not-A relationship
      'regex',       // Regular expression
      'in',          // In set
      'not-in',      // Not in set
      'exists',      // Property exists
    ];
    return r3CompatibleOperators.includes(operator);
  }

  /**
   * Gets the FHIR version this CodeSystem was loaded from
   * @returns {string} FHIR version ('R3', 'R4', or 'R5')
   */
  getFHIRVersion() {
    return this.version;
  }

  /**
   * Validates that this is a proper CodeSystem resource
   * @throws {Error} If validation fails
   */
  /**
   * Enhanced validate method for CodeSystem class
   * Add this to replace the existing validate() method
   */
  validate() {
    if (!this.jsonObj || typeof this.jsonObj !== 'object') {
      throw new Error('Invalid CodeSystem: expected object');
    }

    if (this.jsonObj.resourceType !== 'CodeSystem') {
      throw new Error(`Invalid CodeSystem: resourceType must be "CodeSystem", got "${this.jsonObj.resourceType}"`);
    }

    if (!this.jsonObj.url || typeof this.jsonObj.url !== 'string') {
      throw new Error('Invalid CodeSystem: url is required and must be a string');
    }

    if (!this.jsonObj.name || typeof this.jsonObj.name !== 'string') {
      throw new Error('Invalid CodeSystem: name is required and must be a string');
    }

    if (this.jsonObj.status && typeof this.jsonObj.status !== 'string') {
      throw new Error('Invalid CodeSystem: status must be a string');
    }
    if (this.jsonObj.status && typeof this.jsonObj.status == 'string') {
      const validStatuses = ['draft', 'active', 'retired', 'unknown'];
      if (!validStatuses.includes(this.jsonObj.status)) {
        throw new Error(`Invalid CodeSystem: status must be one of ${validStatuses.join(', ')}, got "${this.jsonObj.status}"`);
      }
    }

    // Validate identifier array
    if (this.jsonObj.identifier) {
      // Convert single identifier object to array if needed (for R3)
      if (!Array.isArray(this.jsonObj.identifier)) {
        this.jsonObj.identifier = [this.jsonObj.identifier];
      }

      this._validateArray(this.jsonObj.identifier, 'identifier', (identifier, index) => {
        if (!identifier || typeof identifier !== 'object') {
          throw new Error(`Invalid CodeSystem: identifier[${index}] must be an object`);
        }
      });
    }

    // Validate jurisdiction array
    if (this.jsonObj.jurisdiction) {
      if (!Array.isArray(this.jsonObj.jurisdiction)) {
        throw new Error('Invalid CodeSystem: jurisdiction must be an array if present');
      }
      this._validateArray(this.jsonObj.jurisdiction, 'jurisdiction', (jurisdiction, index) => {
        if (!jurisdiction || typeof jurisdiction !== 'object') {
          throw new Error(`Invalid CodeSystem: jurisdiction[${index}] must be an object`);
        }
      });
    }

    // Validate useContext array
    if (this.jsonObj.useContext) {
      if (!Array.isArray(this.jsonObj.useContext)) {
        throw new Error('Invalid CodeSystem: useContext must be an array if present');
      }
      this._validateArray(this.jsonObj.useContext, 'useContext', (useContext, index) => {
        if (!useContext || typeof useContext !== 'object') {
          throw new Error(`Invalid CodeSystem: useContext[${index}] must be an object`);
        }
      });
    }

    // Validate filter array
    if (this.jsonObj.filter) {
      if (!Array.isArray(this.jsonObj.filter)) {
        throw new Error('Invalid CodeSystem: filter must be an array if present');
      }
      this._validateArray(this.jsonObj.filter, 'filter', (filter, index) => {
        if (!filter || typeof filter !== 'object') {
          throw new Error(`Invalid CodeSystem: filter[${index}] must be an object`);
        }
        if (filter.operator && !Array.isArray(filter.operator)) {
          throw new Error(`Invalid CodeSystem: filter[${index}].operator must be an array if present`);
        }
        if (filter.operator) {
          this._validateArray(filter.operator, `filter[${index}].operator`, (operator, opIndex) => {
            if (typeof operator !== 'string') {
              throw new Error(`Invalid CodeSystem: filter[${index}].operator[${opIndex}] must be a string`);
            }
          });
        }
      });
    }

    // Validate property array
    if (this.jsonObj.property) {
      if (!Array.isArray(this.jsonObj.property)) {
        throw new Error('Invalid CodeSystem: property must be an array if present');
      }
      this._validateArray(this.jsonObj.property, 'property', (property, index) => {
        if (!property || typeof property !== 'object') {
          throw new Error(`Invalid CodeSystem: property[${index}] must be an object`);
        }
        if (!property.code || typeof property.code !== 'string') {
          throw new Error(`Invalid CodeSystem: property[${index}].code is required and must be a string`);
        }
      });
    }

    // Validate concept array
    if (this.jsonObj.concept) {
      if (!Array.isArray(this.jsonObj.concept)) {
        throw new Error('Invalid CodeSystem: concept must be an array if present');
      }
      this._validateConceptArray(this.jsonObj.concept, 'concept');
    }
  }

  /**
   * Helper method to validate arrays for null/undefined elements
   * @param {Array} array - The array to validate
   * @param {string} path - Path description for error messages
   * @param {Function} [itemValidator] - Optional function to validate each item
   * @private
   */
  _validateArray(array, path, itemValidator) {
    if (!Array.isArray(array)) {
      throw new Error(`Invalid CodeSystem: ${path} must be an array`);
    }

    array.forEach((item, index) => {
      if (item === null || item === undefined) {
        throw new Error(`Invalid CodeSystem: ${path}[${index}] is null or undefined`);
      }
      if (itemValidator) {
        itemValidator(item, index);
      }
    });
  }

  /**
   * Recursively validates concept arrays and their nested structure
   * @param {Array} concepts - Array of concepts to validate
   * @param {string} path - Path description for error messages
   * @private
   */
  _validateConceptArray(concepts, path) {
    this._validateArray(concepts, path, (concept, index) => {
      const conceptPath = `${path}[${index}]`;

      if (!concept || typeof concept !== 'object') {
        throw new Error(`Invalid CodeSystem: ${conceptPath} must be an object`);
      }

      if (!concept.code || typeof concept.code !== 'string') {
        throw new Error(`Invalid CodeSystem: ${conceptPath}.code is required and must be a string`);
      }

      // Validate designation array
      if (concept.designation) {
        if (!Array.isArray(concept.designation)) {
          throw new Error(`Invalid CodeSystem: ${conceptPath}.designation must be an array if present`);
        }
        this._validateArray(concept.designation, `${conceptPath}.designation`, (designation, desigIndex) => {
          if (!designation || typeof designation !== 'object') {
            throw new Error(`Invalid CodeSystem: ${conceptPath}.designation[${desigIndex}] must be an object`);
          }
          // We could add more specific designation validation here if needed
        });
      }

      // Validate property array
      if (concept.property) {
        if (!Array.isArray(concept.property)) {
          throw new Error(`Invalid CodeSystem: ${conceptPath}.property must be an array if present`);
        }
        this._validateArray(concept.property, `${conceptPath}.property`, (property, propIndex) => {
          if (!property || typeof property !== 'object') {
            throw new Error(`Invalid CodeSystem: ${conceptPath}.property[${propIndex}] must be an object`);
          }
          if (!property.code || typeof property.code !== 'string') {
            throw new Error(`Invalid CodeSystem: ${conceptPath}.property[${propIndex}].code is required and must be a string`);
          }
        });
      }

      // Recursively validate nested concepts
      if (concept.concept) {
        if (!Array.isArray(concept.concept)) {
          throw new Error(`Invalid CodeSystem: ${conceptPath}.concept must be an array if present`);
        }
        this._validateConceptArray(concept.concept, `${conceptPath}.concept`);
      }
    });
  }

  /**
   * Builds internal maps for fast concept lookup and hierarchy navigation
   * @private
   */
  buildMaps() {
    this.codeMap.clear();
    this.displayMap.clear();
    this.parentToChildrenMap.clear();
    this.childToParentsMap.clear();

    if (!this.jsonObj.concept) {
      return;
    }

    // First pass: build basic maps and collect all concepts (including nested)
    const allConcepts = [];
    this._collectAllConcepts(this.jsonObj.concept, allConcepts);

    allConcepts.forEach(concept => {
      // Build code and display maps
      this.codeMap.set(concept.code, concept);
      if (concept.display) {
        this.displayMap.set(concept.display, concept);
      }
    });

    // Second pass: build hierarchy maps
    allConcepts.forEach(concept => {
      this._buildHierarchyMaps(concept);
    });

    // Third pass: handle nested concept structures
    this._buildNestedHierarchy(this.jsonObj.concept);
  }

  /**
   * Recursively collects all concepts including nested ones
   * @param {Object[]} concepts - Array of concepts
   * @param {Object[]} allConcepts - Accumulator for all concepts
   * @private
   */
  _collectAllConcepts(concepts, allConcepts) {
    concepts.forEach(concept => {
      allConcepts.push(concept);
      if (concept.concept && Array.isArray(concept.concept)) {
        this._collectAllConcepts(concept.concept, allConcepts);
      }
    });
  }

  /**
   * Builds hierarchy maps from concept properties
   * @param {Object} concept - The concept to process
   * @private
   */
  _buildHierarchyMaps(concept) {
    if (!concept.property || !Array.isArray(concept.property)) {
      return;
    }

    concept.property.forEach(property => {
      if (property.code === 'parent' && property.valueCode) {
        // This concept has a parent
        this._addToChildToParentsMap(concept.code, property.valueCode);
        this._addToParentToChildrenMap(property.valueCode, concept.code);
      } else if (property.code === 'child' && property.valueCode) {
        // This concept has a child
        this._addToParentToChildrenMap(concept.code, property.valueCode);
        this._addToChildToParentsMap(property.valueCode, concept.code);
      }
    });
  }

  /**
   * Builds hierarchy from nested concept structures
   * @param {Object[]} concepts - Array of concepts
   * @param {string} [parentCode] - Code of parent concept
   * @private
   */
  _buildNestedHierarchy(concepts, parentCode = null) {
    concepts.forEach(concept => {
      if (parentCode) {
        this._addToChildToParentsMap(concept.code, parentCode);
        this._addToParentToChildrenMap(parentCode, concept.code);
      }

      if (concept.concept && Array.isArray(concept.concept)) {
        this._buildNestedHierarchy(concept.concept, concept.code);
      }
    });
  }

  /**
   * Adds a parent-child relationship to the child-to-parents map
   * @param {string} childCode - The child concept code
   * @param {string} parentCode - The parent concept code
   * @private
   */
  _addToChildToParentsMap(childCode, parentCode) {
    if (!this.childToParentsMap.has(childCode)) {
      this.childToParentsMap.set(childCode, []);
    }
    const parents = this.childToParentsMap.get(childCode);
    if (!parents.includes(parentCode)) {
      parents.push(parentCode);
    }
  }

  /**
   * Adds a parent-child relationship to the parent-to-children map
   * @param {string} parentCode - The parent concept code
   * @param {string} childCode - The child concept code
   * @private
   */
  _addToParentToChildrenMap(parentCode, childCode) {
    if (!this.parentToChildrenMap.has(parentCode)) {
      this.parentToChildrenMap.set(parentCode, []);
    }
    const children = this.parentToChildrenMap.get(parentCode);
    if (!children.includes(childCode)) {
      children.push(childCode);
    }
  }

  /**
   * Gets a concept by its code
   * @param {string} code - The concept code to look up
   * @returns {Object|undefined} The concept object or undefined if not found
   */
  getConceptByCode(code) {
    return this.codeMap.get(code);
  }

  /**
   * Gets a concept by its display text
   * @param {string} display - The display text to look up
   * @returns {Object|undefined} The concept object or undefined if not found
   */
  getConceptByDisplay(display) {
    return this.displayMap.get(display);
  }

  /**
   * Gets all child codes for a given parent code
   * @param {string} parentCode - The parent concept code
   * @returns {string[]} Array of child codes (empty array if no children)
   */
  getChildren(parentCode) {
    return this.parentToChildrenMap.get(parentCode) || [];
  }

  /**
   * Gets all parent codes for a given child code
   * @param {string} childCode - The child concept code
   * @returns {string[]} Array of parent codes (empty array if no parents)
   */
  getParents(childCode) {
    return this.childToParentsMap.get(childCode) || [];
  }

  /**
   * Gets all descendant codes (children, grandchildren, etc.) for a given code
   * @param {string} code - The ancestor concept code
   * @returns {string[]} Array of all descendant codes
   */
  getDescendants(code) {
    const descendants = new Set();
    const toProcess = [code];

    while (toProcess.length > 0) {
      const current = toProcess.pop();
      const children = this.getChildren(current);

      children.forEach(child => {
        if (!descendants.has(child)) {
          descendants.add(child);
          toProcess.push(child);
        }
      });
    }

    return Array.from(descendants);
  }

  /**
   * Gets all ancestor codes (parents, grandparents, etc.) for a given code
   * @param {string} code - The descendant concept code
   * @returns {string[]} Array of all ancestor codes
   */
  getAncestors(code) {
    const ancestors = new Set();
    const visited = new Set([code]); // Track visited codes to handle circular references
    const toProcess = [code];

    while (toProcess.length > 0) {
      const current = toProcess.pop();
      const parents = this.getParents(current);

      parents.forEach(parent => {
        if (!visited.has(parent)) {
          visited.add(parent);
          ancestors.add(parent);
          toProcess.push(parent);
        }
      });
    }

    return Array.from(ancestors);
  }

  /**
   * Checks if a code is a descendant of another code
   * @param {string} descendantCode - The potential descendant code
   * @param {string} ancestorCode - The potential ancestor code
   * @returns {boolean} True if descendantCode is a descendant of ancestorCode
   */
  isDescendantOf(descendantCode, ancestorCode) {
    return this.getAncestors(descendantCode).includes(ancestorCode);
  }

  /**
   * Gets root concepts (concepts with no parents)
   * @returns {string[]} Array of root concept codes
   */
  getRootConcepts() {
    return Array.from(this.codeMap.keys()).filter(code =>
      this.getParents(code).length === 0
    );
  }

  /**
   * Gets leaf concepts (concepts with no children)
   * @returns {string[]} Array of leaf concept codes
   */
  getLeafConcepts() {
    return Array.from(this.codeMap.keys()).filter(code =>
      this.getChildren(code).length === 0
    );
  }

  /**
   * Checks if a code exists in this code system
   * @param {string} code - The code to check
   * @returns {boolean} True if the code exists
   */
  hasCode(code) {
    return this.codeMap.has(code);
  }

  /**
   * Gets all codes in this code system
   * @returns {string[]} Array of all codes
   */
  getAllCodes() {
    return Array.from(this.codeMap.keys());
  }

  /**
   * Gets all concepts in this code system
   * @returns {Object[]} Array of all concept objects
   */
  getAllConcepts() {
    return Array.from(this.codeMap.values());
  }

  /**
   * Gets basic info about this code system
   * @returns {Object} Basic information object
   */
  getInfo() {
    return {
      resourceType: this.jsonObj.resourceType,
      url: this.jsonObj.url,
      version: this.jsonObj.version,
      name: this.jsonObj.name,
      title: this.jsonObj.title,
      status: this.jsonObj.status,
      fhirVersion: this.version,
      conceptCount: this.codeMap.size,
      rootConceptCount: this.getRootConcepts().length,
      leafConceptCount: this.getLeafConcepts().length
    };
  }

  static isUseADisplay(use) {
    return true; // for now
  }
}

module.exports = CodeSystem;