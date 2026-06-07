const { convertResourceToR5, convertResourceFromR5 } = require('../../tx/xversion/xv-resource');

/**
 * Cross-version conversion tests, focused on resources that omit optional
 * properties the converters previously assumed were present:
 *   - ValueSet without `compose` (expansion-only)
 *   - Parameters without a `parameter` array (empty Parameters)
 *   - Bundle entries without a `resource` (request/response/search-only)
 * Plus "still works" cases to ensure the added guards didn't change normal
 * conversion behaviour.
 */

describe('xversion — ValueSet without compose (the reported bug)', () => {
  test('expansion-only ValueSet converts R4 -> R5 without throwing', () => {
    const vs = { resourceType: 'ValueSet', url: 'http://x', expansion: { contains: [{ system: 's', code: 'a' }] } };
    let out;
    expect(() => { out = convertResourceToR5(vs, '4.0'); }).not.toThrow();
    expect(out.resourceType).toBe('ValueSet');
    expect(out.expansion.contains).toHaveLength(1);
  });

  test('expansion-only ValueSet converts R3 -> R5 without throwing', () => {
    const vs = { resourceType: 'ValueSet', url: 'http://x', expansion: { contains: [] } };
    expect(() => convertResourceToR5(vs, '3.0')).not.toThrow();
  });

  test('ValueSet with neither compose nor expansion converts without throwing', () => {
    expect(() => convertResourceToR5({ resourceType: 'ValueSet', url: 'http://x' }, '4.0')).not.toThrow();
  });

  test('ValueSet WITH compose still converts (guard did not skip real work)', () => {
    const vs = {
      resourceType: 'ValueSet',
      compose: { include: [{ system: 's', filter: [{ property: 'p', op: 'is-a', value: 'v' }] }] }
    };
    const out = convertResourceToR5(vs, '4.0');
    expect(out.compose.include[0].filter[0].op).toBe('is-a');
  });

  test('R5-only filter operator is moved to an extension when targeting R4', () => {
    const vs = {
      resourceType: 'ValueSet',
      compose: { include: [{ system: 's', filter: [{ property: 'p', op: 'child-of', value: 'v' }] }] }
    };
    const out = convertResourceFromR5(vs, '4.0');
    const filter = out.compose.include[0].filter[0];
    expect(filter.op).toBeUndefined();
    expect(filter._op).toBeDefined();
    // _op is a FHIR primitive-element extension: { extension: [ { url, valueCode } ] }
    expect(Array.isArray(filter._op.extension)).toBe(true);
    expect(filter._op.extension[0].url).toBe('http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.filter.op');
    expect(filter._op.extension[0].valueCode).toBe('child-of');
  });
});

describe('xversion — filter op _op extension is a well-formed primitive extension', () => {
  const OP_EXT_URL = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.filter.op';

  // Assert the FHIR-correct shape: { extension: [ { url, valueCode } ] }
  function expectWellFormedOp(filter, expectedCode) {
    expect(filter.op).toBeUndefined();
    expect(filter._op).toBeDefined();
    expect(Array.isArray(filter._op.extension)).toBe(true);
    expect(filter._op.extension).toHaveLength(1);
    expect(filter._op.extension[0].url).toBe(OP_EXT_URL);
    expect(filter._op.extension[0].valueCode).toBe(expectedCode);
    // the URL must NOT be sitting directly on _op (the original bug)
    expect(typeof filter._op.extension).not.toBe('string');
  }

  test('R5 -> R4 include filter (R5-only op)', () => {
    const vs = { resourceType: 'ValueSet', compose: { include: [{ system: 's', filter: [{ property: 'p', op: 'child-of', value: 'v' }] }] } };
    const out = convertResourceFromR5(vs, '4.0');
    expectWellFormedOp(out.compose.include[0].filter[0], 'child-of');
  });

  test('R5 -> R4 exclude filter (R5-only op)', () => {
    const vs = { resourceType: 'ValueSet', compose: { exclude: [{ system: 's', filter: [{ property: 'p', op: 'child-of', value: 'v' }] }] } };
    const out = convertResourceFromR5(vs, '4.0');
    expectWellFormedOp(out.compose.exclude[0].filter[0], 'child-of');
  });

  test('R5 -> R3 include filter (op not R3-compatible)', () => {
    const vs = { resourceType: 'ValueSet', compose: { include: [{ system: 's', filter: [{ property: 'p', op: 'generalizes', value: 'v' }] }] } };
    const out = convertResourceFromR5(vs, '3.0');
    expectWellFormedOp(out.compose.include[0].filter[0], 'generalizes');
  });

  test('R5 -> R3 exclude filter (op not R3-compatible)', () => {
    const vs = { resourceType: 'ValueSet', compose: { exclude: [{ system: 's', filter: [{ property: 'p', op: 'generalizes', value: 'v' }] }] } };
    const out = convertResourceFromR5(vs, '3.0');
    expectWellFormedOp(out.compose.exclude[0].filter[0], 'generalizes');
  });
});

describe('xversion — Parameters without a parameter array', () => {
  test('empty Parameters converts R4 -> R5 without throwing', () => {
    expect(() => convertResourceToR5({ resourceType: 'Parameters' }, '4.0')).not.toThrow();
  });

  test('empty Parameters converts R5 -> R4 without throwing', () => {
    expect(() => convertResourceFromR5({ resourceType: 'Parameters' }, '4.0')).not.toThrow();
  });

  test('empty Parameters converts R5 -> R3 without throwing', () => {
    expect(() => convertResourceFromR5({ resourceType: 'Parameters' }, '3.0')).not.toThrow();
  });

  test('R5 Parameters with a match param but no parameter array does not throw', () => {
    // Exercises the R5->R5 match-fixing clone path
    expect(() => convertResourceToR5({ resourceType: 'Parameters' }, '5.0')).not.toThrow();
  });

  test('Parameters WITH parameters still converts a nested resource', () => {
    const params = {
      resourceType: 'Parameters',
      parameter: [{ name: 'tx-resource', resource: { resourceType: 'ValueSet', expansion: { contains: [] } } }]
    };
    const out = convertResourceToR5(params, '4.0');
    expect(out.parameter[0].resource.resourceType).toBe('ValueSet');
  });

  test('R5 -> R4 converts a match relationship to a legacy equivalence', () => {
    const params = {
      resourceType: 'Parameters',
      parameter: [{ name: 'match', part: [{ name: 'relationship', valueCode: 'source-is-narrower-than-target' }] }]
    };
    const out = convertResourceFromR5(params, '4.0');
    const equ = out.parameter[0].part.find(p => p.name === 'equivalence');
    expect(equ).toBeDefined();
    expect(equ.valueCode).toBe('wider');
    // relationship is removed in R4
    expect(out.parameter[0].part.find(p => p.name === 'relationship')).toBeUndefined();
  });
});

describe('xversion — Bundle entries without a resource', () => {
  test('request-only entry converts R4 -> R5 without throwing', () => {
    const bundle = { resourceType: 'Bundle', type: 'batch', entry: [{ request: { method: 'GET', url: 'ValueSet' } }] };
    expect(() => convertResourceToR5(bundle, '4.0')).not.toThrow();
  });

  test('request-only entry converts R5 -> R4 and is preserved', () => {
    const bundle = { resourceType: 'Bundle', type: 'batch', entry: [{ request: { method: 'GET', url: 'ValueSet' } }] };
    const out = convertResourceFromR5(bundle, '4.0');
    expect(out.entry).toHaveLength(1);
    expect(out.entry[0].request.url).toBe('ValueSet');
    expect(out.entry[0].resource).toBeUndefined();
  });

  test('Bundle without an entry array converts without throwing', () => {
    expect(() => convertResourceToR5({ resourceType: 'Bundle', type: 'searchset' }, '4.0')).not.toThrow();
  });

  test('entry WITH a resource still has that resource converted', () => {
    const bundle = {
      resourceType: 'Bundle', type: 'collection',
      entry: [{ resource: { resourceType: 'ValueSet', compose: { include: [{ system: 's' }] } } }]
    };
    const out = convertResourceFromR5(bundle, '4.0');
    expect(out.entry[0].resource.resourceType).toBe('ValueSet');
    expect(out.entry[0].resource.compose.include[0].system).toBe('s');
  });
});

describe('xversion — dispatcher passthrough', () => {
  test('an undefined resource passes through both directions without throwing', () => {
    expect(() => convertResourceToR5(undefined, '4.0')).not.toThrow();
    expect(() => convertResourceFromR5(undefined, '4.0')).not.toThrow();
    expect(convertResourceToR5(undefined, '4.0')).toBeUndefined();
  });

  test('a resource with no resourceType is returned unchanged', () => {
    const obj = { foo: 'bar' };
    expect(convertResourceToR5(obj, '4.0')).toBe(obj);
  });

  test('R5 source/target is a no-op passthrough', () => {
    const vs = { resourceType: 'ValueSet', url: 'http://x' };
    expect(convertResourceToR5(vs, '5.0')).toBe(vs);
    expect(convertResourceFromR5(vs, '5.0')).toBe(vs);
  });
});
