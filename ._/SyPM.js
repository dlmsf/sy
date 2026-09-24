import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

/**
 * Global base directory for SyPM configuration and data storage
 * @constant {string}
 */
const GLOBAL_BASE_DIR = path.join(os.homedir(), '.sypm');

/**
 * Path to the process registry JSON file
 * @constant {string}
 */
const PROCESS_REGISTRY = path.join(GLOBAL_BASE_DIR, 'processes.json');

/**
 * Directory for storing process log files
 * @constant {string}
 */
const LOG_DIR = path.join(GLOBAL_BASE_DIR, 'logs');

/**
 * Directory for storing daemon service files
 * @constant {string}
 */
const DAEMON_DIR = path.join(GLOBAL_BASE_DIR, 'daemons');

/**
 * Directory for cluster master logs
 * @constant {string}
 */
const CLUSTER_LOG_DIR = path.join(GLOBAL_BASE_DIR, 'cluster_logs');

// Ensure global directories exist
if (!fs.existsSync(GLOBAL_BASE_DIR)) {
    fs.mkdirSync(GLOBAL_BASE_DIR, { recursive: true });
}
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}
if (!fs.existsSync(DAEMON_DIR)) {
    fs.mkdirSync(DAEMON_DIR, { recursive: true });
}
if (!fs.existsSync(CLUSTER_LOG_DIR)) {
    fs.mkdirSync(CLUSTER_LOG_DIR, { recursive: true });
}
if (!fs.existsSync(PROCESS_REGISTRY)) {
    fs.writeFileSync(PROCESS_REGISTRY, '[]', 'utf-8');
}

/**
 * Main SyPM class for managing system processes
 * @class
 */
class SyPM {
    /**
     * Loads the process registry from the filesystem
     * @static
     * @private
     * @returns {Array<Object>} Array of process entries
     */
    static _loadRegistry() {
        try {
            const raw = fs.readFileSync(PROCESS_REGISTRY, 'utf-8');
            return JSON.parse(raw);
        } catch (error) {
            console.warn('Registry corrupted, resetting...');
            fs.writeFileSync(PROCESS_REGISTRY, '[]', 'utf-8');
            return [];
        }
    }

    /**
     * Saves the process registry to the filesystem
     * @static
     * @private
     * @param {Array<Object>} data - Process registry data to save
     */
    static _saveRegistry(data) {
        fs.writeFileSync(PROCESS_REGISTRY, JSON.stringify(data, null, 2));
    }

    /**
     * Generates a unique process ID
     * @static
     * @private
     * @returns {string} Unique process identifier
     */
    static _generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    /**
     * Generates a unique process name
     * @static
     * @private
     * @returns {string} Unique process name
     */
    static _generateProcessName() {
        return `process_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    }

    /**
     * Detects the current operating system and init system
     * @static
     * @private
     * @returns {Object} Object containing OS and init system information
     */
    static _detectSystem() {
        const platform = os.platform();
        let initSystem = 'unknown';
        let shell = 'bash';

        try {
            if (fs.existsSync('/proc/1/comm')) {
                const initProcess = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
                if (initProcess.includes('systemd')) {
                    initSystem = 'systemd';
                } else if (initProcess.includes('init')) {
                    initSystem = 'sysvinit';
                } else if (initProcess.includes('runit')) {
                    initSystem = 'runit';
                } else if (initProcess.includes('openrc')) {
                    initSystem = 'openrc';
                }
            }

            if (fs.existsSync('/etc/alpine-release')) {
                shell = 'ash';
            }

            if (fs.existsSync('/etc/systemd/system')) {
                initSystem = 'systemd';
            } else if (fs.existsSync('/etc/init.d')) {
                initSystem = 'sysvinit';
            } else if (fs.existsSync('/etc/runit')) {
                initSystem = 'runit';
            } else if (fs.existsSync('/etc/init')) {
                initSystem = 'upstart';
            }
        } catch (error) {
            console.warn('System detection failed, using defaults');
        }

        return {
            platform: platform,
            initSystem: initSystem,
            shell: shell,
            isLinux: platform === 'linux',
            isAlpine: fs.existsSync('/etc/alpine-release')
        };
    }

    /**
     * Recursively gets all child process IDs for a given parent PID
     * @static
     * @private
     * @param {number} pid - Parent process ID
     * @returns {Array<number>} Array of child process IDs
     */
    static _getAllChildPids(pid) {
        const childPids = [];
        try {
            if (os.platform() === 'win32') {
                const output = execSync(`wmic process where (ParentProcessId=${pid}) get ProcessId 2>nul`, { encoding: 'utf-8' });
                const pids = output.split('\n')
                    .filter(line => line.trim() && !isNaN(parseInt(line.trim())))
                    .map(pid => parseInt(pid.trim()));
                childPids.push(...pids);

                for (const childPid of pids) {
                    childPids.push(...this._getAllChildPids(childPid));
                }
            } else {
                const output = execSync(`pgrep -P ${pid} 2>/dev/null`, { encoding: 'utf-8' });
                const pids = output.split('\n')
                    .filter(line => line.trim())
                    .map(pid => parseInt(pid.trim()));
                childPids.push(...pids);

                for (const childPid of pids) {
                    childPids.push(...this._getAllChildPids(childPid));
                }
            }
        } catch (error) {
            // No child processes or command failed
        }
        return childPids;
    }

    /**
     * Kills a process tree including all child processes
     * @static
     * @private
     * @param {number} pid - Root process ID to kill
     * @returns {boolean} True if any processes were killed
     */
    static _killProcessTree(pid) {
        let killedCount = 0;

        try {
            const allPids = this._getAllChildPids(pid);
            const pidsToKill = [...allPids, pid];

            for (const processPid of pidsToKill) {
                try {
                    process.kill(processPid, 'SIGKILL');
                    killedCount++;
                } catch (error) {
                    if (error.code !== 'ESRCH') {
                        // Process doesn't exist, that's fine
                    }
                }
            }

            if (os.platform() === 'win32' && killedCount === 0) {
                try {
                    execSync(`taskkill /pid ${pid} /T /F 2>nul`);
                    killedCount = 1;
                } catch (error) {
                    // Ignore errors
                }
            }
        } catch (error) {
            // Ignore errors in process tree killing
        }

        return killedCount > 0;
    }

    /**
     * Checks if a process name is already in use and locked
     * @static
     * @private
     * @param {string} processName - Name to check
     * @param {boolean} uniqueNameLock - Whether unique name locking is enabled
     * @returns {boolean} True if name is already in use and locked
     */
    static _isNameLocked(processName, uniqueNameLock) {
        if (!uniqueNameLock) {
            return false;
        }

        const registry = this._loadRegistry();
        const existingProcess = registry.find(process =>
            process.name === processName &&
            process.config.uniqueNameLock === true &&
            this.isAlive(process.id)
        );

        return !!existingProcess;
    }

    /**
     * Creates a cluster wrapper script for scaled processes
     * @static
     * @private
     * @param {string} processId - Unique process identifier
     * @param {string} filePath - Path to the script file
     * @param {number} instances - Number of instances (0 = max CPUs)
     * @param {string} logPath - Path to the log file
     * @returns {string} Path to the created cluster wrapper script
     */
    static _createClusterWrapper(processId, filePath, instances, logPath) {
        const numInstances = instances === 0 ? os.cpus().length : instances;

        const wrapperContent = `
const cluster = require('cluster');
const os = require('os');
const path = require('path');

const numCPUs = ${numInstances};
const workerScript = '${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}';
const logFile = '${logPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}';

if (cluster.isMaster) {
    const fs = require('fs');
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    logStream.write(\`[Master \${process.pid}] Starting \${numCPUs} workers for: \${workerScript}\\n\`);
    console.log(\`[Master \${process.pid}] Starting \${numCPUs} workers for: \${workerScript}\`);
    
    for (let i = 0; i < numCPUs; i++) {
        const worker = cluster.fork();
        logStream.write(\`[Master \${process.pid}] Worker \${worker.process.pid} started (worker \${i + 1}/\${numCPUs})\\n\`);
        console.log(\`[Master \${process.pid}] Worker \${worker.process.pid} started (worker \${i + 1}/\${numCPUs})\`);
    }
    
    cluster.on('exit', (worker, code, signal) => {
        logStream.write(\`[Master \${process.pid}] Worker \${worker.process.pid} died (code: \${code}, signal: \${signal}). Restarting...\\n\`);
        console.log(\`[Master \${process.pid}] Worker \${worker.process.pid} died. Restarting...\`);
        cluster.fork();
    });
    
    cluster.on('online', (worker) => {
        logStream.write(\`[Master \${process.pid}] Worker \${worker.process.pid} is online\\n\`);
    });
    
    process.on('SIGTERM', () => {
        logStream.write(\`[Master \${process.pid}] Received SIGTERM, shutting down cluster...\\n\`);
        for (const id in cluster.workers) {
            cluster.workers[id].kill();
        }
        process.exit(0);
    });
} else {
    require(workerScript);
}
`;

        const wrapperPath = path.join(CLUSTER_LOG_DIR, `cluster_wrapper_${processId}.js`);
        fs.writeFileSync(wrapperPath, wrapperContent, 'utf-8');
        return wrapperPath;
    }

    /**
     * Creates a monitor script for auto-restart processes
     * @static
     * @private
     * @param {string} processId - Unique process identifier
     * @param {string} filePath - Path to the script file to monitor
     * @param {string} processName - Name of the process
     * @param {string} logPath - Path to the log file
     * @param {boolean} autoRestart - Whether to auto-restart the process
     * @param {number} restartTries - Number of restart attempts
     * @param {string} [workingDir] - Optional working directory
     * @param {boolean} [daemon] - Whether to run as daemon
     * @param {boolean} [uniqueNameLock] - Whether to lock the process name as unique
     * @param {number} [instances] - Number of cluster instances (0 = max)
     * @returns {string} Path to the created monitor script
     */
    static _createMonitorScript(processId, filePath, processName, logPath, autoRestart, restartTries, workingDir, daemon = false, uniqueNameLock = false, instances = 1) {
        const systemInfo = this._detectSystem();
        const shell = systemInfo.shell;

        const escapedRegistryPath = PROCESS_REGISTRY.replace(/'/g, "'\\''");
        const escapedFilePath = filePath.replace(/'/g, "'\\''");
        const escapedLogPath = logPath.replace(/'/g, "'\\''");
        const escapedWorkingDir = workingDir ? workingDir.replace(/'/g, "'\\''") : '';

        const scriptContent = `#!/usr/bin/env ${shell}

PROCESS_ID='${processId}'
FILE_PATH='${escapedFilePath}'
PROCESS_NAME='${processName}'
LOG_PATH='${escapedLogPath}'
AUTO_RESTART=${autoRestart ? 'true' : 'false'}
RESTART_TRIES=${restartTries || 0}
REGISTRY_PATH='${escapedRegistryPath}'
WORKING_DIR='${escapedWorkingDir}'
CURRENT_TRIES=0
MAX_RETRIES=${restartTries > 0 ? restartTries : 999999}
INSTANCES=${instances || 1}

echo "=== PROCESS MONITOR STARTED ===" >> "$LOG_PATH"
echo "Process: $PROCESS_NAME (ID: $PROCESS_ID)" >> "$LOG_PATH"
echo "Auto-restart: $AUTO_RESTART" >> "$LOG_PATH"
echo "Max restarts: $MAX_RETRIES" >> "$LOG_PATH"
echo "Working Directory: $WORKING_DIR" >> "$LOG_PATH"
echo "Instances: $INSTANCES" >> "$LOG_PATH"
echo "Started at: \$(date)" >> "$LOG_PATH"
echo "Registry: $REGISTRY_PATH" >> "$LOG_PATH"
echo "=================================" >> "$LOG_PATH"

update_registry() {
    local status="\$1"
    local node_pid="\$2"
    local current_tries="\$3"
    
    cat > /tmp/update_registry_$$.js << EOF
const fs = require('fs');
try {
    const registryPath = '${escapedRegistryPath}';
    if (fs.existsSync(registryPath)) {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        const processIndex = registry.findIndex(p => p.id === '${processId}');
        if (processIndex !== -1) {
            registry[processIndex].status = '\$status';
            if ('\$node_pid' && '\$node_pid' !== 'null') {
                registry[processIndex].pid = parseInt('\$node_pid');
            }
            registry[processIndex].monitorPid = $$;
            registry[processIndex].config.currentTries = parseInt('\$current_tries');
            registry[processIndex].lastUpdate = new Date().toISOString();
            fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
            console.log('Registry updated:', '\$status');
        }
    }
} catch (error) {
    console.error('Registry update failed:', error.message);
}
EOF
    
    node /tmp/update_registry_$$.js >> "$LOG_PATH" 2>&1
    rm -f /tmp/update_registry_$$.js
}

should_continue() {
    cat > /tmp/check_registry_$$.js << EOF
const fs = require('fs');
try {
    const registryPath = '${escapedRegistryPath}';
    if (fs.existsSync(registryPath)) {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        const process = registry.find(p => p.id === '${processId}');
        if (!process) {
            console.log('Process not found in registry');
            process.exit(1);
        }
        if (process.status === 'stopped' || process.status === 'dead') {
            console.log('Process status is stopped/dead:', process.status);
            process.exit(1);
        }
        console.log('Process status OK:', process.status);
        process.exit(0);
    } else {
        console.log('Registry file not found');
        process.exit(1);
    }
} catch (e) {
    console.log('Registry check error:', e.message);
    process.exit(0);
}
EOF
    
    node /tmp/check_registry_$$.js >> "$LOG_PATH" 2>&1
    local result=\$?
    rm -f /tmp/check_registry_$$.js
    return \$result
}

start_and_monitor() {
    local attempt=\$1
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Starting process - Attempt: \$((attempt + 1))/\$MAX_RETRIES" >> "\$LOG_PATH"
    
    local cd_command=""
    if [ -n "\$WORKING_DIR" ] && [ -d "\$WORKING_DIR" ]; then
        cd_command="cd '\$WORKING_DIR' && "
        echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Working directory: \$WORKING_DIR" >> "\$LOG_PATH"
    fi
    
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Executing: \${cd_command}node '\$FILE_PATH'" >> "\$LOG_PATH"
    eval "\${cd_command}node '\$FILE_PATH'" >> "\$LOG_PATH" 2>&1 &
    local NODE_PID=\$!
    
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Process started with PID: \$NODE_PID" >> "\$LOG_PATH"
    
    update_registry "running" "\$NODE_PID" "\$attempt"
    
    wait \$NODE_PID
    local exit_code=\$?
    
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Process exited with code: \$exit_code" >> "\$LOG_PATH"
    
    return \$exit_code
}

main() {
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Monitor starting for process: \$PROCESS_NAME" >> "\$LOG_PATH"
    
    while true; do
        if ! should_continue; then
            echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Monitor stopped by registry - process should not continue" >> "\$LOG_PATH"
            update_registry "dead" "null" "\$CURRENT_TRIES"
            break
        fi
        
        start_and_monitor \$CURRENT_TRIES
        local exit_code=\$?
        
        if [ "\$AUTO_RESTART" = "true" ] && [ \$CURRENT_TRIES -lt \$((MAX_RETRIES - 1)) ]; then
            CURRENT_TRIES=\$((CURRENT_TRIES + 1))
            echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Auto-restarting... Attempt: \$CURRENT_TRIES/\$MAX_RETRIES" >> "\$LOG_PATH"
            update_registry "restarting" "null" "\$CURRENT_TRIES"
            sleep 2
        else
            echo "[\$(date +'%Y-%m-%d %H:%M:%S')] No more restart attempts. Final status." >> "\$LOG_PATH"
            update_registry "dead" "null" "\$CURRENT_TRIES"
            break
        fi
    done
    
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Monitor stopped for process: \$PROCESS_NAME" >> "\$LOG_PATH"
}

main
`;

        const scriptPath = path.join(LOG_DIR, `monitor_${processId}.sh`);
        fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
        fs.chmodSync(scriptPath, 0o755);
        return scriptPath;
    }

    /**
     * Checks if a daemon service is currently running on the host init system.
     * Note: enabling a daemon (for auto-start on boot) does NOT start it, so we
     * must query the runtime state of the service, not just its enablement.
     * @static
     * @private
     * @param {string} processId - Unique process identifier
     * @returns {boolean} True if the init-system service is active/running
     */
    static _isDaemonServiceRunning(processId) {
        const systemInfo = this._detectSystem();
        try {
            if (systemInfo.initSystem === 'systemd') {
                const serviceName = `sypm-${processId}.service`;
                const output = execSync(`systemctl is-active ${serviceName} 2>/dev/null`, { encoding: 'utf-8' }).trim();
                return output === 'active';
            } else if (systemInfo.initSystem === 'openrc') {
                const serviceName = `sypm-${processId}`;
                const output = execSync(`rc-service ${serviceName} status 2>/dev/null`, { encoding: 'utf-8' });
                return output.includes('started') || output.includes('running');
            }
        } catch (_) {
            // Service not installed / init system unsupported
        }
        return false;
    }

    /**
     * Checks if a tracked PID is currently alive
     * @static
     * @private
     * @param {number} pid - Process ID
     * @returns {boolean} True if the process is alive
     */
    static _isPidAlive(pid) {
        if (!pid) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Determines whether a daemon-managed process is alive.
     * A daemon process is considered alive when ANY of the following is true:
     *   - its tracked PID is alive
     *   - its monitor PID (auto-restart wrapper) is alive
     *   - the underlying init-system service is active
     * This prevents the false "dead" reports that happened when the service
     * was only enabled (for boot auto-start) but the spawned process was the
     * one actually running.
     * @static
     * @private
     * @param {Object} proc - Registry process entry
     * @returns {boolean} True if the daemon process is running
     */
    static _isDaemonProcessAlive(proc) {
        if (this._isPidAlive(proc.pid)) return true;
        if (proc.monitorPid && proc.monitorPid !== proc.pid && this._isPidAlive(proc.monitorPid)) return true;
        if (this._isDaemonServiceRunning(proc.id)) return true;
        return false;
    }

    /**
     * Syncs daemon processes status with system services
     * @static
     * @private
     */
    static _syncDaemonStatus() {
        const registry = this._loadRegistry();
        let updated = false;

        for (const proc of registry) {
            if (proc.config?.daemon) {
                const isRunning = this._isDaemonProcessAlive(proc);

                if (isRunning && proc.status !== 'running') {
                    proc.status = 'running';
                    updated = true;
                    console.log(`✓ Updated status for daemon process ${proc.name}: running`);
                } else if (!isRunning && (proc.status === 'running' || proc.status === 'restarting')) {
                    proc.status = 'dead';
                    updated = true;
                    console.log(`✓ Updated status for daemon process ${proc.name}: dead`);
                }
            }
        }

        if (updated) {
            this._saveRegistry(registry);
        }
    }

    /**
     * Creates a systemd service file for daemon processes
     * @static
     * @private
     * @param {string} processId - Unique process identifier
     * @param {string} processName - Name of the process
     * @param {string} filePath - Path to the script file
     * @param {string} workingDir - Working directory for the process
     * @param {string} logPath - Path to the log file
     * @returns {string} Path to the created service file
     */
    static _createSystemdService(processId, processName, filePath, workingDir, logPath) {
        const serviceContent = `[Unit]
Description=SyPM Managed Process: ${processName}
After=network.target

[Service]
Type=simple
User=${os.userInfo().username}
WorkingDirectory=${workingDir || path.dirname(filePath)}
ExecStart=/usr/bin/node ${filePath}
Restart=always
RestartSec=3
StandardOutput=append:${logPath}
StandardError=append:${logPath}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;

        const servicePath = path.join(DAEMON_DIR, `sypm-${processId}.service`);
        fs.writeFileSync(servicePath, serviceContent, 'utf-8');
        return servicePath;
    }

    /**
     * Creates an OpenRC init script for daemon processes
     * @static
     * @private
     * @param {string} processId - Unique process identifier
     * @param {string} processName - Name of the process
     * @param {string} filePath - Path to the script file
     * @param {string} workingDir - Working directory for the process
     * @param {string} logPath - Path to the log file
     * @returns {string} Path to the created init script
     */
    static _createOpenRCInitScript(processId, processName, filePath, workingDir, logPath) {
        const initScriptContent = `#!/sbin/openrc-run

name="sypm-${processId}"
description="SyPM Managed Process: ${processName}"
pidfile="/var/run/sypm-${processId}.pid"

command="/usr/bin/node"
command_args="${filePath}"
command_background=true

depend() {
    need net
}

start() {
    ebegin "Starting ${processName}"
    start-stop-daemon --start \\
        --pidfile "\${pidfile}" \\
        --make-pidfile \\
        --background \\
        --user ${os.userInfo().username} \\
        --chdir "${workingDir || path.dirname(filePath)}" \\
        --exec /usr/bin/node -- ${filePath} >> ${logPath} 2>&1
    eend \$?
}

stop() {
    ebegin "Stopping ${processName}"
    start-stop-daemon --stop --pidfile "\${pidfile}"
    eend \$?
}
`;

        const initScriptPath = path.join(DAEMON_DIR, `sypm-${processId}`);
        fs.writeFileSync(initScriptPath, initScriptContent, 'utf-8');
        fs.chmodSync(initScriptPath, 0o755);
        return initScriptPath;
    }

    /**
     * Enables a process to start automatically on system boot
     * @static
     * @private
     * @param {string} processId - Unique process identifier
     * @param {Object} processInfo - Process information object
     * @returns {boolean} True if daemon setup was successful
     */
    static _enableDaemon(processId, processInfo) {
        const systemInfo = this._detectSystem();

        if (!systemInfo.isLinux) {
            console.log('⚠️  Daemon mode is only supported on Linux systems');
            return false;
        }

        try {
            if (systemInfo.initSystem === 'systemd') {
                const servicePath = this._createSystemdService(
                    processId,
                    processInfo.name,
                    processInfo.path,
                    processInfo.config.workingDir,
                    processInfo.log
                );

                const systemServicePath = `/etc/systemd/system/sypm-${processId}.service`;
                execSync(`sudo cp "${servicePath}" "${systemServicePath}"`);
                execSync('sudo systemctl daemon-reload');
                execSync(`sudo systemctl enable sypm-${processId}.service`);

                console.log(`✓ Systemd service created and enabled: sypm-${processId}.service`);
                return true;

            } else if (systemInfo.initSystem === 'openrc') {
                const initScriptPath = this._createOpenRCInitScript(
                    processId,
                    processInfo.name,
                    processInfo.path,
                    processInfo.config.workingDir,
                    processInfo.log
                );

                const systemInitPath = `/etc/init.d/sypm-${processId}`;
                execSync(`sudo cp "${initScriptPath}" "${systemInitPath}"`);
                execSync(`sudo rc-update add sypm-${processId} default`);

                console.log(`✓ OpenRC init script created and enabled: sypm-${processId}`);
                return true;

            } else {
                console.log(`⚠️  Unsupported init system: ${systemInfo.initSystem}`);
                console.log('⚠️  Daemon mode requires systemd or OpenRC');
                return false;
            }
        } catch (error) {
            console.log(`⚠️  Failed to enable daemon mode: ${error.message}`);
            console.log('⚠️  You may need to run with sudo privileges');
            return false;
        }
    }

    /**
     * Disables a process from starting automatically on system boot
     * @static
     * @private
     * @param {string} processId - Unique process identifier
     * @returns {boolean} True if daemon was successfully disabled
     */
    static _disableDaemon(processId) {
        const systemInfo = this._detectSystem();

        if (!systemInfo.isLinux) {
            return false;
        }

        try {
            if (systemInfo.initSystem === 'systemd') {
                const serviceName = `sypm-${processId}.service`;
                execSync(`sudo systemctl disable ${serviceName} 2>/dev/null || true`);
                execSync(`sudo rm -f /etc/systemd/system/${serviceName}`);
                execSync('sudo systemctl daemon-reload');
                console.log(`✓ Systemd service disabled and removed: ${serviceName}`);
                return true;

            } else if (systemInfo.initSystem === 'openrc') {
                const serviceName = `sypm-${processId}`;
                execSync(`sudo rc-update del ${serviceName} 2>/dev/null || true`);
                execSync(`sudo rm -f /etc/init.d/${serviceName}`);
                console.log(`✓ OpenRC init script disabled and removed: ${serviceName}`);
                return true;

            } else {
                return false;
            }
        } catch (error) {
            console.log(`⚠️  Failed to disable daemon mode: ${error.message}`);
            return false;
        }
    }

    /**
     * Creates a PTY wrapper script that provides a pseudo-terminal for the child process
     * @static
     * @private
     * @param {string} processId - Unique process identifier
     * @param {string} command - The command to execute
     * @param {string} logPath - Path to the log file
     * @param {string} [workingDir] - Optional working directory
     * @returns {string} Path to the created PTY wrapper script
     */
    static _createPtyWrapperScript(processId, command, logPath, workingDir) {
        const systemInfo = this._detectSystem();
        const shell = systemInfo.shell;

        const escapedCommand = command.replace(/'/g, "'\\''");
        const escapedLogPath = logPath.replace(/'/g, "'\\''");
        const escapedWorkingDir = workingDir ? workingDir.replace(/'/g, "'\\''") : '';

        const scriptContent = `#!/usr/bin/env ${shell}
# SyPM PTY Wrapper Script
# Provides a pseudo-terminal for the child process so it can initialize
# interactive features (readline, CLI menus) while running in background

COMMAND='${escapedCommand}'
LOG_PATH='${escapedLogPath}'
WORKING_DIR='${escapedWorkingDir}'

export TERM=xterm-256color
export FORCE_COLOR=1
export COLORTERM=truecolor

if [ -n "$WORKING_DIR" ] && [ -d "$WORKING_DIR" ]; then
    cd "$WORKING_DIR" || exit 1
fi

echo "=== PTY WRAPPER STARTED ===" >> "$LOG_PATH"
echo "Command: $COMMAND" >> "$LOG_PATH"
echo "Working Directory: $(pwd)" >> "$LOG_PATH"
echo "TERM: $TERM" >> "$LOG_PATH"
echo "Started at: $(date)" >> "$LOG_PATH"
echo "===========================" >> "$LOG_PATH"

# Try multiple methods to create a pseudo-terminal
if command -v script &> /dev/null; then
    echo "Using 'script' command for PTY" >> "$LOG_PATH"
    SHELL=/bin/bash script -q -c "$COMMAND" /dev/null >> "$LOG_PATH" 2>&1
elif command -v unbuffer &> /dev/null; then
    echo "Using 'unbuffer' command for PTY" >> "$LOG_PATH"
    unbuffer $COMMAND >> "$LOG_PATH" 2>&1
elif command -v stdbuf &> /dev/null; then
    echo "Using 'stdbuf' for line buffering" >> "$LOG_PATH"
    stdbuf -oL $COMMAND >> "$LOG_PATH" 2>&1
else
    echo "No PTY tools available, running directly" >> "$LOG_PATH"
    eval "$COMMAND" >> "$LOG_PATH" 2>&1
fi

EXIT_CODE=$?
echo "Command exited with code: $EXIT_CODE" >> "$LOG_PATH"
exit $EXIT_CODE
`;

        const scriptPath = path.join(LOG_DIR, `pty_wrapper_${processId}.sh`);
        fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
        fs.chmodSync(scriptPath, 0o755);
        return scriptPath;
    }

    /**
     * Executes a global command line as a managed background process.
     * Uses a pseudo-terminal (PTY) wrapper to allow interactive CLIs (readline, menus)
     * to initialize properly while running detached from the parent terminal.
     * @static
     * @param {string} command - The command to execute (e.g., 'myapp-server', 'python script.py')
     * @param {Object} [config={}] - Configuration options for the process
     * @param {string} [config.name] - Custom name for the process
     * @param {boolean} [config.autoRestart] - Whether to auto-restart the process on crash
     * @param {number} [config.restartTries] - Number of restart attempts (implies autoRestart)
     * @param {string} [config.workingDir] - Working directory to run the process in
     * @param {boolean} [config.daemon] - Whether to run as system daemon (auto-start on boot)
     * @param {boolean} [config.uniqueNameLock] - Whether to lock the process name as unique
     * @param {Array<string>} [config.commandArgs] - Additional arguments to pass to the command
     * @returns {Object} Process entry object with process details
     * @throws {Error} If command is empty or invalid
     */
    static exec(command, config = {}) {
        if (!command || typeof command !== 'string' || command.trim().length === 0) {
            throw new Error('Command cannot be empty');
        }

        const systemInfo = this._detectSystem();
        const id = this._generateId();
        const processName = config.name || `cmd_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const logPath = path.join(LOG_DIR, `${processName}.log`);

        if (config.uniqueNameLock && this._isNameLocked(processName, config.uniqueNameLock)) {
            throw new Error(`Process name "${processName}" is already in use and locked as unique. Cannot start another process with the same name.`);
        }

        fs.writeFileSync(logPath, `Global Command Execution - Started: ${new Date().toISOString()}\nCommand: ${command}\n`, 'utf-8');

        const commandParts = command.trim().split(/\s+/);
        const executable = commandParts[0];
        const args = commandParts.slice(1);

        if (config.commandArgs && Array.isArray(config.commandArgs)) {
            args.push(...config.commandArgs);
        }

        let child;
        let actualPid;
        let workingDir = config.workingDir || null;

        if (workingDir) {
            workingDir = path.resolve(workingDir);
            if (!fs.existsSync(workingDir)) {
                throw new Error(`Working directory does not exist: ${workingDir}`);
            }
            if (!fs.statSync(workingDir).isDirectory()) {
                throw new Error(`Working directory is not a directory: ${workingDir}`);
            }
        }

        if (config.autoRestart || config.restartTries) {
            const wrapperScript = this._createCommandMonitorScript(
                id,
                command,
                processName,
                logPath,
                config.autoRestart ? 'true' : 'false',
                config.restartTries || 0,
                workingDir
            );

            child = spawn(systemInfo.shell, [wrapperScript], {
                detached: true,
                stdio: 'ignore'
            });

            actualPid = child.pid;
            child.unref();

            console.log(`✓ Started monitor for command with PID: ${actualPid} using ${systemInfo.shell}`);
        } else {
            // Create PTY wrapper script for proper TTY environment
            const ptyWrapperPath = this._createPtyWrapperScript(id, command, logPath, workingDir);

            const spawnOptions = {
                detached: true,
                stdio: 'ignore',
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    FORCE_COLOR: '1',
                    COLORTERM: 'truecolor'
                }
            };

            if (workingDir) {
                spawnOptions.cwd = workingDir;
            }

            child = spawn(systemInfo.shell, [ptyWrapperPath], spawnOptions);

            actualPid = child.pid;
            child.unref();

            console.log(`✓ Started background command with PID: ${actualPid}`);
            console.log(`✓ PTY wrapper enabled for readline/CLI support`);
            console.log(`✓ Output logged to: ${logPath}`);
        }

        const entry = {
            id,
            pid: actualPid,
            name: processName,
            path: command,
            log: logPath,
            createdAt: new Date().toISOString(),
            status: 'running',
            type: 'global_command',
            config: {
                autoRestart: !!config.autoRestart,
                restartTries: config.restartTries || 0,
                currentTries: 0,
                workingDir: workingDir,
                daemon: !!config.daemon,
                uniqueNameLock: !!config.uniqueNameLock,
                command: command,
                shell: systemInfo.shell,
                commandArgs: config.commandArgs || []
            },
            isAutoRestart: !!(config.autoRestart || config.restartTries),
            isGlobalCommand: true,
            monitorPid: (config.autoRestart || config.restartTries) ? actualPid : null,
            lastUpdate: new Date().toISOString()
        };

        const registry = this._loadRegistry();
        registry.push(entry);
        this._saveRegistry(registry);

        if (config.daemon) {
            const daemonSuccess = this._enableDaemon(id, entry);
            if (daemonSuccess) {
                console.log(`✓ Daemon mode enabled for command: ${processName}`);
                console.log(`✓ Process will auto-start on system reboot`);
            }
        }

        if (config.uniqueNameLock) {
            console.log(`✓ Unique name lock enabled for command: ${processName}`);
            console.log(`✓ No other process can use this name while this process exists`);
        }

        return entry;
    }

    /**
     * Creates a monitor script for auto-restart global commands
     * @static
     * @private
     * @param {string} processId - Unique process identifier
     * @param {string} command - The command to execute
     * @param {string} processName - Name of the process
     * @param {string} logPath - Path to the log file
     * @param {boolean} autoRestart - Whether to auto-restart the process
     * @param {number} restartTries - Number of restart attempts
     * @param {string} [workingDir] - Optional working directory
     * @returns {string} Path to the created monitor script
     */
    static _createCommandMonitorScript(processId, command, processName, logPath, autoRestart, restartTries, workingDir) {
        const systemInfo = this._detectSystem();
        const shell = systemInfo.shell;

        const escapedRegistryPath = PROCESS_REGISTRY.replace(/'/g, "'\\''");
        const escapedLogPath = logPath.replace(/'/g, "'\\''");
        const escapedWorkingDir = workingDir ? workingDir.replace(/'/g, "'\\''") : '';

        const scriptContent = `#!/usr/bin/env ${shell}

PROCESS_ID='${processId}'
COMMAND='${command.replace(/'/g, "'\\''")}'
PROCESS_NAME='${processName}'
LOG_PATH='${escapedLogPath}'
AUTO_RESTART=${autoRestart ? 'true' : 'false'}
RESTART_TRIES=${restartTries || 0}
REGISTRY_PATH='${escapedRegistryPath}'
WORKING_DIR='${escapedWorkingDir}'
CURRENT_TRIES=0
MAX_RETRIES=${restartTries > 0 ? restartTries : 999999}

export TERM=xterm-256color
export FORCE_COLOR=1
export COLORTERM=truecolor

echo "=== GLOBAL COMMAND MONITOR STARTED ===" >> "$LOG_PATH"
echo "Process: $PROCESS_NAME (ID: $PROCESS_ID)" >> "$LOG_PATH"
echo "Command: $COMMAND" >> "$LOG_PATH"
echo "Auto-restart: $AUTO_RESTART" >> "$LOG_PATH"
echo "Max restarts: $MAX_RETRIES" >> "$LOG_PATH"
echo "Working Directory: $WORKING_DIR" >> "$LOG_PATH"
echo "Started at: \$(date)" >> "$LOG_PATH"
echo "=================================" >> "$LOG_PATH"

update_registry() {
    local status="\$1"
    local node_pid="\$2"
    local current_tries="\$3"
    
    cat > /tmp/update_registry_$$.js << EOF
const fs = require('fs');
try {
    const registryPath = '${escapedRegistryPath}';
    if (fs.existsSync(registryPath)) {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        const processIndex = registry.findIndex(p => p.id === '${processId}');
        if (processIndex !== -1) {
            registry[processIndex].status = '\$status';
            if ('\$node_pid' && '\$node_pid' !== 'null') {
                registry[processIndex].pid = parseInt('\$node_pid');
            }
            registry[processIndex].monitorPid = $$;
            registry[processIndex].config.currentTries = parseInt('\$current_tries');
            registry[processIndex].lastUpdate = new Date().toISOString();
            fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
            console.log('Registry updated:', '\$status');
        }
    }
} catch (error) {
    console.error('Registry update failed:', error.message);
}
EOF
    
    node /tmp/update_registry_$$.js >> "$LOG_PATH" 2>&1
    rm -f /tmp/update_registry_$$.js
}

should_continue() {
    cat > /tmp/check_registry_$$.js << EOF
const fs = require('fs');
try {
    const registryPath = '${escapedRegistryPath}';
    if (fs.existsSync(registryPath)) {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        const process = registry.find(p => p.id === '${processId}');
        if (!process) {
            console.log('Process not found in registry');
            process.exit(1);
        }
        if (process.status === 'stopped' || process.status === 'dead') {
            console.log('Process status is stopped/dead:', process.status);
            process.exit(1);
        }
        console.log('Process status OK:', process.status);
        process.exit(0);
    } else {
        console.log('Registry file not found');
        process.exit(1);
    }
} catch (e) {
    console.log('Registry check error:', e.message);
    process.exit(0);
}
EOF
    
    node /tmp/check_registry_$$.js >> "$LOG_PATH" 2>&1
    local result=\$?
    rm -f /tmp/check_registry_$$.js
    return \$result
}

start_and_monitor() {
    local attempt=\$1
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Starting command - Attempt: \$((attempt + 1))/\$MAX_RETRIES" >> "\$LOG_PATH"
    
    if [ -n "\$WORKING_DIR" ] && [ -d "\$WORKING_DIR" ]; then
        cd "\$WORKING_DIR"
        echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Working directory: \$WORKING_DIR" >> "\$LOG_PATH"
    fi
    
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Executing: \$COMMAND" >> "\$LOG_PATH"
    
    # Use PTY wrapper for proper TTY environment
    if command -v script &> /dev/null; then
        SHELL=/bin/bash script -q -c "\$COMMAND" /dev/null >> "\$LOG_PATH" 2>&1 &
    elif command -v unbuffer &> /dev/null; then
        unbuffer \$COMMAND >> "\$LOG_PATH" 2>&1 &
    else
        eval "\$COMMAND" >> "\$LOG_PATH" 2>&1 &
    fi
    
    local CMD_PID=\$!
    
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Command started with PID: \$CMD_PID" >> "\$LOG_PATH"
    
    update_registry "running" "\$CMD_PID" "\$attempt"
    
    wait \$CMD_PID
    local exit_code=\$?
    
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Command exited with code: \$exit_code" >> "\$LOG_PATH"
    
    return \$exit_code
}

main() {
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Monitor starting for command: \$PROCESS_NAME" >> "\$LOG_PATH"
    
    while true; do
        if ! should_continue; then
            echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Monitor stopped by registry - command should not continue" >> "\$LOG_PATH"
            update_registry "dead" "null" "\$CURRENT_TRIES"
            break
        fi
        
        start_and_monitor \$CURRENT_TRIES
        local exit_code=\$?
        
        if [ "\$AUTO_RESTART" = "true" ] && [ \$CURRENT_TRIES -lt \$((MAX_RETRIES - 1)) ]; then
            CURRENT_TRIES=\$((CURRENT_TRIES + 1))
            echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Auto-restarting... Attempt: \$CURRENT_TRIES/\$MAX_RETRIES" >> "\$LOG_PATH"
            update_registry "restarting" "null" "\$CURRENT_TRIES"
            sleep 2
        else
            echo "[\$(date +'%Y-%m-%d %H:%M:%S')] No more restart attempts. Final status." >> "\$LOG_PATH"
            update_registry "dead" "null" "\$CURRENT_TRIES"
            break
        fi
    done
    
    echo "[\$(date +'%Y-%m-%d %H:%M:%S')] Monitor stopped for command: \$PROCESS_NAME" >> "\$LOG_PATH"
}

main
`;

        const scriptPath = path.join(LOG_DIR, `monitor_cmd_${processId}.sh`);
        fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
        fs.chmodSync(scriptPath, 0o755);
        return scriptPath;
    }

    /**
     * Runs a Node.js script as a managed background process
     * @static
     * @param {string} filepathOrCode - File path to the script or JavaScript code string
     * @param {Object} [config={}] - Configuration options for the process
     * @param {string} [config.name] - Custom name for the process
     * @param {boolean} [config.autoRestart] - Whether to auto-restart the process on crash
     * @param {number} [config.restartTries] - Number of restart attempts (implies autoRestart)
     * @param {string} [config.workingDir] - Working directory to run the process in
     * @param {boolean} [config.daemon] - Whether to run as system daemon (auto-start on boot)
     * @param {boolean} [config.uniqueNameLock] - Whether to lock the process name as unique
     * @param {number} [config.instances] - Number of cluster instances to run (0 = max CPUs, 1 = single process)
     * @returns {Object} Process entry object with process details
     * @throws {Error} If file not found or working directory is invalid
     */
    static run(filepathOrCode, config = {}) {
        let resolvedPath;
        let isTempFile = false;
        let tempFilePath = null;
        let workingDir = config.workingDir || null;

        if (workingDir) {
            workingDir = path.resolve(workingDir);
            if (!fs.existsSync(workingDir)) {
                throw new Error(`Working directory does not exist: ${workingDir}`);
            }
            if (!fs.statSync(workingDir).isDirectory()) {
                throw new Error(`Working directory is not a directory: ${workingDir}`);
            }
        }

        if (typeof filepathOrCode === 'string' &&
            (filepathOrCode.includes('function') ||
             filepathOrCode.includes('const ') ||
             filepathOrCode.includes('let ') ||
             filepathOrCode.includes('var ') ||
             filepathOrCode.includes('require(') ||
             filepathOrCode.includes('import ') ||
             filepathOrCode.includes('export ') ||
             filepathOrCode.trim().startsWith('//') ||
             filepathOrCode.trim().startsWith('/*') ||
             filepathOrCode.includes('console.log'))) {

            isTempFile = true;

            const isESM = (filepathOrCode.includes('import ') && !filepathOrCode.includes('require(')) ||
                         filepathOrCode.includes('export ');

            const extension = isESM ? '.mjs' : '.js';
            const tempName = config.name ? `sypm_${config.name}_${Date.now()}${extension}` : `sypm_temp_${Date.now()}${extension}`;

            if (workingDir) {
                tempFilePath = path.join(workingDir, tempName);
            } else {
                tempFilePath = path.join(tmpdir(), tempName);
            }

            fs.writeFileSync(tempFilePath, filepathOrCode, 'utf-8');
            resolvedPath = tempFilePath;

            console.log(`✓ Created temporary ${isESM ? 'ESM' : 'CommonJS'} file: ${tempFilePath}`);
            if (workingDir) {
                console.log(`✓ Running in working directory: ${workingDir}`);
            }
        } else {
            resolvedPath = path.resolve(filepathOrCode);
            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`File not found: ${resolvedPath}`);
            }

            if (workingDir && path.dirname(resolvedPath) !== workingDir) {
                isTempFile = true;
                const fileName = path.basename(resolvedPath);
                tempFilePath = path.join(workingDir, fileName);

                fs.copyFileSync(resolvedPath, tempFilePath);
                resolvedPath = tempFilePath;

                console.log(`✓ Copied file to working directory: ${workingDir}`);
            }
        }

        const instances = config.instances !== undefined ? config.instances : 1;
        let actualScriptPath = resolvedPath;

        if (instances > 1 || instances === 0) {
            const numInstances = instances === 0 ? os.cpus().length : instances;
            console.log(`✓ Cluster mode enabled: ${numInstances} instances`);

            const wrapperPath = this._createClusterWrapper(
                this._generateId(),
                resolvedPath,
                instances,
                path.join(LOG_DIR, `${config.name || 'process'}.log`)
            );
            actualScriptPath = wrapperPath;
        }

        const id = this._generateId();
        const processName = config.name || this._generateProcessName();
        const logPath = path.join(LOG_DIR, `${processName}.log`);

        if (config.uniqueNameLock && this._isNameLocked(processName, config.uniqueNameLock)) {
            throw new Error(`Process name "${processName}" is already in use and locked as unique. Cannot start another process with the same name.`);
        }

        fs.writeFileSync(logPath, `Process Manager - Started: ${new Date().toISOString()}\n`, 'utf-8');

        let child;
        let actualPid;

        if (config.autoRestart || config.restartTries) {
            const monitorScript = this._createMonitorScript(
                id,
                actualScriptPath,
                processName,
                logPath,
                config.autoRestart ? 'true' : 'false',
                config.restartTries || 0,
                workingDir,
                config.daemon,
                config.uniqueNameLock,
                instances
            );

            const systemInfo = this._detectSystem();
            child = spawn(systemInfo.shell, [monitorScript], {
                detached: true,
                stdio: 'ignore'
            });

            actualPid = child.pid;
            child.unref();

            console.log(`✓ Started monitor with PID: ${actualPid} using ${systemInfo.shell}`);
        } else {
            const logFileDescriptor = fs.openSync(logPath, 'a');

            const spawnOptions = {
                detached: true,
                stdio: ['ignore', logFileDescriptor, logFileDescriptor]
            };

            if (workingDir) {
                spawnOptions.cwd = workingDir;
            }

            child = spawn(process.execPath, [actualScriptPath], spawnOptions);

            actualPid = child.pid;
            child.unref();
        }

        const entry = {
            id,
            pid: actualPid,
            name: processName,
            path: resolvedPath,
            log: logPath,
            createdAt: new Date().toISOString(),
            status: 'running',
            type: 'node_script',
            config: {
                autoRestart: !!config.autoRestart,
                restartTries: config.restartTries || 0,
                currentTries: 0,
                workingDir: workingDir,
                daemon: !!config.daemon,
                uniqueNameLock: !!config.uniqueNameLock,
                instances: instances
            },
            isAutoRestart: !!(config.autoRestart || config.restartTries),
            isCluster: instances > 1 || instances === 0,
            monitorPid: (config.autoRestart || config.restartTries) ? actualPid : null,
            lastUpdate: new Date().toISOString(),
            isTempFile: isTempFile,
            tempFilePath: isTempFile ? tempFilePath : null,
            originalPath: !isTempFile ? filepathOrCode : null
        };

        const registry = this._loadRegistry();
        registry.push(entry);
        this._saveRegistry(registry);

        if (config.daemon) {
            const daemonSuccess = this._enableDaemon(id, entry);
            if (daemonSuccess) {
                console.log(`✓ Daemon mode enabled for process: ${processName}`);
                console.log(`✓ Process will auto-start on system reboot`);
            }
        }

        if (config.uniqueNameLock) {
            console.log(`✓ Unique name lock enabled for process: ${processName}`);
            console.log(`✓ No other process can use this name while this process exists`);
        }

        if (instances > 1 || instances === 0) {
            const numInstances = instances === 0 ? os.cpus().length : instances;
            console.log(`✓ Running in cluster mode with ${numInstances} worker(s)`);
        }

        return entry;
    }

    /**
     * Lists all managed processes with their current status
     * @static
     * @returns {Array<Object>} Array of process objects with status information
     */
    static list() {
        this._syncDaemonStatus();

        const registry = this._loadRegistry();
        const processList = [];

        for (const proc of registry) {
            if (proc.config?.daemon) {
                // Daemon processes must not be reported as dead merely because the
                // init service is inactive: the real process may still be alive
                // (e.g. service was only enabled for boot, not started yet).
                const isAlive = this._isDaemonProcessAlive(proc);
                let status = proc.status;

                if (isAlive && proc.status !== 'running') {
                    status = 'running';
                    proc.status = status;
                    this._saveRegistry(registry);
                } else if (!isAlive && (proc.status === 'running' || proc.status === 'restarting')) {
                    status = 'dead';
                    proc.status = status;
                    this._saveRegistry(registry);
                }

                let displayStatus = status.charAt(0).toUpperCase() + status.slice(1);

                processList.push({
                    status: displayStatus,
                    id: proc.id,
                    name: proc.name,
                    pid: proc.pid,
                    type: proc.type || 'node_script',
                    command: proc.config?.command || proc.path,
                    monitorPid: proc.monitorPid || 'N/A',
                    tries: proc.config?.currentTries || 0,
                    autoRestart: proc.isAutoRestart ? 'Yes' : 'No',
                    daemon: proc.config?.daemon ? 'Yes' : 'No',
                    uniqueNameLock: proc.config?.uniqueNameLock ? 'Yes' : 'No',
                    cluster: proc.isCluster ? `Yes (${proc.config?.instances === 0 ? 'max' : proc.config?.instances})` : 'No',
                    workingDir: proc.config?.workingDir || 'Default',
                    path: proc.path
                });
                continue;
            }

            let status = proc.status;
            let displayStatus = status.charAt(0).toUpperCase() + status.slice(1);

            let isAlive = false;
            try {
                if (proc.isAutoRestart && proc.monitorPid) {
                    process.kill(proc.monitorPid, 0);
                    isAlive = true;
                } else {
                    process.kill(proc.pid, 0);
                    isAlive = true;
                }
            } catch (e) {
                isAlive = false;
            }

            if (!isAlive && (proc.status === 'running' || proc.status === 'restarting')) {
                status = 'dead';
                proc.status = status;
                displayStatus = 'Dead';
                this._saveRegistry(registry);
            } else if (isAlive && proc.status === 'stopped') {
                status = 'running';
                proc.status = status;
                displayStatus = 'Running';
                this._saveRegistry(registry);
            }

            processList.push({
                status: displayStatus,
                id: proc.id,
                name: proc.name,
                pid: proc.pid,
                type: proc.type || 'node_script',
                command: proc.config?.command || proc.path,
                monitorPid: proc.monitorPid || 'N/A',
                tries: proc.config?.currentTries || 0,
                autoRestart: proc.isAutoRestart ? 'Yes' : 'No',
                daemon: proc.config?.daemon ? 'Yes' : 'No',
                uniqueNameLock: proc.config?.uniqueNameLock ? 'Yes' : 'No',
                cluster: proc.isCluster ? `Yes (${proc.config?.instances === 0 ? 'max' : proc.config?.instances})` : 'No',
                workingDir: proc.config?.workingDir || 'Default',
                path: proc.path
            });
        }

        return processList;
    }

    /**
     * Removes a process from the registry by ID
     * @static
     * @private
     * @param {string} id - Process ID to remove
     * @returns {boolean} True if process was found and removed
     */
    static _removeFromRegistry(id) {
        const registry = this._loadRegistry();
        const index = registry.findIndex(process => process.id === id);

        if (index !== -1) {
            registry.splice(index, 1);
            this._saveRegistry(registry);
            return true;
        }
        return false;
    }

    /**
     * Checks if a process is alive by its unique name
     * @static
     * @param {string} processName - Unique name of the process to check
     * @returns {boolean} True if process is running
     */
    static isAliveByName(processName) {
        const registry = this._loadRegistry();
        const proc = registry.find(p => p.name === processName && p.config.uniqueNameLock === true);

        if (!proc) {
            console.error(`Process with name "${processName}" not found or doesn't have unique name lock enabled.`);
            return false;
        }

        return this.isAlive(proc.id);
    }

    /**
     * Kills a process by its unique name
     * @static
     * @param {string} processName - Unique name of the process to kill
     * @returns {boolean} True if process was found and killed
     */
    static killByName(processName) {
        const registry = this._loadRegistry();
        const proc = registry.find(p => p.name === processName && p.config.uniqueNameLock === true);

        if (!proc) {
            console.error(`Process with name "${processName}" not found or doesn't have unique name lock enabled.`);
            return false;
        }

        console.log(`Killing process by name: ${proc.name} (ID: ${proc.id}, PID: ${proc.pid})`);
        return this.kill(proc.id);
    }

    /**
     * Kills a process by PID or ID
     * @static
     * @param {string|number} pidOrId - Process ID or PID to kill
     * @returns {boolean} True if process was found and killed
     */
    static kill(pidOrId) {
        const registry = this._loadRegistry();
        const proc = registry.find(p => p.pid == pidOrId || p.id === pidOrId);

        if (!proc) {
            console.error('Process not found in registry.');
            return false;
        }

        const processType = proc.isGlobalCommand ? 'global command' : 'process';
        console.log(`Killing ${processType}: ${proc.name} (ID: ${proc.id})${proc.isCluster ? ' [CLUSTER]' : ''}`);

        proc.status = 'stopped';
        this._saveRegistry(registry);

        let killed = false;

        if (proc.isAutoRestart) {
            if (proc.monitorPid) {
                killed = this._killProcessTree(proc.monitorPid);
            }
            if (proc.pid !== proc.monitorPid) {
                this._killProcessTree(proc.pid);
            }
        } else {
            killed = this._killProcessTree(proc.pid);
        }

        if (proc.isCluster) {
            try {
                process.kill(proc.pid, 'SIGTERM');
                console.log(`✓ Sent SIGTERM to cluster master (PID: ${proc.pid})`);
            } catch (error) {
                // Process might already be dead
            }
        }

        if (killed) {
            console.log(`✓ Successfully killed ${processType}: ${proc.name}`);
        } else {
            console.log(`- ${processType} ${proc.name} was not running`);
        }

        if (proc.config?.daemon) {
            this._disableDaemon(proc.id);
        }

        if (proc.isTempFile && proc.tempFilePath) {
            try {
                if (fs.existsSync(proc.tempFilePath)) {
                    fs.unlinkSync(proc.tempFilePath);
                    console.log(`✓ Removed temporary file: ${proc.tempFilePath}`);
                }
            } catch (error) {
                console.log(`⚠ Could not remove temp file: ${error.message}`);
            }
        }

        return true;
    }

    /**
     * Kills all managed processes
     * @static
     * @returns {number} Number of processes killed
     */
    static killAll() {
        const registry = this._loadRegistry();

        if (registry.length === 0) {
            console.log('No processes to kill.');
            return 0;
        }

        console.log(`Killing all ${registry.length} processes...`);

        for (const proc of registry) {
            proc.status = 'stopped';
        }
        this._saveRegistry(registry);

        let killedCount = 0;

        for (const proc of registry) {
            let killed = false;

            if (proc.config?.daemon) {
                try {
                    const systemInfo = this._detectSystem();
                    if (systemInfo.initSystem === 'systemd') {
                        const serviceName = `sypm-${proc.id}.service`;
                        execSync(`systemctl stop ${serviceName} 2>/dev/null || true`);
                        console.log(`✓ Stopped systemd service: ${serviceName}`);
                        killed = true;
                    } else if (systemInfo.initSystem === 'openrc') {
                        const serviceName = `sypm-${proc.id}`;
                        execSync(`rc-service ${serviceName} stop 2>/dev/null || true`);
                        console.log(`✓ Stopped OpenRC service: ${serviceName}`);
                        killed = true;
                    }
                } catch (error) {
                    console.log(`⚠ Could not stop daemon service for ${proc.name}: ${error.message}`);
                }
            }

            if (proc.isCluster) {
                try {
                    process.kill(proc.pid, 'SIGTERM');
                    console.log(`✓ Sent SIGTERM to cluster master for: ${proc.name}`);
                    killed = true;
                } catch (error) {
                    // Process might already be dead
                }
            }

            if (!killed) {
                if (proc.isAutoRestart && proc.monitorPid) {
                    killed = this._killProcessTree(proc.monitorPid);
                } else {
                    killed = this._killProcessTree(proc.pid);
                }
            }

            if (killed) {
                killedCount++;
                console.log(`✓ Killed: ${proc.name}`);
            } else {
                console.log(`- Already dead: ${proc.name}`);
            }

            if (proc.config?.daemon) {
                this._disableDaemon(proc.id);
            }

            if (proc.isTempFile && proc.tempFilePath) {
                try {
                    if (fs.existsSync(proc.tempFilePath)) {
                        fs.unlinkSync(proc.tempFilePath);
                        console.log(`  ✓ Removed temporary file: ${proc.tempFilePath}`);
                    }
                } catch (error) {
                    console.log(`  ⚠ Could not remove temp file: ${error.message}`);
                }
            }
        }

        this._saveRegistry([]);
        console.log(`\n✓ Successfully killed ${killedCount} out of ${registry.length} processes.`);
        return killedCount;
    }

    /**
     * Checks if a process is alive by PID, ID, or name
     * @static
     * @param {string|number} identifier - Process ID, PID, or unique name to check
     * @returns {boolean} True if process is running
     */
    static isAlive(identifier) {
        const registry = this._loadRegistry();

        let proc = registry.find(p => p.pid == identifier || p.id === identifier);

        if (!proc && typeof identifier === 'string') {
            proc = registry.find(p => p.name === identifier && p.config.uniqueNameLock === true);
        }

        if (!proc) return false;

        // Daemon processes may be kept alive by the init system even when the
        // originally tracked PID has exited (or was re-spawned). Check both the
        // tracked PID(s) and the underlying service before declaring it dead.
        // This prevents live daemons from being pruned by cleanup() and from
        // vanishing out of --list / --monit.
        if (proc.config?.daemon) {
            return this._isDaemonProcessAlive(proc);
        }

        try {
            if (proc.isAutoRestart && proc.monitorPid) {
                process.kill(proc.monitorPid, 0);
            } else {
                process.kill(proc.pid, 0);
            }
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Follows logs of a process in real-time
     * @static
     * @param {string|number} [pidOrId] - Process ID or PID to follow logs for, or undefined for all processes
     */
    static log(pidOrId) {
        const registry = this._loadRegistry();

        if (pidOrId === undefined) {
            console.log(`🚀 Following logs for ALL processes (${registry.length} total)`);
            console.log('=' .repeat(80));

            if (registry.length === 0) {
                console.log('No processes found to follow logs.');
                return;
            }

            const logFiles = new Map();
            for (const proc of registry) {
                if (fs.existsSync(proc.log)) {
                    logFiles.set(proc.log, proc.name);
                }
            }

            console.log(`Following ${logFiles.size} log files:`);
            for (const [logPath, processName] of logFiles) {
                console.log(`  - ${processName}: ${logPath}`);
            }
            console.log('=' .repeat(80));
            console.log('Press Ctrl+C to stop following logs\n');

            for (const [logPath, processName] of logFiles) {
                try {
                    const existingContent = fs.readFileSync(logPath, 'utf-8');
                    const lines = existingContent.split('\n');
                    for (const line of lines) {
                        if (line.trim()) {
                            console.log(`[${processName}] ${line}`);
                        }
                    }
                } catch (error) {
                    console.error(`Error reading log file for ${processName}:`, error.message);
                }
            }

            const lastPositions = new Map();
            for (const logPath of logFiles.keys()) {
                try {
                    const stats = fs.statSync(logPath);
                    lastPositions.set(logPath, stats.size);
                } catch (error) {
                    lastPositions.set(logPath, 0);
                }
            }

            const watchers = [];

            for (const [logPath, processName] of logFiles) {
                const watcher = fs.watch(logPath, (eventType) => {
                    if (eventType === 'change') {
                        try {
                            const stats = fs.statSync(logPath);
                            const lastPosition = lastPositions.get(logPath) || 0;

                            if (stats.size > lastPosition) {
                                const stream = fs.createReadStream(logPath, {
                                    start: lastPosition,
                                    end: stats.size
                                });

                                stream.on('data', (chunk) => {
                                    const lines = chunk.toString().split('\n');
                                    for (const line of lines) {
                                        if (line.trim()) {
                                            console.log(`[${processName}] ${line}`);
                                        }
                                    }
                                });

                                stream.on('end', () => {
                                    lastPositions.set(logPath, stats.size);
                                });

                                stream.on('error', () => {
                                    // Ignore stream errors
                                });
                            } else if (stats.size < lastPosition) {
                                lastPositions.set(logPath, 0);
                                const fullContent = fs.readFileSync(logPath, 'utf-8');
                                const lines = fullContent.split('\n');
                                for (const line of lines) {
                                    if (line.trim()) {
                                        console.log(`[${processName}] ${line}`);
                                    }
                                }
                                lastPositions.set(logPath, fullContent.length);
                            }
                        } catch (error) {
                            // File might be temporarily unavailable
                        }
                    }
                });

                watchers.push(watcher);
            }

            const cleanup = () => {
                for (const watcher of watchers) {
                    watcher.close();
                }
                console.log('\n\n📋 Log following stopped for all processes.');
                process.exit(0);
            };

            process.on('SIGINT', cleanup);
            process.on('SIGTERM', cleanup);

            return;
        }

        const proc = registry.find(p => p.pid == pidOrId || p.id === pidOrId);

        if (!proc) {
            console.error('Process not found.');
            return;
        }

        const logPath = proc.log;

        if (!fs.existsSync(logPath)) {
            console.error('Log file not found.');
            return;
        }

        const processType = proc.isGlobalCommand ? 'Global Command' : 'Process';
        console.log(`🚀 Following logs for: ${proc.name} (ID: ${proc.id}) - ${processType}`);
        console.log(`📁 Log file: ${logPath}`);
        if (proc.config?.workingDir) {
            console.log(`📁 Working directory: ${proc.config.workingDir}`);
        }
        if (proc.config?.daemon) {
            console.log(`🔧 Daemon mode: Enabled`);
        }
        if (proc.config?.uniqueNameLock) {
            console.log(`🔒 Unique name lock: Enabled`);
        }
        if (proc.isCluster) {
            const numInstances = proc.config?.instances === 0 ? 'max' : proc.config?.instances;
            console.log(`⚡ Cluster mode: Enabled (${numInstances} instances)`);
        }
        if (proc.isGlobalCommand) {
            console.log(`🌐 Global Command: ${proc.config?.command || proc.path}`);
        }
        console.log('=' .repeat(80));
        console.log('Press Ctrl+C to stop following logs\n');

        try {
            const existingContent = fs.readFileSync(logPath, 'utf-8');
            console.log(existingContent);
        } catch (error) {
            console.error('Error reading log file:', error.message);
            return;
        }

        let lastSize = fs.statSync(logPath).size;

        const watcher = fs.watch(logPath, (eventType) => {
            if (eventType === 'change') {
                try {
                    const stats = fs.statSync(logPath);
                    if (stats.size > lastSize) {
                        const stream = fs.createReadStream(logPath, {
                            start: lastSize,
                            end: stats.size
                        });

                        stream.on('data', (chunk) => {
                            process.stdout.write(chunk.toString());
                        });

                        stream.on('end', () => {
                            lastSize = stats.size;
                        });

                        stream.on('error', () => {
                            // Ignore stream errors
                        });
                    } else if (stats.size < lastSize) {
                        lastSize = 0;
                        const fullContent = fs.readFileSync(logPath, 'utf-8');
                        process.stdout.write(fullContent);
                        lastSize = fullContent.length;
                    }
                } catch (error) {
                    // File might be temporarily unavailable
                }
            }
        });

        const cleanup = () => {
            watcher.close();
            console.log('\n\n📋 Log following stopped.');
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
    }

    /**
     * Restarts a process by PID or ID
     * @static
     * @param {string|number} pidOrId - Process ID or PID to restart
     * @returns {boolean} True if process was found and restarted
     */
    static restart(pidOrId) {
        const registry = this._loadRegistry();
        const proc = registry.find(p => p.pid == pidOrId || p.id === pidOrId);

        if (!proc) {
            console.error('Process not found.');
            return false;
        }

        const processType = proc.isGlobalCommand ? 'global command' : 'process';
        console.log(`Restarting ${processType}: ${proc.name} (ID: ${proc.id})${proc.isCluster ? ' [CLUSTER]' : ''}`);

        const savedConfig = {
            name: proc.name,
            autoRestart: proc.config.autoRestart,
            restartTries: proc.config.restartTries,
            workingDir: proc.config.workingDir,
            daemon: proc.config.daemon,
            uniqueNameLock: proc.config.uniqueNameLock,
            command: proc.config.command,
            instances: proc.config.instances,
            originalPath: proc.originalPath,
            isGlobalCommand: proc.isGlobalCommand,
            commandArgs: proc.config.commandArgs
        };

        this.kill(proc.id);

        setTimeout(() => {
            this._removeFromRegistry(proc.id);

            if (savedConfig.isGlobalCommand) {
                const newProcess = this.exec(savedConfig.command, {
                    name: savedConfig.name,
                    autoRestart: savedConfig.autoRestart,
                    restartTries: savedConfig.restartTries,
                    workingDir: savedConfig.workingDir,
                    daemon: savedConfig.daemon,
                    uniqueNameLock: savedConfig.uniqueNameLock,
                    commandArgs: savedConfig.commandArgs
                });

                console.log(`✓ Successfully restarted ${processType}: ${newProcess.name} (New PID: ${newProcess.pid}, ID: ${newProcess.id})`);
                if (newProcess.config.workingDir) {
                    console.log(`✓ Running in working directory: ${newProcess.config.workingDir}`);
                }
                if (newProcess.config.daemon) {
                    console.log(`✓ Daemon mode: Enabled`);
                }
                if (newProcess.config.uniqueNameLock) {
                    console.log(`✓ Unique name lock: Enabled`);
                }
            } else {
                const originalSource = savedConfig.originalPath || proc.path;
                const newProcess = this.run(originalSource, {
                    name: savedConfig.name,
                    autoRestart: savedConfig.autoRestart,
                    restartTries: savedConfig.restartTries,
                    workingDir: savedConfig.workingDir,
                    daemon: savedConfig.daemon,
                    uniqueNameLock: savedConfig.uniqueNameLock,
                    instances: savedConfig.instances || 1
                });

                console.log(`✓ Successfully restarted: ${newProcess.name} (New PID: ${newProcess.pid}, ID: ${newProcess.id})`);
                if (newProcess.config.workingDir) {
                    console.log(`✓ Running in working directory: ${newProcess.config.workingDir}`);
                }
                if (newProcess.config.daemon) {
                    console.log(`✓ Daemon mode: Enabled`);
                }
                if (newProcess.config.uniqueNameLock) {
                    console.log(`✓ Unique name lock: Enabled`);
                }
                if (newProcess.isCluster) {
                    const numInstances = newProcess.config.instances === 0 ? 'max' : newProcess.config.instances;
                    console.log(`✓ Cluster mode: ${numInstances} instances`);
                }
            }
        }, 1000);

        return true;
    }

    /**
     * Enables daemon mode for an existing process
     * @static
     * @param {string|number} pidOrId - Process ID or PID to enable daemon mode for
     * @returns {boolean} True if daemon mode was successfully enabled
     */
    static enableDaemon(pidOrId) {
        const registry = this._loadRegistry();
        const proc = registry.find(p => p.pid == pidOrId || p.id === pidOrId);

        if (!proc) {
            console.error('Process not found.');
            return false;
        }

        if (proc.config.daemon) {
            console.log(`Process ${proc.name} already has daemon mode enabled.`);
            return true;
        }

        console.log(`Enabling daemon mode for process: ${proc.name} (ID: ${proc.id})`);

        const success = this._enableDaemon(proc.id, proc);
        if (success) {
            proc.config.daemon = true;
            this._saveRegistry(registry);
            console.log(`✓ Daemon mode enabled for process: ${proc.name}`);
            return true;
        } else {
            console.log(`✗ Failed to enable daemon mode for process: ${proc.name}`);
            return false;
        }
    }

    /**
     * Disables daemon mode for an existing process
     * @static
     * @param {string|number} pidOrId - Process ID or PID to disable daemon mode for
     * @returns {boolean} True if daemon mode was successfully disabled
     */
    static disableDaemon(pidOrId) {
        const registry = this._loadRegistry();
        const proc = registry.find(p => p.pid == pidOrId || p.id === pidOrId);

        if (!proc) {
            console.error('Process not found.');
            return false;
        }

        if (!proc.config.daemon) {
            console.log(`Process ${proc.name} does not have daemon mode enabled.`);
            return true;
        }

        console.log(`Disabling daemon mode for process: ${proc.name} (ID: ${proc.id})`);

        const success = this._disableDaemon(proc.id);
        if (success) {
            proc.config.daemon = false;
            this._saveRegistry(registry);
            console.log(`✓ Daemon mode disabled for process: ${proc.name}`);
            return true;
        } else {
            console.log(`✗ Failed to disable daemon mode for process: ${proc.name}`);
            return false;
        }
    }

    /**
     * Cleans up dead processes and removes them from registry
     * @static
     */
    static cleanup() {
        const registry = this._loadRegistry();
        const aliveProcesses = [];

        for (const proc of registry) {
            if (this.isAlive(proc.id)) {
                aliveProcesses.push(proc);
            } else {
                const processType = proc.isGlobalCommand ? 'global command' : 'process';
                console.log(`Cleaning up dead ${processType}: ${proc.name} (ID: ${proc.id})`);

                if (proc.config?.daemon) {
                    this._disableDaemon(proc.id);
                }

                if (proc.isTempFile && proc.tempFilePath) {
                    try {
                        if (fs.existsSync(proc.tempFilePath)) {
                            fs.unlinkSync(proc.tempFilePath);
                            console.log(`  ✓ Removed temporary file: ${proc.tempFilePath}`);
                        }
                    } catch (error) {
                        console.log(`  ⚠ Could not remove temp file: ${error.message}`);
                    }
                }

                try {
                    const monitorScript = path.join(LOG_DIR, `monitor_${proc.id}.sh`);
                    const cmdMonitorScript = path.join(LOG_DIR, `monitor_cmd_${proc.id}.sh`);
                    const ptyWrapperScript = path.join(LOG_DIR, `pty_wrapper_${proc.id}.sh`);

                    if (fs.existsSync(monitorScript)) {
                        fs.unlinkSync(monitorScript);
                    }
                    if (fs.existsSync(cmdMonitorScript)) {
                        fs.unlinkSync(cmdMonitorScript);
                    }
                    if (fs.existsSync(ptyWrapperScript)) {
                        fs.unlinkSync(ptyWrapperScript);
                    }
                } catch (error) {
                    // Ignore cleanup errors
                }
            }
        }

        if (aliveProcesses.length !== registry.length) {
            this._saveRegistry(aliveProcesses);
            console.log(`✓ Cleaned up ${registry.length - aliveProcesses.length} dead processes.`);
        } else {
            console.log('✓ No dead processes to clean up.');
        }
    }

    /**
     * Displays global SyPM information
     * @static
     */
    static info() {
        const systemInfo = this._detectSystem();

        console.log(`SyPM Global Information:`);
        console.log(`Base Directory: ${GLOBAL_BASE_DIR}`);
        console.log(`Registry File: ${PROCESS_REGISTRY}`);
        console.log(`Log Directory: ${LOG_DIR}`);
        console.log(`Daemon Directory: ${DAEMON_DIR}`);
        console.log(`Cluster Wrapper Directory: ${CLUSTER_LOG_DIR}`);
        console.log(`Operating System: ${systemInfo.platform}`);
        console.log(`Init System: ${systemInfo.initSystem}`);
        console.log(`Default Shell: ${systemInfo.shell}`);
        console.log(`Alpine Linux: ${systemInfo.isAlpine ? 'Yes' : 'No'}`);
        console.log(`CPU Cores: ${os.cpus().length}`);

        const registry = this._loadRegistry();
        console.log(`Total Processes: ${registry.length}`);
        console.log(`Active Processes: ${registry.filter(p => this.isAlive(p.id)).length}`);
        console.log(`Daemon Processes: ${registry.filter(p => p.config?.daemon).length}`);
        console.log(`Unique Name Locked Processes: ${registry.filter(p => p.config?.uniqueNameLock).length}`);
        console.log(`Cluster Mode Processes: ${registry.filter(p => p.isCluster).length}`);
        console.log(`Global Command Processes: ${registry.filter(p => p.isGlobalCommand).length}`);
    }

    /**
     * Opens a real-time monitoring dashboard for all managed processes.
     *
     * Features:
     *   - Responsive to terminal size changes (re-renders on SIGWINCH)
     *   - Scrollable process list with infinite scroll (PgUp/PgDn, Home/End, g/G)
     *   - Keyboard selection (arrow keys) to open the live log of a specific process
     *   - Return from log view back to the list (q / Esc / b)
     *   - Alternate screen buffer + hidden cursor: the original terminal is restored on exit
     *   - Raw-mode input with escape-sequence buffering (handles split arrow-key chunks)
     *
     * Keybindings (list view):
     *   ↑/↓ or j/k     Move selection
     *   PgUp/PgDn      Page through the process list
     *   Home/End or g/G Jump to first/last process
     *   Enter or Space Open live log of selected process
     *   q or Ctrl+C    Quit the dashboard
     *
     * Keybindings (log view):
     *   ↑/↓ or j/k     Scroll log by one line
     *   PgUp/PgDn      Scroll log by one page
     *   Home/End or g/G Jump to top / jump to bottom (enables follow)
     *   f              Toggle follow (auto-scroll to newest)
     *   q / Esc / b    Return to process list
     *   Ctrl+C         Quit the dashboard
     *
     * @static
     */
    static monit() {
        const stdout = process.stdout;
        const stdin = process.stdin;

        if (!stdout.isTTY || !stdin.isTTY) {
            console.error('SyPM --monit requires an interactive terminal (TTY).');
            return;
        }

        const ESC = '\x1B';
        const stripAnsi = (s) => String(s).replace(/\x1B\[[0-9;]*m/g, '');

        // ---------- ANSI / terminal helpers ----------
        const write = (s) => {
            try { stdout.write(s); } catch (_) { /* ignore */ }
        };
        const hideCursor = () => write(`${ESC}[?25l`);
        const showCursor = () => write(`${ESC}[?25h`);
        const enterAltScreen = () => write(`${ESC}[?1049h`);
        const exitAltScreen = () => write(`${ESC}[?1049l`);

        const truncVisible = (str, len) => {
            if (len <= 0) return '';
            if (stripAnsi(str).length <= len) return str;
            let out = '';
            let count = 0;
            let i = 0;
            while (i < str.length && count < len) {
                if (str[i] === ESC) {
                    const m = str.substring(i).match(/^\x1B\[[0-9;]*m/);
                    if (m) {
                        out += m[0];
                        i += m[0].length;
                        continue;
                    }
                }
                out += str[i];
                i++;
                count++;
            }
            return out + '\x1B[0m';
        };

        const padVisible = (str, len) => {
            const v = stripAnsi(str);
            if (v.length > len) return truncVisible(str, len);
            if (v.length === len) return str;
            return str + ' '.repeat(len - v.length);
        };

        const getSize = () => ({
            width: Math.max(50, stdout.columns || 100),
            height: Math.max(10, stdout.rows || 24)
        });

        // ---------- State ----------
        const state = {
            mode: 'list',
            selectedIndex: 0,
            scrollOffset: 0,
            processes: [],
            logProcess: null,
            logFilePath: null,
            logLines: [],
            logScroll: 0,
            logFollow: true,
            lastLogSize: -1,
            isRunning: true,
            refreshTimer: null
        };

        // ---------- Data helpers ----------
        const formatUptime = (createdAt) => {
            if (!createdAt) return 'N/A';
            const t = new Date(createdAt).getTime();
            if (isNaN(t)) return 'N/A';
            const diff = Math.floor((Date.now() - t) / 1000);
            if (diff < 0) return '0s';
            if (diff < 60) return `${diff}s`;
            if (diff < 3600) return `${Math.floor(diff / 60)}m`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
            return `${Math.floor(diff / 86400)}d`;
        };

        const getMemoryUsage = (pid) => {
            if (!pid) return 'N/A';
            try {
                if (os.platform() === 'win32') {
                    const output = execSync(`wmic process where ProcessId=${pid} get WorkingSetSize 2>nul`, { encoding: 'utf-8' });
                    const lines = output.split('\n').filter(line => line.trim());
                    if (lines.length > 1) {
                        const memBytes = parseInt(lines[1].trim());
                        if (!isNaN(memBytes)) {
                            return `${(memBytes / 1024 / 1024).toFixed(1)} MB`;
                        }
                    }
                } else {
                    const output = execSync(`ps -o rss= -p ${pid} 2>/dev/null`, { encoding: 'utf-8' });
                    const memKB = parseInt(output.trim());
                    if (!isNaN(memKB)) {
                        return `${(memKB / 1024).toFixed(1)} MB`;
                    }
                }
            } catch (_) { /* process missing or no permission */ }
            return 'N/A';
        };

        const getCPUUsage = (pid) => {
            if (!pid) return 'N/A';
            try {
                if (os.platform() !== 'win32') {
                    const output = execSync(`ps -o %cpu= -p ${pid} 2>/dev/null`, { encoding: 'utf-8' });
                    const cpuPercent = parseFloat(output.trim());
                    if (!isNaN(cpuPercent)) {
                        return `${cpuPercent.toFixed(1)}%`;
                    }
                }
            } catch (_) { /* process missing or no permission */ }
            return 'N/A';
        };

        const readLogFile = (filePath) => {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n');
                const LIMIT = 5000;
                if (lines.length > LIMIT) {
                    return lines.slice(lines.length - LIMIT);
                }
                return lines;
            } catch (e) {
                return [`(error reading log: ${e.message})`];
            }
        };

        // ---------- View builders ----------
        const renderList = (width, height) => {
            try {
                state.processes = SyPM.list();
            } catch (_) {
                state.processes = [];
            }
            const procs = state.processes;

            if (state.selectedIndex >= procs.length) state.selectedIndex = Math.max(0, procs.length - 1);
            if (state.selectedIndex < 0) state.selectedIndex = 0;

            const lines = [];

            // --- Header ---
            const systemInfo = SyPM._detectSystem();
            const totalMem = os.totalmem();
            const usedMem = totalMem - os.freemem();
            const memPct = totalMem > 0 ? ((usedMem / totalMem) * 100).toFixed(1) : '0.0';
            const aliveCount = procs.filter(p => p.status === 'Running' || p.status === 'Restarting').length;

            lines.push(`${ESC}[1;36m SyPM Process Monitor ${ESC}[0m${ESC}[90m [list]${ESC}[0m`);
            const infoStr = ` OS: ${systemInfo.platform}  |  Cores: ${os.cpus().length}  |  Mem: ${memPct}%  |  Procs: ${procs.length} (alive: ${aliveCount})`;
            lines.push(truncVisible(`${ESC}[90m${infoStr}${ESC}[0m`, width));
            lines.push(`${ESC}[90m${'─'.repeat(Math.max(1, width))}${ESC}[0m`);

            // --- Column widths ---
            const colNum = 4;
            const colName = Math.max(10, Math.min(30, Math.floor(width * 0.20)));
            const colPid = 8;
            const colStatus = 11;
            const colUptime = 7;
            const colMem = 9;
            const colCpu = 6;
            const fixed = 2 + colNum + colName + colPid + colStatus + colUptime + colMem + colCpu + 7;
            const colType = Math.max(6, width - fixed);

            const headerRow =
                '  ' +
                padVisible('#', colNum) + ' ' +
                padVisible('Name', colName) + ' ' +
                padVisible('PID', colPid) + ' ' +
                padVisible('Status', colStatus) + ' ' +
                padVisible('Uptime', colUptime) + ' ' +
                padVisible('Memory', colMem) + ' ' +
                padVisible('CPU', colCpu) + ' ' +
                padVisible('Type', colType);
            lines.push(`${ESC}[1m${truncVisible(headerRow, width)}${ESC}[0m`);
            lines.push(`${ESC}[90m${'─'.repeat(Math.max(1, width))}${ESC}[0m`);

            // Build createdAt lookup (list() output doesn't include it)
            const createdAtMap = new Map();
            try {
                for (const r of SyPM._loadRegistry()) {
                    createdAtMap.set(r.id, r.createdAt || r.lastUpdate);
                }
            } catch (_) { /* ignore */ }

            // --- Viewport ---
            const footerLines = 2;
            const headerLines = lines.length;
            const visibleRows = Math.max(1, height - headerLines - footerLines);

            // Adjust scroll to keep selection visible (infinite scroll through all procs)
            let offset = state.scrollOffset;
            if (state.selectedIndex < offset) offset = state.selectedIndex;
            if (state.selectedIndex >= offset + visibleRows) {
                offset = state.selectedIndex - visibleRows + 1;
            }
            const maxOffset = Math.max(0, procs.length - visibleRows);
            if (offset > maxOffset) offset = maxOffset;
            if (offset < 0) offset = 0;
            state.scrollOffset = offset;

            const showAbove = offset > 0;
            const showBelow = (offset + visibleRows) < procs.length;

            if (procs.length === 0) {
                lines.push(`${ESC}[90m  No processes currently managed.${ESC}[0m`);
            } else {
                if (showAbove) {
                    lines.push(`${ESC}[90m  ▲ ${offset} more above${ESC}[0m`);
                }

                // Reserve room for below indicator too
                const indicators = (showAbove ? 1 : 0) + (showBelow ? 1 : 0);
                const dataRows = Math.max(1, visibleRows - indicators);
                const end = Math.min(procs.length, offset + dataRows);

                for (let i = offset; i < end; i++) {
                    const p = procs[i];
                    const selected = (i === state.selectedIndex);
                    const marker = selected ? `${ESC}[7m▶${ESC}[0m` : ' ';

                    let statusStr;
                    switch (p.status) {
                        case 'Running':    statusStr = `${ESC}[32mRunning${ESC}[0m`; break;
                        case 'Restarting': statusStr = `${ESC}[33mRestarting${ESC}[0m`; break;
                        case 'Dead':       statusStr = `${ESC}[31mDead${ESC}[0m`; break;
                        case 'Stopped':    statusStr = `${ESC}[90mStopped${ESC}[0m`; break;
                        default:           statusStr = String(p.status || '');
                    }

                    const uptime = formatUptime(createdAtMap.get(p.id));
                    const mem = getMemoryUsage(p.pid);
                    const cpu = getCPUUsage(p.pid);

                    let row = `${marker} `;
                    row += padVisible(String(i + 1), colNum) + ' ';
                    row += padVisible(truncVisible(String(p.name || ''), colName), colName) + ' ';
                    row += padVisible(String(p.pid == null ? '' : p.pid), colPid) + ' ';
                    row += padVisible(statusStr, colStatus) + ' ';
                    row += padVisible(uptime, colUptime) + ' ';
                    row += padVisible(mem, colMem) + ' ';
                    row += padVisible(cpu, colCpu) + ' ';
                    row += padVisible(truncVisible(String(p.type || 'node_script'), colType), colType);

                    if (selected) {
                        row = `${ESC}[1m${row}${ESC}[0m`;
                    }

                    lines.push(truncVisible(row, width));
                }

                if (showBelow) {
                    const remaining = Math.max(0, procs.length - (offset + dataRows));
                    lines.push(`${ESC}[90m  ▼ ${remaining} more below${ESC}[0m`);
                }
            }

            // Fill remaining rows so old lines don't linger
            while (lines.length < height - footerLines) {
                lines.push('');
            }

            // --- Footer ---
            lines.push(`${ESC}[90m${'─'.repeat(Math.max(1, width))}${ESC}[0m`);
            const position = procs.length === 0 ? '0/0' : `${state.selectedIndex + 1}/${procs.length}`;
            const footer = ` ↑/↓ move   Enter: view log   PgUp/PgDn page   Home/End jump   q quit    [${position}]`;
            lines.push(truncVisible(`${ESC}[90m${footer}${ESC}[0m`, width));

            return lines;
        };

        const renderLog = (width, height) => {
            const lines = [];
            const p = state.logProcess;

            const title = p ? ` Log: ${p.name} ` : ' Log ';
            lines.push(`${ESC}[1;36m${truncVisible(title, width)}${ESC}[0m${ESC}[90m [log]${ESC}[0m`);
            if (p) {
                const sub = ` ID: ${p.id}   PID: ${p.pid}   Type: ${p.type || 'node_script'}   File: ${state.logFilePath || ''}`;
                lines.push(truncVisible(`${ESC}[90m${sub}${ESC}[0m`, width));
            } else {
                lines.push('');
            }
            lines.push(`${ESC}[90m${'─'.repeat(Math.max(1, width))}${ESC}[0m`);

            const footerLines = 2;
            const headerLines = lines.length;
            const visibleRows = Math.max(1, height - headerLines - footerLines);

            const total = state.logLines.length;
            const maxScroll = Math.max(0, total - visibleRows);

            if (state.logFollow) {
                state.logScroll = maxScroll;
            }
            if (state.logScroll > maxScroll) state.logScroll = maxScroll;
            if (state.logScroll < 0) state.logScroll = 0;

            const start = state.logScroll;
            const end = Math.min(total, start + visibleRows);

            if (total === 0) {
                lines.push(`${ESC}[90m  (no log content yet)${ESC}[0m`);
            } else {
                if (start > 0) {
                    lines.push(`${ESC}[90m  ▲ ${start} lines above${ESC}[0m`);
                }
                for (let i = start; i < end; i++) {
                    lines.push(truncVisible(state.logLines[i] || '', width));
                }
                if (end < total) {
                    lines.push(`${ESC}[90m  ▼ ${total - end} lines below${ESC}[0m`);
                }
            }

            while (lines.length < height - footerLines) {
                lines.push('');
            }

            lines.push(`${ESC}[90m${'─'.repeat(Math.max(1, width))}${ESC}[0m`);
            const range = total > 0 ? `${start + 1}-${end}/${total}` : `0/0`;
            const follow = state.logFollow ? `${ESC}[32mFOLLOW${ESC}[0m` : `${ESC}[33mPAUSED${ESC}[0m`;
            const footer = ` ↑/↓ scroll   PgUp/PgDn page   Home/End   f ${state.logFollow ? 'pause' : 'follow'}   q/Esc back    [${range}] ${follow}`;
            lines.push(truncVisible(footer, width));

            return lines;
        };

        const render = () => {
            if (!state.isRunning) return;
            const { width, height } = getSize();

            let lines;
            try {
                lines = (state.mode === 'log')
                    ? renderLog(width, height)
                    : renderList(width, height);
            } catch (err) {
                lines = [`${ESC}[31mRender error: ${err.message}${ESC}[0m`];
            }

            let out = '';
            for (let row = 0; row < height; row++) {
                out += `${ESC}[${row + 1};1H${ESC}[2K`;
                out += (lines[row] || '');
            }
            write(out);
        };

        // ---------- Log content refresh ----------
        const refreshLogContent = () => {
            if (state.mode !== 'log' || !state.logFilePath) return false;
            try {
                const stat = fs.statSync(state.logFilePath);
                if (stat.size !== state.lastLogSize) {
                    state.lastLogSize = stat.size;
                    state.logLines = readLogFile(state.logFilePath);
                    return true;
                }
            } catch (_) { /* log may not exist yet */ }
            return false;
        };

        // ---------- Mode transitions ----------
        const enterLogView = () => {
            const p = state.processes[state.selectedIndex];
            if (!p) return;
            let proc = null;
            try {
                const registry = SyPM._loadRegistry();
                proc = registry.find(r => r.id === p.id);
            } catch (_) { /* ignore */ }
            if (!proc) return;

            state.logProcess = proc;
            state.logFilePath = proc.log;
            state.logLines = readLogFile(proc.log);
            state.lastLogSize = -1;
            state.logScroll = 0;
            state.logFollow = true;
            state.mode = 'log';
            refreshLogContent();
            render();
        };

        const exitLogView = () => {
            state.mode = 'list';
            state.logProcess = null;
            state.logFilePath = null;
            state.logLines = [];
            state.lastLogSize = -1;
            state.logScroll = 0;
            state.logFollow = true;
            render();
        };

        // ---------- Input handling ----------
        const pageSize = () => {
            const { height } = getSize();
            return Math.max(1, height - 8);
        };

        const moveSelection = (delta) => {
            const procs = state.processes;
            if (procs.length === 0) return;
            let next = state.selectedIndex + delta;
            if (next < 0) next = 0;
            if (next > procs.length - 1) next = procs.length - 1;
            state.selectedIndex = next;
        };

        const handleInput = (data) => {
            if (!state.isRunning) return;

            // Ctrl+C always quits
            if (data === '\x03') {
                shutdown();
                return;
            }

            if (state.mode === 'list') {
                const procs = state.processes;
                if (data === `${ESC}[A` || data === `${ESC}[OA` || data === 'k') {
                    moveSelection(-1); render();
                } else if (data === `${ESC}[B` || data === `${ESC}[OB` || data === 'j') {
                    moveSelection(1); render();
                } else if (data === `${ESC}[5~`) {
                    moveSelection(-pageSize()); render();
                } else if (data === `${ESC}[6~`) {
                    moveSelection(pageSize()); render();
                } else if (data === `${ESC}[H` || data === `${ESC}[1~` || data === 'g') {
                    state.selectedIndex = 0; render();
                } else if (data === `${ESC}[F` || data === `${ESC}[4~` || data === 'G') {
                    state.selectedIndex = Math.max(0, procs.length - 1); render();
                } else if (data === '\r' || data === '\n' || data === ' ') {
                    enterLogView();
                } else if (data === 'q' || data === 'Q') {
                    shutdown();
                }
            } else if (state.mode === 'log') {
                if (data === 'q' || data === 'Q' || data === 'b' || data === 'B' || data === ESC) {
                    exitLogView();
                } else if (data === `${ESC}[A` || data === `${ESC}[OA` || data === 'k') {
                    state.logFollow = false;
                    state.logScroll = Math.max(0, state.logScroll - 1);
                    render();
                } else if (data === `${ESC}[B` || data === `${ESC}[OB` || data === 'j') {
                    state.logFollow = false;
                    state.logScroll += 1;
                    render();
                } else if (data === `${ESC}[5~`) {
                    state.logFollow = false;
                    state.logScroll = Math.max(0, state.logScroll - pageSize());
                    render();
                } else if (data === `${ESC}[6~`) {
                    state.logFollow = false;
                    state.logScroll += pageSize();
                    render();
                } else if (data === `${ESC}[H` || data === `${ESC}[1~` || data === 'g') {
                    state.logFollow = false;
                    state.logScroll = 0;
                    render();
                } else if (data === `${ESC}[F` || data === `${ESC}[4~` || data === 'G') {
                    state.logFollow = true;
                    render();
                } else if (data === 'f' || data === 'F') {
                    state.logFollow = !state.logFollow;
                    render();
                }
            }
        };

        // Input buffering to handle split escape sequences from some terminals
        const KNOWN_SEQS = [
            `${ESC}[A`, `${ESC}[B`, `${ESC}[C`, `${ESC}[D`,
            `${ESC}[H`, `${ESC}[F`,
            `${ESC}[1~`, `${ESC}[2~`, `${ESC}[3~`, `${ESC}[4~`, `${ESC}[5~`, `${ESC}[6~`,
            `${ESC}[7~`, `${ESC}[8~`,
            `${ESC}[OA`, `${ESC}[OB`, `${ESC}[OC`, `${ESC}[OD`
        ];
        let inputBuffer = '';
        let inputTimer = null;

        const flushInput = () => {
            const data = inputBuffer;
            inputBuffer = '';
            if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
            if (data) handleInput(data);
        };

        const onData = (chunk) => {
            inputBuffer += chunk;
            // Not an escape sequence: flush immediately
            if (!inputBuffer.startsWith(ESC)) {
                flushInput();
                return;
            }
            // Complete known sequence: flush immediately
            if (KNOWN_SEQS.includes(inputBuffer)) {
                flushInput();
                return;
            }
            // Known prefix of a longer sequence: wait briefly for the rest
            const isPrefix = KNOWN_SEQS.some(seq => seq.startsWith(inputBuffer));
            if (isPrefix && inputBuffer.length < 6) {
                if (inputTimer) clearTimeout(inputTimer);
                inputTimer = setTimeout(flushInput, 40);
                return;
            }
            // Unknown escape sequence: flush it
            flushInput();
        };

        // ---------- Lifecycle ----------
        const onResize = () => {
            // Re-render at the new terminal size
            render();
        };

        const shutdown = () => {
            if (!state.isRunning) return;
            state.isRunning = false;

            if (state.refreshTimer) {
                clearInterval(state.refreshTimer);
                state.refreshTimer = null;
            }
            if (inputTimer) {
                clearTimeout(inputTimer);
                inputTimer = null;
            }

            try { stdin.removeListener('data', onData); } catch (_) {}
            try {
                stdin.setRawMode(false);
                stdin.pause();
            } catch (_) {}

            try { process.removeListener('SIGWINCH', onResize); } catch (_) {}
            try { process.removeListener('SIGINT', shutdown); } catch (_) {}
            try { process.removeListener('SIGTERM', shutdown); } catch (_) {}
            try { process.removeListener('uncaughtException', onUncaught); } catch (_) {}

            showCursor();
            exitAltScreen();
            console.log('📊 Monitoring stopped.');
            process.exit(0);
        };

        const onUncaught = (err) => {
            // Always restore the terminal on unexpected errors
            try { showCursor(); } catch (_) {}
            try { exitAltScreen(); } catch (_) {}
            console.error('SyPM monit crashed:', err && err.stack ? err.stack : err);
            process.exit(1);
        };

        // ---------- Start ----------
        enterAltScreen();
        hideCursor();

        try {
            stdin.setRawMode(true);
            stdin.resume();
            stdin.setEncoding('utf8');
            stdin.on('data', onData);
        } catch (e) {
            console.error('Failed to enable raw mode:', e.message);
            try { stdin.setRawMode(false); } catch (_) {}
            showCursor();
            exitAltScreen();
            return;
        }

        process.on('SIGWINCH', onResize);
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        process.on('uncaughtException', onUncaught);

        // Initial paint
        render();

        // Periodic refresh (1s)
        state.refreshTimer = setInterval(() => {
            if (!state.isRunning) return;
            if (state.mode === 'list') {
                render();
            } else {
                if (refreshLogContent()) {
                    render();
                }
            }
        }, 1000);
    }

    /**
     * Comprehensive test method to verify all SyPM functionality
     * @static
     * @returns {Promise<boolean>} True if all tests pass
     */
    static async Test() {
        console.log('🧪 Starting SyPM Comprehensive Test Suite...\n');

        let testCount = 0;
        let passedTests = 0;
        let failedTests = 0;

        const runTest = async (testName, testFunction) => {
            testCount++;
            process.stdout.write(`  ${testCount}. ${testName}... `);

            try {
                await testFunction();
                console.log('✓ PASSED');
                passedTests++;
            } catch (error) {
                console.log('✗ FAILED');
                console.log(`     Error: ${error.message}`);
                failedTests++;
            }
        };

        const waitFor = (condition, timeout = 5000, interval = 100) => {
            return new Promise((resolve, reject) => {
                const startTime = Date.now();

                const checkCondition = () => {
                    try {
                        if (condition()) {
                            resolve();
                        } else if (Date.now() - startTime > timeout) {
                            reject(new Error(`Timeout waiting for condition after ${timeout}ms`));
                        } else {
                            setTimeout(checkCondition, interval);
                        }
                    } catch (error) {
                        reject(error);
                    }
                };

                checkCondition();
            });
        };

        const cleanupBeforeTests = () => {
            const registry = this._loadRegistry();
            if (registry.length > 0) {
                console.log('Cleaning up existing processes before tests...');
                this.killAll();
            }

            this._saveRegistry([]);
        };

        const createTestScripts = () => {
            const simpleScript = `
console.log('Simple test script started');
setTimeout(() => {
    console.log('Simple test script completed');
}, 5000);
`;

            const crashScript = `
console.log('Crash test script started');
process.exit(1);
`;

            const longRunningScript = `
console.log('Long running test script started');
setInterval(() => {
    console.log('Long running script still alive...');
}, 10000);
`;

            const httpScript = `
const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Hello from PID: ' + process.pid);
});
server.listen(0, () => {
    console.log('Server started on port:', server.address().port);
    console.log('Process PID:', process.pid);
});
setInterval(() => {}, 1000);
`;

            const scripts = {
                simple: { code: simpleScript, file: path.join(tmpdir(), 'test_simple.js') },
                crash: { code: crashScript, file: path.join(tmpdir(), 'test_crash.js') },
                long: { code: longRunningScript, file: path.join(tmpdir(), 'test_long.js') },
                http: { code: httpScript, file: path.join(tmpdir(), 'test_http.js') }
            };

            for (const script of Object.values(scripts)) {
                fs.writeFileSync(script.file, script.code, 'utf-8');
            }

            return scripts;
        };

        const cleanupTestScripts = (scripts) => {
            for (const script of Object.values(scripts)) {
                try {
                    if (fs.existsSync(script.file)) {
                        fs.unlinkSync(script.file);
                    }
                } catch (error) {
                    // Ignore cleanup errors
                }
            }
        };

        cleanupBeforeTests();
        const testScripts = createTestScripts();

        console.log('📋 Running Core Functionality Tests:\n');

        await runTest('Registry load/save operations', () => {
            const testData = [{ id: 'test', name: 'test' }];
            this._saveRegistry(testData);
            const loadedData = this._loadRegistry();
            if (JSON.stringify(loadedData) !== JSON.stringify(testData)) {
                throw new Error('Registry save/load mismatch');
            }
            this._saveRegistry([]);
        });

        await runTest('Unique ID generation', () => {
            const id1 = this._generateId();
            const id2 = this._generateId();
            if (id1 === id2) {
                throw new Error('Generated duplicate IDs');
            }
            if (typeof id1 !== 'string' || id1.length === 0) {
                throw new Error('Invalid ID generated');
            }
        });

        await runTest('Process name generation', () => {
            const name1 = this._generateProcessName();
            const name2 = this._generateProcessName();
            if (name1 === name2) {
                throw new Error('Generated duplicate names');
            }
            if (!name1.startsWith('process_')) {
                throw new Error('Invalid name format');
            }
        });

        await runTest('System detection', () => {
            const systemInfo = this._detectSystem();
            if (!systemInfo.platform) {
                throw new Error('System detection failed');
            }
            console.log(`\n     Detected: ${systemInfo.platform}, ${systemInfo.initSystem}, ${systemInfo.shell}`);
        });

        let simpleProcessId;
        await runTest('Run file-based process', async () => {
            const process = this.run(testScripts.simple.file, {
                name: 'test-simple-file'
            });
            simpleProcessId = process.id;

            if (!process.id || !process.pid || !process.name) {
                throw new Error('Invalid process object returned');
            }

            await waitFor(() => this.isAlive(process.id), 3000, 100);
        });

        let codeProcessId;
        await runTest('Run code-based process', async () => {
            const process = this.run(testScripts.long.code, {
                name: 'test-code-process'
            });
            codeProcessId = process.id;

            if (!process.isTempFile) {
                throw new Error('Code process should be marked as temp file');
            }

            await waitFor(() => this.isAlive(process.id), 3000, 100);
        });

        await runTest('Run process with working directory', async () => {
            const testWorkingDir = path.join(tmpdir(), 'sypm_test_dir');
            if (!fs.existsSync(testWorkingDir)) {
                fs.mkdirSync(testWorkingDir, { recursive: true });
            }

            const process = this.run(testScripts.simple.code, {
                name: 'test-working-dir',
                workingDir: testWorkingDir
            });

            if (!process.config.workingDir) {
                throw new Error('Working directory not set in process config');
            }

            await waitFor(() => this.isAlive(process.id), 3000, 100);

            this.kill(process.id);

            await waitFor(() => !this.isAlive(process.id), 3000, 100);

            try {
                fs.rmdirSync(testWorkingDir);
            } catch (error) {
                // Ignore cleanup errors
            }
        });

        await runTest('Unique name lock functionality', async () => {
            const uniqueName = 'test-unique-process';

            const firstProcess = this.run(testScripts.long.code, {
                name: uniqueName,
                uniqueNameLock: true
            });

            try {
                const secondProcess = this.run(testScripts.simple.code, {
                    name: uniqueName,
                    uniqueNameLock: true
                });
                throw new Error('Second process should not have started with same locked name');
            } catch (error) {
                if (!error.message.includes('already in use and locked')) {
                    throw new Error(`Unexpected error: ${error.message}`);
                }
                console.log(`\n     ✓ Correctly prevented duplicate process: ${error.message}`);
            }

            this.kill(firstProcess.id);

            await waitFor(() => !this.isAlive(firstProcess.id), 3000, 100);

            const thirdProcess = this.run(testScripts.simple.code, {
                name: uniqueName,
                uniqueNameLock: true
            });

            if (!thirdProcess.config.uniqueNameLock) {
                throw new Error('Unique name lock not set in process config');
            }

            this.kill(thirdProcess.id);
        });

        await runTest('List processes functionality', () => {
            const processes = this.list();
            if (!Array.isArray(processes)) {
                throw new Error('List should return an array');
            }

            const ourProcesses = processes.filter(p =>
                p.name === 'test-simple-file' || p.name === 'test-code-process'
            );

            if (ourProcesses.length < 2) {
                throw new Error('Not all test processes found in list');
            }
        });

        await runTest('Process alive status check', () => {
            if (!this.isAlive(simpleProcessId)) {
                throw new Error('Process should be alive');
            }
        });

        await runTest('Kill process by ID', async () => {
            const killed = this.kill(simpleProcessId);
            if (!killed) {
                throw new Error('Failed to kill process by ID');
            }

            await waitFor(() => !this.isAlive(simpleProcessId), 3000, 100);
        });

        await runTest('Kill process by PID', async () => {
            const processes = this.list();
            const codeProcess = processes.find(p => p.name === 'test-code-process');
            if (!codeProcess) {
                throw new Error('Code process not found for PID test');
            }

            const killed = this.kill(codeProcess.pid);
            if (!killed) {
                throw new Error('Failed to kill process by PID');
            }

            await waitFor(() => !this.isAlive(codeProcess.id), 3000, 100);
        });

        let autoRestartProcessId;
        await runTest('Run process with auto-restart', async () => {
            const process = this.run(testScripts.crash.file, {
                name: 'test-auto-restart',
                autoRestart: true,
                restartTries: 2
            });
            autoRestartProcessId = process.id;

            if (!process.isAutoRestart) {
                throw new Error('Auto-restart process not properly configured');
            }

            if (!process.config.autoRestart) {
                throw new Error('Auto-restart flag not set in config');
            }

            await waitFor(() => this.isAlive(process.id), 3000, 100);
        });

        await runTest('Cluster mode with max instances (0)', async () => {
            const process = this.run(testScripts.http.file, {
                name: 'test-cluster-max',
                instances: 0
            });

            if (!process.isCluster) {
                throw new Error('Process should be in cluster mode');
            }

            const expectedInstances = os.cpus().length;
            console.log(`\n     Expected instances: ${expectedInstances}`);

            await new Promise(resolve => setTimeout(resolve, 2000));

            this.kill(process.id);
        });

        await runTest('Cluster mode with specific instances (2)', async () => {
            const process = this.run(testScripts.http.file, {
                name: 'test-cluster-2',
                instances: 2
            });

            if (!process.isCluster) {
                throw new Error('Process should be in cluster mode');
            }

            if (process.config.instances !== 2) {
                throw new Error(`Expected 2 instances, got ${process.config.instances}`);
            }

            await new Promise(resolve => setTimeout(resolve, 2000));

            this.kill(process.id);
        });

        await runTest('Daemon mode configuration', async () => {
            const systemInfo = this._detectSystem();
            if (!systemInfo.isLinux) {
                console.log('\n     Skipping daemon test on non-Linux system');
                return;
            }

            const process = this.run(testScripts.long.file, {
                name: 'test-daemon-process',
                daemon: true
            });

            if (!process.config.daemon) {
                throw new Error('Daemon flag not set in config');
            }

            console.log(`\n     Daemon mode configured for ${systemInfo.initSystem}`);

            this.kill(process.id);
        });

        await runTest('Cleanup dead processes', async () => {
            this.kill(autoRestartProcessId);

            await waitFor(() => !this.isAlive(autoRestartProcessId), 3000, 100);

            this.cleanup();
            const processes = this.list();
            const found = processes.find(p => p.id === autoRestartProcessId);
            if (found) {
                throw new Error('Dead process not cleaned up');
            }
        });

        await runTest('Kill all processes', async () => {
            this.run(testScripts.simple.file, { name: 'test-kill-all-1' });
            this.run(testScripts.simple.file, { name: 'test-kill-all-2' });

            await new Promise(resolve => setTimeout(resolve, 1000));

            const killedCount = this.killAll();

            await new Promise(resolve => setTimeout(resolve, 1000));

            const afterCount = this.list().length;
            if (afterCount !== 0) {
                throw new Error('Not all processes were killed');
            }
        });

        await runTest('System info display', () => {
            this.info();
        });

        await runTest('Process restart functionality', async () => {
            const process = this.run(testScripts.long.file, {
                name: 'test-restart'
            });

            const originalPid = process.pid;

            await waitFor(() => this.isAlive(process.id), 3000, 100);

            const restartSuccess = this.restart(process.id);

            if (!restartSuccess) {
                throw new Error('Restart failed');
            }

            await new Promise(resolve => setTimeout(resolve, 2000));

            const newProcesses = this.list();
            const restartedProcess = newProcesses.find(p => p.name === 'test-restart');

            if (!restartedProcess) {
                throw new Error('Restarted process not found');
            }

            if (restartedProcess.pid === originalPid) {
                throw new Error('Process PID did not change after restart');
            }

            this.kill(restartedProcess.id);

            await waitFor(() => !this.isAlive(restartedProcess.id), 3000, 100);
        });

        await runTest('All processes log following', async () => {
            const process1 = this.run(testScripts.simple.code, { name: 'test-log-all-1' });
            const process2 = this.run(testScripts.simple.code, { name: 'test-log-all-2' });

            await new Promise(resolve => setTimeout(resolve, 1000));

            if (typeof this.log !== 'function') {
                throw new Error('Log method is not a function');
            }

            this.kill(process1.id);
            this.kill(process2.id);
        });

        console.log('\n📋 Running Global Command Execution Tests:\n');

        await runTest('Execute simple global command (background with PTY)', async () => {
            const process = this.exec('echo "Hello from global command"', {
                name: 'test-global-cmd-simple'
            });

            if (!process.isGlobalCommand) {
                throw new Error('Process should be marked as global command');
            }

            if (process.type !== 'global_command') {
                throw new Error('Process type should be global_command');
            }

            await new Promise(resolve => setTimeout(resolve, 2000));

            this.kill(process.id);
        });

        await runTest('Execute global command with auto-restart', async () => {
            const process = this.exec('node -e "console.log(\'test\'); process.exit(1)"', {
                name: 'test-global-cmd-restart',
                autoRestart: true,
                restartTries: 2
            });

            if (!process.isGlobalCommand) {
                throw new Error('Process should be marked as global command');
            }

            if (!process.isAutoRestart) {
                throw new Error('Process should have auto-restart enabled');
            }

            await waitFor(() => this.isAlive(process.id), 3000, 100);

            await new Promise(resolve => setTimeout(resolve, 3000));

            this.kill(process.id);
        });

        await runTest('Execute global command with working directory', async () => {
            const testWorkingDir = path.join(tmpdir(), 'sypm_test_cmd_dir');
            if (!fs.existsSync(testWorkingDir)) {
                fs.mkdirSync(testWorkingDir, { recursive: true });
            }

            const process = this.exec('echo "Running in specific directory"', {
                name: 'test-global-cmd-dir',
                workingDir: testWorkingDir
            });

            if (!process.config.workingDir) {
                throw new Error('Working directory not set in process config');
            }

            if (process.config.workingDir !== testWorkingDir) {
                throw new Error(`Working directory mismatch: ${process.config.workingDir} !== ${testWorkingDir}`);
            }

            await new Promise(resolve => setTimeout(resolve, 2000));

            this.kill(process.id);

            try {
                fs.rmdirSync(testWorkingDir);
            } catch (error) {
                // Ignore cleanup errors
            }
        });

        await runTest('Execute global command with unique name lock', async () => {
            const uniqueCmdName = 'test-unique-cmd';

            const firstProcess = this.exec('node -e "setInterval(() => console.log(\'running\'), 1000)"', {
                name: uniqueCmdName,
                uniqueNameLock: true
            });

            try {
                const secondProcess = this.exec('echo "duplicate"', {
                    name: uniqueCmdName,
                    uniqueNameLock: true
                });
                throw new Error('Second global command should not have started with same locked name');
            } catch (error) {
                if (!error.message.includes('already in use and locked')) {
                    throw new Error(`Unexpected error: ${error.message}`);
                }
                console.log(`\n     ✓ Correctly prevented duplicate global command: ${error.message}`);
            }

            this.kill(firstProcess.id);

            await waitFor(() => !this.isAlive(firstProcess.id), 3000, 100);
        });

        await runTest('Restart global command', async () => {
            const process = this.exec('node -e "setInterval(() => console.log(\'global cmd running\'), 5000)"', {
                name: 'test-global-cmd-restart'
            });

            const originalPid = process.pid;

            await waitFor(() => this.isAlive(process.id), 3000, 100);

            const restartSuccess = this.restart(process.id);

            if (!restartSuccess) {
                throw new Error('Global command restart failed');
            }

            await new Promise(resolve => setTimeout(resolve, 2000));

            const newProcesses = this.list();
            const restartedProcess = newProcesses.find(p => p.name === 'test-global-cmd-restart');

            if (!restartedProcess) {
                throw new Error('Restarted global command not found');
            }

            if (restartedProcess.pid === originalPid) {
                throw new Error('Global command PID did not change after restart');
            }

            if (restartedProcess.type !== 'global_command') {
                throw new Error('Restarted process should still be marked as global command');
            }

            this.kill(restartedProcess.id);

            await waitFor(() => !this.isAlive(restartedProcess.id), 3000, 100);
        });

        await runTest('Mixed processes management', async () => {
            const nodeProcess = this.run(testScripts.long.code, {
                name: 'test-mixed-node'
            });

            const cmdProcess = this.exec('node -e "setInterval(() => {}, 1000)"', {
                name: 'test-mixed-cmd'
            });

            const processes = this.list();
            const nodeProc = processes.find(p => p.name === 'test-mixed-node');
            const cmdProc = processes.find(p => p.name === 'test-mixed-cmd');

            if (!nodeProc) {
                throw new Error('Node.js process not found in list');
            }

            if (!cmdProc) {
                throw new Error('Global command process not found in list');
            }

            if (cmdProc.type !== 'global_command') {
                throw new Error('Global command process should have type global_command');
            }

            if (nodeProc.type !== 'node_script') {
                throw new Error('Node.js process should have type node_script');
            }

            this.kill(nodeProcess.id);
            this.kill(cmdProcess.id);
        });

        await runTest('List command shows global commands correctly', () => {
            const processes = this.list();
            const globalCommands = processes.filter(p => p.type === 'global_command');

            if (globalCommands.length > 0) {
                const firstCmd = globalCommands[0];
                if (!firstCmd.command) {
                    throw new Error('Global command process should have command field');
                }
            }
        });

        await runTest('Info shows global command count', () => {
            const originalLog = console.log;
            let output = '';
            console.log = (msg) => { output += msg + '\n'; };

            this.info();

            console.log = originalLog;

            if (!output.includes('Global Command Processes')) {
                throw new Error('Info should show Global Command Processes count');
            }
        });

        this.killAll();
        cleanupTestScripts(testScripts);

        console.log('\n📊 Test Results Summary:');
        console.log('=' .repeat(40));
        console.log(`Total Tests: ${testCount}`);
        console.log(`Passed: ${passedTests} ✓`);
        console.log(`Failed: ${failedTests} ✗`);
        console.log(`Success Rate: ${((passedTests / testCount) * 100).toFixed(1)}%`);

        if (failedTests === 0) {
            console.log('\n🎉 ALL TESTS PASSED! SyPM is working correctly with PTY support for interactive CLIs.');
            return true;
        } else {
            console.log('\n⚠️  Some tests failed. Please check the implementation.');
            return false;
        }
    }

    /**
     * Displays help information for CLI usage
     * @static
     */
    static displayHelp() {
        console.log(`
    Process Manager CLI Usage (Global):
      node SyPM [command] [options]
      node SyPM [options] "<global command>" [args...]   (shorthand for --exec)

    Commands:
      --run <file>          Run a Node.js script as a background process
      --exec <command>      Execute a global command line as a managed background process
      --list                List all managed processes (global)
      --monit               Open real-time process monitoring dashboard
      --kill <pid|id|name>  Kill a process by PID, ID, or unique name
      --kill-all            Stop all managed processes and remove from registry
      --restart <pid|id>    Restart a process by PID or ID
      --alive <pid|id|name> Check if a process is alive by PID, ID, or unique name
      --log [pid|id]        Follow logs of a process (real-time) or all processes if no PID/ID specified
      --cleanup             Remove dead processes from registry
      --info                Show global SyPM information
      --enable-daemon <id>  Enable daemon mode for a process (auto-start on boot)
      --disable-daemon <id> Disable daemon mode for a process
      --test                Run comprehensive test suite
      --help                Display this help message

    Shorthand Global Command Syntax:
      Simply place the command name in quotes after any SyPM options.
      Additional arguments after the command are passed to the command.
      All commands run DETACHED in the background with PTY support.
      PTY (pseudo-terminal) allows readline, CLI menus, and other TTY-dependent
      features to initialize and run properly in the background.

      Examples:
        node SyPM --name my-server "myapp-server" --port 8080
        node SyPM --auto-restart "python3 main.py"
        node SyPM --working-dir /app "npm start"
        node SyPM "my-cli-tool" --option value    (command with its own args)

    Global Command Execution (--exec also supported):
      node SyPM --exec "ls -la" --name list-files
      node SyPM --exec "python3 server.py" --working-dir /path/to/project --auto-restart
      node SyPM --exec "npm run dev" --name dev-server --unique-name-lock

    Options for --run, --exec, and shorthand commands:
      --name <name>         Specify a name for the process
      --auto-restart        Auto-restart the process if it crashes
      --restart-tries <n>   Number of restart attempts (implies auto-restart)
      --working-dir <path>  Run the process in specified working directory
      --daemon              Run as system daemon (auto-start on system boot)
      --unique-name-lock    Lock the process name as unique (prevent duplicates)
      --instances <n>       Number of cluster instances (0 = max CPUs, only for --run)

    Cluster Mode Examples:
      node SyPM --run app.js --instances 0        # Use all CPU cores
      node SyPM --run app.js --instances 4        # Use exactly 4 instances
      node SyPM --run app.js --name my-app --instances 0

    General Examples:
      node SyPM --run app.js --name my-app --unique-name-lock
      node SyPM --alive my-app
      node SyPM --kill my-app
      node SyPM --kill 12345
      node SyPM --log
      node SyPM --log abc123def
      node SyPM --list
      node SyPM --monit
      node SyPM --test
            `);
    }

    /**
     * Parses command line arguments and executes corresponding commands.
     * Supports new shorthand: node SyPM.js [options] "<command>" [args...]
     * @static
     * @private
     */
    static parseArguments() {
        const args = process.argv.slice(2);

        if (args.length === 0 || args.includes('--help')) {
            this.displayHelp();
            return;
        }

        if (args.includes('--info')) {
            this.info();
            return;
        }

        if (args.includes('--test')) {
            this.Test().then(success => {
                process.exit(success ? 0 : 1);
            }).catch(error => {
                console.error('Test suite failed:', error);
                process.exit(1);
            });
            return;
        }

        if (args.includes('--list')) {
            const processes = this.list();
            console.log('Managed Processes (Global):');
            if (processes.length === 0) {
                console.log('No processes found.');
            } else {
                console.table(processes);
            }
            return;
        }

        if (args.includes('--monit')) {
            this.monit();
            return;
        }

        if (args.includes('--exec')) {
            const execIndex = args.indexOf('--exec');
            if (execIndex + 1 >= args.length || args[execIndex + 1].startsWith('--')) {
                console.error('Error: --exec requires a command to execute');
                return;
            }

            let commandArgs = [];
            let i = execIndex + 1;
            while (i < args.length && !args[i].startsWith('--')) {
                commandArgs.push(args[i]);
                i++;
            }

            const command = commandArgs.join(' ');
            const config = {};

            if (args.includes('--name')) {
                const nameIndex = args.indexOf('--name');
                if (nameIndex + 1 < args.length && !args[nameIndex + 1].startsWith('--')) {
                    config.name = args[nameIndex + 1];
                }
            }

            if (args.includes('--auto-restart')) {
                config.autoRestart = true;
            }

            if (args.includes('--restart-tries')) {
                const triesIndex = args.indexOf('--restart-tries');
                if (triesIndex + 1 < args.length && !args[triesIndex + 1].startsWith('--')) {
                    const tries = parseInt(args[triesIndex + 1]);
                    if (!isNaN(tries) && tries > 0) {
                        config.restartTries = tries;
                        config.autoRestart = true;
                    }
                }
            }

            if (args.includes('--working-dir')) {
                const dirIndex = args.indexOf('--working-dir');
                if (dirIndex + 1 < args.length && !args[dirIndex + 1].startsWith('--')) {
                    config.workingDir = args[dirIndex + 1];
                }
            }

            if (args.includes('--daemon')) {
                config.daemon = true;
            }

            if (args.includes('--unique-name-lock')) {
                config.uniqueNameLock = true;
            }

            try {
                const result = this.exec(command, config);
                console.log(`✓ Started global command: ${result.name} (PID: ${result.pid}, ID: ${result.id})`);
                console.log(`✓ Command: ${command}`);
                console.log(`✓ Global registry: ${PROCESS_REGISTRY}`);
                console.log(`✓ Output logged to: ${result.log}`);
                if (config.autoRestart) {
                    console.log(`✓ Auto-restart enabled${config.restartTries ? ` with ${config.restartTries} tries` : ''}`);
                }
                if (config.workingDir) {
                    console.log(`✓ Working directory: ${config.workingDir}`);
                }
                if (config.daemon) {
                    console.log(`✓ Daemon mode: Enabled (auto-start on system boot)`);
                }
                if (config.uniqueNameLock) {
                    console.log(`✓ Unique name lock: Enabled (no duplicate names allowed)`);
                    console.log(`✓ You can now use "${result.name}" with --alive and --kill commands`);
                }
            } catch (error) {
                console.error('✗ Error executing command:', error.message);
            }
            return;
        }

        if (args.includes('--run')) {
            const runIndex = args.indexOf('--run');
            if (runIndex + 1 >= args.length || args[runIndex + 1].startsWith('--')) {
                console.error('Error: --run requires a file path');
                return;
            }

            const filePath = args[runIndex + 1];
            const config = {};

            if (args.includes('--name')) {
                const nameIndex = args.indexOf('--name');
                if (nameIndex + 1 < args.length && !args[nameIndex + 1].startsWith('--')) {
                    config.name = args[nameIndex + 1];
                }
            }

            if (args.includes('--auto-restart')) {
                config.autoRestart = true;
            }

            if (args.includes('--restart-tries')) {
                const triesIndex = args.indexOf('--restart-tries');
                if (triesIndex + 1 < args.length && !args[triesIndex + 1].startsWith('--')) {
                    const tries = parseInt(args[triesIndex + 1]);
                    if (!isNaN(tries) && tries > 0) {
                        config.restartTries = tries;
                        config.autoRestart = true;
                    }
                }
            }

            if (args.includes('--working-dir')) {
                const dirIndex = args.indexOf('--working-dir');
                if (dirIndex + 1 < args.length && !args[dirIndex + 1].startsWith('--')) {
                    config.workingDir = args[dirIndex + 1];
                }
            }

            if (args.includes('--daemon')) {
                config.daemon = true;
            }

            if (args.includes('--unique-name-lock')) {
                config.uniqueNameLock = true;
            }

            if (args.includes('--instances')) {
                const instancesIndex = args.indexOf('--instances');
                if (instancesIndex + 1 < args.length && !args[instancesIndex + 1].startsWith('--')) {
                    const instances = parseInt(args[instancesIndex + 1]);
                    if (!isNaN(instances) && instances >= 0) {
                        config.instances = instances;
                    }
                }
            }

            try {
                const result = this.run(filePath, config);
                console.log(`✓ Started process: ${result.name} (PID: ${result.pid}, ID: ${result.id})`);
                console.log(`✓ Global registry: ${PROCESS_REGISTRY}`);
                if (config.autoRestart) {
                    console.log(`✓ Auto-restart enabled${config.restartTries ? ` with ${config.restartTries} tries` : ''}`);
                }
                if (config.workingDir) {
                    console.log(`✓ Working directory: ${config.workingDir}`);
                }
                if (config.daemon) {
                    console.log(`✓ Daemon mode: Enabled (auto-start on system boot)`);
                }
                if (config.uniqueNameLock) {
                    console.log(`✓ Unique name lock: Enabled (no duplicate names allowed)`);
                    console.log(`✓ You can now use "${result.name}" with --alive and --kill commands`);
                }
                if (config.instances && config.instances !== 1) {
                    const numInstances = config.instances === 0 ? os.cpus().length : config.instances;
                    console.log(`✓ Cluster mode: ${numInstances} instances`);
                }
            } catch (error) {
                console.error('✗ Error starting process:', error.message);
            }
            return;
        }

        if (args.includes('--kill')) {
            const killIndex = args.indexOf('--kill');
            if (killIndex + 1 >= args.length || args[killIndex + 1].startsWith('--')) {
                console.error('Error: --kill requires a PID, ID, or name');
                return;
            }

            const identifier = args[killIndex + 1];

            if (isNaN(identifier)) {
                const killed = this.killByName(identifier);
                if (!killed) {
                    this.kill(identifier);
                }
            } else {
                this.kill(identifier);
            }
            return;
        }

        if (args.includes('--kill-all')) {
            this.killAll();
            return;
        }

        if (args.includes('--restart')) {
            const restartIndex = args.indexOf('--restart');
            if (restartIndex + 1 >= args.length || args[restartIndex + 1].startsWith('--')) {
                console.error('Error: --restart requires a PID or ID');
                return;
            }

            const pidOrId = args[restartIndex + 1];
            this.restart(pidOrId);
            return;
        }

        if (args.includes('--alive')) {
            const aliveIndex = args.indexOf('--alive');
            if (aliveIndex + 1 >= args.length || args[aliveIndex + 1].startsWith('--')) {
                console.error('Error: --alive requires a PID, ID, or name');
                return;
            }

            const identifier = args[aliveIndex + 1];
            const isAlive = this.isAlive(identifier);
            console.log(`Process "${identifier}" is ${isAlive ? 'alive' : 'not alive'}`);
            return;
        }

        if (args.includes('--log')) {
            const logIndex = args.indexOf('--log');
            let pidOrId;

            if (logIndex + 1 < args.length && !args[logIndex + 1].startsWith('--')) {
                pidOrId = args[logIndex + 1];
            }

            this.log(pidOrId);
            return;
        }

        if (args.includes('--enable-daemon')) {
            const daemonIndex = args.indexOf('--enable-daemon');
            if (daemonIndex + 1 >= args.length || args[daemonIndex + 1].startsWith('--')) {
                console.error('Error: --enable-daemon requires a process ID');
                return;
            }

            const processId = args[daemonIndex + 1];
            this.enableDaemon(processId);
            return;
        }

        if (args.includes('--disable-daemon')) {
            const daemonIndex = args.indexOf('--disable-daemon');
            if (daemonIndex + 1 >= args.length || args[daemonIndex + 1].startsWith('--')) {
                console.error('Error: --disable-daemon requires a process ID');
                return;
            }

            const processId = args[daemonIndex + 1];
            this.disableDaemon(processId);
            return;
        }

        if (args.includes('--cleanup')) {
            this.cleanup();
            return;
        }

        // Shorthand for global command execution without --exec
        let commandName = null;
        let commandArgs = [];
        let i = 0;
        while (i < args.length) {
            if (args[i].startsWith('--')) {
                if (args[i] === '--name' || args[i] === '--restart-tries' ||
                    args[i] === '--working-dir' || args[i] === '--instances') {
                    i += 2;
                } else {
                    i += 1;
                }
            } else {
                commandName = args[i];
                commandArgs = args.slice(i + 1);
                break;
            }
        }

        if (commandName) {
            const fullCommand = [commandName, ...commandArgs].join(' ');

            const config = {};
            if (args.includes('--name')) {
                const nameIndex = args.indexOf('--name');
                if (nameIndex + 1 < args.length && !args[nameIndex + 1].startsWith('--')) {
                    config.name = args[nameIndex + 1];
                }
            }
            if (args.includes('--auto-restart')) {
                config.autoRestart = true;
            }
            if (args.includes('--restart-tries')) {
                const triesIndex = args.indexOf('--restart-tries');
                if (triesIndex + 1 < args.length && !args[triesIndex + 1].startsWith('--')) {
                    const tries = parseInt(args[triesIndex + 1]);
                    if (!isNaN(tries) && tries > 0) {
                        config.restartTries = tries;
                        config.autoRestart = true;
                    }
                }
            }
            if (args.includes('--working-dir')) {
                const dirIndex = args.indexOf('--working-dir');
                if (dirIndex + 1 < args.length && !args[dirIndex + 1].startsWith('--')) {
                    config.workingDir = args[dirIndex + 1];
                }
            }
            if (args.includes('--daemon')) {
                config.daemon = true;
            }
            if (args.includes('--unique-name-lock')) {
                config.uniqueNameLock = true;
            }

            try {
                const result = this.exec(fullCommand, config);
                console.log(`✓ Started global command: ${result.name} (PID: ${result.pid}, ID: ${result.id})`);
                console.log(`✓ Command: ${fullCommand}`);
                console.log(`✓ Global registry: ${PROCESS_REGISTRY}`);
                console.log(`✓ Output logged to: ${result.log}`);
                if (config.autoRestart) {
                    console.log(`✓ Auto-restart enabled${config.restartTries ? ` with ${config.restartTries} tries` : ''}`);
                }
                if (config.workingDir) {
                    console.log(`✓ Working directory: ${config.workingDir}`);
                }
                if (config.daemon) {
                    console.log(`✓ Daemon mode: Enabled (auto-start on system boot)`);
                }
                if (config.uniqueNameLock) {
                    console.log(`✓ Unique name lock: Enabled (no duplicate names allowed)`);
                    console.log(`✓ You can now use "${result.name}" with --alive and --kill commands`);
                }
            } catch (error) {
                console.error('✗ Error executing command:', error.message);
            }
            return;
        }

        console.error('Error: Unknown command or invalid arguments. Use --help for usage information.');
    }
}

if (process.argv[1] === __filename) {
    SyPM.parseArguments();
}

export default SyPM;