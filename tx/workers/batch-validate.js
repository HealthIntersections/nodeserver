//
// Validate Worker - Handles $validate-code operations
//
// GET /CodeSystem/$validate-code?{params}
// POST /CodeSystem/$validate-code
// GET /CodeSystem/{id}/$validate-code?{params}
// POST /CodeSystem/{id}/$validate-code
// GET /ValueSet/$validate-code?{params}
// POST /ValueSet/$validate-code
// GET /ValueSet/{id}/$validate-code?{params}
// POST /ValueSet/{id}/$validate-code
//

const { TerminologyWorker } = require('./worker');
const {OperationOutcome, Issue} = require("../library/operation-outcome");
const {Parameters} = require("../library/parameters");
const {ValidateWorker} = require("./validate");

class BatchValidateWorker extends TerminologyWorker {

  globalNames = new Set();

  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for code systems and resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
    this.globalNames.add("tx-resource");
    this.globalNames.add("url");
    this.globalNames.add("valueSet");
    this.globalNames.add("lenient-display-validation");
    this.globalNames.add("__Accept-Language");
    this.globalNames.add("__Content-Language");
  }

  /**
   * Get operation name
   * @returns {string}
   */
  opName() {
    return 'batch-validate-code';
  }

  async handleValueSet(req, res) {
    const priorTraceNotes = this.opContext.traceNotes;
    try {
      let params = req.body;
      this.addHttpParams(req, params);

      this.opContext.traceNotes = this.#shouldTraceBatchNotes(params);

      let globalParams = [];
      for (const p of params.parameter) {
        if (this.globalNames.has(p.name)) {
          globalParams.push(p);
        }
      }

      let output = [];

      for (const p of params.parameter) {
        if (p.name == 'validation') {
          let op = new Parameters();
          op.jsonObj.parameter = [];
          for (const gp of globalParams) {
            let exists = p.resource.parameter.find(pp => gp.name == pp.name);
            if (gp.name == 'tx-resource' || !exists) {
              op.jsonObj.parameter.push(gp);
            }
          }
          op.jsonObj.parameter.push(...p.resource.parameter);

          // Keep one request-scope operation context so provider-resolution caches
          // are reused across validations in this batch.
          let worker = new ValidateWorker(this.opContext, this.log, this.provider, this.languages, this.i18n);
          try {
            let p;
            if (this.hasValueSet(op.jsonObj.parameter)) {
              p = await worker.handleValueSetInner(op.jsonObj);
            } else {
              p = await worker.handleCodeSystemInner(op.jsonObj);
            }
            output.push({name: "validation", resource : p});
          } catch (error) {
            this.log.error(error);
            if (error instanceof Issue) {
              let op = new OperationOutcome();
              op.addIssue(error);
              output.push({name: "validation", resource : op.jsonObj});
            } else {
              output.push({name: "validation", resource : this.operationOutcome('error', error.issueCode || 'exception', error.message) } );
            }
          }
        }
      }
      let result = { resourceType : "Parameters", parameter: output}
      req.logInfo = `${output.length} validations`;
      this.opContext.traceNotes = priorTraceNotes;
      return res.json(result);
    } catch (error) {
      this.opContext.traceNotes = priorTraceNotes;
      this.log.error(error);
      return res.status(error.statusCode || 500).json(this.operationOutcome(
        'error', error.issueCode || 'exception', error.message));
    }
  }

  /**
   * Build an OperationOutcome
   */
  operationOutcome(severity, code, message) {
    return {
      resourceType: 'OperationOutcome',
      issue: [{
        severity,
        code,
        details: {
          text: message
        },
        diagnostics: message
      }]
    };
  }

  hasValueSet(parameter) {
    return parameter.find(p => p.name == 'url' || p.name == 'valueSet');
  }

  #shouldTraceBatchNotes(params) {
    const list = Array.isArray(params?.parameter) ? params.parameter : [];
    for (const p of list) {
      if (p?.name !== 'validation' || !p?.resource?.parameter) {
        continue;
      }
      for (const pp of p.resource.parameter) {
        if (pp?.name === 'diagnostics') {
          if (pp.valueBoolean === true) return true;
          if (String(pp.valueString || '').toLowerCase() === 'true') return true;
        }
      }
    }
    return false;
  }
}

module.exports = {
  BatchValidateWorker
};
