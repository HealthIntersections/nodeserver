# Changelog

All notable changes to the Health Intersections Node Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.1] - 2026-07-30

### Added

- Cooperative yielding for long terminology operations: after every 25ms of continuous compute the
  operation yields the event loop (`checkAndYield`), so a heavy $expand can no longer stall every
  other request on the server. Operations whose client has disconnected are aborted at their next
  yield point instead of computing a response nobody will read
- The operation time limit is now configurable (`operationTimeLimit`, seconds) and defaults to 20s
  (below common client timeouts, so clients see the too-costly OperationOutcome rather than a
  socket timeout), and is measured against compute time consumed rather than wall-clock, so
  concurrent operations time-sharing the event loop don't abort each other
- The Node Blocking chart on the status page now shows the worst single event-loop stall per
  window as well as the mean

### Fixed

- fix whole-code-system SNOMED CT expansions blocking the server for 30 seconds and then failing:
  the hierarchy walk read a non-existent `.code` property, so every concept was treated as a
  duplicate of the first and no expansion size guard could ever stop the walk. This is what caused
  the rash of client timeouts on tx.fhir.org after the 0.11.0 upgrade
- the hierarchy walk now visits each concept once rather than once per path to it (SNOMED CT is a
  poly-hierarchy: the old walk made ~15.8M visits for ~520k concepts)
- restore the up-front too-costly refusal for expansions that cannot fit the expansion limit (the
  totalCount size guard was silently dead - method read as a property); expansions with a
  count/offset window inside the limit still succeed as partial, unclosed expansions
- re-enable the CPT 1000-code expansion cap (same method-read-as-property bug)
- fix parameter misalignment in the no-details expansion path (19 arguments passed to a
  20-parameter function)

### Tx Conformance Statement

FHIRsmith passed all 2729 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.2, runner v6.9.12)

## [0.11.0] - 2026-mm-dd

### Added

- Upgrade the tx registry module to support exclusions and languages
- Add support for sealed caches 

### Changed

- rework caching
- Remember filter analysis on cached value sets 
- Improved Rendering for CodeSystem and ValueSets
- Update ECL & tests given ECL functionality confirmations
- Update snomed subset from test IG
- improved error when multiple cache-id headers passed to the server
- fix slow crawling for FHIRsmith servers by the tx registry
- make tx search page size default to 1000 for json/xml and leave it at 20 for html
- rework batch processing for caches

### Fixed

- Report the FIRST matching coding, not the last, and only one message about status
- rework how expansions on complex codesystems are handled
- better handling of expansions on grammar based systems
- (SNOMED CT) consistent use of designations
- give preferredForLanguage a display in expansions
- fix various ECL processing bugs
- fix precedence order problem loading THO content after core content
- fix links in metadata statements 
- fix unhandled promises 
- fix handling of properties in R4 expansions
- fix bug validating codes from erroneously coded R4 v2 tables
 
### Tx Conformance Statement

FHIRsmith passed all 2729 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.2, runner v6.9.12

## [v0.10.1] - 2026-06-27

### Fixed

- Terminology: the version-less value set lookup now resolves to the latest version when several versions of the same value set are present (e.g. VSAC date versions), instead of an arbitrary one determined by database row order
- Rendering: fixed value set links in `renderLinkComma` (read the resolver's `description`/`link` fields and fall back to the raw URI)

### Tx Conformance Statement

FHIRsmith passed all 2503 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.11)

## [v0.10.0] - 2026-06-27

### Added

- Publisher: track the IG Publisher version used for each task, and show it on the tasks list and task detail pages
- Packages: new `POST /packages/update-package` endpoint to force-refresh specific packages in the registry, bypassing the feed crawler's de-duplication (used to push out a corrected package after a bad publish)
- Publisher: automatically update SUSHI to the latest release before each draft build and publication run, installed into a FHIRsmith-owned prefix so it needs no root privileges

### Changed

- Rebuilt how caching works (see the tools IG for documentation)
- Renamed the compare worker/operation

### Fixed

- Publisher: the publication run now verifies that the package about to be published is a real publication build (not a draft) before committing it to the web tree, so a failed publication build can no longer silently ship a `notForPublication` draft package
- Packages: the crawler now rejects any package flagged `notForPublication` at ingest, instead of only checking the feed entry
- Registry: better handling of versions on manual queries against the external registry
- Fixed handling of the cache-control header
- Corrections to generated test cases

### Security

- SSRF protection: outbound fetches in the packages and registry crawlers now reject any host that resolves to a non-public address (private, loopback, link-local including cloud-metadata, CGNAT, unique-local, etc.). Enforced at connection time, so it also covers redirect targets and DNS rebinding, and prevents leaking registry API keys to a redirected host
- Path-injection hardening: local-file feed reads in the packages crawler are confined to explicitly-allowed directories; the `update-package` endpoint only accepts http(s) URLs
- Dependency updates (npm audit)

### Tx Conformance Statement

FHIRsmith passed all 2503 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.11)

## [v0.9.7] - 2026-06-12

### Added

- Support for tx modele to load resources directly 
- Missing overwork protection processing ECL

### Fixed

- Fix bug validating secondary displays across languages
- Fix CORS issue (double headers)
- Fix czech code in snomed import
- Many minor validation fixes
- ECL processing bugs
- Publishing: better logging, and fix timeout & restart error

### Tx Conformance Statement

FHIRsmith passed all 2503 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.10)

## [v0.9.6] - 2026-05-21

### Added

- increase timeout when publishing IGs (for US Core)

### Fixed

- Replace re2-wasm with re2js in library/regex-utilities.js to eliminate the underlying WASM-heap leak
- Fix async problem loading OMOP
- Fix memory leaks
- Don't leak database connections

### Tx Conformance Statement

FHIRsmith passed all 1649 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.7)

## [v0.9.5] - 2026-05-16

### Fixed

- Workaround for memory leak in re2-wasm library that reduces it's severity
- Replace re2-wasm with re2js in library/regex-utilities.js to eliminate the underlying WASM-heap leak

### Tx Conformance Statement

FHIRsmith passed all 1649 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.7)

## [v0.9.4] - 2026-05-01

### Added

- Draft MCP specification from Ontoserver

### Changed

- Update Danish SNOMED CT Extension to 2026-03-31 version.

### Fixed

- fix problem with version specific code system resolution
- fix hgvs handling of error response
- update NPM dependencies

### Tx Conformance Statement

FHIRsmith passed all 1649 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.7)

## [v0.9.3] - 2026-04-10

### Added

- Add support for handling contained value sets
- Add beta support for ECL

### Changed

- Bump vsac fetch to 1000 and improve history presentation

### Fixed

- Fix count on empty value set

### Tx Conformance Statement

FHIRsmith passed all 1651 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.6)

## [v0.9.2] - 2026-04-14

### Fixed

- Improve VSAC logging
- Fix SCT import to handle SCT DK

### Tx Conformance Statement

FHIRsmith passed all 1578 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.6)

## [v0.9.1] - 2026-04-10

### Added

- TX: Add support for child-of filters

### Changed

- TX: increase vsac timeout

### Fixed

- Tidy up dashboard
- TX: fix bug listing versions when validating
- Fix support for child-of in R4/R3

### Tx Conformance Statement

FHIRsmith passed all 1578 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.5)

## [v0.9.0] - 2026-04-09

### Added

- TX: VSAC upgrade to pick up more changes
- TX: add definition of $related operation to CapabilityStatement

### Changed

- TX: Deal with regex Denial of Service Issue
- TX: improve fragment handling in extensions per TI decision 
- TX: Reduce snomed loaded versions - have already moved to affiliate managed servers
- TX: fix bug handling excluded concepts using a filter
- improve dashboard template
 
### Fixed

- Update dependencies for security fixes
- TX: fix error in SNOMED translate for implicit concept maps
- TX: Fix OCL cache invalidation and case-insensitive concept lookups
- Publisher: fix handling of web templates folder
- Publisher: fix webtemplates table headings

### Tx Conformance Statement

FHIRsmith passed all 1578 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.5)

## [v0.8.6] - 2026-04-06

### Added

- TX: Full support for $related operation
- Add sponsor message to footer on all pages

### Changed

- TX: Improve $expand efficiency slightly
- Rework logging for efficiency and configurability
- TX: Try to make the server more resistant to running out of memory and dying
- Improve memory reporting on dashboard and home pages
- improve metadata display for resources

### Fixed

- Fix up tx test version to be correct in capabilities statement
- Fix security warning

### Tx Conformance Statement

FHIRsmith passed all 1497 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4)

## [v0.8.5] - 2026-04-02

### Added

- Add support for webSource extension
- Add support for SCT filter in (codes)

### Changed

- Upgrade LOINC to 2.82
- Improve resource rendering -copy button + link

### Fixed

- Add missing code systems from search

### Tx Conformance Statement

FHIRsmith passed all 1497 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4)

## [v0.8.4] - 2026-04-01

### Added

- add .npmrc to defend against supply chain attacks

### Changed

- Rework extension handling to make sure uzbek loinc works - load supplements from store

### Fixed

- tx/expand: fix for bug where filter array is present but empty
- tx/SCT: support filters generalizes and child-of
- tx/SCT: fix bug evaluating property filters
- Fix version conversion issues

### Tx Conformance Statement

FHIRsmith passed all 1497 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4)

## [v0.8.3] - 2026-03-31

### Changed

- More dashboard improvements
- Packages: Allow javascript in the pubpack
- Publisher: Show username on publisher page
- Publisher: Allow non-admin users to delete non-approved tasks

### Fixed

- Publisher: fix task logging
- SHL: path fixes

### Tx Conformance Statement

FHIRsmith passed all 1497 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4)

## [v0.8.2] - 2026-03-29

### Added

- Support for implicit snomed concept maps

### Changed

- Reverse the [interpretation of RxNorm [rel] and [rela] value sets](https://chat.fhir.org/#narrow/channel/179202-terminology/topic/Inverted.20query.20for.20RELA.20in.20using.20RxNorm.20page/with/582270767)
- Improve modifier extension message
- 
### Fixed

- fix missing files from npm package
- Add missing styles to dashboard
- $translate fixes: don't return duplicate matches, handle R4/R5 issues properly, fix missed comments and products
- fix handling force-value-set version parameter

### Tx Conformance Statement

FHIRsmith passed all 1498 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4

## [v0.8.0] - 2026-03-27

### Added

- XIG: add JSON and CSV downloads
- TX: Add snomed filter support for inactive, moduleId, and properties

### Changed

- Improve Dashboard Presentation
- Make docker image platform compatible with apple silicon (arm)
- TX: update rxnorm version for tx.fhir.org
- TX: Improve VSAC information page

### Fixed

- XIG: fix valueset source filter
- TX: Fix bug in language processing looking up country codes
- TX: Fix up terminology search for LOINC and generally 
- TX: fix rxnorm property support and search performance
- Publisher: fix status display when building draft IG

### Tx Conformance Statement

FHIRsmith passed all 1498 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4)

## [v0.7.6] - 2026-03-25

### Added

- Dashboard endpoint (see dashboard.html)
- Initial cs-api documentation

### Changed

- Update package crawler to support archived feed entries

### Fixed

- OCL improvements:
   - Improve multilingual support and caching for non-OCL expansions
   - cache compose instead of pre-built expansions
- Fix ConceptMap rendering
- Ongoing on work on publishing module
- Tidy up tx-reg to prevent hanging

### Tx Conformance Statement

FHIRsmith passed all 1464 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.3)

## [v0.7.5] - 2026-03-19

### Changed

- Support ignoring code systems when loading, and ban urn:iso:std:iso:3166#20210120 for tx.fhir.org

### Fixed

- Fix handling of user defined codes for country codes
- Fix version bug when loading supplements
- FHIRsmith passed all 1460 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.9.0)

### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.9.0)

## [v0.7.4] - 2026-03-19

### Changed

- XIG: show using resource package explicitly
- TX: Check conformance statement production at start up

### Fixed
- TX: Load URI provider on tx.fhir.org
- TX: fix error getting SCT version for html format

### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.9.0)

## [v0.7.3] - 2026-03-19

### Changed

- Show total memory on home page
- OCL improvements
- Publisher: Allow editing websites
- Publisher: separate out target folder and git folder
- Publisher: use trusted git repo for ig_registry
- Extend XIG for phinvads analysis

### Fixed
- Don't exempt tx/data from npm project
- SNOMED CT fix: align getLanguageCode with mapLanguageCode byte mapping

### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.9.0)

## [v0.7.2] - 2026-03-16

### Added
- Folders module to support kindling 
- Extension Tracker to support IG Usage Stats

### Changed
- Return valueset-unclosed as valueString instead of valueBoolean

### Fixed
- Imported include excludes were ignored
- expansion.total inconsistent fixed
- $expand filter for SNOMED
- high-severity npm audit vulnerabilities (flatted, liquidjs, minimatch, underscore, fast-xml-parser)
- Showing hostname in all circumstances
- OCL issue: robust hash-based cold cache loading for ValueSet expansions. Ensure cacheKey and fingerprint are used for reliable retrieval and integrity.

### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.8.2)

## [v0.7.1] - 2026-03-14

### Added
- Add web interface for ConceptMap

### Changed
- Change status out parameter on $validate-code from string -> code

### Fixed
- Fix handling of markdown in release process
- OCL cache fixes
-
### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.8.2)

## [v0.7.0] - 2026-03-13

### Added
- Add support for serving for OCL TX content (h/t Italo Macêdo from the OCL team)
- Add default configurations (wip)

### Changed
- Make web-crawlers more robust after tx.fhir.org crash
- Don't accept NPM packages that have .js code or install scripts

### Fixed 
- Fix many bugs in expansion and validation for value sets that include two different versions of the same code system
- Fix CodeSystem search on system parameter to reduce user confusion
- Fix CodeSystem search such that default search is without any specified source
- Fix headers sent multiple times error

### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.8.2)

## [v0.6.0] - 2026-03-06

### Added
- Add support to packages server for scoped packages
- Add support for exclusions and content tracking in tx-registry
- Add support for serving a host

### Changed
- fix error in SCT expression validation
- fix null error in search
- fix search for code systems with uppercase letters in their name
- rework html interface for CodeSystem and ValueSet
- further work on publisehr

### Tx Conformance Statement

FHIRsmith passed all 1382 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.0, runner v6.8.2)

## [v0.5.6] - 2026-02-26

### Changed
- Added content to TerminologyCapabilities.codeSystem
- fix LOINC list filter handling
- Improve Diagnostic Logging
- Add icd-9-cm parser

### Tx Conformance Statement

FHIRsmith 0.5.5 passed all 1382 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.0, runner v6.8.1)

## [v0.5.5] - 2026-02-26

### Changed
- Fix loading problem for multiple versions of the same code system
- Fix url matching in search to be precise

### Tx Conformance Statement

FHIRsmith 0.5.5 passed all 1382 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.0, runner v6.8.1)

## [v0.5.4] - 2026-02-25

This version requires that you delete all package content from the terminology-cache directly
by hand before running this version.

### Changed
- Improved Problem page
- Ignore system version in VSAC value sets
- Improve value set search
- better handling of code systems without a content property

### Tx Conformance Statement

FHIRsmith 0.5.4 passed all 1382 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.0, runner v6.8.1)

## [v0.5.3] - 2026-02-24

### Added
- Page listing logical problems in terminology definitions

### Changed
- Fixed many bugs identified by usage

### Tx Conformance Statement

FHIRsmith 0.5.1 passed all 1382 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.0, runner v6.8.1)

## [v0.5.1] - 2026-02-20

### Added
- Improved logging of startup conditions and failure

### Changed
- Fixed bad cron scheduled processing in XIG module

### Tx Conformance Statement

FHIRsmith 0.5.1 passed all 1288 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.1-SNAPSHOT, runner v6.8.0)

## [v0.5.2] - 2026-02-20

### Changed
- Fixed bad count reference in XIG

### Tx Conformance Statement

FHIRsmith 0.5.2 passed all 1288 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.1-SNAPSHOT, runner v6.8.0)

## [v0.5.0] - 2026-02-19

### Added
- Prototype Implementation of $related operation

### Changed
- A great deal of QA work preparing the server to run tx.fhir.org, which led to 100s of fixes

### Tx Conformance Statement

FHIRsmith passed all 1288 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.1-SNAPSHOT, runner v6.8.0)

## [v0.4.2] - 2026-02-05
### Changed
- Even More testing the release process; some tidy up to testing data

## [v0.4.1] - 2026-02-05
### Changed
- More testing the release process; some tidy up to testing data

## [v0.4.0] - 2026-02-05
### Changed
- Just testing the release process; some tidy up to testing data

## [v0.3.0] - 2026-02-05
### Added
- Add first draft of publishing engine

### Changed
- Move all runtime files to a data directory, where an environment variable says. Existing configurations MUST change
- Finish porting the terminology server
- Lots of QA related changes, and consistency.

## [v0.2.0] - 2026-01-13
### Added
- port tx.fhir.org to FHIRsmith, and pass all the tests

### Changed
- rework logging, testing, etc infrastructure

## [v0.1.1] - 2025-08-21
### Added
- set up ci and release workflows with Docker
- Add tx-reg implementation

### Changed

- rework logging from scratch 

## [v0.1.0] - 2025-08-20

First Documented Release 

### Added
- SHL Module: Support services for SHL and VHL implementations
- VCL Module: Support services for ValueSet Compose Language 
- XIG Module: The Cross-IG Resource server 
- Packages Modules: The server for packages2.fhir.org/packages 
- Testing Infrastructure
