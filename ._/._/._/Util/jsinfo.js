import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, chmodSync } from 'fs';
import { resolve, extname, join, basename } from 'path';
import { tmpdir } from 'os';

/**
 * Counts unique variations of imported native Node.js modules in JavaScript code
 */
function countNativeModuleImports(code) {
    const nativeModules = new Set([
        'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
        'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
        'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
        'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
        'process', 'punycode', 'querystring', 'readline', 'repl',
        'stream', 'string_decoder', 'timers', 'tls', 'trace_events',
        'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
        'zlib', 'fs/promises', 'timers/promises', 'stream/promises',
        'stream/consumers', 'stream/web', 'dns/promises', 'readline/promises'
    ]);

    const importVariations = {};
    
    // Pattern 1: import default from 'module'
    const pattern1 = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
    // Pattern 2: import { named } from 'module'
    const pattern2 = /import\s*{([^}]+)}\s*from\s+['"]([^'"]+)['"]/g;
    // Pattern 3: import * as name from 'module'
    const pattern3 = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
    // Pattern 4: import 'module'
    const pattern4 = /import\s+['"]([^'"]+)['"]/g;
    // Pattern 5: dynamic import()
    const pattern5 = /import\(['"]([^'"]+)['"]\)/g;

    // Process pattern 1: import default from 'module'
    let match;
    while ((match = pattern1.exec(code)) !== null) {
        const importVariation = `import ${match[1]}`;
        const moduleName = match[2];
        checkAndAddVariation(moduleName, importVariation, nativeModules, importVariations);
    }

    // Process pattern 2: import { named } from 'module'
    while ((match = pattern2.exec(code)) !== null) {
        const importedBindings = match[1].trim();
        const importVariation = `import { ${importedBindings} }`;
        const moduleName = match[2];
        checkAndAddVariation(moduleName, importVariation, nativeModules, importVariations);
    }

    // Process pattern 3: import * as name from 'module'
    while ((match = pattern3.exec(code)) !== null) {
        const importVariation = `import * as ${match[1]}`;
        const moduleName = match[2];
        checkAndAddVariation(moduleName, importVariation, nativeModules, importVariations);
    }

    // Process pattern 4: import 'module'
    while ((match = pattern4.exec(code)) !== null) {
        const importVariation = 'import (side effect)';
        const moduleName = match[1];
        checkAndAddVariation(moduleName, importVariation, nativeModules, importVariations);
    }

    // Process pattern 5: dynamic import()
    while ((match = pattern5.exec(code)) !== null) {
        const importVariation = 'import() (dynamic)';
        const moduleName = match[1];
        checkAndAddVariation(moduleName, importVariation, nativeModules, importVariations);
    }

    return importVariations;
}

function checkAndAddVariation(moduleName, importVariation, nativeModules, importVariations) {
    for (const nativeModule of nativeModules) {
        if (moduleName === nativeModule || moduleName === `node:${nativeModule}`) {
            const cleanModuleName = moduleName.replace(/^node:/, '');
            
            if (!importVariations[cleanModuleName]) {
                importVariations[cleanModuleName] = new Set();
            }
            
            importVariations[cleanModuleName].add(importVariation);
            break;
        }
    }
}

/**
 * Extracts unique interfaces and methods used in the code with their module context
 */
function extractInterfacesAndMethods(code, importVariations) {
    const interfaces = {};
    
    // Create a map to track which methods belong to which imports
    const importBindings = new Map();
    
    // Extract default imports: import http from 'http'
    const defaultImportPattern = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = defaultImportPattern.exec(code)) !== null) {
        importBindings.set(match[1], match[2].replace(/^node:/, ''));
    }
    
    // Extract namespace imports: import * as http from 'http'
    const namespaceImportPattern = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = namespaceImportPattern.exec(code)) !== null) {
        importBindings.set(match[1], match[2].replace(/^node:/, ''));
    }
    
    // Extract named imports and track them
    const namedImportPattern = /import\s*{([^}]+)}\s*from\s+['"]([^'"]+)['"]/g;
    while ((match = namedImportPattern.exec(code)) !== null) {
        const bindings = match[1].split(',').map(b => {
            const parts = b.trim().split(/\s+as\s+/);
            return parts[parts.length - 1].trim();
        });
        const moduleName = match[2].replace(/^node:/, '');
        bindings.forEach(binding => {
            importBindings.set(binding, moduleName);
        });
    }
    
    // Find method calls on imported objects
    const methodCallPattern = /(\w+)\.(\w+)\s*\(/g;
    while ((match = methodCallPattern.exec(code)) !== null) {
        const objectName = match[1];
        const methodName = match[2];
        
        if (importBindings.has(objectName)) {
            const moduleName = importBindings.get(objectName);
            if (!interfaces[moduleName]) {
                interfaces[moduleName] = new Set();
            }
            interfaces[moduleName].add(methodName);
        }
    }
    
    // Find property access on imported objects
    const propAccessPattern = /(\w+)\.(\w+)(?=\s*[=;,)\s])/g;
    while ((match = propAccessPattern.exec(code)) !== null) {
        const objectName = match[1];
        const propName = match[2];
        
        if (importBindings.has(objectName) && propName !== 'prototype') {
            const moduleName = importBindings.get(objectName);
            if (!interfaces[moduleName]) {
                interfaces[moduleName] = new Set();
            }
            interfaces[moduleName].add(propName);
        }
    }
    
    // Direct usage of imported methods/functions
    importBindings.forEach((moduleName, binding) => {
        if (binding.match(/^[a-z]/)) { // Likely a function/method
            const directUsagePattern = new RegExp(`\\b${binding}\\s*\\(`, 'g');
            while ((match = directUsagePattern.exec(code)) !== null) {
                if (!interfaces[moduleName]) {
                    interfaces[moduleName] = new Set();
                }
                interfaces[moduleName].add(`${binding}()`);
            }
        }
    });
    
    return interfaces;
}

/**
 * Get all .js files from a path (file or directory)
 */
function getJSFiles(inputPath) {
    const files = [];
    const resolvedPath = resolve(inputPath);

    if (!existsSync(resolvedPath)) {
        console.error(`Path not found: ${inputPath}`);
        return files;
    }

    try {
        const stats = statSync(resolvedPath);

        if (stats.isFile() && extname(resolvedPath) === '.js') {
            files.push(resolvedPath);
        } else if (stats.isDirectory()) {
            const dirFiles = readdirSync(resolvedPath);
            dirFiles.forEach(file => {
                const fullPath = join(resolvedPath, file);
                try {
                    const fileStats = statSync(fullPath);
                    if (fileStats.isFile() && extname(file) === '.js') {
                        files.push(fullPath);
                    } else if (fileStats.isDirectory()) {
                        // Recursively get files from subdirectories
                        files.push(...getJSFiles(fullPath));
                    }
                } catch (err) {
                    // Skip files that can't be read
                }
            });
        }
    } catch (error) {
        console.error(`Error processing path ${inputPath}: ${error.message}`);
    }

    return files;
}

/**
 * Generate shell script that creates directory structure in /tmp/jsinfo/
 */
function generateShellScript(allResults) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const scriptName = `generate-jsinfo-${timestamp}.sh`;
    const baseDir = '/tmp/jsinfo';
    
    let scriptContent = '#!/bin/bash\n\n';
    scriptContent += `# Generated by Node.js Interface Analyzer\n`;
    scriptContent += `# Generated at: ${new Date().toISOString()}\n`;
    scriptContent += `# Total files analyzed: ${allResults.length}\n`;
    scriptContent += `# This script creates a directory structure in ${baseDir}\n\n`;
    
    scriptContent += `BASE_DIR="${baseDir}"\n`;
    scriptContent += `TIMESTAMP="${timestamp}"\n`;
    scriptContent += `TARGET_DIR="$BASE_DIR/$TIMESTAMP"\n\n`;
    
    scriptContent += `echo "Creating interface directory structure in $TARGET_DIR..."\n`;
    scriptContent += `mkdir -p "$TARGET_DIR"\n\n`;
    
    // Aggregate all unique interfaces across all files
    const moduleInterfaces = {};
    const moduleVariations = {};
    
    allResults.forEach(({ file, importVariations, interfaces }) => {
        // Aggregate import variations
        Object.entries(importVariations).forEach(([moduleName, variations]) => {
            if (!moduleVariations[moduleName]) {
                moduleVariations[moduleName] = new Set();
            }
            variations.forEach(v => moduleVariations[moduleName].add(v));
        });
        
        // Aggregate interfaces per module
        Object.entries(interfaces).forEach(([moduleName, methods]) => {
            if (!moduleInterfaces[moduleName]) {
                moduleInterfaces[moduleName] = new Map();
            }
            
            methods.forEach(method => {
                // Split method by dots to create hierarchy
                const parts = method.split('.');
                let currentMap = moduleInterfaces[moduleName];
                
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!currentMap.has(parts[i])) {
                        currentMap.set(parts[i], new Map());
                    }
                    currentMap = currentMap.get(parts[i]);
                }
                
                if (!currentMap.has('__methods__')) {
                    currentMap.set('__methods__', new Set());
                }
                currentMap.get('__methods__').add(parts[parts.length - 1]);
            });
        });
    });
    
    // Generate directory creation commands
    scriptContent += `# Create module directories\n`;
    
    Object.entries(moduleInterfaces).forEach(([moduleName, methods]) => {
        const safeModuleName = moduleName.replace(/\//g, '_');
        const moduleDir = `$TARGET_DIR/${safeModuleName}`;
        
        scriptContent += `echo "Creating structure for module: ${moduleName}"\n`;
        scriptContent += `mkdir -p "${moduleDir}"\n`;
        
        // Create hierarchical directories
        function createDirectories(map, currentPath) {
            map.forEach((value, key) => {
                if (key !== '__methods__') {
                    const newPath = `${currentPath}/${key}`;
                    scriptContent += `mkdir -p "${newPath}"\n`;
                    createDirectories(value, newPath);
                }
            });
        }
        
        createDirectories(methods, moduleDir);
        
        // Create method files
        function createMethodFiles(map, currentPath) {
            map.forEach((value, key) => {
                if (key === '__methods__') {
                    value.forEach(method => {
                        const methodFile = `${currentPath}/${method}.method`;
                        scriptContent += `echo "# Method: ${method}" > "${methodFile}"\n`;
                    });
                } else {
                    const newPath = `${currentPath}/${key}`;
                    createMethodFiles(value, newPath);
                }
            });
        }
        
        createMethodFiles(methods, moduleDir);
        
        // Create README.md for each module
        scriptContent += `cat > "${moduleDir}/README.md" << 'EOF'\n`;
        scriptContent += `# Module: ${moduleName}\n\n`;
        scriptContent += `## Import Variations\n`;
        
        const variations = moduleVariations[moduleName];
        if (variations) {
            variations.forEach(v => {
                scriptContent += `- \`${v}\`\n`;
            });
        }
        
        scriptContent += `\n## Interfaces & Methods\n\n`;
        scriptContent += '```\n';
        
        function generateTree(map, prefix = '') {
            map.forEach((value, key) => {
                if (key !== '__methods__') {
                    scriptContent += `${prefix}├── ${key}/\n`;
                    generateTree(value, prefix + '│   ');
                }
            });
            
            if (map.has('__methods__')) {
                const methods = Array.from(map.get('__methods__')).sort();
                methods.forEach((method, index) => {
                    const isLast = index === methods.length - 1 && 
                        Array.from(map.keys()).filter(k => k !== '__methods__').length === 0;
                    scriptContent += `${prefix}${isLast ? '└── ' : '├── '}${method}()\n`;
                });
            }
        }
        
        generateTree(methods);
        scriptContent += '```\n';
        scriptContent += 'EOF\n\n';
    });
    
    // Create root README.md
    scriptContent += `# Create root README\n`;
    scriptContent += `cat > "$TARGET_DIR/README.md" << 'EOF'\n`;
    scriptContent += `# Node.js Interface Analysis\n\n`;
    scriptContent += `Generated at: $(date)\n`;
    scriptContent += `Total files analyzed: ${allResults.length}\n\n`;
    scriptContent += `## Module Structure\n\n`;
    scriptContent += '```\n';
    
    Object.entries(moduleInterfaces).forEach(([moduleName, methods]) => {
        const safeModuleName = moduleName.replace(/\//g, '_');
        scriptContent += `${safeModuleName}/\n`;
        
        function generateRootTree(map, prefix = '    ') {
            map.forEach((value, key) => {
                if (key !== '__methods__') {
                    scriptContent += `${prefix}├── ${key}/\n`;
                    generateRootTree(value, prefix + '│   ');
                }
            });
        }
        
        generateRootTree(methods);
    });
    
    scriptContent += '```\n';
    scriptContent += 'EOF\n\n';
    
    // Summary
    scriptContent += `echo ""\n`;
    scriptContent += `echo "✅ Directory structure created successfully!"\n`;
    scriptContent += `echo "📍 Location: $TARGET_DIR"\n`;
    scriptContent += `echo ""\n`;
    scriptContent += `echo "Modules analyzed:"\n`;
    
    Object.entries(moduleInterfaces).forEach(([moduleName, methods]) => {
        let totalMethods = 0;
        function countMethods(map) {
            map.forEach((value, key) => {
                if (key === '__methods__') {
                    totalMethods += value.size;
                } else {
                    countMethods(value);
                }
            });
        }
        countMethods(methods);
        
        scriptContent += `echo "  📦 ${moduleName}: ${totalMethods} methods/interfaces"\n`;
    });
    
    scriptContent += `echo ""\n`;
    scriptContent += `echo "To explore: cd $TARGET_DIR && find . -type f | sort"\n`;
    
    writeFileSync(scriptName, scriptContent, 'utf8');
    
    // Make the script executable
    try {
        chmodSync(scriptName, '755');
        console.log(`✅ Script made executable`);
    } catch (error) {
        console.log('Note: Could not make script executable automatically.');
        console.log(`Run: chmod +x ${scriptName}`);
    }
    
    return scriptName;
}

/**
 * Print results to console
 */
function printResults(importVariations, interfaces) {
    if (Object.keys(importVariations).length === 0) {
        console.log('   No native Node.js module imports found.');
        return;
    }

    let totalUniqueVariations = 0;
    
    Object.entries(importVariations).sort().forEach(([moduleName, variations]) => {
        const uniqueCount = variations.size;
        totalUniqueVariations += uniqueCount;
        
        console.log(`   📦 ${moduleName}:`);
        console.log(`      Unique variations: ${uniqueCount}`);
        console.log('      Variations:');
        variations.forEach(variation => {
            console.log(`        • ${variation}`);
        });
        
        if (interfaces[moduleName]) {
            const methods = interfaces[moduleName];
            console.log(`      Methods/Interfaces (${methods.size}):`);
            Array.from(methods).sort().forEach(method => {
                console.log(`        - ${method}`);
            });
        }
    });

    console.log(`   📊 Total unique variations: ${totalUniqueVariations}`);
}

// Main execution
function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.error('❌ Please provide at least one .js file or directory');
        console.log('Usage: node jsinfo.js [--sh] <file1.js> <file2.js> <dir1> ...');
        console.log('  --sh    Generate shell script that creates interface structure in /tmp/jsinfo/');
        process.exit(1);
    }

    const generateSh = args.includes('--sh');
    const paths = args.filter(arg => arg !== '--sh');
    
    if (paths.length === 0) {
        console.error('❌ Please provide at least one file or directory path');
        process.exit(1);
    }

    // Collect all JS files
    const allJSFiles = [];
    paths.forEach(inputPath => {
        const files = getJSFiles(inputPath);
        allJSFiles.push(...files);
    });

    if (allJSFiles.length === 0) {
        console.error('❌ No .js files found');
        process.exit(1);
    }

    console.log(`📁 Found ${allJSFiles.length} JavaScript file(s):`);
    allJSFiles.forEach(file => console.log(`   - ${file}`));
    console.log('');

    // Analyze all files
    const allResults = [];
    
    allJSFiles.forEach(file => {
        try {
            const code = readFileSync(file, 'utf8');
            const importVariations = countNativeModuleImports(code);
            const interfaces = extractInterfacesAndMethods(code, importVariations);
            
            console.log(`📄 Analyzing: ${basename(file)}`);
            printResults(importVariations, interfaces);
            console.log('');
            
            allResults.push({
                file: basename(file),
                importVariations,
                interfaces
            });
        } catch (error) {
            console.error(`❌ Error analyzing ${basename(file)}: ${error.message}`);
        }
    });

    // Generate shell script if --sh flag is present
    if (generateSh) {
        console.log('🔨 Generating shell script...');
        const scriptName = generateShellScript(allResults);
        console.log(`✅ Shell script generated: ${scriptName}`);
        console.log(`\n📝 To create the interface structure, run:`);
        console.log(`   ./${scriptName}`);
        console.log(`\n📍 This will create: /tmp/jsinfo/[timestamp]/`);
    }
}

// Run the main function
main();