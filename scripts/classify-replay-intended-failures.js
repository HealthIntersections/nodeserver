#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {
    replay: '',
    ndjson: '',
    out: '',
    top: 20,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--replay' && argv[i + 1]) out.replay = argv[++i];
    else if (a === '--ndjson' && argv[i + 1]) out.ndjson = argv[++i];
    else if (a === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (a === '--top' && argv[i + 1]) out.top = Number(argv[++i]);
  }
  if (!out.replay || !out.ndjson) {
    throw new Error('Usage: classify-replay-intended-failures.js --replay <file.json> --ndjson <file.ndjson> [--out <file.json>] [--top <n>]');
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function readNdjsonMap(filePath) {
  const abs = path.resolve(filePath);
  const out = new Map();
  const lines = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && obj.id) out.set(obj.id, obj);
    } catch (_e) {
      // ignore malformed line
    }
  }
  return out;
}

function maybeRequestBodyObject(sample) {
  if (!sample) return null;
  const rb = sample.requestBody;
  if (rb && typeof rb === 'object' && !Array.isArray(rb)) return rb;
  return null;
}

function getParams(bodyObj) {
  if (!bodyObj || bodyObj.resourceType !== 'Parameters') return [];
  return Array.isArray(bodyObj.parameter) ? bodyObj.parameter : [];
}

function findParam(params, name) {
  return params.find((p) => p && p.name === name) || null;
}

function collectValueSetsFromParams(params) {
  const out = [];
  for (const p of params) {
    if (!p || !p.resource || typeof p.resource !== 'object') continue;
    if (p.resource.resourceType === 'ValueSet') out.push(p.resource);
  }
  return out;
}

function hasRxnormTtyInFilter(valueSets) {
  for (const vs of valueSets) {
    const include = vs?.compose?.include;
    if (!Array.isArray(include)) continue;
    for (const inc of include) {
      const filters = Array.isArray(inc?.filter) ? inc.filter : [];
      for (const f of filters) {
        const prop = String(f?.property || '').toLowerCase();
        const op = String(f?.op || '').toLowerCase();
        if (prop === 'tty' && op === 'in') return true;
      }
    }
  }
  return false;
}

function hasBcp13GrammarEnumeration(valueSets) {
  for (const vs of valueSets) {
    const include = vs?.compose?.include;
    if (!Array.isArray(include)) continue;
    for (const inc of include) {
      if (String(inc?.system || '') === 'urn:ietf:bcp:13') return true;
    }
  }
  return false;
}

function hasCtsUrlInParams(params, valueSets) {
  const urlParam = findParam(params, 'url');
  const urlV = urlParam?.valueUri || urlParam?.valueCanonical || urlParam?.valueString || '';
  if (typeof urlV === 'string' && /cts\.nlm\.nih\.gov/i.test(urlV)) return true;
  for (const vs of valueSets) {
    const u = vs?.url || '';
    if (typeof u === 'string' && /cts\.nlm\.nih\.gov/i.test(u)) return true;
  }
  return false;
}

function hasMissingSnomedModuleVersionParam(params) {
  const p = findParam(params, 'system-version');
  const uri = p?.valueUri || p?.valueCanonical || p?.valueString || '';
  return typeof uri === 'string' && uri.includes('http://snomed.info/sct/83821000000107');
}

function hasDisplayLanguageEnglish(params) {
  const p = findParam(params, 'displayLanguage');
  const v = p?.valueString || p?.valueCode || '';
  return String(v).toLowerCase() === 'english';
}

function classifyFailure(resultRow, sampleRow) {
  const url = String(resultRow.url || '');
  const method = String(resultRow.method || '');

  if (url.startsWith('/r5/')) return 'endpoint_r5_not_enabled';
  if (/cts\.nlm\.nih\.gov/i.test(url)) return 'external_cts_valueset_not_loaded';
  if (method === 'POST' && resultRow.hadBody === false) return 'captured_post_body_unparsed_or_missing';

  const bodyObj = maybeRequestBodyObject(sampleRow);
  const params = getParams(bodyObj);
  const valueSets = collectValueSetsFromParams(params);

  if (hasCtsUrlInParams(params, valueSets)) return 'external_cts_valueset_not_loaded';
  if (hasBcp13GrammarEnumeration(valueSets) && resultRow.actualStatus === 422) {
    return 'grammar_code_system_not_enumerable';
  }
  if (hasDisplayLanguageEnglish(params)) return 'invalid_displayLanguage_english';
  if (hasRxnormTtyInFilter(valueSets)) return 'rxnorm_filter_tty_in_not_supported';
  if (hasMissingSnomedModuleVersionParam(params)) return 'snomed_module_version_not_loaded';
  if (
    resultRow.intendedStatus === 500 &&
    resultRow.actualStatus === 422 &&
    String(resultRow.signature || '').includes('ValueSet $expand')
  ) {
    return 'too_costly_422_replaces_legacy_500';
  }
  if (
    String(resultRow.signature || '').includes('tx-resource') &&
    resultRow.intendedStatus === 200 &&
    resultRow.actualStatus === 422
  ) {
    return 'tx_resource_dependency_not_resolved';
  }

  if (resultRow.prodStatus !== resultRow.devStatus) return 'upstream_prod_dev_disagree';
  return 'other_needs_triage';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const replay = readJson(args.replay);
  const ndjsonById = readNdjsonMap(args.ndjson);
  const fails = (replay.results || []).filter((r) => r.statusMatch?.intended !== true);

  const rows = fails.map((r) => {
    const sample = ndjsonById.get(r.id);
    const category = classifyFailure(r, sample);
    return {
      id: r.id,
      category,
      intendedStatus: r.intendedStatus,
      actualStatus: r.actualStatus,
      prodStatus: r.prodStatus,
      devStatus: r.devStatus,
      method: r.method,
      url: r.url,
      signature: r.signature,
      requestBodyParseError: !!r.requestBodyParseError,
      hadBody: !!r.hadBody,
    };
  });

  const counts = {};
  for (const r of rows) counts[r.category] = (counts[r.category] || 0) + 1;

  const byCategory = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => {
      const examples = rows.filter((r) => r.category === category).slice(0, args.top);
      return { category, count, examples };
    });

  const out = {
    generatedAt: new Date().toISOString(),
    replayFile: path.resolve(args.replay),
    ndjsonFile: path.resolve(args.ndjson),
    intendedSource: replay.intendedSource || null,
    total: replay?.overall?.total || (replay.results || []).length,
    intendedFail: replay?.overall?.intendedFail || fails.length,
    categories: byCategory,
  };

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    // eslint-disable-next-line no-console
    console.log(`Wrote ${outPath}`);
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    intendedFail: out.intendedFail,
    categories: byCategory.map((c) => ({ category: c.category, count: c.count })),
  }, null, 2));
}

main();
