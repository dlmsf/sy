// ssh-lab.mjs
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile, chmod, access, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

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

    // Try apt with retry
    for (let i = 0; i < 3; i++) {
      const result = await this._exec('apt-get update -qq 2>/dev/null && apt-get install -y -qq sshpass 2>/dev/null', { timeout: 60000 });
      if (result.success || result.stderr === '') {
        const checkResult = await this._exec('which sshpass');
        if (checkResult.success) return true;
      }
      if (i < 2) await new Promise(r => setTimeout(r, 2000));
    }

    // Try apk
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

      const configContent = 'Host *\n    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n    LogLevel ERROR\n';
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
   * Copy SSH key using sshpass (simpler and more reliable)
   */
  static async _copyKeySshpass(host, password, user) {
    const cmd = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh-copy-id -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host}`;
    const result = await this._exec(cmd);
    
    if (result.success) {
      return { success: true, method: 'sshpass', message: 'Key copied via sshpass' };
    }
    
    // Check if key was already there
    if (result.stderr.includes('already exist')) {
      return { success: true, method: 'sshpass', message: 'Key already exists on target' };
    }
    
    return { success: false, method: 'sshpass', error: result.stderr };
  }

  /**
   * Copy SSH key using pure bash with expect-like behavior
   */
  static async _copyKeyBash(host, password, user) {
    const tmpScript = `/tmp/ssh_copy_${Date.now()}.sh`;
    const escapedPassword = password.replace(/'/g, "'\\''");
    
    const scriptContent = `#!/bin/bash
# Create expect-like script using sshpass approach with /dev/tcp
# First, try direct ssh-copy-id with sshpass
export SSHPASS='${escapedPassword}'
sshpass -e ssh-copy-id -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} 2>&1
exit_code=$?
if [ $exit_code -eq 0 ]; then
  echo "SUCCESS: Key copied"
  exit 0
fi

# Check if key already exists
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
    
    // Try bash method first (if sshpass is available)
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
    
    // Fall back to bash method
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
    
    // Try nc as fallback
    const ncResult = await this._exec(`nc -zv -w2 ${host} ${port} 2>&1`);
    return ncResult.success || ncResult.stderr.includes('succeeded') || ncResult.stderr.includes('open');
  }

  /**
   * Test SSH connection and return detailed debug info
   */
  static async _testConnection(host, user, useKey = true) {
    const keyOpts = useKey ? '-o PasswordAuthentication=no -o BatchMode=yes' : '';
    const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${keyOpts} ${user}@${host} "echo 'CONNECTION_OK'" 2>&1`;
    
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
    
    // Step 0: Check reachability
    console.error('\n[Step 0] Checking if host is reachable...');
    const reachable = await this.checkAccess(host);
    if (!reachable) {
      console.error('[Step 0] Host not reachable');
      return { success: false, message: `Host ${host} not reachable on port 22` };
    }
    console.error('[Step 0] Host is reachable');

    // Step 1: Setup local SSH
    console.error('\n[Step 1] Setting up local SSH...');
    const setupResult = await this.setup();
    if (!setupResult.success) {
      console.error('[Step 1] Setup failed:', setupResult.message);
      return setupResult;
    }
    console.error('[Step 1] Setup complete:', setupResult.message);

    // Step 2: Test current connection status
    console.error('\n[Step 2] Testing current connection...');
    const preTest = await this._testConnection(host, user, true);
    
    if (preTest.success) {
      console.error('[Step 2] Passwordless SSH already working!');
      return { success: true, message: 'Passwordless SSH already configured and working' };
    }
    console.error('[Step 2] Passwordless SSH not working, will copy key');

    // Step 3: Copy SSH key
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

    // Step 4: Fix permissions on target
    console.error('\n[Step 4] Fixing permissions on target...');
    const fixCmd = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no ${user}@${host} "chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; restorecon -R ~/.ssh 2>/dev/null; echo 'PERMISSIONS_FIXED'" 2>&1`;
    const fixResult = await this._exec(fixCmd);
    console.error('[Step 4] Fix result:', fixResult.stdout, fixResult.stderr);

    // Step 5: Wait and verify with retries
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
      
      // On last attempt, try to diagnose the issue
      if (attempt === 5) {
        console.error('\n[Diagnosis] Checking target SSH configuration...');
        
        // Check if authorized_keys has our key
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

Examples:
  node ssh-lab.mjs setup
  node ssh-lab.mjs copy 10.10.10.10 password123 root
  node ssh-lab.mjs check 10.10.10.10
  node ssh-lab.mjs full 10.10.10.10 password123 root
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
          
        default:
          console.error(`Unknown method: ${method}`);
          console.log(usage);
          process.exit(1);
      }
      
      // Output final result as JSON
      console.log(JSON.stringify(result, null, 2));
      
      // Exit with appropriate code
      process.exit(result.success ? 0 : 1);
      
    } catch (error) {
      console.error('Fatal error:', error.message);
      process.exit(1);
    }
  })();
}