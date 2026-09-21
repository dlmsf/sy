import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { execSync } from 'child_process';
import SyPM from './../../../SyPM.js';

const execAsync = promisify(exec);

class ClipboardMonitor {
    constructor() {
        this.configDir = path.join(os.homedir(), '.clipboard-monitor');
        this.configPath = path.join(this.configDir, 'clipboard-config.json');
        this.outputPath = path.join(process.cwd(), 'result');
        this.lastClipboardContent = '';
        this.isMonitoring = false;
        this.isPaused = false;
        this.skipNextClipboardCheck = false;
        this.tagRestrictMode = false;
        this.config = {
            profiles: {},
            interval: 1000
        };
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        // Background mode properties
        this.bgMode = false;
        this.originalRoot = process.cwd();
        this.currentRoot = process.cwd();
        this.trackerShellPid = null;
        this.trackerTty = null;
        this.trackerSessionId = null; // NEW
        this.lastTrackedDir = process.cwd();
        this.isBackgroundProcess = false;

        // Auto-pause-after-commands mode
        this.pauseAfterMode = false;
        // Auto-wait variant of pause-after (continue automatically, no manual resume)
        this.pauseAfterAutoMode = false;

        // Next-diff mode: after commands finish, the next clipboard content must be
        // different from the last one before it gets processed automatically.
        this.nextDiffMode = false;
    }

    async question(query) {
        return new Promise(resolve => this.rl.question(query, resolve));
    }

    async ensureConfigDirectory() {
        try {
            await fs.mkdir(this.configDir, { recursive: true });
        } catch (error) {
            console.error('Error creating config directory:', error);
            throw error;
        }
    }

    async ensureDirectoryExists() {
        const dir = path.dirname(this.outputPath);
        try {
            await fs.mkdir(dir, { recursive: true });
        } catch (error) {
            console.error('Error creating directory:', error);
            throw error;
        }
    }

    async loadOrCreateConfig() {
        // Migrate old config from /tmp if exists
        const oldConfigDir = path.join(os.tmpdir(), 'clipboard-monitor');
        const oldConfigPath = path.join(oldConfigDir, 'clipboard-config.json');
        try {
            await fs.access(oldConfigPath);
            // Old config exists, check if new config already exists
            try {
                await fs.access(this.configPath);
                // New config exists, don't overwrite
            } catch (error) {
                if (error.code === 'ENOENT') {
                    // New config doesn't exist, copy old to new
                    await fs.mkdir(this.configDir, { recursive: true });
                    await fs.copyFile(oldConfigPath, this.configPath);
                    console.log(`✓ Migrated configuration from ${oldConfigPath} to ${this.configPath}`);
                }
            }
        } catch (error) {
            // Old config doesn't exist, ignore
        }

        try {
            await this.ensureConfigDirectory();
            const configData = await fs.readFile(this.configPath, 'utf8');
            this.config = { ...this.config, ...JSON.parse(configData) };
            delete this.config.activeProfile; // Remove legacy activeProfile
            console.log(`✓ Configuration loaded from ${this.configPath}`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await this.saveConfig();
                console.log(`✓ Default configuration created at ${this.configPath}`);
            } else {
                console.error('Error loading config:', error);
            }
        }
    }

    async saveConfig() {
        try {
            await this.ensureConfigDirectory();
            await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
            console.log(`✓ Configuration saved to ${this.configPath}`);
        } catch (error) {
            console.error('Error saving config:', error);
        }
    }

    async waitForFileCreation(filePath, timeout = 10000) {
        const startTime = Date.now();
        let lastSize = -1;
        let stableCount = 0;
        
        while (Date.now() - startTime < timeout) {
            try {
                const stats = await fs.stat(filePath);
                if (stats.isFile() && stats.size > 0) {
                    if (stats.size === lastSize) {
                        stableCount++;
                        if (stableCount >= 3) {
                            return true;
                        }
                    } else {
                        lastSize = stats.size;
                        stableCount = 0;
                    }
                }
            } catch (error) {
                stableCount = 0;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
    }

    shellQuote(str) {
        return "'" + String(str).replace(/'/g, "'\\''") + "'";
    }

    filterShellNoise(text) {
        if (!text) return text;
        const lines = String(text).split('\n');
        const kept = lines.filter(line => {
            const l = line.trim();
            if (!l) return false;
            if (/cannot set terminal process group/i.test(l)) return false;
            if (/no job control in this shell/i.test(l)) return false;
            return true;
        });
        return kept.join('\n').trim();
    }

    // Runs a command with the default /bin/sh first (unchanged behavior for
    // everything that already works). If and only if it fails with "not found"
    // (e.g. the user's 'clip' shell function/alias), it retries through the
    // user's interactive shell so aliases/functions from their rc files work.
    async runCommandWithFallback(command) {
        try {
            return await execAsync(command);
        } catch (error) {
            const msg = ((error && error.stderr) || '') + ((error && error.message) || '');
            if (!/not found|command not found/i.test(msg)) {
                throw error;
            }
            return await this.runCommandViaInteractiveShell(command);
        }
    }

    async runCommandViaInteractiveShell(command) {
        const shell = process.env.SHELL || '/bin/bash';
        const scriptFile = path.join(
            os.tmpdir(),
            `clipwait-cmd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`
        );
        await fs.writeFile(scriptFile, command, 'utf8');
        try {
            return await execAsync(`${this.shellQuote(shell)} -i ${this.shellQuote(scriptFile)}`);
        } finally {
            try { await fs.unlink(scriptFile); } catch (e) { /* ignore */ }
        }
    }

    async executeCommands(profile) {
        if (!profile.commands || profile.commands.length === 0) {
            console.log('No commands to execute');
            return true;
        }

        console.log('Waiting for file creation to complete...');
        const fileCreated = await this.waitForFileCreation(this.outputPath);
        
        if (!fileCreated) {
            console.error('✗ File was not created within timeout period');
            return false;
        }

        console.log(`✓ File confirmed created and stable: ${this.outputPath}`);
        console.log(`Executing ${profile.commands.length} command(s) sequentially...`);
        
        let allSucceeded = true;
        for (let i = 0; i < profile.commands.length; i++) {
            const command = profile.commands[i];
            console.log(`[${i + 1}/${profile.commands.length}] Executing: ${command}`);
            
            try {
                const { stdout, stderr } = await this.runCommandWithFallback(command);
                const cleanStdout = (stdout || '').trim();
                const cleanStderr = this.filterShellNoise(stderr);
                if (cleanStdout) {
                    console.log(`  Output: ${cleanStdout}`);
                }
                if (cleanStderr) {
                    console.log(`  Stderr: ${cleanStderr}`);
                }
                console.log(`  ✓ Command completed successfully`);
            } catch (error) {
                const cleanMessage = this.filterShellNoise(error.message) || error.message;
                console.error(`  ✗ Command failed: ${cleanMessage}`);
                allSucceeded = false;
                const continueExec = await this.question('  Continue with next commands? (y/n): ');
                if (continueExec.toLowerCase() !== 'y') {
                    console.log('  Stopping command execution.');
                    break;
                }
            }
        }
        return allSucceeded;
    }

    async getClipboardContent() {
        try {
            let command;
            
            if (process.platform === 'darwin') {
                command = 'pbpaste';
            } else if (process.platform === 'linux') {
                command = 'xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null';
            } else if (process.platform === 'win32') {
                command = 'powershell -command "Get-Clipboard"';
            } else {
                throw new Error(`Unsupported platform: ${process.platform}`);
            }

            const { stdout } = await execAsync(command);
            return stdout;
        } catch (error) {
            return '';
        }
    }

    async writeToFile(content) {
        try {
            const stats = await fs.stat(this.outputPath).catch(() => null);
            if (stats && stats.isDirectory()) {
                console.error(`Error: ${this.outputPath} is a directory, not a file`);
                return false;
            }
            
            await fs.writeFile(this.outputPath, content, 'utf8');
            console.log(`[${new Date().toISOString()}] Clipboard content written to ${this.outputPath}`);
            return true;
        } catch (error) {
            console.error('Error writing to file:', error);
            return false;
        }
    }

    hasCodeReplacerTags(content) {
        const START = '[CODEREPLACER-START]';
        const END = '[/CODEREPLACER-END]';
        return content.includes(START) && content.includes(END);
    }

    isStructGeneratorInstruction(content) {
        const markers = [
            'AI INSTRUCTIONS',
            'USER REQUEST:',
            'OUTPUT FORMAT:',
            'CRITICAL PATH PRESERVATION ENFORCEMENT',
            'MANDATORY RULES:',
            'VERIFICATION CHECK:',
            'ORIGINAL size:',
            'Parsed size:',
            'PARSED FILE:',
            'REFERENCE ONLY:',
            'REFERENCE-ONLY FILES'
        ];
        
        const hasMarker = markers.some(marker => content.includes(marker));
        if (hasMarker) {
            return true;
        }
        
        const fileHeaderPattern = /={50,}\nFILE: .+\n={50,}/g;
        const fileHeaderMatches = content.match(fileHeaderPattern);
        if (fileHeaderMatches && fileHeaderMatches.length > 0) {
            return true;
        }
        
        const aiInstructionPattern = /={50,}\nAI INSTRUCTIONS\n={50,}/;
        if (aiInstructionPattern.test(content)) {
            return true;
        }
        
        const hasUserRequest = content.includes('USER REQUEST:');
        const hasOutputFormat = content.includes('OUTPUT FORMAT:');
        const hasInstructions = content.includes('AI INSTRUCTIONS');
        
        if ((hasUserRequest && hasOutputFormat) || (hasInstructions && hasUserRequest)) {
            return true;
        }
        
        return false;
    }

    validateCodeReplacerPaths(content) {
        const START = '[CODEREPLACER-START]';
        const END = '[/CODEREPLACER-END]';
        const basePath = this.currentRoot;

        let searchPos = 0;
        let foundAnyTag = false;

        while (true) {
            const startIdx = content.indexOf(START, searchPos);
            if (startIdx === -1) break;

            foundAnyTag = true;
            const endIdx = content.indexOf(END, startIdx + START.length);
            if (endIdx === -1) {
                console.error('✗ Validation error: Incomplete CODEREPLACER block detected.');
                return false;
            }

            const block = content.slice(startIdx, endIdx + END.length);
            const pathRegex = /PATH='([^']*)'/g;
            let match;
            while ((match = pathRegex.exec(block)) !== null) {
                const rawPath = match[1];
                const resolved = path.resolve(rawPath);
                const relative = path.relative(basePath, resolved);

                if (relative.startsWith('..') || path.isAbsolute(relative)) {
                    console.error(
                        `✗ Validation failed: PATH '${rawPath}' is outside the allowed directory '${basePath}'.`
                    );
                    return false;
                }
            }

            searchPos = endIdx + END.length;
        }

        return true;
    }

    // Capture terminal info including session ID
    captureTerminalInfo() {
        const info = {
            myPid: process.pid,
            myPpid: process.ppid,
            tty: null,
            shellPid: null,
            sessionId: null
        };

        try {
            info.tty = execSync(`ps -o tty= -p ${info.myPid}`).toString().trim();
            
            let currentPid = info.myPpid;
            let attempts = 0;
            
            while (currentPid > 1 && attempts < 10) {
                try {
                    const procInfo = execSync(`ps -o comm= -p ${currentPid}`).toString().trim();
                    const ppid = parseInt(execSync(`ps -o ppid= -p ${currentPid}`).toString().trim());
                    const tty = execSync(`ps -o tty= -p ${currentPid}`).toString().trim();
                    
                    const shellNames = ['bash', 'zsh', 'sh', 'fish', 'ksh', 'tcsh', 'dash'];
                    if (shellNames.some(shell => procInfo.includes(shell))) {
                        info.shellPid = currentPid;
                        info.tty = tty;
                        info.sessionId = execSync(`ps -o sess= -p ${currentPid}`).toString().trim();
                        console.log(`✓ Found shell: PID ${currentPid} (${procInfo})`);
                        break;
                    }
                    
                    currentPid = ppid;
                    attempts++;
                } catch (error) {
                    break;
                }
            }
        } catch (error) {
            console.error('Error capturing terminal info:', error);
        }
        
        return info;
    }

    // Get current directory of tracked shell
    getShellCwd(pid) {
        try {
            return execSync(`readlink /proc/${pid}/cwd`).toString().trim();
        } catch (error) {
            return null;
        }
    }

    // Check if directory changed and update if needed
    async checkDirectoryChange() {
        if (!this.trackerShellPid && !this.trackerSessionId) {
            return;
        }

        // Dynamically find the active shell PID in the same session
        const activePid = await this.findActiveShellPid();
        if (activePid && activePid !== this.trackerShellPid) {
            console.log(`\n🔄 Active shell changed: ${this.trackerShellPid} → ${activePid}`);
            this.trackerShellPid = activePid;
        }

        if (!this.trackerShellPid) return;

        const newDir = this.getShellCwd(this.trackerShellPid);
        if (!newDir || newDir === this.lastTrackedDir) {
            return;
        }

        this.lastTrackedDir = newDir;
        console.log(`\n🔄 Terminal directory changed: ${newDir}`);

        // Check if new directory is the same as or inside the current root
        const relative = path.relative(this.currentRoot, newDir);
        const isInside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));

        if (isInside) {
            console.log('   Directory is inside current repo tree. Keeping current root.');
            return;
        }

        // Directory is outside current root - check if it's a NEW git repository
        console.log('   Directory is outside current repo. Checking for .git repository...');
        
        // Find nearest ancestor with .git
        let dir = newDir;
        let newRepoRoot = null;
        
        while (dir !== path.dirname(dir)) {
            try {
                const gitPath = path.join(dir, '.git');
                const stats = await fs.stat(gitPath);
                if (stats.isDirectory()) {
                    newRepoRoot = dir;
                    break;
                }
            } catch (e) {
                // .git not found, continue upward
            }
            dir = path.dirname(dir);
        }

        // Only update if we found a NEW .git repository different from current root
        if (newRepoRoot && newRepoRoot !== this.currentRoot) {
            console.log(`   📁 Found new git repository: ${newRepoRoot}`);
            console.log(`   Updating working directory from ${this.currentRoot} to ${newRepoRoot}`);
            
            this.currentRoot = newRepoRoot;
            
            // Update output path
            if (this.currentProfileName && this.config.profiles[this.currentProfileName]) {
                const profile = this.config.profiles[this.currentProfileName];
                const outputFile = profile.outputFile || this.currentProfileName;
                this.outputPath = path.join(newRepoRoot, outputFile);
                console.log(`   Output file path updated to: ${this.outputPath}`);
                await this.ensureDirectoryExists();
            }
        } else {
            console.log('   No new .git repository found. Keeping current root.');
        }
    }

    async checkClipboard() {
        if (this.isPaused) {
            return;
        }

        // Check directory change if in background mode
        if (this.bgMode && this.isBackgroundProcess) {
            await this.checkDirectoryChange();
        }
        
        const currentContent = await this.getClipboardContent();
        
        // If skipNextClipboardCheck is set (after resume from pause),
        // update lastClipboardContent to current content and clear the flag
        if (this.skipNextClipboardCheck) {
            this.lastClipboardContent = currentContent;
            this.skipNextClipboardCheck = false;
            console.log('✓ Current clipboard content skipped - waiting for new changes...');
            return;
        }
        
        if (currentContent && currentContent !== this.lastClipboardContent) {
            this.lastClipboardContent = currentContent;
            console.log('\n' + '='.repeat(60));
            console.log('New clipboard content detected!');

            if (this.tagRestrictMode) {
                if (this.isStructGeneratorInstruction(currentContent)) {
                    console.log('✗ Tag Restrict Mode: Content rejected (struct generator instruction detected).');
                    console.log('='.repeat(60) + '\n');
                    return;
                }
                
                if (!this.hasCodeReplacerTags(currentContent)) {
                    console.log('✗ Tag Restrict Mode: Content rejected (no CODEREPLACER tags found).');
                    console.log('='.repeat(60) + '\n');
                    return;
                }
                console.log('✓ Tag Restrict Mode: CODEREPLACER tags detected.');
            }

            if (!this.validateCodeReplacerPaths(currentContent)) {
                console.log('✗ Clipboard content rejected due to path validation failure.');
                console.log('='.repeat(60) + '\n');
                return;
            }

            const writeSuccess = await this.writeToFile(currentContent);
            
            if (writeSuccess && this.currentProfileName) {
                const profile = this.config.profiles[this.currentProfileName];
                if (profile) {
                    const allCommandsFinished = await this.executeCommands(profile);
                    if (this.notifyMode && allCommandsFinished) {
                        this.sendCompletionSignal();
                    }
                    if (this.pauseAfterMode && allCommandsFinished) {
                        if (this.pauseAfterAutoMode) {
                            console.log('✓ Auto mode: monitoring continues, waiting for the next clipboard change...');
                        } else {
                            this.autoPauseAfterCommands();
                        }
                    }
                    if (this.nextDiffMode && allCommandsFinished) {
                        await this.armNextDiff();
                    }
                }
            }
            
            console.log('='.repeat(60) + '\n');
        }
    }

    autoPauseAfterCommands() {
        if (this.isPaused) {
            return;
        }
        this.isPaused = true;
        console.log('\n⏸️  Auto-paused after commands finished - Press P to resume');
    }

    async armNextDiff() {
        // After the profile commands finish, capture the current clipboard content
        // as the new baseline. This ensures the monitor will NOT automatically grab
        // the next clipboard content unless it is DIFFERENT from the last one.
        const currentContent = await this.getClipboardContent();
        this.lastClipboardContent = currentContent;
        console.log('✓ Next-Diff mode: waiting for clipboard content different from the last...');
    }

    async showProfiles() {
        console.log('\n' + '='.repeat(60));
        console.log('Available Profiles:');
        console.log('='.repeat(60));
        const profiles = Object.keys(this.config.profiles);
        if (profiles.length === 0) {
            console.log('No profiles configured yet.');
            return;
        }
        profiles.forEach((name, index) => {
            const profile = this.config.profiles[name];
            console.log(`\n${index + 1}. ${name}`);
            console.log(`   Output file: ${profile.outputFile || name}`);
            console.log(`   Commands: ${profile.commands.length}`);
            const defaultFlags = [];
            if (profile.defaultBg) defaultFlags.push('bg');
            if (profile.defaultTag) defaultFlags.push('tag');
            if (profile.defaultNotify) defaultFlags.push('notify');
            if (profile.defaultPauseAfter) defaultFlags.push(profile.defaultPauseAfterAuto ? 'pause-after-auto' : 'pause-after');
            if (profile.defaultNextDiff) defaultFlags.push('next-diff');
            console.log(`   Default flags: ${defaultFlags.length > 0 ? defaultFlags.join(', ') : 'none'}`);
            profile.commands.forEach((cmd, cmdIndex) => {
                console.log(`     ${cmdIndex + 1}. ${cmd}`);
            });
        });
        console.log('='.repeat(60));
    }

    async addProfile() {
        console.log('\n=== Add New Profile ===');
        const name = await this.question('Profile name: ');
        
        if (!name || this.config.profiles[name]) {
            console.log('Invalid or duplicate profile name.');
            return;
        }
        
        const outputFile = await this.question(`Output file name (default: ${name}): `) || name;
        const commands = [];
        
        console.log('Enter commands (one per line, empty line to finish):');
        while (true) {
            const command = await this.question(`Command ${commands.length + 1}: `);
            if (!command) break;
            commands.push(command);
        }
        
        // Ask about default flags
        const defaultBg = (await this.question('Enable --bg by default? (y/n): ')).toLowerCase() === 'y';
        const defaultTag = (await this.question('Enable --tag by default? (y/n): ')).toLowerCase() === 'y';
        const defaultNotify = (await this.question('Enable --notify by default? (y/n): ')).toLowerCase() === 'y';
        const defaultPauseAfter = (await this.question('Enable --pause-after by default? (y/n): ')).toLowerCase() === 'y';
        let defaultPauseAfterAuto = false;
        if (defaultPauseAfter) {
            defaultPauseAfterAuto = (await this.question('  Use auto-wait mode for --pause-after (continue automatically without pressing P)? (y/n): ')).toLowerCase() === 'y';
        }
        const defaultNextDiff = (await this.question('Enable --next-diff by default? (y/n): ')).toLowerCase() === 'y';

        this.config.profiles[name] = {
            outputFile,
            commands,
            defaultBg,
            defaultTag,
            defaultNotify,
            defaultPauseAfter,
            defaultPauseAfterAuto,
            defaultNextDiff
        };
        
        await this.saveConfig();
        console.log(`✓ Profile "${name}" added successfully.`);
    }

    async editProfile() {
        await this.showProfiles();
        const name = await this.question('\nProfile name to edit: ');
        
        if (!this.config.profiles[name]) {
            console.log('Profile not found.');
            return;
        }
        
        console.log(`\nEditing profile: ${name}`);
        console.log('Press Enter to keep current value.');
        
        const currentOutputFile = this.config.profiles[name].outputFile || name;
        const outputFile = await this.question(`Output file name (${currentOutputFile}): `);
        if (outputFile) {
            this.config.profiles[name].outputFile = outputFile;
        }

        // Edit default flags
        const currentBg = this.config.profiles[name].defaultBg || false;
        const bgInput = await this.question(`Enable --bg by default? (current: ${currentBg ? 'yes' : 'no'}) [y/n/Enter to keep]: `);
        if (bgInput.toLowerCase() === 'y') this.config.profiles[name].defaultBg = true;
        else if (bgInput.toLowerCase() === 'n') this.config.profiles[name].defaultBg = false;

        const currentTag = this.config.profiles[name].defaultTag || false;
        const tagInput = await this.question(`Enable --tag by default? (current: ${currentTag ? 'yes' : 'no'}) [y/n/Enter to keep]: `);
        if (tagInput.toLowerCase() === 'y') this.config.profiles[name].defaultTag = true;
        else if (tagInput.toLowerCase() === 'n') this.config.profiles[name].defaultTag = false;

        const currentNotify = this.config.profiles[name].defaultNotify || false;
        const notifyInput = await this.question(`Enable --notify by default? (current: ${currentNotify ? 'yes' : 'no'}) [y/n/Enter to keep]: `);
        if (notifyInput.toLowerCase() === 'y') this.config.profiles[name].defaultNotify = true;
        else if (notifyInput.toLowerCase() === 'n') this.config.profiles[name].defaultNotify = false;

        const currentPauseAfter = this.config.profiles[name].defaultPauseAfter || false;
        const pauseAfterInput = await this.question(`Enable --pause-after by default? (current: ${currentPauseAfter ? 'yes' : 'no'}) [y/n/Enter to keep]: `);
        if (pauseAfterInput.toLowerCase() === 'y') this.config.profiles[name].defaultPauseAfter = true;
        else if (pauseAfterInput.toLowerCase() === 'n') this.config.profiles[name].defaultPauseAfter = false;

        if (this.config.profiles[name].defaultPauseAfter) {
            const currentPauseAfterAuto = this.config.profiles[name].defaultPauseAfterAuto || false;
            const pauseAfterAutoInput = await this.question(`Use auto-wait mode for --pause-after (no need to press P)? (current: ${currentPauseAfterAuto ? 'yes' : 'no'}) [y/n/Enter to keep]: `);
            if (pauseAfterAutoInput.toLowerCase() === 'y') this.config.profiles[name].defaultPauseAfterAuto = true;
            else if (pauseAfterAutoInput.toLowerCase() === 'n') this.config.profiles[name].defaultPauseAfterAuto = false;
        } else {
            this.config.profiles[name].defaultPauseAfterAuto = false;
        }

        const currentNextDiff = this.config.profiles[name].defaultNextDiff || false;
        const nextDiffInput = await this.question(`Enable --next-diff by default? (current: ${currentNextDiff ? 'yes' : 'no'}) [y/n/Enter to keep]: `);
        if (nextDiffInput.toLowerCase() === 'y') this.config.profiles[name].defaultNextDiff = true;
        else if (nextDiffInput.toLowerCase() === 'n') this.config.profiles[name].defaultNextDiff = false;
        
        console.log('Current commands:');
        this.config.profiles[name].commands.forEach((cmd, index) => {
            console.log(`  ${index + 1}. ${cmd}`);
        });
        
        const addCommands = await this.question('Do you want to add commands after the existing ones? (y/n): ');
        if (addCommands.toLowerCase() === 'y') {
            const newCommands = [];
            console.log('Enter new commands (one per line, empty line to finish):');
            while (true) {
                const command = await this.question(`New command ${newCommands.length + 1}: `);
                if (!command) break;
                newCommands.push(command);
            }
            this.config.profiles[name].commands = this.config.profiles[name].commands.concat(newCommands);
            console.log(`✓ ${newCommands.length} command(s) appended.`);
        }

        const insertCommands = await this.question('Do you want to insert commands at a specific position? (y/n): ');
        if (insertCommands.toLowerCase() === 'y') {
            const total = this.config.profiles[name].commands.length;
            const positionInput = await this.question('Insert at position (e.g., "23" = after command 2, before command 3; use "0" for the beginning): ');
            const cleaned = (positionInput || '').trim().replace(/[^0-9]/g, '');
            let insertIndex;
            if (cleaned.length === 0) {
                console.log('Invalid position input. Defaulting to end (append).');
                insertIndex = this.config.profiles[name].commands.length;
            } else {
                // For "23", the "after" position is the first digit.
                // For a single number "2", it also means "after command 2".
                const afterPos = parseInt(cleaned[0], 10);
                insertIndex = afterPos;
                if (insertIndex < 0) insertIndex = 0;
                if (insertIndex > total) insertIndex = total;
            }
            const insertedCommands = [];
            console.log('Enter new commands to insert (one per line, empty line to finish):');
            while (true) {
                const command = await this.question(`Insert command ${insertedCommands.length + 1}: `);
                if (!command) break;
                insertedCommands.push(command);
            }
            if (insertedCommands.length > 0) {
                this.config.profiles[name].commands.splice(insertIndex, 0, ...insertedCommands);
                console.log(`✓ ${insertedCommands.length} command(s) inserted at position ${insertIndex + 1}.`);
            } else {
                console.log('No commands entered. Nothing inserted.');
            }
        }
        
        await this.saveConfig();
        console.log(`✓ Profile "${name}" updated successfully.`);
    }

    async deleteProfile() {
        await this.showProfiles();
        const name = await this.question('\nProfile name to delete: ');
        
        if (!this.config.profiles[name]) {
            console.log('Profile not found.');
            return;
        }
        
        const confirm = await this.question(`Are you sure you want to delete profile "${name}"? (y/n): `);
        if (confirm.toLowerCase() === 'y') {
            delete this.config.profiles[name];
            await this.saveConfig();
            console.log(`✓ Profile "${name}" deleted successfully.`);
        }
    }

    async duplicateProfile() {
        await this.showProfiles();
        const sourceName = await this.question('\nSource profile name to duplicate: ');
        if (!this.config.profiles[sourceName]) {
            console.log('Source profile not found.');
            return;
        }
        const newName = await this.question('New profile name: ');
        if (!newName || this.config.profiles[newName]) {
            console.log('Invalid or duplicate new profile name.');
            return;
        }
        // Deep copy the source profile
        const sourceProfile = this.config.profiles[sourceName];
        this.config.profiles[newName] = {
            outputFile: sourceProfile.outputFile,
            commands: [...sourceProfile.commands],
            defaultBg: sourceProfile.defaultBg,
            defaultTag: sourceProfile.defaultTag,
            defaultNotify: sourceProfile.defaultNotify,
            defaultPauseAfter: sourceProfile.defaultPauseAfter,
            defaultPauseAfterAuto: sourceProfile.defaultPauseAfterAuto,
            defaultNextDiff: sourceProfile.defaultNextDiff
        };
        await this.saveConfig();
        console.log(`✓ Profile "${sourceName}" duplicated as "${newName}".`);
    }

    async manageProfiles() {
        while (true) {
            console.log('\n' + '='.repeat(60));
            console.log('Profile Management');
            console.log('='.repeat(60));
            console.log('1. Show profiles');
            console.log('2. Add new profile');
            console.log('3. Edit profile');
            console.log('4. Duplicate profile');
            console.log('5. Delete profile');
            console.log('6. Back to main menu');
            
            const choice = await this.question('\nSelect option: ');
            
            switch (choice) {
                case '1':
                    await this.showProfiles();
                    break;
                case '2':
                    await this.addProfile();
                    break;
                case '3':
                    await this.editProfile();
                    break;
                case '4':
                    await this.duplicateProfile();
                    break;
                case '5':
                    await this.deleteProfile();
                    break;
                case '6':
                    return;
                default:
                    console.log('Invalid option.');
            }
        }
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        if (this.isPaused) {
            console.log('\n⏸️  Monitoring PAUSED - Press P to resume');
        } else {
            console.log('\n▶️  Monitoring RESUMED - current clipboard will be ignored, waiting for new changes...');
            // When resuming from pause, skip the current clipboard content
            // and only process new clipboard changes after resume
            this.skipNextClipboardCheck = true;
        }
    }

    async startMonitoring(profileName, isBackground = false) {
        this.isBackgroundProcess = isBackground;
        
        if (profileName && this.config.profiles[profileName]) {
            this.currentProfileName = profileName;
            this.outputPath = path.join(this.currentRoot, this.config.profiles[profileName].outputFile || profileName);
        } else {
            console.error(`✗ Profile "${profileName}" not found.`);
            return false;
        }
        
        await this.ensureDirectoryExists();
        // Skip initial clipboard content - only process changes after monitoring starts
        this.lastClipboardContent = await this.getClipboardContent();
        this.isMonitoring = true;
        this.isPaused = false;
        
        const activeProfile = this.config.profiles[this.currentProfileName];
        
        console.log('\n' + '='.repeat(60));
        console.log('Clipboard Monitor Started');
        console.log('='.repeat(60));
        console.log(`Active profile: ${this.currentProfileName}`);
        console.log(`Output file: ${this.outputPath}`);
        console.log(`Commands to execute: ${activeProfile.commands.length}`);
        console.log('ℹ️  Current clipboard content will be ignored - waiting for new changes...');
        if (this.tagRestrictMode) {
            console.log('🔒 TAG RESTRICT MODE: Only content with CODEREPLACER tags will be processed');
            console.log('   (Struct generator instructions will be ignored)');
        }
        if (this.pauseAfterMode) {
            if (this.pauseAfterAutoMode) {
                console.log('⏸️  AUTO-WAIT AFTER COMMANDS: monitoring continues automatically after commands finish');
            } else {
                console.log('⏸️  AUTO-PAUSE AFTER COMMANDS: monitoring pauses after all commands finish');
            }
        }
        if (this.nextDiffMode) {
            console.log('🔁 NEXT-DIFF MODE: After commands finish, only clipboard content different from the last will be processed');
        }
        if (this.bgMode && isBackground) {
            console.log('🔍 BACKGROUND TRACKING: Directory changes will be monitored');
            console.log(`   Current root: ${this.currentRoot}`);
            if (this.trackerShellPid) {
                console.log(`   Tracking shell PID: ${this.trackerShellPid}`);
            }
        }
        console.log('Press P to pause/resume monitoring');
        console.log('Press Ctrl+C to stop monitoring...');
        console.log('='.repeat(60) + '\n');
        
        while (this.isMonitoring) {
            await this.checkClipboard();
            await new Promise(resolve => setTimeout(resolve, this.config.interval));
        }
        return true;
    }

    // Dynamically find the active shell PID in the same session
    async findActiveShellPid() {
        if (!this.trackerSessionId) return this.trackerShellPid;

        const shellNames = ['bash', 'zsh', 'sh', 'fish', 'ksh', 'tcsh', 'dash'];
        let highestPid = null;

        try {
            const procDirs = await fs.readdir('/proc');
            for (const dir of procDirs) {
                if (!/^\d+$/.test(dir)) continue;
                const pid = parseInt(dir, 10);
                try {
                    const comm = (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim();
                    if (!shellNames.some(shell => comm.includes(shell))) continue;

                    // Read session ID from /proc/<pid>/stat (field 6)
                    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
                    const statParts = stat.split(' ');
                    // Fields: pid (0), comm (1), state (2), ppid (3), pgrp (4), session (5), ...
                    const sessionId = statParts[5]; // session is field 6 (0-indexed 5)
                    if (sessionId === this.trackerSessionId) {
                        if (highestPid === null || pid > highestPid) {
                            highestPid = pid;
                        }
                    }
                } catch (e) {
                    // Ignore processes that disappear
                }
            }
        } catch (e) {
            // Ignore /proc read errors
        }

        return highestPid || this.trackerShellPid;
    }

    // Create background process script
    createBackgroundScript(profileName, tagMode, shellPid, tty, sessionId, bgToken, notifyMode = false, pauseAfterMode = false, pauseAfterAutoMode = false, nextDiffMode = false) {
        return `
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const execAsync = promisify(exec);

const BG_TOKEN = '${bgToken}';
const METADATA_PATH = path.join(os.tmpdir(), 'clipboard-monitor', 'bg-processes.json');

class BackgroundClipboardMonitor {
    constructor() {
        this.configDir = path.join(os.homedir(), '.clipboard-monitor');
        this.configPath = path.join(this.configDir, 'clipboard-config.json');
        this.outputPath = path.join(process.cwd(), 'result');
        this.lastClipboardContent = '';
        this.isMonitoring = true;
        this.isPaused = false;
        this.tagRestrictMode = ${tagMode};
        this.config = {
            profiles: {},
            interval: 1000
        };
        this.originalRoot = process.cwd();
        this.currentRoot = process.cwd();
        this.trackerShellPid = ${shellPid};
        this.trackerTty = '${tty || ''}';
        this.trackerSessionId = '${sessionId || ''}';
        this.lastTrackedDir = process.cwd();
        this.notifyMode = ${notifyMode};
        this.pauseAfterMode = ${pauseAfterMode};
        this.pauseAfterAutoMode = ${pauseAfterAutoMode};
        this.nextDiffMode = ${nextDiffMode};
        this.profileName = '${profileName || ''}';
        
        this.logFile = path.join(os.homedir(), '.clipboard-monitor', 'clipwait-bg-' + BG_TOKEN + '.log');
    }
    
    log(message) {
        const timestamp = new Date().toISOString();
        const logEntry = timestamp + ' - ' + message;
        console.log(logEntry);
        
        try {
            fs.appendFile(this.logFile, logEntry + '\\n', 'utf8');
        } catch (error) {
            // Ignore logging errors
        }
    }
    
    async loadConfig() {
        try {
            const configData = await fs.readFile(this.configPath, 'utf8');
            this.config = { ...this.config, ...JSON.parse(configData) };
            delete this.config.activeProfile; // Remove legacy activeProfile
            this.log('✓ Configuration loaded');
        } catch (error) {
            this.log('✗ Error loading config: ' + error.message);
        }
    }
    
    async getClipboardContent() {
        try {
            let command;
            
            if (process.platform === 'darwin') {
                command = 'pbpaste';
            } else if (process.platform === 'linux') {
                command = 'xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null';
            } else if (process.platform === 'win32') {
                command = 'powershell -command "Get-Clipboard"';
            } else {
                return '';
            }

            const { stdout } = await execAsync(command);
            return stdout;
        } catch (error) {
            return '';
        }
    }
    
    async writeToFile(content) {
        try {
            const stats = await fs.stat(this.outputPath).catch(() => null);
            if (stats && stats.isDirectory()) {
                this.log('✗ Error: ' + this.outputPath + ' is a directory');
                return false;
            }
            
            await fs.writeFile(this.outputPath, content, 'utf8');
            this.log('✓ Clipboard content written to ' + this.outputPath);
            return true;
        } catch (error) {
            this.log('✗ Error writing to file: ' + error.message);
            return false;
        }
    }
    
    hasCodeReplacerTags(content) {
        const START = '[CODEREPLACER-START]';
        const END = '[/CODEREPLACER-END]';
        return content.includes(START) && content.includes(END);
    }
    
    isStructGeneratorInstruction(content) {
        const markers = [
            'AI INSTRUCTIONS',
            'USER REQUEST:',
            'OUTPUT FORMAT:',
            'CRITICAL PATH PRESERVATION ENFORCEMENT',
            'MANDATORY RULES:',
            'VERIFICATION CHECK:',
            'ORIGINAL size:',
            'Parsed size:',
            'PARSED FILE:',
            'REFERENCE ONLY:',
            'REFERENCE-ONLY FILES'
        ];
        
        const hasMarker = markers.some(marker => content.includes(marker));
        if (hasMarker) return true;
        
        const fileHeaderPattern = /={50,}\\nFILE: .+\\n={50,}/g;
        const fileHeaderMatches = content.match(fileHeaderPattern);
        if (fileHeaderMatches && fileHeaderMatches.length > 0) return true;
        
        const aiInstructionPattern = /={50,}\\nAI INSTRUCTIONS\\n={50,}/;
        if (aiInstructionPattern.test(content)) return true;
        
        const hasUserRequest = content.includes('USER REQUEST:');
        const hasOutputFormat = content.includes('OUTPUT FORMAT:');
        const hasInstructions = content.includes('AI INSTRUCTIONS');
        
        if ((hasUserRequest && hasOutputFormat) || (hasInstructions && hasUserRequest)) return true;
        
        return false;
    }
    
    validateCodeReplacerPaths(content) {
        const START = '[CODEREPLACER-START]';
        const END = '[/CODEREPLACER-END]';
        const basePath = this.currentRoot;
        
        let searchPos = 0;
        
        while (true) {
            const startIdx = content.indexOf(START, searchPos);
            if (startIdx === -1) break;
            
            const endIdx = content.indexOf(END, startIdx + START.length);
            if (endIdx === -1) {
                this.log('✗ Validation error: Incomplete CODEREPLACER block');
                return false;
            }
            
            const block = content.slice(startIdx, endIdx + END.length);
            const pathRegex = /PATH='([^']*)'/g;
            let match;
            while ((match = pathRegex.exec(block)) !== null) {
                const rawPath = match[1];
                const resolved = path.resolve(rawPath);
                const relative = path.relative(basePath, resolved);
                
                if (relative.startsWith('..') || path.isAbsolute(relative)) {
                    this.log('✗ Validation failed: PATH ' + rawPath + ' is outside ' + basePath);
                    return false;
                }
            }
            
            searchPos = endIdx + END.length;
        }
        
        return true;
    }
    
    async findActiveShellPid() {
        if (!this.trackerSessionId) return this.trackerShellPid;

        const shellNames = ['bash', 'zsh', 'sh', 'fish', 'ksh', 'tcsh', 'dash'];
        let highestPid = null;

        try {
            const procDirs = await fs.readdir('/proc');
            for (const dir of procDirs) {
                if (!/^\\d+$/.test(dir)) continue;
                const pid = parseInt(dir, 10);
                try {
                    const comm = (await fs.readFile('/proc/' + pid + '/comm', 'utf8')).trim();
                    if (!shellNames.some(shell => comm.includes(shell))) continue;

                    const stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
                    const statParts = stat.split(' ');
                    const sessionId = statParts[5];
                    if (sessionId === this.trackerSessionId) {
                        if (highestPid === null || pid > highestPid) {
                            highestPid = pid;
                        }
                    }
                } catch (e) {
                    // Ignore
                }
            }
        } catch (e) {
            // Ignore
        }

        return highestPid || this.trackerShellPid;
    }

    getShellCwd(pid) {
        try {
            return execSync('readlink /proc/' + pid + '/cwd').toString().trim();
        } catch (error) {
            return null;
        }
    }

    async updateMetadataActivity(type, value) {
        try {
            const data = JSON.parse(await fs.readFile(METADATA_PATH, 'utf8'));
            const proc = data.processes?.find(p => p.bgToken === BG_TOKEN);
            if (proc) {
                proc.lastActivityAt = new Date().toISOString();
                if (type === 'directory') {
                    proc.lastTrackedDirs = proc.lastTrackedDirs || [];
                    proc.lastTrackedDirs.unshift(value);
                    if (proc.lastTrackedDirs.length > 3) {
                        proc.lastTrackedDirs = proc.lastTrackedDirs.slice(0, 3);
                    }
                } else if (type === 'command') {
                    proc.executedCommands = proc.executedCommands || [];
                    proc.executedCommands.unshift(value);
                    if (proc.executedCommands.length > 5) {
                        proc.executedCommands = proc.executedCommands.slice(0, 5);
                    }
                }
                await fs.writeFile(METADATA_PATH, JSON.stringify(data, null, 2), 'utf8');
            }
        } catch (error) {
            // Ignore metadata update errors
        }
    }
    
    async checkDirectoryChange() {
        const activePid = await this.findActiveShellPid();
        if (activePid && activePid !== this.trackerShellPid) {
            this.log('🔄 Active shell changed: ' + this.trackerShellPid + ' → ' + activePid);
            this.trackerShellPid = activePid;
        }

        if (!this.trackerShellPid) return;

        const newDir = this.getShellCwd(this.trackerShellPid);
        if (!newDir || newDir === this.lastTrackedDir) return;
        
        this.lastTrackedDir = newDir;
        this.log('🔄 Terminal directory changed: ' + newDir);
        await this.updateMetadataActivity('directory', newDir);
        
        // Check if new directory is inside the current root
        const relative = path.relative(this.currentRoot, newDir);
        const isInside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        
        if (isInside) {
            this.log('   Directory is inside current repo tree. Keeping current root.');
            return;
        }
        
        // Directory is outside current root - check if it's a NEW git repository
        this.log('   Directory is outside current repo. Checking for .git repository...');
        
        // Find nearest ancestor with .git
        let dir = newDir;
        let newRepoRoot = null;
        
        while (dir !== path.dirname(dir)) {
            try {
                const gitPath = path.join(dir, '.git');
                const stats = await fs.stat(gitPath);
                if (stats.isDirectory()) {
                    newRepoRoot = dir;
                    break;
                }
            } catch (e) {
                // .git not found, continue upward
            }
            dir = path.dirname(dir);
        }
        
        // Only update if we found a NEW .git repository different from current root
        if (newRepoRoot && newRepoRoot !== this.currentRoot) {
            this.log('📁 Found new git repository: ' + newRepoRoot);
            this.log('   Updating working directory from ' + this.currentRoot + ' to ' + newRepoRoot);
            
            this.currentRoot = newRepoRoot;
            
            if (this.profileName && this.config.profiles[this.profileName]) {
                const profile = this.config.profiles[this.profileName];
                const outputFile = profile.outputFile || this.profileName;
                this.outputPath = path.join(newRepoRoot, outputFile);
                this.log('   Output file path updated to: ' + this.outputPath);
            }
        } else {
            this.log('   No new .git repository found. Keeping current root.');
        }
    }
    
    shellQuote(str) {
        return "'" + String(str).replace(/'/g, "'\\\\''") + "'";
    }

    filterShellNoise(text) {
        if (!text) return text;
        const lines = String(text).split('\\n');
        const kept = lines.filter(line => {
            const l = line.trim();
            if (!l) return false;
            if (/cannot set terminal process group/i.test(l)) return false;
            if (/no job control in this shell/i.test(l)) return false;
            return true;
        });
        return kept.join('\\n').trim();
    }

    async runCommandWithFallback(command) {
        try {
            return await execAsync(command);
        } catch (error) {
            const msg = ((error && error.stderr) || '') + ((error && error.message) || '');
            if (!/not found|command not found/i.test(msg)) {
                throw error;
            }
            return await this.runCommandViaInteractiveShell(command);
        }
    }

    async runCommandViaInteractiveShell(command) {
        const shell = process.env.SHELL || '/bin/bash';
        const scriptFile = path.join(os.tmpdir(), 'clipwait-cmd-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.sh');
        await fs.writeFile(scriptFile, command, 'utf8');
        try {
            return await execAsync(this.shellQuote(shell) + ' -i ' + this.shellQuote(scriptFile));
        } finally {
            try { await fs.unlink(scriptFile); } catch (e) { /* ignore */ }
        }
    }

    async executeCommands(profile) {
        if (!profile.commands || profile.commands.length === 0) {
            return true; // nothing to execute, considered finished
        }
        
        this.log('Executing ' + profile.commands.length + ' command(s)...');
        
        for (let i = 0; i < profile.commands.length; i++) {
            const command = profile.commands[i];
            this.log('[' + (i + 1) + '/' + profile.commands.length + '] Executing: ' + command);
            await this.updateMetadataActivity('command', command);
            
            try {
                const { stdout, stderr } = await this.runCommandWithFallback(command);
                const cleanStdout = (stdout || '').trim();
                const cleanStderr = this.filterShellNoise(stderr);
                if (cleanStdout) this.log('  Output: ' + cleanStdout);
                if (cleanStderr) this.log('  Stderr: ' + cleanStderr);
                this.log('  ✓ Command completed successfully');
            } catch (error) {
                const cleanMessage = this.filterShellNoise(error.message) || error.message;
                this.log('  ✗ Command failed: ' + cleanMessage);
                return false; // did not finish all commands
            }
        }
        return true; // all commands executed
    }
    
    sendCompletionSignal() {
        // Send a bell character to the tracked terminal to notify user
        if (this.trackerTty) {
            try {
                const ttyDevice = '/dev/' + this.trackerTty;
                execSync('printf "\\a" > ' + ttyDevice);
                this.log('🔔 Notification signal sent to terminal ' + ttyDevice);
            } catch (error) {
                this.log('⚠ Could not send notification signal: ' + error.message);
            }
        } else {
            this.log('🔔 No terminal TTY to send notification signal.');
        }
        // Also log a clear message
        this.log('✅ All profile commands have been executed successfully.');
    }
    
    async checkClipboard() {
        if (this.isPaused) {
            return;
        }
        
        await this.checkDirectoryChange();
        
        const currentContent = await this.getClipboardContent();
        
        if (currentContent && currentContent !== this.lastClipboardContent) {
            this.lastClipboardContent = currentContent;
            this.log('New clipboard content detected');
            
            if (this.tagRestrictMode) {
                if (this.isStructGeneratorInstruction(currentContent)) {
                    this.log('✗ Tag Restrict Mode: Content rejected (struct generator instruction)');
                    return;
                }
                
                if (!this.hasCodeReplacerTags(currentContent)) {
                    this.log('✗ Tag Restrict Mode: Content rejected (no CODEREPLACER tags)');
                    return;
                }
                this.log('✓ Tag Restrict Mode: CODEREPLACER tags detected');
            }
            
            if (!this.validateCodeReplacerPaths(currentContent)) {
                this.log('✗ Clipboard content rejected due to path validation failure');
                return;
            }
            
            const writeSuccess = await this.writeToFile(currentContent);
            
            if (writeSuccess && this.profileName) {
                const profile = this.config.profiles[this.profileName];
                if (profile) {
                    const allCommandsFinished = await this.executeCommands(profile);
                    if (this.notifyMode && allCommandsFinished) {
                        this.sendCompletionSignal();
                    }
                    if (this.pauseAfterMode && allCommandsFinished) {
                        if (this.pauseAfterAutoMode) {
                            this.log('✓ Auto mode: monitoring continues, waiting for the next clipboard change...');
                        } else {
                            this.isPaused = true;
                            this.log('⏸️  Auto-paused after commands finished');
                        }
                    }
                    if (this.nextDiffMode && allCommandsFinished) {
                        const freshContent = await this.getClipboardContent();
                        this.lastClipboardContent = freshContent;
                        this.log('✓ Next-Diff mode: waiting for clipboard content different from the last...');
                    }
                }
            }
        }
    }
    
    async start() {
        this.log('🚀 Background Clipboard Monitor Started');
        this.log('   Current root: ' + this.currentRoot);
        if (this.trackerShellPid) {
            this.log('   Initial shell PID: ' + this.trackerShellPid);
            if (this.trackerSessionId) {
                this.log('   Session ID: ' + this.trackerSessionId);
            }
        }
        
        await this.loadConfig();
        
        if (this.profileName && this.config.profiles[this.profileName]) {
            const profile = this.config.profiles[this.profileName];
            const outputFile = profile.outputFile || this.profileName;
            this.outputPath = path.join(this.currentRoot, outputFile);
            this.log('   Output file: ' + this.outputPath);
        } else {
            this.log('✗ No profile specified or profile not found');
            return;
        }
        
        // Skip initial clipboard content - only process changes after monitoring starts
        this.lastClipboardContent = await this.getClipboardContent();
        this.log('ℹ️  Current clipboard content will be ignored - waiting for new changes...');
        
        while (this.isMonitoring) {
            await this.checkClipboard();
            await new Promise(resolve => setTimeout(resolve, this.config.interval));
        }
    }
}

const monitor = new BackgroundClipboardMonitor();

process.on('SIGINT', () => {
    monitor.isMonitoring = false;
    monitor.log('👋 Background monitor stopped');
    process.exit(0);
});

process.on('SIGTERM', () => {
    monitor.isMonitoring = false;
    monitor.log('👋 Background monitor stopped');
    process.exit(0);
});

monitor.start().catch(error => {
    monitor.log('✗ Fatal error: ' + error.message);
    process.exit(1);
});
`;
    }

    async loadBgMetadata() {
        const metadataPath = path.join(this.configDir, 'bg-processes.json');
        try {
            const data = await fs.readFile(metadataPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { processes: [] };
            }
            console.error('Error loading bg metadata:', error);
            return { processes: [] };
        }
    }

    async saveBgMetadata(data) {
        const metadataPath = path.join(this.configDir, 'bg-processes.json');
        await fs.mkdir(path.dirname(metadataPath), { recursive: true });
        await fs.writeFile(metadataPath, JSON.stringify(data, null, 2), 'utf8');
    }

    formatIdleTime(seconds) {
        if (seconds < 60) return `${seconds}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
        return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    }

    async manageBackgroundProcesses() {
        console.log('\n' + '='.repeat(70));
        console.log('ClipWait Background Processes');
        console.log('='.repeat(70));

        let metadata = await this.loadBgMetadata();
        let processes = metadata.processes || [];
        const syPMList = SyPM.list();

        // Auto-cleanup dead processes
        const aliveProcesses = processes.filter(bgProc => {
            const syProc = syPMList.find(p => p.id === bgProc.sypmId);
            return syProc && (syProc.status === 'Running' || syProc.status === 'Restarting');
        });
        if (aliveProcesses.length !== processes.length) {
            const removedCount = processes.length - aliveProcesses.length;
            metadata.processes = aliveProcesses;
            await this.saveBgMetadata(metadata);
            processes = aliveProcesses;
            console.log(`🧹 Auto-cleaned ${removedCount} dead process(es).`);
        }

        if (processes.length === 0) {
            console.log('No ClipWait background processes running.');
            console.log('Start one with: node clipwait.js --bg <profile>');
            return;
        }

        // Capture current session for highlighting
        const info = this.captureTerminalInfo();
        const currentSessionId = info.sessionId;

        // Display compact list
        for (let i = 0; i < processes.length; i++) {
            const bgProc = processes[i];
            const syProc = syPMList.find(p => p.id === bgProc.sypmId);
            const isAlive = syProc && (syProc.status === 'Running' || syProc.status === 'Restarting');
            const statusSymbol = isAlive ? '🟢' : '🔴';
            const pid = syProc ? syProc.pid : 'N/A';
            const idleSeconds = bgProc.lastActivityAt ? Math.floor((Date.now() - new Date(bgProc.lastActivityAt).getTime()) / 1000) : null;
            const idleStr = idleSeconds === null ? 'N/A' : this.formatIdleTime(idleSeconds);
            const isCurrentSession = currentSessionId && bgProc.sessionId === currentSessionId;
            const sessionMarker = isCurrentSession ? ' *' : '';

            let line = `${i+1}. [${statusSymbol}] ${bgProc.name} PID:${pid} idle:${idleStr}${sessionMarker}`;
            if (isCurrentSession) {
                line = `\x1b[1;32m${line}\x1b[0m`; // bold green
            } else if (!isAlive) {
                line = `\x1b[31m${line}\x1b[0m`; // red
            }
            console.log(line);
        }
        if (currentSessionId) {
            console.log('* = process from current terminal session');
        }

        console.log('\nOptions:');
        console.log('  l <num>  Show live logs');
        console.log('  d <num>  Show details');
        console.log('  r <num>  Remove (kill)');
        console.log('  q        Quit manager');

        while (true) {
            const input = await this.question('\nAction: ');
            const parts = input.trim().split(/\s+/);
            if (parts.length === 0) continue;
            const cmd = parts[0].toLowerCase();

            if (cmd === 'q') break;

            if ((cmd === 'r' || cmd === 'l' || cmd === 'd') && parts.length >= 2) {
                const idx = parseInt(parts[1]) - 1;
                if (idx >= 0 && idx < processes.length) {
                    const bgProc = processes[idx];
                    if (cmd === 'r') {
                        console.log(`Removing process: ${bgProc.name} (${bgProc.sypmId})`);
                        const killed = SyPM.kill(bgProc.sypmId);
                        if (killed) {
                            metadata.processes = metadata.processes.filter(p => p.bgToken !== bgProc.bgToken);
                            await this.saveBgMetadata(metadata);
                            console.log('✓ Process removed from manager.');
                        } else {
                            console.log('⚠ Could not kill process.');
                        }
                        // Refresh and return to show updated list
                        return this.manageBackgroundProcesses();
                    } else if (cmd === 'l') {
                        console.log(`Following logs for ${bgProc.name}...`);
                        SyPM.log(bgProc.sypmId);
                        console.log('Log following ended.');
                    } else if (cmd === 'd') {
                        this.showBgProcessDetails(bgProc, syPMList.find(p => p.id === bgProc.sypmId));
                    }
                } else {
                    console.log('Invalid process number.');
                }
            } else {
                console.log('Invalid command.');
            }
        }
    }

    showBgProcessDetails(bgProc, syProc) {
        const isAlive = syProc && (syProc.status === 'Running' || syProc.status === 'Restarting');
        const status = isAlive ? '🟢 Running' : '🔴 Dead';
        const idleSeconds = bgProc.lastActivityAt ? Math.floor((Date.now() - new Date(bgProc.lastActivityAt).getTime()) / 1000) : null;
        const idleStr = idleSeconds === null ? 'N/A' : this.formatIdleTime(idleSeconds);
        console.log(`\nDetails for ${bgProc.name}:`);
        console.log(`  Status: ${status}`);
        console.log(`  SyPM ID: ${bgProc.sypmId} | PID: ${syProc ? syProc.pid : 'N/A'}`);
        console.log(`  Profile: ${bgProc.profile}`);
        console.log(`  Terminal: tty=${bgProc.tty || '?'}, shellPID=${bgProc.shellPid}, session=${bgProc.sessionId || '?'}`);
        console.log(`  Started: ${new Date(bgProc.startedAt).toLocaleString()}`);
        console.log(`  Last Activity: ${bgProc.lastActivityAt ? new Date(bgProc.lastActivityAt).toLocaleString() + ' (' + idleStr + ' idle)' : 'Never'}`);
        console.log(`  Last 3 Paths:`);
        if (bgProc.lastTrackedDirs && bgProc.lastTrackedDirs.length > 0) {
            bgProc.lastTrackedDirs.forEach(dir => console.log(`    - ${dir}`));
        } else {
            console.log(`    (none)`);
        }
        console.log(`  Last 5 Commands:`);
        if (bgProc.executedCommands && bgProc.executedCommands.length > 0) {
            bgProc.executedCommands.forEach(cmd => console.log(`    - ${cmd}`));
        } else {
            console.log(`    (none)`);
        }
        if (syProc && syProc.log) {
            console.log(`  Log: ${syProc.log}`);
        }
    }

    async showStatusForCurrentSession() {
        console.log('🔍 Checking ClipWait background process for current terminal session...');
        const info = this.captureTerminalInfo();
        if (!info.sessionId) {
            console.log('✗ Could not determine terminal session ID.');
            return;
        }
        const metadata = await this.loadBgMetadata();
        const processes = (metadata.processes || []).filter(p => p.sessionId === info.sessionId);
        if (processes.length === 0) {
            console.log('No ClipWait background process found for this session.');
            return;
        }
        // Filter alive
        const syPMList = SyPM.list();
        const alive = processes.filter(p => {
            const syProc = syPMList.find(sp => sp.id === p.sypmId);
            return syProc && (syProc.status === 'Running' || syProc.status === 'Restarting');
        });
        if (alive.length === 0) {
            console.log('No alive ClipWait background process for this session.');
            return;
        }
        // Sort by startedAt descending, pick first
        alive.sort((a,b) => new Date(b.startedAt) - new Date(a.startedAt));
        const target = alive[0];
        console.log(`Following logs for ClipWait background process: ${target.name} (ID: ${target.sypmId})`);
        console.log('Press Ctrl+C to stop following logs...\n');
        
        // Use tail -f to continuously follow the log file
        const logPath = path.join(os.homedir(), '.clipboard-monitor', 'clipwait-bg-' + target.bgToken + '.log');
        const tailProcess = exec('tail -f "' + logPath + '"');
        
        tailProcess.stdout.on('data', (data) => {
            process.stdout.write(data);
        });
        
        tailProcess.stderr.on('data', (data) => {
            process.stderr.write(data);
        });
        
        // Wait for user to press Ctrl+C
        await new Promise((resolve) => {
            const handleSignal = () => {
                tailProcess.kill();
                process.removeListener('SIGINT', handleSignal);
                process.removeListener('SIGTERM', handleSignal);
                resolve();
            };
            process.on('SIGINT', handleSignal);
            process.on('SIGTERM', handleSignal);
        });
    }

    async startBackgroundMode(profileName, notifyMode = false, pauseAfterMode = false, pauseAfterAutoMode = false) {
        console.log('🚀 Starting ClipWait in background mode with terminal tracking...');
        
        // Capture terminal info before backgrounding
        const info = this.captureTerminalInfo();
        if (!info.shellPid) {
            console.error('✗ Could not find shell PID. Cannot track terminal directory.');
            return false;
        }
        
        this.trackerShellPid = info.shellPid;
        this.trackerTty = info.tty;
        this.trackerSessionId = info.sessionId; // NEW
        
        console.log(`✓ Shell PID: ${info.shellPid}`);
        console.log(`✓ TTY: ${info.tty || 'unknown'}`);
        console.log(`✓ Session ID: ${info.sessionId || 'unknown'}`);
        console.log(`✓ Current directory: ${this.currentRoot}`);
        if (notifyMode) {
            console.log('🔔 Notification mode enabled: will send terminal signal when commands finish.');
        }
        if (pauseAfterMode) {
            if (pauseAfterAutoMode) {
                console.log('⏸️  Auto-wait-after-commands mode enabled (no manual resume needed).');
            } else {
                console.log('⏸️  Auto-pause-after-commands mode enabled.');
            }
        }
        if (this.nextDiffMode) {
            console.log('🔁 Next-Diff mode enabled: after commands finish, only clipboard content different from the last will be processed.');
        }
        
        // Generate unique token for this background process
        const bgToken = `bg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const processName = `clipwait-bg-${bgToken}`;
        
        // Create background script
        const bgScript = this.createBackgroundScript(
            profileName || this.config.activeProfile,
            this.tagRestrictMode,
            info.shellPid,
            info.tty,
            info.sessionId,
            bgToken,
            notifyMode,
            pauseAfterMode,
            pauseAfterAutoMode,
            this.nextDiffMode
        );
        
        // Write background script to temp file
        const bgFile = path.join(this.configDir, `clipwait-bg-${bgToken}.mjs`);
        await fs.writeFile(bgFile, bgScript, 'utf8');
        
        console.log('📝 Created background script: ' + bgFile);
        console.log('🚀 Starting background process with SyPM...');
        
        try {
            const processInfo = SyPM.run(bgFile, {
                name: processName,
                autoRestart: true,
                restartTries: 10,
                uniqueNameLock: true
            });
            
            // Save metadata
            const metadata = await this.loadBgMetadata();
            metadata.processes = metadata.processes || [];
            metadata.processes.push({
                bgToken: bgToken,
                sypmId: processInfo.id,
                name: processName,
                profile: profileName,
                shellPid: info.shellPid,
                tty: info.tty,
                sessionId: info.sessionId,
                startedAt: new Date().toISOString(),
                lastActivityAt: new Date().toISOString(),
                lastTrackedDirs: [this.currentRoot],
                executedCommands: [],
                currentRoot: this.currentRoot
            });
            await this.saveBgMetadata(metadata);
            
            console.log('✅ ClipWait background process started successfully!');
            console.log('📋 Process Info:');
            console.log('  - Name: ' + processInfo.name);
            console.log('  - PID: ' + processInfo.pid);
            console.log('  - ID: ' + processInfo.id);
            console.log('  - Log: ' + processInfo.log);
            
            console.log('\n📝 To manage background processes:');
            console.log('  node clipwait.js --bg');
            
            console.log('\n📝 To view logs:');
            console.log('  node SyPM.js --log ' + processInfo.id);
            console.log('  or');
            console.log('  tail -f ' + path.join(os.tmpdir(), 'clipwait-bg-' + bgToken + '.log'));
            
            console.log('\n🔍 To stop ClipWait:');
            console.log('  node SyPM.js --kill ' + processInfo.id);
            console.log('  or');
            console.log('  node SyPM.js --kill ' + processName);
            
            return true;
        } catch (error) {
            console.error('❌ Error starting background process:', error);
            return false;
        }
    }

    async mainMenu() {
        await this.loadOrCreateConfig();
        
        const args = process.argv.slice(2);
        let tagMode = false;
        let bgModeRequested = false;
        let statusMode = false;
        let notifyMode = false;
        let pauseAfterMode = false;
        let pauseAfterAutoMode = false;
        let nextDiffMode = false;
        let argProfile = null;
        
        // Parse arguments in any order, track explicit flags
        const remainingArgs = [];
        let explicitBg = false;
        let explicitTag = false;
        let explicitNotify = false;
        let explicitPauseAfter = false;
        let explicitPauseAfterAuto = false;
        let explicitPauseChosen = false;
        let explicitNextDiff = false;
        for (const arg of args) {
            if (arg === '--tag') {
                tagMode = true;
                explicitTag = true;
            } else if (arg === '--bg') {
                bgModeRequested = true;
                explicitBg = true;
            } else if (arg === '--status') {
                statusMode = true;
            } else if (arg === '--notify') {
                notifyMode = true;
                explicitNotify = true;
            } else if (arg === '--pause-after') {
                pauseAfterMode = true;
                explicitPauseAfter = true;
                explicitPauseChosen = true;
            } else if (arg === '--pause-after-auto') {
                pauseAfterMode = true;
                pauseAfterAutoMode = true;
                explicitPauseAfterAuto = true;
                explicitPauseChosen = true;
            } else if (arg === '--next-diff') {
                nextDiffMode = true;
                explicitNextDiff = true;
            } else {
                remainingArgs.push(arg);
            }
        }
        
        if (statusMode) {
            await this.showStatusForCurrentSession();
            this.rl.close();
            return;
        }
        
        if (remainingArgs.length > 0) {
            argProfile = remainingArgs[0];
            // Apply profile default flags if not explicitly set
            const profile = this.config.profiles[argProfile];
            if (profile) {
                if (!explicitBg && profile.defaultBg) bgModeRequested = true;
                if (!explicitTag && profile.defaultTag) tagMode = true;
                if (!explicitNotify && profile.defaultNotify) notifyMode = true;
                if (!explicitPauseChosen) {
                    if (profile.defaultPauseAfterAuto) {
                        pauseAfterMode = true;
                        pauseAfterAutoMode = true;
                    } else if (profile.defaultPauseAfter) {
                        pauseAfterMode = true;
                    }
                }
                if (!explicitNextDiff && profile.defaultNextDiff) nextDiffMode = true;
            }
        }
        
        if (tagMode) {
            this.tagRestrictMode = true;
            console.log('🔒 Tag Restrict Mode enabled: Only content with CODEREPLACER tags will be processed.');
            console.log('   Struct generator instructions will be automatically filtered out.');
        }
        
        if (bgModeRequested) {
            this.bgMode = true;
            console.log('🔍 Background Mode enabled.');
        }

        if (pauseAfterMode) {
            this.pauseAfterMode = true;
            if (pauseAfterAutoMode) {
                this.pauseAfterAutoMode = true;
                console.log('⏸️  Auto-Wait After Commands mode enabled: monitoring will continue automatically after commands finish (no need to press P).');
            } else {
                console.log('⏸️  Auto-Pause After Commands mode enabled: monitoring will pause after all commands finish.');
            }
        }

        if (nextDiffMode) {
            this.nextDiffMode = true;
            console.log('🔁 Next-Diff mode enabled: after commands finish, only clipboard content different from the last will be processed.');
        }
        
        // If background mode is enabled and no profile specified, open manager
        if (this.bgMode && !argProfile) {
            await this.manageBackgroundProcesses();
            this.rl.close();
            return;
        }
        
        // If background mode is enabled with a profile, start background process and exit
        if (this.bgMode) {
            if (argProfile && !this.config.profiles[argProfile]) {
                console.error(`✗ Profile "${argProfile}" not found.`);
                return;
            }
            
            await this.startBackgroundMode(argProfile, notifyMode, pauseAfterMode, pauseAfterAutoMode);
            this.rl.close();
            return;
        }
        
        // Regular mode
        if (argProfile && this.config.profiles[argProfile]) {
            await this.startMonitoring(argProfile);
            return;
        }
        
        while (true) {
            console.log('\n' + '='.repeat(60));
            console.log('Clipboard Monitor - Main Menu');
            if (this.tagRestrictMode) {
                console.log('🔒 TAG RESTRICT MODE ACTIVE');
                console.log('   (Struct generator instructions filtered)');
            }
            console.log('='.repeat(60));
            console.log('1. Start monitoring');
            console.log('2. Manage profiles');
            console.log('3. Show profiles');
            console.log('4. Exit');
            
            const choice = await this.question('\nSelect option: ');
            
            switch (choice) {
                case '1':
                    await this.showProfiles();
                    const profileName = await this.question('\nEnter profile name to start: ');
                    if (this.config.profiles[profileName]) {
                        await this.startMonitoring(profileName);
                    } else {
                        console.log('Profile not found.');
                    }
                    break;
                case '2':
                    await this.manageProfiles();
                    break;
                case '3':
                    await this.showProfiles();
                    break;
                case '4':
                    console.log('Goodbye!');
                    this.rl.close();
                    process.exit(0);
                default:
                    console.log('Invalid option.');
            }
        }
    }
}

const monitor = new ClipboardMonitor();

process.on('SIGINT', () => {
    console.log('\nReceived SIGINT. Stopping...');
    monitor.isMonitoring = false;
    monitor.rl.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Stopping...');
    monitor.isMonitoring = false;
    monitor.rl.close();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    monitor.isMonitoring = false;
    monitor.rl.close();
    process.exit(1);
});

// Only set up interactive key handling if not in background mode
if (!process.argv.includes('--bg')) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key) => {
        if (key === 'p' || key === 'P') {
            if (monitor.isMonitoring) {
                monitor.togglePause();
            }
        }
        if (key === '\u0003') {
            console.log('\nReceived Ctrl+C. Stopping...');
            monitor.isMonitoring = false;
            monitor.rl.close();
            process.exit(0);
        }
    });
}

monitor.mainMenu().catch(error => {
    console.error('Failed to start:', error);
    process.exit(1);
});