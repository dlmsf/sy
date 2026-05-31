// ssh-lab.mjs - ULTRA RELIABLE VERSION
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile, chmod, access, readFile, unlink, rename } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { networkInterfaces } from 'os';
import * as net from 'net';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);

// Background scan state management
const SCAN_STATE_FILE = join(homedir(), '.ssh-lab-scan-state.json');
const SCAN_PID_FILE = join(homedir(), '.ssh-lab-scan.pid');

export default class SSH {
  /**
   * Execute command and return full output even on error
   */
  static async _exec(cmd, options = {}) {
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 15000,
        ...options
      });
      return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      return {
        success: false,
        stdout: error.stdout?.trim() || '',
        stderr: error.stderr?.trim() || error.message,
        error: error.message
      };
    }
  }

  /**
   * Install sshpass if not present
   */
  static async _ensureSshpass() {
    const { success } = await this._exec('which sshpass');
    if (success) return true;

    for (let i = 0; i < 3; i++) {
      const result = await this._exec('apt-get update -qq 2>/dev/null && apt-get install -y -qq sshpass 2>/dev/null', { timeout: 60000 });
      if (result.success || result.stderr === '') {
        const checkResult = await this._exec('which sshpass');
        if (checkResult.success) return true;
      }
      if (i < 2) await new Promise(r => setTimeout(r, 2000));
    }

    const apkResult = await this._exec('apk add --no-cache sshpass 2>/dev/null', { timeout: 30000 });
    if (apkResult.success) return true;

    return false;
  }

  /**
   * Setup SSH directory and config
   */
  static async setup() {
    try {
      const sshDir = join(homedir(), '.ssh');
      const configPath = join(sshDir, 'config');
      const keyPath = join(sshDir, 'id_rsa');

      await mkdir(sshDir, { recursive: true, mode: 0o700 });

      const configContent = 'Host *\n    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n    LogLevel ERROR\n    ConnectTimeout 5\n    ConnectionAttempts 1\n';
      await writeFile(configPath, configContent, { mode: 0o600 });

      try {
        await access(keyPath);
        return { success: true, message: 'SSH already configured, key exists' };
      } catch {
        await this._exec(`ssh-keygen -t rsa -b 2048 -N "" -f ${keyPath} -q`);
        return { success: true, message: 'SSH configured and key generated' };
      }
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Copy SSH key using sshpass
   */
  static async _copyKeySshpass(host, password, user) {
    const cmd = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh-copy-id -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host}`;
    const result = await this._exec(cmd);
   
    if (result.success) {
      return { success: true, method: 'sshpass', message: 'Key copied via sshpass' };
    }
   
    if (result.stderr.includes('already exist')) {
      return { success: true, method: 'sshpass', message: 'Key already exists on target' };
    }
   
    return { success: false, method: 'sshpass', error: result.stderr };
  }

  /**
   * Copy SSH key using pure bash
   */
  static async _copyKeyBash(host, password, user) {
    const tmpScript = `/tmp/ssh_copy_${Date.now()}.sh`;
    const escapedPassword = password.replace(/'/g, "'\\''");
   
    const scriptContent = `#!/bin/bash
export SSHPASS='${escapedPassword}'
sshpass -e ssh-copy-id -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} 2>&1
exit_code=$?
if [ $exit_code -eq 0 ]; then
  echo "SUCCESS: Key copied"
  exit 0
fi

sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} "test -f ~/.ssh/authorized_keys && grep -q '$(cat ~/.ssh/id_rsa.pub)' ~/.ssh/authorized_keys && echo 'SUCCESS: Key already present' || echo 'FAILED: Key not found'" 2>&1
exit $?`;

    try {
      await writeFile(tmpScript, scriptContent, { mode: 0o700 });
      const result = await this._exec(`bash ${tmpScript}`);
      await this._exec(`rm -f ${tmpScript}`);
     
      if (result.stdout.includes('SUCCESS')) {
        return { success: true, method: 'bash', message: result.stdout.trim() };
      }
     
      return { success: false, method: 'bash', error: result.stdout || result.stderr };
    } catch (error) {
      await this._exec(`rm -f ${tmpScript}`);
      return { success: false, method: 'bash', error: error.message };
    }
  }

  /**
   * Copy SSH key with automatic fallback
   */
  static async copyKey(host, password, user = 'root') {
    console.error('[copyKey] Starting key copy process...');
   
    const hasSshpass = await this._ensureSshpass();
   
    if (hasSshpass) {
      console.error('[copyKey] sshpass available, using sshpass method');
      const result = await this._copyKeySshpass(host, password, user);
      if (result.success) {
        console.error('[copyKey] sshpass method succeeded');
        return result;
      }
      console.error('[copyKey] sshpass method failed:', result.error);
    } else {
      console.error('[copyKey] sshpass not available, falling back to bash method');
    }
   
    console.error('[copyKey] Trying bash method...');
    const bashResult = await this._copyKeyBash(host, password, user);
    console.error('[copyKey] Bash method result:', bashResult);
   
    return bashResult;
  }

  /**
   * Check if port is open
   */
  static async checkAccess(host, port = 22) {
    const result = await this._exec(`timeout 3 bash -c "echo >/dev/tcp/${host}/${port}" 2>&1`);
    if (result.success) return true;
   
    const ncResult = await this._exec(`nc -zv -w2 ${host} ${port} 2>&1`);
    return ncResult.success || ncResult.stderr.includes('succeeded') || ncResult.stderr.includes('open');
  }

  /**
   * Test SSH connection
   */
  static async _testConnection(host, user, useKey = true) {
    const keyOpts = useKey ? '-o PasswordAuthentication=no -o BatchMode=yes' : '';
    const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ConnectionAttempts=2 ${keyOpts} ${user}@${host} "echo 'CONNECTION_OK'" 2>&1`;
   
    console.error(`[_testConnection] Testing connection to ${user}@${host} (key=${useKey})...`);
    const result = await this._exec(cmd);
   
    console.error(`[_testConnection] stdout:`, result.stdout);
    console.error(`[_testConnection] stderr:`, result.stderr);
   
    return {
      success: result.stdout.includes('CONNECTION_OK'),
      output: result.stdout,
      error: result.stderr
    };
  }

  /**
   * Full setup workflow
   */
  static async fullSetup(host, password, user = 'root') {
    console.error('\n=== SSH Full Setup Started ===');
    console.error(`Target: ${user}@${host}`);
   
    console.error('\n[Step 0] Checking if host is reachable...');
    const reachable = await this.checkAccess(host);
    if (!reachable) {
      console.error('[Step 0] Host not reachable');
      return { success: false, message: `Host ${host} not reachable on port 22` };
    }
    console.error('[Step 0] Host is reachable');

    console.error('\n[Step 1] Setting up local SSH...');
    const setupResult = await this.setup();
    if (!setupResult.success) {
      console.error('[Step 1] Setup failed:', setupResult.message);
      return setupResult;
    }
    console.error('[Step 1] Setup complete:', setupResult.message);

    console.error('\n[Step 2] Testing current connection...');
    const preTest = await this._testConnection(host, user, true);
   
    if (preTest.success) {
      console.error('[Step 2] Passwordless SSH already working!');
      return { success: true, message: 'Passwordless SSH already configured and working' };
    }
    console.error('[Step 2] Passwordless SSH not working, will copy key');

    console.error('\n[Step 3] Copying SSH key...');
    const copyResult = await this.copyKey(host, password, user);
   
    if (!copyResult.success) {
      console.error('[Step 3] Key copy failed:', copyResult);
      return {
        success: false,
        message: `Failed to copy SSH key: ${copyResult.error || 'Unknown error'}`,
        details: copyResult
      };
    }
    console.error('[Step 3] Key copy successful via', copyResult.method);

    console.error('\n[Step 4] Fixing permissions on target...');
    const fixCmd = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no ${user}@${host} "chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; restorecon -R ~/.ssh 2>/dev/null; echo 'PERMISSIONS_FIXED'" 2>&1`;
    const fixResult = await this._exec(fixCmd);
    console.error('[Step 4] Fix result:', fixResult.stdout, fixResult.stderr);

    console.error('\n[Step 5] Verifying passwordless SSH...');
   
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) {
        const delay = attempt * 2000;
        console.error(`[Step 5] Waiting ${delay/1000}s before attempt ${attempt}...`);
        await new Promise(r => setTimeout(r, delay));
      }
     
      const testResult = await this._testConnection(host, user, true);
     
      if (testResult.success) {
        console.error(`[Step 5] SUCCESS on attempt ${attempt}!`);
        return {
          success: true,
          message: `Full setup complete via ${copyResult.method}, passwordless SSH working`,
          method: copyResult.method,
          attempts: attempt
        };
      }
     
      console.error(`[Step 5] Attempt ${attempt} failed:`, testResult.error?.slice(-200));
     
      if (attempt === 5) {
        console.error('\n[Diagnosis] Checking target SSH configuration...');
       
        const checkCmd = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no ${user}@${host} "echo '---SSHD_CONFIG---'; grep -E '^(PubkeyAuthentication|AuthorizedKeysFile|PasswordAuthentication|PermitRootLogin)' /etc/ssh/sshd_config 2>/dev/null; echo '---AUTH_KEYS---'; ls -la ~/.ssh/ 2>/dev/null; echo '---KEY_CHECK---'; md5sum ~/.ssh/authorized_keys 2>/dev/null" 2>&1`;
        const diagResult = await this._exec(checkCmd);
        console.error('[Diagnosis] Target info:');
        console.error(diagResult.stdout);
        console.error(diagResult.stderr);
      }
    }

    return {
      success: false,
      message: 'Key copied but passwordless SSH verification failed after 5 attempts. Check SSH daemon config on target.',
      method: copyResult.method
    };
  }

  /**
   * Check if SSH connection is fully unlocked
   */
  static async checkUnlocked(host, user = 'root') {
    console.error(`[checkUnlocked] Testing unlocked access to ${user}@${host}...`);
   
    const reachable = await this.checkAccess(host);
    if (!reachable) {
      return {
        host,
        user,
        accessible: false,
        unlocked: false,
        message: 'Host not reachable on port 22'
      };
    }

    const testResult = await this._testConnection(host, user, true);
   
    if (testResult.success) {
      return {
        host,
        user,
        accessible: true,
        unlocked: true,
        message: 'SSH fully unlocked - passwordless access working',
        details: testResult.output
      };
    }

    const sshTest = await this._exec(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes ${user}@${host} "exit" 2>&1`
    );
   
    if (sshTest.stderr.includes('Permission denied') ||
        sshTest.stderr.includes('password')) {
      return {
        host,
        user,
        accessible: true,
        unlocked: false,
        message: 'SSH accessible but requires password - not unlocked',
        details: sshTest.stderr
      };
    }
   
    if (sshTest.stderr.includes('Connection refused')) {
      return {
        host,
        user,
        accessible: false,
        unlocked: false,
        message: 'SSH port open but connection refused',
        details: sshTest.stderr
      };
    }

    return {
      host,
      user,
      accessible: true,
      unlocked: false,
      message: 'SSH accessible but unlock status unclear',
      details: testResult.error || sshTest.stderr
    };
  }

  /**
   * ULTRA-RELIABLE TCP port check with multiple retries
   * Uses longer timeouts and more retries to ensure no host is missed
   * @param {string} host - Target IP
   * @param {number} port - Port to check (default 22)
   * @param {number} timeout - Timeout in ms (default 1200 - increased for reliability)
   * @param {number} retries - Number of retry attempts (default 3 - increased)
   * @returns {Promise<boolean>} True if port is open
   */
  static _tcpCheck(host, port = 22, timeout = 1200, retries = 3) {
    return new Promise(async (resolve) => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          // Wait between retries with increasing delay
          await new Promise(r => setTimeout(r, 200 * attempt));
        }
        
        const result = await new Promise((resolveSocket) => {
          const socket = new net.Socket();
          let resolved = false;

          const finalize = (result) => {
            if (!resolved) {
              resolved = true;
              socket.removeAllListeners();
              socket.destroy();
              resolveSocket(result);
            }
          };

          socket.setTimeout(timeout);

          socket.on('connect', () => {
            finalize(true);
          });

          socket.on('timeout', () => {
            finalize(false);
          });

          socket.on('error', (err) => {
            finalize(false);
          });

          socket.on('close', () => {
            finalize(false);
          });

          try {
            socket.connect(port, host);
          } catch (error) {
            finalize(false);
          }
        });
        
        if (result) {
          resolve(true);
          return;
        }
      }
      
      resolve(false);
    });
  }

  /**
   * Fast check if host has SSH accessible using native TCP
   * @param {string} host - Target IP
   * @returns {Promise<Object|null>} Host info or null if not accessible
   */
  static async _fastCheckAccess(host) {
    try {
      const isOpen = await this._tcpCheck(host, 22, 1200, 3);
      
      if (isOpen) {
        return {
          host,
          accessible: true,
          unlocked: null,
          type: 'pending'
        };
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if host is unlocked using native SSH with short timeout
   * Uses a separate SSH process to avoid blocking
   * @param {string} host - Target IP
   * @param {string} user - SSH user
   * @returns {Promise<boolean>} True if unlocked
   */
  static async _quickSshCheck(host, user = 'root') {
    const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 -o PasswordAuthentication=no -o BatchMode=yes -o ConnectionAttempts=1 ${user}@${host} "echo UNLOCKED" 2>&1`;
    
    try {
      const result = await this._exec(cmd, { timeout: 5000 });
      return result.stdout.includes('UNLOCKED');
    } catch (error) {
      return false;
    }
  }

  /**
   * Fast check if host is unlocked (passwordless) using native SSH
   * CRITICAL: Uses quick check first, then falls back to thorough retry
   * @param {string} host - Target IP
   * @param {string} user - SSH user
   * @returns {Promise<Object>} Updated host object with unlock status
   */
  static async _fastCheckUnlocked(host, user = 'root') {
    console.error(`[_fastCheckUnlocked] Starting check for ${host}...`);
    
    // Quick check first
    const quickResult = await this._quickSshCheck(host, user);
    if (quickResult) {
      console.error(`[_fastCheckUnlocked] ${host} IS UNLOCKED (quick check)!`);
      return {
        host,
        accessible: true,
        unlocked: true,
        type: 'unlocked',
        user: user,
        message: 'SSH unlocked - passwordless access'
      };
    }
    
    // If quick check fails, try with more aggressive retries
    const sshCmd = [
      'ssh',
      '-o StrictHostKeyChecking=no',
      '-o ConnectTimeout=5',
      '-o ConnectionAttempts=3',
      '-o PasswordAuthentication=no',
      '-o BatchMode=yes',
      '-o ControlMaster=no',
      '-o ControlPath=none',
      '-o ServerAliveInterval=2',
      '-o ServerAliveCountMax=2',
      `${user}@${host}`,
      '"echo UNLOCKED"'
    ].join(' ');

    // Try up to 5 times with progressive backoff
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(500 * Math.pow(2, attempt), 5000);
        console.error(`[_fastCheckUnlocked] ${host} retry ${attempt}/${4} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const result = await this._exec(sshCmd, { timeout: 12000 });
        
        const isUnlocked = result.stdout.includes('UNLOCKED');
        
        console.error(`[_fastCheckUnlocked] ${host} attempt ${attempt}: unlocked=${isUnlocked}`);
        
        // If unlocked, return immediately
        if (isUnlocked) {
          console.error(`[_fastCheckUnlocked] ${host} IS UNLOCKED!`);
          return {
            host,
            accessible: true,
            unlocked: true,
            type: 'unlocked',
            user: user,
            message: 'SSH unlocked - passwordless access'
          };
        }
        
        // Check for specific error messages
        if (result.stderr.includes('Permission denied') || 
            result.stderr.includes('password') ||
            result.stderr.includes('authenticate')) {
          console.error(`[_fastCheckUnlocked] ${host} requires password`);
          return {
            host,
            accessible: true,
            unlocked: false,
            type: 'accessible',
            user: user,
            message: 'SSH accessible but requires password'
          };
        }
        
        // Check if the error is a connection issue (retryable)
        if (result.stderr.includes('Connection refused') ||
            result.stderr.includes('Connection timed out') ||
            result.stderr.includes('No route to host') ||
            result.stderr.includes('Command failed')) {
          console.error(`[_fastCheckUnlocked] ${host} connection issue, will retry...`);
          continue;
        }
        
        console.error(`[_fastCheckUnlocked] ${host} unclear response (stdout: "${result.stdout?.substring(0, 50)}", stderr: "${result.stderr?.substring(0, 50)}")`);
        
      } catch (error) {
        console.error(`[_fastCheckUnlocked] ${host} attempt ${attempt} error: ${error.message?.substring(0, 100)}`);
        
        if (attempt >= 4) {
          return {
            host,
            accessible: true,
            unlocked: false,
            type: 'accessible',
            user: user,
            message: 'SSH accessible but unlock check failed after retries'
          };
        }
      }
    }
    
    // Fallback
    console.error(`[_fastCheckUnlocked] ${host} could not determine unlock status`);
    return {
      host,
      accessible: true,
      unlocked: false,
      type: 'accessible',
      user: user,
      message: 'SSH accessible but unlock status unknown'
    };
  }

  /**
   * Get all local network IPs from network interfaces
   * @returns {Array<string>} Array of unique IP addresses with netmask
   */
  static _getLocalIPs() {
    const interfaces = networkInterfaces();
    const ipMap = new Map();
    
    for (const [name, nets] of Object.entries(interfaces)) {
      if (!nets) continue;
      
      const skipPatterns = ['docker', 'veth', 'br-', 'lo', 'virbr', 'vboxnet', 'vmnet'];
      if (skipPatterns.some(pattern => name.startsWith(pattern))) continue;
      
      for (const net of nets) {
        if (net.family === 'IPv4' && !net.internal) {
          if (net.address.startsWith('127.') || net.address.startsWith('169.254.')) continue;
          
          if (!ipMap.has(net.address)) {
            ipMap.set(net.address, { ip: net.address, netmask: net.netmask });
          }
        }
      }
    }
    
    return Array.from(ipMap.values());
  }

  /**
   * Generate IP range from IP and netmask
   * @param {string} ip - IP address
   * @param {string} netmask - Netmask
   * @returns {Array<string>} Array of IPs in range
   */
  static _generateIPRange(ip, netmask) {
    const ipParts = ip.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);
    
    if (ipParts.length !== 4 || maskParts.length !== 4) return [];
    
    const network = ipParts.map((octet, i) => octet & maskParts[i]);
    
    // For /24 networks (most common case), optimized generation
    if (maskParts[0] === 255 && maskParts[1] === 255 && maskParts[2] === 255 && maskParts[3] === 0) {
      const ips = [];
      const base = `${network[0]}.${network[1]}.${network[2]}.`;
      const gateway = network[3];
      const start = gateway === 1 ? 2 : 1;
      
      for (let d = start; d <= 254; d++) {
        ips.push(base + d);
      }
      return ips;
    }
    
    // For other netmasks
    const broadcast = network.map((octet, i) => octet | (~maskParts[i] & 255));
    const ips = new Set();
    
    const startA = network[0], endA = broadcast[0];
    const startB = (startA === endA) ? network[1] : 0;
    const endB = (startA === endA) ? broadcast[1] : 255;
    const startC = (startA === endA && startB === endB) ? network[2] : 0;
    const endC = (startA === endA && startB === endB) ? broadcast[2] : 255;
    
    for (let a = startA; a <= endA; a++) {
      for (let b = (a === startA ? startB : 0); b <= (a === endA ? endB : 255); b++) {
        for (let c = (a === startA && b === startB ? startC : 0);
             c <= (a === endA && b === endB ? endC : 255); c++) {
          const startD = (a === startA && b === startB && c === startC) ? network[3] + 1 : 1;
          const endD = (a === endA && b === endB && c === endC) ? broadcast[3] - 1 : 254;
          
          for (let d = startD; d <= endD; d++) {
            ips.add(`${a}.${b}.${c}.${d}`);
          }
        }
      }
    }
    
    return Array.from(ips);
  }

  /**
   * Process items in controlled batches with concurrency limit
   * @param {Array} items - Array of items to process
   * @param {Function} fn - Async function to apply to each item
   * @param {number} concurrency - Max concurrent operations
   * @returns {Promise<Array>} Results array (filtered)
   */
  static async _batchProcess(items, fn, concurrency = 500) {
    if (!items || items.length === 0) return [];
    
    const results = new Array(items.length);
    let index = 0;
    let completed = 0;

    async function worker() {
      while (index < items.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = await fn(items[currentIndex]);
          completed++;
          
          if (completed % 100 === 0) {
            console.error(`[batchProcess] Progress: ${completed}/${items.length}`);
          }
        } catch (error) {
          console.error(`[batchProcess] Error:`, error.message);
          results[currentIndex] = null;
          completed++;
        }
      }
    }

    const workerCount = Math.min(concurrency, items.length);
    const workers = Array(workerCount).fill(null).map(() => worker());
    
    await Promise.all(workers);
    
    return results.filter(r => r !== null && r !== undefined);
  }

  /**
   * Save scan state to file for persistence
   */
  static async _saveScanState(state) {
    try {
      await mkdir(dirname(SCAN_STATE_FILE), { recursive: true });
      const tmpFile = SCAN_STATE_FILE + '.tmp';
      await writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf8');
      await rename(tmpFile, SCAN_STATE_FILE);
    } catch (error) {
      console.error('[scanNetwork] Failed to save scan state:', error.message);
    }
  }

  /**
   * Load scan state from file
   */
  static async _loadScanState() {
    try {
      const data = await readFile(SCAN_STATE_FILE, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if background scan is running
   */
  static async _isBackgroundScanRunning() {
    try {
      const pidData = await readFile(SCAN_PID_FILE, 'utf8');
      const pid = parseInt(pidData.trim());
      
      if (!pid || isNaN(pid)) return false;
      
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        try {
          await unlink(SCAN_PID_FILE);
        } catch (err) {
          // Ignore cleanup errors
        }
        return false;
      }
    } catch (error) {
      return false;
    }
  }

  /**
   * Clear scan PID file
   */
  static async _clearScanPid() {
    try {
      await unlink(SCAN_PID_FILE);
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  /**
   * Perform the actual network scan (internal method)
   * CRITICAL: Uses two-pass TCP scanning for reliability
   * CRITICAL: Sequential SSH checking with aggressive retries
   */
  static async _performScan(config = {}) {
    const startTime = Date.now();
    
    try {
      // Get all local interfaces and generate IP ranges
      const localIPs = this._getLocalIPs();
      
      if (localIPs.length === 0) {
        console.error('[scanNetwork] No network interfaces found');
        return {
          success: false,
          message: 'No network interfaces found',
          timestamp: new Date().toISOString(),
          scanComplete: true,
          scanInProgress: false
        };
      }
      
      // Generate unique IPs using a Set for absolute deduplication
      const allIPs = new Set();
      
      for (const { ip, netmask } of localIPs) {
        console.error(`[scanNetwork] Interface: ${ip}/${netmask}`);
        const rangeIPs = this._generateIPRange(ip, netmask);
        for (const rangeIP of rangeIPs) {
          allIPs.add(rangeIP);
        }
      }
      
      const ipArray = Array.from(allIPs);
      const concurrency = config.concurrency || 500;
      console.error(`[scanNetwork] Scanning ${ipArray.length} unique IPs with ${concurrency} concurrent TCP connections...`);
      
      // PHASE 1: TCP port scanning on ALL IPs
      console.error('[scanNetwork] Phase 1: TCP port scanning (pass 1)...');
      const accessResults1 = await this._batchProcess(
        ipArray,
        (ip) => this._fastCheckAccess(ip),
        concurrency
      );
      
      // PHASE 1b: Quick second pass for any missed hosts
      // Take a sample of IPs that weren't found and rescan
      const foundIPs = new Set(accessResults1.map(r => r?.host).filter(Boolean));
      const missedIPs = ipArray.filter(ip => !foundIPs.has(ip));
      
      if (missedIPs.length > 0 && ipArray.length > 10) {
        console.error(`[scanNetwork] Phase 1: TCP port scanning (pass 2 - rescanning ${missedIPs.length} missed IPs)...`);
        
        // Use higher concurrency for rescan to be faster
        const accessResults2 = await this._batchProcess(
          missedIPs,
          (ip) => this._fastCheckAccess(ip),
          Math.min(concurrency * 2, 1000)
        );
        
        // Merge all results
        const allResults = [...accessResults1, ...accessResults2];
        
        // ABSOLUTE DEDUPLICATION: Use Map with IP as key
        const hostMap = new Map();
        for (const result of allResults) {
          if (result && result.host && !hostMap.has(result.host)) {
            hostMap.set(result.host, result);
          }
        }
        
        var accessibleHosts = Array.from(hostMap.values());
      } else {
        // ABSOLUTE DEDUPLICATION: Use Map with IP as key
        const hostMap = new Map();
        for (const result of accessResults1) {
          if (result && result.host && !hostMap.has(result.host)) {
            hostMap.set(result.host, result);
          }
        }
        
        var accessibleHosts = Array.from(hostMap.values());
      }
      
      console.error(`[scanNetwork] Phase 1 complete in ${((Date.now() - startTime)/1000).toFixed(2)}s: ${accessibleHosts.length} unique hosts with SSH open`);
      console.error(`[scanNetwork] Hosts found: ${accessibleHosts.map(h => h.host).join(', ') || 'none'}`);
      
      if (accessibleHosts.length === 0) {
        const emptyResult = {
          success: true,
          timestamp: new Date().toISOString(),
          duration: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
          total_scanned: ipArray.length,
          accessible: 0,
          unlocked: 0,
          hosts: [],
          scanComplete: true,
          scanInProgress: false
        };
        await this._saveScanState(emptyResult);
        return emptyResult;
      }
      
      // PHASE 2: Check unlock status for discovered hosts
      // PROCESS SEQUENTIALLY - ONE AT A TIME - for maximum reliability
      console.error(`[scanNetwork] Phase 2: Checking unlock status for ${accessibleHosts.length} hosts (sequential)...`);
      
      const unlockResults = [];
      for (let i = 0; i < accessibleHosts.length; i++) {
        const host = accessibleHosts[i];
        console.error(`[scanNetwork] Checking host ${i+1}/${accessibleHosts.length}: ${host.host}...`);
        const result = await this._fastCheckUnlocked(host.host);
        unlockResults.push(result);
        console.error(`[scanNetwork] Host ${host.host} result: ${result.unlocked ? 'UNLOCKED' : 'LOCKED'}`);
      }
      
      // FINAL DEDUPLICATION: Ensure absolutely no duplicates
      const finalHostMap = new Map();
      for (const result of unlockResults) {
        if (result && result.host && !finalHostMap.has(result.host)) {
          finalHostMap.set(result.host, result);
        }
      }
      
      const finalHosts = Array.from(finalHostMap.values())
        .sort((a, b) => {
          // Sort: unlocked first, then by IP numerically
          if (b.unlocked !== a.unlocked) return b.unlocked - a.unlocked;
          return a.host.localeCompare(b.host, undefined, { numeric: true });
        });
      
      const unlockedCount = finalHosts.filter(h => h.unlocked).length;
      const accessibleCount = finalHosts.filter(h => !h.unlocked).length;
      
      const finalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.error(`\n[scanNetwork] Scan complete in ${finalDuration}s`);
      console.error(`[scanNetwork] Total scanned: ${ipArray.length}`);
      console.error(`[scanNetwork] SSH accessible (locked): ${accessibleCount}`);
      console.error(`[scanNetwork] SSH unlocked: ${unlockedCount}`);
      console.error(`[scanNetwork] All hosts found: ${finalHosts.map(h => `${h.host} (${h.type})`).join(', ')}`);
      
      const finalResult = {
        success: true,
        timestamp: new Date().toISOString(),
        duration: `${finalDuration}s`,
        total_scanned: ipArray.length,
        accessible: accessibleCount,
        unlocked: unlockedCount,
        hosts: finalHosts,
        scanComplete: true,
        scanInProgress: false
      };
      
      // Save final result
      await this._saveScanState(finalResult);
      
      return finalResult;
    } catch (error) {
      console.error('[scanNetwork] Fatal error:', error);
      return {
        success: false,
        message: error.message,
        timestamp: new Date().toISOString(),
        scanComplete: true,
        scanInProgress: false
      };
    } finally {
      await this._clearScanPid();
    }
  }

  /**
   * Start a truly detached background scan using a separate process
   */
  static _startDetachedBackgroundScan(config = {}) {
    const scanScript = `
      import('${__filename.replace(/'/g, "\\'")}').then(async (module) => {
        const SSH = module.default;
        try {
          const { writeFile } = await import('fs/promises');
          const { homedir } = await import('os');
          const { join } = await import('path');
          const pidFile = join(homedir(), '.ssh-lab-scan.pid');
          await writeFile(pidFile, process.pid.toString(), 'utf8');
          
          await SSH._performScan(${JSON.stringify(config)});
          
          try { await require('fs/promises').unlink(pidFile); } catch (e) {}
          process.exit(0);
        } catch (error) {
          try {
            const { unlink } = await import('fs/promises');
            const { homedir } = await import('os');
            const { join } = await import('path');
            await unlink(join(homedir(), '.ssh-lab-scan.pid'));
          } catch (e) {}
          process.exit(1);
        }
      });
    `;
    
    const child = spawn('node', ['--input-type=module', '-e', scanScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });
    
    child.unref();
    return child;
  }

  /**
   * Scan network for SSH hosts with optional background mode
   */
  static async scanNetwork(config = {}) {
    const {
      background = false,
      forceNew = false,
      concurrency = 500,
      cacheTimeout = 0
    } = config;

    if (!background) {
      return await this._performScan({ concurrency });
    }

    // BACKGROUND MODE
    const savedState = await this._loadScanState();
    const isScanRunning = await this._isBackgroundScanRunning();
    
    let returnState;
    
    if (isScanRunning) {
      if (savedState && savedState.scanComplete) {
        const cacheAge = Date.now() - new Date(savedState.timestamp).getTime();
        returnState = {
          ...savedState,
          scanInProgress: true,
          cacheAge: `${(cacheAge/1000).toFixed(1)}s`
        };
      } else {
        returnState = {
          success: true,
          timestamp: new Date().toISOString(),
          duration: '0s',
          total_scanned: 0,
          accessible: 0,
          unlocked: 0,
          hosts: [],
          scanComplete: false,
          scanInProgress: true
        };
      }
      
      return returnState;
    }
    
    // No scan running
    if (savedState && savedState.scanComplete) {
      const cacheAge = Date.now() - new Date(savedState.timestamp).getTime();
      returnState = { ...savedState, cacheAge: `${(cacheAge/1000).toFixed(1)}s` };
    } else {
      returnState = {
        success: true,
        timestamp: new Date().toISOString(),
        duration: '0s',
        total_scanned: 0,
        accessible: 0,
        unlocked: 0,
        hosts: [],
        scanComplete: false,
        scanInProgress: true
      };
    }

    const shouldStartNewScan = () => {
      if (forceNew) return true;
      
      if (cacheTimeout > 0 && savedState && savedState.scanComplete) {
        const cacheAge = Date.now() - new Date(savedState.timestamp).getTime();
        if (cacheAge < cacheTimeout) return false;
      }
      
      return true;
    };

    if (shouldStartNewScan()) {
      this._startDetachedBackgroundScan({ concurrency });
    }

    return returnState;
  }

  /**
   * Force stop any running background scan
   */
  static async stopBackgroundScan() {
    try {
      const pidData = await readFile(SCAN_PID_FILE, 'utf8');
      const pid = parseInt(pidData.trim());
      
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (e) {
          // Process might already be dead
        }
      }
      
      await this._clearScanPid();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get current scan status without starting a new scan
   */
  static async getScanStatus() {
    const savedState = await this._loadScanState();
    const isScanRunning = await this._isBackgroundScanRunning();
    
    return {
      scanInProgress: isScanRunning,
      lastResult: savedState || null
    };
  }

  /**
   * Clear saved scan state
   */
  static async clearScanCache() {
    try {
      await writeFile(SCAN_STATE_FILE, JSON.stringify({}), 'utf8');
      await this._clearScanPid();
      return true;
    } catch (error) {
      return false;
    }
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, method, ...args] = process.argv;

  const usage = `
Usage: node ssh-lab.mjs <method> [args]

Methods:
  setup                       One-time SSH config + key generation
  copy <host> <password> [user]   Copy SSH key to remote host
  check <host> [port]             Check if SSH port is open
  full <host> <password> [user]   Run setup + copyKey + verify
  unlock-check <host> [user]      Check if SSH is fully unlocked (passwordless)
  scan                            Scan all network interfaces for SSH hosts
  scan-status                    Get current background scan status
  scan-stop                      Stop running background scan
  scan-clear                     Clear scan cache

Scan Options (for 'scan' method):
  --background          Enable background scanning mode
  --force              Force start new scan even if one is running
  --concurrency=<n>    Max concurrent connections (default: 500)

Examples:
  node ssh-lab.mjs setup
  node ssh-lab.mjs copy 10.10.10.10 password123 root
  node ssh-lab.mjs check 10.10.10.10
  node ssh-lab.mjs full 10.10.10.10 password123 root
  node ssh-lab.mjs unlock-check 10.10.10.10 root
  node ssh-lab.mjs scan
  node ssh-lab.mjs scan --background
  node ssh-lab.mjs scan --background --force
  node ssh-lab.mjs scan-status
`;

  if (!method) {
    console.log(usage);
    process.exit(1);
  }

  (async () => {
    try {
      let result;
      
      switch (method) {
        case 'setup':
          result = await SSH.setup();
          break;
          
        case 'copy': {
          const [host, password, user = 'root'] = args;
          if (!host || !password) {
            console.error('Usage: node ssh-lab.mjs copy <host> <password> [user]');
            process.exit(1);
          }
          result = await SSH.copyKey(host, password, user);
          break;
        }
          
        case 'check': {
          const [host, port = 22] = args;
          if (!host) {
            console.error('Usage: node ssh-lab.mjs check <host> [port]');
            process.exit(1);
          }
          result = await SSH.checkAccess(host, parseInt(port));
          break;
        }
          
        case 'full': {
          const [host, password, user = 'root'] = args;
          if (!host || !password) {
            console.error('Usage: node ssh-lab.mjs full <host> <password> [user]');
            process.exit(1);
          }
          result = await SSH.fullSetup(host, password, user);
          break;
        }

        case 'unlock-check': {
          const [host, user = 'root'] = args;
          if (!host) {
            console.error('Usage: node ssh-lab.mjs unlock-check <host> [user]');
            process.exit(1);
          }
          result = await SSH.checkUnlocked(host, user);
          break;
        }

        case 'scan': {
          const scanConfig = {
            background: args.includes('--background'),
            forceNew: args.includes('--force')
          };
          
          const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
          if (concurrencyArg) {
            scanConfig.concurrency = parseInt(concurrencyArg.split('=')[1]) || 500;
          }
          
          result = await SSH.scanNetwork(scanConfig);
          break;
        }

        case 'scan-status': {
          result = await SSH.getScanStatus();
          break;
        }

        case 'scan-stop': {
          const stopped = await SSH.stopBackgroundScan();
          result = { success: stopped, message: stopped ? 'Scan stopped' : 'No scan running' };
          break;
        }

        case 'scan-clear': {
          const cleared = await SSH.clearScanCache();
          result = { success: cleared, message: cleared ? 'Cache cleared' : 'Failed to clear cache' };
          break;
        }
          
        default:
          console.error(`Unknown method: ${method}`);
          console.log(usage);
          process.exit(1);
      }
      
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
      
    } catch (error) {
      console.error('Fatal error:', error.message);
      process.exit(1);
    }
  })();
}