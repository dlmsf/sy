import { promises as fs } from 'fs';
import path from 'path';
import process from 'process';
import os from 'os';
import readline from 'readline';
import { CodeParser, Selection, CodeEmitter, CLIMenu } from './CodeParser.js';

// ============================================================
//  ANSI escape codes for terminal control
// ============================================================
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const REVERSE = '\x1b[7m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';

// ============================================================
//  Helper: clear screen and move cursor to top-left
// ============================================================
function clearScreen() {
    process.stdout.write(CLEAR_SCREEN);
}

// ============================================================
//  Format number with dot thousands separator
//  Example: 1000000 -> 1.000.000
// ============================================================
function formatNumber(value) {
    return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ============================================================
//  Read directory contents (async)
// ============================================================
async function readDirectory(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
    });

    return entries;
}

// ============================================================
//  Check if any path contains ._ pattern
// ============================================================
function hasSpecialPathPattern(filePaths) {
    return filePaths.some(filePath => 
        filePath.split(path.sep).some(part => part.startsWith('._'))
    );
}

// ============================================================
//  Generate path preservation enforcement block
// ============================================================
function generatePathEnforcement(filePaths, outputFormat) {
    const specialPaths = filePaths.filter(filePath => 
        filePath.split(path.sep).some(part => part.startsWith('._'))
    );
    
    if (specialPaths.length === 0) return '';
    
    let enforcement = '';
    enforcement += `${'-'.repeat(50)}\n`;
    enforcement += `CRITICAL PATH PRESERVATION ENFORCEMENT\n`;
    enforcement += `${'-'.repeat(50)}\n\n`;
    enforcement += `The following file paths contain directory names starting with "._":\n\n`;
    
    specialPaths.forEach(filePath => {
        enforcement += `  ACTUAL PATH: ${filePath}\n`;
    });
    
    enforcement += `\nMANDATORY RULES:\n`;
    enforcement += `1. You MUST copy the PATH='...' value EXACTLY as shown in the FILE: header above.\n`;
    enforcement += `2. Directory names starting with "._" (like "._backup", "._config", "._") are REAL directory names.\n`;
    enforcement += `3. "._/" is NOT the same as "./" - they are completely different directories.\n`;
    enforcement += `4. NEVER convert "._/" to "./" or "././" - this will point to a NON-EXISTENT file.\n`;
    enforcement += `5. Copy the path character by character, preserving every "._/" exactly.\n`;
    enforcement += `6. If you see "/._/._/._/", write "/._/._/._/" - not "/././._/" or any other variation.\n\n`;
    
    if (outputFormat === 'tagged' || outputFormat === 'both') {
        enforcement += `SPECIFIC EXAMPLE FOR TAGGED OUTPUT:\n`;
        enforcement += `  WRONG: PATH='${specialPaths[0].replace(/\._\//g, './')}'  ← THIS WILL FAIL\n`;
        enforcement += `  CORRECT: PATH='${specialPaths[0]}'  ← THIS IS REQUIRED\n\n`;
        enforcement += `When generating [CODEREPLACER-START] tags, the PATH attribute must be\n`;
        enforcement += `copied EXACTLY from the FILE: header. Verify each character before output.\n\n`;
    }
    
    enforcement += `VERIFICATION CHECK:\n`;
    enforcement += `Before outputting any path, compare it character by character with the FILE: header.\n`;
    enforcement += `If they don't match exactly, you have made an error and must correct it.\n`;
    enforcement += `${'-'.repeat(50)}\n\n`;
    
    return enforcement;
}

// ============================================================
//  Check if file is a JavaScript/TypeScript file
// ============================================================
function isJavaScriptFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext);
}

// ============================================================
//  Generate struct file from a list of absolute paths
// ============================================================
async function generateStruct(filePaths, outputFileName = 'struct', options = {}) {
    const {
        includeInstructions = false,
        userDemand = '',
        outputFormat = 'full',
        parsedFiles = null,
    } = options;

    let structContent = '';
    const needsPathEnforcement = hasSpecialPathPattern(filePaths);

    if (includeInstructions) {
        structContent += `${'='.repeat(50)}\n`;
        structContent += `AI INSTRUCTIONS\n`;
        structContent += `${'='.repeat(50)}\n`;

        structContent += `You are an AI assistant helping with code modifications.\n`;
        structContent += `Below are the current contents of the selected files.\n`;
        structContent += `Your task is to apply the following user request:\n\n`;
        structContent += `USER REQUEST:\n${userDemand}\n\n`;

        if (needsPathEnforcement) {
            structContent += generatePathEnforcement(filePaths, outputFormat);
        }

        if (parsedFiles && parsedFiles.size > 0) {
            structContent += `${'!'.repeat(50)}\n`;
            structContent += `⚠️  WARNING: PARSED FILES DETECTED\n`;
            structContent += `${'!'.repeat(50)}\n\n`;
            structContent += `The following files have been PARSED using CodeParser.\n`;
            structContent += `This means their content has been FILTERED - only selected\n`;
            structContent += `portions are shown below.\n\n`;
            for (const [filePath, info] of parsedFiles.entries()) {
                structContent += `  PARSED FILE: ${filePath}\n`;
                structContent += `  Original size: ${formatNumber(info.originalSize)} bytes | Parsed size: ${formatNumber(info.parsedSize)} bytes\n`;
                structContent += `  Stats: ${info.stats.containers} containers, ${info.stats.functions} functions, ${info.stats.totalMembers} members\n`;
                if (info.notes && info.notes.length > 0) {
                    structContent += `  Notes:\n`;
                    info.notes.forEach(note => structContent += `    • ${note}\n`);
                }
                structContent += `\n`;
            }
            structContent += `IMPORTANT: When making replacements in these files, use the\n`;
            structContent += `[CODEREPLACER] tagged format. The parsed content shown is a\n`;
            structContent += `FILTERED version - the actual file on disk contains MORE code\n`;
            structContent += `than what is shown. Replacements must target the EXACT original\n`;
            structContent += `text in the actual file.\n\n`;
            structContent += `${'!'.repeat(50)}\n\n`;
        }

        if (outputFormat === 'full') {
            structContent += `OUTPUT FORMAT: FULL FILES\n`;
            structContent += `Provide the complete new content for EVERY file that requires changes.\n`;
            structContent += `Do not abbreviate or omit any parts. Output each file's entire content.\n`;
            structContent += `Use the same file path headers as provided below.\n\n`;
        } else if (outputFormat === 'tagged') {
            structContent += `OUTPUT FORMAT: TAGGED REPLACEMENTS (CODEREPLACER)\n`;
            structContent += `Use the following tag structure to specify replacements within files:\n\n`;
            structContent += `[CODEREPLACER-START]\n`;
            structContent += `PATH='<absolute path to file>'\n`;
            structContent += `[NEW-REPLACE-START]\n`;
            structContent += `[ORIGINAL-START]\n`;
            structContent += `<exact original text to replace>\n`;
            structContent += `[/ORIGINAL-END]\n`;
            structContent += `[REPLACE-START]\n`;
            structContent += `<replacement text>\n`;
            structContent += `[/REPLACE-END]\n`;
            structContent += `[/NEW-REPLACE-END]\n`;
            structContent += `[/CODEREPLACER-END]\n\n`;
            structContent += `You can include multiple [NEW-REPLACE-START] blocks for multiple replacements in the same file.\n`;
            structContent += `Ensure the original text exactly matches the file content (including whitespace).\n`;
            structContent += `CRITICAL: In PATH='...', copy the path EXACTLY from the FILE: header.\n`;
            structContent += `Verify each character matches before outputting.\n\n`;
        } else if (outputFormat === 'both') {
            structContent += `OUTPUT FORMAT: BOTH FULL FILES AND TAGGED REPLACEMENTS\n`;
            structContent += `You may provide either full file contents or tagged replacements, as appropriate.\n`;
            structContent += `For each file, decide which method is cleaner and use that.\n`;
            structContent += `Clearly separate the two approaches if mixed.\n`;
            structContent += `CRITICAL: Regardless of format, preserve the exact path in all outputs.\n\n`;
        }

        structContent += `${'='.repeat(50)}\n\n`;
    }

    for (const filePath of filePaths) {
        try {
            const content = await fs.readFile(filePath, 'utf8');

            structContent += `${'='.repeat(50)}\n`;
            structContent += `FILE: ${filePath}\n`;
            structContent += `${'='.repeat(50)}\n`;

            const parsedInfo = parsedFiles?.get(filePath);
            if (parsedInfo) {
                structContent += `[NOTE: This file has been PARSED - showing FILTERED content only]\n`;
                structContent += parsedInfo.parsedContent;
                if (!parsedInfo.parsedContent.endsWith('\n')) structContent += '\n';
            } else {
                structContent += content;
                if (!content.endsWith('\n')) structContent += '\n';
            }
            
            structContent += '\n';
        } catch (err) {
            console.error(`\nError reading ${filePath}: ${err.message}`);
        }
    }

    await fs.writeFile(outputFileName, structContent, 'utf8');
    console.log(`\nStruct file written to: ${path.resolve(outputFileName)}`);
    
    if (needsPathEnforcement && includeInstructions) {
        console.log(`\n${YELLOW}⚠️  Path preservation enforcement added - paths with ._/ patterns detected${RESET}`);
    }
    
    if (parsedFiles && parsedFiles.size > 0) {
        console.log(`\n${MAGENTA}🔍 Parsed ${parsedFiles.size} JavaScript file(s) with CodeParser${RESET}`);
    }
}

// ============================================================
//  Save absolute paths to a file (one per line) in /tmp
// ============================================================
async function savePaths(filePaths, saveName) {
    const temporaryDirectory = os.tmpdir();
    const savePath = path.join(temporaryDirectory, saveName);

    await fs.writeFile(savePath, filePaths.join('\n'), 'utf8');
    console.log(`Paths saved to: ${savePath}`);

    return savePath;
}

// ============================================================
//  Load absolute paths from a savename file in /tmp
// ============================================================
async function loadPaths(saveName) {
    const temporaryDirectory = os.tmpdir();
    const savePath = path.join(temporaryDirectory, saveName);
    const data = await fs.readFile(savePath, 'utf8');

    return data
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
}

// ============================================================
//  Token-count estimation based on file size
// ============================================================
async function getFileTokenCount(filePath) {
    try {
        const stats = await fs.stat(filePath);
        return Math.max(1, Math.round(stats.size / 4));
    } catch {
        return 0;
    }
}

// ============================================================
//  Recursively collect all file paths under a directory
// ============================================================
async function collectAllFiles(directory) {
    let entries;

    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
        return [];
    }

    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            const nestedFiles = await collectAllFiles(fullPath);
            files.push(...nestedFiles);
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    return files;
}

// ============================================================
//  Run CodeParser CLI menu for a specific file
//  Returns the selection made by the user
// ============================================================
async function runParserMenu(filePath) {
    console.log(`\n${YELLOW}Loading CodeParser for: ${path.basename(filePath)}${RESET}\n`);
    
    try {
        // Parse the file
        CodeParser.parse(filePath);
        const summary = CodeParser.getSummary();
        
        // Create readline for quick menu
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true
        });
        
        const ask = (question) => new Promise(res => rl.question(question, res));
        
        console.log(`${BOLD}─── CODE PARSER QUICK MENU ───${RESET}`);
        console.log(`File: ${path.basename(filePath)}`);
        console.log(`Stats: ${summary.totalLines} lines | ${summary.containers} containers | ${summary.functions} functions | ${summary.totalMembers} members\n`);
        
        console.log(`Quick options:`);
        console.log(`  1. Include ALL containers (classes/interfaces/enums)`);
        console.log(`  2. Include ALL functions`);
        console.log(`  3. Include ALL variables`);
        console.log(`  4. Include ALL imports`);
        console.log(`  5. Custom selection (full CodeParser menu)`);
        console.log(`  6. Skip parsing (use original file)`);
        
        const choice = await ask(`\nChoose option (1-6): `);
        
        let finalSelection = Selection.empty();
        
        if (choice.trim() === '5') {
            // For full menu, close quick menu readline first
            rl.close();
            
            console.log(`\n${YELLOW}Launching full CodeParser menu...${RESET}\n`);
            
            // Create new readline for full menu
            const fullRl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: true
            });
            
            const menu = new CLIMenu({ 
                rl: fullRl,
                integrationMode: true
            });
            
            const completionPromise = menu.waitForCompletion();
            menu.start(filePath).catch(() => {});
            finalSelection = await completionPromise;
            
            // Close full menu readline
            fullRl.close();
            
        } else if (choice.trim() === '6' || choice.trim() === '') {
            console.log(`\nSkipping parser - using original file.`);
            rl.close();
            return null;
        } else {
            // Quick options
            switch (choice.trim()) {
                case '1':
                    CodeParser.getContainers().forEach(c => {
                        finalSelection.containers[c.name] = { members: null };
                    });
                    break;
                case '2':
                    finalSelection.functions = CodeParser.getFunctions().map(f => f.name);
                    break;
                case '3':
                    finalSelection.includeVariables = true;
                    break;
                case '4':
                    finalSelection.includeImports = true;
                    break;
                default:
                    console.log(`\nInvalid option - skipping parser.`);
                    rl.close();
                    return null;
            }
            rl.close();
        }
        
        // Generate filtered content
        const filtered = CodeParser.generateFiltered(finalSelection);
        const report = CodeParser.getLastReport();
        
        if (filtered && filtered.trim()) {
            console.log(`\n${GREEN}✓ Parsed! Generated ${filtered.split('\n').length} lines (from ${summary.totalLines} original)${RESET}`);
            if (report.notes.length) {
                console.log(`\n${YELLOW}Notes:${RESET}`);
                report.notes.forEach(n => console.log(`  • ${n}`));
            }
            if (!report.validation.ok) {
                console.log(`\n${RED}⚠️  WARNING: Validation issues detected!${RESET}`);
                report.validation.issues.forEach(i => console.log(`  • ${i}`));
            }
        } else {
            console.log(`\n${YELLOW}Empty output generated - using original file.${RESET}`);
            return null;
        }
        
        return {
            selection: finalSelection,
            content: filtered,
            stats: summary,
            notes: report.notes,
            validation: report.validation
        };
    } catch (err) {
        console.error(`\n${RED}Error in CodeParser: ${err.message}${RESET}`);
        console.log(`Using original file.`);
        return null;
    }
}

// ============================================================
//  Interactive file/directory navigation & selection
// ============================================================
async function interactiveMode() {
    const originalRawMode = process.stdin.isRaw;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let currentDirectory = process.cwd();
    let entries = await readDirectory(currentDirectory);
    let cursorIndex = 0;
    let scrollOffset = 0;

    const selectedFiles = new Set();
    const selectedTokenCounts = new Map();
    const parsedFiles = new Map();
    let totalTokens = 0;

    function getMaxEntries() {
        const terminalRows = process.stdout.rows || 24;
        const extraLines = parsedFiles.size > 0 ? 7 : 6;
        return Math.max(1, terminalRows - extraLines);
    }

    function adjustScrollOffset() {
        const maxEntries = getMaxEntries();

        if (cursorIndex < scrollOffset) {
            scrollOffset = cursorIndex;
        }

        if (cursorIndex >= scrollOffset + maxEntries) {
            scrollOffset = cursorIndex - maxEntries + 1;
        }

        const maxScrollOffset = Math.max(0, entries.length - maxEntries);
        if (scrollOffset > maxScrollOffset) {
            scrollOffset = maxScrollOffset;
        }

        if (scrollOffset < 0) {
            scrollOffset = 0;
        }
    }

    async function selectFile(filePath) {
        if (selectedFiles.has(filePath)) return;

        const tokenCount = await getFileTokenCount(filePath);

        selectedFiles.add(filePath);
        selectedTokenCounts.set(filePath, tokenCount);
        totalTokens += tokenCount;
    }

    function deselectFile(filePath) {
        if (!selectedFiles.has(filePath)) return;

        const tokenCount = selectedTokenCounts.get(filePath) || 0;

        selectedFiles.delete(filePath);
        selectedTokenCounts.delete(filePath);
        totalTokens -= tokenCount;
        
        parsedFiles.delete(filePath);
    }

    async function toggleFile(filePath) {
        if (selectedFiles.has(filePath)) {
            deselectFile(filePath);
        } else {
            await selectFile(filePath);
        }
    }

    async function toggleAllInCurrentDirectory() {
        const filePaths = entries
            .filter(entry => entry.isFile())
            .map(entry => path.join(currentDirectory, entry.name));

        const allSelected = filePaths.length > 0 && filePaths.every(filePath => selectedFiles.has(filePath));

        if (allSelected) {
            for (const filePath of filePaths) {
                deselectFile(filePath);
            }
        } else {
            for (const filePath of filePaths) {
                if (!selectedFiles.has(filePath)) {
                    await selectFile(filePath);
                }
            }
        }
    }

    async function toggleAllRecursivelyFromCurrentDirectory() {
        const filePaths = await collectAllFiles(currentDirectory);

        const allSelected = filePaths.length > 0 && filePaths.every(filePath => selectedFiles.has(filePath));

        if (allSelected) {
            for (const filePath of filePaths) {
                deselectFile(filePath);
            }
        } else {
            for (const filePath of filePaths) {
                if (!selectedFiles.has(filePath)) {
                    await selectFile(filePath);
                }
            }
        }
    }

    const render = () => {
        clearScreen();

        const maxEntries = getMaxEntries();
        adjustScrollOffset();

        const visibleEntries = entries.slice(scrollOffset, scrollOffset + maxEntries);
        const totalEntries = entries.length;
        const hasPagination = totalEntries > maxEntries;

        console.log(`${BOLD}${BLUE}Current directory:${RESET} ${YELLOW}${currentDirectory}${RESET}`);
        console.log(`${BOLD}Selected: ${selectedFiles.size} file(s) | Tokens: ${formatNumber(totalTokens)}${RESET}`);
        
        if (parsedFiles.size > 0) {
            console.log(`${RED}${BOLD}⚠️  ${parsedFiles.size} file(s) will be PARSED (filtered)${RESET}`);
        }
        
        console.log('─'.repeat(process.stdout.columns || 80));
        console.log(`${BOLD}Navigation:${RESET} ↑/↓ move, PgUp/PgDn page, Enter open/select, Space toggle, a current, A recursive, g gen, b back, q quit`);
        console.log('─'.repeat(process.stdout.columns || 80));

        visibleEntries.forEach((entry, index) => {
            const actualIndex = scrollOffset + index;
            const fullPath = path.join(currentDirectory, entry.name);
            let prefix = ' ';

            if (entry.isDirectory()) {
                prefix = `${BLUE}[DIR]${RESET} `;
            } else if (selectedFiles.has(fullPath)) {
                if (parsedFiles.has(fullPath)) {
                    prefix = `${MAGENTA}[🔍]${RESET} `;
                } else {
                    prefix = `${GREEN}[✔]${RESET} `;
                }
            } else {
                prefix = '[ ] ';
            }

            const line = `${prefix} ${entry.name}${entry.isDirectory() ? '/' : ''}`;

            if (actualIndex === cursorIndex) {
                console.log(`${REVERSE}${line}${RESET}`);
            } else {
                console.log(line);
            }
        });

        if (hasPagination) {
            const currentPage = Math.floor(scrollOffset / maxEntries) + 1;
            const totalPages = Math.ceil(totalEntries / maxEntries);
            console.log(`─ ${BOLD}${currentPage}${RESET}/${totalPages} ${totalEntries} items`);
        }
    };

    const cleanupAndExit = (code) => {
        process.stdin.setRawMode(originalRawMode);
        process.stdin.pause();
        process.exit(code);
    };

    const askQuestion = (question) => {
        return new Promise(resolve => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: false  // Don't use terminal mode to avoid conflicts
            });
            
            rl.question(question + ' ', (answer) => {
                rl.close();
                resolve(answer.trim());
            });
        });
    };

    const onKeypress = async (key) => {
        const maxEntries = getMaxEntries();

        if (key === '\u001b[A') {
            if (cursorIndex > 0) cursorIndex--;
            render();
            return;
        }

        if (key === '\u001b[B') {
            if (cursorIndex < entries.length - 1) cursorIndex++;
            render();
            return;
        }

        if (key === '\u001b[5~') {
            cursorIndex = Math.max(0, cursorIndex - maxEntries);
            render();
            return;
        }

        if (key === '\u001b[6~') {
            cursorIndex = Math.min(entries.length - 1, cursorIndex + maxEntries);
            render();
            return;
        }

        if (key === ' ') {
            if (entries.length > 0 && cursorIndex >= 0 && cursorIndex < entries.length) {
                const entry = entries[cursorIndex];

                if (!entry.isDirectory()) {
                    const fullPath = path.join(currentDirectory, entry.name);
                    await toggleFile(fullPath);
                }
            }

            render();
            return;
        }

        if (key === '\r' || key === '\n') {
            if (entries.length > 0 && cursorIndex >= 0 && cursorIndex < entries.length) {
                const entry = entries[cursorIndex];

                if (entry.isDirectory()) {
                    currentDirectory = path.join(currentDirectory, entry.name);
                    entries = await readDirectory(currentDirectory);
                    cursorIndex = 0;
                    scrollOffset = 0;
                } else {
                    const fullPath = path.join(currentDirectory, entry.name);
                    await toggleFile(fullPath);
                }
            }

            render();
            return;
        }

        if (key === 'a') {
            await toggleAllInCurrentDirectory();
            render();
            return;
        }

        if (key === 'A') {
            await toggleAllRecursivelyFromCurrentDirectory();
            render();
            return;
        }

        if (key === 'g' || key === 'G') {
            if (selectedFiles.size === 0) {
                console.log('\nNo files selected.');
                render();
                return;
            }

            // Temporarily disable raw mode for interactive prompts
            // REMOVE the keypress listener but DO NOT pause stdin
            process.stdin.removeListener('data', onKeypress);
            process.stdin.setRawMode(false);

            // STEP 1: Ask about parsing JavaScript files
            const jsFiles = [...selectedFiles].filter(isJavaScriptFile);
            
            if (jsFiles.length > 0) {
                console.log(`\n${YELLOW}${BOLD}=== CODE PARSER OPTION ===${RESET}`);
                console.log(`You have ${jsFiles.length} JavaScript/TypeScript file(s) selected.`);
                console.log(`CodeParser can FILTER these files to include only selected parts.\n`);
                
                const parseAnswer = await askQuestion(`Do you want to parse any JavaScript files with CodeParser? (y/n):`);
                
                if (parseAnswer.toLowerCase() === 'y' || parseAnswer.toLowerCase() === 'yes') {
                    console.log(`\n${BOLD}JavaScript files available for parsing:${RESET}`);
                    jsFiles.forEach((file, idx) => {
                        const alreadyParsed = parsedFiles.has(file) ? ' (already parsed)' : '';
                        console.log(`  ${idx + 1}. ${path.basename(file)}${alreadyParsed}`);
                    });
                    
                    const fileChoice = await askQuestion(`\nWhich files? (all | 1,3,5 | 2-4 | none):`);
                    
                    if (fileChoice.toLowerCase() !== 'none' && fileChoice.trim() !== '') {
                        let filesToParse = [];
                        
                        if (fileChoice.toLowerCase() === 'all') {
                            filesToParse = jsFiles;
                        } else {
                            const indexes = parseIndexes(fileChoice, jsFiles.length);
                            filesToParse = indexes.map(idx => jsFiles[idx]);
                        }
                        
                        for (const filePath of filesToParse) {
                            console.log(`\n${YELLOW}${'='.repeat(50)}${RESET}`);
                            console.log(`${YELLOW}=== Parsing: ${path.basename(filePath)} ===${RESET}`);
                            console.log(`${YELLOW}${'='.repeat(50)}${RESET}`);
                            
                            const parseResult = await runParserMenu(filePath);
                            
                            if (parseResult) {
                                const originalContent = await fs.readFile(filePath, 'utf8');
                                parsedFiles.set(filePath, {
                                    parsedContent: parseResult.content,
                                    originalSize: originalContent.length,
                                    parsedSize: parseResult.content.length,
                                    stats: parseResult.stats,
                                    notes: parseResult.notes,
                                    validation: parseResult.validation
                                });
                                console.log(`\n${GREEN}✓ ${path.basename(filePath)} parsed successfully${RESET}`);
                            }
                        }
                    }
                }
            } else {
                console.log(`\n${YELLOW}No JavaScript files selected - skipping parser option.${RESET}`);
            }

            // STEP 2: Ask about AI instructions
            const includeInstrAnswer = await askQuestion(`\nDo you want to add AI instructions? (y/n):`);
            const includeInstructions = includeInstrAnswer.toLowerCase() === 'y' || includeInstrAnswer.toLowerCase() === 'yes';

            let userDemand = '';
            let outputFormat = 'full';

            if (includeInstructions) {
                userDemand = await askQuestion('Enter your request/demand for the AI (single line):');
                const formatAnswer = await askQuestion('Output format - (1) Full files, (2) Tagged replacements, (3) Both:');
                if (formatAnswer === '2') {
                    outputFormat = 'tagged';
                } else if (formatAnswer === '3') {
                    outputFormat = 'both';
                } else {
                    outputFormat = 'full';
                }
                
                if (parsedFiles.size > 0 && outputFormat === 'full') {
                    console.log(`\n${YELLOW}💡 Tip: You have parsed files. Tagged format (option 2) works better${RESET}`);
                    console.log(`${YELLOW}   because the parsed content is a filtered subset of the actual file.${RESET}`);
                }
            }

            // STEP 3: Generate the struct file with options
            await generateStruct([...selectedFiles], 'struct', {
                includeInstructions,
                userDemand,
                outputFormat,
                parsedFiles,
            });

            // STEP 4: Ask if save paths
            const saveName = await askQuestion('\nSave selected file paths? Enter a filename (or leave empty to skip):');

            if (saveName) {
                await savePaths([...selectedFiles], saveName);
            }

            cleanupAndExit(0);
            return;
        }

        if (key === 'b' || key === 'B') {
            const parent = path.dirname(currentDirectory);

            if (parent !== currentDirectory) {
                currentDirectory = parent;
                entries = await readDirectory(currentDirectory);
                cursorIndex = 0;
                scrollOffset = 0;
            }

            render();
            return;
        }

        if (key === 'q' || key === 'Q' || key === '\u0003') {
            cleanupAndExit(0);
            return;
        }
    };

    function parseIndexes(input, max) {
        const result = new Set();
        const parts = input.split(',');
        
        for (const part of parts) {
            const range = part.split('-').map(s => s.trim()).filter(Boolean);
            if (range.length === 2) {
                const start = parseInt(range[0], 10);
                const end = parseInt(range[1], 10);
                if (!isNaN(start) && !isNaN(end)) {
                    for (let i = Math.max(1, start); i <= Math.min(end, max); i++) {
                        result.add(i - 1);
                    }
                }
            } else if (range.length === 1) {
                const idx = parseInt(range[0], 10);
                if (!isNaN(idx) && idx >= 1 && idx <= max) {
                    result.add(idx - 1);
                }
            }
        }
        
        return [...result];
    }

    process.stdin.on('data', onKeypress);
    render();
}

// ============================================================
//  Main entry point
// ============================================================
async function main() {
    const args = process.argv.slice(2);

    if (args.length > 0) {
        const saveName = args[0];

        try {
            const paths = await loadPaths(saveName);

            if (paths.length === 0) {
                console.error('No paths found in save file.');
                process.exit(1);
            }

            await generateStruct(paths);
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    } else {
        await interactiveMode();
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});