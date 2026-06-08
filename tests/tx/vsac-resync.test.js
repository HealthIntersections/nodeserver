const { VSACValueSetProvider } = require('../../tx/vs/vs-vsac');

/**
 * Tests for the operator "resync a ValueSet" action on the VSAC /info page.
 * The provider is built with Object.create to skip the real constructor (which
 * opens the sqlite database); we only exercise the form/password/dispatch logic.
 */

function provider({ password = null, refreshing = false, resync } = {}) {
  const p = Object.create(VSACValueSetProvider.prototype);
  p.resyncPassword = password;
  p.isRefreshing = refreshing;
  p.stats = { task() {} };
  if (resync) p.resyncValueSet = resync;
  return p;
}

const postReq = body => ({ method: 'POST', body });

describe('VSAC resync — feature gating', () => {
  test('disabled when no password configured', () => {
    const p = provider({ password: null });
    expect(p._resyncEnabled()).toBe(false);
    expect(p._resyncFormHtml()).toBe('');
  });

  test('enabled when a password is configured; form has url + password inputs, no value echoed', () => {
    const p = provider({ password: 'sekret' });
    expect(p._resyncEnabled()).toBe(true);
    const form = p._resyncFormHtml();
    expect(form).toContain('method="post"');
    expect(form).toContain('name="url"');
    expect(form).toContain('type="password"');
    expect(form).not.toContain('sekret');   // never reflect the password
  });
});

describe('VSAC resync — password check (timing-safe)', () => {
  test('matches only the exact configured password', () => {
    const p = provider({ password: 's3cret' });
    expect(p._passwordMatches('s3cret')).toBe(true);
    expect(p._passwordMatches('wrong')).toBe(false);
    expect(p._passwordMatches('')).toBe(false);
    expect(p._passwordMatches(null)).toBe(false);
    expect(p._passwordMatches('s3cretX')).toBe(false); // length mismatch
  });

  test('never matches when no password is configured', () => {
    expect(provider({ password: null })._passwordMatches('anything')).toBe(false);
  });
});

describe('VSAC resync — request handling', () => {
  test('does nothing when the feature is disabled', async () => {
    let called = false;
    const p = provider({ password: null, resync: async () => { called = true; return 1; } });
    const note = await p._handleResyncRequest(postReq({ url: 'http://x', password: 'whatever' }));
    expect(note).toBe('');
    expect(called).toBe(false);
  });

  test('wrong password: reports it and does not resync', async () => {
    let called = false;
    const p = provider({ password: 'pw', resync: async () => { called = true; return 1; } });
    const note = await p._handleResyncRequest(postReq({ url: 'http://x', password: 'nope' }));
    expect(note).toMatch(/Incorrect password/i);
    expect(called).toBe(false);
  });

  test('correct password but empty url: asks for a url, does not resync', async () => {
    let called = false;
    const p = provider({ password: 'pw', resync: async () => { called = true; return 1; } });
    const note = await p._handleResyncRequest(postReq({ url: '  ', password: 'pw' }));
    expect(note).toMatch(/Enter a ValueSet URL/i);
    expect(called).toBe(false);
  });

  test('correct password while a full sync is running: defers, does not resync', async () => {
    let called = false;
    const p = provider({ password: 'pw', refreshing: true, resync: async () => { called = true; return 1; } });
    const note = await p._handleResyncRequest(postReq({ url: 'http://x', password: 'pw' }));
    expect(note).toMatch(/full sync is currently running/i);
    expect(called).toBe(false);
  });

  test('correct password, idle: resyncs and reports the version count', async () => {
    let withUrl = null;
    const p = provider({ password: 'pw', resync: async (u) => { withUrl = u; return 4; } });
    const note = await p._handleResyncRequest(postReq({ url: 'http://example.org/vs', password: 'pw' }));
    expect(withUrl).toBe('http://example.org/vs');
    expect(note).toMatch(/Resynced/);
    expect(note).toContain('http://example.org/vs');
    expect(note).toContain('4');
  });

  test('a bare OID is expanded to the VSAC canonical URL before resyncing', async () => {
    let withUrl = null;
    const p = provider({ password: 'pw', resync: async (u) => { withUrl = u; return 1; } });
    await p._handleResyncRequest(postReq({ url: '2.16.840.1.113883.3.526.3.1240', password: 'pw' }));
    expect(withUrl).toBe('http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.526.3.1240');
  });
});

describe('VSAC resync — OID/URL expansion', () => {
  const p = provider({ password: 'pw' });

  test('bare OID expands', () => {
    expect(p._expandOidOrUrl('2.16.840.1.113883.3.526.3.1240'))
      .toBe('http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.526.3.1240');
  });

  test('urn:oid: prefix is stripped then expanded', () => {
    expect(p._expandOidOrUrl('urn:oid:2.16.840.1.113883.3.526.3.1240'))
      .toBe('http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.526.3.1240');
  });

  test('a full URL is left unchanged', () => {
    expect(p._expandOidOrUrl('http://hl7.org/fhir/ValueSet/x'))
      .toBe('http://hl7.org/fhir/ValueSet/x');
  });

  test('whitespace is trimmed', () => {
    expect(p._expandOidOrUrl('  2.16.840.1  ')).toBe('http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1');
  });

  test('empty input stays empty', () => {
    expect(p._expandOidOrUrl('')).toBe('');
    expect(p._expandOidOrUrl(null)).toBe('');
  });

  test('resync failure is reported, not thrown', async () => {
    const p = provider({ password: 'pw', resync: async () => { throw new Error('VSAC down'); } });
    const note = await p._handleResyncRequest(postReq({ url: 'http://x', password: 'pw' }));
    expect(note).toMatch(/failed/i);
    expect(note).toContain('VSAC down');
  });
});
