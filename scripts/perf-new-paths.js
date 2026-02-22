#!/usr/bin/env node
/**
 * Performance comparison script for incremental provider enhancements.
 *
 * Usage:
 *   node scripts/perf-new-paths.js [--branch=incremental|main|both] [--iterations=5] [--warmup=2]
 *
 * Measures HTTP latency for requests exercising the new code paths:
 *   - locateMany (inline concept[] lists in ValueSet)
 *   - filterPage (is-a filters with large result sets)
 *   - display fast path (workingLanguages only)
 *   - property skip (no property[] requested)
 *   - provider cache (repeated CodeSystem resolution)
 *
 * On the incremental branch, also reads /debug/perf-counters to verify path coverage.
 * Runs serially (one server at a time) to avoid RAM contention.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

// --- Configuration ---
const INCREMENTAL_DIR = '/home/jmandel/hobby/FHIRsmith-incremental';
const MAIN_DIR = '/home/jmandel/hobby/FHIRsmith-main';
const CONFIG = 'tx/tx.test-lite.yml';
const PORT = 8099;
const BASE = `http://localhost:${PORT}/r4`;
const DEBUG_BASE = `http://localhost:${PORT}`;

const args = process.argv.slice(2).reduce((m, a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  m[k] = v || true;
  return m;
}, {});
const BRANCH = args.branch || 'both';
const ITERATIONS = parseInt(args.iterations) || 5;
const WARMUP = parseInt(args.warmup) || 2;

// --- Test cases ---
// Each test targets a specific new code path at meaningful scale.

// 1000 RxNorm ingredient codes — SQL IN(...) vs 1000 individual queries
const RXNORM_CODES = require('./perf-rxnorm-codes.json');

// 200 SNOMED codes for batch locate (in-memory binary search; less impact than RxNorm)
const SNOMED_CODES = [
  '404684003','38341003','73211009','386661006','84114007','233604007','49727002','25064002',
  '128462008','44054006','267036007','68566005','13645005','22298006','233615004','195967001',
  '43878008','271807003','56018004','40930008','22253000','70582006','64859006','10509002',
  '73430006','414545008','82423001','3723001','29857009','86299006','59282003','197480006',
  '65966004','409622000','126485001','301011002','62315008','39579001','41006004','26929004',
  '50043002','60046008','75570004','118601006','95417003','73595000','47505003','78648007',
  '309557009','399068003','84757009','271737000','161891005','3424008','13213009','44695005',
  '36971009','111056004','2776000','87433001','23986001','302866003','33737001','59455009',
  '239873007','26079004','55342001','127295002','185903001','312608009','225728007','386692008',
  '44465007','43116000','254837009','372086001','128477000','23685000','128053003','74400008',
  '36989005','118599009','128462008','44054006','267036007','68566005','13645005','22298006',
  '233615004','195967001','43878008','271807003','56018004','40930008','22253000','70582006',
  '64859006','10509002','73430006','414545008','82423001','3723001','29857009','86299006',
  '59282003','197480006','65966004','409622000','126485001','301011002','62315008','39579001',
  '41006004','26929004','50043002','60046008','75570004','118601006','95417003','73595000',
  '47505003','78648007','309557009','399068003','84757009','271737000','161891005','3424008',
  '13213009','44695005','36971009','111056004','2776000','87433001','23986001','302866003',
  '33737001','59455009','239873007','26079004','55342001','127295002','185903001','312608009',
  '225728007','386692008','44465007','43116000','254837009','372086001','128477000','23685000',
  '128053003','74400008','36989005','118599009','84757009','271737000','161891005','3424008',
  '13213009','44695005','36971009','111056004','2776000','87433001','23986001','302866003',
  '33737001','59455009','239873007','26079004','55342001','127295002','185903001','312608009',
  '225728007','386692008','44465007','43116000','254837009','372086001','128477000','23685000',
  '128053003','74400008','36989005','118599009','404684003','38341003','73211009','386661006',
  '84114007','233604007','49727002','25064002','128462008','44054006','267036007','68566005',
];

const TESTS = [
  {
    name: 'locateMany-rxnorm-1k',
    desc: 'RxNorm 1000 codes: 1 SQL IN(...) vs 1000 individual queries',
    body: () => ({
      resourceType: 'Parameters',
      parameter: [{
        name: 'valueSet',
        resource: {
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
              concept: RXNORM_CODES.map(c => ({ code: c }))
            }]
          }
        }
      }]
    })
  },
  {
    name: 'locateMany-snomed-200',
    desc: 'SNOMED 200 codes: batch binary search',
    body: () => ({
      resourceType: 'Parameters',
      parameter: [{
        name: 'valueSet',
        resource: {
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://snomed.info/sct',
              concept: SNOMED_CODES.map(c => ({ code: c }))
            }]
          }
        }
      }]
    })
  },
  {
    name: 'filterPage-snomed-5k',
    desc: 'SNOMED is-a filter, 5000 results: paged vs one-at-a-time',
    body: () => ({
      resourceType: 'Parameters',
      parameter: [
        { name: 'url', valueUri: 'http://hl7.org/fhir/ValueSet/device-kind' },
        { name: 'count', valueInteger: 5000 },
      ]
    })
  },
  {
    name: 'filterPage-snomed-uncapped',
    desc: 'SNOMED is-a filter, uncapped: full iteration stress test',
    body: () => ({
      resourceType: 'Parameters',
      parameter: [
        { name: 'url', valueUri: 'http://hl7.org/fhir/ValueSet/device-kind' },
      ]
    })
  },
  {
    name: 'propSkip-large',
    desc: 'Large expansion without property[]: skip N getProperties() calls',
    body: () => ({
      resourceType: 'Parameters',
      parameter: [
        { name: 'url', valueUri: 'http://hl7.org/fhir/ValueSet/device-kind' },
        { name: 'count', valueInteger: 2000 },
      ]
    })
  },
  {
    name: 'propLoad-large',
    desc: 'Large expansion WITH property[]: load properties for comparison',
    body: () => ({
      resourceType: 'Parameters',
      parameter: [
        { name: 'url', valueUri: 'http://hl7.org/fhir/ValueSet/device-kind' },
        { name: 'count', valueInteger: 2000 },
        { name: 'property', valueString: 'inactive' },
      ]
    })
  },
];

// --- HTTP helpers ---
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 120000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: 10000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function httpPostSimple(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Length': 0 },
      timeout: 10000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write('');
    req.end();
  });
}

// --- Server lifecycle ---
function patchConfig(dir) {
  const configPath = path.join(dir, 'data', 'config.json');
  const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
  const origSource = config.modules.tx.librarySource;
  config.modules.tx.librarySource = CONFIG;
  config.modules.tx.host = `localhost:${PORT}`;
  config.modules.tx.baseUrl = `http://localhost:${PORT}`;
  require('fs').writeFileSync(configPath, JSON.stringify(config, null, 2));
  return origSource;
}

function restoreConfig(dir, origSource) {
  const configPath = path.join(dir, 'data', 'config.json');
  const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
  config.modules.tx.librarySource = origSource;
  require('fs').writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function startServer(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: dir,
      env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      // Wait for server ready
      if (output.includes('Server running on') || output.includes('Terminology module loaded')) {
        child.stdout.removeListener('data', onData);
        child.stderr.removeListener('data', onData);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code) reject(new Error(`Server exited with code ${code}\n${output}`));
    });

    // Fallback: poll health
    const poll = setInterval(async () => {
      try {
        const r = await httpGet(`http://localhost:${PORT}/health`);
        if (r.status === 200) {
          clearInterval(poll);
          child.stdout.removeListener('data', onData);
          child.stderr.removeListener('data', onData);
          resolve(child);
        }
      } catch { /* not ready */ }
    }, 2000);

    // Timeout
    setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Server start timeout.\nOutput: ${output}`));
    }, 300000);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) { resolve(); return; }
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    }, 10000);
  });
}

async function waitReady() {
  // Give the server a moment to finish any lazy init
  for (let i = 0; i < 30; i++) {
    try {
      const r = await httpGet(`http://localhost:${PORT}/health`);
      if (r.status === 200) return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Server not ready after 30s');
}

// --- Measurement ---
async function runTest(test) {
  const body = test.body();
  const url = `${BASE}/ValueSet/$expand`;
  const t0 = performance.now();
  const result = await httpPost(url, body);
  const elapsedMs = performance.now() - t0;
  return { elapsedMs, status: result.status };
}

async function runSuite(label, dir, isIncremental) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`  dir: ${dir}`);
  console.log(`${'='.repeat(60)}\n`);

  // Patch config to use lite library
  console.log('Patching config to use lite library...');
  const origSource = patchConfig(dir);

  const results = {};
  for (const test of TESTS) {
    results[test.name] = { times: [], statuses: [] };
  }
  let counters = null;
  let child;

  try {
    console.log('Starting server...');
    child = await startServer(dir);
    console.log('Server started, waiting for ready...');
    await waitReady();
    console.log('Server ready.');

    // Enable perf counters on incremental branch
    if (isIncremental) {
      try {
        await httpPostSimple(`${DEBUG_BASE}/debug/perf-counters/enable`);
        console.log('Perf counters enabled.');
      } catch (e) {
        console.log('(perf counters endpoint not available)');
      }
    }

    // Warm-up
    console.log(`\nWarm-up (${WARMUP} iterations)...`);
    for (let w = 0; w < WARMUP; w++) {
      for (const test of TESTS) {
        await runTest(test);
      }
    }

    // Reset counters after warmup
    if (isIncremental) {
      try { await httpPostSimple(`${DEBUG_BASE}/debug/perf-counters/reset`); } catch { /* ok */ }
    }

    // Measured runs
    console.log(`\nMeasuring (${ITERATIONS} iterations)...`);
    for (let i = 0; i < ITERATIONS; i++) {
      for (const test of TESTS) {
        const r = await runTest(test);
        results[test.name].times.push(r.elapsedMs);
        results[test.name].statuses.push(r.status);
      }
    }

    // Read perf counters
    if (isIncremental) {
      try {
        const r = await httpGet(`${DEBUG_BASE}/debug/perf-counters`);
        counters = JSON.parse(r.body);
      } catch { /* ok */ }
    }

    await stopServer(child);
  } finally {
    // Ensure server is stopped even on error
    if (child && !child.killed) {
      try { await stopServer(child); } catch { /* ok */ }
    }
    // Restore original config
    restoreConfig(dir, origSource);
    console.log('Config restored.');
  }

  // Small delay to ensure port is released
  await new Promise(r => setTimeout(r, 2000));

  return { results, counters };
}

function stats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return { mean: +mean.toFixed(1), median: +median.toFixed(1), p95: +p95.toFixed(1), min: +min.toFixed(1), max: +max.toFixed(1) };
}

function printResults(label, data) {
  console.log(`\n--- ${label} ---`);
  console.log(`${'Test'.padEnd(30)} ${'Mean'.padStart(9)} ${'Median'.padStart(9)} ${'P95'.padStart(9)} ${'Min'.padStart(9)} ${'Max'.padStart(9)}  Status`);
  console.log('-'.repeat(90));
  for (const test of TESTS) {
    const d = data.results[test.name];
    const s = stats(d.times);
    const statusOk = d.statuses.every(x => x === 200) ? '✓ 200' : `✗ ${[...new Set(d.statuses)]}`;
    console.log(`${test.name.padEnd(30)} ${(s.mean + 'ms').padStart(9)} ${(s.median + 'ms').padStart(9)} ${(s.p95 + 'ms').padStart(9)} ${(s.min + 'ms').padStart(9)} ${(s.max + 'ms').padStart(9)}  ${statusOk}`);
  }
}

function printCounters(counters) {
  if (!counters) { console.log('\n(no perf counters available)'); return; }
  console.log('\n--- Code Path Coverage (incremental) ---');
  console.log('Counts:');
  for (const [k, v] of Object.entries(counters.counts || {}).sort()) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('Timings:');
  for (const [k, v] of Object.entries(counters.timings || {}).sort()) {
    console.log(`  ${k}: ${v.calls} calls, ${v.totalMs}ms total, ${(v.totalMs / v.calls).toFixed(2)}ms avg`);
  }
}

function printComparison(mainData, incrData) {
  console.log('\n--- Comparison (incremental vs main) ---');
  console.log(`${'Test'.padEnd(30)} ${'Main (ms)'.padStart(12)} ${'Incr (ms)'.padStart(12)} ${'Δ'.padStart(10)} ${'%'.padStart(8)}`);
  console.log('-'.repeat(75));
  for (const test of TESTS) {
    const mainMean = stats(mainData.results[test.name].times).mean;
    const incrMean = stats(incrData.results[test.name].times).mean;
    const delta = incrMean - mainMean;
    const pct = mainMean > 0 ? ((delta / mainMean) * 100).toFixed(1) : 'N/A';
    const sign = delta < 0 ? '' : '+';
    console.log(`${test.name.padEnd(30)} ${(mainMean + '').padStart(12)} ${(incrMean + '').padStart(12)} ${(sign + delta.toFixed(1)).padStart(10)} ${(sign + pct + '%').padStart(8)}`);
  }
}

// --- Main ---
async function main() {
  console.log('Performance comparison: incremental provider enhancements');
  console.log(`Iterations: ${ITERATIONS}, Warmup: ${WARMUP}`);

  let mainData = null;
  let incrData = null;

  if (BRANCH === 'main' || BRANCH === 'both') {
    mainData = await runSuite('BASELINE (upstream/main)', MAIN_DIR, false);
    printResults('Baseline (upstream/main)', mainData);
  }

  if (BRANCH === 'incremental' || BRANCH === 'both') {
    incrData = await runSuite('INCREMENTAL (enhanced)', INCREMENTAL_DIR, true);
    printResults('Incremental (enhanced)', incrData);
    printCounters(incrData.counters);
  }

  if (mainData && incrData) {
    printComparison(mainData, incrData);
  }

  // Verify code path coverage on incremental
  if (incrData?.counters) {
    console.log('\n--- Path Coverage Verification ---');
    const c = incrData.counters.counts || {};
    // display.fastPath requires workingLanguages to be English-only without
    // implicit wildcard, which fromAcceptLanguage always adds — so it won't
    // trigger via HTTP requests. Track it as informational, not required.
    const expected = ['locate.batched', 'filter.paged', 'props.skipped', 'cache.hit'];
    const informational = ['display.fastPath', 'display.fullPath'];
    let allHit = true;
    for (const name of expected) {
      const hit = (c[name] || 0) > 0;
      console.log(`  ${hit ? '✓' : '✗'} ${name}: ${c[name] || 0}`);
      if (!hit) allHit = false;
    }
    console.log(allHit ? '\n✓ All required code paths were exercised.' : '\n✗ Some required code paths were NOT exercised — check test cases.');
    console.log('Informational:');
    for (const name of informational) {
      console.log(`  ℹ ${name}: ${c[name] || 0}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
