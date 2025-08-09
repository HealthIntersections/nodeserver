const path = require('path');
const { 
  IETFLanguageCodeProvider, 
  IETFLanguageCodeFactory, 
  IETFLanguageCodeFilter,
  LanguageComponent 
} = require('../../tx/cs/cs-lang');
const { LanguageDefinitions, Languages, Language } = require('../../tx/library/languages');
const { TxOperationContext } = require('../../tx/cs/cs-api');
const CodeSystem = require('../../tx/library/codesystem');

describe('IETF Language CodeSystem Provider', () => {
  let languageDefinitions;
  let provider;
  let opContext;

  beforeAll(async () => {
    // Load language definitions from data file
    const dataPath = path.join(__dirname, '../../data/lang.dat');
    languageDefinitions = await LanguageDefinitions.fromFile(dataPath);
    
    // Create provider instance
    provider = new IETFLanguageCodeProvider(languageDefinitions);
    
    // Create operation context
    opContext = new TxOperationContext(Languages.fromAcceptLanguage('en-US'));
  });

  describe('Metadata', () => {
    test('should return correct system URI', () => {
      expect(provider.system()).toBe('urn:ietf:bcp:47');
    });

    test('should return empty version', () => {
      expect(provider.version()).toBe('');
    });

    test('should return correct description', () => {
      expect(provider.description()).toBe('IETF language codes (BCP 47)');
    });

    test('should return -1 for total count (unbounded)', () => {
      expect(provider.totalCount()).toBe(-1);
    });

    test('should not have parents', () => {
      expect(provider.hasParents()).toBe(false);
    });

    test('should have complete content mode', () => {
      expect(provider.contentMode()).toBe('complete');
    });

    test('should have displays for English', () => {
      const langs = Languages.fromAcceptLanguage('en-US');
      expect(provider.hasAnyDisplays(langs)).toBe(true);
    });

    test('should not have displays for non-English without supplements', () => {
      const langs = Languages.fromAcceptLanguage('fr-FR');
      expect(provider.hasAnyDisplays(langs)).toBe(false);
    });
  });

  describe('Code validation and lookup', () => {
    test('should validate simple language codes', async () => {
      const result = await provider.locate(opContext, 'en');
      expect(result.context).toBeTruthy();
      expect(result.message).toBe(null);
      expect(result.context.language).toBe('en');
    });

    test('should validate language-region codes', async () => {
      const result = await provider.locate(opContext, 'en-US');
      expect(result.context).toBeTruthy();
      expect(result.message).toBe(null);
      expect(result.context.language).toBe('en');
      expect(result.context.region).toBe('US');
    });

    test('should validate language-script-region codes', async () => {
      const result = await provider.locate(opContext, 'zh-Hans-CN');
      expect(result.context).toBeTruthy();
      expect(result.message).toBe(null);
      expect(result.context.language).toBe('zh');
      expect(result.context.script).toBe('Hans');
      expect(result.context.region).toBe('CN');
    });

    test('should reject invalid language codes', async () => {
      const result = await provider.locate(opContext, 'invalid-code');
      expect(result.context).toBe(null);
      expect(result.message).toContain('Invalid language code');
    });

    test('should handle empty codes', async () => {
      const result = await provider.locate(opContext, '');
      expect(result.context).toBe(null);
      expect(result.message).toBe('Empty code');
    });

    test('should extract code from string context', () => {
      const code = provider.code(opContext, 'en-US');
      expect(code).toBe('en-US');
    });

    test('should extract code from Language context', () => {
      const lang = new Language('fr-CA');
      const code = provider.code(opContext, lang);
      expect(code).toBe('fr-CA');
    });
  });

  describe('Display names', () => {
    test('should return display for simple language', async () => {
      const display = await provider.display(opContext, 'en');
      expect(display).toBeTruthy();
      expect(display).not.toBe('??');
    });

    test('should return display for language-region', async () => {
      const display = await provider.display(opContext, 'en-US');
      expect(display).toBeTruthy();
      expect(display).not.toBe('??');
    });

    test('should return ?? for invalid codes', async () => {
      const display = await provider.display(opContext, 'invalid');
      expect(display).toBe('??');
    });

    test('should return ?? for empty codes', async () => {
      const display = await provider.display(opContext, '');
      expect(display).toBe('??');
    });
  });

  describe('Designations', () => {
    test('should return designations for valid language', async () => {
      const designations = await provider.designations(opContext, 'en');
      expect(Array.isArray(designations)).toBe(true);
      expect(designations.length).toBeGreaterThan(0);
      
      // Should have at least one primary designation
      const primary = designations.find(d => d.lang === 'en');
      expect(primary).toBeTruthy();
      expect(primary.value).toBeTruthy();
    });

    test('should return multiple designations for language-region codes', async () => {
      const designations = await provider.designations(opContext, 'en-US');
      expect(Array.isArray(designations)).toBe(true);
      expect(designations.length).toBeGreaterThan(1);
      
      // Should have region variant designations
      const regionVariant = designations.find(d => d.value.includes('('));
      expect(regionVariant).toBeTruthy();
    });

    test('should return empty array for invalid codes', async () => {
      const designations = await provider.designations(opContext, 'invalid');
      expect(designations).toEqual([]);
    });
  });

  describe('Filtering', () => {
    test('should support exists filters for language components', () => {
      expect(provider.doesFilter(opContext, 'language', 'exists', 'true')).toBe(true);
      expect(provider.doesFilter(opContext, 'script', 'exists', 'false')).toBe(true);
      expect(provider.doesFilter(opContext, 'region', 'exists', 'true')).toBe(true);
      expect(provider.doesFilter(opContext, 'invalid', 'exists', 'true')).toBe(false);
      expect(provider.doesFilter(opContext, 'language', 'equals', 'en')).toBe(false);
    });

    test('should create language component filters', async () => {
      const prep = provider.getPrepContext(opContext, false);
      const filter = await provider.filter(opContext, prep, 'language', 'exists', 'true');
      
      expect(filter).toBeInstanceOf(IETFLanguageCodeFilter);
      expect(filter.component).toBe(LanguageComponent.LANG);
      expect(filter.status).toBe(true);
    });

    test('should reject unsupported filter operators', async () => {
      const prep = provider.getPrepContext(opContext, false);
      
      await expect(
        provider.filter(opContext, prep, 'language', 'equals', 'en')
      ).rejects.toThrow('Unsupported filter operator');
    });

    test('should reject invalid exists values', async () => {
      const prep = provider.getPrepContext(opContext, false);
      
      await expect(
        provider.filter(opContext, prep, 'language', 'exists', 'maybe')
      ).rejects.toThrow('Invalid exists value');
    });

    test('should reject unsupported properties', async () => {
      const prep = provider.getPrepContext(opContext, false);
      
      await expect(
        provider.filter(opContext, prep, 'invalid-prop', 'exists', 'true')
      ).rejects.toThrow('Unsupported filter property');
    });
  });

  describe('Filter location', () => {
    test('should locate code with required language component', async () => {
      const prep = provider.getPrepContext(opContext, false);
      const filter = await provider.filter(opContext, prep, 'language', 'exists', 'true');
      
      const result = await provider.filterLocate(opContext, prep, filter, 'en-US');
      expect(result).toBeInstanceOf(Language);
      expect(result.code).toBe('en-US');
    });

    test('should locate code with required region component', async () => {
      const prep = provider.getPrepContext(opContext, false);
      const filter = await provider.filter(opContext, prep, 'region', 'exists', 'true');
      
      const result = await provider.filterLocate(opContext, prep, filter, 'en-US');
      expect(result).toBeInstanceOf(Language);
      expect(result.region).toBe('US');
    });

    test('should reject code missing required component', async () => {
      const prep = provider.getPrepContext(opContext, false);
      const filter = await provider.filter(opContext, prep, 'region', 'exists', 'true');
      
      const result = await provider.filterLocate(opContext, prep, filter, 'en');
      expect(typeof result).toBe('string');
      expect(result).toContain('does not contain');
    });

    test('should reject code with forbidden component', async () => {
      const prep = provider.getPrepContext(opContext, false);
      const filter = await provider.filter(opContext, prep, 'region', 'exists', 'false');
      
      const result = await provider.filterLocate(opContext, prep, filter, 'en-US');
      expect(typeof result).toBe('string');
      expect(result).toContain('contains');
      expect(result).toContain('not allowed');
    });

    test('should reject invalid language codes in filter', async () => {
      const prep = provider.getPrepContext(opContext, false);
      const filter = await provider.filter(opContext, prep, 'language', 'exists', 'true');
      
      const result = await provider.filterLocate(opContext, prep, filter, 'invalid-code');
      expect(typeof result).toBe('string');
      expect(result).toContain('Invalid language code');
    });
  });

  describe('Filter checking', () => {
    test('should check if concept matches filter', () => {
      const filter = new IETFLanguageCodeFilter(LanguageComponent.REGION, true);
      const concept = new Language('en-US');
      
      const result = provider.filterCheck(opContext, null, filter, concept);
      expect(result).toBe(true);
    });

    test('should check if concept fails filter', () => {
      const filter = new IETFLanguageCodeFilter(LanguageComponent.REGION, true);
      const concept = new Language('en');
      
      const result = provider.filterCheck(opContext, null, filter, concept);
      expect(result).toBe(false);
    });

    test('should validate filter type in filterCheck', () => {
      const concept = new Language('en');
      
      expect(() => {
        provider.filterCheck(opContext, null, 'invalid', concept);
      }).toThrow('Invalid filter set type');
    });

    test('should validate concept type in filterCheck', () => {
      const filter = new IETFLanguageCodeFilter(LanguageComponent.REGION, true);
      
      expect(() => {
        provider.filterCheck(opContext, null, filter, 'invalid');
      }).toThrow('Invalid concept type');
    });
  });

  describe('Supplements', () => {
    test('should report no supplements by default', () => {
      expect(provider.hasSupplement('http://example.com/supplement')).toBe(false);
      expect(provider.listSupplements()).toEqual([]);
    });

    test('should validate supplement types', () => {
      expect(() => {
        new IETFLanguageCodeProvider(languageDefinitions, ['invalid']);
      }).toThrow('must be a CodeSystem instance');
    });

    test('should validate supplement array type', () => {
      expect(() => {
        new IETFLanguageCodeProvider(languageDefinitions, 'invalid');
      }).toThrow('Supplements must be an array');
    });
  });

  describe('Unsupported operations', () => {
    test('should not support subsumption', async () => {
      const result = await provider.locateIsA(opContext, 'en-US', 'en');
      expect(result.context).toBe(null);
      expect(result.message).toContain('subsumption');
    });

    test('should not support iteration', () => {
      expect(provider.iterator(opContext, null)).toBe(null);
      expect(provider.nextContext(opContext, null)).toBe(null);
    });

    test('should not support expansion', () => {
      const filter = new IETFLanguageCodeFilter(LanguageComponent.LANG, true);
      
      expect(() => {
        provider.filterSize(opContext, null, filter);
      }).toThrow('cannot be expanded');
      
      expect(() => {
        provider.filterMore(opContext, null, filter);
      }).toThrow('cannot be expanded');
      
      expect(() => {
        provider.filterConcept(opContext, null, filter);
      }).toThrow('cannot be expanded');
    });

    test('should not support text search', async () => {
      await expect(
        provider.searchFilter(opContext, null, 'english', false)
      ).rejects.toThrow('Text search not supported');
    });

    test('should indicate filters are not closed', () => {
      expect(provider.filtersNotClosed(opContext, null)).toBe(true);
    });
  });

  describe('Utility methods', () => {
    test('should compare concepts correctly', () => {
      const lang1 = new Language('en-US');
      const lang2 = new Language('en-US');
      const lang3 = new Language('fr-CA');
      
      expect(provider.sameConcept(opContext, lang1, lang2)).toBe(true);
      expect(provider.sameConcept(opContext, lang1, lang3)).toBe(false);
      expect(provider.sameConcept(opContext, 'en-US', 'en-US')).toBe(true);
    });

    test('should not support subsumption testing', () => {
      expect(provider.subsumesTest(opContext, 'en', 'en-US')).toBe(false);
    });

    test('should return empty definitions', async () => {
      const definition = await provider.definition(opContext, 'en');
      expect(definition).toBe('');
    });

    test('should report codes as not abstract', () => {
      expect(provider.isAbstract(opContext, 'en')).toBe(false);
    });

    test('should report codes as not inactive', () => {
      expect(provider.isInactive(opContext, 'en')).toBe(false);
    });

    test('should report codes as not deprecated', () => {
      expect(provider.isDeprecated(opContext, 'en')).toBe(false);
    });

    test('should return null status', () => {
      expect(provider.getStatus(opContext, 'en')).toBe(null);
    });
  });

  describe('Factory', () => {
    let factory;

    beforeEach(() => {
      factory = new IETFLanguageCodeFactory(languageDefinitions);
    });

    test('should create factory correctly', () => {
      expect(factory.languageDefinitions).toBe(languageDefinitions);
      expect(factory.useCount()).toBe(0);
    });

    test('should return empty default version', () => {
      expect(factory.defaultVersion()).toBe('');
    });

    test('should build providers and track usage', () => {
      const provider1 = factory.build(opContext, null);
      expect(provider1).toBeInstanceOf(IETFLanguageCodeProvider);
      expect(factory.useCount()).toBe(1);

      const provider2 = factory.build(opContext, []);
      expect(provider2).toBeInstanceOf(IETFLanguageCodeProvider);
      expect(factory.useCount()).toBe(2);
    });

    test('should pass supplements to built providers', () => {
      const supplements = [];
      const provider = factory.build(opContext, supplements);
      expect(provider.supplements).toBe(supplements);
    });
  });
});
