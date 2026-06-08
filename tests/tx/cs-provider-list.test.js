const { ListCodeSystemProvider } = require('../../tx/cs/cs-provider-list');

/**
 * ListCodeSystemProvider.codeSystems is an ARRAY (despite the field's
 * "Map<String, CodeSystem>" doc comment). Loaders must append with .push().
 * library.js#loadUrl previously called .set() on it (copied from loadNpm but
 * rewritten Map-style), which threw because arrays have no .set — so any
 * `url:`/`url/cs:` package source failed to load. These tests lock the contract.
 */

describe('ListCodeSystemProvider.codeSystems contract', () => {
  test('is an array, initially empty', () => {
    const cp = new ListCodeSystemProvider();
    expect(Array.isArray(cp.codeSystems)).toBe(true);
    expect(cp.codeSystems).toHaveLength(0);
  });

  test('has no .set method (loaders must use .push)', () => {
    const cp = new ListCodeSystemProvider();
    expect(cp.codeSystems.set).toBeUndefined();
    expect(typeof cp.codeSystems.push).toBe('function');
  });

  test('pushed code systems are returned by listCodeSystems', async () => {
    const cp = new ListCodeSystemProvider();
    cp.codeSystems.push({ url: 'http://a', vurl: 'http://a|1', id: 'a' });
    cp.codeSystems.push({ url: 'http://b', vurl: 'http://b|1', id: 'b' });
    const list = await cp.listCodeSystems('R5', null);
    expect(list).toHaveLength(2);
    expect(list.map(c => c.url)).toEqual(['http://a', 'http://b']);
  });

  test('assignIds iterates the array and assigns unique ids', () => {
    const cp = new ListCodeSystemProvider();
    cp.codeSystems.push({ url: 'http://a' });            // no id
    cp.codeSystems.push({ url: 'http://b', id: 'a' });   // collides after first gets id
    const ids = new Set();
    cp.assignIds(ids);
    const assigned = cp.codeSystems.map(c => c.id);
    expect(new Set(assigned).size).toBe(2);              // all unique
    expect(ids.size).toBe(2);
  });
});
