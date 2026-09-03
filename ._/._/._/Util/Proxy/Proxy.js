import http from 'http';
import https from 'https';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createSecureContext } from 'tls';
import { exec } from 'child_process';
import net from 'net';
import SyPM from '../../../../SyPM.js'; // Adjust path as needed

/**
 * Represents a rule for handling requests for a specific domain.
 * @typedef {Object} Rule
 * @property {string} domain - The domain name for which this rule applies.
 * @property {string} target - The target URL to which the requests should be forwarded.
 * @property {boolean} [useHttps] - Whether to use HTTPS for this domain (default: true)
 */

/**
 * Proxy class for redirecting HTTP traffic to HTTPS and for forwarding requests based on domain rules.
 * 
 * @class
 */
class Proxy {

  /**
   * Creates an instance of Proxy.
   * @param {Rule[]} rules An array of rules for handling requests.
   * @param {Object} [options] Additional options for the proxy
   * @param {boolean} [options.allowHttp] Allow HTTP requests without redirecting to HTTPS
   * @param {boolean} [options.checkPorts] Check and open ports if needed
   * @param {boolean} [options.configureFirewall] Configure firewall rules
   * @param {number} [options.httpPort] HTTP port (default: 80)
   * @param {number} [options.httpsPort] HTTPS port (default: 443)
   */
  constructor(rules, options = {}) {
    this.rules = rules;
    this.options = {
      allowHttp: false,
      checkPorts: false, // Changed to false by default to avoid conflicts
      configureFirewall: false, // Changed to false by default
      httpPort: 80,
      httpsPort: 443,
      ...options
    };
    this.certificates = this.loadCertificates();
    
    // Initialize async setup
    this.initialize();
  }

  /**
   * Initialize the proxy asynchronously
   */
  async initialize() {
    try {
      if (this.options.checkPorts) {
        await this.checkAndOpenPorts();
      }
      
      if (this.options.configureFirewall) {
        await this.configureFirewallRules();
      }
      
      // Start servers after port checks
      this.startServers();
    } catch (error) {
      console.error('Failed to initialize proxy:', error.message);
      // Still try to start servers in case ports are actually available
      this.startServers();
    }
  }

  loadCertificates() {
    let certificates = {};
    this.rules.forEach(rule => {
      if (rule.useHttps !== false) { // Only load certs for HTTPS domains
        const domain = rule.domain;
        try {
          certificates[domain] = {
            key: readFileSync(`/etc/letsencrypt/live/${domain}/privkey.pem`),
            cert: readFileSync(`/etc/letsencrypt/live/${domain}/fullchain.pem`)
          };
        } catch (error) {
          console.warn(`Could not load certificate for ${domain}: ${error.message}`);
        }
      }
    });
    return certificates;
  }

  /**
   * Check if a port is available
   */
  checkPort(port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use`));
        } else {
          reject(err);
        }
      });
      
      server.once('listening', () => {
        server.close();
        resolve();
      });
      
      server.listen(port, '0.0.0.0');
    });
  }

  /**
   * Check and open ports if needed
   */
  async checkAndOpenPorts() {
    const ports = [this.options.httpPort, this.options.httpsPort];
    
    for (const port of ports) {
      try {
        await this.checkPort(port);
        console.log(`Port ${port} is available`);
      } catch (error) {
        console.log(`Port ${port} is in use, attempting to free it...`);
        await this.freePort(port);
      }
    }
  }

  /**
   * Free a port by killing the process using it
   */
  async freePort(port) {
    try {
      // Try to find and kill the process using the port
      const command = `lsof -ti:${port} | xargs kill -9 2>/dev/null || fuser -k ${port}/tcp 2>/dev/null || true`;
      await this.execCommand(command);
      console.log(`Attempted to free port ${port}`);
      
      // Wait a moment for the port to be released
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Check if port is now available
      try {
        await this.checkPort(port);
        console.log(`Port ${port} is now available`);
      } catch (error) {
        console.warn(`Could not free port ${port}: ${error.message}`);
      }
    } catch (error) {
      console.warn(`Error freeing port ${port}: ${error.message}`);
    }
  }

  /**
   * Configure firewall rules for the proxy
   */
  async configureFirewallRules() {
    const commands = [
      `ufw allow ${this.options.httpPort}/tcp 2>/dev/null || true`,
      `ufw allow ${this.options.httpsPort}/tcp 2>/dev/null || true`,
      `iptables -A INPUT -p tcp --dport ${this.options.httpPort} -j ACCEPT 2>/dev/null || true`,
      `iptables -A INPUT -p tcp --dport ${this.options.httpsPort} -j ACCEPT 2>/dev/null || true`
    ];
    
    for (const command of commands) {
      try {
        await this.execCommand(command);
      } catch (error) {
        // Silently continue - some commands may not be available
      }
    }
  }

  /**
   * Execute a system command
   */
  execCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  /**
   * Start the proxy servers
   */
  startServers() {
    // HTTP Server - either redirects to HTTPS or handles HTTP requests directly
    const httpServer = http.createServer((req, res) => {
      const rule = this.rules.find(r => r.domain === req.headers.host);
      
      if (rule && rule.useHttps === false) {
        // Handle HTTP request directly
        this.handleProxyRequest(req, res, rule, false);
      } else {
        // Redirect to HTTPS
        res.writeHead(301, { "Location": `https://${req.headers['host']}${req.url}` });
        res.end();
      }
    });

    // HTTPS Server - handles HTTPS requests
    const httpsServer = https.createServer({
      SNICallback: (domain, cb) => {
        if (this.certificates[domain]) {
          cb(null, createSecureContext(this.certificates[domain]));
        } else {
          cb(new Error(`No matching certificate found for domain: ${domain}`));
        }
      }
    }, (req, res) => {
      const rule = this.rules.find(r => r.domain === req.headers.host);
      if (rule) {
        this.handleProxyRequest(req, res, rule, true);
      } else {
        res.writeHead(404);
        res.end('No rule defined for this domain');
      }
    });

    // Start HTTP server with error handling
    httpServer.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`HTTP Server error: Port ${this.options.httpPort} is already in use. The server might already be running.`);
      } else {
        console.error('HTTP Server error:', error);
      }
    });

    httpServer.listen(this.options.httpPort, '0.0.0.0', () => {
      console.log(`HTTP proxy server started on port ${this.options.httpPort}`);
    });

    // Start HTTPS server with error handling
    httpsServer.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`HTTPS Server error: Port ${this.options.httpsPort} is already in use. The server might already be running.`);
      } else {
        console.error('HTTPS Server error:', error);
      }
    });

    httpsServer.listen(this.options.httpsPort, '0.0.0.0', () => {
      console.log(`HTTPS proxy server started on port ${this.options.httpsPort}`);
    });
  }

  /**
   * Handle proxy request forwarding
   */
  handleProxyRequest(req, res, rule, isHttps) {
    const target = new URL(rule.target);
    const options = {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        'X-Forwarded-For': req.connection.remoteAddress || req.socket.remoteAddress,
        'X-Real-IP': req.connection.remoteAddress || req.socket.remoteAddress,
        'X-Forwarded-Proto': isHttps ? 'https' : 'http',
        'X-Forwarded-Host': req.headers.host,
      },
    };

    // Choose appropriate module based on target protocol
    const proxyModule = target.protocol === 'https:' ? https : http;
    
    const proxyReq = proxyModule.request(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (error) => {
      console.error('Proxy request error:', error);
      res.writeHead(502);
      res.end('Bad Gateway');
    });

    req.pipe(proxyReq, { end: true });
  }

  /**
   * Start the proxy using SyPM as a background process.
   * @param {Rule[]} rules - Array of proxy rules.
   * @param {Object} [options] - Additional options
   * @returns {Promise<boolean>} True if the proxy was started successfully.
   */
  static async SyPM(rules, options = {}) {
    const PROCESS_NAME = 'sypm_proxy_server'; // Name used in SyPM registry

    // Kill any existing proxy managed by SyPM
    try {
      const processes = SyPM.list();
      const existing = processes.find(p => p.name === PROCESS_NAME);
      if (existing) {
        console.log(`Stopping existing proxy (ID: ${existing.id})...`);
        SyPM.kill(existing.id);
        // Wait for the process to be fully killed
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) {
      console.warn('Could not check/kill existing proxy:', error.message);
      // Continue anyway
    }

    async function findGlobalProxyPath() {
      try {
        const command = `find / -name Proxy.js 2>/dev/null`;
        const { stdout } = await execAsync(command);
        const paths = stdout.split('\n').filter(path => path.trim() !== '');
        return paths[0] || null;
      } catch (error) {
        console.error(`Error finding global Proxy.js: ${error}`);
        return null;
      }
    }

    const proxyScriptPath = './sypm_proxy.js';
    const localProxyPath = './Proxy.js';
    const globalProxyPath = await findGlobalProxyPath();

    // Dynamically determine the import statement based on the existence of the local Proxy.js file
    const fileContent = `
      (async () => {
        let Proxy;
        if (${existsSync(localProxyPath)}) {
          Proxy = (await import('${localProxyPath}')).default;
        } else {
          Proxy = (await import('${globalProxyPath}')).default;
        }
        const rules = ${JSON.stringify(rules)};
        const options = ${JSON.stringify(options)};
        new Proxy(rules, options);
      })();
    `;

    // Write the dynamically generated script
    writeFileSync(proxyScriptPath, fileContent);

    try {
      // Start the proxy using SyPM
      const result = SyPM.run(proxyScriptPath, {
        name: PROCESS_NAME
      });
      console.log(`Proxy started with SyPM (PID: ${result.pid}, ID: ${result.id})`);
      return true;
    } catch (error) {
      console.error(`SyPM process management error: ${error.message}`);
      return false;
    }
  }

}

// Helper function to promisify exec
function execAsync(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export default Proxy;