import readline from 'readline';
import { stdin, stdout } from 'process';
import EventEmitter from 'events';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
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


const BuildPagination = (fullarray = [], items_per_page = 5) => {
  let pagination = [{
       page : 1,
       list : []
   }]
   pagination.splice(0,1)
   
   let object_model = {}
   let count = 0
   let type = typeof fullarray[0]
   

   fullarray.forEach((t,index) => {
       if (count == 0) {
           if(index == 0){
               type = typeof t
               if(typeof t == 'object'){
                   object_model = t
               }
           }
           if(typeof t == type){
               if(typeof t == 'object'){
                  let fullinclude = true
                  Object.keys(t).forEach(k => {
                      if(!Object.keys(object_model).includes(k)){
                          fullinclude = false
                      }
                  })
                   if(fullinclude){
                       pagination.push({ page: pagination.length + 1, list: [] })
                   pagination[pagination.length - 1].list.push(t)
                   count += 1
                   }
               } else {
                  pagination.push({ page: pagination.length + 1, list: [] })
                   pagination[pagination.length - 1].list.push(t)
                   count += 1
               }
               
           }
           
       } else {
           if(typeof t == type){
               if(typeof t == 'object'){
                  let fullinclude = true
                  Object.keys(t).forEach(k => {
                      if(!Object.keys(object_model).includes(k)){
                          fullinclude = false
                      }
                  })
                   if(fullinclude){
                   pagination[pagination.length - 1].list.push(t)
                   count += 1
                   }
               } else {
                   pagination[pagination.length - 1].list.push(t)
                   count += 1
               }
           }
       }
       
       if (count == items_per_page) { count = 0 }
   })
return pagination
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
    : this.displayMenuWithArrows(menuTitle, menu.options, configuration, finalIndex);
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
      const normalizedOptions = this.normalizeOptions(options);
      if (configuration.clear) console.clear();

      let { line, column } = this.getCoordinatesFromLinearIndex(normalizedOptions, initialIndex);

      const renderMenu = () => {
        console.clear();
        if (question) console.log(`${question}\n`);
        normalizedOptions.forEach((lineOptions, lineIndex) => {
          let lineString = lineOptions.map((option, columnIndex) => {
            let text;
            if (option.type === 'field') {
                const maxLen = this.fieldMaxWidth || 20;
                let val = '';
                const label = option.label || '';
                if (this.isEditing && lineIndex === line && columnIndex === column && this.activeField) {
                    val = this.activeField.value;
                    const blink = (Math.floor(Date.now() / 500) % 2 === 0) ? '█' : ' ';
                    const truncated = val.length > maxLen ? val.slice(-maxLen) : val;  // show end while editing
                    text = label ? `${label}: ░${truncated}${blink}░` : `░${truncated}${blink}░`;
                } else {
                    val = option.value || '';
                    const truncated = val.length > maxLen ? val.slice(0, maxLen) : val;  // show beginning when not editing
                    text = label ? `${label}: ░${truncated}░` : `░${truncated}░`;
                }
            } else {
                text = typeof option === 'string' ? option : option.name || JSON.stringify(option);
            }
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

      const setFocus = (newLine, newColumn) => {
        line = newLine;
        column = newColumn;
        
        // Store the focused index for remember functionality
        this.lastFocusedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, newLine, newColumn);
        
        // Emit menu navigation event
        this.emitEvent(this.eventTypes.MENU_NAVIGATION, {
          line: newLine,
          column: newColumn,
          linearIndex: this.lastFocusedIndex,  // Use the stored value
          question
        });
        
        renderMenu();
      };

      const selectOption = async (selectionSource = 'mouse') => {
        // Prevent multiple simultaneous selections
        if (this.isClickInProgress) return;
        
        this.isClickInProgress = true;
        
        // Get selected item before cleanup
        // Check if the selected option is a field
        const selectedOption = normalizedOptions[line] && normalizedOptions[line][column];
        if (selectedOption && selectedOption.type === 'field') {
            // Enter editing mode with raw input handling
            this.startFieldEditing(selectedOption, line, column, renderMenu);
            setFocus(line, column);            // keep highlight on the field
            renderMenu();
            return;
        }

this.lastSelectedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, line, column);
        const selected = normalizedOptions[line][column];
        
        // Emit menu selection event with data
        const selectionEventData = {
          index: this.lastSelectedIndex,
          line,
          column,
          selected: this.getOptionDataForEvent(selected),
          question,
          source: selectionSource
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
        
        // Clean up menu state immediately
        this.cleanupMenuState();
        
        try {
          if (selected?.action) {
            // Execute the action
            const result = selected.action();
            if (result instanceof Promise) {
              await result;
            }
          }
          
          // Return the selected item for resolution
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
        
        // Emit key press event for menu
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
          case 'up':
            if (line > 0) line--;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            setFocus(line, column);
            break;
          case 'down':
            if (line < normalizedOptions.length - 1) line++;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            setFocus(line, column);
            break;
          case 'left':
            if (column > 0) column--;
            setFocus(line, column);
            break;
          case 'right':
            if (column < normalizedOptions[line].length - 1) column++;
            setFocus(line, column);
            break;
          case 'return':
            await selectOption('keyboard');
            return;
          case 'c':
            if (key.ctrl) {
              this.cleanupMenuState();
              process.exit();
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
        currentColumn: column
      };

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
      // Handle array of options (already flattened)
      const line = option.map(item => 
        typeof item === 'string' ? { name: item } : item
      );
      result.push(line);
    } else if (option?.type === 'options') {
      // Handle options group - flatten it into the current line
      const line = option.value.map(item => 
        typeof item === 'string' ? { name: item } : item
      );
      result.push(line);
    } else {
      // Single option
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
    let startRow = 0;
    if (question) {
      const questionLines = question.split('\n').length;
      startRow += questionLines + 1;
    }

    for (let row = 0; row < normalizedOptions.length; row++) {
      const actualRow = startRow + row;
      
      if (actualRow === terminalY) {
        let currentColumn = 0;
        for (let column = 0; column < normalizedOptions[row].length; column++) {
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
        break;
      }
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
   */
  constructor(name, build = async (props = { session: new Session }) => { }, config = {
    routes: [{ name: '', stream: false, method: '', input_model: {}, output_model: {}, input_validate: {} }],
    userid_only: false,
    log: false,
    linked: [],
    group: '',
    refreshMode: null,
    onEnter: undefined,
    onEnterOnce: false
  }) {
    /** @type {string} */
    this.Name = name
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
      lockKey: undefined
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

  // Search configuration with defaults
  let searchConfig = {
    mode: config.searchConfig?.mode || 'both',
    keyWeight: config.searchConfig?.keyWeight || 0.7,
    valueWeight: config.searchConfig?.valueWeight || 0.3,
    minSimilarity: config.searchConfig?.minSimilarity || 0.3
  };

  // Load saved search config from storage if exists
  const savedMode = this.Storages.Get(id, searchModeKey);
  const savedKeyWeight = this.Storages.Get(id, searchKeyWeightKey);
  const savedValueWeight = this.Storages.Get(id, searchValueWeightKey);
  const savedMinSimilarity = this.Storages.Get(id, searchMinSimilarityKey);

  if (savedMode) searchConfig.mode = savedMode;
  if (savedKeyWeight !== undefined && savedKeyWeight !== null) searchConfig.keyWeight = savedKeyWeight;
  if (savedValueWeight !== undefined && savedValueWeight !== null) searchConfig.valueWeight = savedValueWeight;
  if (savedMinSimilarity !== undefined && savedMinSimilarity !== null) searchConfig.minSimilarity = savedMinSimilarity;

  if (!this.Storages.Has(id, storageKey)) {
    this.Storages.Set(id, storageKey, {
      data: null,
      path: [],
      searchResults: null,
      searchPath: [],
      filePath: null,
      searchQuery: ''
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
      // Perform search with weighted similarity
      const searchIndex = this.Storages.Get(id, searchIndexKey);
      storage.searchResults = weightedSearchJSON(
        storage.data, 
        storage.searchQuery.trim(),
        searchIndex,
        searchConfig
      );
      storage.searchPath = [];
      
      // Only reset pagination if the search query actually changed
      if (searchQueryChanged) {
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
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        storage.data = data;
        storage.filePath = filePath;

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
          return itemPath.toLowerCase().endsWith('.json');
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
        if (typeof seg === 'number') {
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

            this.Button(id, {
              name: `${this.TextColor.brightBlue(`#${itemData.globalIndex + 1}`)} ${item.type === 'key' ? '🔑' : '📝'} ${abbreviateText(item.path, maxTextLength)}${matchInfo}${similarity}`,
              props: { [`${storageKey}_navigate`]: itemData.globalIndex }
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
      const keys = Object.keys(currentNode);
      this.Text(id, `${this.TextColor.magenta('🔑')} Object (${keys.length} keys)`);

      if (keys.length === 0) {
        this.Text(id, `${this.TextColor.dim('(empty object)')}`);
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
              const keyDisplay = abbreviateText(key, Math.floor(maxTextLength / 2));
              const valuePreview = getValuePreview(value, Math.floor(maxTextLength / 2));

              this.Button(id, {
                name: `${this.TextColor.cyan(keyDisplay)}: ${this.TextColor.dim(valuePreview)}`,
                props: { [`${storageKey}_navigate`]: key }
              });
            }
          }
        );
      }
    } else {
      const valueStr = String(currentNode);
      this.Text(id, `${this.TextColor.brightGreen('💎')} Value: ${this.TextColor.bold(valueStr)}`);
    }

  } else if (Array.isArray(currentNode)) {
    // Array display
    this.Text(id, `${this.TextColor.yellow('📚')} Array (${currentNode.length} items)`);

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
    // Object display
    const keys = Object.keys(currentNode);
    this.Text(id, `${this.TextColor.magenta('🔑')} Object (${keys.length} keys)`);

    if (keys.length === 0) {
      this.Text(id, `${this.TextColor.dim('(empty object)')}`);
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
            const keyDisplay = abbreviateText(key, Math.floor(maxTextLength / 2));
            const valuePreview = getValuePreview(value, Math.floor(maxTextLength / 2));

            let buttonName = `${this.TextColor.cyan(keyDisplay)}: ${this.TextColor.dim(valuePreview)}`;

            if (typeof value === 'string' && value.length > maxTextLength) {
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
    // Primitive display
    const valueStr = typeof currentNode === 'string' ? currentNode : String(currentNode);
    const isLong = valueStr.length > maxTextLength;

    this.Text(id, `${this.TextColor.brightGreen('💎')} Value:`);

    if (isLong) {
      this.Text(id, abbreviateText(valueStr, maxTextLength));
      this.Text(id, ' ');
      this.Text(id, `${this.TextColor.brightYellow('📖 Full Content:')}`);

      const wrapWidth = 70;
      for (let i = 0; i < valueStr.length; i += wrapWidth) {
        this.Text(id, valueStr.substring(i, i + wrapWidth));
      }
    } else {
      this.Text(id, this.TextColor.bold(valueStr));
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
    
            // Page indicator
            const indicatorText = custom.pageIndicatorText || 
                                 `${storage.actual_page} / ${totalPages}`;
            navButtons.push({
              name: indicatorText,
              props: {}
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
     * Create a button
     * @param {string} id - User/build ID
     * @param {string|Object} nameOrConfig - Button name or configuration object
     * @param {Object} [config] - Button configuration (when name is string)
     * @param {string} [config.name] - Button name
     * @param {string} [config.path] - Navigation path
     * @param {Object} [config.props] - Button props
     * @param {boolean} [config.resetSelection] - Reset selection
     * @param {number|boolean} [config.jumpTo] - Jump to index
     * @param {Function} [config.action] - Button action
     * @param {...*} rest - Additional arguments
     */
    this.Button = (id, nameOrConfig, config = {}, ...rest) => {
      if (this.Builds.has(id)) {
        let finalConfig;

        if (typeof nameOrConfig === 'string') {
          finalConfig = {
            name: nameOrConfig,
            ...config
          };

          if (rest.length > 0) {
            Object.assign(finalConfig, ...rest);
          }
        } else {
          finalConfig = nameOrConfig || {};
        }

        if (!finalConfig.path) { finalConfig.path = this.Name; }

        let button_obj = {
          name: finalConfig.name || '',
          metadata: {
            props: finalConfig.props || {},
            path: finalConfig.path || this.Name,
            resetSelection: finalConfig.resetSelection || false,
            jumpTo: finalConfig.jumpTo || false
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

        if (this.Builds.get(id).dropdown_horizontal &&
          this.Builds.get(id).last_dropdown_button !== undefined) {

          const buttonsArray = this.Builds.get(id).Buttons;
          const lastDropdownIndex = this.Builds.get(id).last_dropdown_button;

          let foundGroup = false;

          for (let i = lastDropdownIndex + 1; i < buttonsArray.length; i++) {
            if (buttonsArray[i].type === 'options') {
              buttonsArray[i].value.push(button_obj);
              foundGroup = true;
              break;
            }
          }

          if (!foundGroup) {
            if (lastDropdownIndex >= 0 && lastDropdownIndex < buttonsArray.length) {
              const dropdownButton = buttonsArray[lastDropdownIndex];

              if (!dropdownButton.type) {
                const newGroup = {
                  type: 'options',
                  value: [dropdownButton, button_obj]
                };
                buttonsArray[lastDropdownIndex] = newGroup;
              } else if (dropdownButton.type === 'options') {
                dropdownButton.value.push(button_obj);
              }
            }
          }

        } else if (finalConfig.buttons) {
          const buttonsArray = this.Builds.get(id).Buttons;
          if (buttonsArray.length === 0 || !buttonsArray[buttonsArray.length - 1].type) {
            buttonsArray.push({ type: 'options', value: [button_obj] });
          } else if (buttonsArray[buttonsArray.length - 1].type === 'options') {
            buttonsArray[buttonsArray.length - 1].value.push(button_obj);
          } else {
            buttonsArray.push({ type: 'options', value: [button_obj] });
          }
        } else {
          this.Builds.get(id).Buttons.push(button_obj);
        }
      } else {
        if (this.Log) {
          console.log(`This.Button() Error - userBuild not founded | BuildID: ${id}`);
        }
      }
    };

    /**
     * Create multiple buttons
     * @param {string} id - User/build ID
     * @param {Array<Object>|Object} configs - Button configurations
     */
    this.Buttons = (id, configs = []) => {
      if (!Array.isArray(configs)) {
        configs = [configs];
      }
      configs.forEach(config => {
        this.Button(id, {
          ...config,
          buttons: true
        });
      });
    };

    /**
     * Create a side button
     * @param {string} id - User/build ID
     * @param {Object} config - Button configuration
     */
    this.SideButton = (id, config = {}) => {
      this.Button(id, {
        ...config,
        buttons: true
      });
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
        if (this.Builds.get(id).Text != '') {
          this.Builds.get(id).Text = `${this.Builds.get(id).Text}\n${text}`
        } else {
          this.Builds.get(id).Text = text
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
            onChange: (newValue) => {
                this.Storages.Set(id, storageKey, newValue);
                if (typeof config.onChange === 'function') {
                    config.onChange(newValue);
                }
            }
        };

        // Add it as an item in the current build, similar to a button but with type 'field'
        this.Builds.get(id).Buttons.push(fieldObj);
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

        this.JSON(uid)
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

    // Initialize admin manager with main session as admin
    /** @type {AdminManager} */
    this._adminManager = new AdminManager(this, this.MainSessionID);

    // Store refresh interval for admin stats
    this._refreshInterval = userConfig.RefreshInterval || 500;

    // Store global refresh mode setting
    this.GlobalRefreshMode = userConfig.RefreshMode !== false; // true by default if not set to false

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
      
      const intervalId = setInterval(() => {
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
    if (this.GlobalRefreshMode) {
      this.Refresher = setInterval(async () => {  
        let sessions = [...this.Sessions.keys()]
        
        sessions.forEach(k => {
          const session = this.Sessions.get(k);
          const currentFuncName = session.ActualPath;
          
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
        
        // Check if this is a refresh request and if the function allows it
        const isRefreshRequest = config.props._isRefresh === true;
        if (isRefreshRequest) {
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

    if (!this.serverConfig.enableHTTP) {
      this.LoadScreen();
    }
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

// If this file is run directly, execute the CLI with HTTP disabled by default
if (import.meta.url === `file://${process.argv[1]}`) {
  new SyAPP()
}