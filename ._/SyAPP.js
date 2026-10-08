import readline from 'readline';
import { stdin, stdout } from 'process';
import EventEmitter from 'events';
import { readFileSync, existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'http';
import url from 'url';
import querystring from 'querystring';
import os from 'os'


class ConfigManager {
    static configPath = path.join(process.cwd(), 'config.json');

    static loadConfig() {
        // Check if the config file exists
        if (!fs.existsSync(this.configPath)) {
            return {};
        } else {
            // If it exists, load and return the config object
            return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        }
    }

    static getConfig() {
        return this.loadConfig();
    }

    static updateConfig(newConfig) {
        // Read the existing config, merge with newConfig, and write back
        const config = this.loadConfig();
        const updatedConfig = { ...config, ...newConfig };
        fs.writeFileSync(this.configPath, JSON.stringify(updatedConfig, null, 2));  // Pretty print JSON
        return updatedConfig;
    }

    static setKey(key, value) {
        // Set a specific key-value pair in the config
        const config = this.loadConfig();
        config[key] = value;
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));  // Pretty print JSON
    }

    static getKey(key) {
        // Get a specific value by key from the config
        const config = this.loadConfig();
        return config[key];
    }

    static deleteKey(key) {
        // Delete a specific key-value pair from the config
        const config = this.loadConfig();
        delete config[key];
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));  // Pretty print JSON
    }

    static getAllKeys() {
        // Return an array of all keys in the config
        const config = this.loadConfig();
        return Object.keys(config);
    }
}

class LogMaster {
    static logFilePath = path.join(process.cwd(), 'log.json');
    static tempLogFilePath = path.join(process.cwd(), 'templog.json');
    static hudSocketPath = process.platform === 'win32' ? '\\\\.\\pipe\\logmaster' : '/tmp/logmaster.sock';
    static eventEmitter = new EventEmitter();
    static isWatching = false;
    static activeTypeFilter = null;
    static socket = null;

    static ensureLogFileExists() {
        if (!fs.existsSync(this.logFilePath)) {
            fs.writeFileSync(this.logFilePath, '[]', 'utf-8');
        }
    }

    /**
     * Creates a log entry with optional status mode for refreshing instances
     * @param {string} type - The type/category of the log
     * @param {*} eventContent - The content of the log event
     * @param {Object} [config] - Configuration options for logging
     * @param {boolean} [config.statusMode=false] - If true, refreshes existing log of same type instead of creating new instance
     * @example
     * // Regular log entry
     * LogMaster.Log('error', 'User not found');
     * 
     * // Status mode log that refreshes/updates existing entry
     * LogMaster.Log('system_status', { cpu: 45, memory: 80 }, { statusMode: true });
     * LogMaster.Log('system_status', { cpu: 50, memory: 75 }, { statusMode: true }); // Updates previous entry
     */
    static Log(type, eventContent, config = {}) {
        const timestamp = Date.now();
        const date = new Date(timestamp).toLocaleString('pt-BR', {
            timeZone: 'UTC',
            hour12: false,
        });
    
        const logEntry = {
            TimeStamp: timestamp,
            Date: date,
            Type: type,
            EventContent: eventContent,
        };
    
        const writeToSocket = new Promise((resolve) => {
            const client = net.createConnection(this.hudSocketPath, () => {
                client.write(JSON.stringify(logEntry));
                client.end();
                resolve(true);
            });
    
            client.on('error', () => {
                resolve(false);
            });
        });
    
        const writeToFile = () => {
            const shouldLog = ConfigManager.getKey('log');
            if (!shouldLog) return;
    
            this.ensureLogFileExists();
    
            let logs = [];
            if (fs.existsSync(this.logFilePath)) {
                logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
            }
    
            // Handle status mode - update existing log of same type instead of adding new
            if (config.statusMode) {
                const existingIndex = logs.findIndex(log => log.Type === type);
                
                if (existingIndex !== -1) {
                    // Replace existing log entry
                    logs[existingIndex] = logEntry;
                } else {
                    // Add new log entry if no existing one found
                    logs.push(logEntry);
                }
            } else {
                // Regular mode - always add new log entry
                logs.push(logEntry);
            }
    
            fs.writeFileSync(this.logFilePath, JSON.stringify(logs, null, 4), 'utf-8');
        };
    
        writeToSocket.finally(() => {
            writeToFile();
        });
    }

    /**
     * Retrieves logs with various filtering and pagination options
     * @param {Object} options - Configuration options for log retrieval
     * @param {string} [options.type] - Filter logs by specific type
     * @param {string} [options.search] - Search term to filter logs
     * @param {number} [options.limit] - Number of logs to return
     * @param {boolean} [options.reverse=false] - If true, returns logs from newest to oldest
     * @param {number} [options.offset=0] - Number of logs to skip (for pagination)
     * @param {Date} [options.startDate] - Start date for date range filtering
     * @param {Date} [options.endDate] - End date for date range filtering
     * @param {boolean} [options.includeStatusLogs=true] - Include status mode logs in results
     * @returns {Array} Array of log entries matching the criteria
     * @example
     * // Get last 10 logs of type "error"
     * const logs = LogMaster.getLogs({ type: "error", limit: 10, reverse: true });
     * 
     * // Get first 5 logs containing "user" with pagination
     * const logs = LogMaster.getLogs({ search: "user", limit: 5, offset: 0 });
     * 
     * // Get logs from specific date range
     * const startDate = new Date('2024-01-01');
     * const endDate = new Date('2024-01-31');
     * const logs = LogMaster.getLogs({ startDate, endDate });
     */
    static getLogs(options = {}) {
        this.ensureLogFileExists();
        
        let logs = [];
        try {
            if (fs.existsSync(this.logFilePath)) {
                const fileContent = fs.readFileSync(this.logFilePath, 'utf-8').trim();
                
                // Handle empty file
                if (!fileContent) {
                    logs = [];
                } else {
                    logs = JSON.parse(fileContent);
                }
                
                // Ensure logs is always an array
                if (!Array.isArray(logs)) {
                    console.warn('Log file contained non-array data, resetting to empty array');
                    logs = [];
                    // Optionally fix the file
                    fs.writeFileSync(this.logFilePath, '[]', 'utf-8');
                }
            }
        } catch (error) {
            console.error('Error reading log file:', error.message);
            console.log('Resetting log file to empty array');
            logs = [];
            // Reset the file to avoid future errors
            fs.writeFileSync(this.logFilePath, '[]', 'utf-8');
        }
    
        // Rest of your existing filtering code...
        let filteredLogs = logs;
    
        if (options.type) {
            filteredLogs = filteredLogs.filter(log => log.Type === options.type);
        }
    
        if (options.search) {
            const searchTerm = options.search.toLowerCase();
            filteredLogs = filteredLogs.filter(log => 
                JSON.stringify(log).toLowerCase().includes(searchTerm)
            );
        }
    
        if (options.startDate || options.endDate) {
            filteredLogs = filteredLogs.filter(log => {
                const logDate = new Date(log.TimeStamp);
                let valid = true;
                
                if (options.startDate) {
                    valid = valid && logDate >= options.startDate;
                }
                
                if (options.endDate) {
                    valid = valid && logDate <= options.endDate;
                }
                
                return valid;
            });
        }
    
        if (options.reverse) {
            filteredLogs = filteredLogs.reverse();
        }
    
        const offset = options.offset || 0;
        const limit = options.limit || filteredLogs.length;
        
        return filteredLogs.slice(offset, offset + limit);
    }

    /**
     * Gets the latest status log for a specific type
     * @param {string} type - The log type to retrieve status for
     * @returns {Object|null} The latest status log entry or null if not found
     * @example
     * const systemStatus = LogMaster.getStatusLog('system_status');
     * console.log(systemStatus?.EventContent); // { cpu: 50, memory: 75 }
     */
    static getStatusLog(type) {
        const logs = this.getLogs({ type, reverse: true, limit: 1 });
        return logs.length > 0 ? logs[0] : null;
    }

    /**
     * Clears all status logs of a specific type
     * @param {string} type - The log type to clear
     * @returns {boolean} True if logs were cleared, false otherwise
     * @example
     * LogMaster.clearStatusLogs('system_status');
     */
    static clearStatusLogs(type) {
        this.ensureLogFileExists();
        
        let logs = [];
        if (fs.existsSync(this.logFilePath)) {
            logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
        }

        const initialLength = logs.length;
        logs = logs.filter(log => log.Type !== type);
        
        if (logs.length !== initialLength) {
            fs.writeFileSync(this.logFilePath, JSON.stringify(logs, null, 4), 'utf-8');
            return true;
        }
        
        return false;
    }

    static startHUD() {
        if (fs.existsSync(this.hudSocketPath)) {
            fs.unlinkSync(this.hudSocketPath);
        }

        const server = net.createServer((socket) => {
            this.socket = socket;
            socket.on('data', (data) => {
                const logEntry = JSON.parse(data.toString());
                if (this.isWatching) {
                    if (!this.activeTypeFilter || logEntry.Type === this.activeTypeFilter) {
                        this.displayLog(logEntry);
                    }
                }
            });
        });

        server.listen(this.hudSocketPath, () => {
            console.log('HUD watcher started. Listening for logs...');
            this.displayHUDMenu();
        });

        server.on('error', (err) => {
            console.error('Failed to start HUD watcher:', err);
        });

        process.on('exit', () => {
            if (fs.existsSync(this.hudSocketPath)) {
                fs.unlinkSync(this.hudSocketPath);
            }
        });

        process.on('SIGINT', () => process.exit());
        process.on('SIGTERM', () => process.exit());
    }

    static enterWatchMode() {
        console.clear();
        console.log('Entering Watch Mode. Press "q" to return to the main menu.');

        this.isWatching = true;
        const handleKeyPress = (chunk) => {
            if (chunk.trim() === 'q') {
                process.stdin.removeListener('data', handleKeyPress);
                this.isWatching = false;
                if (this.socket) {
                    this.socket.removeAllListeners('data');
                }
                this.displayHUDMenu();
            }
        };

        process.stdin.on('data', handleKeyPress);
    }

    static displayHUDMenu() {
        console.clear();
        console.log('LogMaster HUD Menu');
        console.log('1. View all log types');
        console.log('2. Search logs by term');
        console.log('3. Set real-time filter by type');
        console.log('4. Clear real-time filter');
        console.log('5. Enter Watch Mode');
        console.log('6. View logs with filters');
        console.log('7. View status logs');
        console.log('8. Exit HUD');

        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const handleMenuChoice = (input) => {
            const choice = input.trim();

            switch (choice) {
                case '1':
                    this.displayLogTypes();
                    break;
                case '2':
                    this.promptSearchTerm();
                    break;
                case '3':
                    this.promptSetFilter();
                    break;
                case '4':
                    this.clearFilter();
                    break;
                case '5':
                    this.enterWatchMode();
                    break;
                case '6':
                    this.promptAdvancedFilters();
                    break;
                case '7':
                    this.displayStatusLogs();
                    break;
                case '8':
                    process.exit();
                    break;
                default:
                    console.log('Invalid choice. Please select a valid option.');
                    this.displayHUDMenu();
            }
        };

        process.stdin.once('data', handleMenuChoice);
    }

    static displayLogTypes() {
        this.ensureLogFileExists();
        const logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
        const types = [...new Set(logs.map(log => log.Type))];

        console.log('Available Log Types:');
        types.forEach((type, index) => {
            console.log(`${index + 1}. ${type}`);
        });

        console.log('Select a type by number to view logs or press Enter to return to menu.');

        const handleTypeSelection = (input) => {
            const choice = parseInt(input.trim(), 10);

            if (choice >= 1 && choice <= types.length) {
                const selectedType = types[choice - 1];
                const filteredLogs = this.getLogs({ type: selectedType });
                console.log(`Logs of type "${selectedType}":`, filteredLogs);
            } else {
                console.log('Invalid choice. Returning to menu.');
                this.displayHUDMenu();
                return;
            }

            console.log('Press any key to return to the main menu.');
            process.stdin.once('data', () => this.displayHUDMenu());
        };

        process.stdin.once('data', handleTypeSelection);
    }

    static promptSearchTerm() {
        console.log('Enter a search term:');

        const handleSearchTerm = (input) => {
            const searchTerm = input.trim();
            const filteredLogs = this.getLogs({ search: searchTerm });

            console.log(`Logs containing "${searchTerm}":`, filteredLogs);

            console.log('Press any key to return to the main menu.');
            process.stdin.once('data', () => this.displayHUDMenu());
        };

        process.stdin.once('data', handleSearchTerm);
    }

    static promptAdvancedFilters() {
        console.log('Advanced Log Filtering');
        console.log('Enter filter options as JSON (or press Enter for all logs):');
        console.log('Example: {"type": "error", "limit": 10, "reverse": true}');

        const handleFilterInput = (input) => {
            try {
                const options = input.trim() ? JSON.parse(input.trim()) : {};
                const filteredLogs = this.getLogs(options);
                
                console.log(`Found ${filteredLogs.length} logs:`);
                console.log(filteredLogs);

                console.log('Press any key to return to the main menu.');
                process.stdin.once('data', () => this.displayHUDMenu());
            } catch (error) {
                console.log('Invalid JSON format. Please try again.');
                this.promptAdvancedFilters();
            }
        };

        process.stdin.once('data', handleFilterInput);
    }

    static displayStatusLogs() {
        console.log('Current Status Logs:');
        
        this.ensureLogFileExists();
        const logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
        
        // Find types that have status logs (latest entry for each type)
        const statusLogs = {};
        logs.forEach(log => {
            statusLogs[log.Type] = log; // This will keep only the latest due to iteration order
        });

        const statusEntries = Object.values(statusLogs);
        
        if (statusEntries.length === 0) {
            console.log('No status logs found.');
        } else {
            statusEntries.forEach(log => {
                this.displayLog(log);
                console.log(''); // Add spacing between logs
            });
        }

        console.log('Press any key to return to the main menu.');
        process.stdin.once('data', () => this.displayHUDMenu());
    }

    static promptSetFilter() {
        console.log('Enter the type to filter by in real-time:');

        const handleSetFilter = (input) => {
            this.activeTypeFilter = input.trim();
            console.log(`Real-time filter set to type "${this.activeTypeFilter}".`);
            this.displayHUDMenu();
        };

        process.stdin.once('data', handleSetFilter);
    }

    static clearFilter() {
        this.activeTypeFilter = null;
        console.log('Real-time filter cleared. Displaying all logs.');
        this.displayHUDMenu();
    }

    static displayLog(logEntry) {
        const boxLines = [
            '┌────────────────────────────────────────────────────────┐',
            `│ Date: ${logEntry.Date.padEnd(47)} │`,
            `│ Type: ${logEntry.Type.padEnd(47)} │`,
            '├────────────────────────────────────────────────────────┤',
        ];

        const simplifiedContent = this.simplifyContent(logEntry.EventContent);
        Object.entries(simplifiedContent).forEach(([key, value]) => {
            const line = `│ ${key}: ${String(value).slice(0, 40).padEnd(40)} │`;
            boxLines.push(line);
        });

        boxLines.push('└────────────────────────────────────────────────────────┘');
        console.log(boxLines.join('\n'));
    }

    static simplifyContent(content) {
        if (typeof content === 'object' && content !== null) {
            if (Array.isArray(content)) {
                return '[ARRAY]';
            } else {
                const simplified = {};
                for (const [key, value] of Object.entries(content)) {
                    if (typeof value === 'object') {
                        simplified[key] = '[OBJECT]';
                    } else {
                        simplified[key] = String(value).slice(0, 30);
                    }
                }
                return simplified;
            }
        } else if (typeof content === 'string') {
            return content.slice(0, 50) + (content.length > 50 ? '...' : '');
        } else {
            return String(content);
        }
    }

    // Command line interface when run directly
    static async runCLI() {
        if (process.argv.length > 2) {
            const command = process.argv[2];
            
            switch (command) {
                case 'view':
                    await this.handleViewCommand();
                    break;
                case 'hud':
                    this.startHUD();
                    break;
                case 'types':
                    this.displayAvailableTypes();
                    break;
                case 'status':
                    await this.handleStatusCommand();
                    break;
                case 'help':
                    this.displayHelp();
                    break;
                default:
                    console.log('Unknown command. Use "help" to see available commands.');
                    process.exit(1);
            }
        } else {
            this.displayHelp();
        }
    }

    static async handleViewCommand() {
        const options = {};
        
        for (let i = 3; i < process.argv.length; i++) {
            const arg = process.argv[i];
            
            if (arg === '--type' && process.argv[i + 1]) {
                options.type = process.argv[++i];
            } else if (arg === '--search' && process.argv[i + 1]) {
                options.search = process.argv[++i];
            } else if (arg === '--limit' && process.argv[i + 1]) {
                options.limit = parseInt(process.argv[++i]);
            } else if (arg === '--reverse') {
                options.reverse = true;
            } else if (arg === '--offset' && process.argv[i + 1]) {
                options.offset = parseInt(process.argv[++i]);
            }
        }
        
        const logs = this.getLogs(options);
        console.log(JSON.stringify(logs, null, 2));
    }

    static async handleStatusCommand() {
        const type = process.argv[3]; // Get type from command line
        
        if (type) {
            // Get specific status log
            const statusLog = this.getStatusLog(type);
            if (statusLog) {
                console.log(JSON.stringify(statusLog, null, 2));
            } else {
                console.log(`No status log found for type: ${type}`);
            }
        } else {
            // Show all status logs
            this.ensureLogFileExists();
            const logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
            
            const statusLogs = {};
            logs.forEach(log => {
                statusLogs[log.Type] = log;
            });

            const statusEntries = Object.values(statusLogs);
            console.log(JSON.stringify(statusEntries, null, 2));
        }
    }

    static displayAvailableTypes() {
        this.ensureLogFileExists();
        const logs = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
        const types = [...new Set(logs.map(log => log.Type))];
        
        console.log('Available log types:');
        types.forEach(type => console.log(`- ${type}`));
    }

    static displayHelp() {
        console.log(`
LogMaster CLI Usage:

Commands:
  view [options]        - View logs with filters
  hud                   - Start the HUD interface
  types                 - List all available log types
  status [type]         - View status logs (all or specific type)
  help                  - Show this help message

View Options:
  --type <type>         - Filter by log type
  --search <term>       - Search for term in logs
  --limit <number>      - Limit number of results
  --reverse             - Show newest first
  --offset <number>     - Skip number of results

Status Mode Usage (in code):
  LogMaster.Log('type', content, { statusMode: true });

Examples:
  node LogMaster.js view --type error --limit 10
  node LogMaster.js view --search "user" --reverse
  node LogMaster.js status system_status
  node LogMaster.js status
  node LogMaster.js hud
  node LogMaster.js types
        `);
    }
}


/**
 * Split an array into fixed-size pages.
 *
 * NOTE: this used to silently DROP items whose key set was not a subset
 * of the FIRST item's key set (the "object_model" heuristic). That made
 * mixed-schema arrays — very common in real JSON — lose almost every
 * element, which is exactly the "only 1 instance shows up" symptom.
 *
 * The current implementation includes EVERY item, in original order, so
 * every element of the source array is guaranteed to be reachable.
 */
const BuildPagination = (fullarray = [], items_per_page = 5) => {
  const arr = Array.isArray(fullarray) ? fullarray : [];
  const perPage = Math.max(1, items_per_page | 0) || 1;
  const total = arr.length;
  const pages = [];
  for (let start = 0; start < total; start += perPage) {
    pages.push({
      page: pages.length + 1,
      list: arr.slice(start, Math.min(start + perPage, total))
    });
  }
  return pages;
}

class ColorText {
  // Standard 8/16 colors
  static black(text) {
    return `\x1b[30m${text}\x1b[0m`;
  }

  static red(text) {
    return `\x1b[31m${text}\x1b[0m`;
  }

  static green(text) {
    return `\x1b[32m${text}\x1b[0m`;
  }

  static yellow(text) {
    return `\x1b[33m${text}\x1b[0m`;
  }

  static blue(text) {
    return `\x1b[34m${text}\x1b[0m`;
  }

  static magenta(text) {
    return `\x1b[35m${text}\x1b[0m`;
  }

  static cyan(text) {
    return `\x1b[36m${text}\x1b[0m`;
  }

  static white(text) {
    return `\x1b[37m${text}\x1b[0m`;
  }

  // Bright/Vivid versions (90-97)
  static brightBlack(text) {
    return `\x1b[90m${text}\x1b[0m`;
  }

  static brightRed(text) {
    return `\x1b[91m${text}\x1b[0m`;
  }

  static brightGreen(text) {
    return `\x1b[92m${text}\x1b[0m`;
  }

  static brightYellow(text) {
    return `\x1b[93m${text}\x1b[0m`;
  }

  static brightBlue(text) {
    return `\x1b[94m${text}\x1b[0m`;
  }

  static brightMagenta(text) {
    return `\x1b[95m${text}\x1b[0m`;
  }

  static brightCyan(text) {
    return `\x1b[96m${text}\x1b[0m`;
  }

  static brightWhite(text) {
    return `\x1b[97m${text}\x1b[0m`;
  }

  // 256-color palette - Common colors
  static orange(text) {
    return `\x1b[38;5;208m${text}\x1b[0m`;
  }

  static pink(text) {
    return `\x1b[38;5;205m${text}\x1b[0m`;
  }

  static purple(text) {
    return `\x1b[38;5;129m${text}\x1b[0m`;
  }

  static brown(text) {
    return `\x1b[38;5;130m${text}\x1b[0m`;
  }

  static lime(text) {
    return `\x1b[38;5;154m${text}\x1b[0m`;
  }

  static teal(text) {
    return `\x1b[38;5;30m${text}\x1b[0m`;
  }

  static lavender(text) {
    return `\x1b[38;5;183m${text}\x1b[0m`;
  }

  static salmon(text) {
    return `\x1b[38;5;209m${text}\x1b[0m`;
  }

  static gold(text) {
    return `\x1b[38;5;220m${text}\x1b[0m`;
  }

  static silver(text) {
    return `\x1b[38;5;7m${text}\x1b[0m`;
  }

  // Background colors (standard)
  static bgBlack(text) {
    return `\x1b[40m${text}\x1b[0m`;
  }

  static bgRed(text) {
    return `\x1b[41m${text}\x1b[0m`;
  }

  static bgGreen(text) {
    return `\x1b[42m${text}\x1b[0m`;
  }

  static bgYellow(text) {
    return `\x1b[43m${text}\x1b[0m`;
  }

  static bgBlue(text) {
    return `\x1b[44m${text}\x1b[0m`;
  }

  static bgMagenta(text) {
    return `\x1b[45m${text}\x1b[0m`;
  }

  static bgCyan(text) {
    return `\x1b[46m${text}\x1b[0m`;
  }

  static bgWhite(text) {
    return `\x1b[47m${text}\x1b[0m`;
  }

  // Bright background colors
  static bgBrightBlack(text) {
    return `\x1b[100m${text}\x1b[0m`;
  }

  static bgBrightRed(text) {
    return `\x1b[101m${text}\x1b[0m`;
  }

  static bgBrightGreen(text) {
    return `\x1b[102m${text}\x1b[0m`;
  }

  static bgBrightYellow(text) {
    return `\x1b[103m${text}\x1b[0m`;
  }

  static bgBrightBlue(text) {
    return `\x1b[104m${text}\x1b[0m`;
  }

  static bgBrightMagenta(text) {
    return `\x1b[105m${text}\x1b[0m`;
  }

  static bgBrightCyan(text) {
    return `\x1b[106m${text}\x1b[0m`;
  }

  static bgBrightWhite(text) {
    return `\x1b[107m${text}\x1b[0m`;
  }

  // Text styles
  static bold(text) {
    return `\x1b[1m${text}\x1b[0m`;
  }

  static dim(text) {
    return `\x1b[2m${text}\x1b[0m`;
  }

  static italic(text) {
    return `\x1b[3m${text}\x1b[0m`;
  }

  static underline(text) {
    return `\x1b[4m${text}\x1b[0m`;
  }

  static blink(text) {
    return `\x1b[5m${text}\x1b[0m`;
  }

  static inverse(text) {
    return `\x1b[7m${text}\x1b[0m`;
  }

  static hidden(text) {
    return `\x1b[8m${text}\x1b[0m`;
  }

  static strikethrough(text) {
    return `\x1b[9m${text}\x1b[0m`;
  }

  // Utility methods
  static custom(text, colorCode) {
    if (colorCode >= 0 && colorCode <= 255) {
      return `\x1b[38;5;${colorCode}m${text}\x1b[0m`;
    }
    return text;
  }

  static bgCustom(text, colorCode) {
    if (colorCode >= 0 && colorCode <= 255) {
      return `\x1b[48;5;${colorCode}m${text}\x1b[0m`;
    }
    return text;
  }

  static rgb(text, r, g, b) {
    if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
      return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
    }
    return text;
  }

  static bgRgb(text, r, g, b) {
    if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
      return `\x1b[48;2;${r};${g};${b}m${text}\x1b[0m`;
    }
    return text;
  }

  static combine(text, ...styles) {
    let result = text;
    for (const style of styles) {
      if (typeof style === 'function') {
        result = style(result);
      } else if (typeof style === 'string') {
        // Handle string style names
        const styleMethod = this[style] || this[style.toLowerCase()];
        if (styleMethod) {
          result = styleMethod.call(this, result);
        }
      }
    }
    return result;
  }

  /**
   * Display all available colors with examples
   * @param {string} sampleText - Text to display for each color
   * @param {boolean} showCode - Whether to show the ANSI code
   */
  static showAllColors(sampleText = "Hello World", showCode = true) {
    const colorGroups = {
      "Standard Colors": [
        { name: "black", method: this.black },
        { name: "red", method: this.red },
        { name: "green", method: this.green },
        { name: "yellow", method: this.yellow },
        { name: "blue", method: this.blue },
        { name: "magenta", method: this.magenta },
        { name: "cyan", method: this.cyan },
        { name: "white", method: this.white }
      ],
      "Bright Colors": [
        { name: "brightBlack", method: this.brightBlack },
        { name: "brightRed", method: this.brightRed },
        { name: "brightGreen", method: this.brightGreen },
        { name: "brightYellow", method: this.brightYellow },
        { name: "brightBlue", method: this.brightBlue },
        { name: "brightMagenta", method: this.brightMagenta },
        { name: "brightCyan", method: this.brightCyan },
        { name: "brightWhite", method: this.brightWhite }
      ],
      "256-Color Palette": [
        { name: "orange", method: this.orange },
        { name: "pink", method: this.pink },
        { name: "purple", method: this.purple },
        { name: "brown", method: this.brown },
        { name: "lime", method: this.lime },
        { name: "teal", method: this.teal },
        { name: "lavender", method: this.lavender },
        { name: "salmon", method: this.salmon },
        { name: "gold", method: this.gold },
        { name: "silver", method: this.silver }
      ],
      "Background Colors": [
        { name: "bgBlack", method: this.bgBlack },
        { name: "bgRed", method: this.bgRed },
        { name: "bgGreen", method: this.bgGreen },
        { name: "bgYellow", method: this.bgYellow },
        { name: "bgBlue", method: this.bgBlue },
        { name: "bgMagenta", method: this.bgMagenta },
        { name: "bgCyan", method: this.bgCyan },
        { name: "bgWhite", method: this.bgWhite }
      ],
      "Bright Backgrounds": [
        { name: "bgBrightBlack", method: this.bgBrightBlack },
        { name: "bgBrightRed", method: this.bgBrightRed },
        { name: "bgBrightGreen", method: this.bgBrightGreen },
        { name: "bgBrightYellow", method: this.bgBrightYellow },
        { name: "bgBrightBlue", method: this.bgBrightBlue },
        { name: "bgBrightMagenta", method: this.bgBrightMagenta },
        { name: "bgBrightCyan", method: this.bgBrightCyan },
        { name: "bgBrightWhite", method: this.bgBrightWhite }
      ],
      "Text Styles": [
        { name: "bold", method: this.bold },
        { name: "dim", method: this.dim },
        { name: "italic", method: this.italic },
        { name: "underline", method: this.underline },
        { name: "blink", method: this.blink },
        { name: "inverse", method: this.inverse },
        { name: "hidden", method: this.hidden },
        { name: "strikethrough", method: this.strikethrough }
      ]
    };

    console.log("\n" + this.bold(this.cyan("═".repeat(60))));
    console.log(this.bold(this.cyan("COLOR TEXT DEMONSTRATION")));
    console.log(this.bold(this.cyan("═".repeat(60))) + "\n");

    for (const [groupName, colors] of Object.entries(colorGroups)) {
      console.log(this.bold(this.yellow(`\n${groupName}:`)));
      console.log(this.dim("─".repeat(40)));

      colors.forEach(color => {
        const coloredText = color.method.call(this, sampleText);
        if (showCode) {
          // Extract ANSI code for display
          const match = coloredText.match(/\x1b\[([\d;]+)m/);
          const code = match ? match[1] : 'N/A';
          console.log(`  ${color.name.padEnd(20)} ${coloredText} ${this.dim(`(\\x1b[${code}m)`)}`);
        } else {
          console.log(`  ${color.name.padEnd(20)} ${coloredText}`);
        }
      });
    }

    // Show combination examples
    console.log(this.bold(this.yellow("\nCombination Examples:")));
    console.log(this.dim("─".repeat(40)));
    
    const combos = [
      ["red", "bold"],
      ["green", "underline"],
      ["blue", "italic", "bgYellow"],
      ["magenta", "bold", "underline"],
      ["cyan", "inverse"],
      ["orange", "bold", "bgBlue"]
    ];

    combos.forEach((styles, i) => {
      const result = this.combine(sampleText, ...styles.map(s => this[s]));
      console.log(`  ${styles.join(' + ').padEnd(25)} ${result}`);
    });

    // Show RGB examples
    console.log(this.bold(this.yellow("\nRGB Examples:")));
    console.log(this.dim("─".repeat(40)));
    
    const rgbExamples = [
      { name: "Deep Sky Blue", r: 0, g: 191, b: 255 },
      { name: "Coral", r: 255, g: 127, b: 80 },
      { name: "Spring Green", r: 0, g: 255, b: 127 },
      { name: "Goldenrod", r: 218, g: 165, b: 32 }
    ];

    rgbExamples.forEach(example => {
      const colored = this.rgb(sampleText, example.r, example.g, example.b);
      console.log(`  ${example.name.padEnd(20)} ${colored} ${this.dim(`(${example.r},${example.g},${example.b})`)}`);
    });

    console.log("\n" + this.bold(this.cyan("═".repeat(60))));
    console.log(this.dim("Use ColorText.<method>(text) to apply colors"));
    console.log(this.dim("Example: ColorText.red('Error!')"));
    console.log(this.bold(this.cyan("═".repeat(60))) + "\n");
  }
}

function getMachineID() {
    // Try primary DMI method
    try {
        if (existsSync('/sys/class/dmi/id/product_uuid')) {
            const uuid = readFileSync('/sys/class/dmi/id/product_uuid', 'utf8').trim();
            if (uuid && uuid.length >= 36) {
                return uuid.toUpperCase();
            }
        }
    } catch {}

    // Fallback 1: /etc/machine-id (Linux)
    try {
        if (existsSync('/etc/machine-id')) {
            const id = readFileSync('/etc/machine-id', 'utf8').trim();
            if (id.length >= 32) return `MACHINE-ID-${id}`;
        }
    } catch {}

    // Fallback 2: CPU info serial (Linux ARM)
    try {
        const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
        const lines = cpuinfo.split('\n');
        for (const line of lines) {
            if (line.includes('Serial') && line.includes(':')) {
                const serial = line.split(':')[1].trim();
                if (serial.length > 0) return `CPU-${serial}`;
            }
        }
    } catch {}

    // Fallback 3: MAC address (first network interface)
    try {
        const netPath = '/sys/class/net/';
        const interfaces = execSync(`ls ${netPath}`, { stdio: ['pipe', 'pipe', 'ignore'] })
            .toString()
            .split('\n')
            .filter(iface => iface && !iface.startsWith('lo'));
        
        if (interfaces.length > 0) {
            const mac = readFileSync(`${netPath}${interfaces[0]}/address`, 'utf8').trim();
            if (mac) return `MAC-${mac.replace(/:/g, '').toUpperCase()}`;
        }
    } catch {}

    // Fallback 4: Disk UUID (first disk)
    try {
        const disks = execSync('lsblk -o UUID,MOUNTPOINT -n 2>/dev/null || true', { shell: true })
            .toString()
            .split('\n')
            .filter(line => line && !line.includes('MOUNTPOINT'));
        
        if (disks.length > 0) {
            const diskUuid = disks[0].split(' ')[0].trim();
            if (diskUuid) return `DISK-${diskUuid}`;
        }
    } catch {}

    // Final fallback: Generate hash from hostname + timestamp
    const hostname = typeof window === 'undefined' 
        ? os.hostname() 
        : 'browser';
    
    const hash = createHash('sha256')
        .update(hostname + Date.now().toString())
        .digest('hex')
        .substring(0, 32);
    
    return `GEN-${hash.toUpperCase()}`;
}


//TerminalHUD interface below

/**
 * TerminalHUD - A framework for creating HUD interfaces in terminal
 * Optional mouse support: click to focus, double-click to select, wheel to navigate.
 * Now extends EventEmitter for event-driven architecture.
 * 
 * @class TerminalHUD
 * @extends {EventEmitter}
 */
class TerminalHUD extends EventEmitter {
  /**
   * Creates an instance of TerminalHUD
   * @constructor
   * @param {object} configuration - Configuration options
   * @param {boolean} [configuration.numberedMenus=false] - Use numbered menus instead of arrow navigation
   * @param {string} [configuration.highlightColor='blue'] - Color for highlighting selected menu option
   * @param {boolean} [configuration.mouseSupport=true] - Enable mouse click/double-click navigation
   * @param {boolean} [configuration.mouseWheel] - Enable mouse wheel navigation (defaults to mouseSupport value)
   * @param {boolean} [configuration.enableEvents=true] - Enable event emission
   */
  constructor(configuration = {}) {
    super(); // Initialize EventEmitter
    
    this.readlineInterface = readline.createInterface({
      input: stdin,
      output: stdout
    });
    this.isLoading = false;
    this.numberedMenus = configuration.numberedMenus || false;
    this.highlightColor = this.getAnsiBackgroundColor(configuration.highlightColor || 'blue');
    this.clickMode = configuration.clickMode || 'single';   // 'single' or 'double'
    this.lastMenuGenerator = null;
    this.lastSelectedIndex = 0;
    this.lastFocusedIndex = 0; 
    
    // Event emission configuration
    this.enableEvents = configuration.enableEvents !== false; // Default to true

    // Optional mouse support
    this.mouseSupport = configuration.mouseSupport || true;
    this.mouseWheel = configuration.mouseWheel !== undefined ? configuration.mouseWheel : this.mouseSupport;
    this.mouseEventBuffer = '';
    this.isMouseEnabled = false;
    this.currentMenuState = null;
    this.lastMouseClick = { time: 0, x: -1, y: -1 };
    this.DOUBLE_CLICK_DELAY = 300;
    this.doubleClickTimeout = null;
    this.isClickInProgress = false;
    this.mouseClickBlinkLock = false;

    // Active field editing state
    this.activeField = null;          // { value, originalValue, line, column, onChange }
    this.isEditing = false;
    this.inputBuffer = '';
    this.fieldMaxWidth = 20;          // default maximum visible characters
    
    // Mouse wheel state
    this.wheelAccumulator = 0;
    this.activeField = null;
    this.isEditing = false;
    this.WHEEL_THRESHOLD = 1; // Number of wheel events needed to trigger navigation

    // Persisted viewport scroll offset across menu rebuilds of the SAME
    // function/page. This is what makes dropdown (and nested dropdown)
    // toggling feel fluid: instead of snapping the viewport back to the top
    // and then re-scrolling to re-reveal the focused item (which produces
    // the "the menu keeps going down" drift), the viewport stays exactly
    // where the user had it.
    this._lastScrollOffset = 0;

    // Track if we're currently in a menu
    this.isInMenu = false;

    // Track if selection is from keyboard
    this.isKeyboardSelection = false;

    // Bind the mouse handler to maintain context
    this.handleMouseData = this.handleMouseData.bind(this);
    
    // Event types documentation
    this.eventTypes = {
      // Menu events
      MENU_DISPLAY: 'menu:display',
      MENU_SELECTION: 'menu:selection',
      MENU_NAVIGATION: 'menu:navigation',
      MENU_CLOSE: 'menu:close',
      
      // Input events
      QUESTION_ASK: 'question:ask',
      QUESTION_ANSWER: 'question:answer',
      
      // Loading events
      LOADING_START: 'loading:start',
      LOADING_STOP: 'loading:stop',
      
      // Mouse events
      MOUSE_CLICK: 'mouse:click',
      MOUSE_RIGHT_CLICK: 'mouse:rightclick',
      MOUSE_DOUBLE_CLICK: 'mouse:doubleclick',
      MOUSE_WHEEL: 'mouse:wheel',
      
      // Key events
      KEY_PRESS: 'key:press',
      
      // General events
      PRESS_WAIT: 'press:wait'
    };
  }

  /**
   * Emits an event with the given name and data
   * @private
   * @param {string} eventName - The name of the event to emit
   * @param {object} [eventData={}] - Additional data to include with the event
   */
  emitEvent(eventName, eventData = {}) {
    if (this.enableEvents && this.listenerCount(eventName) > 0) {
      this.emit(eventName, {
        timestamp: Date.now(),
        ...eventData
      });
    }
    // Also emit wildcard event for all listeners
    if (this.enableEvents && this.listenerCount('*') > 0) {
      this.emit('*', {
        event: eventName,
        timestamp: Date.now(),
        ...eventData
      });
    }
  }

  // Core Helper Methods

  /**
   * Gets ANSI background color code for a given color name
   * @private
   * @param {string} color - Color name (red, green, yellow, blue, magenta, cyan, white)
   * @returns {string} ANSI escape sequence for the background color
   */
  getAnsiBackgroundColor(color) {
    const colors = {
      red: '\x1b[41m',
      green: '\x1b[42m',
      yellow: '\x1b[43m',
      blue: '\x1b[44m',
      magenta: '\x1b[45m',
      cyan: '\x1b[46m',
      white: '\x1b[47m'
    };
    return colors[color] || '';
  }

  /**
   * Resets terminal colors to default
   * @private
   * @returns {string} ANSI reset sequence
   */
  resetColor() {
    return '\x1b[0m';
  }

  /**
   * Starts a loading animation in the terminal
   * @private
   */
  startLoading() {
    this.isLoading = true;
    
    // Emit loading start event
    this.emitEvent(this.eventTypes.LOADING_START);
    
    let loadingCounter = 0;
    this.loadingInterval = setInterval(() => {
      stdout.clearLine();
      stdout.cursorTo(0);
      stdout.write(`⏳ Loading${'.'.repeat(loadingCounter)}`);
      loadingCounter = (loadingCounter + 1) % 4;
    }, 500);
  }

  /**
   * Stops the loading animation
   * @private
   */
  stopLoading() {
    this.isLoading = false;
    clearInterval(this.loadingInterval);
    stdout.clearLine();
    stdout.cursorTo(0);
    
    // Emit loading stop event
    this.emitEvent(this.eventTypes.LOADING_STOP);
  }

  // Public API

  /**
   * Resets terminal modes to default state
   * @private
   */
  resetTerminalModes() {
    // Write all terminal reset commands
    stdout.write('\x1b[?1000l'); // Disable mouse tracking
    stdout.write('\x1b[?1002l'); // Disable mouse drag tracking
    stdout.write('\x1b[?1003l'); // Disable all mouse tracking
    stdout.write('\x1b[?1006l'); // Disable SGR mouse mode
    stdout.write('\x1b[?25h');   // Show cursor
    stdout.write(''); // Force flush
  }

  /**
   * Cleans up mouse support features
   * @private
   */
  cleanupMouseSupport() {
    // Only cleanup if mouse was enabled
    if (this.isMouseEnabled) {
      this.resetTerminalModes();
      stdin.removeListener('data', this.handleMouseData);
      this.isMouseEnabled = false;
      this.mouseEventBuffer = '';
    }
    
    // Reset click state
    this.resetClickState();
    
    // Reset wheel accumulator
    this.wheelAccumulator = 0;
    this.activeField = null;
    this.isEditing = false;
  }

  /**
 * Asks for password input with hidden characters
 * @private
 * @param {string} question - The password prompt
 * @param {string} maskChar - Character to display instead of actual input (default: '*')
 * @returns {Promise<string>} The password entered
 */
async askPassword(question, maskChar = '*') {
  // Cleanup any existing menu state
  if (this.isInMenu) {
    this.cleanupMouseSupport();
    this.isInMenu = false;
  }

  // Remove keypress listeners if any
  stdin.removeAllListeners('keypress');
  
  // Ensure raw mode is off initially
  if (stdin.isRaw) {
    stdin.setRawMode(false);
  }

  return new Promise((resolve) => {
    let password = '';
    
    // Write the question
    stdout.write(`\n${question}`);
    
    // Set raw mode for character-by-character input
    stdin.setRawMode(true);
    stdin.resume();
    
    const handleChar = (data) => {
      const char = data.toString();
      
      // Handle Enter key (CR or LF)
      if (char === '\r' || char === '\n') {
        stdout.write('\n'); // New line after password
        stdin.setRawMode(false);
        stdin.removeListener('data', handleChar);
        resolve(password);
        return;
      }
      
      // Handle Backspace
      if (char === '\b' || char === '\x7f') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          // Move cursor back, overwrite with space, move back again
          stdout.write('\b \b');
        }
        return;
      }
      
      // Handle Ctrl+C
      if (char === '\x03') {
        stdout.write('^C\n');
        process.exit(0);
      }
      
      // Add character to password
      password += char;
      // Display mask character
      stdout.write(maskChar);
    };
    
    stdin.on('data', handleChar);
  });
}

  /**
   * Asks a question to the user
   * @async
   * @param {string} question - The question to ask
   * @param {object} [configuration={}] - Configuration options
   * @param {Array<string|object>} [configuration.options] - Menu options for selection
   * @param {string} [configuration.alert] - Alert message to display
   * @param {string} [configuration.alertEmoji='⚠️'] - Emoji for alert message
   * @param {boolean} [configuration.clearScreen=true] - Whether to clear screen before display
   * @param {number} [configuration.initialSelectedIndex=0] - Initial selected index
   * @param {number} [configuration.selectedIncrement=0] - Increment to apply to selected index
   * @param {any} [configuration.props] - Additional properties to pass to menu generator
   * @returns {Promise<string|any>} The user's answer or selected option
   * 
   * @emits TerminalHUD#question:ask
   * @emits TerminalHUD#question:answer
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:selection
   * @emits TerminalHUD#menu:navigation
   */
  async ask(question, configuration = {}) {

    if (configuration.password) {
      return this.askPassword(question, configuration.mask || '*');
    }
  
    // Emit question ask event
    this.emitEvent(this.eventTypes.QUESTION_ASK, {
      question,
      configuration
    });

    if (configuration.options) {
      return this.numberedMenus
        ? this.displayMenuFromOptions(question, configuration.options, configuration)
        : this.displayMenuWithArrows(question, configuration.options, configuration);
    }

    // If we're in a menu, cleanup mouse support first
    if (this.isInMenu) {
      this.cleanupMouseSupport();
      this.isInMenu = false;
    }

    // Remove keypress listeners if any
    stdin.removeAllListeners('keypress');
    
    // Ensure raw mode is off
    if (stdin.isRaw) {
      stdin.setRawMode(false);
    }

    // Close current readline interface if it exists
    if (this.readlineInterface) {
      this.readlineInterface.close();
    }

    // Create a new clean readline interface
    return new Promise((resolve) => {
      this.readlineInterface = readline.createInterface({
        input: stdin,
        output: stdout,
        terminal: true
      });

      this.readlineInterface.question(`\n${question}`, (answer) => {
        this.readlineInterface.close();
        
        // Emit question answer event
        this.emitEvent(this.eventTypes.QUESTION_ANSWER, {
          question,
          answer,
          configuration
        });
        
        // Restore interface for future use
        this.readlineInterface = readline.createInterface({
          input: stdin,
          output: stdout
        });
        resolve(answer);
      });
    });
  }

/**
 * Counts total options in a menu structure, properly handling groups
 * @private
 * @param {Array<string|object|Array<string|object>>} options - Menu options
 * @returns {number} Total number of options
 */
countMenuOptions(options) {
  if (!Array.isArray(options)) return 0;
  
  let count = 0;
  for (const option of options) {
    if (Array.isArray(option)) {
      count += option.length;
    } else if (option && option.type === 'options') {
      // Count each item in the options group
      count += option.value.length;
    } else {
      count++;
    }
  }
  return count;
}

   /**
 * Displays a menu generated by a menu generator function or from a raw menu object
 * @async
 * @param {Function|object} menuGeneratorOrObject - Function that generates menu content OR raw menu object
 * @param {object} [configuration={}] - Configuration options
 * @param {any} [configuration.props] - Properties to pass to menu generator
 * @param {boolean} [configuration.clearScreen=true] - Whether to clear screen
 * @param {string} [configuration.alert] - Alert message to display
 * @param {string} [configuration.alertEmoji='⚠️'] - Emoji for alert message
 * @param {number} [configuration.initialSelectedIndex=0] - Initial selected index
 * @param {number} [configuration.selectedIncrement=0] - Increment to apply to selected index (deprecated, use jumpToIndex instead)
 * @param {boolean} [configuration.remember=false] - Whether to remember the previous selection index if possible
 * @param {number} [configuration.jumpToIndex=0] - Jump forward/backward this many positions from the base index
 * @param {boolean} [configuration.jumpFromLast=false] - If true, jump from the last index when jumpToIndex is negative
 * @returns {Promise<string|any>} The selected option
 * 
 * @emits TerminalHUD#menu:display
 * @emits TerminalHUD#menu:selection
 * @emits TerminalHUD#menu:navigation
 * @emits TerminalHUD#loading:start
 * @emits TerminalHUD#loading:stop
 */
async displayMenu(menuGeneratorOrObject, configuration = {
  props: {},
  clearScreen: true,
  alert: undefined,
  alertEmoji: '⚠️',
  initialSelectedIndex: 0,
  selectedIncrement: 0,
  remember: false,
  jumpToIndex: 0,
  jumpFromLast: false
}) {
  if (configuration.clearScreen) console.clear();
  
  let menu;
  
  // Determine if first parameter is a function or object
  if (typeof menuGeneratorOrObject === 'function') {
    // Handle menu generator function (existing behavior)
    this.startLoading();
    menu = await menuGeneratorOrObject(configuration.props);
    this.stopLoading();
  } else if (typeof menuGeneratorOrObject === 'object' && menuGeneratorOrObject !== null) {
    // Handle raw menu object (new behavior)
    menu = menuGeneratorOrObject;
  } else {
    throw new Error('displayMenu expects either a menu generator function or a menu object');
  }
  
  // Validate menu structure
  if (!menu || typeof menu !== 'object') {
    throw new Error('Invalid menu structure');
  }
  
  if (configuration.alert) {
    console.log(`${configuration.alertEmoji || '⚠️'}  ${configuration.alert}\n`);
  }
  
  // Handle title - it could be a string or a promise
  const menuTitle = typeof menu.title === 'function' 
    ? await menu.title() 
    : (menu.title && typeof menu.title.then === 'function' 
      ? await menu.title 
      : menu.title || '');
  
  // Get total number of options
  const totalOptions = this.countMenuOptions(menu.options);
  
  // Determine base index
let baseIndex;

if (configuration.remember) {
  // Use remembered focus index if valid, otherwise fall back to selected index
  const rememberedIndex = this.lastFocusedIndex !== undefined 
    ? this.lastFocusedIndex 
    : this.lastSelectedIndex;
    
  baseIndex = (rememberedIndex >= 0 && rememberedIndex < totalOptions) 
    ? rememberedIndex 
    : (configuration.initialSelectedIndex || 0);
} else {
  // Use initialSelectedIndex as base
  baseIndex = configuration.initialSelectedIndex || 0;
}
  
  // Apply selectedIncrement for backward compatibility
  if (configuration.selectedIncrement) {
    configuration.jumpToIndex = (configuration.jumpToIndex || 0) + configuration.selectedIncrement;
  }
  
  // Calculate final index based on jump configuration
  let finalIndex = baseIndex;
  
  if (configuration.jumpToIndex) {
    if (configuration.jumpToIndex > 0) {
      // Positive jump: always jump forward from base index
      finalIndex = Math.min(baseIndex + configuration.jumpToIndex, totalOptions - 1);
    } else if (configuration.jumpToIndex < 0) {
      if (configuration.jumpFromLast) {
        // Jump backward from the last index
        finalIndex = Math.max(0, totalOptions - 1 + configuration.jumpToIndex);
      } else {
        // Jump backward from base index
        finalIndex = Math.max(0, baseIndex + configuration.jumpToIndex);
      }
    }
  }
  
  // Ensure finalIndex is within bounds
  finalIndex = Math.max(0, Math.min(finalIndex, totalOptions - 1));

  // Only reset the persisted viewport scroll when the menu is genuinely
  // being (re)opened fresh (different function, resetSelection, etc.).
  // For same-function rebuilds (dropdown toggles, refreshes, navigations
  // between pages of the same function) we KEEP the previous scroll offset
  // so the viewport does not jump every time a dropdown is opened/closed.
  if (!configuration.remember) {
    this._lastScrollOffset = 0;
  }

  this.lastFocusedIndex = finalIndex;
  
  // Store reference to menu generator for function case
  if (typeof menuGeneratorOrObject === 'function') {
    this.lastMenuGenerator = menuGeneratorOrObject;
  }
  
  // Emit menu display event with jump information
  this.emitEvent(this.eventTypes.MENU_DISPLAY, {
    question: menuTitle,
    options: this.sanitizeOptionsForEvent(menu.options),
    configuration: {
      ...configuration,
      baseIndex,
      finalIndex,
      totalOptions
    },
    menuType: this.numberedMenus ? 'numbered' : 'arrow'
  });
  
  return this.numberedMenus
    ? this.displayMenuFromOptions(menuTitle, menu.options, { ...configuration, initialSelectedIndex: finalIndex })
    : this.displayMenuWithArrows(menuTitle, menu.options, {
        ...configuration,
        pinnedTitle: menu.pinnedTitle,
        pinnedTopTitle: menu.pinnedTopTitle,
        pinnedTopSeparator: menu.pinnedTopSeparator,
        pinnedBottomSeparator: menu.pinnedBottomSeparator
      }, finalIndex);
}

  /**
   * Waits for any key press
   * @async
   * @returns {Promise<void>}
   * 
   * @emits TerminalHUD#press:wait
   * @emits TerminalHUD#key:press
   */
  async pressWait() {
    // Emit press wait event
    this.emitEvent(this.eventTypes.PRESS_WAIT);

    // Cleanup mouse support if active
    if (this.isInMenu) {
      this.cleanupMouseSupport();
      this.isInMenu = false;
    }

    // Remove any existing listeners
    stdin.removeAllListeners('keypress');
    stdin.removeAllListeners('data');
    
    // Ensure raw mode is off initially
    if (stdin.isRaw) {
      stdin.setRawMode(false);
    }

    return new Promise(resolve => {
      console.log('\nPress any key to continue...');
      
      const keyHandler = (data) => {
        stdin.setRawMode(false);
        stdin.removeListener('data', keyHandler);
        
        // Emit key press event
        this.emitEvent(this.eventTypes.KEY_PRESS, {
          key: data.toString(),
          isCtrlC: data.toString() === '\x03'
        });
        
        // Handle Ctrl+C
        if (data && data.toString() === '\x03') {
          process.exit(0);
        }
        
        resolve();
      };
      
      stdin.setRawMode(true);
      stdin.once('data', keyHandler);
    });
  }

  /**
   * Closes the TerminalHUD instance and cleans up resources
   * 
   * @emits TerminalHUD#menu:close
   */
  close() {
    // Emit menu close event if in menu
    if (this.isInMenu) {
      this.emitEvent(this.eventTypes.MENU_CLOSE);
    }
    
    this.cleanupAll();
    if (this.readlineInterface) {
      this.readlineInterface.close();
    }
  }

  // Menu Display Logic (Enhanced for Mouse)

  /**
   * Displays a menu with arrow key navigation and optional mouse support
   * @async
   * @private
   * @param {string} question - The menu title/question
   * @param {Array<string|object>} options - Menu options
   * @param {object} [configuration={}] - Configuration options
   * @param {boolean} [configuration.clear=false] - Whether to clear screen
   * @param {number} [initialIndex=0] - Initial selected index
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:navigation
   * @emits TerminalHUD#menu:selection
   * @emits TerminalHUD#key:press
   * @emits TerminalHUD#mouse:click
   * @emits TerminalHUD#mouse:doubleclick
   * @emits TerminalHUD#mouse:wheel
   */
  async displayMenuWithArrows(question, options = [], configuration = { clear: false }, initialIndex = 0) {
    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question,
      options: this.sanitizeOptionsForEvent(options),
      configuration,
      initialIndex,
      menuType: 'arrow'
    });

    if (!this.mouseSupport) {
      return this.displayMenuWithArrowsOriginal(question, options, configuration, initialIndex);
    }

    return new Promise((resolve) => {
      // ------------------------------------------------------------------
      // PINNED OPTIONS SUPPORT (TOP + BOTTOM)
      // ------------------------------------------------------------------
      // Options marked with `pinnedTop: true` are moved to the top of the
      // screen, above a single separator line. Options marked with
      // `pinned: true` are moved to the bottom of the screen, below a
      // single separator line. In both cases, their relative order among
      // themselves is preserved (invocation order). The middle area keeps
      // its existing infinite-scroll viewport + ▼ indicator.
      // ------------------------------------------------------------------
      const normalizedAll = this.normalizeOptions(options);

      const isPinnedTopOption = (opt) => {
        if (!opt || typeof opt !== 'object') return false;
        if (opt.pinnedTop === true) return true;
        if (opt.metadata && opt.metadata.pinnedTop === true) return true;
        return false;
      };

      const isPinnedBottomOption = (opt) => {
        if (!opt || typeof opt !== 'object') return false;
        if (opt.pinned === true) return true;
        if (opt.metadata && opt.metadata.pinned === true) return true;
        return false;
      };

      const scrollableOptions = [];
      const pinnedTopOptions = [];
      const pinnedBottomOptions = [];
      for (const lineArr of normalizedAll) {
        const hasTop = Array.isArray(lineArr) && lineArr.some(isPinnedTopOption);
        const hasBottom = Array.isArray(lineArr) && lineArr.some(isPinnedBottomOption);
        if (hasTop) pinnedTopOptions.push(lineArr);
        else if (hasBottom) pinnedBottomOptions.push(lineArr);
        else scrollableOptions.push(lineArr);
      }

      // Combined ordering for focus indexing:
      //   [pinned-top] → [scrollable] → [pinned-bottom]
      const normalizedOptions = [
        ...pinnedTopOptions,
        ...scrollableOptions,
        ...pinnedBottomOptions
      ];
      const pinnedTopCount = pinnedTopOptions.length;
      const scrollableCount = scrollableOptions.length;
      const pinnedCount = pinnedBottomOptions.length;
      const hasPinnedTopArea = pinnedTopCount > 0;
      const hasPinnedArea = pinnedCount > 0;

      // Index offset of the scrollable block inside normalizedOptions
      const scrollableStartIndex = pinnedTopCount;
      // Index offset of the pinned-bottom block inside normalizedOptions
      const pinnedBottomStartIndex = pinnedTopCount + scrollableCount;

      const pinnedTopTitle = configuration.pinnedTopTitle || '';
      const pinnedTopTitleLines = pinnedTopTitle ? pinnedTopTitle.split('\n') : [];
      const pinnedTitle = configuration.pinnedTitle || '';
      const pinnedTitleLines = pinnedTitle ? pinnedTitle.split('\n') : [];

      // Optional per-area separator styles. Default 'line' = unchanged look.
      const pinnedTopSeparatorStyle = configuration.pinnedTopSeparator || 'line';
      const pinnedBottomSeparatorStyle = configuration.pinnedBottomSeparator || 'line';

      const buildSeparator = (style) => {
        const sepWidth = Math.max(10, stdout.columns || 40);
        switch (style) {
          case 'none':
            return '';
          case 'discrete':
            return ColorText.brightBlack('·'.repeat(sepWidth));
          case 'line':
          default:
            return ColorText.dim('─'.repeat(sepWidth));
        }
      };

      if (configuration.clear) console.clear();

      let { line, column } = this.getCoordinatesFromLinearIndex(normalizedOptions, initialIndex);

      // ------------------------------------------------------------------
      // VIEWPORT SCROLL STATE (native pagination for small terminals)
      // ------------------------------------------------------------------
      // Restore the scroll offset from the previous render of the same
      // function/page. Preserving it here is what prevents the viewport
      // from repeatedly snapping back to index 0 and then re-scrolling
      // (which is what made nested dropdown toggles "drift downward" when
      // the user was already scrolled mid-list).
      let scrollOffset = this._lastScrollOffset || 0;
      let maxVisibleLines = 1;
      // Total rows actually available for the scrollable area (computed by
      // computeViewport below). Used so textview items, which occupy more
      // than one row, never overflow the terminal height.
      let availableRowsForScrollable = 1;

      // ------------------------------------------------------------------
      // PER-LINE HORIZONTAL SCROLL STATE
      // ------------------------------------------------------------------
      // Keyed by line index → the leftmost visible column index for that
      // line. This mirrors the vertical `scrollOffset` above but on the
      // horizontal axis: whenever a single row of options is wider than
      // the terminal, the row becomes horizontally scrollable instead of
      // overflowing / being silently truncated. The focused row is kept
      // in sync with `column` so left/right navigation always reveals
      // the focused option (with ◀N / N▶ indicators otherwise).
      // ------------------------------------------------------------------
      const hScrollByLine = {};

      // ------------------------------------------------------------------
      // DOUBLE-TAP DETECTION (up and down arrow keys)
      // ------------------------------------------------------------------
      // Auto-repeat from holding a key fires at roughly 30–50ms intervals
      // on most terminals, and NEVER sends a "release" event. A genuine
      // human double-tap also tends to be fast, so timing alone is not
      // enough to tell them apart reliably.
      //
      // To eliminate conflict with holding the key, we additionally require
      // that the FIRST press of the pair did NOT stay "down" for the full
      // window. We track both press times and a "hold detected" flag: if a
      // third press arrives while the previous two were still within the
      // auto-repeat cadence, we treat it as a hold and permanently disable
      // the double-tap trigger until the key is released.
      // ------------------------------------------------------------------
      const DOUBLE_TAP_WINDOW_MS = 120;  // max gap between the two taps
      const HOLD_RESET_MS = 400;         // no press for this long = released

      let lastUpPressTime = 0;
      let upHoldDetected = false;
      let upLastSeenTime = 0;

      let lastDownPressTime = 0;
      let downHoldDetected = false;
      let downLastSeenTime = 0;

      // Double-tap detection for LEFT / RIGHT arrows — used to hop
      // between grid cells with a fast double-tap (mirrors ↑/↓).
      let lastLeftPressTime = 0;
      let leftHoldDetected = false;
      let leftLastSeenTime = 0;
      let lastRightPressTime = 0;
      let rightHoldDetected = false;
      let rightLastSeenTime = 0;

      // Reset the hold flag if no key event has been seen for HOLD_RESET_MS
      const checkKeyRelease = () => {
        const now = Date.now();
        if (upHoldDetected && (now - upLastSeenTime) > HOLD_RESET_MS) {
          upHoldDetected = false;
          lastUpPressTime = 0;
        }
        if (downHoldDetected && (now - downLastSeenTime) > HOLD_RESET_MS) {
          downHoldDetected = false;
          lastDownPressTime = 0;
        }
        if (leftHoldDetected && (now - leftLastSeenTime) > HOLD_RESET_MS) {
          leftHoldDetected = false;
          lastLeftPressTime = 0;
        }
        if (rightHoldDetected && (now - rightLastSeenTime) > HOLD_RESET_MS) {
          rightHoldDetected = false;
          lastRightPressTime = 0;
        }
      };

      // Helper: which cell (if any) does the given column belong to on a
      // grid line? Returns null when the line is not a grid line.
      const getGridCellInfo = (lineIdx, columnIdx) => {
        const lineData = normalizedOptions[lineIdx];
        if (!lineData || !lineData._grid) return null;
        const ranges = lineData._gridCellRanges || [];
        for (let ci = 0; ci < ranges.length; ci++) {
          const r = ranges[ci];
          if (columnIdx >= r.start && columnIdx < r.end) {
            return { cellIdx: ci, ranges };
          }
        }
        return null;
      };

      const computeViewport = () => {
        const terminalHeight = stdout.rows || 24;
        let headerLines = 0;
        if (question) {
          headerLines = question.split('\n').length + 1;
        }
        const topSeparatorRows = hasPinnedTopArea ? 1 : 0;
        const topRows = hasPinnedTopArea
          ? (pinnedTopCount + topSeparatorRows + pinnedTopTitleLines.length)
          : 0;
        const bottomSeparatorRows = hasPinnedArea ? 1 : 0;
        const bottomRows = hasPinnedArea
          ? (pinnedCount + bottomSeparatorRows + pinnedTitleLines.length)
          : 0;

        availableRowsForScrollable = Math.max(
          1,
          terminalHeight - headerLines - topRows - bottomRows - 2
        );

        // Count how many scrollable items fit into availableRowsForScrollable,
        // treating textview items as taking `lines` visual rows each.
        let itemCount = 0;
        let rowsUsed = 0;
        for (const lineArr of scrollableOptions) {
          const h = (Array.isArray(lineArr) && lineArr.length === 1 &&
                     lineArr[0] && lineArr[0].type === 'textview')
            ? Math.max(2, lineArr[0].lines || 4)
            : 1;
          if (rowsUsed + h > availableRowsForScrollable) break;
          rowsUsed += h;
          itemCount++;
        }
        maxVisibleLines = Math.max(1, itemCount);
      };

      // ------------------------------------------------------------------
      // GRID LINE RENDERING
      // ------------------------------------------------------------------
      const renderGridLine = (lineOptions, lineIndex, focusLine, focusColumn, termWidth, hScrollMap) => {
        const grid = lineOptions._grid;
        const ranges = lineOptions._gridCellRanges || [];
        const numCells = ranges.length;
        if (numCells === 0) return '';

        const cfg = grid.config || {};
        const maxRatio = (typeof cfg.maxCellRatio === 'number' && cfg.maxCellRatio > 0)
          ? cfg.maxCellRatio
          : 0.2;
        const maxCellWidth = Math.max(8, Math.floor(termWidth * maxRatio));
        const totalGap = Math.max(0, numCells - 1);
        const availableWidth = Math.max(1, termWidth - totalGap);
        const cellWidth = Math.min(
          maxCellWidth,
          Math.max(6, Math.floor(availableWidth / numCells))
        );

        if (!hScrollMap.__grid) hScrollMap.__grid = {};
        const gridKey = `g${lineIndex}_${grid.name || ''}`;
        if (!hScrollMap.__grid[gridKey]) {
          hScrollMap.__grid[gridKey] = new Array(numCells).fill(0);
        }
        const cellScrolls = hScrollMap.__grid[gridKey];
        while (cellScrolls.length < numCells) cellScrolls.push(0);

        const stripAnsi = (s) => String(s == null ? '' : s).replace(/\x1b\[[0-9;]*m/g, '');
        // HARDENED: every branch returns a STRING, matching the same
        // guarantee now provided by renderOptionLine's text extraction.
        // This prevents `undefined.length` crashes inside renderGridLine
        // when a cell item is null/undefined, or when both `it.name` and
        // `JSON.stringify(it)` produce `undefined` (functions, symbols,
        // objects whose `toJSON()` returns `undefined`).
        const itemText = (it) => {
          if (it === null || it === undefined) return '';
          if (typeof it === 'string') return it;
          if (it.type === 'cellText') return String(it.text || '');
          if (it.type === 'field') {
            const label = it.label || '';
            const val = String(it.value || '');
            return label ? `${label}: ░${val}░` : `░${val}░`;
          }
          if (typeof it.name === 'string') return it.name;
          try {
            const json = JSON.stringify(it);
            return typeof json === 'string' ? json : '';
          } catch (_) {
            return '';
          }
        };

        let focusCellIdx = -1;
        let focusItemIdx = -1;
        if (lineIndex === focusLine) {
          for (let ci = 0; ci < numCells; ci++) {
            const r = ranges[ci];
            if (focusColumn >= r.start && focusColumn < r.end) {
              focusCellIdx = ci;
              focusItemIdx = focusColumn - r.start;
              break;
            }
          }
        }

        if (focusCellIdx >= 0) {
          const cell = grid.cells[focusCellIdx];
          const items = (cell && cell.items) || [];
          let scroll = cellScrolls[focusCellIdx] || 0;
          if (focusItemIdx < scroll) scroll = focusItemIdx;
          if (scroll < 0) scroll = 0;
          if (scroll >= items.length && items.length > 0) scroll = items.length - 1;

          const reserveRight = 6;
          const measure = (from, to) => {
            let w = 0;
            if (from > 0) w += stripAnsi(`◀${from} `).length;
            for (let i = from; i <= to && i < items.length; i++) {
              if (i > from) w += 2;
              w += stripAnsi(itemText(items[i])).length;
            }
            return w;
          };
          let w = measure(scroll, focusItemIdx);
          while (w > cellWidth - reserveRight && scroll < focusItemIdx) {
            scroll++;
            w = measure(scroll, focusItemIdx);
          }
          cellScrolls[focusCellIdx] = scroll;
        }

        const parts = [];
        for (let ci = 0; ci < numCells; ci++) {
          const cell = grid.cells[ci];
          const items = (cell && cell.items) || [];
          const texts = items.map(itemText);
          let scroll = cellScrolls[ci] || 0;
          if (scroll < 0) scroll = 0;
          if (scroll > 0 && scroll >= items.length) scroll = Math.max(0, items.length - 1);
          cellScrolls[ci] = scroll;

          let cellStr = '';
          let cw = 0;

          if (scroll > 0) {
            const ind = ColorText.dim(`◀${scroll} `);
            cellStr += ind;
            cw += stripAnsi(ind).length;
          }

          let lastRendered = scroll - 1;
          for (let i = scroll; i < texts.length; i++) {
            const sep = (i > scroll) ? '  ' : '';
            const raw = texts[i];
            const clean = stripAnsi(raw);
            const isFirst = (i === scroll);
            const hasMoreAfter = i < texts.length - 1;
            const reserveRight = hasMoreAfter ? 6 : 0;

            if (!isFirst && cw + sep.length + clean.length + reserveRight > cellWidth) {
              break;
            }

            let renderTxt = raw;
            if (isFirst) {
              const maxLen = cellWidth - cw - (hasMoreAfter ? 6 : 0);
              if (clean.length > maxLen && maxLen > 1) {
                renderTxt = clean.slice(0, Math.max(1, maxLen - 1)) + '…';
              }
            }

            const isFocused = (lineIndex === focusLine && ci === focusCellIdx && i === focusItemIdx);
            if (isFocused) {
              if (this.highlightColor) {
                cellStr += `${sep}${this.highlightColor}${renderTxt}${this.resetColor()}`;
              } else {
                cellStr += `${sep}→ ${renderTxt}`;
              }
            } else {
              cellStr += sep + renderTxt;
            }
            cw += sep.length + stripAnsi(renderTxt).length;
            lastRendered = i;
          }

          const rightMore = texts.length - 1 - lastRendered;
          if (rightMore > 0) {
            let ind = ` ${rightMore}▶`;
            if (cw + ind.length > cellWidth) {
              const max = cellWidth - cw;
              ind = max > 1 ? ind.slice(0, max) : '';
            }
            if (ind) {
              cellStr += ColorText.dim(ind);
              cw += stripAnsi(ind).length;
            }
          }

          const visibleLen = stripAnsi(cellStr).length;
          if (visibleLen < cellWidth) {
            cellStr += ' '.repeat(cellWidth - visibleLen);
          }

          parts.push(cellStr);
        }

        return parts.join(ColorText.dim('│'));
      };

      // Render a single line of options into a string.
      //
      // This version applies HORIZONTAL scrolling: if the combined width
      // of a row's options exceeds the terminal width, only the visible
      // window [hScroll, lastRendered] is drawn, with dim ◀N / N▶
      // indicators on either side to signal the hidden columns. The
      // focused row is always adjusted so the focused column is visible,
      // exactly mirroring the vertical viewport behaviour above.
      const renderOptionLine = (lineOptions, lineIndex, focusLine, focusColumn) => {
        const termWidth = stdout.columns || 80;

        // Grid lines carry a `_grid` marker (see this.Grid()).
        if (lineOptions._grid) {
          return renderGridLine(lineOptions, lineIndex, focusLine, focusColumn, termWidth, hScrollByLine);
        }

        // Build the raw (unstyled) text for every column in this line.
        //
        // HARDENED: every entry produced by this map is GUARANTEED to be
        // a STRING. Previously the final expression
        //
        //     return typeof option === 'string' ? option : option.name || JSON.stringify(option);
        //
        // could yield `undefined` (when `option` was a function / symbol /
        // an object whose `toJSON()` returned `undefined`) or a NON-string
        // (e.g. an array or number used as `option.name`). Downstream, the
        // renderer does `sep.length + text.length`, so any non-string
        // value blew up with:
        //
        //   TypeError: Cannot read properties of undefined (reading 'length')
        //
        // This wrapper eliminates the entire class of failure without
        // changing any visible layout or navigation behaviour.
        const texts = lineOptions.map((option, columnIndex) => {
          // Null / undefined slot → render as empty cell instead of crash.
          if (option === null || option === undefined) return '';

          // Plain string option (kept for safety; normalizeOptions usually
          // converts these into `{ name }` objects first).
          if (typeof option === 'string') return option;

          if (option.type === 'field') {
            const maxLen = this.fieldMaxWidth || 20;
            let val = '';
            const label = option.label || '';
            if (this.isEditing && lineIndex === focusLine && columnIndex === focusColumn && this.activeField) {
              val = this.activeField.value || '';
              const blink = (Math.floor(Date.now() / 500) % 2 === 0) ? '█' : ' ';
              const truncated = val.length > maxLen ? val.slice(-maxLen) : val;
              return label ? `${label}: ░${truncated}${blink}░` : `░${truncated}${blink}░`;
            } else {
              val = option.value || '';
              const truncated = val.length > maxLen ? val.slice(0, maxLen) : val;
              return label ? `${label}: ░${truncated}░` : `░${truncated}░`;
            }
          }

          // Prefer an explicit, real string name.
          if (typeof option.name === 'string') return option.name;

          // Final fallback: JSON stringification, guarded so that
          // functions / symbols / non-serialisable objects (which make
          // JSON.stringify return `undefined`) become an empty string.
          try {
            const json = JSON.stringify(option);
            return typeof json === 'string' ? json : '';
          } catch (_) {
            return '';
          }
        });

        // ---------- Resolve this line's horizontal scroll offset ----------
        let hScroll = hScrollByLine[lineIndex] || 0;
        if (hScroll < 0) hScroll = 0;
        if (texts.length === 0) {
          hScrollByLine[lineIndex] = 0;
          return '';
        }
        if (hScroll > texts.length - 1) hScroll = texts.length - 1;

        // Keep the focused column visible on the focused line.
        if (lineIndex === focusLine) {
          if (focusColumn < hScroll) {
            // Focus moved left of the current viewport → snap left.
            hScroll = focusColumn;
          } else {
            // Walk the offset forward until the focused column fits inside
            // the terminal width (accounting for the ◀ indicator + separators).
            const RESERVED = 4; // room for a " NNN▶" right indicator
            while (hScroll < focusColumn) {
              let w = 0;
              if (hScroll > 0) w += (`◀${hScroll} `).length;
              for (let c = hScroll; c <= focusColumn; c++) {
                if (c > hScroll) w += 3;
                w += texts[c].length;
              }
              if (w <= termWidth - RESERVED) break;
              hScroll++;
            }
          }
        }

        // Persist the resolved offset so the next render of the same line
        // resumes from exactly this position.
        hScrollByLine[lineIndex] = hScroll;

        // ---------- Render the visible slice of this line ----------
        const parts = [];
        let currentWidth = 0;

        const leftMore = hScroll;
        if (leftMore > 0) {
          const indicator = `◀${leftMore} `;
          parts.push(ColorText.dim(indicator));
          currentWidth += indicator.length;
        }

        let lastRendered = hScroll - 1;
        for (let c = hScroll; c < texts.length; c++) {
          const sep = (c > hScroll) ? '   ' : '';
          const text = texts[c];
          const pieceWidth = sep.length + text.length;
          const hasMoreAfter = c < texts.length - 1;
          // Reserve a little room for the right indicator when there are
          // more columns waiting beyond this one.
          const reserve = hasMoreAfter ? 5 : 0;
          const isFirstVisible = (c === hScroll);
          if (!isFirstVisible && currentWidth + pieceWidth + reserve > termWidth) {
            break;
          }

          if (lineIndex === focusLine && c === focusColumn) {
            if (this.highlightColor) {
              parts.push(`${sep}${this.highlightColor}${text}${this.resetColor()}`);
            } else {
              parts.push(`${sep}→ ${text}`);
            }
          } else {
            parts.push(sep + text);
          }
          currentWidth += pieceWidth;
          lastRendered = c;
        }

        const rightMore = texts.length - 1 - lastRendered;
        if (rightMore > 0) {
          parts.push(' ' + ColorText.dim(`${rightMore}▶`));
        }

        return parts.join('');
      };

      // ------------------------------------------------------------------
      // TEXT VIEW (this.TextButton) RENDERING
      // ------------------------------------------------------------------
      // Renders a `textview` item as a fixed-height framed box.
      // States: idle (dim) / focused (yellow) / active (green).
      // While ACTIVE the bottom border shows a contextual hint with the
      // E-to-edit shortcut (only when editable).
      const renderTextViewLines = (item, isFocused, lineIdx) => {
        const termWidth = Math.max(20, stdout.columns || 80);
        const totalLines = Math.max(2, item.lines || 4);
        const contentLines = totalLines - 2;
        const innerWidth = Math.max(4, termWidth - 4);
        const value = String(item.value || '');
        const scroll = item.scroll || 0;
        const active = !!item.active;
        const editable = !!item.editable;

        const wrapped = [];
        const rawLines = value.split('\n');
        for (const rawLine of rawLines) {
          if (rawLine.length === 0) { wrapped.push(''); continue; }
          for (let i = 0; i < rawLine.length; i += innerWidth) {
            wrapped.push(rawLine.slice(i, i + innerWidth));
          }
        }
        if (wrapped.length === 0) wrapped.push('');

        const totalWrapped = wrapped.length;
        const maxScroll = Math.max(0, totalWrapped - contentLines);
        const s = Math.max(0, Math.min(scroll, maxScroll));

        const styleLine = (l) => {
          if (active) return ColorText.brightGreen(l);
          if (isFocused) return ColorText.brightYellow(l);
          return ColorText.dim(l);
        };

        const out = [];

        const label = item.label || '';
        const labelPart = label ? ` ${label} ` : '';
        const topFill = Math.max(0, termWidth - 2 - labelPart.length);
        out.push(('┌' + labelPart + '─'.repeat(topFill) + '┐').slice(0, termWidth));

        for (let i = 0; i < contentLines; i++) {
          const idx = s + i;
          let text = (idx < totalWrapped) ? wrapped[idx] : '';
          if (text.length > innerWidth) text = text.slice(0, innerWidth);
          text = text.padEnd(innerWidth, ' ');

          let leftMarker = '│';
          if (i === 0 && s > 0) leftMarker = '↑';
          if (i === contentLines - 1 && (s + contentLines) < totalWrapped) leftMarker = '↓';
          if (i === 0 && isFocused && !active) leftMarker = '▶';

          let line = leftMarker + ' ' + text + ' │';
          if (line.length > termWidth) line = line.slice(0, termWidth);
          else if (line.length < termWidth) line = line + ' '.repeat(termWidth - line.length);
          out.push(line);
        }

        let counter = '';
        if (maxScroll > 0) {
          counter = ` ${s + 1}-${Math.min(s + contentLines, totalWrapped)}/${totalWrapped} `;
        }
        if (isFocused && !active) {
          const hint = ' Enter: activate ';
          const avail = Math.max(0, termWidth - 2 - counter.length - hint.length);
          counter = counter + '─'.repeat(avail) + hint;
        }
        if (active) {
          const hint = editable
            ? ' ↑↓: scroll  E: edit  Enter: exit '
            : ' ↑↓: scroll  Enter: exit ';
          const avail = Math.max(0, termWidth - 2 - counter.length - hint.length);
          counter = counter + '─'.repeat(avail) + hint;
        }
        const botFill = Math.max(0, termWidth - 2 - counter.length);
        out.push(('└' + '─'.repeat(botFill) + counter + '┘').slice(0, termWidth));

        return out.map(styleLine);
      };

      const renderMenu = () => {
        computeViewport();

        console.clear();

        let currentRow = 0;

        // ---------- Pinned-top area ----------
        let pinnedTopFirstRow = -1;
        if (hasPinnedTopArea) {
          // Optional pinned-top title (rendered as-is, one line at a time)
          for (const tLine of pinnedTopTitleLines) {
            console.log(tLine);
            currentRow += 1;
          }

          // Row where the first pinned-top option will be drawn
          pinnedTopFirstRow = currentRow;

          for (let i = 0; i < pinnedTopCount; i++) {
            const lineString = renderOptionLine(normalizedOptions[i], i, line, column);
            console.log(lineString);
            currentRow += 1;
          }

          // Single separator line (style controlled by pinnedTopSeparator)
          console.log(buildSeparator(pinnedTopSeparatorStyle));
          currentRow += 1;
        }

        // ---------- Question ----------
        if (question) {
          console.log(`${question}\n`);
          currentRow += question.split('\n').length + 1;
        }

        // ---------- Scrollable area ----------
        const focusInScrollable =
          line >= scrollableStartIndex &&
          line < scrollableStartIndex + scrollableCount;

        const focusRel = line - scrollableStartIndex;

        if (focusInScrollable) {
          if (focusRel < scrollOffset) scrollOffset = focusRel;
          if (focusRel >= scrollOffset + maxVisibleLines) {
            scrollOffset = focusRel - maxVisibleLines + 1;
          }
        }

        const maxScroll = Math.max(0, scrollableCount - maxVisibleLines);
        if (scrollOffset > maxScroll) scrollOffset = maxScroll;
        if (scrollOffset < 0) scrollOffset = 0;

        // Persist the (clamped) scroll offset so the next rebuild of the
        // same menu keeps the viewport in exactly the same visual place.
        // This is the key fix that makes dropdown / nested dropdown
        // toggling fluid even when the user is scrolled mid-list.
        this._lastScrollOffset = scrollOffset;

        const startRel = scrollOffset;
        const endRel = Math.min(scrollOffset + maxVisibleLines, scrollableCount);

        const hasUpIndicator = startRel > 0;

        const firstItemRow = currentRow;

        let rowsUsedInLoop = 0;
        let lastRenderedRel = startRel - 1;

        for (let rel = startRel; rel < endRel; rel++) {
          const lineIndex = scrollableStartIndex + rel;
          const lineOptions = normalizedOptions[lineIndex];
          const isTextView = Array.isArray(lineOptions) && lineOptions.length === 1 &&
                             lineOptions[0] && lineOptions[0].type === 'textview';

          if (isTextView) {
            const tv = lineOptions[0];
            const height = Math.max(2, tv.lines || 4);
            if (rowsUsedInLoop + height > availableRowsForScrollable) break;
            const tvLines = renderTextViewLines(tv, lineIndex === line, lineIndex);
            for (const ln of tvLines) {
              console.log(ln);
              currentRow += 1;
            }
            rowsUsedInLoop += height;
            lastRenderedRel = rel;
          } else {
            if (rowsUsedInLoop + 1 > availableRowsForScrollable) break;
            const lineString = renderOptionLine(lineOptions, lineIndex, line, column);
            console.log(lineString);
            currentRow += 1;
            rowsUsedInLoop += 1;
            lastRenderedRel = rel;
          }
        }

        const remaining = scrollableCount - (lastRenderedRel + 1);
        const hasDownIndicator = remaining > 0;
        if (hasDownIndicator) {
          console.log(ColorText.dim(`${remaining} more below`));
          currentRow += 1;
        }

        // ---------- Pinned-bottom area ----------
        let pinnedFirstRow = -1;
        if (hasPinnedArea) {
          // Single separator line (style controlled by pinnedBottomSeparator)
          console.log(buildSeparator(pinnedBottomSeparatorStyle));
          currentRow += 1;

          for (const tLine of pinnedTitleLines) {
            console.log(tLine);
            currentRow += 1;
          }

          pinnedFirstRow = currentRow;

          for (let i = 0; i < pinnedCount; i++) {
            const lineIndex = pinnedBottomStartIndex + i;
            const lineString = renderOptionLine(normalizedOptions[lineIndex], lineIndex, line, column);
            console.log(lineString);
            currentRow += 1;
          }
        }

        if (this.currentMenuState) {
          this.currentMenuState.scrollOffset = scrollOffset;
          this.currentMenuState.maxVisibleLines = maxVisibleLines;
          this.currentMenuState.firstItemRow = firstItemRow;
          this.currentMenuState.hasUpIndicator = hasUpIndicator;
          this.currentMenuState.hasDownIndicator = hasDownIndicator;
          this.currentMenuState.currentLine = line;
          this.currentMenuState.currentColumn = column;

          this.currentMenuState.pinnedTopCount = pinnedTopCount;
          this.currentMenuState.scrollableCount = scrollableCount;
          this.currentMenuState.pinnedCount = pinnedCount;
          this.currentMenuState.scrollableStartIndex = scrollableStartIndex;
          this.currentMenuState.pinnedBottomStartIndex = pinnedBottomStartIndex;
          this.currentMenuState.pinnedTopFirstRow = pinnedTopFirstRow;
          this.currentMenuState.pinnedFirstRow = pinnedFirstRow;
        }
      };

      const setFocus = (newLine, newColumn) => {
        // Defensive: if focus moves away from an active textview, drop
        // it back to FOCUSED so the next visit starts cleanly.
        const prevOption = normalizedOptions[line] && normalizedOptions[line][column];
        const nextOption = normalizedOptions[newLine] && normalizedOptions[newLine][newColumn];
        if (prevOption && prevOption.type === 'textview' && prevOption !== nextOption) {
          if (prevOption.active) {
            prevOption.active = false;
            if (typeof prevOption.persistActive === 'function') {
              prevOption.persistActive();
            }
          }
        }

        line = newLine;
        column = newColumn;

        if (this.currentMenuState) {
          this.currentMenuState.currentLine = newLine;
          this.currentMenuState.currentColumn = newColumn;
        }

        this.lastFocusedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, newLine, newColumn);

        this.emitEvent(this.eventTypes.MENU_NAVIGATION, {
          line: newLine,
          column: newColumn,
          linearIndex: this.lastFocusedIndex,
          question
        });

        renderMenu();
      };

      const selectOption = async (selectionSource = 'mouse') => {
        if (this.isClickInProgress) return;

        this.isClickInProgress = true;

        const selectedOption = normalizedOptions[line] && normalizedOptions[line][column];
        if (selectedOption && selectedOption.type === 'field') {
          this.startFieldEditing(selectedOption, line, column, renderMenu);
          setFocus(line, column);
          renderMenu();
          return;
        }

        // -------- TextButton / Textview handling --------
        // FOCUSED → Enter/click ACTIVATES the box.
        // ACTIVE  → Enter/click DEACTIVATES the box.
        // Editing is handled by the E-key shortcut in handleKeyPress.
        if (selectedOption && selectedOption.type === 'textview') {
          const wasFocused = (normalizedOptions[line] &&
                              normalizedOptions[line][column] === selectedOption);
          if (!wasFocused) setFocus(line, column);

          selectedOption.onToggle();
          this.isClickInProgress = false;
          renderMenu();
          return;
        }

        this.lastSelectedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, line, column);
        const selected = normalizedOptions[line][column];

        const selectionEventData = {
          index: this.lastSelectedIndex,
          line,
          column,
          selected: this.getOptionDataForEvent(selected),
          question,
          source: selectionSource
        };

        if (selected && typeof selected === 'object') {
          if (selected.eventData) {
            selectionEventData.customData = selected.eventData;
          }
          if (selected.metadata) {
            selectionEventData.metadata = selected.metadata;
          }
        }

        this.emitEvent(this.eventTypes.MENU_SELECTION, selectionEventData);

        this.cleanupMenuState();

        try {
          if (selected?.action) {
            const result = selected.action();
            if (result instanceof Promise) {
              await result;
            }
          }

          resolve(selected?.name || selected);
        } catch (error) {
          console.error('Error in menu action:', error);
          resolve(null);
        } finally {
          this.isClickInProgress = false;
        }
      };

      const handleKeyPress = async (_, key) => {
        if (!this.isInMenu) return;

        this.emitEvent(this.eventTypes.KEY_PRESS, {
          key: key.name,
          sequence: key.sequence,
          ctrl: key.ctrl,
          shift: key.shift,
          meta: key.meta,
          inMenu: true
        });

        // --- FIELD EDITING MODE (handled by raw listener, ignore keypress) ---
        if (this.isEditing && this.activeField) {
          return;
        }

        // --- NORMAL MENU NAVIGATION ---
        switch (key.name) {
          case 'up': {
            const now = Date.now();
            checkKeyRelease();
            upLastSeenTime = now;

            // If a hold was detected, swallow any potential double-tap
            // and just navigate normally.
            if (!upHoldDetected) {
              const elapsed = now - lastUpPressTime;

              if (lastUpPressTime !== 0 && elapsed <= DOUBLE_TAP_WINDOW_MS) {
                // Two presses within the window → check if this is actually
                // auto-repeat. If the previous gap was extremely short (<50ms),
                // it's more likely a hold; mark hold detected and cancel.
                // Otherwise treat as a genuine double-tap.
                if (elapsed < 50) {
                  upHoldDetected = true;
                  lastUpPressTime = 0;
                } else {
                  // Genuine double-tap
                  lastUpPressTime = 0;

                  if (hasPinnedTopArea) {
                    scrollOffset = 0;
                    setFocus(0, 0);
                  } else if (normalizedOptions.length > 0) {
                    setFocus(0, 0);
                  }
                  break;
                }
              } else {
                lastUpPressTime = now;
              }
            }

            // -------- TextButton ↑ (locked while active) --------
            {
              const tvUp = normalizedOptions[line] && normalizedOptions[line][column];
              if (tvUp && tvUp.type === 'textview' && tvUp.active) {
                tvUp.onScroll(-1);
                renderMenu();
                break;
              }
            }

            if (line > 0) line--;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            setFocus(line, column);
            break;
          }

          case 'down': {
            const now = Date.now();
            checkKeyRelease();
            downLastSeenTime = now;

            if (!downHoldDetected) {
              const elapsed = now - lastDownPressTime;

              if (lastDownPressTime !== 0 && elapsed <= DOUBLE_TAP_WINDOW_MS) {
                if (elapsed < 50) {
                  downHoldDetected = true;
                  lastDownPressTime = 0;
                } else {
                  lastDownPressTime = 0;

                  if (hasPinnedArea) {
                    computeViewport();
                    scrollOffset = Math.max(0, scrollableCount - maxVisibleLines);
                    setFocus(pinnedBottomStartIndex, 0);
                  } else if (normalizedOptions.length > 0) {
                    const lastLine = normalizedOptions.length - 1;
                    const lastCol = Math.max(0, normalizedOptions[lastLine].length - 1);
                    setFocus(lastLine, lastCol);
                  }
                  break;
                }
              } else {
                lastDownPressTime = now;
              }
            }

            // -------- TextButton ↓ (locked while active) --------
            {
              const tvDown = normalizedOptions[line] && normalizedOptions[line][column];
              if (tvDown && tvDown.type === 'textview' && tvDown.active) {
                tvDown.onScroll(1);
                renderMenu();
                break;
              }
            }

            if (line < normalizedOptions.length - 1) line++;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            setFocus(line, column);
            break;
          }

          case 'left': {
            const now = Date.now();
            checkKeyRelease();
            leftLastSeenTime = now;

            if (!leftHoldDetected) {
              const elapsed = now - lastLeftPressTime;
              if (lastLeftPressTime !== 0 && elapsed <= DOUBLE_TAP_WINDOW_MS) {
                if (elapsed < 50) {
                  leftHoldDetected = true;
                  lastLeftPressTime = 0;
                } else {
                  lastLeftPressTime = 0;
                  const gi = getGridCellInfo(line, column);
                  if (gi && gi.cellIdx > 0) {
                    const prevRange = gi.ranges[gi.cellIdx - 1];
                    setFocus(line, prevRange.start);
                    break;
                  }
                }
              } else {
                lastLeftPressTime = now;
              }
            }

            if (column > 0) column--;
            setFocus(line, column);
            break;
          }

          case 'right': {
            const now = Date.now();
            checkKeyRelease();
            rightLastSeenTime = now;

            if (!rightHoldDetected) {
              const elapsed = now - lastRightPressTime;
              if (lastRightPressTime !== 0 && elapsed <= DOUBLE_TAP_WINDOW_MS) {
                if (elapsed < 50) {
                  rightHoldDetected = true;
                  lastRightPressTime = 0;
                } else {
                  lastRightPressTime = 0;
                  const gi = getGridCellInfo(line, column);
                  if (gi && gi.cellIdx < gi.ranges.length - 1) {
                    const nextRange = gi.ranges[gi.cellIdx + 1];
                    setFocus(line, nextRange.start);
                    break;
                  }
                }
              } else {
                lastRightPressTime = now;
              }
            }

            if (column < normalizedOptions[line].length - 1) column++;
            setFocus(line, column);
            break;
          }

          case 'return':
            await selectOption('keyboard');
            return;

          case 'c':
            if (key.ctrl) {
              if (this.listenerCount('ctrl+c') > 0) {
                this.emit('ctrl+c');
                return;
              }
              this.cleanupMenuState();
              process.exit();
            }
            break;

          case 'e':
            // "E" opens the built-in text editor for the currently
            // ACTIVE + EDITABLE textview (this.TextButton with
            // { editable: true }).
            //
            // The editor is deliberately NOT invoked inline. Instead
            // we (1) flip the box back to FOCUSED, (2) tear down the
            // menu (removes keypress/mouse listeners, disables raw
            // mode, resets mouse tracking), (3) resolve the pending
            // menu promise so the promise chain unwinds cleanly, and
            // (4) schedule openEditor() on the next macrotask via
            // setImmediate.
            //
            // That deferral is what guarantees the editor always gets
            // a completely idle terminal: the keypress handler has
            // returned, no mouse sequences are in flight, and stdin
            // has no leftover listeners competing for raw bytes.
            //
            // Only plain "e" triggers this — ctrl+e, shift+e and
            // alt/meta+e are left for future shortcuts.
            if (!key.ctrl && !key.shift && !key.meta) {
              const tvEdit = normalizedOptions[line] && normalizedOptions[line][column];
              if (tvEdit &&
                  tvEdit.type === 'textview' &&
                  tvEdit.active &&
                  tvEdit.editable &&
                  typeof tvEdit.openEditor === 'function') {
                // Flip the box back to FOCUSED so the next render
                // (triggered by the editor's post-save LoadScreen)
                // starts from a clean, un-highlighted state.
                tvEdit.active = false;
                if (typeof tvEdit.persistActive === 'function') {
                  tvEdit.persistActive();
                }

                // Tear down the menu.
                this.cleanupMenuState();

                // Resolve the pending menu promise. Nothing in the
                // LoadScreen flow actually awaits this promise (the
                // menu is fire-and-forget), so this is purely
                // bookkeeping to keep the promise chain clean.
                resolve(tvEdit);

                // Defer the editor to the next macrotask.
                setImmediate(() => {
                  try { tvEdit.openEditor(); } catch (_) {}
                });
                return;
              }
            }
            break;
        }
      };

      // Setup for this menu
      this.setupMenuState(handleKeyPress);

      // Store menu state for mouse handling
      this.currentMenuState = {
        normalizedOptions,
        question,
        renderMenu,
        setFocus,
        selectOption,
        currentLine: line,
        currentColumn: column,
        scrollOffset: 0,
        maxVisibleLines: 1,
        hScrollByLine,
        firstItemRow: 0,
        hasUpIndicator: false,
        hasDownIndicator: false,
        pinnedTopCount,
        scrollableCount,
        pinnedCount,
        scrollableStartIndex,
        pinnedBottomStartIndex,
        pinnedTopFirstRow: -1,
        pinnedFirstRow: -1
      };

      // Re-render on terminal resize so the viewport adapts to the new
      // dimensions (both wider and narrower terminals).
      const resizeHandler = () => {
        if (this.isInMenu && this.currentMenuState) {
          try { renderMenu(); } catch (_) { /* ignore resize render errors */ }
        }
      };
      this.currentMenuState.resizeHandler = resizeHandler;
      stdout.on('resize', resizeHandler);

      renderMenu();
    });
  }

  /**
   * Sets up the menu state and event listeners
   * @private
   * @param {Function} keyPressHandler - Function to handle key press events
   */
  setupMenuState(keyPressHandler) {
    this.isInMenu = true;
    
    // Remove any existing listeners
    stdin.removeAllListeners('keypress');
    
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', keyPressHandler);

    // Enable mouse tracking for this menu
    this.safeEnableMouseTracking();
  }

  /**
   * Cleans up menu state and event listeners
   * @private
   */
  cleanupMenuState() {
    this.isInMenu = false;

    // Remove the terminal-resize listener we attached for this menu
    if (this.currentMenuState?.resizeHandler) {
      try { stdout.removeListener('resize', this.currentMenuState.resizeHandler); } catch (_) {}
      this.currentMenuState.resizeHandler = null;
    }

    // Remove keypress listener
    stdin.removeAllListeners('keypress');
    
    // Disable raw mode
    if (stdin.isRaw) {
      stdin.setRawMode(false);
    }
    
    // Cleanup mouse support
    this.cleanupMouseSupport();
    
    this.currentMenuState = null;
    this.wheelAccumulator = 0;
  }

  /**
   * Displays a menu with arrow key navigation (original implementation without mouse support)
   * @async
   * @private
   * @param {string} question - The menu title/question
   * @param {Array<string|object>} options - Menu options
   * @param {object} [configuration={}] - Configuration options
   * @param {boolean} [configuration.clear=false] - Whether to clear screen
   * @param {number} [initialIndex=0] - Initial selected index
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:navigation
   * @emits TerminalHUD#menu:selection
   * @emits TerminalHUD#key:press
   */
  async displayMenuWithArrowsOriginal(question, options = [], configuration = { clear: false }, initialIndex = 0) {
    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question,
      options: this.sanitizeOptionsForEvent(options),
      configuration,
      initialIndex,
      menuType: 'arrow-original'
    });

    return new Promise(resolve => {
      if (configuration.clear) console.clear();
     
      const normalizedOptions = this.normalizeOptions(options);
      let { line, column } = this.getCoordinatesFromLinearIndex(normalizedOptions, initialIndex);

      const renderMenu = () => {
        console.clear();
        if (question) console.log(`${question}\n`);
        normalizedOptions.forEach((lineOptions, lineIndex) => {
          let lineString = lineOptions.map((option, columnIndex) => {
            const text = typeof option === 'string' ? option : option.name || JSON.stringify(option);
            if (lineIndex === line && columnIndex === column) {
              return this.highlightColor
                ? `${this.highlightColor}${text}${this.resetColor()}`
                : `→ ${text}`;
            }
            return text;
          }).join('   ');
          console.log(lineString);
        });
      };

      const handleKeyPress = async (_, key) => {
        // Emit key press event for menu
        this.emitEvent(this.eventTypes.KEY_PRESS, {
          key: key.name,
          sequence: key.sequence,
          ctrl: key.ctrl,
          shift: key.shift,
          meta: key.meta,
          inMenu: true
        });
        
        switch (key.name) {
          case 'up':
            if (line > 0) line--;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            // Update focused index
            this.lastFocusedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, line, column);
            break;
          case 'down':
            if (line < normalizedOptions.length - 1) line++;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            // Update focused index
            this.lastFocusedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, line, column);
            break;
          case 'left':
            if (column > 0) column--;
            // Update focused index
            this.lastFocusedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, line, column);
            break;
          case 'right':
            if (column < normalizedOptions[line].length - 1) column++;
            // Update focused index
            this.lastFocusedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, line, column);
            break;
          case 'return':
            stdin.removeListener('keypress', handleKeyPress);
            stdin.setRawMode(false);
            this.lastSelectedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, line, column);
            // Also update focused index on selection
            this.lastFocusedIndex = this.lastSelectedIndex;
            const selected = normalizedOptions[line][column];
            
            // Emit menu selection event
            const selectionEventData = {
              index: this.lastSelectedIndex,
              line,
              column,
              selected: this.getOptionDataForEvent(selected),
              question,
              source: 'keyboard'
            };
            
            // Add custom data from option if available
            if (selected && typeof selected === 'object') {
              if (selected.eventData) {
                selectionEventData.customData = selected.eventData;
              }
              if (selected.metadata) {
                selectionEventData.metadata = selected.metadata;
              }
            }
            
            this.emitEvent(this.eventTypes.MENU_SELECTION, selectionEventData);
            
            if (selected?.action) await selected.action();
            resolve(selected?.name || selected);
            return;
        }
        renderMenu();
      };

      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', handleKeyPress);
      renderMenu();
    });
  }

  /**
   * Displays a menu with numbered options
   * @async
   * @private
   * @param {string} question - The menu title/question
   * @param {Array<string|object>} options - Menu options
   * @param {object} [configuration={}] - Configuration options
   * @param {boolean} [configuration.clear=true] - Whether to clear screen
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:selection
   */
  async displayMenuFromOptions(question, options, configuration = { clear: true }) {
    if (!this.numberedMenus) {
      return this.displayMenuWithArrows(question, options, configuration);
    }

    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question,
      options: this.sanitizeOptionsForEvent(options),
      configuration,
      menuType: 'numbered-from-options'
    });

    console.clear();
    if (question) console.log(`${question}\n`);

    const optionMap = {};
    let index = 1;
    const printOption = (option) => {
      const text = typeof option === 'string' ? option : option.name;
      console.log(`${index}. ${text}`);
      optionMap[index++] = option;
    };

    options.forEach(option => {
      Array.isArray(option)
        ? option.forEach(subOption => printOption(subOption))
        : printOption(option);
    });

    const choice = parseInt(await this.ask('Choose an option: '));
    const selected = optionMap[choice];
   
    if (!selected) {
      console.log('Invalid option, try again.');
      return this.displayMenuFromOptions(question, options, configuration);
    }

    if (typeof selected === 'string') return selected;
    
    // Emit menu selection event
    this.emitEvent(this.eventTypes.MENU_SELECTION, {
      index: choice,
      selected: this.getOptionDataForEvent(selected),
      question,
      source: 'numbered'
    });
    
    if (selected.action) await selected.action();
    return selected.name;
  }

  /**
   * Displays a numbered menu with special option types
   * @async
   * @private
   * @param {string} title - The menu title
   * @param {Array<object>} options - Menu options with type property
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:selection
   */
  async displayNumberedMenu(title, options) {
    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question: title,
      options: this.sanitizeOptionsForEvent(options),
      menuType: 'numbered'
    });

    console.clear();
    if (title) console.log(`${title}\n`);

    const optionMap = {};
    let index = 1;
    const printOption = (option) => {
      if (option.type === 'options' && Array.isArray(option.value)) {
        console.log(option.value.map(individualOption => `${index++}. ${individualOption.name}`).join(' '));
        option.value.forEach(individualOption => optionMap[index - option.value.length + individualOption.value] = individualOption);
      }
      else if (option.type === 'text' && option.value) {
        console.log(option.value);
      }
      else if (option.name) {
        console.log(`${index}. ${option.name}`);
        optionMap[index++] = option;
      }
    };

    options.forEach(printOption);
    const choice = parseInt(await this.ask('\nChoose an option: '));
    const selected = optionMap[choice];

    if (!selected) {
      console.log('Invalid option, try again.');
      return this.displayNumberedMenu(title, options);
    }

    // Emit menu selection event
    this.emitEvent(this.eventTypes.MENU_SELECTION, {
      index: choice,
      selected: this.getOptionDataForEvent(selected),
      question: title,
      source: 'numbered'
    });
    
    if (selected.action) await selected.action();
    return selected.name;
  }

  // Menu Utilities
/**
 * Normalizes menu options to a consistent format, handling groups
 * @private
 * @param {Array<string|object|Array<string|object>>} options - Menu options
 * @returns {Array<Array<object>>} Normalized options in 2D array format
 */
normalizeOptions(options) {
  const result = [];
  
  for (const option of options) {
    if (Array.isArray(option)) {
      const line = option.map(item => 
        typeof item === 'string' ? { name: item } : item
      );
      result.push(line);
    } else if (option?.type === 'options') {
      const line = option.value.map(item => 
        typeof item === 'string' ? { name: item } : item
      );
      result.push(line);
    } else if (option?.type === 'grid') {
      // Grid: flatten every cell's items into ONE navigable line so the
      // HUD's focus/linear-index maths work unchanged. Per-cell grouping
      // and per-cell horizontal scroll are preserved via `_grid` and
      // `_gridCellRanges` markers attached to the flattened line.
      const cells = Array.isArray(option.cells) ? option.cells : [];
      const line = [];
      const ranges = [];
      for (const cell of cells) {
        const start = line.length;
        for (const it of (cell.items || [])) {
          line.push(it);
        }
        ranges.push({ start, end: line.length });
      }
      line._grid = option;
      line._gridCellRanges = ranges;
      result.push(line);
    } else {
      const item = typeof option === 'string' ? { name: option } : option;
      result.push([item]);
    }
  }
  
  return result;
}

  /**
   * Converts linear index to 2D coordinates
   * @private
   * @param {Array<Array<object>>} lines - 2D array of options
   * @param {number} index - Linear index
   * @returns {{line: number, column: number}} 2D coordinates
   */
  getCoordinatesFromLinearIndex(lines, index) {
    let count = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (index < count + lines[lineIndex].length) {
        return { line: lineIndex, column: index - count };
      }
      count += lines[lineIndex].length;
    }
    return {
      line: lines.length - 1,
      column: lines[lines.length - 1].length - 1
    };
  }

  /**
   * Converts 2D coordinates to linear index
   * @private
   * @param {Array<Array<object>>} lines - 2D array of options
   * @param {number} line - Row index
   * @param {number} column - Column index
   * @returns {number} Linear index
   */
  getLinearIndexFromCoordinates(lines, line, column) {
    return lines.slice(0, line).reduce((sum, currentLine) => sum + currentLine.length, 0) + column;
  }

  /**
   * Sanitizes options for event emission (removes functions)
   * @private
   * @param {Array<string|object|Array<string|object>>} options - Menu options
   * @returns {Array<object|Array<object>>} Sanitized options
   */
  sanitizeOptionsForEvent(options) {
    return options.map(option => {
      if (typeof option === 'string') {
        return { name: option };
      }
      if (Array.isArray(option)) {
        return option.map(item => this.getOptionDataForEvent(item));
      }
      return this.getOptionDataForEvent(option);
    });
  }
  
 /**
 * Gets safe option data for event emission
 * @private
 * @param {string|object} option - Menu option
 * @returns {object|null} Safe option data without functions
 */
getOptionDataForEvent(option) {
  if (!option) return null;
  
  // Handle options group
  if (option.type === 'options') {
    return {
      type: 'options',
      value: option.value.map(item => this.getOptionDataForEvent(item))
    };
  }
  
  if (typeof option === 'string') {
    return { name: option };
  }
  
  // Return a safe object without functions for event emission
  const eventData = {
    name: option.name,
    type: option.type,
    value: option.value
  };
  
  // Include custom data if present
  if (option.eventData) {
    eventData.eventData = option.eventData;
  }
  if (option.metadata) {
    eventData.metadata = option.metadata;
  }
  
  return eventData;
}

  // Mouse Support (Enhanced with Wheel)

  /**
   * Safely enables mouse tracking
   * @private
   */
  safeEnableMouseTracking() {
    if (this.isMouseEnabled || !this.isInMenu) return;
    
    try {
      // Enable mouse tracking with wheel support
      stdout.write('\x1b[?1000h'); // Enable basic mouse tracking
      stdout.write('\x1b[?1002h'); // Enable cell motion tracking
      stdout.write('\x1b[?1003h'); // Enable all motion tracking (includes wheel)
      stdout.write('\x1b[?1006h'); // Enable SGR mouse mode
      this.isMouseEnabled = true;

      // Add the mouse event listener
      stdin.on('data', this.handleMouseData);
    } catch (error) {
      this.isMouseEnabled = false;
    }
  }

  /**
   * Disables mouse tracking temporarily (for field editing)
   * @private
   */
  disableMouseTracking() {
      if (this.isMouseEnabled) {
          this.resetTerminalModes();
          stdin.removeListener('data', this.handleMouseData);
          this.isMouseEnabled = false;
      }
  }

  /**
   * Re-enables mouse tracking if the menu is still open
   * @private
   */
  enableMouseTracking() {
      if (!this.isMouseEnabled && this.isInMenu) {
          this.safeEnableMouseTracking();
      }
  }

  /**
   * Starts field editing mode with raw input handling.
   * Disables mouse tracking and attaches a raw data listener that filters mouse sequences.
   * @private
   * @param {object} fieldOption - The field option being edited
   * @param {number} line - Line index of the field
   * @param {number} column - Column index of the field
   * @param {Function} renderMenu - Function to re-render the menu
   */
  startFieldEditing(fieldOption, line, column, renderMenu) {
      if (this.isEditing) return; // Already editing

      this.activeField = {
          value: fieldOption.value || '',
          originalValue: fieldOption.value || '',
          line,
          column,
          onChange: fieldOption.onChange || null
      };
      this.isEditing = true;

      // Disable mouse tracking to stop mouse events
      this.disableMouseTracking();

      // Attach raw input listener for field editing
      this.fieldInputHandler = (data) => this.handleFieldInput(data, renderMenu);
      stdin.on('data', this.fieldInputHandler);
  }

  /**
   * Handles raw input during field editing, filtering out mouse sequences.
   * @private
   * @param {Buffer|string} data - Raw input data
   * @param {Function} renderMenu - Function to re-render the menu
   */
  handleFieldInput(data, renderMenu) {
      const str = data.toString();

      // Ignore mouse sequences (SGR or X10)
      if (str.includes('\x1b[<') || str.includes('\x1b[M')) {
          return;
      }

      for (const char of str) {
          if (char === '\r' || char === '\n') {
              // Enter: save and exit
              if (this.activeField.onChange) {
                  this.activeField.onChange(this.activeField.value);
              }
              this.stopFieldEditing(renderMenu);
              return;
          } else if (char === '\x7f' || char === '\b') {
              // Backspace
              if (this.activeField.value.length > 0) {
                  this.activeField.value = this.activeField.value.slice(0, -1);
              }
          } else if (char === '\x1b') {
              // Escape: cancel
              this.activeField.value = this.activeField.originalValue;
              this.stopFieldEditing(renderMenu);
              return;
          } else if (char >= ' ') {
              // Printable character
              this.activeField.value += char;
          }
      }

      // Re-render after changes
      if (renderMenu) renderMenu();
  }

  /**
   * Stops field editing mode, removes the raw listener, and re-enables mouse tracking.
   * @private
   * @param {Function} renderMenu - Function to re-render the menu
   */
  stopFieldEditing(renderMenu) {
      if (this.fieldInputHandler) {
          stdin.removeListener('data', this.fieldInputHandler);
          this.fieldInputHandler = null;
      }
      this.isEditing = false;
      this.activeField = null;
      this.isClickInProgress = false; // Reset to allow future clicks

      // Re-enable mouse tracking if still in menu
      if (this.isInMenu) {
          this.enableMouseTracking();
      }

      // Re-render to show final value
      if (renderMenu) renderMenu();
  }

  /**
   * Cleans up all resources
   * @private
   */
  cleanupAll() {
    this.isInMenu = false;

    // Remove the terminal-resize listener if a menu was open
    if (this.currentMenuState?.resizeHandler) {
      try { stdout.removeListener('resize', this.currentMenuState.resizeHandler); } catch (_) {}
      this.currentMenuState.resizeHandler = null;
    }

    this.cleanupMouseSupport();
    
    if (this.doubleClickTimeout) {
      clearTimeout(this.doubleClickTimeout);
      this.doubleClickTimeout = null;
    }
  }

  /**
   * Resets mouse click state
   * @private
   */
  resetClickState() {
    this.lastMouseClick = { time: 0, x: -1, y: -1 };
    this.isClickInProgress = false;
    
    if (this.doubleClickTimeout) {
      clearTimeout(this.doubleClickTimeout);
      this.doubleClickTimeout = null;
    }
  }

  /**
   * Handles mouse data from terminal
   * @private
   * @param {Buffer|string} data - Raw mouse event data
   */
  handleMouseData(data) {
    if (!this.mouseSupport || !this.isInMenu || !this.currentMenuState) {
      return;
    }

    const stringData = data.toString();
    
    // Check if this is a mouse event
    if (!stringData.includes('\x1b[') || (!stringData.includes('M') && !stringData.includes('m'))) {
      return;
    }

    this.mouseEventBuffer += stringData;

    // Process SGR mouse events (modern terminal mouse protocol)
    const sgrMatch = this.mouseEventBuffer.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (sgrMatch) {
      this.mouseEventBuffer = '';
      this.handleSGRMouseEvent(sgrMatch);
      return;
    }

    // Process X10 mouse events (legacy terminal mouse protocol)
    const x10Match = this.mouseEventBuffer.match(/\x1b\[M([\x00-\xFF]{3})/);
    if (x10Match) {
      this.mouseEventBuffer = '';
      this.handleX10MouseEvent(x10Match);
      return;
    }

    // Clear buffer if it gets too long (malformed data)
    if (this.mouseEventBuffer.length > 20) {
      this.mouseEventBuffer = '';
    }
  }

  /**
   * Handles SGR (Standard Generalized Representation) mouse events
   * @private
   * @param {Array<string>} match - Regex match groups
   */
  handleSGRMouseEvent(match) {
    const button = parseInt(match[1]);
    const x = parseInt(match[2]) - 1;
    const y = parseInt(match[3]) - 1;
    const eventType = match[4];

    // Check for mouse wheel events first (button codes 64 and 65 for wheel up/down in SGR mode)
    if (button & 64) {
      // Wheel event in SGR mode
      const isWheelDown = (button & 1) === 1;
      
      // Emit mouse wheel event
      this.emitEvent(this.eventTypes.MOUSE_WHEEL, {
        x,
        y,
        direction: isWheelDown ? 'down' : 'up',
        buttonCode: button
      });
      
      this.processMouseWheel(x, y, isWheelDown ? 'down' : 'up');
    }
    // Check for left click (button code 0 with eventType 'M')
    else if (eventType === 'M' && button === 0) {
      // Emit mouse click event
      this.emitEvent(this.eventTypes.MOUSE_CLICK, {
        x,
        y,
        button: 'left',
        buttonCode: button
      });
      
      this.processMouseClick(x, y);
    } else if (eventType === 'M' && button === 2) {
      this.emitEvent('mouse:rightclick', { x, y, button: 'right', buttonCode: button });
      // If you want right‑click to also select (like left), uncomment:
      // this.processMouseClick(x, y);
      // Instead we'll let SyAPP handle the navigation
  }
  }

  /**
   * Handles X10 mouse events (legacy protocol)
   * @private
   * @param {Array<string>} match - Regex match groups
   */
  handleX10MouseEvent(match) {
    const bytes = match[1];
    const button = bytes.charCodeAt(0) - 32;
    const x = bytes.charCodeAt(1) - 33;
    const y = bytes.charCodeAt(2) - 33;

    // Check for mouse wheel events in X10 mode (button codes 96 and 97 for wheel up/down)
    if (button >= 96 && button <= 97) {
      const isWheelDown = button === 97;
      
      // Emit mouse wheel event
      this.emitEvent(this.eventTypes.MOUSE_WHEEL, {
        x,
        y,
        direction: isWheelDown ? 'down' : 'up',
        buttonCode: button
      });
      
      this.processMouseWheel(x, y, isWheelDown ? 'down' : 'up');
    }
    // Check for left click (button code 0)
    else if (button === 0) {
      // Emit mouse click event
      this.emitEvent(this.eventTypes.MOUSE_CLICK, {
        x,
        y,
        button: 'left',
        buttonCode: button
      });
      
      this.processMouseClick(x, y);
    } else if (button === 2) {
      this.emitEvent('mouse:rightclick', { x, y, button: 'right', buttonCode: button });
      // this.processMouseClick(x, y);   // if you want identical left/right behaviour
  }
  }

  /**
   * Processes mouse click events
   * @private
   * @param {number} x - X coordinate of click
   * @param {number} y - Y coordinate of click
   */
  processMouseClick(x, y) {  
    if (this.isClickInProgress) return;

    const { normalizedOptions, question, setFocus, selectOption } = this.currentMenuState;
    const clickedIndex = this.findOptionIndexAtCoordinates(y, x, normalizedOptions, question);
    if (clickedIndex === -1) return;

    const { line: targetLine, column: targetColumn } = 
        this.getCoordinatesFromLinearIndex(normalizedOptions, clickedIndex);

    // Always focus the option (visual feedback)
    setFocus(targetLine, targetColumn);

    // Single‑click mode – select immediately
    if (this.clickMode === 'single') {
        // Emit mouse click event
        this.emitEvent(this.eventTypes.MOUSE_CLICK, {
            x, y, button: 'left'
        });
        selectOption('mouse').catch(error => {
            console.error('Error in menu selection:', error);
        });
        return;
    }

    // Double‑click mode (original logic)
    const currentTime = Date.now();
    const isDoubleClick = (currentTime - this.lastMouseClick.time < this.DOUBLE_CLICK_DELAY &&
                           this.lastMouseClick.x === x && 
                           this.lastMouseClick.y === y);

    if (isDoubleClick) {
        this.emitEvent(this.eventTypes.MOUSE_DOUBLE_CLICK, { x, y, button: 'left' });
        this.lastMouseClick = { time: 0, x: -1, y: -1 };
        if (this.doubleClickTimeout) {
            clearTimeout(this.doubleClickTimeout);
            this.doubleClickTimeout = null;
        }
        selectOption('mouse').catch(error => {
            console.error('Error in menu selection:', error);
        });
    } else {
        this.lastMouseClick = { time: currentTime, x, y };
        if (this.doubleClickTimeout) clearTimeout(this.doubleClickTimeout);
        this.doubleClickTimeout = setTimeout(() => {
            this.lastMouseClick = { time: 0, x: -1, y: -1 };
            this.doubleClickTimeout = null;
        }, this.DOUBLE_CLICK_DELAY);
    }
}

  /**
   * Processes mouse wheel events for navigation
   * @private
   * @param {number} x - X coordinate of wheel event
   * @param {number} y - Y coordinate of wheel event
   * @param {'up'|'down'} direction - Wheel direction
   */
  processMouseWheel(x, y, direction) {
    if (!this.currentMenuState || !this.mouseWheel || this.isClickInProgress) {
      return;
    }

    const { normalizedOptions, setFocus, currentLine, currentColumn } = this.currentMenuState;
    
    // Accumulate wheel events to smooth out navigation
    this.wheelAccumulator += (direction === 'down' ? 1 : -1);
    
    // Only navigate when threshold is reached
    if (Math.abs(this.wheelAccumulator) >= this.WHEEL_THRESHOLD) {
      let newLine = currentLine;
      let newColumn = currentColumn;
      
      if (direction === 'down') {
        // Move down (next item)
        const linearIndex = this.getLinearIndexFromCoordinates(normalizedOptions, currentLine, currentColumn);
        const totalItems = normalizedOptions.reduce((sum, line) => sum + line.length, 0);
        
        if (linearIndex < totalItems - 1) {
          const newLinearIndex = linearIndex + 1;
          const coordinates = this.getCoordinatesFromLinearIndex(normalizedOptions, newLinearIndex);
          newLine = coordinates.line;
          newColumn = coordinates.column;
        }
      } else {
        // Move up (previous item)
        const linearIndex = this.getLinearIndexFromCoordinates(normalizedOptions, currentLine, currentColumn);
        
        if (linearIndex > 0) {
          const newLinearIndex = linearIndex - 1;
          const coordinates = this.getCoordinatesFromLinearIndex(normalizedOptions, newLinearIndex);
          newLine = coordinates.line;
          newColumn = coordinates.column;
        }
      }
      
      this.currentMenuState.currentLine = newLine;
this.currentMenuState.currentColumn = newColumn;

// Update the focused index for remember functionality
this.lastFocusedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, newLine, newColumn);

// Set focus to new position
setFocus(newLine, newColumn);
      
      // Reset accumulator
      this.wheelAccumulator = 0;
    }
  }

  /**
   * Finds the menu option index at given terminal coordinates
   * @private
   * @param {number} terminalY - Terminal Y coordinate
   * @param {number} terminalX - Terminal X coordinate
   * @param {Array<Array<object>>} normalizedOptions - Normalized menu options
   * @param {string} question - Menu question/title
   * @returns {number} Index of the option or -1 if not found
   */
  findOptionIndexAtCoordinates(terminalY, terminalX, normalizedOptions, question) {
    // The renderer stores the exact terminal rows where the first visible
    // scrollable option, the first pinned-top option and the first
    // pinned-bottom option were drawn. Mouse coordinates are mapped back
    // into the combined normalizedOptions array, whose ordering is:
    //   [pinned-top] → [scrollable] → [pinned-bottom]
    const state = this.currentMenuState;

    const pinnedTopCount = (state && typeof state.pinnedTopCount === 'number')
      ? state.pinnedTopCount
      : 0;
    const scrollableCount = (state && typeof state.scrollableCount === 'number')
      ? state.scrollableCount
      : normalizedOptions.length;
    const scrollableStartIndex = (state && typeof state.scrollableStartIndex === 'number')
      ? state.scrollableStartIndex
      : pinnedTopCount;
    const pinnedBottomStartIndex = (state && typeof state.pinnedBottomStartIndex === 'number')
      ? state.pinnedBottomStartIndex
      : (pinnedTopCount + scrollableCount);

    const pinnedTopFirstRow = (state && typeof state.pinnedTopFirstRow === 'number')
      ? state.pinnedTopFirstRow
      : -1;
    const pinnedFirstRow = (state && typeof state.pinnedFirstRow === 'number')
      ? state.pinnedFirstRow
      : -1;

    let row;

    if (pinnedTopFirstRow >= 0 && terminalY >= pinnedTopFirstRow && terminalY < (pinnedTopFirstRow + pinnedTopCount)) {
      // Click is inside the pinned-top area
      row = terminalY - pinnedTopFirstRow;
    } else if (pinnedFirstRow >= 0 && terminalY >= pinnedFirstRow) {
      // Click is inside the pinned-bottom area (below the separator)
      row = pinnedBottomStartIndex + (terminalY - pinnedFirstRow);
    } else {
      // Click is inside the scrollable area
      let firstItemRow;
      let scrollOffset = 0;
      let maxVisible;

      if (state && typeof state.firstItemRow === 'number') {
        firstItemRow = state.firstItemRow;
        scrollOffset = state.scrollOffset || 0;
        maxVisible = typeof state.maxVisibleLines === 'number'
          ? state.maxVisibleLines
          : scrollableCount;
      } else {
        firstItemRow = 0;
        if (question) {
          firstItemRow += question.split('\n').length + 1;
        }
        scrollOffset = 0;
        maxVisible = scrollableCount;
      }

      const visualRow = terminalY - firstItemRow;
      if (visualRow < 0) return -1;

      // Walk items accumulating visual heights. TextView items occupy
      // `lines` rows each, so the old 1-row-per-item mapping would
      // return the wrong item when a textview sits above the click.
      let acc = 0;
      let targetRel = -1;
      for (let i = scrollOffset; i < scrollableCount; i++) {
        const lineArr = normalizedOptions[scrollableStartIndex + i];
        if (!lineArr) break;
        const h = (Array.isArray(lineArr) && lineArr.length === 1 &&
                   lineArr[0] && lineArr[0].type === 'textview')
          ? Math.max(2, lineArr[0].lines || 4)
          : 1;
        if (visualRow < acc + h) {
          targetRel = i;
          break;
        }
        acc += h;
      }

      if (targetRel === -1) return -1;

      row = scrollableStartIndex + targetRel;
    }

    if (row < 0 || row >= normalizedOptions.length) return -1;

    // GRID hit-testing: side-by-side cells, each `cellWidth` wide with a
    // 1-char '│' separator between them.
    if (normalizedOptions[row] && normalizedOptions[row]._grid) {
      const line = normalizedOptions[row];
      const grid = line._grid;
      const ranges = line._gridCellRanges || [];
      const numCells = ranges.length;
      if (numCells === 0) return -1;

      const termWidth = stdout.columns || 80;
      const cfg = grid.config || {};
      const maxRatio = (typeof cfg.maxCellRatio === 'number' && cfg.maxCellRatio > 0)
        ? cfg.maxCellRatio
        : 0.2;
      const maxCellWidth = Math.max(8, Math.floor(termWidth * maxRatio));
      const totalGap = Math.max(0, numCells - 1);
      const availableWidth = Math.max(1, termWidth - totalGap);
      const cellWidth = Math.min(
        maxCellWidth,
        Math.max(6, Math.floor(availableWidth / numCells))
      );

      const hMap = (state && state.hScrollByLine) ? state.hScrollByLine : {};
      const gMap = (hMap.__grid) ? hMap.__grid : {};
      const gridKey = `g${row}_${grid.name || ''}`;
      const cellScrolls = gMap[gridKey] || new Array(numCells).fill(0);

      let x = terminalX;
      let cellIdx = -1;
      let cellOffsetX = 0;
      for (let ci = 0; ci < numCells; ci++) {
        if (ci > 0) {
          if (x < 1) break;
          x -= 1;
        }
        if (x < cellWidth) { cellIdx = ci; cellOffsetX = x; break; }
        x -= cellWidth;
      }
      if (cellIdx < 0) return -1;

      const range = ranges[cellIdx];
      const scroll = Math.max(0, cellScrolls[cellIdx] || 0);
      const cell = grid.cells[cellIdx];
      const items = (cell && cell.items) || [];
      const strip = (s) => String(s == null ? '' : s).replace(/\x1b\[[0-9;]*m/g, '');
      const textOf = (it) => {
        if (!it) return '';
        if (typeof it === 'string') return it;
        if (it.type === 'cellText') return String(it.text || '');
        if (it.type === 'field') {
          const label = it.label || '';
          const val = String(it.value || '');
          return label ? `${label}: ░${val}░` : `░${val}░`;
        }
        return it.name || '';
      };

      let curX = 0;
      if (scroll > 0) curX += strip(`◀${scroll} `).length;
      for (let i = scroll; i < items.length; i++) {
        const w = strip(textOf(items[i])).length;
        if (cellOffsetX >= curX && cellOffsetX <= curX + w + 2) {
          return this.getLinearIndexFromCoordinates(normalizedOptions, row, range.start + i);
        }
        curX += w + 2;
      }
      return -1;
    }

    // Find the column inside that row.
    //
    // The row may be horizontally scrolled: when `hScrollByLine[row]` is
    // greater than zero, the first visible column is not column 0, and a
    // dim "◀N " indicator occupies a few leading characters. Both are
    // accounted for here so clicks still land on the correct option.
    const hScrollByLine = (state && state.hScrollByLine) ? state.hScrollByLine : {};
    const hScroll = hScrollByLine[row] || 0;

    let currentColumn = 0;
    if (hScroll > 0) {
      currentColumn += (`◀${hScroll} `).length;
    }

    for (let column = hScroll; column < normalizedOptions[row].length; column++) {
      const option = normalizedOptions[row][column];
      const rawText = typeof option === 'string' ? option : option.name || JSON.stringify(option);
      const text = rawText.replace(/\x1b\[[0-9;]*m/g, '');   // strip escape sequences
      const textWidth = text.length;

      const optionStart = currentColumn;
      const optionEnd = currentColumn + textWidth;

      if (terminalX >= optionStart && terminalX <= optionEnd + 2) {
        return this.getLinearIndexFromCoordinates(normalizedOptions, row, column);
      }

      currentColumn += textWidth + 3;
    }

    return -1;
  }
}

// Event type definitions for JSDoc

/**
 * Event emitted when a menu is displayed
 * @event TerminalHUD#menu:display
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} question - Menu question/title
 * @property {Array<object|Array<object>>} options - Menu options (sanitized)
 * @property {object} configuration - Configuration object
 * @property {number} [initialIndex] - Initial selected index
 * @property {'arrow'|'arrow-original'|'numbered'|'numbered-from-options'} menuType - Type of menu displayed
 */

/**
 * Event emitted when a menu option is selected
 * @event TerminalHUD#menu:selection
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} index - Linear index of selected option
 * @property {number} line - Row index of selected option
 * @property {number} column - Column index of selected option
 * @property {object} selected - Selected option data (sanitized)
 * @property {string} question - Menu question/title
 * @property {'keyboard'|'mouse'|'numbered'} source - Source of selection
 * @property {object} [customData] - Custom data from option
 * @property {object} [metadata] - Metadata from option
 */

/**
 * Event emitted when navigating through menu options
 * @event TerminalHUD#menu:navigation
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} line - New row index
 * @property {number} column - New column index
 * @property {number} linearIndex - New linear index
 * @property {string} question - Menu question/title
 */

/**
 * Event emitted when a menu is closed
 * @event TerminalHUD#menu:close
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Event emitted when asking a question
 * @event TerminalHUD#question:ask
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} question - The question being asked
 * @property {object} configuration - Configuration object
 */

/**
 * Event emitted when a question is answered
 * @event TerminalHUD#question:answer
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} question - The question that was asked
 * @property {string} answer - The answer provided
 * @property {object} configuration - Configuration object
 */

/**
 * Event emitted when loading starts
 * @event TerminalHUD#loading:start
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Event emitted when loading stops
 * @event TerminalHUD#loading:stop
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Event emitted on mouse click
 * @event TerminalHUD#mouse:click
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} x - X coordinate of click
 * @property {number} y - Y coordinate of click
 * @property {'left'|'right'|'middle'} button - Mouse button
 * @property {number} buttonCode - Raw button code
 */

/**
 * Event emitted on mouse double click
 * @event TerminalHUD#mouse:doubleclick
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} x - X coordinate of click
 * @property {number} y - Y coordinate of click
 * @property {'left'|'right'|'middle'} button - Mouse button
 */

/**
 * Event emitted on mouse wheel scroll
 * @event TerminalHUD#mouse:wheel
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} x - X coordinate of wheel event
 * @property {number} y - Y coordinate of wheel event
 * @property {'up'|'down'} direction - Wheel direction
 * @property {number} buttonCode - Raw button code
 */

/**
 * Event emitted on key press
 * @event TerminalHUD#key:press
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} [key] - Key name (for keypress events)
 * @property {string} [sequence] - Raw key sequence
 * @property {boolean} [ctrl] - Ctrl key pressed
 * @property {boolean} [shift] - Shift key pressed
 * @property {boolean} [meta] - Meta key pressed
 * @property {boolean} [inMenu] - Whether in menu context
 * @property {string} [key] - Key character (for generic key press)
 * @property {boolean} [isCtrlC] - Whether it's Ctrl+C
 */

/**
 * Event emitted when waiting for key press
 * @event TerminalHUD#press:wait
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Wildcard event emitted for all events
 * @event TerminalHUD#*
 * @type {object}
 * @property {string} event - Original event name
 * @property {number} timestamp - Event timestamp
 * @property {object} [additionalData] - Original event data
 */


// --------------------------- Util interfaces --------------------------------------------

// --------------------------- Core Classes ---------------------------

/**
 * Represents a session in the application
 * @class
 */
class Session {
  /**
   * @param {Object} config - Session configuration
   * @param {string} [config.uniqueid] - Unique session identifier
   * @param {string} [config.machine_id] - Machine identifier
   * @param {number} [config.process_id] - Process identifier
   * @param {string} [config.userid] - User identifier
   * @param {boolean} [config.external=false] - Whether session is external
   */
  constructor(config = { uniqueid: undefined, machine_id: undefined, process_id: undefined, userid: undefined, external: false }) {
    /** @type {string} */
    this.MachineID = config.machine_id || ''
    /** @type {number|undefined} */
    this.ProcessID = config.process_id || undefined
    /** @type {string|undefined} */
    this.UserID = config.userid || undefined
    /** @type {boolean} */
    this.External = config.external || false
    /** @type {string} */
    this.UniqueID = config.uniqueid || `${this.MachineID}-P${this.ProcessID}`
    /** @type {string|undefined} */
    this.ActualPath = undefined
    /** @type {string|undefined} */
    this.PreviousPath = undefined
    /** @type {Object|undefined} */
    this.ActualProps = undefined
    /** @type {Object|undefined} */
    this.PreviousProps = undefined
    this.InAction = false
    
    // ============================================================
    // NEW: Real function tracking (not affected by refreshes)
    // ============================================================
    /** 
     * The real previous function path (only changes when navigating to a DIFFERENT function)
     * This stays stable during refreshes of the same function
     * @type {string|undefined} 
     */
    this.PreviousFuncPath = undefined
    
    /** 
     * History of previous function paths (max size controlled by SyAPP config)
     * Most recent function is at index 0
     * @type {Array<string>} 
     */
    this.FuncHistory = []
  }
}

/**
 * Represents a user build state
 * @class
 */
class userBuild {
  /**
   * @param {Object} data - Build data
   * @param {Session} [data.session] - Session instance
   */
  constructor(data = { session: new Session }) {
    /** @type {Session} */
    this.Session = data.session || new Session()
    /** @type {string} */
    this.UniqueID = this.Session.UniqueID
    /** @type {string} */
    this.MachineID = this.Session.MachineID
    /** @type {number|undefined} */
    this.ProcessID = this.Session.ProcessID || undefined
    /** @type {string|undefined} */
    this.UserID = this.Session.UserID || undefined
    /** @type {string} */
    this.Text = ''
    /** @type {string} Text rendered inside the pinned-top area (above pinned-top options) */
    this.PinnedTopText = ''
    /** @type {string} Text rendered inside the pinned-bottom area (above pinned-bottom options) */
    this.PinnedText = ''
    /**
     * Optional separator style for the pinned-top area line.
     *   'line' (default) | 'none' | 'discrete'
     * @type {'line'|'none'|'discrete'}
     */
    this.PinnedTopSeparator = 'line'
    /**
     * Optional separator style for the pinned-bottom area line.
     *   'line' (default) | 'none' | 'discrete'
     * @type {'line'|'none'|'discrete'}
     */
    this.PinnedBottomSeparator = 'line'
    /** @type {Array<Object>} */
    this.Buttons = []
    /** @type {boolean} */
    this.WaitInput = false
    /** @type {string} */
    this.InputPath = ''
    /** @type {Object} */
    this.InputProps = ''
    /** @type {string} */
    this.InputQuestion = ''
    /** @type {boolean} */
    this.InputPassword = false

    /**
     * Route collection for HTTP mode
     * @type {Object}
     * @property {Array} GET - GET routes
     * @property {Array} POST - POST routes
     * @property {Array} PUT - PUT routes
     * @property {Array} DELETE - DELETE routes
     */
    this.Routes = {
      GET: [],
      POST: [],
      PUT: [],
      DELETE: []
    }

    /** @type {number} */
    this.droplevel = 0
    /** @type {boolean|undefined} */
    this.dropdown_color = undefined
    /** @type {boolean|undefined} */
    this.dropdown_spacement = undefined
    /** @type {boolean|undefined} */
    this.dropdown_horizontal = undefined
    /** @type {number|undefined} */
    this.last_dropdown_button = undefined
    /** @type {Object|undefined} */
    this.GotoNow = undefined

    /**
     * Page navigation registry — collects every page that requested an
     * auto-generated navigation button during the current Build pass.
     * After the build function finishes, the collected entries are
     * rendered as a single `this.Buttons([...])` row, with the currently
     * selected page visually marked.
     * @type {Array<{name: string, label?: string, pinPosition: 'top'|'bottom'}>}
     */
    this.PageNav = []
  }
}



// --------------------------- HTTP Model Validator ---------------------------

/**
 * HTTP Model Validator class
 * @class
 */
class HTTPModelValidator {
  /**
   * Validate data against a model
   * @param {Object} data - Data to validate
   * @param {Object} model - Model definition
   * @param {Object} options - Validation options
   * @param {boolean} [options.includeMissingKeys=true] - Include missing keys in validation response
   * @returns {Object} Validation result { valid: boolean, errors: Array, sanitized: Object, missingKeys: Array }
   */
  static validate(data, model, options = { includeMissingKeys: true }) {
    if (!model || Object.keys(model).length === 0) {
      return { valid: true, errors: [], sanitized: data, missingKeys: [] }
    }
    
    const errors = []
    const sanitized = {}
    const missingKeys = []
    
    for (const [field, definition] of Object.entries(model)) {
      let fieldType, required = false
      
      if (typeof definition === 'string') {
        fieldType = definition
      } else {
        fieldType = definition.type
        required = definition.required || false
      }
      
      const value = data[field]
      
      if (required && (value === undefined || value === null || value === '')) {
        errors.push(`Field '${field}' is required`)
        missingKeys.push(field)
        continue
      }
      
      if (value !== undefined && value !== null && value !== '') {
        switch (fieldType.toLowerCase()) {
          case 'string':
            sanitized[field] = String(value)
            break
          case 'number':
            const num = Number(value)
            if (isNaN(num)) {
              errors.push(`Field '${field}' must be a number`)
            } else {
              sanitized[field] = num
            }
            break
          case 'boolean':
            if (typeof value === 'string') {
              sanitized[field] = value.toLowerCase() === 'true' || value === '1'
            } else {
              sanitized[field] = Boolean(value)
            }
            break
          case 'object':
            if (typeof value !== 'object' || value === null) {
              errors.push(`Field '${field}' must be an object`)
            } else {
              sanitized[field] = value
            }
            break
          case 'array':
            if (!Array.isArray(value)) {
              errors.push(`Field '${field}' must be an array`)
            } else {
              sanitized[field] = value
            }
            break
          case 'date':
            const date = new Date(value)
            if (isNaN(date.getTime())) {
              errors.push(`Field '${field}' must be a valid date`)
            } else {
              sanitized[field] = date
            }
            break
          default:
            sanitized[field] = value
        }
      } else if (!required && value === undefined) {
        // Optional field not provided, skip
        continue
      } else if (!required && value === null) {
        sanitized[field] = null
      } else if (!required && value === '') {
        sanitized[field] = ''
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      sanitized,
      missingKeys: options.includeMissingKeys ? missingKeys : []
    }
  }
  
  /**
   * Get readable model description
   * @param {Object} model - Model definition
   * @returns {Object} Model description
   */
  static describe(model) {
    const description = {}
    
    for (const [field, definition] of Object.entries(model)) {
      if (typeof definition === 'string') {
        description[field] = { type: definition, required: false }
      } else {
        description[field] = { 
          type: definition.type,
          required: definition.required || false
        }
      }
    }
    
    return description
  }
}

// ============================================================
// STREAMING JSON / JSONL LOADER
// ============================================================
//
// Node.js caps the maximum length of a single JS string at roughly
// 512 MB ("Cannot create a string longer than 0x1fffffe8 characters").
// Naively reading a multi-hundred-MB JSON file with `readFileSync(path,
// 'utf8')` therefore crashes for large datasets.
//
// These helpers load JSON / JSONL files WITHOUT ever materialising the
// entire file as one string:
//
//   • JSONL files are streamed line-by-line.
//   • JSON files whose top-level structure is an array are streamed
//     element-by-element using a depth/string-aware tokenizer.
//   • Files under ~400 MB keep using the fast readFileSync path, so
//     nothing changes for typical datasets.
//
// Memory usage is bounded by the size of the LARGEST top-level item
// (or line, for JSONL), never by the size of the whole file.
// ============================================================

/**
 * Stream the top-level items of a JSON array file. Yields each complete
 * element's raw source text (still encoded as JSON). Handles nested
 * objects/arrays, string escapes and whitespace correctly.
 * @private
 */
async function* _syappStreamJsonArrayItems(filePath, chunkSize = 256 * 1024) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: chunkSize });
  let depth = 0;
  let inString = false;
  let escape = false;
  let arrayStarted = false;
  let itemBuf = '';
  let itemHasContent = false;
  let itemComplete = false;

  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];

      if (!arrayStarted) {
        if (c === '[') { arrayStarted = true; continue; }
        if (/\s/.test(c)) continue;
        throw new Error('Not a top-level JSON array');
      }

      if (inString) {
        itemBuf += c;
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }

      if (itemComplete) {
        if (/\s/.test(c)) continue;
        if (c === ',') {
          itemComplete = false;
          yield itemBuf;
          itemBuf = '';
          itemHasContent = false;
          continue;
        }
        if (c === ']') {
          yield itemBuf;
          return;
        }
        throw new Error('Unexpected character after JSON array item: ' + JSON.stringify(c));
      }

      if (c === '"') {
        inString = true;
        itemBuf += c;
        itemHasContent = true;
        continue;
      }
      if (c === '[' || c === '{') {
        depth++;
        itemBuf += c;
        itemHasContent = true;
        continue;
      }
      if (c === ']' || c === '}') {
        if (depth === 0) {
          if (c === ']') {
            if (itemHasContent) yield itemBuf;
            return;
          }
          throw new Error('Unexpected "}" at top level');
        }
        depth--;
        itemBuf += c;
        if (depth === 0) itemComplete = true;
        continue;
      }
      if (c === ',' && depth === 0) {
        if (itemHasContent) {
          yield itemBuf;
          itemBuf = '';
          itemHasContent = false;
        }
        continue;
      }
      if (/\s/.test(c) && depth === 0 && !itemHasContent) {
        continue;
      }
      itemBuf += c;
      itemHasContent = true;
    }
  }
  if (itemHasContent) yield itemBuf;
}

/**
 * Parse a JSON or JSONL file without ever building a single string
 * larger than the largest top-level item (or line, for JSONL).
 *
 * @param {string} filePath - Absolute path to the .json / .jsonl file.
 * @param {Function} [onProgress] - (bytesRead, totalBytes) callback.
 * @returns {Promise<any>} Parsed data.
 * @private
 */
async function _syappLoadJsonFile(filePath, onProgress) {
  const stat = fs.statSync(filePath);
  const totalBytes = stat.size;
  const lower = filePath.toLowerCase();
  const isJsonl = lower.endsWith('.jsonl');

  // Files under ~400 MB are read in one shot — the fast, well-tested
  // path, well below Node's ~512MB hard cap.
  const SAFE_STRING_LIMIT = 400 * 1024 * 1024;
  if (totalBytes < SAFE_STRING_LIMIT) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (typeof onProgress === 'function') onProgress(totalBytes, totalBytes);
    if (isJsonl) {
      return content
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));
    }
    return JSON.parse(content);
  }

  // Large JSONL: stream line by line.
  if (isJsonl) {
    const data = [];
    let bytesRead = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    let carry = '';
    for await (const chunk of stream) {
      bytesRead += Buffer.byteLength(chunk, 'utf8');
      if (typeof onProgress === 'function') onProgress(bytesRead, totalBytes);
      const combined = carry + chunk;
      let start = 0;
      let idx;
      while ((idx = combined.indexOf('\n', start)) !== -1) {
        let line = combined.slice(start, idx);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.trim() !== '') data.push(JSON.parse(line));
        start = idx + 1;
      }
      carry = combined.slice(start);
    }
    if (carry.trim() !== '') data.push(JSON.parse(carry));
    if (typeof onProgress === 'function') onProgress(totalBytes, totalBytes);
    return data;
  }

  // Large JSON: only top-level arrays can be streamed by the tokenizer.
  // Object-rooted giant JSON genuinely needs a full string; fall back
  // to readFileSync (which will throw the standard string-limit error
  // for files above the cap — a real Node limitation).
  const fd = fs.openSync(filePath, 'r');
  let firstNonWs = '';
  try {
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) {
      const ch = String.fromCharCode(buf[i]);
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
        firstNonWs = ch;
        break;
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  if (firstNonWs !== '[') {
    const content = fs.readFileSync(filePath, 'utf8');
    if (typeof onProgress === 'function') onProgress(totalBytes, totalBytes);
    return JSON.parse(content);
  }

  const data = [];
  let bytesRead = 0;
  for await (const itemStr of _syappStreamJsonArrayItems(filePath)) {
    data.push(JSON.parse(itemStr));
    bytesRead += itemStr.length;
    if (typeof onProgress === 'function') onProgress(bytesRead, totalBytes);
  }
  if (typeof onProgress === 'function') onProgress(totalBytes, totalBytes);
  return data;
}

// ============================================================
// JS PARSER + RUNNER used by this.JavaScript()
// ============================================================

// ---- tokenizer ----
// `clean` has strings/comments blanked; `depthStart` is the brace depth
// entering the line, used to walk class bodies reliably.
function _jsTok(code) {
  const raw = String(code || '').split('\n'), out = [];
  let depth = 0, inB = false, inT = false;
  for (let i = 0; i < raw.length; i++) {
    const orig = raw[i], dStart = depth;
    let c = '', j = 0, inS = null, inL = false;
    while (j < orig.length) {
      const ch = orig[j], nx = orig[j + 1];
      if (inB) { if (ch === '*' && nx === '/') { inB = false; c += '  '; j += 2; } else { c += ' '; j++; } continue; }
      if (inL) { c += ' '; j++; continue; }
      if (inT) { if (ch === '\\') { c += '  '; j += 2; continue; } if (ch === '`') { inT = false; c += ' '; j++; continue; } c += ' '; j++; continue; }
      if (inS) { if (ch === '\\') { c += '  '; j += 2; continue; } if (ch === inS) inS = null; c += ' '; j++; continue; }
      if (ch === '/' && nx === '/') { inL = true; c += '  '; j += 2; continue; }
      if (ch === '/' && nx === '*') { inB = true; c += '  '; j += 2; continue; }
      if (ch === '"' || ch === "'") { inS = ch; c += ' '; j++; continue; }
      if (ch === '`') { inT = true; c += ' '; j++; continue; }
      if (ch === '{') depth++; else if (ch === '}') depth = Math.max(0, depth - 1);
      c += ch; j++;
    }
    out.push({ num: i + 1, original: orig, clean: c, depthStart: dStart });
  }
  return out;
}

function _jsParams(t) {
  const s = t.indexOf('('); if (s < 0) return [];
  let d = 0, e = -1;
  for (let i = s; i < t.length; i++) {
    if (t[i] === '(') d++;
    else if (t[i] === ')') { d--; if (!d) { e = i; break; } }
  }
  if (e < 0) return [];
  const inner = t.slice(s + 1, e); if (!inner.trim()) return [];
  const parts = []; let buf = '', dd = 0;
  for (const ch of inner) {
    if ('([{'.includes(ch)) dd++;
    else if (')]}'.includes(ch)) dd--;
    if (ch === ',' && !dd) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map(p => {
    p = String(p).trim(); if (!p) return null;
    const eq = p.indexOf('=');
    const h = (eq < 0 ? p : p.slice(0, eq)).split(':')[0].trim().split(/\s+/).pop();
    return h || null;
  }).filter(Boolean);
}

function _jsBlockEnd(lines, idx) {
  let d = 0, started = false;
  for (let i = idx; i < lines.length; i++) {
    for (const ch of lines[i].clean) {
      if (ch === '{') { d++; started = true; }
      else if (ch === '}') { d--; if (started && d === 0) return i; }
    }
  }
  return lines.length - 1;
}

function _jsStmtEnd(lines, idx) {
  let d = 0;
  for (let i = idx; i < lines.length; i++) {
    for (const ch of lines[i].clean) {
      if ('([{'.includes(ch)) d++;
      else if (')]}'.includes(ch)) d = Math.max(0, d - 1);
      else if (ch === ';' && !d) return i;
    }
    if (i > idx && !d) {
      const n = lines[i + 1];
      if (n) {
        const nc = n.clean.trim();
        if (nc && !/^[.)\]},]|&&|\|\||=>|\+|-|\*|\/|:/.test(nc)) return i;
      }
    }
  }
  return lines.length - 1;
}

function _jsClassBody(lines, si, ei, name, ext) {
  const bd = lines[si].depthStart + 1;
  const info = { name, extends: ext || null, methods: [], fields: [], constructorArgs: [], lineStart: lines[si].num, lineEnd: lines[ei].num, startIdx: si, endIdx: ei };
  let i = si + 1;
  while (i < ei) {
    const r = lines[i];
    if (r.depthStart !== bd) { i++; continue; }
    let rest = r.clean.trim();
    if (!rest || /^[})\]]/.test(rest)) { i++; continue; }
    const m = { isStatic: false, isAsync: false };
    let g = 0, mc;
    while ((mc = rest.match(/^(static|async|get|set|public|private|protected|readonly|abstract|override)\s+/)) && g++ < 8) {
      if (mc[1] === 'static') m.isStatic = true;
      else if (mc[1] === 'async') m.isAsync = true;
      rest = rest.slice(mc[0].length);
    }
    if (/^constructor\s*\(/.test(rest)) { const e = _jsBlockEnd(lines, i); info.constructorArgs = _jsParams(rest); i = e + 1; continue; }
    const mm = rest.match(/^([A-Za-z_$#][\w$]*|\[[^\]]*\])\s*\??\s*\(/);
    if (mm) { const e = _jsBlockEnd(lines, i); info.methods.push({ name: mm[1], params: _jsParams(rest), isStatic: m.isStatic, isAsync: m.isAsync, lineStart: r.num, startIdx: i, endIdx: e }); i = e + 1; continue; }
    const fm = rest.match(/^([A-Za-z_$#][\w$]*)\s*(?:=|;|:)/);
    if (fm) { const e = _jsStmtEnd(lines, i); info.fields.push({ name: fm[1], isStatic: m.isStatic, lineStart: r.num, startIdx: i, endIdx: e }); i = e + 1; continue; }
    i++;
  }
  return info;
}

function _jsParse(code) {
  const r = { classes: [], functions: [], variables: [], imports: [] };
  const lines = _jsTok(code);
  let i = 0;
  while (i < lines.length) {
    const rec = lines[i], c = rec.clean.trim();
    if (!c || rec.depthStart !== 0) { i++; continue; }
    let m;
    if ((m = c.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+([A-Za-z_$.]+))?/))) {
      const e = _jsBlockEnd(lines, i);
      r.classes.push(_jsClassBody(lines, i, e, m[1], m[2]));
      i = e + 1; continue;
    }
    if ((m = c.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/))) {
      const e = _jsBlockEnd(lines, i);
      r.functions.push({ name: m[1], params: _jsParams(c), isAsync: /\basync\b/.test(c), lineStart: rec.num, startIdx: i, endIdx: e });
      i = e + 1; continue;
    }
    if ((m = c.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/))) {
      const e = _jsStmtEnd(lines, i);
      const full = lines.slice(i, e + 1).map(l => l.clean).join(' ');
      if (/=>/.test(full) || /\bfunction\b/.test(full)) {
        r.functions.push({ name: m[1], params: _jsParams(full), isAsync: /=\s*async\b/.test(full), lineStart: rec.num, startIdx: i, endIdx: e });
      } else {
        r.variables.push({ name: m[1], lineStart: rec.num, startIdx: i, endIdx: e });
      }
      i = e + 1; continue;
    }
    if (/^import\b/.test(c) && !/^import\s*\(/.test(c)) {
      const e = _jsStmtEnd(lines, i);
      r.imports.push({ statement: rec.original.trim(), lineStart: rec.num, startIdx: i, endIdx: e });
      i = e + 1; continue;
    }
    i++;
  }
  return r;
}

function _jsShape(src) {
  try { return _jsParse(String(src || '')); }
  catch (_) { return { classes: [], functions: [], variables: [], imports: [] }; }
}

function _jsCoerce(v) {
  if (v == null || typeof v !== 'string') return v;
  const t = v.trim();
  if (t === '') return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t === 'undefined') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^[\[{"]/.test(t)) try { return JSON.parse(t); } catch (_) {}
  return v;
}

function _jsFit(name, max) {
  name = String(name || '');
  if (name.length <= max) return name;
  return name.slice(0, Math.max(1, max - 6)) + '…' + name.slice(-4);
}

// ============================================================
// RECENTS STORAGE — JSON files under os.tmpdir()
// ============================================================
// Every inline code written through the widget's editor is saved
// here. Pinned entries survive pruning; unpinned ones are trimmed to
// the newest `maxUnpinned` (default 20).

const _JS_CODES_DIR = path.join(os.tmpdir(), 'syapp_js_codes');

function _jsEnsureDir() {
  try { if (!fs.existsSync(_JS_CODES_DIR)) fs.mkdirSync(_JS_CODES_DIR, { recursive: true }); } catch (_) {}
}

function _jsList() {
  _jsEnsureDir();
  try {
    return fs.readdirSync(_JS_CODES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const full = path.join(_JS_CODES_DIR, f);
          const j = JSON.parse(fs.readFileSync(full, 'utf8'));
          return {
            file: f,
            name: String(j.name || 'untitled'),
            code: String(j.code || ''),
            pinned: !!j.pinned,
            createdAt: j.createdAt || 0,
            updatedAt: j.updatedAt || 0,
            mtime: fs.statSync(full).mtimeMs
          };
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || ((b.mtime || 0) - (a.mtime || 0)));
  } catch (_) { return []; }
}

function _jsSave(entry) {
  _jsEnsureDir();
  const file = entry.file || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.json`;
  const payload = {
    name: String(entry.name || 'untitled'),
    code: String(entry.code || ''),
    pinned: !!entry.pinned,
    createdAt: entry.createdAt || Date.now(),
    updatedAt: Date.now()
  };
  try { fs.writeFileSync(path.join(_JS_CODES_DIR, file), JSON.stringify(payload, null, 2)); } catch (_) {}
  return { file, ...payload };
}

function _jsLoad(file) {
  try {
    const p = path.join(_JS_CODES_DIR, file);
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      file,
      name: String(j.name || 'untitled'),
      code: String(j.code || ''),
      pinned: !!j.pinned,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt
    };
  } catch (_) { return null; }
}

function _jsDel(file) {
  try { fs.unlinkSync(path.join(_JS_CODES_DIR, file)); return true; } catch (_) { return false; }
}

function _jsPrune(maxUnpinned = 20) {
  const unpinned = _jsList().filter(c => !c.pinned);
  let n = 0;
  for (let i = maxUnpinned; i < unpinned.length; i++) if (_jsDel(unpinned[i].file)) n++;
  return n;
}

function _jsAutoName(code) {
  const line = String(code || '').split('\n').find(l => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l));
  return line ? line.trim().slice(0, 40) : 'untitled';
}

// ============================================================
// JS EXECUTION — fresh `node` subprocess per call
// ============================================================

const _JS_RUNNER = [
  "const url=require('url'),file=process.argv[1],cls=process.argv[2],meth=process.argv[3],b64=process.argv[4];",
  "function snap(v,d,s){d=d||0;s=s||new WeakSet();if(d>8)return'[max-depth]';if(v==null)return null;const t=typeof v;",
  "if(t==='bigint'||t==='symbol')return v.toString();if(t==='function')return'[Function: '+(v.name||'anonymous')+']';",
  "if(t!=='object')return v;if(s.has(v))return'[circular]';s.add(v);",
  "if(Array.isArray(v))return v.map(x=>snap(x,d+1,s));",
  "if(v instanceof Date)return{'__Date':v.toISOString()};",
  "if(v instanceof RegExp)return{'__RegExp':String(v)};",
  "if(v instanceof Error)return{'__Error':v.message,name:v.name};",
  "if(v instanceof Map)return{'__Map':Array.from(v.entries()).map(([k,x])=>[snap(k,d+1,s),snap(x,d+1,s)])};",
  "if(v instanceof Set)return{'__Set':Array.from(v.values()).map(x=>snap(x,d+1,s))};",
  "const o={};for(const k of Object.keys(v))try{o[k]=snap(v[k],d+1,s)}catch(_){o[k]='[unserializable]'}return o}",
  "(async()=>{try{",
  "const m=await import(url.pathToFileURL(file).href+'?t='+Date.now());",
  "const cs=[];if(m.default!==undefined)cs.push(m.default);for(const k of Object.keys(m))if(k!=='default')cs.push(m[k]);",
  "let C=null;for(const c of cs)if(typeof c==='function'&&c.name===cls){C=c;break}",
  "if(!C)throw new Error('Class \"'+cls+'\" not found in exported module');",
  "let a={};try{a=JSON.parse(Buffer.from(b64,'base64').toString('utf8')||'{}')}catch(_){}",
  "const ca=Array.isArray(a.constructor)?a.constructor:[],ma=Array.isArray(a.method)?a.method:[],pp=a.props&&typeof a.props==='object'?a.props:{};",
  "const inst=new C(...ca);for(const k of Object.keys(pp))try{inst[k]=pp[k]}catch(_){}",
  "if(meth==='__constructOnly'){process.stdout.write(JSON.stringify({ok:true,instance:snap(inst)})+'\\n');return}",
  "if(typeof inst[meth]!=='function')throw new Error('Method not found: '+meth);",
  "let r=inst[meth](...ma);if(r&&typeof r.then==='function')r=await r;",
  "process.stdout.write(JSON.stringify({ok:true,result:snap(r),instance:snap(inst)})+'\\n')",
  "}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e&&e.message?e.message:String(e),stack:e&&e.stack?e.stack:null})+'\\n')}})();"
].join("\n");

function _jsRunNode(scriptPath, args = [], options = {}) {
  return new Promise((resolve) => {
    const timeout = options.timeout || 30000;
    let done = false;
    const fin = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = spawn('node', [scriptPath, ...args], { cwd: options.cwd || process.cwd(), env: { ...process.env, ...(options.env || {}) } });
    } catch (e) { return fin({ ok: false, error: e.message, code: -1 }); }
    let so = '', se = '';
    if (child.stdout) child.stdout.on('data', d => { so += d.toString(); if (so.length > 5e6) so = so.slice(-5e6); });
    if (child.stderr) child.stderr.on('data', d => { se += d.toString(); if (se.length > 5e6) se = se.slice(-5e6); });
    child.on('close', (code, signal) => fin({ ok: code === 0, code, signal, stdout: so, stderr: se }));
    child.on('error', (err) => fin({ ok: false, error: err.message, code: -1, stdout: so, stderr: se }));
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} fin({ ok: false, error: `Timed out after ${timeout}ms`, code: -1, stdout: so, stderr: se }); }, timeout);
    child.on('close', () => clearTimeout(t));
  });
}

async function _jsRunInline(code, options = {}) {
  const tmp = path.join(os.tmpdir(), `syapp_js_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.js`);
  fs.writeFileSync(tmp, String(code || ''), 'utf8');
  try { return await _jsRunNode(tmp, options.args || [], options); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

function _jsRunClass(filePath, cls, meth, args = {}, options = {}) {
  return new Promise((resolve) => {
    const timeout = options.timeout || 30000;
    let done = false;
    const fin = (r) => { if (!done) { done = true; resolve(r); } };
    const b64 = Buffer.from(JSON.stringify(args || {}), 'utf8').toString('base64');
    let child;
    try {
      child = spawn('node', ['-e', _JS_RUNNER, filePath, cls, meth, b64], { cwd: options.cwd || path.dirname(filePath) || process.cwd(), env: { ...process.env } });
    } catch (e) { return fin({ ok: false, error: e.message }); }
    let so = '', se = '';
    if (child.stdout) child.stdout.on('data', d => { so += d.toString(); });
    if (child.stderr) child.stderr.on('data', d => { se += d.toString(); });
    child.on('close', () => {
      try {
        const trimmed = so.trim(), p = trimmed ? JSON.parse(trimmed) : null;
        if (!p) return fin({ ok: false, error: 'Empty result', stderr: se });
        if (p.ok) return fin({ ok: true, result: p.result, instance: p.instance, stderr: se });
        return fin({ ok: false, error: p.error || 'Unknown error', stack: p.stack, stderr: se });
      } catch (e) { fin({ ok: false, error: 'Could not parse runner output: ' + e.message, raw: so, stderr: se }); }
    });
    child.on('error', (err) => fin({ ok: false, error: err.message }));
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} fin({ ok: false, error: `Timed out after ${timeout}ms`, stderr: se }); }, timeout);
    child.on('close', () => clearTimeout(t));
  });
}

// --------------------------- SyAPP_Func Class ---------------------------

/**
 * Base class for all application functions
 * @class
 */
class SyAPP_Func {
  /**
   * @param {string} name - Function name
   * @param {Function} build - Build function
   * @param {Object} config - Configuration
   * @param {Array<{name: string, stream: boolean, method: string, input_model: Object, output_model: Object, input_validate: any}>} [config.routes] - Route configurations
   * @param {boolean} [config.userid_only=false] - Whether function is user ID only
   * @param {boolean} [config.log=false] - Enable logging
   * @param {Array<Function>} [config.linked=[]] - Linked functions
   * @param {string} [config.group=''] - Group name for routes
   * @param {boolean|null} [config.refreshMode=null] - Refresh mode override (null=use global, true=force on, false=force off)
   * @param {Function} [config.onEnter] - Deprecated: Use Lifecycle hooks instead
   * @param {boolean} [config.onEnterOnce=false] - Deprecated: Use Lifecycle hooks instead
   * @param {Function} [config.syappInit] - Global SyAPP-level init hook. Executes ONCE after the parent SyAPP instance finishes construction. SyAPP will NOT load the first screen (and will NOT run any refresh tick) until this hook's returned Promise has FULLY resolved. Receives a context object: { syapp, mainFuncName, mainFuncOriginalName, serverConfig, config, userConfig, funcs, sessions, mainSessionId, logMaster, colorText, configManager }.
   * @param {boolean} [config.syappInitOnce=true] - If true (default), the syappInit hook runs only once per SyAPP instance.
   */
  constructor(name, build = async (props = { session: new Session }) => { }, config = {
    routes: [{ name: '', stream: false, method: '', input_model: {}, output_model: {}, input_validate: {} }],
    userid_only: false,
    log: false,
    linked: [],
    group: '',
    refreshMode: null,
    onEnter: undefined,
    onEnterOnce: false,
    syappInit: undefined,
    syappInitOnce: true
  }) {
    /** @type {string} */
    this.Name = name
    /**
     * Raw build function as provided to the constructor.
     *
     * Kept as a private reference so `this.Emb()` can invoke the build
     * body of an embedded SyAPP_Func WITHOUT going through the regular
     * `Build()` lifecycle — which would otherwise create and then delete
     * the session's `userBuild`, wiping the PARENT's in-progress build
     * for the same session id.
     *
     * @type {Function}
     * @private
     */
    this._rawBuild = build
    /** @type {Array<Function>} */
    this.Linked = config.linked || []
    /** @type {boolean} */
    this.Log = config.log || false
    /** @type {boolean} */
    this.UserID_Only = config.userid_only || false
    /** @type {Array} */
    this.Routes = config.routes || []
    /** @type {string} */
    this.Group = config.group || ''
    /** @type {boolean|null} Refresh mode override */
    this.RefreshMode = config.refreshMode !== undefined ? config.refreshMode : null

    // Legacy onEnter support (backward compatibility)
    /** @type {Function|undefined} Hook executed on each manual entry (not on refresh) */
    this.OnEnter = config.onEnter
    /** @type {boolean} If true, OnEnter runs only once per user session */
    this.OnEnterOnce = config.onEnterOnce || false

    // ============================================================
    // SyAPP INIT PROCESS (global, SyAPP-instance level)
    // ============================================================
    // Executed ONCE after the parent SyAPP instance finishes its
    // construction. SyAPP will not proceed to the first screen (nor
    // will it schedule any refresh tick) until the returned Promise
    // has FULLY resolved — including any awaited async work inside.
    //
    // The handler receives the full SyAPP context, including the
    // resolved `mainFuncName` (whether it came from the class's own
    // name or from `{ mainFuncName: ... }` passed to
    // `new SyAPP(MyFunc, { mainFuncName: 'Custom' })`).
    //
    // @example
    //   new SyAPP_Func('myapp', buildFn, {
    //     syappInit: async ({ mainFuncName, syapp, userConfig }) => {
    //       console.log('SyAPP starting as', mainFuncName)
    //       await seedDatabase()
    //     }
    //   })
    // ============================================================

    /**
     * SyAPP-instance init hook. Receives a context object with the
     * SyAPP instance, its resolved mainFuncName, serverConfig, funcs,
     * sessions, and the raw user config.
     * @type {Function|undefined}
     */
    this.SyAPPInit = config.syappInit

    /**
     * If true (default), SyAPPInit runs only once per SyAPP instance.
     * @type {boolean}
     */
    this.SyAPPInitOnce = config.syappInitOnce !== false

    /**
     * Internal flag tracking whether SyAPPInit already ran.
     * @type {boolean}
     * @private
     */
    this._syappInitExecuted = false

    /** @type {Map<string, Map<string, {data: Object, expiry: number, position: number, textLineIndex: number}>>} */
    this.AlertStorage = new Map()

    // Alert configuration
    /** @type {Object} */
    this.AlertConfig = {
      defaultDuration: 5000,
      maxAlerts: 100,
      allowDuplicates: false // Default: don't allow duplicate alert names
    }

    /** @type {Map<string, userBuild>} */
    this.Builds = new Map()

    /** @type {Map<string, Object>} */
    this.UserStorage = new Map()

    // ============================================================
    // LIFECYCLE HOOKS SYSTEM
    // ============================================================

    /**
     * Lifecycle hooks storage
     * Organized by level (function/page) and type (enter/leave)
     * Each stores arrays of { handler: Function, once: boolean, executedData }
     * @private
     */
    this._lifecycleHooks = {
      function: {
        enter: [],      // { handler: Function, once: boolean, executed: boolean }
        leave: [],      // { handler: Function, once: boolean, executed: boolean }
      },
      session: {
        enter: [],      // { handler: Function, once: boolean, executedSessions: Set }
        leave: [],      // { handler: Function, once: boolean, executedSessions: Set }
      },
      page: {
        enter: new Map(),  // Map<pageName, Array<{ handler, once, executedSessions, _pageName }>>
        leave: new Map(),  // Map<pageName, Array<{ handler, once, executedSessions, _pageName }>>
      }
    }

    /**
     * Execution context for dynamic hook registration.
     * When a lifecycle phase is active, this object holds the type, associated data,
     * and the session ID. New hooks registered while this is set will be executed immediately.
     * @type {{ type: string, pageName?: string, props: Object, sessionId: string } | null}
     * @private
     */
    this._lifecycleExecutionContext = null;

    // Private helper: execute a single hook handler with error handling
    const executeHookHandler = async (handler, props, onSuccess = null) => {
      try {
        const result = handler(props);
        if (result instanceof Promise) {
          await result;
        }
        if (onSuccess) onSuccess();
      } catch (error) {
        console.error(`Lifecycle hook error in ${this.Name}:`, error);
      }
    };

    /**
     * Storage utilities for user data
     * @namespace
     */
    this.Storages = {
      /**
       * Set a value in user storage
       * @param {string} id - User ID
       * @param {string} key - Storage key
       * @param {*} value - Value to store
       * @returns {boolean} Success
       */
      Set: (id, key, value) => {
        if (!this.UserStorage.has(id)) {
          this.UserStorage.set(id, {})
        }
        this.UserStorage.get(id)[key] = value
        return true
      },

      /**
       * Get a value from user storage
       * @param {string} id - User ID
       * @param {string} key - Storage key
       * @returns {*} Stored value
       */
      Get: (id, key) => {
        const user = this.UserStorage.get(id)
        return user ? user[key] : undefined
      },

      /**
       * Check if key exists in user storage
       * @param {string} id - User ID
       * @param {string} key - Storage key
       * @returns {boolean} Whether key exists
       */
      Has: (id, key) => {
        const user = this.UserStorage.get(id)
        return user ? key in user : false
      },

      /**
       * Delete a key from user storage
       * @param {string} id - User ID
       * @param {string} key - Storage key
       * @returns {boolean} Whether key was deleted
       */
      Delete: (id, key) => {
        const user = this.UserStorage.get(id)
        if (!user) return false
        const existed = key in user
        if (existed) delete user[key]
        return existed
      },

      /**
       * Delete entire user storage
       * @param {string} id - User ID
       * @returns {boolean} Whether user was deleted
       */
      DeleteUser: (id) => {
        return this.UserStorage.delete(id)
      },

      /**
       * Get all user data
       * @param {string} id - User ID
       * @returns {Object|null} All user data
       */
      GetAll: (id) => {
        const user = this.UserStorage.get(id)
        return user ? { ...user } : null
      },

      /**
       * Update user data with a function
       * @param {string} id - User ID
       * @param {Function} updateFn - Update function
       * @returns {*} Result of update function
       */
      Update: (id, updateFn) => {
        if (!this.UserStorage.has(id)) {
          this.UserStorage.set(id, {})
        }
        const user = this.UserStorage.get(id)
        return updateFn(user)
      },

      /**
       * Set multiple values at once
       * @param {string} id - User ID
       * @param {Object} data - Key-value pairs to set
       * @returns {number} Number of keys set
       */
      SetMany: (id, data) => {
        if (!this.UserStorage.has(id)) {
          this.UserStorage.set(id, {})
        }
        const user = this.UserStorage.get(id)
        Object.assign(user, data)
        return Object.keys(data).length
      },

      /**
       * Clear all user data (set to empty object)
       * @param {string} id - User ID
       * @returns {boolean} Success
       */
      ClearUser: (id) => {
        const user = this.UserStorage.get(id)
        if (!user) return false
        for (const key in user) {
          delete user[key]
        }
        return true
      },

      /**
       * Count total users
       * @returns {number} User count
       */
      Count: () => {
        return this.UserStorage.size
      },

      /**
       * Get all user IDs
       * @returns {Array<string>} Array of user IDs
       */
      GetUsers: () => {
        return Array.from(this.UserStorage.keys())
      },

      /**
       * Get all user data
       * @returns {Object} All user data keyed by user ID
       */
      GetAllData: () => {
        const result = {}
        for (const [id, user] of this.UserStorage) {
          result[id] = { ...user }
        }
        return result
      },

      /**
       * Clear all storage
       */
      Clear: () => {
        this.UserStorage.clear()
      }
    }

    /** @type {Object} */
    this.TextColor = ColorText

    /**
     * Wait and log message
     * @param {string} message - Message to log
     * @param {number} ms - Milliseconds to wait
     * @returns {Promise<void>}
     */
    this.WaitLog = async (message, ms = 5000) => {
      console.log(message)
      await new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Admin interface for managing SyAPP instance
     * @namespace
     */
    this.Admin = {
      /**
       * Check if current user is admin
       * @param {string} id - User/build ID
       * @returns {boolean} Whether user is admin
       */
      IsAdmin: (id) => {
        if (!this._syappInstance) return false;
        return this._syappInstance._adminManager.isAdmin(id);
      },

      /**
       * Get SyAPP instance configuration (admin only)
       * @param {string} id - User/build ID
       * @returns {Object|null} Instance configuration or null if not admin
       */
      GetConfig: (id) => {
        if (!this.Admin.IsAdmin(id)) {
          if (this.Log) {
            console.log(`Admin.GetConfig() - Access denied for ${id}`);
          }
          return null;
        }
        return this._syappInstance._adminManager.getConfig();
      },

      /**
       * Update SyAPP instance configuration (admin only)
       * @param {string} id - User/build ID
       * @param {Object} updates - Configuration updates
       * @returns {Object} Result of the operation
       */
      UpdateConfig: (id, updates) => {
        if (!this.Admin.IsAdmin(id)) {
          if (this.Log) {
            console.log(`Admin.UpdateConfig() - Access denied for ${id}`);
          }
          return { success: false, error: 'Not authorized' };
        }
        return this._syappInstance._adminManager.queueUpdate(id, 'updateConfig', updates);
      },

      /**
       * Get server statistics (admin only)
       * @param {string} id - User/build ID
       * @returns {Object|null} Server statistics or null if not admin
       */
      GetStats: (id) => {
        if (!this.Admin.IsAdmin(id)) {
          if (this.Log) {
            console.log(`Admin.GetStats() - Access denied for ${id}`);
          }
          return null;
        }
        return this._syappInstance._adminManager.getStats();
      },

      /**
       * Get active sessions list (admin only)
       * @param {string} id - User/build ID
       * @returns {Array|null} Array of session info or null if not admin
       */
      GetSessions: (id) => {
        if (!this.Admin.IsAdmin(id)) {
          if (this.Log) {
            console.log(`Admin.GetSessions() - Access denied for ${id}`);
          }
          return null;
        }
        return this._syappInstance._adminManager.getSessions();
      },

      /**
       * Add admin user (admin only)
       * @param {string} id - User/build ID
       * @param {string} newAdminId - ID to add as admin
       * @returns {Object} Result of the operation
       */
      AddAdmin: (id, newAdminId) => {
        if (!this.Admin.IsAdmin(id)) {
          if (this.Log) {
            console.log(`Admin.AddAdmin() - Access denied for ${id}`);
          }
          return { success: false, error: 'Not authorized' };
        }
        return this._syappInstance._adminManager.queueUpdate(id, 'addAdmin', { adminId: newAdminId });
      },

      /**
       * Remove admin user (admin only)
       * @param {string} id - User/build ID
       * @param {string} adminId - ID to remove from admins
       * @returns {Object} Result of the operation
       */
      RemoveAdmin: (id, adminId) => {
        if (!this.Admin.IsAdmin(id)) {
          if (this.Log) {
            console.log(`Admin.RemoveAdmin() - Access denied for ${id}`);
          }
          return { success: false, error: 'Not authorized' };
        }
        return this._syappInstance._adminManager.queueUpdate(id, 'removeAdmin', { adminId });
      },

      /**
       * Get HTTP server configuration (admin only)
       * @param {string} id - User/build ID
       * @param {string} funcName - Function name to get info about
       * @returns {Object|null} HTTP config or null if not admin
       */
      GetHTTPConfig: (id) => {
        if (!this.Admin.IsAdmin(id)) {
          if (this.Log) {
            console.log(`Admin.GetHTTPConfig() - Access denied for ${id}`);
          }
          return null;
        }
        return this._syappInstance._adminManager.getHTTPConfig();
      },

      /**
       * Update HTTP server configuration (admin only)
       * @param {string} id - User/build ID
       * @param {Object} updates - HTTP config updates
       * @returns {Object} Result of the operation
       */
      UpdateHTTPConfig: (id, updates) => {
        if (!this.Admin.IsAdmin(id)) {
          if (this.Log) {
            console.log(`Admin.UpdateHTTPConfig() - Access denied for ${id}`);
          }
          return { success: false, error: 'Not authorized' };
        }
        return this._syappInstance._adminManager.queueUpdate(id, 'updateHTTPConfig', updates);
      },

      /**
       * Get function information (admin only)
       * @param {string} id - User/build ID
       * @param {string} funcName - Function name to get info about
       * @returns {Object|null} Function info or null if not admin
       */
      GetFunctionInfo: (id, funcName) => {
        if (!this.Admin.IsAdmin(id)) {
          if (this.Log) {
            console.log(`Admin.GetFunctionInfo() - Access denied for ${id}`);
          }
          return null;
        }
        return this._syappInstance._adminManager.getFunctionInfo(funcName);
      },

      /**
       * Get admin commands help
       * @returns {Object} Available admin commands
       */
      Help: () => {
        return {
          commands: {
            'IsAdmin': 'Check if user is admin',
            'GetConfig': 'Get instance configuration',
            'UpdateConfig': 'Update instance configuration',
            'GetStats': 'Get server statistics',
            'GetSessions': 'Get active sessions',
            'AddAdmin': 'Add admin user',
            'RemoveAdmin': 'Remove admin user',
            'GetHTTPConfig': 'Get HTTP configuration',
            'UpdateHTTPConfig': 'Update HTTP configuration',
            'GetFunctionInfo': 'Get function information'
          },
          usage: 'Replace "this" with the function instance and provide your user ID as first parameter'
        };
      }
    };

    // ============================================================
    // LIFECYCLE HOOKS - PUBLIC API
    // ============================================================

    /**
     * Register a hook to execute when the function is entered for the FIRST TIME by any session
     * (SyAPP level - executes only once globally, not per session)
     * @param {string} id - User/build ID (required for consistency with other methods)
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnFunctionFirstEnter = (id, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnFunctionFirstEnter() Error - handler must be a function | BuildID: ${id}`);
        return this;
      }
      this._lifecycleHooks.function.enter.push({
        handler: handler,
        once: true,
        executed: false
      });
      return this;
    };

    /**
     * Register a hook to execute EVERY TIME the function is entered by any session
     * (SyAPP level - executes for each session entry)
     * @param {string} id - User/build ID (required for consistency with other methods)
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnFunctionEnter = (id, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnFunctionEnter() Error - handler must be a function | BuildID: ${id}`);
        return this;
      }
      this._lifecycleHooks.function.enter.push({
        handler: handler,
        once: false,
        executed: false
      });
      return this;
    };

    /**
     * Register a hook to execute EVERY TIME the function is left by any session
     * @param {string} id - User/build ID (required for consistency with other methods)
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnFunctionLeave = (id, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnFunctionLeave() Error - handler must be a function | BuildID: ${id}`);
        return this;
      }
      this._lifecycleHooks.function.leave.push({
        handler: handler,
        once: false,
        executed: false
      });
      return this;
    };

    /**
     * Register a hook to execute when the function is left for the FIRST TIME by any session
     * (SyAPP level - executes only once globally)
     * @param {string} id - User/build ID (required for consistency with other methods)
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnFunctionFirstLeave = (id, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnFunctionFirstLeave() Error - handler must be a function | BuildID: ${id}`);
        return this;
      }
      this._lifecycleHooks.function.leave.push({
        handler: handler,
        once: true,
        executed: false
      });
      return this;
    };

    /**
     * Register a hook to execute when a SESSION enters the function for the FIRST TIME
     * (Session level - executes once per unique session/user)
     * @param {string} id - User/build ID (the session identifier)
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnSessionEnter = (id, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnSessionEnter() Error - handler must be a function | BuildID: ${id}`);
        return this;
      }
      const hookEntry = {
        handler: handler,
        once: true,
        executedSessions: new Set()
      };
      this._lifecycleHooks.session.enter.push(hookEntry);
      return this;
    };

    /**
     * Register a hook to execute EVERY TIME a session enters the function
     * @param {string} id - User/build ID (the session identifier)
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnSessionEveryEnter = (id, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnSessionEveryEnter() Error - handler must be a function | BuildID: ${id}`);
        return this;
      }
      this._lifecycleHooks.session.enter.push({
        handler: handler,
        once: false,
        executedSessions: new Set()
      });
      return this;
    };

    /**
     * Register a hook to execute when a SESSION leaves the function
     * @param {string} id - User/build ID (the session identifier)
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnSessionLeave = (id, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnSessionLeave() Error - handler must be a function | BuildID: ${id}`);
        return this;
      }
      this._lifecycleHooks.session.leave.push({
        handler: handler,
        once: false,
        executedSessions: new Set()
      });
      return this;
    };

    /**
     * Register a hook to execute when a SESSION leaves the function for the FIRST TIME
     * @param {string} id - User/build ID (the session identifier)
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnSessionFirstLeave = (id, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnSessionFirstLeave() Error - handler must be a function | BuildID: ${id}`);
        return this;
      }
      const hookEntry = {
        handler: handler,
        once: true,
        executedSessions: new Set()
      };
      this._lifecycleHooks.session.leave.push(hookEntry);
      return this;
    };

    /**
     * Register a hook to execute when a SESSION enters a specific PAGE for the FIRST TIME
     * @param {string} id - User/build ID (the session identifier)
     * @param {string} pageName - Name of the page
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnPageEnter = (id, pageName, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnPageEnter() Error - handler must be a function | BuildID: ${id} | Page: ${pageName}`);
        return this;
      }
      if (!this._lifecycleHooks.page.enter.has(pageName)) {
        this._lifecycleHooks.page.enter.set(pageName, []);
      }
      const hookEntry = {
        handler: handler,
        once: true,
        executedSessions: new Set(),
        _pageName: pageName
      };
      this._lifecycleHooks.page.enter.get(pageName).push(hookEntry);

      // Immediate execution ONLY when we are inside a real page‑enter phase
      const ctx = this._lifecycleExecutionContext;
      if (ctx && ctx.type === 'pageEnter' && ctx.pageName === pageName && ctx.sessionId === id) {
        // The flag _isRealPageEnter guarantees we only fire during genuine page changes
        if (ctx.props._isRealPageEnter && !hookEntry.executedSessions.has(id)) {
          executeHookHandler(hookEntry.handler, ctx.props, () => {
            hookEntry.executedSessions.add(id);
          });
        }
      }
      return this;
    };

    /**
     * Register a hook to execute EVERY TIME a session enters a specific PAGE
     * @param {string} id - User/build ID (the session identifier)
     * @param {string} pageName - Name of the page
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnPageEveryEnter = (id, pageName, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnPageEveryEnter() Error - handler must be a function | BuildID: ${id} | Page: ${pageName}`);
        return this;
      }
      if (!this._lifecycleHooks.page.enter.has(pageName)) {
        this._lifecycleHooks.page.enter.set(pageName, []);
      }
      const hookEntry = {
        handler: handler,
        once: false,
        executedSessions: new Set(),
        _pageName: pageName
      };
      this._lifecycleHooks.page.enter.get(pageName).push(hookEntry);

      // Immediate execution if currently inside a real page‑enter phase
      const ctx = this._lifecycleExecutionContext;
      if (ctx && ctx.type === 'pageEnter' && ctx.pageName === pageName && ctx.sessionId === id) {
        if (ctx.props._isRealPageEnter) {
          executeHookHandler(hookEntry.handler, ctx.props, null);
        }
      }
      return this;
    };

    /**
     * Register a hook to execute when a SESSION leaves a specific PAGE
     * @param {string} id - User/build ID (the session identifier)
     * @param {string} pageName - Name of the page
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnPageLeave = (id, pageName, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnPageLeave() Error - handler must be a function | BuildID: ${id} | Page: ${pageName}`);
        return this;
      }
      if (!this._lifecycleHooks.page.leave.has(pageName)) {
        this._lifecycleHooks.page.leave.set(pageName, []);
      }
      const hookEntry = {
        handler: handler,
        once: false,
        executedSessions: new Set(),
        _pageName: pageName
      };
      this._lifecycleHooks.page.leave.get(pageName).push(hookEntry);

      // Immediate execution if currently inside the page leave phase for this page
      const ctx = this._lifecycleExecutionContext;
      if (ctx && ctx.type === 'pageLeave' && ctx.pageName === pageName && ctx.sessionId === id) {
        executeHookHandler(hookEntry.handler, ctx.props, null);
      }
      return this;
    };

    /**
     * Register a hook to execute when a SESSION leaves a specific PAGE for the FIRST TIME
     * @param {string} id - User/build ID (the session identifier)
     * @param {string} pageName - Name of the page
     * @param {Function} handler - Async or sync function to execute: (props) => {} or async (props) => {}
     * @returns {this} For chaining
     */
    this.OnPageFirstLeave = (id, pageName, handler) => {
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`OnPageFirstLeave() Error - handler must be a function | BuildID: ${id} | Page: ${pageName}`);
        return this;
      }
      if (!this._lifecycleHooks.page.leave.has(pageName)) {
        this._lifecycleHooks.page.leave.set(pageName, []);
      }
      const hookEntry = {
        handler: handler,
        once: true,
        executedSessions: new Set(),
        _pageName: pageName
      };
      this._lifecycleHooks.page.leave.get(pageName).push(hookEntry);

      const ctx = this._lifecycleExecutionContext;
      if (ctx && ctx.type === 'pageLeave' && ctx.pageName === pageName && ctx.sessionId === id) {
        if (!hookEntry.executedSessions.has(id)) {
          executeHookHandler(hookEntry.handler, ctx.props, () => {
            hookEntry.executedSessions.add(id);
          });
        }
      }
      return this;
    };

    // ============================================================
    // LIFECYCLE EXECUTION METHODS (Internal)
    // ============================================================

    /**
     * Execute function-level enter hooks (global scope)
     * @param {Object} props - Build props
     * @returns {Promise<void>}
     * @private
     */
    this._executeFunctionEnterHooks = async (props) => {
      const hooks = this._lifecycleHooks.function.enter;
      for (const hook of hooks) {
        if (hook.once && hook.executed) continue;
        if (hook.once) {
          hook.executed = true;
        }
        try {
          const result = hook.handler(props);
          if (result instanceof Promise) {
            await result;
          }
        } catch (error) {
          console.error(`Function enter hook error in ${this.Name}:`, error);
        }
      }
    };

    /**
     * Execute function-level leave hooks (global scope)
     * @param {Object} props - Build props
     * @returns {Promise<void>}
     * @private
     */
    this._executeFunctionLeaveHooks = async (props) => {
      const hooks = this._lifecycleHooks.function.leave;
      for (const hook of hooks) {
        if (hook.once && hook.executed) continue;
        if (hook.once) {
          hook.executed = true;
        }
        try {
          const result = hook.handler(props);
          if (result instanceof Promise) {
            await result;
          }
        } catch (error) {
          console.error(`Function leave hook error in ${this.Name}:`, error);
        }
      }
    };

    /**
     * Execute session-level enter hooks
     * @param {Object} props - Build props
     * @returns {Promise<void>}
     * @private
     */
    this._executeSessionEnterHooks = async (props) => {
      const sessionId = props.session.UniqueID;
      const hooks = this._lifecycleHooks.session.enter;
      for (const hook of hooks) {
        if (hook.once && hook.executedSessions.has(sessionId)) continue;
        try {
          const result = hook.handler(props);
          if (result instanceof Promise) {
            await result;
          }
          if (hook.once) {
            hook.executedSessions.add(sessionId);
          }
        } catch (error) {
          console.error(`Session enter hook error in ${this.Name}:`, error);
        }
      }
    };

    /**
     * Execute session-level leave hooks
     * @param {Object} props - Build props
     * @returns {Promise<void>}
     * @private
     */
    this._executeSessionLeaveHooks = async (props) => {
      const sessionId = props.session.UniqueID;
      const hooks = this._lifecycleHooks.session.leave;
      for (const hook of hooks) {
        if (hook.once && hook.executedSessions.has(sessionId)) continue;
        try {
          const result = hook.handler(props);
          if (result instanceof Promise) {
            await result;
          }
          if (hook.once) {
            hook.executedSessions.add(sessionId);
          }
        } catch (error) {
          console.error(`Session leave hook error in ${this.Name}:`, error);
        }
      }
    };

    /**
     * Execute page-level enter hooks
     * @param {string} pageName - Page name
     * @param {Object} props - Build props
     * @returns {Promise<void>}
     * @private
     */
    this._executePageEnterHooks = async (pageName, props) => {
      const sessionId = props.session.UniqueID;
      const pageHooks = this._lifecycleHooks.page.enter.get(pageName) || [];
      for (const hook of pageHooks) {
        if (hook.once && hook.executedSessions.has(sessionId)) continue;
        try {
          const result = hook.handler(props);
          if (result instanceof Promise) {
            await result;
          }
          if (hook.once) {
            hook.executedSessions.add(sessionId);
          }
        } catch (error) {
          console.error(`Page enter hook error in ${this.Name} page ${pageName}:`, error);
        }
      }
    };

    /**
     * Execute page-level leave hooks
     * @param {string} pageName - Page name
     * @param {Object} props - Build props
     * @returns {Promise<void>}
     * @private
     */
    this._executePageLeaveHooks = async (pageName, props) => {
      const sessionId = props.session.UniqueID;
      const pageHooks = this._lifecycleHooks.page.leave.get(pageName) || [];
      for (const hook of pageHooks) {
        if (hook.once && hook.executedSessions.has(sessionId)) continue;
        try {
          const result = hook.handler(props);
          if (result instanceof Promise) {
            await result;
          }
          if (hook.once) {
            hook.executedSessions.add(sessionId);
          }
        } catch (error) {
          console.error(`Page leave hook error in ${this.Name} page ${pageName}:`, error);
        }
      }
    };

    // --------------------------- HTTP Route Methods ---------------------------

    /**
     * Register a GET route
     * @param {string} id - User/build ID
     * @param {string} path - Route path
     * @param {Function} handler - Route handler (req, res) => {}
     * @param {Object} config - Route configuration
     * @param {boolean} [config.stream=false] - Whether route streams data
     * @param {Object} [config.input_model={}] - Input model definition
     * @param {Object} [config.output_model={}] - Output model definition
     * @param {any} [config.input_validate={}] - Response to send on validation failure
     * @param {Object} [config.validation_options] - Validation options
     * @param {boolean} [config.validation_options.includeMissingKeys=true] - Include missing keys in validation error response
     * @param {boolean} [config.baseRoute] - Override global baseRoute for this specific route
     * @param {boolean} [config.includeFuncName] - Override global includeFuncName for this specific route
     */
    this.Get = (id, path, handler, config = { 
      stream: false, 
      input_model: {}, 
      output_model: {}, 
      input_validate: {}, 
      validation_options: { includeMissingKeys: true },
      baseRoute: undefined, 
      includeFuncName: undefined 
    }) => {
      if (this.Builds.has(id)) {
        const normalizedPath = path === '' ? '/' : (path.startsWith('/') ? path : `/${path}`)
        
        const routeConfig = {
          method: 'GET',
          path: normalizedPath,
          originalPath: path,
          handler,
          stream: config.stream || false,
          input_model: config.input_model || {},
          output_model: config.output_model || {},
          input_validate: config.input_validate || {},
          validation_options: config.validation_options || { includeMissingKeys: true },
          baseRoute: config.baseRoute,
          includeFuncName: config.includeFuncName
        }
        this.Builds.get(id).Routes.GET.push(routeConfig)
      }
    }

    /**
     * Register a POST route
     */
    this.Post = (id, path, handler, config = { 
      stream: false, 
      input_model: {}, 
      output_model: {}, 
      input_validate: {}, 
      validation_options: { includeMissingKeys: true },
      baseRoute: undefined, 
      includeFuncName: undefined 
    }) => {
      if (this.Builds.has(id)) {
        const normalizedPath = path === '' ? '/' : (path.startsWith('/') ? path : `/${path}`)
        
        const routeConfig = {
          method: 'POST',
          path: normalizedPath,
          originalPath: path,
          handler,
          stream: config.stream || false,
          input_model: config.input_model || {},
          output_model: config.output_model || {},
          input_validate: config.input_validate || {},
          validation_options: config.validation_options || { includeMissingKeys: true },
          baseRoute: config.baseRoute,
          includeFuncName: config.includeFuncName
        }
        this.Builds.get(id).Routes.POST.push(routeConfig)
      }
    }

    /**
     * Register a PUT route
     */
    this.Put = (id, path, handler, config = { 
      stream: false, 
      input_model: {}, 
      output_model: {}, 
      input_validate: {}, 
      validation_options: { includeMissingKeys: true },
      baseRoute: undefined, 
      includeFuncName: undefined 
    }) => {
      if (this.Builds.has(id)) {
        const normalizedPath = path === '' ? '/' : (path.startsWith('/') ? path : `/${path}`)
        
        const routeConfig = {
          method: 'PUT',
          path: normalizedPath,
          originalPath: path,
          handler,
          stream: config.stream || false,
          input_model: config.input_model || {},
          output_model: config.output_model || {},
          input_validate: config.input_validate || {},
          validation_options: config.validation_options || { includeMissingKeys: true },
          baseRoute: config.baseRoute,
          includeFuncName: config.includeFuncName
        }
        this.Builds.get(id).Routes.PUT.push(routeConfig)
      }
    }

    /**
     * Register a DELETE route
     */
    this.Delete = (id, path, handler, config = { 
      stream: false, 
      input_model: {}, 
      output_model: {}, 
      input_validate: {}, 
      validation_options: { includeMissingKeys: true },
      baseRoute: undefined, 
      includeFuncName: undefined 
    }) => {
      if (this.Builds.has(id)) {
        const normalizedPath = path === '' ? '/' : (path.startsWith('/') ? path : `/${path}`)
        
        const routeConfig = {
          method: 'DELETE',
          path: normalizedPath,
          originalPath: path,
          handler,
          stream: config.stream || false,
          input_model: config.input_model || {},
          output_model: config.output_model || {},
          input_validate: config.input_validate || {},
          validation_options: config.validation_options || { includeMissingKeys: true },
          baseRoute: config.baseRoute,
          includeFuncName: config.includeFuncName
        }
        this.Builds.get(id).Routes.DELETE.push(routeConfig)
      }
    }

    // --------------------------- Page Methods ---------------------------

    // Add this after the DropDown method in the SyAPP_Func class

/**
 * Dropdown manager methods for managing dropdown states
 * @namespace
 */
this.DropDownManager = {
  /**
   * Open a specific dropdown
   * @param {string} id - User/build ID
   * @param {string} dropdownName - Name of the dropdown (without 'dropdown-' prefix)
   * @returns {boolean} Whether the operation succeeded
   */
  Open: (id, dropdownName) => {
    if (!this.Builds.has(id)) {
      if (this.Log) console.log(`DropDownManager.Open() Error - userBuild not found | BuildID: ${id}`);
      return false;
    }
    
    const storageKey = `dropdown-${dropdownName}`;
    let state = this.Storages.Get(id, storageKey);
    
    if (!state) {
      this.Storages.Set(id, storageKey, { dropped: false });
      state = { dropped: false };
      if (this.Log) console.log(`DropDownManager.Open() - Dropdown '${dropdownName}' not initialized, creating state | BuildID: ${id}`);
    }
    
    if (!state.dropped) {
      state.dropped = true;
      this.Storages.Set(id, storageKey, state);
      return true;
    }
    
    return false; // Already open
  },

  /**
   * Close a specific dropdown
   * @param {string} id - User/build ID
   * @param {string} dropdownName - Name of the dropdown (without 'dropdown-' prefix)
   * @returns {boolean} Whether the operation succeeded
   */
  Close: (id, dropdownName) => {
    if (!this.Builds.has(id)) {
      if (this.Log) console.log(`DropDownManager.Close() Error - userBuild not found | BuildID: ${id}`);
      return false;
    }
    
    const storageKey = `dropdown-${dropdownName}`;
    const state = this.Storages.Get(id, storageKey);
    
    if (!state) {
      if (this.Log) console.log(`DropDownManager.Close() - Dropdown '${dropdownName}' not found | BuildID: ${id}`);
      return false;
    }
    
    if (state.dropped) {
      state.dropped = false;
      this.Storages.Set(id, storageKey, state);
      return true;
    }
    
    return false; // Already closed
  },

  /**
   * Toggle a specific dropdown
   * @param {string} id - User/build ID
   * @param {string} dropdownName - Name of the dropdown (without 'dropdown-' prefix)
   * @returns {boolean} New state (true = open, false = closed)
   */
  Toggle: (id, dropdownName) => {
    if (!this.Builds.has(id)) {
      if (this.Log) console.log(`DropDownManager.Toggle() Error - userBuild not found | BuildID: ${id}`);
      return false;
    }
    
    const storageKey = `dropdown-${dropdownName}`;
    let state = this.Storages.Get(id, storageKey);
    
    if (!state) {
      state = { dropped: false };
      this.Storages.Set(id, storageKey, state);
    }
    
    state.dropped = !state.dropped;
    this.Storages.Set(id, storageKey, state);
    
    return state.dropped;
  },

  /**
   * Check if a specific dropdown is open
   * @param {string} id - User/build ID
   * @param {string} dropdownName - Name of the dropdown (without 'dropdown-' prefix)
   * @returns {boolean} Whether the dropdown is open
   */
  IsOpen: (id, dropdownName) => {
    const storageKey = `dropdown-${dropdownName}`;
    const state = this.Storages.Get(id, storageKey);
    return state ? state.dropped : false;
  },

  /**
   * Close all dropdowns for a user/build
   * @param {string} id - User/build ID
   * @returns {number} Number of dropdowns closed
   */
  CloseAll: (id) => {
    let closedCount = 0;
    
    // Get all storage keys for this user
    const allData = this.Storages.GetAll(id);
    if (!allData) return 0;
    
    for (const key of Object.keys(allData)) {
      if (key.startsWith('dropdown-')) {
        const state = allData[key];
        if (state && state.dropped) {
          state.dropped = false;
          this.Storages.Set(id, key, state);
          closedCount++;
        }
      }
    }
    
    return closedCount;
  },

  /**
   * Get the state of all dropdowns for a user/build
   * @param {string} id - User/build ID
   * @returns {Object} Object with dropdown names as keys (without 'dropdown-' prefix) and their states
   */
  GetStates: (id) => {
    const states = {};
    const allData = this.Storages.GetAll(id);
    
    if (!allData) return states;
    
    for (const key of Object.keys(allData)) {
      if (key.startsWith('dropdown-')) {
        const dropdownName = key.replace('dropdown-', '');
        states[dropdownName] = {
          open: allData[key].dropped || false,
          exists: true
        };
      }
    }
    
    return states;
  },

  /**
   * Get list of all dropdown names for a user/build (without 'dropdown-' prefix)
   * @param {string} id - User/build ID
   * @returns {Array<string>} Array of dropdown names
   */
  List: (id) => {
    const dropdowns = [];
    const allData = this.Storages.GetAll(id);
    
    if (!allData) return dropdowns;
    
    for (const key of Object.keys(allData)) {
      if (key.startsWith('dropdown-')) {
        dropdowns.push(key.replace('dropdown-', ''));
      }
    }
    
    return dropdowns;
  },

  /**
   * Get count of open dropdowns for a user/build
   * @param {string} id - User/build ID
   * @returns {number} Number of open dropdowns
   */
  CountOpen: (id) => {
    let openCount = 0;
    const allData = this.Storages.GetAll(id);
    
    if (!allData) return 0;
    
    for (const key of Object.keys(allData)) {
      if (key.startsWith('dropdown-') && allData[key].dropped) {
        openCount++;
      }
    }
    
    return openCount;
  },

  /**
   * Get total count of dropdowns for a user/build
   * @param {string} id - User/build ID
   * @returns {number} Total number of dropdowns
   */
  Count: (id) => {
    let count = 0;
    const allData = this.Storages.GetAll(id);
    
    if (!allData) return 0;
    
    for (const key of Object.keys(allData)) {
      if (key.startsWith('dropdown-')) {
        count++;
      }
    }
    
    return count;
  },

  /**
   * Delete/reset a specific dropdown state
   * @param {string} id - User/build ID
   * @param {string} dropdownName - Name of the dropdown (without 'dropdown-' prefix)
   * @returns {boolean} Whether the dropdown was deleted
   */
  Reset: (id, dropdownName) => {
    const storageKey = `dropdown-${dropdownName}`;
    return this.Storages.Delete(id, storageKey);
  },

  /**
   * Delete all dropdown states for a user/build
   * @param {string} id - User/build ID
   * @returns {number} Number of dropdowns deleted
   */
  ResetAll: (id) => {
    let deletedCount = 0;
    const allData = this.Storages.GetAll(id);
    
    if (!allData) return 0;
    
    for (const key of Object.keys(allData)) {
      if (key.startsWith('dropdown-')) {
        this.Storages.Delete(id, key);
        deletedCount++;
      }
    }
    
    return deletedCount;
  },

  /**
   * Get detailed information about all dropdowns for a user/build
   * @param {string} id - User/build ID
   * @returns {Object} Detailed dropdown information
   */
  GetInfo: (id) => {
    const info = {
      total: 0,
      open: 0,
      closed: 0,
      dropdowns: {}
    };
    
    const allData = this.Storages.GetAll(id);
    
    if (!allData) return info;
    
    for (const key of Object.keys(allData)) {
      if (key.startsWith('dropdown-')) {
        const dropdownName = key.replace('dropdown-', '');
        const state = allData[key];
        const isOpen = state.dropped || false;
        
        info.total++;
        if (isOpen) info.open++;
        else info.closed++;
        
        info.dropdowns[dropdownName] = {
          open: isOpen,
          storageKey: key,
          dropped: state.dropped
        };
      }
    }
    
    return info;
  },

  /**
   * Close all dropdowns except specified ones
   * @param {string} id - User/build ID
   * @param {Array<string>} keepOpen - Array of dropdown names to keep open (without 'dropdown-' prefix)
   * @returns {number} Number of dropdowns closed
   */
  CloseAllExcept: (id, keepOpen = []) => {
    let closedCount = 0;
    const allData = this.Storages.GetAll(id);
    
    if (!allData) return 0;
    
    for (const key of Object.keys(allData)) {
      if (key.startsWith('dropdown-')) {
        const dropdownName = key.replace('dropdown-', '');
        if (!keepOpen.includes(dropdownName)) {
          const state = allData[key];
          if (state && state.dropped) {
            state.dropped = false;
            this.Storages.Set(id, key, state);
            closedCount++;
          }
        }
      }
    }
    
    return closedCount;
  },

  /**
   * Check if a dropdown exists
   * @param {string} id - User/build ID
   * @param {string} dropdownName - Name of the dropdown (without 'dropdown-' prefix)
   * @returns {boolean} Whether the dropdown exists
   */
  Exists: (id, dropdownName) => {
    const storageKey = `dropdown-${dropdownName}`;
    return this.Storages.Has(id, storageKey);
  },

  /**
   * Set multiple dropdowns to the same state at once
   * @param {string} id - User/build ID
   * @param {Array<string>} dropdownNames - Array of dropdown names (without 'dropdown-' prefix)
   * @param {boolean} open - Whether to open (true) or close (false) the dropdowns
   * @returns {number} Number of dropdowns changed
   */
  SetMany: (id, dropdownNames = [], open = false) => {
    let changedCount = 0;
    
    for (const dropdownName of dropdownNames) {
      const storageKey = `dropdown-${dropdownName}`;
      let state = this.Storages.Get(id, storageKey);
      
      if (!state) {
        state = { dropped: false };
        this.Storages.Set(id, storageKey, state);
      }
      
      if (state.dropped !== open) {
        state.dropped = open;
        this.Storages.Set(id, storageKey, state);
        changedCount++;
      }
    }
    
    return changedCount;
  }
};

    /**
     * Define a page in the UI.
     * Page‑enter hooks are executed only when the page actually changes, and
     * newly registered hooks inside the page code fire immediately on that real entry.
     * Same‑page button clicks never trigger the hooks.
     * @param {string} id - User/build ID
     * @param {string} name - Page name
     * @param {Function} code - Page code to execute
     * @param {Object} config - Page configuration
     * @param {string} [config.pagelabel] - Page label to display
     * @param {number} [config.jumpTo=1] - Jump to index
     * @param {boolean} [config.lock=false] - Whether page is locked
     * @param {string} [config.lockKey] - Lock key
     * @returns {Promise<void>}
     */
    this.Page = async (id, name = '', code = async () => { }, config = {
      pagelabel: undefined,
      jumpTo: 1,
      lock: false,
      lockKey: undefined,
      pinButton: undefined,
      pinPosition: undefined
    }) => {
      if (this.Builds.has(id)) {
        const userBuild = this.Builds.get(id);
        const currentProps = userBuild.Session.ActualProps || {};
        const currentPage = currentProps.page || '';
        // Use the persistent _previousPage stored directly on the session
        const previousPage = userBuild.Session._previousPage || '';

        // Handle page leave hooks for previous page
        if (previousPage && previousPage !== name && name === currentPage) {
          await this._executePageLeaveHooks(previousPage, { session: userBuild.Session, ...currentProps });
        }

        if (config.lock) {
          const lockKey = config.lockKey || `page-lock-${name}`;
          const isLocked = this.Storages.Get(id, lockKey);

          if (isLocked && !currentProps._unlock) {
            return;
          }

          if (!isLocked && name === currentPage) {
            this.Storages.Set(id, lockKey, true);
          }

          if (currentProps._unlock === lockKey) {
            this.Storages.Delete(id, lockKey);
            delete userBuild.Session.ActualProps._unlock;
          }
        }

        // ------------------------------------------------------------------
        // PAGE NAV BUTTON REGISTRATION
        // ------------------------------------------------------------------
        // When `pinButton` is true (either passed per-page or enabled
        // globally via SyAPP({ autoPinPages: true })), register this page
        // so the Build() pass can render ONE this.Buttons([...]) row with
        // all page nav buttons, marking the currently selected page.
        // `pinPosition` (default 'bottom') controls whether the whole
        // nav row lives in the pinned-bottom area or the pinned-top area.
        // ------------------------------------------------------------------
        const pinButton = config.pinButton !== undefined
          ? !!config.pinButton
          : !!(this._syappInstance && this._syappInstance.autoPinPages);
        const pinPosition = config.pinPosition === 'top' ? 'top' : 'bottom';

        if (pinButton && name) {
          if (!Array.isArray(userBuild.PageNav)) userBuild.PageNav = [];
          if (!userBuild.PageNav.some(p => p.name === name)) {
            userBuild.PageNav.push({
              name: name,
              label: config.pagelabel || name,
              pinPosition: pinPosition
            });
          }
        }

        const shouldExecute = (name === currentPage) || (name === '' && !currentPage);

        if (shouldExecute) {
          // Determine if this is a real page change
          const isNewPage = (name !== previousPage);

          // Execute pre‑registered page‑enter hooks ONLY on real navigation
          if (!currentProps._isRefresh && isNewPage) {
            await this._executePageEnterHooks(name, { session: userBuild.Session, ...currentProps });
          }

          // Update the persistent _previousPage on the session only when page changed
          if (name !== previousPage) {
            userBuild.Session._previousPage = name;
          }

          // Set a flag that guarantees immediate‑execution only for real entries
          if (!currentProps._isRefresh && isNewPage) {
            currentProps._isRealPageEnter = true;
          }

          // Set the execution context for dynamic hook registration
          const previousContext = this._lifecycleExecutionContext;
          if (!currentProps._isRefresh && isNewPage) {
            this._lifecycleExecutionContext = {
              type: 'pageEnter',
              pageName: name,
              props: { session: userBuild.Session, ...currentProps },
              sessionId: userBuild.Session.UniqueID
            };
          } else {
            // Ensure no stale context during refresh or same‑page render
            this._lifecycleExecutionContext = null;
          }

          try {
            if (config.pagelabel) {
              this.Text(id, `• ${config.pagelabel}`);
            }
            await code();
          } finally {
            // Clean up the real‑page flag and restore context
            delete currentProps._isRealPageEnter;
            this._lifecycleExecutionContext = previousContext;
          }
        }
      } else {
        if (this.Log) {
          console.log(`this.Page() Error - userBuild not found | BuildID: ${id} | Page: ${name}`);
        }
      }
    };

    /**
     * Lock a page
     * @param {string} id - User/build ID
     * @param {string} pageName - Page name
     * @param {string|null} [lockKey=null] - Lock key
     */
    this.LockPage = (id, pageName, lockKey = null) => {
      if (this.Builds.has(id)) {
        const key = lockKey || `page-lock-${pageName}`;
        this.Storages.Set(id, key, true);
      }
    };

    /**
     * Unlock a page
     * @param {string} id - User/build ID
     * @param {string} pageName - Page name
     * @param {string|null} [lockKey=null] - Lock key
     */
    this.UnlockPage = (id, pageName, lockKey = null) => {
      if (this.Builds.has(id)) {
        const key = lockKey || `page-lock-${pageName}`;
        this.Storages.Delete(id, key);
      }
    };

    /**
     * Check if a page is locked
     * @param {string} id - User/build ID
     * @param {string} pageName - Page name
     * @param {string|null} [lockKey=null] - Lock key
     * @returns {boolean} Whether page is locked
     */
    this.IsPageLocked = (id, pageName, lockKey = null) => {
      if (this.Builds.has(id)) {
        const key = lockKey || `page-lock-${pageName}`;
        return !!this.Storages.Get(id, key);
      }
      return false;
    };

    // --------------------------- Pinned Container Methods ---------------------------

    /**
     * Execute a block of UI-building code inside a "pinned top" context.
     *
     * Every child created inside the code block (Text, Button, Buttons,
     * SideButton, Field) is automatically marked as pinnedTop and is
     * therefore rendered in the fixed top area, above a single separator
     * line, regardless of how many scrollable items exist in the middle.
     *
     * This is the building-block equivalent of `this.Page`: instead of
     * following the selected page, it follows the pinned-top region, and
     * the code you supply becomes the body of that region.
     *
     * Nesting PinnedTop / PinnedBottom restores the previous context when
     * the inner block finishes, so combined layouts are safe. Children
     * may explicitly override the pin by setting `pinned: true` (bottom)
     * or `pinnedTop: false` on their own config object.
     *
     * @param {string} id - User/build ID
     * @param {Function} code - async () => { ... } builder body
     * @returns {Promise<void>}
     *
     * @example
     *   await this.PinnedTop(id, async () => {
     *     this.Text(id, '📌 Header');
     *     this.Button(id, { name: '☰ Menu', props: { open: 'menu' } });
     *   });
     */
    this.PinnedTop = async (id, code = async () => { }, config = {}) => {
      if (!this.Builds.has(id)) {
        if (this.Log) console.log(`this.PinnedTop() Error - userBuild not found | BuildID: ${id}`);
        return;
      }
      const build = this.Builds.get(id);
      const previousContext = build._pinContext;
      build._pinContext = 'top';
      if (config && config.separator !== undefined) {
        build.PinnedTopSeparator = config.separator;
      }
      try {
        if (typeof code === 'function') {
          await code();
        }
      } finally {
        build._pinContext = previousContext;
      }
    };

    /**
     * Execute a block of UI-building code inside a "pinned bottom" context.
     *
     * Every child created inside the code block (Text, Button, Buttons,
     * SideButton, Field) is automatically marked as pinned and is
     * therefore rendered in the fixed bottom area, below a single
     * separator line, regardless of how many scrollable items exist in
     * the middle.
     *
     * Mirrors `this.PinnedTop` and `this.Page`: the supplied async code
     * becomes the body of the pinned-bottom region, and nested PinnedTop
     * / PinnedBottom calls restore the previous context when they finish.
     *
     * Children may explicitly override the pin by setting `pinnedTop:
     * true` (top) or `pinned: false` on their own config object.
     *
     * @param {string} id - User/build ID
     * @param {Function} code - async () => { ... } builder body
     * @returns {Promise<void>}
     *
     * @example
     *   await this.PinnedBottom(id, async () => {
     *     this.Button(id, { name: '⌂ Home' });
     *     this.Button(id, { name: '↻ Refresh' });
     *   });
     */
    this.PinnedBottom = async (id, code = async () => { }, config = {}) => {
      if (!this.Builds.has(id)) {
        if (this.Log) console.log(`this.PinnedBottom() Error - userBuild not found | BuildID: ${id}`);
        return;
      }
      const build = this.Builds.get(id);
      const previousContext = build._pinContext;
      build._pinContext = 'bottom';
      if (config && config.separator !== undefined) {
        build.PinnedBottomSeparator = config.separator;
      }
      try {
        if (typeof code === 'function') {
          await code();
        }
      } finally {
        build._pinContext = previousContext;
      }
    };

    // --------------------------- Alert Methods (unchanged) ---------------------------

    /**
     * Set alert configuration
     * @param {Object} config - Alert configuration
     * @param {number} [config.defaultDuration=5000] - Default duration in ms
     * @param {number} [config.maxAlerts=100] - Maximum alerts per user
     * @param {boolean} [config.allowDuplicates=false] - Allow duplicate alert names
     */
    this.SetAlertConfig = (config = {}) => {
      this.AlertConfig = {
        defaultDuration: config.defaultDuration || 5000,
        maxAlerts: config.maxAlerts || 100,
        allowDuplicates: config.allowDuplicates || false
      }
    }

    /**
     * Add an alert text that persists through refreshes
     * @param {string} id - User/build ID
     * @param {string} text - Text to display
     * @param {Object} [config] - Alert configuration
     * @param {number} [config.duration] - Duration in ms (default from AlertConfig)
     * @param {string} [config.name] - Unique name for this alert (auto-generated if not provided)
     * @param {boolean} [config.allowDuplicate=false] - Allow duplicate alerts with same name
     * @returns {string} The alert name (for later removal)
     */
    this.Alert = (id, text, config = {}) => {
      if (!this.Builds.has(id)) {
        if (this.Log) {
          console.log(`this.Alert() Error - userBuild not found | BuildID: ${id}`);
        }
        return null;
      }

      const duration = config.duration || this.AlertConfig.defaultDuration;
      const allowDuplicate = config.allowDuplicate !== undefined ? config.allowDuplicate : this.AlertConfig.allowDuplicates;
      
      const alertName = config.name || `alert_${this._hashString(text)}`;

      if (!this.AlertStorage.has(id)) {
        this.AlertStorage.set(id, new Map());
      }

      const userAlerts = this.AlertStorage.get(id);
      const now = Date.now();
      
      for (const [name, alert] of userAlerts) {
        if (alert.expiry <= now) {
          userAlerts.delete(name);
        }
      }

      if (!allowDuplicate && userAlerts.has(alertName)) {
        const existingAlert = userAlerts.get(alertName);
        existingAlert.expiry = now + duration;
        existingAlert.data.text = text; // Update text if changed
        return alertName;
      }

      if (userAlerts.size >= this.AlertConfig.maxAlerts) {
        let oldestName = null;
        let oldestTime = Infinity;
        for (const [name, alert] of userAlerts) {
          if (alert.expiry < oldestTime) {
            oldestTime = alert.expiry;
            oldestName = name;
          }
        }
        if (oldestName) {
          userAlerts.delete(oldestName);
        }
      }

      const currentText = this.Builds.get(id).Text || '';
      const textLines = currentText.split('\n');
      
      userAlerts.set(alertName, {
        type: 'text',
        data: { text },
        expiry: now + duration,
        textLineIndex: textLines.length,
        position: {
          lineIndex: textLines.length,
          beforeTextLength: currentText.length
        },
        alertName
      });

      this.AlertStorage.set(id, userAlerts);
      this.Builds.get(id)._hasAlerts = true;
      
      return alertName;
    }

    /**
     * Add an alert button that persists through refreshes
     * @param {string} id - User/build ID
     * @param {string|Object} nameOrConfig - Button name or configuration object
     * @param {Object} [config] - Button configuration
     * @param {number} [config.duration] - Duration in ms (default from AlertConfig)
     * @param {string} [config.alertId] - Custom alert ID for management
     * @param {string} [config.name] - Button name
     * @param {string} [config.path] - Navigation path
     * @param {Object} [config.props] - Button props
     * @param {boolean} [config.resetSelection] - Reset selection
     * @param {number|boolean} [config.jumpTo] - Jump to index
     * @param {Function} [config.action] - Button action
     */
    this.AlertButton = (id, nameOrConfig, config = {}) => {
      if (!this.Builds.has(id)) {
        if (this.Log) {
          console.log(`this.AlertButton() Error - userBuild not found | BuildID: ${id}`);
        }
        return;
      }

      const duration = config.duration || this.AlertConfig.defaultDuration;
      const alertId = config.alertId || `alert-btn-${Date.now()}-${Math.random()}`;
      
      const buttonConfig = { ...config };
      delete buttonConfig.duration;
      delete buttonConfig.alertId;

      if (!this.AlertStorage.has(id)) {
        this.AlertStorage.set(id, []);
      }

      const alerts = this.AlertStorage.get(id);
      const now = Date.now();
      const activeAlerts = alerts.filter(alert => alert.expiry > now);
      
      if (activeAlerts.length >= this.AlertConfig.maxAlerts) {
        activeAlerts.shift();
      }

      const currentButtons = this.Builds.get(id).Buttons;
      
      const position = {
        buttonIndex: currentButtons.length,
        context: {
          dropdownColor: this.Builds.get(id).dropdown_color,
          dropdownSpacement: this.Builds.get(id).dropdown_spacement,
          dropdownHorizontal: this.Builds.get(id).dropdown_horizontal,
          droplevel: this.Builds.get(id).droplevel,
          lastDropdownButton: this.Builds.get(id).last_dropdown_button
        }
      };

      activeAlerts.push({
        type: 'button',
        data: {
          nameOrConfig,
          buttonConfig
        },
        expiry: now + duration,
        position,
        alertId
      });

      this.AlertStorage.set(id, activeAlerts);
      this.Button(id, nameOrConfig, buttonConfig);
    }

    /**
     * Simple string hashing for generating alert names
     * @private
     */
    this._hashString = (str) => {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      return Math.abs(hash).toString(36);
    }

    /**
     * Remove a specific alert by name
     * @param {string} id - User/build ID
     * @param {string} alertName - Alert name to remove
     */
    this.RemoveAlert = (id, alertName) => {
      if (!this.AlertStorage.has(id)) return;
      
      const userAlerts = this.AlertStorage.get(id);
      userAlerts.delete(alertName);
      
      if (userAlerts.size === 0) {
        this.AlertStorage.delete(id);
      }
    }

    /**
     * Clear all alerts for a user
     * @param {string} id - User/build ID
     */
    this.ClearAlerts = (id) => {
      this.AlertStorage.delete(id);
    }

    /**
     * Process and insert alerts at their correct positions
     * This is called after the build function executes
     * @param {string} id - User/build ID
     */
    this.ProcessAlerts = (id) => {
      if (!this.Builds.has(id) || !this.AlertStorage.has(id)) return;

      const now = Date.now();
      const userAlerts = this.AlertStorage.get(id);
      
      for (const [name, alert] of userAlerts) {
        if (alert.expiry <= now) {
          userAlerts.delete(name);
        }
      }

      if (userAlerts.size === 0) {
        this.AlertStorage.delete(id);
        return;
      }

      const currentText = this.Builds.get(id).Text || '';
      const currentLines = currentText.split('\n');
      
      const textAlerts = Array.from(userAlerts.values())
        .filter(a => a.type === 'text')
        .sort((a, b) => a.position.lineIndex - b.position.lineIndex);

      if (textAlerts.length === 0) return;

      const finalLines = [];
      let alertIndex = 0;
      let currentAlert = textAlerts[alertIndex];
      
      if (currentLines.length === 0 || (currentLines.length === 1 && currentLines[0] === '')) {
        textAlerts.forEach(alert => {
          finalLines.push(alert.data.text);
        });
      } else {
        for (let i = 0; i < currentLines.length; i++) {
          while (currentAlert && currentAlert.position.lineIndex <= i) {
            finalLines.push(currentAlert.data.text);
            alertIndex++;
            currentAlert = textAlerts[alertIndex];
          }
          
          const isAlertText = textAlerts.some(alert => alert.data.text === currentLines[i]);
          if (!isAlertText) {
            finalLines.push(currentLines[i]);
          }
        }
        
        while (currentAlert) {
          finalLines.push(currentAlert.data.text);
          alertIndex++;
          currentAlert = textAlerts[alertIndex];
        }
      }

      this.Builds.get(id).Text = finalLines.join('\n');
      
      textAlerts.forEach((alert, index) => {
        alert.position.lineIndex = finalLines.indexOf(alert.data.text);
      });
    }

    // --------------------------- File Browser (unchanged) ---------------------------

    /**
     * File browser with recursive dropdown navigation and pagination
     * @param {string} id - User/build ID
     * @param {Object} config - File browser configuration
     * @param {string} [config.name='fileBrowser'] - Unique name for this file browser instance
     * @param {string} [config.startPath] - Starting directory path (default: OS root)
     * @param {string} [config.displayName] - Custom display name for the browser button (default: 'Browse: {current folder}')
     * @param {boolean} [config.multiple=true] - Allow multiple file selection
     * @param {boolean} [config.showMessages=false] - Show status messages via Text/Alert
     * @param {number} [config.itemsPerPage=5] - Items per page in dropdown
     * @param {Function} [config.filter] - Filter function for files/dirs: (itemPath, isDir) => boolean
     * @param {Object} [config.icons] - Custom icons
     * @param {string} [config.icons.folder='📁'] - Folder icon
     * @param {string} [config.icons.file='📄'] - File icon
     * @param {string} [config.icons.selected='✅'] - Selected indicator
     * @param {string} [config.icons.openFolder='📂'] - Open folder icon
     * @param {string} [config.icons.back='⬆️'] - Back navigation icon
     * @param {string} [config.icons.error='❌'] - Error icon
     * @param {string} [config.icons.clear='🗑️'] - Clear selection icon
     * @returns {Array<string>} Array of selected file paths
     */
    this.File = async (id, config = {}) => {
      // Default configuration
      const defaultConfig = {
        name: 'fileBrowser',
        startPath: os.platform() === 'win32' ? process.cwd().split(path.sep)[0] + path.sep : '/',
        displayName: null, // null means auto-generate from current path
        multiple: true,
        showMessages: false,
        itemsPerPage: 5,
        filter: null,
        icons: {
          folder: '📁',
          file: '📄',
          selected: '✅',
          openFolder: '📂',
          back: '⬆️',
          error: '❌',
          clear: '🗑️'
        }
      };

      const finalConfig = { ...defaultConfig, ...config };
      finalConfig.icons = { ...defaultConfig.icons, ...(config.icons || {}) };

      const instanceName = finalConfig.name;
      const storageKey = `fileBrowser_${instanceName}`;
      
      if (!this.Storages.Has(id, storageKey)) {
        this.Storages.Set(id, storageKey, {
          instanceName: instanceName,
          displayName: finalConfig.displayName,
          selectedFiles: [],
          currentPath: finalConfig.startPath,
          currentPage: 0,
          totalPages: 1
        });
      }

      const storage = this.Storages.Get(id, storageKey);
      
      if (finalConfig.displayName !== undefined && storage.displayName !== finalConfig.displayName) {
        storage.displayName = finalConfig.displayName;
        this.Storages.Set(id, storageKey, storage);
      }
      
      const currentProps = this.Builds.get(id).Session.ActualProps || {};
      
      const navigateProp = `${storageKey}_navigate`;
      if (currentProps[navigateProp]) {
        storage.currentPath = currentProps[navigateProp];
        storage.currentPage = 0;
        this.Storages.Set(id, storageKey, storage);
        delete this.Builds.get(id).Session.ActualProps[navigateProp];
      }

      const selectProp = `${storageKey}_select`;
      if (currentProps[selectProp]) {
        const selectedPath = currentProps[selectProp];
        
        if (storage.selectedFiles.includes(selectedPath)) {
          storage.selectedFiles = storage.selectedFiles.filter(f => f !== selectedPath);
        } else {
          if (finalConfig.multiple) {
            storage.selectedFiles.push(selectedPath);
          } else {
            storage.selectedFiles = [selectedPath];
          }
        }
        
        this.Storages.Set(id, storageKey, storage);
        delete this.Builds.get(id).Session.ActualProps[selectProp];
      }

      const pageProp = `${storageKey}_page`;
      if (currentProps[pageProp] !== undefined) {
        const newPage = parseInt(currentProps[pageProp]);
        if (!isNaN(newPage) && newPage >= 0) {
          storage.currentPage = newPage;
        }
        this.Storages.Set(id, storageKey, storage);
        delete this.Builds.get(id).Session.ActualProps[pageProp];
      }

      const clearProp = `${storageKey}_clear`;
      if (currentProps[clearProp]) {
        storage.selectedFiles = [];
        storage.currentPage = 0;
        this.Storages.Set(id, storageKey, storage);
        delete this.Builds.get(id).Session.ActualProps[clearProp];
      }

      const currentPath = storage.currentPath;
      
      const getDisplayName = () => {
        if (storage.displayName) {
          return storage.displayName;
        } else {
          const folderName = path.basename(currentPath) || currentPath;
          return `Browse: ${folderName}`;
        }
      };
      
      const getOpenDisplayName = () => {
        if (storage.displayName) {
          return storage.displayName;
        } else {
          const folderName = path.basename(currentPath) || currentPath;
          return `${folderName}`;
        }
      };
      
      if (finalConfig.showMessages) {
        this.Text(id, `${finalConfig.icons.openFolder} ${currentPath}`);
        if (storage.selectedFiles.length > 0) {
          this.Text(id, `${finalConfig.icons.selected} ${storage.selectedFiles.length} file(s) selected`);
        }
      }

      try {
        const allItems = fs.readdirSync(currentPath, { withFileTypes: true });
        
        const items = [];
        
        const parentPath = path.dirname(currentPath);
        if (currentPath !== parentPath) {
          items.push({
            name: '..',
            path: parentPath,
            isDirectory: true,
            isParent: true
          });
        }
        
        for (const item of allItems) {
          const itemPath = path.join(currentPath, item.name);
          
          if (finalConfig.filter && !finalConfig.filter(itemPath, item.isDirectory())) {
            continue;
          }
          
          try {
            if (item.isDirectory()) {
              items.push({
                name: item.name,
                path: itemPath,
                isDirectory: true,
                isParent: false
              });
            } else if (item.isFile()) {
              items.push({
                name: item.name,
                path: itemPath,
                isDirectory: false,
                isParent: false
              });
            }
          } catch (error) {
            continue;
          }
        }
        
        const parentItems = items.filter(i => i.isParent);
        const directories = items.filter(i => i.isDirectory && !i.isParent).sort((a, b) => a.name.localeCompare(b.name));
        const files = items.filter(i => !i.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
        const sortedItems = [...parentItems, ...directories, ...files];
        
        const totalPages = Math.max(1, Math.ceil(sortedItems.length / finalConfig.itemsPerPage));
        storage.totalPages = totalPages;
        
        if (storage.currentPage >= totalPages) {
          storage.currentPage = 0;
        }
        if (storage.currentPage < 0) {
          storage.currentPage = totalPages - 1;
        }
        
        const currentPage = storage.currentPage;
        const startIdx = currentPage * finalConfig.itemsPerPage;
        const endIdx = Math.min(startIdx + finalConfig.itemsPerPage, sortedItems.length);
        const pageItems = sortedItems.slice(startIdx, endIdx);
        
        this.Storages.Set(id, storageKey, storage);
        
        const baseDisplayName = getDisplayName();
        
        let closedButtonText = `${finalConfig.icons.folder} ${baseDisplayName}`;
        
        if (storage.selectedFiles.length > 0) {
          closedButtonText += ` (${storage.selectedFiles.length} selected)`;
        }
        
        const openDisplayName = getOpenDisplayName();
        let openButtonText = `${finalConfig.icons.openFolder} Hide ${openDisplayName}`;
        if (totalPages > 1) {
          openButtonText += ` [Page ${currentPage + 1}/${totalPages}]`;
        }
        if (storage.selectedFiles.length > 0) {
          openButtonText += ` (${storage.selectedFiles.length} selected)`;
        }
        
        const dropdownName = `${storageKey}_browser`;
        
        await this.DropDown(id, dropdownName, async () => {
          for (const item of pageItems) {
            if (item.isDirectory) {
              const hasSelectedContent = storage.selectedFiles.some(f => f.startsWith(item.path + path.sep));
              
              let icon = item.isParent ? finalConfig.icons.back : 
                       (hasSelectedContent ? finalConfig.icons.selected : finalConfig.icons.folder);
              
              this.Button(id, {
                name: `${icon} ${item.name}${hasSelectedContent && !item.isParent ? ' (has selected)' : ''}`,
                path: this.Name,
                props: { 
                  [navigateProp]: item.path,
                  page: currentProps.page 
                }
              });
            } else {
              const isSelected = storage.selectedFiles.includes(item.path);
              const icon = isSelected ? finalConfig.icons.selected : finalConfig.icons.file;
              
              this.Button(id, {
                name: `${icon} ${item.name}`,
                path: this.Name,
                props: { 
                  [selectProp]: item.path,
                  page: currentProps.page 
                }
              });
            }
          }
          
          if (totalPages > 1 || storage.selectedFiles.length > 0) {
            this.Button(id, { name: ' ' });
            
            const controlButtons = [];
            
            if (totalPages > 1) {
              controlButtons.push({
                name: `◀ Prev`,
                path: this.Name,
                props: { 
                  [pageProp]: currentPage > 0 ? currentPage - 1 : totalPages - 1,
                  page: currentProps.page 
                }
              });
            }
            
            if (totalPages > 1) {
              controlButtons.push({
                name: `Next ▶`,
                path: this.Name,
                props: { 
                  [pageProp]: currentPage < totalPages - 1 ? currentPage + 1 : 0,
                  page: currentProps.page 
                }
              });
            }
            
            if (storage.selectedFiles.length > 0) {
              controlButtons.push({
                name: `${finalConfig.icons.clear} Clear (${storage.selectedFiles.length})`,
                path: this.Name,
                props: { 
                  [clearProp]: true,
                  page: currentProps.page 
                }
              });
            }
            
            if (controlButtons.length > 0) {
              this.Buttons(id, controlButtons);
            }
          }
          
          if (sortedItems.length === 0) {
            this.Button(id, {
              name: '(empty directory)',
              path: this.Name,
              props: {}
            });
          }
          
        }, {
          up_buttontext: closedButtonText,
          down_buttontext: openButtonText,
          down_emoji: '▼',
          up_emoji: '▶'
        });
        
        if (finalConfig.showMessages && storage.selectedFiles.length > 0) {
          this.Text(id, '');
          this.Text(id, '📋 Selected Files:');
          storage.selectedFiles.forEach((filePath, index) => {
            const relativePath = path.relative(finalConfig.startPath, filePath);
            this.Text(id, `  ${index + 1}. ${relativePath}`);
          });
        }
      } catch (error) {
        if (finalConfig.showMessages) {
          this.Alert(id, `Error reading directory: ${error.message}`, { duration: 3000 });
        }
        
        const baseDisplayName = getDisplayName();
        let errorClosedText = `${finalConfig.icons.error} Error: ${baseDisplayName}`;
        let errorOpenText = `${finalConfig.icons.error} Hide Error`;
        
        const dropdownName = `${storageKey}_browser`;
        await this.DropDown(id, dropdownName, async () => {
          this.Text(id, `${finalConfig.icons.error} Error reading directory:`);
          this.Text(id, error.message);
          
          const parentPath = path.dirname(currentPath);
          if (currentPath !== parentPath) {
            this.Button(id, {
              name: `${finalConfig.icons.back} Go back to parent`,
              path: this.Name,
              props: { 
                [navigateProp]: parentPath,
                page: currentProps.page 
              }
            });
          }
        }, {
          up_buttontext: errorClosedText,
          down_buttontext: errorOpenText,
          up_emoji: '▶'
        });
      }

      return storage.selectedFiles;
    };

    /**
     * File manager methods for managing file selections
     * @namespace
     */
    this.FileManager = {
      /**
       * Get selected files array
       * @param {string} id - User/build ID
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       * @returns {Array<string>} Array of selected file paths
       */
      GetSelected: (id, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        return storage?.selectedFiles || [];
      },

      /**
       * Clear all selected files
       * @param {string} id - User/build ID
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       */
      ClearSelection: (id, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        if (storage) {
          storage.selectedFiles = [];
          storage.currentPage = 0;
          this.Storages.Set(id, storageKey, storage);
        }
      },

      /**
       * Remove a specific file from selection
       * @param {string} id - User/build ID
       * @param {string} filePath - File path to remove from selection
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       */
      RemoveFile: (id, filePath, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        if (storage) {
          storage.selectedFiles = storage.selectedFiles.filter(f => f !== filePath);
        }
      },

      /**
       * Set a specific file as the only selected file (clears others)
       * @param {string} id - User/build ID
       * @param {string} filePath - File path to set as selected
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       */
      SetFile: (id, filePath, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        if (storage) {
          storage.selectedFiles = [filePath];
        }
      },

      /**
       * Add a file to selection without clearing others
       * @param {string} id - User/build ID
       * @param {string} filePath - File path to add to selection
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       */
      AddFile: (id, filePath, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        if (storage && !storage.selectedFiles.includes(filePath)) {
          storage.selectedFiles.push(filePath);
        }
      },

      /**
       * Check if a specific file is selected
       * @param {string} id - User/build ID
       * @param {string} filePath - File path to check
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       * @returns {boolean} Whether the file is selected
       */
      IsSelected: (id, filePath, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        return storage?.selectedFiles?.includes(filePath) || false;
      },

      /**
       * Get current browsing path
       * @param {string} id - User/build ID
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       * @returns {string} Current directory path being browsed
       */
      GetCurrentPath: (id, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        return storage?.currentPath || '';
      },

      /**
       * Get selection count
       * @param {string} id - User/build ID
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       * @returns {number} Number of selected files
       */
      GetCount: (id, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        return storage?.selectedFiles?.length || 0;
      },

      /**
       * Get current page number (0-based)
       * @param {string} id - User/build ID
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       * @returns {number} Current page number
       */
      GetCurrentPage: (id, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        return storage?.currentPage || 0;
      },

      /**
       * Reset file browser to initial state (clears everything)
       * @param {string} id - User/build ID
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       */
      Reset: (id, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        this.Storages.Delete(id, storageKey);
      },

      /**
       * Get selected files with relative paths
       * @param {string} id - User/build ID
       * @param {string} [basePath] - Base path for relative paths (default: startPath from storage)
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       * @returns {Array<string>} Array of relative file paths
       */
      GetSelectedRelative: (id, basePath = null, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        if (!storage || storage.selectedFiles.length === 0) return [];
        
        const base = basePath || storage.startPath || '/';
        return storage.selectedFiles.map(filePath => path.relative(base, filePath));
      },

      /**
       * Update the display name of a file browser instance
       * @param {string} id - User/build ID
       * @param {string} displayName - New display name
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       */
      SetDisplayName: (id, displayName, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        if (storage) {
          storage.displayName = displayName;
          this.Storages.Set(id, storageKey, storage);
        }
      },

      /**
       * Get the display name of a file browser instance
       * @param {string} id - User/build ID
       * @param {string} [instanceName='fileBrowser'] - Instance name used in this.File()
       * @returns {string} Current display name
       */
      GetDisplayName: (id, instanceName = 'fileBrowser') => {
        const storageKey = `fileBrowser_${instanceName}`;
        const storage = this.Storages.Get(id, storageKey);
        return storage?.displayName || `Browse: ${path.basename(storage?.currentPath || '')}`;
      }
    };


/**
 * JSON Browser – Load a JSON file and navigate its structure with pagination.
 * Features: Hierarchical navigation, pagination, text abbreviation, and fast search.
 * @param {string} id - User/build ID
 * @param {Object} config - Configuration options
 * @param {Object} [config.fileConfig] - Custom options for the file picker (see this.File)
 * @param {number} [config.itemsPerPage=5] - Number of items per page for arrays/objects
 * @param {string} [config.name='default'] - Unique name for this browser instance
 * @param {string} [config.startPath] - Starting directory for the file picker
 * @param {number} [config.maxTextLength=40] - Maximum characters before abbreviation
 * @param {Object} [config.searchConfig] - Search configuration
 * @param {string} [config.searchConfig.mode='both'] - Search mode: 'key', 'value', or 'both'
 * @param {number} [config.searchConfig.keyWeight=0.7] - Weight for key matches (0-1)
 * @param {number} [config.searchConfig.valueWeight=0.3] - Weight for value matches (0-1)
 * @param {number} [config.searchConfig.minSimilarity=0.3] - Minimum similarity threshold
 * @returns {Promise<void>}
 */
this.JSON = async (id, config = {}) => {
  // Capture 'this' context for use in callbacks
  const self = this;

  // Helper to parse JSON or JSONL file content
  const parseJsonOrJsonl = (filePath, content) => {
    if (filePath.toLowerCase().endsWith('.jsonl')) {
      const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
      return lines.map(line => JSON.parse(line));
    }
    return JSON.parse(content);
  };

  // ------------------------------------------------------------------
  // Setup storage & instance name
  // ------------------------------------------------------------------
  const instanceName = config.name || 'default';
  const storageKey = `jsonBrowser_${instanceName}`;
  const filePickerName = `${storageKey}_filepicker`;
  const searchFieldName = `${storageKey}_search`;
  const searchChangeProp = `${storageKey}_searchChange`;
  const searchIndexKey = `${storageKey}_searchIndex`;
  const searchModeKey = `${storageKey}_searchMode`;
  const searchKeyWeightKey = `${storageKey}_keyWeight`;
  const searchValueWeightKey = `${storageKey}_valueWeight`;
  const searchMinSimilarityKey = `${storageKey}_minSimilarity`;
  const configPanelOpenKey = `${storageKey}_configPanelOpen`;
  const lastSearchQueryKey = `${storageKey}_lastSearchQuery`;
  const saveOnlyKey = `${storageKey}_saveOnly`;
  const tokenSearchKey = `${storageKey}_tokenSearch`;
  const debugKey = `${storageKey}_debug`;

  // NEW (array-of-objects support):
  //   searchKeyKey   → which specific key searches are restricted to
  //   showKeysKey    → list of keys to display in array item previews
  //                    AND in search-result previews (display only —
  //                    never affects saved output)
  //   valueViewKey   → { key: string, filter: string|null } | null
  const searchKeyKey = `${storageKey}_searchKey`;
  const showKeysKey = `${storageKey}_showKeys`;
  const valueViewKey = `${storageKey}_valueView`;

  // Search configuration with defaults
  let searchConfig = {
    mode: config.searchConfig?.mode || 'both',
    keyWeight: config.searchConfig?.keyWeight || 0.7,
    valueWeight: config.searchConfig?.valueWeight || 0.3,
    minSimilarity: config.searchConfig?.minSimilarity || 0.3,
    // NEW: when set, searches only match entries whose last path segment
    // equals this key name (case-insensitive). null = search everywhere.
    searchKey: config.searchConfig?.searchKey || null
  };

  // Load saved search config from storage if exists
  const savedMode = this.Storages.Get(id, searchModeKey);
  const savedKeyWeight = this.Storages.Get(id, searchKeyWeightKey);
  const savedValueWeight = this.Storages.Get(id, searchValueWeightKey);
  const savedMinSimilarity = this.Storages.Get(id, searchMinSimilarityKey);
  const savedSearchKey = this.Storages.Get(id, searchKeyKey);

  if (savedMode) searchConfig.mode = savedMode;
  if (savedKeyWeight !== undefined && savedKeyWeight !== null) searchConfig.keyWeight = savedKeyWeight;
  if (savedValueWeight !== undefined && savedValueWeight !== null) searchConfig.valueWeight = savedValueWeight;
  if (savedMinSimilarity !== undefined && savedMinSimilarity !== null) searchConfig.minSimilarity = savedMinSimilarity;
  if (savedSearchKey !== undefined && savedSearchKey !== null) searchConfig.searchKey = savedSearchKey || null;

  // Load save-only toggle state
  let saveOnly = this.Storages.Get(id, saveOnlyKey) || false;
  // Load token search and debug toggles
  let tokenSearch = this.Storages.Get(id, tokenSearchKey) || false;
  let debugOutput = this.Storages.Get(id, debugKey) || false;

  if (!this.Storages.Has(id, storageKey)) {
    this.Storages.Set(id, storageKey, {
      data: null,
      path: [],
      searchResults: null,
      searchPath: [],
      filePath: null,
      searchQuery: '',
      // NEW: { key, filter } | null — value-view drilldown state.
      valueView: null
    });
  }

  const storage = this.Storages.Get(id, storageKey);
  const currentProps = this.Builds.get(id).Session.ActualProps || {};

  // ------------------------------------------------------------------
  // Handle navigation props
  // ------------------------------------------------------------------
  const backProp = `${storageKey}_back`;
  const navProp = `${storageKey}_navigate`;
  const loadNewProp = `${storageKey}_loadNew`;
  const clearSearchProp = `${storageKey}_clearSearch`;
  const toggleSearchModeProp = `${storageKey}_toggleSearchMode`;
  const setSearchModeProp = `${storageKey}_setSearchMode`;
  const toggleConfigPanelProp = `${storageKey}_toggleConfigPanel`;
  const updateKeyWeightProp = `${storageKey}_updateKeyWeight`;
  const updateValueWeightProp = `${storageKey}_updateValueWeight`;
  const updateMinSimilarityProp = `${storageKey}_updateMinSimilarity`;
  const toggleSaveOnlyProp = `${storageKey}_toggleSaveOnly`;
  const toggleTokenSearchProp = `${storageKey}_toggleTokenSearch`;
  const toggleDebugProp = `${storageKey}_toggleDebug`;
  const recentLoadProp = `${storageKey}_loadRecent`;
  const returnProp = `${storageKey}_return`;
  const updateRecentTimeWindowProp = `${storageKey}_updateRecentTimeWindow`;

  // NEW: array-of-objects support props.
  //   setSearchKeyProp    → restrict search to one specific model key
  //   clearSearchKeyProp  → remove the search-key restriction
  //   toggleShowKeyProp   → toggle a key in/out of the preview filter
  //   clearShowKeysProp   → wipe the preview filter
  //   openValueViewProp   → open the value view for a specific key
  //   setValueFilterProp  → apply/replace the value filter inside value view
  //   clearValueFilterProp→ clear the value filter (keep value view open)
  //   closeValueViewProp  → return to the regular array view
  const setSearchKeyProp = `${storageKey}_setSearchKey`;
  const clearSearchKeyProp = `${storageKey}_clearSearchKey`;
  const toggleShowKeyProp = `${storageKey}_toggleShowKey`;
  const clearShowKeysProp = `${storageKey}_clearShowKeys`;
  const openValueViewProp = `${storageKey}_openValueView`;
  const setValueFilterProp = `${storageKey}_setValueFilter`;
  const clearValueFilterProp = `${storageKey}_clearValueFilter`;
  const closeValueViewProp = `${storageKey}_closeValueView`;
  const openSearchResultProp = `${storageKey}_openSearchResult`;

  if (currentProps[backProp]) {
    if (storage.searchResults) {
      storage.searchPath.pop();
      if (storage.searchPath.length === 0) {
        storage.searchPath = [];
      }
    } else {
      storage.path.pop();
    }
    delete currentProps[backProp];
  }

  if (currentProps[navProp] !== undefined) {
    if (storage.searchResults) {
      storage.searchPath.push(currentProps[navProp]);
    } else {
      storage.path.push(currentProps[navProp]);
    }
    delete currentProps[navProp];
  }

  if (currentProps[loadNewProp]) {
    storage.data = null;
    storage.path = [];
    storage.searchResults = null;
    storage.searchPath = [];
    storage.filePath = null;
    storage.searchQuery = '';
    storage.historyStack = [];
    this.FileManager.ClearSelection(id, filePickerName);
    this.Storages.Delete(id, searchFieldName);
    this.Storages.Delete(id, searchIndexKey);
    this.Storages.Set(id, lastSearchQueryKey, '');
    delete currentProps[loadNewProp];
  }

  if (currentProps[clearSearchProp]) {
    storage.searchResults = null;
    storage.searchPath = [];
    storage.searchQuery = '';
    this.Storages.Delete(id, searchFieldName);
    this.Storages.Set(id, lastSearchQueryKey, '');
    delete currentProps[clearSearchProp];
  }

  if (currentProps[recentLoadProp]) {
    const newPath = currentProps[recentLoadProp];
    delete currentProps[recentLoadProp];
    if (storage.data !== null && storage.filePath) {
      if (!storage.historyStack) storage.historyStack = [];
      storage.historyStack.push(storage.filePath);
    }
    try {
      const data = await _syappLoadJsonFile(newPath);
      storage.data = data;
      storage.filePath = newPath;
      storage.path = [];
      storage.searchResults = null;
      storage.searchPath = [];
      storage.searchQuery = '';
      this.Storages.Delete(id, searchFieldName);
      this.Storages.Delete(id, `field_${searchFieldName}`);
      this.Storages.Set(id, lastSearchQueryKey, '');
      const searchIndex = buildSearchIndex(data);
      this.Storages.Set(id, searchIndexKey, searchIndex);
      this.Storages.Set(id, storageKey, storage);
      this.Alert(id, `✅ Loaded: ${path.basename(newPath)} (${searchIndex.length} searchable items)`, { duration: 2000 });
    } catch (err) {
      this.Alert(id, `❌ Error loading JSON: ${err.message}`, { duration: 5000 });
    }
  }

  if (currentProps[returnProp]) {
    delete currentProps[returnProp];
    if (storage.historyStack && storage.historyStack.length > 0) {
      const entry = storage.historyStack.pop();
      const prevPath = (entry && typeof entry === 'object') ? entry.path : entry;
      try {
        let data, searchIndex;
        if (entry && typeof entry === 'object' && entry.data !== undefined) {
          // Cached data available — return instantly. This is what
          // avoids a second full reload of a huge JSON file.
          data = entry.data;
          searchIndex = entry.searchIndex || buildSearchIndex(data);
        } else {
          data = await _syappLoadJsonFile(prevPath);
          searchIndex = buildSearchIndex(data);
        }
        storage.data = data;
        storage.filePath = prevPath;
        storage.path = [];
        storage.searchResults = null;
        storage.searchPath = [];
        storage.searchQuery = '';
        this.Storages.Delete(id, searchFieldName);
        this.Storages.Delete(id, `field_${searchFieldName}`);
        this.Storages.Set(id, lastSearchQueryKey, '');
        this.Storages.Set(id, searchIndexKey, searchIndex);
        this.Storages.Set(id, storageKey, storage);
        this.Alert(id, `↩️ Returned to: ${path.basename(prevPath)}`, { duration: 2000 });
      } catch (err) {
        this.Alert(id, `❌ Error returning: ${err.message}`, { duration: 5000 });
      }
    } else {
      this.Alert(id, 'No previous JSON to return to', { duration: 2000 });
    }
  }

  if (currentProps[updateRecentTimeWindowProp] !== undefined && currentProps[updateRecentTimeWindowProp] !== null) {
    const newWindow = parseFloat(currentProps[updateRecentTimeWindowProp]);
    if (!isNaN(newWindow) && newWindow > 0) {
      this.Storages.Set(id, `${storageKey}_recentTimeWindow`, newWindow);
    }
    delete currentProps[updateRecentTimeWindowProp];
  }

  // Handle direct search mode selection
  if (currentProps[setSearchModeProp]) {
    const newMode = currentProps[setSearchModeProp];
    if (newMode === 'key' || newMode === 'value' || newMode === 'both') {
      searchConfig.mode = newMode;
      this.Storages.Set(id, searchModeKey, searchConfig.mode);
      // Force pagination reset since results will change
      this.Storages.Set(id, lastSearchQueryKey, '');
    }
    delete currentProps[setSearchModeProp];
  }

  // Handle search mode toggle (cycle)
  // Handle search mode toggle (cycle)
  if (currentProps[toggleSearchModeProp]) {
    const modes = ['key', 'value', 'both'];
    const currentModeIndex = modes.indexOf(searchConfig.mode);
    searchConfig.mode = modes[(currentModeIndex + 1) % modes.length];
    this.Storages.Set(id, searchModeKey, searchConfig.mode);
    // Force pagination reset since results will change
    this.Storages.Set(id, lastSearchQueryKey, '');
    delete currentProps[toggleSearchModeProp];
  }

  // Handle config panel toggle
  if (currentProps[toggleConfigPanelProp]) {
    const currentState = this.Storages.Get(id, configPanelOpenKey) || false;
    this.Storages.Set(id, configPanelOpenKey, !currentState);
    delete currentProps[toggleConfigPanelProp];
  }

  // Handle weight updates
  if (currentProps[updateKeyWeightProp] !== undefined && currentProps[updateKeyWeightProp] !== null) {
    const newWeight = parseFloat(currentProps[updateKeyWeightProp]);
    if (!isNaN(newWeight) && newWeight >= 0 && newWeight <= 1) {
      searchConfig.keyWeight = newWeight;
      searchConfig.valueWeight = Math.round((1 - newWeight) * 100) / 100;
      this.Storages.Set(id, searchKeyWeightKey, searchConfig.keyWeight);
      this.Storages.Set(id, searchValueWeightKey, searchConfig.valueWeight);
      // Force pagination reset since results will change
      this.Storages.Set(id, lastSearchQueryKey, '');
    }
    delete currentProps[updateKeyWeightProp];
  }

  if (currentProps[updateValueWeightProp] !== undefined && currentProps[updateValueWeightProp] !== null) {
    const newWeight = parseFloat(currentProps[updateValueWeightProp]);
    if (!isNaN(newWeight) && newWeight >= 0 && newWeight <= 1) {
      searchConfig.valueWeight = newWeight;
      searchConfig.keyWeight = Math.round((1 - newWeight) * 100) / 100;
      this.Storages.Set(id, searchValueWeightKey, searchConfig.valueWeight);
      this.Storages.Set(id, searchKeyWeightKey, searchConfig.keyWeight);
      // Force pagination reset since results will change
      this.Storages.Set(id, lastSearchQueryKey, '');
    }
    delete currentProps[updateValueWeightProp];
  }

  if (currentProps[updateMinSimilarityProp] !== undefined && currentProps[updateMinSimilarityProp] !== null) {
    const newMin = parseFloat(currentProps[updateMinSimilarityProp]);
    if (!isNaN(newMin) && newMin >= 0 && newMin <= 1) {
      searchConfig.minSimilarity = newMin;
      this.Storages.Set(id, searchMinSimilarityKey, searchConfig.minSimilarity);
      // Force pagination reset since results will change
      this.Storages.Set(id, lastSearchQueryKey, '');
    }
    delete currentProps[updateMinSimilarityProp];
  }

  // Handle save-only toggle
  if (currentProps[toggleSaveOnlyProp]) {
    saveOnly = !saveOnly;
    this.Storages.Set(id, saveOnlyKey, saveOnly);
    delete currentProps[toggleSaveOnlyProp];
  }

  // Handle token search toggle
  if (currentProps[toggleTokenSearchProp]) {
    tokenSearch = !tokenSearch;
    this.Storages.Set(id, tokenSearchKey, tokenSearch);
    // Reset search results when toggling search engine
    this.Pagination.Reset(id, `${storageKey}_searchResults`);
    this.Pagination.Reset(id, `${storageKey}_searchNav`);
    this.Storages.Set(id, lastSearchQueryKey, '');
    delete currentProps[toggleTokenSearchProp];
  }

  // Handle debug toggle
  if (currentProps[toggleDebugProp]) {
    debugOutput = !debugOutput;
    this.Storages.Set(id, debugKey, debugOutput);
    delete currentProps[toggleDebugProp];
  }

  // ------------------------------------------------------------------
  // NEW: array-of-objects support prop handlers
  // ------------------------------------------------------------------

  // Restrict searches to one specific key of the detected model.
  if (currentProps[setSearchKeyProp] !== undefined) {
    const k = currentProps[setSearchKeyProp];
    searchConfig.searchKey = k || null;
    this.Storages.Set(id, searchKeyKey, searchConfig.searchKey);
    // Any change to the search key invalidates previous results.
    this.Storages.Set(id, lastSearchQueryKey, '');
    this.Pagination.Reset(id, `${storageKey}_searchResults`);
    this.Pagination.Reset(id, `${storageKey}_searchNav`);
    delete currentProps[setSearchKeyProp];
  }

  if (currentProps[clearSearchKeyProp]) {
    searchConfig.searchKey = null;
    this.Storages.Set(id, searchKeyKey, null);
    this.Storages.Set(id, lastSearchQueryKey, '');
    this.Pagination.Reset(id, `${storageKey}_searchResults`);
    this.Pagination.Reset(id, `${storageKey}_searchNav`);
    delete currentProps[clearSearchKeyProp];
  }

  // Toggle one key in/out of the preview "show only these keys" filter.
  // DISPLAY-ONLY: never affects the data written by save-only mode.
  if (currentProps[toggleShowKeyProp] !== undefined) {
    const k = currentProps[toggleShowKeyProp];
    let showKeysState = this.Storages.Get(id, showKeysKey);
    if (!Array.isArray(showKeysState)) showKeysState = [];
    const idx = showKeysState.indexOf(k);
    if (idx >= 0) showKeysState.splice(idx, 1);
    else showKeysState.push(k);
    this.Storages.Set(id, showKeysKey, showKeysState);
    delete currentProps[toggleShowKeyProp];
  }

  if (currentProps[clearShowKeysProp]) {
    this.Storages.Set(id, showKeysKey, []);
    delete currentProps[clearShowKeysProp];
  }

  // Open the value view for a specific key. Only triggered when the
  // user explicitly clicks a "📊 key" button — never automatically.
  if (currentProps[openValueViewProp] !== undefined) {
    const k = currentProps[openValueViewProp];
    if (k) {
      storage.valueView = { key: k, filter: null };
      this.Storages.Set(id, storageKey, storage);
    }
    delete currentProps[openValueViewProp];
  }

  // Apply a specific value filter inside the value view. Passing an
  // empty string clears the filter (toggle-off behaviour).
  if (currentProps[setValueFilterProp] !== undefined) {
    const v = currentProps[setValueFilterProp];
    if (!storage.valueView) storage.valueView = { key: null, filter: null };
    storage.valueView.filter = (v === '' || v === null || v === undefined) ? null : v;
    this.Storages.Set(id, storageKey, storage);
    delete currentProps[setValueFilterProp];
  }

  if (currentProps[clearValueFilterProp]) {
    if (storage.valueView) {
      storage.valueView.filter = null;
      this.Storages.Set(id, storageKey, storage);
    }
    delete currentProps[clearValueFilterProp];
  }

  if (currentProps[closeValueViewProp]) {
    storage.valueView = null;
    this.Storages.Set(id, storageKey, storage);
    delete currentProps[closeValueViewProp];
  }

  // Clicking a search result now enters the underlying FULL object
  // (`_fullObject`) rather than the raw result metadata. A marker
  // object is pushed as the FIRST searchPath segment so the walk logic
  // can unwrap it; deeper navigation (keys, array indices) keeps
  // pushing regular segments on top.
  if (currentProps[openSearchResultProp] !== undefined) {
    const idx = currentProps[openSearchResultProp];
    if (storage.searchResults && storage.searchResults[idx] !== undefined) {
      storage.searchPath = [{ __searchResult: idx }];
    }
    delete currentProps[openSearchResultProp];
  }

  // ------------------------------------------------------------------
  // NEW: detect the model of the tree node the user is currently on.
  //
  // Computed from storage.path (the tree walk), NOT from the search
  // results — the model needs to reflect the underlying array even
  // while a search is active. This drives the config-panel key selectors
  // AND the array view's "📊 key" value-view launchers.
  //
  // Cheap when the current node isn't an array (returns null at once).
  // ------------------------------------------------------------------
  let previewNode = storage.data;
  for (const seg of storage.path) {
    if (previewNode === null || previewNode === undefined) break;
    previewNode = typeof seg === 'number' ? previewNode[seg] : previewNode?.[seg];
  }
  const detectedModel = Array.isArray(previewNode)
    ? detectArrayModel(previewNode)
    : null;

  // Resolve the effective "show keys" list. Kept as the raw stored value
  // so that navigating away and back preserves the user's selection.
  // Used ONLY for the display layer — never for save-only output.
  let showKeys = this.Storages.Get(id, showKeysKey);
  if (!Array.isArray(showKeys)) showKeys = [];
  // ------------------------------------------------------------------
  // CRITICAL: Check for search change from field storage
  // ------------------------------------------------------------------
  const currentFieldValue = this.Storages.Get(id, searchFieldName) || '';
  
  if (currentProps[searchChangeProp] !== undefined && currentProps[searchChangeProp] !== null) {
    const newSearchValue = currentProps[searchChangeProp] || '';
    this.Storages.Set(id, searchFieldName, newSearchValue);
    storage.searchQuery = newSearchValue;
    delete currentProps[searchChangeProp];
  } else if (currentFieldValue !== storage.searchQuery) {
    storage.searchQuery = currentFieldValue;
  }

    // NOW process the search with the current query and configured weights
    const lastSearchQuery = this.Storages.Get(id, lastSearchQueryKey) || '';
    const searchQueryChanged = lastSearchQuery !== storage.searchQuery;
  
    if (storage.searchQuery && storage.searchQuery.trim()) {
      // Perform search with selected engine
      let searchIndex = this.Storages.Get(id, searchIndexKey);
      // NEW: when a specific search key is set (via the config panel),
      // restrict the index to entries whose last path segment matches it.
      // This is what enables "search one specific key across all items".
      if (searchConfig.searchKey) {
        searchIndex = filterSearchIndexByKey(searchIndex, searchConfig.searchKey);
      }
      if (tokenSearch) {
        storage.searchResults = tokenSearchJSON(
          storage.data, 
          storage.searchQuery.trim(),
          searchIndex
        );
      } else {
        storage.searchResults = weightedSearchJSON(
          storage.data, 
          storage.searchQuery.trim(),
          searchIndex,
          searchConfig
        );
      }
      // NEW: attach the FULL enclosing object to every result, so that
      // save-only mode writes the complete object (all keys), and the
      // UI can show whatever it wants without losing data.
      storage.searchResults = enrichSearchResultsWithFullObjects(
        storage.searchResults,
        storage.data
      );
      
      // Only reset navigation and pagination when the search query
      // actually changed. Preserving searchPath across refreshes is
      // what lets the user stay inside a search result's object while
      // the HUD auto-refreshes.
      if (searchQueryChanged) {
        storage.searchPath = [];
        this.Pagination.Reset(id, `${storageKey}_searchResults`);
        this.Pagination.Reset(id, `${storageKey}_searchNav`);
        this.Storages.Set(id, lastSearchQueryKey, storage.searchQuery);
      }
    } else {
      storage.searchResults = null;
      storage.searchPath = [];
      
      // Only reset pagination if we had a search before
      if (searchQueryChanged) {
        this.Pagination.Reset(id, `${storageKey}_searchResults`);
        this.Pagination.Reset(id, `${storageKey}_searchNav`);
        this.Storages.Set(id, lastSearchQueryKey, storage.searchQuery);
      }
    } 

  this.Storages.Set(id, storageKey, storage);

  // ------------------------------------------------------------------
  // Load JSON data if not already loaded
  // ------------------------------------------------------------------
  if (storage.data === null) {
    const selected = this.FileManager.GetSelected(id, filePickerName);
    if (selected.length > 0) {
      const filePath = selected[0];
      try {
        const data = await _syappLoadJsonFile(filePath);
        storage.data = data;
        storage.filePath = filePath;
        storage.path = [];
        storage.searchResults = null;
        storage.searchPath = [];
        storage.searchQuery = '';
        storage.historyStack = [];
        this.Storages.Delete(id, searchFieldName);
        this.Storages.Delete(id, `field_${searchFieldName}`);
        this.Storages.Set(id, lastSearchQueryKey, '');

        const searchIndex = buildSearchIndex(data);
        this.Storages.Set(id, searchIndexKey, searchIndex);

        this.Storages.Set(id, storageKey, storage);
        this.Alert(id, `✅ Loaded: ${path.basename(filePath)} (${searchIndex.length} searchable items)`, { duration: 2000 });
      } catch (err) {
        this.Alert(id, `❌ Error loading JSON: ${err.message}`, { duration: 5000 });
        this.FileManager.ClearSelection(id, filePickerName);
      }
    } else {
      const fileConfig = config.fileConfig || {
        name: filePickerName,
        multiple: false,
        filter: (itemPath, isDir) => {
          if (isDir) return true;
          const lower = itemPath.toLowerCase();
          return lower.endsWith('.json') || lower.endsWith('.jsonl');
        },
        startPath: config.startPath || process.cwd(),
        displayName: '📁 Select JSON file'
      };

      await this.File(id, fileConfig);
      this.Text(id, '👆 Use the file browser above to choose a JSON file.');
      return;
    }
  }

  // ------------------------------------------------------------------
  // SAVE-ONLY MODE: If enabled and search query exists, save results to file and clear search
  // ------------------------------------------------------------------
  if (saveOnly && storage.searchQuery && storage.searchQuery.trim()) {
    try {
      // Ensure we have a file path
      if (storage.filePath) {
        const originalDir = path.dirname(storage.filePath);
        const originalBase = path.basename(storage.filePath, '.json');
        const timestamp = Date.now();
        const outputFileName = `${originalBase}_search_${timestamp}.json`;
        const outputPath = path.join(originalDir, outputFileName);

        // ------------------------------------------------------------------
        // NEW: build the OUTPUT payload from the FULL objects attached to
        // each search result. The show-keys filter is a DISPLAY-ONLY
        // concern, so every saved entry must contain the ENTIRE original
        // object (all keys) — never a slimmed copy.
        //
        //   • For object matches (e.g. "users[3].email"): the parent
        //     object ("users[3]") is written — every key preserved.
        //   • For array matches (e.g. "users[3].tags"): the array itself
        //     is written — every element preserved.
        //   • For flat matches on a whole array of objects (path "root"
        //     or "users"), the whole array is written.
        //
        // Fallback: when `_fullObject` is not present (defensive), the
        // result's own `value` is used so nothing is silently lost.
        // ------------------------------------------------------------------
        const savedPayload = (storage.searchResults || []).map(r => {
          if (!r || typeof r !== 'object') return r;
          const full = (r._fullObject !== undefined) ? r._fullObject : r.value;
          return full;
        });

        // Write search results to file — FULL objects, every key intact.
        fs.writeFileSync(outputPath, JSON.stringify(savedPayload, null, 2), 'utf8');

        // Clear search state completely
        storage.searchResults = null;
        storage.searchPath = [];
        storage.searchQuery = '';
        this.Storages.Delete(id, searchFieldName);
        this.Storages.Set(id, lastSearchQueryKey, '');
        this.Pagination.Reset(id, `${storageKey}_searchResults`);
        this.Pagination.Reset(id, `${storageKey}_searchNav`);
        this.Storages.Set(id, storageKey, storage);

        // Alert user
        this.Alert(id, `💾 Saved ${savedPayload.length} full object(s) to: ${path.basename(outputPath)}`, { duration: 4000 });
      } else {
        // No file loaded, should not happen
        this.Alert(id, '❌ Cannot save search: no JSON file loaded', { duration: 3000 });
      }
    } catch (err) {
      this.Alert(id, `❌ Error saving search results: ${err.message}`, { duration: 5000 });
    }
  }

  // ------------------------------------------------------------------
  // Render search field and controls
  // ------------------------------------------------------------------
  const searchValue = this.Storages.Get(id, searchFieldName) || '';

  this.Field(id, searchFieldName, {
    label: '🔍 Search',
    initialValue: searchValue,
    maxWidth: config.maxTextLength || 40,
    onChange: (value) => {
      self.Storages.Set(id, searchFieldName, value);
      // Clear last search query to force pagination reset on next build
      self.Storages.Set(id, lastSearchQueryKey, '');
      
      const build = self.Builds.get(id);
      if (build && build.Session) {
        if (!build.Session.ActualProps) {
          build.Session.ActualProps = {};
        }
        build.Session.ActualProps[searchChangeProp] = value;
      }
    }
  });
  // Token search toggle
  this.Button(id, {
    name: tokenSearch ? '🔤 Token Search: ON' : '🔤 Token Search: OFF',
    props: { [toggleTokenSearchProp]: true }
  });

  // Debug output toggle
  this.Button(id, {
    name: debugOutput ? '🐞 Debug Output: ON' : '🐞 Debug Output: OFF',
    props: { [toggleDebugProp]: true }
  });

  // Mode toggle button
  const modeEmoji = {
    'key': '🔑',
    'value': '📝',
    'both': '🔀'
  };
  const modeLabel = {
    'key': 'Keys Only',
    'value': 'Values Only',
    'both': 'Keys + Values'
  };

  this.Button(id, {
    name: `${modeEmoji[searchConfig.mode]} Mode: ${modeLabel[searchConfig.mode]}`,
    props: { [toggleSearchModeProp]: true }
  });

  // Config panel toggle button
  const configPanelOpen = this.Storages.Get(id, configPanelOpenKey) || false;
  this.Button(id, {
    name: configPanelOpen ? '⚙️ Hide Search Config' : '⚙️ Search Config',
    props: { [toggleConfigPanelProp]: true }
  });

  // ------------------------------------------------------------------
  // Render search configuration panel (if open)
  // ------------------------------------------------------------------
  if (configPanelOpen) {
    this.Text(id, ' ');
    this.Text(id, `${this.TextColor.brightYellow('⚙️ Search Configuration')}`);
    
    // Mode selection - using individual buttons with setSearchModeProp
    this.Buttons(id, [
      {
        name: searchConfig.mode === 'key' ? '✅ Keys Only' : '🔑 Keys Only',
        props: { [setSearchModeProp]: 'key' }
      },
      {
        name: searchConfig.mode === 'value' ? '✅ Values Only' : '📝 Values Only',
        props: { [setSearchModeProp]: 'value' }
      },
      {
        name: searchConfig.mode === 'both' ? '✅ Keys + Values' : '🔀 Keys + Values',
        props: { [setSearchModeProp]: 'both' }
      }
    ]);

    // ------------------------------------------------------------------
    // NEW: Search Key selector — only shown when the current tree node
    // is an array of objects and a model could be detected. Clicking a
    // key restricts ALL searches to that specific key across the entire
    // dataset; clicking again (or ✖ Any) clears the restriction.
    // ------------------------------------------------------------------
    if (detectedModel && detectedModel.keys.length > 0) {
      this.Text(id, ' ');
      this.Text(id,
        `${this.TextColor.brightCyan('🔍 Search Key:')} ` +
        (searchConfig.searchKey
          ? this.TextColor.green(`"${searchConfig.searchKey}"`)
          : this.TextColor.dim('(any key)'))
      );

      // NOTE: no slice() — every key of the detected model is exposed
      // so no key is ever silently cut from the config panel.
      const searchKeyButtons = detectedModel.keys.map(k => {
        const active = searchConfig.searchKey === k.key;
        return {
          name: active
            ? this.TextColor.bgGreen(this.TextColor.black(` ✓ ${k.key} `))
            : `🔑 ${k.key}`,
          props: { [setSearchKeyProp]: active ? '' : k.key }
        };
      });

      if (searchConfig.searchKey) {
        searchKeyButtons.push({
          name: this.TextColor.brightRed('✖ Any'),
          props: { [clearSearchKeyProp]: true }
        });
      }

      this.Buttons(id, searchKeyButtons);
    }

    // ------------------------------------------------------------------
    // NEW: Show-Keys filter — only shown when the current tree node is
    // an array of objects. Toggling a key hides/shows it in the array
    // item previews, in search result instances (normal & saved), and
    // inside the value view.
    //
    // DISPLAY-ONLY: this filter is NEVER applied to the data written by
    // save-only mode — the saved file always contains every key of each
    // matched object.
    // ------------------------------------------------------------------
    if (detectedModel && detectedModel.keys.length > 0) {
      this.Text(id, ' ');
      this.Text(id,
        `${this.TextColor.brightCyan('👁 Show Keys:')} ` +
        (showKeys.length > 0
          ? this.TextColor.dim(`(${showKeys.length} selected — display only)`)
          : this.TextColor.dim('(all keys shown)'))
      );

      // NOTE: no slice() — every key of the detected model is exposed
      // so no key is ever silently cut from the "Show Keys" filter.
      const showKeyButtons = detectedModel.keys.map(k => {
        const active = showKeys.includes(k.key);
        return {
          name: active
            ? this.TextColor.green(`✓ ${k.key}`)
            : this.TextColor.dim(`○ ${k.key}`),
          props: { [toggleShowKeyProp]: k.key }
        };
      });

      if (showKeys.length > 0) {
        showKeyButtons.push({
          name: this.TextColor.brightRed('✖ Clear'),
          props: { [clearShowKeysProp]: true }
        });
      }

      this.Buttons(id, showKeyButtons);
    }
    
    this.Text(id, ' ');
    
    // Weight adjustment (only in 'both' mode)
    if (searchConfig.mode === 'both') {
      this.Text(id, `${this.TextColor.brightCyan('Weights (auto-adjust to 100%):')}`);
      
      // Key weight field
      this.Field(id, `${storageKey}_keyWeightField`, {
        label: '🔑 Key Weight %',
        initialValue: Math.round(searchConfig.keyWeight * 100).toString(),
        maxWidth: 4,
        onChange: (value) => {
          const weightValue = parseFloat(value) / 100;
          if (!isNaN(weightValue) && weightValue >= 0 && weightValue <= 1) {
            self.Storages.Set(id, searchKeyWeightKey, weightValue);
            self.Storages.Set(id, searchValueWeightKey, Math.round((1 - weightValue) * 100) / 100);
            
            const build = self.Builds.get(id);
            if (build && build.Session) {
              if (!build.Session.ActualProps) {
                build.Session.ActualProps = {};
              }
              build.Session.ActualProps[updateKeyWeightProp] = weightValue;
            }
          }
        }
      });
      
      // Value weight field
      this.Field(id, `${storageKey}_valueWeightField`, {
        label: '📝 Value Weight %',
        initialValue: Math.round(searchConfig.valueWeight * 100).toString(),
        maxWidth: 4,
        onChange: (value) => {
          const weightValue = parseFloat(value) / 100;
          if (!isNaN(weightValue) && weightValue >= 0 && weightValue <= 1) {
            self.Storages.Set(id, searchValueWeightKey, weightValue);
            self.Storages.Set(id, searchKeyWeightKey, Math.round((1 - weightValue) * 100) / 100);
            
            const build = self.Builds.get(id);
            if (build && build.Session) {
              if (!build.Session.ActualProps) {
                build.Session.ActualProps = {};
              }
              build.Session.ActualProps[updateValueWeightProp] = weightValue;
            }
          }
        }
      });
      
      // Quick weight presets
            this.Text(id, `${this.TextColor.dim('Quick presets:')}`);
            this.Buttons(id, [
              {
                name: '🔑 90/10',
                props: { [updateKeyWeightProp]: 0.9 }
              },
              {
                name: '🔑 80/20',
                props: { [updateKeyWeightProp]: 0.8 }
              },
              {
                name: '🔀 50/50',
                props: { [updateKeyWeightProp]: 0.5 }
              },
              {
                name: '📝 20/80',
                props: { [updateKeyWeightProp]: 0.2 }
              },
              {
                name: '📝 10/90',
                props: { [updateKeyWeightProp]: 0.1 }
              }
            ]);
      
      this.Text(id, ' ');
    }
    
    // Minimum similarity threshold
    this.Text(id, `${this.TextColor.brightCyan('Minimum Similarity:')}`);
    this.Field(id, `${storageKey}_minSimilarityField`, {
      label: '🎯 Min %',
      initialValue: Math.round(searchConfig.minSimilarity * 100).toString(),
      maxWidth: 4,
      onChange: (value) => {
        const minValue = parseFloat(value) / 100;
        if (!isNaN(minValue) && minValue >= 0 && minValue <= 1) {
          self.Storages.Set(id, searchMinSimilarityKey, minValue);
          
          const build = self.Builds.get(id);
          if (build && build.Session) {
            if (!build.Session.ActualProps) {
              build.Session.ActualProps = {};
            }
            build.Session.ActualProps[updateMinSimilarityProp] = minValue;
          }
        }
      }
    });
    
    // Quick min similarity presets
    this.Buttons(id, [
      {
        name: '10%',
        props: { [updateMinSimilarityProp]: 0.1 }
      },
      {
        name: '30%',
        props: { [updateMinSimilarityProp]: 0.3 }
      },
      {
        name: '50%',
        props: { [updateMinSimilarityProp]: 0.5 }
      },
      {
        name: '70%',
        props: { [updateMinSimilarityProp]: 0.7 }
      }
    ]);

    // Save-only toggle
    this.Text(id, `${this.TextColor.brightCyan('Save-Only Mode:')}`);
    this.Button(id, {
      name: saveOnly ? '✅ Just save, don\'t show (ON)' : '⬜ Just save, don\'t show (OFF)',
      props: { [toggleSaveOnlyProp]: true }
    });
    this.Text(id, ' ');

    // Recent Files Time Window
    this.Text(id, `${this.TextColor.brightCyan('Recent Files Time Window:')}`);
    const recentTimeWindow = this.Storages.Get(id, `${storageKey}_recentTimeWindow`) || 10;
    this.Field(id, `${storageKey}_recentTimeWindowField`, {
      label: '⏱️ Minutes',
      initialValue: recentTimeWindow.toString(),
      maxWidth: 4,
      onChange: (value) => {
        const minutes = parseFloat(value);
        if (!isNaN(minutes) && minutes > 0) {
          self.Storages.Set(id, `${storageKey}_recentTimeWindow`, minutes);
          const build = self.Builds.get(id);
          if (build && build.Session) {
            if (!build.Session.ActualProps) {
              build.Session.ActualProps = {};
            }
            build.Session.ActualProps[updateRecentTimeWindowProp] = minutes;
          }
        }
      }
    });
    this.Buttons(id, [
      { name: '5 min', props: { [updateRecentTimeWindowProp]: 5 } },
      { name: '10 min', props: { [updateRecentTimeWindowProp]: 10 } },
      { name: '30 min', props: { [updateRecentTimeWindowProp]: 30 } },
      { name: '1 h', props: { [updateRecentTimeWindowProp]: 60 } },
      { name: '2 h', props: { [updateRecentTimeWindowProp]: 120 } }
    ]);
    this.Text(id, ' ');
  }

  this.Text(id, ' ');

  // Navigate in search results or normal tree
  let currentNode;
  let breadcrumb;
  let displaySearchResults = false;

  if (storage.searchResults && storage.searchQuery) {
    displaySearchResults = true;

    if (storage.searchPath.length > 0) {
      currentNode = storage.searchResults;
      for (const seg of storage.searchPath) {
        if (seg && typeof seg === 'object' && seg.__searchResult !== undefined) {
          // Marker: unwrap the full object of the referenced search
          // result so clicking a result lands on the actual data
          // object instead of the metadata wrapper.
          const result = storage.searchResults[seg.__searchResult];
          if (result) {
            currentNode = result._fullObject !== undefined ? result._fullObject : result.value;
          } else {
            currentNode = null;
          }
        } else if (typeof seg === 'number') {
          currentNode = currentNode[seg];
        } else {
          currentNode = currentNode?.[seg];
        }
      }
      breadcrumb = `🔍 "${storage.searchQuery}" → Result`;
    } else {
      currentNode = storage.searchResults;
      breadcrumb = `🔍 Search: "${storage.searchQuery}" (${storage.searchResults.length} results)`;
    }
  } else {
    currentNode = storage.data;
    breadcrumb = '📍 root';
    for (const seg of storage.path) {
      if (typeof seg === 'number') {
        currentNode = currentNode[seg];
        breadcrumb += `[${seg}]`;
      } else {
        currentNode = currentNode?.[seg];
        breadcrumb += `.${seg}`;
      }
    }
  }

  // ------------------------------------------------------------------
  // Helper functions
  // ------------------------------------------------------------------
  const maxTextLength = config.maxTextLength || 40;

  const abbreviateText = (text, maxLength = maxTextLength) => {
    if (text === undefined || text === null) return String(text);
    const str = String(text);
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
  };

  const getValuePreview = (value, maxLength = maxTextLength) => {
    if (Array.isArray(value)) {
      return `Array(${value.length})`;
    }
    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value);
      return `Object(${keys.length} keys)`;
    }
    return abbreviateText(value, maxLength);
  };

  // NEW: preview for array items that shows key:value pairs inline,
  // optionally restricted to a set of "show keys" chosen by the user
  // in the config panel. Used whenever the current node is an array of
  // objects, so items show their actual content instead of "Object(N)".
  //
  // IMPORTANT: each value is truncated to a very short preview
  // (VALUE_CAP characters) so that a single huge value — e.g. a long
  // string sitting in the first key — can never blow up the whole
  // preview line. The key name itself is kept intact.
  const getItemPreviewForArray = (item, maxLength = maxTextLength, showKeysList = []) => {
    if (item === null) return 'null';
    if (typeof item !== 'object') return abbreviateText(item, maxLength);
    if (Array.isArray(item)) return `Array(${item.length})`;

    let keys = Object.keys(item);
    const allKeys = keys.slice();
    if (Array.isArray(showKeysList) && showKeysList.length > 0) {
      const filterSet = new Set(showKeysList);
      keys = keys.filter(k => filterSet.has(k));
      if (keys.length === 0) {
        return `{${allKeys.length} keys} ` + ColorText.dim('(filtered out)');
      }
    }

    const VALUE_CAP = 10;
    const parts = [];
    const budget = Math.max(8, maxLength - 4);
    for (const k of keys) {
      const v = item[k];
      let vs;
      if (v === null) vs = 'null';
      else if (Array.isArray(v)) vs = `[${v.length}]`;
      else if (typeof v === 'object') vs = '{…}';
      else {
        vs = String(v);
        if (vs.length > VALUE_CAP) vs = vs.slice(0, VALUE_CAP) + '…';
      }
      const piece = `${k}:${vs}`;
      if (parts.length > 0 && (parts.join(', ').length + piece.length + 2) > budget) {
        parts.push('…');
        break;
      }
      parts.push(piece);
    }
    return '{' + parts.join(', ') + '}';
  };

  // NEW: preview for a search-result entry.
  //
  // A search result's `.value` field can be any JSON shape. This helper
  // produces a compact one-line display that respects the show-keys
  // filter for DISPLAY ONLY:
  //
  //   • When showKeys is empty → the FULL value (using the existing
  //     getValuePreview rules, so nothing changes for existing users).
  //   • When showKeys is non-empty → a slimmed view exposing only the
  //     selected keys (via slimSearchResultValue), stringified compactly
  //     and truncated to maxLength.
  //
  // IMPORTANT: this helper is ONLY used for what the user SEES. The
  // actual data written by save-only mode always uses the full
  // `_fullObject`, so no keys are ever lost on disk.
  const getSearchResultPreview = (value, maxLength = maxTextLength, showKeysList = []) => {
    if (!Array.isArray(showKeysList) || showKeysList.length === 0) {
      return getValuePreview(value, maxLength);
    }

    const slimmed = slimSearchResultValue(value, showKeysList);
    if (slimmed === null || slimmed === undefined) return String(slimmed);

    if (typeof slimmed !== 'object') {
      return abbreviateText(slimmed, maxLength);
    }

    let str;
    try { str = JSON.stringify(slimmed); }
    catch (_) { str = String(slimmed); }

    if (str === '{}' || str === '[]') {
      return ColorText.dim('(filtered out)');
    }
    return abbreviateText(str, maxLength);
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    else if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    else if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    else return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  };

  const formatBrazilianTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
  };

  const abbreviateFileName = (fileName) => {
    const base = path.basename(fileName, '.json');
    if (base.length <= 6) return base;
    return base.substring(0, 3) + '..' + base.substring(base.length - 3);
  };

  const getRecentJsonFiles = () => {
    const dir = storage.filePath ? path.dirname(storage.filePath) : (config.startPath || process.cwd());
    try {
      const files = fs.readdirSync(dir, { withFileTypes: true })
        .filter(dirent => dirent.isFile() && dirent.name.toLowerCase().endsWith('.json'))
        .map(dirent => {
          const fullPath = path.join(dir, dirent.name);
          const stat = fs.statSync(fullPath);
          return { name: dirent.name, filePath: fullPath, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return files;
    } catch (e) {
      return [];
    }
  };

  // ------------------------------------------------------------------
  // Display breadcrumb and file info
  // ------------------------------------------------------------------
  this.Text(id, `${this.TextColor.brightCyan('📍')} ${this.TextColor.bold(breadcrumb)}`);
  if (storage.filePath && !displaySearchResults) {
    this.Text(id, `${this.TextColor.dim('📄 ' + path.basename(storage.filePath))}`);
  }
  this.Text(id, ' ');

  // ------------------------------------------------------------------
  // Render the current node
  // ------------------------------------------------------------------
  const itemsPerPage = config.itemsPerPage || 5;

  const createPaginationConfig = (paginationKey, dataLength) => {
    const paginationStorage = this.Storages.Get(id, paginationKey);
    const totalPages = Math.max(1, Math.ceil(dataLength / itemsPerPage));
    const currentPage = paginationStorage?.actual_page || 1;
    const safeCurrentPage = Math.min(currentPage, totalPages);
    
    return {
      items_per_page: itemsPerPage,
      actual_page: safeCurrentPage,
      custom: {
        showSeparators: false,
        showPageInfo: true,
        showNavigation: true,
        pageInfoStyle: 'text',
        prevButtonText: '◀',
        nextButtonText: '▶',
        pageIndicatorText: `${safeCurrentPage}/${totalPages}`
      }
    };
  };

  if (displaySearchResults && storage.searchPath.length === 0) {
    // Search results list
    this.Text(id, `${this.TextColor.green('🔍')} Found ${storage.searchResults.length} matches for "${storage.searchQuery}"`);

    if (storage.searchResults.length === 0) {
      this.Text(id, `${this.TextColor.dim('No results found')}`);
    } else {
      await this.Pagination.Button(
        id, 
        `${storageKey}_searchResults`, 
        storage.searchResults, 
        {
          ...createPaginationConfig(`${storageKey}_searchResults`, storage.searchResults.length),
          renderItem: (itemData) => {
            const item = itemData.item;
            const similarity = item.similarity !== undefined ? 
              ` ${this.TextColor.dim(`(${Math.round(item.similarity * 100)}%)`)}` : '';
            
            let matchInfo = '';
            if (item.matchType === 'key') {
              matchInfo = ` 🔑${item.keySimilarity ? Math.round(item.keySimilarity * 100) + '%' : ''}`;
            } else if (item.matchType === 'value') {
              matchInfo = ` 📝${item.valueSimilarity ? Math.round(item.valueSimilarity * 100) + '%' : ''}`;
            } else if (item.matchType === 'both') {
              matchInfo = ` 🔀K:${item.keySimilarity ? Math.round(item.keySimilarity * 100) + '%' : '0%'} V:${item.valueSimilarity ? Math.round(item.valueSimilarity * 100) + '%' : '0%'}`;
            }

            // NEW: reflect the show-keys filter on EVERY result instance
            // for DISPLAY ONLY. When showKeys is non-empty, the preview is
            // computed from a slimmed copy of the FULL object attached to
            // this result (`_fullObject`), so every key the user selected
            // is shown consistently. The underlying saved data is
            // unaffected — save-only always writes `_fullObject` whole.
            const previewSource = (item._fullObject !== undefined) ? item._fullObject : item.value;
            const slimmedPreview = getSearchResultPreview(previewSource, maxTextLength, showKeys);
            const valuePart = (Array.isArray(showKeys) && showKeys.length > 0 && previewSource !== undefined)
              ? ` ${this.TextColor.dim('→')} ${this.TextColor.brightWhite(slimmedPreview)}`
              : '';

            this.Button(id, {
              name: `${this.TextColor.brightBlue(`#${itemData.globalIndex + 1}`)} ${item.type === 'key' ? '🔑' : '📝'} ${abbreviateText(item.path, maxTextLength)}${matchInfo}${similarity}${valuePart}`,
              props: { [openSearchResultProp]: itemData.globalIndex }
            });
          }
        }
      );
    }

  } else if (displaySearchResults && storage.searchPath.length > 0) {
    // Navigating within search result
    if (Array.isArray(currentNode)) {
      this.Text(id, `${this.TextColor.yellow('📚')} Array (${currentNode.length} items)`);

      if (currentNode.length === 0) {
        this.Text(id, `${this.TextColor.dim('(empty array)')}`);
      } else {
        await this.Pagination.Button(
          id, 
          `${storageKey}_searchNav`, 
          currentNode, 
          {
            ...createPaginationConfig(`${storageKey}_searchNav`, currentNode.length),
            renderItem: (itemData) => {
              const item = itemData.item;
              const display = getValuePreview(item, maxTextLength);
              this.Button(id, {
                name: `${this.TextColor.green(`#${itemData.globalIndex}`)} ${display}`,
                props: { [`${storageKey}_navigate`]: itemData.globalIndex }
              });
            }
          }
        );
      }
    } else if (currentNode !== null && typeof currentNode === 'object') {
      const allKeys = Object.keys(currentNode);
      // Apply the show-keys filter (display only) so entering an
      // object inside a search result honours the user's key selection.
      let keys = allKeys;
      if (Array.isArray(showKeys) && showKeys.length > 0) {
        const filterSet = new Set(showKeys);
        keys = allKeys.filter(k => filterSet.has(k));
      }
      this.Text(id, `${this.TextColor.magenta('🔑')} Object (${keys.length} keys)`);

      if (keys.length === 0) {
        this.Text(id, `${this.TextColor.dim(allKeys.length > 0 ? '(all keys hidden by filter)' : '(empty object)')}`);
      } else {
        const keyItems = keys.map(key => ({ key, value: currentNode[key] }));

        await this.Pagination.Button(
          id, 
          `${storageKey}_searchNav`, 
          keyItems, 
          {
            ...createPaginationConfig(`${storageKey}_searchNav`, keyItems.length),
            renderItem: (itemData) => {
              const { key, value } = itemData.item;
              // FULL key (never truncated) + a short content preview,
              // capped at 10 chars for string values so a huge value in
              // the first key cannot blow up the line.
              const keyDisplay = String(key);
              let valuePreview;
              if (Array.isArray(value)) {
                valuePreview = `Array(${value.length})`;
              } else if (value !== null && typeof value === 'object') {
                valuePreview = `Object(${Object.keys(value).length} keys)`;
              } else {
                const s = String(value);
                valuePreview = s.length > 10 ? s.slice(0, 10) + '…' : s;
              }

              this.Button(id, {
                name: `${this.TextColor.cyan(keyDisplay)}: ${this.TextColor.dim(valuePreview)}`,
                props: { [`${storageKey}_navigate`]: key }
              });
            }
          }
        );
      }
    } else {
      // Primitive value inside a search result — same TextButton treatment
      // as the main tree view. A separate stable storage name is used so
      // the search-result value box never collides with the tree one.
      const valueStr = String(currentNode);

      this.Text(id, `${this.TextColor.brightGreen('💎')} Value:`);

      const valueLines = valueStr.length > 400 ? 12
                        : valueStr.length > 200 ? 8
                        : valueStr.length > 80  ? 6
                        : 4;

      this.TextButton(id, `${storageKey}_search_value_view`, {
        label: 'Value',
        initialValue: valueStr,
        lines: valueLines,
        editable: false
      });
    }

  } else if (Array.isArray(currentNode)) {
    // Array display
    const isSearchResultList = displaySearchResults && storage.searchPath.length === 0;
    const arrayModel = isSearchResultList ? null : detectArrayModel(currentNode);

    // ------------------------------------------------------------------
    // NEW: VALUE-VIEW MODE — only entered by clicking a "📊 key" button
    // below. Shows every distinct value of that key with item counts,
    // lets the user filter to one specific value, and (when filtered)
    // lists the matching items so they can drill into a specific one.
    // ------------------------------------------------------------------
    if (!isSearchResultList && storage.valueView && storage.valueView.key) {
      const vvKey = storage.valueView.key;
      const vvFilter = storage.valueView.filter;

      this.Text(id,
        `${this.TextColor.brightCyan('📊')} ` +
        this.TextColor.bold(`Values of key "${vvKey}"`)
      );
      this.Text(id, this.TextColor.dim(`  (from ${currentNode.length} items)`));

      const aggregatedValues = aggregateKeyValues(currentNode, vvKey);

      if (vvFilter !== null && vvFilter !== undefined) {
        const matchingCount =
          aggregatedValues.find(v => v.value === String(vvFilter))?.count || 0;
        this.Text(id,
          `  ${this.TextColor.brightGreen('✓ Filter:')} ` +
          this.TextColor.bold(String(vvFilter)) + ' ' +
          this.TextColor.dim(`(${matchingCount} item${matchingCount === 1 ? '' : 's'})`)
        );
      }

      this.Text(id, ' ');

      if (aggregatedValues.length === 0) {
        this.Text(id, this.TextColor.dim('  (no values found for this key)'));
      } else {
        const valueItems = aggregatedValues.map(v => ({
          value: v.value,
          count: v.count,
          isActive: vvFilter !== null && vvFilter !== undefined && String(vvFilter) === v.value
        }));

        await this.Pagination.Button(
          id,
          `${storageKey}_valueView`,
          valueItems,
          {
            ...createPaginationConfig(`${storageKey}_valueView`, valueItems.length),
            renderItem: (itemData) => {
              const { value, count, isActive } = itemData.item;
              const shown = abbreviateText(value, Math.floor(maxTextLength * 0.7));
              const name = isActive
                ? this.TextColor.bgGreen(this.TextColor.black(` ▶ ${shown} `)) +
                  ' ' + this.TextColor.dim(`×${count}`)
                : this.TextColor.cyan(shown) + ' ' + this.TextColor.dim(`×${count}`);
              this.Button(id, {
                name,
                props: { [setValueFilterProp]: isActive ? '' : value }
              });
            }
          }
        );
      }

      this.Text(id, ' ');
      const vvActions = [
        {
          name: this.TextColor.orange('← Back to array'),
          props: { [closeValueViewProp]: true }
        }
      ];
      if (vvFilter !== null && vvFilter !== undefined) {
        vvActions.push({
          name: this.TextColor.brightRed('✖ Clear filter'),
          props: { [clearValueFilterProp]: true }
        });
      }
      this.Buttons(id, vvActions);

      // When a filter is active, list the matching items so the user can
      // drill into a specific one. The preview respects the show-keys
      // filter, so every listed instance reflects the user's selection.
      if (vvFilter !== null && vvFilter !== undefined) {
        const matching = [];
        for (let i = 0; i < currentNode.length; i++) {
          const item = currentNode[i];
          if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
          if (!(vvKey in item)) continue;
          const raw = item[vvKey];
          const strV = (typeof raw === 'object' && raw !== null)
            ? JSON.stringify(raw)
            : String(raw);
          if (strV === String(vvFilter)) {
            matching.push({ item, globalIndex: i });
          }
        }

        this.Text(id, ' ');
        this.Text(id, `${this.TextColor.bold(`Matching items (${matching.length}):`)}`);
        await this.Pagination.Button(
          id,
          `${storageKey}_valueViewItems`,
          matching,
          {
            ...createPaginationConfig(`${storageKey}_valueViewItems`, matching.length),
            renderItem: (itemData) => {
              const { item, globalIndex } = itemData.item;
              const display = getItemPreviewForArray(item, maxTextLength, showKeys);
              this.Button(id, {
                name: `${this.TextColor.green(`#${globalIndex}`)} ${display}`,
                props: { [`${storageKey}_navigate`]: globalIndex }
              });
            }
          }
        );
      }

    } else {
      // Regular array view
      this.Text(id, `${this.TextColor.yellow('📚')} Array (${currentNode.length} items)`);

      // ------------------------------------------------------------------
      // NEW: model info + value-view launcher buttons. Only shown when
      // the array contains at least one object and a model was detected.
      // Clicking a "📊 key" button is what "loads" the value view for
      // that key — nothing happens unless the user clicks one.
      // ------------------------------------------------------------------
      if (arrayModel && arrayModel.keys.length > 0) {
        this.Text(id, this.TextColor.dim(
          `  model: ${arrayModel.keys.length} key(s) across ` +
          `${arrayModel.objectCount} object(s)`
        ));

        // NOTE: no slice() — every key of the detected model is exposed
        // so no key is ever silently cut from the array-view launchers.
        // The `(count)` suffix was also removed per the request.
        const keyLauncherButtons = arrayModel.keys.map(k => ({
          name: `📊 ${k.key}`,
          props: { [openValueViewProp]: k.key }
        }));
        if (keyLauncherButtons.length > 0) {
          this.Buttons(id, keyLauncherButtons);
        }
      }

      if (currentNode.length === 0) {
        this.Text(id, `${this.TextColor.dim('(empty array)')}`);
      } else {
        await this.Pagination.Button(
          id, 
          `${storageKey}_array`, 
          currentNode, 
          {
            ...createPaginationConfig(`${storageKey}_array`, currentNode.length),
            renderItem: (itemData) => {
              const item = itemData.item;
              const display = getItemPreviewForArray(item, maxTextLength, showKeys);
              this.Button(id, {
                name: `${this.TextColor.green(`#${itemData.globalIndex}`)} ${display}`,
                props: { [`${storageKey}_navigate`]: itemData.globalIndex }
              });
            }
          }
        );
      }
    }

  } else if (currentNode !== null && typeof currentNode === 'object') {
    // Object display
    const allKeys = Object.keys(currentNode);
    // Apply the show-keys filter (display only) so entering an object
    // honours the user's key selection, whether the object came from
    // the tree, the array view, or a search result.
    let keys = allKeys;
    if (Array.isArray(showKeys) && showKeys.length > 0) {
      const filterSet = new Set(showKeys);
      keys = allKeys.filter(k => filterSet.has(k));
    }
    this.Text(id, `${this.TextColor.magenta('🔑')} Object (${keys.length} keys)`);

    if (keys.length === 0) {
      this.Text(id, `${this.TextColor.dim(allKeys.length > 0 ? '(all keys hidden by filter)' : '(empty object)')}`);
    } else {
      const keyItems = keys.map(key => ({ key, value: currentNode[key] }));

      await this.Pagination.Button(
        id, 
        `${storageKey}_object`, 
        keyItems, 
        {
          ...createPaginationConfig(`${storageKey}_object`, keyItems.length),
          renderItem: (itemData) => {
            const { key, value } = itemData.item;
            // FULL key (never truncated) + a short content preview,
            // capped at 10 chars for string values.
            const keyDisplay = String(key);
            let valuePreview;
            if (Array.isArray(value)) {
              valuePreview = `Array(${value.length})`;
            } else if (value !== null && typeof value === 'object') {
              valuePreview = `Object(${Object.keys(value).length} keys)`;
            } else {
              const s = String(value);
              valuePreview = s.length > 10 ? s.slice(0, 10) + '…' : s;
            }

            let buttonName = `${this.TextColor.cyan(keyDisplay)}: ${this.TextColor.dim(valuePreview)}`;

            if (typeof value === 'string' && value.length > 10) {
              buttonName += ` ${this.TextColor.brightYellow('📖')}`;
            }

            this.Button(id, {
              name: buttonName,
              props: { [`${storageKey}_navigate`]: key }
            });
          }
        }
      );
    }

  } else {
    // Primitive display — the key's value is rendered through
    // this.TextButton() instead of this.Text(), so the user gets the
    // same scrollable / activatable box used for every other value.
    //
    // The box uses a STABLE storage name per JSON browser instance:
    // navigating to a different key produces a different `initialValue`,
    // which causes TextButton to automatically re-seed its content (and
    // reset its scroll position) — so the box always reflects whichever
    // key the user is currently looking at.
    const valueStr = typeof currentNode === 'string' ? currentNode : String(currentNode);

    this.Text(id, `${this.TextColor.brightGreen('💎')} Value:`);

    const valueLines = valueStr.length > 400 ? 12
                      : valueStr.length > 200 ? 8
                      : valueStr.length > 80  ? 6
                      : 4;

    this.TextButton(id, `${storageKey}_value_view`, {
      label: 'Value',
      initialValue: valueStr,
      lines: valueLines,
      editable: false
    });
  }

  // ------------------------------------------------------------------
  // Recent JSON files
  // ------------------------------------------------------------------
  if (storage.filePath) {
    const currentFilePath = storage.filePath;
    const recentTimeWindowMinutes = this.Storages.Get(id, `${storageKey}_recentTimeWindow`) || 10;
    const windowMs = recentTimeWindowMinutes * 60 * 1000;
    const now = Date.now();
    const recentFiles = getRecentJsonFiles()
      .filter(f => f.filePath !== currentFilePath)
      .filter(f => (now - f.mtime) <= windowMs);
    if (recentFiles.length > 0) {
      this.Text(id, ' ');
      this.Text(id, `${this.TextColor.brightCyan('🕒 Recent JSON Files')}`);
      const recentButtons = recentFiles.map(file => ({
        name: `${abbreviateFileName(file.filePath)} ${formatBrazilianTime(file.mtime)}`,
        props: { [recentLoadProp]: file.filePath }
      }));
      this.Buttons(id, recentButtons);
    }
  }

  // ------------------------------------------------------------------
  // Navigation buttons
  // ------------------------------------------------------------------
  this.Text(id, ' ');

  const navButtons = [];

  if ((displaySearchResults && storage.searchPath.length > 0) || 
      (!displaySearchResults && storage.path.length > 0)) {
    navButtons.push({
      name: `${this.TextColor.orange('⬆️ Back')}`,
      props: { [`${storageKey}_back`]: true }
    });
  }

  if (storage.historyStack && storage.historyStack.length > 0) {
    navButtons.push({
      name: `${this.TextColor.orange('🔙 Return')}`,
      props: { [returnProp]: true }
    });
  }

  if (displaySearchResults) {
    navButtons.push({
      name: `${this.TextColor.brightRed('✖ Clear Search')}`,
      props: { [`${storageKey}_clearSearch`]: true }
    });
  }

  navButtons.push({
    name: `${this.TextColor.brightBlue('📂 Load New JSON')}`,
    props: { [`${storageKey}_loadNew`]: true }
  });

  this.Buttons(id, navButtons);
};

// ----------------------------------------------------------------------
// Build search index for fast in-memory searching
// ----------------------------------------------------------------------
function buildSearchIndex(data) {
  const index = [];
  
  const traverse = (obj, path = '') => {
    if (obj === null || obj === undefined) return;
    
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => {
        traverse(item, `${path}[${i}]`);
      });
    } else if (typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        const fullPath = path ? `${path}.${key}` : key;
        
        // Index the key itself
        index.push({
          type: 'key',
          path: fullPath,
          key: key.toLowerCase(),
          value: typeof value === 'string' ? value.toLowerCase() : '',
          fullValue: value
        });
        
        traverse(value, fullPath);
      }
    } else {
      // Index primitive values
      const strValue = String(obj).toLowerCase();
      index.push({
        type: 'value',
        path: path || 'root',
        key: path.split('.').pop()?.toLowerCase() || 'root',
        value: strValue,
        fullValue: obj
      });
    }
  };
  
  traverse(data);
  return index;
}

// ----------------------------------------------------------------------
// Array-of-objects model detection.
//
// Walks an array and collects the union of every key present in its
// object items, plus per-key coverage (how many items actually have it).
// Used by this.JSON() to expose a model of the current array, let the
// user search a single specific key, and drive the value-view drilldown.
//
// Returns null when the array contains no objects at all.
// ----------------------------------------------------------------------
function detectArrayModel(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const keyCounts = new Map();
  let objectCount = 0;

  for (const item of arr) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    objectCount++;
    const seen = new Set();
    for (const k of Object.keys(item)) {
      if (seen.has(k)) continue;
      seen.add(k);
      keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
    }
  }

  if (objectCount === 0) return null;

  const keys = Array.from(keyCounts.entries())
    .map(([key, count]) => ({
      key,
      count,
      coverage: objectCount > 0 ? count / objectCount : 0
    }))
    .sort((a, b) => {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      return a.key.localeCompare(b.key);
    });

  return { keys, objectCount, totalItems: arr.length };
}

// ----------------------------------------------------------------------
// Aggregate distinct values of one key across all objects of an array.
// Values are stringified for grouping so primitives and simple objects
// can be mixed safely. Sorted by frequency (most common first).
// ----------------------------------------------------------------------
function aggregateKeyValues(arr, key) {
  if (!Array.isArray(arr) || !key) return [];
  const counts = new Map();

  for (const item of arr) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    if (!(key in item)) continue;
    const v = item[key];
    let strV;
    if (typeof v === 'object' && v !== null) {
      try { strV = JSON.stringify(v); } catch (_) { strV = String(v); }
    } else {
      strV = String(v);
    }
    counts.set(strV, (counts.get(strV) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}

// ----------------------------------------------------------------------
// Restrict a search index so only entries whose LAST segment matches the
// given key name remain (case-insensitive). Falsy key = no-op.
// ----------------------------------------------------------------------
function filterSearchIndexByKey(searchIndex, key) {
  if (!key || !Array.isArray(searchIndex)) return searchIndex || [];
  const lower = String(key).toLowerCase();
  return searchIndex.filter(entry => entry && entry.key === lower);
}

// ----------------------------------------------------------------------
// NEW: Build a "slim" preview object for a search-result value when a
// show-keys filter is active. Used ONLY for display in the UI.
//
//   • plain object        → return an object with ONLY the selected keys
//                           (recursively, so nested objects are slimmed
//                           too — matching the array-view previews);
//   • array of objects    → map each element through the same filter;
//   • primitive / null    → returned as-is (nothing to slim);
//   • empty showKeys      → the ORIGINAL value, untouched.
//
// This is what guarantees "all instances contain the object with the
// selected keys if have selected keys to hide/show" in the UI.
// It is NEVER applied to the data written to disk by save-only mode.
// ----------------------------------------------------------------------
function slimSearchResultValue(value, showKeys) {
  if (!Array.isArray(showKeys) || showKeys.length === 0) return value;

  const showSet = new Set(showKeys);

  const slim = (v) => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(slim);
    if (typeof v !== 'object') return v;

    const out = {};
    for (const k of Object.keys(v)) {
      if (showSet.has(k)) {
        out[k] = slim(v[k]);
      }
    }
    return out;
  };

  return slim(value);
}

// ----------------------------------------------------------------------
// NEW: Enrich search results so each entry carries the FULL original
// object (or array) it belongs to — never a slimmed copy.
//
// A search result only carries the matched path + the matched value.
// For save-only mode (and for "drill into match" navigation) we want the
// whole enclosing object for that match, exactly as it exists in the
// source dataset — with EVERY key, not just the matched ones.
//
// Strategy: use the path (e.g. "users[3].email" or "users[3]") to walk
// the source data and grab the deepest OBJECT or ARRAY that CONTAINS the
// match. That full object is stored on `_fullObject`. The search-result
// `value` field itself is left untouched, so the display layer keeps
// working exactly as it does today.
//
// Called AFTER the search engine (weighted or token) has produced its
// results — never during the search itself — so this has zero impact on
// search behaviour, ranking, or limits.
// ----------------------------------------------------------------------
function enrichSearchResultsWithFullObjects(results, sourceData) {
  if (!Array.isArray(results) || results.length === 0) return results;
  if (sourceData === null || sourceData === undefined) return results;

  // Resolve a bracket/dot path string ("a.b[2].c") into a value walk.
  // Returns `{ value, parent }` where `parent` is the nearest enclosing
  // object/array, or null if the path cannot be resolved.
  const resolvePathWithParent = (pathStr) => {
    if (!pathStr || pathStr === 'root') return { value: sourceData, parent: sourceData };

    const segments = [];
    const re = /([^.[\]]+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(pathStr)) !== null) {
      if (m[1] !== undefined) segments.push(m[1]);
      else segments.push(parseInt(m[2], 10));
    }

    let node = sourceData;
    let parent = null;
    for (let i = 0; i < segments.length; i++) {
      if (node === null || node === undefined) return { value: undefined, parent: null };
      const seg = segments[i];
      // Remember the parent before descending (only for object/array parents)
      if (node !== null && typeof node === 'object') parent = node;
      node = typeof seg === 'number' ? node[seg] : node[seg];
    }
    return { value: node, parent: parent !== null ? parent : node };
  };

  // Determine which full object to expose for a given result entry.
  //
  //   • If the matched value is itself an object/array → use it.
  //   • If the parent (nearest enclosing object/array) is available →
  //     use that. This is what makes a match on "users[3].email" expose
  //     the entire "users[3]" object including every other key.
  //   • Fallback → the value itself.
  const pickFullObject = (pathStr, valueFallback) => {
    const { value, parent } = resolvePathWithParent(pathStr);
    if (value !== null && typeof value === 'object') return value;
    if (parent !== null && parent !== undefined && typeof parent === 'object') return parent;
    return valueFallback;
  };

  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    try {
      const full = pickFullObject(r.path, r.value);
      // Non-enumerable-friendly plain property; JSON-serialised normally.
      r._fullObject = full;
    } catch (_) {
      r._fullObject = r.value;
    }
  }

  return results;
}

// ----------------------------------------------------------------------
// Weighted search with configurable key/value weights
// ----------------------------------------------------------------------
function weightedSearchJSON(data, query, searchIndex, searchConfig = {}) {
  if (!searchIndex) {
    searchIndex = buildSearchIndex(data);
  }

  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.split(/\s+/).filter(t => t.length > 0);
  
  const mode = searchConfig.mode || 'both';
  const keyWeight = searchConfig.keyWeight || 0.7;
  const valueWeight = searchConfig.valueWeight || 0.3;
  const minSimilarity = searchConfig.minSimilarity || 0.3;

  const results = [];
  const seen = new Set();

  for (const item of searchIndex) {
    let keySimilarity = 0;
    let valueSimilarity = 0;
    let matched = false;
    let matchType = null;

    // Check key matches (if mode is 'key' or 'both')
    if ((mode === 'key' || mode === 'both') && item.key) {
      keySimilarity = calculateSimilarity(item.key, queryLower);
      
      // Check token-based matching for keys
      if (queryTokens.length > 0) {
        const keyTokens = item.key.split(/[\s_\-\.]+/);
        for (const token of queryTokens) {
          for (const keyToken of keyTokens) {
            if (keyToken && (keyToken === token || keyToken.includes(token) || token.includes(keyToken))) {
              keySimilarity = Math.max(keySimilarity, 0.8);
              break;
            }
          }
        }
      }
      
      if (keySimilarity > minSimilarity) {
        matched = true;
        matchType = 'key';
      }
    }

    // Check value matches (if mode is 'value' or 'both')
    if ((mode === 'value' || mode === 'both') && item.value) {
      valueSimilarity = calculateSimilarity(item.value, queryLower);
      
      // Check token-based matching for values
      if (queryTokens.length > 0) {
        const valueTokens = item.value.split(/[\s_\-\.]+/);
        for (const token of queryTokens) {
          for (const valueToken of valueTokens) {
            if (valueToken && (valueToken === token || valueToken.includes(token) || token.includes(valueToken))) {
              valueSimilarity = Math.max(valueSimilarity, 0.8);
              break;
            }
          }
        }
        
        // Check if all tokens are present in value (for multi-word queries)
        if (queryTokens.length > 1) {
          const allTokensPresent = queryTokens.every(token => item.value.includes(token));
          if (allTokensPresent) {
            valueSimilarity = Math.max(valueSimilarity, 0.9);
          }
        }
      }
      
      if (valueSimilarity > minSimilarity) {
        matched = true;
        if (matchType === 'key') {
          matchType = 'both';
        } else {
          matchType = 'value';
        }
      }
    }

    // Calculate weighted similarity
    if (matched && !seen.has(item.path)) {
      let finalSimilarity = 0;
      
      if (mode === 'key') {
        finalSimilarity = keySimilarity;
      } else if (mode === 'value') {
        finalSimilarity = valueSimilarity;
      } else {
        // Weighted average for 'both' mode
        finalSimilarity = (keySimilarity * keyWeight) + (valueSimilarity * valueWeight);
        
        // If only one type matched, give it full weight
        if (keySimilarity === 0) {
          finalSimilarity = valueSimilarity;
        } else if (valueSimilarity === 0) {
          finalSimilarity = keySimilarity;
        }
      }
      
      seen.add(item.path);
      results.push({
        path: item.path,
        key: item.path.split('.').pop() || 'root',
        value: item.fullValue !== undefined ? item.fullValue : item.value,
        type: item.type,
        similarity: finalSimilarity,
        matchType: matchType,
        keySimilarity: keySimilarity,
        valueSimilarity: valueSimilarity
      });
    }
  }

  // Sort by similarity (highest first)
  results.sort((a, b) => b.similarity - a.similarity);

  // Limit to top 100 results for performance
  return results.slice(0, 100);
}

// ----------------------------------------------------------------------
// Tokenize text: remove JSON markers and split into tokens
// ----------------------------------------------------------------------
function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[{}[\]",:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0);
}

// ----------------------------------------------------------------------
// Token-based search: compute similarity based on token incidence
// ----------------------------------------------------------------------
function tokenSearchJSON(data, query, searchIndex) {
  if (!searchIndex) {
    searchIndex = buildSearchIndex(data);
  }

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const results = [];

  for (const item of searchIndex) {
    const docTokens = tokenize(item.fullText || item.value || item.key || '');
    if (docTokens.length === 0) continue;

    const occurrences = [];
    let totalIncidence = 0;
    let tokensFound = 0;

    for (const qToken of queryTokens) {
      let found = false;
      for (let i = 0; i < docTokens.length; i++) {
        if (docTokens[i] === qToken) {
          found = true;
          totalIncidence++;
          const start = Math.max(0, i - 3);
          const end = Math.min(docTokens.length, i + 4);
          const before = docTokens.slice(start, i).join(' ');
          const matched = docTokens[i];
          const after = docTokens.slice(i + 1, end).join(' ');
          occurrences.push({ before, matched, after, position: i });
        }
      }
      if (found) tokensFound++;
    }

    if (totalIncidence === 0) continue;

    const coverage = tokensFound / queryTokens.length;
    const frequency = totalIncidence / docTokens.length;
    const similarity = coverage * 0.7 + frequency * 0.3;

    results.push({
      path: item.path,
      key: item.path.split('.').pop() || 'root',
      value: item.fullValue !== undefined ? item.fullValue : item.value,
      type: item.type,
      similarity: similarity,
      matchType: 'token',
      incidences: totalIncidence,
      contexts: occurrences.slice(0, 10) // limit to 10 contexts
    });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 100);
}

// ----------------------------------------------------------------------
// Fast in-memory search with similarity
// ----------------------------------------------------------------------
function fastSearchJSON(data, query, searchIndex) {
  if (!searchIndex) {
    searchIndex = buildSearchIndex(data);
  }
  
  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.split(/\s+/).filter(t => t.length > 0);
  
  const results = [];
  const seen = new Set();
  
  for (const item of searchIndex) {
    let similarity = 0;
    let matched = false;
    
    // Check key matches
    if (item.key) {
      const keySimilarity = calculateSimilarity(item.key, queryLower);
      if (keySimilarity > 0.3) {
        similarity = Math.max(similarity, keySimilarity);
        matched = true;
      }
    }
    
    // Check value matches
    if (item.value) {
      const valueSimilarity = calculateSimilarity(item.value, queryLower);
      if (valueSimilarity > 0.3) {
        similarity = Math.max(similarity, valueSimilarity);
        matched = true;
      }
      
      // Check token-based matching for multi-word queries
      if (queryTokens.length > 1) {
        const allTokensPresent = queryTokens.every(token => item.value.includes(token));
        if (allTokensPresent) {
          similarity = Math.max(similarity, 0.8);
          matched = true;
        }
      }
    }
    
    if (matched && !seen.has(item.path)) {
      seen.add(item.path);
      results.push({
        path: item.path,
        key: item.path.split('.').pop() || 'root',
        value: item.fullValue !== undefined ? item.fullValue : item.value,
        type: item.type,
        similarity: similarity
      });
    }
  }
  
  // Sort by similarity (highest first)
  results.sort((a, b) => b.similarity - a.similarity);
  
  // Limit to top 100 results for performance
  return results.slice(0, 100);
}

// ----------------------------------------------------------------------
// Calculate similarity between two strings (0-1)
// Combines exact match, prefix, substring, and Levenshtein distance
// ----------------------------------------------------------------------
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  
  // Exact match
  if (str1 === str2) return 1;
  
  // Prefix match (starts with)
  if (str1.startsWith(str2)) return 0.9;
  if (str2.startsWith(str1)) return 0.85;
  
  // Substring match
  if (str1.includes(str2)) return 0.7;
  if (str2.includes(str1)) return 0.65;
  
  // Token-based match
  const tokens1 = str1.split(/[\s_\-\.]+/);
  const tokens2 = str2.split(/[\s_\-\.]+/);
  
  for (const token1 of tokens1) {
    for (const token2 of tokens2) {
      if (token1 && token2) {
        if (token1 === token2) return 0.6;
        if (token1.startsWith(token2) || token2.startsWith(token1)) return 0.55;
        if (token1.includes(token2) || token2.includes(token1)) return 0.5;
      }
    }
  }
  
  // Levenshtein distance for fuzzy matching
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 0;
  
  const distance = levenshteinDistance(str1.substring(0, 100), str2.substring(0, 100));
  const similarity = 1 - (distance / Math.max(str1.substring(0, 100).length, str2.substring(0, 100).length));
  
  // Scale Levenshtein similarity to be lower priority than other matches
  return similarity * 0.4;
}

// ----------------------------------------------------------------------
// Levenshtein distance algorithm for fuzzy string matching
// ----------------------------------------------------------------------
function levenshteinDistance(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  
  if (len1 === 0) return len2;
  if (len2 === 0) return len1;
  
  const matrix = [];
  
  // Initialize matrix
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }
  
  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  
  return matrix[len1][len2];
}

    
    // --------------------------- GotoNow Method ---------------------------

    

    /**
     * Navigate to another function immediately
     * @param {string} id - User/build ID
     * @param {string} path - Target function path
     * @param {Object} config - Navigation config
     * @param {Object} [config.props={}] - Props to pass
     * @param {boolean} [config.breakbuild=false] - Whether to break current build
     * @returns {boolean} Success
     * @throws {Error} Throws GOTO_NOW_BREAK if breakbuild is true
     */
    this.GotoNow = (id, path, config = { props: {}, breakbuild: false }) => {
      if (!this.Builds.has(id)) {
        if (this.Log) {
          console.log(`this.GotoNow() Error - userBuild not found | BuildID: ${id} | Target Path: ${path}`);
        }
        return false;
      }

      const userBuild = this.Builds.get(id);

      userBuild.GotoNow = {
        path: path,
        props: config.props || {},
        breakbuild: config.breakbuild || false
      };

      if (config.breakbuild) {
        const gotoError = new Error('GOTO_NOW_BREAK');
        gotoError.gotoInfo = {
          path: path,
          props: config.props || {}
        };
        throw gotoError;
      }

      return true;
    };

    // --------------------------- SetPage Method ---------------------------

    /**
     * Set current page
     * @param {string} id - User/build ID
     * @param {string} page - Page name
     * @param {boolean} [unlock=false] - Whether to unlock the page
     */
    this.SetPage = (id, page, unlock = false) => {
      if (this.Builds.has(id)) {
        const userBuild = this.Builds.get(id);
        if (!userBuild.Session.ActualProps) {
          userBuild.Session.ActualProps = {};
        }
        
        const previousPage = userBuild.Session.ActualProps.page;
        if (previousPage && previousPage !== page) {
          userBuild.Session.ActualProps._previousPage = previousPage;
          
          this._executePageLeaveHooks(previousPage, { 
            session: userBuild.Session, 
            ...userBuild.Session.ActualProps 
          }).catch(err => {
            if (this.Log) console.error(`Page leave hook error:`, err);
          });
        }
        
        userBuild.Session.ActualProps.page = page;

        if (unlock && page) {
          userBuild.Session.ActualProps._unlock = `page-lock-${page}`;
        }
      } else {
        if (this.Log) {
          console.log(`this.SetPage() Error - userBuild not found | BuildID: ${id}`);
        }
      }
    };

    // --------------------------- Pagination Methods ---------------------------

    this.Pagination = {
      Button: async (id, name = '', data = [], config = {}) => {
        // Base default config
        const defaultCustom = {
          showSeparators: false,
          showPageInfo: true,
          showNavigation: true,
          showBlankSpace: true,
          separatorTop: '─'.repeat(40),
          separatorBetween: '─'.repeat(40),
          separatorBottom: '─'.repeat(40),
          prevButtonText: '◀  Prev',
          nextButtonText: 'Next  ▶',
          pageIndicatorText: null,
          pageInfoText: null,
          pageInfoStyle: 'text',
          renderPageInfo: null,
          renderNavigation: null,
          renderSeparator: null,
          renderBlankSpace: null,
          topSpacing: 0,
          bottomSpacing: 0,
        };
    
        // Safely merge custom config
        const custom = config.custom ? { ...defaultCustom, ...config.custom } : defaultCustom;
    
        const finalConfig = {
          actual_page: 1,
          items_per_page: 5,
          button: {
            text: [{ type: 'text', value: 'text1' }, { type: 'key', value: 'ID' }],
            path: { type: 'text', value: 'path1' },
            props: [{ props_key: 'id', type: 'text', value: 'ID' }]
          },
          renderItem: null,
          ...config,
          custom: custom // Replace with merged custom
        };
    
        // Handle empty data
        if (!data || !data.length) {
          if (this.Storages.Has(id, name)) {
            this.Storages.Delete(id, name);
          }
          return { actual_page: 0, total_pages: 0, items_on_page: 0, total_items: 0 };
        }
    
        // Pagination calculation
        const itemsPerPage = finalConfig.items_per_page || 5;
        const paginatedData = BuildPagination(data, itemsPerPage);
        const totalPages = paginatedData.length;
    
        let storage = this.Storages.Get(id, name);
        if (!storage) {
          storage = { actual_page: finalConfig.actual_page || 1, total_pages: totalPages };
        } else {
          storage.total_pages = totalPages;
          if (storage.actual_page > totalPages) storage.actual_page = totalPages;
          if (storage.actual_page < 1) storage.actual_page = 1;
        }
    
        // Navigation (next/prev props)
        const currentProps = this.Builds.get(id).Session.ActualProps || {};
    
        if (currentProps[`pagination_next_${name}`]) {
          if (storage.actual_page < totalPages) storage.actual_page++;
          delete currentProps[`pagination_next_${name}`];
        }
    
        if (currentProps[`pagination_prev_${name}`]) {
          if (storage.actual_page > 1) storage.actual_page--;
          delete currentProps[`pagination_prev_${name}`];
        }
    
        storage.actual_page = Math.max(1, Math.min(storage.actual_page, totalPages));
        this.Storages.Set(id, name, storage);
    
        const currentPageItems = paginatedData[storage.actual_page - 1]?.list || [];
        const startIndex = (storage.actual_page - 1) * itemsPerPage;
    
        // Pagination data object for custom renderers
        const paginationData = {
          name: name,
          actualPage: storage.actual_page,
          totalPages: totalPages,
          itemsPerPage: itemsPerPage,
          totalItems: data.length,
          startIndex: startIndex,
          endIndex: Math.min(storage.actual_page * itemsPerPage, data.length),
          hasNext: storage.actual_page < totalPages,
          hasPrev: storage.actual_page > 1,
          isFirstPage: storage.actual_page === 1,
          isLastPage: storage.actual_page === totalPages,
          currentPageItems: currentPageItems,
          allData: data,
          storage: storage
        };
    
        // Pre-process dropdown handling (only if renderItem exists)
        if (finalConfig.renderItem && typeof finalConfig.renderItem === 'function') {
          const paginationDropdownPrefix = `dropdown-pagination-${name}-`;
          const allStorageKeys = Object.keys(this.Storages.GetAll(id) || {});
          const paginationDropdownKeys = allStorageKeys.filter(key => 
            key.startsWith(paginationDropdownPrefix)
          );
    
          let clickedDropdownKey = null;
          for (const key of Object.keys(currentProps)) {
            if (key.startsWith('droprun') && currentProps[key]) {
              clickedDropdownKey = currentProps[key];
              break;
            }
          }
    
          if (clickedDropdownKey) {
            paginationDropdownKeys.forEach(dropdownKey => {
              if (dropdownKey !== clickedDropdownKey) {
                const dropdownState = this.Storages.Get(id, dropdownKey);
                if (dropdownState && dropdownState.dropped) {
                  dropdownState.dropped = false;
                  this.Storages.Set(id, dropdownKey, dropdownState);
                }
              }
            });
          }
        }
    
        // Helper function to safely execute custom renderers
        const safeRender = (renderer, ...args) => {
          if (typeof renderer === 'function') {
            try {
              renderer(...args);
              return true;
            } catch (error) {
              console.error(`Pagination custom renderer error:`, error);
              return false;
            }
          }
          return false;
        };
    
        // ============================================================
        // TOP SPACING
        // ============================================================
        if (custom.topSpacing > 0) {
          for (let i = 0; i < custom.topSpacing; i++) {
            this.Button(id, { name: ' ' });
          }
        }
    
        // ============================================================
        // TOP SEPARATOR
        // ============================================================
        if (custom.showSeparators && currentPageItems.length > 0) {
          if (!safeRender(custom.renderSeparator, 'top', paginationData)) {
            this.Button(id, { name: custom.separatorTop });
          }
        }
    
        // ============================================================
        // RENDER ITEMS
        // ============================================================
        if (finalConfig.renderItem && typeof finalConfig.renderItem === 'function') {
          // Modular renderItem mode
          for (let i = 0; i < currentPageItems.length; i++) {
            const item = currentPageItems[i];
            const globalIndex = startIndex + i;
    
            const itemData = {
              item: item,
              index: i,
              globalIndex: globalIndex,
              pageIndex: storage.actual_page,
              isFirst: i === 0,
              isLast: i === currentPageItems.length - 1,
              get: (key) => (typeof item === 'object' && item !== null) ? item[key] : undefined,
              has: (key) => (typeof item === 'object' && item !== null) ? key in item : false,
              keys: (typeof item === 'object' && item !== null) ? Object.keys(item) : [],
              values: (typeof item === 'object' && item !== null) ? Object.values(item) : [],
              isObject: typeof item === 'object' && item !== null,
              isArray: Array.isArray(item),
              isString: typeof item === 'string',
              isNumber: typeof item === 'number',
              toString: () => typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item),
              pagination: paginationData
            };
    
            try {
              const result = finalConfig.renderItem(itemData);
              if (result instanceof Promise) await result;
            } catch (error) {
              console.error(`Pagination renderItem error:`, error);
              this.Button(id, {
                name: `Error rendering item ${globalIndex + 1}`,
                path: this.Name,
                props: { error: error.message }
              });
            }
    
            // Between items separator
            if (custom.showSeparators && i < currentPageItems.length - 1) {
              if (!safeRender(custom.renderSeparator, 'between', paginationData, i)) {
                this.Button(id, { name: custom.separatorBetween });
              }
            }
          }
        } else if (finalConfig.button) {
          // Template mode
          currentPageItems.forEach((item, i) => {
            let buttonText = '';
            let buttonPath = this.Name;
            let buttonProps = {};
    
            if (finalConfig.button.text) {
              finalConfig.button.text.forEach(t => {
                if (t.type === 'text') buttonText += t.value;
                else if (t.type === 'key' && typeof item === 'object') buttonText += item[t.value] || '';
              });
            }
    
            if (finalConfig.button.path) {
              if (finalConfig.button.path.type === 'text') buttonPath = finalConfig.button.path.value;
              else if (finalConfig.button.path.type === 'key' && typeof item === 'object') buttonPath = item[finalConfig.button.path.value] || this.Name;
            }
    
            if (finalConfig.button.props) {
              finalConfig.button.props.forEach(p => {
                if (p.type === 'text') buttonProps[p.props_key] = p.value;
                else if (p.type === 'key' && typeof item === 'object') buttonProps[p.props_key] = item[p.value];
              });
            }
    
            this.Button(id, {
              name: buttonText || JSON.stringify(item),
              path: buttonPath,
              props: buttonProps
            });
    
            // Between items separator
            if (custom.showSeparators && i < currentPageItems.length - 1) {
              if (!safeRender(custom.renderSeparator, 'between', paginationData, i)) {
                this.Button(id, { name: custom.separatorBetween });
              }
            }
          });
        } else {
          // Default auto-detect mode
          currentPageItems.forEach((item, i) => {
            let buttonName, buttonProps = {};
    
            if (typeof item === 'object' && item !== null) {
              const keys = Object.keys(item);
              buttonName = keys.length > 0 ? `${keys[0]}: ${item[keys[0]]}` : JSON.stringify(item);
              buttonProps = { ...item };
            } else {
              buttonName = String(item);
              buttonProps = { value: item };
            }
    
            this.Button(id, {
              name: buttonName,
              path: this.Name,
              props: buttonProps
            });
    
            // Between items separator
            if (custom.showSeparators && i < currentPageItems.length - 1) {
              if (!safeRender(custom.renderSeparator, 'between', paginationData, i)) {
                this.Button(id, { name: custom.separatorBetween });
              }
            }
          });
        }
    
        // ============================================================
        // BOTTOM SEPARATOR
        // ============================================================
        if (custom.showSeparators && currentPageItems.length > 0) {
          if (!safeRender(custom.renderSeparator, 'bottom', paginationData)) {
            this.Button(id, { name: custom.separatorBottom });
          }
        }
    
        // ============================================================
        // BLANK SPACE
        // ============================================================
        if (custom.showBlankSpace && currentPageItems.length > 0) {
          if (!safeRender(custom.renderBlankSpace, paginationData)) {
            this.Button(id, { name: ' ' });
          }
        }
    
        // ============================================================
        // PAGE INFO
        // ============================================================
        if (custom.showPageInfo) {
          if (!safeRender(custom.renderPageInfo, paginationData)) {
            const infoText = custom.pageInfoText || 
                            `Page ${storage.actual_page} of ${totalPages}  •  ${data.length} items`;
            
            if (custom.pageInfoStyle === 'button') {
              this.Button(id, { name: infoText });
            } else if (custom.pageInfoStyle === 'text') {
              this.Text(id, infoText);
            }
            // 'none' style doesn't render anything
          }
        }
    
        // ============================================================
        // NAVIGATION CONTROLS
        // ============================================================
        if (custom.showNavigation) {
          if (!safeRender(custom.renderNavigation, paginationData)) {
            const navButtons = [];
    
            if (storage.actual_page > 1) {
              navButtons.push({
                name: custom.prevButtonText,
                props: { [`pagination_prev_${name}`]: true }
              });
            }
    
            // Page indicator — clickable to enter "go to page" mode.
            // Visual design is unchanged: it still renders as a single
            // compact button showing "X / Y", sitting between Prev and
            // Next exactly as before.
            const indicatorText = custom.pageIndicatorText || 
                                 `${storage.actual_page} / ${totalPages}`;
            navButtons.push({
              name: indicatorText,
              props: { [`pagination_goto_${name}`]: true }
            });
    
            if (storage.actual_page < totalPages) {
              navButtons.push({
                name: custom.nextButtonText,
                props: { [`pagination_next_${name}`]: true }
              });
            }
    
            if (navButtons.length > 0) {
              this.Buttons(id, navButtons);
            }
    
            // --------------------------------------------------------
            // INLINE "GO TO PAGE" FIELD (opened by the page indicator)
            // --------------------------------------------------------
            // Clicking the page indicator switches the pagination into
            // "goto" mode, which renders a compact this.Field() right
            // below the navigation row. The user types a page number
            // and presses Enter to jump straight to that page.
            //
            //   • Enter with a valid page number → jump to that page.
            //   • Enter with an empty value      → cancel and return
            //                                       to the normal view.
            //   • Escape (handled by HUD)        → field stays open;
            //                                      pressing Enter then
            //                                      cancels it.
            //
            // The pagination buttons themselves are NOT modified, so
            // the compact layout of the navigation row is preserved.
            // --------------------------------------------------------
            const gotoModeKey = `pagination_goto_mode_${name}`;
            const gotoFieldName = `pagination_goto_field_${name}`;
    
            // Click handler: entering goto mode seeds an empty field
            // so the user can type a fresh page number from scratch.
            // Empty + Enter is the natural "cancel" path.
            if (currentProps[`pagination_goto_${name}`]) {
              delete currentProps[`pagination_goto_${name}`];
              if (totalPages > 1) {
                this.Storages.Set(id, gotoModeKey, true);
                this.Storages.Set(id, `field_${gotoFieldName}`, '');
              }
            }
    
            // Only render the field when it is actually meaningful
            // (more than one page) and goto mode is currently active.
            if (totalPages > 1 && this.Storages.Get(id, gotoModeKey) === true) {
              this.Field(id, gotoFieldName, {
                label: 'Go to page',
                initialValue: '',
                maxWidth: 6,
                onChange: (value) => {
                  // Always leave goto mode so the field disappears on
                  // the next render pass.
                  this.Storages.Set(id, gotoModeKey, false);
    
                  const trimmed = String(value == null ? '' : value).trim();
    
                  // Enter with empty value → cancel and return.
                  if (trimmed === '') return;
    
                  const target = parseInt(trimmed, 10);
                  if (!isNaN(target) && target >= 1 && target <= totalPages) {
                    const currentStorage = this.Storages.Get(id, name);
                    if (currentStorage) {
                      currentStorage.actual_page = target;
                      currentStorage.total_pages = totalPages;
                      this.Storages.Set(id, name, currentStorage);
                    }
                  }
                  // Invalid input → silently cancel; current page kept.
                }
              });
            }
          }
        }
    
        // ============================================================
        // BOTTOM SPACING
        // ============================================================
        if (custom.bottomSpacing > 0) {
          for (let i = 0; i < custom.bottomSpacing; i++) {
            this.Button(id, { name: ' ' });
          }
        }
    
        return {
          actual_page: storage.actual_page,
          total_pages: totalPages,
          items_on_page: currentPageItems.length,
          total_items: data.length,
          start_index: startIndex,
          end_index: Math.min(storage.actual_page * itemsPerPage, data.length),
          paginationData: paginationData
        };
      },
    
      Reset: (id, name) => {
        if (this.Storages.Has(id, name)) {
          this.Storages.Delete(id, name);
          return true;
        }
        return false;
      },
    
      GetState: (id, name) => {
        const storage = this.Storages.Get(id, name);
        return storage ? {
          actual_page: storage.actual_page,
          total_pages: storage.total_pages
        } : {
          actual_page: 1,
          total_pages: 0
        };
      },
    
      SetPage: (id, name, page) => {
        const storage = this.Storages.Get(id, name);
        if (!storage || page < 1 || page > storage.total_pages) return false;
        storage.actual_page = page;
        this.Storages.Set(id, name, storage);
        return true;
      }
    };

    // --------------------------- DropDown Method ---------------------------

    /**
     * Create a dropdown menu
     * @param {string} id - User/build ID
     * @param {string} name - Dropdown name
     * @param {Function} code - Dropdown content code
     * @param {Object} config - Dropdown configuration
     * @param {string} [config.up_buttontext='Show More'] - Button text when closed
     * @param {string} [config.down_buttontext='Hide'] - Button text when open
     * @param {string} [config.down_emoji='▼'] - Emoji for open state
     * @param {string} [config.up_emoji='▶'] - Emoji for closed state
     * @param {boolean} [config.open_colors=true] - Enable colors when open
     * @param {boolean} [config.open_spacement=true] - Enable spacing when open
     * @param {boolean} [config.horizontal=false] - Open horizontally
     * @param {number} [config.jumpTo=1] - Jump to index
     * @returns {Promise<void>}
     */
    this.DropDown = async (id, name, code = async () => { }, config = {
      up_buttontext: 'Show More',
      down_buttontext: 'Hide',
      down_emoji: '▼',
      up_emoji: '▶',
      open_colors: true,
      open_spacement: true,
      horizontal: false,
      jumpTo: 1
    }) => {
      const storageKey = `dropdown-${name}`;

      config = {
        up_buttontext: 'Show More',
        down_buttontext: 'Hide',
        down_emoji: '▼',
        up_emoji: '▶',
        open_colors: true,
        open_spacement: true,
        horizontal: false,
        ...config
      };

      if (config.horizontal) {
        if (config.down_emoji === '▼') config.down_emoji = '▶';
        if (config.up_emoji === '▶') config.up_emoji = '⧾';
      }

      if (!this.Storages.Has(id, storageKey)) {
        this.Storages.Set(id, storageKey, { dropped: false });
      }

      const state = this.Storages.Get(id, storageKey);
      const wasClicked = this.Builds.get(id).Session.ActualProps.droprun === storageKey;

      if (wasClicked) {
        state.dropped = !state.dropped;
        this.Storages.Set(id, storageKey, state);
      }

      const wasHorizontal = this.Builds.get(id).dropdown_horizontal;
      const wasSpacement = this.Builds.get(id).dropdown_spacement;
      const wasColors = this.Builds.get(id).dropdown_color;
      const wasDroplevel = this.Builds.get(id).droplevel || 0;

      if (state.dropped) {
        if (config.horizontal) {
          this.Button(id, {
            name: this.TextColor.orange(`${config.down_emoji} ${config.down_buttontext}`),
            props: { droprun: storageKey }
          });

          const currentButtonCount = this.Builds.get(id).Buttons.length;
          this.Builds.get(id).last_dropdown_button = currentButtonCount - 1;

          this.Builds.get(id).dropdown_horizontal = true;
          if (config.open_colors) this.Builds.get(id).dropdown_color = true;
          if (config.open_spacement) this.Builds.get(id).dropdown_spacement = true;
          this.Builds.get(id).droplevel = (wasDroplevel > 0) ? wasDroplevel + 1 : 1;

          await code();

          this.Builds.get(id).dropdown_horizontal = wasHorizontal;
          if (config.open_colors && this.Builds.get(id).droplevel === 1) {
            this.Builds.get(id).dropdown_color = undefined;
          }
          if (config.open_spacement && this.Builds.get(id).droplevel === 1) {
            this.Builds.get(id).dropdown_spacement = undefined;
          }
          this.Builds.get(id).droplevel = this.Builds.get(id).droplevel - 1;
          this.Builds.get(id).last_dropdown_button = undefined;
        } else {
          this.Button(id, {
            name: this.TextColor.orange(`${config.down_emoji} ${config.down_buttontext}`),
            props: { droprun: storageKey }
          });

          if (config.open_colors) this.Builds.get(id).dropdown_color = true;
          if (config.open_spacement) this.Builds.get(id).dropdown_spacement = true;
          this.Builds.get(id).droplevel = (wasDroplevel > 0) ? wasDroplevel + 1 : 1;

          await code();

          if (config.open_colors && this.Builds.get(id).droplevel === 1) {
            this.Builds.get(id).dropdown_color = undefined;
          }
          if (config.open_spacement && this.Builds.get(id).droplevel === 1) {
            this.Builds.get(id).dropdown_spacement = undefined;
          }
          this.Builds.get(id).droplevel = this.Builds.get(id).droplevel - 1;
        }
      } else {
        const emoji = config.horizontal ? config.up_emoji : config.up_emoji;
        this.Button(id, {
          name: this.TextColor.gold(`${emoji} ${config.up_buttontext}`),
          props: { droprun: storageKey },
          jumpTo: config.jumpTo !== undefined ? config.jumpTo : 1
        });
      }

      if (wasDroplevel === 0 && this.Builds.get(id).droplevel === 0) {
        this.Builds.get(id).dropdown_horizontal = wasHorizontal;
        this.Builds.get(id).dropdown_color = wasColors;
        this.Builds.get(id).dropdown_spacement = wasSpacement;
      }
    };

    // --------------------------- Button Methods ---------------------------

    /**
     * Internal helper: build a normalized button object from a config.
     * Applies dropdown colouring / spacing but does NOT decide where the
     * button is placed (individual line vs horizontal group). Placement
     * is handled by Button / Buttons / SideButton.
     * @private
     */
    this._makeButtonObj = (id, finalConfig) => {
      if (!this.Builds.has(id)) return null;
      if (!finalConfig.path) finalConfig.path = this.Name;

      const button_obj = {
        name: finalConfig.name || '',
        metadata: {
          props: finalConfig.props || {},
          path: finalConfig.path || this.Name,
          resetSelection: finalConfig.resetSelection || false,
          jumpTo: finalConfig.jumpTo || false,
          pinned: finalConfig.pinned || false,
          pinnedTop: finalConfig.pinnedTop || false
        },
        action: (finalConfig.action) ? finalConfig.action : () => { },
      };

      if (this.Builds.get(id).dropdown_color) {
        button_obj.name = this.TextColor.rgb(
          button_obj.name,
          (127 + Math.floor(Math.sin(this.Builds.get(id).droplevel * 1.7) * 128)),
          (127 + Math.floor(Math.cos(this.Builds.get(id).droplevel * 2.3) * 128)),
          (127 + Math.floor(Math.sin(this.Builds.get(id).droplevel * 1.3 + 1.5) * 128))
        );
      }

      if (this.Builds.get(id).dropdown_spacement) {
        let space = '';
        for (let i = 0; i < this.Builds.get(id).droplevel; i++) {
          space = ` ${space}`;
        }
        button_obj.name = `${space}${button_obj.name}`;
      }

      return button_obj;
    };

    /**
     * Internal helper: try to place one or more button objects into the
     * currently-open horizontal-dropdown group.
     * @private
     * @returns {boolean} true if placement happened
     */
    this._placeInHorizontalDropdown = (id, buttonObjs) => {
      const build = this.Builds.get(id);
      if (!build || !build.dropdown_horizontal || build.last_dropdown_button === undefined) {
        return false;
      }

      const buttonsArray = build.Buttons;
      const lastDropdownIndex = build.last_dropdown_button;
      let foundGroup = false;

      for (let i = lastDropdownIndex + 1; i < buttonsArray.length; i++) {
        if (buttonsArray[i].type === 'options') {
          buttonsArray[i].value.push(...buttonObjs);
          foundGroup = true;
          break;
        }
      }

      if (!foundGroup && lastDropdownIndex >= 0 && lastDropdownIndex < buttonsArray.length) {
        const dropdownButton = buttonsArray[lastDropdownIndex];
        if (!dropdownButton.type) {
          buttonsArray[lastDropdownIndex] = {
            type: 'options',
            value: [dropdownButton, ...buttonObjs]
          };
        } else if (dropdownButton.type === 'options') {
          dropdownButton.value.push(...buttonObjs);
        }
      }

      return true;
    };

    /**
     * Create a button that will be rendered on its OWN line.
     *
     * For horizontal rows use `this.Buttons([...])` or `this.SideButton(...)`
     * instead.
     *
     * @param {string} id - User/build ID
     * @param {string|Object} nameOrConfig - Button name or configuration object
     * @param {Object} [config] - Button configuration (when name is string)
     */
    this.Button = (id, nameOrConfig, config = {}, ...rest) => {
      if (!this.Builds.has(id)) {
        if (this.Log) {
          console.log(`This.Button() Error - userBuild not founded | BuildID: ${id}`);
        }
        return;
      }

      let finalConfig;
      if (typeof nameOrConfig === 'string') {
        finalConfig = { name: nameOrConfig, ...config };
        if (rest.length > 0) Object.assign(finalConfig, ...rest);
      } else {
        // Clone so the pin-context inheritance below never mutates a
        // shared config object owned by the caller.
        finalConfig = nameOrConfig ? { ...nameOrConfig } : {};
      }
      if (!finalConfig.path) finalConfig.path = this.Name;

      // Inherit the current pinned container context (set by
      // this.PinnedTop / this.PinnedBottom) when the caller did not
      // explicitly choose a pin target.
      const __build = this.Builds.get(id);
      if (__build && finalConfig.pinned === undefined && finalConfig.pinnedTop === undefined) {
        if (__build._pinContext === 'top') finalConfig.pinnedTop = true;
        else if (__build._pinContext === 'bottom') finalConfig.pinned = true;
      }

      const button_obj = this._makeButtonObj(id, finalConfig);
      if (!button_obj) return;

      // 0) Inside a Grid cell — capture into the cell's own item list.
      if (__build._cellItems) {
        __build._cellItems.push(button_obj);
        return;
      }

      // 1) Inside a horizontal dropdown → merge into that dropdown's group
      if (this._placeInHorizontalDropdown(id, [button_obj])) return;

      // 2) Legacy "buttons: true" flag.
      //
      // LINE-FIX: `_startNewGroup` forces a BRAND NEW options group to
      // open even if the last array entry is already an options group.
      // This is what makes each this.Buttons(...) call render on its own
      // physical line instead of silently merging into the previous one.
      //
      // SideButton() deliberately does NOT set _startNewGroup, so
      // consecutive SideButton calls still accumulate onto the same row.
      if (finalConfig.buttons) {
        const buttonsArray = this.Builds.get(id).Buttons;
        const lastItem = buttonsArray[buttonsArray.length - 1];
        const forceNewGroup = finalConfig._startNewGroup === true;

        if (forceNewGroup || buttonsArray.length === 0 || !lastItem || lastItem.type !== 'options') {
          buttonsArray.push({ type: 'options', value: [button_obj] });
        } else {
          lastItem.value.push(button_obj);
        }
        return;
      }

      // 3) Normal → individual line
      this.Builds.get(id).Buttons.push(button_obj);
    };

    /**
     * Create multiple buttons laid out horizontally on a SINGLE new line.
     *
     * Behaviour contract (line-fix + button-impl):
     *   • Every call produces exactly ONE new options group, so N
     *     separate this.Buttons() calls render as N distinct rows.
     *   • The group is never merged with a previously created options
     *     group — that was the source of the "my second Buttons() call
     *     disappeared into the first one" bug.
     *   • Inside a horizontal dropdown, the buttons are added to the
     *     dropdown's own options group (matching this.Button behaviour).
     *
     * @param {string} id - User/build ID
     * @param {Array<Object>|Object} configs - Button configuration(s)
     */
    this.Buttons = (id, configs = []) => {
      if (!this.Builds.has(id)) {
        if (this.Log) {
          console.log(`this.Buttons() Error - userBuild not found | BuildID: ${id}`);
        }
        return;
      }
      if (!Array.isArray(configs)) configs = [configs];
      if (configs.length === 0) return;

      const __build = this.Builds.get(id);

      const objs = [];
      for (let i = 0; i < configs.length; i++) {
        const cfg = configs[i];
        if (!cfg) continue;
        const finalConfig = { ...cfg };
        if (!finalConfig.path) finalConfig.path = this.Name;
        // Inherit the current pinned container context (set by
        // this.PinnedTop / this.PinnedBottom) when the caller did not
        // explicitly choose a pin target.
        if (__build && finalConfig.pinned === undefined && finalConfig.pinnedTop === undefined) {
          if (__build._pinContext === 'top') finalConfig.pinnedTop = true;
          else if (__build._pinContext === 'bottom') finalConfig.pinned = true;
        }
        // Mark the FIRST item with _startNewGroup, so Button() opens a
        // fresh options row for this call (see Button() step 2).
        if (i === 0) finalConfig._startNewGroup = true;
        const obj = this._makeButtonObj(id, finalConfig);
        if (obj) objs.push(obj);
      }
      if (objs.length === 0) return;

      // Inside a Grid cell — every button in this group becomes part of
      // the cell's horizontal flow.
      if (__build._cellItems) {
        for (const obj of objs) __build._cellItems.push(obj);
        return;
      }

      // Inside a horizontal dropdown → merge into that dropdown's group
      if (this._placeInHorizontalDropdown(id, objs)) return;

      // Normal → ALWAYS create a brand-new options group on its own line
      this.Builds.get(id).Buttons.push({ type: 'options', value: objs });
    };

    /**
     * Create a side button.
     *
     * Consecutive SideButton calls merge into the SAME horizontal row;
     * any other Button / Buttons / Text / Field / DropDown / Page /
     * WaitInput call between two SideButtons starts a fresh row.
     *
     * @param {string} id - User/build ID
     * @param {Object} config - Button configuration
     */
    this.SideButton = (id, config = {}) => {
      if (!this.Builds.has(id)) {
        if (this.Log) {
          console.log(`this.SideButton() Error - userBuild not found | BuildID: ${id}`);
        }
        return;
      }

      const finalConfig = { ...config };
      if (!finalConfig.path) finalConfig.path = this.Name;

      // Inherit the current pinned container context (set by
      // this.PinnedTop / this.PinnedBottom) when the caller did not
      // explicitly choose a pin target.
      const __build = this.Builds.get(id);
      if (__build && finalConfig.pinned === undefined && finalConfig.pinnedTop === undefined) {
        if (__build._pinContext === 'top') finalConfig.pinnedTop = true;
        else if (__build._pinContext === 'bottom') finalConfig.pinned = true;
      }

      const obj = this._makeButtonObj(id, finalConfig);
      if (!obj) return;

      // Inside a Grid cell — capture into the cell's own list.
      if (__build._cellItems) {
        __build._cellItems.push(obj);
        return;
      }

      // Inside a horizontal dropdown → merge into that dropdown's group
      if (this._placeInHorizontalDropdown(id, [obj])) return;

      // SideButtons form their own horizontal row. Consecutive calls
      // append to the same row via the `_sideButtonGroup` tag, so
      // untouched SideButton usage (Error class, NotFounded class)
      // still merges horizontally exactly like before.
      const buttonsArray = this.Builds.get(id).Buttons;
      const last = buttonsArray[buttonsArray.length - 1];
      if (last && last.type === 'options' && last._sideButtonGroup) {
        last.value.push(obj);
      } else {
        buttonsArray.push({
          type: 'options',
          value: [obj],
          _sideButtonGroup: true
        });
      }
    };

    // --------------------------- Text Method ---------------------------

    /**
     * Add text to the display
     * @param {string} id - User/build ID
     * @param {string} text - Text to display
     * @param {Object} [config] - Text configuration
     */
    this.Text = (id, text, config = {}) => {
      if (this.Builds.has(id)) {
        const userBuild = this.Builds.get(id);

        // Inherit the current pinned container context (set by
        // this.PinnedTop / this.PinnedBottom) when the caller did not
        // explicitly choose a pin target.
        const effective = { ...config };
        if (effective.pinned === undefined && effective.pinnedTop === undefined) {
          if (userBuild._pinContext === 'top') effective.pinnedTop = true;
          else if (userBuild._pinContext === 'bottom') effective.pinned = true;
        }

        if (userBuild._cellItems) {
          // Inside a Grid cell — capture text as a cell item.
          userBuild._cellItems.push({
            type: 'cellText',
            text: text,
            action: () => {},
            metadata: { props: {}, path: this.Name }
          })
        } else if (effective.pinnedTop) {
          if (effective.separator !== undefined) {
            userBuild.PinnedTopSeparator = effective.separator
          }
          // Pinned-top text is rendered above the top separator line.
          if (userBuild.PinnedTopText != '') {
            userBuild.PinnedTopText = `${userBuild.PinnedTopText}\n${text}`
          } else {
            userBuild.PinnedTopText = text
          }
        } else if (effective.pinned) {
          if (effective.separator !== undefined) {
            userBuild.PinnedBottomSeparator = effective.separator
          }
          // Pinned text is rendered below the separator, at the bottom of the screen.
          if (userBuild.PinnedText != '') {
            userBuild.PinnedText = `${userBuild.PinnedText}\n${text}`
          } else {
            userBuild.PinnedText = text
          }
        } else {
          if (userBuild.Text != '') {
            userBuild.Text = `${userBuild.Text}\n${text}`
          } else {
            userBuild.Text = text
          }
        }

      } else {
        if (this.Log) { console.log(`This.Text() Error - userBuild not founded | Text : ${text} | BuildID : ${id}`) }
      }

    }

    // --------------------------- WaitInput Method ---------------------------

    /**
     * Wait for user input
     * @param {string} id - User/build ID
     * @param {Object} config - Input configuration
     * @param {string} [config.path] - Path after input
     * @param {Object} [config.props] - Props to pass
     * @param {string} [config.question] - Input question
     * @param {boolean} [config.password=false] - Whether input is password
     */
    this.WaitInput = (id, config = { path: this.Name, props: {}, question: '', password: false }) => {
      this.Builds.get(id).WaitInput = true
      this.Builds.get(id).InputPath = config.path || this.Name
      this.Builds.get(id).InputProps = config.props || {}
      this.Builds.get(id).InputQuestion = config.question || ''
      this.Builds.get(id).InputPassword = config.password || false
    }

    // --------------------------- Field Method ---------------------------

    /**
     * Create a text field in the current build
     * @param {string} id - User/build ID
     * @param {string} name - Unique name for this field (used as storage key)
     * @param {Object} config - Field configuration
     * @param {string} [config.label] - Label displayed next to the field
     * @param {string} [config.initialValue] - Starting value (will be overwritten if stored)
     * @param {Function} [config.onChange] - Callback when value changes (receives new value)
     * @param {number} [config.maxWidth] - Maximum visible characters (default 20)
     */
    this.Field = (id, name, config = {}) => {
        if (!this.Builds.has(id)) return;

        const __build = this.Builds.get(id);

        // Inherit the current pinned container context (set by
        // this.PinnedTop / this.PinnedBottom) when the caller did not
        // explicitly choose a pin target.
        let pinned = config.pinned;
        let pinnedTop = config.pinnedTop;
        if (pinned === undefined && pinnedTop === undefined) {
            if (__build._pinContext === 'top') pinnedTop = true;
            else if (__build._pinContext === 'bottom') pinned = true;
        }

        const storageKey = `field_${name}`;
        let value = this.Storages.Get(id, storageKey);
        if (value === undefined) {
            value = config.initialValue || '';
            this.Storages.Set(id, storageKey, value);
        }

        // Set max display width if provided
        if (config.maxWidth) {
            this._syappInstance.HUD.fieldMaxWidth = config.maxWidth;
        }

        const fieldObj = {
            type: 'field',
            label: config.label || '', // empty if not provided
            value: value,
            // If true, this field is rendered in the pinned-bottom
            // area at the bottom of the screen, below a single separator line.
            pinned: pinned || false,
            // If true, this field is rendered in the pinned-top
            // area at the top of the screen, above a single separator line.
            pinnedTop: pinnedTop || false,
            onChange: (newValue) => {
                this.Storages.Set(id, storageKey, newValue);
                if (typeof config.onChange === 'function') {
                    config.onChange(newValue);
                }
            }
        };

        // Add it as an item in the current build, similar to a button but
        // with type 'field'. Inside a Grid cell it is captured into the
        // cell's own horizontal flow instead.
        if (__build._cellItems) {
            __build._cellItems.push(fieldObj);
        } else {
            __build.Buttons.push(fieldObj);
        }
    };

    // --------------------------- TextButton Method ---------------------------

    /**
     * Create a compact, scrollable text viewer (TextButton).
     *
     * ─── THREE VISUAL STATES ──────────────────────────────────────────
     *   1. IDLE      — not focused. Frame drawn in DIM GREY.
     *   2. FOCUSED   — current item selected via ↑ / ↓ or hovered with
     *                  the mouse. Frame drawn in BRIGHT YELLOW.
     *                  ↑ / ↓ STILL navigate past the box.
     *   3. ACTIVE    — user pressed Enter / clicked while FOCUSED.
     *                  Frame drawn in BRIGHT GREEN. LOCKED:
     *                    • ↑ / ↓       scroll the text (swallowed at edges)
     *                    • Enter       exits back to FOCUSED
     *                    • Escape      exits back to FOCUSED
     *                    • E (letter)  opens the editor (editable only)
     *
     * ─── EDITOR LAUNCH (the reliable path) ────────────────────────────
     *   The E key handler in the HUD calls a bound `openEditor` method
     *   that TextButton stores directly on the item object. That method:
     *     1. Runs on the next macrotask (setImmediate), so the HUD's
     *        keypress handler has fully returned and the terminal is
     *        guaranteed to be idle.
     *     2. Calls this._openTextEditor() to run the full-screen editor.
     *     3. Persists the new value and triggers a Func rebuild so the
     *        box shows the freshly edited content.
     *
     *   This bypasses the event system, LoadScreen re-entry and trigger
     *   props entirely. It is the same code path that this.TextEditor()
     *   ultimately uses (_openTextEditor), just invoked from a different
     *   place — after the menu has been torn down, never during it.
     *
     * Optional config:
     *   lines        {number}   Visual rows to occupy (min 2, default 4).
     *   label        {string}   Label shown in the top border.
     *   initialValue {string}   Initial text (re-seeds when changed).
     *   editable     {boolean}  Enable the E-to-edit shortcut.
     *   onChange     {Function} Invoked with the new text after an edit.
     *   title        {string}   Editor title (defaults to label || name).
     *   pinned       {boolean}  Pin to the pinned-bottom area.
     *   pinnedTop    {boolean}  Pin to the pinned-top area.
     *
     * @param {string} id - User/build ID
     * @param {string} name - Unique name (used as the storage key)
     * @param {Object} [config] - Configuration
     */
    this.TextButton = (id, name, config = {}) => {
        if (!this.Builds.has(id)) {
            if (this.Log) console.log(`this.TextButton() Error - userBuild not found | BuildID: ${id}`);
            return;
        }

        const __build = this.Builds.get(id);

        // Inherit the current pinned container context.
        let pinned = config.pinned;
        let pinnedTop = config.pinnedTop;
        if (pinned === undefined && pinnedTop === undefined) {
            if (__build._pinContext === 'top') pinnedTop = true;
            else if (__build._pinContext === 'bottom') pinned = true;
        }

        const storageKey = `textbutton_${name}`;
        const scrollKey  = `textbutton_scroll_${name}`;
        const seedKey    = `textbutton_seed_${name}`;
        const activeKey  = `textbutton_active_${name}`;

        // ------------------------------------------------------------------
        // initialValue seeding
        // ------------------------------------------------------------------
        const hasInitial = Object.prototype.hasOwnProperty.call(config, 'initialValue');
        const desiredInitial = hasInitial ? String(config.initialValue == null ? '' : config.initialValue) : null;
        const lastSeed = this.Storages.Get(id, seedKey);
        let value = this.Storages.Get(id, storageKey);

        if (value === undefined) {
            value = desiredInitial !== null ? desiredInitial : '';
            this.Storages.Set(id, storageKey, value);
            this.Storages.Set(id, seedKey, value);
        } else if (desiredInitial !== null && lastSeed !== desiredInitial) {
            value = desiredInitial;
            this.Storages.Set(id, storageKey, value);
            this.Storages.Set(id, seedKey, desiredInitial);
            this.Storages.Set(id, scrollKey, 0);
        }

        let scroll = this.Storages.Get(id, scrollKey);
        if (typeof scroll !== 'number' || !isFinite(scroll)) {
            scroll = 0;
            this.Storages.Set(id, scrollKey, scroll);
        }

        const lines = Math.max(2, Math.min(50, parseInt(config.lines, 10) || 4));
        const editable = !!config.editable;
        const activeStored = this.Storages.Get(id, activeKey) === true;

        // Capture references the openEditor method needs. `self` is the
        // SyAPP_Func instance (SelfBuilder, main Func, etc.) so we can
        // reach _openTextEditor, Storages, _syappInstance, Name, etc.
        const self = this;

        const tvItem = {
            type: 'textview',
            name: name,
            label: config.label || '',
            lines: lines,
            editable: editable,
            value: value,
            scroll: scroll,
            storageKey: storageKey,
            scrollKey: scrollKey,
            activeKey: activeKey,
            active: activeStored,
            pinned: pinned || false,
            pinnedTop: pinnedTop || false,
            metadata: {
                props: {},
                path: this.Name,
                resetSelection: false
            },

            // -------- ↑ / ↓ scroll --------
            onScroll: (delta) => {
                const curScroll = self.Storages.Get(id, scrollKey) || 0;
                const v = self.Storages.Get(id, storageKey) || '';
                const w = Math.max(10, (stdout.columns || 80) - 4);
                const wrapped = [];
                const rawLines = String(v).split('\n');
                for (const rawLine of rawLines) {
                    if (rawLine.length === 0) { wrapped.push(''); continue; }
                    for (let i = 0; i < rawLine.length; i += w) {
                        wrapped.push(rawLine.slice(i, i + w));
                    }
                }
                if (wrapped.length === 0) wrapped.push('');
                const contentLines = Math.max(1, lines - 2);
                const maxS = Math.max(0, wrapped.length - contentLines);
                const newScroll = Math.max(0, Math.min(maxS, curScroll + delta));
                if (newScroll === curScroll) return false;
                self.Storages.Set(id, scrollKey, newScroll);
                tvItem.scroll = newScroll;
                return true;
            },

            persistActive: () => {
                self.Storages.Set(id, activeKey, !!tvItem.active);
            },

            onToggle: () => {
                if (tvItem.active) {
                    tvItem.active = false;
                    tvItem.persistActive();
                    return 'deactivated';
                }
                tvItem.active = true;
                tvItem.persistActive();
                return 'activated';
            },

            // -------- Editor launcher --------
            // Called by the HUD's E-key handler (via setImmediate). Runs
            // the editor, persists the result, then triggers a Func
            // rebuild so the box shows the fresh content.
            openEditor: async () => {
                try {
                    // Belt-and-braces: make sure the HUD released every
                    // terminal mode. This should already be done by the
                    // caller, but if anything is left over we clear it
                    // here so the editor always starts clean.
                    if (self._syappInstance && self._syappInstance.HUD) {
                        try { self._syappInstance.HUD.resetTerminalModes(); } catch (_) {}
                        try { self._syappInstance.HUD.cleanupMouseSupport(); } catch (_) {}
                    }
                    try { if (stdin.isRaw) stdin.setRawMode(false); } catch (_) {}

                    // Run the full-screen editor.
                    const newValue = await self._openTextEditor(id, {
                        title: config.title || config.label || name,
                        initialContent: self.Storages.Get(id, storageKey) || ''
                    });

                    if (newValue !== null && newValue !== undefined) {
                        self.Storages.Set(id, storageKey, newValue);
                        // IMPORTANT: seedKey is intentionally NOT
                        // touched here.
                        //
                        // seedKey stores the ORIGINAL config.initialValue
                        // snapshot taken when the TextButton was first
                        // created. TextButton uses it to detect when the
                        // user changes the initialValue in the source
                        // code (in which case the box should reset to
                        // the new initial).
                        //
                        // If we overwrote seedKey with the user's edit,
                        // the very next build pass would see
                        // `desiredInitial !== lastSeed` (because
                        // config.initialValue is still the old default)
                        // and immediately clobber the user's edit with
                        // the stale initialValue.
                        //
                        // Leaving seedKey untouched is what makes
                        // "edit → save → see the new text in the box"
                        // work reliably, while still allowing a genuine
                        // config change to reset the value.
                        self.Storages.Set(id, scrollKey, 0);
                        self.Storages.Set(id, activeKey, false);
                        if (typeof config.onChange === 'function') {
                            try { config.onChange(newValue); } catch (e) { if (self.Log) console.error(e); }
                        }
                    } else {
                        self.Storages.Set(id, activeKey, false);
                    }

                    // Trigger a rebuild of the current function so the
                    // box renders the new content immediately.
                    if (self._syappInstance) {
                        const session = self._syappInstance.Sessions.get(self._syappInstance.MainSessionID);
                        if (session) {
                            // Ensure nothing is holding the lock.
                            session.InAction = false;
                            const liveProps = { ...(session.ActualProps || {}) };
                            self._syappInstance.LoadScreen(self.Name, {
                                props: liveProps
                            }).catch(() => {});
                        }
                    }
                } catch (err) {
                    if (self.Log) console.error('TextButton editor error:', err);
                    // Try to recover the terminal if something went wrong.
                    try { stdout.write('\x1b[?1049l\x1b[?25h'); } catch (_) {}
                    try { if (stdin.isRaw) stdin.setRawMode(false); } catch (_) {}
                }
            }
        };

        if (__build._cellItems) {
            __build._cellItems.push(tvItem);
        } else {
            __build.Buttons.push(tvItem);
        }
    };

    // --------------------------- TextEditor Method ---------------------------

    /**
     * Open a full-screen, nano-like text editor OUTSIDE the func flow.
     *
     * The method behaves like `this.Field()`: it stores its value under
     * `texteditor_<name>` in the user's storage and adds a button to the
     * current build. The button does nothing until clicked — clicking it
     * passes a trigger prop to `LoadScreen`, which flows back into this
     * method on the next Build pass, where the editor opens synchronously
     * (awaited), fully restoring the terminal on exit so the next SyAPP
     * menu renders cleanly without ever locking the terminal.
     *
     * Safe to call as:
     *   const value = await this.TextEditor(uid, 'myfile', { label: 'Notes' })
     *
     * @param {string} id - User/build ID
     * @param {string} name - Unique name for this editor (used as storage key)
     * @param {Object} [config] - Editor configuration
     * @param {string} [config.label] - Label shown on the button
     * @param {string} [config.buttonText] - Custom button text (default: '📝 <label>')
     * @param {string} [config.title] - Title shown inside the editor
     * @param {string} [config.initialValue=''] - Starting content
     * @param {Function} [config.onChange] - Callback invoked when content changes
     * @param {boolean} [config.pinned] - Pin the button to the bottom area
     * @param {boolean} [config.pinnedTop] - Pin the button to the top area
     * @returns {Promise<string>} The current stored value
     */
    this.TextEditor = async (id, name, config = {}) => {
      if (!this.Builds.has(id)) {
        if (this.Log) console.log(`this.TextEditor() Error - userBuild not found | BuildID: ${id}`);
        return '';
      }

      const storageKey = `texteditor_${name}`;
      let value = this.Storages.Get(id, storageKey);
      if (value === undefined) {
        value = config.initialValue || '';
        this.Storages.Set(id, storageKey, value);
      }

      const build = this.Builds.get(id);
      const triggerProp = `__textEditor_${name}`;
      const currentProps = build.Session.ActualProps || {};

      // If the trigger prop is present, the user clicked the button and
      // we now need to open the editor. We do it HERE, inside the build
      // phase, because the terminal is guaranteed to be released by
      // cleanupMenuState() before the next Build pass runs.
      if (currentProps[triggerProp]) {
        delete currentProps[triggerProp];
        try {
          const newValue = await this._openTextEditor(id, {
            title: config.title || config.label || name,
            initialContent: this.Storages.Get(id, storageKey) || ''
          });
          if (newValue !== null && newValue !== undefined) {
            this.Storages.Set(id, storageKey, newValue);
            if (typeof config.onChange === 'function') {
              try {
                config.onChange(newValue);
              } catch (e) {
                if (this.Log) console.error('TextEditor onChange error:', e);
              }
            }
          }
        } catch (err) {
          if (this.Log) console.error('TextEditor error:', err);
        }
      }

      const buttonCfg = {
        name: config.buttonText || `📝 ${config.label || name}`,
        props: { [triggerProp]: true }
      };
      if (config.pinned !== undefined) buttonCfg.pinned = config.pinned;
      if (config.pinnedTop !== undefined) buttonCfg.pinnedTop = config.pinnedTop;
      this.Button(id, buttonCfg);

      return this.Storages.Get(id, storageKey);
    };

    /**
     * Internal: run the nano-like editor. Restores every terminal mode
     * on exit, regardless of how the user leaves the editor.
     * @private
     */
    this._openTextEditor = async (id, config = {}) => {
      const title = String(config.title || 'text');
      const initialContent = String(config.initialContent || '');

      return new Promise((resolve) => {
        // -------- Save terminal state --------
        let wasRaw = false;
        try { wasRaw = !!stdin.isRaw; } catch (_) {}

        const hud = this._syappInstance && this._syappInstance.HUD;
        const mouseWasEnabled = !!(hud && hud.isMouseEnabled);

        // -------- Disable mouse tracking & drop keypress listeners --------
        if (mouseWasEnabled && hud) {
          try { stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'); } catch (_) {}
          try { stdin.removeListener('data', hud.handleMouseData); } catch (_) {}
          hud.isMouseEnabled = false;
        }
        try { stdin.removeAllListeners('keypress'); } catch (_) {}

        // -------- Enter alternate screen, hide cursor --------
        try {
          stdout.write('\x1b[?1049h');
          stdout.write('\x1b[?25l');
          stdout.write('\x1b[2J\x1b[H');
        } catch (_) {}

        // -------- Editor state --------
        let lines = initialContent.length > 0 ? initialContent.split('\n') : [''];
        let cursorRow = 0, cursorCol = 0;
        let scrollRow = 0, scrollCol = 0;
        let modified = false;
        let statusMessage = '';
        let clipboard = null;
        let running = true, finished = false;
        let awaitingConfirm = false;

        const getCols = () => Math.max(20, stdout.columns || 80);
        const getRows = () => Math.max(5, stdout.rows || 24);

        const drawScreen = () => {
          if (finished || !running) return;
          try {
            const cols = getCols();
            const rows = getRows();
            const contentRows = Math.max(1, rows - 3);

            // Keep cursor in the visible window
            if (cursorRow < scrollRow) scrollRow = cursorRow;
            if (cursorRow >= scrollRow + contentRows) scrollRow = cursorRow - contentRows + 1;
            if (scrollRow < 0) scrollRow = 0;

            if (cursorCol < scrollCol) scrollCol = cursorCol;
            if (cursorCol >= scrollCol + cols) scrollCol = cursorCol - cols + 1;
            if (scrollCol < 0) scrollCol = 0;

            const out = [];

            // Header
            out.push('\x1b[H');
            const modTag = modified ? ' [Modified]' : '';
            const hLeft = ` ${title}${modTag}`;
            const hRight = ` Ln ${cursorRow + 1}, Col ${cursorCol + 1} `;
            let hPad = cols - hLeft.length - hRight.length;
            if (hPad < 0) hPad = 0;
            out.push('\x1b[7m' + hLeft + (hPad > 0 ? ' '.repeat(hPad) : '') + hRight + '\x1b[0m');

            // Content
            for (let i = 0; i < contentRows; i++) {
              out.push('\x1b[' + (i + 2) + ';1H\x1b[2K');
              const lineIdx = scrollRow + i;
              if (lineIdx < lines.length) {
                let display = lines[lineIdx];
                if (scrollCol > 0) display = display.slice(scrollCol);
                if (display.length > cols) display = display.slice(0, cols);
                out.push(display);
              }
            }

            // Status line
            out.push('\x1b[' + (rows - 1) + ';1H\x1b[2K\x1b[7m');
            let sDisp = statusMessage || '';
            if (sDisp.length > cols) sDisp = sDisp.slice(0, cols);
            out.push(sDisp + (sDisp.length < cols ? ' '.repeat(cols - sDisp.length) : ''));
            out.push('\x1b[0m');

            // Help line
            out.push('\x1b[' + rows + ';1H\x1b[2K\x1b[7m');
            const helpText = '^S Save  ^X Exit  ^K Cut line  ^U Paste  Arrows: Move';
            let hDisp = helpText.length > cols ? helpText.slice(0, cols) : helpText;
            out.push(hDisp + (hDisp.length < cols ? ' '.repeat(cols - hDisp.length) : ''));
            out.push('\x1b[0m');

            // Position cursor & show
            const sRow = cursorRow - scrollRow + 2;
            const sCol = cursorCol - scrollCol + 1;
            out.push('\x1b[' + sRow + ';' + sCol + 'H');
            out.push('\x1b[?25h');

            stdout.write(out.join(''));
          } catch (_) { /* ignore draw errors */ }
        };

        const setStatus = (msg, ms = 0) => {
          statusMessage = msg;
          drawScreen();
          if (ms > 0) {
            setTimeout(() => {
              if (running && statusMessage === msg) {
                statusMessage = '';
                drawScreen();
              }
            }, ms);
          }
        };

        const cleanup = () => {
          try { stdin.removeListener('data', handleData); } catch (_) {}
          try { stdout.removeListener('resize', handleResize); } catch (_) {}
        };

        const finish = (result) => {
          if (finished) return;
          finished = true;
          running = false;
          cleanup();

          // Leave alternate buffer
          try {
            stdout.write('\x1b[?25l');
            stdout.write('\x1b[?1049l');
          } catch (_) {}

          // Restore raw mode to exactly what it was
          try {
            if (stdin.isRaw !== wasRaw) stdin.setRawMode(wasRaw);
          } catch (_) {}

          // Make sure cursor is visible
          try { stdout.write('\x1b[?25h'); } catch (_) {}

          resolve(result);
        };

        const handleData = (data) => {
          if (finished || !running || awaitingConfirm) return;
          const str = data.toString();
          if (str.length === 0) return;

          // ---- Ctrl+X: exit (with save prompt when dirty) ----
          if (str === '\x18') {
            if (modified) {
              awaitingConfirm = true;
              setStatus('Save modified buffer? (Y/N, Esc=Cancel)');
              const confirm = (d2) => {
                stdin.removeListener('data', confirm);
                awaitingConfirm = false;
                const s2 = d2.toString();
                if (s2 === 'y' || s2 === 'Y') {
                  finish(lines.join('\n'));
                } else if (s2 === 'n' || s2 === 'N') {
                  finish(null);
                } else {
                  statusMessage = '';
                  drawScreen();
                }
              };
              stdin.once('data', confirm);
              return;
            }
            finish(lines.join('\n'));
            return;
          }

          // ---- Ctrl+S: mark saved, keep editing ----
          if (str === '\x13') {
            modified = false;
            setStatus('Saved', 800);
            return;
          }

          // ---- Ctrl+K: cut line ----
          if (str === '\x0b') {
            clipboard = lines[cursorRow];
            lines.splice(cursorRow, 1);
            if (lines.length === 0) lines.push('');
            if (cursorRow >= lines.length) cursorRow = lines.length - 1;
            cursorCol = Math.min(cursorCol, (lines[cursorRow] || '').length);
            modified = true;
            drawScreen();
            return;
          }

          // ---- Ctrl+U: uncut / paste line ----
          if (str === '\x15') {
            if (clipboard !== null) {
              lines.splice(cursorRow, 0, clipboard);
              cursorRow++;
              cursorCol = 0;
              modified = true;
              drawScreen();
            }
            return;
          }

          // ---- Ctrl+C / Ctrl+D: exit without saving ----
          if (str === '\x03' || str === '\x04') {
            finish(null);
            return;
          }

          // ---- Escape sequences (arrows, home, end, delete) ----
          if (str[0] === '\x1b') {
            if (str[1] === '[') {
              const last = str[str.length - 1];
              if (last === 'A') {
                if (cursorRow > 0) cursorRow--;
                cursorCol = Math.min(cursorCol, (lines[cursorRow] || '').length);
              } else if (last === 'B') {
                if (cursorRow < lines.length - 1) cursorRow++;
                cursorCol = Math.min(cursorCol, (lines[cursorRow] || '').length);
              } else if (last === 'C') {
                const l = lines[cursorRow] || '';
                if (cursorCol < l.length) cursorCol++;
                else if (cursorRow < lines.length - 1) { cursorRow++; cursorCol = 0; }
              } else if (last === 'D') {
                if (cursorCol > 0) cursorCol--;
                else if (cursorRow > 0) { cursorRow--; cursorCol = (lines[cursorRow] || '').length; }
              } else if (last === 'H') {
                cursorCol = 0;
              } else if (last === 'F') {
                cursorCol = (lines[cursorRow] || '').length;
              } else if (last === '~') {
                const mid = str.slice(2, -1);
                if (mid === '1') cursorCol = 0;
                else if (mid === '4') cursorCol = (lines[cursorRow] || '').length;
                else if (mid === '3') {
                  const l = lines[cursorRow] || '';
                  if (cursorCol < l.length) {
                    lines[cursorRow] = l.slice(0, cursorCol) + l.slice(cursorCol + 1);
                    modified = true;
                  } else if (cursorRow < lines.length - 1) {
                    lines[cursorRow] = l + lines[cursorRow + 1];
                    lines.splice(cursorRow + 1, 1);
                    modified = true;
                  }
                }
              }
            }
            drawScreen();
            return;
          }

          // ---- Printable characters, Enter, Backspace, Tab ----
          let needRedraw = false;
          for (const ch of str) {
            const code = ch.charCodeAt(0);
            if (ch === '\r' || ch === '\n') {
              const l = lines[cursorRow] || '';
              lines[cursorRow] = l.slice(0, cursorCol);
              lines.splice(cursorRow + 1, 0, l.slice(cursorCol));
              cursorRow++;
              cursorCol = 0;
              modified = true;
              needRedraw = true;
            } else if (ch === '\x7f' || ch === '\b') {
              const l = lines[cursorRow] || '';
              if (cursorCol > 0) {
                lines[cursorRow] = l.slice(0, cursorCol - 1) + l.slice(cursorCol);
                cursorCol--;
                modified = true;
                needRedraw = true;
              } else if (cursorRow > 0) {
                const prev = lines[cursorRow - 1];
                cursorCol = prev.length;
                lines[cursorRow - 1] = prev + l;
                lines.splice(cursorRow, 1);
                cursorRow--;
                modified = true;
                needRedraw = true;
              }
            } else if (code === 9) {
              const l = lines[cursorRow] || '';
              lines[cursorRow] = l.slice(0, cursorCol) + '    ' + l.slice(cursorCol);
              cursorCol += 4;
              modified = true;
              needRedraw = true;
            } else if (code >= 32 && code < 127) {
              const l = lines[cursorRow] || '';
              lines[cursorRow] = l.slice(0, cursorCol) + ch + l.slice(cursorCol);
              cursorCol++;
              modified = true;
              needRedraw = true;
            }
          }
          if (needRedraw) drawScreen();
        };

        const handleResize = () => {
          if (running) drawScreen();
        };

        // -------- Attach input --------
        try {
          stdin.setRawMode(true);
          stdin.resume();
          stdin.on('data', handleData);
        } catch (e) {
          finish(null);
          return;
        }

        try { stdout.on('resize', handleResize); } catch (_) {}

        // -------- First draw --------
        drawScreen();
      });
    };

    // --------------------------- Cells Method ---------------------------

    /**
     * Column index → letter (0=A, 1=B, ..., 25=Z, 26=AA, ...)
     * @private
     */
    this._cellsColLabel = (idx) => {
      let label = '';
      let n = Math.max(0, idx | 0);
      while (n >= 0) {
        label = String.fromCharCode(65 + (n % 26)) + label;
        n = Math.floor(n / 26) - 1;
      }
      return label;
    };

    /**
     * Cell reference "A1" → { row, col } (0-based). null on bad input.
     * @private
     */
    this._cellsParseRef = (ref) => {
      // Case-insensitive: "A1", "a1" and "Aa1" all parse identically.
      // `$` lock markers ($A$1, $A1, A$1) are stripped so the goto
      // prompt can accept absolute-style references too.
      const m = String(ref).replace(/\$/g, '').match(/^([A-Za-z]+)(\d+)$/);
      if (!m) return null;
      let col = 0;
      for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
      return { col: col - 1, row: parseInt(m[2], 10) - 1 };
    };

    /**
     * (row, col) → cell reference string like "A1"
     * @private
     */
    this._cellsRefFromRC = (row, col) => `${this._cellsColLabel(col)}${row + 1}`;

    /**
     * Recompute the value of every cell. Formula cells (raw starting
     * with "=") are evaluated as PURE JavaScript with `with(cells)`, so
     * any cell reference (A1, B2, ...) is available as a bare identifier
     * and every JS operator/builtin works. Iterates until stable or 10
     * rounds (enough for typical dependency chains; cycles show as the
     * last computed value with no error, matching spreadsheet grace).
     * @private
     */
    this._cellsEvaluate = (state) => {
      const raw = state.cells || {};
      const result = {};

      // Pass 1 — literals
      for (const [ref, cell] of Object.entries(raw)) {
        const upper = String(ref).toUpperCase();
        const r = String(cell && cell.raw != null ? cell.raw : '');
        if (r.startsWith('=')) {
          result[upper] = { formula: r.slice(1), value: undefined, display: '…', error: null };
        } else {
          let v = r;
          if (r !== '' && !isNaN(Number(r))) v = Number(r);
          result[upper] = { value: v, display: r, error: null };
        }
      }

      // Pass 2+ — formulas, iterate until stable
      let changed = true, iter = 0;
      while (changed && iter < 10) {
        changed = false; iter++;
        const scope = {};
        for (const ref of Object.keys(result)) {
          // Case-insensitive access: both "A1" and "a1" resolve to the
          // same cell, so formulas may be written with any casing the
          // user prefers (`=a1+1` is now equivalent to `=A1+1`).
          const desc = {
            get() { const c = result[ref]; return c ? c.value : undefined; },
            enumerable: true, configurable: true
          };
          Object.defineProperty(scope, ref, desc);
          const lower = ref.toLowerCase();
          if (lower !== ref) {
            Object.defineProperty(scope, lower, desc);
          }

          // Absolute-style aliases: register $A$1, $A1 and A$1 as
          // read-only aliases pointing to the same cell. This makes
          // `=$B$1*2` (plain formula) and `` =`${$B$1}` `` (template
          // literal) both resolve to the same value, matching exactly
          // the shift-time behaviour of shiftFormulaRefs().
          const rm = ref.match(/^([A-Z]+)(\d+)$/);
          if (rm) {
            const col = rm[1], row = rm[2];
            const variants = [
              '$' + col + '$' + row,
              '$' + col + row,
              col + '$' + row
            ];
            for (const v of variants) {
              if (v === ref) continue;
              try { Object.defineProperty(scope, v, desc); } catch (_) {}
              const vl = v.toLowerCase();
              if (vl !== v) {
                try { Object.defineProperty(scope, vl, desc); } catch (_) {}
              }
            }
          }
        }
        // get()/cell() also accept $-prefixed references.
        scope.get = (r) => {
          const key = String(r).toUpperCase().replace(/\$/g, '');
          const c = result[key];
          return c ? c.value : undefined;
        };
        scope.cell = scope.get;

        for (const [ref, cell] of Object.entries(result)) {
          if (cell.formula === undefined) continue;
          try {
            const fn = new Function('cells', `with(cells){ return (${cell.formula}); }`);
            const val = fn(scope);
            if (cell.value !== val || cell.error !== null) {
              cell.value = val;
              cell.display = val == null ? '' : String(val);
              cell.error = null;
              changed = true;
            }
          } catch (e) {
            if (cell.error !== e.message) {
              cell.error = e.message;
              cell.display = '#ERR';
              changed = true;
            }
          }
        }
      }
      return result;
    };

    /**
     * Full-screen cells grid editor. Mirrors the TextEditor pattern so
     * the terminal is fully restored on exit, and the HUD menu is never
     * left in an inconsistent state. Supports:
     *   • frozen column header (A, B, C, …) and row header (1, 2, 3, …)
     *   • aligned horizontal + vertical scrolling (all rows scroll together)
     *   • pure-JS formulas with cross-cell access via `with(cells)`
     *   • auto-extend: moving past the last row/column grows the sheet
     * @private
     */
    this._openCellsEditor = async (id, name, config = {}) => {
      const storageKey = `cells_${name}`;
      const state = this.Storages.Get(id, storageKey);
      if (!state) return;

      return new Promise((resolve) => {
        // ---- Save terminal state ----
        let wasRaw = false;
        try { wasRaw = !!stdin.isRaw; } catch (_) {}
        const hud = this._syappInstance && this._syappInstance.HUD;
        const mouseWasEnabled = !!(hud && hud.isMouseEnabled);

        if (mouseWasEnabled && hud) {
          try { stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'); } catch (_) {}
          try { stdin.removeListener('data', hud.handleMouseData); } catch (_) {}
          hud.isMouseEnabled = false;
        }
        try { stdin.removeAllListeners('keypress'); } catch (_) {}

        try {
          stdout.write('\x1b[?1049h');
          stdout.write('\x1b[?25l');
          stdout.write('\x1b[2J\x1b[H');
        } catch (_) {}

        // ---- Editor state ----
        let cursorRow = state.cursorRow || 0;
        let cursorCol = state.cursorCol || 0;
        let scrollRow = 0;
        let scrollCol = 0;
        let editing = false;
        let editBuffer = '';
        let editCursor = 0;
        let running = true;
        let finished = false;
        let statusMessage = '';

        // ---- RIGID DRAW LOCK ----
        // Prevents two draws from interleaving when a resize fires while
        // an edit is committing, or when a key handler triggers a draw
        // that races the debounced resize. Overlapping writes are the
        // root cause of the "duplicated last line" artifact the user
        // reported while scrolling: without this, a second draw could
        // begin writing at row 1 while the first draw was still on the
        // last data row, leaving an orphaned line behind the status bar.
        let drawLock = false;

        // ---- SELECTION STATE ----
        // anchorRow/anchorCol pin one corner of the current range. When
        // selectMode is false, the anchor silently follows the cursor
        // (single-cell mode). Shift+Arrow turns selectMode on and pins
        // the anchor; the cursor keeps moving and the highlighted
        // rectangle spans between the two. Escape cancels.
        let selectMode = false;
        let anchorRow = cursorRow;
        let anchorCol = cursorCol;

        // ---- GOTO MODE ----
        // Inline prompt opened by Ctrl+G / F5. Accepts A1, AA12, etc.
        let gotoMode = false;
        let gotoBuffer = '';

        const cellWidth = 10;
        const rowHeaderWidth = 5;
        const colStep = cellWidth + 1;

        let computed = this._cellsEvaluate(state);

        const getCols = () => Math.max(20, stdout.columns || 80);
        const getRows = () => Math.max(6, stdout.rows || 24);
        // Reserve one spare column (the trailing `- 1`) so a perfectly
        // sized row never reaches the terminal's exact column count.
        // Writing exactly `cols` characters makes many terminals wrap
        // the cursor to the next physical line, which produces exactly
        // the "extra/duplicated line" artifact the user reported.
        const visibleCols = () => Math.max(1, Math.floor((getCols() - rowHeaderWidth - 1) / colStep));
        const visibleRows = () => Math.max(1, getRows() - 4);

        // ---- Selection helpers -------------------------------------------------
        const getSelectionRect = () => {
          const r1 = Math.min(anchorRow, cursorRow);
          const r2 = Math.max(anchorRow, cursorRow);
          const c1 = Math.min(anchorCol, cursorCol);
          const c2 = Math.max(anchorCol, cursorCol);
          return { r1, r2, c1, c2 };
        };

        const isInSelection = (r, c) => {
          if (!selectMode) return false;
          const { r1, r2, c1, c2 } = getSelectionRect();
          return r >= r1 && r <= r2 && c >= c1 && c <= c2;
        };

        const clearSelection = () => {
          selectMode = false;
          anchorRow = cursorRow;
          anchorCol = cursorCol;
        };

        // Shift every A1-style reference in a formula by (dRow, dCol),
        // supporting:
        //   • $ lock markers:  $A1  (col locked),  A$1  (row locked),
        //                       $A$1 (both locked)
        //   • template literals: only refs inside ${...} interpolations
        //                        are shifted; the surrounding template
        //                        string portions are copied verbatim, so
        //                        a literal `$` (e.g. `$${A1}` → `$` + A1)
        //                        is never mistaken for a lock marker and
        //                        `${` is always detected correctly even
        //                        when preceded by another `$`.
        // Case-insensitive: `a1+2` is treated like `A1+2`; output refs
        // are always uppercased.
        const shiftFormulaRefs = (formula, dRow, dCol) => {
          if (!formula) return formula;

          const shiftRef = (colLock, col, rowLock, row) => {
            let colNum = 0;
            for (const ch of col.toUpperCase()) colNum = colNum * 26 + (ch.charCodeAt(0) - 64);
            colNum -= 1;
            const newCol = colLock ? colNum : colNum + dCol;
            const newRow = rowLock ? parseInt(row, 10) - 1 : parseInt(row, 10) - 1 + dRow;
            if (newCol < 0 || newRow < 0) return `${colLock}${col}${rowLock}${row}`;
            return `${colLock}${this._cellsColLabel(newCol)}${rowLock}${newRow + 1}`;
          };

          const isIdentChar = (ch) => !!ch && /[A-Za-z0-9_]/.test(ch);

          // Walk a plain-code region, shifting any refs found inside it.
          const processCode = (code) => {
            let out = '';
            let i = 0;
            while (i < code.length) {
              const before = i > 0 ? code[i - 1] : '';
              if (isIdentChar(before)) { out += code[i]; i++; continue; }
              const rest = code.slice(i);
              const m = rest.match(/^(\$?)([A-Za-z]+)(\$?)(\d+)/);
              if (m && !isIdentChar(code[i + m[0].length])) {
                out += shiftRef(m[1], m[2], m[3], m[4]);
                i += m[0].length;
                continue;
              }
              out += code[i];
              i++;
            }
            return out;
          };

          let out = '';
          let i = 0;
          const n = formula.length;
          while (i < n) {
            const c = formula[i];

            // Plain string literal → copy verbatim.
            if (c === '"' || c === "'") {
              const start = i;
              const delim = c;
              i++;
              while (i < n) {
                if (formula[i] === '\\') { i += 2; continue; }
                if (formula[i] === delim) { i++; break; }
                i++;
              }
              out += formula.slice(start, i);
              continue;
            }

            // Template literal → copy verbatim except inside ${...}.
            if (c === '`') {
              out += '`';
              i++;
              while (i < n) {
                if (formula[i] === '\\') {
                  out += formula.slice(i, i + 2);
                  i += 2;
                  continue;
                }
                if (formula[i] === '`') {
                  out += '`';
                  i++;
                  break;
                }
                if (formula[i] === '$' && formula[i + 1] === '{') {
                  out += '${';
                  i += 2;
                  // Scan forward to the matching close brace, skipping
                  // any inner strings so braces inside them don't count.
                  let depth = 1;
                  const exprStart = i;
                  while (i < n && depth > 0) {
                    const ch = formula[i];
                    if (ch === '"' || ch === "'") {
                      const d = ch;
                      i++;
                      while (i < n) {
                        if (formula[i] === '\\') { i += 2; continue; }
                        if (formula[i] === d) { i++; break; }
                        i++;
                      }
                      continue;
                    }
                    if (ch === '{') depth++;
                    else if (ch === '}') {
                      depth--;
                      if (depth === 0) break;
                    }
                    i++;
                  }
                  const expr = formula.slice(exprStart, i);
                  out += processCode(expr);
                  if (i < n && formula[i] === '}') { out += '}'; i++; }
                  continue;
                }
                out += formula[i];
                i++;
              }
              continue;
            }

            // Plain code region — collect up to the next string start.
            const codeStart = i;
            while (i < n && formula[i] !== '"' && formula[i] !== "'" && formula[i] !== '`') i++;
            out += processCode(formula.slice(codeStart, i));
          }

          return out;
        };

        // -----------------------------------------------------------------
        // FORMULA PATTERN DETECTION
        // -----------------------------------------------------------------
        // Given two consecutive formulas F1 and F2 in the fill direction,
        // try to detect the implicit series they describe, and return a
        // generator function `gen(k)` that yields the k-th formula
        // (gen(0) ≡ F1, gen(1) ≡ F2, gen(2) ≡ F3, ...). Returns null
        // when the two formulas do not describe a consistent pattern.
        //
        // Examples (fill down):
        //   F1 = "=A1+2",      F2 = "=A2+4"       → gen(2) = "=A3+6"
        //   F1 = "=A1*B1",     F2 = "=A2*B2"      → gen(2) = "=A3*B3"
        //   F1 = "=SUM(A1:A5)",F2 = "=SUM(A2:A6)" → gen(2) = "=SUM(A3:A7)"
        //   F1 = "=A1+A2+A3",  F2 = "=A2+A3+A4"   → gen(2) = "=A3+A4+A5"
        //
        // The detector requires:
        //   • identical placeholder structure after ref/number extraction;
        //   • same number of refs and same number of constants;
        //   • every ref shifted consistently along the fill axis
        //     (columns unchanged for row-fill, rows unchanged for col-fill);
        //   • every ref actually moving (axis delta ≠ 0);
        //   • a constant delta for each extracted constant (constants may
        //     evolve independently, so `=A1+2*3` → `=A2+4*5` produces
        //     deltas [2, 2] and extrapolates cleanly).
        // -----------------------------------------------------------------
        const detectFormulaPattern = (F1, F2, axis) => {
          const parseFormula = (f) => {
            const body = f.startsWith('=') ? f.slice(1) : f;
            const constants = [];
            const refs = [];
            let structure = body;

            // Extract cell references first (case-insensitive), replacing
            // each with a unique null-byte-delimited placeholder so the
            // structure can never collide with a real token in the formula.
            structure = structure.replace(/\b([A-Za-z]+)(\d+)\b/g, (m, col, row) => {
              let colNum = 0;
              for (const ch of col.toUpperCase()) colNum = colNum * 26 + (ch.charCodeAt(0) - 64);
              const idx = refs.length;
              refs.push({ colNum: colNum - 1, row: parseInt(row, 10) - 1 });
              return `\x00R${idx}\x00`;
            });

            // Extract standalone numeric constants (any remaining digit
            // sequence after refs have been removed).
            structure = structure.replace(/\b\d+(?:\.\d+)?\b/g, (m) => {
              const idx = constants.length;
              constants.push(parseFloat(m));
              return `\x00N${idx}\x00`;
            });

            return { structure, constants, refs };
          };

          const p1 = parseFormula(F1);
          const p2 = parseFormula(F2);

          if (p1.structure !== p2.structure) return null;
          if (p1.refs.length !== p2.refs.length) return null;
          if (p1.constants.length !== p2.constants.length) return null;

          // Verify consistent ref deltas along the fill axis.
          let dRow = 0, dCol = 0;
          if (p1.refs.length > 0) {
            const r1 = p1.refs[0], r2 = p2.refs[0];
            dRow = r2.row - r1.row;
            dCol = r2.colNum - r1.colNum;
            for (let i = 1; i < p1.refs.length; i++) {
              const a = p1.refs[i], b = p2.refs[i];
              if ((b.row - a.row) !== dRow) return null;
              if ((b.colNum - a.colNum) !== dCol) return null;
            }
          }

          if (axis === 'row') {
            if (dCol !== 0) return null; // refs must move only vertically
            if (dRow === 0) return null; // and must actually move
          } else {
            if (dRow !== 0) return null; // refs must move only horizontally
            if (dCol === 0) return null; // and must actually move
          }

          // Constant deltas between F1 and F2. Different constants may
          // evolve independently, so we keep a delta per constant index.
          const constDeltas = p1.constants.map((c, i) => p2.constants[i] - c);

          return (k) => {
            let result = p1.structure;
            for (let i = 0; i < p1.refs.length; i++) {
              const r = p1.refs[i];
              const newRow = r.row + k * dRow;
              const newCol = r.colNum + k * dCol;
              if (newRow < 0 || newCol < 0) return null;
              const ref = this._cellsRefFromRC(newRow, newCol);
              result = result.replace(`\x00R${i}\x00`, () => ref);
            }
            for (let i = 0; i < p1.constants.length; i++) {
              const v = p1.constants[i] + k * constDeltas[i];
              result = result.replace(`\x00N${i}\x00`, () => String(v));
            }
            return '=' + result;
          };
        };

        // ---- Fill down --------------------------------------------------------
        // Replicates the top row of the selection downward. Per column, in
        // priority order:
        //   1. Formula pattern detected from the first TWO rows (e.g.
        //      `=A1+2` → `=A2+4` continues as `=A3+6`, `=A4+8`, ...):
        //      both refs and numeric constants evolve together.
        //   2. Plain formula ref shift (classic Ctrl+D): only refs move,
        //      constants stay frozen.
        //   3. Numeric pairs: arithmetic progression continues.
        //   4. Empty source: destination is cleared.
        //   5. Anything else: verbatim copy.
        // All comparisons are case-insensitive, so `=a1+2` and `=A1+2`
        // are interchangeable both when detecting and when generating.
        const fillDown = () => {
          if (!selectMode) {
            setStatus('Select a range first (Shift+Arrows)', 2000);
            drawScreen();
            return;
          }
          const { r1, r2, c1, c2 } = getSelectionRect();
          if (r2 <= r1) {
            setStatus('Need more than one row to fill down', 2000);
            drawScreen();
            return;
          }
          if (!state.cells) state.cells = {};

          for (let c = c1; c <= c2; c++) {
            const srcRef = this._cellsRefFromRC(r1, c);
            const srcCell = state.cells[srcRef];
            const srcRaw = srcCell ? (srcCell.raw || '') : '';
            const isFormula = srcRaw.startsWith('=');

            // --- Pattern detection: needs a second formula row below ---
            // Look at the cell directly below the source and, if it also
            // contains a formula, try to derive an extrapolation function
            // from the (F1, F2) pair. Otherwise fall back to simple shift.
            let formulaGen = null;
            if (isFormula && r2 >= r1 + 1) {
              const secondRef = this._cellsRefFromRC(r1 + 1, c);
              const secondCell = state.cells[secondRef];
              const secondRaw = secondCell ? (secondCell.raw || '') : '';
              if (secondRaw.startsWith('=')) {
                formulaGen = detectFormulaPattern(srcRaw, secondRaw, 'row');
              }
            }

            // --- Numeric series detection (existing behaviour) ---
            const srcNum = (!isFormula && srcRaw !== '' && !isNaN(Number(srcRaw)))
              ? Number(srcRaw) : null;
            let increment = null;
            if (srcNum !== null) {
              const secondRef = this._cellsRefFromRC(r1 + 1, c);
              const secondCell = state.cells[secondRef];
              const secondRaw = secondCell ? (secondCell.raw || '') : '';
              const secondNum = (secondRaw !== '' && !isNaN(Number(secondRaw)))
                ? Number(secondRaw) : null;
              if (secondNum !== null) increment = secondNum - srcNum;
            }

            for (let r = r1 + 1; r <= r2; r++) {
              const dstRef = this._cellsRefFromRC(r, c);

              // 1. Formula pattern extrapolation (highest priority)
              if (formulaGen) {
                const generated = formulaGen(r - r1);
                if (generated) {
                  state.cells[dstRef] = { raw: generated };
                  continue;
                }
              }

              // 2. Classic formula ref shift (constants frozen)
              if (isFormula) {
                state.cells[dstRef] = { raw: '=' + shiftFormulaRefs(srcRaw.slice(1), r - r1, 0) };
              } else if (increment !== null) {
                // 3. Numeric arithmetic progression
                state.cells[dstRef] = { raw: String(srcNum + increment * (r - r1)) };
              } else if (srcRaw === '') {
                // 4. Empty source: clear the destination
                delete state.cells[dstRef];
              } else {
                // 5. Verbatim copy
                state.cells[dstRef] = { raw: srcRaw };
              }
            }
          }
          this.Storages.Set(id, storageKey, state);
          computed = this._cellsEvaluate(state);
          setStatus('✓ Filled down', 1200);
          drawScreen();
        };

        // ---- Fill right -------------------------------------------------------
        // Mirrors fillDown on the column axis. The same pattern detection
        // applies, e.g. `=A1+2` → `=B1+4` continues as `=C1+6`, `=D1+8`.
        const fillRight = () => {
          if (!selectMode) {
            setStatus('Select a range first (Shift+Arrows)', 2000);
            drawScreen();
            return;
          }
          const { r1, r2, c1, c2 } = getSelectionRect();
          if (c2 <= c1) {
            setStatus('Need more than one column to fill right', 2000);
            drawScreen();
            return;
          }
          if (!state.cells) state.cells = {};

          for (let r = r1; r <= r2; r++) {
            const srcRef = this._cellsRefFromRC(r, c1);
            const srcCell = state.cells[srcRef];
            const srcRaw = srcCell ? (srcCell.raw || '') : '';
            const isFormula = srcRaw.startsWith('=');

            // --- Pattern detection from the first two columns ---
            let formulaGen = null;
            if (isFormula && c2 >= c1 + 1) {
              const secondRef = this._cellsRefFromRC(r, c1 + 1);
              const secondCell = state.cells[secondRef];
              const secondRaw = secondCell ? (secondCell.raw || '') : '';
              if (secondRaw.startsWith('=')) {
                formulaGen = detectFormulaPattern(srcRaw, secondRaw, 'col');
              }
            }

            // --- Numeric series detection ---
            const srcNum = (!isFormula && srcRaw !== '' && !isNaN(Number(srcRaw)))
              ? Number(srcRaw) : null;
            let increment = null;
            if (srcNum !== null) {
              const secondRef = this._cellsRefFromRC(r, c1 + 1);
              const secondCell = state.cells[secondRef];
              const secondRaw = secondCell ? (secondCell.raw || '') : '';
              const secondNum = (secondRaw !== '' && !isNaN(Number(secondRaw)))
                ? Number(secondRaw) : null;
              if (secondNum !== null) increment = secondNum - srcNum;
            }

            for (let c = c1 + 1; c <= c2; c++) {
              const dstRef = this._cellsRefFromRC(r, c);

              // 1. Formula pattern extrapolation
              if (formulaGen) {
                const generated = formulaGen(c - c1);
                if (generated) {
                  state.cells[dstRef] = { raw: generated };
                  continue;
                }
              }

              // 2. Classic formula ref shift (constants frozen)
              if (isFormula) {
                state.cells[dstRef] = { raw: '=' + shiftFormulaRefs(srcRaw.slice(1), 0, c - c1) };
              } else if (increment !== null) {
                // 3. Numeric arithmetic progression
                state.cells[dstRef] = { raw: String(srcNum + increment * (c - c1)) };
              } else if (srcRaw === '') {
                // 4. Clear
                delete state.cells[dstRef];
              } else {
                // 5. Verbatim copy
                state.cells[dstRef] = { raw: srcRaw };
              }
            }
          }
          this.Storages.Set(id, storageKey, state);
          computed = this._cellsEvaluate(state);
          setStatus('✓ Filled right', 1200);
          drawScreen();
        };

        // ---- Clear selection --------------------------------------------------
        const clearSelectionCells = () => {
          if (!state.cells) { clearCell(); return; }
          if (!selectMode) { clearCell(); return; }
          const { r1, r2, c1, c2 } = getSelectionRect();
          let changed = false;
          for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) {
              const ref = this._cellsRefFromRC(r, c);
              if (state.cells[ref]) { delete state.cells[ref]; changed = true; }
            }
          }
          if (changed) {
            this.Storages.Set(id, storageKey, state);
            computed = this._cellsEvaluate(state);
            setStatus('✓ Cleared selection', 1200);
          }
          drawScreen();
        };

        // ---- Goto -------------------------------------------------------------
        const startGoto = () => {
          gotoMode = true;
          gotoBuffer = '';
          drawScreen();
        };

        const commitGoto = () => {
          const ref = gotoBuffer.trim().toUpperCase();
          const parsed = this._cellsParseRef(ref);
          if (parsed) {
            if (parsed.row >= state.rows) { state.rows = parsed.row + 10; }
            if (parsed.col >= state.cols) { state.cols = parsed.col + 1; }
            this.Storages.Set(id, storageKey, state);
            cursorRow = parsed.row;
            cursorCol = parsed.col;
            clearSelection();
            setStatus(`→ ${this._cellsRefFromRC(cursorRow, cursorCol)}`, 1200);
          } else {
            setStatus(`Invalid ref: "${gotoBuffer}"`, 2000);
          }
          gotoMode = false;
          gotoBuffer = '';
          drawScreen();
        };

        // ---- Renderer ---------------------------------------------------------
        const drawScreen = () => {
          if (finished || !running) return;
          // Rigid lock: if a draw is already in flight, drop this one.
          // The next scheduled draw (from a resize or a key handler) will
          // pick up the new state naturally.
          if (drawLock) return;
          drawLock = true;
          try {
            const cols = getCols();
            const rows = getRows();
            const visCols = visibleCols();
            const visRows = visibleRows();

            // Viewport follows cursor — same axis only.
            if (cursorCol < scrollCol) scrollCol = cursorCol;
            if (cursorCol >= scrollCol + visCols) scrollCol = cursorCol - visCols + 1;
            if (cursorRow < scrollRow) scrollRow = cursorRow;
            if (cursorRow >= scrollRow + visRows) scrollRow = cursorRow - visRows + 1;
            if (scrollCol < 0) scrollCol = 0;
            if (scrollRow < 0) scrollRow = 0;

            const out = [];
            out.push('\x1b[1;1H');

            // ---- Title bar (row 1) --------------------------------------
            const cursorRef = this._cellsRefFromRC(cursorRow, cursorCol);
            const cell = computed[cursorRef];

            let headerInfo;
            if (selectMode) {
              const { r1, r2, c1, c2 } = getSelectionRect();
              const a = this._cellsRefFromRC(r1, c1);
              const b = this._cellsRefFromRC(r2, c2);
              headerInfo = (a === b) ? ` ${a} ` : ` ${a}:${b} `;
            } else {
              headerInfo = ` ${cursorRef} `;
            }

            // Build the left-hand segment of the title bar. During editing
            // the FULL formula is shown, auto-scrolled so the cursor
            // (marked with █) is always visible — this is what makes long
            // formulas readable while typing.
            const baseTag = ` 📊 ${name}`;
            let editingTag = '';
            if (editing) {
              const prefix = ' [EDIT] ';
              const avail = Math.max(
                8,
                cols - baseTag.length - prefix.length - headerInfo.length - 2
              );
              let start = 0;
              if (editCursor >= avail) start = editCursor - avail + 1;
              if (start < 0) start = 0;
              const end = Math.min(editBuffer.length, start + avail);
              const visible = editBuffer.slice(start, end);
              const cursorInVisible = editCursor - start;
              let marked =
                visible.slice(0, cursorInVisible) +
                '█' +
                visible.slice(cursorInVisible);
              if (start > 0) marked = '…' + marked;
              if (end < editBuffer.length) marked = marked + '…';
              editingTag = prefix + marked;
            }
            const gotoTag = gotoMode ? ` [GOTO ${gotoBuffer}█]` : '';
            const titleFull = baseTag + editingTag + gotoTag;
            const maxTitleLen = Math.max(10, cols - headerInfo.length - 2);
            const title = (titleFull.length > maxTitleLen)
              ? titleFull.slice(0, maxTitleLen - 1) + '…'
              : titleFull;
            let pad = Math.max(0, cols - title.length - headerInfo.length);
            // If both title and headerInfo overflow, shrink pad to 0 and
            // truncate the headerInfo rather than the title.
            out.push('\x1b[1;1H\x1b[2K\x1b[7m' + title + ' '.repeat(pad) + headerInfo + '\x1b[0m');

            // ---- Frozen column header (row 2) ---------------------------
            out.push('\x1b[2;1H\x1b[2K');
            let headerLine = ' '.repeat(rowHeaderWidth);
            const sel = selectMode ? getSelectionRect() : null;
            for (let c = 0; c < visCols; c++) {
              const colIdx = scrollCol + c;
              if (colIdx >= state.cols) break;
              const label = this._cellsColLabel(colIdx);
              const padded = label.padEnd(cellWidth);
              const inSelHeader = sel && colIdx >= sel.c1 && colIdx <= sel.c2;
              if (inSelHeader) {
                headerLine += '\x1b[7m' + padded + '\x1b[0m ';
              } else if (colIdx === cursorCol) {
                headerLine += '\x1b[1;4m' + padded + '\x1b[0m ';
              } else {
                headerLine += '\x1b[1m' + padded + '\x1b[0m ';
              }
            }
            out.push(headerLine);

            // ---- Data rows (from row 3) ---------------------------------
            let lastDrawnRow = 2;
            for (let r = 0; r < visRows; r++) {
              const rowIdx = scrollRow + r;
              const screenRow = 3 + r;
              out.push('\x1b[' + screenRow + ';1H\x1b[2K');
              if (rowIdx >= state.rows) break;
              lastDrawnRow = screenRow;

              const rowLabel = String(rowIdx + 1).padStart(rowHeaderWidth - 1) + ' ';
              const inSelRow = sel && rowIdx >= sel.r1 && rowIdx <= sel.r2;
              let line = (inSelRow || rowIdx === cursorRow)
                ? '\x1b[7m' + rowLabel + '\x1b[0m'
                : rowLabel;

              for (let c = 0; c < visCols; c++) {
                const colIdx = scrollCol + c;
                if (colIdx >= state.cols) break;
                const ref = this._cellsRefFromRC(rowIdx, colIdx);
                const isCursor = (rowIdx === cursorRow && colIdx === cursorCol);
                const inSel = selectMode && isInSelection(rowIdx, colIdx);

                let display = '';
                if (editing && isCursor) {
                  // Small window around the cursor inside the cell itself.
                  const w = Math.max(1, cellWidth - 1);
                  let s = 0;
                  if (editCursor >= w) s = editCursor - w + 1;
                  const e = Math.min(editBuffer.length, s + w);
                  const vis = editBuffer.slice(s, e);
                  const ci = editCursor - s;
                  display = vis.slice(0, ci) + '█' + vis.slice(ci);
                } else {
                  const cc = computed[ref];
                  display = cc ? (cc.display || '') : '';
                }
                if (display.length > cellWidth - 1) display = display.slice(0, cellWidth - 2) + '…';
                const padded = display.padEnd(cellWidth);

                if (isCursor) {
                  line += '\x1b[7m' + padded + '\x1b[0m ';
                } else if (inSel) {
                  line += '\x1b[7m' + padded + '\x1b[0m ';
                } else {
                  line += padded + ' ';
                }
              }
              out.push(line);
            }

            // Clear everything below the last drawn row so stale content
            // from a previous, taller frame cannot survive. This is the
            // second half of the duplicate-line fix — the rigid drawLock
            // prevents overlap, and this clear guarantees no orphans.
            out.push('\x1b[' + (lastDrawnRow + 1) + ';1H\x1b[0J');

            // ---- Status / help (last row) -------------------------------
            out.push('\x1b[' + rows + ';1H\x1b[2K\x1b[7m');
            let help;
            if (gotoMode) {
              help = ` Goto cell: ${gotoBuffer}█   Enter: go   Esc: cancel`;
            } else if (editing) {
              help = ' Enter: commit   Esc: cancel   (formulas = pure JS: =A1+B2)';
            } else if (selectMode) {
              const { r1, r2, c1, c2 } = getSelectionRect();
              const count = (r2 - r1 + 1) * (c2 - c1 + 1);
              help = ` Selection: ${count} cell(s)   Ctrl+D: fill down   Ctrl+R: fill right   Del: clear   Esc: cancel`;
            } else if (cell && cell.error) {
              help = ` ✗ ${cell.error}`;
            } else if (statusMessage) {
              help = ' ' + statusMessage;
            } else {
              help = ' Arrows: move   Shift+Arrows: select   Enter: edit   Ctrl+G: goto   Ctrl+D/R: fill   Del: clear   Ctrl+X: exit';
            }
            if (help.length > cols - 1) help = help.slice(0, cols - 1);
            help = help.padEnd(cols - 1);
            out.push(help);
            out.push('\x1b[0m');

            // ---- Cursor --------------------------------------------------
            if (editing) {
              const csr = 3 + (cursorRow - scrollRow);
              const csc = rowHeaderWidth + (cursorCol - scrollCol) * colStep + 1;
              out.push('\x1b[' + csr + ';' + csc + 'H');
              out.push('\x1b[?25h');
            } else {
              out.push('\x1b[?25l');
            }

            stdout.write(out.join(''));
          } catch (_) {
            /* ignore draw errors */
          } finally {
            drawLock = false;
          }
        };

        const setStatus = (msg, ms) => {
          statusMessage = msg;
          drawScreen();
          if (ms > 0) setTimeout(() => {
            if (running && statusMessage === msg) { statusMessage = ''; drawScreen(); }
          }, ms);
        };

        const finish = () => {
          if (finished) return;
          finished = true; running = false;
          try { stdin.removeListener('data', handleData); } catch (_) {}
          try { stdout.removeListener('resize', handleResize); } catch (_) {}

          try { stdout.write('\x1b[?25l\x1b[?1049l'); } catch (_) {}
          try { if (stdin.isRaw !== wasRaw) stdin.setRawMode(wasRaw); } catch (_) {}
          try { stdout.write('\x1b[?25h'); } catch (_) {}

          state.cursorRow = cursorRow;
          state.cursorCol = cursorCol;
          state.scrollRow = scrollRow;
          state.scrollCol = scrollCol;
          this.Storages.Set(id, storageKey, state);
          resolve();
        };

        const commitEdit = () => {
          const ref = this._cellsRefFromRC(cursorRow, cursorCol);
          if (!state.cells) state.cells = {};
          if (editBuffer === '') delete state.cells[ref];
          else state.cells[ref] = { raw: editBuffer };
          this.Storages.Set(id, storageKey, state);
          computed = this._cellsEvaluate(state);
          editing = false;
          editBuffer = '';
          editCursor = 0;
        };

        const clearCell = () => {
          const ref = this._cellsRefFromRC(cursorRow, cursorCol);
          if (state.cells && state.cells[ref]) {
            delete state.cells[ref];
            this.Storages.Set(id, storageKey, state);
            computed = this._cellsEvaluate(state);
          }
        };

        const extendRows = (n) => { state.rows = Math.max(state.rows, n); this.Storages.Set(id, storageKey, state); };
        const extendCols = (n) => { state.cols = Math.max(state.cols, n); this.Storages.Set(id, storageKey, state); };

        const handleData = (data) => {
          if (finished || !running) return;
          const str = data.toString();
          if (str.length === 0) return;

          // ---- GOTO MODE: consume chars into the ref buffer ------------
          if (gotoMode) {
            let needRedraw = false;
            for (const ch of str) {
              const code = ch.charCodeAt(0);
              if (ch === '\r' || ch === '\n') { commitGoto(); return; }
              if (ch === '\x1b') {
                gotoMode = false; gotoBuffer = '';
                setStatus('Goto cancelled', 1000);
                drawScreen();
                return;
              }
              if (ch === '\x7f' || ch === '\b') {
                if (gotoBuffer.length > 0) { gotoBuffer = gotoBuffer.slice(0, -1); needRedraw = true; }
                continue;
              }
              if (code >= 32 && code < 127) { gotoBuffer += ch; needRedraw = true; }
            }
            if (needRedraw) drawScreen();
            return;
          }

          // ---- Global exit keys ----------------------------------------
          // Ctrl+X always exits. Ctrl+C exits only when not editing.
          if (str === '\x18' || (str === '\x03' && !editing)) {
            if (editing) { editing = false; editBuffer = ''; drawScreen(); return; }
            finish(); return;
          }

          // ---- EDIT MODE: raw text input with cursor navigation --------
          // Escape sequences (arrows, Home/End, Delete) are parsed BEFORE
          // the per-char loop so they don't get misinterpreted as a bare
          // Escape (which would cancel editing). The tracked `editCursor`
          // position lets the user navigate freely inside long formulas.
          if (editing) {
            if (str.startsWith('\x1b[')) {
              const arrowMatch = str.match(/^\x1b\[(?:(\d+)(?:;(\d+))?)?([A-DHF])$/);
              const tildeMatch = str.match(/^\x1b\[(\d+)(?:;(\d+))?~$/);
              let handled = false;

              if (arrowMatch) {
                const keyChar = arrowMatch[3];
                if (keyChar === 'D') { if (editCursor > 0) editCursor--; handled = true; }
                else if (keyChar === 'C') { if (editCursor < editBuffer.length) editCursor++; handled = true; }
                else if (keyChar === 'H') { editCursor = 0; handled = true; }
                else if (keyChar === 'F') { editCursor = editBuffer.length; handled = true; }
                // Up / Down move to the start / end of the single-line buffer.
                else if (keyChar === 'A') { editCursor = 0; handled = true; }
                else if (keyChar === 'B') { editCursor = editBuffer.length; handled = true; }
              } else if (tildeMatch) {
                const keyNum = parseInt(tildeMatch[1], 10);
                if (keyNum === 3) {
                  // Delete: remove the character under the cursor.
                  if (editCursor < editBuffer.length) {
                    editBuffer = editBuffer.slice(0, editCursor) + editBuffer.slice(editCursor + 1);
                  }
                  handled = true;
                } else if (keyNum === 1) { editCursor = 0; handled = true; }
                else if (keyNum === 4) { editCursor = editBuffer.length; handled = true; }
              }

              // Unknown escape sequence → swallow silently, never insert raw bytes.
              if (handled) drawScreen();
              return;
            }

            // Bare Escape → cancel editing (discard buffer).
            if (str === '\x1b') {
              editing = false;
              editBuffer = '';
              editCursor = 0;
              drawScreen();
              return;
            }

            // Printable/control characters insert/delete at the cursor.
            let needRedraw = false;
            for (const ch of str) {
              const code = ch.charCodeAt(0);
              if (ch === '\r' || ch === '\n') {
                commitEdit();
                needRedraw = true;
                break;
              } else if (ch === '\x7f' || ch === '\b') {
                if (editCursor > 0) {
                  editBuffer = editBuffer.slice(0, editCursor - 1) + editBuffer.slice(editCursor);
                  editCursor--;
                  needRedraw = true;
                }
              } else if (code >= 32 && code < 127) {
                editBuffer = editBuffer.slice(0, editCursor) + ch + editBuffer.slice(editCursor);
                editCursor++;
                needRedraw = true;
              }
            }
            if (needRedraw) drawScreen();
            return;
          }

          // ---- Ctrl+G / F5: open goto prompt ---------------------------
          // Both send distinct sequences; F5 sends \x1b[15~ which we also
          // catch below during escape-sequence parsing.
          if (str === '\x07') { startGoto(); return; }

          // ---- Ctrl+D / Ctrl+R: fill operations ------------------------
          if (str === '\x04') { fillDown(); return; }
          if (str === '\x12') { fillRight(); return; }

          // ---- Ctrl+A: select all --------------------------------------
          if (str === '\x01') {
            selectMode = true;
            anchorRow = 0; anchorCol = 0;
            cursorRow = state.rows - 1;
            cursorCol = state.cols - 1;
            drawScreen();
            return;
          }

          // ---- Escape (bare): cancel selection -------------------------
          if (str === '\x1b') {
            if (selectMode) clearSelection();
            drawScreen();
            return;
          }

          // ---- Delete / Backspace: clear selection or cell -------------
          if (str === '\x7f' || str === '\b') {
            clearSelectionCells();
            return;
          }

          // ---- Arrow / navigation / modified arrows --------------------
          if (str[0] === '\x1b' && str[1] === '[') {
            // Two forms to recognise:
            //   \x1b[A          (plain)
            //   \x1b[1;2A       (with modifier: 2=Shift, 3=Alt, 4=Shift+Alt, 5=Ctrl)
            //   \x1b[15~        (F5)
            //   \x1b[3~         (Delete)
            //   \x1b[5~ / \x1b[6~ (Page Up / Page Down)
            let keyChar = null;
            let hasShift = false;
            let hasCtrl = false;

            const arrow = str.match(/^\x1b\[(?:(\d+)(?:;(\d+))?)?([A-DHF])$/);
            const tilde = str.match(/^\x1b\[(\d+)(?:;(\d+))?~$/);

            if (arrow) {
              keyChar = arrow[3];
              const mod = arrow[2] ? parseInt(arrow[2], 10) : 1;
              hasShift = (mod === 2 || mod === 4 || mod === 6 || mod === 8);
              hasCtrl = (mod === 5 || mod === 6 || mod === 7 || mod === 8);
            } else if (tilde) {
              const keyNum = parseInt(tilde[1], 10);
              const mod = tilde[2] ? parseInt(tilde[2], 10) : 1;
              hasShift = (mod === 2 || mod === 4 || mod === 6 || mod === 8);
              hasCtrl = (mod === 5 || mod === 6 || mod === 7 || mod === 8);

              if (keyNum === 3) {           // Delete
                clearSelectionCells();
                return;
              }
              if (keyNum === 15) {          // F5 → goto
                startGoto();
                return;
              }
              if (keyNum === 6) {           // Page Down
                const jump = visibleRows();
                if (cursorRow + jump < state.rows) cursorRow += jump;
                else { extendRows(cursorRow + jump + 10); cursorRow += jump; }
                if (!hasShift) clearSelection();
                drawScreen();
                return;
              }
              if (keyNum === 5) {           // Page Up
                const jump = visibleRows();
                cursorRow = Math.max(0, cursorRow - jump);
                if (!hasShift) clearSelection();
                drawScreen();
                return;
              }
              if (keyNum === 1) keyChar = 'H';   // Home
              if (keyNum === 4) keyChar = 'F';   // End
            }

            if (keyChar) {
              // Entering select mode: pin the anchor at the pre-move
              // cursor position, then move.
              if (hasShift && !selectMode) {
                selectMode = true;
                anchorRow = cursorRow;
                anchorCol = cursorCol;
              }

              if (keyChar === 'A') {          // Up
                if (cursorRow > 0) cursorRow--;
              } else if (keyChar === 'B') {   // Down
                if (cursorRow < state.rows - 1) cursorRow++;
                else { extendRows(state.rows + 10); cursorRow++; setStatus('＋10 rows', 1200); }
              } else if (keyChar === 'C') {   // Right
                if (cursorCol < state.cols - 1) cursorCol++;
                else { extendCols(state.cols + 1); cursorCol++; setStatus(`＋col ${this._cellsColLabel(cursorCol)}`, 1200); }
              } else if (keyChar === 'D') {   // Left
                if (cursorCol > 0) cursorCol--;
              } else if (keyChar === 'H') {   // Home
                if (hasCtrl) { cursorRow = 0; cursorCol = 0; }
                else cursorCol = 0;
              } else if (keyChar === 'F') {   // End
                if (hasCtrl) { cursorRow = state.rows - 1; cursorCol = state.cols - 1; }
                else cursorCol = state.cols - 1;
              }

              // A plain move cancels selection. A shift+move keeps it.
              if (!hasShift && selectMode) clearSelection();

              drawScreen();
              return;
            }
          }

          // ---- Enter → edit cell ---------------------------------------
          if (str === '\r' || str === '\n') {
            const ref = this._cellsRefFromRC(cursorRow, cursorCol);
            const c = state.cells && state.cells[ref];
            editBuffer = c ? (c.raw || '') : '';
            editCursor = editBuffer.length;
            editing = true;
            drawScreen();
            return;
          }

          // ---- Printable char → start editing with that char -----------
          const code = str.charCodeAt(0);
          if (code >= 32 && code < 127) {
            const ref = this._cellsRefFromRC(cursorRow, cursorCol);
            const c = state.cells && state.cells[ref];
            editBuffer = c ? (c.raw || '') : '';
            editCursor = editBuffer.length;
            editing = true;
            editBuffer += str;
            editCursor = editBuffer.length;
            drawScreen();
            return;
          }
        };

        const handleResize = () => { if (running) drawScreen(); };

        try {
          stdin.setRawMode(true);
          stdin.resume();
          stdin.on('data', handleData);
        } catch (e) { finish(); return; }

        try { stdout.on('resize', handleResize); } catch (_) {}

        drawScreen();
      });
    };

    /**
     * Create a spreadsheet ("Cells") launcher for this func.
     *
     * Pressing the launcher button opens a full-screen editor with:
     *   • Frozen column header (A, B, C, …) and row header (1, 2, 3, …)
     *   • Aligned horizontal + vertical scrolling (all rows move together)
     *   • Pure-JS formulas — reference other cells directly: `=A1+B2`
     *   • Auto-extension of the sheet when moving past the last row/column
     *
     * Only ONE Cells instance per Func view is supported. To have more
     * than one, put each inside its own `this.Page()`.
     *
     * @param {string} id - User/build ID
     * @param {string} name - Unique name for this Cells instance
     * @param {Object} [config] - Cells configuration
     * @param {number} [config.rows=100] - Initial number of rows
     * @param {number} [config.cols=26] - Initial number of columns (26 = A..Z)
     * @param {string} [config.label] - Launcher button label (default '📊 <name>')
     * @param {boolean} [config.pinned] - Pin the launcher to the bottom
     * @param {boolean} [config.pinnedTop] - Pin the launcher to the top
     * @returns {Promise<Object>} The current Cells state object
     */
    this.Cells = async (id, name, config = {}) => {
      if (!this.Builds.has(id)) {
        if (this.Log) console.log(`this.Cells() Error - userBuild not found | BuildID: ${id}`);
        return null;
      }

      const storageKey = `cells_${name}`;
      const rows = Math.max(1, parseInt(config.rows, 10) || 100);
      const cols = Math.max(1, parseInt(config.cols, 10) || 26);

      let state = this.Storages.Get(id, storageKey);
      if (!state) {
        state = { rows, cols, cells: {}, cursorRow: 0, cursorCol: 0, scrollRow: 0, scrollCol: 0 };
        this.Storages.Set(id, storageKey, state);
      } else {
        if (state.rows < rows) state.rows = rows;
        if (state.cols < cols) state.cols = cols;
      }

      const build = this.Builds.get(id);
      const triggerProp = `__cells_open_${name}`;
      const curProps = (build.Session && build.Session.ActualProps) || {};

      if (curProps[triggerProp]) {
        delete curProps[triggerProp];
        try {
          await this._openCellsEditor(id, name, config);
        } catch (err) {
          if (this.Log) console.error('Cells editor error:', err);
        }
      }

      const buttonCfg = {
        name: config.label || `📊 ${name}`,
        props: { [triggerProp]: true }
      };
      if (config.pinned !== undefined) buttonCfg.pinned = config.pinned;
      if (config.pinnedTop !== undefined) buttonCfg.pinnedTop = config.pinnedTop;
      this.Button(id, buttonCfg);

      return this.Storages.Get(id, storageKey);
    };

    // --------------------------- Grid Method ---------------------------

    /**
     * Create a responsive, horizontally-scrollable grid row.
     *
     * Each element of `cellBuilders` is an async function that builds ONE
     * cell's content, using the same Text/Button/Buttons/SideButton/Field
     * API a `this.Page` body would use. Cells render SIDE-BY-SIDE on the
     * same terminal row. Inside a cell, Button layouts horizontally.
     * Each cell caps at `maxCellRatio` (default 0.2 = 1/5) of terminal
     * width and keeps its OWN `◀N`/`N▶` horizontal scroll viewport.
     *
     * @param {string} id - User/build ID
     * @param {string} name - Grid name (persists per-cell scroll state)
     * @param {Array<Function|{build:Function}|{items:Array}>} cellBuilders
     * @param {Object} [config]
     * @param {number} [config.maxCellRatio=0.2]
     * @param {number} [config.gap=2]
     * @returns {Promise<void>}
     */
    this.Grid = async (id, name, cellBuilders = [], config = {}) => {
      if (!this.Builds.has(id)) {
        if (this.Log) console.log(`this.Grid() Error - userBuild not found | BuildID: ${id}`);
        return;
      }
      const userBuild = this.Builds.get(id);
      const cells = [];

      for (let i = 0; i < cellBuilders.length; i++) {
        const cb = cellBuilders[i];
        const cellItems = [];

        const prevCellItems = userBuild._cellItems;
        userBuild._cellItems = cellItems;

        try {
          if (typeof cb === 'function') {
            await cb();
          } else if (cb && typeof cb.build === 'function') {
            await cb.build();
          } else if (cb && typeof cb === 'object' && Array.isArray(cb.items)) {
            for (const it of cb.items) cellItems.push(it);
          }
        } catch (e) {
          if (this.Log) console.error(`this.Grid() cell ${i} error:`, e);
          cellItems.push({
            name: `[cell error: ${e.message}]`,
            action: () => {},
            metadata: { props: {}, path: this.Name }
          });
        } finally {
          userBuild._cellItems = prevCellItems;
        }

        const flat = [];
        for (const it of cellItems) {
          if (it && it.type === 'options' && Array.isArray(it.value)) {
            for (const sub of it.value) flat.push(sub);
          } else {
            flat.push(it);
          }
        }
        cells.push({ items: flat });
      }

      userBuild.Buttons.push({
        type: 'grid',
        name: name || `grid_${Date.now().toString(36)}`,
        cells,
        config: {
          maxCellRatio: (typeof config.maxCellRatio === 'number' && config.maxCellRatio > 0 && config.maxCellRatio <= 1)
            ? config.maxCellRatio
            : 0.2,
          gap: (typeof config.gap === 'number') ? config.gap : 2
        }
      });
    };

    // --------------------------- Args Method ---------------------------

    /**
     * Process command-line arguments for this function.
     *
     * Arguments are captured from the original process launch:
     *   `node SyAPP.js MyFunc.js [arg1] [arg2] ...`
     * — everything after the target file becomes the positional args array.
     *
     * The handler is called with a SINGLE argument: the `args` array. When
     * a schema (`config.required`) is provided, positional CLI args are
     * mapped onto the schema by order, and any missing required values
     * trigger an interactive form (using `this.Field`) so the user can
     * fill them in. In the form, each `Field` label defaults to the
     * schema entry's `label` (or `name`).
     *
     * The handler runs ONLY when args have actually been resolved on this
     * render — never on a plain refresh tick. With `everyTime: false`
     * (default) the handler fires exactly once per args key; with
     * `everyTime: true` it fires on every entrance.
     *
     * @param {string} id - User/build ID
     * @param {Function} handler - async (args) => {} — receives the args array
     * @param {Object} [config] - Configuration
     * @param {Array<{
     *   name: string,
     *   label?: string,
     *   required?: boolean,
     *   defaultValue?: *,
     *   validate?: (value: *) => (boolean|string|undefined|Promise<boolean|string|undefined>)
     * }>} [config.required=[]] - Named arg schema (order = positional order)
     * @param {boolean} [config.everyTime=false] - If true, re-process on every entrance;
     *                                              else only on the first entrance
     * @param {boolean} [config.form=true] - Show the interactive form when required args
     *                                       are missing
     * @param {string} [config.description] - Text shown above the form
     * @param {string} [config.key='default'] - Unique key when the same func uses
     *                                          multiple Args() blocks
     * @returns {Promise<void>}
     */
    this.Args = async (id, handler, config = {}) => {
      if (!this.Builds.has(id)) {
        if (this.Log) console.log(`this.Args() Error - userBuild not found | BuildID: ${id}`);
        return;
      }
      if (typeof handler !== 'function') {
        if (this.Log) console.log(`this.Args() Error - handler must be a function | BuildID: ${id}`);
        return;
      }

      const opts = {
        required: [],
        everyTime: false,
        form: true,
        description: 'Please provide the required arguments:',
        key: 'default',
        ...config
      };

      const stateKey   = `__args_state_${this.Name}_${opts.key}`;
      const submitKey  = `__args_submit_${this.Name}_${opts.key}`;
      const fieldPrefix = `__args_field_${this.Name}_${opts.key}_`;

      const build = this.Builds.get(id);
      const curProps = (build && build.Session && build.Session.ActualProps) || {};

      let state = this.Storages.Get(id, stateKey);
      if (!state || typeof state !== 'object') state = { processed: false, values: {} };
      if (!state.values || typeof state.values !== 'object') state.values = {};

      // ------------------------------------------------------------------
      // RAW CLI ARGS — captured once by SyAPP at launch
      // ------------------------------------------------------------------
      const syapp = this._syappInstance;
      const cliArgs = (syapp && Array.isArray(syapp._processArgs))
        ? syapp._processArgs
        : [];

      // ------------------------------------------------------------------
      // ROUTE DISCOVERY MODE — never show a form, just hand the handler
      // whatever we have from the CLI (or schema defaults).
      // ------------------------------------------------------------------
      if (curProps._routeDiscovery) {
        const args = [];
        for (let i = 0; i < opts.required.length; i++) {
          const spec = opts.required[i];
          if (!spec || !spec.name) continue;
          const v = cliArgs[i] !== undefined ? cliArgs[i] : spec.defaultValue;
          args.push(v);
          if (!(spec.name in args)) args[spec.name] = v;
        }
        for (let i = opts.required.length; i < cliArgs.length; i++) args.push(cliArgs[i]);
        try { await handler(args); } catch (e) { if (this.Log) console.error(`Args discovery error in ${this.Name}:`, e); }
        return;
      }

      // ------------------------------------------------------------------
      // FORM SUBMISSION — the user just clicked "Submit Args".
      // Collect every Field value, validate, and commit to state.
      // ------------------------------------------------------------------
      let formJustSubmitted = false;
      if (curProps[submitKey]) {
        delete curProps[submitKey];

        const newValues = { ...state.values };
        let allValid = true;

        for (const spec of opts.required) {
          if (!spec || !spec.name) continue;
          const fieldStorageKey = `field_${fieldPrefix}${spec.name}`;
          let v = this.Storages.Get(id, fieldStorageKey);

          if (v === undefined || v === '') {
            if (spec.defaultValue !== undefined) v = spec.defaultValue;
            else if (spec.required !== false) {
              this.Alert(id, `Field "${spec.label || spec.name}" is required`, { duration: 3000 });
              allValid = false;
              break;
            }
          }

          if (allValid && typeof spec.validate === 'function') {
            try {
              const check = await spec.validate(v);
              if (check !== true && check !== undefined) {
                this.Alert(id,
                  typeof check === 'string' ? check : `Invalid value for "${spec.name}"`,
                  { duration: 3000 });
                allValid = false;
                break;
              }
            } catch (err) {
              this.Alert(id, `Validation error for "${spec.name}": ${err.message}`, { duration: 3000 });
              allValid = false;
              break;
            }
          }

          newValues[spec.name] = v;
        }

        if (allValid) {
          state.values = newValues;
          state.processed = true;
          this.Storages.Set(id, stateKey, state);

          // Clean up transient form fields so they don't linger
          for (const spec of opts.required) {
            if (!spec || !spec.name) continue;
            this.Storages.Delete(id, `field_${fieldPrefix}${spec.name}`);
          }
          formJustSubmitted = true;
        }
      }

      // ------------------------------------------------------------------
      // MAPPING + FORM DECISION
      // Process on the first entrance (default) OR on every entrance
      // (when opts.everyTime is true).
      //
      // IMPORTANT: the handler is ONLY invoked when we actually processed
      // args on this render. With everyTime:false and state.processed:true
      // (i.e. the args were already settled), we return WITHOUT calling
      // the handler — otherwise the handler runs on every refresh tick.
      // ------------------------------------------------------------------
      const shouldProcess = opts.everyTime || !state.processed;

      // Case A — already processed and not everyTime: just skip silently.
      if (!shouldProcess && !formJustSubmitted) {
        return;
      }

      // Case B — form was just submitted on this render: fall through
      // and call the handler with the freshly validated values.

      // Case C — first entrance (or everyTime): attempt to resolve args.
      if (shouldProcess && !formJustSubmitted) {
        const values = { ...state.values };

        // Positional CLI args → schema (only fill when not already set)
        for (let i = 0; i < opts.required.length; i++) {
          const spec = opts.required[i];
          if (!spec || !spec.name) continue;
          if (values[spec.name] === undefined || values[spec.name] === '') {
            if (cliArgs[i] !== undefined) values[spec.name] = cliArgs[i];
            else if (spec.defaultValue !== undefined) values[spec.name] = spec.defaultValue;
          }
        }
        state.values = values;

        const missing = opts.required.filter(spec => {
          if (!spec || !spec.name) return false;
          if (spec.required === false) return false;
          const v = values[spec.name];
          return v === undefined || v === null || v === '';
        });

        if (missing.length > 0 && opts.form) {
          // ---------- Render the interactive args form ----------
          this.Text(id, opts.description || 'Please provide the required arguments:');

          for (const spec of opts.required) {
            if (!spec || !spec.name) continue;
            const fieldName = `${fieldPrefix}${spec.name}`;
            const currentVal = values[spec.name] !== undefined ? String(values[spec.name]) : '';
            this.Field(id, fieldName, {
              label: spec.label || spec.name,
              initialValue: currentVal
            });
          }

          this.Button(id, {
            name: ColorText.green('✓ Submit Args'),
            props: { [submitKey]: true }
          });

          this.Storages.Set(id, stateKey, state);
          return; // wait for user to submit
        }

        state.processed = true;
        this.Storages.Set(id, stateKey, state);
      }

      // ------------------------------------------------------------------
      // BUILD THE FINAL ARGS ARRAY AND CALL THE HANDLER
      //   • Schema order first
      //   • Then any extra positional CLI args beyond the schema
      //   • Named access: `args.filename` works alongside `args[0]`
      // ------------------------------------------------------------------
      const values = state.values || {};
      const args = [];

      for (const spec of opts.required) {
        if (!spec || !spec.name) continue;
        const v = values[spec.name];
        args.push(v);
        if (!(spec.name in args)) args[spec.name] = v;
      }
      for (let i = opts.required.length; i < cliArgs.length; i++) {
        args.push(cliArgs[i]);
      }

      try {
        await handler(args);
      } catch (e) {
        if (this.Log) console.error(`Args handler error in ${this.Name}:`, e);
        throw e;
      }
    };

    // --------------------------- Emb Method ---------------------------

    /**
     * Embed an entire SyAPP_Func inside the current function's view.
     *
     * The embedded function is rendered INLINE — its build output (text,
     * buttons, pages, dropdowns, fields, pinned areas, ...) is appended
     * to the CURRENT view, sharing the same session id. Pinned content
     * is properly merged into the parent's pinned areas WITHOUT conflict:
     *
     *   • The embedded func's `Text`/`Button`/... calls that DID NOT
     *     declare a pin go to the parent's scrollable body.
     *   • Calls with `pinned: true` go to the parent's PinnedBottom.
     *   • Calls with `pinnedTop: true` go to the parent's PinnedTop.
     *
     * ─── SOURCES ───────────────────────────────────────────────────────
     * The second argument (a config object) can point at the embedded
     * func in ONE of three mutually exclusive ways:
     *
     *   • `funcClass` — a class extending SyAPP_Func (or SyAPP.Func()).
     *   • `filePath`  — path to a .js/.mjs/.cjs file exporting such a
     *                   class. The file is loaded with dynamic `import()`,
     *                   mirroring how `node SyAPP.js <file>` boots a func.
     *   • `code`      — a raw source string of such a class. It is written
     *                   to a temp file and imported the same way.
     *
     * ─── DEFAULT BEHAVIOUR ─────────────────────────────────────────────
     * With NO config (or with all three source keys empty), this.Emb()
     * renders a single `this.DropDown` containing side buttons:
     *
     *   • 🧩 Self Build → opens a BRAND NEW SelfBuilder session dedicated
     *                     to crafting the embedded func. When the user
     *                     finishes and returns, the produced file path
     *                     (or inline code) is written back to this Emb.
     *   • 📁 Pick File  → opens a nested `this.File()` picker so you can
     *                     choose a .js file that exports a SyAPP_Func.
     *   • ✎ File path   → enter the path manually via WaitInput.
     *   • ✎ Paste code  → paste the func source manually via WaitInput.
     *
     * Once a source exists, an additional button appears:
     *   • ▶ Enter Func → navigates INTO the embedded func normally
     *                     (full Screen, not inline), so you can use it
     *                     like any other page of the app.
     *
     * ─── SAVE MODES ────────────────────────────────────────────────────
     * Once a source exists, the management panel offers two save modes:
     *
     *   • Path mode   → the host file records only the PATH of the
     *                   embedded .js file. Shows the exact snippet.
     *   • Inline mode → the embedded source is written inline in the
     *                   host file. Shows the exact snippet.
     *
     * @param {string} id - User/build ID (like every other method)
     * @param {Object} [config]
     * @param {string}   [config.name='default']  Unique key for this Emb instance
     * @param {Function} [config.funcClass]       Direct class reference
     * @param {string}   [config.filePath]        Path to a .js file exporting a func
     * @param {string}   [config.code]            Inline source of a func
     * @param {string}   [config.sourceFile]      Path of the host file (informational)
     * @param {boolean}  [config.autoRun=true]    Auto-run the embedded build
     * @param {Object}   [config.dropdown]        Dropdown visuals
     * @returns {Promise<Object|null>} The embedded func instance, or null
     */
    this.Emb = async (id, config = {}) => {
      if (!this.Builds.has(id)) {
        if (this.Log) console.log(`this.Emb() Error - userBuild not found | BuildID: ${id}`);
        return null;
      }

      const defaults = {
        name: 'default',
        filePath: undefined,
        code: undefined,
        funcClass: undefined,
        sourceFile: undefined,
        // autoRun is OFF by default: since ▶ Enter Func now performs a
        // real navigation, running the embedded build INLINE would
        // duplicate its content on the parent screen (which is exactly
        // the "still loading in the main func" symptom). Callers that
        // genuinely want the old inline behaviour can pass
        // `autoRun: true` explicitly.
        autoRun: false,
        // When false, no "← Return" button is injected into the
        // embedded func. Default true so every Emb() gets one.
        showReturnButton: true,
        dropdown: {
          up_buttontext: '◈ Embed',
          down_buttontext: 'Hide Embed',
          up_emoji: '▶',
          down_emoji: '▼'
        }
      };
      const cfg = { ...defaults, ...config };
      cfg.dropdown = { ...defaults.dropdown, ...(config.dropdown || {}) };

      const storageKey = `emb_${cfg.name}`;
      const pickerName = `${storageKey}_picker`;
      const nsKey = `__emb_${cfg.name}`;

      // Prop names are namespaced per Emb instance so two Emb widgets on
      // the same screen never step on each other's buttons.
      const P = {
        pickFile:        `${nsKey}_pickfile`,
        selfBuild:       `${nsKey}_selfbuild`,
        clear:           `${nsKey}_clear`,
        saveAsPath:      `${nsKey}_savepath`,
        saveAsInline:    `${nsKey}_saveinline`,
        editFilePath:    `${nsKey}_editfilepath`,
        editCode:        `${nsKey}_editcode`,
        enterFunc:       `${nsKey}_enterfunc`,
        writeSource:     `${nsKey}_writesource`,
        toggleEditPanel: `${nsKey}_toggleeditpanel`
      };

      // ------------------------------------------------------------------
      // Outer file resolution + initial state
      //
      // Storage is per-session, and session ids change across process
      // restarts — so a freshly-booted SyAPP always starts with an
      // EMPTY emb slot even though the widget was populated on a
      // previous run. To recover, we anchor the widget's state to the
      // file that is currently RUNNING (the outer func file), which
      // survives restarts by definition.
      //
      //   outerFilePath := the .js / .mjs / .cjs that SyAPP is
      //                    currently executing (process.argv[2]).
      //
      // Recovery order (most-specific wins):
      //   1. explicit disk record keyed by (outerFilePath, name)
      //   2. self-heal by scanning the running file's source for an
      //      existing this.Emb(id, { name: <this>, filePath }) call —
      //      this is what the previous Save & Return already wrote
      //      into the outer file, so it is the strongest possible
      //      hint that the widget was once populated.
      //   3. cfg.funcClass / cfg.filePath / cfg.code (constructor args)
      //   4. 'none' → setup view
      // ------------------------------------------------------------------
      let outerFilePath = null;
      try {
        const argvFile = process.argv[2];
        if (typeof argvFile === 'string' &&
            /\.(js|mjs|cjs)$/i.test(argvFile) &&
            !/SyAPP\.(js|mjs|cjs)$/i.test(argvFile)) {
          const abs = path.isAbsolute(argvFile)
            ? argvFile
            : path.resolve(process.cwd(), argvFile);
          if (fs.existsSync(abs)) outerFilePath = abs;
        }
      } catch (_) {}
      if (!outerFilePath && typeof __BUILDER_EXPORT_TARGET === 'string' && __BUILDER_EXPORT_TARGET) {
        outerFilePath = __BUILDER_EXPORT_TARGET;
      }

      // ------------------------------------------------------------------
      // DISK KEY NAMESPACING + OUTER-FUNC DETECTION (recursive-Emb fix)
      //
      // process.argv[2] always resolves to the OUTER file, even while an
      // embedded func (imported from a temp file) is executing. Without
      // extra guards, an embedded func's own Emb() would read the OUTER
      // func's disk mirror — which still holds the embedded func's own
      // file path — and render a stale "Enter Func" button that just
      // re-enters the same embedded func in an infinite loop.
      //
      // Two independent defences fix this:
      //
      //   1. Every disk key is namespaced by the OWNING func's runtime
      //      Name, so two Emb widgets with the same `name` in different
      //      funcs never share a disk record. This is what keeps nested
      //      Emb-inside-Emb-inside-Emb flows fully independent.
      //
      //   2. The running-file self-heal SCAN (which cannot distinguish
      //      between Embs that live in the outer file and Embs that
      //      belong to a dynamically imported func) is restricted to
      //      the outer func only.
      // ------------------------------------------------------------------
      const _syappForEmb = this._syappInstance;
      const _mainFuncName = _syappForEmb && _syappForEmb.MainFunc && _syappForEmb.MainFunc.Name;
      const isOuterFunc = !!(_syappForEmb && _mainFuncName && this.Name === _mainFuncName);
      // Disk key = owning func + widget name. Matching key is used by
      // SelfBuilder's _embFinishAndReturn() write-back.
      const diskKey = `${this.Name}::${cfg.name}`;

      if (!this.Storages.Has(id, storageKey)) {
        const initialSource = cfg.funcClass ? 'class'
                            : cfg.filePath  ? 'file'
                            : cfg.code      ? 'code'
                            : 'none';

        const boot = {
          source: initialSource,
          filePath: cfg.filePath || null,
          code: cfg.code || null,
          saveMode: initialSource === 'class' ? 'class'
                  : initialSource === 'file'  ? 'path'
                  : initialSource === 'code'  ? 'inline'
                  : null,
          error: null,
          pickMode: false,
          editPanel: false
        };

        // Step 1 — disk record keyed by (outer file, owner func, widget
        // name). The namespaced key guarantees that an embedded func's
        // own Emb() never collides with the OUTER func's Emb() record.
        if (!boot.filePath && !boot.code && outerFilePath) {
          const disk = _embDiskLoad(outerFilePath, diskKey);
          if (disk && (disk.filePath || disk.code)) {
            boot.source = disk.source || (disk.filePath ? 'file' : 'code');
            boot.filePath = disk.filePath || null;
            boot.code = disk.code || null;
            boot.saveMode = disk.saveMode || (boot.filePath ? 'path' : 'inline');
          }
        }

        // Step 2 — self-heal by scanning the running file for an
        // existing this.Emb(...) call already carrying a filePath.
        //
        // IMPORTANT: this scan is now restricted to the OUTER func
        // (isOuterFunc) only. The scan matches by `name:` string, so it
        // cannot tell apart an Emb declared in the outer file from an
        // Emb declared inside a dynamically imported embedded func. An
        // embedded func whose Emb shares the same `name` would otherwise
        // recover the OUTER func's Emb record — the exact recursive
        // Enter-Func loop this guard prevents.
        if (!boot.filePath && !boot.code && outerFilePath && isOuterFunc) {
          try {
            const src = fs.readFileSync(outerFilePath, 'utf8');
            const healed = _embScanRunningFileForWidget(src, cfg.name);
            if (healed && (healed.filePath || healed.code)) {
              boot.source = healed.filePath ? 'file' : 'code';
              boot.filePath = healed.filePath || null;
              boot.code = healed.code || null;
              boot.saveMode = healed.filePath ? 'path' : 'inline';
            }
          } catch (_) {}
        }

        this.Storages.Set(id, storageKey, boot);
      }

      const state = this.Storages.Get(id, storageKey);
      const curProps = this.Builds.get(id).Session.ActualProps || {};
      const passProps = curProps.page ? { page: curProps.page } : {};

      // Persist any successfully-recovered entry to disk so the NEXT
      // boot does not have to re-scan the outer file. Best-effort.
      if (outerFilePath && (state.filePath || state.code)) {
        _embDiskSave(outerFilePath, diskKey, state);
      }

      // ------------------------------------------------------------------
      // Prop handlers
      // ------------------------------------------------------------------
      if (curProps[P.pickFile]) {
        delete curProps[P.pickFile];
        state.pickMode = true;
        this.Storages.Set(id, storageKey, state);
      }

      // ---------------- Self Build launcher ----------------
      // Opens a BRAND NEW SelfBuilder session. The SelfBuilder is
      // registered under the special name `__selfbuilder__`; SyAPP
      // rebuilds it on every navigation, so a fresh `SelfBuilder`
      // instance is created — giving the user a blank canvas that is
      // completely separate from the app's own SelfBuilder.
      //
      // A pending-return record is stashed on the SyAPP instance so
      // that, when the user is done and comes back, the produced file
      // path (or inline code) is written back into this Emb instance.
      if (curProps[P.selfBuild]) {
        delete curProps[P.selfBuild];
        const returnInfo = {
          embName: cfg.name,
          returnTo: this.Name,
          returnProps: { ...passProps },
          sourceFile: cfg.sourceFile || null
        };
        if (this._syappInstance) {
          this._syappInstance._pendingEmbBuild = returnInfo;
        }
        // Pass the return info BOTH on the shared _pendingEmbBuild
        // slot (legacy path) AND on session-scoped props. The props
        // are what make nested Emb-in-Emb-in-Emb flows reliable:
        // whenever a NESTED EMB session's Self Build fires, a previous
        // (outer) session's Finish & Return may still be running
        // asynchronously and clobber the shared slot to null. Props
        // are set on the CURRENT session's ActualProps and are read
        // back by the SelfBuilder before anything else clears them, so
        // they can never be lost to a race with an older session.
        this.GotoNow(id, '__selfbuilder__', {
          props: {
            __embNewSession: cfg.name,
            __embReturnTo: returnInfo.returnTo,
            __embReturnProps: returnInfo.returnProps,
            __embSourceFile: returnInfo.sourceFile
          }
        });
        return null;
      }

      if (curProps[P.clear]) {
        delete curProps[P.clear];
        Object.assign(state, {
          source: 'none', filePath: null, code: null,
          saveMode: null, error: null, pickMode: false,
          editPanel: false
        });
        this.Storages.Set(id, storageKey, state);
        this.FileManager.ClearSelection(id, pickerName);
      }

      if (curProps[P.saveAsPath]) {
        delete curProps[P.saveAsPath];
        state.saveMode = 'path';
        this.Storages.Set(id, storageKey, state);
      }
      if (curProps[P.saveAsInline]) {
        delete curProps[P.saveAsInline];
        state.saveMode = 'inline';
        this.Storages.Set(id, storageKey, state);
      }

      // ---------------- Enter Func ----------------
      // Navigate INTO the embedded func as a normal screen.
      //
      // The func has already been imported and registered under its
      // REAL class name (either by _embFinishAndReturn, or by a direct
      // pick / paste that we now register below). We resolve the class
      // once more here to make sure the SyAPP.Funcs map contains it,
      // then navigate with a plain funcname — the exact same thing a
      // `{ path: 'MyFunc' }` button would do.
      //
      // Before navigating, we record the RETURN TARGET for this
      // (sessionId, embeddedFuncName) pair so the embedded func can
      // render a default "← Return" button pointing back at this
      // parent func. This is what makes Enter Func → Return Func work
      // out of the box for any func produced by this.Emb().
      if (curProps[P.enterFunc]) {
        delete curProps[P.enterFunc];
        if (state.source !== 'none') {
          const cls = await this._embResolveClass(state, cfg);
          if (cls && this._syappInstance) {
            // Ensure the class is present in SyAPP.Funcs under a stable
            // name. We use `cls.name` first (that is what the produced
            // source declares), then fall back to cfg.name.
            let realName = (typeof cls.name === 'string' && cls.name) ? cls.name : null;
            let instance = null;
            try { instance = new cls(); } catch (_) {}
            if (instance && instance.Name) realName = instance.Name;
            if (!realName) realName = cfg.name;

            // ALWAYS (re)register the freshly-resolved class.
            //
            // The produced embedded func always carries the SAME class
            // name across edits (e.g. "EmbeddedFunc"). On the first
            // Emb → Enter Func round the name is not yet in the Funcs
            // map, so the registration was happening naturally. On any
            // EDIT round the name already exists — and the previous
            // `if (!Funcs.has(realName))` guard would then keep the
            // stale, pre-edit instance in place, so Enter Func would
            // navigate into the OLD content and the user would only
            // see the new content after Ctrl+C and restart.
            //
            // Replacing the entry unconditionally is what makes edits
            // visible IMMEDIATELY. Cross-render user state (Storages /
            // Alerts) is preserved from the previous instance so the
            // embedded func does not lose its own stored data.
            const inst = instance || new cls();
            inst._syappInstance = this._syappInstance;
            const previous = this._syappInstance.Funcs.get(realName);
            if (previous) {
              if (previous.UserStorage) inst.UserStorage = previous.UserStorage;
              if (previous.AlertStorage) inst.AlertStorage = previous.AlertStorage;
            }
            this._syappInstance.Funcs.set(realName, inst);

            // Record the return target for this embedded func so its
            // default "← Return" button knows where to go back to.
            this._syappInstance._embReturnTargets =
              this._syappInstance._embReturnTargets || new Map();
            const session = this.Builds.get(id)?.Session;
            if (session && session.UniqueID) {
              const existing = this._syappInstance._embReturnTargets.get(session.UniqueID) || {};
              existing[realName] = {
                func: this.Name,
                props: { ...(session.ActualProps || {}) }
              };
              this._syappInstance._embReturnTargets.set(session.UniqueID, existing);
            }

            this.GotoNow(id, realName, { props: {} });
            return null;
          }
        }
      }

      // Manual file path entry
      if (curProps[P.editFilePath] === 'start') {
        delete curProps[P.editFilePath];
        this.WaitInput(id, {
          question: 'File path: ', path: this.Name,
          props: { ...passProps, [P.editFilePath]: 'commit' }
        });
        return null;
      }
      if (curProps[P.editFilePath] === 'commit') {
        delete curProps[P.editFilePath];
        const v = String(curProps.inputValue || '').trim();
        delete curProps.inputValue;
        if (v) {
          state.filePath = v;
          state.source = 'file';
          state.saveMode = 'path';
          state.error = null;
          state.editPanel = false;
          this.Storages.Set(id, storageKey, state);
          // Auto-register the class so ▶ Enter Func can navigate to it.
          //
          // Always replace any previous registration with the freshly
          // imported class, so a re-typed path/edited file is visible
          // immediately instead of falling back to a stale instance.
          try {
            const cls = await this._embImportFile(v);
            if (cls && this._syappInstance) {
              let realName = cls.name || null;
              let instance = null;
              try { instance = new cls(); } catch (_) {}
              if (instance && instance.Name) realName = instance.Name;
              if (realName) {
                const inst = instance || new cls();
                inst._syappInstance = this._syappInstance;
                const previous = this._syappInstance.Funcs.get(realName);
                if (previous) {
                  if (previous.UserStorage) inst.UserStorage = previous.UserStorage;
                  if (previous.AlertStorage) inst.AlertStorage = previous.AlertStorage;
                }
                this._syappInstance.Funcs.set(realName, inst);
              }
            }
          } catch (e) {
            state.error = e.message || String(e);
            this.Storages.Set(id, storageKey, state);
          }
        }
      }

      // Manual code entry (single line, \n escaped)
      if (curProps[P.editCode] === 'start') {
        delete curProps[P.editCode];
        this.WaitInput(id, {
          question: 'Paste code (use \\n for newlines): ', path: this.Name,
          props: { ...passProps, [P.editCode]: 'commit' }
        });
        return null;
      }
      if (curProps[P.editCode] === 'commit') {
        delete curProps[P.editCode];
        const raw = String(curProps.inputValue || '');
        delete curProps.inputValue;
        if (raw) {
          state.code = raw.replace(/\\n/g, '\n');
          state.source = 'code';
          state.saveMode = 'inline';
          state.error = null;
          state.editPanel = false;
          this.Storages.Set(id, storageKey, state);
          // Auto-register the inline code so ▶ Enter Func works with a
          // real funcname navigation (no synthetic lookup).
          //
          // Always replace any previous registration with the freshly
          // imported class, so re-pasted/edited inline code is visible
          // immediately instead of falling back to a stale instance.
          try {
            const cls = await this._embImportCode(state.code);
            if (cls && this._syappInstance) {
              let realName = cls.name || null;
              let instance = null;
              try { instance = new cls(); } catch (_) {}
              if (instance && instance.Name) realName = instance.Name;
              if (realName) {
                const inst = instance || new cls();
                inst._syappInstance = this._syappInstance;
                const previous = this._syappInstance.Funcs.get(realName);
                if (previous) {
                  if (previous.UserStorage) inst.UserStorage = previous.UserStorage;
                  if (previous.AlertStorage) inst.AlertStorage = previous.AlertStorage;
                }
                this._syappInstance.Funcs.set(realName, inst);
              }
            }
          } catch (e) {
            state.error = e.message || String(e);
            this.Storages.Set(id, storageKey, state);
          }
        }
      }

      // Write snippet to the host file if a sourceFile was declared
      if (curProps[P.writeSource]) {
        delete curProps[P.writeSource];
        if (cfg.sourceFile) {
          try {
            const snippet = state.saveMode === 'inline'
              ? this._embSnippetInline(state, cfg)
              : this._embSnippetPath(state, cfg);
            const existing = fs.existsSync(cfg.sourceFile)
              ? fs.readFileSync(cfg.sourceFile, 'utf8')
              : '';
            const marker =
              `\n// [SyAPP.Emb append ${new Date().toISOString()}]\n` +
              snippet.split('\n').map(l => '// ' + l).join('\n') + '\n';
            fs.writeFileSync(cfg.sourceFile, existing + marker);
            this.Alert(id,
              `📝 Appended Emb snippet to ${path.basename(cfg.sourceFile)}`,
              { duration: 3000 });
          } catch (e) {
            this.Alert(id, `❌ ${e.message}`, { duration: 4000 });
          }
        }
      }

      // Consume any pending file picker selection
      //
      // NOTE: this now triggers for BOTH the setup view AND the edit
      // sub-panel (pickMode can be set from either), and it always
      // resets `editPanel` to false so the dropdown snaps back to the
      // clean 2-button view right after a new file is chosen.
      //
      // It also AUTO-REGISTERS the picked func into SyAPP.Funcs under
      // its real class name, so ▶ Enter Func is always a plain
      // funcname navigation — never a synthetic lookup.
      if (state.pickMode) {
        const picked = this.FileManager.GetSelected(id, pickerName);
        if (picked.length > 0) {
          this.FileManager.ClearSelection(id, pickerName);
          state.filePath = picked[0];
          state.source = 'file';
          state.saveMode = 'path';
          state.pickMode = false;
          state.error = null;
          state.editPanel = false;
          this.Storages.Set(id, storageKey, state);

          // Auto-register the picked class so Enter Func can navigate
          // to its real name immediately.
          //
          // Always replace any previous registration so re-picking the
          // same .js file (after editing it on disk) is visible without
          // needing Ctrl+C + restart.
          try {
            const cls = await this._embImportFile(picked[0]);
            if (cls && this._syappInstance) {
              let realName = cls.name || null;
              let instance = null;
              try { instance = new cls(); } catch (_) {}
              if (instance && instance.Name) realName = instance.Name;
              if (realName) {
                const inst = instance || new cls();
                inst._syappInstance = this._syappInstance;
                const previous = this._syappInstance.Funcs.get(realName);
                if (previous) {
                  if (previous.UserStorage) inst.UserStorage = previous.UserStorage;
                  if (previous.AlertStorage) inst.AlertStorage = previous.AlertStorage;
                }
                this._syappInstance.Funcs.set(realName, inst);
              }
            }
          } catch (e) {
            state.error = e.message || String(e);
            this.Storages.Set(id, storageKey, state);
          }
        }
      }

      // ------------------------------------------------------------------
      // Resolve the embedded class
      // ------------------------------------------------------------------
      let EmbClass = await this._embResolveClass(state, cfg);
      if (EmbClass && state.error) {
        state.error = null;
        this.Storages.Set(id, storageKey, state);
      }

      // ------------------------------------------------------------------
      // Run the embedded build INLINE
      // ------------------------------------------------------------------
      let embedded = null;
      if (EmbClass && cfg.autoRun !== false) {
        try {
          embedded = await this._embRunInline(id, EmbClass, cfg);
        } catch (e) {
          state.error = e.message || String(e);
          this.Storages.Set(id, storageKey, state);
        }
      }

      // ------------------------------------------------------------------
      // Render the management DropDown
      //
      // Two visual modes, driven by whether a source has been chosen:
      //
      //   • source === 'none'  → SETUP view (Self Build, Pick File, and
      //                          manual entry). This is what the user
      //                          sees right after dropping an empty
      //                          this.Emb() widget into the canvas.
      //
      //   • source !== 'none'  → CLEAN view: exactly TWO buttons,
      //                          `▶ Enter Func` and `✎ Edit`. Everything
      //                          else (Self Build, Pick File, Path /
      //                          Inline mode toggles, snippet, write-back,
      //                          Clear) lives INSIDE the `✎ Edit`
      //                          sub-panel, so the top of the dropdown
      //                          stays minimal once a func is attached.
      // ------------------------------------------------------------------
      if (curProps[P.toggleEditPanel]) {
        delete curProps[P.toggleEditPanel];
        state.editPanel = !state.editPanel;
        this.Storages.Set(id, storageKey, state);
      }

      await this.DropDown(id, `${storageKey}_mgmt`, async () => {
        // ---------------- SETUP view (no source yet) ----------------
        if (state.source === 'none') {
          this.SideButton(id, {
            name: ColorText.brightMagenta('🧩 Self Build'),
            props: { [P.selfBuild]: true }
          });
          this.SideButton(id, {
            name: ColorText.brightBlue('📁 Pick File'),
            props: { [P.pickFile]: true }
          });

          if (state.pickMode) {
            await this.File(id, {
              name: pickerName,
              multiple: false,
              filter: (p, isDir) => isDir || /\.(js|mjs|cjs)$/i.test(p),
              startPath: cfg.startPath || process.cwd(),
              displayName: '📁 Choose a Func .js file'
            });
          }

          if (state.error) {
            this.Text(id, ' ');
            this.Text(id, ColorText.red('⚠ ' + state.error));
          }

          this.Text(id, ' ');
          this.Text(id, ColorText.dim('Or set the source manually:'));
          this.Buttons(id, [
            { name: '✎ File path',   props: { [P.editFilePath]: 'start' } },
            { name: '✎ Paste code',  props: { [P.editCode]: 'start' } }
          ]);
          return;
        }

        // ---------------- CLEAN view (source present) ----------------
        if (!state.editPanel) {
          this.Buttons(id, [
            {
              name: ColorText.bgGreen(ColorText.black(' ▶ Enter Func ')),
              props: { [P.enterFunc]: true }
            },
            {
              name: ColorText.brightYellow('✎ Edit'),
              props: { [P.toggleEditPanel]: true }
            }
          ]);

          if (state.error) {
            this.Text(id, ' ');
            this.Text(id, ColorText.red('⚠ ' + state.error));
          }
          return;
        }

        // ---------------- EDIT sub-panel (source present) ----------------
        this.Button(id, {
          name: ColorText.orange('◀ Back'),
          props: { [P.toggleEditPanel]: true }
        });

        const srcLabel = state.source === 'file'
          ? `📄 ${_fit(path.basename(state.filePath || '?'), 40)}`
          : state.source === 'code'
            ? '⌨ inline code'
            : '◆ class reference';
        this.Text(id, `${ColorText.dim('Source:')} ${srcLabel}`);

        this.SideButton(id, {
          name: ColorText.brightMagenta('🧩 Self Build'),
          props: { [P.selfBuild]: true }
        });
        this.SideButton(id, {
          name: ColorText.brightBlue('📁 Pick File'),
          props: { [P.pickFile]: true }
        });
        this.SideButton(id, {
          name: ColorText.brightGreen('▶ Enter Func'),
          props: { [P.enterFunc]: true }
        });

        if (state.pickMode) {
          await this.File(id, {
            name: pickerName,
            multiple: false,
            filter: (p, isDir) => isDir || /\.(js|mjs|cjs)$/i.test(p),
            startPath: cfg.startPath || process.cwd(),
            displayName: '📁 Choose a Func .js file'
          });
        }

        this.Text(id, ' ');
        this.Buttons(id, [
          {
            name: state.saveMode === 'path'
              ? ColorText.bgGreen(ColorText.black(' ✓ Path mode '))
              : '○ Path mode',
            props: { [P.saveAsPath]: true }
          },
          {
            name: state.saveMode === 'inline'
              ? ColorText.bgGreen(ColorText.black(' ✓ Inline mode '))
              : '○ Inline mode',
            props: { [P.saveAsInline]: true }
          }
        ]);

        const snippet = state.saveMode === 'inline'
          ? this._embSnippetInline(state, cfg)
          : this._embSnippetPath(state, cfg);

        this.TextButton(id, `${storageKey}_snippet`, {
          label: 'Source snippet (paste into your func file)',
          initialValue: snippet,
          lines: 8,
          editable: false
        });

        if (cfg.sourceFile && fs.existsSync(cfg.sourceFile)) {
          this.Button(id, {
            name: ColorText.brightYellow('✎ Write snippet to host file'),
            props: { [P.writeSource]: true }
          });
        }

        if (state.error) {
          this.Text(id, ' ');
          this.Text(id, ColorText.red('⚠ ' + state.error));
        }

        this.Button(id, {
          name: ColorText.red('✕ Clear Emb'),
          props: { [P.clear]: true }
        });
      }, {
        up_buttontext: cfg.dropdown.up_buttontext,
        down_buttontext: cfg.dropdown.down_buttontext,
        up_emoji: cfg.dropdown.up_emoji,
        down_emoji: cfg.dropdown.down_emoji
      });

      return embedded;
    };

    // --------------------------- Emb Internals ---------------------------

    /**
     * Resolve the embedded class based on the current state. Handles the
     * three source modes ('class', 'file', 'code') and returns a class,
     * or null on failure (with `state.error` set).
     * @private
     */
    this._embResolveClass = async (state, cfg) => {
      if (state.source === 'class' && cfg.funcClass) return cfg.funcClass;
      if (state.source === 'file' && state.filePath) {
        try { return await this._embImportFile(state.filePath); }
        catch (e) { state.error = e.message || String(e); return null; }
      }
      if (state.source === 'code' && state.code) {
        try { return await this._embImportCode(state.code); }
        catch (e) { state.error = e.message || String(e); return null; }
      }
      return null;
    };

    /**
     * Import a SyAPP_Func class from a .js/.mjs/.cjs file.
     *
     * `Cannot use import statement outside a module`:
     * Node treats `.js` as CommonJS unless the nearest package.json has
     * `"type": "module"`. Any embedded func file we generate — or any
     * hand-written func file a user picks — contains ESM `import` /
     * `export` statements, so importing it as a plain `.js` blows up
     * with exactly that error.
     *
     * We solve it by resolving to one of two safe entry points:
     *   • `.mjs` / `.cjs` → import directly (Node already knows the
     *     module system from the extension).
     *   • `.js`           → mirror the source into a temp `.mjs` file
     *     (rewriting relative import specifiers so they still resolve
     *     from the ORIGINAL directory), then import THAT. The mirror is
     *     cached per absolute path so repeated Emb() renders do not
     *     rewrite the same file again and again.
     *
     * @param {string} filePath
     * @returns {Promise<Function>}
     * @private
     */
    this._embImportFile = async (filePath) => {
      const abs = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);
      if (!fs.existsSync(abs)) {
        throw new Error(`Embedded func file not found: ${filePath}`);
      }
      const mod = await this._embImportAsEsm(abs, fs.readFileSync(abs, 'utf8'));
      return this._embPickClass(mod, abs);
    };

    /**
     * Import a SyAPP_Func class from a raw source string.
     * Always written to a `.mjs` temp file — safe regardless of the
     * surrounding project's package.json "type" field.
     *
     * @param {string} code
     * @returns {Promise<Function>}
     * @private
     */
    this._embImportCode = async (code) => {
      const dir = path.join(os.tmpdir(), 'syapp_emb');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(
        dir,
        `emb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mjs`
      );
      fs.writeFileSync(tmp, String(code), 'utf8');
      const fileUrl = url.pathToFileURL(tmp).href + '?t=' + Date.now();
      const mod = await import(fileUrl);
      return this._embPickClass(mod, tmp);
    };

    /**
     * Import the source of an embedded func as an ES module, safely,
     * regardless of the file's original extension.
     *
     * If `srcPath` already ends in `.mjs`, the file is imported directly.
     * Otherwise, the source is written to a mirrored `.mjs` file inside
     * a stable temp directory, with:
     *   • a generated `package.json` marking the directory as ESM, so
     *     even a bare `.js` mirror is treated as a module by Node;
     *   • RELATIVE import specifiers rewritten to point back at the
     *     original directory (so `./something.js` still resolves);
     *   • non-relative (bare / absolute / `file:`) specifiers left
     *     untouched, because those resolve identically from anywhere.
     *
     * The mirror is cached per absolute source path, so the same file
     * is only mirrored once per process.
     *
     * @param {string} srcPath  Absolute path to the original source file
     * @param {string} source   Raw source text (already read)
     * @returns {Promise<object>}  The imported module namespace object
     * @private
     */
    this._embImportAsEsm = async (srcPath, source) => {
      // `.mjs` (or `.cjs`) already tell Node the module system. Import
      // the original file directly.
      if (srcPath.endsWith('.mjs') || srcPath.endsWith('.cjs')) {
        const fileUrl = url.pathToFileURL(srcPath).href + '?t=' + Date.now();
        return await import(fileUrl);
      }

      // Non-.mjs source: mirror it into a stable temp `.mjs` file.
      //
      // The mirror cache is keyed by ABSOLUTE PATH *AND* a content hash.
      // If the source text has changed (e.g. the user edited the
      // embedded func via Self Build → Finish & Return), we treat the
      // cache as a MISS, rewrite the mirror with the fresh source and
      // re-import. Without this hash check, the OLD mirror file would
      // be reused and a stale class would be handed back to the Enter
      // Func flow — which is exactly the "changes only apply after
      // Ctrl+C and restart" symptom.
      this._embEsmMirrorCache = this._embEsmMirrorCache || new Map();
      const srcHash = createHash('sha1').update(String(source)).digest('hex').slice(0, 16);
      const cached = this._embEsmMirrorCache.get(srcPath);

      if (cached && cached.hash === srcHash && fs.existsSync(cached.file)) {
        const fileUrl = url.pathToFileURL(cached.file).href + '?t=' + Date.now();
        return await import(fileUrl);
      }

      const srcDir = path.dirname(srcPath);
      const mirrorRoot = path.join(os.tmpdir(), 'syapp_emb_mirror');
      if (!fs.existsSync(mirrorRoot)) fs.mkdirSync(mirrorRoot, { recursive: true });

      // `package.json` marking the mirror tree as ESM. Written once;
      // harmless if it already exists.
      const pkgPath = path.join(mirrorRoot, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(pkgPath, JSON.stringify({ type: 'module' }, null, 2), 'utf8');
      }

      // Unique subdirectory per source file, keyed by a hash of the
      // absolute path, so no two mirrors ever collide.
      const hash = createHash('sha1').update(srcPath).digest('hex').slice(0, 16);
      const mirrorDir = path.join(mirrorRoot, hash);
      if (!fs.existsSync(mirrorDir)) fs.mkdirSync(mirrorDir, { recursive: true });
      const mirrorFile = path.join(mirrorDir, path.basename(srcPath).replace(/\.js$/i, '.mjs'));

      // Rewrite only RELATIVE import specifiers so they resolve from the
      // ORIGINAL directory, not from the mirror directory. Bare and
      // absolute specifiers are left untouched.
      const rewriteSpecifier = (spec) => {
        if (!spec) return spec;
        if (!spec.startsWith('./') && !spec.startsWith('../')) return spec;
        const absTarget = path.resolve(srcDir, spec);
        return url.pathToFileURL(absTarget).href;
      };

      let mirrorSource = source
        .replace(/(\bfrom\s+)(['"])([^'"]+)\2/g, (m, kw, q, spec) => {
          return kw + q + rewriteSpecifier(spec) + q;
        })
        .replace(/(\bimport\s+)(['"])([^'"]+)\2/g, (m, kw, q, spec) => {
          return kw + q + rewriteSpecifier(spec) + q;
        });

      fs.writeFileSync(mirrorFile, mirrorSource, 'utf8');
      this._embEsmMirrorCache.set(srcPath, { file: mirrorFile, hash: srcHash });

      const fileUrl = url.pathToFileURL(mirrorFile).href + '?t=' + Date.now();
      return await import(fileUrl);
    };

    /**
     * Pick the first exported class that duck-types as a SyAPP_Func.
     * @private
     */
    this._embPickClass = (mod, src) => {
      const cands = [];
      if (mod && mod.default !== undefined) cands.push(mod.default);
      if (mod) for (const k of Object.keys(mod)) {
        if (k !== 'default') cands.push(mod[k]);
      }
      for (const c of cands) {
        if (typeof c !== 'function') continue;
        try {
          const probe = new c();
          if (probe && typeof probe.Build === 'function' && typeof probe.Text === 'function') {
            return c;
          }
        } catch (_) { /* try next */ }
      }
      throw new Error(`No SyAPP_Func subclass exported from ${src}`);
    };

    /**
     * Run the embedded func's raw build function with the PARENT's build
     * maps shared, so every Text/Button/Page/… call from the embedded
     * build lands directly on the current session's userBuild — making
     * the embedded output render INLINE.
     *
     * Pinned-area isolation: the embedded instance shares the parent's
     * session, so calls with `pinned: true` / `pinnedTop: true` from the
     * embedded build naturally route into the parent's pinned areas.
     * The `_pinContext` field (used by this.PinnedTop / this.PinnedBottom)
     * is delegated to the parent's userBuild so a nested PinnedTop block
     * inside the embedded func correctly marks its children.
     *
     * @private
     */
    this._embRunInline = async (parentId, EmbClass, cfg) => {
      const instance = new EmbClass();
      instance._syappInstance = this._syappInstance;

      // Share the internal maps so the embedded build writes land on the
      // PARENT's userBuild for the same session id.
      const savedBuilds = instance.Builds;
      const savedUserStorage = instance.UserStorage;
      const savedAlertStorage = instance.AlertStorage;
      const savedPinCtx = instance._pinContext;
      instance.Builds = this.Builds;
      instance.UserStorage = this.UserStorage;
      instance.AlertStorage = this.AlertStorage;

      try {
        if (!this.Builds.has(parentId)) return null;

        const props = {
          session: this.Builds.get(parentId).Session,
          _isEmbedded: true,
          _embeddedFrom: this.Name
        };

        if (typeof instance._rawBuild === 'function') {
          // Preferred path — direct access to the build body, no
          // lifecycle hooks, no userBuild teardown. Pinned-area
          // handling is transparently delegated through the shared
          // `this.Builds` map, so this.PinnedTop()/this.PinnedBottom()
          // inside the embedded build correctly mark the parent's
          // userBuild._pinContext.
          await instance._rawBuild(props);
        } else if (typeof instance.Build === 'function') {
          // Fallback for cross-module imports where _rawBuild is absent:
          // call Build() and merge the returned hud_obj into the parent.
          const r = await instance.Build(props);
          if (r && r.hud_obj) {
            const pb = this.Builds.get(parentId);
            if (r.hud_obj.title) {
              pb.Text = pb.Text ? pb.Text + '\n' + r.hud_obj.title : r.hud_obj.title;
            }
            if (r.hud_obj.pinnedTopTitle) {
              pb.PinnedTopText = pb.PinnedTopText
                ? pb.PinnedTopText + '\n' + r.hud_obj.pinnedTopTitle
                : r.hud_obj.pinnedTopTitle;
            }
            if (r.hud_obj.pinnedTitle) {
              pb.PinnedText = pb.PinnedText
                ? pb.PinnedText + '\n' + r.hud_obj.pinnedTitle
                : r.hud_obj.pinnedTitle;
            }
            if (Array.isArray(r.hud_obj.options)) {
              for (const b of r.hud_obj.options) pb.Buttons.push(b);
            }
          }
        }
        return instance;
      } finally {
        instance.Builds = savedBuilds;
        instance.UserStorage = savedUserStorage;
        instance.AlertStorage = savedAlertStorage;
        instance._pinContext = savedPinCtx;
      }
    };

    /**
     * Build the source snippet for the PATH save mode.
     * @private
     */
    this._embSnippetPath = (state, cfg) => {
      return [
        `await this.Emb(id, {`,
        `  name: ${JSON.stringify(cfg.name)},`,
        `  filePath: ${JSON.stringify(state.filePath || './path/to/func.js')}`,
        `})`
      ].join('\n');
    };

    /**
     * Build the source snippet for the INLINE save mode.
     * @private
     */
    this._embSnippetInline = (state, cfg) => {
      const safe = String(state.code || '')
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');
      return [
        `await this.Emb(id, {`,
        `  name: ${JSON.stringify(cfg.name)},`,
        '  code: `',
        safe,
        '  `',
        `})`
      ].join('\n');
    };

    // --------------------------- JavaScript Runner / Explorer ---------------------------

    /**
     * Minimalist JS runner/explorer.
     *
     * Visual contract:
     *   • Collapsed: exactly ONE dropdown button.
     *   • Expanded, no source: `📁 file` (nested picker) + `✎ code`
     *     (this.TextEditor). Recents show up if any exist.
     *   • Expanded, source present: `▶ execute` first, then `✎ edit`,
     *     `🕘 recents`, `↺ reset`, then the ƒ/◈ lists that open the
     *     class/instance playground.
     *   • Recents view: `📄 load`, `📌 pin`, `✎ rename`, `🗑 del` per entry.
     *
     * Persistence:
     *   Every inline code written through the editor is auto-saved to
     *   `<os.tmpdir()>/syapp_js_codes/*.json`. Pinned entries are never
     *   pruned; unpinned ones are trimmed to the newest 20.
     *
     * @param {string} id
     * @param {string} [codeOrPath='']  file path OR inline JS source
     * @param {Object} [config]
     * @param {string} [config.name='js']
     * @param {Function} [config.filter]
     * @param {string} [config.startPath]
     * @param {number} [config.timeout=30000]
     * @param {boolean} [config.classOnly=false]
     * @returns {Promise<void>}
     */
    this.JavaScript = async (id, codeOrPath = '', config = {}) => {
      if (!this.Builds.has(id)) {
        if (this.Log) console.log(`this.JavaScript() Error - userBuild not found | BuildID: ${id}`);
        return null;
      }

      const cfg = { name: 'js', filter: null, startPath: undefined, timeout: 30000, classOnly: false, ...config };
      const sk = `javascript_${cfg.name}`;
      const fp = `${sk}_f`;
      const fpn = `${sk}_picker`;
      const edk = `texteditor_${fp}_code`;
      const fFilter = cfg.filter || ((p, isDir) => isDir || /\.(js|mjs|cjs)$/i.test(p));

      const fresh = () => ({
        source: 'none', filePath: null, code: '', parsed: null,
        selectedClass: null, selectedMethod: null,
        ctorArgs: {}, methodArgs: {}, propsJson: '{}',
        instance: null, result: null, runResult: null,
        view: null, editing: false, currentCodeFile: null
      });

      if (!this.Storages.Has(id, sk)) {
        const init = fresh();
        if (typeof codeOrPath === 'string' && codeOrPath) {
          const asPath = /\.(js|mjs|cjs)$/i.test(codeOrPath) || (codeOrPath.length < 1024 && fs.existsSync(codeOrPath));
          if (asPath) {
            init.source = 'file';
            init.filePath = path.isAbsolute(codeOrPath) ? codeOrPath : path.resolve(process.cwd(), codeOrPath);
            try { init.code = fs.readFileSync(init.filePath, 'utf8'); init.parsed = _jsParse(init.code); } catch (_) {}
          } else {
            init.source = 'code'; init.code = codeOrPath; init.parsed = _jsParse(codeOrPath);
            const e = _jsSave({ name: _jsAutoName(codeOrPath), code: codeOrPath });
            init.currentCodeFile = e.file;
          }
        }
        this.Storages.Set(id, sk, init);
      }

      const st = this.Storages.Get(id, sk);
      const P  = this.Builds.get(id).Session.ActualProps || {};
      const curPage = P.page || '';
      const passProps = curPage ? { page: curPage } : {};

      // Rendering aliases.
      const L  = (name, props) => this.Button(id, props ? { name, props } : { name });
      const B  = (list)        => this.Buttons(id, list);
      const F  = (name, c)     => this.Field(id, name, c);
      const TB = (name, c)     => this.TextButton(id, name, c);

      const freshView = () => {
        st.selectedClass = null; st.selectedMethod = null;
        st.ctorArgs = {}; st.methodArgs = {};
        st.instance = null; st.result = null; st.runResult = null;
      };

      const buildArgs = (cls, method) => {
        const ca = (cls.constructorArgs || []).map((_, i) => _jsCoerce(st.ctorArgs[i]));
        const ma = method ? (method.params || []).map((_, i) => _jsCoerce(st.methodArgs[i])) : [];
        let props = {};
        try { props = JSON.parse(st.propsJson || '{}'); } catch (_) {}
        return { constructor: ca, method: ma, props };
      };

      const findClass  = (n) => (st.parsed?.classes   || []).find(c => c.name === n);
      const findMethod = (c, n) => (c?.methods || []).find(m => m.name === n);

      // Autosaves current st.code (creating a new file only on first
      // save) and prunes unpinned entries beyond 20.
      const saveCurrent = (name) => {
        if (!st.code || !st.code.trim()) return null;
        const prev = st.currentCodeFile ? _jsLoad(st.currentCodeFile) : null;
        const e = _jsSave({
          file: st.currentCodeFile,
          name: name || (prev ? prev.name : _jsAutoName(st.code)),
          code: st.code,
          pinned: prev ? prev.pinned : false,
          createdAt: prev ? prev.createdAt : Date.now()
        });
        st.currentCodeFile = e.file;
        _jsPrune(20);
        return e;
      };

      // ---------------------------------------------------------------
      // PROP HANDLERS
      // ---------------------------------------------------------------

      if (P.__js_run) {
        delete P.__js_run;
        st.runResult = null; st.result = null;
        if (st.source === 'file' && st.filePath)
          st.runResult = { ...(await _jsRunNode(st.filePath, [], { timeout: cfg.timeout })), mode: 'file' };
        else if (st.source === 'code' && st.code.trim())
          st.runResult = { ...(await _jsRunInline(st.code, { timeout: cfg.timeout })), mode: 'inline' };
      }

      if (P.__js_runFn !== undefined) {
        const fnName = P.__js_runFn;
        delete P.__js_runFn;
        st.runResult = null;
        if (st.source === 'file' && st.filePath && fnName) {
          const wrapper = [
            `import { pathToFileURL } from 'url';`,
            `(async()=>{try{`,
            `const m=await import(pathToFileURL(${JSON.stringify(st.filePath)}).href+'?t='+Date.now());`,
            `const fn=m[${JSON.stringify(fnName)}]||(m.default&&m.default[${JSON.stringify(fnName)}]);`,
            `if(typeof fn!=='function')throw new Error('Function not found: '+${JSON.stringify(fnName)});`,
            `const r=await fn();`,
            `process.stdout.write(JSON.stringify({ok:true,result:r===undefined?null:r}))`,
            `}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message}))}})();`
          ].join('\n');
          const tmp = path.join(os.tmpdir(), `syapp_fn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mjs`);
          fs.writeFileSync(tmp, wrapper, 'utf8');
          try {
            const r = await _jsRunNode(tmp, [], { timeout: cfg.timeout });
            let parsed = null;
            try { parsed = JSON.parse((r.stdout || '').trim() || 'null'); } catch (_) {}
            st.runResult = parsed ? {
              ok: !!parsed.ok,
              stdout: parsed.ok ? JSON.stringify(parsed.result, null, 2) : '',
              stderr: parsed.ok ? '' : String(parsed.error || ''),
              code: parsed.ok ? 0 : 1,
              mode: 'ƒ ' + fnName
            } : { ...r, mode: 'ƒ ' + fnName };
          } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
        }
      }

      if (P.__js_reset) {
        delete P.__js_reset;
        const keep = st.currentCodeFile; // recents entry survives reset
        Object.assign(st, fresh());
        st.currentCodeFile = keep;
        this.Storages.Delete(id, edk);
        this.FileManager.ClearSelection(id, fpn);
      }

      if (P.__js_edit) {
        delete P.__js_edit;
        this.Storages.Set(id, edk, st.code || '');
        st.editing = true;
      }

      if (P.__js_view !== undefined) {
        st.view = P.__js_view || null;
        delete P.__js_view;
      }

      if (P.__js_loadRecent) {
        const e = _jsLoad(P.__js_loadRecent);
        delete P.__js_loadRecent;
        if (e) {
          st.source = 'code';
          st.code = e.code;
          st.parsed = _jsParse(e.code);
          st.currentCodeFile = e.file;
          st.view = null;
          freshView();
          this.Storages.Set(id, edk, e.code);
        }
      }

      if (P.__js_pinRecent) {
        const e = _jsLoad(P.__js_pinRecent);
        delete P.__js_pinRecent;
        if (e) { e.pinned = !e.pinned; _jsSave(e); }
      }

      if (P.__js_delRecent) {
        _jsDel(P.__js_delRecent);
        delete P.__js_delRecent;
      }

      if (P.__js_renameRecent) {
        const file = P.__js_renameRecent;
        delete P.__js_renameRecent;
        const e = _jsLoad(file);
        if (e) {
          this.WaitInput(id, {
            path: this.Name,
            props: { ...passProps, __js_renameWait: `${cfg.name}::${file}` },
            question: `Rename "${e.name}" → `
          });
          return;
        }
      }

      // WaitInput response for a pending rename. The marker prop is
      // namespaced per widget, so two JavaScript instances never
      // collide. SelfBuilder only consumes `inputValue` when ITS OWN
      // pending flags are set — see _processActions.
      if (P.__js_renameWait && P.inputValue !== undefined) {
        const marker = String(P.__js_renameWait);
        const file = marker.split('::')[1];
        const newName = String(P.inputValue || '').trim();
        delete P.__js_renameWait;
        delete P.inputValue;
        if (file && newName) {
          const e = _jsLoad(file);
          if (e) { e.name = newName; _jsSave(e); }
        }
      }

      if (P.__js_enterClass !== undefined) {
        const v = P.__js_enterClass; delete P.__js_enterClass;
        st.selectedClass = v || null; st.selectedMethod = null;
        st.ctorArgs = {}; st.methodArgs = {};
        st.result = null; st.instance = null;
      }

      if (P.__js_enterMethod !== undefined) {
        const v = P.__js_enterMethod; delete P.__js_enterMethod;
        st.selectedMethod = v || null; st.methodArgs = {}; st.result = null;
      }

      if (P.__js_back) {
        delete P.__js_back;
        if (st.selectedMethod !== null) { st.selectedMethod = null; st.methodArgs = {}; }
        else if (st.selectedClass !== null) { freshView(); }
      }

      if (P.__js_instantiate) {
        delete P.__js_instantiate;
        const cls = st.source === 'file' && st.filePath && st.selectedClass ? findClass(st.selectedClass) : null;
        if (cls) {
          const r = await _jsRunClass(st.filePath, st.selectedClass, '__constructOnly', buildArgs(cls, null), { timeout: cfg.timeout });
          st.result = r.ok
            ? { ok: true, value: 'instance ready', instance: r.instance }
            : { ok: false, error: r.error, stack: r.stack };
          if (r.ok) st.instance = r.instance;
        }
      }

      if (P.__js_execute) {
        delete P.__js_execute;
        const cls    = st.source === 'file' && st.filePath && st.selectedClass ? findClass(st.selectedClass) : null;
        const method = cls && st.selectedMethod ? findMethod(cls, st.selectedMethod) : null;
        if (cls && method) {
          const r = await _jsRunClass(st.filePath, st.selectedClass, st.selectedMethod, buildArgs(cls, method), { timeout: cfg.timeout });
          st.result = r.ok
            ? { ok: true, value: r.result, instance: r.instance }
            : { ok: false, error: r.error, stack: r.stack };
          if (r.ok) st.instance = r.instance;
        }
      }

      if (P.__js_clearResult)   { delete P.__js_clearResult;   st.result = null; st.runResult = null; }
      if (P.__js_resetInstance) { delete P.__js_resetInstance; st.instance = null; st.result = null; }

      // ---------------------------------------------------------------
      // AUTO-LOAD from the nested file picker.
      // ---------------------------------------------------------------
      if (st.source === 'none') {
        const picked = this.FileManager.GetSelected(id, fpn);
        if (picked.length > 0) {
          this.FileManager.ClearSelection(id, fpn);
          try {
            st.filePath = picked[0];
            st.code = fs.readFileSync(picked[0], 'utf8');
            st.parsed = _jsParse(st.code);
            st.source = 'file';
            st.currentCodeFile = null;
            freshView();
            this.Alert(id, `✅ ${path.basename(picked[0])}`, { duration: 1500 });
          } catch (e) {
            this.Alert(id, `❌ ${e.message}`, { duration: 4000 });
          }
        }
      }

      // ---------------------------------------------------------------
      // RE-OPEN THE EDITOR (from ✎ edit or from the initial ✎ code button)
      // ---------------------------------------------------------------
      if (st.editing) {
        P[`__textEditor_${fp}_code`] = true;
        const prev = st.code || '';
        const code = await this.TextEditor(id, `${fp}_code`, {
          label: '',
          buttonText: '✎ code',
          initialValue: prev,
          title: 'JavaScript'
        });
        st.editing = false;
        if (typeof code === 'string' && code.trim() && code !== prev) {
          st.code = code;
          st.parsed = _jsParse(code);
          st.source = 'code';
          st.filePath = null;
          saveCurrent();
          freshView();
        }
      }

      // ---------------------------------------------------------------
      // ONE DROPDOWN — everything happens inside it.
      // ---------------------------------------------------------------
      const ddLabel = st.source === 'none'
        ? '⌨ javascript'
        : st.source === 'file'
          ? `📄 ${_jsFit(path.basename(st.filePath || 'js'), 40)}`
          : `⌨ ${_jsFit(st.currentCodeFile ? (_jsLoad(st.currentCodeFile)?.name || 'inline') : 'inline', 30)}`;

      await this.DropDown(id, `${sk}_dd`, async () => {

        // ================ RECENTS VIEW ================
        if (st.view === 'recents') {
          L(ColorText.orange('◀ back'), { __js_view: '' });
          const list = _jsList();
          if (list.length === 0) {
            L(ColorText.dim('(no saved codes)'));
          } else {
            for (const c of list) {
              B([
                { name: `📄 ${_jsFit(c.name, 26)}`, props: { __js_loadRecent: c.file } },
                { name: c.pinned ? '📌' : '☆', props: { __js_pinRecent: c.file } },
                { name: '✎', props: { __js_renameRecent: c.file } },
                { name: '🗑', props: { __js_delRecent: c.file } }
              ]);
            }
          }
          return;
        }

        // ================ NO SOURCE YET ================
        if (st.source === 'none') {
          await this.File(id, {
            name: fpn,
            multiple: false,
            filter: fFilter,
            startPath: cfg.startPath || process.cwd(),
            displayName: '📁 file'
          });

          const code = await this.TextEditor(id, `${fp}_code`, {
            label: '',
            buttonText: '✎ code',
            initialValue: '',
            title: 'JavaScript'
          });
          if (code && code.trim()) {
            st.source = 'code';
            st.code = code;
            st.parsed = _jsParse(code);
            st.filePath = null;
            st.currentCodeFile = null;
            saveCurrent();
            freshView();
          }

          const n = _jsList().length;
          if (n > 0) L(ColorText.dim(`🕘 recents (${n})`), { __js_view: 'recents' });

          if (st.source === 'none') return;
        }

        // ================ ROOT VIEW ================
        if (!st.selectedClass) {
          L(ColorText.bgGreen(ColorText.black(' ▶ execute ')), { __js_run: 1 });

          const recents = _jsList().length;
          const rowActions = [];
          if (st.source === 'code' && st.code && st.code.trim())
            rowActions.push({ name: ColorText.cyan('✎ edit'), props: { __js_edit: 1 } });
          if (recents > 0)
            rowActions.push({ name: ColorText.dim(`🕘 (${recents})`), props: { __js_view: 'recents' } });
          if (st.runResult || st.instance || st.result)
            rowActions.push({ name: ColorText.red('↺ reset'), props: { __js_reset: 1 } });
          if (rowActions.length > 0) B(rowActions);

          const fns = st.parsed?.functions || [];
          if (!cfg.classOnly && fns.length > 0) {
            L(' ');
            L(ColorText.dim(`ƒ functions (${fns.length})`));
            B(fns.map(fn => ({
              name: `▶ ${fn.name}${(fn.params || []).length ? '(' + fn.params.join(', ') + ')' : ''}`,
              props: { __js_runFn: fn.name }
            })));
          }

          const cls = st.parsed?.classes || [];
          if (cls.length > 0) {
            L(' ');
            L(ColorText.dim(`◈ classes (${cls.length})`));
            B(cls.map(c => ({
              name: `◈ ${c.name}` +
                (c.extends ? ColorText.dim(' : ' + c.extends) : '') +
                ColorText.dim(` (${c.methods.length})`),
              props: { __js_enterClass: c.name }
            })));
          }

          if (cfg.classOnly ? cls.length === 0 : (fns.length === 0 && cls.length === 0)) {
            L(ColorText.dim('(nothing parsed — ▶ execute still runs the source)'));
          }

          if (st.runResult) {
            L(' ');
            L(`${st.runResult.ok ? ColorText.green('✓') : ColorText.red('✗')} ` +
              ColorText.dim(`exit ${st.runResult.code ?? '?'} · ${st.runResult.mode}`));
            const out = [
              st.runResult.stdout || '',
              st.runResult.stderr ? '\n[stderr]\n' + st.runResult.stderr : '',
              st.runResult.error ? '\n[error] ' + st.runResult.error : ''
            ].filter(Boolean).join('');
            if (out) TB(`${sk}_run_result`, {
              label: 'out',
              initialValue: out,
              lines: Math.min(14, Math.max(4, out.split('\n').length)),
              editable: false
            });
            L(ColorText.dim('✕ clear'), { __js_clearResult: 1 });
          }
        }

        // ================ CLASS VIEW ================
        else if (!st.selectedMethod) {
          const cls = findClass(st.selectedClass);
          L(ColorText.dim('◈ ') + ColorText.brightMagenta(ColorText.bold(st.selectedClass)) +
            (cls?.extends ? ColorText.dim(' : ' + cls.extends) : ''));

          if (!cls) { L(ColorText.orange('◀ back'), { __js_back: 1 }); return; }

          (cls.constructorArgs || []).forEach((name, i) => F(`${fp}_ctor_${i}`, {
            label: name,
            initialValue: st.ctorArgs[i] !== undefined ? String(st.ctorArgs[i]) : '',
            maxWidth: 30,
            onChange: (v) => { st.ctorArgs[i] = v; }
          }));

          F(`${fp}_props`, {
            label: 'props',
            initialValue: st.propsJson || '{}',
            maxWidth: 40,
            onChange: (v) => { st.propsJson = v; }
          });

          B([
            { name: ColorText.bgGreen(ColorText.black(' 🧪 create ')), props: { __js_instantiate: 1 } },
            { name: ColorText.orange('◀ back'), props: { __js_back: 1 } }
          ]);

          if (st.result) {
            L(' ');
            L(st.result.ok
              ? ColorText.green('✓ ' + (typeof st.result.value === 'string' ? st.result.value : 'ready'))
              : ColorText.red('✗ ' + (st.result.error || 'error')));
          }

          if (st.instance) {
            const s = JSON.stringify(st.instance, null, 2);
            TB(`${sk}_instance_view`, {
              label: 'instance',
              initialValue: s,
              lines: Math.min(14, Math.max(4, s.split('\n').length)),
              editable: false
            });
            if (cls.methods.length > 0) {
              L(' ');
              L(ColorText.dim(`methods (${cls.methods.length})`));
              B(cls.methods.map(m => ({
                name: `${m.isAsync ? '⏳' : m.isStatic ? '·' : '▶'} ${m.name}` +
                  ((m.params || []).length ? `(${m.params.join(', ')})` : ''),
                props: { __js_enterMethod: m.name }
              })));
            }
            L(ColorText.dim('↺ discard'), { __js_resetInstance: 1 });
          }
        }

        // ================ METHOD VIEW ================
        else {
          const cls = findClass(st.selectedClass);
          const method = cls ? findMethod(cls, st.selectedMethod) : null;

          L(ColorText.dim(`${st.selectedClass} › `) + ColorText.brightCyan(ColorText.bold(st.selectedMethod)));

          if (!method) { L(ColorText.orange('◀ back'), { __js_back: 1 }); return; }

          (method.params || []).forEach((name, i) => F(`${fp}_method_${i}`, {
            label: name,
            initialValue: st.methodArgs[i] !== undefined ? String(st.methodArgs[i]) : '',
            maxWidth: 30,
            onChange: (v) => { st.methodArgs[i] = v; }
          }));

          B([
            { name: ColorText.bgGreen(ColorText.black(' ▶ exec ')), props: { __js_execute: 1 } },
            { name: ColorText.orange('◀ back'), props: { __js_back: 1 } }
          ]);

          if (st.result) {
            L(' ');
            if (st.result.ok) {
              let s;
              try { s = JSON.stringify(st.result.value, null, 2); }
              catch (_) { s = String(st.result.value); }
              if (s === undefined) s = '(undefined)';
              TB(`${sk}_method_result`, {
                label: 'result',
                initialValue: s,
                lines: Math.min(16, Math.max(4, s.split('\n').length + 1)),
                editable: false
              });
            } else {
              L(ColorText.red('✗ ' + (st.result.error || 'error')));
              if (st.result.stack) TB(`${sk}_method_stack`, {
                label: 'stack',
                initialValue: String(st.result.stack),
                lines: 6,
                editable: false
              });
            }
            L(ColorText.dim('✕ clear'), { __js_clearResult: 1 });
          }
        }
      }, {
        up_buttontext: ddLabel,
        down_buttontext: ddLabel,
        up_emoji: '▶',
        down_emoji: '▼'
      });
    };

    // --------------------------- Build Method ---------------------------

    this.Build = async (props = { session: new Session }) => {
      const sessionId = props.session.UniqueID;
      const previousFuncName = props.session.PreviousPath;
      const currentFuncName = props.session.ActualPath || this.Name;
      
      if (previousFuncName && previousFuncName !== currentFuncName) {
        const previousFunc = this._syappInstance?.Funcs?.get(previousFuncName);
        if (previousFunc) {
          await previousFunc._executeSessionLeaveHooks(props);
          await previousFunc._executeFunctionLeaveHooks(props);
        }
      }
      
      this.Builds.set(sessionId, new userBuild({ session: props.session }))

      try {
        if (!props._isRefresh) {
          await this._executeFunctionEnterHooks(props);
          await this._executeSessionEnterHooks(props);
        }
        
        if (!props._isRefresh && typeof this.OnEnter === 'function') {
          const onEnterOnceKey = `_onEnter_${this.Name}`;
          let shouldExecuteLegacy = true;
          
          if (this.OnEnterOnce) {
            if (this.Storages.Has(sessionId, onEnterOnceKey) && 
                this.Storages.Get(sessionId, onEnterOnceKey) === true) {
              shouldExecuteLegacy = false;
            }
          }
          
          if (shouldExecuteLegacy) {
            try {
              await this.OnEnter(props);
              if (this.OnEnterOnce) {
                this.Storages.Set(sessionId, onEnterOnceKey, true);
              }
            } catch (onEnterError) {
              console.error(`OnEnter error for function ${this.Name}:`, onEnterError);
            }
          }
        }

        await build(props)

        const userBuild = this.Builds.get(sessionId)

        // ------------------------------------------------------------------
        // PAGE NAVIGATION ROW
        // ------------------------------------------------------------------
        // Pages that requested a pin button (via this.Page({ pinButton: true })
        // or globally via SyAPP({ autoPinPages: true })) were registered in
        // userBuild.PageNav during the build pass. Render them now as
        // ONE this.Buttons([...]) row per pin position, marking the
        // currently-selected page with ● / ○.
        // ------------------------------------------------------------------
        if (Array.isArray(userBuild.PageNav) && userBuild.PageNav.length > 0) {
          const activePage = (userBuild.Session.ActualProps && userBuild.Session.ActualProps.page) || '';

          const buildNavConfigs = (list, isTop) => list.map(p => {
            const isSelected = p.name === activePage;
            const marker = isSelected ? '● ' : '○ ';
            const cfg = {
              name: `${marker}${p.label || p.name}`,
              props: { page: p.name }
            };
            if (isTop) cfg.pinnedTop = true;
            else cfg.pinned = true;
            return cfg;
          });

          const topNavs = userBuild.PageNav.filter(p => p.pinPosition === 'top');
          const bottomNavs = userBuild.PageNav.filter(p => p.pinPosition !== 'top');

          if (topNavs.length > 0) {
            this.Buttons(sessionId, buildNavConfigs(topNavs, true));
          }
          if (bottomNavs.length > 0) {
            this.Buttons(sessionId, buildNavConfigs(bottomNavs, false));
          }
        }

        if (userBuild._hasAlerts || this.AlertStorage.has(sessionId)) {
          this.ProcessAlerts(sessionId);
        }

        if (userBuild && userBuild.GotoNow) {
          const gotoInfo = userBuild.GotoNow

          let obj_return = {
            hud_obj: {
              title: '',
              options: []
            },
            wait_input: false,
            input_obj: {},
            goto_now: {
              path: gotoInfo.path,
              props: gotoInfo.props
            },
            routes: userBuild.Routes
          }

          this.Builds.delete(sessionId)
          return obj_return
        }

        let obj_return = {
          hud_obj: {
            title: this.Builds.get(sessionId).Text,
            pinnedTopTitle: this.Builds.get(sessionId).PinnedTopText || undefined,
            pinnedTitle: this.Builds.get(sessionId).PinnedText || undefined,
            pinnedTopSeparator: this.Builds.get(sessionId).PinnedTopSeparator || 'line',
            pinnedBottomSeparator: this.Builds.get(sessionId).PinnedBottomSeparator || 'line',
            options: this.Builds.get(sessionId).Buttons
          },
          wait_input: this.Builds.get(sessionId).WaitInput,
          input_obj: {
            path: this.Builds.get(sessionId).InputPath,
            props: this.Builds.get(sessionId).InputProps,
            question: this.Builds.get(sessionId).InputQuestion,
            password: this.Builds.get(sessionId).InputPassword
          },
          goto_now: undefined,
          routes: this.Builds.get(sessionId).Routes
        }

        this.Builds.delete(sessionId)
        return obj_return

      } catch (error) {
        if (error.message === 'GOTO_NOW_BREAK' && error.gotoInfo) {
          this.Builds.delete(sessionId)

          return {
            hud_obj: {
              title: '',
              options: []
            },
            wait_input: false,
            input_obj: {},
            goto_now: {
              path: error.gotoInfo.path,
              props: error.gotoInfo.props
            },
            routes: {}
          }
        }

        throw error
      }
    }

    // --------------------------- Route Discovery Method ---------------------------

    this.DiscoverRoutes = async (discoveryProps = {}) => {
      const discoveryId = `route-discovery-${this.Name}-${Date.now()}`
      const discoverySession = new Session({
        uniqueid: discoveryId,
        machine_id: 'route-discovery',
        process_id: process.pid,
        external: true
      })

      const props = {
        session: discoverySession,
        ...discoveryProps
      }

      try {
        const result = await this.Build(props)
        return result.routes || { GET: [], POST: [], PUT: [], DELETE: [] }
      } catch (error) {
        console.error(`Error discovering routes for ${this.Name}:`, error)
        return { GET: [], POST: [], PUT: [], DELETE: [] }
      }
    }
  }
}

// --------------------------- NotFounded Class ---------------------------

/**
 * Not found error handler
 * @extends SyAPP_Func
 */
class NotFounded extends SyAPP_Func {
  constructor() {
    super(
      'notfounded',
      async (props) => {
        let uid = props.session.UniqueID
        this.Text(uid, `Func ${this.TextColor.brightRed(props.notfounded_func)} not founded !`)
        this.Button(uid, { name: '← Return', path: props.session.PreviousPath, props: props.session.PreviousProps })
      },
      {
        refreshMode: false // Error pages shouldn't auto-refresh
      }
    )
  }
}

// --------------------------- Error Class ---------------------------

/**
 * Error handler
 * @extends SyAPP_Func
 */
class Error extends SyAPP_Func {
  constructor() {
    super(
      'error',
      async (props) => {
        let uid = props.session.UniqueID
        this.Text(uid, `Internal error loading ${this.TextColor.brightRed(props.error_func)}\n`)
        if (props.error_message) { this.Alert(uid, props.error_message.toString()) }
        this.SideButton(uid, { name: '← Return', path: props.session.PreviousPath })
        this.SideButton(uid, { name: '⌂ Main Func', path: props.mainfunc })
      },
      {
        refreshMode: false // Error pages shouldn't auto-refresh
      }
    )
  }
}

// --------------------------- TemplateFunc Class ---------------------------

/**
 * Template function for examples
 * @extends SyAPP_Func
 */
class TemplateFunc extends SyAPP_Func {
  constructor() {
    super(
      'templatefunc',
      async (props) => {
        let uid = props.session.UniqueID

        // ------------------------------------------------------------------
        // PINNED ELEMENTS DEMO (TOP + BOTTOM, minimalist)
        // ------------------------------------------------------------------
        // Elements created with `{ pinnedTop: true }` stay fixed at the top,
        // above a single separator line. Elements with `{ pinned: true }`
        // stay fixed at the bottom, below a single separator line. The
        // middle area keeps its infinite-scroll viewport.
        //
        // Double-tap ↑ quickly to jump to the pinned-top area.
        // Double-tap ↓ quickly to jump to the pinned-bottom area.
        // ------------------------------------------------------------------

        // Pinned-TOP area (always visible at the top)
        this.Text(uid, '📌 Top', { pinnedTop: true })

        this.Button(uid, {
          name: '⬆ Top Action',
          props: { action: 'top' },
          pinnedTop: true
        })

        // Scrollable middle content
        for (let i = 1; i <= 100; i++) {
          this.Button(uid, {
            name: `Item ${i}`,
            props: { index: i }
          })
        }

        // Pinned-BOTTOM area (always visible at the bottom)
        this.Field(uid, 'pinned_demo_note', {
          label: '📝 Note',
          initialValue: 'edit me',
          pinned: true
        })

        this.Button(uid, {
          name: '📌 Home',
          props: { action: 'home' },
          pinned: true
        })
        this.Button(uid, {
          name: '📌 Refresh',
          props: { action: 'refresh' },
          pinned: true
        })
        this.Button(uid, {
          name: '📌 Exit',
          props: { action: 'exit' },
          pinned: true
        })
      }
    )
  }
}

// --------------------------- HTTPRoutesStorage Class ---------------------------

class HTTPRoutesStorage {
  constructor() {
    this.routes = new Map() // key: method:path, value: routeInfo
    this.routeMap = new Map() // key: path, value: array of {method, routeInfo}
    this.models = new Map() // key: method:path, value: {input, output}
    this.validationResponses = new Map() // key: method:path, value: validation response
    this.validationOptions = new Map() // key: method:path, value: validation options
  }
  
  addRoute(method, path, routeInfo) {
    const key = `${method}:${path}`
    this.routes.set(key, routeInfo)
    
    if (!this.routeMap.has(path)) {
      this.routeMap.set(path, [])
    }
    this.routeMap.get(path).push({ method, routeInfo })
    
    // Store models
    this.models.set(key, {
      input: routeInfo.input_model || {},
      output: routeInfo.output_model || {}
    })
    
    // Store validation response
    if (routeInfo.input_validate) {
      this.validationResponses.set(key, routeInfo.input_validate)
    }
    
    // Store validation options
    this.validationOptions.set(key, routeInfo.validation_options || { includeMissingKeys: true })
  }
  
  getRoute(method, path) {
    return this.routes.get(`${method}:${path}`)
  }
  
  getModels(method, path) {
    return this.models.get(`${method}:${path}`) || { input: {}, output: {} }
  }
  
  getValidationResponse(method, path) {
    return this.validationResponses.get(`${method}:${path}`)
  }
  
  getValidationOptions(method, path) {
    return this.validationOptions.get(`${method}:${path}`) || { includeMissingKeys: true }
  }
  
  getAllRoutes() {
    return Array.from(this.routes.entries()).map(([key, value]) => ({
      key,
      method: key.split(':')[0],
      path: key.split(':')[1],
      func: value.funcName,
      group: value.group,
      models: this.models.get(key),
      hasValidation: this.validationResponses.has(key),
      validationOptions: this.validationOptions.get(key)
    }))
  }
  
  getStats() {
    const stats = {
      total: this.routes.size,
      byMethod: { GET: 0, POST: 0, PUT: 0, DELETE: 0 },
      byFunc: {},
      withModels: 0,
      withValidation: 0
    }
    
    for (const [key, route] of this.routes) {
      const method = key.split(':')[0]
      stats.byMethod[method] = (stats.byMethod[method] || 0) + 1
      
      stats.byFunc[route.funcName] = (stats.byFunc[route.funcName] || 0) + 1
      
      const models = this.models.get(key)
      if (models && (Object.keys(models.input).length > 0 || Object.keys(models.output).length > 0)) {
        stats.withModels++
      }
      
      if (this.validationResponses.has(key)) {
        stats.withValidation++
      }
    }
    
    return stats
  }
  
  exportData() {
    return {
      routes: this.getAllRoutes(),
      stats: this.getStats(),
      timestamp: new Date().toISOString()
    }
  }
}

// --------------------------- AdminManager Class ---------------------------

/**
 * Admin management system for SyAPP
 * @class
 */
class AdminManager {
  /**
   * @param {SyAPP} syappInstance - Reference to SyAPP instance
   * @param {string} mainSessionId - Main session ID (always admin)
   */
  constructor(syappInstance, mainSessionId) {
    /** @type {SyAPP} */
    this.syapp = syappInstance;
    
    /** @type {Set<string>} */
    this.adminIds = new Set([mainSessionId]);
    
    /** @type {Object|null} */
    this.configCache = null;
  }

  /**
   * Check if an ID is admin
   * @param {string} id - User/build ID
   * @returns {boolean}
   */
  isAdmin(id) {
    return this.adminIds.has(id);
  }

  /**
   * Get instance configuration
   * @returns {Object}
   */
  getConfig() {
    this.configCache = {
      mainFuncName: this.syapp.MainFunc.Name,
      mainFuncOriginalName: this.syapp.MainFunc.OriginalName,
      functionsCount: this.syapp.Funcs.size,
      sessionsCount: this.syapp.Sessions.size,
      adminCount: this.adminIds.size,
      httpEnabled: this.syapp.serverConfig.enableHTTP,
      httpPort: this.syapp.serverConfig.port,
      httpHost: this.syapp.serverConfig.host,
      baseRoute: this.syapp.serverConfig.baseRoute,
      includeFuncName: this.syapp.serverConfig.includeFuncName,
      hasRefresher: !!this.syapp.Refresher,
      globalRefreshMode: this.syapp.GlobalRefreshMode,
      refreshInterval: this.syapp._refreshInterval || 500,
      // NEW: Include function history config
      maxFuncHistorySize: this.syapp.maxFuncHistorySize || 20,
      timestamp: new Date().toISOString()
    };
    return { ...this.configCache };
  }

  /**
   * Get server statistics
   * @returns {Object}
   */
  getStats() {
    const stats = {
      sessions: {
        total: this.syapp.Sessions.size,
        active: 0,
        details: []
      },
      functions: {
        total: this.syapp.Funcs.size,
        list: Array.from(this.syapp.Funcs.keys())
      },
      http: null,
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024 * 100) / 100,
        external: Math.round(process.memoryUsage().external / 1024 / 1024 * 100) / 100
      },
      uptime: process.uptime()
    };

    // Session details
    for (const [sessionId, session] of this.syapp.Sessions) {
      const sessionInfo = {
        id: sessionId,
        isAdmin: this.adminIds.has(sessionId),
        currentPath: session.ActualPath,
        hasPage: !!session.ActualProps?.page,
        currentPage: session.ActualProps?.page || null,
        inAction: session.InAction || false,
        // NEW: Include function history in stats
        previousFuncPath: session.PreviousFuncPath || null,
        funcHistory: session.FuncHistory || [],
        funcHistorySize: (session.FuncHistory || []).length
      };
      stats.sessions.details.push(sessionInfo);
      if (!session.InAction) stats.sessions.active++;
    }

    // HTTP stats if enabled
    if (this.syapp.serverConfig.enableHTTP && this.syapp.routeStorage) {
      stats.http = this.syapp.routeStorage.getStats();
    }

    return stats;
  }

  /**
   * Get active sessions
   * @returns {Array}
   */
  getSessions() {
    const sessions = [];
    for (const [sessionId, session] of this.syapp.Sessions) {
      sessions.push({
        id: sessionId,
        isAdmin: this.adminIds.has(sessionId),
        currentPath: session.ActualPath,
        previousPath: session.PreviousPath,
        // NEW: Include function tracking
        previousFuncPath: session.PreviousFuncPath || null,
        funcHistory: session.FuncHistory || [],
        hasPage: !!session.ActualProps?.page,
        currentPage: session.ActualProps?.page || null,
        inAction: session.InAction || false,
        uniqueId: session.UniqueID
      });
    }
    return sessions;
  }

  /**
   * Get HTTP configuration
   * @returns {Object}
   */
  getHTTPConfig() {
    return {
      enabled: this.syapp.serverConfig.enableHTTP,
      port: this.syapp.serverConfig.port,
      host: this.syapp.serverConfig.host,
      baseRoute: this.syapp.serverConfig.baseRoute,
      includeFuncName: this.syapp.serverConfig.includeFuncName,
      httpConfig: this.syapp.serverConfig.httpConfig,
      routesCount: this.syapp.routeStorage ? this.syapp.routeStorage.getStats().total : 0
    };
  }

  /**
   * Get function information
   * @param {string} funcName - Function name
   * @returns {Object|null}
   */
  getFunctionInfo(funcName) {
    if (!this.syapp.Funcs.has(funcName)) {
      return null;
    }
    
    const func = this.syapp.Funcs.get(funcName);
    return {
      name: func.Name,
      originalName: func.OriginalName,
      isMainFunc: func.IsMainFunc || false,
      hasCustomName: !!func.CustomName,
      customName: func.CustomName || null,
      linkedCount: func.Linked ? func.Linked.length : 0,
      routesCount: func.Routes ? func.Routes.length : 0,
      group: func.Group || '',
      useridOnly: func.UserID_Only || false,
      hasLogging: func.Log || false,
      hasAlertConfig: !!func.AlertConfig,
      refreshMode: func.RefreshMode,
      refreshStatus: func.RefreshMode === null ? 'using global' : 
                     func.RefreshMode === true ? 'always on' : 'always off',
      hasOnEnter: !!func.OnEnter,
      onEnterOnce: func.OnEnterOnce || false,
      lifecycleHooks: {
        functionEnter: func._lifecycleHooks?.function?.enter?.length || 0,
        functionLeave: func._lifecycleHooks?.function?.leave?.length || 0,
        sessionEnter: func._lifecycleHooks?.session?.enter?.length || 0,
        sessionLeave: func._lifecycleHooks?.session?.leave?.length || 0,
        pageEnter: Array.from(func._lifecycleHooks?.page?.enter?.keys() || []).length,
        pageLeave: Array.from(func._lifecycleHooks?.page?.leave?.keys() || []).length
      },
      storageStats: {
        userStorage: func.UserStorage ? func.UserStorage.size : 0,
        alertStorage: func.AlertStorage ? func.AlertStorage.size : 0,
        buildsCount: func.Builds ? func.Builds.size : 0
      }
    };
  }

  /**
   * Add admin user
   * @param {string} adminId - ID to add
   * @returns {Object}
   */
  addAdmin(adminId) {
    if (!adminId) {
      return { success: false, error: 'Invalid admin ID' };
    }
    
    if (this.adminIds.has(adminId)) {
      return { success: false, error: 'Already an admin' };
    }
    
    this.adminIds.add(adminId);
    this.configCache = null;
    
    return { 
      success: true, 
      message: `Added ${adminId} as admin`,
      adminCount: this.adminIds.size
    };
  }

  /**
   * Remove admin user
   * @param {string} adminId - ID to remove
   * @returns {Object}
   */
  removeAdmin(adminId) {
    if (adminId === this.syapp.MainSessionID) {
      return { success: false, error: 'Cannot remove main session admin' };
    }
    
    if (!this.adminIds.has(adminId)) {
      return { success: false, error: 'Not an admin' };
    }
    
    this.adminIds.delete(adminId);
    this.configCache = null;
    
    return { 
      success: true, 
      message: `Removed ${adminId} from admins`,
      adminCount: this.adminIds.size
    };
  }

  /**
   * Update instance configuration
   * @param {Object} updates - Configuration updates
   * @returns {Object}
   */
  updateConfig(updates) {
    const allowedUpdates = ['httpConfig', 'baseRoute', 'includeFuncName'];
    const applied = [];
    const rejected = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedUpdates.includes(key)) {
        if (key === 'httpConfig' && this.syapp.serverConfig.enableHTTP) {
          this.syapp.serverConfig.httpConfig = { ...this.syapp.serverConfig.httpConfig, ...value };
          applied.push(key);
        } else if (key === 'baseRoute') {
          this.syapp.serverConfig.baseRoute = !!value;
          applied.push(key);
        } else if (key === 'includeFuncName') {
          this.syapp.serverConfig.includeFuncName = !!value;
          applied.push(key);
        }
      } else {
        rejected.push(key);
      }
    }

    this.configCache = null;
    
    return {
      success: applied.length > 0,
      applied,
      rejected,
      message: applied.length > 0 ? 'Configuration updated' : 'No valid updates applied'
    };
  }

  /**
   * Update HTTP configuration
   * @param {Object} updates - HTTP config updates
   * @returns {Object}
   */
  updateHTTPConfig(updates) {
    if (!this.syapp.serverConfig.enableHTTP) {
      return { success: false, error: 'HTTP server not enabled' };
    }

    const allowedUpdates = ['port', 'host', 'httpConfig'];
    const applied = [];
    const rejected = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedUpdates.includes(key)) {
        if (key === 'port' && Number.isInteger(value) && value > 0 && value < 65536) {
          this.syapp.serverConfig.port = value;
          applied.push(key);
        } else if (key === 'host' && typeof value === 'string') {
          this.syapp.serverConfig.host = value;
          applied.push(key);
        } else if (key === 'httpConfig' && typeof value === 'object') {
          this.syapp.serverConfig.httpConfig = { ...this.syapp.serverConfig.httpConfig, ...value };
          applied.push(key);
        } else {
          rejected.push(`${key} (invalid value)`);
        }
      } else {
        rejected.push(key);
      }
    }

    this.configCache = null;

    return {
      success: applied.length > 0,
      applied,
      rejected,
      message: applied.length > 0 ? 'HTTP configuration updated (requires server restart for port/host changes)' : 'No valid updates applied'
    };
  }

  /**
   * Execute an admin operation
   * @param {string} id - Requesting user ID
   * @param {string} operation - Operation name
   * @param {*} data - Operation data
   * @returns {Object}
   */
  executeOperation(id, operation, data) {
    if (!this.isAdmin(id)) {
      return { success: false, error: 'Not authorized' };
    }

    switch (operation) {
      case 'updateConfig':
        return this.updateConfig(data);
      
      case 'updateHTTPConfig':
        return this.updateHTTPConfig(data);
      
      case 'addAdmin':
        return this.addAdmin(data.adminId);
      
      case 'removeAdmin':
        return this.removeAdmin(data.adminId);
      
      default:
        return { success: false, error: `Unknown operation: ${operation}` };
    }
  }
}

// --------------------------- SyAPP Class ---------------------------

/**
 * Main SyAPP application class
 * @class
 */
class SyAPP {
  /**
   * @param {Function|Object} mainFuncOrConfig - Main function or configuration
   * @param {Object} [config] - Configuration (when first param is function)
   * @param {Function} [config.mainfunc] - Main function (when first param is config)
   * @param {number} [config.port=3000] - HTTP server port
   * @param {string} [config.host='localhost'] - HTTP server host
   * @param {boolean} [config.enableHTTP=false] - Enable HTTP server
   * @param {Object} [config.httpConfig={}] - HTTP configuration object passed to build functions
   * @param {string} [config.mainFuncName] - Custom name for the main function
   * @param {boolean} [config.baseRoute=false] - Use base routes (no function name prefix)
   * @param {boolean} [config.includeFuncName=true] - Include function name in routes
   * @param {boolean} [config.RefreshMode=true] - Start with Refresh Screen mode
   * @param {number} [config.RefreshInterval=400] - Set the Refresh Screen mode interval in ms
   * @param {number} [config.maxFuncHistorySize=20] - Maximum size of function history array per session
   */
  constructor(mainFuncOrConfig, config = {}) {
    
    /** @type {http.Server|null} */
    this.httpServer = null;
    /** @type {HTTPRoutesStorage} */
    this.routeStorage = new HTTPRoutesStorage();

    // Handle the new dual-parameter signature
    let mainFunc;
    let userConfig;

    if (typeof mainFuncOrConfig === 'function' || (mainFuncOrConfig && mainFuncOrConfig.prototype instanceof SyAPP_Func)) {
      mainFunc = mainFuncOrConfig;
      userConfig = config;
    } else {
      mainFunc = mainFuncOrConfig?.mainfunc || TemplateFunc;
      userConfig = mainFuncOrConfig || {};
    }

    /**
     * Raw config object passed to `new SyAPP(...)`. Preserved so the
     * SyAPP init process can expose it to user-provided init handlers.
     * @type {Object}
     */
    this._userConfig = userConfig;

    /**
     * Resolves once the SyAPP init process (if any) has fully finished.
     * Everything that must wait for init — the first LoadScreen, the
     * refresh loop, HTTP request handling — awaits this promise.
     * @type {Promise<void>}
     */
    this._syappInitReady = Promise.resolve();

/** @type {TerminalHUD} */
this.HUD = new TerminalHUD({
  clickMode: userConfig.mouseClickMode || 'single'   // default to single click
});

    /** @type {{Func: Function, Name: string, OriginalName: string}} */
    this.MainFunc = { Func: mainFunc, Name: undefined, OriginalName: undefined };
    
    // Store original name
    const tempInstance = new this.MainFunc.Func();
    this.MainFunc.OriginalName = tempInstance.Name;
    
    // Set custom name if provided, otherwise use original
    this.MainFunc.Name = userConfig.mainFuncName || this.MainFunc.OriginalName;

    /** @type {Map<string, SyAPP_Func>} */
    this.Funcs = new Map();

    /** @type {string} */
    this.MainSessionID = `${getMachineID()}-P${process.pid}`;

    /** @type {Map<string, Session>} */
    this.Sessions = new Map([[this.MainSessionID, new Session({
      machine_id: getMachineID(),
      process_id: process.pid
    })]]);

    /**
     * Wait and log message
     * @param {string} message - Message to log
     * @param {number} ms - Milliseconds to wait
     * @returns {Promise<void>}
     */
    this.WaitLog = async (message, ms = 5000) => {
      console.log(message);
      await new Promise(resolve => setTimeout(resolve, ms));
    };

    // Server configuration with new options
    /** @type {Object} */
    this.serverConfig = {
      port: userConfig.port || 3000,
      host: userConfig.host || '0.0.0.0',
      enableHTTP: userConfig.enableHTTP || false,
      httpConfig: userConfig.httpConfig || {},
      mainFuncName: userConfig.mainFuncName,
      baseRoute: userConfig.baseRoute || false,
      includeFuncName: userConfig.includeFuncName !== false
    };

    /** 
     * Maximum number of function paths to keep in history per session
     * @type {number}
     */
    this.maxFuncHistorySize = userConfig.maxFuncHistorySize || 20;

    /**
     * When true, every this.Page() call automatically adds a navigation
     * button (pinned at the bottom by default) unless the page opts out
     * via `config.pinButton: false`.
     *
     * Individual pages can still override this per-call by passing
     * `pinButton: false` (to opt out) or `pinButton: true` (to opt in
     * even when the global default is off), and can choose where the
     * button is pinned with `pinPosition: 'top' | 'bottom'`.
     *
     * All registered page nav buttons are collected and rendered as ONE
     * `this.Buttons([...])` row per Build pass, with the currently
     * selected page visually marked (● selected / ○ unselected).
     *
     * @type {boolean}
     */
    this.autoPinPages = userConfig.autoPinPages || false;

    // Initialize admin manager with main session as admin
    /** @type {AdminManager} */
    this._adminManager = new AdminManager(this, this.MainSessionID);

    // Store refresh interval for admin stats
    this._refreshInterval = userConfig.RefreshInterval || 500;

    // Store global refresh mode setting
    this.GlobalRefreshMode = userConfig.RefreshMode !== false; // true by default if not set to false

    /**
     * Command-line arguments passed after the target file.
     *
     * Example: `node SyAPP.js MyFunc.js arg1 arg2`
     *   → process.argv = ['node', 'SyAPP.js', 'MyFunc.js', 'arg1', 'arg2']
     *   → this._processArgs = ['arg1', 'arg2']
     *
     * Can be overridden by passing `processArgs: [...]` in the SyAPP config,
     * which is useful when the app is launched programmatically.
     *
     * These arguments are consumed by `this.Args()` inside any SyAPP_Func.
     *
     * @type {Array<string>}
     */
    this._processArgs = Array.isArray(userConfig.processArgs)
      ? userConfig.processArgs.slice()
      : process.argv.slice(3);

    // Per-function refreshers storage
    this._perFunctionRefreshers = new Map();

    /**
     * Start a per-function refresher for functions with RefreshMode = true
     * @param {string} funcName - Function name
     * @param {SyAPP_Func} funcInstance - Function instance
     * @private
     */
    this._startPerFunctionRefresher = (funcName, funcInstance) => {
      if (this._perFunctionRefreshers.has(funcName)) {
        return; // Already running
      }
      
      const intervalId = setInterval(async () => {
        // Hard gate: never refresh before the SyAPP init has finished.
        await this._syappInitReady;

        // Find all sessions currently on this function
        for (const [sessionId, session] of this.Sessions) {
          if (session.ActualPath === funcName) {
            if (session.ActualProps?.page) {
              this.LoadScreen(funcName, {
                props: {
                  page: session.ActualProps.page,
                  _isRefresh: true
                }
              });
            } else {
              this.LoadScreen(funcName, {
                props: {
                  _isRefresh: true
                }
              });
            }
          }
        }
      }, this._refreshInterval);
      
      this._perFunctionRefreshers.set(funcName, intervalId);
    };

    /**
     * Stop a per-function refresher
     * @param {string} funcName - Function name
     * @private
     */
    this._stopPerFunctionRefresher = (funcName) => {
      const intervalId = this._perFunctionRefreshers.get(funcName);
      if (intervalId) {
        clearInterval(intervalId);
        this._perFunctionRefreshers.delete(funcName);
      }
    };

    /**
     * Check if a function should be refreshed
     * @param {string} funcName - Function name
     * @returns {boolean} Whether the function should refresh
     * @private
     */
    this._shouldRefreshFunction = (funcName) => {
      const func = this.Funcs.get(funcName);
      if (!func) return this.GlobalRefreshMode; // Use global if function not found
      
      if (func.RefreshMode !== null) {
        return func.RefreshMode; // Function has explicit setting
      }
      
      return this.GlobalRefreshMode; // Use global setting
    };

    // Refresh mode
    //
    // NOTE: the refresh tick callback awaits `this._syappInitReady`
    // before touching any session, so the first refresh cannot fire
    // while the SyAPP init process is still running.
    if (this.GlobalRefreshMode) {
      this.Refresher = setInterval(async () => {
        // Hard gate: never refresh before the SyAPP init has finished.
        await this._syappInitReady;

        let sessions = [...this.Sessions.keys()]

        sessions.forEach(k => {
          const session = this.Sessions.get(k);
          const currentFuncName = session.ActualPath;

          // Skip sessions that have not been loaded yet (init still
          // gating the very first screen).
          if (!currentFuncName) return;

          // Check if the current function allows refresh
          if (this._shouldRefreshFunction(currentFuncName)) {
            if (session.ActualProps?.page) {
              this.LoadScreen(currentFuncName, {
                props: {
                  page: session.ActualProps.page,
                  _isRefresh: true
                }
              })
            } else {
              this.LoadScreen(currentFuncName, {
                props: {
                  _isRefresh: true
                }
              })
            }
          }
        })
      }, this._refreshInterval);
    } else {
      // Global refresh is disabled, but we'll start per-function refreshers
      // for functions that explicitly enable it (handled in ProcessFuncs)
    }

    // ------------------------------------------------------------------
    // Terminal-resize handling.
    //
    // When the terminal shrinks, previously-rendered content sized to the
    // OLD column count (full-width separators produced by `_hr()`, long
    // text lines, etc.) becomes wider than the terminal and gets wrapped
    // onto a second visual line.
    //
    // We solve this by re-running the current screen with a lightweight
    // `_isRefresh` rebuild, so every responsive element is recomputed
    // using the new column count. The rebuild is:
    //   • debounced, to avoid thrashing on rapid resize events;
    //   • skipped while a screen is already loading (InAction lock);
    //   • skipped while the user is actively editing a field.
    //
    // A dedicated `_resizeRedraw` flag tells LoadScreen to bypass the
    // per-function RefreshMode check, so the layout adapts even when
    // auto-refresh is disabled.
    // ------------------------------------------------------------------
    let __resizeDebounce = null;
    stdout.on('resize', () => {
      if (__resizeDebounce) clearTimeout(__resizeDebounce);
      __resizeDebounce = setTimeout(() => {
        __resizeDebounce = null;
        try {
          const session = this.Sessions.get(this.MainSessionID);
          if (!session || session.InAction) return;
          const funcName = session.ActualPath;
          if (!funcName) return;
          if (this.HUD && this.HUD.isEditing) return;
          const page = session.ActualProps && session.ActualProps.page;
          const props = page
            ? { page, _isRefresh: true, _resizeRedraw: true }
            : { _isRefresh: true, _resizeRedraw: true };
          this.LoadScreen(funcName, { props, resetSelection: false }).catch(() => {});
        } catch (_) { /* ignore resize-handling errors */ }
      }, 100);
    });

    /**
     * Process and register a function class
     * @param {Function} FuncClass - Function class to process
     * @private
     */
    this.ProcessFuncs = (FuncClass) => {
      const tempInstance = new FuncClass();
      let funcName = tempInstance.Name;

      // If this is the main function and has a custom name, register with both names
      if (FuncClass === this.MainFunc.Func && this.serverConfig.mainFuncName) {
        // Register with original name for backward compatibility
        if (!this.Funcs.has(funcName)) {
          const originalInstance = new FuncClass();
          originalInstance.IsMainFunc = true;
          originalInstance.CustomName = this.serverConfig.mainFuncName;
          originalInstance._syappInstance = this;
          this.Funcs.set(funcName, originalInstance);
          
          // Start per-function refresher if needed
          if (!this.GlobalRefreshMode && originalInstance.RefreshMode === true) {
            this._startPerFunctionRefresher(funcName, originalInstance);
          }
        }
        
        // Register with custom name
        if (!this.Funcs.has(this.serverConfig.mainFuncName)) {
          const customInstance = new FuncClass();
          customInstance.IsMainFunc = true;
          customInstance.OriginalName = funcName;
          customInstance._syappInstance = this;
          Object.defineProperty(customInstance, 'Name', {
            value: this.serverConfig.mainFuncName,
            writable: false,
            configurable: true
          });
          this.Funcs.set(this.serverConfig.mainFuncName, customInstance);
          
          // Start per-function refresher if needed
          if (!this.GlobalRefreshMode && customInstance.RefreshMode === true) {
            this._startPerFunctionRefresher(this.serverConfig.mainFuncName, customInstance);
          }
        }
        
        // Process linked functions
        tempInstance.Linked.forEach(linkedFunc => {
          const linkedTemp = new linkedFunc();
          if (!this.Funcs.has(linkedTemp.Name)) {
            this.ProcessFuncs(linkedFunc);
          }
        });
        
        return;
      }

      // Normal processing for non-main functions
      if (this.Funcs.has(funcName)) {
        return;
      }

      const instance = new FuncClass();
      instance._syappInstance = this;
      this.Funcs.set(funcName, instance);
      
      // Start per-function refresher if needed
      if (!this.GlobalRefreshMode && instance.RefreshMode === true) {
        this._startPerFunctionRefresher(funcName, instance);
      }

      instance.Linked.forEach(linkedFunc => {
        const linkedTemp = new linkedFunc();
        if (!this.Funcs.has(linkedTemp.Name)) {
          this.ProcessFuncs(linkedFunc);
        }
      });
    };

    this.ProcessFuncs(this.MainFunc.Func);
    this.ProcessFuncs(NotFounded);
    this.ProcessFuncs(Error);
    // Pre-load the SelfBuilder as a built-in func, exactly like NotFounded
    // and Error above. This guarantees `__selfbuilder__` is ALWAYS reachable
    // via this.Emb() / GotoNow / any user code, regardless of which func
    // is the main func for this SyAPP instance.
    this.ProcessFuncs(SelfBuilder);

    // ============================================================
    // EMB RETURN TARGETS
    // ============================================================
    // Per-session map of { <embeddedFuncName>: { func, props } }.
    //
    // Every time an Emb instance navigates INTO an embedded func via
    // ▶ Enter Func (or runs it inline), it records the parent func here.
    // The loader then uses this map to inject a default "← Return"
    // button into the embedded func's rendered output, so the user can
    // always get back to the func that owns the this.Emb() widget —
    // without the embedded func's author having to do anything.
    //
    // Keyed by session id first (different sessions can be embedded
    // from different parents), then by embedded func name.
    // ============================================================
    /** @type {Map<string, Object<string, {func: string, props: Object}>>} */
    this._embReturnTargets = new Map();

    // Discover routes from all functions (only if HTTP is enabled)
    if (this.serverConfig.enableHTTP) {
      this.discoverAllRoutes();
      this.startHTTPServer();
    }

    // --------------------------- LoadScreen Method ---------------------------

    /**
     * Load a screen/function
     * @param {string} [funcname] - Function name to load
     * @param {Object} [config] - Load configuration
     * @param {boolean|number} [config.jumpTo=false] - Jump to index
     * @param {boolean} [config.resetSelection=false] - Reset selection
     * @param {Object} [config.props={}] - Props to pass
     * @returns {Promise<void>}
     */
    this.LoadScreen = async (funcname = this.MainFunc.Name, config = { jumpTo: false, resetSelection: false, props: {} }) => {
      const session = this.Sessions.get(this.MainSessionID);
      
      // Lock check - if session is already in action, silently return
      if (session.InAction) {
        return;
      }
      
      // Acquire lock
      session.InAction = true;
      
      try {
        if (!config.props) { config.props = {}; }

        // Handle main function name aliasing
        let targetFuncName = funcname;
        
        // If trying to access main function by original name but we have a custom name
        if (this.serverConfig.mainFuncName && 
            funcname === this.MainFunc.OriginalName && 
            this.Funcs.has(this.serverConfig.mainFuncName)) {
          targetFuncName = this.serverConfig.mainFuncName;
        }

        if (!this.Funcs.has(targetFuncName)) {
          config.props.notfounded_func = funcname;
          targetFuncName = 'notfounded';
        }

        // ------------------------------------------------------------------
        // SYNTHETIC "Enter Func" resolution.
        //
        // this.Emb()'s ▶ Enter Func button navigates to a name of the
        // form `__emb_func__:<name>`. That name is not a real registered
        // func — instead, an Emb instance that has already resolved its
        // embedded class has registered it in `_embFuncRegistry`. We
        // synthesize a short-lived Func entry for it so the rest of the
        // loader treats it like any ordinary screen.
        // ------------------------------------------------------------------
        if (typeof targetFuncName === 'string' && targetFuncName.startsWith('__emb_func__:')) {
          const embName = targetFuncName.slice('__emb_func__:'.length);
          const registry = this._embFuncRegistry;
          const EmbClass = registry && registry.get(embName);
          if (EmbClass) {
            // Register a synthetic func instance under the magic name
            // so it is reachable via the standard Funcs map.
            if (!this.Funcs.has(targetFuncName)) {
              const inst = new EmbClass();
              inst._syappInstance = this;
              this.Funcs.set(targetFuncName, inst);
            }
          } else {
            // Registry miss — show the notfounded screen with a
            // helpful label so the user knows what happened.
            config.props.notfounded_func = `embedded func "${embName}"`;
            targetFuncName = 'notfounded';
          }
        }
        
        // Check if this is a refresh request and if the function allows it.
        //
        // A resize-driven redraw (config.props._resizeRedraw === true) is
        // exempt from the RefreshMode gate: it is not a real refresh, it
        // is just a re-render needed to adapt to new terminal
        // dimensions, and it must always run so responsive layouts can
        // recompute themselves even when auto-refresh is off.
        const isRefreshRequest = config.props._isRefresh === true;
        const isResizeRedraw = config.props._resizeRedraw === true;
        if (isRefreshRequest && !isResizeRedraw) {
          const targetFunc = this.Funcs.get(targetFuncName);
          if (targetFunc && !this._shouldRefreshFunction(targetFuncName)) {
            session.InAction = false;
            return;
          }
        }
        
        config.props.mainfunc = this.MainFunc.Name;

        // Pass HTTP config to the build function if available
        if (this.serverConfig.enableHTTP && this.serverConfig.httpConfig) {
          config.props._httpConfig = this.serverConfig.httpConfig;
        }

        // Track previous path and page for lifecycle hooks
        const previousPath = session.ActualPath;
        const previousPage = session.ActualProps?.page || '';
        
        // ============================================================
        // REAL FUNCTION TRACKING (not affected by refreshes)
        // ============================================================
        
        // Only update PreviousFuncPath when navigating to a DIFFERENT function
        // (not when refreshing the same function)
        if (!isRefreshRequest && session.ActualPath && session.ActualPath !== targetFuncName) {
          // Store the current function as the "real" previous function
          session.PreviousFuncPath = session.ActualPath;
          
          // Add to function history (most recent first)
          if (session.ActualPath) {
            session.FuncHistory.unshift(session.ActualPath);
            
            // Trim history to max size
            if (session.FuncHistory.length > this.maxFuncHistorySize) {
              session.FuncHistory = session.FuncHistory.slice(0, this.maxFuncHistorySize);
            }
          }
        }
        // If it's a refresh, keep PreviousFuncPath and FuncHistory unchanged
        
        // Pass real function tracking to props
        config.props._previousFuncPath = session.PreviousFuncPath;
        config.props._funcHistory = [...session.FuncHistory]; // Pass a copy
        
        session.PreviousPath = session.ActualPath;
        session.ActualPath = targetFuncName;
        session.PreviousProps = session.ActualProps;
        config.props.session = session;
        session.ActualProps = config.props;

        try {
          const return_obj = await this.Funcs.get(targetFuncName).Build(config.props);

          // ============================================================
          // DEFAULT "← Return" BUTTON INJECTION
          // ============================================================
          // If the func we just built was entered via an Emb widget's
          // ▶ Enter Func button, it has an entry in _embReturnTargets
          // for this session. In that case, append a default ← Return
          // button to the rendered HUD options, pointing back at the
          // parent func that owns the Emb.
          //
          // This is a per-session, per-embedded-func lookup, so nested
          // Emb-in-Func-in-Emb flows each get their own Return button
          // that goes back exactly one layer.
          // ============================================================
          if (return_obj && return_obj.hud_obj) {
            try {
              const session = config.props && config.props.session;
              const sessionId = session && session.UniqueID;
              if (sessionId && this._embReturnTargets.has(sessionId)) {
                const perSession = this._embReturnTargets.get(sessionId);
                const target = perSession && perSession[targetFuncName];
                if (target && target.func && target.func !== targetFuncName) {
                  if (!Array.isArray(return_obj.hud_obj.options)) {
                    return_obj.hud_obj.options = [];
                  }
                  return_obj.hud_obj.options.push({
                    name: ColorText.brightYellow('← Return to ' + target.func),
                    metadata: {
                      props: { ...(target.props || {}) },
                      path: target.func,
                      resetSelection: true,
                      jumpTo: false,
                      pinned: false,
                      pinnedTop: false
                    },
                    action: () => {}
                  });
                }
              }
            } catch (_) {
              // Injection is a convenience layer — never let it break
              // the actual screen render.
            }
          }

          if (config.props) {
            if (config.props.session) {
              if (config.props.session.ActualPath && config.props.session.PreviousPath) {
                if (config.props.session.ActualPath != config.props.session.PreviousPath) {
                  this.HUD.lastFocusedIndex = 0
                  config.resetSelection = true;
                }
              }
            }
          }

          if (return_obj && return_obj.goto_now) {
            // Release lock before recursive call
            session.InAction = false;
            
            this.LoadScreen(return_obj.goto_now.path, {
              props: return_obj.goto_now.props || {},
              jumpTo: false,
              resetSelection: true
            }).catch(er => {
              this.LoadScreen('error', {
                props: {
                  error_message: er,
                  error_func: return_obj.goto_now.path,
                  mainfunc: this.MainFunc.Name
                }
              });
            });
            return;
          }

          this.HUD.displayMenu(return_obj.hud_obj, {
            remember: (!config.resetSelection) ? true : false,
            jumpToIndex: (!config.jumpTo) ? undefined : config.jumpTo
          })
            .catch(e => {
              this.LoadScreen('error', {
                props: {
                  error_message: e,
                  error_func: targetFuncName,
                  mainfunc: this.MainFunc.Name
                }
              });
            });

          if (return_obj.wait_input) {
            let response;

            try {
              if (return_obj.input_obj.password) {
                response = await this.HUD.ask(return_obj.input_obj.question || 'Password: ', {
                  password: true,
                  mask: return_obj.input_obj.mask || '*'
                });
              } else {
                response = await this.HUD.ask(return_obj.input_obj.question || 'Type: ');
              }

              // Release lock before recursive call
              session.InAction = false;
              
              this.LoadScreen(return_obj.input_obj.path, {
                props: {
                  inputValue: response,
                  ...return_obj.input_obj.props
                }
              });

            } catch (e) {
              // Release lock before recursive error call
              session.InAction = false;
              
              this.LoadScreen('error', {
                props: {
                  error_message: e,
                  error_func: targetFuncName,
                  mainfunc: this.MainFunc.Name
                }
              });
            }
            return;
          }

          // Release lock on successful completion
          session.InAction = false;

        } catch (buildError) {
          // Release lock before recursive error call
          session.InAction = false;
          
          this.LoadScreen('error', {
            props: {
              error_message: buildError,
              error_func: targetFuncName,
              mainfunc: this.MainFunc.Name
            }
          });
        }
      } catch (error) {
        // Ensure lock is released even if an unexpected error occurs
        session.InAction = false;
        throw error;
      }
    };

    this.HUD.on(this.HUD.eventTypes.MENU_SELECTION, (e) => {
      const currentSession = this.Sessions.get(this.MainSessionID);
      const currentProps = currentSession.ActualProps || {};
      const currentPage = currentProps.page || '';

      const newProps = e.metadata.props || {};

      if (!('page' in newProps) && currentPage) {
        newProps.page = currentPage;
      }

      this.LoadScreen(e.metadata.path, {
        jumpTo: e.metadata.jumpTo || false,
        resetSelection: e.metadata.resetSelection || false,
        props: newProps
      }).catch(er => {
        this.LoadScreen('error', {
          props: {
            error_message: er,
            error_func: e.metadata.path,
            mainfunc: this.MainFunc.Name
          }
        });
      });
    });

    this.HUD.on('mouse:rightclick', () => {
      const currentSession = this.Sessions.get(this.MainSessionID);
      // Navigate back to the previous function (and its props)
      if (currentSession && currentSession.PreviousPath) {
          this.LoadScreen(currentSession.PreviousPath, {
              props: currentSession.PreviousProps || {},
              resetSelection: true
          }).catch(er => {
              this.LoadScreen('error', {
                  props: {
                      error_message: er,
                      error_func: currentSession.PreviousPath,
                      mainfunc: this.MainFunc.Name
                  }
              });
          });
      }
  });

    // ============================================================
    // SyAPP INIT PROCESS — FULLY BLOCKING GATE
    // ============================================================
    // Build the init promise chain. Everything that must wait for
    // init — the first LoadScreen below, the refresh interval
    // (already gated on `this._syappInitReady`), and any per-function
    // refresher scheduled by ProcessFuncs — will resolve this
    // promise and check its state.
    //
    // The handler executes on the MAIN function instance (the one
    // registered under the resolved `this.MainFunc.Name`). It runs
    // once per SyAPP instance when `syappInitOnce` is true (default).
    // ============================================================
    this._syappInitReady = (async () => {
      const mainFunc = this.Funcs.get(this.MainFunc.Name);
      if (!mainFunc) return;
      if (typeof mainFunc.SyAPPInit !== 'function') return;
      if (mainFunc.SyAPPInitOnce && mainFunc._syappInitExecuted) return;

      const initContext = {
        syapp: this,
        mainFuncName: this.MainFunc.Name,
        mainFuncOriginalName: this.MainFunc.OriginalName,
        serverConfig: this.serverConfig,
        config: this.serverConfig,
        userConfig: this._userConfig,
        funcs: this.Funcs,
        sessions: this.Sessions,
        mainSessionId: this.MainSessionID,
        logMaster: LogMaster,
        colorText: ColorText,
        configManager: ConfigManager
      };

      try {
        // Await the FULL completion of the hook. If the user returns
        // a Promise (async function, or a chained .then / new Promise),
        // we wait for it to settle. Errors are logged but do NOT
        // prevent SyAPP from starting.
        const result = mainFunc.SyAPPInit(initContext);
        if (result instanceof Promise) {
          await result;
        }
        if (mainFunc.SyAPPInitOnce) mainFunc._syappInitExecuted = true;
      } catch (err) {
        console.error(`SyAPP init error in ${mainFunc.Name}:`, err);
      }
    })();

    // Gate the first screen on the init process. The `.then` callback
    // runs strictly AFTER the init handler's promise has settled, so
    // the first LoadScreen never races with init work.
    this._syappInitReady
      .then(() => {
        if (!this.serverConfig.enableHTTP) {
          return this.LoadScreen();
        }
      })
      .catch(err => {
        console.error('SyAPP init gate error:', err);
        // Even on init failure we still boot the UI so the app is
        // never left hanging.
        if (!this.serverConfig.enableHTTP) {
          this.LoadScreen();
        }
      });
  }

  // --------------------------- Admin Methods ---------------------------

  /**
   * Register an external ID as admin
   * @param {string} id - ID to register as admin
   * @returns {Object} Result
   */
  registerAdmin(id) {
    if (!id) {
      return { success: false, error: 'Invalid ID' };
    }
    return this._adminManager.addAdmin(id);
  }

  /**
   * Check if an ID is admin
   * @param {string} id - ID to check
   * @returns {boolean}
   */
  isAdmin(id) {
    return this._adminManager.isAdmin(id);
  }

  /**
   * Get admin manager instance
   * @returns {AdminManager}
   */
  getAdminManager() {
    return this._adminManager;
  }

  // --------------------------- Route Discovery ---------------------------

  async discoverAllRoutes() {
    console.log('\n' + ColorText.brightCyan('🔍 Discovering HTTP routes...'));
    
    if (this.serverConfig.enableHTTP) {
      if (this.serverConfig.httpConfig && Object.keys(this.serverConfig.httpConfig).length > 0) {
        console.log(ColorText.yellow('📋 Using HTTP config:'), this.serverConfig.httpConfig);
      }
    }
  
    for (const [funcName, funcInstance] of this.Funcs) {
      // Skip the original name version of main function if we have a custom name
      if (this.serverConfig.mainFuncName && 
          funcName === this.MainFunc.OriginalName && 
          this.Funcs.has(this.serverConfig.mainFuncName)) {
        continue;
      }
  
      // Create discovery props with HTTP config
      const discoveryProps = {
        _routeDiscovery: true,
        _httpConfig: this.serverConfig.httpConfig || {}
      };
  
      const routes = await funcInstance.DiscoverRoutes(discoveryProps);
  
      ['GET', 'POST', 'PUT', 'DELETE'].forEach(method => {
        (routes[method] || []).forEach(route => {
          const basePath = route.path;
          
          // Determine routing behavior for this specific route
          const useBaseRoute = route.baseRoute !== undefined ? route.baseRoute : this.serverConfig.baseRoute;
          const useIncludeFuncName = route.includeFuncName !== undefined ? route.includeFuncName : this.serverConfig.includeFuncName;
          
          const pathVariations = [];
          
          if (useBaseRoute) {
            pathVariations.push(basePath);
          } else {
            if (useIncludeFuncName) {
              if (funcInstance.Group) {
                const groupPath = funcInstance.Group.startsWith('/') ? funcInstance.Group : `/${funcInstance.Group}`;
                if (basePath === '/') {
                  pathVariations.push(`/${funcName}${groupPath}`);
                  pathVariations.push(`/${funcName}${groupPath}/`);
                } else {
                  pathVariations.push(`/${funcName}${groupPath}${basePath}`);
                }
              } else {
                if (basePath === '/') {
                  pathVariations.push(`/${funcName}`);
                  pathVariations.push(`/${funcName}/`);
                } else {
                  pathVariations.push(`/${funcName}${basePath}`);
                }
              }
            } else {
              if (funcInstance.Group) {
                const groupPath = funcInstance.Group.startsWith('/') ? funcInstance.Group : `/${funcInstance.Group}`;
                if (basePath === '/') {
                  pathVariations.push(groupPath);
                  pathVariations.push(`${groupPath}/`);
                } else {
                  pathVariations.push(`${groupPath}${basePath}`);
                }
              } else {
                pathVariations.push(basePath);
              }
            }
          }
  
          const uniquePathVariations = [...new Set(pathVariations)];
  
          const routeInfo = {
            func: funcInstance,
            handler: route.handler,
            method: route.method,
            path: basePath,
            originalPath: route.originalPath,
            fullPath: uniquePathVariations[0],
            allPaths: uniquePathVariations,
            stream: route.stream,
            input_model: route.input_model || {},
            output_model: route.output_model || {},
            input_validate: route.input_validate || null,
            validation_options: route.validation_options || { includeMissingKeys: true },
            funcName: funcName,
            group: funcInstance.Group,
            baseRoute: useBaseRoute,
            includeFuncName: useIncludeFuncName
          };
  
          uniquePathVariations.forEach(variation => {
            const finalPath = variation === '' ? '/' : variation;
            this.routeStorage.addRoute(method, finalPath, routeInfo);
          });
        });
      });
    }
  
    // Log discovered routes with colors
    console.log('\n' + ColorText.brightGreen('✅ Route discovery complete!'));
    console.log(ColorText.brightCyan('📊 Route Statistics:'));
    
    const stats = this.routeStorage.getStats();
    console.log(`   Total Routes: ${ColorText.brightWhite(stats.total)}`);
    console.log(`   By Method: ${ColorText.yellow(`GET: ${stats.byMethod.GET}`)}, ${ColorText.green(`POST: ${stats.byMethod.POST}`)}, ${ColorText.blue(`PUT: ${stats.byMethod.PUT}`)}, ${ColorText.red(`DELETE: ${stats.byMethod.DELETE}`)}`);
    console.log(`   With Models: ${ColorText.magenta(stats.withModels)}`);
    console.log(`   With Validation: ${ColorText.cyan(stats.withValidation)}`);
    
    console.log('\n' + ColorText.brightCyan('📋 Detailed Routes:'));
    
    const routesByFunc = {};
    this.routeStorage.getAllRoutes().forEach(route => {
      if (!routesByFunc[route.func]) {
        routesByFunc[route.func] = [];
      }
      routesByFunc[route.func].push(route);
    });
    
    for (const [funcName, routes] of Object.entries(routesByFunc)) {
      console.log(`\n  ${ColorText.brightYellow(funcName)}:`);
      routes.forEach(route => {
        const methodColor = {
          'GET': ColorText.yellow,
          'POST': ColorText.green,
          'PUT': ColorText.blue,
          'DELETE': ColorText.red
        }[route.method] || ColorText.white;
        
        let modelInfo = '';
        if (Object.keys(route.models.input).length > 0 || Object.keys(route.models.output).length > 0) {
          modelInfo = ColorText.magenta(' 📦');
        }
        
        let validationInfo = '';
        if (route.hasValidation) {
          validationInfo = ColorText.cyan(' 🔒');
          
          if (route.validationOptions && route.validationOptions.includeMissingKeys === false) {
            validationInfo += ColorText.dim(' (no missingKeys)');
          }
        }
        
        console.log(`    ${methodColor(route.method.padEnd(6))} ${route.path}${modelInfo}${validationInfo}`);
        
        if (Object.keys(route.models.input).length > 0) {
          console.log(`      ${ColorText.dim('Input: ' + JSON.stringify(HTTPModelValidator.describe(route.models.input)))}`);
        }
        if (Object.keys(route.models.output).length > 0) {
          console.log(`      ${ColorText.dim('Output: ' + JSON.stringify(HTTPModelValidator.describe(route.models.output)))}`);
        }
      });
    }
    
    console.log('\n' + ColorText.brightGreen('🚀 Server ready to start!') + '\n');
  }

  /**
   * Export route data
   * @returns {Object} Route data
   */
  exportRouteData() {
    return this.routeStorage.exportData();
  }

  /**
   * Get route statistics
   * @returns {Object} Route statistics
   */
  getRouteStats() {
    return this.routeStorage.getStats();
  }

  // --------------------------- HTTP Server Methods ---------------------------

  /**
   * Start the HTTP server
   * @private
   */
  startHTTPServer() {
    this.httpServer = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.httpServer.listen(this.serverConfig.port, this.serverConfig.host, () => {
      console.log('\n' + ColorText.brightGreen('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(ColorText.brightCyan('                              🚀 SyAPP HTTP Server'));
      console.log(ColorText.brightGreen('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━') + '\n');
      
      console.log(`   ${ColorText.brightWhite('URL:')} http://${this.serverConfig.host}:${this.serverConfig.port}/`);
      console.log(`   ${ColorText.brightWhite('Mode:')} ${this.serverConfig.baseRoute ? 'Root level' : 'With function names'}${this.serverConfig.includeFuncName ? '' : ' (no func name)'}`);
      console.log(`   ${ColorText.brightWhite('Routes:')} ${this.routeStorage.getStats().total} total`);
      console.log(`   ${ColorText.brightWhite('Admin:')} ${this._adminManager.adminIds.size} admin(s) registered
`);
      
      console.log(ColorText.brightGreen('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━') + '\n');
    });

    this.httpServer.on('error', (error) => {
      console.error(ColorText.brightRed('❌ HTTP Server error:'), error);
    });
  }
 
  /**
   * Handle incoming HTTP requests with model validation
   * @param {http.IncomingMessage} req - Request object
   * @param {http.ServerResponse} res - Response object
   * @private
   */
  async handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const path = parsedUrl.pathname;
    const method = req.method;

    console.log(`   ${ColorText.brightCyan('➡️')}  ${method} ${path}${ColorText.reset}`);

    const route = this.routeStorage.getRoute(method, path);

    if (!route) {
      console.log(`   ${ColorText.brightRed('❌ Route not found')}${ColorText.reset}`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Route not found',
        requested: `${method} ${path}`,
        appname: this.MainFunc.Name,
        port: this.serverConfig.port,
        available: this.routeStorage.getAllRoutes().map(r => `${r.method} ${r.path}`)
      }));
      return;
    }

    // Add helper methods to response object
    res.json = (data) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    };

    res.status = (code) => {
      res.statusCode = 200;
      return res;
    };

    // Get validation options for this route
    const validationOptions = this.routeStorage.getValidationOptions(method, path);
    
    // Function to send validation error response with missingKeys
    const sendValidationError = (missingKeys = []) => {
      console.log(`   ${ColorText.brightRed('❌ Input validation failed - returning custom response')}${ColorText.reset}`);
      
      if (route.input_validate) {
        if (typeof route.input_validate === 'object' && route.input_validate !== null) {
          const enhancedResponse = { ...route.input_validate };
          
          if (validationOptions.includeMissingKeys && missingKeys.length > 0) {
            enhancedResponse.missingKeys = missingKeys;
          }
          
          res.status(200).json(enhancedResponse);
        } else {
          res.status(200).json(route.input_validate);
        }
      } else {
        const defaultResponse = { 
          error: 'Validation failed',
          message: 'Input validation failed'
        };
        
        if (validationOptions.includeMissingKeys && missingKeys.length > 0) {
          defaultResponse.missingKeys = missingKeys;
        }
        
        res.status(200).json(defaultResponse);
      }
    };

    // Parse body for POST/PUT requests
    if (method === 'POST' || method === 'PUT') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
        if (body.length > 1e6) req.destroy();
      });

      req.on('end', async () => {
        try {
          let parsedBody = {};
          const contentType = req.headers['content-type'];
          
          if (contentType && contentType.includes('application/json') && body) {
            parsedBody = JSON.parse(body);
          } else if (body) {
            parsedBody = querystring.parse(body);
          }

          req.query = parsedUrl.query;
          req.body = parsedBody;
          req.params = parsedUrl.query;

          // Validate input against model FIRST
          if (route.input_model && Object.keys(route.input_model).length > 0) {
            const validation = HTTPModelValidator.validate(
              req.body, 
              route.input_model, 
              { includeMissingKeys: validationOptions.includeMissingKeys }
            );
            
            if (!validation.valid) {
              sendValidationError(validation.missingKeys);
              return;
            }
            
            req.body = validation.sanitized;
            console.log(`   ${ColorText.brightGreen('✅ Input validation passed')}${ColorText.reset}`);
          }

          await route.handler(req, res);

        } catch (error) {
          console.error('Error handling request:', error);
          if (!res.headersSent) {
            if (route.input_validate) {
              if (validationOptions.includeMissingKeys) {
                const errorResponse = typeof route.input_validate === 'object' 
                  ? { ...route.input_validate, missingKeys: [] }
                  : route.input_validate;
                res.status(200).json(errorResponse);
              } else {
                res.status(200).json(route.input_validate);
              }
            } else {
              res.status(200).json({ 
                error: 'Internal server error', 
                details: error.message 
              });
            }
          }
        }
      });

      req.on('error', (error) => {
        console.error('Request error:', error);
        if (!res.headersSent) {
          if (route.input_validate) {
            if (validationOptions.includeMissingKeys) {
              const errorResponse = typeof route.input_validate === 'object'
                ? { ...route.input_validate, missingKeys: [] }
                : route.input_validate;
              res.status(200).json(errorResponse);
            } else {
              res.status(200).json(route.input_validate);
            }
          } else {
            res.status(200).json({ 
              error: 'Request error', 
              details: error.message 
            });
          }
        }
      });
    } else {
      // GET and DELETE requests
      req.query = parsedUrl.query;
      req.params = parsedUrl.query;
      
      if (route.input_model && Object.keys(route.input_model).length > 0) {
        const validation = HTTPModelValidator.validate(
          req.query, 
          route.input_model,
          { includeMissingKeys: validationOptions.includeMissingKeys }
        );
        
        if (!validation.valid) {
          sendValidationError(validation.missingKeys);
          return;
        }
        
        req.query = validation.sanitized;
        console.log(`   ${ColorText.brightGreen('✅ Query validation passed')}${ColorText.reset}`);
      }
      
      try {
        await route.handler(req, res);
      } catch (error) {
        console.error('Handler error:', error);
        if (!res.headersSent) {
          if (route.input_validate) {
            if (validationOptions.includeMissingKeys) {
              const errorResponse = typeof route.input_validate === 'object'
                ? { ...route.input_validate, missingKeys: [] }
                : route.input_validate;
              res.status(200).json(errorResponse);
            } else {
              res.status(200).json(route.input_validate);
            }
          } else {
            res.status(200).json({ 
              error: 'Handler error', 
              details: error.message 
            });
          }
        }
      }
    }
  }

  // --------------------------- Utility Methods ---------------------------

  /**
   * Stop the HTTP server
   */
  stopHTTPServer() {
    if (this.httpServer) {
      this.httpServer.close();
      console.log('HTTP Server stopped');
    }
  }

  /**
   * Stop all per-function refreshers
   */
  stopAllRefreshers() {
    if (this.Refresher) {
      clearInterval(this.Refresher);
      this.Refresher = null;
    }
    
    for (const [funcName, intervalId] of this._perFunctionRefreshers) {
      clearInterval(intervalId);
    }
    this._perFunctionRefreshers.clear();
  }

  /**
   * Get the SyAPP_Func class
   * @returns {typeof SyAPP_Func}
   */
  static Func() { return SyAPP_Func; }
}

// --------------------------- Export ---------------------------

export default SyAPP

// ============================================================
// SELF BUILDER — persistent state + interactive editor
// ============================================================
const SYAPP_HOME = path.join(os.homedir(), '.syapp')
const SYAPP_SAVES_DIR = path.join(SYAPP_HOME, 'saves')

function _ensureSavesDir() {
  if (!fs.existsSync(SYAPP_SAVES_DIR)) fs.mkdirSync(SYAPP_SAVES_DIR, { recursive: true })
}
function _getSaveFile(name) {
  return path.join(SYAPP_SAVES_DIR, `${name}.json`)
}
function _listSaves() {
  _ensureSavesDir()
  return fs.readdirSync(SYAPP_SAVES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .sort()
}
function _loadSaveState(name) {
  const p = _getSaveFile(name)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) { return null }
}
// Deep-clone a value while stripping runtime-only objects that must never
// be persisted (Session instances) and breaking any accidental cycles.
// This guarantees JSON.stringify() cannot throw even if a user object
// picked up a reference to the live Session somewhere.
function _sbSafeState(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value
  if (value.constructor && value.constructor.name === 'Session') return undefined
  if (seen.has(value)) return undefined
  seen.add(value)
  if (Array.isArray(value)) {
    const out = []
    for (const v of value) {
      const sv = _sbSafeState(v, seen)
      out.push(sv === undefined ? null : sv)
    }
    return out
  }
  const out = {}
  for (const k of Object.keys(value)) {
    const sv = _sbSafeState(value[k], seen)
    if (sv !== undefined) out[k] = sv
  }
  return out
}

function _writeSaveState(name, state) {
  _ensureSavesDir()
  const safe = _sbSafeState(state)
  fs.writeFileSync(_getSaveFile(name), JSON.stringify(safe, null, 2))
}

// ============================================================
// EMB DISK PERSISTENCE
// ============================================================
// Emb widget storage is per-session (keyed by session.UniqueID), and
// session ids are rebuilt from machine id + process id — which change
// across process restarts. So the in-memory `emb_<name>` entry does
// NOT survive a Ctrl+C / relaunch, and the widget comes back empty.
//
// To make produced emb funcs recoverable across runs, we mirror the
// widget state to a disk file keyed by a STABLE identifier:
//   (the running outer file's absolute path) + (the widget name)
//
// The outer file path is the natural anchor: an emb widget belongs to
// a specific func file, and that file itself is what `node SyAPP.js
// MyApp.js` reopens. As long as the same file is relaunched, the
// widget's produced path is recoverable.
//
//   ~/.syapp/emb/<hash>.json  → { filePath, code, saveMode, ... }
// ============================================================

function _embDiskKeyFor(outerFilePath, embName) {
  const anchor = String(outerFilePath || '__no_file__');
  return createHash('sha1')
    .update(anchor + '::' + String(embName || 'default'))
    .digest('hex')
    .slice(0, 20);
}

function _embDiskFileFor(outerFilePath, embName) {
  const dir = path.join(SYAPP_HOME, 'emb');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, _embDiskKeyFor(outerFilePath, embName) + '.json');
}

function _embDiskSave(outerFilePath, embName, storageEntry) {
  try {
    const f = _embDiskFileFor(outerFilePath, embName);
    const payload = {
      filePath: storageEntry && storageEntry.filePath ? storageEntry.filePath : null,
      code: storageEntry && storageEntry.code ? storageEntry.code : null,
      source: storageEntry && storageEntry.source ? storageEntry.source : 'none',
      saveMode: storageEntry && storageEntry.saveMode ? storageEntry.saveMode : null,
      updatedAt: Date.now()
    };
    fs.writeFileSync(f, JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) { /* best-effort */ }
}

function _embDiskLoad(outerFilePath, embName) {
  try {
    const f = _embDiskFileFor(outerFilePath, embName);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    // If the recorded file no longer exists, only adopt it when we have
    // inline code to fall back on — otherwise drop the stale entry so
    // the widget shows its setup view cleanly.
    if (j.source === 'file' && j.filePath && !fs.existsSync(j.filePath) && !j.code) {
      return null;
    }
    return j;
  } catch (_) { return null; }
}

/**
 * Scan an already-written outer func file for the `this.Emb(id, { ... })`
 * call that corresponds to a given widget name, and return the filePath
 * and/or inline code it carries.
 *
 * This is the self-heal path: after a Save & Return the outer file
 * itself contains `await this.Emb(id, { name: '<embName>', filePath:
 * '<produced>' })`, so we can recover the widget's produced source
 * WITHOUT depending on any session-keyed storage or auxiliary disk
 * record. It works even on a fresh checkout of the outer file, as long
 * as that file was written by this SelfBuilder.
 *
 * Matching is tolerant:
 *   • whitespace and newlines are ignored,
 *   • both single and double quotes on the string values are accepted,
 *   • the `name:` key may appear in any position inside the object.
 *
 * @param {string} src - Source text of the outer file.
 * @param {string} embName - The widget's name (config.name).
 * @returns {{ filePath: string|null, code: string|null }|null}
 * @private
 */
function _embScanRunningFileForWidget(src, embName) {
  if (typeof src !== 'string' || !src) return null;
  const nameEsc = String(embName || 'default').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Find `this.Emb(` calls and inspect each one's argument object.
  // The regex intentionally stops at the FIRST top-level `}` — object
  // literals passed to this.Emb are flat (name, filePath, code, dropdown),
  // so a shallow match is safe and far more robust than a full parser.
  const callRe = /this\.Emb\s*\([^,]*,\s*\{([\s\S]*?)\}\s*\)/g;
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const body = m[1];

    // Match the widget name: `name: 'x'` or `name: "x"`, with optional
    // whitespace on either side of the colon.
    const nameRe = new RegExp(
      `(?:^|[,{\\s])name\\s*:\\s*(['"])${nameEsc}\\1(?:\\s*,|\\s*$|\\s*[},])`,
      'm'
    );
    if (!nameRe.test(body)) continue;

    // Extract filePath (single or double quoted) if present.
    const fpM = body.match(/(?:^|[,{\s])filePath\s*:\s*(['"])([\s\S]*?)\1/);
    const codeM = body.match(/(?:^|[,{\s])code\s*:\s*(['"])([\s\S]*?)\1/);
    return {
      filePath: fpM ? fpM[2] : null,
      code: codeM ? codeM[2] : null
    };
  }
  return null;
}

// ---------- responsive helpers ----------
function _termCols() { return stdout.columns || 80 }
function _termRows() { return stdout.rows || 24 }
function _hr(char = '─', inset = 0) {
  const w = Math.max(10, _termCols() - inset * 2)
  return ColorText.dim(char.repeat(w))
}
function _fit(str, width) {
  const s = String(str == null ? '' : str)
  if (s.length <= width) return s
  if (width <= 3) return s.slice(0, width)
  return s.slice(0, width - 1) + '…'
}
function _fitCenter(str, width) {
  const s = _fit(str, width)
  const pad = Math.max(0, Math.floor((width - s.length) / 2))
  return ' '.repeat(pad) + s
}

/**
 * Generate a stand-alone .js module from a builder state.
 */
function _genFuncJS(state, syappRelPath) {
  const L = []
  L.push(`import SyAPP from ${JSON.stringify(syappRelPath)}`)
  L.push('')
  const clsName = (state.funcName || 'MyApp').replace(/[^A-Za-z0-9_$]/g, '') || 'MyApp'
  L.push(`export default class ${clsName} extends SyAPP.Func() {`)
  L.push(`  constructor() {`)
  L.push(`    super(${JSON.stringify(state.name || 'myapp')}, async (props) => {`)
  L.push(`      const id = props.session.UniqueID`)

  const emit = (items, indent) => {
    for (const it of items || []) {
      switch (it.type) {
        case 'text':
          L.push(`${indent}this.Text(id, ${JSON.stringify(it.value || '')})`)
          break
        case 'spacer':
          L.push(`${indent}this.Text(id, '')`)
          break
        case 'button': {
          const cfg = { name: it.name || '' }
          if (it.path) cfg.path = it.path
          if (it.props && Object.keys(it.props).length) cfg.props = it.props
          if (it.resetSelection) cfg.resetSelection = true
          if (it.jumpTo) cfg.jumpTo = it.jumpTo
          if (it.pinned) cfg.pinned = true
          if (it.pinnedTop) cfg.pinnedTop = true
          const method = it.sourceMethod === 'SideButton' ? 'SideButton' : 'Button'
          L.push(`${indent}this.${method}(id, ${JSON.stringify(cfg)})`)
          break
        }
        case 'buttonsGroup': {
          const configs = (it.items || [])
            .filter(c => c && c.type === 'button')
            .map(c => {
              const cfg = { name: c.name || '' }
              if (c.path) cfg.path = c.path
              if (c.props && Object.keys(c.props).length) cfg.props = c.props
              if (c.resetSelection) cfg.resetSelection = true
              if (c.jumpTo) cfg.jumpTo = c.jumpTo
              if (c.pinned) cfg.pinned = true
              if (c.pinnedTop) cfg.pinnedTop = true
              return cfg
            })
          if (configs.length > 0) {
            L.push(`${indent}this.Buttons(id, ${JSON.stringify(configs)})`)
          }
          break
        }
        case 'field': {
          const cfg = {}
          if (it.label) cfg.label = it.label
          if (it.initialValue) cfg.initialValue = it.initialValue
          if (it.pinned) cfg.pinned = true
          if (it.pinnedTop) cfg.pinnedTop = true
          L.push(`${indent}this.Field(id, ${JSON.stringify(it.name)}, ${JSON.stringify(cfg)})`)
          break
        }
        case 'texteditor': {
          const cfg = {}
          if (it.label) cfg.label = it.label
          if (it.initialValue) cfg.initialValue = it.initialValue
          if (it.buttonText) cfg.buttonText = it.buttonText
          if (it.pinned) cfg.pinned = true
          if (it.pinnedTop) cfg.pinnedTop = true
          L.push(`${indent}await this.TextEditor(id, ${JSON.stringify(it.name)}, ${JSON.stringify(cfg)})`)
          break
        }
        case 'textbutton': {
          const cfg = {}
          if (it.label) cfg.label = it.label
          if (it.initialValue) cfg.initialValue = it.initialValue
          if (it.lines && it.lines !== 4) cfg.lines = it.lines
          if (it.editable) cfg.editable = true
          if (it.pinned) cfg.pinned = true
          if (it.pinnedTop) cfg.pinnedTop = true
          L.push(`${indent}this.TextButton(id, ${JSON.stringify(it.name)}, ${JSON.stringify(cfg)})`)
          break
        }
        case 'page': {
          const pageCfg = {}
          if (it.pinButton) pageCfg.pinButton = true
          if (it.pinPosition === 'top') pageCfg.pinPosition = 'top'
          const cfgStr = Object.keys(pageCfg).length > 0
            ? `, ${JSON.stringify(pageCfg)}`
            : ''
          L.push(`${indent}await this.Page(id, ${JSON.stringify(it.name)}, async () => {`)
          emit(it.items || [], indent + '  ')
          L.push(`${indent}}${cfgStr})`)
          break
        }
        case 'dropdown': {
          const cfg = {
            up_buttontext: it.up_buttontext || 'Show more',
            down_buttontext: it.down_buttontext || 'Hide'
          }
          L.push(`${indent}await this.DropDown(id, ${JSON.stringify(it.name)}, async () => {`)
          emit(it.items || [], indent + '  ')
          L.push(`${indent}}, ${JSON.stringify(cfg)})`)
          break
        }
        case 'pinnedTop': {
          // Emit the optional separator only when it differs from 'line',
          // so untouched projects export byte-for-byte identical code.
          const sep = (it.separator && it.separator !== 'line') ? it.separator : null
          const cfg = sep ? `, { separator: ${JSON.stringify(sep)} }` : ''
          L.push(`${indent}await this.PinnedTop(id, async () => {`)
          emit(it.items || [], indent + '  ')
          L.push(`${indent}}${cfg})`)
          break
        }
        case 'pinnedBottom': {
          const sep = (it.separator && it.separator !== 'line') ? it.separator : null
          const cfg = sep ? `, { separator: ${JSON.stringify(sep)} }` : ''
          L.push(`${indent}await this.PinnedBottom(id, async () => {`)
          emit(it.items || [], indent + '  ')
          L.push(`${indent}}${cfg})`)
          break
        }
        case 'codeblock': {
          const bt = it.blockType
          const cond = it.condition || ''
          const openBlock = (header) => {
            L.push(`${indent}${header} {`)
            emit(it.items || [], indent + '  ')
            L.push(`${indent}}`)
          }
          if (bt === 'if')            openBlock(`if (${cond || 'true'})`)
          else if (bt === 'elseif')   openBlock(`else if (${cond || 'true'})`)
          else if (bt === 'else')     openBlock(`else`)
          else if (bt === 'for')      openBlock(`for (${cond || 'let i = 0; i < 0; i++'})`)
          else if (bt === 'forof')    openBlock(`for (${cond || 'const x of []'})`)
          else if (bt === 'forawait') openBlock(`for await (${cond || 'const x of []'})`)
          else if (bt === 'while')    openBlock(`while (${cond || 'false'})`)
          else {
            // custom / raw JS block: emit customBefore, nested items,
            // then customAfter, all at the same indentation level.
            if (it.customBefore) L.push(`${indent}${String(it.customBefore).replace(/\n/g, '\n' + indent)}`)
            emit(it.items || [], indent)
            if (it.customAfter) L.push(`${indent}${String(it.customAfter).replace(/\n/g, '\n' + indent)}`)
          }
          break
        }
        case 'waitinput':
          L.push(`${indent}this.WaitInput(id, ${JSON.stringify({
            path: it.path || '',
            props: it.props || {},
            question: it.question || ''
          })})`)
          break
        case 'alert':
          L.push(`${indent}this.Alert(id, ${JSON.stringify(it.text || '')}, { duration: ${Number(it.duration) || 3000} })`)
          break
        case 'gotonow':
          L.push(`${indent}this.GotoNow(id, ${JSON.stringify(it.path || '')}, { props: ${JSON.stringify(it.props || {})} })`)
          break
        case 'setpage':
          L.push(`${indent}this.SetPage(id, ${JSON.stringify(it.page || '')})`)
          break
        case 'file':
          L.push(`${indent}await this.File(id, ${JSON.stringify(it.config || {})})`)
          break
        case 'json':
          L.push(`${indent}await this.JSON(id, ${JSON.stringify(it.config || {})})`)
          break
        case 'cells': {
          const cfg = {}
          if (it.label) cfg.label = it.label
          if (it.rows && it.rows !== 100) cfg.rows = it.rows
          if (it.cols && it.cols !== 26) cfg.cols = it.cols
          if (it.pinned) cfg.pinned = true
          if (it.pinnedTop) cfg.pinnedTop = true
          L.push(`${indent}await this.Cells(id, ${JSON.stringify(it.name)}, ${JSON.stringify(cfg)})`)
          break
        }
        case 'grid': {
          const cells = Array.isArray(it.cells) ? it.cells : []
          const cfgParts = []
          if (it.maxCellRatio && it.maxCellRatio !== 0.2) {
            cfgParts.push(`maxCellRatio: ${it.maxCellRatio}`)
          }
          if (it.gap !== undefined && it.gap !== 2) {
            cfgParts.push(`gap: ${it.gap}`)
          }
          const cfgStr = cfgParts.length > 0 ? `, { ${cfgParts.join(', ')} }` : ''
          L.push(`${indent}await this.Grid(id, ${JSON.stringify(it.name || 'grid')}, [`)
          for (const cell of cells) {
            L.push(`${indent}  async () => {`)
            emit(cell.items || [], indent + '    ')
            L.push(`${indent}  },`)
          }
          L.push(`${indent}]${cfgStr})`)
          break
        }
        case 'args': {
          const cfg = {
            required: it.schema || [],
            everyTime: !!it.everyTime,
            form: it.form !== false,
            key: it.key || it.id
          }
          if (it.description) cfg.description = it.description
          L.push(`${indent}await this.Args(id, async (args) => {`)
          emit(it.items || [], indent + '  ')
          L.push(`${indent}}, ${JSON.stringify(cfg)})`)
          break
        }
        case 'javascript': {
          const cfg = {}
          if (it.config) {
            if (it.config.name) cfg.name = it.config.name
            if (it.config.classOnly) cfg.classOnly = true
            if (it.config.timeout && it.config.timeout !== 30000) cfg.timeout = it.config.timeout
            if (it.config.startPath) cfg.startPath = it.config.startPath
          }
          const cfgArg = Object.keys(cfg).length > 0 ? `, ${JSON.stringify(cfg)}` : ''
          L.push(`${indent}await this.JavaScript(id, ${JSON.stringify(it.codeOrPath || '')}${cfgArg})`)
          break
        }
        case 'emb': {
          const cfg = { name: it.name }
          if (it.filePath) cfg.filePath = it.filePath
          if (it.code) cfg.code = it.code
          if (it.dropdown && Object.keys(it.dropdown).length) cfg.dropdown = it.dropdown
          L.push(`${indent}await this.Emb(id, ${JSON.stringify(cfg)})`)
          break
        }
        case 'route': {
          const m = it.method || 'Get'
          L.push(`${indent}this.${m}(id, ${JSON.stringify(it.path || '/')}, async (req, res) => {`)
          L.push(`${indent}  ${(it.handler || '').replace(/\n/g, '\n' + indent + '  ')}`)
          L.push(`${indent}})`)
          break
        }
        case 'code':
          L.push(`${indent}${(it.value || '').replace(/\n/g, '\n' + indent)}`)
          break
        default:
          L.push(`${indent}// [unknown item type: ${it.type}]`)
      }
    }
  }

  emit(state.items || [], '      ')
  if (state.code) L.push(state.code)
  L.push(`    })`)
  L.push(`  }`)
  L.push(`}`)
  return L.join('\n')
}

// ============================================================
// SELF BUILDER
// ============================================================
let __BUILDER_INITIAL_STATE = null
let __BUILDER_EXPORT_TARGET = null

const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor

// ============================================================
// SELF BUILDER — method discovery, defaults and item factories
// ============================================================

/**
 * Methods that are ALWAYS excluded from the "+New" list because they don't
 * make sense as standalone building blocks. The user-hidden list is layered
 * on top of this via `state.hiddenMethods`, so any SyAPP_Func method not in
 * this list is visible by default and can be toggled off via ⚙ Methods.
 */
const _SB_DEFAULT_NEW_BLACKLIST = [
  'Build', 'DiscoverRoutes', 'ProcessAlerts',
  'WaitLog', 'SetAlertConfig', 'RemoveAlert', 'ClearAlerts',
  'OnFunctionFirstEnter', 'OnFunctionEnter', 'OnFunctionLeave', 'OnFunctionFirstLeave',
  'OnSessionEnter', 'OnSessionEveryEnter', 'OnSessionLeave', 'OnSessionFirstLeave',
  'OnPageEnter', 'OnPageEveryEnter', 'OnPageLeave', 'OnPageFirstLeave',
  'LockPage', 'UnlockPage', 'IsPageLocked',
  'Storages', 'Admin', 'TextColor',
  'DropDownManager', 'FileManager', 'Pagination'
]

/**
 * Map a SyAPP_Func method name to a builder item type. Methods not present
 * here become generic `code` items whose body is a template call.
 */
const _SB_METHOD_TO_ITEMTYPE = {
  Text: 'text',
  Button: 'button',
  SideButton: 'button',
  Buttons: 'buttonsGroup',
  Field: 'field',
  TextEditor: 'texteditor',
  TextButton: 'textbutton',
  Page: 'page',
  PinnedTop: 'pinnedTop',
  PinnedBottom: 'pinnedBottom',
  DropDown: 'dropdown',
  WaitInput: 'waitinput',
  Alert: 'alert',
  AlertButton: 'button',
  GotoNow: 'gotonow',
  SetPage: 'setpage',
  File: 'file',
  JSON: 'json',
  JavaScript: 'javascript',
  Args: 'args',
  Cells: 'cells',
  Grid: 'grid',
  Emb: 'emb',
  Get: 'route',
  Post: 'route',
  Put: 'route',
  Delete: 'route'
}

/**
 * Build a fresh item payload for the given SyAPP_Func method name.
 * @param {string} methodName
 * @param {string} id - unique item id
 * @returns {object} item payload
 */
function _sbMakeItemForMethod(methodName, id) {
  const t = _SB_METHOD_TO_ITEMTYPE[methodName] || 'code'
  const base = { id, type: t, sourceMethod: methodName }
  switch (t) {
    case 'text':
      return { ...base, value: 'New text' }
    case 'button':
      return {
        ...base,
        name: methodName === 'SideButton' ? 'Side Button'
            : methodName === 'AlertButton' ? 'Alert Button'
            : 'Button',
        props: {},
        buttons: methodName === 'SideButton'
      }
    case 'buttonsGroup':
      // Container that holds ONLY button-type children. In view mode it
      // renders all children via this.Buttons([...]) — one horizontal row.
      return { ...base, items: [] }
    case 'field':
      return { ...base, name: 'field_' + id, label: 'Label', initialValue: '' }
    case 'texteditor':
      return { ...base, name: 'editor_' + id, label: 'Text Editor', initialValue: '' }
    case 'textbutton':
      // Compact scrollable text viewer. Defaults to a 4-row read-only box
      // with an editable toggle so the user can opt in to the editor flow.
      return {
        ...base,
        name: 'textbtn_' + id,
        label: 'Text',
        initialValue: '',
        lines: 4,
        editable: false,
        pinned: false,
        pinnedTop: false
      }
    case 'page':
      return {
        ...base,
        name: 'page_' + id,
        items: [],
        // When pinButton is enabled, this page registers itself for the
        // auto-generated navigation row (see SyAPP_Func.Page). Defaults
        // to false so existing projects remain unchanged.
        pinButton: false,
        // Where the nav button is pinned: 'bottom' (default) or 'top'.
        pinPosition: 'bottom'
      }
    case 'pinnedTop':
      // Pinned-top container: children render inside a this.PinnedTop()
      // block, so everything created inside is auto-marked pinnedTop.
      return { ...base, items: [] }
    case 'pinnedBottom':
      // Pinned-bottom container: children render inside a
      // this.PinnedBottom() block, so everything is auto-marked pinned.
      return { ...base, items: [] }
    case 'dropdown':
      return { ...base, name: 'dropdown_' + id, up_buttontext: 'Show more', down_buttontext: 'Hide' }
    case 'waitinput':
      return { ...base, path: '', props: {}, question: 'Type: ' }
    case 'alert':
      return { ...base, text: 'Alert text', duration: 3000 }
    case 'gotonow':
      return { ...base, path: '', props: {} }
    case 'setpage':
      return { ...base, page: '' }
    case 'file':
      return { ...base, config: {} }
    case 'json':
      return { ...base, config: {} }
    case 'args':
      // Args container: own schema + everyTime/form flags + nested children
      // (the handler body). `key` is stable across re-renders so the
      // captured state survives refreshes.
      return {
        ...base,
        everyTime: false,
        form: true,
        description: '',
        key: id,
        schema: [],
        items: []
      }
    case 'cells':
      // Spreadsheet launcher. Opens a full-screen editor with frozen
      // headers, aligned scrolling and pure-JS formulas.
      return {
        ...base,
        name: 'sheet_' + id,
        label: 'Sheet',
        rows: 100,
        cols: 26,
        pinned: false,
        pinnedTop: false
      }
    case 'grid':
      // Horizontal grid of cells. Starts with ONE empty cell.
      return {
        ...base,
        name: 'grid_' + id,
        cells: [{ items: [] }],
        maxCellRatio: 0.2,
        gap: 2
      }
    case 'javascript':
      // Minimalist JS widget. Starts with no source; the whole widget
      // is a single dropdown and the file picker + inline editor live
      // inside it. Inline codes are auto-saved under os.tmpdir().
      return {
        ...base,
        codeOrPath: '',
        config: { name: 'js_' + id, classOnly: false, timeout: 30000 }
      }
    case 'emb': {
      // Embedded SyAPP_Func. The item can be configured with an inline
      // code string, a file path, or left empty — in which case the
      // runtime this.Emb() call falls back to its two-button dropdown
      // (Self Build + File Picker).
      return {
        ...base,
        name: 'emb_' + id,
        filePath: '',
        code: '',
        saveMode: 'path',
        dropdown: {}
      }
    }
    case 'route':
      return { ...base, method: methodName, path: '/', handler: '// handler code' }
    case 'code':
    default:
      return { ...base, value: `// this.${methodName}(id, ...)` }
  }
}

/**
 * Logic-block template names exposed in the "+New" menu.
 * These do NOT come from SyAPP_Func methods — they generate container
 * items (`type: 'codeblock'`) that hold nested items in their body and
 * export as real JS control-flow structures.
 *
 * They are rendered in a SEPARATE section of the "+New" menu (below the
 * method list) so the default options stay the primary focus.
 */
const _SB_LOGIC_BLOCKS = [
  '+ if', '+ else if', '+ else',
  '+ for', '+ for of', '+ for await', '+ while',
  '+ Custom JS'
]

/**
 * Build a fresh logic-block (code chain) item.
 *
 * The resulting item is a CONTAINER: it exposes an `items` array that can
 * receive any other builder item (buttons, text, other code-blocks…) and,
 * on export, wraps those items inside the corresponding JS block:
 *
 *   if (condition) { <nested items go here> }
 *   for (let i = 0; i < n; i++) { <nested items go here> }
 *   for await (const x of iterable) { <nested items go here> }
 *
 * In VIEW mode the condition is evaluated for real (via AsyncFunction) so
 * the preview reflects the actual control flow — e.g. a button placed
 * inside a `for` will only render when the loop is entered.
 *
 * `customBefore` / `customAfter` carry raw JS for the "+ Custom JS"
 * template (and can be used to inject statements before/after the body
 * of any block).
 *
 * @param {string} blockType
 * @param {string} id
 * @returns {object}
 */
function _sbMakeCodeblock(blockType, id) {
  const templates = {
    if:       { label: 'if',        condition: 'condition' },
    elseif:   { label: 'else if',   condition: 'condition' },
    else:     { label: 'else',      condition: '' },
    for:      { label: 'for',       condition: 'let i = 0; i < n; i++' },
    forof:    { label: 'for of',    condition: 'const item of items' },
    forawait: { label: 'for await', condition: 'const item of iterable' },
    while:    { label: 'while',     condition: 'condition' },
    custom:   { label: 'custom JS', condition: '' }
  }
  const t = templates[blockType] || templates.custom
  return {
    id,
    type: 'codeblock',
    blockType,
    label: t.label,
    condition: t.condition,
    customBefore: blockType === 'custom' ? '// custom JS\n' : '',
    customAfter: '',
    items: []
  }
}

/**
 * Validate a raw JS snippet by attempting to compile it as the body of an
 * AsyncFunction. Returns `{ ok: true }` or `{ ok: false, error: <Error> }`.
 *
 * This is a pure syntax check — it does NOT execute the code and therefore
 * does not catch runtime ReferenceErrors. Combined with the render-time
 * execution warning (which DOES surface ReferenceErrors for undefined
 * variables), this covers both the "does not exist" and "won't parse"
 * cases.
 *
 * @param {string} code
 * @param {string} [label='<js>']
 * @returns {{ok: true} | {ok: false, error: Error, label: string}}
 */
function _sbValidateJS(code, label = '<js>') {
  try {
    // eslint-disable-next-line no-new
    new AsyncFunction('id', 'props', code || '')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e, label }
  }
}

/**
 * Validate a condition expression (used by if/else if/for/while blocks).
 * Conditions are wrapped in `return (...)` so we check them as expressions.
 * @param {string} cond
 * @returns {{ok: true} | {ok: false, error: Error, label: string}}
 */
function _sbValidateCondition(cond) {
  // `else` has an empty condition — always OK.
  if (!cond || !cond.trim()) return { ok: true }
  try {
    // eslint-disable-next-line no-new
    new AsyncFunction('id', 'props', `return (${cond})`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e, label: '<condition>' }
  }
}

/**
 * Enumerate all "constructive" methods exposed by SyAPP_Func instances
 * (functions assigned to `this.X = ...` inside the constructor). Cached
 * after the first call because the set is static.
 * @returns {Array<string>}
 */
let __SB_METHOD_CACHE = null
function _sbDiscoverMethods() {
  if (__SB_METHOD_CACHE) return __SB_METHOD_CACHE
  const probe = new SyAPP_Func('__sb_probe__')
  const found = []
  for (const key of Object.getOwnPropertyNames(probe)) {
    if (key.startsWith('_')) continue
    let v
    try { v = probe[key] } catch (_) { continue }
    if (typeof v === 'function') found.push(key)
  }
  __SB_METHOD_CACHE = found.sort()
  return __SB_METHOD_CACHE
}

class SelfBuilder extends SyAPP_Func {
  constructor() {
    super('__selfbuilder__', async (props) => { await this._renderSelf(props) }, { refreshMode: false })
    const initial = __BUILDER_INITIAL_STATE
      ? JSON.parse(JSON.stringify(__BUILDER_INITIAL_STATE))
      : { name: 'untitled', funcName: 'MyApp', code: '', items: [] }
    if (!Array.isArray(initial.hiddenMethods)) initial.hiddenMethods = []
    if (typeof initial.pinnedTopSeparator !== 'string') initial.pinnedTopSeparator = 'line'
    if (typeof initial.pinnedBottomSeparator !== 'string') initial.pinnedBottomSeparator = 'line'
    this.State = initial
    this.Editing = true
    this.EditItemId = null
    this.ExportTarget = __BUILDER_EXPORT_TARGET
    this._pendingEdit = null
    this._pendingAction = null
    this._idSeq = 0

    // ------------------------------------------------------------------
    // EMB MODE
    //
    // When this SelfBuilder was launched from this.Emb()'s 🧩 Self Build
    // button, SyAPP stashes a pending-return record on the SyAPP
    // instance and navigates here with `__embNewSession`. That marker
    // tells the SelfBuilder to operate in EMB mode:
    //
    //   • The canvas starts EMPTY (no shared state with the app's own
    //     SelfBuilder).
    //   • The toolbar shows "✓ Finish & Return" instead of the regular
    //     Save/Load/Export row.
    //   • Clicking Finish writes the produced file (path or inline) back
    //     into the target Emb instance via its own Storages entry, then
    //     navigates back to the caller screen.
    // ------------------------------------------------------------------
    this._embMode = false
    this._embTarget = null
    this._embReturnTo = null
    this._embReturnProps = null

    // Snapshot of the SelfBuilder state taken right BEFORE entering EMB
    // mode. Restored when the user finishes (or otherwise leaves) the
    // EMB run, so the parent builder view comes back exactly as it was.
    // This is what makes the Emb / Self-Build flow recursive.
    this._embPreviousState = null
    this._embPreviousEdit = undefined
    this._embPreviousEditId = null

    // Stack of pre-EMB state snapshots. Every time a new EMB session
    // opens (which can happen recursively when a produced embedded func
    // itself hosts an Emb widget and the user clicks its 🧩 Self Build),
    // the current SelfBuilder state is pushed here. Clicking
    // ✓ Finish & Return pops the top snapshot, so every nesting level
    // restores cleanly and each Emb / Self-Build session is fully
    // independent from every other one — at ANY depth.
    this._embStateStack = []
  }

  /**
   * Called by _renderSelf when the SelfBuilder is running in EMB mode.
   * Writes the final result into the target Emb's storage and returns
   * to the caller screen.
   *
   * The write-back uses the same storage key convention as this.Emb(),
   * so the next time the caller's dropdown opens, it already has the
   * file path (or the inline code) loaded and ready.
   *
   * @param {string} id - UserBuild id of the SelfBuilder session
   * @param {object} props - Build props from the SelfBuilder render
   * @private
   */
  _embFinishAndReturn = async (id, props) => {
    const syapp = this._syappInstance;
    if (!syapp) return;

    // Build a temp file holding the produced source so the caller Emb
    // can consume it via its filePath/inline path.
    let producedPath = null;
    let producedCode = null;
    try {
      const relSyapp = (() => {
        try {
          return path.relative(process.cwd(), url.fileURLToPath(import.meta.url));
        } catch (_) { return './SyAPP.js'; }
      })();
      producedCode = _genFuncJS(this.State, relSyapp);

      const outDir = path.join(os.tmpdir(), 'syapp_emb_builds');
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const outName = (this.State.funcName || 'EmbeddedFunc').replace(/[^A-Za-z0-9_$]/g, '') +
                      '_' + Date.now().toString(36) + '.js';
      producedPath = path.join(outDir, outName);
      fs.writeFileSync(producedPath, producedCode, 'utf8');
    } catch (e) {
      this.Alert(id, `❌ ${e.message}`, { duration: 4000 });
      return;
    }

    // ------------------------------------------------------------------
    // RESOLVE THE CALLER (props-first, shared-slot second).
    //
    // The shared `_pendingEmbBuild` slot is a SINGLE-SLOT field on the
    // SyAPP instance. When two EMB sessions overlap (which happens on
    // every recursive Emb → Self Build → Emb → Self Build flow because
    // the outer session's Finish & Return may still be running when the
    // inner session starts), an outer session can clobber the slot to
    // null while an inner session is still expecting its return info.
    //
    // This SelfBuilder's own `_embTarget` / `_embReturnTo` /
    // `_embReturnProps` are set from session-scoped props on EMB entry
    // and are NEVER touched by any other session, so they are the
    // reliable source. The shared slot is used only as a legacy
    // fallback for code paths that predate the props-based flow.
    // ------------------------------------------------------------------
    let caller = null;
    let callerFromSharedSlot = false;
    if (this._embTarget && this._embReturnTo) {
      caller = {
        embName: this._embTarget,
        returnTo: this._embReturnTo,
        returnProps: this._embReturnProps || {}
      };
    } else if (syapp._pendingEmbBuild && syapp._pendingEmbBuild.embName) {
      caller = syapp._pendingEmbBuild;
      callerFromSharedSlot = true;
    }

    if (caller && caller.embName) {
      // Find the Emb owner func instance so we can write to its
      // Storages under the same id key it uses.
      const session = syapp.Sessions.get(syapp.MainSessionID);
      const sessionId = session ? session.UniqueID : id;
      // In-memory storage is per-SyAPP_Func instance, so the same
      // storageKey across two different funcs is already isolated.
      const embStorageKey = `emb_${caller.embName}`;

      // Ensure the target func has initialised its storage for this
      // Emb name — otherwise we bootstrap a fresh entry with the
      // produced source already set.
      const ownerFunc = syapp.Funcs.get(caller.returnTo);
      if (ownerFunc && ownerFunc.Storages) {
        let cur = ownerFunc.Storages.Get(sessionId, embStorageKey);
        if (!cur || typeof cur !== 'object') {
          cur = { source: 'file', filePath: producedPath, code: null,
                  saveMode: 'path', error: null, pickMode: false };
        } else {
          cur.source = 'file';
          cur.filePath = producedPath;
          cur.code = producedCode;
          cur.saveMode = 'path';
          cur.error = null;
        }
        ownerFunc.Storages.Set(sessionId, embStorageKey, cur);
      }

      // Mirror the produced source into the disk-backed emb record so
      // the widget can be recovered after a Ctrl+C and relaunch, even
      // though the in-memory session-keyed storage entry will be gone
      // the moment the process exits.
      try {
        let outerFilePath = null;
        if (typeof __BUILDER_EXPORT_TARGET === 'string' && __BUILDER_EXPORT_TARGET) {
          outerFilePath = __BUILDER_EXPORT_TARGET;
        } else {
          const argvFile = process.argv[2];
          if (typeof argvFile === 'string' &&
              /\.(js|mjs|cjs)$/i.test(argvFile) &&
              !/SyAPP\.(js|mjs|cjs)$/i.test(argvFile)) {
            const abs = path.isAbsolute(argvFile)
              ? argvFile
              : path.resolve(process.cwd(), argvFile);
            if (fs.existsSync(abs)) outerFilePath = abs;
          }
        }
        if (outerFilePath) {
          // Namespaced disk key matching this.Emb()'s read/write key
          // exactly: owner func + widget name. This is what keeps the
          // outer func's Emb record and every nested embedded func's
          // Emb record completely independent on disk.
          _embDiskSave(outerFilePath, `${caller.returnTo || '__unknown__'}::${caller.embName}`, {
            source: 'file',
            filePath: producedPath,
            code: producedCode,
            saveMode: 'path'
          });
        }
      } catch (_) { /* best-effort */ }

      this.Alert(id, `✓ Embedded func produced: ${path.basename(producedPath)}`, { duration: 3000 });

      // Only clear the shared slot when WE consumed it. If we resolved
      // the caller via this SelfBuilder's own EMB state (because a
      // nested session had already overwritten the slot), leave the
      // slot alone — it now belongs to the nested session and clearing
      // it here would lose that session's return info.
      if (callerFromSharedSlot && syapp._pendingEmbBuild === caller) {
        syapp._pendingEmbBuild = null;
      }

      // ------------------------------------------------------------------
      // POP THE EMB STATE SNAPSHOT STACK.
      //
      // Every Emb → Self Build push contributes exactly one snapshot,
      // and every ✓ Finish & Return pops it back — so nested flows
      // (Emb inside a produced func, inside another Emb, ...) each
      // restore cleanly to the state that was current when their own
      // EMB session started. This is what makes the Emb / Self-Build
      // flow fully recursive at any depth.
      // ------------------------------------------------------------------
      if (Array.isArray(this._embStateStack) && this._embStateStack.length > 0) {
        const prev = this._embStateStack.pop();
        if (prev) {
          this.State = prev.state;
          this.Editing = prev.editing;
          this.EditItemId = prev.editItemId;
          this._embMode = prev.embMode;
          this._embTarget = prev.embTarget;
          this._embReturnTo = prev.embReturnTo;
          this._embReturnProps = prev.embReturnProps;
        }
      } else {
        // No snapshot on the stack — fall back to the legacy
        // single-snapshot field and exit EMB mode.
        if (this._embPreviousState) {
          this.State = this._embPreviousState;
          this.Editing = this._embPreviousEdit;
          this.EditItemId = this._embPreviousEditId;
        }
        this._embMode = false;
        this._embTarget = null;
        this._embReturnTo = null;
        this._embReturnProps = null;
      }

      // Navigate back to the caller screen with its original props.
      this.GotoNow(id, caller.returnTo, { props: caller.returnProps || {} });
      return;
    }

    // ------------------------------------------------------------------
    // NO RESOLVABLE CALLER
    //
    // Even in this path we still pop the EMB stack and exit EMB mode,
    // so the SelfBuilder is left in a usable state instead of being
    // stuck in EMB mode with no way out. The produced func is kept in
    // the temp directory (its path is included in the alert) so it can
    // be picked manually with 📁 Pick File if needed.
    // ------------------------------------------------------------------
    this.Alert(id, `⚠ No Emb target set — result kept in temp: ${path.basename(producedPath)}`, { duration: 5000 });
    if (Array.isArray(this._embStateStack) && this._embStateStack.length > 0) {
      const prev = this._embStateStack.pop();
      if (prev) {
        this.State = prev.state;
        this.Editing = prev.editing;
        this.EditItemId = prev.editItemId;
        this._embMode = prev.embMode;
        this._embTarget = prev.embTarget;
        this._embReturnTo = prev.embReturnTo;
        this._embReturnProps = prev.embReturnProps;
      }
    } else {
      this._embMode = false;
      this._embTarget = null;
      this._embReturnTo = null;
      this._embReturnProps = null;
    }
  }

  _nid() { return `it_${Date.now().toString(36)}_${++this._idSeq}` }

  _findItem(id, items) {
    items = items || this.State.items
    for (const it of items) {
      if (it.id === id) return it

      // Recurse into ANY nested `items` array (page, dropdown, codeblock,
      // args, buttonsGroup, pinnedTop, pinnedBottom).
      if (Array.isArray(it.items)) {
        const f = this._findItem(id, it.items)
        if (f) return f
      }

      // Recurse into grid cells so any item nested inside a cell is
      // reachable (edit, delete, reorder — all work on them). This is
      // what makes clicking the ○/◉ dot actually open the pinned editor.
      if (Array.isArray(it.cells)) {
        for (const cell of it.cells) {
          if (cell && Array.isArray(cell.items)) {
            const f = this._findItem(id, cell.items)
            if (f) return f
          }
        }
      }
    }
    return null
  }

  _findItemByName(name, items) {
    items = items || this.State.items
    for (const it of items) {
      if (it.type === 'page' && it.name === name) return it
      if ((it.type === 'page' || it.type === 'dropdown' || it.type === 'codeblock' ||
           it.type === 'args' || it.type === 'buttonsGroup' ||
           it.type === 'pinnedTop' || it.type === 'pinnedBottom') &&
          Array.isArray(it.items)) {
        const f = this._findItemByName(name, it.items)
        if (f) return f
      }
    }
    return null
  }

  /**
   * Resolve the current editing context from a synthetic "page name".
   *   - real pages            → pageName is the page's name
   *   - dropdown containers   → `__sbdd__:<itemId>`
   *   - code-block containers → `__sbcb__:<itemId>`
   * @returns {{kind: 'root'|'page'|'dropdown'|'codeblock'|'missing', item?: object, items: Array}}
   */
  _resolveContainer(pageName) {
    const S = this.State
    if (!pageName) return { kind: 'root', items: S.items }
    if (typeof pageName === 'string' && pageName.startsWith('__sbdd__:')) {
      const id = pageName.slice(9)
      const item = this._findItem(id)
      if (item && item.type === 'dropdown') {
        if (!Array.isArray(item.items)) item.items = []
        return { kind: 'dropdown', item, items: item.items }
      }
    }
    if (typeof pageName === 'string' && pageName.startsWith('__sbcb__:')) {
      const id = pageName.slice(9)
      const item = this._findItem(id)
      if (item && item.type === 'codeblock') {
        if (!Array.isArray(item.items)) item.items = []
        return { kind: 'codeblock', item, items: item.items }
      }
    }
    if (typeof pageName === 'string' && pageName.startsWith('__sba__:')) {
      const id = pageName.slice(8)
      const item = this._findItem(id)
      if (item && item.type === 'args') {
        if (!Array.isArray(item.items)) item.items = []
        return { kind: 'args', item, items: item.items }
      }
    }
    if (typeof pageName === 'string' && pageName.startsWith('__sbbg__:')) {
      const id = pageName.slice(9)
      const item = this._findItem(id)
      if (item && item.type === 'buttonsGroup') {
        if (!Array.isArray(item.items)) item.items = []
        return { kind: 'buttonsGroup', item, items: item.items }
      }
    }
    if (typeof pageName === 'string' && pageName.startsWith('__sbpt__:')) {
      const id = pageName.slice(9)
      const item = this._findItem(id)
      if (item && item.type === 'pinnedTop') {
        if (!Array.isArray(item.items)) item.items = []
        return { kind: 'pinnedTop', item, items: item.items }
      }
    }
    if (typeof pageName === 'string' && pageName.startsWith('__sbpb__:')) {
      const id = pageName.slice(9)
      const item = this._findItem(id)
      if (item && item.type === 'pinnedBottom') {
        if (!Array.isArray(item.items)) item.items = []
        return { kind: 'pinnedBottom', item, items: item.items }
      }
    }
    // Grid cell container: "__sbgc__:<gridId>:<cellIdx>"
    if (typeof pageName === 'string' && pageName.startsWith('__sbgc__:')) {
      const rest = pageName.slice(9)
      const colonIdx = rest.indexOf(':')
      const gridId = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest
      const cellIdx = colonIdx >= 0 ? (parseInt(rest.slice(colonIdx + 1), 10) || 0) : 0
      const item = this._findItem(gridId)
      if (item && item.type === 'grid') {
        if (!Array.isArray(item.cells)) item.cells = [{ items: [] }]
        if (!item.cells[cellIdx]) item.cells[cellIdx] = { items: [] }
        if (!Array.isArray(item.cells[cellIdx].items)) item.cells[cellIdx].items = []
        return { kind: 'gridCell', item, cellIdx, items: item.cells[cellIdx].items }
      }
    }
    const pageItem = S.items.find(i => i.type === 'page' && i.name === pageName)
    if (pageItem) {
      if (!Array.isArray(pageItem.items)) pageItem.items = []
      return { kind: 'page', item: pageItem, items: pageItem.items }
    }
    return { kind: 'missing', items: [] }
  }

  _getHiddenSet() {
    const hidden = new Set(_SB_DEFAULT_NEW_BLACKLIST)
    for (const m of (this.State.hiddenMethods || [])) hidden.add(m)
    return hidden
  }

  _getVisibleNewMethods() {
    const all = _sbDiscoverMethods()
    const hidden = this._getHiddenSet()
    // Only SyAPP_Func methods here. Logic-block templates are handled
    // separately by _renderNewMethodsMenu so they can be shown in their
    // own section below the method list.
    return all.filter(m => !hidden.has(m))
  }

  /**
   * Number of items to show per page in the "+New" list and in the
   * Config menu. Persisted inside the builder State (so it survives
   * saves/loads) and defaults to 4.
   * @returns {number}
   */
  _getItemsPerPage() {
    const v = this.State && this.State.itemsPerPage
    return (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 20)
      ? Math.floor(v)
      : 4
  }

  _processActions(id, props) {
    const S = this.State
    const p = props || {}
    const curProps = this.Builds.get(id)?.Session?.ActualProps || {}
    const curPage = curProps.page || ''
    const passProps = curPage ? { page: curPage } : {}

    // ---- WaitInput resolution ----
    // Consume `inputValue` ONLY when this SelfBuilder instance itself
    // initiated the WaitInput. Nested widgets (e.g. the JavaScript
    // item's "rename recent" prompt) may also use WaitInput and
    // resolve their own value downstream in their own prop handlers.
    if (p.inputValue !== undefined && (this._pendingEdit || this._pendingAction)) {
      if (this._pendingEdit) {
        const it = this._findItem(this._pendingEdit.itemId)
        if (it) {
          const kind = this._pendingEdit.kind || 'string'
          const prop = this._pendingEdit.prop
          let v = p.inputValue
          let valid = true
          let reason = ''

          if (kind === 'json') {
            try { v = typeof v === 'string' ? JSON.parse(v) : v }
            catch (e) { valid = false; reason = 'Invalid JSON: ' + e.message; v = it[prop] }
          } else if (kind === 'number') {
            const n = Number(v)
            if (isNaN(n)) { valid = false; reason = 'Not a number'; v = it[prop] }
            else v = n
          } else {
            v = String(v)
          }

          // ---------------- JS VALIDATION ----------------
          // For code-bearing properties, compile the result before we
          // commit it. If it doesn't parse, revert to the previous value
          // and alert the user. This is what catches "does not exist"
          // typos at edit time (unbalanced parens, unknown syntax, etc.),
          // while runtime ReferenceErrors are surfaced by the render pass.
          if (valid) {
            if (prop === 'value' && it.type === 'code') {
              const res = _sbValidateJS(v, 'code')
              if (!res.ok) { valid = false; reason = 'JS syntax: ' + res.error.message }
            } else if (prop === 'handler' && it.type === 'route') {
              const res = _sbValidateJS(v, 'handler')
              if (!res.ok) { valid = false; reason = 'JS syntax: ' + res.error.message }
            } else if (prop === 'customBefore' && it.type === 'codeblock') {
              const res = _sbValidateJS(v, 'customBefore')
              if (!res.ok) { valid = false; reason = 'JS syntax: ' + res.error.message }
            } else if (prop === 'customAfter' && it.type === 'codeblock') {
              const res = _sbValidateJS(v, 'customAfter')
              if (!res.ok) { valid = false; reason = 'JS syntax: ' + res.error.message }
            } else if (prop === 'condition' && it.type === 'codeblock') {
              const res = _sbValidateCondition(v)
              if (!res.ok) { valid = false; reason = 'Condition syntax: ' + res.error.message }
            }
          }

          if (valid) {
            it[prop] = v
          } else {
            this.Alert(id, '❌ ' + reason, { duration: 4000 })
          }
        }
        this._pendingEdit = null
      } else if (this._pendingAction === 'save') {
        const name = String(p.inputValue).trim()
        if (name) {
          S.name = name
          try {
            _writeSaveState(name, S)
            this.Alert(id, `💾 Saved "${name}"`, { duration: 2500 })
          } catch (e) {
            this.Alert(id, `❌ ${e.message}`, { duration: 4000 })
          }
        }
        this._pendingAction = null
      } else if (this._pendingAction === 'export') {
        const name = String(p.inputValue).trim()
        if (name) {
          try {
            const target = this.ExportTarget
              ? this.ExportTarget
              : path.resolve(process.cwd(), name.endsWith('.js') ? name : name + '.js')
            const dir = path.dirname(target)
            let rel = path.relative(dir, url.fileURLToPath(import.meta.url))
            if (!rel.startsWith('.')) rel = './' + rel
            const js = _genFuncJS(S, rel)
            fs.writeFileSync(target, js)
            this.Alert(id, `📤 Exported: ${target}`, { duration: 3500 })
          } catch (e) {
            this.Alert(id, `❌ ${e.message}`, { duration: 4000 })
          }
        }
        this._pendingAction = null
      } else if (this._pendingAction === 'load') {
        const name = String(p.inputValue).trim()
        if (name) {
          const loaded = _loadSaveState(name)
          if (loaded) {
            if (!Array.isArray(loaded.hiddenMethods)) loaded.hiddenMethods = []
            this.State = loaded
            this.EditItemId = null
            this.Alert(id, `📂 Loaded "${name}"`, { duration: 2500 })
          } else {
            this.Alert(id, `❌ No save "${name}"`, { duration: 3000 })
          }
        }
        this._pendingAction = null
      } else if (this._pendingAction === 'funcName') {
        const v = String(p.inputValue).trim().replace(/[^A-Za-z0-9_$]/g, '')
        if (v) S.funcName = v
        this._pendingAction = null
      } else if (this._pendingAction === 'appName') {
        const v = String(p.inputValue).trim()
        if (v) S.name = v
        this._pendingAction = null
      } else if (this._pendingAction === 'itemsPerPage') {
        const v = parseInt(String(p.inputValue).trim(), 10)
        if (!isNaN(v) && v >= 1 && v <= 20) {
          S.itemsPerPage = v
        }
        this._pendingAction = null
      }
      delete p.inputValue
      return
    }

    // If `inputValue` is still present here, it belongs to a nested
    // widget — leave it untouched so the widget's own prop handler
    // can consume it.
    if (p.inputValue !== undefined) {
      return
    }

    if (p.__toggleEdit) { this.Editing = !this.Editing; this.EditItemId = null }

    // EMB mode: finish and return to the caller Emb.
    if (p.__embFinish) {
      // Fire-and-forget; the write-back then navigates away.
      this._embFinishAndReturn(id, p).catch(e => {
        this.Alert(id, `❌ ${e.message}`, { duration: 4000 });
      });
      return;
    }

    if (p.__toggleNew) {
      const cur = this.Storages.Get(id, 'sb_new_open') || false
      this.Storages.Set(id, 'sb_new_open', !cur)
      // Opening "+New" closes "⚙ Config" (and vice versa) so only one
      // menu ever occupies the top area at any given time.
      if (!cur) this.Storages.Set(id, 'sb_methods_open', false)
    }

    if (p.__toggleMethods) {
      const cur = this.Storages.Get(id, 'sb_methods_open') || false
      this.Storages.Set(id, 'sb_methods_open', !cur)
      // Opening "⚙ Config" closes "+New" (and vice versa).
      if (!cur) this.Storages.Set(id, 'sb_new_open', false)
    }

    // Filter toggle for the "+New" list (SyAPP ↔ Javascript).
    if (p.__setNewFilter) {
      this.Storages.Set(id, 'sb_new_filter', p.__setNewFilter)
      this.Storages.Set(id, 'sb_new_page', { page: 1 })
    }

    // Config menu: edit the number of items per page.
    if (p.__editConfig) {
      const prop = p.__editConfig
      if (prop === 'itemsPerPage') {
        this._pendingAction = 'itemsPerPage'
        this.WaitInput(id, { question: 'Items per page (1-20): ', path: this.Name, props: passProps })
        return
      }
    }

    if (p.__newPagePrev) {
      const st = this.Storages.Get(id, 'sb_new_page') || { page: 1 }
      st.page = Math.max(1, (st.page || 1) - 1)
      this.Storages.Set(id, 'sb_new_page', st)
    }
    if (p.__newPageNext) {
      const st = this.Storages.Get(id, 'sb_new_page') || { page: 1 }
      st.page = (st.page || 1) + 1
      this.Storages.Set(id, 'sb_new_page', st)
    }
    if (p.__methodsPagePrev) {
      const st = this.Storages.Get(id, 'sb_methods_page') || { page: 1 }
      st.page = Math.max(1, (st.page || 1) - 1)
      this.Storages.Set(id, 'sb_methods_page', st)
    }
    if (p.__methodsPageNext) {
      const st = this.Storages.Get(id, 'sb_methods_page') || { page: 1 }
      st.page = (st.page || 1) + 1
      this.Storages.Set(id, 'sb_methods_page', st)
    }

    if (p.__toggleMethodHidden) {
      const m = p.__toggleMethodHidden
      const hidden = Array.isArray(S.hiddenMethods) ? S.hiddenMethods.slice() : []
      const idx = hidden.indexOf(m)
      if (idx >= 0) hidden.splice(idx, 1)
      else hidden.push(m)
      S.hiddenMethods = hidden
    }

    if (p.__resetHidden) {
      S.hiddenMethods = []
      this.Alert(id, '↺ Method blacklist reset (using defaults)', { duration: 2500 })
    }

    // Cycle a pinned-area separator style: line → none → discrete → line
    if (p.__cycleSeparator) {
      const isTop = p.__cycleSeparator === 'top'
      const key = isTop ? 'pinnedTopSeparator' : 'pinnedBottomSeparator'
      const cur = S[key] || 'line'
      const next = cur === 'line' ? 'none' : cur === 'none' ? 'discrete' : 'line'
      S[key] = next
      const label = isTop ? 'Top' : 'Bottom'
      this.Alert(id, `📌 ${label} separator → ${next}`, { duration: 2000 })
    }

    // Cycle the separator style of a SPECIFIC pinned item (pinnedTop /
    // pinnedBottom container). Stored on the item itself so each pinned
    // region can have its own look. The item-level value overrides the
    // global default when rendering.
    if (p.__cycleItemSeparator) {
      const [iid, which] = String(p.__cycleItemSeparator).split('::')
      const it = this._findItem(iid)
      if (it) {
        const cur = it.separator || 'line'
        const next = cur === 'line' ? 'none' : cur === 'none' ? 'discrete' : 'line'
        it.separator = next
        this.Alert(id, `📌 ${which === 'top' ? 'Top' : 'Bottom'} separator → ${next}`, { duration: 2000 })
      }
    }

    if (p.__add) {
      const methodName = p.__add
      const newId = this._nid()
      let it

      // Logic-block pseudo-methods start with "+ ". Everything else maps
      // to a real SyAPP_Func method.
      if (methodName.startsWith('+ ')) {
        const blockType = {
          '+ if':        'if',
          '+ else if':   'elseif',
          '+ else':      'else',
          '+ for':       'for',
          '+ for of':    'forof',
          '+ for await': 'forawait',
          '+ while':     'while',
          '+ Custom JS': 'custom'
        }[methodName] || 'custom'
        it = _sbMakeCodeblock(blockType, newId)
      } else {
        it = _sbMakeItemForMethod(methodName, newId)
      }

      // Resolve where the new item should go. This supports arbitrarily
      // nested containers (root → page → dropdown → dropdown → codeblock...).
      const container = this._resolveContainer(curPage)
      if (container.kind === 'root' || !container.items) {
        S.items.push(it)
      } else {
        container.items.push(it)
      }

      this.EditItemId = it.id
      this.Storages.Set(id, 'sb_new_open', false)
    }

    // Recursive delete across the FULL container hierarchy (pages,
    // dropdowns, codeblocks, args, buttonsGroup, pinned areas AND grid
    // cells).
    if (p.__del) {
      const recurseFind = (arr) => {
        const idx = arr.findIndex(x => x.id === p.__del)
        if (idx >= 0) { arr.splice(idx, 1); return true }
        for (const it of arr) {
          if (Array.isArray(it.items)) {
            if (recurseFind(it.items)) return true
          }
          if (Array.isArray(it.cells)) {
            for (const cell of it.cells) {
              if (cell && Array.isArray(cell.items)) {
                if (recurseFind(cell.items)) return true
              }
            }
          }
        }
        return false
      }
      recurseFind(S.items)
      if (this.EditItemId === p.__del) this.EditItemId = null
    }

    // Recursive reorder (up/down) across the FULL container hierarchy.
    const moveInTree = (arr, targetId, dir) => {
      const i = arr.findIndex(x => x.id === targetId)
      if (i >= 0) {
        if (dir === 'up' && i > 0) { const [x] = arr.splice(i, 1); arr.splice(i - 1, 0, x); return true }
        if (dir === 'down' && i < arr.length - 1) { const [x] = arr.splice(i, 1); arr.splice(i + 1, 0, x); return true }
        return false
      }
      for (const it of arr) {
        if (Array.isArray(it.items)) {
          if (moveInTree(it.items, targetId, dir)) return true
        }
        if (Array.isArray(it.cells)) {
          for (const cell of it.cells) {
            if (cell && Array.isArray(cell.items)) {
              if (moveInTree(cell.items, targetId, dir)) return true
            }
          }
        }
      }
      return false
    }

    // Grid cell management from the cell's OWN toolbar.
    if (p.__gridAddCell) {
      const parts = String(p.__gridAddCell).split(':')
      const gid = parts[0]
      const cidx = parseInt(parts[1], 10) || 0
      const g = this._findItem(gid)
      if (g && g.type === 'grid') {
        if (!Array.isArray(g.cells)) g.cells = []
        g.cells.splice(cidx + 1, 0, { items: [] })
        this.Storages.Set(id, 'sb_new_open', false)
        const newProps = { ...(this.Builds.get(id)?.Session?.ActualProps || {}) }
        newProps.page = `__sbgc__:${gid}:${cidx + 1}`
        delete newProps.__add
        delete newProps.__toggleNew
        this.Builds.get(id).Session.ActualProps = newProps
        this.Alert(id, '＋ Cell added', { duration: 1500 })
        return
      }
    }
    if (p.__gridDelCell) {
      const parts = String(p.__gridDelCell).split(':')
      const gid = parts[0]
      const cidx = parseInt(parts[1], 10) || 0
      const g = this._findItem(gid)
      if (g && g.type === 'grid' && Array.isArray(g.cells) && g.cells.length > 1) {
        g.cells.splice(cidx, 1)
        const newIdx = Math.max(0, cidx - 1)
        const newProps = { ...(this.Builds.get(id)?.Session?.ActualProps || {}) }
        newProps.page = `__sbgc__:${gid}:${newIdx}`
        delete newProps.__add
        delete newProps.__toggleNew
        this.Builds.get(id).Session.ActualProps = newProps
        this.Alert(id, '− Cell removed', { duration: 1500 })
        return
      }
    }
    if (p.__up)   moveInTree(S.items, p.__up, 'up')
    if (p.__down) moveInTree(S.items, p.__down, 'down')

    if (p.__editItem !== undefined) this.EditItemId = p.__editItem || null

    if (p.__toggleProp) {
      const [iid, prop] = String(p.__toggleProp).split('::')
      const it = this._findItem(iid)
      if (it) it[prop] = !it[prop]
    }

    // Cycle a page's pin position (bottom ↔ top). Used by the page
    // editor's "Pin Position" button.
    if (p.__cyclePinPosition) {
      const it = this._findItem(p.__cyclePinPosition)
      if (it) {
        it.pinPosition = (it.pinPosition === 'top') ? 'bottom' : 'top'
        this.Alert(id, `📌 Pin position → ${it.pinPosition}`, { duration: 2000 })
      }
    }

    if (p.__editProp) {
      const [iid, prop, kind] = String(p.__editProp).split('::')
      this._pendingEdit = { itemId: iid, prop, kind: kind || 'string' }
      const label = kind === 'json' ? `${prop} (JSON)`
                  : kind === 'number' ? `${prop} (number)`
                  : prop
      this.WaitInput(id, { question: `Edit ${label}: `, path: this.Name, props: passProps })
      return
    }

    if (p.__setFuncName) { this._pendingAction = 'funcName'; this.WaitInput(id, { question: 'Class name: ', path: this.Name, props: passProps }); return }
    if (p.__setAppName) { this._pendingAction = 'appName'; this.WaitInput(id, { question: 'App name: ', path: this.Name, props: passProps }); return }
    if (p.__save) { this._pendingAction = 'save'; this.WaitInput(id, { question: 'Save as: ', path: this.Name, props: passProps }); return }
    if (p.__load) { this._pendingAction = 'load'; this.WaitInput(id, { question: 'Load name: ', path: this.Name, props: passProps }); return }
    if (p.__export) { this._pendingAction = 'export'; this.WaitInput(id, { question: 'Export file: ', path: this.Name, props: passProps }); return }
    if (p.__exit) { process.exit(0) }
  }

  // ----------------------------------------------------------
  // RENDER
  // ----------------------------------------------------------
  async _renderSelf(props) {
    const id = props.session.UniqueID
    const curProps = this.Builds.get(id)?.Session?.ActualProps || {}
    const curPage = curProps.page || ''

    // NOTE: `S = this.State` is deliberately captured further down,
    // AFTER the EMB-mode recovery block and AFTER `_processActions`.
    // Both of those can reassign `this.State` (EMB recovery reloads the
    // produced func; `_processActions` 'load' replaces it with a save).
    // Reading it here left `S` pointing at a STALE object, so the
    // renderer's empty-canvas check (`S.items.length === 0`) always fired
    // and the recovered items were silently ignored — the exact
    // "blank Func after restart" symptom.

    // ------------------------------------------------------------------
    // EMB MODE detection
    //
    // If the caller of this SelfBuilder render has `__embNewSession` in
    // its props, this SelfBuilder was launched from this.Emb()'s
    // 🧩 Self Build button. Enable EMB mode, reset the canvas so the
    // user starts fresh (a BRAND NEW SelfBuilder session, separate from
    // the app's own SelfBuilder state), and record the return info.
    // ------------------------------------------------------------------
    // NOTE: no `!this._embMode` guard here any more. That guard prevented
    // the SelfBuilder from switching into a NEW EMB session when the
    // instance was already in EMB mode from a previous flow — which
    // silently broke nested Emb-in-Emb recursion (the second Self Build
    // would reuse the first one's target and then Finish & Return would
    // write the result to the wrong place). We now always enter fresh
    // whenever the marker prop is present, and push the CURRENT state
    // onto the EMB stack so the previous session can be restored when
    // this one finishes.
    if (curProps.__embNewSession) {
      // Push the current state BEFORE mutating anything so that nested
      // flows restore cleanly, one level at a time.
      if (!Array.isArray(this._embStateStack)) this._embStateStack = [];
      this._embStateStack.push({
        state: this.State,
        editing: this.Editing,
        editItemId: this.EditItemId,
        embMode: this._embMode,
        embTarget: this._embTarget,
        embReturnTo: this._embReturnTo,
        embReturnProps: this._embReturnProps
      });

      this._embMode = true;
      this._embTarget = curProps.__embNewSession;

      // ------------------------------------------------------------------
      // RESOLVE RETURN INFO — PROPS FIRST, SHARED SLOT SECOND.
      //
      // The return info is now also shipped as session-scoped props
      // (__embReturnTo / __embReturnProps / __embSourceFile) set by
      // this.Emb()'s 🧩 Self Build handler. Props are the RELIABLE
      // source because they live on the current session's ActualProps
      // and cannot be cleared by any other EMB session.
      //
      // The shared `_pendingEmbBuild` slot remains supported as a
      // legacy fallback for older code paths (and for disk-recovery
      // flows that never touched the shared slot).
      // ------------------------------------------------------------------
      const pending = this._syappInstance && this._syappInstance._pendingEmbBuild;
      this._embReturnTo =
        (curProps.__embReturnTo !== undefined && curProps.__embReturnTo !== null)
          ? curProps.__embReturnTo
          : (pending ? pending.returnTo : null);
      this._embReturnProps =
        (curProps.__embReturnProps !== undefined && curProps.__embReturnProps !== null)
          ? curProps.__embReturnProps
          : (pending ? pending.returnProps : null);

      // Preserve the pre-EMB state so the parent SelfBuilder view can be
      // restored the moment the user finishes (or cancels) the EMB run.
      // Storing State (rather than reusing the live reference) is what
      // makes the Emb-in-Func-in-Emb recursion behave correctly: each
      // nesting level has its own snapshot on the instance stack, and
      // the innermost Finish & Return puts everything back one layer.
      this._embPreviousState = this.State;
      this._embPreviousEdit = this.Editing;
      this._embPreviousEditId = this.EditItemId;

      // ------------------------------------------------------------------
      // RECOVER EXISTING EMBED SOURCE (if any).
      //
      // A brand-new SelfBuilder instance is created on every process
      // restart, so `_embMode` starts as `false` and this guard is
      // entered. The previous implementation unconditionally blanked
      // the canvas here, which is why re-opening "🧩 Self Build" on an
      // already-produced embed showed a BLANK Func after Ctrl+C — even
      // though the embed widget itself was correctly recovered by
      // this.Emb() (that's why Enter Func navigated fine).
      //
      // Fix: before blanking, try to recover the source the embed
      // widget already has attached. If found, parse it with the same
      // best-effort parser used by `--edit` (`_sbParseFuncJS`) and load
      // it into the canvas. Otherwise stay blank — so the very first
      // entry on a fresh embed is byte-for-byte unchanged.
      //
      // Recovery order (first match wins):
      //   1. The OWNER func's in-memory storage for this session, keyed
      //      by `emb_<embName>`. On a fresh process this ALREADY carries
      //      the disk-recovered filePath, because this.Emb() ran during
      //      the owner's build pass just before the user clicked
      //      🧩 Self Build.
      //   2. The disk record read via `_embDiskLoad()` — the same self-
      //      heal path this.Emb() itself uses.
      //   3. Fallback: scan every registered func for one whose storage
      //      holds an `emb_<name>` entry for this session (in case
      //      `_embReturnTo` was somehow lost).
      //
      // IMPORTANT: this reassigns `this.State`. `_renderSelf` therefore
      // captures `S = this.State` AFTER this block (and after
      // `_processActions`), never before — see the note at the top of
      // the method.
      // ------------------------------------------------------------------
      let recoveredState = null;
      try {
        let recoveredPath = null;
        let recoveredCode = null;

        // Resolve the outer file path EXACTLY the way this.Emb() and
        // _embFinishAndReturn() do, so the disk key matches on both
        // write and read.
        let outerFilePath = null;
        try {
          const argvFile = process.argv[2];
          if (typeof argvFile === 'string' &&
              /\.(js|mjs|cjs)$/i.test(argvFile) &&
              !/SyAPP\.(js|mjs|cjs)$/i.test(argvFile)) {
            const abs = path.isAbsolute(argvFile)
              ? argvFile
              : path.resolve(process.cwd(), argvFile);
            if (fs.existsSync(abs)) outerFilePath = abs;
          }
        } catch (_) {}
        if (!outerFilePath &&
            typeof __BUILDER_EXPORT_TARGET === 'string' &&
            __BUILDER_EXPORT_TARGET) {
          outerFilePath = __BUILDER_EXPORT_TARGET;
        }

        // --- 1) In-memory recovery ---
        //
        // The EMB-produced func is written back through whichever func
        // is CURRENTLY rendering the Emb widget, which — for widgets
        // that live INSIDE a Self Build canvas — is always THIS
        // SelfBuilder instance. The owner resolved from _embReturnTo
        // is therefore just a hint: it correctly resolves to
        // '__selfbuilder__' in the recursive case, but the entry can
        // also live on the SelfBuilder itself or on another registered
        // func when the widget is rendered through a nested container.
        //
        // We now probe a small ordered list of candidates:
        //   1. the owner func from _embReturnTo (primary),
        //   2. THIS SelfBuilder instance (the actual writer in the
        //      recursive Emb → Self Build → Emb flow),
        //   3. a global scan over every registered func (last resort).
        //
        // A candidate is accepted ONLY when its entry actually carries
        // a real source (filePath or code). Boot-only entries (source:
        // 'none') are skipped, so a stale sibling / ancestor record
        // can never shadow the correct produced func — this preserves
        // the original anti-confusion fix while still recovering the
        // produced func in every recursive flow.
        try {
          const syapp = this._syappInstance;
          const session = syapp && syapp.Sessions.get(syapp.MainSessionID);
          const sessionId = session ? session.UniqueID : id;
          const storageKeyForRecovery = `emb_${this._embTarget}`;

          const ownerCandidates = [];
          const seenFuncs = new Set();
          const addCandidate = (f) => {
            if (f && typeof f === 'object' && f.Storages && !seenFuncs.has(f)) {
              seenFuncs.add(f);
              ownerCandidates.push(f);
            }
          };

          if (syapp && syapp.Funcs) {
            if (this._embReturnTo) {
              addCandidate(syapp.Funcs.get(this._embReturnTo));
            }
            addCandidate(this);
            for (const [, f] of syapp.Funcs) addCandidate(f);
          } else {
            addCandidate(this);
          }

          for (const candidate of ownerCandidates) {
            try {
              const cur = candidate.Storages.Get(
                sessionId,
                storageKeyForRecovery
              );
              if (cur && (cur.filePath || cur.code)) {
                if (cur.filePath) recoveredPath = cur.filePath;
                if (cur.code) recoveredCode = cur.code;
                break;
              }
            } catch (_) { /* try next candidate */ }
          }
        } catch (_) { /* fall through to disk */ }

        // --- 2) Disk record ---
        //
        // Preferred key is `<owner>::<target>`, which is what both
        // _embFinishAndReturn and this.Emb() write. A small ordered
        // list of additional keys is tried as a safety net, so a
        // widget can still recover its produced func even when the
        // owner name was lost across a restart. The first key that
        // yields an entry with an actual source (filePath or code)
        // wins — boot-only records are ignored.
        if (!recoveredPath && !recoveredCode && outerFilePath) {
          const diskKeys = [
            `${this._embReturnTo || '__unknown__'}::${this._embTarget}`,
            `__selfbuilder__::${this._embTarget}`,
            String(this._embTarget || '')
          ];
          const seenKeys = new Set();
          for (const k of diskKeys) {
            if (!k || seenKeys.has(k)) continue;
            seenKeys.add(k);
            try {
              const disk = _embDiskLoad(outerFilePath, k);
              if (disk && (disk.filePath || disk.code)) {
                if (disk.filePath) recoveredPath = disk.filePath;
                if (disk.code) recoveredCode = disk.code;
                break;
              }
            } catch (_) {}
          }
        }

        // --- Parse the recovered source back into a builder state ---
        if (recoveredPath && fs.existsSync(recoveredPath)) {
          try {
            const src = fs.readFileSync(recoveredPath, 'utf8');
            recoveredState = _sbParseFuncJS(src, recoveredPath);
          } catch (_) { /* fall through to inline code */ }
        }
        if (!recoveredState && recoveredCode &&
            typeof recoveredCode === 'string') {
          try {
            recoveredState = _sbParseFuncJS(
              recoveredCode,
              `emb_${this._embTarget}.js`
            );
          } catch (_) { /* give up silently — blank canvas below */ }
        }
      } catch (_) { /* never let recovery break EMB entry */ }

      if (recoveredState &&
          (recoveredState.items.length > 0 || recoveredState.name)) {
        // Existing produced func found — load it into the canvas so the
        // user continues editing exactly where they left off.
        this.State = {
          ...recoveredState,
          name: recoveredState.name || `emb_${this._embReturnTo || 'unknown'}_${this._embTarget}`,
          funcName: recoveredState.funcName || 'EmbeddedFunc',
          code: recoveredState.code || '',
          items: Array.isArray(recoveredState.items) ? recoveredState.items : [],
          hiddenMethods: Array.isArray(recoveredState.hiddenMethods)
            ? recoveredState.hiddenMethods
            : [],
          pinnedTopSeparator: recoveredState.pinnedTopSeparator || 'line',
          pinnedBottomSeparator: recoveredState.pinnedBottomSeparator || 'line'
        };
      } else {
        // No existing source — start with a fresh, blank canvas.
        //
        // The app name embeds the OWNER func's runtime Name so two
        // nested Emb flows never produce funcs with the SAME runtime
        // Name. Otherwise they collide inside SyAPP.Funcs and the
        // ▶ Enter Func button silently re-enters the WRONG embedded
        // func — the "directs to the same emb func" symptom at every
        // subsequent nesting level.
        this.State = {
          name: `emb_${this._embReturnTo || 'unknown'}_${this._embTarget}`,
          funcName: 'EmbeddedFunc',
          code: '',
          items: [],
          hiddenMethods: [],
          pinnedTopSeparator: 'line',
          pinnedBottomSeparator: 'line'
        };
      }

      this.EditItemId = null;
      this.Editing = true;

      // Clear ALL of the EMB-entry markers so they only trigger once.
      // The return-info props are consumed here (they were already
      // copied onto `this._embReturnTo` / `this._embReturnProps`
      // above), so a subsequent SelfBuilder render does not re-enter
      // EMB mode or leave stale state behind.
      delete curProps.__embNewSession;
      delete curProps.__embReturnTo;
      delete curProps.__embReturnProps;
      delete curProps.__embSourceFile;
    }

    this._processActions(id, props)
    if (this.Builds.get(id)?.WaitInput) return

    // Capture the LIVE State reference AFTER every possible mutation
    // above. Both the EMB-mode recovery block and `_processActions`'
    // 'load' case can reassign `this.State`. Reading it earlier left
    // `S` pointing at the PRE-recovery (blank) object, so the
    // renderer's `S.items.length === 0` check always fired and the
    // recovered items were silently ignored — the exact
    // "blank Func after restart" symptom.
    const S = this.State

    const W = _termCols()
    const container = this._resolveContainer(curPage)

    // -------- pinned top: header + toolbar --------
    // Only ONE separator is emitted here (between header and toolbar).
    // The separator between the toolbar and whatever menu is currently
    // open is rendered by _renderTopToolbar() / the container branch as
    // a pinned-top BUTTON, because _hr() text always lands at the very
    // top of the pinned-top area (before the toolbar buttons) and would
    // therefore never visually sit between the toolbar and the options.
    this.Text(id, this._headerLine(S, curPage, container, id), { pinnedTop: true })
    this.Text(id, _hr('─'), { pinnedTop: true })

    if (container.kind === 'root') {
      this._renderTopToolbar(id, S, container)
    } else {
      // Breadcrumb when inside a nested container + a container-scoped
      // "+New" so that new items land INSIDE the current container.
      const newOpen = this.Storages.Get(id, 'sb_new_open') || false
      const label = container.kind === 'page'
        ? `📄 ${_fit(container.item.name, 30)}`
        : container.kind === 'dropdown'
          ? `▼ ${_fit(container.item.name, 30)}`
          : container.kind === 'codeblock'
            ? `{} ${_fit(this._codeblockLabel(container.item), 30)}`
            : container.kind === 'args'
              ? `⚡ Args (args: [ ... ])`
              : container.kind === 'buttonsGroup'
                ? `⧾ Buttons Group`
                : container.kind === 'pinnedTop'
                  ? `📌 Pinned Top`
                  : container.kind === 'pinnedBottom'
                    ? `📌 Pinned Bottom`
                    : container.kind === 'gridCell'
                      ? `▦ ${_fit(container.item.name || 'grid', 20)} cell ${container.cellIdx + 1}`
                      : ColorText.red(`(missing: ${_fit(curPage, 30)})`)

      const navRow = [
        { name: '← Root', props: { page: '' }, pinnedTop: true },
        { name: label, pinnedTop: true },
        { name: newOpen ? ColorText.bold('− New') : ColorText.bold('＋ New'),
          props: { __toggleNew: 1 }, pinnedTop: true }
      ]

      if (container.kind === 'gridCell') {
        const gridCells = Array.isArray(container.item.cells) ? container.item.cells : []
        const totalCells = gridCells.length || 1
        const cIdx = container.cellIdx
        navRow.push({
          name: cIdx > 0 ? '◀ Cell' : ColorText.dim('◀ Cell'),
          props: cIdx > 0 ? { page: `__sbgc__:${container.item.id}:${cIdx - 1}` } : {},
          pinnedTop: true
        })
        navRow.push({
          name: ColorText.dim(`${cIdx + 1}/${totalCells}`),
          props: {},
          pinnedTop: true
        })
        navRow.push({
          name: cIdx < totalCells - 1 ? 'Cell ▶' : ColorText.dim('Cell ▶'),
          props: cIdx < totalCells - 1 ? { page: `__sbgc__:${container.item.id}:${cIdx + 1}` } : {},
          pinnedTop: true
        })
        navRow.push({
          name: '＋ Cell',
          props: { __gridAddCell: `${container.item.id}:${cIdx}` },
          pinnedTop: true
        })
        navRow.push({
          name: ColorText.red('− Cell'),
          props: totalCells > 1 ? { __gridDelCell: `${container.item.id}:${cIdx}` } : {},
          pinnedTop: true
        })
      }
      this.Buttons(id, navRow)
      if (newOpen) {
        // Break the toolbar options group + draw a separator line between
        // the toolbar and the opened "+New" menu, so the two never merge
        // onto the same visual row.
        this.Button(id, { name: _hr('─'), pinnedTop: true })
        this._renderNewMethodsMenu(id, container)
      }
    }

    // -------- body (scrollable) --------
    if (container.kind === 'root' && S.items.length === 0) {
      this.Text(id, '')
      this.Text(id, ColorText.dim('  Empty app. Use the "+ New" menu above to add items.'))
      this.Text(id, ColorText.dim('  Ctrl+C saves & exits.'))
    } else if (container.kind === 'missing') {
      this.Text(id, ColorText.red(`Container "${curPage}" not found.`))
    } else if (!container.items || container.items.length === 0) {
      this.Text(id, ColorText.dim('  (empty — use the "+ New" menu to add items)'))
    } else {
      await this._renderItems(id, container.items, props)
    }

    // -------- pinned bottom: editor (when an item is selected) or status bar --------
    this.Text(id, _hr('─'), { pinned: true })

    const editingItem = this.EditItemId ? this._findItem(this.EditItemId) : null
    if (editingItem) {
      this._renderPinnedEditor(id, editingItem)
    } else {
      this.Text(id, this._statusLine(S), { pinned: true })
    }
  }

  _headerLine(S, curPage, container, id) {
    const W = _termCols()
    const mode = this.Editing ? ColorText.bgGreen(ColorText.black(' EDIT ')) : ColorText.bgBlue(ColorText.white(' VIEW '))
    const title = ColorText.bold(ColorText.brightCyan(_fit(S.name, Math.max(8, W - 30))))
    const cls = ColorText.dim(`[${_fit(S.funcName, 20)}]`)

    // Determine the label that follows the "|" separator. The header now
    // reflects which menu is currently open in the toolbar — "+New",
    // "Config", or (when inside a nested container) a breadcrumb.
    let ctx = ''
    const newOpen = id ? (this.Storages.Get(id, 'sb_new_open') || false) : false
    const methodsOpen = id ? (this.Storages.Get(id, 'sb_methods_open') || false) : false

    if (newOpen) {
      ctx = ` | ${ColorText.dim('New: choose one option to add...')}`
    } else if (methodsOpen) {
      ctx = ` | ${ColorText.dim('Config: adjust builder settings')}`
    } else if (container && container.kind !== 'root') {
      let lbl
      if (container.kind === 'page')            lbl = `📄 ${container.item.name}`
      else if (container.kind === 'dropdown')   lbl = `▼ ${container.item.name}`
      else if (container.kind === 'codeblock')  lbl = `{} ${this._codeblockLabel(container.item)}`
      else if (container.kind === 'args')       lbl = `⚡ Args (args: [ ... ])`
      else if (container.kind === 'buttonsGroup') lbl = `⧾ Buttons Group`
      else if (container.kind === 'pinnedTop')  lbl = `📌 Pinned Top`
      else if (container.kind === 'pinnedBottom') lbl = `📌 Pinned Bottom`
      else if (container.kind === 'gridCell')   lbl = `▦ ${container.item.name || 'grid'} cell ${container.cellIdx + 1}`
      else                                       lbl = `? ${curPage}`
      ctx = ColorText.dim(` | ${_fit(lbl, 40)}`)
    }
    return `  ${mode}  ${title}  ${cls}${ctx}`
  }

  _statusLine(S) {
    const W = _termCols()
    const left = ColorText.dim(` items: ${S.items.length}`)
    const mid = ColorText.dim(' │ ')
    const right = ColorText.dim('Ctrl+C save+exit')
    const body = left + mid + right
    return ' ' + _fit(body, W - 2)
  }

  _renderTopToolbar(id, S, container) {
    const newOpen = this.Storages.Get(id, 'sb_new_open') || false
    const methodsOpen = this.Storages.Get(id, 'sb_methods_open') || false

    // ------------------------------------------------------------------
    // EMB MODE toolbar
    //
    // When this SelfBuilder was launched from this.Emb()'s Self Build
    // button, the toolbar is trimmed to the essentials and gets a
    // dedicated "✓ Finish & Return" action. That button writes the
    // produced source back into the caller Emb instance and navigates
    // back to the caller screen.
    //
    // All the app-management actions (Save/Load/Export/Exit, plus the
    // app/class name editors) are omitted in EMB mode: those would
    // overwrite the app's own saves and are simply not relevant for a
    // one-shot embedded func builder.
    // ------------------------------------------------------------------
    if (this._embMode) {
      this.Buttons(id, [
        { name: newOpen ? ColorText.bold('− New') : ColorText.bold('＋ New'),
          props: { __toggleNew: 1 }, pinnedTop: true },
        { name: this.Editing ? '👁 View' : '✎ Edit',
          props: { __toggleEdit: 1 }, pinnedTop: true },
        { name: ColorText.bgGreen(ColorText.black(' ✓ Finish & Return ')),
          props: { __embFinish: 1 }, pinnedTop: true },
        { name: methodsOpen ? ColorText.bold('⚙ Config ✓') : '⚙ Config',
          props: { __toggleMethods: 1 }, pinnedTop: true },
        { name: `◆ ${_fit(S.funcName, 22)}`,
          props: { __setFuncName: 1 }, pinnedTop: true }
      ])
    } else {
      // Regular toolbar (unchanged)
      this.Buttons(id, [
        { name: newOpen ? ColorText.bold('− New') : ColorText.bold('＋ New'),
          props: { __toggleNew: 1 }, pinnedTop: true },
        { name: this.Editing ? '👁 View' : '✎ Edit',
          props: { __toggleEdit: 1 }, pinnedTop: true },
        { name: '💾 Save', props: { __save: 1 }, pinnedTop: true },
        { name: '📂 Load', props: { __load: 1 }, pinnedTop: true },
        { name: '📤 Export', props: { __export: 1 }, pinnedTop: true },
        { name: methodsOpen ? ColorText.bold('⚙ Config ✓') : '⚙ Config',
          props: { __toggleMethods: 1 }, pinnedTop: true },
        { name: '🚪 Exit', props: { __exit: 1 }, pinnedTop: true },
        { name: `🏷 ${_fit(S.name, 18)}`, props: { __setAppName: 1 }, pinnedTop: true },
        { name: `◆ ${_fit(S.funcName, 18)}`, props: { __setFuncName: 1 }, pinnedTop: true }
      ])
    }

    // When either menu is open, break the toolbar's options group and
    // draw a separator line BEFORE the menu content. Pushing a plain
    // this.Button() (without the `buttons: true` flag) does two things:
    //   1. it terminates the toolbar's options group, so the config /
    //      "+New" content that follows starts on its own line — never
    //      merged into the toolbar row itself (which is exactly what
    //      made "Items per page" appear to live inside the main tab);
    //   2. it renders a long dim line that visually separates the
    //      toolbar from whatever was opened below it.
    if (newOpen || methodsOpen) {
      this.Button(id, { name: _hr('─'), pinnedTop: true })
    }

    // "+New" and "⚙ Config" content. Each one now lives BELOW the
    // separator button pushed above, so opening them no longer makes
    // their controls appear to live inside the main toolbar tab.
    if (newOpen)     this._renderNewMethodsMenu(id, container)
    if (methodsOpen) this._renderConfigMenu(id)
  }

  /**
   * Render the "+New" menu as ONE paginated options list. The two filter
   * buttons (SyAPP ↔ Javascript) sit on their OWN row BELOW the options
   * list, so they never mix with the primary option buttons.
   *
   *   • "SyAPP"       → discovered SyAPP_Func methods
   *   • "Javascript"  → JS chains / custom-code logic-block templates
   *
   * The number of items per page is driven by the shared config value
   * (default 4, configurable via ⚙ Config → Items per page).
   * No section headers are printed — only the toolbar separators that
   * already surround the pinned-top area.
   */
  _renderNewMethodsMenu(id, container) {
    const perPage = this._getItemsPerPage()
    const insideButtonsGroup = container && container.kind === 'buttonsGroup'
    // Inside a buttonsGroup, only the "Javascript" view would produce
    // items that get filtered out at render time — so we pin the filter
    // to "SyAPP" and hide the filter selector row.
    const filter = insideButtonsGroup
      ? 'syapp'
      : (this.Storages.Get(id, 'sb_new_filter') || 'syapp')

    let entries
    if (filter === 'js') {
      entries = _SB_LOGIC_BLOCKS.map(m => ({ kind: 'js', value: m }))
    } else if (insideButtonsGroup) {
      // Only button-producing methods make sense as children of a
      // Buttons group. Everything else would be filtered at render time.
      const allowed = ['Button', 'SideButton', 'AlertButton']
      entries = this._getVisibleNewMethods()
        .filter(m => allowed.includes(m))
        .map(m => ({ kind: 'syapp', value: m }))
    } else {
      entries = this._getVisibleNewMethods().map(m => ({ kind: 'syapp', value: m }))
    }

    const totalPages = Math.max(1, Math.ceil(entries.length / perPage))
    const st = this.Storages.Get(id, 'sb_new_page') || { page: 1 }
    const cur = Math.min(Math.max(1, st.page || 1), totalPages)
    const start = (cur - 1) * perPage
    const end = Math.min(start + perPage, entries.length)
    const shown = entries.slice(start, end)

    // ---------------- Options list ----------------
    if (shown.length === 0) {
      this.Text(id, ColorText.dim('  (empty — enable methods in ⚙ Config)'), { pinnedTop: true })
    } else {
      for (const entry of shown) {
        const name = entry.kind === 'js'
          ? `⌘ ${entry.value}`
          : `➕ ${entry.value}`
        this.Button(id, {
          name,
          props: { __add: entry.value },
          pinnedTop: true
        })
      }
    }

    // ---------------- Pagination row (below options) ----------------
    if (totalPages > 1) {
      this.Buttons(id, [
        { name: cur > 1 ? '◀' : ColorText.dim('◀'),
          props: cur > 1 ? { __newPagePrev: 1 } : {},
          pinnedTop: true },
        { name: ColorText.dim(`${cur}/${totalPages}`),
          props: {},
          pinnedTop: true },
        { name: cur < totalPages ? '▶' : ColorText.dim('▶'),
          props: cur < totalPages ? { __newPageNext: 1 } : {},
          pinnedTop: true }
      ])
    }

    // ---------------- Filter row (below pagination) ----------------
    // Hidden when inside a Buttons group, since the group only accepts
    // button-producing methods and the JS filter has no meaning there.
    if (!insideButtonsGroup) {
      this.Buttons(id, [
        {
          name: filter === 'syapp' ? ColorText.bold('SyAPP') : ColorText.dim('SyAPP'),
          props: { __setNewFilter: 'syapp' },
          pinnedTop: true
        },
        { name: ColorText.dim('|'), props: {}, pinnedTop: true },
        {
          name: filter === 'js' ? ColorText.bold('Javascript') : ColorText.dim('Javascript'),
          props: { __setNewFilter: 'js' },
          pinnedTop: true
        }
      ])
    }
  }

  /**
   * Render the unified ⚙ Config menu.
   *
   * This single view absorbs every builder setting that used to be
   * scattered across dedicated menus:
   *
   *   • Items per page (default 4) — drives BOTH the "+New" list and
   *     the method toggle list below.
   *   • The full method visibility blacklist (formerly "⚙ Methods").
   *   • The "Reset hidden" shortcut.
   *
   * No section headers are printed — only the separator lines that
   * already surround the pinned-top toolbar.
   */
  _renderConfigMenu(id) {
    const perPage = this._getItemsPerPage()
    const all = _sbDiscoverMethods()
    const hiddenSet = this._getHiddenSet()

    // Each config entry gets its OWN line, matching the layout of the
    // method-visibility list below. This guarantees "Items per page"
    // never sits on the toolbar row and always appears "below like the
    // selection" of the method list.
    this.Button(id, {
      name: `Items per page: ${perPage}`,
      props: { __editConfig: 'itemsPerPage' },
      pinnedTop: true
    })
    this.Button(id, {
      name: 'Reset hidden',
      props: { __resetHidden: 1 },
      pinnedTop: true
    })

    // Global default separator styles for the pinned areas. Clicking
    // cycles each area independently through:
    //     line → none → discrete → line
    // Default is 'line', so untouched projects look identical.
    const gTop = this.State.pinnedTopSeparator || 'line'
    const gBot = this.State.pinnedBottomSeparator || 'line'
    const gIcon = (v) => v === 'none' ? '▫' : v === 'discrete' ? '·' : '─'
    const gTag  = (v) => v === 'none' ? 'none (smooth)'
                       : v === 'discrete' ? 'discrete (· · ·)'
                       : 'line (default)'

    this.Button(id, {
      name: `📌 Top separator: ${gIcon(gTop)} ${gTag(gTop)}   (click to cycle)`,
      props: { __cycleSeparator: 'top' },
      pinnedTop: true
    })
    this.Button(id, {
      name: `📌 Bottom separator: ${gIcon(gBot)} ${gTag(gBot)}   (click to cycle)`,
      props: { __cycleSeparator: 'bottom' },
      pinnedTop: true
    })

    // Method visibility list — paginated with the SAME per-page value.
    const totalPages = Math.max(1, Math.ceil(all.length / perPage))
    const st = this.Storages.Get(id, 'sb_methods_page') || { page: 1 }
    const cur = Math.min(Math.max(1, st.page || 1), totalPages)
    const start = (cur - 1) * perPage
    const end = Math.min(start + perPage, all.length)
    const shown = all.slice(start, end)

    for (const m of shown) {
      const hidden = hiddenSet.has(m)
      const isDefaultHidden = _SB_DEFAULT_NEW_BLACKLIST.includes(m)
      const mark = hidden ? ColorText.red('✗') : ColorText.green('✓')
      const tag = isDefaultHidden ? ColorText.dim(' [off]') : ''
      this.Button(id, {
        name: `${mark} ${m}${tag}`,
        props: { __toggleMethodHidden: m },
        pinnedTop: true
      })
    }

    if (totalPages > 1) {
      this.Buttons(id, [
        { name: cur > 1 ? '◀' : ColorText.dim('◀'),
          props: cur > 1 ? { __methodsPagePrev: 1 } : {},
          pinnedTop: true },
        { name: ColorText.dim(`${cur}/${totalPages}`),
          props: {},
          pinnedTop: true },
        { name: cur < totalPages ? '▶' : ColorText.dim('▶'),
          props: cur < totalPages ? { __methodsPageNext: 1 } : {},
          pinnedTop: true }
      ])
    }
  }

  async _renderItems(id, items, props) {
    for (const it of items) await this._renderItem(id, it, props)
  }

  async _renderItem(id, it, props) {
    // In edit mode, prefix each item with a compact selector dot.
    // The dot's colour encodes whether the item is a navigable preview
    // (green) or a non-navigable body item (dim yellow), so routes, text,
    // alerts, etc. stand visually apart from the clickable body.
    if (this.Editing) {
      const isActive = this.EditItemId === it.id
      const navigable = (it.type === 'button' || it.type === 'dropdown' ||
                         it.type === 'page' || it.type === 'codeblock' ||
                         it.type === 'args' || it.type === 'buttonsGroup' ||
                         it.type === 'pinnedTop' || it.type === 'pinnedBottom')
      const dot = isActive
        ? ColorText.brightYellow('◉')
        : navigable ? ColorText.green('○') : ColorText.dim('○')
      this.Button(id, {
        name: dot,
        props: { __editItem: isActive ? '' : it.id }
      })
    }

    try {
      switch (it.type) {
        case 'text':
          this.Text(id, it.value || '')
          break
        case 'spacer':
          this.Text(id, '')
          break
        case 'button': {
          // IMPORTANT: pass a *copy* of the props. If we pass the live
          // `it.props` object, SyAPP's LoadScreen will attach `.session`
          // (and `.mainfunc`) onto it, which in turn nests the Session
          // into State.items → circular reference → save fails.
          //
          // Dispatch: items created via the "SideButton" entry in the
          // "+ New" menu (sourceMethod === 'SideButton') are rendered
          // through this.SideButton(), so consecutive SideButton items
          // automatically merge into ONE horizontal row in VIEW mode.
          // Regular Button items keep using this.Button().
          const cfg = {
            name: it.name || '',
            props: { ...(it.props || {}) },
            path: it.path,
            resetSelection: it.resetSelection,
            jumpTo: it.jumpTo,
            pinned: it.pinned,
            pinnedTop: it.pinnedTop
          }
          if (it.sourceMethod === 'SideButton' || it.buttons) {
            this.SideButton(id, cfg)
          } else {
            this.Button(id, cfg)
          }
          break
        }
        case 'buttonsGroup': {
          // Container-of-buttons: renders all its button children as
          // ONE horizontal row via this.Buttons([...]).
          if (this.Editing) {
            const hasItems = Array.isArray(it.items) && it.items.length > 0
            const buttonCount = hasItems
              ? it.items.filter(c => c && c.type === 'button').length
              : 0
            this.Button(id, {
              name: `${ColorText.brightCyan('⧾')} Buttons Group${buttonCount ? ColorText.dim(` (${buttonCount})`) : ''}`,
              props: { page: `__sbbg__:${it.id}` }
            })
          } else {
            const configs = (it.items || [])
              .filter(c => c && c.type === 'button')
              .map(c => ({
                name: c.name || '',
                props: { ...(c.props || {}) },
                path: c.path,
                resetSelection: c.resetSelection,
                jumpTo: c.jumpTo,
                pinned: c.pinned,
                pinnedTop: c.pinnedTop
              }))
            if (configs.length > 0) this.Buttons(id, configs)
          }
          break
        }
        case 'field':
          this.Field(id, it.name, {
            label: it.label || '',
            initialValue: it.initialValue || '',
            pinned: it.pinned,
            pinnedTop: it.pinnedTop
          })
          break
        case 'texteditor':
          await this.TextEditor(id, it.name, {
            label: it.label,
            initialValue: it.initialValue,
            buttonText: it.buttonText,
            pinned: it.pinned,
            pinnedTop: it.pinnedTop
          })
          break
        case 'textbutton':
          // Renders the real TextButton in both edit and view modes so
          // the built-in focus/activate/locked-scroll/E-to-edit flow
          // works exactly like a hand-written this.TextButton() call.
          this.TextButton(id, it.name, {
            label: it.label,
            initialValue: it.initialValue,
            lines: it.lines || 4,
            editable: !!it.editable,
            pinned: it.pinned,
            pinnedTop: it.pinnedTop
          })
          break
        case 'page':
          if (this.Editing) {
            const hasItems = Array.isArray(it.items) && it.items.length > 0
            const pinTag = it.pinButton
              ? ColorText.dim(` [📌 ${it.pinPosition === 'top' ? 'top' : 'bottom'}]`)
              : ''
            this.Button(id, {
              name: `📄 ${it.name}${hasItems ? ColorText.dim(` (${it.items.length})`) : ''}${pinTag}`,
              props: { page: it.name }
            })
          } else {
            await this.Page(id, it.name, async () => {
              await this._renderItems(id, it.items || [], props)
            }, {
              pinButton: !!it.pinButton,
              pinPosition: it.pinPosition === 'top' ? 'top' : 'bottom'
            })
          }
          break
        case 'dropdown':
          // In edit mode the dropdown behaves like a page: clicking
          // navigates INTO it, so its nested items can be edited
          // recursively — the same way this.Page() works.
          if (this.Editing) {
            const hasItems = Array.isArray(it.items) && it.items.length > 0
            this.Button(id, {
              name: `${ColorText.brightCyan('▼')} ${it.name || '(dropdown)'}${hasItems ? ColorText.dim(` (${it.items.length})`) : ''}`,
              props: { page: `__sbdd__:${it.id}` }
            })
          } else {
            await this.DropDown(id, it.name, async () => {
              await this._renderItems(id, it.items || [], props)
            }, {
              up_buttontext: it.up_buttontext || 'Show more',
              down_buttontext: it.down_buttontext || 'Hide'
            })
          }
          break
        case 'codeblock':
          // Logic-block containers (if/for/for-of/for-await/while/custom)
          // behave like pages in edit mode: click to step inside.
          if (this.Editing) {
            const hasItems = Array.isArray(it.items) && it.items.length > 0
            this.Button(id, {
              name: `${ColorText.brightMagenta('{}')} ${this._codeblockLabel(it)}${hasItems ? ColorText.dim(` (${it.items.length})`) : ''}`,
              props: { page: `__sbcb__:${it.id}` }
            })
          } else {
            await this._renderCodeblock(id, it, props)
          }
          break
        case 'pinnedTop':
          if (this.Editing) {
            const hasItems = Array.isArray(it.items) && it.items.length > 0
            this.Button(id, {
              name: `${ColorText.brightBlue('📌')} Pinned Top${hasItems ? ColorText.dim(` (${it.items.length})`) : ''}`,
              props: { page: `__sbpt__:${it.id}` }
            })
          } else {
            // Per-item separator overrides the global default when set.
            const sep = it.separator || this.State.pinnedTopSeparator || 'line'
            await this.PinnedTop(id, async () => {
              await this._renderItems(id, it.items || [], props)
            }, { separator: sep })
          }
          break
        case 'pinnedBottom':
          if (this.Editing) {
            const hasItems = Array.isArray(it.items) && it.items.length > 0
            this.Button(id, {
              name: `${ColorText.brightBlue('📌')} Pinned Bottom${hasItems ? ColorText.dim(` (${it.items.length})`) : ''}`,
              props: { page: `__sbpb__:${it.id}` }
            })
          } else {
            const sep = it.separator || this.State.pinnedBottomSeparator || 'line'
            await this.PinnedBottom(id, async () => {
              await this._renderItems(id, it.items || [], props)
            }, { separator: sep })
          }
          break
        case 'waitinput':
          this.Button(id, { name: `⏳ WaitInput: ${it.question || ''}`, props: {} })
          break
        case 'alert':
          this.Text(id, ColorText.brightYellow(`⚠ ${it.text || ''}`))
          break
        case 'gotonow':
          this.Button(id, { name: `→ GotoNow: ${it.path || '?'}`, props: {} })
          break
        case 'setpage':
          this.Button(id, { name: `📄 SetPage: ${it.page || '?'}`, props: {} })
          break
        case 'file':
          this.Button(id, { name: `📁 File`, props: {} })
          break
        case 'json':
          this.Button(id, { name: `🔍 JSON`, props: {} })
          break
        case 'cells':
          // Render the real Cells launcher in view mode so the editor
          // behaves identically to a hand-written this.Cells(...) call.
          await this.Cells(id, it.name, {
            label: it.label,
            rows: it.rows || 100,
            cols: it.cols || 26,
            pinned: it.pinned,
            pinnedTop: it.pinnedTop
          })
          break
        case 'grid': {
          if (this.Editing) {
            const cellCount = Array.isArray(it.cells) ? it.cells.length : 0
            this.Button(id, {
              name: `${ColorText.brightMagenta('▦')} Grid (${cellCount} cell${cellCount === 1 ? '' : 's'})`,
              props: { page: `__sbgc__:${it.id}:0` }
            })
          } else {
            const cells = Array.isArray(it.cells) ? it.cells : []
            const cellBuilders = cells.map(cell => async () => {
              await this._renderItems(id, cell.items || [], props)
            })
            await this.Grid(id, it.name || 'grid', cellBuilders, {
              maxCellRatio: it.maxCellRatio,
              gap: it.gap
            })
          }
          break
        }
        case 'args':
          // Args container: behaves like a page in edit mode (click to
          // step inside and add/modify its children) and executes the
          // real this.Args(...) call in view mode, rendering every nested
          // child as the body of the args handler.
          if (this.Editing) {
            const hasItems = Array.isArray(it.items) && it.items.length > 0
            const schemaLen = Array.isArray(it.schema) ? it.schema.length : 0
            this.Button(id, {
              name: `${ColorText.brightGreen('⚡')} Args (args)${schemaLen ? ColorText.dim(` [${schemaLen} schema]`) : ''}${hasItems ? ColorText.dim(` (${it.items.length})`) : ''}`,
              props: { page: `__sba__:${it.id}` }
            })
          } else {
            await this.Args(id, async (args) => {
              await this._renderItems(id, it.items || [], props)
            }, {
              required: it.schema || [],
              everyTime: !!it.everyTime,
              form: it.form !== false,
              description: it.description || undefined,
              key: it.key || it.id
            })
          }
          break
        case 'javascript':
          // The widget drives itself purely through props on
          // ActualProps (same model as this.File / this.JSON), so its
          // internal buttons keep working in EDIT and VIEW modes alike.
          // In EDIT mode, the ○/◉ dot prefix still opens the pinned
          // editor for tweaking `codeOrPath` and the config.
          await this.JavaScript(id, it.codeOrPath || '', it.config || {})
          break
        case 'emb': {
          // Render the real this.Emb() call. In VIEW mode, the embedded
          // func runs inline. In EDIT mode, the ○/◉ dot prefix still
          // opens the pinned editor where `filePath`, `code`, `saveMode`
          // and `dropdown` can be tweaked.
          const cfg = { name: it.name }
          if (it.filePath) cfg.filePath = it.filePath
          if (it.code) cfg.code = it.code
          if (it.dropdown && Object.keys(it.dropdown).length) cfg.dropdown = it.dropdown
          await this.Emb(id, cfg)
          break
        }
        case 'route':
          this.Text(id, ColorText.magenta(`[ROUTE ${it.method || 'GET'} ${it.path || '/'}]`))
          break
        case 'code':
          try {
            const fn = new AsyncFunction('id', 'props', it.value || '')
            await fn.call(this, id, props)
          } catch (e) {
            this.Text(id, ColorText.red(`[code error] ${e.message}`))
          }
          break
        default:
          this.Text(id, ColorText.dim(`[unknown item type: ${it.type}]`))
      }
    } catch (e) {
      this.Text(id, ColorText.red(`[render error] ${e.message}`))
    }
  }

  _codeblockLabel(it) {
    switch (it.blockType) {
      case 'if':       return `if (${it.condition || '...'})`
      case 'elseif':   return `else if (${it.condition || '...'})`
      case 'else':     return 'else'
      case 'for':      return `for (${it.condition || '...'})`
      case 'forof':    return `for (${it.condition || '...'})`
      case 'forawait': return `for await (${it.condition || '...'})`
      case 'while':    return `while (${it.condition || '...'})`
      case 'custom':   return 'custom JS'
      default:         return it.label || 'code'
    }
  }

  /**
   * Evaluate a code-block's condition for REAL in VIEW mode. Returns true
   * when the block's body should be rendered.
   *
   *   - if / else if / while      → condition must be truthy
   *   - else                      → always true (rendered after the
   *                                 preceding if/else-if in the same
   *                                 sibling group; the builder does not
   *                                 try to detect chain grouping, so an
   *                                 `else` will always render — the user
   *                                 is responsible for chaining blocks
   *                                 correctly, matching real JS)
   *   - for / for of / for await  → the body is rendered once for the
   *                                 preview, provided the iterable yields
   *                                 at least one item (or, for classic
   *                                 `for`, the initial condition passes).
   *                                 We can't actually iterate in preview
   *                                 because the body contains builder
   *                                 calls (not pure JS), so we use a
   *                                 light-weight "would it enter?" probe.
   *   - custom                    → always true (raw JS does not gate
   *                                 the body; use an `if` inside it)
   *
   * Any ReferenceError raised by the condition (e.g. an undefined
   * variable) is surfaced as a warning and the body is hidden, which is
   * exactly the behaviour the user asked for: "if I put variables that
   * do not exist, it shows the warning".
   */
  async _evaluateCodeblockCondition(id, it, props) {
    const bt = it.blockType
    const cond = it.condition || ''

    // Non-gating blocks
    if (bt === 'else' || bt === 'custom') return { enter: true }

    // Classic for-loop: we don't know how many iterations the user wants
    // for the preview, so we just evaluate the guard once with i = 0 to
    // decide whether the body renders at least once.
    if (bt === 'for') {
      // The stored condition is the FULL header `let i=0; i<n; i++`.
      // Reuse AsyncFunction's function-body semantics: we can't simply
      // `return (header)`, so we wrap it in a minimal for-loop that
      // executes zero body iterations but does evaluate the guard.
      try {
        const fn = new AsyncFunction('id', 'props', `
          let __entered = false;
          for (${cond}) { __entered = true; break; }
          return __entered;
        `)
        const enter = await fn.call(this, id, props)
        return { enter: !!enter }
      } catch (e) {
        return { enter: false, error: e }
      }
    }

    // for of / for await: probe the iterable to know if there is at
    // least one element. The stored condition is `const x of EXPR` or
    // `const x of await EXPR`.
    if (bt === 'forof' || bt === 'forawait') {
      const m = cond.match(/^\s*(?:const|let|var)\s+[\w$]+\s+of\s+([\s\S]+)$/)
      if (!m) return { enter: true } // can't parse → don't block preview
      const iterableExpr = m[1].trim()
      try {
        const fn = new AsyncFunction('id', 'props', `
          const __it = (${iterableExpr});
          if (__it == null) return false;
          if (typeof __it[Symbol.asyncIterator] === 'function' || typeof __it[Symbol.iterator] === 'function') {
            const __first = await (__it[Symbol.asyncIterator]
              ? __it[Symbol.asyncIterator]().next()
              : __it[Symbol.iterator]().next());
            return !__first.done;
          }
          return false;
        `)
        const enter = await fn.call(this, id, props)
        return { enter: !!enter }
      } catch (e) {
        return { enter: false, error: e }
      }
    }

    // if / else if / while: plain boolean expression.
    try {
      const fn = new AsyncFunction('id', 'props', `return (${cond || 'false'})`)
      const enter = await fn.call(this, id, props)
      return { enter: !!enter }
    } catch (e) {
      return { enter: false, error: e }
    }
  }

  async _renderCodeblock(id, it, props) {
    // In non-edit mode the code-block gates its nested items by
    // evaluating the condition for real. This is what makes an `if`
    // with a false condition HIDE the button placed inside it, instead
    // of rendering it unconditionally.
    const verdict = await this._evaluateCodeblockCondition(id, it, props)

    if (verdict.error) {
      this.Text(id, ColorText.red(`[code warning] ${this._codeblockLabel(it)} → ${verdict.error.message}`))
    }

    if (!verdict.enter) return

    if (it.customBefore) {
      try {
        const fn = new AsyncFunction('id', 'props', it.customBefore)
        await fn.call(this, id, props)
      } catch (e) {
        this.Text(id, ColorText.red(`[code error] ${e.message}`))
      }
    }

    await this._renderItems(id, it.items || [], props)

    if (it.customAfter) {
      try {
        const fn = new AsyncFunction('id', 'props', it.customAfter)
        await fn.call(this, id, props)
      } catch (e) {
        this.Text(id, ColorText.red(`[code error] ${e.message}`))
      }
    }
  }

  _renderPinnedEditor(id, it) {
    // Title line (compact, pinned to bottom)
    this.Text(id, ' ' + ColorText.brightYellow(`▸ Editing [${it.type}]`) +
                     ColorText.dim(` (${it.id.slice(-6)})`), { pinned: true })

    // ---- Editable properties --------------------------------------------
    // Every property is now editable: strings via WaitInput, numbers via
    // WaitInput with numeric coercion, objects/arrays via JSON WaitInput,
    // booleans via one-click toggles.
    const propButtons = []

    const mkProp = (prop, label, kind = 'string') => {
      const raw = it[prop]
      let preview
      if (kind === 'json') {
        try { preview = JSON.stringify(raw == null ? {} : raw) } catch (_) { preview = '{}' }
      } else if (kind === 'bool') {
        preview = raw ? 'true' : 'false'
      } else {
        preview = String(raw == null ? '' : raw)
      }
      preview = _fit(preview, 28) || '(empty)'
      propButtons.push({
        name: `✎ ${label}: ${preview}`,
        props: { __editProp: `${it.id}::${prop}::${kind}` },
        pinned: true
      })
    }

    const mkToggle = (prop, label) => {
      const on = !!it[prop]
      propButtons.push({
        name: `${on ? ColorText.green('✓') : ColorText.dim('○')} ${label}`,
        props: { __toggleProp: `${it.id}::${prop}` },
        pinned: true
      })
    }

    switch (it.type) {
      case 'text':
        mkProp('value', 'Text', 'string')
        break

      case 'button':
        mkProp('name', 'Name', 'string')
        mkProp('path', 'Path', 'string')
        mkProp('props', 'Props', 'json')
        mkProp('jumpTo', 'JumpTo', 'number')
        mkToggle('resetSelection', 'Reset Sel')
        mkToggle('pinned', 'Pinned Btm')
        mkToggle('pinnedTop', 'Pinned Top')
        break

      case 'field':
        mkProp('name', 'Name', 'string')
        mkProp('label', 'Label', 'string')
        mkProp('initialValue', 'Initial', 'string')
        mkToggle('pinned', 'Pinned Btm')
        mkToggle('pinnedTop', 'Pinned Top')
        break

      case 'texteditor':
        mkProp('name', 'Name', 'string')
        mkProp('label', 'Label', 'string')
        mkProp('initialValue', 'Initial', 'string')
        mkProp('buttonText', 'Button Text', 'string')
        mkToggle('pinned', 'Pinned Btm')
        mkToggle('pinnedTop', 'Pinned Top')
        break

      case 'textbutton':
        mkProp('name', 'Name', 'string')
        mkProp('label', 'Label', 'string')
        mkProp('initialValue', 'Initial', 'string')
        mkProp('lines', 'Rows', 'number')
        mkToggle('editable', 'Editable')
        mkToggle('pinned', 'Pinned Btm')
        mkToggle('pinnedTop', 'Pinned Top')
        break

      case 'page':
        mkProp('name', 'Page Name', 'string')
        mkToggle('pinButton', 'Auto Nav Button')
        // Pin position cycle: bottom ↔ top.
        propButtons.push({
          name: `📌 Pin Position: ${(it.pinPosition === 'top') ? 'top' : 'bottom'}   (click to cycle)`,
          props: { __cyclePinPosition: it.id },
          pinned: true
        })
        break

      case 'dropdown':
        mkProp('name', 'Name', 'string')
        mkProp('up_buttontext', 'Up Button', 'string')
        mkProp('down_buttontext', 'Down Button', 'string')
        break

      case 'codeblock':
        mkProp('label', 'Label', 'string')
        mkProp('condition', 'Condition / Header', 'string')
        mkProp('customBefore', 'JS before body', 'string')
        mkProp('customAfter', 'JS after body', 'string')
        break

      // Pinned container editors get a dedicated "Separator" toggle so
      // the visible style of THAT pinned area can be cycled right from
      // its own editor panel (line → none → discrete → line).
      case 'pinnedTop': {
        const cur = it.separator || (this.State && this.State.pinnedTopSeparator) || 'line'
        const icon = cur === 'none' ? '▫' : cur === 'discrete' ? '·' : '─'
        const tag  = cur === 'none' ? 'none (smooth)'
                   : cur === 'discrete' ? 'discrete (· · ·)'
                   : 'line (default)'
        propButtons.push({
          name: `📌 Top Separator: ${icon} ${tag}   (click to cycle)`,
          props: { __cycleItemSeparator: `${it.id}::top` },
          pinned: true
        })
        break
      }

      case 'pinnedBottom': {
        const cur = it.separator || (this.State && this.State.pinnedBottomSeparator) || 'line'
        const icon = cur === 'none' ? '▫' : cur === 'discrete' ? '·' : '─'
        const tag  = cur === 'none' ? 'none (smooth)'
                   : cur === 'discrete' ? 'discrete (· · ·)'
                   : 'line (default)'
        propButtons.push({
          name: `📌 Bottom Separator: ${icon} ${tag}   (click to cycle)`,
          props: { __cycleItemSeparator: `${it.id}::bottom` },
          pinned: true
        })
        break
      }

      case 'waitinput':
        mkProp('path', 'Path', 'string')
        mkProp('question', 'Question', 'string')
        mkProp('props', 'Props', 'json')
        break

      case 'alert':
        mkProp('text', 'Text', 'string')
        mkProp('duration', 'Duration', 'number')
        break

      case 'gotonow':
        mkProp('path', 'Path', 'string')
        mkProp('props', 'Props', 'json')
        break

      case 'setpage':
        mkProp('page', 'Page', 'string')
        break

      case 'file':
        mkProp('config', 'Config', 'json')
        break

      case 'json':
        mkProp('config', 'Config', 'json')
        break

      case 'cells':
        mkProp('name', 'Name', 'string')
        mkProp('label', 'Label', 'string')
        mkProp('rows', 'Rows', 'number')
        mkProp('cols', 'Cols', 'number')
        mkToggle('pinned', 'Pinned Btm')
        mkToggle('pinnedTop', 'Pinned Top')
        break

      case 'args':
        mkProp('description', 'Description', 'string')
        mkProp('schema', 'Schema (JSON)', 'json')
        mkToggle('everyTime', 'Every Time')
        mkToggle('form', 'Form Fallback')
        break

      case 'javascript': {
        // `codeOrPath` = file path (".js/.mjs/.cjs"), inline source, or
        // empty (widget shows its picker + editor inside the dropdown).
        mkProp('codeOrPath', 'Code / Path', 'string')
        mkProp('config', 'Config (JSON)', 'json')

        const src = it.codeOrPath && !/\.(js|mjs|cjs)$/i.test(it.codeOrPath) ? it.codeOrPath : '';
        if (src) {
          const sh = _jsShape(src);
          propButtons.push({
            name: ColorText.dim(
              `   shape: ${sh.classes.length} class(es), ` +
              `${sh.functions.length} function(s), ` +
              `${sh.variables.length} variable(s)`
            ),
            props: {},
            pinned: true
          });
        }
        break
      }
      case 'emb':
        mkProp('name', 'Name', 'string')
        mkProp('filePath', 'File Path', 'string')
        mkProp('code', 'Inline Code', 'string')
        mkProp('saveMode', 'Save Mode (path|inline)', 'string')
        mkProp('dropdown', 'Dropdown Config', 'json')
        break
      case 'route':
        mkProp('path', 'Path', 'string')
        mkProp('handler', 'Handler', 'string')
        break

      case 'code':
        mkProp('value', 'Code', 'string')
        break

      case 'grid': {
        mkProp('name', 'Name', 'string')
        mkProp('maxCellRatio', 'Max Cell Ratio', 'number')
        mkProp('gap', 'Gap', 'number')
        const cellCount = Array.isArray(it.cells) ? it.cells.length : 0
        propButtons.push({
          name: ColorText.brightMagenta(`▦ Open cells (${cellCount})`),
          props: { page: `__sbgc__:${it.id}:0` },
          pinned: true
        })
        break
      }
    }

    if (propButtons.length > 0) this.Buttons(id, propButtons)

    // ------------------------------------------------------------------
    // Force a NEW physical row for the action buttons (× Delete / ✓ Done
    // / ↑ Up / ↓ Down) so the user never has to walk past every
    // property-edit button just to reach Delete or Done. The plain
    // spacer button breaks the previous `options` group that
    // this.Buttons() would otherwise append to, and the follow-up
    // this.Buttons() therefore starts a fresh group on its own line.
    // ------------------------------------------------------------------
    this.Button(id, { name: ' ', pinned: true })

    const actions = [
      { name: '↑ Up',   props: { __up: it.id },   pinned: true },
      { name: '↓ Down', props: { __down: it.id }, pinned: true }
    ]

    // "Add child" shortcut: container items (pages, dropdowns and
    // code-blocks) get a direct jump into themselves so the user can
    // add nested items right from the editor.
    if (it.type === 'page') {
      actions.push({
        name: ColorText.brightCyan('＋ Add child'),
        props: { page: it.name },
        pinned: true
      })
    } else if (it.type === 'dropdown') {
      actions.push({
        name: ColorText.brightCyan('＋ Add child'),
        props: { page: `__sbdd__:${it.id}` },
        pinned: true
      })
    } else if (it.type === 'codeblock') {
      actions.push({
        name: ColorText.brightCyan('＋ Add child'),
        props: { page: `__sbcb__:${it.id}` },
        pinned: true
      })
    } else if (it.type === 'args') {
      actions.push({
        name: ColorText.brightCyan('＋ Add child'),
        props: { page: `__sba__:${it.id}` },
        pinned: true
      })
    } else if (it.type === 'buttonsGroup') {
      actions.push({
        name: ColorText.brightCyan('＋ Add child'),
        props: { page: `__sbbg__:${it.id}` },
        pinned: true
      })
    } else if (it.type === 'pinnedTop') {
      actions.push({
        name: ColorText.brightCyan('＋ Add child'),
        props: { page: `__sbpt__:${it.id}` },
        pinned: true
      })
    } else if (it.type === 'pinnedBottom') {
      actions.push({
        name: ColorText.brightCyan('＋ Add child'),
        props: { page: `__sbpb__:${it.id}` },
        pinned: true
      })
    }

    actions.push({ name: ColorText.red('× Delete'), props: { __del: it.id },   pinned: true })
    actions.push({ name: ColorText.green('✓ Done'), props: { __editItem: '' }, pinned: true })

    this.Buttons(id, actions)
  }
}

// ============================================================
// USER-FILE PARSER
// ============================================================
// Reverse-engineers an existing SyAPP function file (regardless of
// whether it was originally produced by the SelfBuilder) into a
// State object that the editor can consume.
//
// The parser is intentionally lenient:
//   • extracts the class name,
//   • extracts the app name passed to `super(...)`,
//   • detects the identifier assigned from `props.session.UniqueID`
//     (which can be named anything — id, uid, ID, session, ...),
//   • walks the build-function body statement by statement and maps
//     recognised `this.X(...)` calls into builder items,
//   • and preserves every unrecognised statement as a raw `code`
//     item, so nothing is ever silently dropped.
// ============================================================

let __SB_PARSE_SEQ = 0
function _sbNid() { return `it_${Date.now().toString(36)}_p${++__SB_PARSE_SEQ}` }

/** Sentinel returned by value parsers when an expression is not a
 *  plain JSON-safe literal (identifiers, calls, template interpolation). */
const _SB_CODE = Symbol('sb_code')

/**
 * Extract the content between a balanced open/close character pair.
 * Strings, template literals, line comments and block comments are
 * skipped, so braces/parens inside them never affect the depth count.
 * @returns {string|null} inner content, or null when unbalanced
 */
function _sbExtractBalanced(source, openIdx, openChar, closeChar) {
  if (!source || source[openIdx] !== openChar) return null
  let depth = 0
  let inString = null, inLineComment = false, inBlockComment = false
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i], next = source[i + 1]
    if (inLineComment) { if (c === '\n') inLineComment = false; continue }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++ } continue }
    if (inString) {
      if (c === '\\') { i++; continue }
      if (c === inString) inString = null
      continue
    }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue }
    if (c === openChar) depth++
    else if (c === closeChar) {
      depth--
      if (depth === 0) return source.slice(openIdx + 1, i)
    }
  }
  return null
}

/** Split a top-level comma-separated argument string. */
function _sbSplitArgs(argsStr) {
  const args = []
  let depth = 0, start = 0, inString = null
  for (let i = 0; i < argsStr.length; i++) {
    const c = argsStr[i]
    if (inString) {
      if (c === '\\') { i++; continue }
      if (c === inString) inString = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue }
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      args.push(argsStr.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = argsStr.slice(start).trim()
  if (last) args.push(last)
  return args
}

/**
 * Split a script body into top-level statements. A statement ends when
 * a newline is seen at bracket depth 0. Multi-line statements (e.g. a
 * call whose object literal spans several lines) are kept together.
 */
function _sbSplitStatements(body) {
  const stmts = []
  let depth = 0, start = 0
  let inString = null, inLineComment = false, inBlockComment = false
  for (let i = 0; i < body.length; i++) {
    const c = body[i], next = body[i + 1]
    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false
        if (depth === 0) { stmts.push(body.slice(start, i)); start = i + 1 }
      }
      continue
    }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++ } continue }
    if (inString) {
      if (c === '\\') { i++; continue }
      if (c === inString) inString = null
      continue
    }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    else if (c === '\n' && depth === 0) {
      stmts.push(body.slice(start, i))
      start = i + 1
    }
  }
  if (start < body.length) {
    const tail = body.slice(start)
    if (tail.trim()) stmts.push(tail)
  }
  return stmts.map(s => s.trim()).filter(s => s.length > 0)
}

/**
 * Parse a value expression (literal, object, array) into a JSON-safe
 * JavaScript value. Returns _SB_CODE when the expression contains any
 * runtime evaluation (identifier, call, template interpolation, ...).
 */
function _sbParseValue(src) {
  if (src === undefined || src === null) return undefined
  src = String(src).trim()
  if (src === '') return ''
  if (src === 'true') return true
  if (src === 'false') return false
  if (src === 'null') return null
  if (src === 'undefined') return undefined
  if (/^-?\d+(?:\.\d+)?$/.test(src)) return Number(src)
  if ((src[0] === "'" && src[src.length - 1] === "'") ||
      (src[0] === '"' && src[src.length - 1] === '"')) {
    return src.slice(1, -1)
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r').replace(/\\'/g, "'")
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (src[0] === '`' && src[src.length - 1] === '`') {
    const inner = src.slice(1, -1)
    if (inner.includes('${')) return _SB_CODE
    return inner
  }
  if (src.startsWith('{') && src.endsWith('}')) {
    const inner = src.slice(1, -1).trim()
    if (inner === '') return {}
    const parts = _sbSplitArgs(inner)
    const obj = {}
    for (const part of parts) {
      const m = part.match(/^([\w$]+|['"][^'"]+['"])\s*:\s*([\s\S]+)$/)
      if (!m) return _SB_CODE
      let key = m[1]
      if ((key[0] === "'" || key[0] === '"') && key[key.length - 1] === key[0]) {
        key = key.slice(1, -1)
      }
      const v = _sbParseValue(m[2])
      if (v === _SB_CODE) return _SB_CODE
      obj[key] = v
    }
    return obj
  }
  if (src.startsWith('[') && src.endsWith(']')) {
    const inner = src.slice(1, -1).trim()
    if (inner === '') return []
    const parts = _sbSplitArgs(inner)
    const arr = []
    for (const p of parts) {
      const v = _sbParseValue(p)
      if (v === _SB_CODE) return _SB_CODE
      arr.push(v)
    }
    return arr
  }
  return _SB_CODE
}

/** Detect a `this.Method(...)` call and return { method, args }. */
function _sbParseCall(stmt) {
  const m = stmt.match(/^(?:await\s+)?this\.([A-Za-z_$][\w$]*)\s*\(/)
  if (!m) return null
  const openIdx = m.index + m[0].length - 1
  const argsStr = _sbExtractBalanced(stmt, openIdx, '(', ')')
  if (argsStr === null) return null
  return {
    method: m[1],
    args: _sbSplitArgs(argsStr),
    isAwait: /^\s*await\s+/.test(stmt)
  }
}

/**
 * Drop the leading session-variable argument from a call when it looks
 * like a plain identifier reference (the common `this.Text(uid, ...)`
 * pattern). The sessionVar hint is used when available, but identifier
 * syntax alone is enough to safely drop the first positional argument
 * for every builder method — they all take the id first.
 */
function _sbDropSessionArg(args, sessionVar) {
  if (args.length === 0) return args
  const a0 = args[0]
  if (a0 === sessionVar || /^[A-Za-z_$][\w$]*$/.test(a0) || /^\w+\.session\b/.test(a0)) {
    return args.slice(1)
  }
  return args
}

/**
 * Build a button config from a `this.Button(...)` / `this.SideButton(...)`
 * argument list. Handles all signatures the runtime accepts:
 *   Button(id, 'name')
 *   Button(id, 'name', { ...config })
 *   Button(id, { name, props, path, ... })
 *   Button(id, 'name', { ...config1 }, { ...config2 })
 */
function _sbButtonConfig(rest) {
  const cfg = { name: '', props: {} }
  if (rest.length === 0) return cfg
  let nameFromString = null
  let startIdx = 0
  const first = rest[0]
  if (first && (first[0] === "'" || first[0] === '"' || first[0] === '`')) {
    const v = _sbParseValue(first)
    if (typeof v === 'string') nameFromString = v
    startIdx = 1
  }
  for (let i = startIdx; i < rest.length; i++) {
    const v = _sbParseValue(rest[i])
    if (v === _SB_CODE) return null
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(cfg, v)
    }
  }
  if (nameFromString !== null && !cfg.name) cfg.name = nameFromString
  return cfg
}

/** Turn a parsed button config into a builder button item, or null. */
function _sbMakeButtonItem(cfg, sourceMethod) {
  if (!cfg) return null
  const out = {
    type: 'button',
    sourceMethod: sourceMethod || 'Button',
    name: typeof cfg.name === 'string' ? cfg.name : '',
    props: (cfg.props && typeof cfg.props === 'object' && !Array.isArray(cfg.props)) ? cfg.props : {}
  }
  if (sourceMethod === 'SideButton') out.buttons = true
  if (typeof cfg.path === 'string') out.path = cfg.path
  if (cfg.resetSelection) out.resetSelection = true
  if (cfg.jumpTo !== undefined) out.jumpTo = cfg.jumpTo
  if (cfg.pinned) out.pinned = true
  if (cfg.pinnedTop) out.pinnedTop = true
  return out
}

/** Parse a `{...}` config expression into a plain object, or {} on failure. */
function _sbObjArg(src) {
  if (src === undefined || src === null) return {}
  const v = _sbParseValue(src)
  if (v === _SB_CODE) return null
  if (v && typeof v === 'object' && !Array.isArray(v)) return v
  return {}
}

/** Extract the body of an arrow-function expression `... => { ... }`. */
function _sbExtractArrowBody(src) {
  src = String(src).trim()
  const arrowIdx = src.indexOf('=>')
  if (arrowIdx < 0) return null
  const after = src.slice(arrowIdx + 2).trim()
  if (after.startsWith('{')) return _sbExtractBalanced(after, 0, '{', '}')
  return null
}

/**
 * Parse a container-style method (Page, DropDown, PinnedTop, PinnedBottom,
 * Args). Containers embed an `async () => { ... }` body that is parsed
 * recursively. Optional trailing config object is merged into the item.
 */
function _sbContainerItem(method, rest) {
  let name = ''
  let arrowSrc = null
  let configSrc = null
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i].trim()
    if (/^(async\s*\(|async\s+function|\(?\s*[\w$]*\s*\)?\s*=>)/.test(a)) {
      arrowSrc = a
      if (i + 1 < rest.length) configSrc = rest[i + 1]
      break
    }
    if (i === 0 && (a[0] === "'" || a[0] === '"' || a[0] === '`')) {
      const v = _sbParseValue(a)
      if (typeof v === 'string') name = v
    }
  }
  let nested = []
  if (arrowSrc) {
    const body = _sbExtractArrowBody(arrowSrc)
    if (body !== null) nested = _sbParseBody(body)
  }
  let cfg = {}
  if (configSrc !== null) {
    const cv = _sbObjArg(configSrc)
    if (cv) cfg = cv
  }
  switch (method) {
    case 'Page':
      return {
        type: 'page',
        name: name || `page_${_sbNid()}`,
        items: nested,
        pinButton: !!cfg.pinButton,
        pinPosition: cfg.pinPosition === 'top' ? 'top' : 'bottom'
      }
    case 'DropDown':
      return {
        type: 'dropdown',
        name: name || `dropdown_${_sbNid()}`,
        up_buttontext: typeof cfg.up_buttontext === 'string' ? cfg.up_buttontext : 'Show more',
        down_buttontext: typeof cfg.down_buttontext === 'string' ? cfg.down_buttontext : 'Hide',
        items: nested
      }
    case 'PinnedTop':
      return {
        type: 'pinnedTop',
        items: nested,
        separator: (typeof cfg.separator === 'string') ? cfg.separator : undefined
      }
    case 'PinnedBottom':
      return {
        type: 'pinnedBottom',
        items: nested,
        separator: (typeof cfg.separator === 'string') ? cfg.separator : undefined
      }
    case 'Args':
      return {
        type: 'args',
        everyTime: !!cfg.everyTime,
        form: cfg.form !== false,
        description: typeof cfg.description === 'string' ? cfg.description : '',
        key: typeof cfg.key === 'string' ? cfg.key : _sbNid(),
        schema: Array.isArray(cfg.required) ? cfg.required : [],
        items: nested
      }
  }
  return null
}

/**
 * Convert a parsed `this.X(...)` call into a builder item. Returns null
 * when the call cannot be safely mapped — the caller then stores the
 * original statement as a raw code item.
 */
function _sbCallToItem(call, sessionVar) {
  const rest = _sbDropSessionArg(call.args, sessionVar)
  switch (call.method) {
    case 'Text': {
      const v = _sbParseValue(rest[0])
      if (v === _SB_CODE) return null
      if (typeof v === 'string' && v === '') return { type: 'spacer' }
      if (typeof v === 'string') return { type: 'text', value: v }
      return null
    }
    case 'Button':
    case 'AlertButton':
      return _sbMakeButtonItem(_sbButtonConfig(rest), call.method)
    case 'SideButton':
      return _sbMakeButtonItem(_sbButtonConfig(rest), 'SideButton')
    case 'Buttons': {
      const arr = _sbParseValue(rest[0])
      if (arr === _SB_CODE || !Array.isArray(arr)) return null
      const items = []
      for (const c of arr) {
        if (!c || typeof c !== 'object' || Array.isArray(c)) continue
        const it = _sbMakeButtonItem(c, 'Button')
        if (it) { it.id = _sbNid(); items.push(it) }
      }
      return { type: 'buttonsGroup', items }
    }
    case 'Field': {
      const name = _sbParseValue(rest[0])
      if (typeof name !== 'string') return null
      const cfg = rest[1] !== undefined ? _sbObjArg(rest[1]) : {}
      if (cfg === null) return null
      return {
        type: 'field',
        name,
        label: typeof cfg.label === 'string' ? cfg.label : '',
        initialValue: typeof cfg.initialValue === 'string' ? cfg.initialValue : '',
        pinned: !!cfg.pinned,
        pinnedTop: !!cfg.pinnedTop
      }
    }
    case 'TextButton': {
      const name = _sbParseValue(rest[0])
      if (typeof name !== 'string') return null
      const cfg = rest[1] !== undefined ? _sbObjArg(rest[1]) : {}
      if (cfg === null) return null
      return {
        type: 'textbutton',
        name,
        label: typeof cfg.label === 'string' ? cfg.label : '',
        initialValue: typeof cfg.initialValue === 'string' ? cfg.initialValue : '',
        lines: typeof cfg.lines === 'number' ? cfg.lines : 4,
        editable: !!cfg.editable,
        pinned: !!cfg.pinned,
        pinnedTop: !!cfg.pinnedTop
      }
    }
    case 'Alert': {
      const text = _sbParseValue(rest[0])
      if (typeof text !== 'string') return null
      const cfg = rest[1] !== undefined ? _sbObjArg(rest[1]) : {}
      if (cfg === null) return null
      return {
        type: 'alert',
        text,
        duration: typeof cfg.duration === 'number' ? cfg.duration : 3000
      }
    }
    case 'GotoNow': {
      const pathVal = _sbParseValue(rest[0])
      if (typeof pathVal !== 'string') return null
      const cfg = rest[1] !== undefined ? _sbObjArg(rest[1]) : {}
      if (cfg === null) return null
      return { type: 'gotonow', path: pathVal, props: cfg.props || {} }
    }
    case 'SetPage': {
      const page = _sbParseValue(rest[0])
      if (typeof page !== 'string') return null
      return { type: 'setpage', page }
    }
    case 'WaitInput': {
      const cfg = rest[0] !== undefined ? _sbObjArg(rest[0]) : {}
      if (cfg === null) return null
      return {
        type: 'waitinput',
        path: typeof cfg.path === 'string' ? cfg.path : '',
        props: cfg.props || {},
        question: typeof cfg.question === 'string' ? cfg.question : 'Type: ',
        password: !!cfg.password
      }
    }
    case 'Page':
    case 'DropDown':
    case 'PinnedTop':
    case 'PinnedBottom':
    case 'Args':
      return _sbContainerItem(call.method, rest)
    case 'Emb': {
      // Embedded SyAPP_Func — round-trips the widget's own config so
      // that a produced source containing an `await this.Emb(id, ...)`
      // call can be re-parsed back into a proper Emb item instead of a
      // raw code block. This is what allows nested Emb widgets that
      // live INSIDE an already-produced Self Build func to keep
      // working across recursive edits (Emb → Self Build → Emb →
      // Self Build → …), instead of collapsing into opaque code items
      // that would stop round-tripping at depth ≥ 2.
      const cfg = rest[0] !== undefined ? _sbObjArg(rest[0]) : {};
      if (cfg === null) return null;
      return {
        type: 'emb',
        name: typeof cfg.name === 'string' ? cfg.name : `emb_${_sbNid()}`,
        filePath: typeof cfg.filePath === 'string' ? cfg.filePath : '',
        code: typeof cfg.code === 'string' ? cfg.code : '',
        saveMode: typeof cfg.saveMode === 'string' ? cfg.saveMode : 'path',
        dropdown: (cfg.dropdown && typeof cfg.dropdown === 'object' && !Array.isArray(cfg.dropdown))
          ? cfg.dropdown
          : {}
      };
    }
    case 'File':
      return { type: 'file', config: {} }
    case 'JSON':
      return { type: 'json', config: {} }
    case 'Grid': {
      const nameVal = _sbParseValue(rest[0])
      const cellsArg = rest[1] || ''
      const cells = []
      const trimmed = String(cellsArg).trim()
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const inner = trimmed.slice(1, -1)
        const parts = _sbSplitArgs(inner)
        for (const p of parts) {
          const body = _sbExtractArrowBody(p)
          const cellItems = body !== null ? _sbParseBody(body) : []
          cells.push({ items: cellItems })
        }
      }
      const cfg = rest[2] !== undefined ? _sbObjArg(rest[2]) : {}
      if (cfg === null) return null
      return {
        type: 'grid',
        name: typeof nameVal === 'string' ? nameVal : 'grid',
        cells,
        maxCellRatio: typeof cfg.maxCellRatio === 'number' ? cfg.maxCellRatio : 0.2,
        gap: typeof cfg.gap === 'number' ? cfg.gap : 2
      }
    }
    case 'Get':
    case 'Post':
    case 'Put':
    case 'Delete': {
      const pathVal = _sbParseValue(rest[0])
      const handlerArg = rest[1]
      let handlerCode = '// handler code'
      if (handlerArg) {
        const body = _sbExtractArrowBody(handlerArg)
        if (body !== null) handlerCode = body.trim()
      }
      return {
        type: 'route',
        method: call.method,
        path: typeof pathVal === 'string' ? pathVal : '/',
        handler: handlerCode
      }
    }
  }
  return null
}

/**
 * Detect the identifier assigned from `props.session.UniqueID`. The
 * props variable itself may be named anything (props, p, configuration,
 * cfg, ...) and the target variable may be anything (id, uid, ID, ...).
 */
function _sbFindSessionVar(body, propsVar) {
  const candidates = []
  if (propsVar) candidates.push(propsVar)
  candidates.push('props', 'p', 'configuration', 'config')
  const seen = new Set()
  for (const v of candidates) {
    if (!v || seen.has(v)) continue
    seen.add(v)
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(
      `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${esc}\\.session\\.UniqueID`,
      'i'
    )
    const m = body.match(re)
    if (m) return { sessionVar: m[1], propsVar: v }
  }
  // Fallback: match any `<X>.session.UniqueID` access pattern
  const f = body.match(/([A-Za-z_$][\w$]*)\.session\.UniqueID/i)
  if (f) {
    const esc = f[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const a = body.match(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${esc}\\.session\\.UniqueID`))
    if (a) return { sessionVar: a[1], propsVar: f[1] }
    return { sessionVar: 'id', propsVar: f[1] }
  }
  return { sessionVar: 'id', propsVar: 'props' }
}

/**
 * Extract the async build function from the `super(...)` call. Looks at
 * the second argument of super() and returns { body, propsVar }.
 */
function _sbExtractBuildFunction(source) {
  const m = source.match(/\bsuper\s*\(/)
  if (!m) return null
  const openIdx = source.indexOf('(', m.index)
  if (openIdx < 0) return null
  const argsStr = _sbExtractBalanced(source, openIdx, '(', ')')
  if (argsStr === null) return null
  const args = _sbSplitArgs(argsStr)
  if (args.length < 2) return null
  const buildSrc = args[1].trim()
  let pm = buildSrc.match(/^async\s*\(\s*([\w$]*)\s*\)\s*=>/)
  if (!pm) pm = buildSrc.match(/^async\s+([\w$]+)\s*=>/)
  if (!pm) pm = buildSrc.match(/^async\s+function\s*\(\s*([\w$]*)\s*\)/)
  if (!pm) pm = buildSrc.match(/^\(\s*([\w$]*)\s*\)\s*=>/)
  if (!pm) return null
  const propsVar = pm[1] || 'props'
  const braceIdx = buildSrc.indexOf('{', pm.index + pm[0].length - 1)
  if (braceIdx < 0) return null
  const body = _sbExtractBalanced(buildSrc, braceIdx, '{', '}')
  if (body === null) return null
  return { body, propsVar }
}

/**
 * Parse a raw build-function body into builder items. Recognised
 * `this.X(...)` calls become structured items; everything else becomes
 * a `code` item executed as-is at render time.
 *
 * When the session variable is renamed (e.g. `uid`), any code fallback
 * gets a `const <sessionVar> = id;` prefix so the code can still resolve
 * the session id inside the AsyncFunction sandbox that the renderer
 * provides.
 */
function _sbParseBody(body) {
  const found = _sbFindSessionVar(body, 'props')
  const sessionVar = found.sessionVar
  const stmts = _sbSplitStatements(body)
  const items = []
  for (const stmt of stmts) {
    // Skip the session-variable declaration itself
    if (/^(?:const|let|var)\s+[\w$]+\s*=\s*[\w$]+\.session\.UniqueID\b/i.test(stmt)) {
      continue
    }
    const call = _sbParseCall(stmt)
    if (call) {
      const item = _sbCallToItem(call, sessionVar)
      if (item) {
        item.id = item.id || _sbNid()
        items.push(item)
        continue
      }
    }
    // Fallback: preserve the statement as a raw code item
    let code = stmt
    if (sessionVar && sessionVar !== 'id') {
      const esc = sessionVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`\\b${esc}\\b`).test(code)) {
        code = `const ${sessionVar} = id;\n${code}`
      }
    }
    items.push({ id: _sbNid(), type: 'code', value: code })
  }
  return items
}

/**
 * Parse an entire SyAPP function file into a builder state object.
 * Returns `{ name, funcName, items, hiddenMethods, sessionVar }` — a
 * shape fully compatible with the SelfBuilder's State.
 *
 * Anything the parser cannot understand becomes a raw `code` item, so
 * the loaded file always executes as intended when viewed. Complex
 * functions that were never produced by the SelfBuilder therefore
 * round-trip through the editor without losing behaviour.
 */
function _sbParseFuncJS(source, filePath) {
  const baseName = path.basename(filePath).replace(/\.(js|mjs|cjs)$/i, '')
  const state = {
    name: baseName || 'untitled',
    funcName: (baseName || 'MyApp').replace(/[^A-Za-z0-9_$]/g, '') || 'MyApp',
    code: '',
    items: [],
    hiddenMethods: [],
    sessionVar: 'id'
  }
  if (!source || typeof source !== 'string') return state

  // 1. Class name → funcName
  const clsM = source.match(/class\s+([A-Za-z_$][\w$]*)\s+extends\s+/)
  if (clsM) state.funcName = clsM[1]

  // 2. App name → first string literal argument of super()
  const supM = source.match(/super\s*\(\s*(['"`])([^'"`]+)\1/)
  if (supM) state.name = supM[2]

  // 3. Build-function body (2nd argument to super())
  const buildInfo = _sbExtractBuildFunction(source)
  if (!buildInfo) return state

  // 4. Session-var identifier (can be id, uid, ID, session, ...)
  const found = _sbFindSessionVar(buildInfo.body, buildInfo.propsVar)
  state.sessionVar = found.sessionVar

  // 5. Parse the body into builder items
  state.items = _sbParseBody(buildInfo.body)
  return state
}

// ============================================================
// JSON / JSONL VIEWER — direct-boot loader
// ============================================================
// When the runner is invoked with a .json / .jsonl path, SyAPP boots a
// dedicated JSONViewerFunc that skips the SelfBuilder entirely and
// drops the user straight into this.JSON() with the file pre-loaded.
//
// NOTE ON SELF-CONTAINMENT:
// Every helper used during loading (byte formatter, index walker) is
// defined LOCALLY inside this block. Nothing here relies on module
// symbols declared elsewhere (like buildSearchIndex), so the loader
// cannot fail with "X is not defined" regardless of how the surrounding
// file is reorganised. The viewer func itself reuses the shared
// `_sbJvBuildIndex` walker, so no duplication of indexing logic is
// needed inside the class.
// ============================================================

/**
 * Human-readable byte size formatter.
 * @private
 */
function _sbFormatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

/**
 * Self-contained search-index walker. Mirrors the shape produced by the
 * module-level buildSearchIndex() (used by this.JSON()), so the viewer
 * can hand the result straight to the JSON browser without any
 * dependency on that symbol being reachable at call time.
 *
 * Each entry: { type, path, key, value, fullValue }
 * @private
 */
function _sbJvBuildIndex(data) {
  const index = [];
  const traverse = (obj, pathStr) => {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => {
        traverse(item, `${pathStr}[${i}]`);
      });
    } else if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const fullPath = pathStr ? `${pathStr}.${k}` : k;
        index.push({
          type: 'key',
          path: fullPath,
          key: String(k).toLowerCase(),
          value: typeof v === 'string' ? v.toLowerCase() : '',
          fullValue: v
        });
        traverse(v, fullPath);
      }
    } else {
      const strValue = String(obj).toLowerCase();
      index.push({
        type: 'value',
        path: pathStr || 'root',
        key: pathStr.split('.').pop()?.toLowerCase() || 'root',
        value: strValue,
        fullValue: obj
      });
    }
  };
  traverse(data, '');
  return index;
}

/**
 * Read a .json / .jsonl file from disk with a live progress bar, then
 * parse it and build its search index. Everything is written to stderr
 * so it never clashes with the terminal HUD output on stdout.
 *
 * Progress phases:
 *   1. Reading  — chunked fs.createReadStream, byte-level progress bar.
 *   2. Parsing  — JSON.parse or JSONL line-by-line parse.
 *   3. Indexing — _sbJvBuildIndex() walk, entry count report.
 *
 * @param {string} filePath - Absolute path to the .json / .jsonl file.
 * @returns {Promise<{ data: any, searchIndex: Array }>}
 * @private
 */
async function _sbLoadJsonWithProgress(filePath) {
  const fileName = path.basename(filePath);
  const stat = fs.statSync(filePath);
  const totalBytes = stat.size;
  const totalStr = _sbFormatBytes(totalBytes);
  const barLen = 30;
  const useBar = !!process.stderr.isTTY;

  const renderBar = (bytesRead) => {
    if (!useBar) return;
    const pct = totalBytes > 0
      ? Math.min(100, Math.floor((bytesRead / totalBytes) * 100))
      : 100;
    const filled = Math.floor((pct / 100) * barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    const readStr = _sbFormatBytes(bytesRead);
    process.stderr.write(
      `\r⏳ Reading ${fileName} [${bar}] ${String(pct).padStart(3)}% (${readStr}/${totalStr})`
    );
  };

  if (!useBar) {
    process.stderr.write(`⏳ Loading ${fileName} (${totalStr})...\n`);
  } else {
    renderBar(0);
  }

  // ---------- Read + parse (streaming-aware) ----------
  let data;
  try {
    data = await _syappLoadJsonFile(filePath, (bytesRead) => renderBar(bytesRead));
  } catch (err) {
    if (useBar) process.stderr.write('\n');
    throw err;
  }
  if (useBar) process.stderr.write('\n');

  const topLevelCount = Array.isArray(data)
    ? data.length
    : (data && typeof data === 'object' ? Object.keys(data).length : 1);

  process.stderr.write(
    `✅ Parsed ${fileName} — ${topLevelCount.toLocaleString()} top-level item(s) (${totalStr})\n`
  );

  // ---------- Build search index ----------
  process.stderr.write(`⏳ Building search index...\n`);
  const searchIndex = _sbJvBuildIndex(data);
  process.stderr.write(
    `✅ Built search index — ${searchIndex.length.toLocaleString()} searchable entries\n`
  );

  return { data, searchIndex };
}

/**
 * Build a SyAPP_Func subclass that boots directly into this.JSON() with
 * the given file pre-loaded. The file data and its search index are
 * injected into per-session storage ONCE, on the first build pass, so
 * subsequent refresh ticks and in-view navigation reuse the same
 * in-memory dataset without re-reading the file.
 *
 * The storage keys match exactly what this.JSON() uses for its
 * `default` instance, so the JSON browser skips its file-picker step
 * and renders the data view immediately.
 *
 * @param {string} jsonPath - Absolute path to the source file.
 * @param {any} preloadedData - Parsed contents of the file.
 * @param {Array} preloadedIndex - Pre-built search index.
 * @returns {typeof SyAPP_Func}
 * @private
 */
function _sbMakeJSONViewerFunc(jsonPath, preloadedData, preloadedIndex) {
  return class JSONViewerFunc extends SyAPP_Func {
    constructor() {
      super(
        '__jsonviewer__',
        async (props) => {
          const id = props.session.UniqueID;
          const instanceName = 'default';
          const storageKey = `jsonBrowser_${instanceName}`;
          const searchIndexKey = `${storageKey}_searchIndex`;

          // Pre-populate the JSON browser storage ONCE per session.
          // On every subsequent build pass (refresh ticks, navigation)
          // the storage already has data !== null, so this.JSON()
          // renders the data view directly.
          let storage = this.Storages.Get(id, storageKey);
          if (!storage || storage.data === null || storage.data === undefined) {
            this.Storages.Set(id, storageKey, {
              data: preloadedData,
              path: [],
              searchResults: null,
              searchPath: [],
              filePath: jsonPath,
              searchQuery: '',
              historyStack: []
            });
            this.Storages.Set(id, searchIndexKey, preloadedIndex);
          }

          // Jump straight into the JSON browser view — no file picker,
          // no intermediate screen. The data view renders immediately.
          await this.JSON(id, { name: instanceName });
        },
        { refreshMode: true }
      );
    }
  };
}

function _installCtrlC(syapp) {
  // ------------------------------------------------------------------
  // Terminal state cleanup on exit.
  //
  // When the process is terminated while the HUD has mouse tracking
  // enabled, the terminal keeps emitting SGR mouse sequences (e.g.
  // "51;56;25M") into the shell, which caused the "spam of strange
  // characters" after Ctrl+C on a JSON / JSONL direct load.
  //
  // We explicitly disable every mouse mode, restore the cursor, drop
  // raw mode and detach stdin listeners BEFORE calling process.exit.
  // ------------------------------------------------------------------
  const cleanupTerminal = () => {
    try {
      if (syapp && syapp.HUD) {
        try { syapp.HUD.cleanupMenuState && syapp.HUD.cleanupMenuState(); } catch (_) {}
        try { syapp.HUD.cleanupAll && syapp.HUD.cleanupAll(); } catch (_) {}
        try { syapp.HUD.cleanupMouseSupport && syapp.HUD.cleanupMouseSupport(); } catch (_) {}
        try { syapp.HUD.resetTerminalModes && syapp.HUD.resetTerminalModes(); } catch (_) {}
      }
    } catch (_) {}

    // Belt-and-braces: write the raw reset sequences directly, so even
    // if the HUD helpers throw we always disable mouse tracking and
    // restore the cursor.
    try {
      stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h');
    } catch (_) {}

    try { if (stdin.isRaw) stdin.setRawMode(false); } catch (_) {}
    try { stdin.removeAllListeners('data'); } catch (_) {}
    try { stdin.removeAllListeners('keypress'); } catch (_) {}
  };

  // OS-level SIGINT (e.g. Ctrl+C pressed outside raw-mode menus).
  process.on('SIGINT', () => {
    cleanupTerminal();
    process.exit(0);
  });

  syapp.HUD.on('ctrl+c', async () => {
    const builder = syapp.Funcs.get('__selfbuilder__')
    if (!builder) {
      cleanupTerminal();
      process.exit(0)
    }
    try {
      const name = await syapp.HUD.ask('\nSave as: ')
      const trimmed = String(name || '').trim()
      if (trimmed) {
        builder.State.name = trimmed
        _writeSaveState(trimmed, builder.State)
        console.log(ColorText.brightGreen(`💾 Saved "${trimmed}" → ${_getSaveFile(trimmed)}`))
      }
    } catch (_) { }
    cleanupTerminal();
    process.exit(0)
  })
}

// If this file is run directly, execute the CLI with HTTP disabled by default.
//
// Usage:
//   node SyAPP.js                 → starts with the built-in TemplateFunc as main func (legacy behavior)
//   node SyAPP.js path/to/My.js   → dynamically imports My.js, uses its default export
//                                    (a class extending SyAPP_Func OR SyAPP.Func()) as the main func.
//
// The dynamic import preserves the full module graph of the target file
// (its own imports, its Linked functions, its routes, etc.), and SyAPP
// then recursively registers every function reachable through .Linked,
// exactly the same way it does for its own built-in main function.
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const arg1 = process.argv[2];
    const arg2 = process.argv[3];

    // --- `node SyAPP.js list` ---
    if (arg1 === 'list') {
      const saves = _listSaves();
      if (saves.length === 0) {
        console.log(`No saves yet.\nDirectory: ${SYAPP_SAVES_DIR}`);
      } else {
        console.log(`Saves (${SYAPP_SAVES_DIR}):`);
        for (const s of saves) console.log('  • ' + s);
      }
      return;
    }

    // --- `node SyAPP.js --edit <file>` or `node SyAPP.js <file> --edit` ---
    let editMode = false;
    let editTarget = null;
    if (arg1 === '--edit' && arg2) { editMode = true; editTarget = arg2; }
    else if (arg2 === '--edit') { editMode = true; editTarget = arg1; }
    if (editMode && editTarget) {
      __BUILDER_EXPORT_TARGET = path.isAbsolute(editTarget)
        ? editTarget
        : path.resolve(process.cwd(), editTarget);

      // If the target file already exists, parse it into a builder state
      // so the SelfBuilder opens the file directly in the editor. The
      // parser is best-effort: whatever cannot be mapped to a structured
      // item is preserved as a raw `code` item, so nothing is lost and
      // the loaded code still executes with the same behaviour as before.
      __BUILDER_INITIAL_STATE = null;
      try {
        if (fs.existsSync(__BUILDER_EXPORT_TARGET)) {
          const src = fs.readFileSync(__BUILDER_EXPORT_TARGET, 'utf8');
          const parsed = _sbParseFuncJS(src, __BUILDER_EXPORT_TARGET);
          if (parsed && (parsed.items.length > 0 || parsed.name)) {
            __BUILDER_INITIAL_STATE = parsed;
            console.log(ColorText.brightGreen(
              `📂 Loaded "${editTarget}" — ${parsed.items.length} item(s) parsed`
            ));
          }
        } else {
          console.log(ColorText.yellow(
            `ℹ️  New file: ${editTarget} (will be created on export)`
          ));
        }
      } catch (e) {
        console.error(ColorText.yellow(
          `⚠️  Could not parse "${editTarget}": ${e.message} — starting with a blank editor`
        ));
        __BUILDER_INITIAL_STATE = null;
      }

      const syapp = new SyAPP(SelfBuilder);
      _installCtrlC(syapp);
      return;
    }

    // --- No arguments: start the interactive SelfBuilder with a blank state ---
    if (!arg1) {
      __BUILDER_INITIAL_STATE = null;
      __BUILDER_EXPORT_TARGET = null;
      const syapp = new SyAPP(SelfBuilder);
      _installCtrlC(syapp);
      return;
    }

    // ------------------------------------------------------------------
    // --- `node SyAPP.js <file>.json` / `node SyAPP.js <file>.jsonl` ---
    // ------------------------------------------------------------------
    // Boots a dedicated JSONViewerFunc that skips the SelfBuilder
    // entirely and jumps straight into this.JSON() with the file
    // pre-loaded — no file picker, no builder screen. A live progress
    // indicator is printed to stderr while the file is read, parsed
    // and indexed, so large JSON / JSONL datasets give visible
    // feedback before the terminal HUD takes over.
    //
    // The loader is fully self-contained: every symbol it needs is
    // defined in the same file, immediately above this branch, so
    // there is no risk of "buildSearchIndex is not defined" from a
    // module-reorganisation or a partially-applied patch.
    // ------------------------------------------------------------------
    {
      const lower = String(arg1).toLowerCase();
      if (lower.endsWith('.json') || lower.endsWith('.jsonl')) {
        const jsonPath = path.isAbsolute(arg1)
          ? arg1
          : path.resolve(process.cwd(), arg1);

        if (!fs.existsSync(jsonPath)) {
          console.error(ColorText.brightRed(`❌ JSON file not found: ${arg1}`));
          process.exit(1);
        }

        try {
          const result = await _sbLoadJsonWithProgress(jsonPath);
          const JSONViewerFunc = _sbMakeJSONViewerFunc(jsonPath, result.data, result.searchIndex);
          const syapp = new SyAPP(JSONViewerFunc);
          _installCtrlC(syapp);
        } catch (err) {
          console.error(ColorText.brightRed(`❌ Failed to load "${arg1}": ${err.message}`));
          process.exit(1);
        }
        return;
      }
    }

    // --- If arg1 is a save name (not a file path), load its state ---
    const _looksLikeFile =
      arg1.endsWith('.js') || arg1.endsWith('.mjs') || arg1.endsWith('.cjs') ||
      arg1.startsWith('./') || arg1.startsWith('../') || arg1.startsWith('/') ||
      fs.existsSync(path.resolve(process.cwd(), arg1));

    if (!_looksLikeFile) {
      const st = _loadSaveState(arg1);
      if (!st) {
        console.error(ColorText.brightRed(`❌ Save "${arg1}" not found. Try: node SyAPP.js list`));
        process.exit(1);
      }
      __BUILDER_INITIAL_STATE = st;
      __BUILDER_EXPORT_TARGET = null;
      const syapp = new SyAPP(SelfBuilder);
      _installCtrlC(syapp);
      return;
    }

    // --- Otherwise: existing file-loading behavior is preserved below ---
    const targetFile = arg1;

    // ------------------------------------------------------------------
    // SyAPP_Func acceptance check — reference-independent.
    //
    // The user's file may extend either:
    //   1) class MyFunc extends SyAPP_Func { ... }        ← direct subclass
    //   2) class MyFunc extends SyAPP.Func() { ... }      ← factory subclass
    //
    // Both ultimately resolve to the SAME internal SyAPP_Func class — but
    // only if the user's file imports the exact same SyAPP.js module that
    // we are running from. When the user's file imports SyAPP from a
    // DIFFERENT path (e.g. "./SyAPP.js" vs "./._/SyAPP.js", or a symlink,
    // or a re-export), Node loads a SECOND copy of the module, producing
    // a second SyAPP_Func class. Plain `instanceof` then fails even though
    // the class is genuinely a SyAPP_Func.
    //
    // To be robust against this, we accept a class when ANY of the
    // following is true:
    //   a) it is our local SyAPP_Func,
    //   b) it is SyAPP.Func() (same thing, but kept explicit),
    //   c) its prototype chain contains a constructor named "SyAPP_Func",
    //   d) a fresh instance duck-types as a SyAPP_Func (has the methods
    //      and properties the runtime expects).
    // ------------------------------------------------------------------
    const acceptedBases = [SyAPP_Func, SyAPP.Func()];

    const extendsKnownBase = (cls) => {
      if (typeof cls !== 'function') return false;
      for (const base of acceptedBases) {
        try {
          if (cls === base) return true;
          if (base && cls.prototype instanceof base) return true;
        } catch (_) { /* try next */ }
      }
      return false;
    };

    const prototypeChainHasSyAPPFunc = (cls) => {
      if (typeof cls !== 'function') return false;
      let proto = cls.prototype;
      const seen = new Set();
      while (proto && !seen.has(proto)) {
        seen.add(proto);
        const ctor = proto.constructor;
        if (ctor && ctor.name === 'SyAPP_Func') return true;
        proto = Object.getPrototypeOf(proto);
      }
      return false;
    };

    const duckTypesAsSyAPPFunc = (cls) => {
      if (typeof cls !== 'function') return false;
      let instance;
      try {
        instance = new cls();
      } catch (_) {
        return false;
      }
      if (!instance || typeof instance !== 'object') return false;

      // Core surface every SyAPP_Func instance is expected to expose.
      const requiredProps = [
        'Name',
        'Linked',
        'Builds',
        'UserStorage',
        'Storages',
        'TextColor',
        'Build',
        'Text',
        'Button',
        'Buttons',
        'Page',
        'DropDown',
        'Pagination',
        'GotoNow',
        'SetPage',
        'WaitInput',
        'Field',
        'Alert',
        'AlertButton',
        'Admin'
      ];

      for (const prop of requiredProps) {
        if (!(prop in instance)) return false;
      }

      // Function-typed sanity checks
      if (typeof instance.Build !== 'function') return false;
      if (typeof instance.Text !== 'function') return false;
      if (typeof instance.Button !== 'function') return false;
      if (!(instance.Storages && typeof instance.Storages.Get === 'function' && typeof instance.Storages.Set === 'function')) {
        return false;
      }

      return true;
    };

    const isSyAPPFuncClass = (cls) => {
      return (
        extendsKnownBase(cls) ||
        prototypeChainHasSyAPPFunc(cls) ||
        duckTypesAsSyAPPFunc(cls)
      );
    };

    try {
      // Resolve the target to an absolute path (relative and absolute inputs both work).
      const absolutePath = path.isAbsolute(targetFile)
        ? targetFile
        : path.resolve(process.cwd(), targetFile);

      if (!fs.existsSync(absolutePath)) {
        console.error(ColorText.brightRed(`❌ SyAPP runner: file not found → ${targetFile}`));
        process.exit(1);
      }

      // Convert to a file:// URL so Node's ESM loader imports it identically
      // on Linux, macOS and Windows.
      const fileUrl = url.pathToFileURL(absolutePath).href;

      // Dynamically import the user's file. This preserves ALL of its own
      // imports (relative and bare), its full module graph, and any
      // SyAPP_Func subclasses it declares.
      let importedModule;
      try {
        importedModule = await import(fileUrl);
      } catch (importErr) {
        console.error(ColorText.brightRed(`❌ SyAPP runner: failed to import "${targetFile}":`));
        console.error(importErr);
        process.exit(1);
      }

      // ------------------------------------------------------------------
      // Collect all exported functions and pick the first one that looks
      // like a SyAPP_Func.
      //
      // Priority:
      //   1. default export
      //   2. any named export
      //   3. nested keys inside a plain-object default export
      // ------------------------------------------------------------------
      const candidates = [];

      if (importedModule) {
        if (importedModule.default !== undefined && importedModule.default !== null) {
          candidates.push({ name: 'default', value: importedModule.default });
        }
        for (const key of Object.keys(importedModule)) {
          if (key === 'default') continue;
          candidates.push({ name: key, value: importedModule[key] });
        }
      }

      let ExportedFunc = null;
      let ExportedFuncName = null;

      for (const cand of candidates) {
        let value = cand.value;

        // Descend into plain-object exports looking for common nested keys.
        if (value && typeof value !== 'function' && typeof value === 'object') {
          const nestedKeys = ['default', 'MainFunc', 'Func', 'SyAPP_Func'];
          for (const nk of nestedKeys) {
            const nested = value[nk];
            if (isSyAPPFuncClass(nested)) {
              value = nested;
              break;
            }
          }
        }

        if (isSyAPPFuncClass(value)) {
          ExportedFunc = value;
          ExportedFuncName = cand.name;
          break;
        }
      }

      if (typeof ExportedFunc !== 'function') {
        console.error(ColorText.brightRed(
          `❌ SyAPP runner: "${targetFile}" does not export a class extending SyAPP_Func.\n` +
          `   Expected one of:\n` +
          `     export default class MyFunc extends SyAPP_Func { ... }\n` +
          `     export default class MyFunc extends SyAPP.Func() { ... }\n` +
          `     export class MainFunc extends SyAPP_Func { ... }\n` +
          `     export class Func extends SyAPP_Func { ... }`
        ));
        process.exit(1);
      }

      // Boot SyAPP with the user-provided class as the main function.
      // SyAPP's constructor will:
      //   1. instantiate it as the main func,
      //   2. recursively register every Linked function it declares,
      //   3. start the terminal HUD / refresh loop / HTTP routes
      //      exactly as if it were the built-in main func.
      new SyAPP(ExportedFunc);

    } catch (err) {
      console.error(ColorText.brightRed(`❌ SyAPP runner: unexpected error while loading "${targetFile}":`));
      console.error(err);
      process.exit(1);
    }
  })();
}