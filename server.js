#!/usr/bin/env node

//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const express = require('express');
// const cors = require('cors');
const path = require('path');
const fs = require('fs');
const folders = require('./library/folder-setup');  // <-- ADD: load early

// Load configuration BEFORE logger
let config;
try {
  const configPath = folders.filePath('config.json');  // <-- CHANGE: config now in data dir
  const configData = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configData);
} catch (error) {
  console.error('Failed to load configuration:', error.message);
  process.exit(1);
}

const Logger = require('./library/logger');
const serverLog = Logger.getInstance().child({ module: 'server' });

const activeModules = config.modules ? Object.keys(config.modules)
  .filter(mod => config.modules[mod].enabled)
  .join(', ') : [];
serverLog.info(`Loaded Configuration. Active modules = ${activeModules}`);

// Import modules
const SHLModule = require('./shl/shl.js');
const VCLModule = require('./vcl/vcl.js');
const xigModule = require('./xig/xig.js');
const PackagesModule = require('./packages/packages.js');
const RegistryModule = require('./registry/registry.js');
const PublisherModule = require('./publisher/publisher.js');
const TokenModule = require('./token/token.js');
const NpmProjectorModule = require('./npmprojector/npmprojector.js');
const TXModule = require('./tx/tx.js');
const packageJson = require('./package.json');

const htmlServer = require('./library/html-server');
const ServerStats = require("./stats");
const {Liquid} = require("liquidjs");
const {escapeHtml} = require("./library/utilities");
htmlServer.useLog(serverLog);

const app = express();

const PORT = process.env.PORT || config.server.port || 3000;

// Middleware
app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
app.use(express.raw({ type: 'application/fhir+xml', limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'];
  if (requestId) {
    res.setHeader('X-Request-Id', requestId);
  }
  next();
});

// app.use(cors(config.server.cors));

// Module instances
const modules = {};

let stats = null;

// Initialize modules based on configuration
async function initializeModules() {
  stats = new ServerStats();

  // Initialize SHL module
  if (config.modules?.shl?.enabled) {
    try {
      modules.shl = new SHLModule(stats);
      await modules.shl.initialize(config.modules.shl);
      app.use('/shl', modules.shl.router);
    } catch (error) {
      serverLog.error('Failed to initialize SHL module:', error);
      throw error;
    }
  }

  // Initialize VCL module
  if (config.modules?.vcl?.enabled) {
    try {
      modules.vcl = new VCLModule(stats);
      await modules.vcl.initialize(config.modules.vcl);
      app.use('/VCL', modules.vcl.router);
    } catch (error) {
      serverLog.error('Failed to initialize VCL module:', error);
      throw error;
    }
  }
  
  // Initialize XIG module
  if (config.modules?.xig?.enabled) {
    try {
      await xigModule.initializeXigModule(stats);
      app.use('/xig', xigModule.router);
      modules.xig = xigModule;
    } catch (error) {
      serverLog.error('Failed to initialize XIG module:', error);
      throw error;
    }
  }

  // Initialize Packages module
  if (config.modules?.packages?.enabled) {
    try {
      modules.packages = new PackagesModule(stats);
      await modules.packages.initialize(config.modules.packages);
      app.use('/packages', modules.packages.router);
    } catch (error) {
      console.error('Failed to initialize Server:', error);
      serverLog.error('Failed to initialize Packages module:', error);
      throw error;
    }
  }

  // Initialize Registry module
  if (config.modules?.registry?.enabled) {
    try {
      modules.registry = new RegistryModule(stats);
      await modules.registry.initialize(config.modules.registry);
      app.use('/tx-reg', modules.registry.router);
    } catch (error) {
      serverLog.error('Failed to initialize Registry module:', error);
      throw error;
    }
  }

  // Initialize Publisher module
  if (config.modules?.publisher?.enabled) {
    try {
      modules.publisher = new PublisherModule(stats);
      await modules.publisher.initialize(config.modules.publisher);
      app.use('/publisher', modules.publisher.router);
    } catch (error) {
      serverLog.error('Failed to initialize Publisher module:', error);
      throw error;
    }
  }

  // Initialize Token module
  if (config.modules?.token?.enabled) {
    try {
      modules.token = new TokenModule(stats);
      await modules.token.initialize(config.modules.token);
      app.use('/token', modules.token.router);
    } catch (error) {
      serverLog.error('Failed to initialize Token module:', error);
      throw error;
    }
  }

  // Initialize NpmProjector module
  if (config.modules?.npmprojector?.enabled) {
    try {
      modules.npmprojector = new NpmProjectorModule(stats);
      await modules.npmprojector.initialize(config.modules.npmprojector);
      const basePath = NpmProjectorModule.getBasePath(config.modules.npmprojector);
      app.use(basePath, modules.npmprojector.router);
    } catch (error) {
      serverLog.error('Failed to initialize NpmProjector module:', error);
      throw error;
    }
  }

  // Initialize TX module
  // Note: TX module registers its own endpoints directly on the app
  // because it supports multiple endpoints at different paths
  if (config.modules?.tx?.enabled) {
    try {
      modules.tx = new TXModule(stats);
      await modules.tx.initialize(config.modules.tx, app);
    } catch (error) {
      console.log(error);
      serverLog.error('Failed to initialize TX module:', error);
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

    const publisherTemplatePath = path.join(__dirname, 'publisher', 'publisher-template.html');
    htmlServer.loadTemplate('publisher', publisherTemplatePath);

    // Load Token template
    const tokenTemplatePath = path.join(__dirname, 'token', 'token-template.html');
    htmlServer.loadTemplate('token', tokenTemplatePath);

  } catch (error) {
    serverLog.error('Failed to load templates:', error);
    // Don't fail initialization if templates fail to load
  }
}

async function buildRootPageContent() {
  stats.requestCount++;
  let mc = 0;
  let content = '<div class="row mb-4">';
  content += '<div class="col-12">';

  content += '<h3>Available Modules</h3>';
  content += '<ul class="list-group">';

  // Check which modules are enabled and add them to the list
  if (config.modules.packages.enabled) {
    mc++;
    content += '<li class="list-group-item">';
    content += '<a href="/packages" class="text-decoration-none">Package Server</a>: Browse and download FHIR Implementation Guide packages';
    content += '</li>';
  }

  if (config.modules.xig.enabled) {
    mc++;
    content += '<li class="list-group-item">';
    content += '<a href="/xig" class="text-decoration-none">FHIR IG Statistics</a>: Statistics and analysis of FHIR Implementation Guides';
    content += '</li>';
  }

  if (config.modules.shl.enabled) {
    mc++;
    content += '<li class="list-group-item">';
    content += '<a href="/shl" class="text-decoration-none">SHL Server</a>: SMART Health Links management and validation';
    content += '</li>';
  }

  if (config.modules.vcl.enabled) {
    mc++;
    content += '<li class="list-group-item">';
    content += '<a href="/VCL" class="text-decoration-none">VCL Server</a>: ValueSet Compose Language expression parsing';
    content += '</li>';
  }

  if (config.modules.registry && config.modules.registry.enabled) {
    mc++;
    content += '<li class="list-group-item">';
    content += '<a href="/tx-reg" class="text-decoration-none">Terminology Server Registry</a>: ';
    content += 'Discover and query FHIR terminology servers for code system and value set support';
    content += '</li>';
  }

  if (config.modules.publisher && config.modules.publisher.enabled) {
    mc++;
    content += '<li class="list-group-item">';
    content += '<a href="/publisher" class="text-decoration-none">FHIR Publisher</a>: ';
    content += 'Manage FHIR Implementation Guide publication tasks and approvals';
    content += '</li>';
  }

  if (config.modules.token && config.modules.token.enabled) {
    mc++;
    content += '<li class="list-group-item">';
    content += '<a href="/token" class="text-decoration-none">Token Server</a>: ';
    content += 'OAuth authentication and API key management for FHIR services';
    content += '</li>';
  }

  if (config.modules.npmprojector && config.modules.npmprojector.enabled) {
    mc++;
    content += '<li class="list-group-item">';
    content += '<a href="/npmprojector" class="text-decoration-none">NpmProjector</a>: ';
    content += 'Hot-reloading FHIR server with FHIRPath-based search indexes';
    content += '</li>';
  }

  if (config.modules.tx && config.modules.tx.enabled) {
    content += '<li class="list-group-item">';
    content += '<strong>TX Terminology Server</strong>: ';
    content += 'FHIR terminology services (CodeSystem, ValueSet, ConceptMap)';
    if (config.modules.tx.endpoints && config.modules.tx.endpoints.length > 0) {
      content += '<ul class="mt-2 mb-0">';
      for (const endpoint of config.modules.tx.endpoints) {
        mc++;
        content += `<li><a href="${endpoint.path}" class="text-decoration-none">${endpoint.path}</a> (FHIR v${endpoint.fhirVersion}${endpoint.context ? ', context: ' + endpoint.context : ''})</li>`;
      }
      content += '</ul>';
    }
    content += '</li>';
  }

  content += '</ul>';

  content += '<hr/>';


  // Calculate uptime
  const uptimeMs = Date.now() - stats.startTime;
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  const uptimeDays = Math.floor(uptimeSeconds / 86400);
  const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
  const uptimeSecs = uptimeSeconds % 60;
  let uptimeStr = '';
  if (uptimeDays > 0) uptimeStr += `${uptimeDays}d `;
  if (uptimeHours > 0 || uptimeDays > 0) uptimeStr += `${uptimeHours}h `;
  if (uptimeMinutes > 0 || uptimeHours > 0 || uptimeDays > 0) uptimeStr += `${uptimeMinutes}m `;
  uptimeStr += `${uptimeSecs}s`;

  // Memory usage
  const memUsage = process.memoryUsage();
  const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
  const heapTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(2);
  const rssMB = (memUsage.rss / 1024 / 1024).toFixed(2);

  content += '<table class="grid">';
  content += '<tr>';
  content += `<td><strong>Module Count:</strong> ${mc}</td>`;
  content += `<td><strong>Uptime:</strong> ${escapeHtml(uptimeStr)}</td>`;
  content += `<td><strong>Request Count:</strong> ${stats.requestCount}</td>`;
  content += '</tr>';
  content += '<tr>';
  content += `<td><strong>Heap Used:</strong> ${heapUsedMB} MB</td>`;
  content += `<td><strong>Heap Total:</strong> ${heapTotalMB} MB</td>`;
  content += `<td><strong>Process Memory:</strong> ${rssMB} MB</td>`;
  content += '</tr>';

  content += '</table>';


  // ===== Metrics Graphs =====

  const liquid = new Liquid({
    root: path.join(__dirname, 'tx', 'html'),
    extname: '.liquid'
  });
  content += await liquid.renderFile('home-metrics', {
    historyJson: JSON.stringify(stats.history),
    startTime: stats.startTime
  });

  content += '</div>';
  return content;
}

// eslint-disable-next-line no-unused-vars
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

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

      const content = await buildRootPageContent();
      
      // Build basic stats for root page
      const stats = {
        version: packageJson.version,
        enabledModules: Object.keys(config.modules).filter(m => config.modules[m].enabled).length,
        processingTime: Date.now() - startTime
      };

      const html = htmlServer.renderPage('root', config.hostName || 'FHIRsmith Server', content, stats);
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
        if (moduleName === 'tx') {
          // TX module has multiple endpoints
          enabledModules[moduleName] = {
            enabled: true,
            endpoints: config.modules.tx.endpoints.map(e => ({
              path: e.path,
              fhirVersion: e.fhirVersion,
              context: e.context || null
            }))
          };
        } else {
          enabledModules[moduleName] = {
            enabled: true,
            endpoint: moduleName === 'vcl' ? '/VCL' : `/${moduleName}`
          };
        }
      }
    });

    res.json({
      message: 'FHIR Development Server',
      version: '1.0.0',
      modules: enabledModules,
      endpoints: {
        health: '/health',
        ...Object.fromEntries(
          Object.keys(enabledModules)
            .filter(m => m !== 'tx')
            .map(m => [
              m, 
              m === 'vcl' ? '/VCL' : `/${m}`
            ])
        ),
        // Add TX endpoints separately
        ...(enabledModules.tx ? {
          tx: config.modules.tx.endpoints.map(e => e.path)
        } : {})
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
      stats.markStarted();
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
  stats.finishStats();
  serverLog.info('Server shutdown complete');
  process.exit(0);
});

// Start the server
startServer();