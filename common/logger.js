const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

class Logger {
  static _instance = null;

  static getInstance(options = {}) {
    if (!Logger._instance) {
      Logger._instance = new Logger(options);
    }
    return Logger._instance;
  }

  constructor(options = {}) {
    this.options = {
      level: options.level || 'info',
      logDir: options.logDir || './logs',
      console: options.console !== undefined ? options.console : true,
      file: {
        filename: options.file?.filename || 'server-%DATE%.log',
        datePattern: options.file?.datePattern || 'YYYY-MM-DD',
        maxSize: options.file?.maxSize || '20m',
        maxFiles: options.file?.maxFiles || 14
      }
    };

    // Ensure log directory exists
    if (!fs.existsSync(this.options.logDir)) {
      fs.mkdirSync(this.options.logDir, { recursive: true });
    }

    // Define formats for file output (with full metadata)
    const fileFormats = [
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json()
    ];

    // Create transports
    const transports = [];

    // Add file transport with rotation (includes all metadata)
    const fileTransport = new winston.transports.DailyRotateFile({
      dirname: this.options.logDir,
      filename: this.options.file.filename,
      datePattern: this.options.file.datePattern,
      maxSize: this.options.file.maxSize,
      maxFiles: this.options.file.maxFiles,
      level: this.options.level,
      format: winston.format.combine(...fileFormats)
    });
    transports.push(fileTransport);

    // Add console transport if enabled (without metadata)
    if (this.options.console) {
      // Console format with timestamps and colors, but NO metadata
      const consoleFormat = winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.colorize({ all: true }),
        winston.format.printf(info => {
          // Only display timestamp, level and message (no metadata)
          return `${info.timestamp} ${info.level.padEnd(7)} ${info.message}`;
        })
      );

      const consoleTransport = new winston.transports.Console({
        level: this.options.level,
        format: consoleFormat
      });

      transports.push(consoleTransport);
    }

    // Create the winston logger
    this.logger = winston.createLogger({
      level: this.options.level,
      transports,
      exitOnError: false
    });

    // Log logger initialization
    this.info('Logger initialized @ '+this.options.logDir, {
      level: this.options.level,
      logDir: this.options.logDir
    });
  }

  error(message, meta = {}) {
    this.logger.error(message, meta);
  }

  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }

  verbose(message, meta = {}) {
    this.logger.verbose(message, meta);
  }

  log(level, message, meta = {}) {
    this.logger.log(level, message, meta);
  }

  child(defaultMeta = {}) {
    // For module-specific loggers, create a better formatted prefix
    if (defaultMeta.module) {
      const modulePrefix = `{${defaultMeta.module}}`;
      const childLogger = {
        error: (message, meta = {}) => this.error(`${modulePrefix}: ${message}`, meta),
        warn: (message, meta = {}) => this.warn(`${modulePrefix}: ${message}`, meta),
        info: (message, meta = {}) => this.info(`${modulePrefix}: ${message}`, meta),
        debug: (message, meta = {}) => this.debug(`${modulePrefix}: ${message}`, meta),
        verbose: (message, meta = {}) => this.verbose(`${modulePrefix}: ${message}`, meta),
        log: (level, message, meta = {}) => this.log(level, `${modulePrefix}: ${message}`, meta)
      };
      return childLogger;
    }

    // For other metadata, use winston's child functionality
    const childLogger = Object.create(this);
    const originalMethods = {
      error: this.error,
      warn: this.warn,
      info: this.info,
      debug: this.debug,
      verbose: this.verbose,
      log: this.log
    };

    // Override each method to include the default metadata
    Object.keys(originalMethods).forEach(method => {
      childLogger[method] = function(message, meta = {}) {
        originalMethods[method].call(this, message, { ...defaultMeta, ...meta });
      };
    });

    return childLogger;
  }

  setLevel(level) {
    this.options.level = level;
    this.logger.transports.forEach(transport => {
      transport.level = level;
    });
    this.info(`Log level changed to ${level}`);
  }

  stream() {
    return {
      write: (message) => {
        this.info(message.trim());
      }
    };
  }
}

module.exports = Logger;