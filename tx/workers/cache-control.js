//
// Cache Control Worker - Handles the $cache-control operation
//
// GET  /$cache-control?mode=start   - create a cache, return its (server-issued) id
// POST /$cache-control?mode=start   - as above, optionally front-loading resources
// GET  /$cache-control?mode=end     - tell the server it can release the cache now
// POST /$cache-control?mode=end
// (mode=check is reserved for later - report whether a cache is still valid + stats)
//
// This is the explicit replacement for the implicit `cache-id` parameter protocol:
// the server owns the cache-id namespace, so it can authoritatively reject an
// unknown/expired cache later instead of failing obscurely deep inside a validation.
//
// NOTE: this is scaffolding. start()/end() currently parse the request into a
// Parameters resource (the same way validate.js does) but do not yet create or
// release anything. The behaviour is filled in by later steps.
//

const crypto = require('crypto');
const { TerminologyWorker, CACHE_ID_HEADER } = require('./worker');
const { Parameters } = require('../library/parameters');
const { debugLog } = require('../operation-context');

class CacheControlWorker extends TerminologyWorker {
  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for code systems and resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
  }

  opName() {
    return 'cache-control';
  }

  // Not a value-set operation; the base class requires this to be implemented.
  vsHandle() {
    return null;
  }

  /**
   * Express entry point for /$cache-control (GET and POST).
   * Dispatches on the `mode` query parameter.
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handle(req, res) {
    try {
      const mode = this.getMode(req);
      // GET is accepted as well as POST, for consistency with the server's other
      // operations (which are all browsable) and the convenience of poking
      // $cache-control from a browser. The operation is declared affectsState=true
      // in its OperationDefinition, so conformant clients POST; an accidental
      // GET-created cache is an empty entry that self-expires.
      switch (mode) {
        case 'start':
          return await this.start(req, res);
        case 'end':
          return await this.end(req, res);
        default:
          return res.status(400).json(this.operationOutcome('error', 'invalid',
            `$cache-control requires a 'mode' of 'start' or 'end'` +
            (mode ? ` (got '${mode}')` : ` (none supplied)`)));
      }
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      req.logInfo = this.usedSources.join('|') + ' - error' + (error.msgId ? ' ' + error.msgId : '');
      const statusCode = error.statusCode || 500;
      const issueCode = error.issueCode || 'exception';
      return res.status(statusCode).json(this.operationOutcome('error', issueCode, error.message));
    }
  }

  /**
   * Determine the requested mode. The cache-control mode travels in the query
   * string (?mode=start) so it survives even when a Parameters resource is POSTed
   * as the body; a `mode` parameter in the body is accepted as a fallback.
   * @param {express.Request} req
   * @returns {string|null}
   */
  getMode(req) {
    if (req.query && req.query.mode) {
      return String(req.query.mode);
    }
    if (req.body && req.body.resourceType === 'Parameters') {
      const p = this.findParameter(req.body, 'mode');
      if (p) {
        return this.getParameterValue(p);
      }
    }
    return null;
  }

  /**
   * mode=start: mint a server-issued cache-id, create the (per-endpoint) cache,
   * front-load any supplied resources into it, and return the id in the body.
   *
   * The id is returned in the body rather than a header to keep it readable by
   * browser clients without CORS expose-header configuration; subsequent calls
   * carry it back as the `${CACHE_ID_HEADER}` request header.
   *
   * The cache is created even when no resources are front-loaded: an explicitly
   * empty cache must still *exist* so the server can later tell "cache I issued,
   * currently empty" from "cache-id I never issued". That's why this uses
   * ResourceCache.set (which always creates the entry) rather than add (which
   * ignores empty resource lists).
   *
   * @param {express.Request} req
   * @param {express.Response} res
   */
  async start(req, res) {
    const cache = this.opContext.resourceCache;
    if (!cache) {
      return res.status(500).json(this.operationOutcome('error', 'exception',
        'No resource cache is available on this endpoint'));
    }

    const params = new Parameters(this.buildParameters(req));
    const { txResources, primaryResources } = this.collectSuppliedResources(params.jsonObj);
    const resources = txResources.concat(primaryResources);

    const cacheId = crypto.randomUUID();
    cache.set(cacheId, resources);

    return res.status(200).json({
      resourceType: 'Parameters',
      parameter: [
        { name: 'cache-id', valueId: cacheId }
      ]
    });
  }

  /**
   * mode=end: release the cache named by the `${CACHE_ID_HEADER}` header so the
   * server can reclaim it now rather than waiting for the idle timeout.
   *
   * Releasing is idempotent: ending an id the server doesn't have is not an error
   * here (the authoritative "unknown cache" signal belongs on the validation path,
   * a later step). A missing header is a client error, though.
   *
   * @param {express.Request} req
   * @param {express.Response} res
   */
  async end(req, res) {
    const cache = this.opContext.resourceCache;
    if (!cache) {
      return res.status(500).json(this.operationOutcome('error', 'exception',
        'No resource cache is available on this endpoint'));
    }

    const cacheId = req.headers[CACHE_ID_HEADER];
    if (!cacheId) {
      return res.status(400).json(this.operationOutcome('error', 'invalid',
        `$cache-control mode=end requires the cache-id in the '${CACHE_ID_HEADER}' header`));
    }

    cache.clear(cacheId);

    return res.status(200).json({ resourceType: 'Parameters', parameter: [] });
  }

  /**
   * Build an OperationOutcome.
   * @param {string} severity - error, warning, information
   * @param {string} code - Issue code
   * @param {string} message - Diagnostic message
   * @returns {Object} OperationOutcome resource
   */
  operationOutcome(severity, code, message) {
    return {
      resourceType: 'OperationOutcome',
      issue: [{
        severity,
        code,
        details: { text: message }
      }]
    };
  }
}

module.exports = { CacheControlWorker, CACHE_ID_HEADER };
