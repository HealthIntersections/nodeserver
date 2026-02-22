/**
 * Tests for sqlite3_progress_handler-based query effort limiting.
 * Uses real SNOMED v0 database to verify that:
 * 1. Normal queries complete within the time budget
 * 2. Pathologically expensive queries are interrupted
 * 3. The provider gracefully handles the interrupt
 */

const path = require('path');
const fs = require('fs');

let BetterSqlite3;
try { BetterSqlite3 = require('better-sqlite3-with-progress'); } catch (_) {
  try { BetterSqlite3 = require('better-sqlite3'); } catch (_) { BetterSqlite3 = null; }
}

const snomedDbPath = path.resolve(__dirname, '../../data/terminology-cache/sct_intl_20250201.v0.db');
const hasSnomedDb = fs.existsSync(snomedDbPath);
const hasProgressHandler = BetterSqlite3 && typeof new BetterSqlite3(':memory:').progressHandler === 'function';

const describeIf = (cond, name, fn) => cond ? describe(name, fn) : describe.skip(name, fn);

describeIf(BetterSqlite3 && hasSnomedDb && hasProgressHandler,
  'Progress handler effort limiting (SNOMED v0)', () => {

  let db;

  beforeAll(() => {
    db = new BetterSqlite3(snomedDbPath, { readonly: true });
  });

  afterAll(() => {
    if (db) db.close();
  });

  afterEach(() => {
    db.progressHandler(); // clear handler between tests
  });

  test('normal queries complete well under 500ms', () => {
    const t0 = performance.now();

    // Closure query for Clinical Finding (~124K descendants)
    const r = db.prepare(
      `SELECT count(*) as n FROM closure c
       JOIN concept co ON c.descendant_id = co.concept_id
       WHERE c.ancestor_id = (SELECT concept_id FROM concept WHERE code = '404684003')`
    ).get();

    const elapsed = performance.now() - t0;
    expect(r.n).toBeGreaterThan(100000);
    expect(elapsed).toBeLessThan(500);
  });

  test('time-based handler interrupts expensive query', () => {
    const LIMIT_MS = 100;
    let startTime = performance.now();
    db.progressHandler(10000, () => performance.now() - startTime > LIMIT_MS);

    const t0 = performance.now();
    expect(() => {
      db.prepare(
        'SELECT count(*) FROM closure c1 JOIN closure c2 ON c1.descendant_id = c2.ancestor_id'
      ).get();
    }).toThrow(/interrupt/i);

    const elapsed = performance.now() - t0;
    // Should interrupt close to the limit (within 50ms tolerance for callback granularity)
    expect(elapsed).toBeGreaterThanOrEqual(LIMIT_MS - 10);
    expect(elapsed).toBeLessThan(LIMIT_MS + 50);
  });

  test('time resets between queries', () => {
    const LIMIT_MS = 200;
    let startTime = performance.now();
    db.progressHandler(10000, () => performance.now() - startTime > LIMIT_MS);

    // First query — well within budget
    db.prepare('SELECT count(*) FROM concept WHERE active = 1').get();
    const firstElapsed = performance.now() - startTime;

    // Reset timer — second query gets fresh budget
    startTime = performance.now();
    db.prepare('SELECT count(*) FROM concept WHERE active = 1').get();
    const secondElapsed = performance.now() - startTime;

    // Both should complete quickly
    expect(firstElapsed).toBeLessThan(50);
    expect(secondElapsed).toBeLessThan(50);
  });

  test('handler removal allows unlimited queries', () => {
    let called = false;
    db.progressHandler(1, () => { called = true; return true; }); // would interrupt immediately
    db.progressHandler(); // remove

    const r = db.prepare('SELECT count(*) as n FROM concept').get();
    expect(r.n).toBeGreaterThan(0);
    expect(called).toBe(false);
  });

  test('SQLITE_INTERRUPT error has correct code', () => {
    db.progressHandler(1, () => true); // interrupt on first callback

    try {
      db.prepare('SELECT count(*) FROM concept').get();
      throw new Error('should not reach');
    } catch (e) {
      expect(e.code).toBe('SQLITE_INTERRUPT');
    }
  });
});

describeIf(BetterSqlite3 && !hasProgressHandler,
  'Progress handler unavailable (stock better-sqlite3)', () => {

  test('provider degrades gracefully without progressHandler', () => {
    const db = new BetterSqlite3(':memory:');
    expect(typeof db.progressHandler).not.toBe('function');
    // Basic queries still work
    db.exec('CREATE TABLE t(x)');
    db.exec('INSERT INTO t VALUES (1)');
    const r = db.prepare('SELECT * FROM t').get();
    expect(r.x).toBe(1);
    db.close();
  });
});
