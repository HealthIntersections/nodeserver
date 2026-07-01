/**
 * $cache-control routing smoke tests
 *
 * At this stage the operation is scaffolding only: start/end parse the request but
 * do nothing yet. These tests just confirm the route is wired up and dispatches on
 * the `mode` query parameter. Behavioural tests come with the implementation.
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const BASE = '/tx/r5/$cache-control';

describe('$cache-control routing (scaffolding)', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  // An empty Parameters body stands in for "no front-loaded resources". A real
  // client always sets a Content-Type on a POST; the endpoint's media-type gate
  // rejects a truly bodyless POST with 415 (see note - bodyless POST is a separate
  // decision).
  const emptyBody = { resourceType: 'Parameters', parameter: [] };

  test('POST mode=start resolves and returns a Parameters', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'start' })
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(emptyBody);
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Parameters');
  });

  test('GET mode=start resolves (browsable, like the other operations)', async () => {
    const res = await request(app)
      .get(BASE)
      .query({ mode: 'start' })
      .set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Parameters');
  });

  test('POST mode=end resolves and returns a Parameters', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'end' })
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .set('x-cache-id', 'some-cache-id')
      .send(emptyBody);
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Parameters');
  });

  test('missing mode is a 400 OperationOutcome', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(emptyBody);
    expect(res.status).toBe(400);
    expect(res.body.resourceType).toBe('OperationOutcome');
  });

  test('unknown mode is a 400 OperationOutcome', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'bogus' })
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(emptyBody);
    expect(res.status).toBe(400);
    expect(res.body.resourceType).toBe('OperationOutcome');
  });

  test('mode supplied as a Parameters body parameter is accepted as a fallback', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [{ name: 'mode', valueCode: 'start' }] });
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Parameters');
  });

  // ---- behaviour ----

  function cacheIdFrom(body) {
    const p = (body.parameter || []).find(x => x.name === 'cache-id');
    return p ? p.valueId : undefined;
  }

  test('start returns a server-issued cache-id', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'start' })
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(emptyBody);
    expect(res.status).toBe(200);
    const id = cacheIdFrom(res.body);
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i); // UUID shape
  });

  test('each start mints a distinct cache-id', async () => {
    const a = await request(app).post(BASE).query({ mode: 'start' })
      .set('Content-Type', 'application/json').send(emptyBody);
    const b = await request(app).post(BASE).query({ mode: 'start' })
      .set('Content-Type', 'application/json').send(emptyBody);
    expect(cacheIdFrom(a.body)).not.toBe(cacheIdFrom(b.body));
  });

  test('start front-loads supplied resources into the cache, retrievable by url', async () => {
    const colorsCS = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/cc-test/colors',
      version: '1.0.0',
      status: 'active',
      content: 'complete',
      concept: [{ code: 'red', display: 'Red' }]
    };
    const colorsVS = {
      resourceType: 'ValueSet',
      url: 'http://example.org/cc-test/colors-vs',
      version: '1.0.0',
      status: 'active',
      compose: { include: [{ system: colorsCS.url }] }
    };

    // Front-load CS + VS via start.
    const started = await request(app)
      .post(BASE)
      .query({ mode: 'start' })
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'tx-resource', resource: colorsCS },
          { name: 'valueSet', resource: colorsVS }
        ]
      });
    const cacheId = cacheIdFrom(started.body);
    expect(cacheId).toBeDefined();

    // The front-loaded ValueSet should now resolve by url under that cache-id.
    // (validate still reads cache-id from the parameter in this step; the header
    // read path is a later change.)
    const validated = await request(app)
      .post('/tx/r5/ValueSet/$validate-code')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'cache-id', valueId: cacheId },
          { name: 'url', valueString: colorsVS.url },
          { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
        ]
      });
    expect(validated.status).toBe(200);
    const result = (validated.body.parameter || []).find(x => x.name === 'result');
    expect(result && result.valueBoolean).toBe(true);
  });

  test('end with the cache-id header releases the cache', async () => {
    const started = await request(app).post(BASE).query({ mode: 'start' })
      .set('Content-Type', 'application/json').send(emptyBody);
    const cacheId = cacheIdFrom(started.body);

    const ended = await request(app)
      .post(BASE)
      .query({ mode: 'end' })
      .set('Content-Type', 'application/json')
      .set('x-cache-id', cacheId)
      .send(emptyBody);
    expect(ended.status).toBe(200);
    expect(ended.body.resourceType).toBe('Parameters');
  });

  test('end without the cache-id header is a 400', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'end' })
      .set('Content-Type', 'application/json')
      .send(emptyBody);
    expect(res.status).toBe(400);
    expect(res.body.resourceType).toBe('OperationOutcome');
  });

  test('end of an unknown cache-id is a tolerant no-op (200)', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'end' })
      .set('Content-Type', 'application/json')
      .set('x-cache-id', 'never-issued-this-id')
      .send(emptyBody);
    expect(res.status).toBe(200);
  });

  // ---- header-driven cache use across operations (regression) ----
  //
  // The cache-id travels as the X-Cache-Id header. Only the operations whose
  // Parameters are assembled through buildParameters() used to honour it; the
  // ones that read req.body / the query string directly (expand, related,
  // batch-validate) or that handed setupAdditionalResources a raw req.body
  // (lookup) silently ignored a front-loaded cache and failed to resolve
  // by-reference resources. The middleware now lifts the header onto the
  // operation context and setupAdditionalResources falls back to it, so every
  // operation honours a front-loaded cache from the header alone (no inline
  // tx-resource, no cache-id parameter).
  describe('front-loaded cache is honoured from the header alone', () => {
    const colorsCS = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/hdr-test/colors',
      version: '1.0.0',
      status: 'active',
      content: 'complete',
      concept: [{ code: 'red', display: 'Red' }, { code: 'green', display: 'Green' }]
    };
    const colorsVS = {
      resourceType: 'ValueSet',
      url: 'http://example.org/hdr-test/colors-vs',
      version: '1.0.0',
      status: 'active',
      compose: { include: [{ system: colorsCS.url }] }
    };

    async function startCache() {
      const started = await request(app)
        .post(BASE)
        .query({ mode: 'start' })
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'tx-resource', resource: colorsCS },
            { name: 'valueSet', resource: colorsVS }
          ]
        });
      return cacheIdFrom(started.body);
    }

    test('$expand resolves the front-loaded ValueSet by url via the header', async () => {
      const cacheId = await startCache();
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: colorsVS.url }] });
      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('ValueSet');
      const codes = ((res.body.expansion || {}).contains || []).map(c => c.code).sort();
      expect(codes).toEqual(['green', 'red']);
    });

    test('$lookup resolves the front-loaded CodeSystem via the header', async () => {
      const cacheId = await startCache();
      const res = await request(app)
        .post('/tx/r5/CodeSystem/$lookup')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'system', valueUri: colorsCS.url },
            { name: 'code', valueCode: 'green' }
          ]
        });
      expect(res.status).toBe(200);
      const display = (res.body.parameter || []).find(x => x.name === 'display');
      expect(display && display.valueString).toBe('Green');
    });

    test('$validate-code resolves the front-loaded ValueSet by url via the header', async () => {
      const cacheId = await startCache();
      const res = await request(app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'url', valueString: colorsVS.url },
            { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
          ]
        });
      expect(res.status).toBe(200);
      const result = (res.body.parameter || []).find(x => x.name === 'result');
      expect(result && result.valueBoolean).toBe(true);
    });

    test('an unknown cache-id in the header is a coded 404 on $expand', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', 'never-issued-this-id')
        .send({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: colorsVS.url }] });
      expect(res.status).toBe(404);
      expect(res.body.resourceType).toBe('OperationOutcome');
      const coding = (((res.body.issue || [])[0] || {}).details || {}).coding || [];
      expect(coding.some(c => c.code === 'cache-id-unknown')).toBe(true);
    });
  });

  // ---- sealed vs unsealed caches ----
  //
  // `sealed` (start parameter) governs whether the cache may grow after creation.
  // Sealed: only the front-loaded resources are ever in the cache; resources sent
  // on a later request are used for that request but not retained. Unsealed: the
  // cache accumulates resources it sees, so a resource sent once resolves by
  // reference thereafter.
  //
  // NOTE: the server default is currently unsealed (transitional), which differs
  // from the protocol default of sealed=true; that flips once all clients send an
  // explicit `sealed`.
  describe('sealed vs unsealed caches', () => {
    const csA = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/seal-test/csA',
      version: '1.0.0', status: 'active', content: 'complete',
      concept: [{ code: 'a1', display: 'A One' }]
    };
    const vsA = {
      resourceType: 'ValueSet',
      url: 'http://example.org/seal-test/vsA',
      version: '1.0.0', status: 'active',
      compose: { include: [{ system: csA.url }] }
    };
    // A second VS not front-loaded; used to probe whether the cache grew.
    const csB = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/seal-test/csB',
      version: '1.0.0', status: 'active', content: 'complete',
      concept: [{ code: 'b1', display: 'B One' }]
    };
    const vsB = {
      resourceType: 'ValueSet',
      url: 'http://example.org/seal-test/vsB',
      version: '1.0.0', status: 'active',
      compose: { include: [{ system: csB.url }] }
    };

    async function start(sealed) {
      const params = [
        { name: 'tx-resource', resource: csA },
        { name: 'valueSet', resource: vsA }
      ];
      if (sealed !== undefined) params.push({ name: 'sealed', valueBoolean: sealed });
      const started = await request(app)
        .post(BASE).query({ mode: 'start' })
        .set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: params });
      return started.body;
    }

    test('start echoes the sealed flag it applied', async () => {
      const body = await start(true);
      const p = (body.parameter || []).find(x => x.name === 'sealed');
      expect(p && p.valueBoolean).toBe(true);
    });

    test('default (no sealed param) is unsealed on this server (transitional)', async () => {
      const body = await start(undefined);
      const p = (body.parameter || []).find(x => x.name === 'sealed');
      expect(p && p.valueBoolean).toBe(false);
    });

    test('a sealed cache does not retain a resource sent on a later request', async () => {
      const cacheId = cacheIdFrom(await start(true));

      // Send vsB/csB inline on a validate call (works for this call)...
      const first = await request(app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [
          { name: 'valueSet', resource: vsB },
          { name: 'tx-resource', resource: csB },
          { name: 'coding', valueCoding: { system: csB.url, code: 'b1' } }
        ] });
      expect(first.status).toBe(200);

      // ...but the sealed cache must not have kept vsB: a by-reference call now 404s.
      const second = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: vsB.url }] });
      expect(second.status).not.toBe(200);
    });

    test('an unsealed cache retains a resource sent on a later request', async () => {
      const cacheId = cacheIdFrom(await start(false));

      const first = await request(app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [
          { name: 'valueSet', resource: vsB },
          { name: 'tx-resource', resource: csB },
          { name: 'coding', valueCoding: { system: csB.url, code: 'b1' } }
        ] });
      expect(first.status).toBe(200);

      // The unsealed cache kept vsB: it now resolves by reference.
      const second = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: vsB.url }] });
      expect(second.status).toBe(200);
      const codes = ((second.body.expansion || {}).contains || []).map(c => c.code);
      expect(codes).toContain('b1');
    });
  });
});
