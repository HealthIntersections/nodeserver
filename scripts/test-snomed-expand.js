#!/usr/bin/env node
'use strict';

/**
 * 3-way SNOMED CT expansion benchmark:
 *   1. SQLite v0 + expandForValueSet (optimized)
 *   2. SQLite v0 with expandForValueSet bypassed (v0 baseline)
 *   3. Legacy in-memory binary provider (upstream baseline)
 *
 * Usage: node scripts/test-snomed-expand.js [--full]
 */

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}/r4`;
const SERVER_START_TIMEOUT = 300000;
const REQUEST_TIMEOUT = 60000;
const V0_CONFIG = 'tx/tx.snomed-v0-only.yml';
const LEGACY_CONFIG = 'tx/tx.snomed-legacy-only.yml';
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

// --- Config patching ---
let origLibrarySource;

function patchConfig(librarySource) {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!origLibrarySource) origLibrarySource = config.modules.tx.librarySource;
  config.modules.tx.librarySource = librarySource;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function restoreConfig() {
  if (!origLibrarySource) return;
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  config.modules.tx.librarySource = origLibrarySource;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

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

const SCT = 'http://snomed.info/sct';

const TESTS = [
  {
    name: 'is-a-diabetes',
    desc: 'is-a 73211009 (Diabetes mellitus)',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }],
      _params: [{ name: 'count', valueInteger: 200 }],
    }),
  },
  {
    name: 'concept-3',
    desc: '3 explicit SNOMED codes',
    body: makeVS({
      include: [{ system: SCT,
        concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }]
      }],
    }),
  },
  {
    name: 'descendent-of-diabetes',
    desc: 'descendent-of 73211009 (excludes self)',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: 'descendent-of', value: '73211009' }] }],
      _params: [{ name: 'count', valueInteger: 200 }],
    }),
  },
  {
    name: 'is-a-clinical-finding-100',
    desc: 'is-a 404684003 (Clinical finding), count=100',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },
  {
    name: 'exclude-concept',
    desc: 'is-a 73211009, exclude 44054006',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }],
      exclude: [{ system: SCT, concept: [{ code: '44054006' }] }],
      _params: [{ name: 'count', valueInteger: 200 }],
    }),
  },
];

const EXTENDED_TESTS = [
  {
    name: 'is-a-clinical-paged',
    desc: 'is-a 404684003, offset=5000, count=100',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }],
      _params: [{ name: 'count', valueInteger: 100 }, { name: 'offset', valueInteger: 5000 }],
    }),
  },
  {
    name: 'is-a-procedure-100',
    desc: 'is-a 71388002 (Procedure), count=100',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '71388002' }] }],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },
  {
    name: 'is-a-body-structure',
    desc: 'is-a 123037004 (Body structure), count=100',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '123037004' }] }],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },
  {
    name: 'refset-laterality',
    desc: 'concept in 723264001 (laterality refset), count=100',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: 'in', value: '723264001' }] }],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },
  {
    name: 'exclude-is-a-filter',
    desc: 'is-a 73211009, exclude is-a 44054006 (Type II subtree)',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }],
      exclude: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] }],
      _params: [{ name: 'count', valueInteger: 200 }],
    }),
  },
  {
    name: 'multi-include',
    desc: 'is-a Diabetes + is-a Hypertension, count=100',
    drainCount: 1500,
    body: makeVS({
      include: [
        { system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
        { system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '38341003' }] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },
  {
    name: 'activeonly',
    desc: 'is-a 73211009, activeOnly',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }],
      _params: [{ name: 'count', valueInteger: 200 }, { name: 'activeOnly', valueBoolean: true }],
    }),
  },
  {
    name: 'concept-equals',
    desc: 'concept = 73211009 (single code via filter)',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: '=', value: '73211009' }] }],
    }),
  },
  {
    name: 'is-a-clinical-deep-paged',
    desc: 'is-a 404684003, offset=50000, count=100',
    body: makeVS({
      include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }],
      _params: [{ name: 'count', valueInteger: 100 }, { name: 'offset', valueInteger: 50000 }],
    }),
  },
];

// --- HTTP helpers ---
function postJson(url, body, timeoutMs = REQUEST_TIMEOUT) {
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
  let exact = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].code !== b[i].code) { exact = false; break; }
  }
  if (exact) return { match: true, reason: 'exact' };
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

async function startServer(serverDir) {
  const server = spawn('node', ['server.js'], {
    cwd: serverDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  await waitForServer(`http://localhost:${PORT}/r4/metadata`, SERVER_START_TIMEOUT);
  return server;
}

async function stopServer(server) {
  if (!server) return;
  server.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 2000));
  if (!server.killed) server.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 500));
}

function prepBody(test) {
  const body = JSON.parse(JSON.stringify(test.body));
  if (body.parameter[0].resource.compose._params) {
    body.parameter.push(...body.parameter[0].resource.compose._params);
    delete body.parameter[0].resource.compose._params;
  }
  return body;
}

async function runMode(body, label, iters) {
  const times = [];
  let codes, status;
  let timedOut = false;
  for (let i = 0; i < iters; i++) {
    if (timedOut) break;
    const t0 = performance.now();
    try {
      const res = await postJson(BASE_URL + '/ValueSet/$expand', body);
      const elapsed = performance.now() - t0;
      times.push(elapsed);
      log(`  ${label} iter ${i+1}: ${elapsed.toFixed(0)}ms, HTTP ${res.status}`);
      if (i === 0) { codes = extractCodes(res.body); status = res.status; }
    } catch (e) {
      const elapsed = performance.now() - t0;
      if (e.message === 'Request timed out') {
        times.push(elapsed);
        log(`  ${label} iter ${i+1}: TIMEOUT after ${elapsed.toFixed(0)}ms`);
        timedOut = true;
        if (i === 0) { codes = null; status = 'TIMEOUT'; }
      } else throw e;
    }
  }
  times.sort((a, b) => a - b);
  return { med: times[Math.floor(times.length / 2)], codes, status, timedOut };
}

async function main() {
  const full = process.argv.includes('--full');
  const testList = full ? [...TESTS, ...EXTENDED_TESTS] : TESTS;
  const serverDir = path.resolve(__dirname, '..');
  const ITERS = 2;

  log(`Running ${testList.length} SNOMED tests (${full ? 'full' : 'core'} mode)`);
  log('3-way comparison: v0+expandForValueSet vs v0-baseline vs legacy in-memory\n');

  const results = [];
  let server;

  try {
    // === Phase 1: SQLite v0 (optimized + bypassed) ===
    log('=== Phase 1: SQLite v0 provider ===');
    patchConfig(V0_CONFIG);
    server = await startServer(serverDir);
    log('v0 server ready.\n');
    await httpPost(`http://localhost:${PORT}/debug/perf-counters/enable`);

    for (let ti = 0; ti < testList.length; ti++) {
      const test = testList[ti];
      const body = prepBody(test);
      log(`[${ti+1}/${testList.length}] ${test.name}: ${test.desc}`);

      // v0 optimized
      await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=false`);
      const opt = await runMode(body, 'v0-opt', ITERS);

      // v0 bypassed
      await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=true`);
      const v0base = await runMode(body, 'v0-base', ITERS);

      results.push({ name: test.name, test, body, opt, v0base, legacy: null });
      log('');
    }

    await stopServer(server);
    server = null;

    // === Phase 2: Legacy in-memory provider ===
    log('\n=== Phase 2: Legacy in-memory provider ===');
    patchConfig(LEGACY_CONFIG);
    server = await startServer(serverDir);
    log('Legacy server ready.\n');

    for (let ti = 0; ti < testList.length; ti++) {
      const r = results[ti];
      const body = r.body;
      log(`[${ti+1}/${testList.length}] ${r.name}`);

      const legacy = await runMode(body, 'legacy', ITERS);
      r.legacy = legacy;
      log('');
    }

    await stopServer(server);
    server = null;

    // === Phase 3: Drain verification for mismatched cases ===
    // For tests where page order differs, drain ALL codes and compare sets
    const needsDrain = results.filter(r => {
      if (!r.opt.codes || !r.legacy.codes) return false;
      const cmp = codesEqual(r.opt.codes, r.legacy.codes);
      return !cmp.match;
    });

    if (needsDrain.length > 0) {
      log(`\n=== Phase 3: Drain verification (${needsDrain.length} tests) ===`);

      // Drain from v0 optimized
      patchConfig(V0_CONFIG);
      server = await startServer(serverDir);
      log('v0 server ready for drain.\n');
      await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=false`);

      for (const r of needsDrain) {
        const drainCount = r.test.drainCount || 200000;
        log(`  Draining ${r.name} (up to ${drainCount})...`);
        const drainBody = JSON.parse(JSON.stringify(r.body));
        drainBody.parameter = drainBody.parameter.filter(p =>
          p.name !== 'count' && p.name !== 'offset');
        drainBody.parameter.push({ name: 'count', valueInteger: drainCount });
        try {
          const res = await postJson(BASE_URL + '/ValueSet/$expand', drainBody, 120000);
          r.drainOptCodes = extractCodes(res.body) || [];
          log(`    v0-opt: ${r.drainOptCodes.length} codes (HTTP ${res.status})`);
        } catch (e) {
          log(`    v0-opt: ERROR ${e.message}`);
          r.drainOptCodes = null;
        }
      }

      await stopServer(server);
      server = null;

      // Drain from legacy
      patchConfig(LEGACY_CONFIG);
      server = await startServer(serverDir);
      log('Legacy server ready for drain.\n');

      for (const r of needsDrain) {
        const drainCount = r.test.drainCount || 200000;
        log(`  Draining ${r.name} (up to ${drainCount})...`);
        const drainBody = JSON.parse(JSON.stringify(r.body));
        drainBody.parameter = drainBody.parameter.filter(p =>
          p.name !== 'count' && p.name !== 'offset');
        drainBody.parameter.push({ name: 'count', valueInteger: drainCount });
        try {
          const res = await postJson(BASE_URL + '/ValueSet/$expand', drainBody, 120000);
          r.drainLegacyCodes = extractCodes(res.body) || [];
          log(`    legacy: ${r.drainLegacyCodes.length} codes (HTTP ${res.status})`);
        } catch (e) {
          log(`    legacy: ERROR ${e.message}`);
          r.drainLegacyCodes = null;
        }
      }

      await stopServer(server);
      server = null;

      // Compare drained sets
      for (const r of needsDrain) {
        if (!r.drainOptCodes || !r.drainLegacyCodes) {
          r.drainResult = 'drain error';
          continue;
        }
        const optSet = new Set(r.drainOptCodes.map(c => c.code));
        const legSet = new Set(r.drainLegacyCodes.map(c => c.code));
        const onlyOpt = [...optSet].filter(c => !legSet.has(c));
        const onlyLeg = [...legSet].filter(c => !optSet.has(c));
        if (onlyOpt.length === 0 && onlyLeg.length === 0) {
          r.drainResult = `sets equal (${optSet.size} codes)`;
          log(`  ${r.name}: ✅ ${r.drainResult}`);
        } else {
          r.drainResult = `sets differ (v0-only: ${onlyOpt.length}, legacy-only: ${onlyLeg.length})`;
          log(`  ${r.name}: ❌ ${r.drainResult}`);
          if (onlyOpt.length > 0) log(`    v0-only sample: ${onlyOpt.slice(0,5).join(', ')}`);
          if (onlyLeg.length > 0) log(`    legacy-only sample: ${onlyLeg.slice(0,5).join(', ')}`);
        }
      }
    }

    // === Summary ===
    const lines = [];
    lines.push('=== SNOMED CT 3-way expansion benchmark ===');
    lines.push(`Date: ${new Date().toISOString()}`);
    lines.push(`Tests: ${testList.length} (${full ? 'full' : 'core'})`);
    lines.push('');
    lines.push('Modes: v0-opt = SQLite v0 + expandForValueSet');
    lines.push('       v0-base = SQLite v0, expandForValueSet bypassed');
    lines.push('       legacy = upstream in-memory binary provider');
    lines.push('');
    lines.push('Test                          | v0-opt   | v0-base  | legacy   | v0-opt vs legacy | Codes | Match');
    lines.push('------------------------------|----------|----------|----------|------------------|-------|------');

    for (const r of results) {
      const fmtMs = (v) => v.timedOut ? ' TIMEOUT' : `${v.med.toFixed(1)}`.padStart(8);
      const optMs = fmtMs(r.opt);
      const v0bMs = fmtMs(r.v0base);
      const legMs = fmtMs(r.legacy);

      let vsLegacy = '';
      if (!r.opt.timedOut && !r.legacy.timedOut) {
        const ratio = r.legacy.med / r.opt.med;
        vsLegacy = ratio >= 1
          ? `${ratio.toFixed(1)}x faster`.padStart(16)
          : `${(1/ratio).toFixed(1)}x slower`.padStart(16);
      } else {
        vsLegacy = '             N/A';
      }

      // Compare opt codes vs legacy codes
      const cmp = (!r.opt.codes || !r.legacy.codes)
        ? { match: null, reason: 'N/A' }
        : codesEqual(r.opt.codes, r.legacy.codes);

      let matchLabel;
      if (cmp.match === true) {
        matchLabel = `✅ ${cmp.reason}`;
      } else if (r.drainResult && r.drainResult.startsWith('sets equal')) {
        matchLabel = `✅ order differs, ${r.drainResult}`;
      } else if (r.drainResult) {
        matchLabel = `❌ ${r.drainResult}`;
      } else if (cmp.match === false) {
        matchLabel = `❌ ${cmp.reason}`;
      } else {
        matchLabel = `⚠️ ${cmp.reason}`;
      }
      const codeCount = r.opt.codes?.length ?? '?';

      lines.push(
        `${r.name.padEnd(30)}| ${optMs} | ${v0bMs} | ${legMs} | ${vsLegacy} | ${String(codeCount).padStart(5)} | ${matchLabel}`
      );
    }

    console.log('\n' + lines.join('\n'));

    const outPath = path.join(serverDir, 'test-snomed-expand-results.txt');
    fs.writeFileSync(outPath, lines.join('\n') + '\n');
    log(`\nResults written to ${outPath}`);

  } finally {
    restoreConfig();
    await stopServer(server);
  }
}

main().catch(err => {
  console.error(err);
  restoreConfig();
  process.exit(1);
});
