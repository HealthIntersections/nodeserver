const { ExpansionCache } = require('../../tx/operation-context');

/**
 * ExpansionCache caches an expansion only when it took at least
 * MIN_CACHE_TIME_MS — unless forceCaching is enabled, in which case every
 * expansion is cached regardless of duration. The test runner uses
 * forceCaching to run the whole suite a third time with the cache fully active.
 */

describe('ExpansionCache duration threshold', () => {
  test('does not cache fast expansions by default', () => {
    const c = new ExpansionCache(null);
    expect(c.set('k', { v: 1 }, 10)).toBe(false);
    expect(c.get('k')).toBeFalsy();
  });

  test('caches slow expansions by default', () => {
    const c = new ExpansionCache(null);
    expect(c.set('k', { v: 1 }, ExpansionCache.MIN_CACHE_TIME_MS)).toBe(true);
    expect(c.get('k')).toEqual({ v: 1 });
  });
});

describe('ExpansionCache forceCaching', () => {
  test('defaults to off', () => {
    expect(new ExpansionCache(null).forceCaching).toBe(false);
  });

  test('caches fast (even zero-duration) expansions when on', () => {
    const c = new ExpansionCache(null);
    c.forceCaching = true;
    expect(c.set('k', { v: 1 }, 0)).toBe(true);
    expect(c.get('k')).toEqual({ v: 1 });
  });

  test('still caches slow expansions when on', () => {
    const c = new ExpansionCache(null);
    c.forceCaching = true;
    expect(c.set('k', { v: 2 }, 9999)).toBe(true);
    expect(c.get('k')).toEqual({ v: 2 });
  });

  test('clearAll empties the cache (used to reset between passes)', () => {
    const c = new ExpansionCache(null);
    c.forceCaching = true;
    c.set('k', { v: 1 }, 0);
    expect(c.size()).toBeGreaterThan(0);
    c.clearAll();
    expect(c.size()).toBe(0);
    expect(c.get('k')).toBeFalsy();
  });
});

describe('ExpansionCache.forceSet removed', () => {
  test('the dead forceSet method no longer exists', () => {
    expect(new ExpansionCache(null).forceSet).toBeUndefined();
  });
});

describe('ExpansionCache.getStats (not shadowed by the stats field)', () => {
  test('the stats field holds the ServerStats arg, not a method', () => {
    const serverStats = { task() {}, taskDone() {} };
    const c = new ExpansionCache(serverStats);
    expect(c.stats).toBe(serverStats);   // field, not a function
    expect(typeof c.getStats).toBe('function');
  });

  test('getStats reports size, maxSize and hit counts', () => {
    const c = new ExpansionCache(null, 50);
    c.forceCaching = true;
    c.set('a', { v: 1 }, 0);
    c.set('b', { v: 2 }, 0);
    c.get('a');           // 1 hit
    c.get('a');           // 2 hits
    c.get('b');           // 1 hit
    const s = c.getStats();
    expect(s.size).toBe(2);
    expect(s.maxSize).toBe(50);
    expect(s.totalHits).toBe(3);
  });
});
