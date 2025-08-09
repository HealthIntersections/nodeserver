//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const Logger = require('./common/logger');
const serverLog = Logger.getInstance().child({ module: 'server' });

// Import modules
const SHLModule = require('./shl/shl.js');
const VCLModule = require('./vcl/vcl.js');
const xigModule = require('./xig/xig.js');
const PackagesModule = require('./packages/packages.js');
const RegistryModule = require('./registry/registry.js');

const htmlServer = require('./common/html-server');
htmlServer.useLog(serverLog);

const app = express();

// Load configuration
let config;
try {
  const configPath = path.join(__dirname, 'config.json');
  const configData = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configData);
  
  const activeModules = Object.keys(config.modules)
    .filter(mod => config.modules[mod].enabled)
    .join(', ');

  serverLog.info(`Loaded Configuration. Active modules = ${activeModules}`);
} catch (error) {
  serverLog.error('Failed to load configuration:'+error.message);
  process.exit(1);
}

const PORT = process.env.PORT || config.server.port || 3000;

// Middleware
app.use(express.json());
app.use(express.raw({ type: 'application/fhir+json', limit: '10mb' }));
app.use(express.raw({ type: 'application/fhir+xml', limit: '10mb' }));
app.use(cors(config.server.cors));

// Module instances
const modules = {};

// Initialize modules based on configuration
async function initializeModules() {

  // Initialize SHL module
  if (config.modules.shl.enabled) {
    try {
      modules.shl = new SHLModule();
      await modules.shl.initialize(config.modules.shl);
      app.use('/shl', modules.shl.router);
    } catch (error) {
      serverLog.error('Failed to initialize SHL module:', error);
      throw error;
    }
  }

  // Initialize VCL module
  if (config.modules.vcl.enabled) {
    try {
      modules.vcl = new VCLModule();
      await modules.vcl.initialize(config.modules.vcl);
      app.use('/VCL', modules.vcl.router);
    } catch (error) {
      serverLog.error('Failed to initialize VCL module:', error);
      throw error;
    }
  }
  
  // Initialize XIG module
  if (config.modules.xig.enabled) {
    try {
      await xigModule.initializeXigModule();
      app.use('/xig', xigModule.router);
      modules.xig = xigModule;
    } catch (error) {
      serverLog.error('Failed to initialize XIG module:', error);
      throw error;
    }
  }

  // Initialize Packages module
  if (config.modules.packages.enabled) {
    try {
      modules.packages = new PackagesModule();
      await modules.packages.initialize(config.modules.packages);
      app.use('/packages', modules.packages.router);
    } catch (error) {
      serverLog.error('Failed to initialize Packages module:', error);
      throw error;
    }
  }

  // Initialize Registry module
  if (config.modules.registry && config.modules.registry.enabled) {
    try {
      modules.registry = new RegistryModule();
      await modules.registry.initialize(config.modules.registry);
      app.use('/tx-reg', modules.registry.router);
    } catch (error) {
      serverLog.error('Failed to initialize Registry module:', error);
      throw error;
    }
  }
}

async function loadTemplates() {
  htmlServer.useLog(serverLog);

  try {
    // Load Root template
    const rootTemplatePath = path.join(__dirname, 'root-template.html');
    htmlServer.loadTemplate('root', rootTemplatePath);

    // Load XIG template
    const xigTemplatePath = path.join(__dirname, 'xig', 'xig-template.html');
    htmlServer.loadTemplate('xig', xigTemplatePath);

    // Load Packages template
    const packagesTemplatePath = path.join(__dirname, 'packages', 'packages-template.html');
    htmlServer.loadTemplate('packages', packagesTemplatePath);

    const registryTemplatePath = path.join(__dirname, 'registry', 'registry-template.html');
    htmlServer.loadTemplate('registry', registryTemplatePath);

  } catch (error) {
    serverLog.error('Failed to load templates:', error);
    // Don't fail initialization if templates fail to load
  }
}

function buildRootPageContent() {
  let content = '<div class="row mb-4">';
  content += '<div class="col-12">';

  content += '<h3>Available Modules</h3>';
  content += '<ul class="list-group">';

  // Check which modules are enabled and add them to the list
  if (config.modules.packages.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/packages" class="text-decoration-none">Package Server</a>: Browse and download FHIR Implementation Guide packages';
    content += '</li>';
  }

  if (config.modules.xig.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/xig" class="text-decoration-none">FHIR IG Statistics</a>: Statistics and analysis of FHIR Implementation Guides';
    content += '</li>';
  }

  if (config.modules.shl.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/shl" class="text-decoration-none">SHL Server</a>: SMART Health Links management and validation';
    content += '</li>';
  }

  if (config.modules.vcl.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/VCL" class="text-decoration-none">VCL Server</a>: ValueSet Compose Language expression parsing';
    content += '</li>';
  }

  if (config.modules.registry && config.modules.registry.enabled) {
    content += '<li class="list-group-item">';
    content += '<a href="/tx-reg" class="text-decoration-none">Terminology Server Registry</a>: ';
    content += 'Discover and query FHIR terminology servers for code system and value set support';
    content += '</li>';
  }

  content += '</ul>';
  content += '</div>';

  return content;
}

app.get('/', async (req, res) => {
  // Check if client wants HTML response
  const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');

  if (acceptsHtml) {
    try {
      const startTime = Date.now();

      // Load template if not already loaded
      if (!htmlServer.hasTemplate('root')) {
        const templatePath = path.join(__dirname, 'root-template.html');
        htmlServer.loadTemplate('root', templatePath);
      }

      const content = buildRootPageContent();
      
      // Build basic stats for root page
      const stats = {
        version: '1.0.0',
        enabledModules: Object.keys(config.modules).filter(m => config.modules[m].enabled).length,
        processingTime: Date.now() - startTime
      };

      const html = htmlServer.renderPage('root', 'FHIR Development Server', content, stats);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      serverLog.error('Error rendering root page:', error);
      htmlServer.sendErrorResponse(res, 'root', error);
    }
  } else {
    // Return JSON response for API clients
    const enabledModules = {};
    Object.keys(config.modules).forEach(moduleName => {
      if (config.modules[moduleName].enabled) {
        enabledModules[moduleName] = {
          enabled: true,
          endpoint: moduleName === 'vcl' ? '/VCL' : `/${moduleName}`
        };
      }
    });

    res.json({
      message: 'FHIR Development Server',
      version: '1.0.0',
      modules: enabledModules,
      endpoints: {
        health: '/health',
        ...Object.fromEntries(
          Object.keys(enabledModules).map(m => [
            m, 
            m === 'vcl' ? '/VCL' : `/${m}`
          ])
        )
      }
    });
  }
});


// Serve static files
app.use(express.static(path.join(__dirname, 'static')));

// Health check endpoint
app.get('/health', async (req, res) => {
  const healthStatus = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    modules: {}
  };

  // Get status from each enabled module
  Object.keys(modules).forEach(moduleName => {
    if (modules[moduleName] && typeof modules[moduleName].getStatus === 'function') {
      healthStatus.modules[moduleName] = modules[moduleName].getStatus();
    } else if (moduleName === 'xig') {
      // XIG has different status check
      let xigStatus = 'Enabled';
      if (modules.xig && modules.xig.isCacheLoaded && modules.xig.isCacheLoaded()) {
        xigStatus = 'Running';
      } else {
        xigStatus = 'Enabled but not loaded';
      }
      healthStatus.modules.xig = { enabled: true, status: xigStatus };
    }
  });

  res.json(healthStatus);
});

// Initialize everything
async function startServer() {
  try {
    // Load HTML templates
    await loadTemplates();

    // Initialize modules
    await initializeModules().catch(error => {
      serverLog.error('Failed to initialize modules:', error);
      throw error;
    });

    // Start server
    app.listen(PORT, () => {
      serverLog.info(`=== Server running on http://localhost:${PORT} ===`);
    });
    if (modules.packages && config.modules.packages.enabled) {
      modules.packages.startInitialCrawler();
    }
  } catch (error) {
    serverLog.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  serverLog.info('\nShutting down server...');

  // Shutdown all modules
  for (const [moduleName, moduleInstance] of Object.entries(modules)) {
    try {
      if (moduleInstance && typeof moduleInstance.shutdown === 'function') {
        serverLog.info(`Shutting down ${moduleName} module...`);
        await moduleInstance.shutdown();
        serverLog.info(`${moduleName} module shut down`);
      }
    } catch (error) {
      serverLog.error(`Error shutting down ${moduleName} module:`, error);
    }
  }

  serverLog.info('Server shutdown complete');
  process.exit(0);
});

// Start the server
startServer();