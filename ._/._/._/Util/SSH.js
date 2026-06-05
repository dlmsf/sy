// ssh-lab.mjs - ULTRA RELIABLE VERSION WITH TOGGLE BACKGROUND SCAN
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile, chmod, access, readFile, unlink, rename, rm } from 'fs/promises';
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
const PERSISTENT_HOSTS_FILE = join(homedir(), '.ssh-lab-persistent-hosts.json');

// Toggle background scan state management
const TOGGLE_STATE_FILE = join(homedir(), '.ssh-lab-toggle-state.json');
const TOGGLE_PID_FILE = join(homedir(), '.ssh-lab-toggle.pid');
const TOGGLE_RESULT_FILE = join(homedir(), '.ssh-lab-toggle-result.json');

// All files related to this interface (for cleanup/hard reset)
const ALL_SSH_LAB_FILES = [
  SCAN_STATE_FILE,
  SCAN_PID_FILE,
  PERSISTENT_HOSTS_FILE,
  TOGGLE_STATE_FILE,
  TOGGLE_PID_FILE,
  TOGGLE_RESULT_FILE,
  join(homedir(), '.ssh-lab-scan-state.json.tmp'),
  join(homedir(), '.ssh-lab-toggle-state.json.tmp'),
  join(homedir(), '.ssh-lab-toggle-result.json.tmp'),
  join(homedir(), '.ssh-lab-persistent-hosts.json.tmp'),
];

// QEMU default networks
const QEMU_NETWORKS = ['10.10.10.0/24', '10.10.11.0/24'];

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
   * Copy SSH key using pure bash with expect fallback
   * SURGICAL FIX: Removed sshpass dependency in bash fallback, uses expect or pure SSH
   */
  static async _copyKeyBash(host, password, user) {
    const tmpScript = `/tmp/ssh_copy_${Date.now()}.sh`;
    const escapedPassword = password.replace(/'/g, "'\\''");
    
    // Check if expect is available for proper automation
    const expectCheck = await this._exec('which expect');
    
    if (expectCheck.success) {
      // Method 1: Use expect for reliable SSH key copy
      const expectScript = `/tmp/ssh_copy_${Date.now()}.exp`;
      const expectContent = `#!/usr/bin/expect -f
set timeout 30
spawn ssh-copy-id -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host}
expect {
  "password:" {
    send "${escapedPassword}\\r"
    expect {
      "already exist" {
        puts "SUCCESS: Key already exists on target"
        exit 0
      }
      eof
    }
  }
  "already exist" {
    puts "SUCCESS: Key already exists on target"
    exit 0
  }
  timeout {
    puts "FAILED: Connection timeout"
    exit 1
  }
  eof {
    puts "FAILED: Unexpected EOF"
    exit 1
  }
}
catch wait result
exit [lindex \\$result 3]`;

      try {
        await writeFile(expectScript, expectContent, { mode: 0o700 });
        const result = await this._exec(expectScript);
        await this._exec(`rm -f ${expectScript}`);
        
        if (result.stdout.includes('SUCCESS')) {
          return { success: true, method: 'expect', message: result.stdout.trim() };
        }
        
        return { success: false, method: 'expect', error: result.stdout || result.stderr };
      } catch (error) {
        await this._exec(`rm -f ${expectScript}`);
        return { success: false, method: 'expect', error: error.message };
      }
    } else {
      // Method 2: Pure bash using sshpass only if available, otherwise manual approach
      const sshpassCheck = await this._exec('which sshpass');
      
      if (sshpassCheck.success) {
        // sshpass is available, use it
        const scriptContent = `#!/bin/bash
export SSHPASS='${escapedPassword}'
sshpass -e ssh-copy-id -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} 2>&1
exit_code=$?
if [ $exit_code -eq 0 ]; then
  echo "SUCCESS: Key copied via sshpass"
  exit 0
fi

sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} "test -f ~/.ssh/authorized_keys && grep -q '$(cat ~/.ssh/id_rsa.pub)' ~/.ssh/authorized_keys && echo 'SUCCESS: Key already present' || echo 'FAILED: Key not found'" 2>&1
exit $?`;

        try {
          await writeFile(tmpScript, scriptContent, { mode: 0o700 });
          const result = await this._exec(`bash ${tmpScript}`);
          await this._exec(`rm -f ${tmpScript}`);
          
          if (result.stdout.includes('SUCCESS')) {
            return { success: true, method: 'bash-sshpass', message: result.stdout.trim() };
          }
          
          return { success: false, method: 'bash-sshpass', error: result.stdout || result.stderr };
        } catch (error) {
          await this._exec(`rm -f ${tmpScript}`);
          return { success: false, method: 'bash-sshpass', error: error.message };
        }
      } else {
        // Pure bash fallback without sshpass - use SSH_ASKPASS trick
        const askpassScript = `/tmp/ssh_askpass_${Date.now()}.sh`;
        const askpassContent = `#!/bin/bash
echo '${escapedPassword}'`;

        const scriptContent = `#!/bin/bash
export SSH_ASKPASS="${askpassScript}"
export DISPLAY=dummy:0
setsid ssh-copy-id -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} 2>&1
exit_code=$?
rm -f "${askpassScript}"
if [ $exit_code -eq 0 ]; then
  echo "SUCCESS: Key copied via askpass"
  exit 0
fi

# Check if key already exists
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o PasswordAuthentication=no -o BatchMode=yes ${user}@${host} "exit" 2>&1
if [ $? -eq 0 ]; then
  echo "SUCCESS: Key already present and working"
  exit 0
fi

echo "FAILED: Could not copy key"
exit 1`;

        try {
          await writeFile(askpassScript, askpassContent, { mode: 0o700 });
          await writeFile(tmpScript, scriptContent, { mode: 0o700 });
          const result = await this._exec(`bash ${tmpScript}`);
          await this._exec(`rm -f ${tmpScript} ${askpassScript}`);
          
          if (result.stdout.includes('SUCCESS')) {
            return { success: true, method: 'bash-askpass', message: result.stdout.trim() };
          }
          
          return { success: false, method: 'bash-askpass', error: result.stdout || result.stderr };
        } catch (error) {
          await this._exec(`rm -f ${tmpScript} ${askpassScript}`);
          return { success: false, method: 'bash-askpass', error: error.message };
        }
      }
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
   * Enhanced TCP check with bigger timeout and more retries for persistent hosts
   * @param {string} host - Target IP
   * @returns {Promise<Object|null>} Host info or null if not accessible
   */
  static async _enhancedFastCheckAccess(host) {
    try {
      // Use increased timeout (3000ms) and more retries (6) for hosts that were previously found
      const isOpen = await this._tcpCheck(host, 22, 3000, 6);
      
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
            ipMap.set(net.address, { ip: net.address, netmask: net.netmask, interface: name });
          }
        }
      }
    }
    
    return Array.from(ipMap.values());
  }

  /**
   * List all network interfaces with their IP and netmask
   * @param {Object} options - Filter options
   * @param {Array<string>} options.whitelist - Network CIDRs to include
   * @param {Array<string>} options.blacklist - Network CIDRs to exclude
   * @param {boolean} options.qemuOnly - Only show QEMU networks (10.10.10.0/24 and 10.10.11.0/24)
   * @returns {Array<Object>} Array of interface objects
   */
  static listInterfaces(options = {}) {
    const { whitelist = [], blacklist = [], qemuOnly = false } = options;
    const interfaces = networkInterfaces();
    const results = [];
    
    // Parse CIDR networks for filtering
    const parseCidr = (cidr) => {
      const [ip, prefix] = cidr.split('/');
      const ipParts = ip.split('.').map(Number);
      const mask = ~(2 ** (32 - (parseInt(prefix) || 24)) - 1);
      const network = ipParts.reduce((acc, octet, i) => (acc << 8) | (octet & ((mask >> (24 - i * 8)) & 0xFF)), 0) >>> 0;
      return { network, mask: mask >>> 0, prefix: parseInt(prefix) || 24 };
    };
    
    const whitelistNets = whitelist.map(parseCidr);
    const blacklistNets = blacklist.map(parseCidr);
    const qemuNets = QEMU_NETWORKS.map(parseCidr);
    
    // Helper to check if IP is in a network
    const isInNetwork = (ipStr, net) => {
      const ipParts = ipStr.split('.').map(Number);
      const ipNum = ipParts.reduce((acc, octet) => (acc << 8) | octet, 0) >>> 0;
      return (ipNum & net.mask) === net.network;
    };
    
    for (const [name, nets] of Object.entries(interfaces)) {
      if (!nets) continue;
      
      for (const net of nets) {
        if (net.family !== 'IPv4' || net.internal) continue;
        
        // Apply QEMU-only filter
        if (qemuOnly) {
          const isQemu = qemuNets.some(qnet => isInNetwork(net.address, qnet));
          if (!isQemu) continue;
        }
        
        // Apply whitelist filter
        if (whitelistNets.length > 0) {
          const isWhitelisted = whitelistNets.some(wnet => isInNetwork(net.address, wnet));
          if (!isWhitelisted) continue;
        }
        
        // Apply blacklist filter
        if (blacklistNets.length > 0) {
          const isBlacklisted = blacklistNets.some(bnet => isInNetwork(net.address, bnet));
          if (isBlacklisted) continue;
        }
        
        results.push({
          interface: name,
          ip: net.address,
          netmask: net.netmask,
          cidr: net.cidr || `${net.address}/${this._netmaskToCIDR(net.netmask)}`,
          mac: net.mac,
          type: qemuNets.some(qnet => isInNetwork(net.address, qnet)) ? 'qemu' : 'other'
        });
      }
    }
    
    return results.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'qemu' ? -1 : 1;
      return a.ip.localeCompare(b.ip, undefined, { numeric: true });
    });
  }

  /**
   * Convert netmask to CIDR prefix
   */
  static _netmaskToCIDR(netmask) {
    const parts = netmask.split('.').map(Number);
    let cidr = 0;
    for (const part of parts) {
      cidr += part.toString(2).split('1').length - 1;
    }
    return cidr;
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
   * Get IP ranges filtered by network configuration
   * @param {Object} networkFilter - Network filter configuration
   * @param {Array<string>} networkFilter.whitelist - Network CIDRs to include
   * @param {Array<string>} networkFilter.blacklist - Network CIDRs to exclude
   * @param {boolean} networkFilter.qemuOnly - Only use QEMU networks
   * @returns {Set<string>} Set of IPs to scan
   */
  static _getFilteredIPRange(networkFilter = {}) {
    const { whitelist = [], blacklist = [], qemuOnly = false } = networkFilter;
    const allIPs = new Set();
    const localIPs = this._getLocalIPs();
    
    const parseCidr = (cidr) => {
      const [ip, prefix] = cidr.split('/');
      const ipParts = ip.split('.').map(Number);
      const mask = ~(2 ** (32 - (parseInt(prefix) || 24)) - 1);
      const network = ipParts.reduce((acc, octet, i) => (acc << 8) | (octet & ((mask >> (24 - i * 8)) & 0xFF)), 0) >>> 0;
      return { network, mask: mask >>> 0, prefix: parseInt(prefix) || 24 };
    };
    
    const qemuNets = QEMU_NETWORKS.map(parseCidr);
    const whitelistNets = whitelist.map(parseCidr);
    const blacklistNets = blacklist.map(parseCidr);
    
    const isInNetwork = (ipStr, net) => {
      const ipParts = ipStr.split('.').map(Number);
      const ipNum = ipParts.reduce((acc, octet) => (acc << 8) | octet, 0) >>> 0;
      return (ipNum & net.mask) === net.network;
    };
    
    for (const { ip, netmask, interface: ifName } of localIPs) {
      // Skip excluded interfaces
      const skipPatterns = ['docker', 'veth', 'br-', 'lo', 'virbr', 'vboxnet', 'vmnet'];
      if (skipPatterns.some(pattern => ifName.startsWith(pattern))) continue;
      
      // Apply QEMU-only filter
      if (qemuOnly) {
        const isQemu = qemuNets.some(qnet => isInNetwork(ip, qnet));
        if (!isQemu) continue;
      }
      
      // Apply whitelist
      if (whitelistNets.length > 0) {
        const isWhitelisted = whitelistNets.some(wnet => isInNetwork(ip, wnet));
        if (!isWhitelisted) continue;
      }
      
      // Apply blacklist
      if (blacklistNets.length > 0) {
        const isBlacklisted = blacklistNets.some(bnet => isInNetwork(ip, bnet));
        if (isBlacklisted) continue;
      }
      
      const rangeIPs = this._generateIPRange(ip, netmask);
      for (const rangeIP of rangeIPs) {
        allIPs.add(rangeIP);
      }
    }
    
    return allIPs;
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
   * Save persistent hosts data (for hosts that weren't found in current scan)
   */
  static async _savePersistentHosts(persistentHosts) {
    try {
      await mkdir(dirname(PERSISTENT_HOSTS_FILE), { recursive: true });
      const tmpFile = PERSISTENT_HOSTS_FILE + '.tmp';
      await writeFile(tmpFile, JSON.stringify(persistentHosts, null, 2), 'utf8');
      await rename(tmpFile, PERSISTENT_HOSTS_FILE);
    } catch (error) {
      console.error('[persistentHosts] Failed to save persistent hosts:', error.message);
    }
  }

  /**
   * Load persistent hosts data
   */
  static async _loadPersistentHosts() {
    try {
      const data = await readFile(PERSISTENT_HOSTS_FILE, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return {};
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
   * SURGICAL FIX: Hosts with retries left are maintained for future scans
   * SURGICAL FIX: Hosts that go inactive are removed after maxInactiveScans consecutive scans
   */
  static async _performScan(config = {}) {
    const startTime = Date.now();
    const persistentRetryConfig = config.persistentRetryConfig || {
      maxRetriesScans: 1,         // Default: maintain for 1 more scan with enhanced retry
      enhancedTimeout: 3000,
      enhancedRetries: 6,
      maxInactiveScans: 3         // SURGICAL FIX: Remove hosts after 3 consecutive inactive scans
    };
    
    try {
      // Load persistent hosts from previous scans
      const persistentHosts = await this._loadPersistentHosts();
      console.error(`[scanNetwork] Loaded ${Object.keys(persistentHosts).length} persistent hosts from previous scans`);
      
      // Get filtered IP ranges based on network configuration
      const networkFilter = config.networkFilter || {};
      const allIPs = this._getFilteredIPRange(networkFilter);
      const ipArray = Array.from(allIPs);
      const concurrency = config.concurrency || 500;
      
      if (ipArray.length === 0) {
        console.error('[scanNetwork] No IPs to scan after applying network filters');
        return {
          success: true,
          message: 'No IPs to scan after network filtering',
          timestamp: new Date().toISOString(),
          scanComplete: true,
          scanInProgress: false,
          total_scanned: 0,
          accessible: 0,
          unlocked: 0,
          hosts: []
        };
      }
      
      console.error(`[scanNetwork] Scanning ${ipArray.length} unique IPs with ${concurrency} concurrent TCP connections...`);
      
      if (networkFilter.qemuOnly) {
        console.error('[scanNetwork] QEMU-only mode: scanning 10.10.10.0/24 and 10.10.11.0/24');
      }
      if (networkFilter.whitelist?.length > 0) {
        console.error(`[scanNetwork] Whitelist: ${networkFilter.whitelist.join(', ')}`);
      }
      if (networkFilter.blacklist?.length > 0) {
        console.error(`[scanNetwork] Blacklist: ${networkFilter.blacklist.join(', ')}`);
      }
      
      // PHASE 1: TCP port scanning on ALL IPs
      console.error('[scanNetwork] Phase 1: TCP port scanning (pass 1)...');
      const accessResults1 = await this._batchProcess(
        ipArray,
        (ip) => this._fastCheckAccess(ip),
        concurrency
      );
      
      // PHASE 1b: Quick second pass for any missed hosts
      const foundIPs = new Set(accessResults1.map(r => r?.host).filter(Boolean));
      const missedIPs = ipArray.filter(ip => !foundIPs.has(ip));
      
      if (missedIPs.length > 0 && ipArray.length > 10) {
        console.error(`[scanNetwork] Phase 1: TCP port scanning (pass 2 - rescanning ${missedIPs.length} missed IPs)...`);
        
        const accessResults2 = await this._batchProcess(
          missedIPs,
          (ip) => this._fastCheckAccess(ip),
          Math.min(concurrency * 2, 1000)
        );
        
        const allResults = [...accessResults1, ...accessResults2];
        
        const hostMap = new Map();
        for (const result of allResults) {
          if (result && result.host && !hostMap.has(result.host)) {
            hostMap.set(result.host, result);
          }
        }
        
        var accessibleHosts = Array.from(hostMap.values());
      } else {
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
      
      // PHASE 1c: Process persistent hosts that weren't found in current scan
      const currentFoundIPs = new Set(accessibleHosts.map(h => h.host));
      const notFoundPersistentHosts = [];
      const updatedPersistentHosts = {};
      
      for (const [persistentIP, persistentData] of Object.entries(persistentHosts)) {
        if (!currentFoundIPs.has(persistentIP)) {
          // This persistent host wasn't found in current scan
          const retriesLeft = persistentData.retriesLeft !== undefined ? persistentData.retriesLeft : persistentRetryConfig.maxRetriesScans;
          
          // SURGICAL FIX: Only do enhanced scan if retriesLeft > 0
          // If retriesLeft === 0, this host already had its enhanced scan on previous scan
          if (retriesLeft > 0) {
            notFoundPersistentHosts.push({ ip: persistentIP, data: persistentData });
          } else {
            // SURGICAL FIX: retriesLeft === 0 means enhanced scan was done last time
            // Now it's truly no longer active - start counting inactive scans
            const consecutiveInactiveScans = (persistentData.consecutiveInactiveScans || 0) + 1;
            updatedPersistentHosts[persistentIP] = {
              ...persistentData,
              retriesLeft: 0,
              noLongerActive: true,
              lastAttempt: new Date().toISOString(),
              consecutiveInactiveScans: consecutiveInactiveScans
            };
            console.error(`[scanNetwork] Host ${persistentIP} still not found after retries exhausted, inactive scan ${consecutiveInactiveScans}/${persistentRetryConfig.maxInactiveScans || 3}`);
          }
        } else {
          // Host was found in current scan - reset all counters
          updatedPersistentHosts[persistentIP] = {
            ...persistentData,
            retriesLeft: persistentRetryConfig.maxRetriesScans,
            lastSeen: new Date().toISOString(),
            noLongerActive: false,
            foundWithEnhancedScan: persistentData.foundWithEnhancedScan || false,
            consecutiveInactiveScans: 0
          };
        }
      }
      
      // Perform enhanced scan for persistent hosts with retries left
      if (notFoundPersistentHosts.length > 0) {
        console.error(`[scanNetwork] Phase 1c: Enhanced scan for ${notFoundPersistentHosts.length} persistent hosts with retries...`);
        
        const enhancedResults = await this._batchProcess(
          notFoundPersistentHosts.map(h => h.ip),
          (ip) => this._enhancedFastCheckAccess(ip),
          Math.min(concurrency, notFoundPersistentHosts.length)
        );
        
        const enhancedFoundIPs = new Set(enhancedResults.filter(r => r !== null).map(r => r.host));
        
        // Update accessible hosts with enhanced scan results
        for (const result of enhancedResults) {
          if (result && result.host) {
            const existingHost = accessibleHosts.find(h => h.host === result.host);
            if (!existingHost) {
              accessibleHosts.push(result);
            }
          }
        }
        
        // Update persistent hosts based on enhanced scan results
        for (const { ip, data } of notFoundPersistentHosts) {
          if (enhancedFoundIPs.has(ip)) {
            // Found with enhanced scan - reset all counters
            updatedPersistentHosts[ip] = {
              ...data,
              retriesLeft: persistentRetryConfig.maxRetriesScans,
              lastSeen: new Date().toISOString(),
              foundWithEnhancedScan: true,
              noLongerActive: false,
              consecutiveInactiveScans: 0
            };
            console.error(`[scanNetwork] Host ${ip} FOUND via enhanced scan!`);
          } else {
            // SURGICAL FIX: Not found even with enhanced scan
            // Decrement retriesLeft, but do NOT mark as noLongerActive yet
            // Only set retriesLeft to 0, next scan will mark as inactive if still not found
            const currentRetries = data.retriesLeft !== undefined ? data.retriesLeft : persistentRetryConfig.maxRetriesScans;
            const newRetriesLeft = currentRetries - 1;
            
            updatedPersistentHosts[ip] = {
              ...data,
              retriesLeft: newRetriesLeft,
              lastAttempt: new Date().toISOString(),
              noLongerActive: false,  // SURGICAL FIX: NOT inactive yet
              consecutiveInactiveScans: 0  // SURGICAL FIX: Don't count yet
            };
            
            if (newRetriesLeft > 0) {
              console.error(`[scanNetwork] Host ${ip} not found via enhanced scan, retries left: ${newRetriesLeft} - will retry enhanced scan next time`);
            } else {
              console.error(`[scanNetwork] Host ${ip} not found via enhanced scan, retries exhausted - will mark inactive on next miss`);
            }
          }
        }
      }
      
      // Save updated persistent hosts
      await this._savePersistentHosts(updatedPersistentHosts);
      
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
      console.error(`[scanNetwork] Phase 2: Checking unlock status for ${accessibleHosts.length} hosts (sequential)...`);
      
      const unlockResults = [];
      for (let i = 0; i < accessibleHosts.length; i++) {
        const host = accessibleHosts[i];
        console.error(`[scanNetwork] Checking host ${i+1}/${accessibleHosts.length}: ${host.host}...`);
        const result = await this._fastCheckUnlocked(host.host);
        unlockResults.push(result);
        console.error(`[scanNetwork] Host ${host.host} result: ${result.unlocked ? 'UNLOCKED' : 'LOCKED'}`);
      }
      
      // FINAL DEDUPLICATION
      const finalHostMap = new Map();
      for (const result of unlockResults) {
        if (result && result.host && !finalHostMap.has(result.host)) {
          finalHostMap.set(result.host, result);
        }
      }
      
      const finalHosts = Array.from(finalHostMap.values())
        .sort((a, b) => {
          if (b.unlocked !== a.unlocked) return b.unlocked - a.unlocked;
          return a.host.localeCompare(b.host, undefined, { numeric: true });
        });
      
      // Add persistent host info
      for (const host of finalHosts) {
        if (updatedPersistentHosts[host.host]) {
          host.persistentHostInfo = updatedPersistentHosts[host.host];
        }
        
        if (!updatedPersistentHosts[host.host]) {
          updatedPersistentHosts[host.host] = {
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            retriesLeft: persistentRetryConfig.maxRetriesScans,
            noLongerActive: false,
            consecutiveInactiveScans: 0
          };
        }
      }
      
      // SURGICAL FIX: Inactive hosts - only show those with noLongerActive: true
      const maxInactiveScans = persistentRetryConfig.maxInactiveScans || 3;
      const noLongerActiveHosts = [];
      const hostsToRemove = [];
      
      for (const [ip, data] of Object.entries(updatedPersistentHosts)) {
        if (data.noLongerActive && !finalHostMap.has(ip)) {
          if (data.consecutiveInactiveScans >= maxInactiveScans) {
            hostsToRemove.push(ip);
            console.error(`[scanNetwork] Removing permanently inactive host ${ip} after ${data.consecutiveInactiveScans}/${maxInactiveScans} consecutive inactive scans`);
          } else {
            noLongerActiveHosts.push({
              host: ip,
              accessible: false,
              unlocked: false,
              type: 'inactive',
              message: `Previously found host is no longer accessible (${data.consecutiveInactiveScans}/${maxInactiveScans} inactive scans - will be removed after ${maxInactiveScans})`,
              noLongerActive: true,
              persistentHostInfo: data
            });
          }
        }
      }
      
      for (const ip of hostsToRemove) {
        delete updatedPersistentHosts[ip];
      }
      
      const allFinalHosts = [...finalHosts, ...noLongerActiveHosts]
        .sort((a, b) => {
          if (b.noLongerActive !== a.noLongerActive) return b.noLongerActive ? -1 : 1;
          if (!a.noLongerActive && !b.noLongerActive) {
            if (b.unlocked !== a.unlocked) return b.unlocked - a.unlocked;
          }
          return a.host.localeCompare(b.host, undefined, { numeric: true });
        });
      
      await this._savePersistentHosts(updatedPersistentHosts);
      
      const unlockedCount = allFinalHosts.filter(h => h.unlocked && !h.noLongerActive).length;
      const accessibleCount = allFinalHosts.filter(h => !h.unlocked && !h.noLongerActive).length;
      const inactiveCount = allFinalHosts.filter(h => h.noLongerActive).length;
      
      const finalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.error(`\n[scanNetwork] Scan complete in ${finalDuration}s`);
      console.error(`[scanNetwork] Total scanned: ${ipArray.length}`);
      console.error(`[scanNetwork] SSH accessible (locked): ${accessibleCount}`);
      console.error(`[scanNetwork] SSH unlocked: ${unlockedCount}`);
      console.error(`[scanNetwork] Previously found, now inactive: ${inactiveCount}`);
      console.error(`[scanNetwork] Removed permanently inactive hosts: ${hostsToRemove.length}`);
      
      const finalResult = {
        success: true,
        timestamp: new Date().toISOString(),
        duration: `${finalDuration}s`,
        total_scanned: ipArray.length,
        accessible: accessibleCount,
        unlocked: unlockedCount,
        hosts: allFinalHosts,
        scanComplete: true,
        scanInProgress: false,
        networkFilter: networkFilter
      };
      
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
   * --------------------------------------------------------------------------
   * TOGGLE BACKGROUND SCAN - NEW FEATURE
   * --------------------------------------------------------------------------
   */

  /**
   * Compare two scan configurations for equivalence (ignoring non-scan params)
   */
  static _configsMatch(configA, configB) {
    const normalize = (cfg) => ({
      concurrency: cfg.concurrency || 500,
      networkFilter: cfg.networkFilter || {},
      persistentRetryConfig: cfg.persistentRetryConfig || {
        maxRetriesScans: 1,
        enhancedTimeout: 3000,
        enhancedRetries: 6,
        maxInactiveScans: 3
      }
    });
    const a = normalize(configA);
    const b = normalize(configB);
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * Read toggle state from disk
   */
  static async _readToggleState() {
    try {
      const data = await readFile(TOGGLE_STATE_FILE, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return { enabled: false, config: {} };
    }
  }

  /**
   * Write toggle state to disk
   */
  static async _writeToggleState(state) {
    await mkdir(dirname(TOGGLE_STATE_FILE), { recursive: true });
    const tmp = TOGGLE_STATE_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, TOGGLE_STATE_FILE);
  }

  /**
   * Check if toggle process is running (by PID)
   */
  static async _isToggleProcessRunning() {
    try {
      const pidData = await readFile(TOGGLE_PID_FILE, 'utf8');
      const pid = parseInt(pidData.trim());
      if (!pid || isNaN(pid)) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        // Process not found, clean up
        try { await unlink(TOGGLE_PID_FILE); } catch (_) {}
        return false;
      }
    } catch (error) {
      return false;
    }
  }

  /**
   * Kill toggle process if running
   */
  static async _killToggleProcess() {
    try {
      const pidData = await readFile(TOGGLE_PID_FILE, 'utf8');
      const pid = parseInt(pidData.trim());
      if (pid) {
        try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    try { await unlink(TOGGLE_PID_FILE); } catch (_) {}
  }

  /**
   * Start the toggle loop as a detached Node.js process
   */
  static _startToggleLoop() {
    const loopScript = `
      import { readFile, writeFile, unlink, mkdir, rename } from 'fs/promises';
      import { join, dirname } from 'path';
      import { homedir } from 'os';
      const TOGGLE_STATE_FILE = join(homedir(), '.ssh-lab-toggle-state.json');
      const TOGGLE_RESULT_FILE = join(homedir(), '.ssh-lab-toggle-result.json');
      const TOGGLE_PID_FILE = join(homedir(), '.ssh-lab-toggle.pid');
      
      (async () => {
        try {
          await writeFile(TOGGLE_PID_FILE, String(process.pid));
        } catch (e) {
          process.exit(1);
        }
        
        const SSH = (await import('${__filename.replace(/'/g, "\\'")}')).default;
        
        const readState = async () => {
          try {
            const data = await readFile(TOGGLE_STATE_FILE, 'utf8');
            return JSON.parse(data);
          } catch { return { enabled: false }; }
        };
        
        while (true) {
          const state = await readState();
          if (!state.enabled) {
            break;
          }
          
          const config = state.config || {};
          try {
            const result = await SSH._performScan(config);
            const tmpFile = TOGGLE_RESULT_FILE + '.tmp';
            await mkdir(dirname(TOGGLE_RESULT_FILE), { recursive: true });
            await writeFile(tmpFile, JSON.stringify(result), 'utf8');
            await rename(tmpFile, TOGGLE_RESULT_FILE);
          } catch (err) {
            // Silently continue
          }
          
          // Small pause between scans to allow config updates
          await new Promise(r => setTimeout(r, 200));
        }
        
        try { await unlink(TOGGLE_PID_FILE); } catch (_) {}
        process.exit(0);
      })();
    `;
    
    const child = spawn('node', ['--input-type=module', '-e', loopScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });
    child.unref();
    return child;
  }

  /**
   * Load the latest toggle scan result
   */
  static async _readToggleResult() {
    try {
      const data = await readFile(TOGGLE_RESULT_FILE, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  /**
   * Enable the toggle background scan with given configuration.
   * If already enabled with a different config, it will restart the loop.
   */
  static async toggleOn(config = {}) {
    const scanConfig = {
      concurrency: config.concurrency || 500,
      networkFilter: config.networkFilter || {},
      persistentRetryConfig: config.persistentRetryConfig || {
        maxRetriesScans: 1,
        enhancedTimeout: 3000,
        enhancedRetries: 6,
        maxInactiveScans: 3
      }
    };

    const currentState = await this._readToggleState();
    const isRunning = await this._isToggleProcessRunning();

    if (currentState.enabled && isRunning && this._configsMatch(currentState.config, scanConfig)) {
      return { success: true, message: 'Toggle already active with same configuration', config: scanConfig };
    }

    // Stop any existing loop
    if (isRunning || currentState.enabled) {
      await this._killToggleProcess();
    }

    // Write new state
    await this._writeToggleState({ enabled: true, config: scanConfig });

    // Start loop
    this._startToggleLoop();

    return { success: true, message: 'Toggle background scan activated', config: scanConfig };
  }

  /**
   * Disable the toggle background scan.
   */
  static async toggleOff() {
    const currentState = await this._readToggleState();
    if (!currentState.enabled) {
      return { success: true, message: 'Toggle already inactive' };
    }

    await this._writeToggleState({ enabled: false, config: currentState.config || {} });
    await this._killToggleProcess();

    return { success: true, message: 'Toggle background scan deactivated' };
  }

  /**
   * Get current toggle status: enabled, config, and latest scan result.
   */
  static async getToggleStatus() {
    const state = await this._readToggleState();
    const isRunning = await this._isToggleProcessRunning();
    const lastResult = await this._readToggleResult();

    return {
      enabled: state.enabled,
      running: isRunning,
      config: state.config || {},
      lastResult: lastResult || null
    };
  }

  /**
   * Update the configuration of the toggle scan. If currently enabled, restarts the loop.
   */
  static async updateToggleConfig(config = {}) {
    const currentState = await this._readToggleState();
    const scanConfig = {
      concurrency: config.concurrency || 500,
      networkFilter: config.networkFilter || {},
      persistentRetryConfig: config.persistentRetryConfig || {
        maxRetriesScans: 1,
        enhancedTimeout: 3000,
        enhancedRetries: 6,
        maxInactiveScans: 3
      }
    };

    if (currentState.enabled) {
      // Restart with new config
      await this._killToggleProcess();
      await this._writeToggleState({ enabled: true, config: scanConfig });
      this._startToggleLoop();
      return { success: true, message: 'Toggle config updated and loop restarted', config: scanConfig };
    } else {
      await this._writeToggleState({ enabled: false, config: scanConfig });
      return { success: true, message: 'Toggle config updated (toggle is off)', config: scanConfig };
    }
  }

  /**
   * --------------------------------------------------------------------------
   * MODIFIED scanNetwork TO USE TOGGLE IF CONFIG MATCHES
   * --------------------------------------------------------------------------
   */

  /**
   * Scan network for SSH hosts with optional background mode.
   * If the toggle is active and the requested scan config matches the toggle config,
   * it returns the latest result from the toggle instead of starting a new scan.
   */
  static async scanNetwork(config = {}) {
    const {
      background = false,
      forceNew = false,
      concurrency = 500,
      cacheTimeout = 0,
      persistentRetryConfig = {
        maxRetriesScans: 1,
        enhancedTimeout: 3000,
        enhancedRetries: 6,
        maxInactiveScans: 3
      },
      networkFilter = {},
      qemu = false,
      whitelist,
      blacklist
    } = config;

    // Build network filter from convenience flags
    const effectiveNetworkFilter = { ...networkFilter };
    
    if (qemu) {
      effectiveNetworkFilter.qemuOnly = true;
    }
    if (whitelist) {
      effectiveNetworkFilter.whitelist = Array.isArray(whitelist) ? whitelist : [whitelist];
    }
    if (blacklist) {
      effectiveNetworkFilter.blacklist = Array.isArray(blacklist) ? blacklist : [blacklist];
    }

    const requestedScanConfig = {
      concurrency,
      persistentRetryConfig,
      networkFilter: effectiveNetworkFilter
    };

    // --- CHECK TOGGLE ---
    const toggleState = await this._readToggleState();
    if (toggleState.enabled && this._configsMatch(toggleState.config, requestedScanConfig)) {
      const toggleResult = await this._readToggleResult();
      if (toggleResult) {
        // Add source indicator and return cached result
        return {
          ...toggleResult,
          source: 'toggle',
          scanComplete: true,
          scanInProgress: false,
          toggleActive: true
        };
      } else {
        // Toggle hasn't produced a result yet, return placeholder
        return {
          success: true,
          message: 'Toggle active but no scan result yet',
          timestamp: new Date().toISOString(),
          duration: '0s',
          total_scanned: 0,
          accessible: 0,
          unlocked: 0,
          hosts: [],
          scanComplete: false,
          scanInProgress: true,
          source: 'toggle'
        };
      }
    }

    // --- PROCEED WITH NORMAL SCAN ---
    if (!background) {
      return await this._performScan(requestedScanConfig);
    }

    // BACKGROUND MODE (existing logic)
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
          inactive: 0,
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
        inactive: 0,
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
      this._startDetachedBackgroundScan(requestedScanConfig);
    }

    return returnState;
  }

  /**
   * SURGICAL FEATURE: Test mode - runs scans continuously until Ctrl+C
   * Prints clean results as each scan completes
   * Tracks success rate when minimum IP counts are specified
   * Shows duration per IP metrics
   * @param {Object} config - Configuration options
   * @param {number} config.concurrency - Max concurrent connections (default: 500)
   * @param {Object} config.persistentRetryConfig - Persistent retry configuration
   * @param {number} config.minUnlocked - Minimum unlocked IPs required for success (default: 0, disabled)
   * @param {number} config.minAccessible - Minimum accessible IPs required for success (default: 0, disabled)
   */
  static async testMode(config = {}) {
    const {
      concurrency = 500,
      persistentRetryConfig = {
        maxRetriesScans: 1,
        enhancedTimeout: 3000,
        enhancedRetries: 6,
        maxInactiveScans: 3
      },
      minUnlocked = 0,
      minAccessible = 0,
      networkFilter = {},
      qemu = false,
      whitelist,
      blacklist
    } = config;
  
    // Build network filter from convenience flags
    const effectiveNetworkFilter = { ...networkFilter };
    
    if (qemu) {
      effectiveNetworkFilter.qemuOnly = true;
    }
    if (whitelist) {
      effectiveNetworkFilter.whitelist = Array.isArray(whitelist) ? whitelist : [whitelist];
    }
    if (blacklist) {
      effectiveNetworkFilter.blacklist = Array.isArray(blacklist) ? blacklist : [blacklist];
    }
  
    // Suppress stderr for clean output
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = () => true;
  
    const trackingEnabled = minUnlocked > 0 || minAccessible > 0;
    
    console.log('SSH Lab Test Mode - Ctrl+C to stop');
    if (trackingEnabled) {
      console.log(`Tracking: min-unlocked=${minUnlocked}, min-accessible=${minAccessible}`);
    }
    if (Object.keys(effectiveNetworkFilter).length > 0) {
      console.log(`Network filter: ${JSON.stringify(effectiveNetworkFilter)}`);
    }
    console.log('');
  
    // Build header dynamically based on tracking mode
    const headers = [
      '#'.padEnd(5),
      'Time'.padEnd(12),
      'Unlocked'.padEnd(10),
      'Accessible'.padEnd(12),
      'Inactive'.padEnd(10),
      'Duration'.padEnd(10),
      'Avg Dur'.padEnd(10),
      'Dur/IP'.padEnd(8),
      'Avg D/IP'.padEnd(8)
    ];
    
    if (trackingEnabled) {
      headers.push('Success'.padEnd(8));
      headers.push('Success%'.padEnd(9));
    }
    
    headers.push('IPs');
    console.log(headers.join(' | '));
    console.log('='.repeat(trackingEnabled ? 110 : 85));
  
    let totalDuration = 0;
    let totalScans = 0;
    let successCount = 0;
    let totalDurationPerIP = 0;
    let running = true;
  
    process.on('SIGINT', () => {
      running = false;
      process.stderr.write = originalStderrWrite;
      
      console.log(`\n=== Stopped after ${totalScans} scans ===`);
      console.log(`Total time: ${totalDuration.toFixed(2)}s | Avg duration: ${(totalDuration / Math.max(totalScans, 1)).toFixed(2)}s`);
      if (trackingEnabled) {
        console.log(`Success rate: ${successCount}/${totalScans} (${((successCount / Math.max(totalScans, 1)) * 100).toFixed(1)}%)`);
      }
      console.log(`Avg Duration/IP: ${(totalDurationPerIP / Math.max(totalScans, 1)).toFixed(4)}s`);
      
      process.exit(0);
    });
  
    while (running) {
      try {
        const scanResult = await this._performScan({
          concurrency,
          persistentRetryConfig,
          networkFilter: effectiveNetworkFilter
        });
        
        if (!running) break;
        
        if (scanResult.success && scanResult.scanComplete) {
          totalScans++;
          const duration = parseFloat(scanResult.duration) || 0;
          totalDuration += duration;
          const avgDuration = totalDuration / totalScans;
          
          const totalIPsScanned = scanResult.total_scanned || 0;
          const durationPerIP = totalIPsScanned > 0 ? duration / totalIPsScanned : 0;
          totalDurationPerIP += durationPerIP;
          const avgDurationPerIP = totalDurationPerIP / totalScans;
          
          const unlockedCount = scanResult.unlocked || 0;
          const accessibleCount = scanResult.accessible || 0;
          
          let isSuccess = true;
          if (trackingEnabled) {
            if (minUnlocked > 0 && unlockedCount < minUnlocked) {
              isSuccess = false;
            }
            if (minAccessible > 0 && accessibleCount < minAccessible) {
              isSuccess = false;
            }
            if (isSuccess) {
              successCount++;
            }
          }
          
          const rowData = [
            `#${String(totalScans).padStart(3)}`,
            new Date().toISOString().substring(11, 19).padEnd(12),
            String(unlockedCount).padEnd(10),
            String(accessibleCount).padEnd(12),
            String(scanResult.inactive || 0).padEnd(10),
            `${duration.toFixed(2)}s`.padEnd(10),
            `${avgDuration.toFixed(2)}s`.padEnd(10),
            `${durationPerIP.toFixed(4)}s`.padEnd(8),
            `${avgDurationPerIP.toFixed(4)}s`.padEnd(8)
          ];
          
          if (trackingEnabled) {
            const successPercent = ((successCount / totalScans) * 100).toFixed(1);
            rowData.push(
              isSuccess ? '✓'.padEnd(8) : '✗'.padEnd(8),
              `${successPercent}%`.padEnd(9)
            );
          }
          
          rowData.push(String(totalIPsScanned));
          
          let linePrefix = '';
          if (trackingEnabled) {
            linePrefix = isSuccess ? '  ' : '! ';
          }
          
          console.log(linePrefix + rowData.join(' | '));
          
          if (scanResult.hosts && scanResult.hosts.length > 0) {
            const unlockedHosts = scanResult.hosts.filter(h => h.unlocked && !h.noLongerActive);
            const accessibleHosts = scanResult.hosts.filter(h => h.accessible && !h.unlocked && !h.noLongerActive);
            const inactiveHosts = scanResult.hosts.filter(h => h.noLongerActive);
            
            if (unlockedHosts.length > 0) {
              const prefix = trackingEnabled && minUnlocked > 0 && unlockedHosts.length < minUnlocked ? '! ' : '  ';
              console.log(`${prefix}✓ ${unlockedHosts.map(h => h.host).join(', ')}`);
            }
            if (accessibleHosts.length > 0) {
              const prefix = trackingEnabled && minAccessible > 0 && accessibleHosts.length < minAccessible ? '! ' : '  ';
              console.log(`${prefix}○ ${accessibleHosts.map(h => h.host).join(', ')}`);
            }
            if (inactiveHosts.length > 0) {
              console.log(`  ✗ ${inactiveHosts.map(h => {
                const c = h.persistentHostInfo?.consecutiveInactiveScans || 0;
                const m = persistentRetryConfig.maxInactiveScans || 3;
                return `${h.host}(${c}/${m})`;
              }).join(', ')}`);
            }
          }
        } else {
          if (!running) break;
          totalScans++;
          console.log(`#${String(totalScans).padStart(3)} | ${new Date().toISOString().substring(11, 19)} | Scan failed`);
        }
        
      } catch (error) {
        if (!running) break;
        totalScans++;
        console.log(`#${String(totalScans).padStart(3)} | ${new Date().toISOString().substring(11, 19)} | Error: ${error.message}`);
      }
    }
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
   * Clear saved scan state and persistent hosts
   */
  static async clearScanCache() {
    try {
      await writeFile(SCAN_STATE_FILE, JSON.stringify({}), 'utf8');
      await writeFile(PERSISTENT_HOSTS_FILE, JSON.stringify({}), 'utf8');
      await this._clearScanPid();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * --------------------------------------------------------------------------
   * HARD RESET - Complete cleanup of all SSH Lab state
   * --------------------------------------------------------------------------
   * Removes all files, kills all running processes (background scan + toggle loop),
   * and resets everything to a pristine state.
   * Only touches files specifically belonging to this interface (no directory deletion).
   */
  static async hardReset() {
    const results = {
      filesRemoved: [],
      filesFailed: [],
      processesKilled: [],
      processesFailed: []
    };

    // 1. Kill toggle loop process if running
    const toggleState = await this._readToggleState();
    if (toggleState.enabled || await this._isToggleProcessRunning()) {
      try {
        const pidData = await readFile(TOGGLE_PID_FILE, 'utf8').catch(() => null);
        if (pidData) {
          const pid = parseInt(pidData.trim());
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL');
              results.processesKilled.push({ type: 'toggle-loop', pid });
            } catch (e) {
              results.processesFailed.push({ type: 'toggle-loop', pid, error: e.message });
            }
          }
        }
      } catch (e) {
        // Ignore
      }
    }

    // 2. Kill background scan process if running
    const bgScanRunning = await this._isBackgroundScanRunning();
    if (bgScanRunning) {
      try {
        const pidData = await readFile(SCAN_PID_FILE, 'utf8').catch(() => null);
        if (pidData) {
          const pid = parseInt(pidData.trim());
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL');
              results.processesKilled.push({ type: 'background-scan', pid });
            } catch (e) {
              results.processesFailed.push({ type: 'background-scan', pid, error: e.message });
            }
          }
        }
      } catch (e) {
        // Ignore
      }
    }

    // 3. Remove all known SSH Lab files (including .tmp files)
    for (const filePath of ALL_SSH_LAB_FILES) {
      try {
        await unlink(filePath);
        results.filesRemoved.push(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          results.filesFailed.push({ path: filePath, error: error.message });
        }
        // ENOENT (file doesn't exist) is fine, just skip
      }
    }

    // 4. Also try to remove any orphaned .tmp files that might exist
    try {
      const homeDir = homedir();
      const { readdir } = await import('fs/promises');
      const files = await readdir(homeDir).catch(() => []);
      for (const file of files) {
        if (file.startsWith('.ssh-lab-') && file.endsWith('.tmp')) {
          const fullPath = join(homeDir, file);
          try {
            await unlink(fullPath);
            if (!results.filesRemoved.includes(fullPath)) {
              results.filesRemoved.push(fullPath);
            }
          } catch (e) {
            // Ignore
          }
        }
      }
    } catch (e) {
      // Ignore
    }

    return {
      success: true,
      message: 'Hard reset complete - all SSH Lab state cleared',
      details: results
    };
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
  interfaces                      List all network interfaces
  scan                            Scan all network interfaces for SSH hosts
  scan-status                    Get current background scan status
  scan-stop                      Stop running background scan
  scan-clear                     Clear scan cache
  test                           Run continuous scans until Ctrl+C, tracking statistics
  toggle-on                      Enable toggle background scan (continuously scans)
  toggle-off                     Disable toggle background scan
  toggle-status                  Show toggle status and latest result
  toggle-config                  Update toggle scan configuration (restarts if on)
  hard-reset                     Complete cleanup: kill all processes, remove all files

Network Filter Options (for 'scan', 'test', 'toggle-on', 'toggle-config'):
  --qemu                        Only scan QEMU networks (10.10.10.0/24, 10.10.11.0/24)
  --whitelist=<cidr>            Only scan networks matching this CIDR (can be repeated)
  --blacklist=<cidr>            Exclude networks matching this CIDR (can be repeated)

Scan Options (for 'scan', 'toggle-on', 'toggle-config'):
  --background              Enable background scanning mode
  --force                   Force start new scan even if one is running
  --concurrency=<n>         Max concurrent connections (default: 500)
  --persistent-retries=<n>  Max retry scans for persistent hosts (default: 1)
  --max-inactive-scans=<n>  Max consecutive inactive scans before removal (default: 3)

Test Options (for 'test' method):
  --concurrency=<n>         Max concurrent connections (default: 500)
  --persistent-retries=<n>  Max retry scans for persistent hosts (default: 1)
  --max-inactive-scans=<n>  Max consecutive inactive scans before removal (default: 3)
  --min-unlocked=<n>        Minimum unlocked IPs required for success (default: 0, disabled)
  --min-accessible=<n>      Minimum accessible IPs required for success (default: 0, disabled)

Toggle Examples:
  node ssh-lab.mjs toggle-on --qemu
  node ssh-lab.mjs toggle-on --whitelist=10.10.10.0/24 --concurrency=1000
  node ssh-lab.mjs toggle-off
  node ssh-lab.mjs toggle-status
  node ssh-lab.mjs toggle-config --blacklist=192.168.0.0/16

Hard Reset:
  node ssh-lab.mjs hard-reset
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

        case 'interfaces': {
          const interfaceOptions = {
            qemuOnly: args.includes('--qemu'),
            whitelist: args.filter(a => a.startsWith('--whitelist=')).map(a => a.split('=')[1]),
            blacklist: args.filter(a => a.startsWith('--blacklist=')).map(a => a.split('=')[1])
          };
          
          result = SSH.listInterfaces(interfaceOptions);
          break;
        }

        case 'scan': {
          const scanConfig = {
            background: args.includes('--background'),
            forceNew: args.includes('--force'),
            qemu: args.includes('--qemu'),
            whitelist: args.filter(a => a.startsWith('--whitelist=')).map(a => a.split('=')[1]),
            blacklist: args.filter(a => a.startsWith('--blacklist=')).map(a => a.split('=')[1])
          };
          
          const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
          if (concurrencyArg) {
            scanConfig.concurrency = parseInt(concurrencyArg.split('=')[1]) || 500;
          }
          
          const persistentRetriesArg = args.find(a => a.startsWith('--persistent-retries='));
          const maxInactiveScansArg = args.find(a => a.startsWith('--max-inactive-scans='));
          
          if (persistentRetriesArg || maxInactiveScansArg) {
            scanConfig.persistentRetryConfig = {
              maxRetriesScans: persistentRetriesArg ? (parseInt(persistentRetriesArg.split('=')[1]) || 1) : 1,
              enhancedTimeout: 3000,
              enhancedRetries: 6,
              maxInactiveScans: maxInactiveScansArg ? (parseInt(maxInactiveScansArg.split('=')[1]) || 3) : 3
            };
          }
          
          result = await SSH.scanNetwork(scanConfig);
          break;
        }

        case 'test': {
          const testConfig = {
            concurrency: 500,
            minUnlocked: 0,
            minAccessible: 0,
            qemu: args.includes('--qemu'),
            whitelist: args.filter(a => a.startsWith('--whitelist=')).map(a => a.split('=')[1]),
            blacklist: args.filter(a => a.startsWith('--blacklist=')).map(a => a.split('=')[1])
          };
          
          const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
          if (concurrencyArg) {
            testConfig.concurrency = parseInt(concurrencyArg.split('=')[1]) || 500;
          }
          
          const minUnlockedArg = args.find(a => a.startsWith('--min-unlocked='));
          if (minUnlockedArg) {
            testConfig.minUnlocked = parseInt(minUnlockedArg.split('=')[1]) || 0;
          }
          
          const minAccessibleArg = args.find(a => a.startsWith('--min-accessible='));
          if (minAccessibleArg) {
            testConfig.minAccessible = parseInt(minAccessibleArg.split('=')[1]) || 0;
          }
          
          const persistentRetriesArg = args.find(a => a.startsWith('--persistent-retries='));
          const maxInactiveScansArg = args.find(a => a.startsWith('--max-inactive-scans='));
          
          if (persistentRetriesArg || maxInactiveScansArg) {
            testConfig.persistentRetryConfig = {
              maxRetriesScans: persistentRetriesArg ? (parseInt(persistentRetriesArg.split('=')[1]) || 1) : 1,
              enhancedTimeout: 3000,
              enhancedRetries: 6,
              maxInactiveScans: maxInactiveScansArg ? (parseInt(maxInactiveScansArg.split('=')[1]) || 3) : 3
            };
          }
          
          await SSH.testMode(testConfig);
          process.exit(0);
          break;
        }

        case 'toggle-on': {
          const toggleConfig = {
            concurrency: 500,
            networkFilter: {
              qemuOnly: args.includes('--qemu'),
              whitelist: args.filter(a => a.startsWith('--whitelist=')).map(a => a.split('=')[1]),
              blacklist: args.filter(a => a.startsWith('--blacklist=')).map(a => a.split('=')[1])
            }
          };
          
          const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
          if (concurrencyArg) {
            toggleConfig.concurrency = parseInt(concurrencyArg.split('=')[1]) || 500;
          }
          
          const persistentRetriesArg = args.find(a => a.startsWith('--persistent-retries='));
          const maxInactiveScansArg = args.find(a => a.startsWith('--max-inactive-scans='));
          
          if (persistentRetriesArg || maxInactiveScansArg) {
            toggleConfig.persistentRetryConfig = {
              maxRetriesScans: persistentRetriesArg ? (parseInt(persistentRetriesArg.split('=')[1]) || 1) : 1,
              enhancedTimeout: 3000,
              enhancedRetries: 6,
              maxInactiveScans: maxInactiveScansArg ? (parseInt(maxInactiveScansArg.split('=')[1]) || 3) : 3
            };
          }
          
          result = await SSH.toggleOn(toggleConfig);
          break;
        }

        case 'toggle-off': {
          result = await SSH.toggleOff();
          break;
        }

        case 'toggle-status': {
          result = await SSH.getToggleStatus();
          break;
        }

        case 'toggle-config': {
          const toggleConfig = {
            concurrency: 500,
            networkFilter: {
              qemuOnly: args.includes('--qemu'),
              whitelist: args.filter(a => a.startsWith('--whitelist=')).map(a => a.split('=')[1]),
              blacklist: args.filter(a => a.startsWith('--blacklist=')).map(a => a.split('=')[1])
            }
          };
          
          const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
          if (concurrencyArg) {
            toggleConfig.concurrency = parseInt(concurrencyArg.split('=')[1]) || 500;
          }
          
          const persistentRetriesArg = args.find(a => a.startsWith('--persistent-retries='));
          const maxInactiveScansArg = args.find(a => a.startsWith('--max-inactive-scans='));
          
          if (persistentRetriesArg || maxInactiveScansArg) {
            toggleConfig.persistentRetryConfig = {
              maxRetriesScans: persistentRetriesArg ? (parseInt(persistentRetriesArg.split('=')[1]) || 1) : 1,
              enhancedTimeout: 3000,
              enhancedRetries: 6,
              maxInactiveScans: maxInactiveScansArg ? (parseInt(maxInactiveScansArg.split('=')[1]) || 3) : 3
            };
          }
          
          result = await SSH.updateToggleConfig(toggleConfig);
          break;
        }

        case 'hard-reset': {
          result = await SSH.hardReset();
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
      
      if (result) {
        console.log(JSON.stringify(result, null, 2));
      }
      process.exit(result?.success ? 0 : 1);
      
    } catch (error) {
      console.error('Fatal error:', error.message);
      process.exit(1);
    }
  })();
}