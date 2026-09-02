import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import readline from 'readline';

const execAsync = promisify(exec);

class ClipboardMonitor {
    constructor() {
        this.configDir = path.join(os.tmpdir(), 'clipboard-monitor');
        this.configPath = path.join(this.configDir, 'clipboard-config.json');
        this.outputPath = path.join(process.cwd(), 'result');
        this.lastClipboardContent = '';
        this.isMonitoring = false;
        this.isPaused = false;
        this.tagRestrictMode = false;
        this.config = {
            profiles: {},
            activeProfile: null,
            interval: 1000
        };
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
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
        try {
            await this.ensureConfigDirectory();
            const configData = await fs.readFile(this.configPath, 'utf8');
            this.config = { ...this.config, ...JSON.parse(configData) };
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

    async executeCommands(profile) {
        if (!profile.commands || profile.commands.length === 0) {
            console.log('No commands to execute');
            return;
        }

        console.log('Waiting for file creation to complete...');
        const fileCreated = await this.waitForFileCreation(this.outputPath);
        
        if (!fileCreated) {
            console.error('✗ File was not created within timeout period');
            return;
        }

        console.log(`✓ File confirmed created and stable: ${this.outputPath}`);
        console.log(`Executing ${profile.commands.length} command(s) sequentially...`);
        
        for (let i = 0; i < profile.commands.length; i++) {
            const command = profile.commands[i];
            console.log(`[${i + 1}/${profile.commands.length}] Executing: ${command}`);
            
            try {
                const { stdout, stderr } = await execAsync(command);
                if (stdout) {
                    console.log(`  Output: ${stdout.trim()}`);
                }
                if (stderr) {
                    console.log(`  Stderr: ${stderr.trim()}`);
                }
                console.log(`  ✓ Command completed successfully`);
            } catch (error) {
                console.error(`  ✗ Command failed: ${error.message}`);
                const continueExec = await this.question('  Continue with next commands? (y/n): ');
                if (continueExec.toLowerCase() !== 'y') {
                    console.log('  Stopping command execution.');
                    break;
                }
            }
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

    validateCodeReplacerPaths(content) {
        const START = '[CODEREPLACER-START]';
        const END = '[/CODEREPLACER-END]';
        const basePath = process.cwd();

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

    async checkClipboard() {
        if (this.isPaused) {
            return;
        }
        
        const currentContent = await this.getClipboardContent();
        
        if (currentContent && currentContent !== this.lastClipboardContent) {
            this.lastClipboardContent = currentContent;
            console.log('\n' + '='.repeat(60));
            console.log('New clipboard content detected!');

            if (this.tagRestrictMode) {
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
            
            if (writeSuccess && this.config.activeProfile) {
                const profile = this.config.profiles[this.config.activeProfile];
                if (profile) {
                    await this.executeCommands(profile);
                }
            }
            
            console.log('='.repeat(60) + '\n');
        }
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
            const isActive = name === this.config.activeProfile ? ' [ACTIVE]' : '';
            console.log(`\n${index + 1}. ${name}${isActive}`);
            console.log(`   Output file: ${profile.outputFile || name}`);
            console.log(`   Commands: ${profile.commands.length}`);
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
        
        this.config.profiles[name] = {
            outputFile,
            commands
        };
        
        if (!this.config.activeProfile) {
            this.config.activeProfile = name;
        }
        
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
        
        console.log('Current commands:');
        this.config.profiles[name].commands.forEach((cmd, index) => {
            console.log(`  ${index + 1}. ${cmd}`);
        });
        
        const editCommands = await this.question('Do you want to edit commands? (y/n): ');
        if (editCommands.toLowerCase() === 'y') {
            const commands = [];
            console.log('Enter new commands (one per line, empty line to finish):');
            while (true) {
                const command = await this.question(`Command ${commands.length + 1}: `);
                if (!command) break;
                commands.push(command);
            }
            this.config.profiles[name].commands = commands;
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
            if (this.config.activeProfile === name) {
                this.config.activeProfile = Object.keys(this.config.profiles)[0] || null;
            }
            await this.saveConfig();
            console.log(`✓ Profile "${name}" deleted successfully.`);
        }
    }

    async setActiveProfile() {
        await this.showProfiles();
        const name = await this.question('\nProfile name to set as active: ');
        
        if (!this.config.profiles[name]) {
            console.log('Profile not found.');
            return;
        }
        
        this.config.activeProfile = name;
        await this.saveConfig();
        console.log(`✓ Active profile set to "${name}".`);
    }

    async manageProfiles() {
        while (true) {
            console.log('\n' + '='.repeat(60));
            console.log('Profile Management');
            console.log('='.repeat(60));
            console.log('1. Show profiles');
            console.log('2. Add new profile');
            console.log('3. Edit profile');
            console.log('4. Delete profile');
            console.log('5. Set active profile');
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
                    await this.deleteProfile();
                    break;
                case '5':
                    await this.setActiveProfile();
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
            console.log('\n▶️  Monitoring RESUMED');
        }
    }

    async startMonitoring(profileName) {
        if (profileName) {
            if (this.config.profiles[profileName]) {
                this.config.activeProfile = profileName;
                this.outputPath = path.join(process.cwd(), this.config.profiles[profileName].outputFile || profileName);
                await this.saveConfig();
            } else {
                console.error(`✗ Profile "${profileName}" not found.`);
                return false;
            }
        } else if (this.config.activeProfile && this.config.profiles[this.config.activeProfile]) {
            this.outputPath = path.join(process.cwd(), this.config.profiles[this.config.activeProfile].outputFile || this.config.activeProfile);
        } else {
            console.log('No active profile set. Please configure profiles first.');
            return false;
        }
        
        await this.ensureDirectoryExists();
        this.lastClipboardContent = await this.getClipboardContent();
        this.isMonitoring = true;
        this.isPaused = false;
        
        const activeProfile = this.config.profiles[this.config.activeProfile];
        
        console.log('\n' + '='.repeat(60));
        console.log('Clipboard Monitor Started');
        console.log('='.repeat(60));
        console.log(`Active profile: ${this.config.activeProfile}`);
        console.log(`Output file: ${this.outputPath}`);
        console.log(`Commands to execute: ${activeProfile.commands.length}`);
        if (this.tagRestrictMode) {
            console.log('🔒 TAG RESTRICT MODE: Only content with CODEREPLACER tags will be processed');
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

    async mainMenu() {
        await this.loadOrCreateConfig();
        
        const args = process.argv.slice(2);
        const tagIndex = args.indexOf('--tag');
        let argProfile = null;
        
        if (tagIndex !== -1) {
            this.tagRestrictMode = true;
            console.log('🔒 Tag Restrict Mode enabled: Only content with CODEREPLACER tags will be processed.');
            args.splice(tagIndex, 1);
            argProfile = args[0];
        } else {
            argProfile = args[0];
        }
        
        if (argProfile && this.config.profiles[argProfile]) {
            await this.startMonitoring(argProfile);
            return;
        }
        
        while (true) {
            console.log('\n' + '='.repeat(60));
            console.log('Clipboard Monitor - Main Menu');
            if (this.tagRestrictMode) {
                console.log('🔒 TAG RESTRICT MODE ACTIVE');
            }
            console.log('='.repeat(60));
            console.log('1. Start monitoring');
            console.log('2. Manage profiles');
            console.log('3. Show profiles');
            console.log('4. Exit');
            
            const choice = await this.question('\nSelect option: ');
            
            switch (choice) {
                case '1':
                    if (this.config.activeProfile && this.config.profiles[this.config.activeProfile]) {
                        await this.startMonitoring();
                    } else {
                        console.log('No active profile. Please set a profile first.');
                        await this.showProfiles();
                        const profileName = await this.question('\nEnter profile name to start: ');
                        if (this.config.profiles[profileName]) {
                            await this.startMonitoring(profileName);
                        } else {
                            console.log('Profile not found.');
                        }
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

monitor.mainMenu().catch(error => {
    console.error('Failed to start:', error);
    process.exit(1);
});