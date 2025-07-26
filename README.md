# FHIR Development Server

This server provides various support functions to the FHIR community:  package registry, implementation guide statistics, SMART Health Link Support, and ValueSet Compose Language processing.

Note: In production, this server always runs behind an nginx reverse proxy, so there's no support for SSL 

## Features

### 📦 **Package Server**
- **NPM-style FHIR package registry** with search, versioning, and downloads, consistent with the FHIR NPM Specification
- **Automated package crawling** from FHIR package feeds
- **Package mirroring** with local storage and optional cloud bucket integration
- **Dependency analysis** and broken dependency detection

### 📊 **XIG (Implementation Guide Statistics)**
- **Comprehensive FHIR IG analytics** with resource breakdowns by version, authority, and realm
- **Resource search and filtering** across all published implementation guides
- **Dependency tracking** between FHIR resources
- **Automated daily updates** from fhir.org/guides/stats database

### 🔗 **SHL (SMART Health Links)**
- **Create and manage SMART Health Links** with expiration and access control
- **File upload and serving** with embedded content support
- **FHIR validation integration** using the official FHIR validator
- **Digital signing** with COSE Sign1 for VHL (Verifiable Health Links)

### 🔍 **VCL (ValueSet Compose Language)**
- **Parse VCL expressions** into FHIR ValueSet resources
- **Syntax validation** and error reporting
- **REST API** for integration with other tools

## Quick Start

### Prerequisites
- Node.js 16+ 
- NPM or Yarn
- Java 8+ (for FHIR validator)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd fhir-server

# Install dependencies
npm install

# Create required directories
mkdir -p data logs static

# Copy example configuration
cp config.example.json config.json

# Edit configuration as needed
nano config.json
```

### Basic Configuration

Create a `config.json` file (use `config-template.json`):

```json
{
  "server": {
    "port": 3000,
    "cors": {
      "origin": "*",
      "credentials": true
    }
  },
  "modules": {
    "packages": {
      "enabled": true,
      "database": "./data/packages.db",
      "mirrorPath": "./data/packages",
      "masterUrl": "https://fhir.github.io/ig-registry/package-feeds.json",
      "crawler": {
        "enabled": true,
        "schedule": "0 */2 * * *"
      }
    },
    "xig": {
      "enabled": true
    },
    "shl": {
      "enabled": true,
      "database": "./data/shl.db",
      "password": "your-admin-password-here",
      "validator": {
        "enabled": true,
        "version": "6.3.18",
        "port": 8080
      }
    },
    "vcl": {
      "enabled": true
    }
  }
}
```

### Start the Server

```bash
# Development mode
npm run dev

# Production mode
npm start
```

The server will be available at `http://localhost:{port}` using the port specified in the config.

## Development

### Project Structure
```
├── server.js              # Main server and module coordination
├── packages.js             # Package server module
├── package-crawler.js      # Package crawling engine
├── xig.js                  # XIG statistics module  
├── shl.js                  # SHL server module
├── vcl.js                  # VCL parser module
├── html-server.js          # Shared HTML templating
├── config.json             # Server configuration
├── data/                   # Databases and cached data
├── static/                 # Static web assets
└── logs/                   # Application logs
```

### Adding Modules

1. Create module file implementing the standard interface:
```javascript
class MyModule {
  constructor() {
    this.router = express.Router();
  }
  
  async initialize(config) { /* setup */ }
  setupRoutes() { /* define routes */ }
  async shutdown() { /* cleanup */ }
  getStatus() { /* health info */ }
}
```

2. Register in `server.js`:
```javascript
if (config.modules.mymodule.enabled) {
  modules.mymodule = new MyModule();
  await modules.mymodule.initialize(config.modules.mymodule);
  app.use('/mymodule', modules.mymodule.router);
}
```

### Testing

```bash
# Run health check
curl http://localhost:3000/health

# Test package search
curl "http://localhost:3000/packages/catalog?name=core&fhirversion=R4"

# Test VCL parsing
curl "http://localhost:3000/VCL?vcl=http://loinc.org"
```

## Deployment

### Docker (Recommended)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### Environment Variables

```bash
export PORT=3000
export NODE_ENV=production
export FHIR_SERVER_CONFIG=/path/to/config.json
```

### Reverse Proxy (nginx)

```nginx
server {
    listen 80;
    server_name fhir-server.example.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## License

[BSD-3](https://opensource.org/license/bsd-3-clause)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

- **Issues:** [GitHub Issues](repository-url/issues)
- **Documentation:** [Wiki](repository-url/wiki)
- **FHIR Community:** [chat.fhir.org](https://chat.fhir.org)