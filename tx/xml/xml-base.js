//
// FHIR XML Base Class
// Common functionality for all FHIR resource XML serialization/deserialization
//

/**
 * Base class for FHIR XML serialization/deserialization
 * Contains shared methods for converting between FHIR JSON and XML formats
 */
class FhirXmlBase {

  /**
   * FHIR elements that should always be arrays in JSON
   * These are elements that are arrays at the TOP LEVEL of resources or in unambiguous contexts
   * @type {Set<string>}
   */
  static _arrayElements = new Set([
    // Common resource / DomainResource elements
    'contained',
    // Note: 'identifier' is context-dependent - see _isArrayElement
    // (0..1 on ConceptMap in R4, 0..* on most other resources and ConceptMap in R5)
    'contact',
    'useContext',
    'jurisdiction',
    'extension',
    'modifierExtension',

    // Meta elements
    // Note: Meta.profile, Meta.security, Meta.tag are all context-dependent
    // (array in meta, but singular elsewhere) - handled in _isArrayElement

    // CodeSystem elements
    'concept',          // CodeSystem.concept 0..* (recursive)
    'filter',           // CodeSystem.filter 0..* (also ValueSet.compose.include.filter)
    'operator',         // CodeSystem.filter.operator 0..*
    'designation',      // concept.designation 0..*

    // ValueSet elements
    'include',          // ValueSet.compose.include 0..*
    'exclude',          // ValueSet.compose.exclude 0..*
    'contains',         // ValueSet.expansion.contains 0..* (recursive)
    'parameter',        // ValueSet.expansion.parameter 0..*, Parameters.parameter 0..*
    'valueSet',         // ValueSet.compose.include.valueSet 0..*

    // ConceptMap elements
    'group',            // ConceptMap.group 0..*
    'element',          // ConceptMap.group.element 0..*
    // Note: 'target' is context-dependent - see _isArrayElement
    // (array in ConceptMap.group.element.target, but single uri in ConceptMap.group.target R4)
    'dependsOn',        // ConceptMap.group.element.target.dependsOn 0..*
    'product',          // ConceptMap.group.element.target.product 0..*
    'additionalAttribute', // R5 ConceptMap.additionalAttribute 0..*

    // OperationOutcome elements
    'issue',            // OperationOutcome.issue 0..*
    'location',         // OperationOutcome.issue.location 0..*
    'expression',       // OperationOutcome.issue.expression 0..*

    // Parameters elements
    'part',             // Parameters.parameter.part 0..*

    // Common data type elements
    'coding',           // CodeableConcept.coding 0..*
    'telecom',          // ContactDetail.telecom, ContactPoint uses
    // Note: 'address' is NOT in this set - it is 0..1 in endpoint.address
    // and none of our terminology resources use Address arrays directly
    'given',            // HumanName.given 0..*
    'prefix',           // HumanName.prefix 0..*
    'suffix',           // HumanName.suffix 0..*
    'line',             // Address.line 0..*
    'link',             // Bundle.link 0..*
    'entry',            // Bundle.entry 0..*

    // NamingSystem elements
    'uniqueId',         // NamingSystem.uniqueId 0..*

    // CapabilityStatement elements
    'instantiates',     // CS.instantiates 0..*
    'imports',          // CS.imports 0..* (R4+)
    'format',           // CS.format 1..*
    'patchFormat',      // CS.patchFormat 0..*
    'acceptLanguage',   // CS.acceptLanguage 0..* (R5)
    'implementationGuide', // CS.implementationGuide 0..*
    'rest',             // CS.rest 0..*
    'resource',         // CS.rest.resource 0..*
    'interaction',      // CS.rest.resource.interaction 0..*, CS.rest.interaction 0..*
    'searchInclude',    // CS.rest.resource.searchInclude 0..*
    'searchRevInclude', // CS.rest.resource.searchRevInclude 0..*
    'searchParam',      // CS.rest.resource.searchParam 0..*
    'operation',        // CS.rest.resource.operation 0..*, CS.rest.operation 0..*
    'supportedProfile', // CS.rest.resource.supportedProfile 0..* (R4+)
    'compartment',      // CS.rest.compartment 0..*
    'messaging',        // CS.messaging 0..*
    'endpoint',         // CS.messaging.endpoint 0..*
    'supportedMessage', // CS.messaging.supportedMessage 0..*
    'document',         // CS.document 0..*
    'service',          // CS.rest.security.service 0..*

    // TerminologyCapabilities elements
    'codeSystem',       // TC.codeSystem 0..*
  ]);

  /**
   * Elements that are arrays only in certain parent contexts.
   * These need special handling because the same element name has different
   * cardinality depending on where it appears.
   * @type {Set<string>}
   */
  static _contextDependentArrayElements = new Set([
    'property',   // Array in CodeSystem.property and concept.property, but single in filter
    'profile',    // Array in Meta.profile, but single in CS.rest.resource.profile, CS.document.profile
    'address',    // Array in Patient.address etc, but single in CS.messaging.endpoint.address
    'target',     // Array in ConceptMap.group.element.target, but single uri in ConceptMap.group.target (R4)
    'identifier', // Array on most resources, but 0..1 on ConceptMap in R4 (version-dependent)
    'version',    // Array in TC.codeSystem.version, but single everywhere else
    'language',   // Array in TC.codeSystem.version.language, but single on Resource.language
    'security',   // Array in Meta.security, but single in CS.rest.security
    'tag',        // Array in Meta.tag (handled specially in renderMeta, but needed for generic parsing)
  ]);

  /**
   * Element names that represent boolean types in FHIR.
   * These are converted from XML string "true"/"false" to JSON boolean.
   * @type {Set<string>}
   */
  static _booleanElements = new Set([
    // value[x] boolean
    'valueBoolean',

    // Common resource elements
    'experimental',

    // CodeSystem elements
    'caseSensitive',
    'compositional',
    'versionNeeded',
    'inactive',       // concept.property.valueBoolean (context: concept inactive)

    // CodeSystem concept elements
    'notSelectable',  // concept extension (deprecated but still in use)
    'abstract',       // expansion.contains.abstract

    // ValueSet elements
    'immutable',      // ValueSet.immutable

    // NamingSystem elements
    'preferred',      // NamingSystem.uniqueId.preferred

    // CapabilityStatement elements
    'cors',           // CS.rest.security.cors
    'readHistory',    // CS.rest.resource.readHistory
    'updateCreate',   // CS.rest.resource.updateCreate
    'conditionalCreate',   // CS.rest.resource.conditionalCreate
    'conditionalUpdate',   // CS.rest.resource.conditionalUpdate
    'conditionalPatch',
    'multipleOr',     // CS.rest.resource.searchParam (R5)
    'multipleAnd',    // CS.rest.resource.searchParam (R5)

    // ValueSet expansion contains
    // 'abstract' already listed above
    // 'inactive' already listed above

    // Generic backbone elements
    'userSelected',   // Coding.userSelected
  ]);

  /**
   * Element names that represent integer types in FHIR.
   * These are converted from XML string to JSON number (parseInt).
   * @type {Set<string>}
   */
  static _integerElements = new Set([
    // value[x] integer types
    'valueInteger',
    'valueUnsignedInt',
    'valuePositiveInt',

    // Common elements
    'count',          // CodeSystem.count
    'offset',         // ValueSet.expansion.offset
    'total',          // ValueSet.expansion.total, Bundle.total

    // CapabilityStatement elements
    'reliableCache',  // CS.messaging.reliableCache
  ]);

  /**
   * Element names that represent decimal types in FHIR.
   * These are converted from XML string to JSON number (parseFloat).
   * @type {Set<string>}
   */
  static _decimalElements = new Set([
    'valueDecimal',
    'score',          // Bundle.entry.search.score
  ]);

  /**
   * Parent element contexts where 'value' is a decimal (Quantity-like types).
   * In FHIR, Quantity.value, Money.value etc. are decimal, but most other
   * uses of 'value' (Identifier.value, ContactPoint.value, etc.) are strings.
   * @type {Set<string>}
   */
  static _quantityContexts = new Set([
    'valueQuantity',
    'valueMoney',
    'quantity',       // generic Quantity backbone
    'amount',         // Money amount contexts
    'Quantity',
    'Money',
    'Duration',
    'Age',
    'Distance',
    'Count',
    'SimpleQuantity',
  ]);

  // ==================== XML PARSING (XML -> JSON) ====================

  /**
   * Convert a manually parsed XML element to FHIR JSON format
   * @param {Object} element - Element with {name, attributes, children}
   * @param {string} resourceType - The FHIR resource type
   * @param {number} [fhirVersion] - FHIR version (3, 4, or 5) for version-dependent handling
   * @returns {Object} FHIR JSON object
   */
  static convertElementToFhirJson(element, resourceType, fhirVersion) {
    const result = { resourceType };

    for (const child of element.children) {
      const key = child.name;
      const { value, primitiveExt } = this._convertChildElementWithExt(child, resourceType, fhirVersion);

      // Handle the value
      if (value !== null) {
        if (this._isArrayElement(key, resourceType, fhirVersion)) {
          if (!result[key]) {
            result[key] = [];
          }
          result[key].push(value);
        } else {
          result[key] = value;
        }
      }

      // Handle primitive extension (e.g., _value with extension)
      if (primitiveExt !== null) {
        const extKey = '_' + key;
        result[extKey] = primitiveExt;
      }
    }

    return result;
  }

  /**
   * Check if an element should be an array based on its name and parent context
   * @param {string} elementName - The element name
   * @param {string} parentContext - The parent element name or context
   * @param {number} [fhirVersion] - FHIR version (3, 4, or 5) for version-dependent handling
   * @returns {boolean}
   */
  static _isArrayElement(elementName, parentContext, fhirVersion) {
    // These are always arrays regardless of context
    if (this._arrayElements.has(elementName)) {
      return true;
    }

    // Context-dependent array elements:

    // 'property' is an array in CodeSystem.property, CodeSystem.concept.property,
    // ConceptMap.property (R5), but NOT in filter.property (which is a single code)
    if (elementName === 'property') {
      return parentContext !== 'filter';
    }

    // 'target' is 0..* in ConceptMap.group.element.target (backbone array)
    // but 0..1 in ConceptMap.group.target (R4 uri) and ConceptMap.group.target (R5 uri)
    if (elementName === 'target') {
      return parentContext === 'element';
    }

    // 'identifier' is 0..* on most resources but 0..1 on ConceptMap in R4 and R3
    if (elementName === 'identifier') {
      if (parentContext === 'ConceptMap') {
        return fhirVersion >= 5;
      }
      return true; // 0..* on all other resource types
    }

    // 'version' is 0..* in TerminologyCapabilities.codeSystem.version
    // but 0..1 everywhere else (CodeSystem.version, ValueSet.version, etc.)
    if (elementName === 'version') {
      return parentContext === 'codeSystem';
    }

    // 'language' is 0..* in TerminologyCapabilities.codeSystem.version.language
    // but 0..1 on Resource.language
    if (elementName === 'language') {
      return parentContext === 'version';
    }

    // 'profile' is 0..* in Meta.profile
    // but 0..1 in CapabilityStatement.rest.resource.profile, CS.document.profile
    if (elementName === 'profile') {
      return parentContext === 'meta';
    }

    // 'security' is 0..* in Meta.security (Coding)
    // but 0..1 in CapabilityStatement.rest.security (BackboneElement)
    if (elementName === 'security') {
      return parentContext === 'meta';
    }

    // 'tag' is 0..* in Meta.tag (Coding)
    if (elementName === 'tag') {
      return parentContext === 'meta';
    }

    return false;
  }

  /**
   * Converts a child element to appropriate JSON value, also handling primitive extensions
   * @param {Object} child - Child element with {name, attributes, children}
   * @param {string} parentContext - Parent element name for context-dependent array handling
   * @param {number} [fhirVersion] - FHIR version for version-dependent handling
   * @returns {{value: *, primitiveExt: Object|null}} Converted value and primitive extension if any
   * @private
   */
  // eslint-disable-next-line no-unused-vars
  static _convertChildElementWithExt(child, parentContext = '', fhirVersion) {
    const hasValue = child.attributes.value !== undefined;
    const hasChildren = child.children.length > 0;
    const isExtensionElement = child.name === 'extension' || child.name === 'modifierExtension';

    // Extension elements are NEVER primitive extensions - they are always complex elements
    // Only primitive FHIR elements (like string, code, uri, etc.) can have primitive extensions
    if (!isExtensionElement) {
      // Check if children are only extensions (for primitive extension detection)
      const extensionChildren = child.children.filter(
        c => c.name === 'extension' || c.name === 'modifierExtension'
      );
      const nonExtensionChildren = child.children.filter(
        c => c.name !== 'extension' && c.name !== 'modifierExtension'
      );
      const hasOnlyExtensions = hasChildren && nonExtensionChildren.length === 0;

      // Case 1: Simple primitive with value, no children
      if (hasValue && !hasChildren) {
        return { value: this._convertPrimitiveValue(child.name, child.attributes.value, parentContext), primitiveExt: null };
      }

      // Case 2: Primitive with extension but no value - this is a primitive extension only
      // This ONLY applies when there are NO non-extension children
      if (!hasValue && hasOnlyExtensions) {
        const ext = this._buildExtensionObject(extensionChildren);
        return { value: null, primitiveExt: ext };
      }

      // Case 3: Primitive with both value and extensions (no other children)
      // This ONLY applies when there are NO non-extension children
      if (hasValue && hasOnlyExtensions) {
        const ext = this._buildExtensionObject(extensionChildren);
        return { value: this._convertPrimitiveValue(child.name, child.attributes.value, parentContext), primitiveExt: ext };
      }
    }

    // Case 4: Complex element - process normally (includes extensions as regular children)
    const obj = {};
    const currentContext = child.name; // Use current element name as context for children

    // Copy non-value attributes (like url for extensions)
    for (const [attrName, attrValue] of Object.entries(child.attributes)) {
      if (attrName !== 'value' && attrName !== 'xmlns') {
        obj[attrName] = attrValue;
      }
    }

    // Process ALL children (including extensions as normal array elements)
    for (const grandchild of child.children) {
      const key = grandchild.name;
      const { value, primitiveExt } = this._convertChildElementWithExt(grandchild, currentContext, fhirVersion);

      // Handle the value
      if (value !== null) {
        if (this._isArrayElement(key, currentContext, fhirVersion)) {
          if (!obj[key]) {
            obj[key] = [];
          }
          obj[key].push(value);
        } else if (obj[key] !== undefined) {
          // Convert to array if we see the same key twice
          if (!Array.isArray(obj[key])) {
            obj[key] = [obj[key]];
          }
          obj[key].push(value);
        } else {
          obj[key] = value;
        }
      }

      // Handle primitive extension
      if (primitiveExt !== null) {
        const extKey = '_' + key;
        obj[extKey] = primitiveExt;
      }
    }

    return { value: Object.keys(obj).length > 0 ? obj : null, primitiveExt: null };
  }

  /**
   * Build an extension object from extension children
   * @param {Array} extensionChildren - Array of extension child elements
   * @returns {Object} Extension object with extension/modifierExtension arrays
   * @private
   */
  static _buildExtensionObject(extensionChildren) {
    const ext = {};
    for (const extChild of extensionChildren) {
      const key = extChild.name;
      const { value } = this._convertChildElementWithExt(extChild);
      if (!ext[key]) {
        ext[key] = [];
      }
      ext[key].push(value);
    }
    return ext;
  }

  /**
   * Convert a primitive value to the appropriate JavaScript type
   * @param {string} elementName - The element name
   * @param {string} value - The string value from XML
   * @param {string} [parentContext] - Parent element name for context-dependent typing
   * @returns {*} Converted value
   * @private
   */
  static _convertPrimitiveValue(elementName, value, parentContext) {
    if (this._booleanElements.has(elementName)) {
      return value === 'true';
    }
    if (this._integerElements.has(elementName)) {
      return parseInt(value, 10);
    }
    if (this._decimalElements.has(elementName)) {
      return parseFloat(value);
    }
    // 'value' is a decimal inside Quantity-like types (valueQuantity, valueMoney, Quantity, etc.)
    if (elementName === 'value' && this._quantityContexts.has(parentContext)) {
      return parseFloat(value);
    }
    // Everything else stays as string
    return value;
  }

  /**
   * Simple child element conversion (without tracking primitive extensions)
   * @param {Object} child - Child element with {name, attributes, children}
   * @param {string} parentContext - Parent context for array handling
   * @param {number} [fhirVersion] - FHIR version for version-dependent handling
   * @returns {*} Converted value
   */
  static convertChildElement(child, parentContext = '', fhirVersion) {
    return this._convertChildElementWithExt(child, parentContext, fhirVersion).value;
  }

  // ==================== XML GENERATION (JSON -> XML) ====================

  /**
   * Get the FHIR namespace
   * @returns {string}
   */
  static getNamespace() {
    return 'http://hl7.org/fhir';
  }

  /**
   * Get indentation string
   * @param {number} level - Indentation level
   * @returns {string}
   */
  static indent(level) {
    return '  '.repeat(level);
  }

  /**
   * Escape special characters for XML
   *
   * XML 1.0 cannot represent the C0 control characters at all - not literally,
   * and not as numeric character references either - so a value carrying one
   * cannot be serialised as XML by any means. Tab, line feed and carriage
   * return are the three exceptions; DEL (U+007F) is legal in XML 1.0 and is
   * left alone.
   *
   * Rather than emit a document no conformant parser will read, this rejects
   * the value. Anything reaching here with a control character in it came from
   * outside (a remote API, an imported file) and should have been caught at
   * the boundary.
   *
   * @param {*} value - Value to escape
   * @returns {string}
   * @throws {Error} if the value contains a character XML cannot carry
   */
  static escapeXml(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    // eslint-disable-next-line no-control-regex
    const illegal = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.exec(str);
    if (illegal) {
      const code = illegal[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
      throw new Error(`Cannot serialise this content as XML: it contains U+${code} at offset ${illegal.index}, a control character XML does not allow`);
    }
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Unescape XML entities
   * @param {string} str - String to unescape
   * @returns {string}
   */
  static unescapeXml(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  /**
   * Render an element to XML
   * @param {string} name - Element name
   * @param {*} value - Element value
   * @param {number} level - Indentation level
   * @returns {string} XML string
   */
  static renderElement(name, value, level) {
    if (value === null || value === undefined) {
      return '';
    }

    let xml = '';

    if (Array.isArray(value)) {
      for (const item of value) {
        xml += this.renderElement(name, item, level);
      }
    } else if (typeof value === 'object') {
      // Special handling for extension - url is an attribute
      if (name === 'extension' || name === 'modifierExtension') {
        const url = value.url ? ` url="${this.escapeXml(value.url)}"` : '';
        xml += `${this.indent(level)}<${name}${url}>\n`;
        xml += this.renderObject(value, level + 1, ['url']);
        xml += `${this.indent(level)}</${name}>\n`;
      } else {
        xml += `${this.indent(level)}<${name}>\n`;
        xml += this.renderObject(value, level + 1);
        xml += `${this.indent(level)}</${name}>\n`;
      }
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      xml += `${this.indent(level)}<${name} value="${value}"/>\n`;
    } else {
      xml += `${this.indent(level)}<${name} value="${this.escapeXml(value)}"/>\n`;
    }

    return xml;
  }

  /**
   * Render an object's properties to XML
   * @param {Object} obj - Object to render
   * @param {number} level - Indentation level
   * @param {Array<string>} skipKeys - Keys to skip
   * @returns {string} XML string
   */
  static renderObject(obj, level, skipKeys = []) {
    let xml = '';

    for (const [key, value] of Object.entries(obj)) {
      // Skip primitive extension keys (handled separately)
      if (key.startsWith('_')) {
        continue;
      }
      if (skipKeys.includes(key)) {
        continue;
      }
      xml += this.renderElement(key, value, level);
    }

    return xml;
  }

  /**
   * Render elements in a specific order
   * @param {Object} obj - Object to render
   * @param {number} level - Indentation level
   * @param {Array<string>} elementOrder - Ordered list of element names
   * @returns {string} XML string
   */
  static renderElementsInOrder(obj, level, elementOrder) {
    let xml = '';

    // Process elements in order
    for (const key of elementOrder) {
      if (Object.hasOwn(obj, key) && key !== 'resourceType') {
        xml += this.renderElement(key, obj[key], level);
      }
    }

    // Process any remaining elements not in the order list
    for (const key of Object.keys(obj)) {
      if (!elementOrder.includes(key) && key !== 'resourceType' && !key.startsWith('_')) {
        xml += this.renderElement(key, obj[key], level);
      }
    }

    return xml;
  }

  /**
   * Generate XML declaration and root element wrapper
   * @param {string} resourceType - FHIR resource type
   * @param {string} content - Inner XML content
   * @returns {string} Complete XML document
   */
  static wrapInRootElement(resourceType, content) {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += `<${resourceType} xmlns="${this.getNamespace()}">\n`;
    xml += content;
    xml += `</${resourceType}>`;
    return xml;
  }

  // ==================== XML STRING PARSING ====================

  /**
   * Manual XML parser - parses XML string to element tree
   */
  static parseXmlString(xml) {
    const parser = new FhirXmlParser(xml);
    return parser.parse();
  }
}

/**
 * Simple XML parser for FHIR resources
 * Parses XML string into {name, attributes, children} structure
 */
class FhirXmlParser {
  constructor(xml) {
    this.xml = xml;
    this.pos = 0;
  }

  parse() {
    this._skipDeclaration();
    this._skipWhitespace();
    return this._parseElement();
  }

  _skipDeclaration() {
    this._skipWhitespace();
    if (this.xml.substring(this.pos, this.pos + 5) === '<?xml') {
      const end = this.xml.indexOf('?>', this.pos);
      if (end !== -1) {
        this.pos = end + 2;
      }
    }
  }

  _skipWhitespace() {
    while (this.pos < this.xml.length && /\s/.test(this.xml[this.pos])) {
      this.pos++;
    }
  }

  _parseElement() {
    this._skipWhitespace();

    if (this.xml[this.pos] !== '<') {
      throw new Error(`Expected '<' at position ${this.pos}`);
    }
    this.pos++; // Skip '<'

    // Parse element name
    const nameEnd = this.xml.substring(this.pos).search(/[\s/>]/);
    const name = this.xml.substring(this.pos, this.pos + nameEnd);
    this.pos += nameEnd;

    // Parse attributes
    const attributes = {};
    this._skipWhitespace();

    while (this.pos < this.xml.length && this.xml[this.pos] !== '>' && this.xml[this.pos] !== '/') {
      const attr = this._parseAttribute();
      if (attr) {
        attributes[attr.name] = attr.value;
      }
      this._skipWhitespace();
    }

    const children = [];

    // Self-closing tag
    if (this.xml[this.pos] === '/') {
      this.pos += 2; // Skip '/>'
      return { name, attributes, children };
    }

    this.pos++; // Skip '>'

    // Parse children
    while (this.pos < this.xml.length) {
      this._skipWhitespace();

      if (this.xml.substring(this.pos, this.pos + 2) === '</') {
        // Closing tag
        const closeEnd = this.xml.indexOf('>', this.pos);
        this.pos = closeEnd + 1;
        break;
      }

      if (this.xml[this.pos] === '<') {
        // Check for comment
        if (this.xml.substring(this.pos, this.pos + 4) === '<!--') {
          const commentEnd = this.xml.indexOf('-->', this.pos);
          this.pos = commentEnd + 3;
          continue;
        }

        children.push(this._parseElement());
      } else {
        // Text content - skip for FHIR as values are in attributes
        const textEnd = this.xml.indexOf('<', this.pos);
        this.pos = textEnd;
      }
    }

    return { name, attributes, children };
  }

  _parseAttribute() {
    this._skipWhitespace();

    if (this.xml[this.pos] === '>' || this.xml[this.pos] === '/') {
      return null;
    }

    // Parse attribute name
    const eqPos = this.xml.indexOf('=', this.pos);
    const name = this.xml.substring(this.pos, eqPos).trim();
    this.pos = eqPos + 1;

    // Skip whitespace and opening quote
    this._skipWhitespace();
    const quote = this.xml[this.pos];
    this.pos++;

    // Parse attribute value
    const valueEnd = this.xml.indexOf(quote, this.pos);
    const value = FhirXmlBase.unescapeXml(this.xml.substring(this.pos, valueEnd));
    this.pos = valueEnd + 1;

    return { name, value };
  }
}

module.exports = { FhirXmlBase, FhirXmlParser };