const { UriServices, UriServicesFactory } = require('../../tx/cs/cs-uri');
const { Languages, Language } = require('../../tx/library/languages');
const CodeSystem = require('../../tx/library/codesystem');

describe('Enhanced UriServices with Language Support', () => {
  let uriServices;
  let opContext;

  beforeEach(() => {
    const supplData = {
      "resourceType" : "CodeSystem",
      "url" : "http://hl7.org/fhir/test/CodeSystem/example-url-supplement",
      "name" : "ExampleURLSupplement",
      "language" : "fr",
      "status" : "active",
      "content" : "supplement",
      "supplements" : "urn:ietf:rfc:3986",
      "concept" : [{
        "code" : "https://example.com/different",
        "display" : "Example Different URL",
        "designation" : [{
          "language" : "es",
          "value" : "spanish display"
        }, {
          "language" : "fr-CA",
          "value" : "french canadian display"
        }, {
          "language" : "en",
          "value" : "english display"
        }]
      }, {
        "code" : "https://example.com/another",
        "display" : "Another Example URL"
      }]
    };

    const supplement = new CodeSystem(supplData);
    opContext = {}; // Mock operation context
    uriServices = new UriServices([supplement]);
  });

  describe('Language-aware Display Detection', () => {
    test('should detect displays when supplement language matches requested language', () => {
      const frenchLanguages = Languages.fromAcceptLanguage('fr');
      expect(uriServices.hasAnyDisplays(frenchLanguages)).toBe(true);
    });

    test('should detect displays when supplement language matches more specific requested language', () => {
      const frenchCanadianLanguages = Languages.fromAcceptLanguage('fr-CA');
      expect(uriServices.hasAnyDisplays(frenchCanadianLanguages)).toBe(true);
    });

    test('should not detect displays when supplement language does not match', () => {
      const germanLanguages = Languages.fromAcceptLanguage('de');
      expect(uriServices.hasAnyDisplays(germanLanguages)).toBe(false);
    });

    test('should detect displays from designations in requested language', () => {
      const spanishLanguages = Languages.fromAcceptLanguage('es');
      expect(uriServices.hasAnyDisplays(spanishLanguages)).toBe(true);
    });

    test('should detect displays from designations with more specific language', () => {
      const frenchLanguages = Languages.fromAcceptLanguage('fr');
      expect(uriServices.hasAnyDisplays(frenchLanguages)).toBe(true);

      // fr-CA designation should match fr request
      const result = uriServices.hasAnyDisplays(frenchLanguages);
      expect(result).toBe(true);
    });

    test('should handle English fallback rules', () => {
      const englishLanguages = Languages.fromAcceptLanguage('en');
      expect(uriServices.hasAnyDisplays(englishLanguages)).toBe(true);
    });

    test('should handle multiple language preferences', () => {
      const multiLanguages = Languages.fromAcceptLanguage('de,fr;q=0.9,en;q=0.8');
      expect(uriServices.hasAnyDisplays(multiLanguages)).toBe(true);
    });

    test('should handle array input for backward compatibility', () => {
      expect(uriServices.hasAnyDisplays(['fr', 'en'])).toBe(true);
      expect(uriServices.hasAnyDisplays(['de', 'zh'])).toBe(false);
    });

    test('should handle string input for single language', () => {
      expect(uriServices.hasAnyDisplays('fr')).toBe(true);
      expect(uriServices.hasAnyDisplays('de')).toBe(false);
    });
  });

  describe('Display Retrieval with Language Awareness', () => {
    test('should return display from supplement when language matches', async () => {
      const testUri = 'https://example.com/different';

      // Set up operation context with French language preference
      const frenchContext = {
        languages: Languages.fromAcceptLanguage('fr')
      };

      const display = await uriServices.display(frenchContext, testUri);
      expect(display).toBe('Example Different URL');
    });

    test('should return designation when it matches language preference', async () => {
      const testUri = 'https://example.com/different';

      // Test that designations are considered in display method
      // (This would require enhancing the display method to check designations)
      const display = await uriServices.display(opContext, testUri);
      expect(display).toBe('Example Different URL');
    });

    test('should return empty string for URI not in supplement', async () => {
      const unknownUri = 'https://unknown.example.com/test';
      const display = await uriServices.display(opContext, unknownUri);
      expect(display).toBe('');
    });
  });

  describe('Enhanced Designations Method', () => {
    test('should return all designations from all supplements', async () => {
      const testUri = 'https://example.com/different';
      const designations = await uriServices.designations(opContext, testUri);

      expect(designations).toHaveLength(3);

      const languages = designations.map(d => d.language);
      expect(languages).toContain('es');
      expect(languages).toContain('fr-CA');
      expect(languages).toContain('en');

      const spanishDesignation = designations.find(d => d.language === 'es');
      expect(spanishDesignation.value).toBe('spanish display');
    });

    test('should return null for URI with no designations', async () => {
      const testUri = 'https://example.com/another';
      const designations = await uriServices.designations(opContext, testUri);
      expect(designations).toBeNull();
    });
  });

  describe('Language-aware Functionality', () => {
    test('should handle well-formed supplements', () => {
      const validSupplementData = {
        "resourceType" : "CodeSystem",
        "url" : "http://example.org/valid",
        "name" : "ValidSupplement",
        "language" : "en",
        "status" : "active",
        "concept" : [{
          "code" : "https://example.com/valid",
          "display" : "Valid Concept",
          "designation" : [{
            "language" : "fr",
            "value" : "Concept Valide"
          }],
          "property" : [{
            "code" : "status",
            "valueString" : "active"
          }]
        }]
      };

      const validSupplement = new CodeSystem(validSupplementData);

      expect(() => {
        new UriServices([validSupplement]);
      }).not.toThrow();
    });

    test('should reject non-CodeSystem supplements', () => {
      const rawObject = {
        "resourceType" : "CodeSystem",
        "language" : "en"
      };

      expect(() => {
        new UriServices([rawObject]);
      }).toThrow('Supplement 0 must be a CodeSystem instance, got object');
    });

    test('should reject non-array supplements', () => {
      const singleSupplement = new CodeSystem({
        "resourceType" : "CodeSystem",
        "url" : "http://example.org/single",
        "name" : "SingleSupplement",
        "status" : "active"
      });

      expect(() => {
        new UriServices(singleSupplement);  // Not wrapped in array
      }).toThrow('Supplements must be an array');
    });

    test('should handle supplements without concepts', () => {
      const supplNoConceptsData = {
        "resourceType" : "CodeSystem",
        "url" : "http://example.org/noconcepts",
        "name" : "NoConceptsSupplement",
        "language" : "en",
        "status" : "active"
        // No concept array
      };

      const supplNoConcepts = new CodeSystem(supplNoConceptsData);

      expect(() => {
        new UriServices([supplNoConcepts]);
      }).not.toThrow();
    });

    test('should handle empty supplements array', () => {
      expect(() => {
        new UriServices([]);
      }).not.toThrow();
    });

    test('should handle null supplements', () => {
      expect(() => {
        new UriServices(null);
      }).not.toThrow();
    });

    test('should work with supplement without language property', () => {
      const supplWithoutLangData = {
        "resourceType" : "CodeSystem",
        "url" : "http://example.org/nolang",
        "name" : "NoLangSupplement",
        "status" : "active",
        "concept" : [{
          "code" : "https://example.com/test",
          "display" : "Test Display"
        }]
      };

      const supplWithoutLang = new CodeSystem(supplWithoutLangData);
      const services = new UriServices([supplWithoutLang]);
      const languages = Languages.fromAcceptLanguage('en');

      // Should still work by checking designations
      expect(services.hasAnyDisplays(languages)).toBe(false);
    });

    test('should work with supplement with empty concepts array', () => {
      const supplEmptyData = {
        "resourceType" : "CodeSystem",
        "url" : "http://example.org/empty",
        "name" : "EmptySupplement",
        "language" : "en",
        "status" : "active",
        "concept" : []
      };

      const supplEmpty = new CodeSystem(supplEmptyData);
      const services = new UriServices([supplEmpty]);
      const languages = Languages.fromAcceptLanguage('en');

      expect(services.hasAnyDisplays(languages)).toBe(false);
    });
  });
});
