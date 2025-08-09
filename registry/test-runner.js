// test-runner.js
// Quick test runner to verify the fixes

const { 
  ServerRegistries, 
  ServerRegistry, 
  ServerInformation, 
  ServerVersionInformation,
  ServerRegistryUtilities,
  SECURITY_TYPES 
} = require('./registry-model');
const RegistryCrawler = require('./registry/crawler');
const RegistryAPI = require('./registry-api');

// Create sample test data
function createSampleData() {
  const data = new ServerRegistries();
  data.address = 'https://registry.example.org';
  data.lastRun = new Date('2024-01-15T10:00:00Z');
  data.outcome = 'Crawled 2 registries successfully, 0 errors';
  data.doco = 'Test registry for unit tests';

  // Registry 1: Main Registry
  const reg1 = new ServerRegistry();
  reg1.code = 'main';
  reg1.name = 'Main Terminology Registry';
  reg1.address = 'https://main.registry.org';
  reg1.authority = 'HL7 International';

  // Server 1.1: TX Server
  const server11 = new ServerInformation();
  server11.code = 'tx1';
  server11.name = 'TX Terminology Server';
  server11.address = 'https://tx.fhir.org';
  server11.accessInfo = 'Public FHIR terminology server';
  server11.authCSList = ['http://loinc.org*', 'http://snomed.info/sct*'];
  server11.authVSList = ['http://hl7.org/fhir/ValueSet/loinc*'];
  server11.usageList = ['production', 'public'];

  // Version 4.0.1 for TX Server
  const version111 = new ServerVersionInformation();
  version111.version = '4.0.1';
  version111.address = 'https://tx.fhir.org/r4';
  version111.security = 'open';
  version111.lastSuccess = new Date('2024-01-15T09:55:00Z');
  version111.lastTat = '250ms';
  version111.codeSystems = [
    'http://loinc.org',
    'http://snomed.info/sct',
    'http://hl7.org/fhir/sid/icd-10',
    'http://www.nlm.nih.gov/research/umls/rxnorm'
  ].sort();
  version111.valueSets = [
    'http://hl7.org/fhir/ValueSet/observation-codes',
    'http://hl7.org/fhir/ValueSet/condition-code',
    'http://hl7.org/fhir/ValueSet/loinc-diagnostic-report-codes'
  ].sort();
  server11.versions.push(version111);

  // Version 5.0.0 for TX Server (doesn't have loinc-diagnostic-report-codes)
  const version112 = new ServerVersionInformation();
  version112.version = '5.0.0';
  version112.address = 'https://tx.fhir.org/r5';
  version112.security = 'open';
  version112.lastSuccess = new Date('2024-01-15T09:56:00Z');
  version112.lastTat = '180ms';
  version112.codeSystems = [
    'http://loinc.org',
    'http://snomed.info/sct',
    'http://hl7.org/fhir/sid/icd-11'
  ].sort();
  version112.valueSets = [
    'http://hl7.org/fhir/ValueSet/observation-codes'
  ].sort();
  server11.versions.push(version112);

  // Server 1.2: Ontoserver
  const server12 = new ServerInformation();
  server12.code = 'onto';
  server12.name = 'Ontoserver';
  server12.address = 'https://ontoserver.example.org';
  server12.accessInfo = 'Enterprise terminology server';
  server12.authCSList = ['http://snomed.info/sct*'];
  server12.authVSList = [];
  server12.usageList = ['production'];

  const version121 = new ServerVersionInformation();
  version121.version = '6.4.0';
  version121.address = 'https://ontoserver.example.org/fhir';
  version121.security = 'oauth';
  version121.lastSuccess = new Date('2024-01-15T09:50:00Z');
  version121.lastTat = '180ms';
  version121.codeSystems = [
    'http://snomed.info/sct',
    'http://snomed.info/sct/32506021000036107',
    'http://loinc.org'
  ].sort();
  version121.valueSets = [
    'http://snomed.info/sct?fhir_vs=ecl/<404684003',
    'http://snomed.info/sct?fhir_vs=ecl/<373873005'
  ].sort();
  server12.versions.push(version121);

  reg1.servers.push(server11);
  reg1.servers.push(server12);

  // Registry 2: Test Registry
  const reg2 = new ServerRegistry();
  reg2.code = 'test';
  reg2.name = 'Test Terminology Registry';
  reg2.address = 'https://test.registry.org';
  reg2.authority = 'Testing Authority';

  // Server 2.1: Test Server with error
  const server21 = new ServerInformation();
  server21.code = 'test-server';
  server21.name = 'Test Server';
  server21.address = 'https://test.server.org';
  server21.accessInfo = 'Test server (currently down)';

  const version211 = new ServerVersionInformation();
  version211.version = '1.0.0';
  version211.address = 'https://test.server.org/fhir';
  version211.error = 'Connection timeout';
  server21.versions.push(version211);

  // Server 2.2: Local Dev Server
  const server22 = new ServerInformation();
  server22.code = 'local';
  server22.name = 'Local Development Server';
  server22.address = 'http://localhost:8080';
  server22.accessInfo = 'Local development instance';
  server22.authCSList = ['http://example.org/codesystem/*'];
  server22.authVSList = ['http://example.org/valueset/*'];

  const version221 = new ServerVersionInformation();
  version221.version = '5.0.0';
  version221.address = 'http://localhost:8080/fhir';
  version221.security = 'open';
  version221.lastSuccess = new Date('2024-01-15T08:00:00Z');
  version221.lastTat = '50ms';
  version221.codeSystems = [
    'http://example.org/codesystem/test1',
    'http://example.org/codesystem/test2',
    'http://hl7.org/fhir/sid/icd-10'
  ].sort();
  version221.valueSets = [
    'http://example.org/valueset/test1',
    'http://example.org/valueset/test2'
  ].sort();
  server22.versions.push(version221);

  reg2.servers.push(server21);
  reg2.servers.push(server22);

  data.registries.push(reg1);
  data.registries.push(reg2);

  return data;
}

// Run specific tests
function runTests() {
  const crawler = new RegistryCrawler();
  crawler.loadData(createSampleData().toJSON());
  const api = new RegistryAPI(crawler);
  
  console.log('\nRunning problematic tests:\n');
  
  // Test 1: should return all servers when no filter specified
  console.log('Test 1: should return all servers when no filter specified');
  const rows1 = api.buildRowsForCodeSystem({});
  console.log(`  Expected: 4 working versions`);
  console.log(`  Received: ${rows1.length} versions`);
  console.log(`  Server codes: ${rows1.map(r => `${r.serverCode}(${r.version})`).join(', ')}`);
  console.log(`  Test ${rows1.length === 4 ? '✓ PASSED' : '✗ FAILED'}\n`);
  
  // Test 2: should handle wildcard value set matching
  console.log('Test 2: should handle wildcard value set matching');
  const rows2 = api.buildRowsForValueSet({
    valueSet: 'http://hl7.org/fhir/ValueSet/loinc-diagnostic-report-codes'
  });
  console.log(`  Query: 'http://hl7.org/fhir/ValueSet/loinc-diagnostic-report-codes'`);
  console.log(`  TX server is authoritative for: 'http://hl7.org/fhir/ValueSet/loinc*'`);
  console.log(`  Version 4.0.1 HAS this value set`);
  console.log(`  Version 5.0.0 does NOT have this value set`);
  console.log(`  Expected: 1 version (4.0.1 which has the value set) OR 2 versions (both authoritative)?`);
  console.log(`  Received: ${rows2.length} version(s)`);
  if (rows2.length > 0) {
    console.log(`  Versions: ${rows2.map(r => `${r.version} (auth=${r.authoritative})`).join(', ')}`);
  }
  console.log(`  Test ${rows2.length === 1 && rows2[0].version === '4.0.1' ? '✓ PASSED (strict)' : rows2.length === 2 ? '✓ PASSED (Pascal-style)' : '✗ FAILED'}\n`);
  
  // Test 3: should rank servers without errors higher
  console.log('Test 3: should not include servers with errors even if authoritative');
  const data = crawler.getData();
  const testServer = data.registries[1].servers[0];
  testServer.authCSList = ['http://test.org/*'];
  
  const rows3 = api.buildRowsForCodeSystem({
    codeSystem: 'http://test.org/cs'
  });
  const hasErrorServer = rows3.some(r => r.serverCode === 'test-server');
  console.log(`  Expected: No test-server in results`);
  console.log(`  Received: ${hasErrorServer ? 'test-server found' : 'test-server not found'}`);
  console.log(`  Servers in result: ${rows3.map(r => r.serverCode).join(', ')}`);
  console.log(`  Test ${!hasErrorServer ? '✓ PASSED' : '✗ FAILED'}\n`);
  
  // Run all the other tests to make sure we didn't break anything
  console.log('Running additional validation tests:\n');
  
  // Test: Find servers supporting LOINC
  const loincRows = api.buildRowsForCodeSystem({
    codeSystem: 'http://loinc.org'
  });
  console.log('Test: Find servers supporting LOINC');
  console.log(`  Expected: 3 servers (tx1 v4, tx1 v5, onto v6)`);
  console.log(`  Received: ${loincRows.length} servers`);
  console.log(`  Test ${loincRows.length === 3 ? '✓ PASSED' : '✗ FAILED'}\n`);
  
  // Test: Filter by version
  const versionRows = api.buildRowsForCodeSystem({
    version: '4.0',
    codeSystem: 'http://loinc.org'
  });
  console.log('Test: Filter by version 4.0');
  console.log(`  Expected: 1 server (version 4.0.1)`);
  console.log(`  Received: ${versionRows.length} server(s)`);
  if (versionRows.length > 0) {
    console.log(`  Version: ${versionRows[0].version}`);
  }
  console.log(`  Test ${versionRows.length === 1 && versionRows[0].version === '4.0.1' ? '✓ PASSED' : '✗ FAILED'}\n`);
  
  console.log('================================');
  console.log('Test run complete!');
}

// Run the tests
runTests();