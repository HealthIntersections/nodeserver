const { CodeSystemContentMode, CodeSystemFactoryProvider } = require('./cs-api');
const {
  SnomedStrings, SnomedWords, SnomedStems, SnomedReferences,
  SnomedDescriptions, SnomedDescriptionIndex, SnomedConceptList,
  SnomedRelationshipList, SnomedReferenceSetMembers, SnomedReferenceSetIndex,
  SnomedFileReader
} = require('../sct/structures');
const {
  SnomedExpressionServices, SnomedExpression, SnomedConcept,
  SnomedExpressionParser, NO_REFERENCE, SnomedServicesRenderOption
} = require('../sct/expressions');
const { DesignationUse } = require("../library/designations");
const { BaseCSServices } = require("./cs-base");
const { formatDateMMDDYYYY } = require("../../library/utilities");
const { ConceptMap } = require("../library/conceptmap");
const { ECLLexer, ECLParser, ECLNodeType, ECLTokenType } = require("../sct/ecl");
const { Issue } = require("../library/operation-outcome");
const { debugLog } = require("../operation-context");

// Context kinds matching Pascal enum
const SnomedProviderContextKind = {
  CODE: 0,
  EXPRESSION: 1
};

/**
 * SNOMED Expression Context - represents either a simple concept or complex expression
 */
class SnomedExpressionContext {
  constructor(source = '', expression = null) {
    this.source = source;
    this.expression = expression;
  }

  static fromReference(reference) {
    const expression = new SnomedExpression();
    expression.concepts.push(new SnomedConcept(reference));
    return new SnomedExpressionContext('', expression);
  }

  static fromCode(code, reference) {
    const expression = new SnomedExpression();
    const concept = new SnomedConcept(reference);
    concept.code = code;
    expression.concepts.push(concept);
    return new SnomedExpressionContext(code, expression);
  }

  static fromExpression(source, expression) {
    return new SnomedExpressionContext(source, expression);
  }

  isComplex() {
    return this.expression && this.expression.isComplex();
  }

  isSimple() {
    return this.expression && this.expression.isSimple();
  }

  getReference() {
    return this.expression && this.expression.concepts.length > 0
      ? this.expression.concepts[0].reference
      : NO_REFERENCE;
  }

  getCode() {
    if (this.source) return this.source;
    return this.expression && this.expression.concepts.length > 0
      ? this.expression.concepts[0].code
      : '';
  }
}

/**
 * Filter context for SNOMED filtering operations
 */
class SnomedFilterContext {
  constructor() {
    this.ndx = 0;
    this.cursor = 0;
    this.matches = [];
    this.members = [];
    this.descendants = [];
    this.expressions = undefined; // special use
  }
}

class SnomedPrep {
  constructor() {
    this.filters = [];
  }
}

/**
 * Core SNOMED services providing access to structures and expression processing
 */
class SnomedServices {
  constructor(sharedData) {
    // Core data structures
    this.strings = new SnomedStrings(sharedData.strings);
    this.words = new SnomedWords(sharedData.words);
    this.stems = new SnomedStems(sharedData.stems);
    this.refs = new SnomedReferences(sharedData.refs);
    this.descriptions = new SnomedDescriptions(sharedData.desc);
    this.descriptionIndex = new SnomedDescriptionIndex(sharedData.descRef);
    this.concepts = new SnomedConceptList(sharedData.concept);
    this.relationships = new SnomedRelationshipList(sharedData.rel);
    this.refSetIndex = new SnomedReferenceSetIndex(sharedData.refSetIndex, sharedData.hasLangs);
    this.refSetMembers = new SnomedReferenceSetMembers(sharedData.refSetMembers);

    // Metadata
    this.versionUri = sharedData.versionUri;
    this.versionDate = sharedData.versionDate;
    this.edition = sharedData.edition;
    this.version = sharedData.version;
    this.totalCount = this.concepts.count();

    // Indexes and roots
    this.isAIndex = sharedData.isAIndex;
    this.activeRoots = sharedData.activeRoots;
    this.inactiveRoots = sharedData.inactiveRoots;
    this.defaultLanguage = sharedData.defaultLanguage;
    this.isTesting = sharedData.isTesting;

    // Expression services
    this.expressionServices = new SnomedExpressionServices({
      strings: this.strings,
      words: this.words,
      stems: this.stems,
      refs: this.refs,
      descriptions: this.descriptions,
      descriptionIndex: this.descriptionIndex,
      concepts: this.concepts,
      relationships: this.relationships,
      refSetMembers: this.refSetMembers,
      refSetIndex: this.refSetIndex
    }, this.isAIndex);

  }

  close() {
    // Cleanup if needed
  }

  getSystemUri() {
    return 'http://snomed.info/sct';
  }

  getVersion() {
    return this.versionUri;
  }

  getDescription() {
    return `SNOMED CT ${getEditionName(this.edition)}`;
  }

  name() {
    return `SCT ${getEditionCode(this.edition)}`;
  }

  stringToIdOrZero(str) {
    try {
      if (!str) return 0n;
      return BigInt(str);
    } catch {
      return 0n;
    }
  }

  stringToId(str) {
    return BigInt(str);
  }

  getConceptId(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      return concept.identity.toString();
    } catch (error) {
      return reference.toString();
    }
  }

  conceptExists(conceptId) {
    const id = this.stringToIdOrZero(conceptId);
    if (id === 0n) return false;

    const result = this.concepts.findConcept(id);
    return result.found;
  }

  isActive(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      // Check status flags - active concepts typically have status 0
      return (concept.flags & 0x0F) === 0;
    } catch (error) {
      return false;
    }
  }

  isPrimitive(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      // Check primitive flag
      return (concept.flags & 0x10) !== 0;
    } catch (error) {
      return true; // Assume primitive if can't read
    }
  }

  subsumes(parentRef, childRef) {
    if (parentRef === childRef) {
      return true;
    }

    try {
      // Get the closure (all descendants) for parent concept
      const closureRef = this.concepts.getAllDesc(parentRef);

      if (closureRef === 0 || closureRef === 0xFFFFFFFF) {
        return false;
      }

      const descendants = this.refs.getReferences(closureRef);
      return descendants && descendants.includes(childRef);
    } catch (error) {
      return false;
    }
  }

  getDisplayName(reference = 0) {
    try {
      const concept = this.concepts.getConcept(reference);
      const descriptionsRef = concept.descriptions;

      if (descriptionsRef === 0) {
        return '';
      }

      const descriptionIndices = this.refs.getReferences(descriptionsRef);

      // Look for preferred term, then any active description
      for (const descIndex of descriptionIndices) {
        const description = this.descriptions.getDescription(descIndex);
        if (description.active) {
          const term = this.strings.getEntry(description.iDesc);
          return term.trim();
        }
      }

      return '';
    } catch (error) {
      return '';
    }
  }

  getConceptDescendants(reference) {
    try {
      const allDescRef = this.concepts.getAllDesc(reference);
      if (allDescRef === 0 || allDescRef === 0xFFFFFFFF) {
        return [];
      }
      return this.refs.getReferences(allDescRef) || [];
    } catch (error) {
      return [];
    }
  }

  getConceptChildren(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      const inboundsRef = concept.inbounds;

      if (inboundsRef === 0) return [];

      const inbounds = this.refs.getReferences(inboundsRef);
      const children = [];

      for (const relIndex of inbounds) {
        const rel = this.relationships.getRelationship(relIndex);
        if (rel.active && rel.relType === this.isAIndex && rel.group === 0) {
          children.push(rel.source);
        }
      }

      return children;
    } catch (error) {
      return [];
    }
  }

  getConceptParents(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      const parentsRef = concept.parents;

      if (parentsRef === 0) return [];

      return this.refs.getReferences(parentsRef) || [];
    } catch (error) {
      return [];
    }
  }

  getConceptRelationships(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      const relRef = concept.outbounds;

      if (relRef === 0) return [];

      return this.refs.getReferences(relRef) || [];
    } catch (error) {
      return [];
    }
  }

  getConceptRefSet(conceptIndex, byName = false) {
    for (let i = 0; i < this.refSetIndex.count(); i++) {
      const refSet = this.refSetIndex.getReferenceSet(i);
      if (refSet.definition === conceptIndex) {
        return byName ? refSet.membersByName : refSet.membersByRef;
      }
    }
    return 0;
  }

  // Filter support methods
  filterEquals(id) {
    const result = new SnomedFilterContext();
    const conceptResult = this.concepts.findConcept(id);

    if (!conceptResult.found) {
      throw new Error(`The SNOMED CT Concept ${id} is not known`);
    }

    result.descendants = [conceptResult.index];
    return result;
  }

  filterIsA(id, includeBase = true) {
    const result = new SnomedFilterContext();
    const conceptResult = this.concepts.findConcept(id);

    if (!conceptResult.found) {
      throw new Error(`The SNOMED CT Concept ${id} is not known`);
    }

    const descendants = this.getConceptDescendants(conceptResult.index);

    if (includeBase) {
      result.descendants = [conceptResult.index, ...descendants];
    } else {
      result.descendants = descendants;
    }

    return result;
  }

  filterChildOf(id = true) {
    const result = new SnomedFilterContext();
    const conceptResult = this.concepts.findConcept(id);

    if (!conceptResult.found) {
      throw new Error(`The SNOMED CT Concept ${id} is not known`);
    }

    const descendants = this.getConceptChildren(conceptResult.index);

    result.descendants = descendants;

    return result;
  }


  filterGeneralizes(id = true) {
    const result = new SnomedFilterContext();
    const conceptResult = this.concepts.findConcept(id);

    if (!conceptResult.found) {
      throw new Error(`The SNOMED CT Concept ${id} is not known`);
    }

    let ancestors = new Set();
    let parents = this.getConceptParents(conceptResult.index);
    let isNew = true;
    while (isNew) {
      isNew = false;
      let np = [];
      for (let parent of parents) {
        if (!ancestors.has(parent)) {
          isNew = true;
          ancestors.add(parent);
          np.push(...this.getConceptParents(parent));
        }
      }
      parents = np;
    }

    result.descendants = [...ancestors];

    return result;
  }


  filterIn(idList) {
    const result = new SnomedFilterContext();
    let members = [];
    for (let id of idList.split(',')) {
      const conceptResult = this.concepts.findConcept(id);

      if (!conceptResult.found) {
        throw new Error(`The SNOMED CT Concept ${id} is not known`);
      }

      const refSetIndex = this.getConceptRefSet(conceptResult.index, false);
      if (refSetIndex === 0) {
        members.push(conceptResult.index);
      } else {
        members.push(...this.refSetMembers.getMembers(refSetIndex));
      }
    }
    result.members = members;
    return result;
  }

  filterInactive(state) {
    const result = new SnomedFilterContext();
    result.inactive = state;
    return result;
  }

  filterModuleId(id) {
    const result = new SnomedFilterContext();
    let concept = this.concepts.findConcept(id);
    result.moduleId = concept.index;
    return result;
  }

  filterByProperty(prop, value) {
    const result = new SnomedFilterContext();
    let p = this.concepts.findConcept(prop);
    let v = this.concepts.findConcept(value);
    result.propProp = p.index;
    result.propValue = v.index;
    return result;

  }

  /**
   * Supported ECL subset:
   *   Plain concept ref      404684003
   *   << (descendant-or-self-of)
   *   <! (strict descendant-of)
   *   <  (child-of)
   *   >> (ancestor-or-self-of)
   *   >! (strict ancestor-of)
   *   >  (parent-of)
   *   ^  (member-of refset)      — refset must be a plain concept ID
   *   *  (wildcard)
   *   AND / OR / MINUS compound expressions
   *
   * Everything else (refinements, dotted expressions, cardinality,
   * reverse attributes, numeric/string comparisons) throws an informative error.
   */

  /**
   * Parse an ECL expression string and return a SnomedFilterContext whose
   * `descendants` array contains the resolved concept indexes.
   *
   * Throws an Error for syntax errors, unknown concepts, or unsupported features.
   *
   * @param {string} eclExpression
   * @returns {SnomedFilterContext}
   */
  filterECL = function (eclExpression, forIteration, opContext) {
    let ast;
    try {
      const tokens = new ECLLexer(eclExpression).tokenize();
      ast = new ECLParser(tokens).parse();
    } catch (err) {
      debugLog(err);
      throw new Issue('error', 'invalid', null, 'INVALID_ECL', opContext.i18n.translate('INVALID_ECL', opContext.langs, [eclExpression, err.message]), 'vs-invalid').handleAsOO(400);
    }
    let result;
    try {
      result = this._evalECLNode(ast);
    } catch (err) {
      debugLog(err);
      throw new Issue('error', 'invalid', null, 'UNSUPPORTED_ECL', opContext.i18n.translate('UNSUPPORTED_ECL', opContext.langs, [eclExpression, err.message]), 'vs-invalid').handleAsOO(400);
    }
    // Wildcard + iteration: the `eclWildcard` flag is only consulted by the
    // per-concept membership checks (filterCheck/filterLocate). For an $expand
    // we actually need the full concept list, otherwise filterSize returns 0
    // and the iteration yields nothing. Materialise active concepts now.
    if (forIteration && result.eclWildcard && (!result.descendants || result.descendants.length === 0)) {
      result.descendants = this._eclEnumerateActiveConcepts();
      delete result.eclWildcard;
    }
    return result;
  };

  /**
   * Return every active concept's index. Used to materialise wildcard results
   * when the filter needs to be iterated over (e.g. $expand).
   * @returns {number[]}
   */
  _eclEnumerateActiveConcepts = function () {
    const all = [];
    const n = this.concepts.count();
    for (let i = 0; i < n; i++) {
      const concept = this.concepts.getConceptByCount(i);
      if ((concept.flags & 0x0F) === 0) { // active
        all.push(concept.index);
      }
    }
    return all;
  };

  /**
   * Recursive ECL AST evaluator.
   * @param {object} node
   * @returns {SnomedFilterContext}
   */
  _evalECLNode = function (node) {
    if (!node) {
      throw new Error('ECL evaluation error: null AST node');
    }

    switch (node.type) {

      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT:
        return this._evalSubExpression(node);

      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT: {
        const left = this._evalECLNode(node.left);
        const right = this._evalECLNode(node.right);
        switch (node.operator) {
          case ECLNodeType.CONJUNCTION:
            return this._eclIntersect(left, right);
          case ECLNodeType.DISJUNCTION:
            return this._eclUnion(left, right);
          case ECLNodeType.EXCLUSION:
            return this._eclMinus(left, right);
          default:
            throw new Error(`Unsupported ECL compound operator: ${node.operator}`);
        }
      }

      case ECLNodeType.REFINED_EXPRESSION_CONSTRAINT:
        return this._evalRefined(node);

      case ECLNodeType.DOTTED_EXPRESSION_CONSTRAINT:
        return this._evalDotted(node);

      default:
        // Could be a bare concept reference or wildcard passed in directly
        // (e.g. when a parenthesised expression resolves to one of these).
        if (node.type === ECLNodeType.CONCEPT_REFERENCE ||
          node.type === ECLNodeType.WILDCARD ||
          node.type === ECLNodeType.MEMBER_OF) {
          // Wrap it as if it came from a no-operator SubExpressionConstraint
          return this._evalSubExpression({ type: ECLNodeType.SUB_EXPRESSION_CONSTRAINT, operator: null, focus: node });
        }
        throw new Error(`Unsupported ECL node type: ${node.type}`);
    }
  };

  /**
   * Evaluate a SUB_EXPRESSION_CONSTRAINT node, which combines an optional
   * hierarchy operator with a focus (concept ref, wildcard, or member-of).
   * @param {object} node
   * @returns {SnomedFilterContext}
   */
  _evalSubExpression = function (node) {
    const operator = node.operator; // an ECLTokenType string, or null
    const focus = node.focus;

    // Wildcard
    if (focus.type === ECLNodeType.WILDCARD) {
      if (operator) {
        throw new Error('ECL hierarchy operators combined with wildcard (*) are not supported');
      }
      return this._eclWildcard();
    }

    // Member-of (^)
    if (focus.type === ECLNodeType.MEMBER_OF) {
      if (operator) {
        throw new Error('ECL hierarchy operators combined with ^ (member-of) are not yet supported');
      }
      return this._evalMemberOf(focus);
    }

    // Plain concept reference
    if (focus.type === ECLNodeType.CONCEPT_REFERENCE) {
      return this._evalConceptWithOperator(focus.conceptId, operator);
    }

    // Parenthesised sub-expression: focus is itself a full constraint node
    return this._evalECLNode(focus);
  };

  /**
   * Resolve a concept ID + hierarchy operator.
   * @param {string} conceptId
   * @param {string|null} operator  ECLTokenType constant
   * @returns {SnomedFilterContext}
   */
  _evalConceptWithOperator = function (conceptId, operator) {
    switch (operator) {
      case null:
      case undefined:
        return this.filterEquals(conceptId);

      // ── Descendants ────────────────────────────────────────────────────────
      case ECLTokenType.DESCENDANT_OR_SELF_OF: { // <<   self + all transitive descendants
        return this.filterIsA(conceptId, true);
      }

      case ECLTokenType.DESCENDANT_OF: {         // <    all transitive descendants, no self
        return this.filterIsA(conceptId, false);
      }

      case ECLTokenType.CHILD_OR_SELF_OF: {      // <<!  self + direct children only
        const conceptResult = this.concepts.findConcept(conceptId);
        if (!conceptResult.found) {
          throw new Error(`The SNOMED CT Concept ${conceptId} is not known`);
        }
        const result = new SnomedFilterContext();
        const children = this.getConceptChildren(conceptResult.index);
        result.descendants = [conceptResult.index, ...children];
        return result;
      }

      case ECLTokenType.CHILD_OF: {              // <!   direct children only
        return this.filterChildOf(conceptId);
      }

      // ── Ancestors ──────────────────────────────────────────────────────────
      case ECLTokenType.ANCESTOR_OR_SELF_OF: {   // >>   self + all transitive ancestors
        const result = this.filterGeneralizes(conceptId);
        const self = this.concepts.findConcept(conceptId);
        if (self.found && !result.descendants.includes(self.index)) {
          result.descendants.push(self.index);
        }
        return result;
      }

      case ECLTokenType.ANCESTOR_OF: {           // >    all transitive ancestors, no self
        return this.filterGeneralizes(conceptId);
      }

      case ECLTokenType.PARENT_OR_SELF_OF: {     // >>!  self + direct parents only
        const conceptResult = this.concepts.findConcept(conceptId);
        if (!conceptResult.found) {
          throw new Error(`The SNOMED CT Concept ${conceptId} is not known`);
        }
        const result = new SnomedFilterContext();
        const parents = this.getConceptParents(conceptResult.index);
        result.descendants = [conceptResult.index, ...parents];
        return result;
      }

      case ECLTokenType.PARENT_OF: {             // >!   direct parents only
        const conceptResult = this.concepts.findConcept(conceptId);
        if (!conceptResult.found) {
          throw new Error(`The SNOMED CT Concept ${conceptId} is not known`);
        }
        const result = new SnomedFilterContext();
        result.descendants = this.getConceptParents(conceptResult.index);
        return result;
      }

      default:
        throw new Error(`Unsupported ECL hierarchy operator: ${operator}`);
    }
  };

  /**
   * Evaluate a MEMBER_OF node.  Only plain concept-reference refsets are
   * supported; complex expressions inside ^ are not yet supported.
   * @param {object} memberOfNode
   * @returns {SnomedFilterContext}
   */
  _evalMemberOf = function (memberOfNode) {
    const refSet = memberOfNode.refSet;
    if (refSet.type !== ECLNodeType.CONCEPT_REFERENCE) {
      throw new Error('ECL ^ (member-of) with a non-concept-reference refset is not yet supported');
    }
    // filterIn accepts a comma-separated string; a single ID works fine
    return this.filterIn(refSet.conceptId);
  };

  /**
   * Wildcard — all active concepts.  The eclWildcard flag tells filterCheck /
   * filterLocate to accept every active concept without enumeration.
   * @returns {SnomedFilterContext}
   */
  _eclWildcard = function () {
    const result = new SnomedFilterContext();
    result.eclWildcard = true;
    return result;
  };

  // ── Dotted expressions ───────────────────────────────────────────────────────

  /**
   * Evaluate a dotted expression: `<baseConstraint> . attrA . attrB`.
   * For each chained attribute, replaces the current set with the set of
   * active relationship targets whose `relType` matches the attribute.
   * Only plain concept-reference attribute names are supported.
   * @param {object} node
   * @returns {SnomedFilterContext}
   */
  _evalDotted = function (node) {
    let current = this._eclResolveSet(this._evalECLNode(node.base));

    for (const attr of node.attributes || []) {
      if (attr.type !== ECLNodeType.CONCEPT_REFERENCE) {
        throw new Error('ECL dotted expressions only support plain concept-reference attribute names');
      }
      const attrResult = this.concepts.findConcept(attr.conceptId);
      if (!attrResult.found) {
        throw new Error(`The SNOMED CT Concept ${attr.conceptId} is not known`);
      }
      const attrTypeIdx = attrResult.index;

      const next = new Set();
      for (const conceptIdx of current) {
        const relIdxs = this.getConceptRelationships(conceptIdx);
        for (const relIdx of relIdxs) {
          const rel = this.relationships.getRelationship(relIdx);
          if (rel.active && rel.relType === attrTypeIdx) {
            next.add(rel.target);
          }
        }
      }
      current = [...next];
    }

    const result = new SnomedFilterContext();
    result.descendants = current;
    return result;
  };

  // ── Refinements ──────────────────────────────────────────────────────────────

  /**
   * Evaluate a refined expression: `<baseConstraint> : <refinement>`.
   * Supported refinement shapes:
   *   - ATTRIBUTE            attr = valueExpr
   *   - ATTRIBUTE_SET        attr1 = v1, attr2 = v2 (conjunction)
   *   - ATTRIBUTE_GROUP      { attr1 = v1, attr2 = v2 } (same relationship group)
   * Reverse attributes, cardinality, `!=`, and non-concept attribute names
   * throw informative errors.
   * @param {object} node
   * @returns {SnomedFilterContext}
   */
  _evalRefined = function (node) {
    const baseSet = this._eclResolveSet(this._evalECLNode(node.base));
    const matching = [];
    for (const conceptIdx of baseSet) {
      if (this._refinementMatches(conceptIdx, node.refinement)) {
        matching.push(conceptIdx);
      }
    }
    const result = new SnomedFilterContext();
    result.descendants = matching;
    return result;
  };

  /**
   * Check whether a single concept satisfies a refinement node (ATTRIBUTE,
   * ATTRIBUTE_SET, or ATTRIBUTE_GROUP).
   * @param {number} conceptIdx
   * @param {object} refinement
   * @returns {boolean}
   */
  _refinementMatches = function (conceptIdx, refinement) {
    switch (refinement.type) {
      case ECLNodeType.ATTRIBUTE:
        return this._attributeMatches(conceptIdx, refinement, null);
      case ECLNodeType.ATTRIBUTE_SET:
        for (const a of refinement.attributes) {
          if (!this._refinementMatches(conceptIdx, a)) return false;
        }
        return true;
      case ECLNodeType.ATTRIBUTE_GROUP:
        return this._attributeGroupMatches(conceptIdx, refinement);
      default:
        throw new Error(`Unsupported refinement node type: ${refinement.type}`);
    }
  };

  /**
   * Check whether a concept has at least one active relationship whose
   * `relType` matches the attribute name and whose `target` is in the value
   * expression's result set. If `groupFilter` is not null, the relationship
   * must also have that exact `group` number (used by group matching).
   * @param {number} conceptIdx
   * @param {object} attr
   * @param {number|null} groupFilter
   * @returns {boolean}
   */
  _attributeMatches = function (conceptIdx, attr, groupFilter) {
    if (attr.reverse) {
      throw new Error('ECL reverse attributes (R) are not yet supported');
    }
    if (!attr.comparison) {
      throw new Error('ECL attribute without a comparison is not supported');
    }
    if (attr.comparison.type !== ECLNodeType.EXPRESSION_COMPARISON) {
      throw new Error(`ECL ${attr.comparison.type} in refinements is not yet supported`);
    }
    if (attr.comparison.operator !== ECLTokenType.EQUALS) {
      throw new Error('ECL != in refinements is not yet supported');
    }
    if (attr.name.type !== ECLNodeType.CONCEPT_REFERENCE) {
      throw new Error('ECL refinements only support plain concept-reference attribute names');
    }

    const count = this._countAttributeMatches(conceptIdx, attr, groupFilter);

    if (attr.cardinality) {
      return this._cardinalityAccepts(attr.cardinality, count);
    }
    return count >= 1;
  };

  /**
   * Count the number of active relationships on the concept whose `relType`
   * matches the attribute name and whose `target` is in the value expression's
   * result set. Honours an optional group filter.
   * @param {number} conceptIdx
   * @param {object} attr
   * @param {number|null} groupFilter
   * @returns {number}
   */
  _countAttributeMatches = function (conceptIdx, attr, groupFilter) {
    const attrResult = this.concepts.findConcept(attr.name.conceptId);
    if (!attrResult.found) {
      throw new Error(`The SNOMED CT Concept ${attr.name.conceptId} is not known`);
    }
    const attrTypeIdx = attrResult.index;

    const valueSet = new Set(this._eclResolveSet(this._evalECLNode(attr.comparison.value)));

    const relIdxs = this.getConceptRelationships(conceptIdx);
    let count = 0;
    for (const relIdx of relIdxs) {
      const rel = this.relationships.getRelationship(relIdx);
      if (!rel.active) continue;
      if (rel.relType !== attrTypeIdx) continue;
      if (groupFilter !== null && rel.group !== groupFilter) continue;
      if (valueSet.has(rel.target)) count++;
    }
    return count;
  };

  /**
   * Test a count against a parsed cardinality `{min, max}` where `max` is
   * either an integer or the string `'*'` (unbounded).
   * @param {{min: number, max: number|'*'}} cardinality
   * @param {number} count
   * @returns {boolean}
   */
  _cardinalityAccepts = function (cardinality, count) {
    const { min, max } = cardinality;
    if (min != null && count < min) return false;
    if (max != null && max !== '*' && count > max) return false;
    return true;
  };

  /**
   * Check whether any single relationship group on the concept satisfies all
   * attributes in an ATTRIBUTE_GROUP. Ungrouped relationships (group === 0)
   * are not eligible — an attribute group must match within a real group.
   *
   * If the group itself carries cardinality (e.g. `[1..1] {…}`), the match
   * requires the count of matching groups to fall within the specified range.
   * @param {number} conceptIdx
   * @param {object} group
   * @returns {boolean}
   */
  _attributeGroupMatches = function (conceptIdx, group) {
    const relIdxs = this.getConceptRelationships(conceptIdx);
    const groupNumbers = new Set();
    for (const relIdx of relIdxs) {
      const rel = this.relationships.getRelationship(relIdx);
      if (rel.active && rel.group > 0) {
        groupNumbers.add(rel.group);
      }
    }

    let matchingGroupCount = 0;
    for (const g of groupNumbers) {
      let allMatch = true;
      for (const attr of group.attributes) {
        if (!this._attributeMatches(conceptIdx, attr, g)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        matchingGroupCount++;
        // With no cardinality, short-circuit on the first matching group.
        if (!group.cardinality) return true;
      }
    }

    if (group.cardinality) {
      return this._cardinalityAccepts(group.cardinality, matchingGroupCount);
    }
    return false;
  };

  // ── Set operation helpers ────────────────────────────────────────────────────

  /**
   * Flatten a SnomedFilterContext to a plain array of concept indexes,
   * handling the three different storage slots used by the existing filters.
   * @param {SnomedFilterContext} ctx
   * @returns {number[]}
   */
  _eclToIndexArray = function (ctx) {
    if (ctx.descendants && ctx.descendants.length > 0) return ctx.descendants;
    if (ctx.members && ctx.members.length > 0) return ctx.members.map(m => m.ref);
    if (ctx.matches && ctx.matches.length > 0) return ctx.matches.map(m => m.index);
    return [];
  };

  /**
   * Like _eclToIndexArray, but if the context is a bare wildcard (no
   * descendants populated) it materialises the full active-concept list
   * via _eclEnumerateActiveConcepts. Used by dotted/refined evaluation,
   * which need an explicit concept set to iterate over.
   * @param {SnomedFilterContext} ctx
   * @returns {number[]}
   */
  _eclResolveSet = function (ctx) {
    if (ctx.eclWildcard && (!ctx.descendants || ctx.descendants.length === 0)) {
      return this._eclEnumerateActiveConcepts();
    }
    return this._eclToIndexArray(ctx);
  };

  /**
   * AND: concepts present in both sets.
   */
  _eclIntersect = function (left, right) {
    if (left.eclWildcard) return right;
    if (right.eclWildcard) return left;
    const leftSet = new Set(this._eclToIndexArray(left));
    const result = new SnomedFilterContext();
    result.descendants = this._eclToIndexArray(right).filter(idx => leftSet.has(idx));
    return result;
  };

  /**
   * OR: concepts present in either set.
   */
  _eclUnion = function (left, right) {
    if (left.eclWildcard || right.eclWildcard) return this._eclWildcard();
    const combined = new Set([
      ...this._eclToIndexArray(left),
      ...this._eclToIndexArray(right)
    ]);
    const result = new SnomedFilterContext();
    result.descendants = [...combined];
    return result;
  };

  /**
   * MINUS: concepts in left that are not in right.
   */
  _eclMinus = function (left, right) {
    const result = new SnomedFilterContext();

    if (right.eclWildcard) {
      result.descendants = [];
      return result;
    }

    const rightSet = new Set(this._eclToIndexArray(right));

    if (left.eclWildcard) {
      // Enumerate all active concepts minus the right set
      const all = [];
      for (let i = 0; i < this.concepts.count(); i++) {
        const concept = this.concepts.getConceptByCount(i);
        if (this.isActive(concept.index) && !rightSet.has(concept.index)) {
          all.push(concept.index);
        }
      }
      result.descendants = all;
      return result;
    }

    result.descendants = this._eclToIndexArray(left).filter(idx => !rightSet.has(idx));
    return result;
  };


  searchFilter(searchText, includeInactive = false, exactMatch = false) {
    const result = new SnomedFilterContext();

    // Simplified search - in full implementation would use stemming and word indexes
    const searchTerms = searchText.filter.toLowerCase().split(/\s+/);
    const matches = [];

    // Search through all concepts
    for (let i = 0; i < this.concepts.count(); i++) {
      const conceptIndex = i * this.concepts.constructor.CONCEPT_SIZE;

      try {
        const concept = this.concepts.getConcept(conceptIndex);
        if (!includeInactive && !this.isActive(conceptIndex)) {
          continue;
        }

        const descriptionsRef = concept.descriptions;
        if (descriptionsRef === 0) continue;

        const descriptionIndices = this.refs.getReferences(descriptionsRef);
        let matchFound = false;
        let priority = 0;

        for (const descIndex of descriptionIndices) {
          const description = this.descriptions.getDescription(descIndex);
          if (description.active) {
            const term = this.strings.getEntry(description.iDesc).toLowerCase();

            if (exactMatch) {
              // All search terms must be present
              matchFound = searchTerms.every(searchTerm => term.includes(searchTerm));
            } else {
              // Any search term can match
              matchFound = searchTerms.some(searchTerm => term.includes(searchTerm));
            }

            if (matchFound) {
              // Calculate priority based on match quality
              if (term === searchText.filter.toLowerCase()) {
                priority = 100; // Exact match
              } else if (term.startsWith(searchText.filter.toLowerCase())) {
                priority = 50; // Prefix match
              } else {
                priority = 10; // Contains match
              }
              break;
            }
          }
        }

        if (matchFound) {
          matches.push({
            index: conceptIndex,
            term: concept.identity,
            priority: priority
          });
        }
      } catch (error) {
        // Skip problematic concepts
        continue;
      }
    }

    // Sort by priority (descending)
    matches.sort((a, b) => b.priority - a.priority);

    result.matches = matches;
    return result;
  }
}

/**
 * SNOMED CT Code System Provider
 */
class SnomedProvider extends BaseCSServices {
  constructor(opContext, supplements, snomedServices) {
    super(opContext, supplements);
    this.sct = snomedServices;
  }

  // Metadata methods
  system() {
    return this.sct.getSystemUri();
  }

  version() {
    return this.sct.getVersion();
  }


  /**
   * @param {string} checkVersion - first version
   * @param {string} actualVersion - second version
   * @returns {boolean} True if actualVersion is more detailed than checkVersion (for SCT)
   */
  versionIsMoreDetailed(checkVersion, actualVersion) {
    return actualVersion && actualVersion.startsWith(checkVersion);
  }

  description() {
    return this.sct.getDescription();
  }

  totalCount() {
    return this.sct.totalCount;
  }

  contentMode() {
    return CodeSystemContentMode.Complete;
  }

  hasParents() {
    return true;
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);

    // Check supplements first
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }

    // SNOMED has displays for English and other languages
    return langs.isEnglishOrNothing();
  }

  // Core concept methods
  async code(context) {

    const ctxt = await this.#ensureContext(context);

    if (!ctxt) return null;

    if (ctxt.isComplex()) {
      return this.sct.expressionServices.renderExpression(ctxt.expression, SnomedServicesRenderOption.Minimal);
    } else {
      return ctxt.getCode() || this.sct.getConceptId(ctxt.getReference());
    }
  }

  async display(context) {

    const ctxt = await this.#ensureContext(context);

    if (!ctxt) return null;

    // Check supplements first
    let disp = this._displayFromSupplements(ctxt.getCode());
    if (disp) return disp;

    if (ctxt.isComplex()) {
      return this.sct.expressionServices.renderExpression(ctxt.expression, SnomedServicesRenderOption.FillMissing);
    } else {
      return this.sct.getDisplayName(ctxt.getReference(), this.sct.defaultLanguage);
    }
  }

  async definition(context) {
    await this.#ensureContext(context);
    return null; // SNOMED doesn't provide definitions in this sense
  }

  async isAbstract(context) {
    await this.#ensureContext(context);
    return false; // SNOMED concepts are not abstract
  }

  async isInactive(context) {

    const ctxt = await this.#ensureContext(context);

    if (!ctxt || ctxt.isComplex()) return false;

    return !this.sct.isActive(ctxt.getReference());
  }

  async isDeprecated(context) {
    await this.#ensureContext(context);

    return false; // Handle via status if needed
  }

  async getStatus(context) {

    const ctxt = await this.#ensureContext(context);

    if (!ctxt || ctxt.isComplex()) return null;

    return this.sct.isActive(ctxt.getReference()) ? 'active' : 'inactive';
  }

  async designations(context, displays) {

    const ctxt = await this.#ensureContext(context);

    if (ctxt) {


      if (ctxt.isComplex()) {
        // For complex expressions, just add the display
        const display = await this.display(context);
        if (display) {
          displays.addDesignation(true, 'active', 'en-US', DesignationUse.PREFERRED, display);
        }
      } else {
        // Get all designations for the concept
        try {
          const concept = this.sct.concepts.getConcept(ctxt.getReference());
          const descriptionsRef = concept.descriptions;

          if (descriptionsRef !== 0) {
            const descriptionIndices = this.sct.refs.getReferences(descriptionsRef);

            for (const descIndex of descriptionIndices) {
              const description = this.sct.descriptions.getDescription(descIndex);
              const term = this.sct.strings.getEntry(description.iDesc).trim();
              const langCode = this.getLanguageCode(description.lang);
              const kind = this.sct.concepts.getConcept(description.kind);
              const kid = String(kind.identity);
              const kdesc = this.sct.getDisplayName(description.kind);
              let use = { system: 'http://snomed.info/sct', code: kid, display: kdesc };

              displays.addDesignation(false, description.active ? 'active' : 'inactive', langCode, use, term);
            }
          }
        } catch (error) {
          // Add basic designation if we can't read detailed descriptions
          const display = this.sct.getDisplayName(ctxt.getReference());
          if (display) {
            displays.addDesignation(true, 'active', 'en-US', null, display);
          }
        }

        // Add supplement designations
        this._listSupplementDesignations(ctxt.getCode(), displays);
      }
    }
  }

  getLanguageCode(langIndex) {
    const languageMap = {
      1: 'en',
      2: 'fr',
      3: 'nl',
      4: 'es',
      5: 'sv',
      6: 'da',
      7: 'de',
      8: 'it',
      9: 'cs'
    };
    return languageMap[langIndex] || 'en';
  }

  // Lookup methods
  async locate(code) {
    if (!code) return { context: null, message: 'Empty code' };

    const conceptId = this.sct.stringToIdOrZero(code);

    if (conceptId === 0n) {
      // Try parsing as expression
      try {
        const expression = new SnomedExpressionParser().parse(code);
        this.sct.expressionServices.checkExpression(expression);
        return {
          context: SnomedExpressionContext.fromExpression(code, expression),
          message: null
        };
      } catch (error) {
        return {
          context: null,
          message: Number.isInteger(code) ? undefined : `Not a valid expression: ${error.message}`
        };
      }
    } else {
      const result = this.sct.concepts.findConcept(conceptId);
      if (result.found) {
        return {
          context: SnomedExpressionContext.fromCode(code, result.index),
          message: null
        };
      } else {
        return {
          context: null,
          message: undefined
        };
      }
    }
  }

  async incompleteValidationMessage(context) {

    const ctxt = await this.#ensureContext(context);

    if (!ctxt) return null;

    if (ctxt.isComplex()) {
      return "The expression is grammatically correct and the concepts are valid, but the expression has not been checked against the SNOMED CT concept model (MRCM)";
    } else {
      return null;
    }
  }

  async locateIsA(code, parent, disallowParent = false) {


    const childId = this.sct.stringToIdOrZero(code);
    const parentId = this.sct.stringToIdOrZero(parent);

    if (childId === 0n || parentId === 0n) {
      return { context: null, message: 'Invalid concept ID' };
    }

    const childResult = this.sct.concepts.findConcept(childId);
    const parentResult = this.sct.concepts.findConcept(parentId);

    if (!childResult.found || !parentResult.found) {
      return { context: null, message: 'Concept not found' };
    }

    const subsumes = this.sct.subsumes(parentResult.index, childResult.index);
    const allowedByParent = !disallowParent || (childResult.index !== parentResult.index);

    if (subsumes && allowedByParent) {
      return {
        context: SnomedExpressionContext.fromCode(code, childResult.index),
        message: null
      };
    } else {
      return { context: null, message: 'Concept is not subsumed by parent' };
    }
  }

  // Iterator methods
  async iterator(context) {


    if (!context) {
      // Iterate all active root concepts
      return {
        context: null,
        keys: this.sct.activeRoots.slice(),
        current: 0,
        total: this.sct.activeRoots.length
      };
    } else {
      const ctxt = await this.#ensureContext(context);
      if (!ctxt || ctxt.isComplex()) {
        return { context: ctxt, keys: [], current: 0, total: 0 };
      }

      // Get children of this concept
      const children = this.sct.getConceptChildren(ctxt.getReference());
      return {
        context: ctxt,
        keys: children,
        current: 0,
        total: children.length
      };
    }
  }

  async nextContext(iteratorContext) {
    if (iteratorContext.current >= iteratorContext.total) {
      return null;
    }

    const key = iteratorContext.keys[iteratorContext.current];
    iteratorContext.current++;

    return SnomedExpressionContext.fromReference(key);
  }

  async extendLookup(context, props, params) {
    const ctxt = await this.#ensureContext(context);
    if (ctxt) {
      if (!(ctxt instanceof SnomedExpressionContext) || ctxt.expression?.concepts.length == 1) {
        const time = this.sct.concepts.getConcept(ctxt.getReference()).effectiveTime;
        const pascalEpoch = new Date(1899, 11, 30);
        const date = new Date(pascalEpoch.getTime() + time * 86400000);
        const dateStr = date.toISOString().slice(0, 10);
        this._addDateTimeProperty(params, 'property', 'effectiveTime', dateStr);


        const parents = this.sct.getConceptParents(ctxt.getReference());
        for (let parentRef of parents) {
          const code = this.sct.getConceptId(parentRef);
          const description = this.sct.getDisplayName(parentRef);
          this._addCodeProperty(params, 'property', 'parent', code, null, description);
        }

        const children = this.sct.getConceptChildren(ctxt.getReference());
        for (let childRef of children) {
          const code = this.sct.getConceptId(childRef);
          const description = this.sct.getDisplayName(childRef);
          this._addCodeProperty(params, 'property', 'child', code, null, description);
        }

        const moduleId = this.sct.concepts.getModuleId(ctxt.getReference());
        if (moduleId) {
          const code = this.sct.getConceptId(moduleId);
          this._addCodeProperty(params, 'property', 'module', code, null, this.sct.getDisplayName(moduleId));
        }

        const relationships = this.sct.getConceptRelationships(ctxt.getReference());
        let set = new Set();
        for (let relationshipRef of relationships) {
          const relationship = this.sct.relationships.getRelationship(relationshipRef);
          const relType = this.sct.getConceptId(relationship.relType);
          if (relType != '116680003') {
            const relTypeD = this.sct.getDisplayName(relationship.relType);
            const code = this.sct.getConceptId(relationship.target);
            const description = this.sct.getDisplayName(relationship.target);
            if (!set.has(relType + ":" + code)) {
              set.add(relType + ":" + code);
              let p = this._addCodeProperty(params, 'property', relType, code, null, description);
              p.part.push({ name: 'code-display', valueString: relTypeD });
            }
          }
        }
      }
      if (ctxt instanceof SnomedExpressionContext) {
        // ignore concepts for now, but list refinements and refinement groups
        for (const refinement of ctxt.expression.refinements) {
          const codeA = refinement.name.code;
          const codeB = refinement.value.describe();
          const description = await this.display(codeB);
          let p = this._addCodeProperty(params, 'property', codeA, codeB, null, description);
          p.part.push({ name: 'code-display', valueString: await this.display(codeA) });
        }
        for (const refinementGroup of ctxt.expression.refinementGroups) {
          for (const refinement of refinementGroup.refinements) {
            const codeA = refinement.name.code;
            const codeB = refinement.value.describe();
            const description = await this.display(codeB);
            let p = this._addCodeProperty(params, 'property', codeA, codeB, null, description);
            p.part.push({ name: 'code-display', valueString: await this.display(codeA) });
          }
        }
      }
    }
  }

  // Filter support
  async doesFilter(prop, op, value) {
    if (prop === 'concept') {
      const id = this.sct.stringToIdOrZero(value);
      if (id !== 0n && ['=', 'is-a', 'descendent-of', 'in', 'generalizes', 'child-of'].includes(op)) {
        return this.sct.conceptExists(value);
      }
      if (op === 'in' && value.includes(',')) {
        let ok = true;
        for (const idStr of value.split(',')) {
          const id = this.sct.stringToIdOrZero(idStr);
          if (id === 0n) {
            ok = false;
            break;
          }
        }
        return ok;
      }
    }
    if (prop === 'inactive') {
      return op === '=' && ['true', 'false'].includes(value);
    }

    if (prop === 'moduleId') {
      const id = this.sct.stringToIdOrZero(value);
      return id !== 0n && op === '=';
    }
    if (prop === 'constraint') {
      return op === '=';
    }

    if (prop == 'expressions' && op == '=' && ['true', 'false'].includes(value)) {
      return true;
    }

    const cid = this.sct.stringToIdOrZero(prop);
    if (cid != 0) {
      const id = this.sct.stringToIdOrZero(value);
      return id !== 0n && op === '=';
    }

    return false;
  }

  // eslint-disable-next-line no-unused-vars
  async getPrepContext(iterate) {

    return new SnomedPrep(); // Simple filter context
  }

  async filter(filterContext, forIteration, prop, op, value) {

    if (prop === 'concept') {
      const id = this.sct.stringToIdOrZero(value);
      if (id === 0n && op !== 'in') {
        throw new Error(`Invalid concept ID: ${value}`);
      }

      switch (op) {
        case '=': {
          filterContext.filters.push(this.sct.filterEquals(id));
          return null;
        }
        case 'is-a': {
          filterContext.filters.push(this.sct.filterIsA(id, true));
          return null;
        }
        case 'descendent-of': {
          filterContext.filters.push(this.sct.filterIsA(id, false));
          return null;
        }
        case 'child-of': {
          filterContext.filters.push(this.sct.filterChildOf(id));
          return null;
        }
        case 'generalizes': {
          filterContext.filters.push(this.sct.filterGeneralizes(id, false));
          return null;
        }
        case 'in': {
          filterContext.filters.push(this.sct.filterIn(value));
          return null;
        }
        default:
          throw new Error(`Unsupported filter operation: concept ${op} ${value}`);
      }
    }

    if (prop === 'inactive') {
      if (value !== 'true' && value !== 'false') {
        throw new Error(`Invalid filter value: ${value}`);
      }

      switch (op) {
        case '=': {
          filterContext.filters.push(this.sct.filterInactive(value === 'true'));
          return null;
        }
        default:
          throw new Error(`Unsupported filter operation: inactive ${op} ${value}`);
      }
    }

    if (prop === 'constraint' && op === '=') {
      filterContext.filters.push(await this.sct.filterECL(value, forIteration, this.opContext));
      return null;
    }

    if (prop === 'moduleId') {
      const id = this.sct.stringToIdOrZero(value);
      if (id === 0n) {
        throw new Error(`Invalid concept ID: ${value}`);
      }

      switch (op) {
        case '=': {
          filterContext.filters.push(this.sct.filterModuleId(id));
          return null;
        }
        default:
          throw new Error(`Unsupported filter operation: moduleId ${op} ${value}`);
      }
    }

    if (prop == 'expressions' && op == '=') {
      const filter = new SnomedFilterContext();
      filter.expressions = value == 'true';
      filterContext.filters.push(filter);
      return null;
    }

    const cid = this.sct.stringToIdOrZero(prop);
    if (cid != 0) {

      const id = this.sct.stringToIdOrZero(value);
      if (id === 0n) {
        throw new Error(`Invalid concept ID: ${value}`);
      }

      switch (op) {
        case '=': {
          filterContext.filters.push(this.sct.filterByProperty(cid, id));
          return null;
        }
        default:
          throw new Error(`Unsupported filter operation: ${prop} ${op} ${value}`);
      }
    }

    throw new Error(`Unsupported filter property: ${prop}`);
  }


  async executeFilters(filterContext) {
    return filterContext.filters;
  }

  // eslint-disable-next-line no-unused-vars
  async filtersNotClosed(filterContext) {
    for (let filter of filterContext.filters) {
      if (filter.expressions != undefined && !filter.expressions) {
        return false;
      }
    }
    return true;
  }

  async filterSize(filterContext, set) {
    if (set.matches && set.matches.length > 0) {
      return set.matches.length;
    } else if (set.members && set.members.length > 0) {
      return set.members.length;
    } else if (set.descendants && set.descendants.length > 0) {
      return set.descendants.length;
    }

    return 0;
  }

  async filterMore(filterContext, set) {
    set.cursor = set.cursor || 0;
    this.#ensurePopulated(set);
    const size = await this.filterSize(filterContext, set);
    return set.cursor < size;
  }

  async filterConcept(filterContext, set) {
    const size = await this.filterSize(filterContext, set);
    if (set.cursor >= size) {
      return null;
    }

    let key;
    if (set.matches && set.matches.length > 0) {
      key = set.matches[set.cursor].index;
    } else if (set.members && set.members.length > 0) {
      key = set.members[set.cursor].ref;
    } else if (set.descendants && set.descendants.length > 0) {
      key = set.descendants[set.cursor];
    } else {
      return null;
    }

    set.cursor++;
    return SnomedExpressionContext.fromReference(key);
  }

  async filterLocate(filterContext, set, code) {

    const conceptResult = await this.locate(code);
    if (!conceptResult.context) {
      return conceptResult.message;
    }

    if (set.eclWildcard) {
      return this.sct.isActive(reference) ? ctxt : null;
    }
    const ctxt = conceptResult.context;
    const reference = ctxt.getReference();
    let found = false;

    if (set.inactive !== undefined) {
      let concept = this.sct.concepts.getConcept(reference);
      let active = (concept.flags & 0x0F) === 0;
      found = active !== set.inactive
    } else if (set.moduleId) {
      let concept = this.sct.concepts.getConcept(reference);
      let moduleId = this.sct.concepts.getModuleId(concept.index);
      found = moduleId === set.moduleId;
    } else if (set.propProp || set.propValue) {
      found = false;
      const relationships = this.sct.getConceptRelationships(reference);
      for (let relationshipRef of relationships) {
        const relationship = this.sct.relationships.getRelationship(relationshipRef);
        if (set.propProp === relationship.relType && set.propValue === relationship.target) {
          found = true;
        }
      }
    } else if (set.matches && set.matches.length > 0) {
      found = set.matches.some(m => m.index === reference);
    } else if (set.members && set.members.length > 0) {
      found = set.members.some(m => m.ref === reference);
    } else if (set.descendants && set.descendants.length > 0) {
      found = set.descendants.includes(reference);
    }

    if (found) {
      return ctxt;
    } else {
      return null;
    }
  }

  async filterCheck(filterContext, set, concept) {
    if (!(concept instanceof SnomedExpressionContext)) {
      return false;
    }

    if (set.expressions != undefined) {
      let b = set.expressions || !concept.isComplex();
      return b;
    }

    const reference = concept.getReference();
    if (set.inactive !== undefined) {
      return this.sct.isActive(reference) !== set.inactive;
    }

    if (set.moduleId) {
      return this.sct.concepts.getModuleId(reference) === set.moduleId;
    }

    if (set.propProp || set.propValue) {
      const relationships = this.sct.getConceptRelationships(reference);
      for (let relationshipRef of relationships) {
        const relationship = this.sct.relationships.getRelationship(relationshipRef);
        if (set.propProp === relationship.relType && set.propValue === relationship.target) {
          return true;
        }
      }
    }

    if (set.matches && set.matches.length > 0) {
      return set.matches.some(m => m.index === reference);
    } else if (set.members && set.members.length > 0) {
      return set.members.some(m => m.ref === reference);
    } else if (set.descendants && set.descendants.length > 0) {
      return set.descendants.includes(reference);
    }
    if (set.eclWildcard) {
      return this.sct.isActive(reference);
    }
    return false;
  }

  #ensurePopulated(set) {
    if (set.populationDone) {
      return;
    }
    if (set.inactive !== undefined && set.descendants.length === 0) {
      for (let i = 0; i < this.sct.concepts.count(); i++) {
        let concept = this.sct.concepts.getConceptByCount(i);
        let active = (concept.flags & 0x0F) === 0;
        if (active !== set.inactive) {
          set.descendants.push(concept.index);
        }
      }
    }
    if (set.moduleId) {
      for (let i = 0; i < this.sct.concepts.count(); i++) {
        let concept = this.sct.concepts.getConceptByCount(i);
        let moduleId = this.sct.concepts.getModuleId(concept.index);
        if (moduleId === set.moduleId) {
          set.descendants.push(concept.index);
        }
      }
    }
    if (set.propProp || set.propValue) {
      for (let i = 0; i < this.sct.concepts.count(); i++) {
        let concept = this.sct.concepts.getConceptByCount(i);
        const relationships = this.sct.getConceptRelationships(concept.index);
        for (let relationshipRef of relationships) {
          const relationship = this.sct.relationships.getRelationship(relationshipRef);
          if (set.propProp === relationship.relType && set.propValue === relationship.target) {
            set.descendants.push(concept.index);
          }
        }
      }
    }
    set.populationDone = true;
  }

  // Search filter
  async searchFilter(filterContext, filter, sort) {
    let f = this.sct.searchFilter(filter, false, sort);
    filterContext.filters.push(f);
    return f;
  }

  // Subsumption testing
  async subsumesTest(codeA, codeB) {


    try {
      const exprA = new SnomedExpressionParser(this.sct.concepts).parse(codeA);
      const exprB = new SnomedExpressionParser(this.sct.concepts).parse(codeB);

      if (exprA.isSimple() && exprB.isSimple()) {
        const refA = exprA.concepts[0].reference;
        const refB = exprB.concepts[0].reference;

        if (refA === refB) {
          return 'equivalent';
        } else if (this.sct.subsumes(refA, refB)) {
          return 'subsumes';
        } else if (this.sct.subsumes(refB, refA)) {
          return 'subsumed-by';
        } else {
          return 'not-subsumed';
        }
      } else {
        const b1 = this.sct.expressionServices.expressionSubsumes(exprA, exprB);
        const b2 = this.sct.expressionServices.expressionSubsumes(exprB, exprA);

        if (b1 && b2) {
          return 'equivalent';
        } else if (b1) {
          return 'subsumes';
        } else if (b2) {
          return 'subsumed-by';
        } else {
          return 'not-subsumed';
        }
      }
    } catch (error) {
      throw new Error(`Error in subsumption test: ${error.message}`);
    }
  }

  // Helper methods
  async #ensureContext(context) {
    if (!context) {
      return null;
    }

    if (typeof context === 'string') {
      const result = await this.locate(context);
      if (!result.context) {
        throw new Error(result.message);
      }
      return result.context;
    }

    if (context instanceof SnomedExpressionContext) {
      return context;
    }

    throw new Error(`Unknown type at #ensureContext: ${typeof context}`);
  }

  versionAlgorithm() {
    return 'url';
  }

  isNotClosed() {
    return true;
  }

  isDisplay(cd) {
    return cd.use.system === this.system() &&
      (cd.use.code === '900000000000013009' || cd.use.code === '900000000000003001');
  }

  async getTranslations(map, coding, target, reverse) {
    if (!map || (target && target !== this.system()) || reverse) {
      return [];
    }
    let ref = this.sct.concepts.findConcept(map.id);
    if (!ref.found) {
      return [];
    }
    let rref = this.sct.refSetIndex.getRefSetByConcept(ref.index);
    if (rref == -1) {
      return [];
    }
    let refSetRecord = this.sct.refSetIndex.getReferenceSet(rref);
    let members = this.sct.refSetMembers.getMembers(refSetRecord.membersByRef);
    let srcConcept = this.sct.concepts.findConcept(coding.code);
    if (!srcConcept.found) {
      return [];
    }

    let result = [];
    let L = 0;
    let H = members.length - 1;
    while (L <= H) {
      const I = Math.floor((L + H) / 2);
      const ref = members[I].ref;
      if (ref < srcConcept.index) {
        L = I + 1;
      } else if (ref > srcConcept.index) {
        H = I - 1;
      } else {
        // Found — but scan left for first match in case of duplicates
        let first = I;
        while (first > 0 && members[first - 1].ref === srcConcept.index) {
          first--;
        }
        // Process all matching members
        for (let i = first; i < members.length && members[i].ref === srcConcept.index; i++) {
          let values = this.sct.refs.getReferences(members[i].values);
          if (values && values.length >= 1) {
            let tgtId = String(this.sct.concepts.getConceptId(values[0]));
            let ct = {
              map: map.vurl,
              code: tgtId,
              system: this.system(),
              version: this.version(),
              display: await this.display(tgtId),
              relationship: map.jsonObj.relationship
            }
            result.push(ct);
          }
        }
        break;
      }
    }

    return result;
  }

  hasMultiHierarchy() {
    return true;
  }

}

/**
 * Factory for creating SNOMED services and providers
 */
class SnomedServicesFactory extends CodeSystemFactoryProvider {
  constructor(i18n, filePath) {
    super(i18n);
    this.filePath = filePath;
    this.uses = 0;
    this._loaded = false;
    this._sharedData = null;
  }

  system() {
    return 'http://snomed.info/sct';
  }

  version() {
    return this._sharedData.versionUri;
  }

  getPartialVersion() {
    let ver = this.version();
    if (ver.includes("/version")) {
      return ver.substring(0, ver.indexOf("/version"));
    } else {
      return null;
    }
  }


  /**
   * Build an implicit SNOMED CT ValueSet from a URL.
   *
   * Handles the following URL patterns:
   *   http://snomed.info/sct?fhir_vs                    – all of SNOMED CT
   *   http://snomed.info/sct?fhir_vs=refset             – list of reference sets
   *   http://snomed.info/sct?fhir_vs=refset/<id>        – members of a reference set
   *   http://snomed.info/sct?fhir_vs=isa/<id>           – concept and descendants
   *
   * The URL may optionally include edition and/or version segments:
   *   http://snomed.info/sct/<edition>?fhir_vs...
   *   http://snomed.info/sct/<edition>/version/<ver>?fhir_vs...
   *
   * @param {string} url - The ValueSet URL to resolve
   * @returns {object|null} A FHIR ValueSet JSON object, or null if the URL is not recognised
   */
  async buildKnownValueSet(url, version) {
    if (!url.startsWith("http://snomed.info/sct")) {
      return null;
    }
    if (version != null && !this.version().startsWith(version)) {
      return null;
    }

    const URI_SNOMED = 'http://snomed.info/sct';

    // Extract the query portion (?fhir_vs...) if this is a recognised SNOMED implicit VS URL
    let id = null;
    const qIdx = url.indexOf('?');
    if (qIdx === -1) {
      return null;
    }

    if (url.startsWith('http://snomed.info/sct?fhir_vs') ||
      url.startsWith(`http://snomed.info/sct/${this.edition}?fhir_vs`) ||
      url.startsWith(`http://snomed.info/sct/${this.edition}/version/${this.version}?fhir_vs`)) {
      id = url.substring(qIdx);
    } else {
      return null;
    }

    const now = new Date().toISOString();

    if (id === '?fhir_vs=refset') {
      // List of all reference sets
      const concepts = [];
      for (let i = 0; i < this.refSetIndex.count; i++) {
        const code = this.refSetIndex.getReferenceSetCode(i);
        concepts.push({ code: this.getConceptId(code) });
      }
      return {
        resourceType: 'ValueSet',
        url,
        status: 'active',
        version: this.versionDate,
        name: 'SNOMEDCTReferenceSetList',
        title: 'SNOMED CT Reference Set List',
        description: 'Reference Sets defined in this SNOMED-CT version',
        date: now,
        compose: {
          include: [{
            system: URI_SNOMED,
            concept: concepts,
          }],
        },
      };
    }

    if (id === '?fhir_vs') {
      // All of SNOMED CT
      return {
        resourceType: 'ValueSet',
        url,
        status: 'active',
        version: this.versionDate,
        name: 'ALLSNOMEDCT',
        title: 'SNOMED CT Reference Set (All of SNOMED CT)',
        description: 'SNOMED CT Reference Set (All of SNOMED CT)',
        date: now,
        compose: {
          include: [{
            system: URI_SNOMED,
          }],
        },
      };
    }

    if (id.startsWith('?fhir_vs=refset/')) {
      const refsetId = id.substring(16);
      let ref = this.snomedServices.concepts.findConcept(refsetId);
      if (!ref.found) {
        return null;
      }
      let rref = this.snomedServices.refSetIndex.getRefSetByConcept(ref.index);
      if (rref == -1) {
        return null;
      }
      return {
        resourceType: 'ValueSet',
        url,
        status: 'active',
        version: this.versionDate,
        name: 'SNOMEDCTRefSet' + refsetId,
        title: 'SNOMED CT Reference Set ' + refsetId,
        description: this.snomedServices.getDisplayName(ref.index),
        date: now,
        compose: {
          include: [{
            system: URI_SNOMED,
            filter: [{
              property: 'concept',
              op: 'in',
              value: refsetId,
            }],
          }],
        },
      };
    }

    if (id.startsWith('?fhir_vs=isa/')) {
      const conceptId = id.substring(13);
      let ref = this.snomedServices.concepts.findConcept(conceptId);
      if (!ref.found) {
        return null;
      }
      return {
        resourceType: 'ValueSet',
        url,
        status: 'active',
        version: this.versionDate,
        name: 'SNOMEDCTConcept' + conceptId,
        title: 'SNOMED CT Concept ' + conceptId + ' and descendants',
        description: 'All Snomed CT concepts for ' + this.snomedServices.getDisplayName(ref.index),
        date: now,
        compose: {
          include: [{
            system: URI_SNOMED,
            filter: [{
              property: 'concept',
              op: 'is-a',
              value: conceptId,
            }],
          }],
        },
      };
    }
    return null;
  }

  async #ensureLoaded() {
    if (!this._loaded) {
      await this.load();
    }
  }

  async load() {
    const reader = new SnomedFileReader(this.filePath);
    this._sharedData = await reader.loadSnomedData();
    this.snomedServices = new SnomedServices(this._sharedData);
    this._loaded = true;
  }

  defaultVersion() {
    return this._sharedData?.version || 'unknown';
  }

  async build(opContext, supplements = []) {
    await this.#ensureLoaded();
    this.recordUse();
    return new SnomedProvider(opContext, supplements, this.snomedServices);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }

  name() {
    if (this.version().includes("xsct")) {
      return "SNOMED CT Test Set";
    } else {
      return `SCT ${getEditionCode(this._sharedData.edition)}`;
    }
  }

  nameBase() {
    return `SCT`;
  }

  id() {
    let match = this.version().match(/^http:\/\/snomed\.info\/sct\/(\d+)(?:\/version\/(\d{8}))?$/);
    if (!match) {
      match = this.version().match(/^http:\/\/snomed\.info\/xsct\/(\d+)(?:\/version\/(\d{8}))?$/);
      if (match) {
        match = "x" + match;
      }
    }
    return match && match[1] && match[2] ? "SCT-" + match[1] + "-" + match[2] : null;
  }

  describeVersion(version) {
    const match = version.match(/^http:\/\/snomed\.info\/sct\/(\d+)(?:\/version\/(\d{8}))?$/);
    if (!match) return version;

    const edition = getEditionName(match[1]);
    if (!match[2]) return edition;

    return edition + ' ' + formatDateMMDDYYYY(match[2].substring(4, 6) + match[2].substring(6, 8) + match[2].substring(0, 4));
  }

  async findImplicitConceptMap(url, version) {
    if (version && (version !== this.version())) {
      return null;
    }
    if (!url || !url.startsWith(this.system() + "?fhir_cm=")) {
      return null;
    }
    let id = url.substring(url.indexOf("=") + 1);
    if (['900000000000523009', '900000000000526001', '900000000000527005', '900000000000530003'].includes(id)) {
      let name = '';
      let relationship = '';
      switch (id) {
        case '900000000000523009':
          name = 'POSSIBLY EQUIVALENT TO';
          relationship = 'inexact';
          break;
        case '900000000000526001':
          name = 'REPLACED BY';
          relationship = 'equivalent';
          break;
        case '900000000000527005':
          name = 'SAME AS';
          relationship = 'equal';
          break;
        case '900000000000530003':
          name = 'ALTERNATIVE';
          relationship = 'inexact';
          break;
      }
      let cm = {
        resourceType: 'ConceptMap',
        internalSource: this,
        relationship: relationship,
        id: id,
        url: `${this.system()}?fhir_cm=${id}`,
        version: this.version(),
        name: `SNOMED CT ${name} Concept Map`,
        description: `The concept map implicitly defined by the ${name} Association Reference Set`,
        copyright: 'This value set includes content from SNOMED CT, which is copyright © 2002+ International Health Terminology Standards Development Organisation (SNOMED International), and distributed by agreement between SNOMED International and HL7',
        status: 'active',
        sourceUri: `${this.system}?fhir_vs`,
        targetUri: `${this.system}?fhir_vs`,
        group: [{
          source: 'http://snomed.info/sct',
          target: 'http://snomed.info/sct'
        }]
      }
      return new ConceptMap(cm);
    } else {
      return null;
    }
  }

  webSource() {
    return this.version();
  }

}

function getEditionName(edition) {
  const editionMap = {
    '900000000000207008': 'International Edition',
    '449081005': 'International Spanish Edition',
    '11000221109': 'Argentinian Edition',
    '32506021000036107': 'Australian Edition (with drug extension)',
    '11000234105': 'Austrian Edition',
    '11000172109': 'Belgian Edition',
    '20621000087109': 'Canadian English Edition',
    '20611000087101': 'Canadian Canadian French Edition',
    '554471000005108': 'Danish Edition',
    '11000279109': 'Czech Edition',
    '11000181102': 'Estonian Edition',
    '11000229106': 'Finnish Edition',
    '11000315107': 'French Edition',
    '11000274103': 'German Edition',
    '1121000189102': 'Indian Edition',
    '827022005': 'IPS Terminology',
    '11000220105': 'Irish Edition',
    '11000146104': 'Netherlands Edition',
    '21000210109': 'New Zealand Edition',
    '51000202101': 'Norwegian Edition',
    '11000267109': 'Republic of Korea Edition (South Korea)',
    '900000001000122104': 'Spanish National Edition',
    '45991000052106': 'Swedish Edition',
    '2011000195101': 'Swiss Edition',
    '83821000000107': 'UK Edition',
    '999000021000000109': 'UK Clinical Edition',
    '5631000179106': 'Uruguay Edition',
    '731000124108': 'US Edition',
    '21000325107': 'Chilean Edition',
    '5991000124107': 'US Edition (with ICD-10-CM maps)'
  };

  return editionMap[edition] || 'Unknown Edition';
}

function getEditionCode(edition) {
  const editionMap = {
    '900000000000207008': 'Intl',
    '449081005': 'es',
    '11000221109': 'AR-es',
    '32506021000036107': 'AU+',
    '11000234105': 'AT',
    '11000172109': 'BE',
    '20621000087109': 'CA-en',
    '20611000087101': 'CA-fr',
    '554471000005108': 'DK',
    '11000279109': 'CZ',
    '11000181102': 'ES',
    '11000229106': 'FI',
    '11000315107': 'FR-fr',
    '11000274103': 'DE',
    '1121000189102': 'IN',
    '827022005': 'IPS',
    '11000220105': 'IE',
    '11000146104': 'NL',
    '21000210109': 'NZ',
    '51000202101': 'NO',
    '11000267109': 'KR',
    '900000001000122104': 'ES-es',
    '45991000052106': 'SW',
    '2011000195101': 'CH',
    '83821000000107': 'UK',
    '999000021000000109': 'UK-Clinical',
    '5631000179106': 'UR',
    '731000124108': 'US',
    '21000325107': 'CL',
    '5991000124107': 'US+)'
  };

  return editionMap[edition] || 'Unknown Edition';
}


module.exports = {
  SnomedProvider,
  SnomedServicesFactory,
  SnomedExpressionContext,
  SnomedServices,
  SnomedFilterContext,
  SnomedProviderContextKind
};