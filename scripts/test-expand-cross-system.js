#!/usr/bin/env node
'use strict';

/**
 * Comprehensive expandForValueSet tests: richer include/exclude combinations
 * and cross-system (RxNorm + LOINC) ValueSets.
 *
 * Tests exercise:
 *  - Filter-based excludes that fully cover, partially cover, or don't overlap includes
 *  - Multi-include with multi-exclude using filters on both sides
 *  - Cross-system ValueSets (RxNorm + LOINC includes, excludes across systems)
 *  - Edge cases: exclude superset of include, empty result sets, disjoint exclude
 *
 * Usage: node scripts/test-expand-cross-system.js [--full]
 */

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}/r4`;
const SERVER_START_TIMEOUT = 300000;
const LIBRARY_CONFIG = 'tx/tx.rxnorm-loinc.yml';
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

const RXSYS = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const LNSYS = 'http://loinc.org';

// --- Config patching ---
let origLibrarySource;

function patchConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  origLibrarySource = config.modules.tx.librarySource;
  config.modules.tx.librarySource = LIBRARY_CONFIG;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function restoreConfig() {
  if (!origLibrarySource) return;
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  config.modules.tx.librarySource = origLibrarySource;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Test helpers ---
function makeVS(compose) {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'valueSet', resource: { resourceType: 'ValueSet', compose } },
      ...(compose._params || []),
    ],
  };
}

// ============================================================
//  RxNorm-only: richer include/exclude patterns
//  Includes STY-based excludes which stress-test query planning —
//  if these hang, that's a real issue (blocks the event loop).
// ============================================================
const RXNORM_TESTS = [
  {
    name: 'rx-exclude-same-tty',
    desc: 'Include TTY=SBD, exclude TTY=SBD (full cover → 0 results)',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-exclude-disjoint-tty',
    desc: 'Include TTY=SBD, exclude TTY=IN (disjoint → no effect)',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'IN' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-exclude-partial-tty',
    desc: 'Include TTY in SBD,SCD, exclude TTY=SBD (partial → only SCD left)',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: 'in', value: 'SBD,SCD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-sty-exclude-overlapping',
    desc: 'Include TTY=SBD, exclude STY=T200 (cross-property partial overlap)',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-concepts-exclude-tty-filter',
    desc: '10 concepts include, exclude TTY=SBD (removes SBD members)',
    body: makeVS({
      include: [{ system: RXSYS, concept: [
        { code: '197381' }, { code: '197382' }, { code: '197383' },
        { code: '197384' }, { code: '197385' }, { code: '313782' },
        { code: '312961' }, { code: '312962' }, { code: '310798' },
        { code: '308056' },
      ]}],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
    }),
  },
  {
    name: 'rx-filter-exclude-20-concepts',
    desc: 'Include TTY=SCD, exclude 20 specific codes',
    drainCount: 20000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SCD' }] }],
      exclude: [{ system: RXSYS, concept: [
        { code: '197381' }, { code: '197382' }, { code: '197383' },
        { code: '197384' }, { code: '197385' }, { code: '197386' },
        { code: '197387' }, { code: '197388' }, { code: '197389' },
        { code: '197390' }, { code: '197391' }, { code: '197392' },
        { code: '197393' }, { code: '197394' }, { code: '197395' },
        { code: '197396' }, { code: '197397' }, { code: '197398' },
        { code: '197399' }, { code: '197400' },
      ]}],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-multi-include-sty+concepts-exclude',
    desc: 'SBD+SCD includes, exclude STY=T200 + 5 concepts',
    drainCount: 40000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SCD' }] },
      ],
      exclude: [
        { system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] },
        { system: RXSYS, concept: [
          { code: '197381' }, { code: '197382' }, { code: '197383' },
          { code: '197384' }, { code: '197385' },
        ]},
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-3-tty-include-2-tty-exclude',
    desc: 'Include TTY in SBD,SCD,GPCK, exclude TTY in SBD,GPCK',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: 'in', value: 'SBD,SCD,GPCK' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: 'in', value: 'SBD,GPCK' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
];

// ============================================================
//  LOINC-only: richer include/exclude patterns
// ============================================================
const LOINC_TESTS = [
  {
    name: 'ln-exclude-filter-partial',
    desc: 'Include CLASS=CHEM, exclude COMPONENT=Glucose (partial)',
    drainCount: 5000,
    body: makeVS({
      include: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }],
      exclude: [{ system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'Glucose' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'ln-exclude-same-filter',
    desc: 'Include CLASS=CHEM, exclude CLASS=CHEM (full cover → 0 results)',
    body: makeVS({
      include: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }],
      exclude: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'ln-exclude-disjoint',
    desc: 'Include CLASS=CHEM, exclude CLASS=MICRO (disjoint → no effect)',
    drainCount: 5000,
    body: makeVS({
      include: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }],
      exclude: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'MICRO' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'ln-concepts-exclude-filter',
    desc: '5 LOINC codes include, exclude CLASS=CHEM (removes CHEM members)',
    body: makeVS({
      include: [{ system: LNSYS, concept: [
        { code: '2339-0' }, { code: '2345-7' }, { code: '718-7' },
        { code: '4548-4' }, { code: '14749-6' },
      ]}],
      exclude: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }],
    }),
  },
  {
    name: 'ln-multi-include-multi-exclude',
    desc: 'CHEM + HEM/BC, exclude COMPONENT=Glucose + 3 concepts',
    drainCount: 8000,
    body: makeVS({
      include: [
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'HEM/BC' }] },
      ],
      exclude: [
        { system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'Glucose' }] },
        { system: LNSYS, concept: [{ code: '2339-0' }, { code: '2345-7' }, { code: '718-7' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
];

// ============================================================
//  Cross-system: RxNorm + LOINC in same ValueSet
// ============================================================
const CROSS_SYSTEM_TESTS = [
  {
    name: 'cross-rx-ln-include',
    desc: 'Include RxNorm TTY=SBD + LOINC CLASS=CHEM, count=10',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-rx-include-ln-exclude',
    desc: 'Include RxNorm TTY=SBD + LOINC CHEM, exclude LOINC COMPONENT=Glucose',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] },
      ],
      exclude: [
        { system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'Glucose' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-ln-include-rx-exclude',
    desc: 'Include LOINC CHEM + RxNorm SBD, exclude RxNorm STY=T200',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
      ],
      exclude: [
        { system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-concepts-both-systems',
    desc: 'Include 3 RxNorm concepts + 3 LOINC concepts',
    body: makeVS({
      include: [
        { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }, { code: '197383' }] },
        { system: LNSYS, concept: [{ code: '2339-0' }, { code: '2345-7' }, { code: '718-7' }] },
      ],
    }),
  },
  {
    name: 'cross-concepts-exclude-concepts',
    desc: '3 RxNorm + 3 LOINC concepts, exclude 1 from each system',
    body: makeVS({
      include: [
        { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }, { code: '197383' }] },
        { system: LNSYS, concept: [{ code: '2339-0' }, { code: '2345-7' }, { code: '718-7' }] },
      ],
      exclude: [
        { system: RXSYS, concept: [{ code: '197381' }] },
        { system: LNSYS, concept: [{ code: '718-7' }] },
      ],
    }),
  },
  {
    name: 'cross-filter-exclude-cross',
    desc: 'Include RxNorm SBD + LOINC CHEM, exclude both RxNorm T200 + LOINC Glucose',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] },
      ],
      exclude: [
        { system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] },
        { system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'Glucose' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-mixed-concepts-filters',
    desc: 'RxNorm concepts + LOINC filter, exclude LOINC concepts + RxNorm filter',
    body: makeVS({
      include: [
        { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }, { code: '313782' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'HEM/BC' }] },
      ],
      exclude: [
        { system: LNSYS, concept: [{ code: '718-7' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
];

// ============================================================
//  HTTP helpers (same as test-expand-for-valueset.js)
// ============================================================
function postJson(url, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpPost(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''),
      method: 'POST', headers: { 'Content-Length': 0 },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

async function waitForServer(url, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await httpGet(url);
      if (res.status === 200) return true;
    } catch (_) { /* not ready */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Server did not start within timeout');
}

function extractCodes(responseBody) {
  try {
    const json = JSON.parse(responseBody);
    if (!json.expansion || !json.expansion.contains) return [];
    return json.expansion.contains.map(c => ({
      code: c.code, display: c.display, system: c.system, inactive: c.inactive || false,
    }));
  } catch (_) { return null; }
}

function codesEqual(a, b) {
  if (a === null || b === null) return { match: false, reason: 'null' };
  if (a.length !== b.length) return { match: false, reason: `count ${a.length} vs ${b.length}` };
  let exact = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].code !== b[i].code || a[i].system !== b[i].system) { exact = false; break; }
  }
  if (exact) return { match: true, reason: 'exact' };
  const key = c => `${c.system}|${c.code}`;
  const setA = new Set(a.map(key));
  const setB = new Set(b.map(key));
  const sameSet = setA.size === setB.size && [...setA].every(c => setB.has(c));
  if (sameSet) return { match: true, reason: 'order differs' };
  return { match: false, reason: 'different codes' };
}

// ============================================================
//  Main runner
// ============================================================
function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

async function main() {
  const full = process.argv.includes('--full');
  const rxOnly = process.argv.includes('--rx');
  const lnOnly = process.argv.includes('--ln');
  const crossOnly = process.argv.includes('--cross');

  let testList;
  if (rxOnly) testList = RXNORM_TESTS;
  else if (lnOnly) testList = LOINC_TESTS;
  else if (crossOnly) testList = CROSS_SYSTEM_TESTS;
  else testList = [...RXNORM_TESTS, ...LOINC_TESTS, ...CROSS_SYSTEM_TESTS];

  const serverDir = path.resolve(__dirname, '..');

  log(`Running ${testList.length} tests`);
  log('Patching config for RxNorm+LOINC library...');
  patchConfig();

  let server;
  try {
    log(`Starting server on port ${PORT}...`);
    server = spawn('node', ['server.js'], {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});

    await waitForServer(`http://localhost:${PORT}/r4/metadata`, SERVER_START_TIMEOUT);
    log('Server ready.\n');

    await httpPost(`http://localhost:${PORT}/debug/perf-counters/enable`);

    const results = [];

    for (let ti = 0; ti < testList.length; ti++) {
      const test = testList[ti];
      const body = JSON.parse(JSON.stringify(test.body));
      if (body.parameter[0].resource.compose._params) {
        body.parameter.push(...body.parameter[0].resource.compose._params);
        delete body.parameter[0].resource.compose._params;
      }

      log(`[${ti+1}/${testList.length}] ${test.name}: ${test.desc}`);

      // OPTIMIZED
      await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=false`);
      const t0 = performance.now();
      let optRes;
      try { optRes = await postJson(BASE_URL + '/ValueSet/$expand', body); }
      catch (e) { optRes = { status: 'ERROR', body: e.message }; }
      const optMs = performance.now() - t0;
      const optCodes = typeof optRes.body === 'string' ? extractCodes(optRes.body) : null;

      // BASELINE (skip if test.skipBaseline — query blocks the event loop)
      let baseRes, baseTimeout = false, baseMs = 0, baseCodes = null, baseSkipped = false;
      if (test.skipBaseline) {
        baseSkipped = true;
        baseRes = { status: 'SKIP', body: '' };
      } else {
        await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=true`);
        const t1 = performance.now();
        try { baseRes = await postJson(BASE_URL + '/ValueSet/$expand', body); }
        catch (e) {
          baseTimeout = e.message === 'Request timed out';
          baseRes = { status: 'TIMEOUT', body: '' };
        }
        baseMs = performance.now() - t1;
        baseCodes = typeof baseRes.body === 'string' ? extractCodes(baseRes.body) : null;
      }

      const cmp = baseSkipped ? { match: null, reason: 'baseline skipped (blocks event loop)' }
        : baseTimeout ? { match: null, reason: 'baseline timeout' }
        : codesEqual(optCodes, baseCodes);
      const speedup = (baseSkipped || baseTimeout) ? Infinity : baseMs / optMs;

      const matchIcon = cmp.match === true ? '✅' : cmp.match === false ? '❌' : '⏱️';
      const baseLabel = baseSkipped ? 'SKIP' : baseTimeout ? 'TIMEOUT' : `${baseMs.toFixed(0)}ms`;
      log(`  Opt: ${optMs.toFixed(0)}ms (${optRes.status})  Base: ${baseLabel} (${baseRes.status})  ${speedup === Infinity ? '∞' : speedup.toFixed(1) + 'x'}  ${matchIcon} ${cmp.reason} opt:${optCodes?.length ?? '?'} base:${baseCodes?.length ?? '?'}`);

      // Drain for set comparison if needed
      let drainResult = null;
      if (test.drainCount && !baseTimeout && !baseSkipped && (!cmp.match || cmp.reason === 'order differs')) {
        log(`  Draining ${test.drainCount} codes...`);
        const drainBody = JSON.parse(JSON.stringify(body));
        drainBody.parameter = drainBody.parameter.filter(p => p.name !== 'count' && p.name !== 'offset');
        drainBody.parameter.push({ name: 'count', valueInteger: test.drainCount });

        await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=false`);
        const dOpt = await postJson(BASE_URL + '/ValueSet/$expand', drainBody, 30000);
        await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=true`);
        const dBase = await postJson(BASE_URL + '/ValueSet/$expand', drainBody, 30000);

        if (dOpt.status !== 200 || dBase.status !== 200) {
          drainResult = `HTTP error (opt:${dOpt.status} base:${dBase.status})`;
        } else {
          const key = c => `${c.system}|${c.code}`;
          const optAll = (extractCodes(dOpt.body) || []).map(key);
          const baseAll = (extractCodes(dBase.body) || []).map(key);
          const optSet = new Set(optAll);
          const baseSet = new Set(baseAll);
          const onlyOpt = [...optSet].filter(c => !baseSet.has(c));
          const onlyBase = [...baseSet].filter(c => !optSet.has(c));
          drainResult = (onlyOpt.length === 0 && onlyBase.length === 0)
            ? `sets equal (${optSet.size} codes)`
            : `sets differ (opt-only: ${onlyOpt.length}, base-only: ${onlyBase.length})`;
          if (onlyOpt.length > 0) log(`    opt-only: ${onlyOpt.slice(0,3).join(', ')}`);
          if (onlyBase.length > 0) log(`    base-only: ${onlyBase.slice(0,3).join(', ')}`);
        }
        log(`  Drain: ${drainResult}`);
      }
      log('');

      results.push({
        name: test.name, optMs: optMs.toFixed(1),
        baseMs: baseSkipped ? 'SKIP' : baseTimeout ? 'TIMEOUT' : baseMs.toFixed(1),
        speedup: speedup === Infinity ? '∞' : speedup.toFixed(1),
        match: cmp.match, reason: cmp.reason, drainResult, baseTimeout, baseSkipped,
        optCount: optCodes?.length ?? '?', baseCount: baseCodes?.length ?? '?',
      });
    }

    // Summary table
    const lines = [];
    lines.push('=== Cross-system expandForValueSet test results ===');
    lines.push(`Date: ${new Date().toISOString()}`);
    lines.push(`Tests: ${testList.length}`);
    lines.push('');
    lines.push('Test                               | Opt (ms) | Base (ms) | Speedup | Codes | Result');
    lines.push('-----------------------------------|----------|-----------|---------|-------|-------');
    for (const r of results) {
      const drainOk = r.drainResult && r.drainResult.startsWith('sets equal');
      const pass = r.match === true || drainOk;
      const icon = r.baseSkipped ? '⚠️' : r.baseTimeout ? '⏱️' : (pass ? '✅' : '❌');
      const detail = r.baseSkipped ? `baseline skipped — blocks event loop (opt: ${r.optCount} codes)`
        : r.baseTimeout ? `baseline timeout (opt OK: ${r.optCount} codes)`
        : (drainOk ? `page order differs, ${r.drainResult}` : r.reason);
      const speedCol = r.speedup === '∞' ? '     ∞ ' : `${r.speedup.padStart(6)}x`;
      lines.push(`${r.name.padEnd(35)}| ${r.optMs.padStart(8)} | ${r.baseMs.padStart(9)} | ${speedCol} | ${String(r.optCount).padStart(5)} | ${icon} ${detail}`);
    }

    console.log('\n' + lines.join('\n'));

    const outPath = path.join(serverDir, 'test-cross-system-results.txt');
    fs.writeFileSync(outPath, lines.join('\n') + '\n');
    log(`Results written to ${outPath}`);

  } finally {
    restoreConfig();
    if (server) {
      server.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

main().catch(err => {
  console.error(err);
  restoreConfig();
  process.exit(1);
});
