/**
 * Custom Winston transport for streaming logs over a TCP socket
 * This allows viewing logs remotely via telnet or a custom client
 */
const winston = require('winston');
const net = require('net');
const Transport = winston.Transport;

/**
 * Winston transport that streams logs to connected TCP clients
 * @extends {winston.Transport}
 */
class SocketTransport extends Transport {
  /**
   * Create a new socket transport
   * @param {Object} options - Transport options
   * @param {string} [options.host='127.0.0.1'] - Host to bind to
   * @param {number} [options.port=9300] - Port to listen on
   * @param {string} [options.level='info'] - Minimum log level to stream
   * @param {Function} [options.format] - Custom formatter function (msg, level, meta) => string
   */
  constructor(options = {}) {
    super(options);
    this.name = 'socket';
    this.level = options.level || 'info';
    this.clients = new Set();
    this.format = options.format || this._defaultFormat;
    
    // Create TCP server
    this.server = net.createServer((socket) => {
      console.log(`Client connected to log stream from ${socket.remoteAddress}`);
      
      // Send welcome message
      socket.write(`=== Connected to log stream (${new Date().toISOString()}) ===\n`);
      socket.write(`=== Log level: ${this.level} ===\n\n`);
      
      // Add to clients set
      this.clients.add(socket);
      
      socket.on('close', () => {
        console.log(`Client disconnected from log stream: ${socket.remoteAddress}`);
        this.clients.delete(socket);
      });
      
      socket.on('error', (err) => {
        console.error(`Socket error: ${err.message}`);
        this.clients.delete(socket);
      });
      
      // Support for simple commands
      socket.on('data', (data) => {
        const command = data.toString().trim().toLowerCase();
        
        if (command === 'help') {
          socket.write(this._getHelpText());
        } else if (command === 'stats') {
          socket.write(this._getStatsText());
        } else if (command === 'quit' || command === 'exit') {
          socket.end('=== Disconnected ===\n');
        } else if (command.startsWith('level ')) {
          const newLevel = command.split(' ')[1];
          if (['error', 'warn', 'info', 'debug', 'verbose', 'silly'].includes(newLevel)) {
            this.level = newLevel;
            socket.write(`=== Log level changed to ${newLevel} ===\n`);
          } else {
            socket.write(`=== Invalid log level: ${newLevel} ===\n`);
          }
        }
      });
    });
    
    // Start listening
    const port = options.port || 9300;
    const host = options.host || '127.0.0.1';
    
    this.server.listen(port, host, () => {
      console.log(`Log socket server running on ${host}:${port}`);
    });
    
    this.server.on('error', (err) => {
      console.error(`Socket transport error: ${err.message}`);
    });
  }
  
  /**
   * Winston transport method called for each log
   * @param {Object} info - Log information
   * @param {Function} callback - Callback function
   */
  log(info, callback) {
    setImmediate(() => {
      this.emit('logged', info);
    });
    
    // Skip if no clients connected
    if (this.clients.size === 0) {
      callback();
      return;
    }
    
    // Format the log entry
    const logEntry = this.format(info);
    
    // Send to all connected clients
    const deadClients = [];
    for (const client of this.clients) {
      try {
        client.write(logEntry);
      } catch (err) {
        deadClients.push(client);
      }
    }
    
    // Remove dead connections
    deadClients.forEach(client => this.clients.delete(client));
    
    callback();
  }
  
  /**
   * Default log formatter
   * @param {Object} info - Log information
   * @returns {string} Formatted log entry
   * @private
   */
  _defaultFormat(info) {
    const timestamp = info.timestamp || new Date().toISOString();
    const level = info.level.toUpperCase().padEnd(7);
    const message = info.message || '';
    
    // Extract metadata excluding standard fields
    const meta = { ...info };
    delete meta.timestamp;
    delete meta.level;
    delete meta.message;
    
    const metaStr = Object.keys(meta).length > 0 
      ? ` ${JSON.stringify(meta)}` 
      : '';
    
    return `${timestamp} [${level}] ${message}${metaStr}\n`;
  }
  
  /**
   * Get help text for connected clients
   * @returns {string} Help text
   * @private
   */
  _getHelpText() {
    return `
=== Log Viewer Commands ===
help   - Show this help
stats  - Show connection statistics
level <level> - Change log level (error, warn, info, debug, verbose, silly)
quit/exit - Disconnect

=== Log Format ===
TIMESTAMP [LEVEL] MESSAGE {metadata}

=== Examples ===
level debug    - Show debug and higher priority logs
level error    - Show only error logs

`.trim() + '\n\n';
  }
  
  /**
   * Get statistics text for connected clients
   * @returns {string} Statistics text
   * @private
   */
  _getStatsText() {
    return `
=== Log Statistics ===
Connected clients: ${this.clients.size}
Current log level: ${this.level}
Server started: ${this.server.startTime || 'unknown'}
Current time: ${new Date().toISOString()}

`.trim() + '\n\n';
  }
  
  /**
   * Close the socket server
   * @param {Function} [callback] - Callback function
   */
  close(callback) {
    // Notify all clients
    for (const client of this.clients) {
      try {
        client.end('=== Log server shutting down ===\n');
      } catch (err) {
        // Ignore errors during shutdown
      }
    }
    
    // Close server
    this.server.close(callback);
  }
}

// Register the transport with Winston
winston.transports.Socket = SocketTransport;

module.exports = SocketTransport;
