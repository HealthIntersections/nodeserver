/**
 * Comprehensive Jest Test Suite for ECL Validator
 *
 * Tests based on:
 * - Official ECL specification examples
 * - SNOMED CT Browser examples
 * - Australian Digital Health examples
 * - IHTSDO query service examples
 * - Real-world clinical use cases
 *
 * Note that these sensible ECL examples were then twisted into weird non-sensical expressions to use the
 * test SCT set. Don't think they're going to make much sense
 */

const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const {ECLTokenType, ECLLexer, ECLValidator, ECLNodeType} = require("../../tx/sct/ecl");
const {join} = require("node:path");
const {OperationContext} = require("../../tx/operation-context");
const {TestUtilities} = require("../test-utilities");

describe('ECL Validator Test Suite', () => {
  let eclValidator;
  let snomedServices;
  let opContext;

  beforeAll(async () => {
    // Load test SNOMED data
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    const factory = new SnomedServicesFactory(opContext.i18n, join(__dirname, '../../tx/data/snomed-testing.cache'));
    await factory.load();
    snomedServices = factory.snomedServices;
    eclValidator = new ECLValidator(snomedServices);
  });

  describe('ECL cardinality counts distinct values (issue #230 bug 3)', () => {
    const expandCodes = (ecl) => {
      const ctx = snomedServices.filterECL(ecl, true, opContext);
      return new Set((ctx.descendants || []).map(i => snomedServices.concepts.getConceptId(i).toString()));
    };

    // 192008 has two raw 116676008 (Associated morphology) relationship rows but
    // only ONE distinct value — the local analog of the issue's 903008. It must
    // satisfy [1..1] and [1..*], and must NOT satisfy [2..*]. Counting raw rows
    // (the bug) gave the opposite.
    test('a single distinct morphology satisfies [1..1]/[1..*], not [2..*]', () => {
      const one = expandCodes('* : [1..1] 116676008 = *');
      const atLeastOne = expandCodes('* : [1..*] 116676008 = *');
      const two = expandCodes('* : [2..*] 116676008 = *');
      expect(one.has('192008')).toBe(true);
      expect(atLeastOne.has('192008')).toBe(true);
      expect(two.has('192008')).toBe(false);
    });

    test('[1..1] and [2..*] partition [1..*] (distinct-value counting is consistent)', () => {
      const one = expandCodes('* : [1..1] 116676008 = *');
      const two = expandCodes('* : [2..*] 116676008 = *');
      const atLeastOne = expandCodes('* : [1..*] 116676008 = *');
      expect(one.size + two.size).toBe(atLeastOne.size);
      for (const c of one) {
        expect(two.has(c)).toBe(false);
      }
    });

    // Value-constrained form, matching the shape of the external case
    // `< 64572001 : [1..1] 363698007 = << 10200004` whose count rose once
    // distinct counting was applied. 192008 has Associated morphology 442021009
    // in two raw rows but one distinct value, so it satisfies [1..1] (not [2..*])
    // for that specific value.
    test('value-constrained [1..1] includes a concept with one distinct value stated across rows', () => {
      const one = expandCodes('* : [1..1] 116676008 = 442021009');
      const atLeastOne = expandCodes('* : [1..*] 116676008 = 442021009');
      const two = expandCodes('* : [2..*] 116676008 = 442021009');
      expect(one.has('192008')).toBe(true);
      expect(atLeastOne.has('192008')).toBe(true);
      expect(two.has('192008')).toBe(false);
    });
  });

  describe('ECL memberOf (issue #230 bugs 1 & 2)', () => {
    const expand = (ecl) => {
      const ctx = snomedServices.filterECL(ecl, true, opContext);
      return ctx.descendants || [];
    };
    const codesOf = (ecl) => expand(ecl).map(i => snomedServices.concepts.getConceptId(i).toString());

    // Bug 1: a bare ^<concept that is not a reference set> must be rejected with
    // an error that names the concept (was: returned the fabricated 0xFFFFFFFF
    // sentinel / the concept itself).
    test('bare ^<non-reference-set> is rejected with a value-identifying error', () => {
      expect(() => snomedServices.filterECL('^404684003', true, opContext))
        .toThrow(/404684003 is not a reference set/);
    });

    // Bug 1: returns the refset's referenced-component concepts, including
    // concepts that are themselves inactive (active refers to the membership row,
    // not the referenced concept). 900000000000526001 (an association refset)
    // has one member: the inactive concept 307530000.
    test('memberOf returns referenced concepts, including inactive ones', () => {
      const codes = codesOf('^900000000000526001');
      expect(codes).toContain('307530000');
      const idx = expand('^900000000000526001').find(
        i => snomedServices.concepts.getConceptId(i).toString() === '307530000');
      expect(snomedServices.isActive(idx)).toBe(false); // inactive concept, still returned
    });

    // Bug 1: never fabricate the 0xFFFFFFFF (4294967295) sentinel, and never
    // return the operand concept itself.
    test('memberOf never emits the sentinel or the operand itself', () => {
      const codes = codesOf('^900000000000526001');
      expect(codes).not.toContain('4294967295');
      expect(codes).not.toContain('900000000000526001');
    });

    // Bug 2: a wrapped/computed operand must be evaluated, not rejected as
    // "non-concept-reference refset is not yet supported".
    test('wrapped memberOf operands are evaluated, not rejected as unsupported', () => {
      expect(() => snomedServices.filterECL('^(<<192008)', true, opContext)).not.toThrow();
      expect(() => snomedServices.filterECL('^(404684003)', true, opContext)).not.toThrow();
      // computed operand is lenient: non-refset concepts in the set are skipped
      expect(Array.isArray(codesOf('^(404684003)'))).toBe(true);
    });
  });

  describe('ECL Lexer Tests', () => {

    test('should tokenize simple concept reference', () => {
      const lexer = new ECLLexer('404684003 |Clinical finding|');
      const tokens = lexer.tokenize();

      expect(tokens).toHaveLength(3); // SCTID, TERM, PIPE, EOF
      expect(tokens[0]).toMatchObject({
        type: ECLTokenType.SCTID,
        value: '404684003'
      });
      expect(tokens[1]).toMatchObject({
        type: ECLTokenType.TERM,
        value: 'Clinical finding'
      });
    });

    test('should tokenize constraint operators', () => {
      const operators = [
        { input: '<', expected: ECLTokenType.DESCENDANT_OF },
        { input: '<!', expected: ECLTokenType.CHILD_OF },
        { input: '<<', expected: ECLTokenType.DESCENDANT_OR_SELF_OF },
        { input: '<<!', expected: ECLTokenType.CHILD_OR_SELF_OF },
        { input: '>', expected: ECLTokenType.ANCESTOR_OF },
        { input: '>>', expected: ECLTokenType.ANCESTOR_OR_SELF_OF },
        { input: '>!', expected: ECLTokenType.PARENT_OF },
        { input: '>>!', expected: ECLTokenType.PARENT_OR_SELF_OF }
      ];

      operators.forEach(({ input, expected }) => {
        const lexer = new ECLLexer(input);
        console.log(`Tokenizing "${input}": ${expected}`);
        const tokens = lexer.tokenize();
        expect(tokens[0].type).toBe(expected);
        expect(tokens[0].value).toBe(input);
      });
    });

    test('should tokenize boolean operators and keywords', () => {
      const lexer = new ECLLexer('AND OR MINUS R');
      const tokens = lexer.tokenize();

      expect(tokens[0].type).toBe(ECLTokenType.AND);
      expect(tokens[1].type).toBe(ECLTokenType.OR);
      expect(tokens[2].type).toBe(ECLTokenType.MINUS);
      expect(tokens[3].type).toBe(ECLTokenType.REVERSE);
    });

    test('should tokenize special characters and punctuation', () => {
      const lexer = new ECLLexer('(){}[],:=!=<><=>=^*.');
      const tokens = lexer.tokenize();

      const expectedTypes = [
        ECLTokenType.LPAREN,
        ECLTokenType.RPAREN,
        ECLTokenType.LBRACE,
        ECLTokenType.RBRACE,
        ECLTokenType.LBRACKET,
        ECLTokenType.RBRACKET,
        ECLTokenType.COMMA,
        ECLTokenType.COLON,
        ECLTokenType.EQUALS,
        ECLTokenType.NOT_EQUALS,
        ECLTokenType.DESCENDANT_OF,
        ECLTokenType.ANCESTOR_OF,
        ECLTokenType.LTE,
        ECLTokenType.GTE,
        ECLTokenType.MEMBER_OF,
        ECLTokenType.WILDCARD,
        ECLTokenType.DOT,
        ECLTokenType.EOF
      ];

      tokens.forEach((token, index) => {
        console.log(`Token ${expectedTypes[index]}: ${token.type}`);
        if (index < expectedTypes.length - 1) { // Exclude EOF from detailed check
          expect(token.type).toBe(expectedTypes[index]);
        }
      });

      expect(tokens[tokens.length - 1].type).toBe(ECLTokenType.EOF);
    });

    test('should handle numeric literals correctly', () => {
      const lexer = new ECLLexer('123 -456 78.9 -12.34');
      const tokens = lexer.tokenize();

      // With Option 1: all positive digit sequences are treated as SCTIDs
      expect(tokens[0]).toMatchObject({
        type: ECLTokenType.SCTID,
        value: '123'
      });
      // Negative numbers still use the number parsing logic
      expect(tokens[1]).toMatchObject({
        type: ECLTokenType.INTEGER,
        value: '-456'
      });
      // Decimal sequences parsed as SCTID (will be validated semantically)
      expect(tokens[2]).toMatchObject({
        type: ECLTokenType.DECIMAL,
        value: '78.9'
      });
      // Negative decimal
      expect(tokens[3]).toMatchObject({
        type: ECLTokenType.DECIMAL,
        value: '-12.34'
      });
    });

    test('should handle string literals with escaping', () => {
      const lexer = new ECLLexer('"simple string" "string with \\"quotes\\"" \'single quotes\'');
      const tokens = lexer.tokenize();

      expect(tokens[0]).toMatchObject({
        type: ECLTokenType.STRING,
        value: 'simple string'
      });
      expect(tokens[1]).toMatchObject({
        type: ECLTokenType.STRING,
        value: 'string with "quotes"'
      });
      expect(tokens[2]).toMatchObject({
        type: ECLTokenType.STRING,
        value: 'single quotes'
      });
    });

    test('should handle whitespace correctly', () => {
      const lexer = new ECLLexer('  \t\n<< \r\n 404684003  \t');
      const tokens = lexer.tokenize();

      expect(tokens).toHaveLength(3); // <<, SCTID, EOF (whitespace ignored)
      expect(tokens[0].type).toBe(ECLTokenType.DESCENDANT_OR_SELF_OF);
      expect(tokens[1].type).toBe(ECLTokenType.SCTID);
    });

    test('should throw error on invalid characters', () => {
      const lexer = new ECLLexer('404684003 @ invalid');
      expect(() => lexer.tokenize()).toThrow('Unexpected character');
    });

    test('should throw error on unterminated string', () => {
      const lexer = new ECLLexer('"unterminated string');
      expect(() => lexer.tokenize()).toThrow('Unterminated string');
    });

    test('should throw error on unterminated term', () => {
      const lexer = new ECLLexer('|unterminated term');
      expect(() => lexer.tokenize()).toThrow('Unterminated term');
    });
  });

  describe('ECL Parser Tests', () => {

    test('should parse simple concept reference', () => {
      const result = eclValidator.parse('404684003 |Clinical finding|');

      expect(result.success).toBe(true);
      expect(result.ast.type).toBe(ECLNodeType.SUB_EXPRESSION_CONSTRAINT);
      expect(result.ast.focus.type).toBe(ECLNodeType.CONCEPT_REFERENCE);
      expect(result.ast.focus.conceptId).toBe('404684003');
      expect(result.ast.focus.term).toBe('Clinical finding');
    });

    test('should parse wildcard', () => {
      const result = eclValidator.parse('*');

      expect(result.success).toBe(true);
      expect(result.ast.focus.type).toBe(ECLNodeType.WILDCARD);
    });

    test('should parse constraint operators', () => {
      const testCases = [
        {
          input: '< 404684003 |Clinical finding|',
          operator: ECLTokenType.DESCENDANT_OF
        },
        {
          input: '<< 404684003 |Clinical finding|',
          operator: ECLTokenType.DESCENDANT_OR_SELF_OF
        },
        {
          input: '<! 404684003 |Clinical finding|',
          operator: ECLTokenType.CHILD_OF
        },
        {
          input: '<<! 404684003 |Clinical finding|',
          operator: ECLTokenType.CHILD_OR_SELF_OF
        }
      ];

      testCases.forEach(({ input, operator }) => {
        console.log(`Parsing: ${input}`);
        const result = eclValidator.parse(input);
        expect(result.success).toBe(true);
        expect(result.ast.operator).toBe(operator);
        expect(result.ast.focus.conceptId).toBe('404684003');
      });
    });

    test('should parse compound expressions with boolean operators', () => {
      const testCases = [
        {
          input: '404684003 |Clinical finding| AND 11687002 |Gestational diabetes mellitus|',
          operator: ECLNodeType.CONJUNCTION
        },
        {
          input: '404684003 |Clinical finding| OR 11687002 |Gestational diabetes mellitus|',
          operator: ECLNodeType.DISJUNCTION
        },
        {
          input: '404684003 |Clinical finding| MINUS 11687002 |Gestational diabetes mellitus|',
          operator: ECLNodeType.EXCLUSION
        }
      ];

      testCases.forEach(({ input, operator }) => {
        const result = eclValidator.parse(input);
        expect(result.success).toBe(true);
        expect(result.ast.type).toBe(ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT);
        expect(result.ast.operator).toBe(operator);
      });
    });

    test('should parse refinement expressions', () => {
      const result = eclValidator.parse(
        '<< 404684003 |Clinical finding|: 363698007 |Finding site| = << 39057004 |Pulmonary valve structure|'
      );

      expect(result.success).toBe(true);
      expect(result.ast.type).toBe(ECLNodeType.REFINED_EXPRESSION_CONSTRAINT);
      expect(result.ast.base.operator).toBe(ECLTokenType.DESCENDANT_OR_SELF_OF);
      expect(result.ast.refinement.type).toBe(ECLNodeType.ATTRIBUTE);
    });

    test('should parse attribute groups', () => {
      const result = eclValidator.parse(
        '<< 404684003 |Clinical finding|: {363698007 |Finding site| = << 39057004 |Pulmonary valve structure|, 116676008 |Associated morphology| = << 415582006 |Stenosis|}'
      );

      expect(result.success).toBe(true);
      expect(result.ast.refinement.type).toBe(ECLNodeType.ATTRIBUTE_GROUP);
      expect(result.ast.refinement.attributes).toHaveLength(2);
    });

    test('should parse cardinality constraints', () => {
      const result = eclValidator.parse(
        '<< 404684003 |Clinical finding|: [1..3] 363698007 |Finding site| = << 39057004 |Pulmonary valve structure|'
      );

      expect(result.success).toBe(true);
      expect(result.ast.refinement.cardinality.min).toBe(1);
      expect(result.ast.refinement.cardinality.max).toBe(3);
    });

    test('should parse dotted expressions', () => {
      const result = eclValidator.parse(
        '<< 404684003 |Clinical finding|.363698007 |Finding site|'
      );

      expect(result.success).toBe(true);
      expect(result.ast.type).toBe(ECLNodeType.DOTTED_EXPRESSION_CONSTRAINT);
      expect(result.ast.attributes).toHaveLength(1);
    });

    test('should parse member of expressions', () => {
      const result = eclValidator.parse(
        '^ 192008 |Congenital syphilitic hepatomegaly|'
      );

      expect(result.success).toBe(true);
      expect(result.ast.focus.type).toBe(ECLNodeType.MEMBER_OF);
    });

    test('should parse parenthesized expressions', () => {
      const result = eclValidator.parse(
        '(<< 404684003 |Clinical finding| AND << 11687002 |Gestational diabetes mellitus|)'
      );

      expect(result.success).toBe(true);
      expect(result.ast.type).toBe(ECLNodeType.SUB_EXPRESSION_CONSTRAINT);
    });

    test('should handle parser errors gracefully', () => {
      const invalidExpressions = [
        '< <',  // Invalid syntax
        '404684003 |',  // Unterminated term
        ': 363698007',  // Missing base expression
        '404684003 AND',  // Incomplete boolean expression
        '{363698007 =',  // Incomplete attribute group
      ];

      invalidExpressions.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('error');
      });
    });
  });

  describe('Official ECL Specification Examples', () => {

    test('Simple Expression Constraints', () => {
      const examples = [
        '404684003 |Clinical finding|',
        '*',
        '< 404684003 |Clinical finding|',
        '<< 11687002 |Gestational diabetes mellitus|',
        '<! 404684003 |Clinical finding|',
        '<<!11687002 |Gestational diabetes mellitus|',
        '> 371067004 |Hepatopulmonary syndrome|',
        '>> 371067004 |Hepatopulmonary syndrome|',
        '>! 371067004 |Hepatopulmonary syndrome|',
        '>>! 371067004 |Hepatopulmonary syndrome|',
        '^ 192008 |Congenital syphilitic hepatomegaly|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });

    test('Compound Expression Constraints', () => {
      const examples = [
        '<< 362965005 |Disorder of body system| AND << 302292003 |Finding of trunk structure|',
        '<< 362965005 |Disorder of body system| OR << 302292003 |Finding of trunk structure|',
        '<< 362965005 |Disorder of body system| MINUS << 302292003 |Finding of trunk structure|',
        '<< 404684003 |Clinical finding| AND ^ 192008 |Congenital syphilitic hepatomegaly|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });

    test('Refined Expression Constraints', () => {
      const examples = [
        '<< 404684003 |Clinical finding|: 363698007 |Finding site| = << 39057004 |Pulmonary valve structure|',
        '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = << 415582006 |Stenosis|',
        '<< 404684003 |Clinical finding|: 363698007 |Finding site| = << 39057004 |Pulmonary valve structure|, 116676008 |Associated morphology| = << 415582006 |Stenosis|',
        '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = (<< 19921004 |Crushing injury| OR << 50960005 |Hemorrhage|)',
        '<< 404684003 |Clinical finding|: 47429007 |Associated with| = (<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = << 55641003 |Infarct|)'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });

    test('Attribute Groups', () => {
      const examples = [
        '<< 404684003 |Clinical finding|: {363698007 |Finding site| = << 39057004 |Pulmonary valve structure|, 116676008 |Associated morphology| = << 415582006 |Stenosis|}',
        '<< 404684003 |Clinical finding|: {363698007 |Finding site| = << 39057004 |Pulmonary valve structure|, 116676008 |Associated morphology| = << 415582006 |Stenosis|}, {363698007 |Finding site| = << 73829009 |Right atrial structure|, 116676008 |Associated morphology| = << 56246009 |Hypertrophy|}'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });

    test('Cardinality Constraints', () => {
      const examples = [
        '<< 373873005 |Pharmaceutical / biologic product|: [1..3] 127489000 |Has active ingredient| = << 105590001 |Substance|',
        '<< 373873005 |Pharmaceutical / biologic product|: [1..*] 127489000 |Has active ingredient| = << 105590001 |Substance|',
        '<< 373873005 |Pharmaceutical / biologic product|: [0..1] 127489000 |Has active ingredient| = << 105590001 |Substance|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('Dotted Expression Constraints', () => {
      const examples = [
        '<< 72704001 |Fracture|.363698007 |Finding site|',
        '<< 404684003 |Clinical finding|.363698007 |Finding site|.272741003 |Laterality|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });

    test('Numeric Value Constraints', () => {
      const examples = [
        '<< 406459008 |Halibut liver oil product|: 411116001 |Has manufactured dose form| = << 420692007 |Conventional release oral capsule|, {732943007 |Has basis of strength substance| = (776168003 |Product containing only halibut liver oil (medicinal product)|: 732943007 |Has basis of strength substance| >= #500, 767525000 |Unit| = 258684004 |mg|)}'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Real-world Clinical Examples', () => {

    test('Clinical Finding Hierarchy Examples', () => {
      const examples = [
        // Basic clinical findings
        '<< 404684003 |Clinical finding|',
        '<< 243796009 |Situation with explicit context|',
        '<< 272379006 |Event|',

        // Specific conditions
        '<< 11687002 |Gestational diabetes mellitus|',
        '<< 72704001 |Fracture|',
        '<< 362965005 |Disorder of body system|',

        // Complex conditions with refinements
        '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = << 72704001 |Fracture|',
        '<< 404684003 |Clinical finding|: 363698007 |Finding site| = << 23416004 |Bone structure of ulna|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });

    test('Pharmaceutical Product Examples', () => {
      const examples = [
        '<< 373873005 |Pharmaceutical / biologic product|',
        '<< 373873005 |Pharmaceutical / biologic product|: 127489000 |Has active ingredient| = << 406459008 |Halibut liver oil product|',
        '<< 373873005 |Pharmaceutical / biologic product|: [1..3] 127489000 |Has active ingredient| = << 105590001 |Substance|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });

    test('Complex Boolean Combinations', () => {
      const examples = [
        // Lung disorders with edema
        '<< 362965005 |Disorder of body system| AND << 302292003 |Finding of trunk structure|',

        // Findings with Acute inflammation or hemorrhage morphology
        '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = (<< 4532008 |Acute inflammation| OR << 50960005 |Hemorrhage|)',

        // Lung disorders excluding those in cardiology refset
        '<< 362965005 |Disorder of body system| MINUS ^ 192008 |Congenital syphilitic hepatomegaly|',

        // Complex nested expressions
        '(<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = << 4532008 |Acute inflammation|) AND (<< 404684003 |Clinical finding|: 363698007 |Finding site| = << 23416004 |Bone structure of ulna|)'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });

    test('Reference Set Examples', () => {
      const examples = [
        '^ 192008 |Congenital syphilitic hepatomegaly|',
        '^ 900000000000509007 |United States of America English language reference set|',
        '^(<< 900000000000526001 |REPLACED BY association reference set|)'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Edge Cases and Error Handling', () => {

    test('should handle empty input', () => {
      const result = eclValidator.parse('');
      expect(result.success).toBe(false);
    });

    test('should handle whitespace-only input', () => {
      const result = eclValidator.parse('   \t\n   ');
      expect(result.success).toBe(false);
    });

    test('should handle malformed expressions', () => {
      const malformedExpressions = [
        '< <',
        '404684003 |',
        ': 363698007',
        '404684003 AND',
        '{363698007 =',
        '404684003 |Clinical finding| :',
        '<< AND >>',
        '^ ^ 192008',
        '404684003 |Clinical finding| |'
      ];

      malformedExpressions.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      });
    });

    test('should handle nested parentheses correctly', () => {
      const examples = [
        '(404684003 |Clinical finding|)',
        '((404684003 |Clinical finding|))',
        '(<< 404684003 |Clinical finding| AND (<< 11687002 |Gestational diabetes mellitus| OR << 72704001 |Fracture|))'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });

    test('should handle complex cardinality expressions', () => {
      const examples = [
        '[*] 127489000 |Has active ingredient|',
        '[0..*] 127489000 |Has active ingredient|',
        '[1..1] 127489000 |Has active ingredient|',
        '[5..10] 127489000 |Has active ingredient|'
      ];

      examples.forEach(cardinalityExpr => {
        const fullExpr = `<< 373873005 |Pharmaceutical / biologic product|: ${cardinalityExpr} = << 105590001 |Substance|`;
        const result = eclValidator.parse(fullExpr);
        expect(result.success).toBe(true);
      });
    });

    test('should handle reverse flag correctly', () => {
      const examples = [
        '<< 404684003 |Clinical finding|: R 363698007 |Finding site| = << 39057004 |Pulmonary valve structure|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
        expect(result.ast.refinement.reverse).toBe(true);
      });
    });
  });

  describe('Semantic Validation Tests', () => {

    test('should validate concept existence for valid concepts', () => {
      // These tests will depend on what concepts are in the test cache
      const potentiallyValidConcepts = [
        '404684003 |Clinical finding|',
        '138875005 |SNOMED CT Concept|',
        '11687002 |Gestational diabetes mellitus|'
      ];

      potentiallyValidConcepts.forEach(expr => {
        const result = eclValidator.parse(expr);
        // We expect parsing to succeed, semantic validation may or may not
        expect(result.success || result.errors.some(e => e.includes('not found'))).toBe(true);
      });
    });

    test('should reject invalid concept IDs', () => {
      const invalidConcepts = [
        'abc123 |Invalid concept|',
        '99999999999999999 |Non-existent concept|',
        '0 |Zero concept|'
      ];

      invalidConcepts.forEach(expr => {
        const result = eclValidator.parse(expr);
        if (result.success) {
          // If parsing succeeds, semantic validation should catch it
          expect(result.errors.length).toBeGreaterThan(0);
        }
      });
    });

    test('should validate syntax without semantic checks', () => {
      const result = eclValidator.validateSyntax('<< 999999999 |Non-existent concept|');
      expect(result.success).toBe(true); // Syntax is valid
    });
  });

  describe('Performance Tests', () => {

    test('should parse simple expressions quickly', () => {
      const start = Date.now();

      for (let i = 0; i < 1000; i++) {
        eclValidator.parse('<< 404684003 |Clinical finding|');
      }

      const duration = Date.now() - start;
      expect(duration).toBeLessThan(1000); // Should complete 1000 parses in under 1 second
    });

    test('should parse complex expressions in reasonable time', () => {
      const complexExpression = `
        (<< 404684003 |Clinical finding|: 
          {363698007 |Finding site| = << 39057004 |Pulmonary valve structure|, 
           116676008 |Associated morphology| = << 415582006 |Stenosis|}, 
          {363698007 |Finding site| = << 73829009 |Right atrial structure|, 
           116676008 |Associated morphology| = << 56246009 |Hypertrophy|}) 
        AND 
        (<< 373873005 |Pharmaceutical / biologic product|: 
          [1..3] 127489000 |Has active ingredient| = << 105590001 |Substance|)
      `;

      const start = Date.now();
      const result = eclValidator.parse(complexExpression);
      const duration = Date.now() - start;

      console.log(`Parse "${complexExpression}": ${result.success} (${result.errors})`);

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(100); // Should parse complex expression in under 100ms
    });
  });

  describe('Integration Tests with SNOMED Services', () => {

    test('should integrate with SNOMED filter operations', async () => {
      // Test basic concept lookup
      if (snomedServices.conceptExists('404684003')) {
        const result = await eclValidator.evaluate('404684003 |Clinical finding|');
        expect(result.total).toBeGreaterThan(0);
        expect(result.results).toHaveLength(1);
        expect(result.results[0].conceptId).toBe('404684003');
      }
    });

    test('should handle hierarchy operations if concepts exist', async () => {
      // Test descendant operations
      try {
        const result = await eclValidator.evaluate('<< 138875005 |SNOMED CT Concept|');
        expect(result.total).toBeGreaterThan(0);
      } catch (error) {
        // Concept might not exist in test data
        expect(error.message).toContain('not found');
      }
    });

    test('should handle wildcard evaluation with limits', async () => {
      try {
        const result = await eclValidator.evaluate('*');
        expect(result.total).toBeGreaterThan(0);
        expect(result.results.length).toBeLessThanOrEqual(1000); // Should be limited
      } catch (error) {
        // May not be supported or may timeout
        console.log('Wildcard evaluation not supported or failed:', error.message);
      }
    });
  });

  describe('Advanced ECL Features', () => {

    test('should handle nested expressions correctly', () => {
      const nestedExpressions = [
        '<< 404684003 |Clinical finding|: 47429007 |Associated with| = (<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = << 55641003 |Infarct|)',
        '^(<< 192008 |Congenital syphilitic hepatomegaly|)',
        '(<< 404684003 |Clinical finding| AND << 11687002 |Gestational diabetes mellitus|) OR (<< 72704001 |Fracture| AND << 23416004 |Bone structure of ulna|)'
      ];

      nestedExpressions.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });

    test('should handle mixed operator precedence', () => {
      const expressions = [
        '<< 404684003 |Clinical finding| AND << 11687002 |Gestational diabetes mellitus| OR << 72704001 |Fracture|',
        '<< 404684003 |Clinical finding| OR << 11687002 |Gestational diabetes mellitus| AND << 72704001 |Fracture|',
        '<< 404684003 |Clinical finding| MINUS << 11687002 |Gestational diabetes mellitus| AND << 72704001 |Fracture|'
      ];

      expressions.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });

    test('should handle attribute constraints with comparison operators', () => {
      const expressions = [
        '<< 404684003 |Clinical finding|: 363698007 |Finding site| != << 39057004 |Pulmonary valve structure|',
        '<< 406459008 |Halibut liver oil product|: 732943007 |Has basis of strength substance| >= #500',
        '<< 406459008 |Halibut liver oil product|: 732943007 |Has basis of strength substance| <= #1000',
        '<< 406459008 |Halibut liver oil product|: 732943007 |Has basis of strength substance| > #250',
        '<< 406459008 |Halibut liver oil product|: 732943007 |Has basis of strength substance| < #1500'
      ];

      expressions.forEach(expr => {
        const result = eclValidator.parse(expr);
        console.log(`Parse "${expr}": ${result.success} (${result.errors})`);
        expect(result.success).toBe(true);
      });
    });
  });
  describe('ECL Term Validation', () => {
    test('should accept valid concept with correct term', () => {
      // You'll need to fill in a real concept ID and its actual term from your SNOMED data
      const result = eclValidator.parse('11687002 |Gestational diabetes mellitus|');
      console.log(`Parse "11687002 |Gestational diabetes mellitus|": ${result.success} (${result.errors})`);

      expect(result.success).toBe(true);
      expect(result.ast.type).toBe(ECLNodeType.SUB_EXPRESSION_CONSTRAINT);
      expect(result.ast.focus.conceptId).toBe('11687002');
      expect(result.ast.focus.term).toBe('Gestational diabetes mellitus');
    });

    test('should reject valid concept with incorrect term', () => {
      // Same concept ID but with wrong term
      const result = eclValidator.parse('11687002 |Wrong term here|');
      console.log(`Parse "11687002 |Wrong term here|": ${result.success} (${result.errors})`);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Term "Wrong term here" does not match any active description for concept 11687002');
    });

    test('should accept concept without term', () => {
      // Just the concept ID without term should still work
      const result = eclValidator.parse('11687002');
      console.log(`Parse "'11687002'": ${result.success} (${result.errors})`);

      expect(result.success).toBe(true);
      expect(result.ast.focus.conceptId).toBe('11687002');
      expect(result.ast.focus.term).toBeNull();
    });

    test('should handle term validation in compound expressions', () => {
      // Test term validation works in more complex expressions
      const result = eclValidator.parse('<< 11687002 |Gestational diabetes mellitus| AND << 404684003 |Wrong clinical finding term|');
      console.log(`Parse "<< 11687002 |Gestational diabetes mellitus| AND << 404684003 |Wrong clinical finding term|": ${result.success} (${result.errors})`);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('does not match any active description');
    });

    test('should handle term validation in refinements', () => {
      // Test term validation in attribute contexts
      const result = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Wrong morphology term| = 72704001 |Fracture|');
      console.log(`Parse "<< 404684003 |Clinical finding|: 116676008 |Wrong morphology term| = 72704001 |Fracture|": ${result.success} (${result.errors})`);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('does not match any active description');
    });

    test('should provide helpful error message with expected term', () => {
      const result = eclValidator.parse('11687002 |Completely wrong term|');

      expect(result.success).toBe(false);
      expect(result.errors[0]).toMatch(/Expected term like ".*"/);
    });
  });

  describe('ECL Semantic Validation (Separate)', () => {

    describe('Parse vs Semantic Validation Separation', () => {
      test('parse() should succeed even with semantic errors', () => {
        // This has semantic errors but should parse fine
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 11687002 | Gestational diabetes mellitus | = 72704001 |Fracture|');

        expect(parseResult.success).toBe(true);
        expect(parseResult.ast).toBeDefined();
        expect(parseResult.errors).toHaveLength(0);
      });

      test('validateSemantics() should catch semantic errors', () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 11687002 | Gestational diabetes mellitus | = 72704001 |Fracture|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(false);
        expect(semanticResult.errors).toHaveLength(1);
        expect(semanticResult.errors[0]).toContain('is not a valid relationship type');
      });

      test('parseAndValidateSemantics() should do both in one call', () => {
        const result = eclValidator.parseAndValidateSemantics('<< 404684003 |Clinical finding|: 11687002 | Gestational diabetes mellitus | = 72704001 |Fracture|');

        expect(result.success).toBe(false);
        expect(result.ast).toBeDefined(); // Parse succeeded
        expect(result.errors).toHaveLength(1); // But semantic validation failed
        expect(result.errors[0]).toContain('is not a valid relationship type');
      });
    });

    describe('Relationship Type Validation', () => {
      test('should accept valid relationship types', () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 72704001 |Fracture|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
        expect(semanticResult.errors).toHaveLength(0);
      });

      test('should reject invalid relationship types', () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 11687002 | Gestational diabetes mellitus | = 72704001 |Fracture|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(false);
        expect(semanticResult.errors[0]).toContain('is not a valid relationship type');
        expect(semanticResult.errors[0]).toContain('Concept model attribute');
      });
    });

    describe('Domain Validation', () => {
      test('should accept appropriate attribute domains', () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 49755003 |Morphologically abnormal structure|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
      });

      test('should reject inappropriate attribute domains', () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 260686004 |Method| = 129433002 |Inspection|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(false);
        expect(semanticResult.errors[0]).toContain('is not typically used with concepts outside of');
        expect(semanticResult.errors[0]).toContain('Procedure');
      });

      test('should accept procedure attributes with procedures', () => {
        const parseResult = eclValidator.parse('<< 71388002 |Procedure|: 260686004 |Method| = 129428001 |Inspection|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
      });
    });

    describe('Range Validation', () => {
      test('should accept valid attribute ranges', () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 49755003 |Morphologically abnormal structure|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
      });

      test('should reject invalid attribute ranges', () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 71388002 |Procedure|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(false);
        expect(semanticResult.errors[0]).toContain('is not a valid concept for attribute');
      });
    });

    describe('Workflow Examples', () => {
      test('syntax error stops at parse', () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding: missing pipe');

        expect(parseResult.success).toBe(false);
        expect(parseResult.ast).toBeNull();
        // No point in semantic validation if parse failed
      });

      test('parse success, semantic validation optional', () => {
        const expression = '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 72704001 |Fracture|';

        // Parse first
        const parseResult = eclValidator.parse(expression);
        expect(parseResult.success).toBe(true);

        // Use the AST for evaluation without semantic validation
        // (this would work in the ECL evaluator)

        // Only validate semantics if needed
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);
        expect(semanticResult.success).toBe(true);
      });

      test('can continue with warnings on semantic issues', () => {
        const expression = '<< 404684003 |Clinical finding|: 260686004 |Method| = 129433002 |Inspection|';

        const parseResult = eclValidator.parse(expression);
        expect(parseResult.success).toBe(true);

        const semanticResult = eclValidator.validateSemantics(parseResult.ast);
        expect(semanticResult.success).toBe(false);

        // Application could choose to:
        // 1. Treat as error and reject
        // 2. Treat as warning and continue
        // 3. Ask user for confirmation

        console.log('Semantic warning:', semanticResult.errors[0]);
        // Still have valid AST to work with: parseResult.ast
      });

      test('validateSemantics can be called multiple times', () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 72704001 |Fracture|');

        // Could validate with different rule sets
        const strictResult = eclValidator.validateSemantics(parseResult.ast);
        expect(strictResult.success).toBe(true);

        // Or validate again after AST modifications
        const revalidateResult = eclValidator.validateSemantics(parseResult.ast);
        expect(revalidateResult.success).toBe(true);
      });
    });

    describe('Edge Cases', () => {
      test('should skip semantic validation for wildcards', () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: * = *');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
      });

      test('should handle complex expressions', () => {
        const parseResult = eclValidator.parse(`
        (<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 72704001 |Fracture|) 
        AND 
        (<< 71388002 |Procedure|: 260686004 |Method| = 129433002 |Inspection|)
      `);
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
      });

      test('should collect multiple semantic errors', () => {
        const parseResult = eclValidator.parse(`
        << 404684003 |Clinical finding|: {
          11687002 | Gestational diabetes mellitus | = 72704001 |Fracture|,
          260686004 |Method| = 129433002 |Inspection|
        }
      `);
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(false);
        expect(semanticResult.errors.length).toBeGreaterThan(1);
      });
    });
  });
});