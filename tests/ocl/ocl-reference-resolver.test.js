const {
  OclReferenceResolver,
  normalizeNamespace,
  deriveNamespace,
  normalizeReference,
  isOclRepoPath,
  GLOBAL_NAMESPACE,
  RESOLVE_PATH
} = require('../../tx/ocl/resolve/reference-resolver');

function silentLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

// Shape of one entry in OCL's $resolveReference response array.
function oclEntry({
  resolved = true,
  url = '/orgs/CIEL/sources/CIEL/HEAD/',
  registryEntry = null,
  referenceType = 'relative',
  resolutionUrl = null,
  request = null
} = {}) {
  return {
    reference_type: referenceType,
    timestamp: '2026-07-15T13:12:18.919301',
    resolved,
    request,
    resolution_url: resolutionUrl,
    url_registry_entry: registryEntry,
    result: resolved ? { type: 'Source Version', short_code: 'CIEL', url } : null
  };
}

// Echoes one result per submitted ref, tagging the url so ordering is assertable.
function echoClient() {
  return {
    post: jest.fn(async (path, body) => ({
      data: body.map(ref => {
        const url = typeof ref === 'string' ? ref : ref.url;
        return oclEntry({ url: `/orgs/X/sources/${url}/HEAD/`, request: ref });
      })
    }))
  };
}

function makeResolver({ httpClient, logger, token = 'Token abc', ...rest } = {}) {
  return new OclReferenceResolver({
    httpClient: httpClient || echoClient(),
    logger: logger || silentLogger(),
    token,
    ...rest
  });
}

function httpError(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
}

describe('normalizeNamespace', () => {
  it.each([
    ['MyOrg', '/orgs/MyOrg/'],
    ['/orgs/MyOrg', '/orgs/MyOrg/'],
    ['orgs/MyOrg/', '/orgs/MyOrg/'],
    ['/orgs/MyOrg/', '/orgs/MyOrg/'],
    ['  /orgs/MyOrg/  ', '/orgs/MyOrg/'],
    ['/users/joe/', '/users/joe/'],
    ['users/joe', '/users/joe/']
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeNamespace(input)).toBe(expected);
  });

  it.each([['/'], [''], ['   '], [null], [undefined]])(
    'treats %s as the global namespace',
    input => {
      expect(normalizeNamespace(input)).toBe(GLOBAL_NAMESPACE);
    }
  );

  // A malformed namespace must throw rather than silently degrade to global —
  // that would look fine while resolving against the wrong context.
  it.each([['/orgs/'], ['/users/'], ['/foo/bar/'], ['//'], ['a/b/c'], ['/orgs/a/b/']])(
    'rejects %s',
    input => {
      expect(() => normalizeNamespace(input)).toThrow(/Invalid OCL namespace/);
    }
  );
});

describe('isOclRepoPath', () => {
  it.each([
    ['/orgs/CIEL/sources/CIEL/'],
    ['/orgs/CIEL/sources/CIEL/HEAD/'],
    ['/orgs/CIEL/collections/C/'],
    // The whole point: user-owned repos are real and must not be filtered out.
    ['/users/joe/sources/S/'],
    ['  /users/joe/sources/S/  ']
  ])('accepts %s', input => {
    expect(isOclRepoPath(input)).toBe(true);
  });

  it.each([
    ['http://loinc.org'],
    ['/sources/S/'],
    ['/orgs/'],
    ['/orgs/CIEL'],
    ['/groups/x/sources/S/'],
    [''],
    [null],
    [undefined]
  ])('rejects %p', input => {
    expect(isOclRepoPath(input)).toBe(false);
  });
});

describe('deriveNamespace', () => {
  it('prefers an explicit namespace over org', () => {
    expect(deriveNamespace({ namespace: '/users/joe/', org: 'CIEL' })).toBe('/users/joe/');
  });

  it('derives /orgs/{org}/ from org', () => {
    expect(deriveNamespace({ org: 'CIEL' })).toBe('/orgs/CIEL/');
  });

  it.each([[{}], [{ org: '' }], [{ namespace: '  ', org: null }], [undefined]])(
    'falls back to the global namespace for %s',
    input => {
      expect(deriveNamespace(input)).toBe(GLOBAL_NAMESPACE);
    }
  );
});

describe('normalizeReference', () => {
  it('accepts a relative path string and sends it as a string', () => {
    const ref = normalizeReference('/orgs/CIEL/sources/CIEL/');
    expect(ref.url).toBe('/orgs/CIEL/sources/CIEL/');
    expect(ref.body).toBe('/orgs/CIEL/sources/CIEL/');
    expect(ref.namespace).toBeNull();
  });

  it('keeps the expanded object fields', () => {
    const ref = normalizeReference({
      url: 'http://hl7.org/fhir/CodeSystem/x',
      version: '0.8',
      code: '1948',
      resourceType: 'Mapping'
    });
    expect(ref.body).toEqual({
      url: 'http://hl7.org/fhir/CodeSystem/x',
      version: '0.8',
      code: '1948',
      resourceType: 'Mapping'
    });
  });

  it('extracts namespace for grouping but never puts it in the body', () => {
    const ref = normalizeReference({ url: '/orgs/A/sources/S/', namespace: '/orgs/A/' });
    expect(ref.namespace).toBe('/orgs/A/');
    expect(ref.body).not.toHaveProperty('namespace');
  });

  it('drops null and undefined fields', () => {
    const ref = normalizeReference({ url: 'x', version: null, code: undefined });
    expect(ref.body).toEqual({ url: 'x' });
  });

  it.each([[''], ['   ']])('rejects the empty string %p', input => {
    expect(() => normalizeReference(input)).toThrow(/cannot be empty/);
  });

  it.each([[{}], [{ url: '' }], [{ url: null }]])('rejects object %p without a url', input => {
    expect(() => normalizeReference(input)).toThrow(/requires a url/);
  });

  it.each([[null], [undefined], [123], [[]]])('rejects %p', input => {
    expect(() => normalizeReference(input)).toThrow(/Invalid OCL reference/);
  });
});

describe('OclReferenceResolver construction', () => {
  it('requires an http client', () => {
    expect(() => new OclReferenceResolver({ token: 'Token abc' })).toThrow(/requires an http client/);
  });

  it('derives its namespace from org', () => {
    expect(makeResolver({ org: 'CIEL' }).namespace).toBe('/orgs/CIEL/');
  });

  it('defaults to the global namespace when no org is configured', () => {
    expect(makeResolver().namespace).toBe(GLOBAL_NAMESPACE);
  });

  it('throws on a malformed configured namespace', () => {
    expect(() => makeResolver({ namespace: '/foo/bar/' })).toThrow(/Invalid OCL namespace/);
  });

  // $resolveReference is auth-gated on every instance probed, while the /orgs/
  // enumeration it replaces is public — so a tokenless call is a guaranteed 401.
  it('stays disabled without a token and issues no request', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient, token: null });

    expect(resolver.isEnabled()).toBe(false);
    expect(resolver.disabledReason).toBe('no token configured');
    await expect(resolver.resolveReferences(['/orgs/A/sources/S/'])).resolves.toBeNull();
    expect(httpClient.post).not.toHaveBeenCalled();
  });

  it('is enabled with a token', () => {
    expect(makeResolver().isEnabled()).toBe(true);
  });
});

describe('OclReferenceResolver resolution', () => {
  it('resolves a single relative reference', async () => {
    const httpClient = {
      post: jest.fn(async () => ({ data: [oclEntry({ url: '/orgs/CIEL/sources/CIEL/HEAD/' })] }))
    };
    const resolver = makeResolver({ httpClient });

    const result = await resolver.resolve('/orgs/CIEL/sources/CIEL/');

    expect(result.resolved).toBe(true);
    expect(result.repoUrl).toBe('/orgs/CIEL/sources/CIEL/HEAD/');
    expect(httpClient.post).toHaveBeenCalledWith(
      RESOLVE_PATH,
      ['/orgs/CIEL/sources/CIEL/'],
      { params: { namespace: GLOBAL_NAMESPACE } }
    );
  });

  it('resolves an expanded object reference', async () => {
    const httpClient = {
      post: jest.fn(async () => ({
        data: [oclEntry({ url: '/orgs/CIEL/sources/CIEL/v2021-03-12/', referenceType: 'canonical' })]
      }))
    };
    const resolver = makeResolver({ httpClient, org: 'CIEL' });

    const result = await resolver.resolve({
      url: 'http://hl7.org/fhir/CodeSystem/my-codesystem',
      version: '0.8',
      code: '1948'
    });

    expect(result.resolved).toBe(true);
    expect(result.referenceType).toBe('canonical');
    expect(httpClient.post).toHaveBeenCalledWith(
      RESOLVE_PATH,
      [{ url: 'http://hl7.org/fhir/CodeSystem/my-codesystem', version: '0.8', code: '1948' }],
      { params: { namespace: '/orgs/CIEL/' } }
    );
  });

  it('passes a piped canonical through untouched', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    await resolver.resolve('http://terminology.hl7.org/CodeSystem/x|0.1.0');

    expect(httpClient.post).toHaveBeenCalledWith(
      RESOLVE_PATH,
      ['http://terminology.hl7.org/CodeSystem/x|0.1.0'],
      expect.anything()
    );
  });

  it('resolves a user-owned repo (regression: /orgs/-only filters dropped these)', async () => {
    const httpClient = {
      post: jest.fn(async () => ({ data: [oclEntry({ url: '/users/joe/sources/S/HEAD/' })] }))
    };
    const resolver = makeResolver({ httpClient, namespace: '/users/joe/' });

    const result = await resolver.resolve('/users/joe/sources/S/');

    expect(result.repoUrl).toBe('/users/joe/sources/S/HEAD/');
  });

  it('surfaces url_registry_entry (Phase 2 sandbox needs it)', async () => {
    const httpClient = {
      post: jest.fn(async () => ({
        data: [
          oclEntry({
            registryEntry: '/orgs/MyOrg/url-registry/1/',
            resolutionUrl: 'http://terminology.hl7.org/CodeSystem/x'
          })
        ]
      }))
    };
    const resolver = makeResolver({ httpClient, org: 'MyOrg' });

    const result = await resolver.resolve('http://terminology.hl7.org/CodeSystem/x|0.1.0');

    expect(result.registryEntry).toBe('/orgs/MyOrg/url-registry/1/');
    expect(result.resolutionUrl).toBe('http://terminology.hl7.org/CodeSystem/x');
  });

  it('returns an empty array and issues no request for no references', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    await expect(resolver.resolveReferences([])).resolves.toEqual([]);
    expect(httpClient.post).not.toHaveBeenCalled();
  });

  it('reports resolved:false without throwing', async () => {
    const httpClient = {
      post: jest.fn(async () => ({ data: [oclEntry({ resolved: false })] }))
    };
    const resolver = makeResolver({ httpClient });

    const result = await resolver.resolve('/orgs/nope/sources/nope/');

    expect(result.resolved).toBe(false);
    expect(result.repoUrl).toBeNull();
  });

  it('treats a resolved flag with no result url as unresolved', async () => {
    const httpClient = {
      post: jest.fn(async () => ({ data: [{ resolved: true, result: null }] }))
    };
    const resolver = makeResolver({ httpClient });

    const result = await resolver.resolve('/orgs/A/sources/S/');

    expect(result.resolved).toBe(false);
  });

  it.each([[null], ['oops'], [42]])('treats a malformed result entry %p as unresolved', async entry => {
    const httpClient = { post: jest.fn(async () => ({ data: [entry] })) };
    const resolver = makeResolver({ httpClient });

    const result = await resolver.resolve('/orgs/A/sources/S/');

    expect(result.resolved).toBe(false);
    expect(result.repoUrl).toBeNull();
  });

  it('tolerates a non-array response body', async () => {
    const httpClient = {
      post: jest.fn(async () => ({ data: oclEntry({ url: '/orgs/A/sources/S/HEAD/' }) }))
    };
    const resolver = makeResolver({ httpClient });

    const result = await resolver.resolve('/orgs/A/sources/S/');

    expect(result.repoUrl).toBe('/orgs/A/sources/S/HEAD/');
  });

  it('tolerates a null response body', async () => {
    const httpClient = { post: jest.fn(async () => ({ data: null })) };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    const result = await resolver.resolve('/orgs/A/sources/S/');

    expect(result.resolved).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/misaligned/));
  });
});

describe('OclReferenceResolver batching', () => {
  // OCL discourages the per-reference namespace field, so we group by namespace and
  // use the request-level query parameter instead.
  it('groups by namespace: one POST per namespace, order preserved, no per-ref namespace', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient, org: 'Default' });

    const results = await resolver.resolveReferences([
      'a',
      { url: 'b', namespace: '/orgs/Other/' },
      'c'
    ]);

    expect(httpClient.post).toHaveBeenCalledTimes(2);

    const [firstCall, secondCall] = httpClient.post.mock.calls;
    expect(firstCall[1]).toEqual(['a', 'c']);
    expect(firstCall[2]).toEqual({ params: { namespace: '/orgs/Default/' } });
    expect(secondCall[1]).toEqual([{ url: 'b' }]);
    expect(secondCall[2]).toEqual({ params: { namespace: '/orgs/Other/' } });

    // The namespace field must never appear in the body.
    expect(JSON.stringify(secondCall[1])).not.toContain('namespace');

    // Caller order survives the regrouping.
    expect(results.map(r => r.repoUrl)).toEqual([
      '/orgs/X/sources/a/HEAD/',
      '/orgs/X/sources/b/HEAD/',
      '/orgs/X/sources/c/HEAD/'
    ]);
  });

  it('honours a per-call namespace override', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient, org: 'Default' });

    await resolver.resolveReferences(['a'], { namespace: '/users/joe/' });

    expect(httpClient.post.mock.calls[0][2]).toEqual({ params: { namespace: '/users/joe/' } });
  });

  it('discards a group whose result count does not match the request count', async () => {
    // Never let result[0] be attributed to the wrong canonical.
    const httpClient = {
      post: jest.fn(async () => ({ data: [oclEntry({ url: '/orgs/A/sources/only/HEAD/' })] }))
    };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    const results = await resolver.resolveReferences(['a', 'b']);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.resolved === false)).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/returned 1 result\(s\) for 2 reference\(s\).*misaligned/)
    );
  });
});

describe('OclReferenceResolver caching', () => {
  it('serves a repeat reference from cache', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    const first = await resolver.resolve('/orgs/A/sources/S/');
    const second = await resolver.resolve('/orgs/A/sources/S/');

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  // The same canonical legitimately resolves differently per namespace; a
  // namespace-blind cache key would cross-contaminate them.
  it('does not collide across namespaces', async () => {
    const httpClient = {
      post: jest.fn(async (path, body, config) => ({
        data: body.map(() => oclEntry({ url: `${config.params.namespace}sources/S/HEAD/` }))
      }))
    };
    const resolver = makeResolver({ httpClient });

    const a = await resolver.resolve('S', { namespace: '/orgs/A/' });
    const b = await resolver.resolve('S', { namespace: '/orgs/B/' });

    expect(httpClient.post).toHaveBeenCalledTimes(2);
    expect(a.repoUrl).toBe('/orgs/A/sources/S/HEAD/');
    expect(b.repoUrl).toBe('/orgs/B/sources/S/HEAD/');
  });

  it('distinguishes references that differ only by code', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    await resolver.resolve({ url: 'S', code: '1' });
    await resolver.resolve({ url: 'S', code: '2' });

    expect(httpClient.post).toHaveBeenCalledTimes(2);
  });

  it('mixes cached and uncached references in one call', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    await resolver.resolve('a');
    httpClient.post.mockClear();

    const results = await resolver.resolveReferences(['a', 'b']);

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(httpClient.post.mock.calls[0][1]).toEqual(['b']);
    expect(results.map(r => r.repoUrl)).toEqual([
      '/orgs/X/sources/a/HEAD/',
      '/orgs/X/sources/b/HEAD/'
    ]);
  });

  it('does not cache a failed resolution', async () => {
    const httpClient = {
      post: jest
        .fn()
        .mockRejectedValueOnce(httpError(400, { detail: 'bad' }))
        .mockResolvedValueOnce({ data: [oclEntry({ url: '/orgs/A/sources/S/HEAD/' })] })
    };
    const resolver = makeResolver({ httpClient, logger: silentLogger() });

    const first = await resolver.resolve('/orgs/A/sources/S/');
    const second = await resolver.resolve('/orgs/A/sources/S/');

    expect(first.resolved).toBe(false);
    expect(second.resolved).toBe(true);
    expect(httpClient.post).toHaveBeenCalledTimes(2);
  });
});

describe('OclReferenceResolver error handling', () => {
  it('disables itself and falls back when the endpoint is missing (404)', async () => {
    const httpClient = { post: jest.fn().mockRejectedValue(httpError(404)) };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    await expect(resolver.resolveReferences(['a'])).resolves.toBeNull();
    expect(resolver.isEnabled()).toBe(false);
    expect(resolver.disabledReason).toBe('endpoint not implemented (404)');
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/not available/));

    // Stays disabled: no further requests.
    await expect(resolver.resolveReferences(['b'])).resolves.toBeNull();
    expect(httpClient.post).toHaveBeenCalledTimes(1);
  });

  it.each([[401], [403]])('disables itself and falls back on %i', async status => {
    const httpClient = { post: jest.fn().mockRejectedValue(httpError(status)) };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    await expect(resolver.resolveReferences(['a'])).resolves.toBeNull();
    expect(resolver.isEnabled()).toBe(false);
    expect(resolver.disabledReason).toBe(`not authorised (${status})`);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/credentials/));
  });

  // A 400 is our bug, not the instance's — log it loudly but stay enabled, since a
  // later well-formed batch may be fine.
  it('reports a 400 without disabling', async () => {
    const httpClient = { post: jest.fn().mockRejectedValue(httpError(400, { detail: 'malformed' })) };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    const results = await resolver.resolveReferences(['a', 'b']);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.resolved === false)).toBe(true);
    expect(resolver.isEnabled()).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });

  it('falls back on a network timeout without disabling', async () => {
    const httpClient = { post: jest.fn().mockRejectedValue(new Error('timeout of 30000ms exceeded')) };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    await expect(resolver.resolveReferences(['a'])).resolves.toBeNull();
    expect(resolver.isEnabled()).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/timeout/));
  });

  it('falls back wholesale when one group fails mid-flight', async () => {
    // Half-resolved sets are worse than none: the caller would mix resolver output
    // with its fallback path.
    const httpClient = {
      post: jest
        .fn()
        .mockResolvedValueOnce({ data: [oclEntry({ url: '/orgs/A/sources/S/HEAD/' })] })
        .mockRejectedValueOnce(httpError(401))
    };
    const resolver = makeResolver({ httpClient, logger: silentLogger(), org: 'A' });

    const results = await resolver.resolveReferences(['a', { url: 'b', namespace: '/orgs/B/' }]);

    expect(results).toBeNull();
  });
});
