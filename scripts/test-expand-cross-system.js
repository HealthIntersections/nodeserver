#!/usr/bin/env node
'use strict';

/**
 * Comprehensive expandForValueSet tests: richer include/exclude combinations
 * and cross-system (RxNorm + LOINC) ValueSets.
 *
 * Tests exercise:
 *  - Filter-based excludes that fully cover, partially cover, or don't overlap includes
 *  - Multi-include with multi-exclude using filters on both sides
 *  - Cross-system ValueSets (RxNorm + LOINC includes, excludes across systems)
 *  - Edge cases: exclude superset of include, empty result sets, disjoint exclude
 *
 * Usage: node scripts/test-expand-cross-system.js [--full]
 */

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3000;
const REF_PORT = 3001;
const BASE_URL = `http://localhost:${PORT}/r4`;
const REF_URL = `http://localhost:${REF_PORT}/r4`;
const SERVER_START_TIMEOUT = 300000;
const LIBRARY_CONFIG = process.env.TEST_LIBRARY_CONFIG || 'tx/tx.all-v0.yml';
const BASELINE_CONFIG = process.env.TEST_BASELINE_CONFIG || 'tx/tx.upstream-baseline.yml';
const HAS_BASELINE = LIBRARY_CONFIG !== BASELINE_CONFIG;

const RXSYS = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const LNSYS = 'http://loinc.org';

// --- Test helpers ---
function makeVS(compose) {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'valueSet', resource: { resourceType: 'ValueSet', compose } },
      ...(compose._params || []),
    ],
  };
}

// ============================================================
//  RxNorm-only: richer include/exclude patterns
//  Includes STY-based excludes which stress-test query planning —
//  if these hang, that's a real issue (blocks the event loop).
// ============================================================
const RXNORM_TESTS = [
  {
    name: 'rx-exclude-same-tty',
    desc: 'Include TTY=SBD, exclude TTY=SBD (full cover → 0 results)',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-exclude-disjoint-tty',
    desc: 'Include TTY=SBD, exclude TTY=IN (disjoint → no effect)',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'IN' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-exclude-partial-tty',
    desc: 'Include TTY in SBD,SCD, exclude TTY=SBD (partial → only SCD left)',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: 'in', value: 'SBD,SCD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-sty-exclude-overlapping',
    desc: 'Include TTY=SBD, exclude STY=T200 (cross-property partial overlap)',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-concepts-exclude-tty-filter',
    desc: '10 concepts include, exclude TTY=SBD (removes SBD members)',
    body: makeVS({
      include: [{ system: RXSYS, concept: [
        { code: '197381' }, { code: '197382' }, { code: '197383' },
        { code: '197384' }, { code: '197385' }, { code: '313782' },
        { code: '312961' }, { code: '312962' }, { code: '310798' },
        { code: '308056' },
      ]}],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
    }),
  },
  {
    name: 'rx-filter-exclude-20-concepts',
    desc: 'Include TTY=SCD, exclude 20 specific codes',
    drainCount: 20000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SCD' }] }],
      exclude: [{ system: RXSYS, concept: [
        { code: '197381' }, { code: '197382' }, { code: '197383' },
        { code: '197384' }, { code: '197385' }, { code: '197386' },
        { code: '197387' }, { code: '197388' }, { code: '197389' },
        { code: '197390' }, { code: '197391' }, { code: '197392' },
        { code: '197393' }, { code: '197394' }, { code: '197395' },
        { code: '197396' }, { code: '197397' }, { code: '197398' },
        { code: '197399' }, { code: '197400' },
      ]}],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-multi-include-sty+concepts-exclude',
    desc: 'SBD+SCD includes, exclude STY=T200 + 5 concepts',
    drainCount: 40000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SCD' }] },
      ],
      exclude: [
        { system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] },
        { system: RXSYS, concept: [
          { code: '197381' }, { code: '197382' }, { code: '197383' },
          { code: '197384' }, { code: '197385' },
        ]},
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-3-tty-include-2-tty-exclude',
    desc: 'Include TTY in SBD,SCD,GPCK, exclude TTY in SBD,GPCK',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: 'in', value: 'SBD,SCD,GPCK' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: 'in', value: 'SBD,GPCK' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
];

// ============================================================
//  LOINC-only: richer include/exclude patterns
// ============================================================
const LOINC_TESTS = [
  {
    name: 'ln-exclude-filter-partial',
    desc: 'Include CLASS=LP7786-9, exclude COMPONENT=LP14635-4 (partial)',
    drainCount: 5000,
    body: makeVS({
      include: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
      exclude: [{ system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'LP14635-4' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'ln-exclude-same-filter',
    desc: 'Include CLASS=LP7786-9, exclude CLASS=LP7786-9 (full cover → 0)',
    body: makeVS({
      include: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
      exclude: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'ln-exclude-disjoint',
    desc: 'Include CLASS=LP7786-9, exclude CLASS=LP7819-8 (disjoint)',
    drainCount: 5000,
    body: makeVS({
      include: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
      exclude: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7819-8' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'ln-concepts-exclude-filter',
    desc: '5 LOINC codes include, exclude CLASS=LP7786-9 (removes CHEM)',
    body: makeVS({
      include: [{ system: LNSYS, concept: [
        { code: '2339-0' }, { code: '2345-7' }, { code: '718-7' },
        { code: '4548-4' }, { code: '14749-6' },
      ]}],
      exclude: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
    }),
  },
  {
    name: 'ln-multi-include-multi-exclude',
    desc: 'CHEM + HEM/BC, exclude COMPONENT=Glucose + 3 concepts',
    drainCount: 8000,
    body: makeVS({
      include: [
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7803-2' }] },
      ],
      exclude: [
        { system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'LP14635-4' }] },
        { system: LNSYS, concept: [{ code: '2339-0' }, { code: '2345-7' }, { code: '718-7' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
];

// ============================================================
//  Cross-system: RxNorm + LOINC in same ValueSet
// ============================================================
const CROSS_SYSTEM_TESTS = [
  {
    name: 'cross-rx-ln-include',
    desc: 'Include RxNorm TTY=SBD + LOINC CLASS=CHEM, count=10',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-rx-include-ln-exclude',
    desc: 'Include RxNorm TTY=SBD + LOINC CHEM, exclude LOINC COMPONENT=Glucose',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
      ],
      exclude: [
        { system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'LP14635-4' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-ln-include-rx-exclude',
    desc: 'Include LOINC CHEM + RxNorm SBD, exclude RxNorm STY=T200',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
      ],
      exclude: [
        { system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-concepts-both-systems',
    desc: 'Include 3 RxNorm concepts + 3 LOINC concepts',
    body: makeVS({
      include: [
        { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }, { code: '197383' }] },
        { system: LNSYS, concept: [{ code: '2339-0' }, { code: '2345-7' }, { code: '718-7' }] },
      ],
    }),
  },
  {
    name: 'cross-concepts-exclude-concepts',
    desc: '3 RxNorm + 3 LOINC concepts, exclude 1 from each system',
    body: makeVS({
      include: [
        { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }, { code: '197383' }] },
        { system: LNSYS, concept: [{ code: '2339-0' }, { code: '2345-7' }, { code: '718-7' }] },
      ],
      exclude: [
        { system: RXSYS, concept: [{ code: '197381' }] },
        { system: LNSYS, concept: [{ code: '718-7' }] },
      ],
    }),
  },
  {
    name: 'cross-filter-exclude-cross',
    desc: 'Include RxNorm SBD + LOINC CHEM, exclude both RxNorm T200 + LOINC Glucose',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
      ],
      exclude: [
        { system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] },
        { system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'LP14635-4' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-mixed-concepts-filters',
    desc: 'RxNorm concepts + LOINC filter, exclude LOINC concepts + RxNorm filter',
    body: makeVS({
      include: [
        { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }, { code: '313782' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7803-2' }] },
      ],
      exclude: [
        { system: LNSYS, concept: [{ code: '718-7' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  // Unsupported filter property → forces fallback to baseline path (~1.0x)
  {
    name: 'rx-unsupported-filter-fallback',
    desc: 'Include with unsupported filter property → baseline fallback',
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'BOGUS_PROPERTY', op: '=', value: 'XYZ' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-unsupported-exclude-filter-fallback',
    desc: 'Supported include + unsupported exclude filter → exclude falls back',
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
      ],
      exclude: [
        { system: RXSYS, filter: [{ property: 'BOGUS_PROPERTY', op: '=', value: 'XYZ' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
];

const SCTSYS = 'http://snomed.info/sct';

// ============================================================
//  Snippet library for fuzz-composing ValueSets
//  Each snippet is a partial compose fragment (include or exclude clause).
//  The generator mixes and matches these into Frankenstein ValueSets.
// ============================================================
const SNIPPETS = {
  rxIncludes: [
    { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
    { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SCD' }] },
    { system: RXSYS, filter: [{ property: 'TTY', op: 'in', value: 'SBD,SCD' }] },
    { system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] },
    // RxNorm codes are 2-7 digits; narrow prefixes keep results small
    { system: RXSYS, filter: [{ property: 'code', op: 'regex', value: '10[0-9]{2}' }] },       // 4-digit 10xx (~50 codes)
    { system: RXSYS, filter: [{ property: 'code', op: 'regex', value: '200[0-9]{3}' }] },      // 6-digit 200xxx (~100 codes)
    { system: RXSYS, filter: [
      { property: 'code', op: 'regex', value: '1[0-9]{5}' },
      { property: 'TTY', op: '=', value: 'SBD' },
    ]},
    { system: RXSYS, concept: [{ code: '197381' }, { code: '312961' }, { code: '1000000' }] },
  ],
  rxExcludes: [
    { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
    { system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] },
    { system: RXSYS, filter: [{ property: 'code', op: 'regex', value: '10[0-9]{4}' }] },       // 6-digit 10xxxx
    { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }] },
  ],
  lnIncludes: [
    { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
    { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7819-8' }] },
    // LOINC codes are NNNNN-N; constrain first 2+ digits
    { system: LNSYS, filter: [{ property: 'code', op: 'regex', value: '123[0-9]{2}-[0-9]' }] }, // 123xx-N (~10 codes)
    { system: LNSYS, filter: [{ property: 'code', op: 'regex', value: '45[0-9]{3}-[0-9]' }] },  // 45xxx-N (~100 codes)
    { system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'LP14635-4' }] },
    { system: LNSYS, concept: [{ code: '2160-0' }, { code: '718-7' }, { code: '2345-7' }] },
  ],
  lnExcludes: [
    { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
    { system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'LP14635-4' }] },
    { system: LNSYS, filter: [{ property: 'code', op: 'regex', value: '1[0-9]{3}-[0-9]' }] },   // 1xxx-N
    { system: LNSYS, concept: [{ code: '2160-0' }, { code: '718-7' }] },
  ],
  sctIncludes: [
    { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },  // Diabetes (~200)
    { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '85562004' }] },  // Hand (~30)
    { system: SCTSYS, filter: [{ property: 'concept', op: 'descendent-of', value: '73211009' }] },
    // SNOMED codes are 6-18 digits; use specific 3-digit prefix + length to bound
    { system: SCTSYS, filter: [{ property: 'code', op: 'regex', value: '732[0-9]{5}' }] },     // 8-digit 732xxxxx (~70 codes)
    { system: SCTSYS, filter: [{ property: 'code', op: 'regex', value: '4405[0-9]{4}' }] },    // 8-digit 4405xxxx (~50 codes)
    { system: SCTSYS, concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }] },
  ],
  sctExcludes: [
    { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },  // Type 2 DM
    { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '7569003' }] },   // Finger
    { system: SCTSYS, filter: [{ property: 'code', op: 'regex', value: '732[0-9]{5}' }] },
    { system: SCTSYS, concept: [{ code: '44054006' }] },
  ],
};

function generateFuzzTests(count, seed) {
  // Simple seedable PRNG for reproducibility
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
  const rpickN = (arr, n) => {
    const shuffled = [...arr].sort(() => rand() - 0.5);
    return shuffled.slice(0, Math.min(n, shuffled.length));
  };

  const allIncludes = [...SNIPPETS.rxIncludes, ...SNIPPETS.lnIncludes, ...SNIPPETS.sctIncludes];
  const allExcludes = [...SNIPPETS.rxExcludes, ...SNIPPETS.lnExcludes, ...SNIPPETS.sctExcludes];

  const tests = [];
  for (let i = 0; i < count; i++) {
    // 1-3 includes, 0-2 excludes
    const numInc = 1 + Math.floor(rand() * 3);
    const numExc = Math.floor(rand() * 3);
    const includes = rpickN(allIncludes, numInc);
    const excludes = rpickN(allExcludes, numExc);

    const systems = new Set([...includes, ...excludes].map(s => s.system));
    const sysLabel = [...systems].map(s =>
      s.includes('rxnorm') ? 'rx' : s.includes('loinc') ? 'ln' : 'sct'
    ).sort().join('+');

    const hasRegex = [...includes, ...excludes].some(s =>
      (s.filter || []).some(f => f.op === 'regex')
    );
    const hasConcepts = [...includes, ...excludes].some(s => s.concept);
    const hasHierarchy = [...includes, ...excludes].some(s =>
      (s.filter || []).some(f => f.op === 'is-a' || f.op === 'descendent-of')
    );

    const tags = [sysLabel];
    if (hasRegex) tags.push('regex');
    if (hasConcepts) tags.push('concepts');
    if (hasHierarchy) tags.push('hier');
    if (numExc > 0) tags.push(`exc${numExc}`);

    tests.push({
      name: `fuzz-${i + 1}-${tags.join('-')}`,
      desc: `Fuzz: ${numInc} includes, ${numExc} excludes [${tags.join(', ')}]`,
      skipBaseline: true,
      body: makeVS({
        include: includes,
        ...(excludes.length > 0 ? { exclude: excludes } : {}),
        _params: [{ name: 'count', valueInteger: 10 }],
      }),
    });
  }
  return tests;
}

// Hand-crafted regex + combination tests
const REGEX_TESTS = [
  {
    name: 'rx-code-regex-numeric-range',
    desc: 'RxNorm codes matching 4-digit pattern 10xx',
    drainCount: 500,
    skipBaseline: true,
    body: makeVS({
      include: [{ system: RXSYS, filter: [
        { property: 'code', op: 'regex', value: '10[0-9]{2}' },
      ] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-regex-plus-tty-filter',
    desc: 'RxNorm code regex combined with TTY=SBD property filter',
    drainCount: 500,
    skipBaseline: true,
    body: makeVS({
      include: [{ system: RXSYS, filter: [
        { property: 'code', op: 'regex', value: '1[0-9]{5}' },
        { property: 'TTY', op: '=', value: 'SBD' },
      ] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'ln-code-regex',
    desc: 'LOINC codes matching pattern like 12345-*',
    drainCount: 500,
    skipBaseline: true,
    body: makeVS({
      include: [{ system: LNSYS, filter: [
        { property: 'code', op: 'regex', value: '1234[0-9]-[0-9]' },
      ] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-regex-exclude-concepts',
    desc: 'RxNorm regex include, exclude specific concepts',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: RXSYS, filter: [
        { property: 'code', op: 'regex', value: '1000[0-9]{2}' },
      ] }],
      exclude: [{ system: RXSYS, concept: [{ code: '100008' }, { code: '100009' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-regex-exclude-regex',
    desc: 'RxNorm regex include, regex-based exclude via TTY',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: RXSYS, filter: [
        { property: 'code', op: 'regex', value: '10[0-9]{3}' },
      ] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-rx-regex-ln-class',
    desc: 'Cross-system: RxNorm regex + LOINC CLASS include',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'code', op: 'regex', value: '200[0-9]{3}' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-regex-both-systems',
    desc: 'Cross-system: regex on both RxNorm and LOINC',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'code', op: 'regex', value: '200[0-9]{3}' }] },
        { system: LNSYS, filter: [{ property: 'code', op: 'regex', value: '123[0-9]{2}-[0-9]' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-concepts-plus-regex-exclude',
    desc: 'RxNorm concept list include, regex-pattern exclude',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: RXSYS, concept: [
        { code: '197381' }, { code: '197382' }, { code: '312961' },
        { code: '1000000' }, { code: '1000005' },
      ] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'code', op: 'regex', value: '10000[0-9]+' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'sct-hier-plus-rx-regex',
    desc: 'Cross: SNOMED hierarchy + RxNorm regex, exclude SNOMED subtree',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
        { system: RXSYS, filter: [{ property: 'code', op: 'regex', value: '200[0-9]{3}' }] },
      ],
      exclude: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'ln-regex-exclude-class',
    desc: 'LOINC regex include, CLASS-based exclude',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: LNSYS, filter: [
        { property: 'code', op: 'regex', value: '[0-9]{4}-[0-9]' },
      ] }],
      exclude: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'search-filter-plus-property',
    desc: 'Text search "tylenol" intersected with TTY=SBD',
    skipBaseline: true,
    body: {
      resourceType: 'Parameters',
      parameter: [
        { name: 'valueSet', resource: { resourceType: 'ValueSet', compose: {
          include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
        }}},
        { name: 'filter', valueString: 'tylenol' },
        { name: 'count', valueInteger: 20 },
      ],
    },
  },
  {
    name: 'search-filter-plus-class',
    desc: 'Text search "glucose" intersected with LOINC CLASS=CHEM',
    skipBaseline: true,
    body: {
      resourceType: 'Parameters',
      parameter: [
        { name: 'valueSet', resource: { resourceType: 'ValueSet', compose: {
          include: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
        }}},
        { name: 'filter', valueString: 'glucose' },
        { name: 'count', valueInteger: 10 },
      ],
    },
  },
];

// ============================================================
//  SNOMED: hierarchy-based include/exclude patterns
//  Tests is-a expansions with exclude subtrees — exercises
//  closure table joins and NOT EXISTS pushdown.
// ============================================================
const SNOMED_TESTS = [
  {
    name: 'sct-hand-minus-fingers',
    desc: 'Include is-a Hand (85562004), exclude is-a Finger (7569003) → non-finger hand parts',
    drainCount: 1000,
    body: makeVS({
      include: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '85562004' }] }],
      exclude: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '7569003' }] }],
      _params: [{ name: 'count', valueInteger: 20 }],
    }),
  },
  {
    name: 'sct-diabetes-minus-type2',
    desc: 'Include is-a Diabetes mellitus (73211009), exclude is-a Type 2 (44054006)',
    drainCount: 5000,
    body: makeVS({
      include: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }],
      exclude: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] }],
      _params: [{ name: 'count', valueInteger: 20 }],
    }),
  },
  {
    name: 'sct-procedure-minus-surgical',
    desc: 'Include is-a Procedure (71388002), exclude is-a Surgical procedure (387713003)',
    drainCount: 100000,
    body: makeVS({
      include: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '71388002' }] }],
      exclude: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '387713003' }] }],
      _params: [{ name: 'count', valueInteger: 20 }],
    }),
  },
  {
    name: 'sct-eye-minus-retina',
    desc: 'Include is-a Eye structure (81745001), exclude is-a Retina (5665001)',
    drainCount: 1000,
    body: makeVS({
      include: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '81745001' }] }],
      exclude: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '5665001' }] }],
      _params: [{ name: 'count', valueInteger: 20 }],
    }),
  },
  {
    name: 'sct-exclude-same-subtree',
    desc: 'Include is-a Fracture (125605004), exclude same → 0 results',
    drainCount: 5000,
    body: makeVS({
      include: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '125605004' }] }],
      exclude: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '125605004' }] }],
      _params: [{ name: 'count', valueInteger: 20 }],
    }),
  },
  {
    name: 'sct-concepts-exclude-subtree',
    desc: '5 diabetes concepts, exclude is-a Type 2 (44054006)',
    drainCount: 100,
    body: makeVS({
      include: [{
        system: SCTSYS,
        concept: [
          { code: '73211009' },   // Diabetes mellitus
          { code: '44054006' },   // Type 2 DM
          { code: '46635009' },   // Type 1 DM
          { code: '11530004' },   // Brittle DM
          { code: '237599002' },  // Insulin-treated Type 2 DM
        ],
      }],
      exclude: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] }],
      _params: [{ name: 'count', valueInteger: 20 }],
    }),
  },
];

// ============================================================
//  Real-world IG ValueSets — tests modeled on actual FHIR IGs
//  (IPS, US Core, FHIR R4 Core). These exercise patterns found
//  in production use: massive hierarchies, multi-exclude,
//  multi-property AND filters, cross-system concepts+filters,
//  and union-of-many-roots.
// ============================================================
const REALWORLD_TESTS = [
  // --- Massive SNOMED hierarchies (FHIR R4 Core) ---
  {
    name: 'rw-sct-all-procedures',
    desc: 'FHIR R4 Procedure Codes: is-a 71388002 (Procedure) — ~59K codes',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '71388002' }] }],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },
  {
    name: 'rw-sct-clinical-findings',
    desc: 'FHIR R4 Clinical Findings: is-a 404684003 — ~124K codes, largest hierarchy',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },
  {
    name: 'rw-sct-body-structures',
    desc: 'FHIR R4 Body Structures: is-a 442083009 — ~37K codes',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '442083009' }] }],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- SNOMED medication codes (3-root union, FHIR R4 Core) ---
  {
    name: 'rw-sct-medications-3root',
    desc: 'FHIR R4 Medication Codes: 3 is-a roots (drug, pharma product, immunologic)',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '410942007' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '373873005' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '106181007' }] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- IPS Procedures: include + 8 hierarchy excludes (the gold standard) ---
  {
    name: 'rw-ips-procedures-8exc',
    desc: 'IPS Procedures: all procedures minus 8 admin/bloodbank/community subtrees',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'descendent-of', value: '71388002' }] },
      ],
      exclude: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '14734007' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '59524001' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '389067005' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '442006003' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '225288009' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '308335008' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '710135002' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '389084004' }] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- IPS Medications: medicinal products minus vaccines ---
  {
    name: 'rw-ips-meds-minus-vaccines',
    desc: 'IPS Medications: medicinal products (763158003) minus vaccines (787859002)',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'descendent-of', value: '763158003' }] },
      ],
      exclude: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '787859002' }] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- IPS Allergy Reaction: 19-root union of small hierarchies ---
  {
    name: 'rw-ips-allergy-reaction-19root',
    desc: 'IPS Allergy Reactions: union of 19 SNOMED is-a roots (bronchospasm, seizure, etc)',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '4386001' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '9826008' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '39579001' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '41291007' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '49727002' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '62315008' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '91175000' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '126485001' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '195967001' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '267036007' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '271807003' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '410430005' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '418363000' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '422400008' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '422587007' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '698247007' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '702809001' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '768962006' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '781682005' }] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- IPS Microorganisms: 5 organism taxonomy roots ---
  {
    name: 'rw-ips-microorganisms',
    desc: 'IPS Microorganisms: bacteria, fungi, viruses, cestoda/nematoda, prions',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'descendent-of', value: '409822003' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'descendent-of', value: '414561005' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'descendent-of', value: '49872002' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'descendent-of', value: '441649000' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'descendent-of', value: '84676004' }] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- Condition/Problem/Diagnosis: hierarchy + concept list (FHIR R4) ---
  {
    name: 'rw-condition-code',
    desc: 'FHIR R4 Condition Codes: Clinical finding is-a + "No current problems" concept',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] },
        { system: SCTSYS, concept: [{ code: '160245001' }] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- LOINC Document Type Codes (SCALE_TYP=Doc) ---
  {
    name: 'rw-loinc-doc-types',
    desc: 'FHIR R4 Document Type: LOINC SCALE_TYP=LP32888-7 (Doc) — ~12K document codes',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: LNSYS, filter: [{ property: 'SCALE_TYP', op: '=', value: 'LP32888-7' }] }],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- IPS Lab Results: LOINC CLASSTYPE=1 + STATUS=ACTIVE, minus 4 CLASS excludes ---
  {
    name: 'rw-ips-lab-results',
    desc: 'IPS Lab Results: LOINC CLASSTYPE=1 AND STATUS=ACTIVE, exclude 4 CLASS values',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: LNSYS, filter: [
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
        { property: 'CLASSTYPE', op: '=', value: '1' },
      ] }],
      exclude: [
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP62148-9' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP175679-2' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7785-1' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP94892-4' }] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- IPS Radiology Observations: LOINC STATUS=ACTIVE AND CLASS (Radiology) ---
  {
    name: 'rw-ips-radiology-obs',
    desc: 'IPS Radiology: LOINC STATUS=ACTIVE AND CLASS=LP29684-5 (multi-property AND)',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: LNSYS, filter: [
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
        { property: 'CLASS', op: '=', value: 'LP29684-5' },
      ] }],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- RxNorm clinical drugs + LOINC lab tests: realistic cross-system ---
  {
    name: 'rw-cross-rx-drugs-ln-labs',
    desc: 'Cross-system: RxNorm SBD drugs + LOINC active lab codes (CLASSTYPE=1)',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: LNSYS, filter: [
          { property: 'STATUS', op: '=', value: 'ACTIVE' },
          { property: 'CLASSTYPE', op: '=', value: '1' },
        ] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- Substance codes: 2-root union (FHIR R4 Core) ---
  {
    name: 'rw-sct-substances-2root',
    desc: 'FHIR R4 Substance: Substance (105590001) + Pharma products (373873005)',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '105590001' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '373873005' }] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- IPS cross-system medication example: SNOMED + RxNorm concepts ---
  {
    name: 'rw-ips-meds-sct-rx-concepts',
    desc: 'IPS Medication Example: 7 SNOMED + 3 RxNorm concept codes',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: SCTSYS, concept: [
          { code: '777067000' }, { code: '774587000' }, { code: '776556004' },
          { code: '774409003' }, { code: '780130002' }, { code: '778315007' },
          { code: '779725005' },
        ] },
        { system: RXSYS, concept: [
          { code: '331055' }, { code: '437158' }, { code: '332122' },
        ] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- Surgical procedures minus fracture management (realistic clinical) ---
  {
    name: 'rw-surgical-minus-fracture',
    desc: 'Surgical procedure (387713003) minus fracture repair (125605004)',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '387713003' }] },
      ],
      exclude: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '125605004' }] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- IPS Problems: 3 descendent-of + 1 is-a (massive multi-root) ---
  {
    name: 'rw-ips-problems-4root',
    desc: 'IPS Problems: Clinical finding + Context + Events + No current problems',
    skipBaseline: true,
    body: makeVS({
      include: [
        { system: SCTSYS, filter: [{ property: 'concept', op: 'descendent-of', value: '404684003' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'descendent-of', value: '243796009' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'descendent-of', value: '272379006' }] },
        { system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '160245001' }] },
      ],
      _params: [{ name: 'count', valueInteger: 100 }],
    }),
  },

  // --- Text search + hierarchy: "heart" conditions ---
  {
    name: 'rw-heart-conditions-search',
    desc: 'Search "heart" within Clinical Findings hierarchy (search+filter combo)',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: SCTSYS, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }],
      _params: [
        { name: 'count', valueInteger: 50 },
        { name: 'filter', valueString: 'heart' },
      ],
    }),
  },

  // --- Text search + LOINC property: "glucose" lab tests ---
  {
    name: 'rw-glucose-lab-search',
    desc: 'Search "glucose" within LOINC active lab codes',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: LNSYS, filter: [
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
        { property: 'CLASSTYPE', op: '=', value: '1' },
      ] }],
      _params: [
        { name: 'count', valueInteger: 50 },
        { name: 'filter', valueString: 'glucose' },
      ],
    }),
  },

  // --- Text search + RxNorm TTY: "metformin" branded drugs ---
  {
    name: 'rw-metformin-sbd-search',
    desc: 'Search "metformin" within RxNorm SBD (branded drugs)',
    skipBaseline: true,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [
        { name: 'count', valueInteger: 50 },
        { name: 'filter', valueString: 'metformin' },
      ],
    }),
  },
];

// ============================================================
//  HTTP helpers
// ============================================================
function postJson(url, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpPost(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''),
      method: 'POST', headers: { 'Content-Length': 0 },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

async function waitForServer(url, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await httpGet(url);
      if (res.status === 200) return true;
    } catch (_) { /* not ready */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Server did not start within timeout');
}

function extractCodes(responseBody) {
  try {
    const json = JSON.parse(responseBody);
    if (!json.expansion || !json.expansion.contains) return [];
    return json.expansion.contains.map(c => ({
      code: c.code, display: c.display, system: c.system, inactive: c.inactive || false,
    }));
  } catch (_) { return null; }
}

function codesEqual(a, b) {
  if (a === null || b === null) return { match: false, reason: 'null' };
  if (a.length !== b.length) return { match: false, reason: `count ${a.length} vs ${b.length}` };
  let exact = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].code !== b[i].code || a[i].system !== b[i].system) { exact = false; break; }
  }
  if (exact) return { match: true, reason: 'exact' };
  const key = c => `${c.system}|${c.code}`;
  const setA = new Set(a.map(key));
  const setB = new Set(b.map(key));
  const sameSet = setA.size === setB.size && [...setA].every(c => setB.has(c));
  if (sameSet) return { match: true, reason: 'order differs' };
  return { match: false, reason: 'different codes' };
}

// ============================================================
//  Main runner
// ============================================================
function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

async function main() {
  const full = process.argv.includes('--full');
  const rxOnly = process.argv.includes('--rx');
  const lnOnly = process.argv.includes('--ln');
  const crossOnly = process.argv.includes('--cross');
  const sctOnly = process.argv.includes('--sct');
  const fuzzOnly = process.argv.includes('--fuzz');
  const rwOnly = process.argv.includes('--rw');
  const fuzzCount = parseInt(process.argv.find(a => a.startsWith('--fuzz-count='))?.split('=')[1] || '20');
  const fuzzSeed = parseInt(process.argv.find(a => a.startsWith('--fuzz-seed='))?.split('=')[1] || '42');

  let testList;
  if (rxOnly) testList = RXNORM_TESTS;
  else if (lnOnly) testList = LOINC_TESTS;
  else if (crossOnly) testList = CROSS_SYSTEM_TESTS;
  else if (sctOnly) testList = SNOMED_TESTS;
  else if (fuzzOnly) testList = generateFuzzTests(fuzzCount, fuzzSeed);
  else if (rwOnly) testList = REALWORLD_TESTS;
  else if (full) testList = [...RXNORM_TESTS, ...LOINC_TESTS, ...CROSS_SYSTEM_TESTS, ...REGEX_TESTS, ...SNOMED_TESTS, ...REALWORLD_TESTS, ...generateFuzzTests(fuzzCount, fuzzSeed)];
  else testList = [...RXNORM_TESTS, ...LOINC_TESTS, ...CROSS_SYSTEM_TESTS, ...REGEX_TESTS, ...SNOMED_TESTS];

  const serverDir = path.resolve(__dirname, '..');

  log(`Running ${testList.length} tests`);
  log(`Using library: ${LIBRARY_CONFIG}`);
  if (HAS_BASELINE) log(`Baseline: ${BASELINE_CONFIG} on port ${REF_PORT}`);

  let server, refServer;
  try {
    log(`Starting v0 server on port ${PORT}...`);
    server = spawn('node', ['server.js'], {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test', TX_LIBRARY_SOURCE: LIBRARY_CONFIG, PORT: String(PORT) },
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});

    if (HAS_BASELINE) {
      log(`Starting baseline server on port ${REF_PORT}...`);
      refServer = spawn('node', ['server.js'], {
        cwd: serverDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'test', TX_LIBRARY_SOURCE: BASELINE_CONFIG, PORT: String(REF_PORT) },
      });
      refServer.stdout.on('data', () => {});
      refServer.stderr.on('data', () => {});
    }

    await waitForServer(`http://localhost:${PORT}/r4/metadata`, SERVER_START_TIMEOUT);
    log('v0 server ready.');
    if (HAS_BASELINE) {
      await waitForServer(`http://localhost:${REF_PORT}/r4/metadata`, SERVER_START_TIMEOUT);
      log('Baseline server ready.');
    }
    log('');

    try { await httpPost(`http://localhost:${PORT}/debug/perf-counters/enable`); } catch (_e) { /* ignore */ }

    const results = [];

    for (let ti = 0; ti < testList.length; ti++) {
      const test = testList[ti];
      const body = JSON.parse(JSON.stringify(test.body));
      if (body.parameter[0].resource.compose._params) {
        body.parameter.push(...body.parameter[0].resource.compose._params);
        delete body.parameter[0].resource.compose._params;
      }

      log(`[${ti+1}/${testList.length}] ${test.name}: ${test.desc}`);

      // V0 run
      const t0 = performance.now();
      let optRes;
      try { optRes = await postJson(BASE_URL + '/ValueSet/$expand', body); }
      catch (e) { optRes = { status: 'ERROR', body: e.message }; }
      const optMs = performance.now() - t0;
      const optCodes = typeof optRes.body === 'string' ? extractCodes(optRes.body) : null;

      // BASELINE (upstream native providers)
      let baseMs = 0, baseCodes = null, baseSkipped = false;
      if (HAS_BASELINE && !test.skipBaseline) {
        const t1 = performance.now();
        let baseRes;
        try { baseRes = await postJson(REF_URL + '/ValueSet/$expand', body); }
        catch (e) { baseRes = { status: 'TIMEOUT', body: '' }; }
        baseMs = performance.now() - t1;
        baseCodes = typeof baseRes.body === 'string' ? extractCodes(baseRes.body) : null;
      } else {
        baseSkipped = true;
      }

      // Compare v0 vs baseline (paged)
      let cmpBase = baseSkipped ? { match: null, reason: 'baseline skipped' }
        : codesEqual(optCodes, baseCodes);

      const speedup = baseSkipped ? null : baseMs / optMs;

      // Drain: if paged comparison failed and drainCount is set, re-request full sets and compare sorted
      let drainCmp = null;
      if (cmpBase.match === false && test.drainCount) {
        const drainBody = JSON.parse(JSON.stringify(body));
        // Replace count parameter with drainCount
        const countIdx = drainBody.parameter.findIndex(p => p.name === 'count');
        if (countIdx >= 0) drainBody.parameter[countIdx].valueInteger = test.drainCount;
        else drainBody.parameter.push({ name: 'count', valueInteger: test.drainCount });

        let drainOpt, drainBase;
        try { drainOpt = await postJson(BASE_URL + '/ValueSet/$expand', drainBody, 120000); } catch (_e) { /* ignore */ }
        try { drainBase = await postJson(REF_URL + '/ValueSet/$expand', drainBody, 120000); } catch (_e) { /* ignore */ }
        const drainOptCodes = drainOpt?.body ? extractCodes(drainOpt.body) : null;
        const drainBaseCodes = drainBase?.body ? extractCodes(drainBase.body) : null;
        drainCmp = codesEqual(drainOptCodes, drainBaseCodes);
        if (drainCmp.match) {
          drainCmp.optTotal = drainOptCodes?.length;
          drainCmp.baseTotal = drainBaseCodes?.length;
        }
      }

      const baseIcon = cmpBase.match === true ? '✅' : cmpBase.match === false ? '❌' : '—';
      const drainIcon = drainCmp ? (drainCmp.match ? '✅' : '❌') : '';
      const drainNote = drainCmp ? ` drain(${test.drainCount}): ${drainIcon} ${drainCmp.reason}${drainCmp.optTotal ? ` (${drainCmp.optTotal}/${drainCmp.baseTotal})` : ''}` : '';

      const baseLabel = baseSkipped ? 'N/A' : `${baseMs.toFixed(0)}ms`;
      log(`  v0: ${optMs.toFixed(0)}ms (${optCodes?.length ?? '?'} codes)  Base: ${baseLabel} ${baseIcon} ${cmpBase.reason || ''}${drainNote}`);

      const SLOW_THRESHOLD_MS = parseInt(process.env.SLOW_THRESHOLD_MS || '3000');
      if (optMs > SLOW_THRESHOLD_MS || (baseMs > SLOW_THRESHOLD_MS && !baseSkipped)) {
        const compose = body.parameter[0]?.resource?.compose;
        if (compose) {
          log(`  ⚠️  SLOW (>${SLOW_THRESHOLD_MS}ms) — compose input:`);
          log('  ' + JSON.stringify(compose, null, 2).split('\n').join('\n  '));
        }
      }

      log('');

      results.push({
        name: test.name, optMs: optMs.toFixed(1),
        baseMs: baseSkipped ? 'N/A' : baseMs.toFixed(1),
        speedup: speedup != null ? speedup.toFixed(1) : null,
        matchBase: cmpBase.match, reasonBase: cmpBase.reason,
        drainMatch: drainCmp?.match ?? null, drainReason: drainCmp?.reason ?? null,
        baseSkipped,
        optCount: optCodes?.length ?? '?',
        baseCount: baseCodes?.length ?? '?',
      });
    }

    // Summary table
    const lines = [];
    lines.push('=== v0 vs upstream baseline test results ===');
    lines.push(`Date: ${new Date().toISOString()}`);
    lines.push(`v0 config: ${LIBRARY_CONFIG}`);
    lines.push(`Baseline config: ${BASELINE_CONFIG}`);
    lines.push(`Tests: ${testList.length}`);
    lines.push('');

    lines.push('Test                               | v0 (ms) | Base (ms) | Speedup | Codes | Match      | Drain');
    lines.push('-----------------------------------|---------|-----------|---------|-------|------------|------');
    for (const r of results) {
      const icon = r.baseSkipped ? '—' : r.matchBase === true ? '✅' : '❌';
      const detail = r.baseSkipped ? '' : (r.reasonBase || '');
      const speedCol = r.speedup != null ? `${r.speedup.padStart(6)}x` : '     — ';
      const drainCol = r.drainMatch === true ? '✅ ' + r.drainReason : r.drainMatch === false ? '❌ ' + r.drainReason : '';
      lines.push(`${r.name.padEnd(35)}| ${r.optMs.padStart(7)} | ${(r.baseMs || '').padStart(9)} | ${speedCol} | ${String(r.optCount).padStart(5)} | ${icon} ${detail.padEnd(10)}| ${drainCol}`);
    }

    console.log('\n' + lines.join('\n'));

    const outPath = path.join(serverDir, 'test-cross-system-results.txt');
    fs.writeFileSync(outPath, lines.join('\n') + '\n');
    log(`Results written to ${outPath}`);

  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
    }
    if (refServer) {
      refServer.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
