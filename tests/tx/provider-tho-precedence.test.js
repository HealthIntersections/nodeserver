const { Provider } = require('../../tx/provider');

/**
 * Mirrors the special-case logic in CanonicalResourceManager.see() in the Java
 * core: when content was moved from the FHIR core packages to
 * terminology.hl7.org (THO/UTG), the resource versions went backwards (e.g.
 * http://terminology.hl7.org/CodeSystem/coverage-selfpay is 4.0.1 in
 * hl7.fhir.r4.core (2019) but 1.0.1 in hl7.terminology (2024)). Plain
 * version precedence therefore left the stale core copy as the unversioned
 * default, so $lookup with no version couldn't find codes (like 'payconc')
 * that only exist in the THO copy. A THO resource must displace same-URL
 * resources from core packages as the unversioned default, regardless of
 * version — but explicitly versioned entries survive, because the core
 * packages carry historical versions (the R4 v2 tables 0006/0360/0391 at
 * 2.1/2.3.1/2.4/2.6/2.7, normalized from their pipe-versioned urls at load
 * time) that THO does not publish at all.
 */

const SELFPAY = 'http://terminology.hl7.org/CodeSystem/coverage-selfpay';

function cs(url, version, sourcePackage) {
  return {
    url,
    version,
    sourcePackage,
    vurl: version ? `${url}|${version}` : url,
    // string-compare "more recent" — fine for the versions used here
    isMoreRecent(other) { return String(this.version) > String(other.version); }
  };
}

function newProvider(...systems) {
  const p = Object.create(Provider.prototype);
  p.codeSystems = new Map();
  for (const s of systems) p.addCodeSystem(s);
  return p;
}

describe('Provider.addCodeSystem — THO vs core package precedence', () => {
  test('THO resource displaces an older-versioned core resource with the same url (coverage-selfpay case)', () => {
    const p = newProvider(
      cs(SELFPAY, '4.0.1', 'hl7.fhir.r4.core#4.0.1'),
      cs(SELFPAY, '1.0.1', 'hl7.terminology.r4#6.0.2')
    );
    // the unversioned default must be the THO copy despite its lower version
    expect(p.codeSystems.get(SELFPAY).sourcePackage).toBe('hl7.terminology.r4#6.0.2');
    expect(p.codeSystems.get(SELFPAY).version).toBe('1.0.1');
    // the core copy loses only the unversioned default slot; it stays addressable
    // by explicit version, because core packages carry historical versions (e.g. the
    // normalized R4 v2 tables 0006/0360/0391) that THO does not publish at all
    expect(p.codeSystems.has(SELFPAY + '|4.0.1')).toBe(true);
    expect(p.codeSystems.get(SELFPAY + '|4.0.1').sourcePackage).toBe('hl7.fhir.r4.core#4.0.1');
    expect(p.codeSystems.get(SELFPAY + '|1.0.1').sourcePackage).toBe('hl7.terminology.r4#6.0.2');
  });

  test('a core resource never displaces an already-loaded THO resource (reverse load order)', () => {
    const p = newProvider(
      cs(SELFPAY, '1.0.1', 'hl7.terminology.r4#6.0.2'),
      cs(SELFPAY, '4.0.1', 'hl7.fhir.r4.core#4.0.1')
    );
    expect(p.codeSystems.get(SELFPAY).sourcePackage).toBe('hl7.terminology.r4#6.0.2');
    // versioned addressability is kept in this load order too
    expect(p.codeSystems.get(SELFPAY + '|4.0.1').sourcePackage).toBe('hl7.fhir.r4.core#4.0.1');
  });

  test('a core resource yields its versioned slot to THO only when THO provides that exact version', () => {
    const p = newProvider(
      cs(SELFPAY, '1.0.1', 'hl7.terminology.r4#6.0.2'),
      cs(SELFPAY, '1.0.1', 'hl7.fhir.r4.core#4.0.1')
    );
    expect(p.codeSystems.get(SELFPAY + '|1.0.1').sourcePackage).toBe('hl7.terminology.r4#6.0.2');
  });

  test('THO does not displace same-url resources from non-core packages', () => {
    const p = newProvider(
      cs('http://a', '2.0.0', 'some.other.package#1.0.0'),
      cs('http://a', '1.0.0', 'hl7.terminology.r4#6.0.2')
    );
    // normal version precedence applies: 2.0.0 stays the default
    expect(p.codeSystems.get('http://a').version).toBe('2.0.0');
    expect(p.codeSystems.has('http://a|2.0.0')).toBe(true);
    expect(p.codeSystems.has('http://a|1.0.0')).toBe(true);
  });

  test('normal version precedence is unaffected when THO is not involved', () => {
    const p = newProvider(
      cs('http://b', '2', 'pkg.one#1.0.0'),
      cs('http://b', '1', 'pkg.two#1.0.0')
    );
    expect(p.codeSystems.get('http://b').version).toBe('2');
  });

  test('THO only displaces core resources with the same url', () => {
    const p = newProvider(
      cs('http://other', '4.0.1', 'hl7.fhir.r4.core#4.0.1'),
      cs(SELFPAY, '1.0.1', 'hl7.terminology.r4#6.0.2')
    );
    expect(p.codeSystems.get('http://other').version).toBe('4.0.1');
    expect(p.codeSystems.has('http://other|4.0.1')).toBe(true);
  });

  test('resources with no sourcePackage fall back to plain version precedence', () => {
    const p = newProvider(
      cs('http://c', '1', undefined),
      cs('http://c', '2', undefined)
    );
    expect(p.codeSystems.get('http://c').version).toBe('2');
  });
});
