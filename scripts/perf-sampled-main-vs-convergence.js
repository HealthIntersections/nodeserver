#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

function parseArgs(argv) {
  const out = {
    input: '/home/jmandel/hobby/FHIRsmith/captured/snomed.ndjson',
    out: 'captured/perf-sampled-main-vs-convergence.json',
    repeats: 8,
    warmup: 1,
    pathPrefix: '/r4/',
    limit: 0,
    portBase: 9500,
    expansionCache: 'both',
    mainRoot: '/home/jmandel/hobby/FHIRsmith',
    convRoot: '/home/jmandel/hobby/FHIRsmith-tx-mainline-convergence',
    mainLibrary: '',
    convLibrary: 'tx/tx.snomed-v0.yml',
    endpointPath: '/r4',
    fhirVersion: '4.0',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) out.input = argv[++i];
    else if (a === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (a === '--repeats' && argv[i + 1]) out.repeats = Number(argv[++i]);
    else if (a === '--warmup' && argv[i + 1]) out.warmup = Number(argv[++i]);
    else if (a === '--path-prefix' && argv[i + 1]) out.pathPrefix = argv[++i];
    else if (a === '--limit' && argv[i + 1]) out.limit = Number(argv[++i]);
    else if (a === '--port-base' && argv[i + 1]) out.portBase = Number(argv[++i]);
    else if (a === '--expansion-cache' && argv[i + 1]) out.expansionCache = argv[++i];
    else if (a === '--main-root' && argv[i + 1]) out.mainRoot = argv[++i];
    else if (a === '--conv-root' && argv[i + 1]) out.convRoot = argv[++i];
    else if (a === '--main-library' && argv[i + 1]) out.mainLibrary = argv[++i];
    else if (a === '--conv-library' && argv[i + 1]) out.convLibrary = argv[++i];
    else if (a === '--endpoint-path' && argv[i + 1]) out.endpointPath = argv[++i];
    else if (a === '--fhir-version' && argv[i + 1]) out.fhirVersion = argv[++i];
  }

  if (!Number.isFinite(out.repeats) || out.repeats <= 0) throw new Error(`Invalid --repeats: ${out.repeats}`);
  if (!Number.isFinite(out.warmup) || out.warmup < 0) throw new Error(`Invalid --warmup: ${out.warmup}`);
  if (!Number.isFinite(out.portBase) || out.portBase <= 0) throw new Error(`Invalid --port-base: ${out.portBase}`);
  if (!['on', 'off', 'both'].includes(out.expansionCache)) {
    throw new Error(`--expansion-cache must be on|off|both (got "${out.expansionCache}")`);
  }
  return out;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const idx = Math.max(0, Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[idx];
}

function summarizeTimings(values) {
  if (!values.length) {
    return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, meanMs: 0, maxMs: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    minMs: Number(sorted[0].toFixed(3)),
    p50Ms: Number(percentile(sorted, 50).toFixed(3)),
    p95Ms: Number(percentile(sorted, 95).toFixed(3)),
    meanMs: Number((sum / sorted.length).toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

function readNdjson(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`Input NDJSON not found: ${abs}`);
  const lines = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean);
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw new Error(`Invalid JSON at ${abs}:${idx + 1} (${e.message})`);
    }
  });
}

function normalizeSamples(samples, pathPrefix, limit) {
  let filtered = samples.filter((s) => typeof s?.url === 'string');
  if (pathPrefix) filtered = filtered.filter((s) => s.url.startsWith(pathPrefix));
  if (limit > 0) filtered = filtered.slice(0, limit);
  return filtered.map((s, i) => ({
    index: i,
    id: s.id || `sample-${i + 1}`,
    method: String(s.method || 'GET').toUpperCase(),
    url: s.url,
    signature: s.signature || `${String(s.method || 'GET').toUpperCase()} ${s.url}`,
    requestBody: s.requestBody && typeof s.requestBody === 'object' ? s.requestBody : null,
  }));
}

function ensureMainLibrary(mainRoot, outDir) {
  const target = path.resolve(outDir, 'perf-main-two-snomed.yml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = [
    'base:',
    '  url: https://storage.googleapis.com/tx-fhir-org',
    '',
    'sources:',
    '  - internal:lang',
    '  - internal:country',
    '  - internal:currency',
    '  - internal:areacode',
    '  - internal:mimetypes',
    '  - internal:usstates',
    '  - internal:hgvs',
    '  - ucum:tx/data/ucum-essence.xml',
    '  - sqlite!:sct_intl_20250201.db',
    '  - sqlite:sct_test_20250814.db',
    '  - npm:hl7.terminology',
    '  - npm:fhir.tx.support.r4',
    '',
  ].join('\n');
  fs.writeFileSync(target, content);
  return target;
}

function resolveLibrary(repoRoot, libraryPath) {
  if (!libraryPath) return '';
  if (path.isAbsolute(libraryPath)) return libraryPath;
  return path.resolve(repoRoot, libraryPath);
}

function disableExpansionCache(txModule) {
  for (const endpoint of txModule.endpoints || []) {
    endpoint.expansionCache = {
      computeKey: () => `disabled-${Math.random().toString(36).slice(2)}`,
      get: () => null,
      has: () => false,
      set: () => false,
      forceSet: () => {},
      clear: () => {},
      clearAll: () => {},
      evictOldest: () => 0,
      evictOldestHalf: () => 0,
      checkMemoryPressure: () => false,
      stats: () => ({ size: 0, maxSize: 0, memoryThresholdMB: 0, totalHits: 0, totalDurationSaved: 0 }),
      size: () => 0,
    };
  }
}

async function startServer(target, port, endpointPath, fhirVersion, expansionCacheEnabled) {
  const txPath = path.resolve(target.repoRoot, 'tx/tx.js');
  const statsPath = path.resolve(target.repoRoot, 'stats.js');
  const TXModule = require(txPath);
  const ServerStats = require(statsPath);

  const app = express();
  app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
  app.use(express.raw({ type: 'application/fhir+xml', limit: '50mb' }));
  app.use(express.json({ limit: '50mb' }));

  const config = {
    enabled: true,
    consoleErrors: false,
    host: 'local.host',
    librarySource: target.librarySource,
    cacheTimeout: 30,
    expansionCacheSize: 1000,
    expansionCacheMemoryThreshold: 0,
    endpoints: [{ path: endpointPath, fhirVersion, context: null }],
  };

  const stats = new ServerStats();
  const txModule = new TXModule(stats);
  const started = process.hrtime.bigint();
  await txModule.initialize(config, app);
  if (!expansionCacheEnabled) disableExpansionCache(txModule);

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, (err) => (err ? reject(err) : resolve(s)));
  });
  await waitForReady(port, endpointPath);
  const startupMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { server, txModule, stats, startupMs };
}

async function waitForReady(port, endpointPath, timeoutMs = 30000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  const probePath = `${endpointPath.replace(/\/$/, '')}/metadata`;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}${probePath}`, {
        method: 'GET',
        headers: { accept: 'application/fhir+json, application/json' },
      });
      if (resp.status >= 200 && resp.status < 500) {
        return;
      }
      lastError = new Error(`Readiness probe returned status ${resp.status}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Server readiness timed out after ${timeoutMs}ms (${lastError ? lastError.message : 'no response'})`);
}

async function stopServer(ctx) {
  if (ctx.txModule && typeof ctx.txModule.shutdown === 'function') await ctx.txModule.shutdown();
  if (ctx.stats && typeof ctx.stats.finishStats === 'function') ctx.stats.finishStats();
  await new Promise((resolve) => {
    ctx.server.closeAllConnections?.();
    ctx.server.close(() => resolve());
  });
}

async function sendRequest(port, sample) {
  const headers = { accept: 'application/fhir+json, application/json' };
  const req = { method: sample.method, headers };
  if (sample.method === 'POST' && sample.requestBody) {
    req.headers['content-type'] = 'application/fhir+json';
    req.body = JSON.stringify(sample.requestBody);
  }
  const resp = await fetch(`http://127.0.0.1:${port}${sample.url}`, req);
  const bodyText = await resp.text();
  return { status: resp.status, bytes: Buffer.byteLength(bodyText || '', 'utf8') };
}

function summarizeRun(records, startupMs) {
  const timings = records.map((r) => r.durationMs);
  const statusCounts = {};
  for (const r of records) statusCounts[String(r.status)] = (statusCounts[String(r.status)] || 0) + 1;

  const byQuery = new Map();
  for (const r of records) {
    let q = byQuery.get(r.id);
    if (!q) {
      q = { id: r.id, method: r.method, url: r.url, signature: r.signature, timings: [], statuses: {} };
      byQuery.set(r.id, q);
    }
    q.timings.push(r.durationMs);
    q.statuses[String(r.status)] = (q.statuses[String(r.status)] || 0) + 1;
  }

  const perQuery = [...byQuery.values()].map((q) => ({
    id: q.id,
    method: q.method,
    url: q.url,
    signature: q.signature,
    timings: summarizeTimings(q.timings),
    statuses: q.statuses,
  }));

  return {
    startupMs: Number(startupMs.toFixed(3)),
    requestCount: records.length,
    statusCounts,
    overallTimings: summarizeTimings(timings),
    perQuery,
  };
}

function compareTargets(runMain, runConv) {
  const mapMain = new Map(runMain.perQuery.map((q) => [q.id, q]));
  const mapConv = new Map(runConv.perQuery.map((q) => [q.id, q]));
  const deltas = [];
  for (const [id, qm] of mapMain.entries()) {
    const qc = mapConv.get(id);
    if (!qc) continue;
    deltas.push({
      id,
      method: qm.method,
      url: qm.url,
      mainP50Ms: qm.timings.p50Ms,
      convP50Ms: qc.timings.p50Ms,
      deltaMs: Number((qc.timings.p50Ms - qm.timings.p50Ms).toFixed(3)),
    });
  }
  const fasterConv = deltas.filter((d) => d.deltaMs < 0).length;
  const fasterMain = deltas.filter((d) => d.deltaMs > 0).length;
  const tie = deltas.length - fasterConv - fasterMain;
  const absMedian = summarizeTimings(deltas.map((d) => Math.abs(d.deltaMs)));
  return {
    comparedQueries: deltas.length,
    fasterConv,
    fasterMain,
    tie,
    absoluteDeltaMs: absMedian,
    largestConvWins: deltas.filter((d) => d.deltaMs < 0).sort((a, b) => a.deltaMs - b.deltaMs).slice(0, 12),
    largestMainWins: deltas.filter((d) => d.deltaMs > 0).sort((a, b) => b.deltaMs - a.deltaMs).slice(0, 12),
  };
}

async function runMode(target, cacheMode, args, port, samples) {
  const expansionCacheEnabled = cacheMode === 'on';
  const ctx = await startServer(target, port, args.endpointPath, args.fhirVersion, expansionCacheEnabled);
  const records = [];
  try {
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      for (let w = 0; w < args.warmup; w++) {
        try {
          await sendRequest(port, sample);
        } catch (_e) {
          // ignore warmup failures
        }
      }

      for (let r = 0; r < args.repeats; r++) {
        const started = process.hrtime.bigint();
        let status = 0;
        let bytes = 0;
        let error = null;
        try {
          const res = await sendRequest(port, sample);
          status = res.status;
          bytes = res.bytes;
        } catch (e) {
          error = String(e?.message || e);
        }
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        records.push({
          id: sample.id,
          method: sample.method,
          url: sample.url,
          signature: sample.signature,
          repeat: r + 1,
          status,
          bytes,
          error,
          durationMs: Number(durationMs.toFixed(3)),
        });
      }

      if ((i + 1) % 20 === 0 || i + 1 === samples.length) {
        console.log(`[${target.name}/${cacheMode}] ${i + 1}/${samples.length} queries complete`);
      }
    }
  } finally {
    await stopServer(ctx);
  }

  return summarizeRun(records, ctx.startupMs);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outAbs = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  const mainLibrary = args.mainLibrary
    ? resolveLibrary(args.mainRoot, args.mainLibrary)
    : ensureMainLibrary(args.mainRoot, path.dirname(outAbs));
  const convLibrary = resolveLibrary(args.convRoot, args.convLibrary);

  const samplesAll = readNdjson(args.input);
  const samples = normalizeSamples(samplesAll, args.pathPrefix, args.limit);
  if (!samples.length) throw new Error('No samples selected. Adjust --path-prefix/--limit/input');

  const targets = [
    { name: 'main', repoRoot: path.resolve(args.mainRoot), librarySource: mainLibrary },
    { name: 'convergence', repoRoot: path.resolve(args.convRoot), librarySource: convLibrary },
  ];

  const cacheModes = args.expansionCache === 'both' ? ['on', 'off'] : [args.expansionCache];
  const runs = {};

  let slot = 0;
  for (const cacheMode of cacheModes) {
    for (const target of targets) {
      const port = args.portBase + slot;
      slot += 1;
      console.log(`Starting run target=${target.name} expansion-cache=${cacheMode} port=${port}`);
      runs[`${target.name}:${cacheMode}`] = await runMode(target, cacheMode, args, port, samples);
    }
  }

  const comparisons = {};
  for (const cacheMode of cacheModes) {
    const rm = runs[`main:${cacheMode}`];
    const rc = runs[`convergence:${cacheMode}`];
    if (rm && rc) comparisons[cacheMode] = compareTargets(rm, rc);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    input: path.resolve(args.input),
    queryCount: samples.length,
    repeats: args.repeats,
    warmup: args.warmup,
    pathPrefix: args.pathPrefix,
    endpointPath: args.endpointPath,
    fhirVersion: args.fhirVersion,
    targets,
    cacheModes,
    runs,
    comparisons,
  };

  fs.writeFileSync(outAbs, JSON.stringify(output, null, 2));

  const brief = { out: outAbs, queryCount: samples.length, repeats: args.repeats, cacheModes, comparisons };
  console.log(JSON.stringify(brief, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
