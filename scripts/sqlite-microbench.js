#!/usr/bin/env node
'use strict';

/**
 * SQLite microbenchmarks for RxNorm provider interface design.
 * Run: node scripts/sqlite-microbench.js [path-to-rxnorm.db]
 *
 * Tests both async `sqlite3` and sync `better-sqlite3` to inform
 * whether lazy cursors, LIMIT/OFFSET, UNION, etc. are worth using
 * in the expandForValueSet provider interface.
 */

const path = require('path');

// --- Configuration ---
const DB_PATH = process.argv[2] || path.join(__dirname, '..', 'data', 'terminology-cache', 'rxnorm_02032025-a.db');
const WARMUP = 1;
const ITERATIONS = 5;

// --- Helpers ---
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stats(arr) {
  const med = median(arr);
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  return { median: med.toFixed(2), min: min.toFixed(2), max: max.toFixed(2) };
}

async function bench(name, fn, iterations = ITERATIONS, warmup = WARMUP) {
  // Warmup
  for (let i = 0; i < warmup; i++) await fn();

  const times = [];
  let lastResult;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    lastResult = await fn();
    times.push(performance.now() - t0);
  }
  const s = stats(times);
  const extra = lastResult && typeof lastResult === 'object' && lastResult._rows != null
    ? ` (${lastResult._rows} rows)` : '';
  console.log(`  ${name}: ${s.median}ms median [${s.min}–${s.max}]${extra}`);
  return { name, ...s, ...lastResult };
}

// --- Load both sqlite packages ---
let sqlite3Async, BetterSqlite3;
try { sqlite3Async = require('sqlite3').verbose(); } catch (e) {
  console.error('sqlite3 package not available'); process.exit(1);
}
try { BetterSqlite3 = require('better-sqlite3'); } catch (e) {
  console.warn('better-sqlite3 not available — skipping sync benchmarks');
}

// Async sqlite3 helper: promisified db.all
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

// Async sqlite3 helper: db.each with optional early abort
function dbEach(db, sql, params, rowCb) {
  return new Promise((resolve, reject) => {
    let count = 0;
    db.each(sql, params, (err, row) => {
      if (err) { reject(err); return; }
      count++;
      rowCb(row, count);
    }, (err, totalRows) => {
      if (err) reject(err);
      else resolve({ count, totalRows });
    });
  });
}

// Open async db
function openAsync(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3Async.Database(dbPath, sqlite3Async.OPEN_READONLY, (err) => {
      if (err) reject(err); else resolve(db);
    });
  });
}

function closeAsync(db) {
  return new Promise((resolve) => db.close(resolve));
}

// Base query
const BASE_SQL = `SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY<>'SY'`;
const SBD_SQL = `SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD'`;

// --- Benchmark functions ---

async function runB1(db) {
  console.log('\n=== B1: db.all() full materialization (SBD ~23k rows) ===');
  await bench('db.all(SBD)', async () => {
    const rows = await dbAll(db, SBD_SQL);
    return { _rows: rows.length };
  });
}

async function runB2(db) {
  console.log('\n=== B2: db.all() with LIMIT/OFFSET ===');
  for (const offset of [0, 100, 1000, 10000]) {
    await bench(`LIMIT 100 OFFSET ${offset}`, async () => {
      const rows = await dbAll(db, SBD_SQL + ` ORDER BY RXCUI LIMIT 100 OFFSET ${offset}`);
      return { _rows: rows.length };
    });
  }
}

async function runB3(db) {
  console.log('\n=== B3: db.each() row-at-a-time (SBD) ===');

  await bench('db.each() all rows', async () => {
    let count = 0;
    await dbEach(db, SBD_SQL, [], () => { count++; });
    return { _rows: count };
  });

  // db.each with processing only first N rows (can't truly abort in sqlite3)
  for (const n of [100, 1100]) {
    await bench(`db.each() process first ${n}`, async () => {
      let processed = 0;
      await dbEach(db, SBD_SQL, [], (row, count) => {
        if (processed < n) {
          // Simulate processing
          const obj = { code: row.RXCUI, display: row.STR, suppress: row.SUPPRESS };
          processed++;
        }
      });
      return { _rows: processed };
    });
  }
}

async function runB4(bdb) {
  console.log('\n=== B4: better-sqlite3 stmt.iterate() — lazy cursor ===');
  const stmt = bdb.prepare(SBD_SQL);

  await bench('iterate() all rows', () => {
    let count = 0;
    for (const row of stmt.iterate()) { count++; }
    return { _rows: count };
  });

  for (const n of [100, 1100, 5000]) {
    await bench(`iterate() break after ${n}`, () => {
      let count = 0;
      for (const row of stmt.iterate()) {
        count++;
        if (count >= n) break;
      }
      return { _rows: count };
    });
  }
}

async function runB5(bdb) {
  console.log('\n=== B5: better-sqlite3 all() vs iterate() — full results ===');
  const stmt = bdb.prepare(SBD_SQL);

  await bench('stmt.all()', () => {
    const rows = stmt.all();
    return { _rows: rows.length };
  });

  await bench('stmt.iterate() → array', () => {
    const rows = [];
    for (const row of stmt.iterate()) { rows.push(row); }
    return { _rows: rows.length };
  });

  await bench('stmt.iterate() count only', () => {
    let count = 0;
    for (const row of stmt.iterate()) { count++; }
    return { _rows: count };
  });
}

async function runB6(bdb) {
  console.log('\n=== B6: better-sqlite3 prepared statement reuse ===');
  const stmt = bdb.prepare(
    `SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY=?`
  );

  // First call includes any implicit caching/compilation
  const ttys = ['SBD', 'SCD', 'IN', 'SBDC', 'SCDC'];

  await bench('prepare+iterate SBD (first)', () => {
    const s = bdb.prepare(`SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY=?`);
    let count = 0;
    for (const row of s.iterate('SBD')) count++;
    return { _rows: count };
  });

  await bench('reuse stmt across 5 TTYs', () => {
    let total = 0;
    for (const tty of ttys) {
      for (const row of stmt.iterate(tty)) total++;
    }
    return { _rows: total };
  });

  // Compare: iterate same TTY 5 times (reuse amortization)
  await bench('reuse stmt, SBD x5', () => {
    let total = 0;
    for (let i = 0; i < 5; i++) {
      for (const row of stmt.iterate('SBD')) total++;
    }
    return { _rows: total };
  });
}

async function runB7(bdb) {
  console.log('\n=== B7: UNION vs separate queries vs IN() ===');

  await bench('UNION ALL (SBD+SCD)', () => {
    const stmt = bdb.prepare(
      `SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD'
       UNION ALL
       SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SCD'`
    );
    let count = 0;
    for (const row of stmt.iterate()) count++;
    return { _rows: count };
  });

  await bench('Two separate queries', () => {
    const s1 = bdb.prepare(`SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD'`);
    const s2 = bdb.prepare(`SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SCD'`);
    let count = 0;
    for (const row of s1.iterate()) count++;
    for (const row of s2.iterate()) count++;
    return { _rows: count };
  });

  await bench('IN (SBD, SCD)', () => {
    const stmt = bdb.prepare(
      `SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY IN ('SBD','SCD')`
    );
    let count = 0;
    for (const row of stmt.iterate()) count++;
    return { _rows: count };
  });
}

async function runB8(bdb) {
  console.log('\n=== B8: NOT IN for excludes ===');

  // Get 50 real RxCUIs to use as excludes
  const sample = bdb.prepare(
    `SELECT RXCUI FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' LIMIT 50`
  ).all().map(r => r.RXCUI);

  const excludeList = sample.map(c => `'${c}'`).join(',');
  const excludeSet = new Set(sample);

  await bench('SQL NOT IN (50 codes)', () => {
    const stmt = bdb.prepare(
      `SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' AND RXCUI NOT IN (${excludeList})`
    );
    let count = 0;
    for (const row of stmt.iterate()) count++;
    return { _rows: count };
  });

  await bench('JS filter (50 codes)', () => {
    const stmt = bdb.prepare(SBD_SQL);
    let count = 0;
    for (const row of stmt.iterate()) {
      if (!excludeSet.has(row.RXCUI)) count++;
    }
    return { _rows: count };
  });

  // Larger exclude: 500 codes
  const sample500 = bdb.prepare(
    `SELECT RXCUI FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' LIMIT 500`
  ).all().map(r => r.RXCUI);
  const excludeList500 = sample500.map(c => `'${c}'`).join(',');
  const excludeSet500 = new Set(sample500);

  await bench('SQL NOT IN (500 codes)', () => {
    const stmt = bdb.prepare(
      `SELECT RXCUI, STR, SUPPRESS FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD' AND RXCUI NOT IN (${excludeList500})`
    );
    let count = 0;
    for (const row of stmt.iterate()) count++;
    return { _rows: count };
  });

  await bench('JS filter (500 codes)', () => {
    const stmt = bdb.prepare(SBD_SQL);
    let count = 0;
    for (const row of stmt.iterate()) {
      if (!excludeSet500.has(row.RXCUI)) count++;
    }
    return { _rows: count };
  });
}

async function runB9(bdb) {
  console.log('\n=== B9: Row construction cost ===');
  const stmt = bdb.prepare(SBD_SQL);

  await bench('Count only (no construction)', () => {
    let count = 0;
    for (const row of stmt.iterate()) count++;
    return { _rows: count };
  });

  await bench('Minimal object { code, display, suppress }', () => {
    let count = 0;
    for (const row of stmt.iterate()) {
      const obj = { code: row.RXCUI, display: row.STR, suppress: row.SUPPRESS === '1' };
      count++;
    }
    return { _rows: count };
  });

  await bench('Rich object (FHIR-like entry)', () => {
    let count = 0;
    for (const row of stmt.iterate()) {
      const entry = {
        system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
        code: row.RXCUI,
        display: row.STR,
        inactive: row.SUPPRESS === '1',
        designation: [{ language: 'en', value: row.STR }],
        property: row.SUPPRESS !== '1'
          ? []
          : [{ code: 'status', valueCode: 'inactive' }],
      };
      count++;
    }
    return { _rows: count };
  });

  await bench('Rich object + Map dedup check', () => {
    let count = 0;
    const map = new Map();
    for (const row of stmt.iterate()) {
      const key = `http://www.nlm.nih.gov/research/umls/rxnorm|${row.RXCUI}`;
      if (!map.has(key)) {
        const entry = {
          system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
          code: row.RXCUI,
          display: row.STR,
          inactive: row.SUPPRESS === '1',
          designation: [{ language: 'en', value: row.STR }],
          property: row.SUPPRESS !== '1'
            ? []
            : [{ code: 'status', valueCode: 'inactive' }],
        };
        map.set(key, entry);
        count++;
      }
    }
    return { _rows: count };
  });
}

async function runB10(bdb) {
  console.log('\n=== B10: OFFSET scan cost (all TTYs ~250k rows) ===');

  for (const offset of [0, 100, 1000, 10000, 50000, 100000]) {
    await bench(`LIMIT 100 OFFSET ${offset}`, () => {
      const stmt = bdb.prepare(BASE_SQL + ` ORDER BY RXCUI LIMIT 100 OFFSET ${offset}`);
      const rows = stmt.all();
      return { _rows: rows.length };
    });
  }

  console.log('\n  (compare: no ORDER BY)');
  for (const offset of [0, 10000, 50000, 100000]) {
    await bench(`no ORDER LIMIT 100 OFFSET ${offset}`, () => {
      const stmt = bdb.prepare(BASE_SQL + ` LIMIT 100 OFFSET ${offset}`);
      const rows = stmt.all();
      return { _rows: rows.length };
    });
  }
}

// --- Bonus: async vs sync package comparison ---
async function runPackageComparison(asyncDb, syncDb) {
  console.log('\n=== BONUS: async sqlite3 vs better-sqlite3 (SBD all rows) ===');

  await bench('async sqlite3 db.all()', async () => {
    const rows = await dbAll(asyncDb, SBD_SQL);
    return { _rows: rows.length };
  });

  await bench('sync better-sqlite3 stmt.all()', () => {
    const rows = syncDb.prepare(SBD_SQL).all();
    return { _rows: rows.length };
  });

  await bench('sync better-sqlite3 stmt.iterate()', () => {
    let count = 0;
    for (const row of syncDb.prepare(SBD_SQL).iterate()) count++;
    return { _rows: count };
  });
}

// --- Main ---
async function main() {
  console.log(`SQLite Microbenchmarks — RxNorm`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Iterations: ${ITERATIONS} (warmup: ${WARMUP})`);
  console.log(`Node: ${process.version}`);

  // Open async db
  const asyncDb = await openAsync(DB_PATH);

  // Get row count for reference
  const countRow = await dbAll(asyncDb, `SELECT COUNT(*) as cnt FROM rxnconso WHERE SAB='RXNORM' AND TTY='SBD'`);
  console.log(`SBD rows: ${countRow[0].cnt}`);
  const allCount = await dbAll(asyncDb, `SELECT COUNT(*) as cnt FROM rxnconso WHERE SAB='RXNORM' AND TTY<>'SY'`);
  console.log(`All non-SY rows: ${allCount[0].cnt}`);

  // --- Async sqlite3 benchmarks ---
  await runB1(asyncDb);
  await runB2(asyncDb);
  await runB3(asyncDb);

  // --- Better-sqlite3 benchmarks ---
  let syncDb;
  if (BetterSqlite3) {
    syncDb = new BetterSqlite3(DB_PATH, { readonly: true });

    await runB4(syncDb);
    await runB5(syncDb);
    await runB6(syncDb);
    await runB7(syncDb);
    await runB8(syncDb);
    await runB9(syncDb);
    await runB10(syncDb);

    // Package comparison
    await runPackageComparison(asyncDb, syncDb);

    syncDb.close();
  } else {
    console.log('\n[SKIPPED] better-sqlite3 benchmarks (package not installed)');
  }

  await closeAsync(asyncDb);

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
