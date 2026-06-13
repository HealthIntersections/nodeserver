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
});
