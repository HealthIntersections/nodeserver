//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const express = require('express');
const {parseVCL, parseVCLAndSetId, validateVCLExpression, VCLParseException} = require('./vcl-parser.js');

const Logger = require('../common/logger');
const vclLog = Logger.getInstance().child({ module: 'vcl' });

class VCLModule {
  constructor() {
    this.router = express.Router();
    this.config = null;
    this.setupSecurityMiddleware();
    this.setupRoutes();
  }

  setupSecurityMiddleware() {
    // Security headers middleware
    this.router.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'"
      ].join('; '));
      res.removeHeader('X-Powered-By');
      next();
    });

  }

  // Parameter validation middleware
  validateQueryParams(allowedParams = {}) {
    return (req, res, next) => {
      try {
        const normalized = {};
        
        // Check for parameter pollution (arrays) and validate
        for (const [key, value] of Object.entries(req.query)) {
          if (Array.isArray(value)) {
            return res.status(400).json({ 
              error: 'Parameter pollution detected',
              parameter: key 
            });
          }
          
          if (allowedParams[key]) {
            const config = allowedParams[key];
            
            if (value !== undefined) {
              if (typeof value !== 'string') {
                return res.status(400).json({ 
                  error: `Parameter ${key} must be a string` 
                });
              }
              
              if (value.length > (config.maxLength || 255)) {
                return res.status(400).json({ 
                  error: `Parameter ${key} too long (max ${config.maxLength || 255})` 
                });
              }
              
              if (config.pattern && !config.pattern.test(value)) {
                return res.status(400).json({ 
                  error: `Parameter ${key} has invalid format` 
                });
              }
              
              normalized[key] = value;
            } else if (config.required) {
              return res.status(400).json({ 
                error: `Parameter ${key} is required` 
              });
            } else {
              normalized[key] = config.default || '';
            }
          } else if (value !== undefined) {
            // Unknown parameter
            return res.status(400).json({ 
              error: `Unknown parameter: ${key}` 
            });
          }
        }
        
        // Set default values for missing optional parameters
        for (const [key, config] of Object.entries(allowedParams)) {
          if (normalized[key] === undefined && !config.required) {
            normalized[key] = config.default || '';
          }
        }
        
        req.query = normalized;
        next();
      } catch (error) {
        vclLog.error('Parameter validation error:', error);
        res.status(500).json({ error: 'Parameter validation failed' });
      }
    };
  }

  // Enhanced HTML escaping
  escapeHtml(str) {
    if (!str || typeof str !== 'string') return '';
    
    const escapeMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;',
      '`': '&#x60;',
      '=': '&#x3D;'
    };
    
    return str.replace(/[&<>"'`=\/]/g, (match) => escapeMap[match]);
  }

  // VCL expression validation
  validateVCLInput(vcl) {
    if (!vcl || typeof vcl !== 'string') {
      throw new Error('VCL expression must be a non-empty string');
    }

    // Length validation
    if (vcl.length > 10000) {
      throw new Error('VCL expression too long (max 10000 characters)');
    }

    // Basic character validation - allow VCL-specific characters
    // VCL expressions can contain: letters, numbers, dots, hyphens, underscores, 
    // colons, slashes, pipes, parentheses, square brackets, equals, commas, spaces
    const allowedCharsPattern = /^[a-zA-Z0-9.\-_:\/|()[\]=, \t\r\n]*$/;
    if (!allowedCharsPattern.test(vcl)) {
      throw new Error('VCL expression contains invalid characters');
    }

    // Check for potential injection patterns
    const suspiciousPatterns = [
      /<script/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /expression\s*\(/i,
      /eval\s*\(/i,
      /document\./i,
      /window\./i
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(vcl)) {
        throw new Error('VCL expression contains potentially malicious content');
      }
    }

    return vcl;
  }

  async initialize(config) {
    this.config = config;
  }

  setupRoutes() {
    // Parameter validation config for VCL endpoint
    const vclParams = {
      vcl: { 
        required: true,
        maxLength: 10000
      }
    };

    // VCL parsing endpoint
    this.router.get('/', this.validateQueryParams(vclParams), (req, res) => {
      var {vcl} = req.query;

      // Validation
      if (!vcl) {
        return res.status(400).json({
          error: 'VCL expression is required as query parameter: ?vcl=<expression>'
        });
      }

      if (vcl.startsWith('http://fhir.org/VCL/')) {
        vcl = vcl.substring(20);
      }

      try {
        // Validate the VCL expression first
        if (!validateVCLExpression(vcl)) {
          return res.status(400).json({
            error: 'Invalid VCL expression syntax'
          });
        }

        // Parse the VCL expression and generate ValueSet with ID
        const valueSet = parseVCLAndSetId(vcl);

        // Return the ValueSet as JSON
        res.json(valueSet);

      } catch (error) {
        vclLog.error('VCL parsing error:'+ error);

        if (error instanceof VCLParseException) {
          return res.status(400).json({
            error: 'VCL parsing error',
            message: error.message,
            position: error.position >= 0 ? error.position : undefined
          });
        } else {
          return res.status(500).json({
            error: 'Internal server error while parsing VCL',
            message: error.message
          });
        }
      }
    });
  }

  async shutdown() {
    // VCL module doesn't have any resources to clean up
  }

  getStatus() {
    return {
      enabled: true
    };
  }
}

module.exports = VCLModule;