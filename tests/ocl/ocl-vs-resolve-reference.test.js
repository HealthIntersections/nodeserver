// $resolveReference integration in the ValueSet provider: resolve a ValueSet
// canonical to its collection without searching every org's collection listing.

const { OCLValueSetProvider } = require('../../tx/ocl/vs-ocl');
const { OclReferenceResolver } = require('../../tx/ocl/resolve/reference-resolver');

function silentLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

// One $resolveReference entry resolving a canonical to a collection.
function collectionResolve(repoUrl, canonical) {
  return {
    reference_type: 'canonical',
    resolved: true,
    resolution_url: repoUrl,
    url_registry_entry: null,
    result: {
      url: repoUrl,
      canonical_url: canonical,
      owner_type: 'Organization',
      type: 'Collection'
    }
  };
}

function makeProvider({ post, get } = {}) {
  const provider = new OCLValueSetProvider({ org: 'MS', token: 'Token x' });
  const httpClient = {
    get: get || jest.fn(async () => ({ data: [] })),
    post: post || jest.fn(async () => ({ data: [] }))
  };
  provider.httpClient = httpClient;
  provider.referenceResolver = new OclReferenceResolver({
    httpClient, token: 'Token x', logger: silentLogger()
  });
  return { provider, httpClient };
}

describe('vs-ocl $resolveReference: collection resolution', () => {
  it('resolves an unenumerated collection via $resolveReference and skips the per-org search', async () => {
    const collection = {
      id: 'BRCID10', url: '/orgs/MS/collections/BRCID10/',
      canonical_url: 'https://x/ValueSet/BRCID10', version: 'HEAD', name: 'BRCID10',
      compose: { include: [] }
    };
    const post = jest.fn(async () => ({
      data: [collectionResolve('/orgs/MS/collections/BRCID10/', 'https://x/ValueSet/BRCID10')]
    }));
    const get = jest.fn(async (url) => {
      if (url === '/orgs/MS/collections/BRCID10/') return { data: collection };
      return { data: [] };
    });
    const { provider, httpClient } = makeProvider({ post, get });

    const vs = await provider.fetchValueSet('https://x/ValueSet/BRCID10', null);

    expect(post).toHaveBeenCalledTimes(1);
    expect(vs).toBeTruthy();
    expect(vs.url).toBe('https://x/ValueSet/BRCID10');
    // The authoritative resolve means no /collections/ text search was issued.
    const searched = httpClient.get.mock.calls.some(c => /\/collections\/$/.test(c[0]));
    expect(searched).toBe(false);
  });

  it('falls back to the per-org search when the resolver is disabled (no token)', async () => {
    const provider = new OCLValueSetProvider({ org: 'MS' }); // no token
    const get = jest.fn(async (url) => {
      if (/\/collections\/$/.test(url)) {
        return {
          data: [{
            id: 'BRCID10', url: '/orgs/MS/collections/BRCID10/',
            canonical_url: 'https://x/ValueSet/BRCID10', version: 'HEAD', name: 'BRCID10',
            compose: { include: [] }
          }]
        };
      }
      if (url === '/orgs/') return { data: [{ id: 'MS' }] };
      return { data: [] };
    });
    const post = jest.fn(async () => ({ data: [] }));
    provider.httpClient = { get, post };

    const vs = await provider.fetchValueSet('https://x/ValueSet/BRCID10', null);

    expect(post).not.toHaveBeenCalled();
    expect(vs).toBeTruthy();
    // The text search path did run.
    expect(get.mock.calls.some(c => /\/collections\/$/.test(c[0]))).toBe(true);
  });

  it('ignores a resolved repo that is not a collection', async () => {
    // OCL resolves the canonical to a *source*, not a collection: not a ValueSet.
    const post = jest.fn(async () => ({
      data: [collectionResolve('/orgs/MS/sources/NotACollection/', 'https://x/ValueSet/BRCID10')]
    }));
    const get = jest.fn(async (url) => {
      if (/\/collections\/$/.test(url)) return { data: [] }; // search finds nothing either
      if (url === '/orgs/') return { data: [{ id: 'MS' }] };
      return { data: [] };
    });
    const { provider } = makeProvider({ post, get });

    const vs = await provider.fetchValueSet('https://x/ValueSet/BRCID10', null);

    // Resolver answered a source, so we fell through to the search, which found nothing.
    expect(vs).toBeNull();
  });
});
