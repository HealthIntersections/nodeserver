const CodeSystem = require('../library/codesystem');

class TxOperationContext {

  constructor(langs) {
    this.langs = langs;
  }

  /**
   * @type {Language} languages specified in request
   */
  langs;
}

class Designation {
  lang;
  use;
  value;
}

class CodeSystemProvider {
  /**
   * @section Metadata for the code system
   */

  /**
   * @returns {string} uri for the code system
   */
  name() { return system() + (this.version() ? "|"+this.version() : "") }

  /**
   * @returns {string} uri for the code system
   */
  system() { throw "Must override"; }

  /**
   * @returns {string} version for the code system
   */
  version() { throw "Must override"; }

  /**
   * @returns {string} default language for the code system
   */
  defLang() { return 'en' }

  /**
   * @returns {CodeSystemContentMode} content mode for the CodeSystem
   */
  contentMode() { return CodeSystemContentMode.Complete; }

  /**
   * @returns {integer} agreed limitation of expansions (see CPT). 0 means no limitation
   */
  expandLimitation() { return 0; }

  /**
   * @returns {string} description for the code system
   */
  description() { throw "Must override"; }

  /**
   * @returns {string} source package for the code system, if known
   */
  sourcePackage() { return null; }

  /**
   * @returns {integer} total number of concepts in the code system
   */
  totalCount() { throw "Must override"; }

  /**
   * @returns {CodeSystem.property[]} defined properties for the code system
   */
  propertyDefinitions() { return null; }

  /**
   * @param {Languages} languages language specification
   * @returns {boolean} defined properties for the code system
   */
  hasAnyDisplays(languages) { return languages.matches('en'); }

  /**
   * @returns {boolean} true if there's a heirarchy
   */
  hasParents() { return false; }

  /**
   * @returns {string} true if the code system nominates an enumeration to use in place of iterating (UCUM)
   */
  specialEnumeration() { return null; }

  /**
   * @param {string} url the supplement of interest
   * @returns {boolean} true if the nominated supplement is in scope
   */
  hasSupplement(url) { return false; }

  /**
   * @returns {string[]} all supplements in scope
   */
  listSupplements() { return null; }

  /**
   * @returns {Feature[]} applicable Features
   */
  listFeatures() { return null; }

  /**
   * @param {string} v1 - first version
   * @param {string} v2 - second version
   * @returns {boolean} True if something....
   */
  versionIsMoreDetailed(v1, v2) { return false; }

  /**
   * @returns { {status, standardsStatus : String, experimental : boolean} } applicable Features
   */
  getStatus() { return null; }

  /**
   * @section Getting Information about the concepts in the CodeSystem
   */

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {String | CodeSystemProviderContext} code
   * @returns {string} the correct code for the concept specified
   */
  code(opContext, code) {throw "Must override"; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {String | CodeSystemProviderContext} code
   * @returns {string} the best display given the languages in the operation context
   */
  async display(opContext, code) {throw "Must override"; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {string} the definition for the concept (if available)
   */
  async definition(opContext, code) {throw "Must override"; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {boolean} if the concept is abstract
   */
  isAbstract(opContext, code) { return false; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {boolean} if the concept is inactive
   */
  isInactive(opContext, code) { return false; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {boolean} if the concept is inactive
   */
  isDeprecated(opContext, code) { return false; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {string} status
   */
  getStatus(opContext, code) { return null; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {string} assigned itemWeight - if there is one
   */
  itemWeight(opContext, code) { return null; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {string} parent, if there is one
   */
  parent(opContext, code) { return null; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {Designation[]} whatever designations exist (in all languages)
   */
  async designations(opContext, code) { return null; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {Extension[]} extensions, if any
   */
  extensions(opContext, code) { return null; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {CodeSystem.concept.property[]} parent, if there is one
   */
  properties(opContext, code) { return null; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {string} information about incomplete validation on the concept, if there is any information (SCT)
   */
  incompleteValidationMessage(opContext, code) { return null; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} a
   * @param {string | CodeSystemProviderContext} b
   * @returns {boolean} true if they're the same
   */
  sameConcept(/*TxOperationContext*/ opContext, a, b) { return false; }

  /**
   * @section Finding concepts in the CodeSystem
   */

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string } code
   * @returns {{context : CodeSystemProviderContext, message : String} the result of looking for the code
   */
  async locate(opContext, code) { throw "Must override"; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string} code
   * @param {string} parent
   * @param {boolean} disallowParent
   * @returns {{context : CodeSystemProviderContext, message : String} the result of looking for the code in the context of the parent
   */
  async locateIsA(opContext, code) {
    if (this.hasParents()) throw "Must override"; else return { context : null, message: "The CodeSystem "+this.name()+" does not have parents"}
  }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemProviderContext} code
   * @returns {CodeSystemIterator} a handle that can be passed to nextConcept (or null, if it can't be iterated)
   */
  iterator(opContext, code) { return null }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {CodeSystemIterator} context
   * @returns {CodeSystemProviderContext} the next concept, or null
   */
  nextContext(opContext,context) { return null; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {string | CodeSystemIterator} codeA
   * @param {string | CodeSystemIterator} codeB
   * @returns {boolean} true if codeA subsumes codeB
   */
  subsumesTest(opContext, codeA, codeB) { return false; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {CodeSystemProviderContext} ctxt the context to add properties for
   * @param {string[]} props the properties requested
   * @param {Parameters} params the parameters response to add to
   */
  extendLookup(opContext, ctxt, props, params) { }

  // procedure getCDSInfo(/*TxOperationContext*/ opContext; card : TCDSHookCard; langList : THTTPLanguageList; baseURL, code, display : String); virtual;

  /**
   * returns true if a filter is supported
   *
   * @param {TxOperationContext} opContext  operation context (logging, etc)
   * @param {String} prop
   * @param {ValueSetFilterOperator} op
   * @param {String} prop
   * @returns {boolean} true if suppoted
   * */
  doesFilter(/*TxOperationContext*/ opContext, prop, op, value) { return false; }

  /**
   * gets a single context in which filters will be evaluated. The application doesn't make use of this context;
   * it's only use is to be passed back to the CodeSystem provider so it can make use of it - if it wants
   *
   * @param {TxOperationContext} opContext  operation context (logging, etc)
   * @param {boolean} iterate true if the conceptSets that result from this will be iterated, and false if they'll be used to locate a single code
   * @returns {FilterExecutionContext} filter (or null, it no use for this)
   * */
  getPrepContext(opContext, iterate) { return null; }

  /**
   * executes a text search filter (whatever that means) and returns a FilterConceptSet
   *
   * throws an exception if the search filter can't be handled
   *
   * @param {TxOperationContext} opContext  operation context (logging, etc)
   * @param {FilterExecutionContext} filterContext filtering context
   * @param {String} filter user entered text search
   * @param {boolean} sort ?
   **/
  async searchFilter(opContext, filterContext, filter, sort) { throw "Must override"; } // ? must override?

  /**
   * I don't know what this does
   *
   * throws an exception if the search filter can't be handled
   * @param {TxOperationContext} opContext  operation context (logging, etc)
   * @param {FilterExecutionContext} filterContext filtering context
   * @param {String} filter user entered text search
   * @param {boolean} sort ?
   **/
  async specialFilter(opContext, filterContext, filter, sort) { throw "Must override"; } // ? must override?

  /**
   * Get a FilterConceptSet for a value set filter
   *
   * throws an exception if the search filter can't be handled
   *
   * @param {TxOperationContext} opContext  operation context (logging, etc)
   * @param {FilterExecutionContext} filterContext filtering context
   * @param {String} prop
   * @param {ValueSetFilterOperator} op
   * @param {String} prop
   **/
  async filter(opContext, filterContext, prop, op, value) { throw "Must override"; } // well, only if any filters are actually supported

  /**
   * called once all the filters have been handled, and iteration is about to happen.
   * this function returns one more filters. If there were multiple filters, but only
   * one FilterConceptSet, then the code system provider has done the join across the
   * filters, otherwise the engine will do so as required
   *
   * @param {TxOperationContext} opContext  operation context (logging, etc)
   * @param {FilterExecutionContext} filterContext filtering context
   * @returns {FilterConceptSet[]} filter sets
   **/
  async executeFilters(opContext, filterContext) { throw "Must override"; } // well, only if any filters are actually supported

  /**
   * return how many concepts are in the filter set
   @param {TxOperationContext} opContext  operation context (logging, etc)
   @param {FilterExecutionContext} filterContext filtering context
   @param {FilterConceptSet} set of interest
   @returns {int} number of concepts in the set
   */
  filterSize(opContext, filterContext, set) {throw "Must override"; }

  /**
   * return true if there's an infinite number of members (or at least, beyond knowing)
   *
   * This is true if the code system defines a grammar
   *
   @param {TxOperationContext} opContext  operation context (logging, etc)
   @param {FilterExecutionContext} filterContext filtering context
   @returns {boolean} true if not closed
   */
  filtersNotClosed(opContext, filterContext) { return false; }

  /**
   * iterate the filter set. Iteration is forwards only, using the style
   * while (filterMore()) { something(filterConcept()};
   *
   @param {TxOperationContext} opContext  operation context (logging, etc)
   @param {FilterExecutionContext} filterContext filtering context
   @param {FilterConceptSet} set of interest
   @returns {boolean} if there is a concept
   */
  filterMore(opContext, filterContext, set) {throw "Must override"; }

  /**
   * get the current concept
   *
   @param {TxOperationContext} opContext  operation context (logging, etc)
   @param {FilterExecutionContext} filterContext filtering context
   @param {FilterConceptSet} set of interest
   @returns {CodeSystemProviderContext} if there is a concept
   */
  filterConcept(opContext, filterContext, set) {throw "Must override"; }

  /**
   * filterLocate - instead of iterating, find a code in the FilterConceptSet
   *
   @param {TxOperationContext} opContext  operation context (logging, etc)
   @param {FilterExecutionContext} filterContext filtering context
   @param {FilterConceptSet} set of interest
   @param {string} code the code to find
   @returns {string | CodeSystemProviderContext} an error explaining why it isn't in the set, or a handle to the concept
   */
  async filterLocate(opContext, filterContext, set, code) {throw "Must override"; }

   /**
   * filterLocate - instead of iterating, find a code in the FilterConceptSet
   *
   @param {TxOperationContext} opContext  operation context (logging, etc)
   @param {FilterExecutionContext} filterContext filtering context
   @param {FilterConceptSet} set of interest
   @param {CodeSystemProviderContext} concept the code to find
   @returns {string | boolean } an error explaining why it isn't in the set, or true if it is
   */
   filterCheck(opContext, filterContext, set, concept) {throw "Must override"; }

  /**
   * filterFinish - opportunity for the provider to close up and recover resources etc
   *
   @param {TxOperationContext} opContext  operation context (logging, etc)
   @param {FilterExecutionContext} filterContext filtering context
   */
  filterFinish(opContext, filterContext) {throw "Must override"; }

  /**
   * register the concept maps that are implicitly defined as part of the code system
   *
   * @param {ConceptMap[]} conceptMaps
   *
   */
  registerConceptMaps(list) {}


  /**
   * register the concept maps that are implicitly defined as part of the code system
   *
   * @param {TxOperationContext} opContext  operation context (logging, etc)
   * @param {Coding} coding the coding to translate
   * @param {String} target
   * @returns {CodeTranslation[]} the list of translations
   */
  async getTranslations(opContext, coding, target) { return null;}
}

class CodeSystemFactoryProvider {
  uses = 0;

  /**
   * @returns {String} the latest version, if known
   */
  defaultVersion() { throw "Must override"; }

  /**
   * @param {TxOperationContext} opContext operation context (logging, etc)
   * @param {CodeSystem[]} supplements any supplements that are in scope
   * @returns {CodeSystemProvider} a built provider - or an exception
   */
  build(opContext, supplements) { throw "Must override Factory"; }

  /**
   * @returns {number} how many times the factory has been asked to construct a provider
   */
  useCount() {return this.uses}

  recordUse() {
    this.uses++;
  }
}

module.exports = {
  TxOperationContext,
  Designation,
  CodeSystemProvider,
  CodeSystemFactoryProvider
};