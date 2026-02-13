#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = {
    inputs: [
      '/home/jmandel/hobby/FHIRsmith/captured/loinc.ndjson',
      '/home/jmandel/hobby/FHIRsmith/captured/rxnorm.ndjson',
    ],
    mainRoot: '/home/jmandel/hobby/FHIRsmith-main',
    convRoot: '/home/jmandel/hobby/FHIRsmith-tx-mainline-convergence',
    mainLibrary: '/tmp/sample-main-loinc-rxnorm.yml',
    convLibrary: '/tmp/sample-loinc-rxnorm.yml',
    endpointPath: '/r4',
    fhirVersion: '4.0',
    portMain: 9630,
    portConv: 9631,
    out: 'captured/compare-main-vs-convergence-body-diff-analysis-20260213.json',
    suppressExpansionMetadata: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) out.inputs.push(argv[++i]);
    else if (a === '--inputs' && argv[i + 1]) out.inputs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--main-root' && argv[i + 1]) out.mainRoot = argv[++i];
    else if (a === '--conv-root' && argv[i + 1]) out.convRoot = argv[++i];
    else if (a === '--main-library' && argv[i + 1]) out.mainLibrary = argv[++i];
    else if (a === '--conv-library' && argv[i + 1]) out.convLibrary = argv[++i];
    else if (a === '--endpoint-path' && argv[i + 1]) out.endpointPath = argv[++i];
    else if (a === '--fhir-version' && argv[i + 1]) out.fhirVersion = argv[++i];
    else if (a === '--port-main' && argv[i + 1]) out.portMain = Number(argv[++i]);
    else if (a === '--port-conv' && argv[i + 1]) out.portConv = Number(argv[++i]);
    else if (a === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (a === '--keep-expansion-metadata') out.suppressExpansionMetadata = false;
  }

  if (!out.inputs.length) throw new Error('No inputs provided');
  return out;
}

function stableStringify(value) {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function deepSortKeys(value) {
  if (Array.isArray(value)) return value.map((v) => deepSortKeys(v));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const k of Object.keys(value).sort()) {
    out[k] = deepSortKeys(value[k]);
  }
  return out;
}

function parseJsonIfPossible(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const t = text.trim();
  if (t[0] !== '{' && t[0] !== '[') return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex');
}

function normalizeContains(contains) {
  if (!Array.isArray(contains)) return [];
  const rows = contains.map((row) => {
    const out = deepSortKeys(row);
    if (Array.isArray(out.designation)) {
      out.designation = out.designation
        .map((d) => deepSortKeys(d))
        .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
    }
    if (Array.isArray(out.property)) {
      out.property = out.property
        .map((p) => deepSortKeys(p))
        .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
    }
    if (Array.isArray(out.contains)) out.contains = normalizeContains(out.contains);
    return out;
  });
  rows.sort((a, b) => {
    const ak = `${a.system || ''}|${a.code || ''}|${a.display || ''}`;
    const bk = `${b.system || ''}|${b.code || ''}|${b.display || ''}`;
    const c = ak.localeCompare(bk);
    if (c !== 0) return c;
    return stableStringify(a).localeCompare(stableStringify(b));
  });
  return rows;
}

function normalizeParameters(params, options) {
  if (!Array.isArray(params)) return [];
  const norm = params.map((p) => {
    const out = deepSortKeys(p);
    if (Array.isArray(out.part)) out.part = normalizeParameters(out.part, options);
    if (out.resource && typeof out.resource === 'object') out.resource = normalizeSemanticBody(out.resource, options);
    return out;
  });
  norm.sort((a, b) => {
    const an = a.name || '';
    const bn = b.name || '';
    const c = an.localeCompare(bn);
    if (c !== 0) return c;
    return stableStringify(a).localeCompare(stableStringify(b));
  });
  return norm;
}

function normalizeSemanticBody(body, options = {}) {
  if (!body || typeof body !== 'object') return body;
  const rt = body.resourceType;
  const out = deepSortKeys(body);

  if (rt === 'Parameters' && Array.isArray(out.parameter)) {
    out.parameter = normalizeParameters(out.parameter, options);
    return out;
  }

  if (rt === 'ValueSet' && out.expansion && Array.isArray(out.expansion.contains)) {
    out.expansion.contains = normalizeContains(out.expansion.contains);
    if (Array.isArray(out.expansion.parameter)) out.expansion.parameter = normalizeParameters(out.expansion.parameter, options);
    if (options.suppressExpansionMetadata !== false) {
      delete out.expansion.identifier;
      delete out.expansion.timestamp;
    }
    return out;
  }

  if (rt === 'OperationOutcome' && Array.isArray(out.issue)) {
    out.issue = out.issue
      .map((i) => deepSortKeys(i))
      .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
    return out;
  }

  return out;
}

function flattenContains(contains, fallbackSystem, out) {
  if (!Array.isArray(contains)) return;
  for (const c of contains) {
    const system = c.system || fallbackSystem || '';
    const code = c.code || '';
    const key = `${system}|${code}`;
    const simplified = {
      system,
      code,
      display: c.display || null,
      inactive: c.inactive === true,
      abstract: c.abstract === true,
      designation: Array.isArray(c.designation)
        ? c.designation.map((d) => deepSortKeys(d)).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
        : [],
      property: Array.isArray(c.property)
        ? c.property.map((p) => deepSortKeys(p)).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
        : [],
    };
    out.set(key, simplified);
    if (Array.isArray(c.contains)) flattenContains(c.contains, system, out);
  }
}

function buildContainsMap(vs) {
  const map = new Map();
  if (!vs || !vs.expansion) return map;
  const fallbackSystem = vs.expansion.system || '';
  flattenContains(vs.expansion.contains, fallbackSystem, map);
  return map;
}

function paramNameValueMultimap(parametersResource) {
  const out = new Map();
  const params = Array.isArray(parametersResource?.parameter) ? parametersResource.parameter : [];
  for (const p of params) {
    const name = p?.name || '';
    const cloned = deepSortKeys(p);
    const serial = stableStringify(cloned);
    const arr = out.get(name) || [];
    arr.push(serial);
    out.set(name, arr);
  }
  for (const [k, arr] of out.entries()) arr.sort();
  return out;
}

function diffMultimapKeys(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const changed = [];
  for (const k of keys) {
    const av = a.get(k) || [];
    const bv = b.get(k) || [];
    if (av.length !== bv.length || av.some((v, i) => v !== bv[i])) changed.push(k);
  }
  changed.sort();
  return changed;
}

function getParameterBoolean(parametersResource, name) {
  const params = Array.isArray(parametersResource?.parameter) ? parametersResource.parameter : [];
  for (const p of params) {
    if (p?.name === name && typeof p.valueBoolean === 'boolean') return p.valueBoolean;
  }
  return null;
}

function collectDiffPaths(a, b, pathSoFar, out, limit) {
  if (out.length >= limit) return;
  if (Object.is(a, b)) return;

  const pathLabel = pathSoFar || '$';
  const aObj = a && typeof a === 'object';
  const bObj = b && typeof b === 'object';
  if (!aObj || !bObj) {
    out.push(pathLabel);
    return;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push(pathLabel);
      return;
    }
    if (a.length !== b.length) out.push(`${pathLabel}.length`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n && out.length < limit; i++) {
      collectDiffPaths(a[i], b[i], `${pathLabel}[${i}]`, out, limit);
    }
    return;
  }

  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    if (out.length >= limit) break;
    if (!(k in a)) {
      out.push(`${pathLabel}.${k} (missing-main)`);
      continue;
    }
    if (!(k in b)) {
      out.push(`${pathLabel}.${k} (missing-conv)`);
      continue;
    }
    collectDiffPaths(a[k], b[k], `${pathLabel}.${k}`, out, limit);
  }
}

function classifySemanticDifference(sample, mainBody, convBody) {
  const rtMain = mainBody?.resourceType || null;
  const rtConv = convBody?.resourceType || null;
  if (rtMain === 'ValueSet' && rtConv === 'ValueSet') {
    const mainMap = buildContainsMap(mainBody);
    const convMap = buildContainsMap(convBody);
    const mainKeys = new Set(mainMap.keys());
    const convKeys = new Set(convMap.keys());
    let mainOnly = 0;
    let convOnly = 0;
    for (const k of mainKeys) if (!convKeys.has(k)) mainOnly++;
    for (const k of convKeys) if (!mainKeys.has(k)) convOnly++;
    if (mainOnly || convOnly) {
      return {
        category: 'expansion_membership_diff',
        meaningful: true,
        detail: { mainOnly, convOnly, common: [...mainKeys].filter((k) => convKeys.has(k)).length },
      };
    }

    let displayDiff = 0;
    let detailDiff = 0;
    for (const k of mainKeys) {
      const m = mainMap.get(k);
      const c = convMap.get(k);
      if ((m.display || null) !== (c.display || null)) displayDiff++;
      const mNoDisplay = { ...m, display: null };
      const cNoDisplay = { ...c, display: null };
      if (stableStringify(mNoDisplay) !== stableStringify(cNoDisplay)) detailDiff++;
    }

    if (detailDiff === 0 && displayDiff === 0) {
      return {
        category: 'expansion_metadata_only_diff',
        meaningful: false,
        detail: { codeCount: mainKeys.size },
      };
    }

    if (detailDiff === 0 && displayDiff > 0) {
      return {
        category: 'expansion_display_diff',
        meaningful: true,
        detail: { codeCount: mainKeys.size, displayDiff },
      };
    }
    return {
      category: 'expansion_concept_detail_diff',
      meaningful: true,
      detail: { codeCount: mainKeys.size, displayDiff, detailDiff },
    };
  }

  if (rtMain === 'Parameters' && rtConv === 'Parameters') {
    const mainMM = paramNameValueMultimap(mainBody);
    const convMM = paramNameValueMultimap(convBody);
    const changedNames = diffMultimapKeys(mainMM, convMM);
    const resultMain = getParameterBoolean(mainBody, 'result');
    const resultConv = getParameterBoolean(convBody, 'result');
    if (resultMain !== null && resultConv !== null && resultMain !== resultConv) {
      return {
        category: 'validation_result_diff',
        meaningful: true,
        detail: { resultMain, resultConv, changedNames },
      };
    }
    const msgLike = new Set(['message', 'diagnostics']);
    if (changedNames.length > 0 && changedNames.every((n) => msgLike.has(n))) {
      return {
        category: 'diagnostics_text_diff',
        meaningful: false,
        detail: { changedNames },
      };
    }
    const msgAndIssueLike = new Set(['message', 'diagnostics', 'issues']);
    if (changedNames.length > 0 && changedNames.every((n) => msgAndIssueLike.has(n))) {
      return {
        category: 'message_or_issues_text_diff',
        meaningful: false,
        detail: { changedNames },
      };
    }
    if (changedNames.length > 0 && changedNames.every((n) => ['display', 'message', 'diagnostics'].includes(n))) {
      return {
        category: 'display_text_diff',
        meaningful: true,
        detail: { changedNames },
      };
    }
    return {
      category: 'parameters_value_diff',
      meaningful: true,
      detail: { changedNames },
    };
  }

  if (rtMain === 'OperationOutcome' && rtConv === 'OperationOutcome') {
    return {
      category: 'operation_outcome_diff',
      meaningful: false,
      detail: {},
    };
  }

  return {
    category: 'other_semantic_diff',
    meaningful: true,
    detail: { mainResourceType: rtMain, convResourceType: rtConv, method: sample.method, url: sample.url },
  };
}

function summarizeCategories(records) {
  const out = {};
  for (const r of records) out[r.category] = (out[r.category] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function summarizeSignatures(records) {
  const out = {};
  for (const r of records) out[r.signature] = (out[r.signature] || 0) + 1;
  return Object.entries(out)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([signature, count]) => ({ signature, count }));
}

function readNdjson(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForReady(port, endpointPath, timeoutMs = 60000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  const probePath = `${endpointPath.replace(/\/$/, '')}/metadata`;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}${probePath}`, {
        method: 'GET',
        headers: { accept: 'application/fhir+json, application/json' },
      });
      if (resp.status >= 200 && resp.status < 500) return;
      lastError = new Error(`Readiness status ${resp.status}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for server readiness on ${port}: ${lastError ? lastError.message : 'no response'}`);
}

async function startServer(repoRoot, librarySource, port, endpointPath, fhirVersion) {
  const txPath = path.resolve(repoRoot, 'tx/tx.js');
  const statsPath = path.resolve(repoRoot, 'stats.js');
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
    librarySource,
    cacheTimeout: 30,
    expansionCacheSize: 1000,
    expansionCacheMemoryThreshold: 0,
    endpoints: [{ path: endpointPath, fhirVersion, context: null }],
  };

  const stats = new ServerStats();
  const txModule = new TXModule(stats);
  await txModule.initialize(config, app);

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, (err) => (err ? reject(err) : resolve(s)));
  });
  await waitForReady(port, endpointPath);
  return { server, txModule, stats };
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
  if (sample.method === 'POST' && sample.requestBody && typeof sample.requestBody === 'object') {
    req.headers['content-type'] = 'application/fhir+json';
    req.body = JSON.stringify(sample.requestBody);
  }
  const resp = await fetch(`http://127.0.0.1:${port}${sample.url}`, req);
  const bodyText = await resp.text();
  return {
    status: resp.status,
    contentType: resp.headers.get('content-type') || '',
    bodyText,
    bodyJson: parseJsonIfPossible(bodyText),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outAbs = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  const allSamples = [];
  for (const input of args.inputs) {
    const abs = path.resolve(input);
    const records = readNdjson(abs);
    const sourceName = path.basename(abs).replace(/\.ndjson$/i, '');
    for (const r of records) {
      if (typeof r?.url !== 'string') continue;
      if (!r.url.startsWith(`${args.endpointPath}/`)) continue;
      allSamples.push({
        source: sourceName,
        id: r.id || `${sourceName}-${allSamples.length + 1}`,
        method: String(r.method || 'GET').toUpperCase(),
        url: r.url,
        signature: r.signature || `${String(r.method || 'GET').toUpperCase()} ${r.url}`,
        requestBody: r.requestBody && typeof r.requestBody === 'object' ? r.requestBody : null,
      });
    }
  }

  const bySourceTotals = {};
  for (const s of allSamples) bySourceTotals[s.source] = (bySourceTotals[s.source] || 0) + 1;

  const ctxMain = await startServer(args.mainRoot, args.mainLibrary, args.portMain, args.endpointPath, args.fhirVersion);
  const ctxConv = await startServer(args.convRoot, args.convLibrary, args.portConv, args.endpointPath, args.fhirVersion);

  const comparisons = [];
  try {
    for (const sample of allSamples) {
      const [mainResp, convResp] = await Promise.all([sendRequest(args.portMain, sample), sendRequest(args.portConv, sample)]);

      const strictMainBody = mainResp.bodyJson ? deepSortKeys(mainResp.bodyJson) : null;
      const strictConvBody = convResp.bodyJson ? deepSortKeys(convResp.bodyJson) : null;
      const semanticMainBody = mainResp.bodyJson
        ? normalizeSemanticBody(mainResp.bodyJson, { suppressExpansionMetadata: args.suppressExpansionMetadata })
        : null;
      const semanticConvBody = convResp.bodyJson
        ? normalizeSemanticBody(convResp.bodyJson, { suppressExpansionMetadata: args.suppressExpansionMetadata })
        : null;

      const strictHashMain = mainResp.bodyJson ? sha256(stableStringify(strictMainBody)) : sha256(mainResp.bodyText);
      const strictHashConv = convResp.bodyJson ? sha256(stableStringify(strictConvBody)) : sha256(convResp.bodyText);
      const semanticHashMain = mainResp.bodyJson ? sha256(stableStringify(semanticMainBody)) : strictHashMain;
      const semanticHashConv = convResp.bodyJson ? sha256(stableStringify(semanticConvBody)) : strictHashConv;

      const both2xx = mainResp.status >= 200 && mainResp.status < 300 && convResp.status >= 200 && convResp.status < 300;
      const statusSame = mainResp.status === convResp.status;
      const strictSame = strictHashMain === strictHashConv;
      const semanticSame = semanticHashMain === semanticHashConv;

      let category = 'same_strict';
      let meaningful = false;
      let detail = {};
      let diffPaths = [];

      if (!statusSame) {
        category = 'status_diff';
        meaningful = true;
        detail = { mainStatus: mainResp.status, convStatus: convResp.status };
      } else if (!both2xx) {
        category = 'same_non_2xx_status';
      } else if (strictSame) {
        category = 'same_strict';
      } else if (semanticSame) {
        category = 'ordering_or_nonsemantic_diff';
        meaningful = false;
      } else if (!mainResp.bodyJson || !convResp.bodyJson) {
        category = 'non_json_body_diff';
        meaningful = true;
      } else {
        const semanticClass = classifySemanticDifference(sample, mainResp.bodyJson, convResp.bodyJson);
        category = semanticClass.category;
        meaningful = semanticClass.meaningful;
        detail = semanticClass.detail || {};
        diffPaths = [];
        collectDiffPaths(semanticMainBody, semanticConvBody, '$', diffPaths, 20);
      }

      comparisons.push({
        id: sample.id,
        source: sample.source,
        method: sample.method,
        url: sample.url,
        signature: sample.signature,
        mainStatus: mainResp.status,
        convStatus: convResp.status,
        both2xx,
        statusSame,
        strictSame,
        semanticSame,
        category,
        meaningful,
        detail,
        mainBytes: Buffer.byteLength(mainResp.bodyText || '', 'utf8'),
        convBytes: Buffer.byteLength(convResp.bodyText || '', 'utf8'),
        mainResourceType: mainResp.bodyJson?.resourceType || null,
        convResourceType: convResp.bodyJson?.resourceType || null,
        diffPaths,
      });
    }
  } finally {
    await stopServer(ctxConv);
    await stopServer(ctxMain);
  }

  const summary = {
    total: comparisons.length,
    bySourceTotals,
    statusSame: comparisons.filter((r) => r.statusSame).length,
    statusDiff: comparisons.filter((r) => !r.statusSame).length,
    both2xx: comparisons.filter((r) => r.both2xx).length,
    strictSame: comparisons.filter((r) => r.both2xx && r.strictSame).length,
    semanticSame: comparisons.filter((r) => r.both2xx && r.semanticSame).length,
    bodyDifferentAmongBoth2xx: comparisons.filter((r) => r.both2xx && !r.strictSame).length,
    meaningfulDifferentAmongBoth2xx: comparisons.filter((r) => r.both2xx && !r.strictSame && r.meaningful).length,
    nonMeaningfulDifferentAmongBoth2xx: comparisons.filter((r) => r.both2xx && !r.strictSame && !r.meaningful).length,
    categoryCounts: summarizeCategories(comparisons.filter((r) => !r.strictSame || !r.statusSame)),
    topSignaturesForDifferences: summarizeSignatures(comparisons.filter((r) => !r.strictSame || !r.statusSame)),
  };

  const perSource = {};
  for (const source of Object.keys(bySourceTotals)) {
    const rows = comparisons.filter((r) => r.source === source);
    perSource[source] = {
      total: rows.length,
      statusSame: rows.filter((r) => r.statusSame).length,
      statusDiff: rows.filter((r) => !r.statusSame).length,
      both2xx: rows.filter((r) => r.both2xx).length,
      strictSame: rows.filter((r) => r.both2xx && r.strictSame).length,
      semanticSame: rows.filter((r) => r.both2xx && r.semanticSame).length,
      bodyDifferentAmongBoth2xx: rows.filter((r) => r.both2xx && !r.strictSame).length,
      meaningfulDifferentAmongBoth2xx: rows.filter((r) => r.both2xx && !r.strictSame && r.meaningful).length,
      nonMeaningfulDifferentAmongBoth2xx: rows.filter((r) => r.both2xx && !r.strictSame && !r.meaningful).length,
      categoryCounts: summarizeCategories(rows.filter((r) => !r.strictSame || !r.statusSame)),
    };
  }

  const examplesByCategory = {};
  for (const row of comparisons) {
    if (row.strictSame && row.statusSame) continue;
    const arr = examplesByCategory[row.category] || [];
    if (arr.length < 12) arr.push(row);
    examplesByCategory[row.category] = arr;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      inputs: args.inputs,
      mainRoot: args.mainRoot,
      convRoot: args.convRoot,
      mainLibrary: args.mainLibrary,
      convLibrary: args.convLibrary,
      endpointPath: args.endpointPath,
      fhirVersion: args.fhirVersion,
      suppressExpansionMetadata: args.suppressExpansionMetadata,
      ports: { main: args.portMain, conv: args.portConv },
    },
    summary,
    perSource,
    examplesByCategory,
    comparisons,
  };

  fs.writeFileSync(outAbs, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out: outAbs, summary, perSource }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
