'use strict';

/**
 * SNOMED-specific subclass of SqliteRuntimeV0Provider that adds
 * post-coordinated expression support (parse, validate, display, subsume).
 *
 * Delegates all standard v0 operations to the parent class and only
 * intercepts expression-related calls.
 */

const { SqliteRuntimeV0Provider, SqliteRuntimeV0FactoryProvider } = require('./cs-sqlite-runtime-v0');
const { createSqliteExpressionServices } = require('./cs-sqlite-expression-adapter');
const {
  SnomedExpressionContext,
  SnomedServicesRenderOption,
} = require('../sct/expressions');

class SnomedSqliteV0Provider extends SqliteRuntimeV0Provider {
  constructor(opContext, supplements, db, metadata, runtime, options = {}) {
    super(opContext, supplements, db, metadata, runtime, options);
    this._exprServices = null;
    this._exprParser = null;
  }

  /** Lazy-init expression services from the sync db. */
  #getExpressionServices() {
    if (this._exprServices) return this._exprServices;
    const syncDb = this._getOrCreateSyncDb();
    if (!syncDb) return null;
    const result = createSqliteExpressionServices(syncDb, this.meta.csId);
    this._exprServices = result.expressionServices;
    this._exprParser = result.parser;
    return this._exprServices;
  }

  /** Override _ensureContext to accept SnomedExpressionContext. */
  async _ensureContext(code) {
    if (code instanceof SnomedExpressionContext) return code;
    return super._ensureContext(code);
  }

  /** Extract code string from a SnomedExpressionContext. */
  #exprCode(ctx) {
    if (ctx.source) return ctx.source;
    if (ctx.expression?.concepts?.[0]?.code) return ctx.expression.concepts[0].code;
    return '';
  }

  // ── locate: try expression parse when code not found in DB ────────

  async locate(code) {
    // First try the standard DB lookup
    const result = await super.locate(code);
    if (result.context) return result;

    // Not found as a simple code — try parsing as SNOMED expression
    return this.#tryLocateExpression(code);
  }

  #tryLocateExpression(code) {
    if (!code || typeof code !== 'string') {
      return { context: null, message: undefined };
    }

    // Quick check: expressions contain ':' or '+' — skip pure numeric codes
    if (/^\d+$/.test(code)) {
      return { context: null, message: undefined };
    }

    const exprSvc = this.#getExpressionServices();
    if (!exprSvc) {
      return { context: null, message: undefined };
    }

    try {
      const expression = this._exprParser.parse(code);
      exprSvc.checkExpression(expression);
      return {
        context: new SnomedExpressionContext(code, expression),
        message: null
      };
    } catch (error) {
      return {
        context: null,
        message: `Not a valid expression: ${error.message}`
      };
    }
  }

  // ── code / display / designations overrides for expressions ────────

  async code(context) {
    if (context instanceof SnomedExpressionContext) {
      if (context.isComplex()) {
        const exprSvc = this.#getExpressionServices();
        return exprSvc
          ? exprSvc.renderExpression(context.expression, SnomedServicesRenderOption.Minimal)
          : this.#exprCode(context);
      }
      return this.#exprCode(context);
    }
    return super.code(context);
  }

  async display(context) {
    if (context instanceof SnomedExpressionContext) {
      if (context.isComplex()) {
        const exprSvc = this.#getExpressionServices();
        return exprSvc
          ? exprSvc.renderExpression(context.expression, SnomedServicesRenderOption.FillMissing)
          : this.#exprCode(context);
      }
      const code = this.#exprCode(context);
      const dbResult = await super.locate(code);
      if (dbResult.context) return dbResult.context.display || code;
      return code;
    }
    return super.display(context);
  }

  async designations(context, displays) {
    if (context instanceof SnomedExpressionContext && context.isComplex()) {
      const disp = await this.display(context);
      const { CodeSystem } = require('../library/codesystem');
      displays.addDesignation(true, 'active', this.defLang(), CodeSystem.makeUseForDisplay(), disp);
      return;
    }
    // Simple SnomedExpressionContext — resolve to DB context
    if (context instanceof SnomedExpressionContext) {
      const code = this.#exprCode(context);
      const dbResult = await super.locate(code);
      if (dbResult.context) return super.designations(dbResult.context, displays);
      return;
    }
    return super.designations(context, displays);
  }

  async properties(context) {
    if (context instanceof SnomedExpressionContext && context.isComplex()) {
      return [{ code: 'inactive', valueBoolean: false }];
    }
    if (context instanceof SnomedExpressionContext) {
      const code = this.#exprCode(context);
      const dbResult = await super.locate(code);
      if (dbResult.context) return super.properties(dbResult.context);
      return [];
    }
    return super.properties(context);
  }

  // ── incompleteValidationMessage for expressions ───────────────────

  async incompleteValidationMessage(context) {
    if (context instanceof SnomedExpressionContext && context.isComplex()) {
      return 'The expression is grammatically correct and the concepts are valid, but the expression has not been checked against the SNOMED CT concept model (MRCM)';
    }
    return null;
  }

  // ── subsumesTest: handle expression subsumption ───────────────────

  async subsumesTest(codeA, codeB) {
    // If both are simple codes, use parent's fast path
    const isExprA = typeof codeA === 'string' && /[:{+]/.test(codeA);
    const isExprB = typeof codeB === 'string' && /[:{+]/.test(codeB);

    if (!isExprA && !isExprB) {
      return super.subsumesTest(codeA, codeB);
    }

    const exprSvc = this.#getExpressionServices();
    if (!exprSvc) return super.subsumesTest(codeA, codeB);

    try {
      const exprA = this._exprParser.parse(typeof codeA === 'string' ? codeA : String(codeA));
      exprSvc.checkExpression(exprA);
      const exprB = this._exprParser.parse(typeof codeB === 'string' ? codeB : String(codeB));
      exprSvc.checkExpression(exprB);

      if (exprSvc.expressionsEquivalent(exprA, exprB)) return 'equivalent';

      const aSubsumesB = exprSvc.expressionSubsumes(exprA, exprB);
      if (aSubsumesB) return 'subsumes';

      const bSubsumesA = exprSvc.expressionSubsumes(exprB, exprA);
      if (bSubsumesA) return 'subsumed-by';

      return 'not-subsumed';
    } catch (_error) {
      return 'not-subsumed';
    }
  }

  // ── doesFilter: support expressions=true|false ────────────────────

  async doesFilter(prop, op, value) {
    if (prop === 'expressions' && op === '=' && ['true', 'false'].includes(value)) {
      return true;
    }
    return super.doesFilter(prop, op, value);
  }

  // ── filterLocate / filterCheck: handle expression contexts ────────

  async filterLocate(filterContext, set, code) {
    // Try parent first — works for simple codes
    const result = await super.filterLocate(filterContext, set, code);
    if (result && typeof result !== 'string') return result;

    // If parent returned an error string, try as expression
    const exprResult = this.#tryLocateExpression(code);
    if (exprResult.context) {
      // Expression is valid — for "all codes" value sets, expressions composed
      // of valid concepts are considered members
      return exprResult.context;
    }
    return result; // Return original error
  }

  async filterCheck(filterContext, set, concept) {
    if (concept instanceof SnomedExpressionContext) {
      // Expressions composed of valid SNOMED concepts pass filter checks
      return true;
    }
    return super.filterCheck(filterContext, set, concept);
  }

  // ── isInactive / isAbstract / getStatus for expression contexts ───

  async isInactive(context) {
    if (context instanceof SnomedExpressionContext) {
      // Expressions are synthetic — always "active"
      if (context.isComplex()) return false;
      const code = this.#exprCode(context);
      const dbResult = await super.locate(code);
      return dbResult.context ? super.isInactive(dbResult.context) : false;
    }
    return super.isInactive(context);
  }

  async isAbstract(context) {
    if (context instanceof SnomedExpressionContext && context.isComplex()) return false;
    return super.isAbstract(context);
  }

  async getStatus(context) {
    if (context instanceof SnomedExpressionContext && context.isComplex()) return 'active';
    return super.getStatus(context);
  }
}

class SnomedSqliteV0Factory extends SqliteRuntimeV0FactoryProvider {
  async build(opContext, supplements) {
    if (!this._loaded) await this.load();
    this.recordUse();
    return new SnomedSqliteV0Provider(opContext, supplements, this._db, this._meta, this._runtime, {
      ownsDb: false,
      sharedState: this._sharedState,
      dbPath: this.dbPath
    });
  }
}

SqliteRuntimeV0FactoryProvider.registerSpecialization({
  id: 'snomed-expressions',
  systemPrefix: 'http://snomed.info/sct',
  tags: ['snomed'],
  priority: 100,
  FactoryClass: SnomedSqliteV0Factory
});

module.exports = { SnomedSqliteV0Provider, SnomedSqliteV0Factory };
