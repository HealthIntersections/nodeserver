#!/usr/bin/env node
/**
 * Benchmark test suite for LOINC expandForValueSet
 * Mirrors the RxNorm test harness (scripts/test-expand-for-valueset.js)
 * Tests various LOINC filter/concept patterns against baseline
 */

const http = require('http');

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const SYSTEM = 'http://loinc.org';

// Test cases exercising different LOINC query patterns
const TEST_CASES = [
  // --- Filter: relationship property (COMPONENT = part code) ---
  {
    name: 'filter-component-bacteria',
    description: 'COMPONENT = LP14082-9 (Bacteria, 27 codes)',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [{ property: 'COMPONENT', op: '=', value: 'LP14082-9' }]
      }]
    },
    params: { count: 10 }
  },

  // --- Filter: relationship property (CLASS = class part) ---
  {
    name: 'filter-class-chem',
    description: 'CLASS = LP7786-9 (CHEM, 10707 codes)',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }]
      }]
    },
    params: { count: 10 }
  },

  // --- Filter: SCALE_TYP (large: 42k codes) ---
  {
    name: 'filter-scale-qn',
    description: 'SCALE_TYP = LP7753-9 (Qn, 42085 codes)',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [{ property: 'SCALE_TYP', op: '=', value: 'LP7753-9' }]
      }]
    },
    params: { count: 10 }
  },

  // --- Filter: SYSTEM (medium: 13k codes) ---
  {
    name: 'filter-system-ser',
    description: 'SYSTEM = LP7567-3 (Ser, 13584 codes)',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [{ property: 'SYSTEM', op: '=', value: 'LP7567-3' }]
      }]
    },
    params: { count: 10 }
  },

  // --- Concept list (explicit codes) ---
  {
    name: 'concept-5',
    description: '5 explicit LOINC codes',
    compose: {
      include: [{
        system: SYSTEM,
        concept: [
          { code: '2160-0' },  // Creatinine
          { code: '2345-7' },  // Glucose
          { code: '718-7' },   // Hemoglobin
          { code: '4548-4' },  // HbA1c
          { code: '2951-2' }   // Sodium
        ]
      }]
    },
    params: {}
  },

  // --- Exclude: component filter minus specific codes ---
  {
    name: 'exclude-concepts',
    description: 'COMPONENT=LP14082-9 minus 2 specific codes',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [{ property: 'COMPONENT', op: '=', value: 'LP14082-9' }]
      }],
      exclude: [{
        system: SYSTEM,
        concept: [
          { code: '100906-7' },
          { code: '11101-3' }
        ]
      }]
    },
    params: { count: 10 }
  },

  // --- ActiveOnly: CLASS=CHEM with activeOnly ---
  {
    name: 'activeonly-class',
    description: 'CLASS=LP7786-9 activeOnly=true',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }]
      }]
    },
    params: { count: 10, activeOnly: true }
  },

  // --- LIST filter (answer list) ---
  {
    name: 'filter-list-ll150',
    description: 'LIST = LL150-4 (255 answers)',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [{ property: 'LIST', op: '=', value: 'LL150-4' }]
      }]
    },
    params: { count: 10 },
    drainCount: 300
  },

  // --- Property filter (CLASSTYPE = 1 = Laboratory) ---
  {
    name: 'filter-classtype-lab',
    description: 'CLASSTYPE = 1 (Laboratory, ~60k codes)',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [{ property: 'CLASSTYPE', op: '=', value: '1' }]
      }]
    },
    params: { count: 10 }
  },

  // --- Paged: offset into CLASS filter ---
  {
    name: 'paged-class-offset-100',
    description: 'CLASS=LP7786-9 offset=100 count=10',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }]
      }]
    },
    params: { count: 10, offset: 100 }
  },

  // --- Multi-filter: COMPONENT + SCALE_TYP ---
  {
    name: 'multi-filter-component-scale',
    description: 'COMPONENT=LP14082-9 AND SCALE_TYP=Qn',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [
          { property: 'COMPONENT', op: '=', value: 'LP14082-9' },
          { property: 'SCALE_TYP', op: '=', value: 'LP7753-9' }
        ]
      }]
    },
    params: { count: 10 }
  },

  // --- STATUS filter ---
  {
    name: 'filter-status-active',
    description: 'STATUS = ACTIVE',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }]
      }]
    },
    params: { count: 10 },
    drainCount: 200000
  },

  // --- Text search + filter ---
  {
    name: 'text-glucose',
    description: 'Text search "glucose" with count=10',
    compose: {
      include: [{
        system: SYSTEM,
        filter: [{ property: 'SCALE_TYP', op: '=', value: 'LP7753-9' }]
      }]
    },
    params: { count: 10, filter: 'glucose' }
  },

  // --- Multi-include: two component filters ---
  {
    name: 'multi-include-2-components',
    description: 'COMPONENT=LP14082-9 OR COMPONENT=LP33405-9',
    compose: {
      include: [
        {
          system: SYSTEM,
          filter: [{ property: 'COMPONENT', op: '=', value: 'LP14082-9' }]
        },
        {
          system: SYSTEM,
          filter: [{ property: 'COMPONENT', op: '=', value: 'LP33405-9' }]
        }
      ]
    },
    params: { count: 10 },
    drainCount: 1000
  },
];

// --- HTTP helpers ---
function httpPost(url, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error('Bad JSON: ' + Buffer.concat(chunks).toString().substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

async function waitForServer(maxWait = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await httpGet(`${BASE}/r4/metadata`);
      return true;
    } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('Server did not start');
}

function buildExpandRequest(tc) {
  const vs = {
    resourceType: 'ValueSet',
    compose: tc.compose
  };

  const params = {
    resourceType: 'Parameters',
    parameter: [
      { name: 'valueSet', resource: vs }
    ]
  };

  if (tc.params.count) params.parameter.push({ name: 'count', valueInteger: tc.params.count });
  if (tc.params.offset) params.parameter.push({ name: 'offset', valueInteger: tc.params.offset });
  if (tc.params.activeOnly) params.parameter.push({ name: 'activeOnly', valueBoolean: true });
  if (tc.params.filter) params.parameter.push({ name: 'filter', valueString: tc.params.filter });

  return params;
}

function extractCodes(response) {
  if (!response?.expansion?.contains) return [];
  return response.expansion.contains.map(c => ({ code: c.code, display: c.display?.substring(0, 50) }));
}

function ts() {
  return new Date().toISOString().substring(11, 19);
}

async function setBypass(enabled) {
  const url = `${BASE}/debug/bypass-expand-for-valueset?bypass=${enabled}`;
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST' }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.end();
  });
}

async function runTest(tc) {
  const baselineTimeout = 10000;
  const result = { name: tc.name, optMs: 0, baseMs: 0, optCodes: [], baseCodes: [], error: null };

  try {
    // Optimized run (expandForValueSet enabled)
    await setBypass(false);
    const optReq = buildExpandRequest(tc);
    const t0 = performance.now();
    const optResp = await httpPost(`${BASE}/r4/ValueSet/$expand`, optReq, 30000);
    result.optMs = performance.now() - t0;
    result.optCodes = extractCodes(optResp);

    if (optResp.issue) {
      result.error = optResp.issue[0]?.diagnostics?.substring(0, 100);
      return result;
    }

    // Baseline run (expandForValueSet bypassed)
    await setBypass(true);
    const baseReq = buildExpandRequest(tc);
    try {
      const t1 = performance.now();
      const baseResp = await httpPost(`${BASE}/r4/ValueSet/$expand`, baseReq, baselineTimeout);
      result.baseMs = performance.now() - t1;
      result.baseCodes = extractCodes(baseResp);
    } catch (e) {
      if (e.message === 'timeout') {
        result.baseMs = -1;
      } else throw e;
    }

    // Re-enable optimized path
    await setBypass(false);

    // Drain comparison if requested
    if (tc.drainCount && result.baseMs !== -1) {
      console.log(`[${ts()}]   Draining up to ${tc.drainCount} codes for full set comparison...`);
      const drainParams = JSON.parse(JSON.stringify(tc));
      drainParams.params.count = tc.drainCount;
      drainParams.params.offset = 0;

      await setBypass(false);
      const dOptResp = await httpPost(`${BASE}/r4/ValueSet/$expand`, buildExpandRequest(drainParams), 120000);
      const dOptCodes = new Set(extractCodes(dOptResp).map(c => c.code));

      await setBypass(true);
      const dBaseResp = await httpPost(`${BASE}/r4/ValueSet/$expand`, buildExpandRequest(drainParams), 120000);
      const dBaseCodes = new Set(extractCodes(dBaseResp).map(c => c.code));

      await setBypass(false);

      result.drainOpt = dOptCodes.size;
      result.drainBase = dBaseCodes.size;
      result.drainEqual = dOptCodes.size === dBaseCodes.size && [...dOptCodes].every(c => dBaseCodes.has(c));
      console.log(`[${ts()}]   Drain: opt=${dOptCodes.size} base=${dBaseCodes.size} → ${result.drainEqual ? 'sets equal' : 'DIFFERENT'} (${dOptCodes.size} codes)`);
    }

  } catch (e) {
    result.error = e.message;
  }

  return result;
}

function compareResults(result) {
  if (result.error) return `❌ ${result.error}`;
  if (result.baseMs === -1) return `⏱️ baseline timeout (opt OK: ${result.optCodes.length} codes)`;

  const optCodes = result.optCodes.map(c => c.code);
  const baseCodes = result.baseCodes.map(c => c.code);

  if (optCodes.length !== baseCodes.length) {
    return `❌ count ${optCodes.length} vs ${baseCodes.length}`;
  }

  // Exact match?
  if (JSON.stringify(optCodes) === JSON.stringify(baseCodes)) return '✅ exact';

  // Set equal?
  const optSet = new Set(optCodes);
  const baseSet = new Set(baseCodes);
  if (optSet.size === baseSet.size && [...optSet].every(c => baseSet.has(c))) {
    if (result.drainEqual !== undefined) {
      return result.drainEqual
        ? `✅ page order differs, sets equal (${result.drainOpt} codes)`
        : `❌ page order differs, full sets DIFFERENT`;
    }
    return '✅ page order differs, sets equal';
  }

  // Page sets differ — check drain if available
  if (result.drainEqual !== undefined) {
    return result.drainEqual
      ? `✅ page order differs, sets equal (${result.drainOpt} codes)`
      : `❌ different codes (drain: ${result.drainOpt} vs ${result.drainBase})`;
  }

  return '❌ different codes';
}

async function main() {
  // Start server
  const { spawn } = require('child_process');
  const fs = require('fs');

  // Patch config — the librarySource is nested in tx module config
  const configPath = 'data/config.json';
  const origConfig = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(origConfig);
  // Find the nested librarySource in the tx module
  if (config.modules?.tx) {
    config.modules.tx.librarySource = 'tx/tx.loinc-only.yml';
  } else {
    config.librarySource = 'tx/tx.loinc-only.yml';
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log(`[${ts()}] Starting server with LOINC-only config...`);

  const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: PORT.toString() },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  server.stdout.on('data', d => serverOutput += d.toString());
  server.stderr.on('data', d => serverOutput += d.toString());

  try {
    await waitForServer(120000);
    console.log(`[${ts()}] Server ready`);

    const results = [];
    for (const tc of TEST_CASES) {
      console.log(`[${ts()}] Running: ${tc.name} — ${tc.description}`);
      const r = await runTest(tc);
      results.push(r);

      const speedup = r.baseMs === -1 ? '∞' : r.baseMs <= 0 ? 'N/A' : (r.baseMs / r.optMs).toFixed(1) + 'x';
      console.log(`[${ts()}]   Optimized: ${r.optMs.toFixed(1)}ms  |  Baseline: ${r.baseMs === -1 ? 'TIMEOUT' : r.baseMs.toFixed(1) + 'ms'}  |  Speedup: ${speedup}`);

      // Show first few codes side by side if different
      if (r.optCodes.length > 0 && r.baseCodes.length > 0) {
        const match = JSON.stringify(r.optCodes.map(c=>c.code)) === JSON.stringify(r.baseCodes.map(c=>c.code));
        if (!match) {
          for (let i = 0; i < Math.min(5, r.optCodes.length); i++) {
            console.log(`[${ts()}]     [${i}] opt: ${r.optCodes[i]?.code}/${r.optCodes[i]?.display} | base: ${r.baseCodes[i]?.code}/${r.baseCodes[i]?.display}`);
          }
        }
      }
    }

    // Summary table
    console.log('');
    console.log(`=== LOINC expandForValueSet test results ===`);
    console.log(`Date: ${new Date().toISOString()}`);
    console.log(`Tests: ${results.length}`);
    console.log('');
    console.log('Test                          | New (ms) | Old (ms) | Speedup | Codes | Result');
    console.log('------------------------------|----------|----------|---------|-------|-------');

    for (const r of results) {
      const name = r.name.padEnd(30);
      const optMs = r.optMs.toFixed(1).padStart(8);
      const baseMs = r.baseMs === -1 ? ' TIMEOUT' : r.baseMs.toFixed(1).padStart(8);
      const speedup = r.baseMs === -1 ? '    ∞' : r.baseMs <= 0 ? '  N/A' : (r.baseMs / r.optMs).toFixed(1).padStart(5) + 'x';
      const codes = String(r.optCodes.length).padStart(5);
      const comparison = compareResults(r);
      console.log(`${name}|${optMs} |${baseMs} | ${speedup.padStart(7)} | ${codes} | ${comparison}`);
    }

    // Write results
    const outPath = 'test-loinc-expand-results.txt';
    const lines = results.map(r => {
      const speedup = r.baseMs === -1 ? 'Inf' : (r.baseMs / r.optMs).toFixed(1);
      return `${r.name}\t${r.optMs.toFixed(1)}\t${r.baseMs === -1 ? 'TIMEOUT' : r.baseMs.toFixed(1)}\t${speedup}\t${r.optCodes.length}\t${compareResults(r)}`;
    });
    fs.writeFileSync(outPath, lines.join('\n'));
    console.log(`\n[${ts()}] Results written to ${outPath}`);

  } finally {
    // Restore config
    fs.writeFileSync(configPath, origConfig);

    server.kill();
    console.log(`[${ts()}] Server stopped, config restored`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
