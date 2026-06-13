/**
 * ResourceCache unit tests
 *
 * ResourceCache backs the cache-id protocol: resources sent under a cache-id on one
 * request must be retrievable on later requests with the same cache-id, and kept
 * isolated between different cache-ids.
 */

const { ResourceCache } = require('../../tx/operation-context');

const CS = (url, version) => ({ resourceType: 'CodeSystem', url, version });
const VS = (url, version) => ({ resourceType: 'ValueSet', url, version });

// A resource that reports a concept count, like the real wrapper classes do.
const sized = (resource, n) => ({ ...resource, conceptCount: () => n });

describe('ResourceCache', () => {
  let cache;

  beforeEach(() => {
    cache = new ResourceCache(null);
  });

  describe('get / has on empty cache', () => {
    test('get returns empty array for unknown cache-id', () => {
      expect(cache.get('nope')).toEqual([]);
    });
    test('has is false for unknown cache-id', () => {
      expect(cache.has('nope')).toBe(false);
    });
  });

  describe('add', () => {
    test('stores resources under a cache-id and reports has()', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      expect(cache.has('c1')).toBe(true);
      expect(cache.get('c1')).toHaveLength(1);
    });

    test('merges across multiple add() calls under the same cache-id', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      cache.add('c1', [VS('http://vs', '1.0.0')]);
      const got = cache.get('c1');
      expect(got).toHaveLength(2);
      expect(got.map(r => r.resourceType).sort()).toEqual(['CodeSystem', 'ValueSet']);
    });

    test('replaces an existing resource with the same url+version+type', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      const updated = { ...CS('http://cs', '1.0.0'), title: 'updated' };
      cache.add('c1', [updated]);
      const got = cache.get('c1');
      expect(got).toHaveLength(1);
      expect(got[0].title).toBe('updated');
    });

    test('keeps resources with the same url but different versions as distinct', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      cache.add('c1', [CS('http://cs', '2.0.0')]);
      expect(cache.get('c1')).toHaveLength(2);
    });

    test('treats a CodeSystem and ValueSet at the same url as distinct', () => {
      cache.add('c1', [CS('http://same', '1.0.0')]);
      cache.add('c1', [VS('http://same', '1.0.0')]);
      expect(cache.get('c1')).toHaveLength(2);
    });

    test('ignores empty / null resource lists', () => {
      cache.add('c1', []);
      cache.add('c1', null);
      expect(cache.has('c1')).toBe(false);
    });
  });

  describe('isolation between cache-ids', () => {
    test('resources under one cache-id are not visible under another', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      expect(cache.get('c2')).toEqual([]);
      expect(cache.has('c2')).toBe(false);
    });

    test('two cache-ids hold independent contents', () => {
      cache.add('c1', [CS('http://a', '1')]);
      cache.add('c2', [CS('http://b', '1')]);
      expect(cache.get('c1').map(r => r.url)).toEqual(['http://a']);
      expect(cache.get('c2').map(r => r.url)).toEqual(['http://b']);
    });
  });

  describe('get returns a copy', () => {
    test('mutating the returned array does not affect the cache', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      const got = cache.get('c1');
      got.push(VS('http://injected', '1'));
      expect(cache.get('c1')).toHaveLength(1);
    });
  });

  describe('set (replace all)', () => {
    test('replaces the entire contents for a cache-id', () => {
      cache.add('c1', [CS('http://cs', '1.0.0'), VS('http://vs', '1.0.0')]);
      cache.set('c1', [CS('http://only', '1.0.0')]);
      const got = cache.get('c1');
      expect(got).toHaveLength(1);
      expect(got[0].url).toBe('http://only');
    });
  });

  describe('clear / clearAll / size', () => {
    test('clear removes a single cache-id', () => {
      cache.add('c1', [CS('http://a', '1')]);
      cache.add('c2', [CS('http://b', '1')]);
      cache.clear('c1');
      expect(cache.has('c1')).toBe(false);
      expect(cache.has('c2')).toBe(true);
      expect(cache.size()).toBe(1);
    });

    test('clearAll empties the cache', () => {
      cache.add('c1', [CS('http://a', '1')]);
      cache.add('c2', [CS('http://b', '1')]);
      cache.clearAll();
      expect(cache.size()).toBe(0);
    });
  });

  describe('prune', () => {
    test('removes entries older than maxAge but keeps fresh ones', () => {
      cache.add('old', [CS('http://old', '1')]);
      // Force the entry to look stale.
      cache.cache.get('old').lastUsed = Date.now() - 10000;
      cache.add('fresh', [CS('http://fresh', '1')]);

      cache.prune(5000); // maxAge 5s

      expect(cache.has('old')).toBe(false);
      expect(cache.has('fresh')).toBe(true);
    });

    test('get() refreshes lastUsed so an active entry is not pruned', () => {
      cache.add('c1', [CS('http://a', '1')]);
      cache.cache.get('c1').lastUsed = Date.now() - 10000;
      cache.get('c1'); // touch -> refreshes lastUsed
      cache.prune(5000);
      expect(cache.has('c1')).toBe(true);
    });
  });

  describe('running concept count', () => {
    test('starts at zero', () => {
      expect(cache.conceptCount()).toBe(0);
    });

    test('add accumulates the total and per-cache subtotal', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10), sized(VS('http://b', '1'), 3)]);
      expect(cache.conceptCount()).toBe(13);
      expect(cache.conceptCountFor('c1')).toBe(13);
    });

    test('resources with no conceptCount() count as zero', () => {
      cache.add('c1', [CS('http://a', '1')]); // plain object, no conceptCount
      expect(cache.conceptCount()).toBe(0);
    });

    test('replacing a resource adjusts by the difference', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      expect(cache.conceptCount()).toBe(10);
      cache.add('c1', [sized(CS('http://a', '1'), 4)]); // same key, fewer concepts
      expect(cache.conceptCount()).toBe(4);
      expect(cache.conceptCountFor('c1')).toBe(4);
    });

    test('totals are kept separate per cache-id', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      cache.add('c2', [sized(CS('http://b', '1'), 5)]);
      expect(cache.conceptCount()).toBe(15);
      expect(cache.conceptCountFor('c1')).toBe(10);
      expect(cache.conceptCountFor('c2')).toBe(5);
    });

    test('set replaces the entry contribution', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10), sized(VS('http://b', '1'), 5)]);
      expect(cache.conceptCount()).toBe(15);
      cache.set('c1', [sized(CS('http://c', '1'), 2)]);
      expect(cache.conceptCount()).toBe(2);
      expect(cache.conceptCountFor('c1')).toBe(2);
    });

    test('clear subtracts the cleared entry', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      cache.add('c2', [sized(CS('http://b', '1'), 5)]);
      cache.clear('c1');
      expect(cache.conceptCount()).toBe(5);
      expect(cache.conceptCountFor('c1')).toBe(0);
    });

    test('clearAll resets the total to zero', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      cache.add('c2', [sized(CS('http://b', '1'), 5)]);
      cache.clearAll();
      expect(cache.conceptCount()).toBe(0);
    });

    test('prune subtracts evicted entries', () => {
      cache.add('old', [sized(CS('http://old', '1'), 7)]);
      cache.cache.get('old').lastUsed = Date.now() - 10000;
      cache.add('fresh', [sized(CS('http://fresh', '1'), 4)]);
      cache.prune(5000);
      expect(cache.conceptCount()).toBe(4);
    });
  });

  describe('high-water marks (max)', () => {
    test('track the most caches and concepts ever held', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      cache.add('c2', [sized(CS('http://b', '1'), 5)]);
      expect(cache.maxSize()).toBe(2);
      expect(cache.maxConceptCount()).toBe(15);
    });

    test('max is not reduced when entries are cleared', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      cache.add('c2', [sized(CS('http://b', '1'), 5)]);
      cache.clear('c1');
      cache.clear('c2');
      expect(cache.size()).toBe(0);
      expect(cache.conceptCount()).toBe(0);
      // high-water marks persist
      expect(cache.maxSize()).toBe(2);
      expect(cache.maxConceptCount()).toBe(15);
    });

    test('max grows but never shrinks across set/prune', () => {
      cache.set('c1', [sized(CS('http://a', '1'), 20)]);
      expect(cache.maxConceptCount()).toBe(20);
      cache.set('c1', [sized(CS('http://a', '1'), 3)]); // shrink live count
      expect(cache.conceptCount()).toBe(3);
      expect(cache.maxConceptCount()).toBe(20);
    });
  });
});
