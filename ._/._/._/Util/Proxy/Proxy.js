import http from 'http';
import https from 'https';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createSecureContext } from 'tls';
import {exec} from 'child_process'

/**
 * Represents a rule for handling requests for a specific domain.
 * @typedef {Object} Rule
 * @property {string} domain - The domain name for which this rule applies.
 * @property {string} target - The target URL to which the requests should be forwarded.
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
   * Each rule is an object containing a 'domain' field for the domain name and a 'target' field for the URL to which requests should be forwarded.
   */

  constructor(rules) {
    this.rules = rules;
    this.certificates = this.loadCertificates();
    this.startServers();
  }

  loadCertificates() {
    let certificates = {};
    this.rules.forEach(rule => {
      const domain = rule.domain;
      certificates[domain] = {
        key: readFileSync(`/etc/letsencrypt/live/${domain}/privkey.pem`),
        cert: readFileSync(`/etc/letsencrypt/live/${domain}/fullchain.pem`)
      };
    });
    return certificates;
  }

  startServers() {
    http.createServer((req, res) => {
      res.writeHead(301, { "Location": `https://${req.headers['host']}${req.url}` });
      res.end();
    }).listen(80);
  
    https.createServer({
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
        const target = new URL(rule.target);
        const options = {
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            'X-Forwarded-For': req.connection.remoteAddress || req.socket.remoteAddress,
            'X-Real-IP': req.connection.remoteAddress || req.socket.remoteAddress,
            'X-Forwarded-Proto': req.protocol || (req.connection.encrypted ? 'https' : 'http'),
            'X-Forwarded-Host': req.headers.host,
          },
        };
  
        const proxyReq = http.request(options, proxyRes => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res, { end: true });
        });
  
        req.pipe(proxyReq, { end: true });
      } else {
        res.writeHead(404);
        res.end('No rule defined for this domain');
      }
    }).listen(443);
  }
  
  static async PM2(rules) {

    async function findGlobalProxyPath() {
      try {
        const command = `find / -name Proxy.js 2>/dev/null`;
        const { stdout } = await execAsync(command);
        // Split the output by newline and filter out empty lines
        const paths = stdout.split('\n').filter(path => path.trim() !== '');
        // Return the first path found
        return paths[0] || null;
      } catch (error) {
        console.error(`Error finding global Proxy.js: ${error}`);
        return null;
      }
    }

    const proxyScriptPath = './pm2_proxy.js';
    const localProxyPath = './Proxy.js';
    const globalProxyPath = await findGlobalProxyPath()

    // Dynamically determine the import statement based on the existence of the local Proxy.js file
    // We need to encapsulate the logic in an IIFE to use await
    const fileContent = `
      (async () => {
        let Proxy;
        if (${existsSync(localProxyPath)}) {
          Proxy = (await import('${localProxyPath}')).default;
        } else {
          Proxy = (await import('${globalProxyPath}')).default;
        }
        const rules = ${JSON.stringify(rules)};
        new Proxy(rules);
      })();
    `;

    // Write the dynamically generated script to pm2_proxy.js
    writeFileSync(proxyScriptPath, fileContent);

    // Use exec to manage the PM2 process, first stopping any existing instance
    try {
      const { stdout: pm2ListStdout } = await execAsync(`pm2 list`);
      if (pm2ListStdout.includes('pm2_proxy')) {
        await execAsync(`pm2 delete pm2_proxy`);
      }

      // Start a new PM2 process with the updated pm2_proxy.js
      await execAsync(`pm2 start ${proxyScriptPath}`);
      console.log("PM2 process successfully managed.");
      return true;
    } catch (error) {
      console.error(`PM2 process management error: ${error.message}`);
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