import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates a JS file with the content of another JS file wrapped in a template string const
 * @param {string} jsFilePath - Path to the source .js file
 * @param {string} outputFilePath - Path for the output .js file
 * @param {Object} options - Configuration options
 * @returns {Object} Result object with conversion details
 */
export function JStoString(jsFilePath, outputFilePath, options = {}) {
    // Validate inputs
    if (typeof jsFilePath !== 'string') {
        throw new Error('JS file path must be a string');
    }
    if (typeof outputFilePath !== 'string') {
        throw new Error('Output file path must be a string');
    }
    
    // Check if JS file exists
    if (!fs.existsSync(jsFilePath)) {
        throw new Error(`JS file not found: ${jsFilePath}`);
    }
    if (!jsFilePath.endsWith('.js')) {
        throw new Error('Input file must be a .js file');
    }
    if (!outputFilePath.endsWith('.js')) {
        throw new Error('Output file must have .js extension');
    }

    const defaultOptions = {
        constName: null,
        minify: false,
        addHeaders: true,
        validateJS: false,
        encoding: 'utf8',
        backupOriginal: false,
        updateExisting: false,
        autoConfirm: false,
        ...options
    };

    try {
        // Read the JS file content
        const jsCode = fs.readFileSync(jsFilePath, defaultOptions.encoding);
        
        // Generate a safe variable name
        const baseName = path.basename(jsFilePath, '.js');
        const safeVarName = defaultOptions.constName || generateSafeVarName(baseName);

        // Advanced escaping for JavaScript code in template string
        const escapedJSCode = escapeJSForTemplateString(jsCode, defaultOptions.minify);

        // Optional: update an existing wrapper file in place (const/let/var string values only)
        if (defaultOptions.updateExisting) {
            return updateExistingWrapper(outputFilePath, escapedJSCode, jsFilePath, defaultOptions);
        }

        // Create backup if requested
        if (defaultOptions.backupOriginal && fs.existsSync(outputFilePath)) {
            const backupPath = outputFilePath + '.backup';
            fs.copyFileSync(outputFilePath, backupPath);
        }

        // Generate the wrapped JavaScript content
        const wrappedJSContent = generateWrappedJSContent(jsFilePath, safeVarName, escapedJSCode, defaultOptions);

        // Ensure output directory exists
        const outputDir = path.dirname(outputFilePath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });
        }

        // Write the wrapped JavaScript file
        fs.writeFileSync(outputFilePath, wrappedJSContent, defaultOptions.encoding);
        
        // Set appropriate file permissions
        fs.chmodSync(outputFilePath, 0o644);
        
        const result = {
            success: true,
            variableName: safeVarName,
            inputFile: jsFilePath,
            outputFile: outputFilePath,
            originalSize: jsCode.length,
            escapedSize: escapedJSCode.length,
            compressionRatio: ((jsCode.length - escapedJSCode.length) / jsCode.length * 100).toFixed(2)
        };
        
        console.log(`✅ Successfully created ${outputFilePath}`);
        console.log(`📦 JS code wrapped in const: ${safeVarName}`);
        console.log(`📊 Original: ${jsCode.length} bytes, Escaped: ${escapedJSCode.length} bytes (${result.compressionRatio}% change)`);
        
        return result;
        
    } catch (error) {
        console.error(`❌ Failed to create JS wrapper: ${error.message}`);
        throw error;
    }
}

/**
 * Advanced escaping specifically for JavaScript code in template strings
 */
function escapeJSForTemplateString(jsCode, minify = false) {
    let processed = jsCode;
    
    // Normalize line endings first
    processed = processed.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Minify if requested (basic minification for JS)
    if (minify) {
        processed = processed
            // Remove single-line comments
            .replace(/\/\/[^\n]*/g, '')
            // Remove multi-line comments carefully
            .replace(/\/\*[\s\S]*?\*\//g, '')
            // Collapse whitespace
            .replace(/\s+/g, ' ')
            // Clean around operators and punctuation
            .replace(/\s*([{}();,=+\-*\/<>!&|?:[\]])\s*/g, '$1')
            .trim();
    }
    
    // CRITICAL: Escape template string special characters in correct order
    return processed
        // Escape backslashes first - this is crucial!
        .replace(/\\/g, '\\\\')
        // Escape backticks
        .replace(/`/g, '\\`')
        // Escape ${ sequences - prevent template interpolation
        .replace(/\$\{/g, '\\${')
        // Escape carriage returns
        .replace(/\r/g, '\\r')
        // Escape form feeds
        .replace(/\f/g, '\\f')
        // Escape vertical tabs
        .replace(/\v/g, '\\v')
        // Escape tabs
        .replace(/\t/g, '\\t')
        // Escape newlines (important for multi-line template strings)
        .replace(/\n/g, '\\n')
        // Escape Unicode line separators
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * Generates safe JavaScript variable name
 */
function generateSafeVarName(baseName) {
    return baseName
        .replace(/[^a-zA-Z0-9_$]/g, '_')
        .replace(/^[0-9]/, '_$&')
        .replace(/_+/g, '_')
        .substring(0, 50);
}

/**
 * Generates the wrapped JavaScript content
 */
function generateWrappedJSContent(jsFilePath, varName, escapedCode, options) {
    const headers = options.addHeaders ? `/**
 * Auto-generated wrapper for JS file: ${path.basename(jsFilePath)}
 * Original path: ${jsFilePath}
 * Generated on: ${new Date().toISOString()}
 * Original size: ${fs.statSync(jsFilePath).size} bytes
 * Wrapped size: ${escapedCode.length} characters
 * 
 * WARNING: This file contains the original JS code as a string literal.
 * Do not edit this file directly - edit the original source file instead.
 */
` : '';

    return `${headers}const ${varName} = \`${escapedCode}\`;

// Export for ES6 modules
export default ${varName};

// Export for CommonJS (Node.js)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ${varName};
    module.exports.default = ${varName};
}

// Global scope assignment (browser environment)
if (typeof window !== 'undefined') {
    window.${varName} = ${varName};
}

// Utility function to evaluate the wrapped code (use with caution!)
export function evaluateWrappedCode() {
    return eval(${varName});
}

// Utility function to get code stats
export function getCodeStats() {
    return {
        length: ${varName}.length,
        lines: ${varName}.split('\\\\n').length,
        originalFile: '${jsFilePath}',
        generated: '${new Date().toISOString()}'
    };
}
`;
}

/**
 * Validates basic JavaScript syntax
 */
function validateJSSyntax(jsCode) {
    if (jsCode.trim().length === 0) {
        throw new Error('JavaScript code cannot be empty');
    }

    // Check for common JS syntax issues
    const lines = jsCode.split('\n');
    
    // Check for unclosed template literals
    const templateLiteralStarts = (jsCode.match(/`/g) || []).length;
    if (templateLiteralStarts % 2 !== 0) {
        throw new Error('Unclosed template literal detected in source JS');
    }
    
    // Check for unclosed comments
    const blockCommentStarts = (jsCode.match(/\/\*/g) || []).length;
    const blockCommentEnds = (jsCode.match(/\*\//g) || []).length;
    if (blockCommentStarts !== blockCommentEnds) {
        throw new Error('Unclosed block comment detected in source JS');
    }
    
    // Check for unclosed strings (basic check)
    const singleQuotes = (jsCode.match(/'/g) || []).length;
    const doubleQuotes = (jsCode.match(/"/g) || []).length;
    if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
        console.warn('⚠️  Warning: Possible unclosed string in source JS');
    }
}

/**
 * Batch wrapper for multiple JS files
 */
export function batchWrapJSFiles(files, outputDir, options = {}) {
    if (!Array.isArray(files)) {
        throw new Error('files must be an array');
    }

    const results = [];
    
    for (const file of files) {
        try {
            const outputFile = path.join(outputDir, `wrapped_${path.basename(file)}`);
            const result = JStoString(file, outputFile, options);
            results.push(result);
        } catch (error) {
            results.push({
                success: false,
                file,
                error: error.message
            });
        }
    }
    
    return results;
}

/**
 * Creates a wrapped version with additional safety features
 */
export function createSecureJSWrapper(jsFilePath, outputFilePath, options = {}) {
    const secureOptions = {
        validateJS: true,
        backupOriginal: true,
        minify: false, // Don't minify for security
        addHeaders: true,
        ...options
    };

    // Read and validate the source JS first
    const jsCode = fs.readFileSync(jsFilePath, 'utf8');
    validateJSSyntax(jsCode);
    
    // Additional security checks
    if (jsCode.includes('process.env') || jsCode.includes('require(') || jsCode.includes('import.meta')) {
        console.warn('⚠️  Warning: Source JS contains potentially sensitive code');
    }
    
    return JStoString(jsFilePath, outputFilePath, secureOptions);
}

/**
 * CLI interface
 */
function runCLI() {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        showHelp();
        process.exit(0);
    }
    
    if (args.includes('--version') || args.includes('-v')) {
        console.log('JStoString v1.0.0');
        process.exit(0);
    }
    
    const jsFilePath = args[0];
    let outputFilePath = args[1];
    
    // Generate default output path if not provided
    if (!outputFilePath) {
        const baseName = path.basename(jsFilePath, '.js');
        const dirName = path.dirname(jsFilePath);
        outputFilePath = path.join(dirName, `wrapped_${baseName}.js`);
    }
    
    // Ensure output has .js extension
    if (!outputFilePath.endsWith('.js')) {
        outputFilePath += '.js';
    }
    
    // Determine whether to use update mode on the second argument
    const forceUpdate = args.includes('--update');
    const forceOutput = args.includes('--force-output');
    let useUpdate = forceUpdate;

    if (!forceUpdate && !forceOutput && args[1] && fs.existsSync(outputFilePath)) {
        try {
            const targetContent = fs.readFileSync(outputFilePath, 'utf8');
            // Looks like a wrapper file if it has a const/let/var = `...` declaration
            if (/(?:const|let|var)\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*`/.test(targetContent)) {
                useUpdate = true;
            }
        } catch (e) {
            // On read error, fall back to output mode
        }
    }
    
    const options = {
        minify: args.includes('--minify'),
        addHeaders: !args.includes('--no-headers'),
        validateJS: args.includes('--validate'),
        backupOriginal: args.includes('--backup'),
        constName: getOptionValue(args, '--name'),
        updateExisting: useUpdate,
        autoConfirm: args.includes('--yes') || args.includes('-y')
    };
    
    try {
        JStoString(jsFilePath, outputFilePath, options);
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        process.exit(1);
    }
}

/**
 * Get value for named options from CLI args
 */
function getOptionValue(args, optionName) {
    const index = args.indexOf(optionName);
    if (index !== -1 && args[index + 1]) {
        return args[index + 1];
    }
    return null;
}

/**
 * Updates an existing wrapper file in place.
 * Finds const/let/var declarations whose template-string value is similar to
 * the newly escaped source content, asks the user (or auto-confirms), and
 * replaces ONLY the template string content. The variable name and every
 * other part of the file are left byte-for-byte intact.
 */
export function updateExistingWrapper(targetFile, newEscapedContent, sourceJsPath, options = {}) {
    if (!fs.existsSync(targetFile)) {
        throw new Error(`Target file for update not found: ${targetFile}`);
    }

    const targetContent = fs.readFileSync(targetFile, options.encoding || 'utf8');

    // Match: (const|let|var) <name> = `...`
    // Content group handles escaped backslashes / backticks correctly.
    const regex = /((?:const|let|var)\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*`)((?:\\.|[^`\\])*)(`)/g;

    const matches = [];
    let match;
    while ((match = regex.exec(targetContent)) !== null) {
        const fullMatch = match[0];
        const prefix = match[1];
        const oldContent = match[2];
        const closingBacktick = match[3];

        const nameMatch = /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(prefix);
        const varName = nameMatch ? nameMatch[1] : 'unknown';

        const sim = calculateStringSimilarity(oldContent, newEscapedContent);

        matches.push({
            start: match.index,
            end: match.index + fullMatch.length,
            prefix,
            oldContent,
            closingBacktick,
            varName,
            similarity: sim
        });
    }

    if (matches.length === 0) {
        console.log(`ℹ️  No const/let/var template-string declarations found in ${targetFile}. Nothing to update.`);
        return {
            success: true,
            updated: false,
            reason: 'no-declarations',
            targetFile
        };
    }

    const SIMILARITY_THRESHOLD = 0.3;
    const autoConfirm = !!options.autoConfirm;
    const replacements = [];

    console.log(`🔍 Found ${matches.length} template-string declaration(s) in ${targetFile}`);

    for (const m of matches) {
        if (m.similarity < SIMILARITY_THRESHOLD) {
            console.log(`⏭️  Skipping '${m.varName}' (similarity ${(m.similarity * 100).toFixed(1)}% < ${(SIMILARITY_THRESHOLD * 100).toFixed(0)}%)`);
            continue;
        }

        let shouldReplace = false;
        if (autoConfirm) {
            shouldReplace = true;
            console.log(`✅ Auto-replacing '${m.varName}' (similarity ${(m.similarity * 100).toFixed(1)}%)`);
        } else {
            const answer = syncPrompt(`Replace content of '${m.varName}' in ${targetFile}? (similarity ${(m.similarity * 100).toFixed(1)}%) [y/N] `);
            shouldReplace = /^(y|yes)$/i.test(answer.trim());
            if (!shouldReplace) {
                console.log(`   Skipped '${m.varName}'`);
            }
        }

        if (shouldReplace) {
            replacements.push(m);
        }
    }

    if (replacements.length === 0) {
        console.log(`ℹ️  No replacements selected. ${targetFile} unchanged.`);
        return {
            success: true,
            updated: false,
            reason: 'no-selection',
            targetFile
        };
    }

    // Create backup if requested
    if (options.backupOriginal) {
        const backupPath = targetFile + '.backup';
        fs.copyFileSync(targetFile, backupPath);
    }

    // Apply replacements from end to start so earlier offsets stay valid
    let newTargetContent = targetContent;
    const sortedReplacements = [...replacements].sort((a, b) => b.start - a.start);
    for (const r of sortedReplacements) {
        const newText = r.prefix + newEscapedContent + r.closingBacktick;
        newTargetContent = newTargetContent.slice(0, r.start) + newText + newTargetContent.slice(r.end);
    }

    fs.writeFileSync(targetFile, newTargetContent, options.encoding || 'utf8');
    fs.chmodSync(targetFile, 0o644);

    console.log(`✅ Updated ${replacements.length} variable(s) in ${targetFile}`);
    replacements.forEach(r => console.log(`   - ${r.varName}`));

    return {
        success: true,
        updated: true,
        targetFile,
        sourceFile: sourceJsPath,
        replacedVariables: replacements.map(r => r.varName),
        replacedCount: replacements.length,
        originalSize: targetContent.length,
        newSize: newTargetContent.length
    };
}

/**
 * Jaccard similarity on character bigrams (same idea as Replacer.js)
 */
function calculateStringSimilarity(str1, str2) {
    if (str1 === str2) return 1;
    if (!str1 || !str2) return 0;

    const bigrams = (str) => {
        const grams = new Set();
        for (let i = 0; i < str.length - 1; i++) {
            grams.add(str.slice(i, i + 2));
        }
        return grams;
    };

    const s1 = bigrams(str1);
    const s2 = bigrams(str2);
    const intersection = new Set([...s1].filter(x => s2.has(x)));
    const union = new Set([...s1, ...s2]);
    return union.size === 0 ? 1 : intersection.size / union.size;
}

/**
 * Minimal synchronous prompt (reads one line from stdin, fd 0)
 */
function syncPrompt(question) {
    process.stdout.write(question);
    let line = '';
    const buf = Buffer.alloc(1);
    let safety = 0;
    while (safety < 65536) {
        safety++;
        let bytesRead;
        try {
            bytesRead = fs.readSync(0, buf, 0, 1, null);
        } catch (e) {
            break;
        }
        if (bytesRead === 0) break;
        const ch = buf.toString('utf8', 0, 1);
        if (ch === '\n') break;
        if (ch !== '\r') line += ch;
    }
    return line;
}

/**
 * Show CLI help
 */
function showHelp() {
    console.log(`
Usage: js-to-string <input.js> [output.js] [options]

Convert JS files to JavaScript modules with the JS code as template strings.

Arguments:
  input.js                Path to the input JS file (required)
  output.js               Path to the output JS file (optional, defaults to wrapped_<input>.js)
                          If this file already exists and contains template-string variable
                          declarations, it will be updated in place (see --update / --force-output).

Options:
  --minify                Minify the JS code before embedding
  --no-headers            Skip adding header comments to the output
  --validate              Perform basic JS syntax validation
  --backup                Create backup of output file if it exists
  --name <constName>      Custom constant name for the wrapped code
  --update                Force update mode: treat the second argument as an existing
                          wrapper file and replace matching template-string values in place
  --force-output          Force output mode: overwrite the second argument instead of
                          updating it in place
  --yes, -y               Auto-confirm all replacements in update mode (no prompt)
  -h, --help              Show this help message
  -v, --version           Show version information

Examples:
  js-to-string script.js
  js-to-string script.js output.js
  js-to-string script.js --minify --validate
  js-to-string script.js output.js --minify --no-headers --name myCode
  js-to-string script.js --name AppCode --backup
  js-to-string new-script.js existing-wrapper.js
  js-to-string new-script.js existing-wrapper.js --update --yes
  js-to-string new-script.js existing-wrapper.js --force-output
`);
}

// Check if the script is being run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runCLI();
}

// Default export
export default JStoString;
