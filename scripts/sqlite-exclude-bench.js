#!/usr/bin/env node
/* eslint-disable no-unused-vars */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.argv[2] || path.join(__dirname, '..', 'data', 'terminology-cache', 'rxnorm_02032025-a.db');
const db = new Database(DB_PATH, { readonly: true });

// Get real exclude codes
const all50 = db.prepare("SELECT RXCUI FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' LIMIT 50").all().map(r => r.RXCUI);
const all500 = db.prepare("SELECT RXCUI FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' LIMIT 500").all().map(r => r.RXCUI);
const all2000 = db.prepare("SELECT RXCUI FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' LIMIT 2000").all().map(r => r.RXCUI);

function bench(name, fn, n = 7) {
  fn(); fn(); // warmup
  const times = [];
  let result;
  for (let i = 0; i < n; i++) { const t = performance.now(); result = fn(); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  const rows = typeof result === 'number' ? result : '?';
  console.log(`  ${name}: ${times[3].toFixed(3)}ms median [${times[0].toFixed(3)}–${times[6].toFixed(3)}] (${rows} rows)`);
}

const BASE = "SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' ORDER BY RXCUI";

// --- Query plans ---
console.log('=== Query plans ===');
const plans = [
  ["Baseline", BASE],
  ["NOT IN literal", "SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' AND RXCUI NOT IN ('12345') ORDER BY RXCUI"],
  ["NOT IN subquery", "SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' AND RXCUI NOT IN (SELECT RXCUI FROM rxnconso WHERE SAB='RXNORM' AND TTY='IN') ORDER BY RXCUI"],
  ["NOT EXISTS", "SELECT r.RXCUI, r.STR, r.SUPPRESS FROM rxnconso r WHERE r.SAB='RXNORM' AND r.TTY='SBD' AND NOT EXISTS (SELECT 1 FROM rxnconso x WHERE x.RXCUI=r.RXCUI AND x.SAB='RXNORM' AND x.TTY='IN') ORDER BY r.RXCUI"],
  ["EXCEPT", "SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' EXCEPT SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='IN'"],
];
for (const [label, sql] of plans) {
  console.log(`\n  ${label}:`);
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all();
  plan.forEach(r => console.log(`    ${r.detail}`));
}

// --- 50 code excludes ---
console.log('\n\n=== Exclude: 50 codes ===');
const lit50 = all50.map(c => `'${c}'`).join(',');
const set50 = new Set(all50);

bench('NOT IN literal(50)', () => {
  let c = 0;
  for (const r of db.prepare(`SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' AND RXCUI NOT IN (${lit50}) ORDER BY RXCUI`).iterate()) c++;
  return c;
});

bench('JS Set.has(50)', () => {
  let c = 0;
  for (const r of db.prepare(BASE).iterate()) { if (!set50.has(r.RXCUI)) c++; }
  return c;
});

bench('NOT IN subquery(IN TTY ~14k)', () => {
  let c = 0;
  for (const r of db.prepare("SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' AND RXCUI NOT IN (SELECT RXCUI FROM rxnconso WHERE SAB='RXNORM' AND TTY='IN') ORDER BY RXCUI").iterate()) c++;
  return c;
});

bench('NOT EXISTS(IN TTY ~14k)', () => {
  let c = 0;
  for (const r of db.prepare("SELECT r.RXCUI, r.STR, r.SUPPRESS FROM rxnconso r WHERE r.SAB='RXNORM' AND r.TTY='SBD' AND NOT EXISTS (SELECT 1 FROM rxnconso x WHERE x.RXCUI=r.RXCUI AND x.SAB='RXNORM' AND x.TTY='IN') ORDER BY r.RXCUI").iterate()) c++;
  return c;
});

bench('EXCEPT(IN TTY)', () => {
  let c = 0;
  for (const r of db.prepare("SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' EXCEPT SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='IN'").iterate()) c++;
  return c;
});

// --- 500 code excludes ---
console.log('\n=== Exclude: 500 codes ===');
const lit500 = all500.map(c => `'${c}'`).join(',');
const set500 = new Set(all500);

bench('NOT IN literal(500)', () => {
  let c = 0;
  for (const r of db.prepare(`SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' AND RXCUI NOT IN (${lit500}) ORDER BY RXCUI`).iterate()) c++;
  return c;
});

bench('JS Set.has(500)', () => {
  let c = 0;
  for (const r of db.prepare(BASE).iterate()) { if (!set500.has(r.RXCUI)) c++; }
  return c;
});

// --- 2000 code excludes ---
console.log('\n=== Exclude: 2000 codes ===');
const lit2000 = all2000.map(c => `'${c}'`).join(',');
const set2000 = new Set(all2000);

bench('NOT IN literal(2000)', () => {
  let c = 0;
  for (const r of db.prepare(`SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' AND RXCUI NOT IN (${lit2000}) ORDER BY RXCUI`).iterate()) c++;
  return c;
});

bench('JS Set.has(2000)', () => {
  let c = 0;
  for (const r of db.prepare(BASE).iterate()) { if (!set2000.has(r.RXCUI)) c++; }
  return c;
});

// --- Temp table approach ---
console.log('\n=== Temp table exclude (2000 codes) ===');

// Need a writable connection for temp tables
const dbRW = new Database(DB_PATH);

dbRW.exec('CREATE TEMP TABLE exclude_codes (rxcui TEXT PRIMARY KEY)');

bench('Temp table + NOT IN subquery', () => {
  dbRW.exec('DELETE FROM exclude_codes');
  const ins = dbRW.prepare('INSERT INTO exclude_codes VALUES (?)');
  const tx = dbRW.transaction(() => { for (const c of all2000) ins.run(c); });
  tx();
  let c = 0;
  for (const r of dbRW.prepare("SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' AND RXCUI NOT IN (SELECT rxcui FROM exclude_codes) ORDER BY RXCUI").iterate()) c++;
  return c;
});

bench('Temp table + LEFT JOIN IS NULL', () => {
  dbRW.exec('DELETE FROM exclude_codes');
  const ins = dbRW.prepare('INSERT INTO exclude_codes VALUES (?)');
  const tx = dbRW.transaction(() => { for (const c of all2000) ins.run(c); });
  tx();
  let c = 0;
  for (const r of dbRW.prepare("SELECT r.RXCUI, r.STR, r.SUPPRESS FROM rxnconso r LEFT JOIN exclude_codes x ON r.RXCUI=x.rxcui WHERE r.SAB='RXNORM' AND r.TTY='SBD' AND x.rxcui IS NULL ORDER BY r.RXCUI").iterate()) c++;
  return c;
});

bench('Temp table + NOT EXISTS', () => {
  dbRW.exec('DELETE FROM exclude_codes');
  const ins = dbRW.prepare('INSERT INTO exclude_codes VALUES (?)');
  const tx = dbRW.transaction(() => { for (const c of all2000) ins.run(c); });
  tx();
  let c = 0;
  for (const r of dbRW.prepare("SELECT r.RXCUI, r.STR, r.SUPPRESS FROM rxnconso r WHERE r.SAB='RXNORM' AND r.TTY='SBD' AND NOT EXISTS (SELECT 1 FROM exclude_codes x WHERE x.rxcui=r.RXCUI) ORDER BY r.RXCUI").iterate()) c++;
  return c;
});

dbRW.close();
db.close();
console.log('\n=== Done ===');
