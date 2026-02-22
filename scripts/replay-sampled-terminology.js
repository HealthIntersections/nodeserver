#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const TXModule = require('../tx/tx.js');
const ServerStats = require('../stats');

function parseArgs(argv) {
  const out = {
    input: 'captured/snomed.ndjson',
    out: 'captured/snomed-replay-intended-results.json',
    port: 9400,
    endpointPath: '/r4',
    librarySource: 'tx/tx.snomed-v0.yml',
    intendedSource: 'prod',
    compare: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) out.input = argv[++i];
    else if (a === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (a === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
    else if (a === '--path' && argv[i + 1]) out.endpointPath = argv[++i];
    else if (a === '--library' && argv[i + 1]) out.librarySource = argv[++i];
    else if (a === '--intended-source' && argv[i + 1]) out.intendedSource = argv[++i];
    else if (a === '--compare' && argv[i + 1]) out.compare = argv[++i];
  }

  if (!['prod', 'dev'].includes(out.intendedSource)) {
    throw new Error(`--intended-source must be prod|dev (got "${out.intendedSource}")`);
  }
  if (!Number.isFinite(out.port) || out.port <= 0) {
    throw new Error(`Invalid --port: ${out.port}`);
  }

  return out;
}

function readNdjson(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Input NDJSON not found: ${abs}`);
  }
  const lines = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON at ${abs}:${i + 1} (${error.message})`);
    }
  });
}

function parseResourceType(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return typeof body.resourceType === 'string' ? body.resourceType : null;
}

function isJsonObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function intendedStatusFromSample(sample, intendedSource) {
  if (intendedSource === 'dev') return sample.devStatus;
  return sample.prodStatus;
}

async function startServer(port, endpointPath, librarySource) {
  const app = express();
  app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
  app.use(express.raw({ type: 'application/fhir+xml', limit: '50mb' }));
  app.use(express.json({ limit: '50mb' }));

  const config = {
    enabled: true,
    consoleErrors: false,
    host: 'local.host',
    librarySource,
    endpoints: [{ path: endpointPath, fhirVersion: endpointPath === '/r5' ? '5.0' : '4.0', context: null }],
  };

  const stats = new ServerStats();
  const txModule = new TXModule(stats);
  await txModule.initialize(config, app);

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, (err) => (err ? reject(err) : resolve(s)));
  });

  return { app, server, txModule, stats };
}

async function stopServer(ctx) {
  if (ctx.txModule && typeof ctx.txModule.shutdown === 'function') {
    await ctx.txModule.shutdown();
  }
  if (ctx.stats && typeof ctx.stats.finishStats === 'function') {
    ctx.stats.finishStats();
  }
  await new Promise((resolve) => {
    ctx.server.closeAllConnections?.();
    ctx.server.close(() => resolve());
  });
}

function summarizeResults(results) {
  const byActual = {};
  const byIntendedPair = {};
  const topMismatches = {};

  let intendedPass = 0;
  let intendedFail = 0;
  let prodMatch = 0;
  let devMatch = 0;
  let noActual = 0;
  let postTotal = 0;
  let postWithBody = 0;
  let postMissingBody = 0;
  let totalDuration = 0;
  let maxDuration = 0;

  for (const r of results) {
    const statusKey = r.actualStatus == null ? 'ERR' : String(r.actualStatus);
    byActual[statusKey] = (byActual[statusKey] || 0) + 1;

    const pair = `${r.intendedStatus}->${statusKey}`;
    byIntendedPair[pair] = (byIntendedPair[pair] || 0) + 1;

    if (r.statusMatch.intended === true) intendedPass += 1;
    else intendedFail += 1;

    if (r.statusMatch.prod === true) prodMatch += 1;
    if (r.statusMatch.dev === true) devMatch += 1;
    if (r.actualStatus == null) noActual += 1;

    if (r.method === 'POST') {
      postTotal += 1;
      if (r.hadBody) postWithBody += 1;
      else postMissingBody += 1;
    }

    totalDuration += r.durationMs;
    if (r.durationMs > maxDuration) maxDuration = r.durationMs;

    if (r.statusMatch.intended !== true) {
      const sig = r.signature || `${r.method} ${r.url}`;
      topMismatches[sig] = (topMismatches[sig] || 0) + 1;
    }
  }

  const topPairs = Object.entries(byIntendedPair).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const topFailSigs = Object.entries(topMismatches).sort((a, b) => b[1] - a[1]).slice(0, 12);

  return {
    total: results.length,
    intendedPass,
    intendedFail,
    prodMatch,
    devMatch,
    noActual,
    postTotal,
    postWithBody,
    postMissingBody,
    avgDurationMs: results.length ? Math.round(totalDuration / results.length) : 0,
    maxDurationMs: maxDuration,
    byActual,
    topPairs,
    topFailSigs,
  };
}

function actualStatusFromPrior(record) {
  if (typeof record?.actualStatus === 'number') return record.actualStatus;
  if (typeof record?.actual === 'number') return record.actual;
  return null;
}

function compareAgainstPrior(currentResults, priorResults, sampleById) {
  const priorById = new Map();
  for (const r of priorResults || []) {
    if (r && r.id) priorById.set(r.id, r);
  }

  const classifications = [];
  const summary = {
    compared: 0,
    noPrior: 0,
    improved: 0,
    regressed: 0,
    unchangedPass: 0,
    unchangedFail: 0,
    changedStatus: 0,
  };

  for (const cur of currentResults) {
    const sample = sampleById.get(cur.id);
    const prior = priorById.get(cur.id);
    if (!sample || !prior) {
      summary.noPrior += 1;
      continue;
    }

    const priorActual = actualStatusFromPrior(prior);
    if (priorActual == null) {
      summary.noPrior += 1;
      continue;
    }

    const priorIntendedMatch = priorActual === cur.intendedStatus;
    const currentIntendedMatch = cur.statusMatch.intended === true;
    let classification = 'unchanged-fail';

    if (!priorIntendedMatch && currentIntendedMatch) classification = 'improved';
    else if (priorIntendedMatch && !currentIntendedMatch) classification = 'regressed';
    else if (priorIntendedMatch && currentIntendedMatch) classification = 'unchanged-pass';

    summary.compared += 1;
    if (classification === 'improved') summary.improved += 1;
    else if (classification === 'regressed') summary.regressed += 1;
    else if (classification === 'unchanged-pass') summary.unchangedPass += 1;
    else summary.unchangedFail += 1;

    if (priorActual !== cur.actualStatus) summary.changedStatus += 1;

    classifications.push({
      id: cur.id,
      url: cur.url,
      signature: cur.signature,
      intendedStatus: cur.intendedStatus,
      priorActualStatus: priorActual,
      currentActualStatus: cur.actualStatus,
      priorIntendedMatch,
      currentIntendedMatch,
      classification,
    });
  }

  const topChanged = classifications
    .filter((c) => c.priorActualStatus !== c.currentActualStatus)
    .slice(0, 25);
  const regressed = classifications.filter((c) => c.classification === 'regressed').slice(0, 25);
  const improved = classifications.filter((c) => c.classification === 'improved').slice(0, 25);

  return { summary, improved, regressed, topChanged };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const samples = readNdjson(args.input);
  const sampleById = new Map(samples.map((s) => [s.id, s]));

  const outAbs = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  const serverCtx = await startServer(args.port, args.endpointPath, args.librarySource);
  const results = [];

  try {
    for (const sample of samples) {
      const started = Date.now();
      const body = isJsonObject(sample.requestBody) ? sample.requestBody : null;
      const hadBody = !!body;

      let actualStatus = null;
      let responseResourceType = null;
      let responseBytes = 0;
      let error = null;

      try {
        const req = {
          method: sample.method || 'GET',
          headers: { accept: 'application/fhir+json, application/json' },
        };
        if (hadBody) {
          req.headers['content-type'] = 'application/fhir+json';
          req.body = JSON.stringify(body);
        }

        const resp = await fetch(`http://localhost:${args.port}${sample.url}`, req);
        actualStatus = resp.status;
        const text = await resp.text();
        responseBytes = text ? Buffer.byteLength(text, 'utf8') : 0;
        if (text) {
          try {
            responseResourceType = parseResourceType(JSON.parse(text));
          } catch (_error) {
            responseResourceType = null;
          }
        }
      } catch (e) {
        error = String(e?.message || e);
      }

      const intendedStatus = intendedStatusFromSample(sample, args.intendedSource);
      const prodStatus = sample.prodStatus;
      const devStatus = sample.devStatus;

      results.push({
        id: sample.id,
        ts: sample.ts,
        method: sample.method,
        url: sample.url,
        signature: sample.signature,
        prodStatus,
        devStatus,
        intendedSource: args.intendedSource,
        intendedStatus,
        actualStatus,
        error,
        statusMatch: {
          intended: typeof actualStatus === 'number' && typeof intendedStatus === 'number' ? actualStatus === intendedStatus : false,
          prod: typeof actualStatus === 'number' && typeof prodStatus === 'number' ? actualStatus === prodStatus : false,
          dev: typeof actualStatus === 'number' && typeof devStatus === 'number' ? actualStatus === devStatus : false,
        },
        hadBody,
        requestBodyMissing: !!sample.requestBodyMissing,
        requestBodyParseError: !!sample.requestBodyParseError,
        durationMs: Date.now() - started,
        responseBytes,
        responseResourceType,
      });
    }
  } finally {
    await stopServer(serverCtx);
  }

  const overall = summarizeResults(results);
  const r4 = summarizeResults(results.filter((r) => String(r.url).startsWith('/r4/')));
  const r5 = summarizeResults(results.filter((r) => String(r.url).startsWith('/r5/')));

  let comparison = null;
  if (args.compare) {
    const compareAbs = path.resolve(args.compare);
    const priorJson = JSON.parse(fs.readFileSync(compareAbs, 'utf8'));
    const priorResults = Array.isArray(priorJson.results) ? priorJson.results : [];
    comparison = {
      against: compareAbs,
      ...compareAgainstPrior(results, priorResults, sampleById),
    };
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    input: path.resolve(args.input),
    port: args.port,
    endpointPath: args.endpointPath,
    librarySource: args.librarySource,
    intendedSource: args.intendedSource,
    overall,
    r4,
    r5,
    comparison,
    results,
  };

  fs.writeFileSync(outAbs, JSON.stringify(payload, null, 2));

  const cliSummary = {
    out: outAbs,
    intendedSource: args.intendedSource,
    overall: {
      total: overall.total,
      intendedPass: overall.intendedPass,
      intendedFail: overall.intendedFail,
      prodMatch: overall.prodMatch,
      devMatch: overall.devMatch,
    },
    comparison: comparison ? comparison.summary : null,
  };
  console.log(JSON.stringify(cliSummary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

