#!/usr/bin/env node
'use strict';

/**
 * Test expandForValueSet correctness and performance.
 *
 * Starts the server with lite config, runs RxNorm expansion requests with
 * and without the expandForValueSet bypass flag, compares results.
 *
 * Usage: node scripts/test-expand-for-valueset.js
 */

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}/r4`;
const SERVER_START_TIMEOUT = 300000;
const LITE_CONFIG = 'tx/tx.rxnorm-only.yml';

// --- Test cases ---
function makeVS(compose) {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'valueSet', resource: { resourceType: 'ValueSet', compose } },
      ...(compose._params || []),
    ],
  };
}

const RXSYS = 'http://www.nlm.nih.gov/research/umls/rxnorm';

const TESTS = [
  {
    name: 'filter-tty-sbd-10',
    desc: 'TTY=SBD, count=10',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'concept-5',
    desc: '5 explicit codes',
    body: makeVS({
      include: [{ system: RXSYS,
        concept: [{ code: '197381' }, { code: '197382' }, { code: '197383' }, { code: '197384' }, { code: '197385' }]
      }],
    }),
  },
  {
    name: 'exclude-concepts-3',
    desc: 'TTY=SBD, 3 concept excludes, count=10',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      exclude: [{ system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }, { code: '197383' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'multi-include-2',
    desc: 'TTY=SBD + TTY=SCD, count=10',
    drainCount: 40000, // must exceed total SBD+SCD (~37k) for valid set comparison
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SCD' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'activeonly-sbd',
    desc: 'TTY=SBD, activeOnly, count=10',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }, { name: 'activeOnly', valueBoolean: true }],
    }),
  },
];

// --- EXTENDED tests (add with --full flag) ---
const EXTENDED_TESTS = [
  {
    name: 'filter-tty-in-multi',
    desc: 'TTY in SBD,SCD, count=10',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: 'in', value: 'SBD,SCD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'filter-sty-t200',
    desc: 'STY=T200, count=10',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'paged-offset-100',
    desc: 'TTY=SBD, offset=100, count=10',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }, { name: 'offset', valueInteger: 100 }],
    }),
  },
  {
    name: 'text-aspirin',
    desc: 'TTY=SBD, filter=aspirin, count=10',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }, { name: 'filter', valueString: 'aspirin' }],
    }),
  },
  {
    name: 'exclude-filter',
    desc: 'TTY=SBD, exclude TTY=SBDC, count=10',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBDC' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'multi-include-concept+filter',
    desc: 'Concepts + TTY=SBD filter, count=10',
    drainCount: 25000,
    body: makeVS({
      include: [
        { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'combo-active-text-paged',
    desc: 'TTY=SBD, activeOnly, filter=tablet, offset=10, count=5',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [
        { name: 'count', valueInteger: 5 }, { name: 'offset', valueInteger: 10 },
        { name: 'activeOnly', valueBoolean: true }, { name: 'filter', valueString: 'tablet' },
      ],
    }),
  },
  {
    name: 'multi-include-multi-exclude',
    desc: 'SBD+SCD, exclude 3 concepts + SBDC, count=10',
    drainCount: 40000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SCD' }] },
      ],
      exclude: [
        { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }, { code: '197383' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBDC' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
];

// --- HTTP helpers ---
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
    } catch (e) { /* not ready */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Server did not start within timeout');
}

function extractCodes(responseBody) {
  try {
    const json = JSON.parse(responseBody);
    if (!json.expansion || !json.expansion.contains) return [];
    return json.expansion.contains.map(c => ({
      code: c.code,
      display: c.display,
      system: c.system,
      inactive: c.inactive || false,
    }));
  } catch (e) {
    return null;
  }
}

function codesEqual(a, b) {
  if (a === null || b === null) return { match: false, reason: 'null' };
  if (a.length !== b.length) return { match: false, reason: `count ${a.length} vs ${b.length}` };
  // Check exact positional match
  let exact = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].code !== b[i].code) { exact = false; break; }
  }
  if (exact) return { match: true, reason: 'exact' };
  // Check set match (same codes, different order)
  const setA = new Set(a.map(c => c.code));
  const setB = new Set(b.map(c => c.code));
  const sameSet = setA.size === setB.size && [...setA].every(c => setB.has(c));
  if (sameSet) return { match: true, reason: 'order differs' };
  return { match: false, reason: 'different codes' };
}

// --- Main ---
function log(msg) {
  console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`);
}

async function main() {
  const full = process.argv.includes('--full');
  const testList = full ? [...TESTS, ...EXTENDED_TESTS] : TESTS;
  const serverDir = path.resolve(__dirname, '..');

  log(`Running ${testList.length} tests (${full ? 'full' : 'core'} mode, pass --full for all)`);
  log(`Using library: ${LITE_CONFIG}`);

  let server;
  try {
    log(`Starting server on port ${PORT}...`);
    server = spawn('node', ['server.js'], {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test', TX_LIBRARY_SOURCE: LITE_CONFIG },
    });

    let serverOutput = '';
    server.stdout.on('data', d => { serverOutput += d.toString(); });
    server.stderr.on('data', d => { serverOutput += d.toString(); });

    await waitForServer(`http://localhost:${PORT}/r4/metadata`, SERVER_START_TIMEOUT);
    log('Server ready.\n');

    // Enable perf counters
    await httpPost(`http://localhost:${PORT}/debug/perf-counters/enable`);

    const results = [];
    const ITERS = 2;

    for (let ti = 0; ti < testList.length; ti++) {
      const test = testList[ti];
      // Fix up the body: move _params to top level
      const body = JSON.parse(JSON.stringify(test.body));
      if (body.parameter[0].resource.compose._params) {
        body.parameter.push(...body.parameter[0].resource.compose._params);
        delete body.parameter[0].resource.compose._params;
      }

      log(`[${ti+1}/${testList.length}] ${test.name}: ${test.desc}`);

      // Run OPTIMIZED (expandForValueSet enabled)
      await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=false`);
      await httpPost(`http://localhost:${PORT}/debug/perf-counters/reset`);

      const timesOpt = [];
      let optCodes, optStatus;
      for (let i = 0; i < ITERS; i++) {
        log(`  opt iter ${i+1}/${ITERS}...`);
        const t0 = performance.now();
        const res = await postJson(BASE_URL + '/ValueSet/$expand', body);
        const elapsed = performance.now() - t0;
        timesOpt.push(elapsed);
        log(`  opt iter ${i+1}: ${elapsed.toFixed(0)}ms, HTTP ${res.status}`);
        if (i === 0) { optCodes = extractCodes(res.body); optStatus = res.status; }
      }
      const cOpt = JSON.parse((await httpGet(`http://localhost:${PORT}/debug/perf-counters`)).body);

      // Run BASELINE (expandForValueSet bypassed)
      await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=true`);
      await httpPost(`http://localhost:${PORT}/debug/perf-counters/reset`);

      const timesBase = [];
      let baseCodes, baseStatus;
      let baseTimeout = false;
      for (let i = 0; i < ITERS; i++) {
        if (baseTimeout) break; // don't repeat after timeout
        log(`  base iter ${i+1}/${ITERS}...`);
        const t0 = performance.now();
        try {
          const res = await postJson(BASE_URL + '/ValueSet/$expand', body);
          const elapsed = performance.now() - t0;
          timesBase.push(elapsed);
          log(`  base iter ${i+1}: ${elapsed.toFixed(0)}ms, HTTP ${res.status}`);
          if (i === 0) { baseCodes = extractCodes(res.body); baseStatus = res.status; }
        } catch (e) {
          const elapsed = performance.now() - t0;
          if (e.message === 'Request timed out') {
            timesBase.push(elapsed);
            log(`  base iter ${i+1}: TIMEOUT after ${elapsed.toFixed(0)}ms`);
            baseTimeout = true;
            if (i === 0) { baseCodes = null; baseStatus = 'TIMEOUT'; }
          } else {
            throw e;
          }
        }
      }
      const cBase = JSON.parse((await httpGet(`http://localhost:${PORT}/debug/perf-counters`)).body);

      // Compare
      timesOpt.sort((a, b) => a - b);
      timesBase.sort((a, b) => a - b);
      const medOpt = timesOpt[Math.floor(timesOpt.length / 2)];
      const medBase = timesBase[Math.floor(timesBase.length / 2)];
      const cmp = baseTimeout
        ? { match: null, reason: 'baseline timeout' }
        : codesEqual(optCodes, baseCodes);
      const speedup = medBase / medOpt;

      const statusNote = (optStatus !== 200 || (baseStatus !== 200 && baseStatus !== 'TIMEOUT'))
        ? ` [HTTP opt:${optStatus} base:${baseStatus}]` : '';

      const matchIcon = cmp.match === true ? '✅' : cmp.match === false ? '❌' : '⏱️';
      const baseLabel = baseTimeout ? 'TIMEOUT' : `${medBase.toFixed(1)}ms`;
      log(`  Optimized: ${medOpt.toFixed(1)}ms  |  Baseline: ${baseLabel}  |  Speedup: ${baseTimeout ? '∞' : speedup.toFixed(1) + 'x'}${statusNote}`);
      log(`  Codes: ${matchIcon} ${cmp.reason} (opt: ${optCodes?.length ?? '?'}, base: ${baseCodes?.length ?? '?'})`);

      if (!cmp.match && optCodes && baseCodes) {
        const maxShow = Math.min(5, Math.max(optCodes.length, baseCodes.length));
        for (let i = 0; i < maxShow; i++) {
          const o = optCodes[i]; const b = baseCodes[i];
          if (!o || !b || o.code !== b.code || o.display !== b.display) {
            log(`    [${i}] opt: ${o?.code}/${o?.display?.substring(0,40)} | base: ${b?.code}/${b?.display?.substring(0,40)}`);
          }
        }
      }

      const handled = cOpt.counters?.['expandForValueSet.handled'] || 0;
      const fallback = cOpt.counters?.['expandForValueSet.fallback'] || 0;
      log(`  Counters: handled=${handled}, fallback=${fallback}`);

      // Full-drain set comparison: fetch ALL codes from both paths, compare as sets
      let drainResult = null;
      if (test.drainCount && !baseTimeout && (!cmp.match || cmp.reason === 'order differs')) {
        log(`  Draining up to ${test.drainCount} codes for full set comparison...`);
        const drainBody = JSON.parse(JSON.stringify(body));
        // Replace count/offset/limit params for full drain
        drainBody.parameter = drainBody.parameter.filter(p =>
          p.name !== 'count' && p.name !== 'offset' && p.name !== 'limit');
        drainBody.parameter.push({ name: 'count', valueInteger: test.drainCount });
        drainBody.parameter.push({ name: 'limit', valueInteger: test.drainCount });

        await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=false`);
        const drainOpt = await postJson(BASE_URL + '/ValueSet/$expand', drainBody, 120000);
        await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=true`);
        const drainBase = await postJson(BASE_URL + '/ValueSet/$expand', drainBody, 120000);

        if (drainOpt.status !== 200 || drainBase.status !== 200) {
          drainResult = `HTTP error (opt:${drainOpt.status} base:${drainBase.status})`;
          log(`  Drain failed: ${drainResult}`);
        } else {
          const optCodes2 = extractCodes(drainOpt.body) || [];
          const baseCodes2 = extractCodes(drainBase.body) || [];
          const optSet = new Set(optCodes2.map(c => c.code));
          const baseSet = new Set(baseCodes2.map(c => c.code));
          const onlyOpt = [...optSet].filter(c => !baseSet.has(c));
          const onlyBase = [...baseSet].filter(c => !optSet.has(c));
          const setsEqual = onlyOpt.length === 0 && onlyBase.length === 0;
          drainResult = setsEqual
            ? `sets equal (${optSet.size} codes)`
            : `sets differ (opt-only: ${onlyOpt.length}, base-only: ${onlyBase.length})`;
          log(`  Drain: opt=${optSet.size} base=${baseSet.size} → ${drainResult}`);
          if (!setsEqual && onlyOpt.length > 0) log(`    opt-only sample: ${onlyOpt.slice(0,5).join(', ')}`);
          if (!setsEqual && onlyBase.length > 0) log(`    base-only sample: ${onlyBase.slice(0,5).join(', ')}`);
        }
      }
      log('');

      results.push({ name: test.name, medOpt: medOpt.toFixed(1),
        medBase: baseTimeout ? 'TIMEOUT' : medBase.toFixed(1),
        speedup: baseTimeout ? '∞' : speedup.toFixed(1),
        match: cmp.match, reason: cmp.reason,
        drainResult, baseTimeout,
        optCount: optCodes?.length ?? '?', baseCount: baseCodes?.length ?? '?' });
    }

    // Summary
    const lines = [];
    lines.push('=== expandForValueSet test results ===');
    lines.push(`Date: ${new Date().toISOString()}`);
    lines.push(`Tests: ${testList.length} (${full ? 'full' : 'core'})`);
    lines.push('');
    lines.push('Test                          | New (ms) | Old (ms) | Speedup | Codes | Result');
    lines.push('------------------------------|----------|----------|---------|-------|-------');
    for (const r of results) {
      const drainOk = r.drainResult && r.drainResult.startsWith('sets equal');
      const pass = r.match === true || drainOk;
      const icon = r.baseTimeout ? '⏱️' : (pass ? '✅' : '❌');
      const detail = r.baseTimeout ? `baseline timeout (opt OK: ${r.optCount} codes)`
        : (drainOk ? `page order differs, ${r.drainResult}` : r.reason);
      const speedCol = typeof r.speedup === 'string' && r.speedup === '∞' ? '    ∞ ' : `${r.speedup.padStart(5)}x `;
      lines.push(`${r.name.padEnd(30)}| ${r.medOpt.padStart(8)} | ${r.medBase.padStart(8)} | ${speedCol} | ${String(r.optCount).padStart(5)} | ${icon} ${detail}`);
    }

    console.log('\n' + lines.join('\n'));

    const outPath = path.join(serverDir, 'test-expand-results.txt');
    fs.writeFileSync(outPath, lines.join('\n') + '\n');
    log(`Results written to ${outPath}`);

  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
