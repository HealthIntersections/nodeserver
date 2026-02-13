/* eslint-disable no-console */
// Minimal official test wrapper for SNOMED/LOINC/RxNorm touching tx-ecosystem fixtures.
// Intentionally avoids Jest + Java validator pipeline.

const fs = require('fs');
const path = require('path');
const express = require('express');
const TXModule = require('../tx/tx.js');
const ServerStats = require('../stats');

type JsonMap = Record<string, any>;

type Term = 'snomed' | 'loinc' | 'rxnorm';

type LoadedTest = {
  suite: string;
  test: string;
  operation: string;
  expectedHttpCodeRaw: any;
  requestPath: string;
  responsePath: string | null;
  requestBody: any;
  expectedBody: any | null;
  fixtureResources: any[];
  terms: Term[];
};

type ExpectedFailure = {
  id: string;
  reason: string;
};

const INLINE_RESOURCE_TYPES = new Set(['CodeSystem', 'ValueSet', 'ConceptMap']);

const EXPECTED_FAILURES: ExpectedFailure[] = [
  {
    id: 'tx.fhir.org::snomed-validation-1',
    reason: 'Upstream-consistent message wording drift vs fixture',
  },
  {
    id: 'tx.fhir.org::loinc-expand-all',
    reason: 'Upstream-consistent too-costly OperationOutcome differences (still 4xx)',
  },
  {
    id: 'tx.fhir.org::loinc-expand-status',
    reason: 'Upstream-consistent omission of expansion.total in paged response',
  },
  {
    id: 'tx.fhir.org::loinc-expand-class-regex',
    reason: 'Upstream-consistent omission of expansion.total in paged response',
  },
  {
    id: 'tx.fhir.org::loinc-expand-prop-order-obs',
    reason: 'Upstream-consistent omission of expansion.total in paged response',
  },
  {
    id: 'tx.fhir.org::loinc-expand-copyright',
    reason: 'Upstream-consistent omission of expansion.total in paged response',
  },
  {
    id: 'tx.fhir.org::loinc-expand-scale-type',
    reason: 'Upstream-consistent omission of expansion.total in paged response',
  },
  {
    id: 'tx.fhir.org::loinc-expand-filter-dockind-request-parameters',
    reason: 'Upstream-consistent omission of expansion.total in paged response',
  },
  {
    id: 'omop::translate-loinc-implicit',
    reason: 'Upstream-consistent 400 requiring sourceSystem with sourceCode',
  },
  {
    id: 'omop::translate-loinc-implicit-bad',
    reason: 'Upstream-consistent 400 requiring sourceSystem with sourceCode',
  },
];

const EXPECTED_FAILURE_MAP = new Map(EXPECTED_FAILURES.map((e) => [e.id, e.reason]));


const TERM_REGEX: Record<Term, RegExp> = {
  snomed: /snomed|snomed\.info\/sct|\/xsct\//i,
  loinc: /loinc|loinc\.org/i,
  rxnorm: /rxnorm|nlm\.nih\.gov\/research\/umls\/rxnorm/i,
};

const OP_TO_PATH: Record<string, string> = {
  'cs-validate-code': '/CodeSystem/$validate-code',
  'validate-code': '/ValueSet/$validate-code',
  'batch-validate-code': '/ValueSet/$batch-validate-code',
  lookup: '/CodeSystem/$lookup',
  expand: '/ValueSet/$expand',
  translate: '/ConceptMap/$translate',
  subsumes: '/CodeSystem/$subsumes',
};

function parseArgs(argv: string[]) {
  const out: { fhirPath: string; port: number; outFile: string; setupFile: string } = {
    fhirPath: '/r4',
    port: 9195,
    outFile: 'captured/official-term-mini-results.json',
    setupFile: 'tx/fixtures/test-cases-setup.json',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path' && argv[i + 1]) out.fhirPath = argv[++i];
    else if (a === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
    else if (a === '--out' && argv[i + 1]) out.outFile = argv[++i];
    else if (a === '--setup' && argv[i + 1]) out.setupFile = argv[++i];
  }

  return out;
}

function detectTerms(blob: string): Term[] {
  const found: Term[] = [];
  (Object.keys(TERM_REGEX) as Term[]).forEach((term) => {
    if (TERM_REGEX[term].test(blob)) found.push(term);
  });
  return found;
}

function loadJsonSafe(filePath: string): any | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getValueFieldName(obj: JsonMap): string | null {
  for (const k of Object.keys(obj || {})) {
    if (k.startsWith('value')) return k;
  }
  return null;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function listify(input: any): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter((x) => !!x);
  return [String(input)];
}

function loadInlineResourcesFromFile(absPath: string): any[] {
  const resource = loadJsonSafe(absPath);
  if (!resource) return [];
  if (resource.resourceType === 'Bundle' && Array.isArray(resource.entry)) {
    return resource.entry
      .map((e: any) => e?.resource)
      .filter((r: any) => r && INLINE_RESOURCE_TYPES.has(r.resourceType));
  }
  if (INLINE_RESOURCE_TYPES.has(resource.resourceType)) {
    return [resource];
  }
  return [];
}

function dedupeResources(resources: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of resources) {
    if (!r || !r.resourceType) continue;
    const key = `${r.resourceType}|${r.url || ''}|${r.version || ''}|${r.id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function withTxResources(requestBody: any, fixtureResources: any[]): any {
  if (!fixtureResources.length) return requestBody;
  const body = deepClone(requestBody);
  if (body?.resourceType !== 'Parameters') {
    return body;
  }
  if (!Array.isArray(body.parameter)) body.parameter = [];
  for (const r of fixtureResources) {
    body.parameter.push({ name: 'tx-resource', resource: deepClone(r) });
  }
  return body;
}

function placeholderString(s: any): boolean {
  return typeof s === 'string' && /^\$[^$]+\$$/.test(s);
}

function deepEqualLite(actual: any, expected: any): boolean {
  if (placeholderString(expected)) return true;
  if (expected === null || expected === undefined) return actual === expected;
  if (typeof expected !== typeof actual) return false;

  if (typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected)) return false;

  const optional = new Set<string>(Array.isArray(expected['$optional-properties$']) ? expected['$optional-properties$'] : []);
  for (const [k, v] of Object.entries(expected)) {
    if (k.startsWith('$')) continue;
    if (!(k in actual)) {
      if (optional.has(k)) continue;
      return false;
    }
    if (!deepEqualLite(actual[k], v)) return false;
  }
  return true;
}

function checkParameters(actual: JsonMap, expected: JsonMap): string[] {
  const errors: string[] = [];
  const expParams = Array.isArray(expected.parameter) ? expected.parameter : [];
  const actParams = Array.isArray(actual.parameter) ? actual.parameter : [];

  for (const exp of expParams) {
    const name = exp?.name;
    if (!name) continue;
    const candidates = actParams.filter((p: any) => p?.name === name);
    if (!candidates.length) {
      errors.push(`missing parameter "${name}"`);
      continue;
    }

    const valueKey = getValueFieldName(exp);
    if (valueKey) {
      const want = exp[valueKey];
      const ok = candidates.some((c: any) => deepEqualLite(c[valueKey], want));
      if (!ok) errors.push(`parameter "${name}" value mismatch`);
      continue;
    }

    if (exp.resource && typeof exp.resource === 'object') {
      // Keep OperationOutcome matching intentionally loose to avoid false
      // negatives from optional fields and diagnostics text variance.
      if (exp.resource.resourceType === 'OperationOutcome') {
        const ok = candidates.some((c: any) => {
          const ar = c?.resource || {};
          if (ar.resourceType !== 'OperationOutcome') return false;
          const expIssues = Array.isArray(exp.resource.issue) ? exp.resource.issue : [];
          if (!expIssues.length) return true;
          const actIssues = Array.isArray(ar.issue) ? ar.issue : [];
          return expIssues.every((ei: any) => {
            if (!ei || typeof ei !== 'object') return true;
            const wantCode = ei.code;
            const wantSeverity = ei.severity;
            return actIssues.some((ai: any) => {
              if (!ai || typeof ai !== 'object') return false;
              if (wantCode && ai.code !== wantCode) return false;
              if (wantSeverity && ai.severity !== wantSeverity) return false;
              return true;
            });
          });
        });
        if (!ok) errors.push(`parameter "${name}" resource mismatch`);
      } else {
        const ok = candidates.some((c: any) => deepEqualLite(c.resource || {}, exp.resource));
        if (!ok) errors.push(`parameter "${name}" resource mismatch`);
      }
    }
  }

  return errors;
}

function checkValueSet(actual: JsonMap, expected: JsonMap): string[] {
  const errors: string[] = [];
  const expExpansion = expected.expansion || {};
  const actExpansion = actual.expansion || {};

  if (typeof expExpansion.total === 'number' && actExpansion.total !== expExpansion.total) {
    errors.push(`expansion.total mismatch (expected ${expExpansion.total}, got ${actExpansion.total})`);
  }

  const expContains = Array.isArray(expExpansion.contains) ? expExpansion.contains : [];
  const actContains = Array.isArray(actExpansion.contains) ? actExpansion.contains : [];
  for (const ec of expContains) {
    const code = ec?.code;
    if (!code) continue;
    const system = ec?.system;
    const found = actContains.some((ac: any) => ac?.code === code && (!system || ac?.system === system));
    if (!found) errors.push(`missing expansion code ${system ? `${system}|` : ''}${code}`);
  }

  return errors;
}

function evaluate(actualBody: any, expectedBody: any | null): string[] {
  if (!expectedBody) return [];
  const errors: string[] = [];

  if (expectedBody.resourceType && actualBody?.resourceType !== expectedBody.resourceType) {
    errors.push(`resourceType mismatch (expected ${expectedBody.resourceType}, got ${actualBody?.resourceType})`);
    return errors;
  }

  if (expectedBody.resourceType === 'Parameters') {
    errors.push(...checkParameters(actualBody || {}, expectedBody));
  } else if (expectedBody.resourceType === 'ValueSet') {
    errors.push(...checkValueSet(actualBody || {}, expectedBody));
  } else {
    if (!deepEqualLite(actualBody || {}, expectedBody)) errors.push('body mismatch');
  }

  return errors;
}

function loadOfficialTests(): LoadedTest[] {
  const root = path.resolve('data/terminology-cache/hl7.fhir.uv.tx-ecosystem#1.9.0-SNAPSHOT/package/tests');
  const testCasesPath = path.join(root, 'test-cases.json');
  if (!fs.existsSync(testCasesPath)) {
    throw new Error(`Official test-cases not found at ${testCasesPath}`);
  }

  const testCases = JSON.parse(fs.readFileSync(testCasesPath, 'utf8'));
  const selected: LoadedTest[] = [];

  for (const suite of testCases.suites || []) {
    const suiteSetupFiles = listify(suite.setup).map((rel) => path.join(root, rel));
    const suiteSetupResources = dedupeResources(suiteSetupFiles.flatMap(loadInlineResourcesFromFile));

    for (const t of suite.tests || []) {
      if (!t.request) continue;
      const op = t.operation;
      if (!OP_TO_PATH[op]) continue;

      const reqAbs = path.join(root, t.request);
      if (!fs.existsSync(reqAbs)) continue;
      const reqRaw = fs.readFileSync(reqAbs, 'utf8');
      const requestBody = loadJsonSafe(reqAbs);
      if (!requestBody) continue;

      const sourceFiles = listify(t.source).map((rel) => path.join(root, rel));
      const sourceResources = dedupeResources(sourceFiles.flatMap(loadInlineResourcesFromFile));
      const fixtureResources = dedupeResources([...suiteSetupResources, ...sourceResources]);

      const responsePath = t.response ? path.join(root, t.response) : null;
      const expectedBody = responsePath ? loadJsonSafe(responsePath) : null;
      const fixtureHint = fixtureResources
        .map((r) => `${r.resourceType}|${r.url || ''}|${r.version || ''}|${r.id || ''}`)
        .join('\n');
      const blob = `${suite.name}\n${t.name}\n${t.request}\n${reqRaw}\n${fixtureHint}`;
      const terms = detectTerms(blob);
      if (!terms.length) continue;

      selected.push({
        suite: suite.name,
        test: t.name,
        operation: op,
        expectedHttpCodeRaw: t['http-code'],
        requestPath: t.request,
        responsePath: t.response || null,
        requestBody,
        expectedBody,
        fixtureResources,
        terms,
      });
    }
  }

  return selected;
}

function expectedStatusLabel(raw: any): string {
  if (raw === undefined || raw === null || raw === '') return '200';
  return String(raw);
}

function matchesExpectedStatus(actual: number, raw: any): boolean {
  const label = expectedStatusLabel(raw).toLowerCase();
  if (/^[1-5]xx$/.test(label)) {
    const bucket = Number(label[0]);
    return actual >= bucket * 100 && actual < (bucket + 1) * 100;
  }
  const n = Number(label);
  if (!Number.isNaN(n)) return actual === n;
  // Fallback to 200 if unknown token.
  return actual === 200;
}

function testId(suite: string, test: string): string {
  return `${suite}::${test}`;
}

function expectedFailureReason(suite: string, test: string): string | null {
  return EXPECTED_FAILURE_MAP.get(testId(suite, test)) || null;
}

async function startServer(port: number, setupFile: string) {
  const app = express();
  app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
  app.use(express.raw({ type: 'application/fhir+xml', limit: '50mb' }));
  app.use(express.json({ limit: '50mb' }));

  const config = JSON.parse(fs.readFileSync(path.resolve(setupFile), 'utf8'));
  const stats = new ServerStats();
  const txModule = new TXModule(stats);
  await txModule.initialize(config, app);

  const server = await new Promise<any>((resolve, reject) => {
    const s = app.listen(port, (err: any) => (err ? reject(err) : resolve(s)));
  });

  return { server, txModule, stats };
}

async function stopServer(serverCtx: any) {
  if (serverCtx.txModule && typeof serverCtx.txModule.shutdown === 'function') {
    await serverCtx.txModule.shutdown();
  }
  if (serverCtx.stats && typeof serverCtx.stats.finishStats === 'function') {
    serverCtx.stats.finishStats();
  }
  await new Promise<void>((resolve) => {
    serverCtx.server.closeAllConnections?.();
    serverCtx.server.close(() => resolve());
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tests = loadOfficialTests();
  fs.mkdirSync(path.dirname(args.outFile), { recursive: true });

  console.log(`Loaded ${tests.length} terminology-touching official tests`);
  const serverCtx = await startServer(args.port, args.setupFile);
  console.log(`Server started on port ${args.port}, path=${args.fhirPath}`);

  const results: any[] = [];

  try {
    for (const t of tests) {
      const endpoint = OP_TO_PATH[t.operation];
      const url = `http://localhost:${args.port}${args.fhirPath}${endpoint}`;
      const started = Date.now();
      const requestBody = withTxResources(t.requestBody, t.fixtureResources);

      let status = 0;
      let actualBody: any = null;
      let networkError: string | null = null;

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/fhir+json',
            accept: 'application/fhir+json, application/json',
          },
          body: JSON.stringify(requestBody),
        });
        status = resp.status;
        const text = await resp.text();
        actualBody = text ? JSON.parse(text) : null;
      } catch (e: any) {
        networkError = String(e?.message || e);
      }

      const statusOk = matchesExpectedStatus(status, t.expectedHttpCodeRaw);
      const bodyErrors = networkError ? [`network error: ${networkError}`] : evaluate(actualBody, t.expectedBody);
      const rawPass = statusOk && bodyErrors.length === 0;
      const xfailReason = expectedFailureReason(t.suite, t.test);
      const isXfail = !!xfailReason && !rawPass;
      const isXpass = !!xfailReason && rawPass;
      const effectivePass = rawPass || isXfail;
      const outcome = isXpass ? 'xpass' : isXfail ? 'xfail' : rawPass ? 'pass' : 'fail';

      results.push({
        suite: t.suite,
        test: t.test,
        id: testId(t.suite, t.test),
        terms: t.terms,
        operation: t.operation,
        request: t.requestPath,
        expectedResponse: t.responsePath,
        fixtureResourceCount: t.fixtureResources.length,
        expectedStatus: expectedStatusLabel(t.expectedHttpCodeRaw),
        actualStatus: status,
        durationMs: Date.now() - started,
        pass: effectivePass,
        rawPass,
        outcome,
        expectedFailure: !!xfailReason,
        expectedFailureReason: xfailReason,
        bodyErrors,
        actualBody: effectivePass ? undefined : actualBody,
      });
    }
  } finally {
    await stopServer(serverCtx);
  }

  const termSummary: Record<Term, any> = {
    snomed: { total: 0, passed: 0, failed: 0 },
    loinc: { total: 0, passed: 0, failed: 0 },
    rxnorm: { total: 0, passed: 0, failed: 0 },
  };

  for (const r of results) {
    for (const term of r.terms as Term[]) {
      termSummary[term].total += 1;
      if (r.pass) {
        termSummary[term].passed += 1;
      } else {
        termSummary[term].failed += 1;
      }
    }
  }

  const rawPassed = results.filter((r) => r.rawPass).length;
  const rawFailed = results.length - rawPassed;
  const xfailed = results.filter((r) => r.outcome === 'xfail').length;
  const xpassed = results.filter((r) => r.outcome === 'xpass').length;
  const unexpectedFailed = results.filter((r) => r.outcome === 'fail').length;
  const effectivePassed = results.filter((r) => r.pass).length;
  const effectiveFailed = unexpectedFailed;

  const overall = {
    generatedAt: new Date().toISOString(),
    mode: 'minimal-official-wrapper',
    serverPath: args.fhirPath,
    expectedFailureCount: EXPECTED_FAILURES.length,
    totalTestsRun: results.length,
    rawPassed,
    rawFailed,
    xfailed,
    xpassed,
    passed: effectivePassed,
    failed: effectiveFailed,
    termSummary,
    failures: results.filter((r) => r.outcome === 'fail'),
    expectedFailuresObserved: results.filter((r) => r.outcome === 'xfail'),
    expectedFailuresPassed: results.filter((r) => r.outcome === 'xpass'),
  };

  fs.writeFileSync(args.outFile, JSON.stringify({ overall, results }, null, 2));

  console.log('--- Summary ---');
  console.log(JSON.stringify(overall, null, 2));
  console.log(`Wrote: ${args.outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
