#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {
    input: 'captured/compare-main-vs-convergence-body-diff-analysis-20260213.v2.json',
    output: 'captured/compare-main-vs-convergence-meaningful-diffs-20260213.json',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) out.input = argv[++i];
    else if (a === '--output' && argv[i + 1]) out.output = argv[++i];
  }
  return out;
}

function summarize(rows) {
  const byCategory = {};
  const bySource = {};
  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    bySource[r.source || 'unknown'] = (bySource[r.source || 'unknown'] || 0) + 1;
  }
  return {
    total: rows.length,
    byCategory: Object.fromEntries(Object.entries(byCategory).sort((a, b) => b[1] - a[1])),
    bySource: Object.fromEntries(Object.entries(bySource).sort((a, b) => b[1] - a[1])),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inAbs = path.resolve(args.input);
  const outAbs = path.resolve(args.output);

  const report = JSON.parse(fs.readFileSync(inAbs, 'utf8'));
  const rows = Array.isArray(report.comparisons) ? report.comparisons : [];
  const meaningful = rows.filter((r) => r.category === 'status_diff' || (r.both2xx && r.meaningful === true));

  const out = {
    generatedAt: new Date().toISOString(),
    sourceReport: inAbs,
    summary: summarize(meaningful),
    rows: meaningful,
  };

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ output: outAbs, summary: out.summary }, null, 2));
}

main();
