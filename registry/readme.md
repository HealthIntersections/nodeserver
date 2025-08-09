# Terminology Server Registry

A Node.js module for crawling and querying FHIR terminology servers. This module maintains a registry of terminology servers, periodically crawls them to gather capability information, and provides an API to find the best server for specific code systems or value sets.

## Architecture

The module consists of three main components:

### 1. Data Model (`registry-model.js`)
- **ServerRegistries**: Top-level container for all registry data
- **ServerRegistry**: Individual registry containing multiple servers
- **ServerInformation**: Server metadata and authoritative designations
- **ServerVersionInformation**: Version-specific server capabilities
- **ServerRow**: Flattened representation for API responses
- **ServerRegistryUtilities**: Helper functions for matching and filtering

### 2. Crawler (`registry-crawler.js`)
- Periodically fetches capability statements from configured servers
- Extracts security models, supported code systems, and value sets
- Handles retries and error recovery
- Maintains current state of all servers

### 3. API Processor (`registry-api.js`)
- Provides query endpoints for finding servers
- Ranks servers based on:
  - Authoritative designation
  - Availability (no errors)
  - Recency of successful connection
  - Number of resources available
- Supports filtering by registry, server, version, and resource

## Installation

```bash
npm install
```

## Usage

### Basic Server Setup

```javascript
const express = require('express');
const RegistryCrawler = require('./crawler');
const RegistryAPI = require('./api');

// Configure crawler
const crawler = new RegistryCrawler({
  timeout: 30000,
  crawlInterval: 5 * 60 * 1000, // 5 minutes
  registryConfigs: [
    {
      code: 'main',
      name: 'Main Registry',
      servers: [
        {
          code: 'tx1',
          name: 'TX Server',
          authCSList: ['http://loinc.org*'],
          versions: [
            {
              version: '4.0.1',
              address: 'https://tx.fhir.org/r4'
            }
          ]
        }
      ]
    }
  ]
});

// Create API
const api = new RegistryAPI(crawler);

// Set up Express
const app = express();
api.registerRoutes(app);

// Start crawler and server
crawler.start();
app.listen(3000);
```

### API Endpoints

#### Query Endpoints

**Find servers for a code system:**
```
GET /api/query/codesystem?system=http://loinc.org&version=4.0
```

**Find servers for a value set:**
```
GET /api/query/valueset?valueset=http://hl7.org/fhir/ValueSet/observation-codes
```

**Find the best server:**
```
GET /api/best-server/codesystem?url=http://snomed.info/sct
```

#### Registry Information

**Get statistics:**
```
GET /api/registry/stats
```

**List all registries:**
```
GET /api/registry
```

**Get servers in a registry:**
```
GET /api/registry/main/servers
```

#### Admin Endpoints

**Trigger manual crawl:**
```
POST /api/admin/crawl
```

**Export/Import data:**
```
GET /api/admin/data
POST /api/admin/data
```

## Configuration

### Registry Configuration

```javascript
{
  code: 'main',           // Unique registry identifier
  name: 'Main Registry',  // Display name
  address: 'https://...',  // Registry URL
  authority: 'HL7',       // Managing authority
  servers: [...]          // Array of server configs
}
```

### Server Configuration

```javascript
{
  code: 'tx1',            // Unique server identifier
  name: 'TX Server',      // Display name
  address: 'https://...', // Base server URL
  accessInfo: '...',      // Access information
  authCSList: [           // Authoritative code systems
    'http://loinc.org*',  // Supports wildcards
    'http://snomed.info/sct'
  ],
  authVSList: [...],      // Authoritative value sets
  usageList: ['public'],  // Usage tags
  versions: [...]         // Array of version configs
}
```

### Version Configuration

```javascript
{
  version: '4.0.1',       // FHIR version
  address: 'https://...'  // Version-specific endpoint
}
```

## Authoritative Designations

Servers can be marked as authoritative for specific code systems or value sets. This affects ranking:

- Authoritative servers are always ranked first
- Wildcards are supported (e.g., `http://loinc.org*`)
- Non-authoritative servers are still returned but ranked lower

## Testing

Run the test suite:

```bash
npm test
```

Run with Jest (if installed):

```bash
npm run test:jest
```

## Data Persistence

The crawler can save and load its state:

```javascript
// Save current state
const data = crawler.saveData();
fs.writeFileSync('registry-data.json', JSON.stringify(data));

// Load saved state
const savedData = JSON.parse(fs.readFileSync('registry-data.json'));
crawler.loadData(savedData);
```

## Development

Start development server with auto-reload:

```bash
npm run dev
```

## Migration from Pascal

This module is a JavaScript port of a Pascal implementation. Key differences:

| Pascal | JavaScript |
|--------|------------|
| TStringList | Array |
| TFslList<T> | Array |
| set of TServerSecurity | Set |
| TFslDateTime | Date |
| class methods | static methods |

## Security Models

The crawler detects the following security models:

- `open`: No authentication required
- `password`: Basic authentication
- `token`: Token-based authentication
- `oauth`: OAuth 2.0
- `smart`: SMART on FHIR
- `cert`: Certificate-based authentication

## License

BSD-3-Clause (matching the original Pascal implementation)