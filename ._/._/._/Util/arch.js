#!/usr/bin/env node

import http from 'http';
import fs from 'fs/promises';
import { existsSync, statSync, readFileSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import url from 'url';

// Get directory path from command line argument
const targetDir = process.argv[2];

if (!targetDir) {
    console.error('Please provide a directory path as the first argument');
    console.error('Usage: node arch.js /path/to/directory');
    process.exit(1);
}

const absolutePath = path.resolve(targetDir);

// Check if directory exists
if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
    console.error(`Error: ${absolutePath} is not a valid directory`);
    process.exit(1);
}

const PORT = 3000;

// Check if it's a git repository
let isGitRepo = false;
let commits = [];

try {
    execSync('git rev-parse --git-dir', { cwd: absolutePath, stdio: 'ignore' });
    isGitRepo = true;
    
    const gitLog = execSync('git log --reverse --format="%H|||%s|||%ai|||%an"', {
        cwd: absolutePath,
        encoding: 'utf-8'
    });
    
    commits = gitLog.trim().split('\n').filter(line => line).map(line => {
        const [hash, message, date, author] = line.split('|||');
        return { hash, message, date, author };
    });
} catch (error) {
    // Not a git repository or no commits
}

// Function to read file content for a specific commit
function getFileContent(filePath, commitHash = null) {
    try {
        if (commitHash && isGitRepo) {
            return execSync(`git show ${commitHash}:"${filePath}"`, {
                cwd: absolutePath,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'ignore']
            });
        } else {
            const fullPath = path.join(absolutePath, filePath);
            return readFileSync(fullPath, 'utf-8');
        }
    } catch (error) {
        return null;
    }
}

// Enhanced multi-language code structure analyzer
function analyzeFileStructure(filePath, commitHash = null) {
    const content = getFileContent(filePath, commitHash);
    if (!content) return null;
    
    const lines = content.split('\n');
    const ext = path.extname(filePath).toLowerCase();
    
    const structure = {
        totalLines: lines.length,
        emptyLines: 0,
        commentLines: 0,
        codeLines: 0,
        imports: [],
        exports: [],
        functions: [],
        classes: [],
        interfaces: [],
        types: [],
        enums: [],
        constants: [],
        variables: [],
        controlStructures: [],
        decorators: [],
        errorHandlers: [],
        asyncStructures: [],
        reactComponents: [],
        hooks: [],
        testSuites: [],
        databaseQueries: [],
        apiEndpoints: [],
        complexity: {
            cyclomaticComplexity: 1,
            nestingDepth: 0,
            maxNestingDepth: 0
        },
        dependencies: new Set(),
        languageFeatures: new Set()
    };
    
    let currentNestingDepth = 0;
    let inMultilineComment = false;
    let inString = false;
    let stringChar = '';
    let inTemplateLiteral = false;
    let bracketStack = [];
    
    lines.forEach((line, index) => {
        const trimmed = line.trim();
        const lineNum = index + 1;
        let lineProcessed = false;
        
        // Track nesting depth
        const openBraces = (trimmed.match(/[{[(]/g) || []).length;
        const closeBraces = (trimmed.match(/[}\])]/g) || []).length;
        currentNestingDepth += openBraces - closeBraces;
        structure.complexity.maxNestingDepth = Math.max(structure.complexity.maxNestingDepth, currentNestingDepth);
        
        // Handle multiline comments
        if (inMultilineComment) {
            structure.commentLines++;
            if (trimmed.includes('*/')) {
                inMultilineComment = false;
            }
            return;
        }
        
        // Check for multiline comment start
        if (trimmed.startsWith('/*') || trimmed.startsWith('/**')) {
            structure.commentLines++;
            if (!trimmed.includes('*/')) {
                inMultilineComment = true;
            }
            return;
        }
        
        // Empty lines
        if (trimmed === '') {
            structure.emptyLines++;
            return;
        }
        
        // Single line comments
        if (trimmed.startsWith('//') || trimmed.startsWith('#') || 
            trimmed.startsWith(';') || trimmed.startsWith('--') ||
            trimmed.startsWith('<!--')) {
            structure.commentLines++;
            return;
        }
        
        // Language-specific comment detection
        if (detectLanguageComment(trimmed, ext)) {
            structure.commentLines++;
            return;
        }
        
        // Shebang line
        if (lineNum === 1 && trimmed.startsWith('#!')) {
            structure.commentLines++;
            return;
        }
        
        // Import/Require detection (multi-language)
        const importInfo = detectImport(trimmed, lineNum, ext);
        if (importInfo) {
            structure.imports.push(importInfo);
            if (importInfo.module) structure.dependencies.add(importInfo.module);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // Export detection
        const exportInfo = detectExport(trimmed, lineNum, ext);
        if (exportInfo) {
            structure.exports.push(exportInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // Decorator/Annotation detection
        const decoratorInfo = detectDecorator(trimmed, lineNum);
        if (decoratorInfo) {
            structure.decorators.push(decoratorInfo);
            structure.languageFeatures.add('decorators');
        }
        
        // Function detection (multi-language)
        const funcInfo = detectFunction(trimmed, lineNum, ext);
        if (funcInfo) {
            structure.functions.push(funcInfo);
            structure.codeLines++;
            structure.complexity.cyclomaticComplexity++;
            lineProcessed = true;
            if (funcInfo.isAsync) {
                structure.asyncStructures.push({ line: lineNum, type: 'async_function', name: funcInfo.name });
            }
        }
        
        // Arrow function detection
        const arrowFuncInfo = detectArrowFunction(trimmed, lineNum);
        if (arrowFuncInfo) {
            structure.functions.push(arrowFuncInfo);
            structure.codeLines++;
            structure.complexity.cyclomaticComplexity++;
            lineProcessed = true;
            if (arrowFuncInfo.isAsync) {
                structure.asyncStructures.push({ line: lineNum, type: 'async_arrow', name: arrowFuncInfo.name });
            }
        }
        
        // Class detection (multi-language)
        const classInfo = detectClass(trimmed, lineNum, ext);
        if (classInfo) {
            structure.classes.push(classInfo);
            structure.codeLines++;
            structure.complexity.cyclomaticComplexity++;
            lineProcessed = true;
        }
        
        // Interface/Trait detection
        const interfaceInfo = detectInterface(trimmed, lineNum, ext);
        if (interfaceInfo) {
            structure.interfaces.push(interfaceInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // Type definition detection
        const typeInfo = detectTypeDefinition(trimmed, lineNum);
        if (typeInfo) {
            structure.types.push(typeInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // Enum detection
        const enumInfo = detectEnum(trimmed, lineNum);
        if (enumInfo) {
            structure.enums.push(enumInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // Constant detection
        const constInfo = detectConstant(trimmed, lineNum, ext);
        if (constInfo) {
            structure.constants.push(constInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // Variable declaration
        const varInfo = detectVariable(trimmed, lineNum);
        if (varInfo && !lineProcessed) {
            structure.variables.push(varInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // Control structure detection
        const controlInfo = detectControlStructure(trimmed, lineNum);
        if (controlInfo) {
            structure.controlStructures.push(controlInfo);
            structure.complexity.cyclomaticComplexity++;
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // Error handling detection
        const errorInfo = detectErrorHandling(trimmed, lineNum);
        if (errorInfo) {
            structure.errorHandlers.push(errorInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // Async/Await/Promise detection
        const asyncInfo = detectAsyncPattern(trimmed, lineNum);
        if (asyncInfo) {
            structure.asyncStructures.push(asyncInfo);
        }
        
        // React component detection
        const reactInfo = detectReactComponent(trimmed, lineNum);
        if (reactInfo) {
            structure.reactComponents.push(reactInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // React Hook detection
        const hookInfo = detectReactHook(trimmed, lineNum);
        if (hookInfo) {
            structure.hooks.push(hookInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // Test suite detection
        const testInfo = detectTestSuite(trimmed, lineNum);
        if (testInfo) {
            structure.testSuites.push(testInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // Database query detection
        const dbInfo = detectDatabaseQuery(trimmed, lineNum);
        if (dbInfo) {
            structure.databaseQueries.push(dbInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        // API endpoint detection
        const apiInfo = detectApiEndpoint(trimmed, lineNum);
        if (apiInfo) {
            structure.apiEndpoints.push(apiInfo);
            structure.codeLines++;
            lineProcessed = true;
        }
        
        if (!lineProcessed) {
            structure.codeLines++;
        }
        
        // Track language features
        detectLanguageFeatures(trimmed, structure.languageFeatures);
    });
    
    // Convert Set to Array for JSON serialization
    structure.dependencies = Array.from(structure.dependencies);
    structure.languageFeatures = Array.from(structure.languageFeatures);
    
    return structure;
}

// Helper detection functions for multi-language support
function detectLanguageComment(line, ext) {
    // Python docstring
    if ((ext === '.py' || ext === '.pyw') && (line.startsWith('"""') || line.startsWith("'''"))) return true;
    // Ruby =begin
    if (ext === '.rb' && line.startsWith('=begin')) return true;
    // Lua
    if (ext === '.lua' && line.startsWith('--[[')) return true;
    // Haskell
    if (ext === '.hs' && line.startsWith('{-')) return true;
    return false;
}

function detectImport(line, lineNum, ext) {
    const patterns = [
        // JavaScript/TypeScript imports
        { regex: /^(?:import\s+(?:[\w*\s{},]*)\s+from\s+['"]([^'"]+)['"])/, type: 'es6_import', module: 1 },
        { regex: /^(?:import\s+['"]([^'"]+)['"])/, type: 'es6_side_effect', module: 1 },
        { regex: /^(?:const\s+[\w{}\s,]*=\s*require\s*\(['"]([^'"]+)['"]\))/, type: 'require', module: 1 },
        { regex: /^(?:let\s+[\w{}\s,]*=\s*require\s*\(['"]([^'"]+)['"]\))/, type: 'require', module: 1 },
        { regex: /^(?:var\s+[\w{}\s,]*=\s*require\s*\(['"]([^'"]+)['"]\))/, type: 'require', module: 1 },
        // Python imports
        { regex: /^(?:from\s+(\S+)\s+import\s+)/, type: 'python_import', module: 1 },
        { regex: /^(?:import\s+(\S+))/, type: 'python_import', module: 1 },
        // Java/Kotlin imports
        { regex: /^(?:import\s+(?:static\s+)?(\S+))/, type: 'java_import', module: 1 },
        // C# using
        { regex: /^(?:using\s+(?:static\s+)?(\S+))/, type: 'csharp_using', module: 1 },
        // Ruby require
        { regex: /^(?:require\s+['"]([^'"]+)['"])/, type: 'ruby_require', module: 1 },
        // PHP use/require/include
        { regex: /^(?:use\s+(\S+))/, type: 'php_use', module: 1 },
        { regex: /^(?:require(?:_once)?\s*\(?['"]([^'"]+)['"]\)?)/, type: 'php_require', module: 1 },
        { regex: /^(?:include(?:_once)?\s*\(?['"]([^'"]+)['"]\)?)/, type: 'php_include', module: 1 },
        // Go imports
        { regex: /^(?:import\s+["']([^"']+)["'])/, type: 'go_import', module: 1 },
        // Rust use
        { regex: /^(?:use\s+(\S+))/, type: 'rust_use', module: 1 },
        // C/C++ includes
        { regex: /^(?:#include\s+[<"]([^>"]+)[>"])/, type: 'c_include', module: 1 },
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            return {
                line: lineNum,
                type: pattern.type,
                content: line.substring(0, 150),
                module: match[pattern.module]?.split('/').pop()?.split('\\').pop() || match[pattern.module]
            };
        }
    }
    
    return null;
}

function detectExport(line, lineNum, ext) {
    const patterns = [
        { regex: /^(?:export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type|enum)\s+(\w+))/, type: 'named_export' },
        { regex: /^(?:export\s+{\s*([^}]+)\s*})/, type: 'export_list' },
        { regex: /^(?:export\s+default\s+(\w+))/, type: 'default_export' },
        { regex: /^(?:module\.exports\s*=\s*)/, type: 'commonjs_export' },
        { regex: /^(?:exports\.(\w+)\s*=)/, type: 'commonjs_named_export' },
        // Python __all__
        { regex: /^(?:__all__\s*=\s*\[)/, type: 'python_export' },
        // PHP public/protected/private
        { regex: /^(?:public\s+(?:static\s+)?function\s+(\w+))/, type: 'php_public_method' },
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            return {
                line: lineNum,
                type: pattern.type,
                content: line.substring(0, 100)
            };
        }
    }
    
    return null;
}

function detectDecorator(line, lineNum) {
    const patterns = [
        // Python decorator
        { regex: /^@(\w+)(?:\(.*\))?$/, language: 'python' },
        // JavaScript/TypeScript decorator
        { regex: /^@(\w+)(?:\(.*\))?(?:\s*$|\s+)/, language: 'javascript' },
        // Java annotation
        { regex: /^@(\w+)(?:\(.*\))?$/, language: 'java' },
        // C# attribute
        { regex: /^\[(\w+)(?:\(.*\))?\]$/, language: 'csharp' },
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            return {
                line: lineNum,
                name: match[1],
                content: line.substring(0, 100),
                language: pattern.language
            };
        }
    }
    
    return null;
}

function detectFunction(line, lineNum, ext) {
    const patterns = [
        // JavaScript/TypeScript function declaration
        { regex: /^(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/, isAsync: 1, name: 2, params: 3 },
        // Python function
        { regex: /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/, isAsync: 1, name: 2, params: 3 },
        // Java/C#/C++ method
        { regex: /^(?:public|private|protected|static|virtual|override|abstract|final|\s)*\s+[\w<>[\],\s]+\s+(\w+)\s*\(([^)]*)\)/, name: 2, params: 3 },
        // PHP function
        { regex: /^(?:public|private|protected|static)?\s*function\s+(\w+)\s*\(([^)]*)\)/, name: 1, params: 2 },
        // Ruby method
        { regex: /^def\s+(?:self\.)?(\w+)(?:\(([^)]*)\))?/, name: 1, params: 2 },
        // Go function
        { regex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(([^)]*)\)/, name: 2, params: 3 },
        // Rust function
        { regex: /^fn\s+(\w+)\s*\(([^)]*)\)/, name: 1, params: 2 },
        // Kotlin function
        { regex: /^fun\s+(\w+)\s*\(([^)]*)\)/, name: 1, params: 2 },
        // Swift function
        { regex: /^func\s+(\w+)\s*\(([^)]*)\)/, name: 1, params: 2 },
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            const funcName = match[pattern.name];
            // Skip common keywords that might match function patterns
            if (['if', 'for', 'while', 'switch', 'catch', 'with', 'class', 'interface', 'enum'].includes(funcName)) {
                continue;
            }
            return {
                line: lineNum,
                name: funcName || 'anonymous',
                type: 'function',
                params: match[pattern.params] || '',
                isAsync: pattern.isAsync ? !!match[pattern.isAsync] : false,
                content: line.substring(0, 150)
            };
        }
    }
    
    return null;
}

function detectArrowFunction(line, lineNum) {
    const patterns = [
        { regex: /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/, name: 1, params: 2, isAsync: 0 },
        { regex: /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(\w+)\s*=>/, name: 1, params: 2, isAsync: 0 },
        { regex: /^(?:async\s+)?\(([^)]*)\)\s*=>/, name: null, params: 1, isAsync: 0 },
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            return {
                line: lineNum,
                name: match[pattern.name] || 'anonymous',
                type: 'arrow_function',
                params: match[pattern.params] || '',
                isAsync: line.includes('async'),
                content: line.substring(0, 150)
            };
        }
    }
    
    return null;
}

function detectClass(line, lineNum, ext) {
    const patterns = [
        { regex: /^class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,]+))?/, name: 1, extends: 2, implements: 3 },
        { regex: /^(?:public|private|protected)?\s*class\s+(\w+)/, name: 1 },
        // Python class
        { regex: /^class\s+(\w+)(?:\(([^)]*)\))?/, name: 1, inherits: 2 },
        // PHP class
        { regex: /^(?:abstract|final)?\s*class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,]+))?/, name: 1 },
        // Ruby class
        { regex: /^class\s+(\w+)(?:\s+<\s+(\w+))?/, name: 1 },
        // Kotlin/Swift class
        { regex: /^(?:data\s+)?class\s+(\w+)(?:\s*:\s*(\w+))?/, name: 1 },
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            return {
                line: lineNum,
                name: match[pattern.name],
                type: 'class',
                extends: match[pattern.extends] || match[2] || null,
                implements: match[pattern.implements] || match[3] || null,
                content: line.substring(0, 150)
            };
        }
    }
    
    return null;
}

function detectInterface(line, lineNum, ext) {
    const patterns = [
        { regex: /^interface\s+(\w+)(?:\s+extends\s+([\w\s,]+))?/, name: 1 },
        { regex: /^(?:export\s+)?interface\s+(\w+)/, name: 1 },
        // Java interface
        { regex: /^(?:public\s+)?interface\s+(\w+)/, name: 1 },
        // PHP interface
        { regex: /^interface\s+(\w+)(?:\s+extends\s+([\w\s,]+))?/, name: 1 },
        // TypeScript type
        { regex: /^(?:export\s+)?type\s+(\w+)\s*=/, name: 1 },
        // Go interface
        { regex: /^type\s+(\w+)\s+interface/, name: 1 },
        // Rust trait
        { regex: /^trait\s+(\w+)/, name: 1 },
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            return {
                line: lineNum,
                name: match[pattern.name],
                type: 'interface',
                content: line.substring(0, 150)
            };
        }
    }
    
    return null;
}

function detectTypeDefinition(line, lineNum) {
    const patterns = [
        { regex: /^type\s+(\w+)\s*=\s*(.+)/, name: 1, definition: 2 },
        { regex: /^typedef\s+.*\s+(\w+)\s*;/, name: 1 }, // C typedef
        { regex: /^data\s+class\s+(\w+)/, name: 1 }, // Kotlin data class
        { regex: /^record\s+(\w+)/, name: 1 }, // Java record
        { regex: /^(?:export\s+)?type\s+(\w+)\s*=\s*{/, name: 1 }, // TypeScript object type
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            return {
                line: lineNum,
                name: match[pattern.name],
                type: 'type_definition',
                content: line.substring(0, 150)
            };
        }
    }
    
    return null;
}

function detectEnum(line, lineNum) {
    const patterns = [
        { regex: /^(?:export\s+)?enum\s+(\w+)/, name: 1 },
        { regex: /^(?:public\s+)?enum\s+(\w+)/, name: 1 }, // Java
        // Rust enum
        { regex: /^pub\s+enum\s+(\w+)/, name: 1 },
        // Swift enum
        { regex: /^(?:indirect\s+)?enum\s+(\w+)/, name: 1 },
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            return {
                line: lineNum,
                name: match[pattern.name],
                type: 'enum',
                content: line.substring(0, 150)
            };
        }
    }
    
    return null;
}

function detectConstant(line, lineNum, ext) {
    const patterns = [
        { regex: /^const\s+(\w+)\s*[:=]/, name: 1 },
        { regex: /^(?:public\s+)?static\s+final\s+\w+\s+(\w+)\s*=/, name: 1 }, // Java constant
        { regex: /^#define\s+(\w+)/, name: 1 }, // C/C++ define
        { regex: /^(?:public\s+)?const\s+\w+\s+(\w+)\s*=/, name: 1 }, // C# constant
        { regex: /^(\w+)\s*=\s*(?:['"].*['"]|\d+)\s*$/, name: 1 }, // Python constant (heuristic)
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            const name = match[pattern.name];
            // For Python, only detect ALL_CAPS as constants
            if (ext === '.py' && !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
                continue;
            }
            return {
                line: lineNum,
                name: name,
                type: 'constant',
                content: line.substring(0, 150)
            };
        }
    }
    
    return null;
}

function detectVariable(line, lineNum) {
    const patterns = [
        { regex: /^(?:const|let|var)\s+(\w+)\s*(?:=|:)/, name: 1 },
        { regex: /^(?:private|protected|public)?\s*(?:static\s+)?(?:final\s+)?[\w<>[\]]+\s+(\w+)\s*[=;]/, name: 1 },
        { regex: /^\$(\w+)\s*=/, name: 1 }, // PHP variable
        { regex: /^(\w+)\s*:=\s*/, name: 1 }, // Go short declaration
        { regex: /^(\w+)\s*=\s*\w+/, name: 1 }, // Python variable
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            const name = match[pattern.name];
            // Skip if it's a keyword or already detected as something else
            if (['if', 'for', 'while', 'switch', 'return', 'throw', 'new', 'delete'].includes(name)) {
                continue;
            }
            return {
                line: lineNum,
                name: name,
                type: 'variable',
                content: line.substring(0, 100)
            };
        }
    }
    
    return null;
}

function detectControlStructure(line, lineNum) {
    const patterns = [
        { regex: /^(?:}\s*else\s*{?|else\s+if\s*\(|else\s*{)/, type: 'else_if' },
        { regex: /^if\s*\(/, type: 'if_statement' },
        { regex: /^for\s*\(/, type: 'for_loop' },
        { regex: /^for\s+\w+\s+in\s+/, type: 'for_in' },
        { regex: /^for\s+\w+\s+of\s+/, type: 'for_of' },
        { regex: /^while\s*\(/, type: 'while_loop' },
        { regex: /^do\s*{/, type: 'do_while' },
        { regex: /^switch\s*\(/, type: 'switch' },
        { regex: /^case\s+/, type: 'case' },
        { regex: /^default\s*:/, type: 'default' },
        { regex: /^try\s*{/, type: 'try' },
        { regex: /^catch\s*\(/, type: 'catch' },
        { regex: /^finally\s*{/, type: 'finally' },
        { regex: /^foreach\s*\(/, type: 'foreach' },
        { regex: /^match\s*\(/, type: 'match' }, // Rust match
        { regex: /^when\s*{/, type: 'when' }, // Kotlin when
    ];
    
    for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
            return {
                line: lineNum,
                type: pattern.type,
                content: line.substring(0, 100)
            };
        }
    }
    
    return null;
}

function detectErrorHandling(line, lineNum) {
    const patterns = [
        { regex: /^throw\s+(?:new\s+)?/, type: 'throw' },
        { regex: /^raise\s+/, type: 'raise' },
        { regex: /^assert\s+/, type: 'assert' },
        { regex: /^panic\s*\(/, type: 'panic' },
        { regex: /\.catch\s*\(/, type: 'promise_catch' },
        { regex: /^except\s+/, type: 'except' },
        { regex: /^rescue\s+/, type: 'rescue' },
    ];
    
    for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
            return {
                line: lineNum,
                type: pattern.type,
                content: line.substring(0, 100)
            };
        }
    }
    
    return null;
}

function detectAsyncPattern(line, lineNum) {
    const patterns = [
        { regex: /\bawait\s+/, type: 'await' },
        { regex: /\.then\s*\(/, type: 'promise_then' },
        { regex: /\basync\s+/, type: 'async_keyword' },
        { regex: /Promise\./, type: 'promise_usage' },
        { regex: /async\s+def\s+/, type: 'async_function' },
    ];
    
    for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
            return {
                line: lineNum,
                type: pattern.type,
                content: line.substring(0, 100)
            };
        }
    }
    
    return null;
}

function detectReactComponent(line, lineNum) {
    const patterns = [
        { regex: /^(?:export\s+)?(?:default\s+)?function\s+([A-Z]\w*)\s*\(/, name: 1, type: 'functional_component' },
        { regex: /^(?:export\s+)?(?:default\s+)?class\s+([A-Z]\w*)\s+extends\s+(?:React\.)?(?:Pure)?Component/, name: 1, type: 'class_component' },
        { regex: /^(?:const|let|var)\s+([A-Z]\w*)\s*=\s*(?:React\.)?(?:memo|forwardRef|createElement)/, name: 1, type: 'memo_component' },
        { regex: /^(?:const|let|var)\s+([A-Z]\w*)\s*:\s*React\.FC/, name: 1, type: 'typescript_component' },
    ];
    
    for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
            return {
                line: lineNum,
                name: match[pattern.name],
                type: pattern.type,
                content: line.substring(0, 100)
            };
        }
    }
    
    return null;
}

function detectReactHook(line, lineNum) {
    const patterns = [
        { regex: /\buseState\s*\(/, hook: 'useState' },
        { regex: /\buseEffect\s*\(/, hook: 'useEffect' },
        { regex: /\buseContext\s*\(/, hook: 'useContext' },
        { regex: /\buseReducer\s*\(/, hook: 'useReducer' },
        { regex: /\buseCallback\s*\(/, hook: 'useCallback' },
        { regex: /\buseMemo\s*\(/, hook: 'useMemo' },
        { regex: /\buseRef\s*\(/, hook: 'useRef' },
        { regex: /\buseSelector\s*\(/, hook: 'useSelector' },
        { regex: /\buseDispatch\s*\(/, hook: 'useDispatch' },
        { regex: /\buseQuery\s*\(/, hook: 'useQuery' },
        { regex: /\buseMutation\s*\(/, hook: 'useMutation' },
        { regex: /\buseRouter\s*\(/, hook: 'useRouter' },
        { regex: /\buseForm\s*\(/, hook: 'useForm' },
        { regex: /\buseTranslation\s*\(/, hook: 'useTranslation' },
    ];
    
    for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
            return {
                line: lineNum,
                name: pattern.hook,
                type: 'hook',
                content: line.substring(0, 100)
            };
        }
    }
    
    return null;
}

function detectTestSuite(line, lineNum) {
    const patterns = [
        { regex: /^(?:it|test)\s*\(/, type: 'test_case' },
        { regex: /^describe\s*\(/, type: 'test_suite' },
        { regex: /^(?:beforeEach|afterEach|beforeAll|afterAll)\s*\(/, type: 'test_hook' },
        { regex: /^context\s*\(/, type: 'test_context' },
        { regex: /^def\s+test_/, type: 'python_test' },
        { regex: /^class\s+\w*Test/, type: 'test_class' },
        { regex: /@Test/, type: 'test_annotation' },
    ];
    
    for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
            return {
                line: lineNum,
                type: pattern.type,
                content: line.substring(0, 100)
            };
        }
    }
    
    return null;
}

function detectDatabaseQuery(line, lineNum) {
    const patterns = [
        { regex: /\b(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE|DROP TABLE)\b/i, type: 'sql_query' },
        { regex: /\b\.query\s*\(/, type: 'db_query' },
        { regex: /\b\.execute\s*\(/, type: 'db_execute' },
        { regex: /\b\.find\s*\(/, type: 'orm_find' },
        { regex: /\b\.findOne\s*\(/, type: 'orm_find_one' },
        { regex: /\b\.save\s*\(/, type: 'orm_save' },
        { regex: /\b\.create\s*\(/, type: 'orm_create' },
        { regex: /\b\.update\s*\(/, type: 'orm_update' },
        { regex: /\b\.delete\s*\(/, type: 'orm_delete' },
        { regex: /\bModel\./, type: 'orm_model' },
        { regex: /\bSchema\./, type: 'orm_schema' },
    ];
    
    for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
            return {
                line: lineNum,
                type: pattern.type,
                content: line.substring(0, 150)
            };
        }
    }
    
    return null;
}

function detectApiEndpoint(line, lineNum) {
    const patterns = [
        { regex: /\.(get|post|put|delete|patch|options|head)\s*\(/, type: 'http_method' },
        { regex: /app\.(get|post|put|delete|patch)\s*\(/, type: 'express_route' },
        { regex: /router\.(get|post|put|delete|patch)\s*\(/, type: 'router_route' },
        { regex: /@(Get|Post|Put|Delete|Patch|RequestMapping)\s*\(/, type: 'spring_route' },
        { regex: /@(app\.route|bp\.route)\s*\(/, type: 'flask_route' },
        { regex: /Route::(get|post|put|delete|patch)\s*\(/, type: 'laravel_route' },
        { regex: /fetch\s*\(/, type: 'fetch_call' },
        { regex: /axios\.(get|post|put|delete|patch)\s*\(/, type: 'axios_call' },
    ];
    
    for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
            return {
                line: lineNum,
                type: pattern.type,
                content: line.substring(0, 150)
            };
        }
    }
    
    return null;
}

function detectLanguageFeatures(line, features) {
    const featurePatterns = [
        { regex: /=>/, feature: 'arrow_functions' },
        { regex: /\?\s*\./, feature: 'optional_chaining' },
        { regex: /\?\?/, feature: 'nullish_coalescing' },
        { regex: /\.{3}/, feature: 'spread_operator' },
        { regex: /`[^`]*\$\{[^}]*\}[^`]*`/, feature: 'template_literals' },
        { regex: /\[.*\]:/, feature: 'computed_properties' },
        { regex: /async\s+/, feature: 'async_await' },
        { regex: /yield\s+/, feature: 'generators' },
        { regex: /Symbol\(/, feature: 'symbols' },
        { regex: /Proxy\(/, feature: 'proxies' },
        { regex: /Reflect\./, feature: 'reflection' },
        { regex: /Map\(/, feature: 'maps' },
        { regex: /Set\(/, feature: 'sets' },
        { regex: /WeakMap|WeakSet/, feature: 'weak_collections' },
        { regex: /class\s+/, feature: 'classes' },
        { regex: /import\s*\(/, feature: 'dynamic_imports' },
        { regex: /with\s*\(/, feature: 'with_statement' },
        { regex: /pattern\s+/, feature: 'pattern_matching' },
    ];
    
    for (const pattern of featurePatterns) {
        if (pattern.regex.test(line)) {
            features.add(pattern.feature);
        }
    }
}

// Calculate file detail map data - ENHANCED VERSION
function calculateFileDetailMapData(filePath, commitHash = null) {
    const structure = analyzeFileStructure(filePath, commitHash);
    if (!structure) return null;
    
    const nodes = [];
    const links = [];
    let id = 0;
    
    const rootId = id++;
    nodes.push({
        id: rootId,
        name: path.basename(filePath),
        type: 'file',
        path: filePath,
        depth: 0,
        size: structure.totalLines,
        childrenCount: 6 + (structure.complexity ? 1 : 0)
    });
    
    // Overview section
    const overviewId = id++;
    nodes.push({
        id: overviewId,
        name: '📊 File Overview',
        type: 'section',
        path: filePath + '#overview',
        depth: 1,
        size: structure.totalLines,
        childrenCount: 8
    });
    links.push({ source: rootId, target: overviewId, depth: 1 });
    
    // File statistics
    const stats = [
        { name: `📏 Total Lines: ${structure.totalLines}`, type: 'stat' },
        { name: `⌨️  Code Lines: ${structure.codeLines}`, type: 'stat' },
        { name: `💬 Comment Lines: ${structure.commentLines}`, type: 'stat' },
        { name: `⬜ Empty Lines: ${structure.emptyLines}`, type: 'stat' },
        { name: `📈 Code Density: ${((structure.codeLines / Math.max(1, structure.totalLines)) * 100).toFixed(1)}%`, type: 'stat' },
        { name: `💭 Comment Ratio: ${((structure.commentLines / Math.max(1, structure.codeLines + structure.commentLines)) * 100).toFixed(1)}%`, type: 'stat' },
        { name: `🧩 Language Features: ${structure.languageFeatures.length}`, type: 'stat' },
        { name: `📦 Dependencies: ${structure.dependencies.length}`, type: 'stat' }
    ];
    
    stats.forEach(stat => {
        const statId = id++;
        nodes.push({ id: statId, name: stat.name, type: stat.type, depth: 2, size: 1 });
        links.push({ source: overviewId, target: statId, depth: 2 });
    });
    
    // Complexity section
    if (structure.complexity) {
        const complexityId = id++;
        nodes.push({
            id: complexityId,
            name: '📈 Code Complexity',
            type: 'section',
            depth: 1,
            size: 3,
            childrenCount: 3
        });
        links.push({ source: rootId, target: complexityId, depth: 1 });
        
        const complexityStats = [
            `🔄 Cyclomatic: ${structure.complexity.cyclomaticComplexity}`,
            `📊 Max Nesting: ${structure.complexity.maxNestingDepth}`,
            `🏷️  Complexity Score: ${calculateComplexityScore(structure.complexity)}`
        ];
        
        complexityStats.forEach(stat => {
            const statId = id++;
            nodes.push({ id: statId, name: stat, type: 'detail', depth: 2, size: 1 });
            links.push({ source: complexityId, target: statId, depth: 2 });
        });
    }
    
    // Functions section
    if (structure.functions.length > 0) {
        const functionsId = id++;
        nodes.push({
            id: functionsId,
            name: `⚡ Functions (${structure.functions.length})`,
            type: 'section',
            depth: 1,
            size: structure.functions.length,
            childrenCount: Math.min(structure.functions.length, 15)
        });
        links.push({ source: rootId, target: functionsId, depth: 1 });
        
        structure.functions.slice(0, 15).forEach(func => {
            const funcId = id++;
            nodes.push({
                id: funcId,
                name: func.name,
                type: 'function',
                depth: 2,
                size: 1,
                line: func.line,
                params: func.params
            });
            links.push({ source: functionsId, target: funcId, depth: 2 });
        });
    }
    
    // Classes section
    if (structure.classes.length > 0) {
        const classesId = id++;
        nodes.push({
            id: classesId,
            name: `🏗️  Classes (${structure.classes.length})`,
            type: 'section',
            depth: 1,
            size: structure.classes.length,
            childrenCount: Math.min(structure.classes.length, 15)
        });
        links.push({ source: rootId, target: classesId, depth: 1 });
        
        structure.classes.slice(0, 15).forEach(cls => {
            const clsId = id++;
            nodes.push({
                id: clsId,
                name: cls.name,
                type: 'class',
                depth: 2,
                size: 1,
                line: cls.line
            });
            links.push({ source: classesId, target: clsId, depth: 2 });
        });
    }
    
    // Imports section
    if (structure.imports.length > 0) {
        const importsId = id++;
        nodes.push({
            id: importsId,
            name: `📦 Imports (${structure.imports.length})`,
            type: 'section',
            depth: 1,
            size: structure.imports.length,
            childrenCount: Math.min(structure.imports.length, 10)
        });
        links.push({ source: rootId, target: importsId, depth: 1 });
        
        // Group imports by type
        const importTypes = {};
        structure.imports.forEach(imp => {
            if (!importTypes[imp.type]) importTypes[imp.type] = [];
            importTypes[imp.type].push(imp);
        });
        
        Object.entries(importTypes).slice(0, 10).forEach(([type, imports]) => {
            const typeId = id++;
            nodes.push({
                id: typeId,
                name: `${type} (${imports.length})`,
                type: 'import_group',
                depth: 2,
                size: imports.length
            });
            links.push({ source: importsId, target: typeId, depth: 2 });
            
            imports.slice(0, 5).forEach(imp => {
                const impId = id++;
                nodes.push({
                    id: impId,
                    name: imp.module || 'unknown',
                    type: 'import',
                    depth: 3,
                    size: 1,
                    line: imp.line
                });
                links.push({ source: typeId, target: impId, depth: 3 });
            });
        });
    }
    
    // Exports section
    if (structure.exports.length > 0) {
        const exportsId = id++;
        nodes.push({
            id: exportsId,
            name: `📤 Exports (${structure.exports.length})`,
            type: 'section',
            depth: 1,
            size: structure.exports.length,
            childrenCount: Math.min(structure.exports.length, 10)
        });
        links.push({ source: rootId, target: exportsId, depth: 1 });
        
        structure.exports.slice(0, 10).forEach(exp => {
            const expId = id++;
            nodes.push({
                id: expId,
                name: exp.type,
                type: 'export',
                depth: 2,
                size: 1,
                line: exp.line
            });
            links.push({ source: exportsId, target: expId, depth: 2 });
        });
    }
    
    // React Components section
    if (structure.reactComponents.length > 0) {
        const reactId = id++;
        nodes.push({
            id: reactId,
            name: `⚛️  React Components (${structure.reactComponents.length})`,
            type: 'section',
            depth: 1,
            size: structure.reactComponents.length,
            childrenCount: structure.reactComponents.length
        });
        links.push({ source: rootId, target: reactId, depth: 1 });
        
        structure.reactComponents.forEach(comp => {
            const compId = id++;
            nodes.push({
                id: compId,
                name: comp.name,
                type: 'react_component',
                depth: 2,
                size: 1,
                line: comp.line
            });
            links.push({ source: reactId, target: compId, depth: 2 });
        });
    }
    
    // Hooks section
    if (structure.hooks.length > 0) {
        const hooksId = id++;
        nodes.push({
            id: hooksId,
            name: `🎣 Hooks (${structure.hooks.length})`,
            type: 'section',
            depth: 1,
            size: structure.hooks.length,
            childrenCount: Math.min(structure.hooks.length, 10)
        });
        links.push({ source: rootId, target: hooksId, depth: 1 });
        
        structure.hooks.slice(0, 10).forEach(hook => {
            const hookId = id++;
            nodes.push({
                id: hookId,
                name: hook.name,
                type: 'hook',
                depth: 2,
                size: 1,
                line: hook.line
            });
            links.push({ source: hooksId, target: hookId, depth: 2 });
        });
    }
    
    // Dependencies section
    if (structure.dependencies.length > 0) {
        const depsId = id++;
        nodes.push({
            id: depsId,
            name: `🔗 Dependencies (${structure.dependencies.length})`,
            type: 'section',
            depth: 1,
            size: structure.dependencies.length,
            childrenCount: Math.min(structure.dependencies.length, 10)
        });
        links.push({ source: rootId, target: depsId, depth: 1 });
        
        structure.dependencies.slice(0, 10).forEach(dep => {
            const depId = id++;
            nodes.push({
                id: depId,
                name: dep,
                type: 'dependency',
                depth: 2,
                size: 1
            });
            links.push({ source: depsId, target: depId, depth: 2 });
        });
    }
    
    return { nodes, links, structure };
}

function calculateComplexityScore(complexity) {
    const score = complexity.cyclomaticComplexity * 2 + complexity.maxNestingDepth * 3;
    if (score <= 10) return 'Low';
    if (score <= 20) return 'Medium';
    if (score <= 30) return 'High';
    return 'Very High';
}

// Function to build file tree structure
async function buildFileTree(dirPath, ignoreList = ['.git', 'node_modules', '.DS_Store']) {
    const name = path.basename(dirPath);
    const stats = statSync(dirPath);
    
    const node = {
        name,
        path: dirPath,
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.size
    };
    
    if (stats.isDirectory()) {
        const children = [];
        try {
            const files = await fs.readdir(dirPath);
            
            for (const file of files.sort()) {
                if (!ignoreList.includes(file) && !file.startsWith('.')) {
                    const fullPath = path.join(dirPath, file);
                    try {
                        const child = await buildFileTree(fullPath, ignoreList);
                        children.push(child);
                    } catch (err) {
                        // Skip inaccessible files
                    }
                }
            }
        } catch (error) {
            console.error(`Error reading ${dirPath}:`, error.message);
        }
        node.children = children;
    }
    
    return node;
}

// Function to build file tree for specific git commit
function buildGitFileTree(commitHash) {
    try {
        const fileList = execSync(`git ls-tree -r --name-only ${commitHash}`, {
            cwd: absolutePath,
            encoding: 'utf-8'
        });
        
        const files = fileList.trim().split('\n').filter(f => f);
        const tree = { name: path.basename(absolutePath), type: 'directory', children: [] };
        const pathMap = new Map();
        
        files.forEach(filePath => {
            const parts = filePath.split('/');
            let currentLevel = tree.children;
            let currentPath = '';
            
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                
                if (i === parts.length - 1) {
                    currentLevel.push({
                        name: part,
                        type: 'file',
                        path: filePath
                    });
                } else {
                    let dirNode = pathMap.get(currentPath);
                    if (!dirNode) {
                        dirNode = {
                            name: part,
                            type: 'directory',
                            children: []
                        };
                        currentLevel.push(dirNode);
                        pathMap.set(currentPath, dirNode);
                    }
                    currentLevel = dirNode.children;
                }
            }
        });
        
        const sortTree = (node) => {
            if (node.children) {
                node.children.sort((a, b) => {
                    if (a.type === b.type) return a.name.localeCompare(b.name);
                    return a.type === 'directory' ? -1 : 1;
                });
                node.children.forEach(sortTree);
            }
        };
        sortTree(tree);
        
        return tree;
    } catch (error) {
        console.error(`Error getting git tree for commit ${commitHash}:`, error.message);
        return null;
    }
}

// Calculate map layout data
function calculateMapData(node, depth = 0) {
    const nodes = [];
    const links = [];
    let id = 0;
    
    function processNode(node, parentId = null, depth = 0, path = '') {
        const currentId = id++;
        const currentPath = path ? `${path}/${node.name}` : node.name;
        
        const nodeData = {
            id: currentId,
            name: node.name,
            type: node.type,
            path: currentPath,
            depth,
            size: node.size || 0,
            childrenCount: node.children ? node.children.length : 0
        };
        
        nodes.push(nodeData);
        
        if (parentId !== null) {
            links.push({
                source: parentId,
                target: currentId,
                depth
            });
        }
        
        if (node.children && node.children.length > 0) {
            node.children.forEach(child => {
                processNode(child, currentId, depth + 1, currentPath);
            });
        }
    }
    
    processNode(node);
    
    return { nodes, links };
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ========== IMPROVEMENT: Rich block tree analysis ==========
function extractKeywordsInBlock(lines, startLine, endLine) {
    const keywords = new Set();
    const patterns = {
        'return': /\breturn\b/,
        'throw': /\bthrow\b/,
        'await': /\bawait\b/,
        'new': /\bnew\s+\w+/,
        'import': /\bimport\b/,
        'require': /\brequire\b/,
        'console.log': /\bconsole\.log\b/,
        'console.error': /\bconsole\.error\b/,
        'fetch': /\bfetch\b/,
        'async': /\basync\b/,
        'this': /\bthis\./,
        'super': /\bsuper\b/,
        'typeof': /\btypeof\b/,
        'instanceof': /\binstanceof\b/,
        'delete': /\bdelete\b/,
        'yield': /\byield\b/,
        'break': /\bbreak\b/,
        'continue': /\bcontinue\b/,
        'var': /\bvar\s+/,
        'let': /\blet\s+/,
        'const': /\bconst\s+/,
    };
    
    for (let i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
        const line = lines[i] || '';
        for (const [name, regex] of Object.entries(patterns)) {
            if (regex.test(line)) keywords.add(name);
        }
    }
    return Array.from(keywords);
}

function countCallsInBlock(lines, startLine, endLine) {
    let count = 0;
    for (let i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
        const line = lines[i] || '';
        // Count function calls: word followed by (
        const matches = line.match(/\b\w+\s*\(/g);
        if (matches) count += matches.length;
        // Count method calls: .word(
        const methodMatches = line.match(/\.\w+\s*\(/g);
        if (methodMatches) count += methodMatches.length;
    }
    return count;
}

function extractCommentsInBlock(lines, startLine, endLine) {
    const comments = [];
    for (let i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
        const trimmed = (lines[i] || '').trim();
        if (trimmed.startsWith('//')) {
            comments.push(trimmed.substring(2).trim());
        } else if (trimmed.startsWith('/*')) {
            comments.push(trimmed.substring(2).replace('*/', '').trim());
        } else if (trimmed.startsWith('*') && !trimmed.startsWith('*/')) {
            comments.push(trimmed.substring(1).trim());
        }
    }
    return comments.slice(0, 3); // limit to 3 comments per block
}

// Build a rich hierarchical block tree from source code (for languages with braces)
function buildBlockTree(filePath, commitHash = null) {
    const content = getFileContent(filePath, commitHash);
    if (!content) return null;
    
    const lines = content.split('\n');
    const ext = path.extname(filePath).toLowerCase();
    
    // Only support curly-brace languages (not Python, Ruby, etc.)
    const braceLanguages = ['.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.swift', '.kt', '.php', '.scala', '.dart', '.groovy'];
    if (!braceLanguages.includes(ext)) {
        return { supported: false, reason: 'Block explorer only supports curly-brace languages' };
    }
    
    const blocks = [];
    const stack = [];
    let root = { children: [], startLine: 0, endLine: lines.length + 1, depth: 0, type: 'file' };
    let currentBlock = null;
    let inString = false;
    let stringChar = '';
    let inLineComment = false;
    let inBlockComment = false;
    
    function findBlockType(startLine) {
        const headerLine = startLine > 0 ? lines[startLine - 2] : '';
        if (!headerLine) return 'block';
        
        const trimmed = headerLine.trim();
        if (/\b(if|else\s*if|else)\b/.test(trimmed)) return 'conditional';
        if (/\b(for|while|do)\b/.test(trimmed)) return 'loop';
        if (/\b(switch|case)\b/.test(trimmed)) return 'switch';
        if (/\b(try|catch|finally)\b/.test(trimmed)) return 'exception';
        if (/\b(function|=>|def|fn|fun|func)\b/.test(trimmed)) return 'function';
        if (/\bclass\b/.test(trimmed)) return 'class';
        return 'block';
    }
    
    function extractHeaderContent(startLine) {
        // Get the header line that contains the opening brace
        const headerLine = startLine > 0 ? lines[startLine - 2] : '';
        if (!headerLine) return '';
        const trimmed = headerLine.trim();
        // Remove leading keywords and get the condition/signature
        let result = trimmed
            .replace(/^(if|else\s*if|else|for|while|do|switch|try|catch|finally|function|class)\s*/, '')
            .replace(/\s*{\s*$/, '')
            .trim();
        if (result.length > 80) result = result.substring(0, 77) + '...';
        return result;
    }
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        
        let j = 0;
        while (j < line.length) {
            const ch = line[j];
            if (inString) {
                if (ch === '\\') {
                    j += 2;
                    continue;
                }
                if (ch === stringChar) {
                    inString = false;
                }
            } else if (inLineComment) {
                break;
            } else if (inBlockComment) {
                if (ch === '*' && line[j+1] === '/') {
                    inBlockComment = false;
                    j += 2;
                    continue;
                }
            } else {
                if (ch === '"' || ch === "'" || ch === '`') {
                    inString = true;
                    stringChar = ch;
                } else if (ch === '/' && line[j+1] === '/') {
                    inLineComment = true;
                    break;
                } else if (ch === '/' && line[j+1] === '*') {
                    inBlockComment = true;
                    j += 2;
                    continue;
                } else if (ch === '{') {
                    const block = {
                        startLine: lineNum,
                        endLine: null,
                        depth: stack.length + 1,
                        children: [],
                        type: findBlockType(lineNum),
                        header: extractHeaderContent(lineNum),
                        totalLines: 0,
                        childCount: 0,
                        keywords: [],
                        callCount: 0,
                        comments: [],
                    };
                    if (stack.length === 0) {
                        root.children.push(block);
                    } else {
                        const parent = stack[stack.length - 1];
                        parent.children.push(block);
                    }
                    stack.push(block);
                } else if (ch === '}') {
                    if (stack.length > 0) {
                        const block = stack.pop();
                        block.endLine = lineNum;
                        // Enrich block with information
                        block.totalLines = block.endLine - block.startLine + 1;
                        block.childCount = block.children.length;
                        block.keywords = extractKeywordsInBlock(lines, block.startLine, block.endLine);
                        block.callCount = countCallsInBlock(lines, block.startLine, block.endLine);
                        block.comments = extractCommentsInBlock(lines, block.startLine, block.endLine);
                    }
                }
            }
            j++;
        }
        inLineComment = false;
    }
    
    // Set endLine for any unclosed blocks
    for (const block of stack) {
        block.endLine = lines.length;
        block.totalLines = block.endLine - block.startLine + 1;
        block.childCount = block.children.length;
        block.keywords = extractKeywordsInBlock(lines, block.startLine, block.endLine);
        block.callCount = countCallsInBlock(lines, block.startLine, block.endLine);
        block.comments = extractCommentsInBlock(lines, block.startLine, block.endLine);
    }
    
    // Set root info
    root.totalLines = lines.length;
    root.childCount = root.children.length;
    
    return { supported: true, root, totalLines: lines.length };
}
// ========== END IMPROVEMENT ==========

// Generate HTML
function generateHTML(initialTree, isGitRepo, commits) {
    const mapData = calculateMapData(initialTree);
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Tree Visualizer</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; height: 100vh; overflow: hidden; }
        .container { max-width: 100%; height: 100%; display: flex; flex-direction: column; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-shrink: 0; }
        h1 { color: #58a6ff; font-size: 24px; margin: 0; }
        .view-toggle { display: flex; gap: 10px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 4px; }
        .view-btn { background: transparent; color: #8b949e; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; transition: all 0.2s; }
        .view-btn.active { background: #1f6feb; color: white; }
        .view-btn:hover:not(.active) { background: #21262d; color: #c9d1d9; }
        .git-controls { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 15px; margin-bottom: 20px; flex-shrink: 0; display: ${isGitRepo ? 'block' : 'none'}; }
        .commit-navigation { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; transition: all 0.2s; }
        .btn:hover { background: #30363d; border-color: #8b949e; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .commit-slider { flex: 1; -webkit-appearance: none; height: 6px; background: #30363d; border-radius: 3px; outline: none; }
        .commit-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; background: #58a6ff; border-radius: 50%; cursor: pointer; }
        .commit-info { color: #8b949e; font-size: 13px; margin-top: 8px; }
        .commit-info span { color: #58a6ff; font-weight: 600; }
        .main-content { flex: 1; display: flex; gap: 20px; overflow: hidden; min-height: 0; }
        .views-container { flex: 1; overflow: hidden; position: relative; min-width: 0; }
        .file-detail-view { width: 550px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; display: none; flex-direction: column; overflow: hidden; }
        .file-detail-view.active { display: flex; }
        .file-detail-header { padding: 15px; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
        .file-detail-title { color: #58a6ff; font-size: 16px; font-weight: 600; word-break: break-all; flex: 1; margin-right: 10px; }
        .close-btn { background: none; border: none; color: #8b949e; cursor: pointer; font-size: 20px; padding: 5px; transition: color 0.2s; }
        .close-btn:hover { color: #f85149; }
        .file-detail-tabs { display: flex; gap: 5px; padding: 10px; background: #0d1117; border-bottom: 1px solid #30363d; flex-shrink: 0; }
        .tab-btn { background: transparent; color: #8b949e; border: 1px solid #30363d; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; transition: all 0.2s; }
        .tab-btn.active { background: #1f6feb; color: white; border-color: #1f6feb; }
        .tab-btn:hover:not(.active) { background: #21262d; color: #c9d1d9; }
        .file-detail-content { flex: 1; overflow: hidden; position: relative; min-height: 0; }
        .tab-content { position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow-y: auto; overflow-x: hidden; padding: 15px; display: none; }
        .tab-content.active { display: block; }
        .structure-section { margin-bottom: 20px; }
        .structure-section h3 { color: #58a6ff; font-size: 14px; margin-bottom: 10px; padding-bottom: 5px; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 8px; }
        .structure-item { background: #1c2128; border: 1px solid #30363d; border-radius: 4px; padding: 8px 12px; margin-bottom: 5px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; transition: all 0.2s; }
        .structure-item:hover { background: #21262d; border-color: #58a6ff; }
        .structure-item .item-name { color: #79c0ff; font-weight: 600; font-family: 'Courier New', monospace; }
        .structure-item .item-line { color: #8b949e; font-size: 11px; }
        .structure-item .item-type { color: #8b949e; font-size: 10px; text-transform: uppercase; background: #30363d; padding: 2px 6px; border-radius: 3px; }
        .structure-badge { display: inline-block; background: #30363d; color: #8b949e; padding: 2px 8px; border-radius: 12px; font-size: 11px; margin-left: 5px; }
        .complexity-indicator { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
        .complexity-low { background: #1b3826; color: #3fb950; }
        .complexity-medium { background: #3d2e00; color: #d2991d; }
        .complexity-high { background: #3d1f00; color: #f0883e; }
        .complexity-very-high { background: #3d1119; color: #f85149; }
        .file-detail-svg { width: 100%; height: 100%; min-height: 300px; }
        .file-detail-tooltip { position: absolute; background: #1c2128; border: 1px solid #30363d; border-radius: 6px; padding: 10px; color: #c9d1d9; font-size: 12px; pointer-events: none; opacity: 0; transition: opacity 0.2s; z-index: 1000; max-width: 250px; }
        .file-detail-controls { position: absolute; bottom: 20px; right: 20px; display: flex; gap: 5px; z-index: 10; }
        .zoom-btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 16px; }
        .zoom-btn:hover { background: #30363d; }
        .file-content-preview { padding: 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; white-space: pre-wrap; word-wrap: break-word; max-height: none; }
        .file-content-preview pre { margin: 0; }
        .empty-detail-message { display: flex; align-items: center; justify-content: center; height: 100%; color: #8b949e; font-size: 14px; text-align: center; padding: 20px; }
        .tree-view, .map-view { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: #161b22; border: 1px solid #30363d; border-radius: 6px; overflow: auto; }
        .tree-view { padding: 20px; }
        .map-view { padding: 20px; display: none; }
        .map-view.active { display: block; }
        .tree-view.active { display: block; }
        .tree-view.hidden, .map-view.hidden { display: none; }
        .tree { font-family: 'Courier New', monospace; font-size: 14px; line-height: 1.6; }
        .tree-item { margin-left: 20px; }
        .tree-node { display: flex; align-items: center; padding: 2px 0; border-radius: 3px; transition: background 0.2s; }
        .tree-node:hover { background: #1c2128; }
        .tree-node.clickable { cursor: pointer; }
        .tree-node.clickable:hover { background: #1f6feb33; }
        .icon { margin-right: 8px; width: 20px; text-align: center; }
        .folder { color: #58a6ff; }
        .file { color: #8b949e; }
        .file.clickable { color: #79c0ff; cursor: pointer; }
        .file.clickable:hover { text-decoration: underline; }
        .branch-line { color: #30363d; margin-right: 4px; }
        .toggle-btn { background: none; border: none; color: #58a6ff; cursor: pointer; padding: 0 4px; font-size: 12px; width: 20px; text-align: center; }
        .toggle-btn:hover { color: #79c0ff; }
        .loading { display: none; color: #58a6ff; margin-left: 10px; font-style: italic; }
        .stats { color: #8b949e; font-size: 12px; margin-top: 10px; flex-shrink: 0; }
        .map-svg { width: 100%; height: 100%; min-height: 300px; }
        .map-node { cursor: pointer; transition: all 0.3s; }
        .map-node:hover { filter: brightness(1.3); }
        .map-node-circle { stroke-width: 2px; transition: all 0.3s; }
        .map-node:hover .map-node-circle { stroke-width: 3px; }
        .map-link { stroke: #30363d; stroke-width: 1.5px; transition: all 0.3s; }
        .map-link:hover { stroke: #58a6ff; stroke-width: 2px; }
        .map-label { fill: #c9d1d9; font-size: 10px; pointer-events: none; text-anchor: middle; }
        .map-tooltip { position: absolute; background: #1c2128; border: 1px solid #30363d; border-radius: 6px; padding: 10px; color: #c9d1d9; font-size: 12px; pointer-events: none; opacity: 0; transition: opacity 0.2s; z-index: 1000; max-width: 300px; }
        .map-controls { position: absolute; bottom: 20px; right: 20px; display: flex; gap: 5px; z-index: 10; }
        
        /* Rich block explorer styles */
        .block-tree { font-family: 'Courier New', monospace; font-size: 12px; }
        .block-node { margin-left: 16px; }
        .block-line { display: flex; align-items: flex-start; padding: 4px 6px; cursor: pointer; border-radius: 4px; margin-bottom: 2px; transition: background 0.15s; }
        .block-line:hover { background: #1c2128; }
        .block-toggle { background: none; border: none; color: #58a6ff; cursor: pointer; font-size: 11px; width: 16px; text-align: center; margin-right: 4px; flex-shrink: 0; padding: 0; }
        .block-toggle:hover { color: #79c0ff; }
        .block-icon { margin-right: 6px; width: 18px; text-align: center; flex-shrink: 0; font-size: 13px; }
        .block-info { flex: 1; min-width: 0; }
        .block-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
        .block-type { font-weight: 600; text-transform: uppercase; font-size: 10px; padding: 1px 6px; border-radius: 3px; letter-spacing: 0.3px; }
        .block-type-function { background: #1f1e33; color: #d2a8ff; }
        .block-type-class { background: #3d1f00; color: #f0883e; }
        .block-type-conditional { background: #1b3826; color: #3fb950; }
        .block-type-loop { background: #1f2d3d; color: #79c0ff; }
        .block-type-switch { background: #3d2e00; color: #d2991d; }
        .block-type-exception { background: #3d1119; color: #f85149; }
        .block-type-block { background: #21262d; color: #8b949e; }
        .block-header { color: #e6edf3; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .block-range { color: #484f58; font-size: 10px; flex-shrink: 0; }
        .block-details { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
        .block-keyword { background: #1c2128; color: #8b949e; font-size: 9px; padding: 1px 6px; border-radius: 8px; border: 1px solid #30363d; }
        .block-comment { color: #6e7681; font-size: 10px; font-style: italic; margin-top: 2px; padding-left: 4px; border-left: 2px solid #30363d; }
        .block-summary { margin-bottom: 8px; padding: 8px 10px; background: #1c2128; border-radius: 4px; border: 1px solid #30363d; font-size: 11px; color: #8b949e; }
        .block-summary strong { color: #58a6ff; }
        
        /* Custom scrollbar */
        .tab-content::-webkit-scrollbar,
        .file-content-preview::-webkit-scrollbar {
            width: 8px;
        }
        .tab-content::-webkit-scrollbar-track,
        .file-content-preview::-webkit-scrollbar-track {
            background: #0d1117;
        }
        .tab-content::-webkit-scrollbar-thumb,
        .file-content-preview::-webkit-scrollbar-thumb {
            background: #30363d;
            border-radius: 4px;
        }
        .tab-content::-webkit-scrollbar-thumb:hover,
        .file-content-preview::-webkit-scrollbar-thumb:hover {
            background: #484f58;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📁 File Tree Architecture</h1>
            <div class="view-toggle">
                <button class="view-btn active" onclick="switchView('tree')">🌳 Tree View</button>
                <button class="view-btn" onclick="switchView('map')">🗺️ Map View</button>
            </div>
        </div>
        
        <div class="git-controls" id="gitControls">
            <div class="commit-navigation">
                <button class="btn" onclick="navigateCommit(-1)" id="prevBtn">◀ Previous</button>
                <input type="range" class="commit-slider" id="commitSlider" 
                       min="0" max="${Math.max(0, commits.length - 1)}" value="${Math.max(0, commits.length - 1)}"
                       oninput="onSliderChange(this.value)">
                <button class="btn" onclick="navigateCommit(1)" id="nextBtn">Next ▶</button>
                <span class="loading" id="loading">Loading...</span>
            </div>
            <div class="commit-info">
                Commit: <span id="commitMessage">${commits.length > 0 ? escapeHtml(commits[commits.length - 1].message) : 'Current'}</span><br>
                Date: <span id="commitDate">${commits.length > 0 ? commits[commits.length - 1].date : new Date().toISOString()}</span><br>
                Author: <span id="commitAuthor">${commits.length > 0 ? escapeHtml(commits[commits.length - 1].author) : 'N/A'}</span>
            </div>
        </div>
        
        <div class="main-content">
            <div class="views-container">
                <div class="tree-view active" id="treeView">
                    <div class="tree" id="treeContainer">
                        ${renderTreeHTML(initialTree)}
                    </div>
                </div>
                
                <div class="map-view" id="mapView">
                    <svg class="map-svg" id="mapSvg"></svg>
                    <div class="map-tooltip" id="mapTooltip"></div>
                    <div class="map-controls">
                        <button class="zoom-btn" onclick="zoomMap(1.2)">➕</button>
                        <button class="zoom-btn" onclick="zoomMap(0.8)">➖</button>
                        <button class="zoom-btn" onclick="resetMap()">🔄</button>
                    </div>
                </div>
            </div>
            
            <div class="file-detail-view" id="fileDetailView">
                <div class="file-detail-header">
                    <span class="file-detail-title" id="fileDetailTitle">Select a file to view details</span>
                    <button class="close-btn" onclick="closeFileDetail()">✕</button>
                </div>
                <div class="file-detail-tabs" id="fileDetailTabs" style="display:none;">
                    <button class="tab-btn active" onclick="switchDetailTab('overview')">📊 Overview</button>
                    <button class="tab-btn" onclick="switchDetailTab('structure')">🏗️ Structure</button>
                    <button class="tab-btn" onclick="switchDetailTab('map')">🗺️ Map</button>
                    <button class="tab-btn" onclick="switchDetailTab('code')">💻 Code</button>
                    <button class="tab-btn" onclick="switchDetailTab('blocks')">🔍 Blocks</button>
                </div>
                <div class="file-detail-content" id="fileDetailContent">
                    <div class="tab-content active" id="tab-overview">
                        <div class="empty-detail-message" id="emptyOverviewMessage">Loading file overview...</div>
                        <div id="overviewContent" style="display:none;"></div>
                    </div>
                    <div class="tab-content" id="tab-structure">
                        <div class="empty-detail-message" id="emptyStructureMessage">Loading file structure...</div>
                        <div id="structureContent" style="display:none;"></div>
                    </div>
                    <div class="tab-content" id="tab-map">
                        <svg class="file-detail-svg" id="fileDetailSvg" style="display:none;"></svg>
                        <div class="empty-detail-message" id="emptyMapMessage">Click on a file in the tree or map view to see its structure</div>
                        <div class="file-detail-tooltip" id="fileDetailTooltip"></div>
                        <div class="file-detail-controls" id="fileDetailControls" style="display:none;">
                            <button class="zoom-btn" onclick="zoomFileDetailMap(1.2)">➕</button>
                            <button class="zoom-btn" onclick="zoomFileDetailMap(0.8)">➖</button>
                            <button class="zoom-btn" onclick="resetFileDetailMap()">🔄</button>
                        </div>
                    </div>
                    <div class="tab-content" id="tab-code">
                        <div class="file-content-preview" id="fileContentPreview" style="display:none;">
                            <pre id="fileContentCode"></pre>
                        </div>
                        <div class="empty-detail-message" id="emptyCodeMessage">Code preview will appear here</div>
                    </div>
                    <div class="tab-content" id="tab-blocks">
                        <div class="empty-detail-message" id="emptyBlocksMessage">Loading block structure...</div>
                        <div id="blocksContent" style="display:none;" class="block-tree"></div>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="stats" id="stats"></div>
    </div>
    
    <script>
        const commits = ${JSON.stringify(commits)};
        let currentCommitIndex = ${commits.length > 0 ? commits.length - 1 : 0};
        let currentView = 'tree';
        let currentMapData = ${JSON.stringify(mapData)};
        let initialTree = ${JSON.stringify(initialTree)};
        let currentFileDetailData = null;
        let currentFileStructure = null;
        let mapTransform = { x: 0, y: 0, scale: 1 };
        let fileDetailMapTransform = { x: 0, y: 0, scale: 1 };
        let isDragging = false;
        let dragStart = { x: 0, y: 0 };
        let isFileDetailDragging = false;
        let fileDetailDragStart = { x: 0, y: 0 };
        let currentSelectedFile = null;
        let currentDetailTab = 'overview';
        let isGitRepo = ${isGitRepo};
        
        // View switching
        function switchView(view) {
            currentView = view;
            
            document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');
            
            const treeView = document.getElementById('treeView');
            const mapView = document.getElementById('mapView');
            
            if (view === 'tree') {
                treeView.classList.add('active');
                treeView.classList.remove('hidden');
                mapView.classList.remove('active');
                mapView.classList.add('hidden');
            } else {
                mapView.classList.add('active');
                mapView.classList.remove('hidden');
                treeView.classList.remove('active');
                treeView.classList.add('hidden');
                setTimeout(() => renderMap(currentMapData, 'mapSvg', 'mapTooltip', mapTransform, 'map'), 100);
            }
        }
        
        // Detail tab switching
        function switchDetailTab(tab) {
            currentDetailTab = tab;
            
            document.querySelectorAll('#fileDetailTabs .tab-btn').forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');
            
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            document.getElementById('tab-' + tab).classList.add('active');
            
            if (tab === 'map' && currentFileDetailData) {
                setTimeout(() => renderMap(currentFileDetailData, 'fileDetailSvg', 'fileDetailTooltip', fileDetailMapTransform, 'file-detail'), 100);
            }
            if (tab === 'blocks' && currentSelectedFile) {
                loadBlockView(currentSelectedFile);
            }
        }
        
        // Map rendering
        function renderMapData(data, svgId, tooltipId, transform, type) {
            const svg = document.getElementById(svgId);
            const container = svg.parentElement;
            const width = container.clientWidth || 400;
            const height = container.clientHeight || 400;
            
            if (!data || !data.nodes || data.nodes.length === 0) {
                svg.style.display = 'none';
                if (type === 'file-detail') {
                    document.getElementById('emptyMapMessage').style.display = 'flex';
                    document.getElementById('fileDetailControls').style.display = 'none';
                }
                return;
            }
            
            svg.style.display = 'block';
            if (type === 'file-detail') {
                document.getElementById('emptyMapMessage').style.display = 'none';
                document.getElementById('fileDetailControls').style.display = 'flex';
            }
            
            // Calculate layout
            const maxDepth = Math.max(...data.nodes.map(n => n.depth || 0), 1);
            const nodesByDepth = {};
            data.nodes.forEach(node => {
                if (!nodesByDepth[node.depth]) nodesByDepth[node.depth] = [];
                nodesByDepth[node.depth].push(node);
            });
            
            const positions = {};
            const margin = { top: 50, bottom: 30, left: 30, right: 30 };
            const availableWidth = width - margin.left - margin.right;
            const availableHeight = height - margin.top - margin.bottom;
            
            data.nodes.forEach(node => {
                const depthNodes = nodesByDepth[node.depth] || [];
                const depthIndex = depthNodes.indexOf(node);
                const totalInDepth = depthNodes.length;
                
                const x = margin.left + (availableWidth / (maxDepth + 1)) * ((node.depth || 0) + 0.5);
                const y = margin.top + (availableHeight / Math.max(totalInDepth, 1)) * (depthIndex + 0.5);
                
                positions[node.id] = { x, y };
            });
            
            // Generate SVG
            let svgContent = '';
            
            // Draw links
            data.links.forEach(link => {
                const source = positions[link.source];
                const target = positions[link.target];
                if (source && target) {
                    const midX = (source.x + target.x) / 2;
                    svgContent += \`<path class="map-link" d="M\${source.x},\${source.y} C\${midX},\${source.y} \${midX},\${target.y} \${target.x},\${target.y}"/>\`;
                }
            });
            
            // Draw nodes
            data.nodes.forEach(node => {
                const pos = positions[node.id];
                if (!pos) return;
                
                let radius, color;
                const nodeType = node.type || 'unknown';
                
                switch(nodeType) {
                    case 'directory': radius = 20; color = '#58a6ff'; break;
                    case 'file': radius = 18; color = '#8b949e'; break;
                    case 'section': radius = 16; color = '#3fb950'; break;
                    case 'function': radius = 12; color = '#d2a8ff'; break;
                    case 'class': radius = 14; color = '#f0883e'; break;
                    case 'import': radius = 10; color = '#79c0ff'; break;
                    case 'import_group': radius = 14; color = '#1f6feb'; break;
                    case 'export': radius = 10; color = '#3fb950'; break;
                    case 'detail': radius = 8; color = '#8b949e'; break;
                    case 'stat': radius = 6; color = '#6e7681'; break;
                    case 'dependency': radius = 8; color = '#f0883e'; break;
                    case 'react_component': radius = 12; color = '#61dafb'; break;
                    case 'hook': radius = 10; color = '#d2a8ff'; break;
                    default: radius = 8; color = '#8b949e';
                }
                
                let displayName = node.name || '';
                if (displayName.length > 20) displayName = displayName.substring(0, 18) + '...';
                
                svgContent += \`<g class="map-node" transform="translate(\${pos.x},\${pos.y})" data-path="\${node.path || ''}" data-type="\${nodeType}">\`;
                svgContent += \`<circle class="map-node-circle" r="\${radius}" fill="\${color}" stroke="\${color}" opacity="0.8"/>\`;
                svgContent += \`<text class="map-label" dy="\${radius + 12}" text-anchor="middle" fill="#c9d1d9">\${displayName}</text>\`;
                svgContent += '</g>';
            });
            
            svg.innerHTML = svgContent;
            
            // Add click handlers
            svg.querySelectorAll('.map-node').forEach(nodeEl => {
                nodeEl.addEventListener('click', function(e) {
                    const path = this.getAttribute('data-path');
                    const type = this.getAttribute('data-type');
                    if (type === 'file' && path) {
                        openFileDetail(path);
                    }
                });
            });
            
            // Add drag and zoom
            if (type === 'map') {
                svg.onmousedown = function(e) {
                    isDragging = true;
                    dragStart = { x: e.clientX - mapTransform.x, y: e.clientY - mapTransform.y };
                    svg.style.cursor = 'grabbing';
                };
                svg.onmousemove = function(e) {
                    if (isDragging) {
                        mapTransform.x = e.clientX - dragStart.x;
                        mapTransform.y = e.clientY - dragStart.y;
                        updateMapTransform();
                    }
                };
                svg.onwheel = function(e) {
                    e.preventDefault();
                    const delta = e.deltaY > 0 ? 0.9 : 1.1;
                    zoomMap(delta, e.clientX, e.clientY);
                };
            } else {
                svg.onmousedown = function(e) {
                    isFileDetailDragging = true;
                    fileDetailDragStart = { x: e.clientX - fileDetailMapTransform.x, y: e.clientY - fileDetailMapTransform.y };
                    svg.style.cursor = 'grabbing';
                };
                svg.onmousemove = function(e) {
                    if (isFileDetailDragging) {
                        fileDetailMapTransform.x = e.clientX - fileDetailDragStart.x;
                        fileDetailMapTransform.y = e.clientY - fileDetailDragStart.y;
                        updateFileDetailMapTransform();
                    }
                };
                svg.onwheel = function(e) {
                    e.preventDefault();
                    const delta = e.deltaY > 0 ? 0.9 : 1.1;
                    zoomFileDetailMap(delta, e.clientX, e.clientY);
                };
            }
            
            svg.onmouseup = function() {
                isDragging = false;
                isFileDetailDragging = false;
                svg.style.cursor = 'grab';
            };
            
            svg.style.cursor = 'grab';
            updateTransform(transform, svgId);
        }
        
        function updateTransform(transform, svgId) {
            const svg = document.getElementById(svgId);
            svg.style.transform = \`translate(\${transform.x}px, \${transform.y}px) scale(\${transform.scale})\`;
        }
        
        function renderMap(data, svgId, tooltipId, transform, type) {
            renderMapData(data, svgId, tooltipId, transform, type);
        }
        
        function updateMapTransform() {
            updateTransform(mapTransform, 'mapSvg');
        }
        
        function zoomMap(factor, cx, cy) {
            mapTransform.scale *= factor;
            if (cx && cy) {
                mapTransform.x = cx - (cx - mapTransform.x) * factor;
                mapTransform.y = cy - (cy - mapTransform.y) * factor;
            }
            updateMapTransform();
        }
        
        function resetMap() {
            mapTransform = { x: 0, y: 0, scale: 1 };
            updateMapTransform();
        }
        
        function updateFileDetailMapTransform() {
            updateTransform(fileDetailMapTransform, 'fileDetailSvg');
        }
        
        function zoomFileDetailMap(factor, cx, cy) {
            fileDetailMapTransform.scale *= factor;
            if (cx && cy) {
                fileDetailMapTransform.x = cx - (cx - fileDetailMapTransform.x) * factor;
                fileDetailMapTransform.y = cy - (cy - fileDetailMapTransform.y) * factor;
            }
            updateFileDetailMapTransform();
        }
        
        function resetFileDetailMap() {
            fileDetailMapTransform = { x: 0, y: 0, scale: 1 };
            updateFileDetailMapTransform();
        }
        
        // Render structure overview
        function renderStructureOverview(structure) {
            let html = '';
            
            // File Statistics
            html += '<div class="structure-section">';
            html += '<h3>📊 File Statistics</h3>';
            html += \`<div class="structure-item"><span>Total Lines</span><span class="item-name">\${structure.totalLines}</span></div>\`;
            html += \`<div class="structure-item"><span>Code Lines</span><span class="item-name">\${structure.codeLines}</span></div>\`;
            html += \`<div class="structure-item"><span>Comment Lines</span><span class="item-name">\${structure.commentLines}</span></div>\`;
            html += \`<div class="structure-item"><span>Empty Lines</span><span class="item-name">\${structure.emptyLines}</span></div>\`;
            const density = ((structure.codeLines / Math.max(1, structure.totalLines)) * 100).toFixed(1);
            html += \`<div class="structure-item"><span>Code Density</span><span class="item-name">\${density}%</span></div>\`;
            html += '</div>';
            
            // Complexity
            if (structure.complexity) {
                html += '<div class="structure-section">';
                html += '<h3>📈 Complexity Analysis</h3>';
                html += \`<div class="structure-item"><span>Cyclomatic Complexity</span><span class="item-name">\${structure.complexity.cyclomaticComplexity}</span></div>\`;
                html += \`<div class="structure-item"><span>Max Nesting Depth</span><span class="item-name">\${structure.complexity.maxNestingDepth}</span></div>\`;
                const score = structure.complexity.cyclomaticComplexity * 2 + structure.complexity.maxNestingDepth * 3;
                let complexityClass = 'low';
                let complexityLabel = 'Low';
                if (score > 30) { complexityClass = 'very-high'; complexityLabel = 'Very High'; }
                else if (score > 20) { complexityClass = 'high'; complexityLabel = 'High'; }
                else if (score > 10) { complexityClass = 'medium'; complexityLabel = 'Medium'; }
                html += \`<div class="structure-item"><span>Complexity Score</span><span class="complexity-indicator complexity-\${complexityClass}">\${complexityLabel}</span></div>\`;
                html += '</div>';
            }
            
            // Language Features
            if (structure.languageFeatures && structure.languageFeatures.length > 0) {
                html += '<div class="structure-section">';
                html += '<h3>🧩 Language Features</h3>';
                structure.languageFeatures.forEach(feature => {
                    html += \`<div class="structure-item"><span class="item-type">\${feature}</span></div>\`;
                });
                html += '</div>';
            }
            
            // Dependencies
            if (structure.dependencies && structure.dependencies.length > 0) {
                html += '<div class="structure-section">';
                html += \`<h3>📦 Dependencies <span class="structure-badge">\${structure.dependencies.length}</span></h3>\`;
                structure.dependencies.forEach(dep => {
                    html += \`<div class="structure-item"><span class="item-name">\${dep}</span></div>\`;
                });
                html += '</div>';
            }
            
            return html;
        }
        
        // Render detailed structure
        function renderDetailedStructure(structure) {
            let html = '';
            
            // Functions
            if (structure.functions && structure.functions.length > 0) {
                html += '<div class="structure-section">';
                html += \`<h3>⚡ Functions <span class="structure-badge">\${structure.functions.length}</span></h3>\`;
                structure.functions.forEach(func => {
                    html += \`<div class="structure-item">\`;
                    html += \`<span class="item-name">\${func.name || 'anonymous'}(\${func.params || ''})</span>\`;
                    html += \`<div>\`;
                    html += \`<span class="item-type">\${func.type || 'function'}</span>\`;
                    if (func.isAsync) html += '<span class="structure-badge">async</span>';
                    html += \`<span class="item-line">Line \${func.line}</span>\`;
                    html += \`</div></div>\`;
                });
                html += '</div>';
            }
            
            // Classes
            if (structure.classes && structure.classes.length > 0) {
                html += '<div class="structure-section">';
                html += \`<h3>🏗️ Classes <span class="structure-badge">\${structure.classes.length}</span></h3>\`;
                structure.classes.forEach(cls => {
                    html += \`<div class="structure-item">\`;
                    html += \`<span class="item-name">\${cls.name}</span>\`;
                    html += \`<div>\`;
                    html += \`<span class="item-type">class</span>\`;
                    if (cls.extends) html += \`<span class="structure-badge">extends \${cls.extends}</span>\`;
                    html += \`<span class="item-line">Line \${cls.line}</span>\`;
                    html += \`</div></div>\`;
                });
                html += '</div>';
            }
            
            // Interfaces/Types
            if (structure.interfaces && structure.interfaces.length > 0) {
                html += '<div class="structure-section">';
                html += \`<h3>📋 Interfaces/Types <span class="structure-badge">\${structure.interfaces.length}</span></h3>\`;
                structure.interfaces.forEach(iface => {
                    html += \`<div class="structure-item">\`;
                    html += \`<span class="item-name">\${iface.name}</span>\`;
                    html += \`<div><span class="item-type">\${iface.type}</span><span class="item-line">Line \${iface.line}</span></div>\`;
                    html += \`</div>\`;
                });
                html += '</div>';
            }
            
            // Imports
            if (structure.imports && structure.imports.length > 0) {
                html += '<div class="structure-section">';
                html += \`<h3>📥 Imports <span class="structure-badge">\${structure.imports.length}</span></h3>\`;
                structure.imports.slice(0, 20).forEach(imp => {
                    html += \`<div class="structure-item">\`;
                    html += \`<span class="item-name">\${imp.module || 'unknown'}</span>\`;
                    html += \`<div><span class="item-type">\${imp.type}</span><span class="item-line">Line \${imp.line}</span></div>\`;
                    html += \`</div>\`;
                });
                if (structure.imports.length > 20) {
                    html += \`<div class="structure-item"><span>... and \${structure.imports.length - 20} more imports</span></div>\`;
                }
                html += '</div>';
            }
            
            // Exports
            if (structure.exports && structure.exports.length > 0) {
                html += '<div class="structure-section">';
                html += \`<h3>📤 Exports <span class="structure-badge">\${structure.exports.length}</span></h3>\`;
                structure.exports.forEach(exp => {
                    html += \`<div class="structure-item">\`;
                    html += \`<span class="item-name">\${exp.type}</span>\`;
                    html += \`<span class="item-line">Line \${exp.line}</span>\`;
                    html += \`</div>\`;
                });
                html += '</div>';
            }
            
            // React Components
            if (structure.reactComponents && structure.reactComponents.length > 0) {
                html += '<div class="structure-section">';
                html += \`<h3>⚛️ React Components <span class="structure-badge">\${structure.reactComponents.length}</span></h3>\`;
                structure.reactComponents.forEach(comp => {
                    html += \`<div class="structure-item">\`;
                    html += \`<span class="item-name">\${comp.name}</span>\`;
                    html += \`<div><span class="item-type">\${comp.type}</span><span class="item-line">Line \${comp.line}</span></div>\`;
                    html += \`</div>\`;
                });
                html += '</div>';
            }
            
            // Control Structures
            if (structure.controlStructures && structure.controlStructures.length > 0) {
                html += '<div class="structure-section">';
                html += \`<h3>🔄 Control Flow <span class="structure-badge">\${structure.controlStructures.length}</span></h3>\`;
                const controlTypes = {};
                structure.controlStructures.forEach(cs => {
                    if (!controlTypes[cs.type]) controlTypes[cs.type] = 0;
                    controlTypes[cs.type]++;
                });
                Object.entries(controlTypes).forEach(([type, count]) => {
                    html += \`<div class="structure-item"><span class="item-name">\${type}</span><span class="structure-badge">\${count}</span></div>\`;
                });
                html += '</div>';
            }
            
            return html;
        }
        
        // Rich block view functions
        function loadBlockView(filePath) {
            const emptyMsg = document.getElementById('emptyBlocksMessage');
            const contentDiv = document.getElementById('blocksContent');
            emptyMsg.style.display = 'flex';
            contentDiv.style.display = 'none';
            emptyMsg.textContent = 'Loading block structure...';
            
            fetchBlockData(filePath).then(blockData => {
                if (!blockData) {
                    emptyMsg.textContent = 'Failed to load block data.';
                    return;
                }
                if (!blockData.supported) {
                    emptyMsg.textContent = blockData.reason || 'Block view not supported for this file type.';
                    return;
                }
                emptyMsg.style.display = 'none';
                contentDiv.style.display = 'block';
                renderRichBlockTree(blockData, contentDiv);
            }).catch(err => {
                emptyMsg.textContent = 'Error loading blocks: ' + err.message;
            });
        }
        
        async function fetchBlockData(filePath) {
            let commitHash = null;
            if (isGitRepo && commits.length > 0 && currentCommitIndex >= 0) {
                commitHash = commits[currentCommitIndex].hash;
            }
            let url = '/file-blocks/' + encodeURIComponent(filePath);
            if (commitHash) url += '?commit=' + commitHash;
            const response = await fetch(url);
            if (!response.ok) throw new Error('Failed to fetch blocks');
            return await response.json();
        }
        
        function renderRichBlockTree(blockData, container) {
            container.innerHTML = '';
            
            // Add summary
            const summary = document.createElement('div');
            summary.className = 'block-summary';
            const rootChildren = blockData.root.children || [];
            summary.innerHTML = \`<strong>Total blocks:</strong> \${countAllBlocks(blockData.root)} &nbsp;|&nbsp; <strong>Max depth:</strong> \${maxDepth(blockData.root)} &nbsp;|&nbsp; <strong>File lines:</strong> \${blockData.totalLines || 'N/A'}\`;
            container.appendChild(summary);
            
            // Build tree
            const treeContainer = document.createElement('div');
            treeContainer.className = 'block-tree';
            buildRichBlockDOM(blockData.root, treeContainer, 0);
            container.appendChild(treeContainer);
        }
        
        function countAllBlocks(node) {
            let count = 0;
            if (node.children) {
                count += node.children.length;
                node.children.forEach(child => {
                    count += countAllBlocks(child);
                });
            }
            return count;
        }
        
        function maxDepth(node) {
            let max = node.depth || 0;
            if (node.children) {
                node.children.forEach(child => {
                    const childDepth = maxDepth(child);
                    if (childDepth > max) max = childDepth;
                });
            }
            return max;
        }
        
        function buildRichBlockDOM(node, parent, depth) {
            if (!node) return;
            
            if (node.type === 'file') {
                // Root node - file level
                if (node.children) {
                    node.children.forEach(child => buildRichBlockDOM(child, parent, depth));
                }
                return;
            }
            
            const blockDiv = document.createElement('div');
            blockDiv.className = 'block-node';
            
            const lineDiv = document.createElement('div');
            lineDiv.className = 'block-line';
            
            const toggle = document.createElement('span');
            toggle.className = 'block-toggle';
            const hasChildren = node.children && node.children.length > 0;
            toggle.textContent = hasChildren ? '▶' : '·';
            if (!hasChildren) toggle.style.visibility = 'hidden';
            
            const icon = document.createElement('span');
            icon.className = 'block-icon';
            switch(node.type) {
                case 'function': icon.innerHTML = '⚡'; break;
                case 'class': icon.innerHTML = '🏗️'; break;
                case 'conditional': icon.innerHTML = '🔀'; break;
                case 'loop': icon.innerHTML = '🔄'; break;
                case 'switch': icon.innerHTML = '🔢'; break;
                case 'exception': icon.innerHTML = '⚠️'; break;
                default: icon.innerHTML = '📦';
            }
            
            const infoDiv = document.createElement('div');
            infoDiv.className = 'block-info';
            
            const headerRow = document.createElement('div');
            headerRow.className = 'block-header-row';
            
            const typeSpan = document.createElement('span');
            typeSpan.className = 'block-type block-type-' + node.type;
            typeSpan.textContent = node.type;
            
            const headerSpan = document.createElement('span');
            headerSpan.className = 'block-header';
            headerSpan.textContent = node.header || '';
            headerSpan.title = node.header || '';
            
            const rangeSpan = document.createElement('span');
            rangeSpan.className = 'block-range';
            rangeSpan.textContent = 'L' + node.startLine + '-' + node.endLine + ' (' + (node.totalLines || 0) + ' lines)';
            
            headerRow.appendChild(typeSpan);
            if (node.header) headerRow.appendChild(headerSpan);
            headerRow.appendChild(rangeSpan);
            
            infoDiv.appendChild(headerRow);
            
            // Details row with keywords, calls, children
            if (node.keywords && node.keywords.length > 0 || node.callCount > 0 || node.childCount > 0) {
                const detailsDiv = document.createElement('div');
                detailsDiv.className = 'block-details';
                
                if (node.keywords && node.keywords.length > 0) {
                    node.keywords.forEach(kw => {
                        const kwSpan = document.createElement('span');
                        kwSpan.className = 'block-keyword';
                        kwSpan.textContent = kw;
                        detailsDiv.appendChild(kwSpan);
                    });
                }
                
                if (node.callCount > 0) {
                    const callSpan = document.createElement('span');
                    callSpan.className = 'block-keyword';
                    callSpan.textContent = node.callCount + ' calls';
                    callSpan.style.background = '#1f2d3d';
                    callSpan.style.color = '#79c0ff';
                    detailsDiv.appendChild(callSpan);
                }
                
                if (node.childCount > 0) {
                    const childSpan = document.createElement('span');
                    childSpan.className = 'block-keyword';
                    childSpan.textContent = node.childCount + ' children';
                    childSpan.style.background = '#1b3826';
                    childSpan.style.color = '#3fb950';
                    detailsDiv.appendChild(childSpan);
                }
                
                infoDiv.appendChild(detailsDiv);
            }
            
            // Comments
            if (node.comments && node.comments.length > 0) {
                node.comments.forEach(comment => {
                    if (comment) {
                        const commentDiv = document.createElement('div');
                        commentDiv.className = 'block-comment';
                        commentDiv.textContent = '// ' + comment;
                        infoDiv.appendChild(commentDiv);
                    }
                });
            }
            
            lineDiv.appendChild(toggle);
            lineDiv.appendChild(icon);
            lineDiv.appendChild(infoDiv);
            
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'block-node';
            childrenContainer.style.display = 'none';
            
            if (hasChildren) {
                node.children.forEach(child => buildRichBlockDOM(child, childrenContainer, depth + 1));
                
                toggle.style.cursor = 'pointer';
                toggle.style.visibility = 'visible';
                lineDiv.addEventListener('click', function() {
                    if (childrenContainer.style.display === 'none') {
                        childrenContainer.style.display = 'block';
                        toggle.textContent = '▼';
                    } else {
                        childrenContainer.style.display = 'none';
                        toggle.textContent = '▶';
                    }
                });
            }
            
            blockDiv.appendChild(lineDiv);
            blockDiv.appendChild(childrenContainer);
            parent.appendChild(blockDiv);
        }
        
        // File detail functions
        async function openFileDetail(filePath) {
            currentSelectedFile = filePath;
            const fileDetailView = document.getElementById('fileDetailView');
            const fileDetailTitle = document.getElementById('fileDetailTitle');
            const fileDetailTabs = document.getElementById('fileDetailTabs');
            
            fileDetailTitle.textContent = '📄 ' + filePath.split('/').pop();
            fileDetailView.classList.add('active');
            fileDetailTabs.style.display = 'flex';
            
            // Reset tabs
            document.querySelectorAll('#fileDetailTabs .tab-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelector('#fileDetailTabs .tab-btn:first-child').classList.add('active');
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            document.getElementById('tab-overview').classList.add('active');
            currentDetailTab = 'overview';
            
            document.getElementById('emptyOverviewMessage').style.display = 'flex';
            document.getElementById('overviewContent').style.display = 'none';
            document.getElementById('emptyStructureMessage').style.display = 'flex';
            document.getElementById('structureContent').style.display = 'none';
            document.getElementById('fileDetailSvg').style.display = 'none';
            document.getElementById('emptyMapMessage').style.display = 'flex';
            document.getElementById('fileDetailControls').style.display = 'none';
            document.getElementById('fileContentPreview').style.display = 'none';
            document.getElementById('emptyCodeMessage').style.display = 'flex';
            document.getElementById('emptyBlocksMessage').style.display = 'flex';
            document.getElementById('blocksContent').style.display = 'none';
            
            document.getElementById('loading').style.display = 'inline';
            
            try {
                let commitHash = null;
                if (isGitRepo && commits.length > 0 && currentCommitIndex >= 0) {
                    commitHash = commits[currentCommitIndex].hash;
                }
                
                let url = '/file-detail/' + encodeURIComponent(filePath);
                if (commitHash) url += '?commit=' + commitHash;
                
                const response = await fetch(url);
                
                if (!response.ok) {
                    throw new Error('Failed to fetch file details');
                }
                
                const detailData = await response.json();
                currentFileDetailData = detailData;
                currentFileStructure = detailData.structure;
                
                fileDetailMapTransform = { x: 0, y: 0, scale: 1 };
                
                // Render overview
                if (currentFileStructure) {
                    document.getElementById('emptyOverviewMessage').style.display = 'none';
                    document.getElementById('overviewContent').style.display = 'block';
                    document.getElementById('overviewContent').innerHTML = renderStructureOverview(currentFileStructure);
                    
                    document.getElementById('emptyStructureMessage').style.display = 'none';
                    document.getElementById('structureContent').style.display = 'block';
                    document.getElementById('structureContent').innerHTML = renderDetailedStructure(currentFileStructure);
                }
                
                // Render map
                if (currentFileDetailData && currentFileDetailData.nodes && currentFileDetailData.nodes.length > 0) {
                    document.getElementById('emptyMapMessage').style.display = 'none';
                    document.getElementById('fileDetailControls').style.display = 'flex';
                    renderMap(currentFileDetailData, 'fileDetailSvg', 'fileDetailTooltip', fileDetailMapTransform, 'file-detail');
                }
                
                // Load code preview
                try {
                    let contentUrl = '/file-content/' + encodeURIComponent(filePath);
                    if (commitHash) contentUrl += '?commit=' + commitHash;
                    
                    const contentResponse = await fetch(contentUrl);
                    const contentData = await contentResponse.json();
                    
                    if (contentData.content) {
                        const preview = document.getElementById('fileContentPreview');
                        const code = document.getElementById('fileContentCode');
                        preview.style.display = 'block';
                        document.getElementById('emptyCodeMessage').style.display = 'none';
                        
                        code.textContent = contentData.content;
                    }
                } catch (contentError) {
                    console.error('Error loading file content:', contentError);
                }
                
                document.getElementById('emptyBlocksMessage').textContent = 'Click on the Blocks tab to load block structure';
                
            } catch (error) {
                console.error('Error loading file detail:', error);
                document.getElementById('emptyOverviewMessage').style.display = 'flex';
                document.getElementById('emptyOverviewMessage').textContent = 'Error loading file details: ' + error.message;
            } finally {
                document.getElementById('loading').style.display = 'none';
            }
        }
        
        function closeFileDetail() {
            const fileDetailView = document.getElementById('fileDetailView');
            fileDetailView.classList.remove('active');
            document.getElementById('fileDetailTabs').style.display = 'none';
            currentSelectedFile = null;
            currentFileDetailData = null;
            currentFileStructure = null;
            document.getElementById('fileDetailSvg').style.display = 'none';
            document.getElementById('emptyMapMessage').style.display = 'flex';
            document.getElementById('emptyMapMessage').textContent = 'Click on a file in the tree or map view to see its structure';
            document.getElementById('fileDetailControls').style.display = 'none';
            document.getElementById('fileContentPreview').style.display = 'none';
        }
        
        // Tree functions
        function toggleFolder(btn) {
            const treeItem = btn.parentElement.nextElementSibling;
            if (treeItem && treeItem.classList.contains('tree-item')) {
                if (treeItem.style.display === 'none') {
                    treeItem.style.display = 'block';
                    btn.textContent = '▼';
                } else {
                    treeItem.style.display = 'none';
                    btn.textContent = '▶';
                }
            }
        }
        
        function renderTreeFromData(node, level, prefix, isLast) {
            if (level === undefined) level = 0;
            if (prefix === undefined) prefix = '';
            if (isLast === undefined) isLast = true;
            
            let html = '';
            
            if (level > 0) {
                html += '<div class="tree-node' + (node.type === 'file' ? ' clickable' : '') + '"';
                if (node.type === 'file') {
                    const filePath = (node.path || node.name).replace(/'/g, "\\'");
                    html += ' onclick="openFileDetail(\\'' + filePath + '\\')"';
                }
                html += '>';
                html += '<span class="branch-line">' + prefix + (isLast ? '└── ' : '├── ') + '</span>';
                
                if (node.type === 'directory') {
                    html += '<span class="toggle-btn" onclick="event.stopPropagation(); toggleFolder(this)">▼</span>';
                    html += '<span class="icon folder">📁</span>';
                    html += '<span class="folder">' + (node.name || '') + '/</span>';
                    html += '</div>';
                    
                    if (node.children && node.children.length > 0) {
                        html += '<div class="tree-item">';
                        const newPrefix = prefix + (isLast ? '    ' : '│   ');
                        for (let i = 0; i < node.children.length; i++) {
                            html += renderTreeFromData(node.children[i], level + 1, newPrefix, i === node.children.length - 1);
                        }
                        html += '</div>';
                    }
                } else {
                    html += '<span class="icon file">📄</span>';
                    html += '<span class="file clickable">' + (node.name || '') + '</span>';
                    html += '</div>';
                }
            } else {
                html += '<div class="tree-node">';
                html += '<span class="icon folder">📁</span>';
                html += '<span class="folder" style="font-weight: bold;">' + (node.name || '') + '/</span>';
                html += '</div>';
                
                if (node.children && node.children.length > 0) {
                    html += '<div class="tree-item">';
                    for (let i = 0; i < node.children.length; i++) {
                        html += renderTreeFromData(node.children[i], 1, '', i === node.children.length - 1);
                    }
                    html += '</div>';
                }
            }
            
            return html;
        }
        
        // Git navigation
        async function onSliderChange(value) {
            currentCommitIndex = parseInt(value);
            await loadCommit(commits[currentCommitIndex].hash);
        }
        
        async function navigateCommit(direction) {
            const newIndex = currentCommitIndex + direction;
            if (newIndex >= 0 && newIndex < commits.length) {
                currentCommitIndex = newIndex;
                document.getElementById('commitSlider').value = currentCommitIndex;
                await loadCommit(commits[currentCommitIndex].hash);
            }
        }
        
        async function loadCommit(hash) {
            document.getElementById('loading').style.display = 'inline';
            document.getElementById('prevBtn').disabled = true;
            document.getElementById('nextBtn').disabled = true;
            
            try {
                const response = await fetch('/tree/' + hash);
                const data = await response.json();
                
                if (currentView === 'tree') {
                    document.getElementById('treeContainer').innerHTML = renderTreeFromData(data.tree);
                }
                
                const mapResponse = await fetch('/map/' + hash);
                currentMapData = await mapResponse.json();
                
                if (currentView === 'map') {
                    renderMap(currentMapData, 'mapSvg', 'mapTooltip', mapTransform, 'map');
                }
                
                if (currentSelectedFile) {
                    await openFileDetail(currentSelectedFile);
                }
                
                document.getElementById('commitMessage').textContent = data.commit.message;
                document.getElementById('commitDate').textContent = data.commit.date;
                document.getElementById('commitAuthor').textContent = data.commit.author;
                
                const stats = countNodes(data.tree);
                document.getElementById('stats').textContent = 'Files: ' + stats.files + ' | Directories: ' + stats.directories;
            } catch (error) {
                console.error('Error loading commit:', error);
            } finally {
                document.getElementById('loading').style.display = 'none';
                document.getElementById('prevBtn').disabled = currentCommitIndex === 0;
                document.getElementById('nextBtn').disabled = currentCommitIndex === commits.length - 1;
            }
        }
        
        function countNodes(node) {
            let files = 0;
            let directories = 0;
            
            if (node.type === 'file') files++;
            else if (node.type === 'directory') directories++;
            
            if (node.children) {
                for (let i = 0; i < node.children.length; i++) {
                    const counts = countNodes(node.children[i]);
                    files += counts.files;
                    directories += counts.directories;
                }
            }
            
            return { files, directories };
        }
        
        // Initialize stats
        const initialStats = countNodes(initialTree);
        document.getElementById('stats').textContent = 'Files: ' + initialStats.files + ' | Directories: ' + initialStats.directories;
        
        // Handle window resize
        window.addEventListener('resize', function() {
            if (currentView === 'map') {
                renderMap(currentMapData, 'mapSvg', 'mapTooltip', mapTransform, 'map');
            }
            if (currentFileDetailData && currentDetailTab === 'map') {
                renderMap(currentFileDetailData, 'fileDetailSvg', 'fileDetailTooltip', fileDetailMapTransform, 'file-detail');
            }
        });
    </script>
</body>
</html>`;
}

function renderTreeHTML(node, level, prefix, isLast) {
    if (level === undefined) level = 0;
    if (prefix === undefined) prefix = '';
    if (isLast === undefined) isLast = true;
    
    let html = '';
    
    if (level > 0) {
        html += '<div class="tree-node' + (node.type === 'file' ? ' clickable' : '') + '"';
        if (node.type === 'file') {
            const filePath = (node.path || node.name).replace(/'/g, "\\'");
            html += ' onclick="openFileDetail(\'' + filePath + '\')"';
        }
        html += '>';
        html += '<span class="branch-line">' + prefix + (isLast ? '└── ' : '├── ') + '</span>';
        
        if (node.type === 'directory') {
            html += '<span class="toggle-btn" onclick="event.stopPropagation(); toggleFolder(this)">▼</span>';
            html += '<span class="icon folder">📁</span>';
            html += '<span class="folder">' + escapeHtml(node.name) + '/</span>';
            html += '</div>';
            
            if (node.children && node.children.length > 0) {
                html += '<div class="tree-item">';
                const newPrefix = prefix + (isLast ? '    ' : '│   ');
                for (let i = 0; i < node.children.length; i++) {
                    html += renderTreeHTML(node.children[i], level + 1, newPrefix, i === node.children.length - 1);
                }
                html += '</div>';
            }
        } else {
            html += '<span class="icon file">📄</span>';
            html += '<span class="file clickable">' + escapeHtml(node.name) + '</span>';
            html += '</div>';
        }
    } else {
        html += '<div class="tree-node">';
        html += '<span class="icon folder">📁</span>';
        html += '<span class="folder" style="font-weight: bold;">' + escapeHtml(node.name) + '/</span>';
        html += '</div>';
        
        if (node.children && node.children.length > 0) {
            html += '<div class="tree-item">';
            for (let i = 0; i < node.children.length; i++) {
                html += renderTreeHTML(node.children[i], 1, '', i === node.children.length - 1);
            }
            html += '</div>';
        }
    }
    
    return html;
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    try {
        if (pathname === '/') {
            const tree = await buildFileTree(absolutePath);
            const html = generateHTML(tree, isGitRepo, commits);
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        } else if (pathname.startsWith('/tree/')) {
            const commitHash = pathname.split('/tree/')[1];
            
            if (!isGitRepo) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not a git repository' }));
                return;
            }
            
            const tree = buildGitFileTree(commitHash);
            const commit = commits.find(c => c.hash === commitHash);
            const stats = countNodes(tree);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tree, commit, stats }));
        } else if (pathname.startsWith('/map/')) {
            const commitHash = pathname.split('/map/')[1];
            
            if (!isGitRepo) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not a git repository' }));
                return;
            }
            
            const tree = buildGitFileTree(commitHash);
            const mapData = calculateMapData(tree);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mapData));
        } else if (pathname.startsWith('/file-detail/')) {
            const filePath = decodeURIComponent(pathname.split('/file-detail/')[1]);
            const commitHash = query.commit || null;
            
            const detailMapData = calculateFileDetailMapData(filePath, commitHash);
            
            if (!detailMapData) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ nodes: [], links: [], structure: null }));
                return;
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(detailMapData));
        } else if (pathname.startsWith('/file-content/')) {
            const filePath = decodeURIComponent(pathname.split('/file-content/')[1]);
            const commitHash = query.commit || null;
            
            const content = getFileContent(filePath, commitHash);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                content: content,
                path: filePath,
                commit: commitHash
            }));
        } else if (pathname.startsWith('/file-blocks/')) {
            const filePath = decodeURIComponent(pathname.split('/file-blocks/')[1]);
            const commitHash = query.commit || null;
            
            const blockData = buildBlockTree(filePath, commitHash);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(blockData));
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    } catch (error) {
        console.error('Server error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
});

function countNodes(node) {
    let files = 0;
    let directories = 0;
    
    if (node.type === 'file') files++;
    else if (node.type === 'directory') directories++;
    
    if (node.children) {
        node.children.forEach(child => {
            const counts = countNodes(child);
            files += counts.files;
            directories += counts.directories;
        });
    }
    
    return { files, directories };
}

server.listen(PORT, () => {
    console.log(`\n🌳 File Tree Visualizer running at http://localhost:${PORT}`);
    console.log(`📁 Visualizing: ${absolutePath}`);
    
    if (isGitRepo) {
        console.log(`📜 Git repository detected with ${commits.length} commits`);
        console.log(`🔄 Use the slider to navigate through commit history`);
        console.log(`🗺️  Toggle between Tree and Map views`);
        console.log(`📄 Click on files to view detailed structure analysis with multi-language support`);
        console.log(`🔍 Rich Block Explorer tab now shows block type, header, line range, keywords, call counts, child counts, and inline comments\n`);
    } else {
        console.log(`ℹ️  Not a git repository - showing current file structure only`);
        console.log(`📄 Click on files to view detailed structure analysis with multi-language support`);
        console.log(`🔍 Rich Block Explorer tab now shows block type, header, line range, keywords, call counts, child counts, and inline comments\n`);
    }
});

process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});