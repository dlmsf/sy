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
//  CR + LF helpers (built at runtime, never written as the
//  two-character backslash escape sequence in source, so no
//  text-processing step can ever split a string literal).
// ============================================================
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

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
//  ROBUST MULTI-LINE TEXT EDITOR (nano-like)
//
//  Pure vanilla Node.js - no external libraries.
//  Used to capture the USER REQUEST text: multi-line editing,
//  full arrow-key navigation, Home/End, PgUp/PgDn,
//  Backspace/Delete, and paste support (including multi-line).
//
//  Resolves to:
//    { type: 'save',   value: <string> }  when the user confirms
//    { type: 'cancel' }                   when the user cancels
//
//  Self-contained: manages raw mode itself and always restores
//  the previous raw-mode state on exit.
// ============================================================
function openTextEditor(initialText = '', titleText = 'USER REQUEST') {
    return new Promise((resolve) => {
        const originalRawMode = !!process.stdin.isRaw;

        let lines = String(initialText == null ? '' : initialText).split('\n');
        if (lines.length === 0) lines = [''];

        let row = lines.length - 1;
        let col = lines[row].length;
        let scrollTop = 0;
        let hScroll = 0;

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const getSize = () => {
            const totalRows = process.stdout.rows || 24;
            const totalCols = process.stdout.columns || 80;
            const textHeight = Math.max(1, totalRows - 5);
            return { totalRows, totalCols, textHeight };
        };

        const clampCursor = () => {
            if (row < 0) row = 0;
            if (row > lines.length - 1) row = lines.length - 1;
            const lineLen = lines[row].length;
            if (col < 0) col = 0;
            if (col > lineLen) col = lineLen;
        };

        const adjustScroll = () => {
            const { textHeight } = getSize();
            if (row < scrollTop) scrollTop = row;
            if (row >= scrollTop + textHeight) scrollTop = row - textHeight + 1;
            if (scrollTop < 0) scrollTop = 0;
        };

        const adjustHScroll = () => {
            const { totalCols } = getSize();
            if (col < hScroll) hScroll = col;
            if (col >= hScroll + totalCols) hScroll = col - totalCols + 1;
            if (hScroll < 0) hScroll = 0;
        };

        const render = () => {
            clampCursor();
            adjustScroll();
            adjustHScroll();

            const { totalCols, textHeight } = getSize();
            const sep = '─'.repeat(totalCols);
            const out = [];

            out.push('\x1b[2J\x1b[H');

            out.push(`${BOLD}${GREEN}=== ${titleText} (editor) ===${RESET}` + CRLF);
            out.push(
                `${BOLD}Line ${row + 1}/${lines.length}  Col ${col + 1}${RESET}  ` +
                `${MAGENTA}Ctrl+S${RESET} save & continue   ${MAGENTA}Esc${RESET} cancel` + CRLF
            );
            out.push(sep + CRLF);

            for (let i = 0; i < textHeight; i++) {
                const lineIdx = scrollTop + i;
                if (lineIdx < lines.length) {
                    let text = lines[lineIdx];
                    if (hScroll > 0) text = text.slice(hScroll);
                    if (text.length > totalCols) text = text.slice(0, totalCols);
                    out.push(text + CRLF);
                } else {
                    out.push(CRLF);
                }
            }

            out.push(sep + CRLF);
            out.push(
                `${BOLD}↑↓←→ move  Home/End  PgUp/PgDn  Enter newline  ` +
                `Backspace/Del  (paste supported)${RESET}`
            );

            process.stdout.write(out.join(''));

            const screenRow = 4 + (row - scrollTop);
            const screenCol = (col - hScroll) + 1;
            process.stdout.write(`\x1b[${screenRow};${screenCol}H`);
        };

        const cleanupAndResolve = (result) => {
            process.stdin.removeListener('data', onData);
            process.stdout.removeListener('resize', onResize);
            process.stdout.write('\x1b[2J\x1b[H');
            process.stdin.setRawMode(originalRawMode);
            resolve(result);
        };

        const saveValue = () => cleanupAndResolve({ type: 'save', value: lines.join('\n') });
        const cancel = () => cleanupAndResolve({ type: 'cancel' });

        const onResize = () => { render(); };

        const insertText = (rawText) => {
            const text = rawText.split(CRLF).join(LF).split(CR).join(LF);
            if (text.length === 0) return;

            const parts = text.split('\n');

            if (parts.length === 1) {
                const line = lines[row];
                lines[row] = line.slice(0, col) + text + line.slice(col);
                col += text.length;
                return;
            }

            const before = lines[row].slice(0, col);
            const after = lines[row].slice(col);
            const block = [before + parts[0]];
            for (let i = 1; i < parts.length - 1; i++) block.push(parts[i]);
            block.push(parts[parts.length - 1] + after);

            lines.splice(row, 1, ...block);
            row = row + (block.length - 1);
            col = parts[parts.length - 1].length;
        };

        const onData = (key) => {
            if (key === '\x03') { cancel(); return; }
            if (key === '\x13') { saveValue(); return; }
            if (key === '\x0f') { saveValue(); return; }
            if (key === '\x01') { col = 0; render(); return; }
            if (key === '\x05') { col = lines[row].length; render(); return; }

            if (key === '\x1b[A' || key === '\x1bOA') {
                if (row > 0) row--;
                render(); return;
            }
            if (key === '\x1b[B' || key === '\x1bOB') {
                if (row < lines.length - 1) row++;
                render(); return;
            }
            if (key === '\x1b[C' || key === '\x1bOC') {
                if (col < lines[row].length) {
                    col++;
                } else if (row < lines.length - 1) {
                    row++;
                    col = 0;
                }
                render(); return;
            }
            if (key === '\x1b[D' || key === '\x1bOD') {
                if (col > 0) {
                    col--;
                } else if (row > 0) {
                    row--;
                    col = lines[row].length;
                }
                render(); return;
            }
            if (key === '\x1b[H' || key === '\x1b[1~' || key === '\x1bOH') {
                col = 0; render(); return;
            }
            if (key === '\x1b[F' || key === '\x1b[4~' || key === '\x1bOF') {
                col = lines[row].length; render(); return;
            }
            if (key === '\x1b[5~') {
                const { textHeight } = getSize();
                row = Math.max(0, row - textHeight);
                render(); return;
            }
            if (key === '\x1b[6~') {
                const { textHeight } = getSize();
                row = Math.min(lines.length - 1, row + textHeight);
                render(); return;
            }
            if (key === '\x1b[3~') {
                const line = lines[row];
                if (col < line.length) {
                    lines[row] = line.slice(0, col) + line.slice(col + 1);
                } else if (row < lines.length - 1) {
                    lines[row] = line + lines[row + 1];
                    lines.splice(row + 1, 1);
                }
                render(); return;
            }

            if (key === '\x1b') { cancel(); return; }
            if (key.startsWith('\x1b')) { return; }

            if (key === '\r' || key === '\n') {
                const line = lines[row];
                const before = line.slice(0, col);
                const after = line.slice(col);
                lines[row] = before;
                lines.splice(row + 1, 0, after);
                row++;
                col = 0;
                render(); return;
            }

            if (key === '\x7f' || key === '\x08') {
                if (col > 0) {
                    const line = lines[row];
                    lines[row] = line.slice(0, col - 1) + line.slice(col);
                    col--;
                } else if (row > 0) {
                    const prevLen = lines[row - 1].length;
                    lines[row - 1] = lines[row - 1] + lines[row];
                    lines.splice(row, 1);
                    row--;
                    col = prevLen;
                }
                render(); return;
            }

            let insert = '';
            for (let i = 0; i < key.length; i++) {
                const ch = key[i];
                const code = ch.charCodeAt(0);
                if (ch === '\t' || ch === '\n' || (code >= 32 && code !== 127)) {
                    insert += ch;
                }
            }
            if (insert.length === 0) { return; }

            insertText(insert);
            render();
        };

        process.stdout.on('resize', onResize);
        process.stdin.on('data', onData);
        render();
    });
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
    enforcement += `CRITICAL PATH PRESERVATION ENFORCEMENT
`;
    enforcement += `${'-'.repeat(50)}\n
`;
    enforcement += `The following file paths contain directory names starting with "._":\n
`;
    
    specialPaths.forEach(filePath => {
        enforcement += `  ACTUAL PATH: ${filePath}\n`;
    });
    
    enforcement += `\nMANDATORY RULES:\n`;
    enforcement += `1. You MUST copy the PATH='...' value EXACTLY as shown in the FILE: header above.\n`;
    enforcement += `2. Directory names starting with "._" (like "._backup", "._config", "._") are REAL directory names.\n`;
    enforcement += `3. "._/" is NOT the same as "./" - they are completely different directories.\n`;
    enforcement += `4. NEVER convert "._/" to "./" or "././" - this will point to a NON-EXISTENT file.\n`;
    enforcement += `5. Copy the path character by character, preserving every "._/" exactly.\n`;
    enforcement += `6. If you see "/._/._/._/", write "/._/._/._/" - not "/././._/" or any other variation.\n
`;
    
    if (outputFormat === 'tagged' || outputFormat === 'both') {
        enforcement += `SPECIFIC EXAMPLE FOR TAGGED OUTPUT:\n`;
        enforcement += `  WRONG: PATH='${specialPaths[0].replace(/\._\//g, './')}'  ← THIS WILL FAIL
`;
        enforcement += `  CORRECT: PATH='${specialPaths[0]}'  ← THIS IS REQUIRED

`;
        enforcement += `When generating [CODEREPLACER-START] tags, the PATH attribute must be
`;
        enforcement += `copied EXACTLY from the FILE: header. Verify each character before output.\n
`;
    } else if (outputFormat === 'codeonly') {
        enforcement += `SPECIFIC EXAMPLE FOR FULL-CODE OUTPUT:\n`;
        enforcement += `  WRONG: FILE: ${specialPaths[0].replace(/\._\//g, './')}\n`;
        enforcement += `  CORRECT: FILE: ${specialPaths[0]}\n
`;
        enforcement += `When writing the FILE: header for each full-code block, the path must be
`;
        enforcement += `copied EXACTLY from the FILE: header above. Verify each character before output.\n
`;
    }
    
    enforcement += `VERIFICATION CHECK:\n`;
    enforcement += `Before outputting any path, compare it character by character with the FILE: header.\n`;
    enforcement += `If they don't match exactly, you have made an error and must correct it.\n`;
    enforcement += `${'-'.repeat(50)}\n
`;
    
    return enforcement;
}

// ============================================================
//  Generate the "100% WORKING CODE" safety warning block.
//
//  This is a REINFORCEMENT / ATTENTION message that is injected
//  at the top of every AI instruction template. Its sole purpose
//  is to make very explicit to the AI that the current codebase
//  is fully functional and that any regression is unacceptable.
//
//  Purely additive: this function only returns a string. It does
//  not touch any existing behavior anywhere.
// ============================================================
function generateSafetyWarning() {
    const rule = '#'.repeat(78);
    let warning = '';

    warning += `${rule}\n`;
    warning += `#\n`;
    warning += `#  !!!   CRITICAL WARNING  -  THE CODE IS 100% WORKING   !!!\n`;
    warning += `#\n`;
    warning += `${rule}\n
`;

    warning += `THE EXISTING CODE IN THIS PROJECT IS 100% WORKING AND FULLY FUNCTIONAL.\n`;
    warning += `Every feature, function, and behavior currently operates correctly, and the
`;
    warning += `user depends on it. Breaking or altering this working behavior is NOT
`;
    warning += `acceptable under any circumstance.\n
`;

    warning += `BEFORE YOU WRITE ANY SINGLE LINE OF CODE, INTERNALIZE THESE RULES:\n
`;

    warning += `1. SURGICAL CHANGES ONLY
`;
    warning += `   Apply ONLY the changes explicitly requested in the USER REQUEST above.\n`;
    warning += `   Nothing more. Do not expand scope. Do not "improve" unrelated code.\n
`;

    warning += `2. DO NOT REFACTOR / RENAME / REORGANIZE
`;
    warning += `   Do NOT rename variables, functions, parameters, or files. Do NOT
`;
    warning += `   reorder imports, functions, or statements "for cleanliness". Do NOT
`;
    warning += `   reformat or change whitespace of code you were not asked to touch.\n
`;

    warning += `3. DO NOT REMOVE OR "SIMPLIFY" WORKING CODE
`;
    warning += `   Any line, branch, function, or check that works today MUST still work
`;
    warning += `   after your change. Never delete code because it "looks redundant".\n
`;

    warning += `4. DO NOT CHANGE EXISTING BEHAVIOR
`;
    warning += `   Preserve ALL existing: return values, error handling, edge cases,\n`;
    warning += `   console output, side effects, defaults, and control flow - unless
`;
    warning += `   the request explicitly asks to change them.\n
`;

    warning += `5. NO NEW DEPENDENCIES OR ABSTRACTIONS
`;
    warning += `   Do NOT add packages, patterns, helpers, or layers the request did not
`;
    warning += `   ask for. Do NOT introduce changes nobody requested.\n
`;

    warning += `6. PRESERVE PUBLIC INTERFACES
`;
    warning += `   Function signatures, exported names, command-line flags, config keys,\n`;
    warning += `   and any interface used by other files MUST remain compatible.\n
`;

    warning += `7. SMALLEST POSSIBLE DIFF
`;
    warning += `   If two solutions achieve the requested change, choose the one with the
`;
    warning += `   smaller and safer diff. Minimal change = maximum safety.\n
`;

    warning += `8. WHEN IN DOUBT, DO NOT TOUCH
`;
    warning += `   If you are not 100% certain that a modification is safe AND required,\n`;
    warning += `   leave the existing code untouched. Never guess-destroy working code.\n
`;

    warning += `A change that "looks cleaner" but alters behavior is a REGRESSION, not
`;
    warning += `an improvement. Regressions break working software. That is a FAILURE.\n
`;

    warning += `${rule}\n
`;

    return warning;
}

// ============================================================
//  Check if file is a JavaScript/TypeScript file
// ============================================================
function isJavaScriptFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext);
}

// ============================================================
//  Import resolution helpers
//
//  These let the interactive browser auto-select files that a
//  JavaScript/TypeScript file imports, recursively. They are
//  purely additive: existing selection logic (selectFile,
//  deselectFile, toggleFile, ...) is reused unchanged.
// ============================================================

// Extract every import/require/export-from specifier from JS source.
// Handles:
//   import X from '...' / import { ... } from '...' / import '...'
//   import type { ... } from '...' (TS)
//   export * from '...' / export { ... } from '...'
//   const X = require('...')  (CommonJS)
//   import('...') / require('...')  (dynamic)
function extractImportSpecifiers(content) {
    const specifiers = new Set();
    let m;

    // Static ES module imports (works across multi-line forms).
    const staticImport = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
    while ((m = staticImport.exec(content)) !== null) specifiers.add(m[1]);

    // Re-exports: export { X } from '...' / export * from '...'
    const exportFrom = /^\s*export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/gm;
    while ((m = exportFrom.exec(content)) !== null) specifiers.add(m[1]);

    // CommonJS require('...')
    const requireCall = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = requireCall.exec(content)) !== null) specifiers.add(m[1]);

    // Dynamic import('...')
    const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dynamicImport.exec(content)) !== null) specifiers.add(m[1]);

    return [...specifiers];
}

// Resolve an import specifier relative to the importing file.
// Returns an absolute path if a real file exists, otherwise null.
// Bare specifiers (node_modules, package names) are skipped - we
// cannot know where they live without the Node resolver.
async function resolveImportSpecifier(specifier, fromFile) {
    if (typeof specifier !== 'string' || specifier.length === 0) return null;

    // Skip bare package specifiers - we can't resolve them safely.
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        return null;
    }

    const baseDir = path.dirname(fromFile);
    const resolved = specifier.startsWith('/')
        ? specifier
        : path.resolve(baseDir, specifier);

    const candidates = [resolved];

    // If the specifier has no extension, try the standard JS/TS
    // extensions and index files (same order Node/TS use).
    if (!path.extname(resolved)) {
        const exts = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json'];
        for (const ext of exts) candidates.push(resolved + ext);
        for (const ext of exts) candidates.push(path.join(resolved, 'index' + ext));
    }

    for (const candidate of candidates) {
        try {
            const stat = await fs.stat(candidate);
            if (stat.isFile()) return candidate;
        } catch {
            // Try the next candidate.
        }
    }

    return null;
}

// Recursively collect a file and everything it imports.
//   maxDepth = 0        -> only the file itself
//   maxDepth = 1        -> the file + its direct imports (default)
//   maxDepth = Infinity -> full import graph
// Cycles are handled via the `visited` set (dedup + termination).
async function collectImportedFiles(filePath, maxDepth, visited = new Set()) {
    if (visited.has(filePath)) return [];
    visited.add(filePath);

    const collected = [filePath];

    if (maxDepth <= 0) return collected;
    if (!isJavaScriptFile(filePath)) return collected;

    let content;
    try {
        content = await fs.readFile(filePath, 'utf8');
    } catch {
        return collected;
    }

    const specifiers = extractImportSpecifiers(content);

    for (const spec of specifiers) {
        const resolved = await resolveImportSpecifier(spec, filePath);
        if (!resolved || visited.has(resolved)) continue;
        const nested = await collectImportedFiles(resolved, maxDepth - 1, visited);
        collected.push(...nested);
    }

    return collected;
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
        referenceOnlyFiles = new Set(),  // NEW: set of paths marked as reference-only
    } = options;

    let structContent = '';
    const needsPathEnforcement = hasSpecialPathPattern(filePaths);

    if (includeInstructions) {
        structContent += `${'='.repeat(50)}\n`;
        structContent += `AI INSTRUCTIONS
`;
        structContent += `${'='.repeat(50)}\n`;

        structContent += `You are an AI assistant helping with code modifications.\n`;
        structContent += `Below are the current contents of the selected files.\n`;
        structContent += `Your task is to apply the following user request:\n
`;
        // USER REQUEST now starts on the same line as the label.
        structContent += `USER REQUEST: ${userDemand}\n
`;

        // Reinforce to the AI that the codebase is 100% working and
        // that any regression is unacceptable. Placed BEFORE the path
        // enforcement / parsed files sections so the AI reads it first.
        structContent += generateSafetyWarning();

        if (needsPathEnforcement) {
            structContent += generatePathEnforcement(filePaths, outputFormat);
        }

        if (parsedFiles && parsedFiles.size > 0) {
            structContent += `${'!'.repeat(50)}\n`;
            structContent += `⚠️  WARNING: PARSED FILES DETECTED
`;
            structContent += `${'!'.repeat(50)}\n
`;
            structContent += `The following files have been PARSED using CodeParser.\n`;
            structContent += `This means their content has been FILTERED - only selected
`;
            structContent += `portions are shown below.\n
`;
            for (const [filePath, info] of parsedFiles.entries()) {
                structContent += `  PARSED FILE: ${filePath}\n`;
                structContent += `  Original size: ${formatNumber(info.originalSize)} bytes | Parsed size: ${formatNumber(info.parsedSize)} bytes
`;
                structContent += `  Stats: ${info.stats.containers} containers, ${info.stats.functions} functions, ${info.stats.totalMembers} members
`;
                if (info.notes && info.notes.length > 0) {
                    structContent += `  Notes:\n`;
                    info.notes.forEach(note => structContent += `    • ${note}\n`);
                }
                structContent += `\n`;
            }
            if (outputFormat === 'codeonly') {
                structContent += `IMPORTANT: For this task, output FULL CODE ONLY.\n`;
                structContent += `Do NOT use the [CODEREPLACER] tag schema. Do NOT abbreviate.\n`;
                structContent += `The parsed content shown is a FILTERED version - the actual
`;
                structContent += `file on disk contains MORE code than what is shown. Your full-code
`;
                structContent += `output must reflect the complete file as it should be after changes.\n
`;
            } else {
                structContent += `IMPORTANT: When making replacements in these files, use the
`;
                structContent += `[CODEREPLACER] tagged format. The parsed content shown is a
`;
                structContent += `FILTERED version - the actual file on disk contains MORE code
`;
                structContent += `than what is shown. Replacements must target the EXACT original
`;
                structContent += `text in the actual file.\n
`;
            }
            structContent += `${'!'.repeat(50)}\n
`;
        }

        // NEW: mention reference-only files in instructions
        if (referenceOnlyFiles.size > 0) {
            structContent += `${'*'.repeat(50)}\n`;
            structContent += `ℹ️  REFERENCE-ONLY FILES
`;
            structContent += `${'*'.repeat(50)}\n
`;
            structContent += `The following files are provided for CONTEXT ONLY.\n`;
            structContent += `DO NOT modify them, do not propose changes to them.\n`;
            structContent += `Use them only to understand the surrounding code.\n
`;
            for (const refFile of referenceOnlyFiles) {
                structContent += `  REFERENCE ONLY: ${refFile}\n`;
            }
            structContent += `\n${'*'.repeat(50)}\n
`;
        }

        if (outputFormat === 'full') {
            structContent += `OUTPUT FORMAT: FULL FILES
`;
            structContent += `Provide the complete new content for EVERY file that requires changes.\n`;
            structContent += `Do not abbreviate or omit any parts. Output each file's entire content.\n`;
            structContent += `Use the same file path headers as provided below.\n
`;
        } else if (outputFormat === 'tagged') {
            structContent += `OUTPUT FORMAT: TAGGED REPLACEMENTS (CODEREPLACER)\n`;
            structContent += `Use the following tag structure to specify replacements within files:\n
`;
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
            structContent += `[/CODEREPLACER-END]\n
`;
            structContent += `You can include multiple [NEW-REPLACE-START] blocks for multiple replacements in the same file.\n`;
            structContent += `Ensure the original text exactly matches the file content (including whitespace).\n`;
            structContent += `CRITICAL: In PATH='...', copy the path EXACTLY from the FILE: header.\n`;
            structContent += `Verify each character matches before outputting.\n
`;
            structContent += `CRITICAL RULE - STANDALONE REPLACEMENTS:\n`;
            structContent += `EVERY response with [CODEREPLACER] tags must be COMPLETE and STANDALONE.\n`;
            structContent += `Treat each response as if it will be applied to a FRESH copy of the original files.\n`;
            structContent += `You must include ALL replacements needed to fully implement the user's request - even if
`;
            structContent += `you previously provided them in an earlier message. NEVER reference or rely on
`;
            structContent += `previous responses. Imagine the user has just run 'git restore .' before applying your
`;
            structContent += `tags. If a replacement depends on another replacement, INCLUDE BOTH in the same response.\n`;
            structContent += `A response containing only partial or incremental changes is INVALID and will fail.\n
`;
        } else if (outputFormat === 'both') {
            structContent += `OUTPUT FORMAT: BOTH FULL FILES AND TAGGED REPLACEMENTS
`;
            structContent += `You may provide either full file contents or tagged replacements, as appropriate.\n`;
            structContent += `For each file, decide which method is cleaner and use that.\n`;
            structContent += `Clearly separate the two approaches if mixed.\n`;
            structContent += `CRITICAL: Regardless of format, preserve the exact path in all outputs.\n
`;
            structContent += `CRITICAL RULE - STANDALONE REPLACEMENTS:\n`;
            structContent += `EVERY response with [CODEREPLACER] tags must be COMPLETE and STANDALONE.\n`;
            structContent += `Treat each response as if it will be applied to a FRESH copy of the original files.\n`;
            structContent += `You must include ALL replacements needed to fully implement the user's request - even if
`;
            structContent += `you previously provided them in an earlier message. NEVER reference or rely on
`;
            structContent += `previous responses. Imagine the user has just run 'git restore .' before applying your
`;
            structContent += `tags. If a replacement depends on another replacement, INCLUDE BOTH in the same response.\n`;
            structContent += `A response containing only partial or incremental changes is INVALID and will fail.\n
`;
        } else if (outputFormat === 'codeonly') {
            structContent += `OUTPUT FORMAT: FULL CODE ONLY (NO TAGS, NO ABBREVIATIONS)\n`;
            structContent += `Provide the complete, entire code for EVERY file that requires changes.\n`;
            structContent += `You MUST NOT use the [CODEREPLACER] tag schema or any other tag/replacement format.\n`;
            structContent += `Output only the raw, full source code for each file.\n
`;
            structContent += `STRICT RULES - THE FOLLOWING ARE STRICTLY FORBIDDEN:\n`;
            structContent += `- Do NOT use any tag schema (no [CODEREPLACER], no [ORIGINAL-START], etc.).\n`;
            structContent += `- Do NOT abbreviate the code in ANY way.\n`;
            structContent += `- Do NOT use placeholders such as "...", "// ...", "// existing code",\n`;
            structContent += `  "// rest is unchanged", "/* unchanged */", "// same as before", "// unchanged"\n`;
            structContent += `  or any equivalent shortcut.\n`;
            structContent += `- Do NOT summarize, truncate, or skip any part of the code.\n`;
            structContent += `- Do NOT write things like "code continues here" or "(unchanged)".\n`;
            structContent += `- Do NOT write only the modified portions - you MUST write EVERY line.\n`;
            structContent += `- Output the ENTIRE file from the first line to the last line, in full.\n`;
            structContent += `- Include all imports, comments, functions, classes, and everything else.\n
`;
            structContent += `For each file, start the code block with the exact same file path header
`;
            structContent += `as provided below (FILE: <path>) so it is clear which code belongs to which file.\n
`;
            structContent += `CRITICAL: The output MUST be complete, runnable, unabbreviated code.\n`;
            structContent += `Any abbreviation or omission makes the response INVALID and it will fail.\n
`;
        }

        structContent += `${'='.repeat(50)}\n
`;
    }

    for (const filePath of filePaths) {
        try {
            const content = await fs.readFile(filePath, 'utf8');

            structContent += `${'='.repeat(50)}\n`;
            structContent += `FILE: ${filePath}\n`;
            structContent += `${'='.repeat(50)}\n`;

            // NEW: add reference-only note if applicable
            if (referenceOnlyFiles.has(filePath)) {
                structContent += `[NOTE: This file is for REFERENCE/CONTEXT ONLY - DO NOT MODIFY]\n`;
            }

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
    
    if (referenceOnlyFiles.size > 0) {
        console.log(`\n${MAGENTA}ℹ️  Marked ${referenceOnlyFiles.size} file(s) as reference-only${RESET}`);
    }
}

// ============================================================
//  Save session state (files + options + parsing selections) as
//  JSON in /tmp. This captures EXACTLY what the interactive flow
//  produced, so `node Struct.js <savename>` can regenerate the
//  SAME struct from the LATEST file contents on disk.
// ============================================================
async function saveState(state, saveName) {
    const temporaryDirectory = os.tmpdir();
    const savePath = path.join(temporaryDirectory, saveName);

    await fs.writeFile(savePath, JSON.stringify(state, null, 2), 'utf8');
    console.log(`Session state saved to: ${savePath}`);
    console.log(`To regenerate later: node Struct.js ${saveName}`);

    return savePath;
}

// ============================================================
//  Load session state from a savename file in /tmp.
//  Supports BOTH:
//    - new JSON format (full state: files + options + parsing)
//    - legacy plain-text format (one path per line)
//  Legacy saves are upgraded to a minimal state object so older
//  save files keep working.
// ============================================================
async function loadState(saveName) {
    const temporaryDirectory = os.tmpdir();
    const savePath = path.join(temporaryDirectory, saveName);
    const data = await fs.readFile(savePath, 'utf8');

    // New format: JSON object with a `files` array.
    try {
        const parsed = JSON.parse(data);
        if (
            parsed &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            Array.isArray(parsed.files)
        ) {
            return {
                files: parsed.files,
                includeInstructions: !!parsed.includeInstructions,
                userDemand: parsed.userDemand || '',
                outputFormat: parsed.outputFormat || 'full',
                parsed: parsed.parsed && typeof parsed.parsed === 'object' ? parsed.parsed : {},
                referenceOnly: Array.isArray(parsed.referenceOnly) ? parsed.referenceOnly : [],
            };
        }
    } catch {
        // Not JSON - fall through to legacy plain-text parsing.
    }

    // Legacy format: newline-separated absolute paths.
    const paths = data
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    return {
        files: paths,
        includeInstructions: false,
        userDemand: '',
        outputFormat: 'full',
        parsed: {},
        referenceOnly: [],
    };
}

// ============================================================
//  Regenerate struct from a saved session state.
//  - Reads the LATEST file contents from disk (files may have
//    been edited since the save).
//  - Re-applies the saved CodeParser selections by re-parsing.
//  - NEVER aborts on a single failure: missing files, empty
//    parses, or invalid selections fall back to the original
//    file content with a clear warning.
// ============================================================
async function regenerateFromState(state) {
    const {
        files = [],
        includeInstructions = false,
        userDemand = '',
        outputFormat = 'full',
        parsed = {},
        referenceOnly = [],
    } = state;

    const existingFiles = [];
    const missingFiles = [];

    // Filter files that still exist on disk.
    for (const filePath of files) {
        try {
            await fs.access(filePath);
            existingFiles.push(filePath);
        } catch {
            missingFiles.push(filePath);
        }
    }

    if (missingFiles.length > 0) {
        console.log(`\n${YELLOW}⚠️  ${missingFiles.length} saved file(s) no longer exist:${RESET}`);
        missingFiles.forEach(f => console.log(`  • ${f}`));
        console.log(`${YELLOW}These will be skipped.${RESET}\n`);
    }

    if (existingFiles.length === 0) {
        console.error('No existing files to process.');
        process.exit(1);
    }

    // Restrict reference-only to files that actually exist now.
    const existingSet = new Set(existingFiles);
    const referenceOnlyFiles = new Set(
        referenceOnly.filter(f => existingSet.has(f))
    );

    const parsedFiles = new Map();

    // Re-parse every file that had a saved parser selection.
    for (const filePath of existingFiles) {
        const parseInfo = parsed[filePath];
        if (!parseInfo || !parseInfo.selection) continue;

        try {
            CodeParser.parse(filePath);
            const summary = CodeParser.getSummary();
            const filtered = CodeParser.generateFiltered(parseInfo.selection);
            const report = CodeParser.getLastReport();
            const validation = report.validation || { ok: true, issues: [] };
            const notes = report.notes || [];
            const originalContent = await fs.readFile(filePath, 'utf8');

            if (filtered && filtered.trim()) {
                parsedFiles.set(filePath, {
                    parsedContent: filtered,
                    originalSize: originalContent.length,
                    parsedSize: filtered.length,
                    stats: summary,
                    notes,
                    validation,
                });

                console.log(`${GREEN}✓ Re-parsed: ${path.basename(filePath)}${RESET}`);

                if (notes.length > 0) {
                    notes.forEach(n => console.log(`  • ${n}`));
                }
                if (!validation.ok) {
                    console.log(`  ${YELLOW}Validation issues:${RESET}`);
                    validation.issues.forEach(i => console.log(`    • ${i}`));
                }
            } else {
                console.log(`${YELLOW}⚠️  Empty parse result for ${path.basename(filePath)} - using original file${RESET}`);
            }
        } catch (err) {
            // Selection may no longer be valid (e.g. code was heavily
            // refactored). Fall back to the original file content.
            console.log(`${YELLOW}⚠️  Could not re-parse ${path.basename(filePath)}: ${err.message}${RESET}`);
            console.log(`${YELLOW}   Using original file content.${RESET}`);
        }
    }

    await generateStruct(existingFiles, 'struct', {
        includeInstructions,
        userDemand,
        outputFormat,
        parsedFiles,
        referenceOnlyFiles,
    });
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
//  Fast content-based file search
// ============================================================

// Directories that are almost never relevant for code search.
// Skipping them keeps recursive walks extremely fast on real projects.
const SEARCH_SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    '__pycache__',
    '.cache',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.turbo',
    '.parcel-cache',
    'dist',
    'build',
    'coverage',
    '.idea',
    '.vscode',
]);

// Binary file extensions - pre-filtered before any read() syscall.
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif', '.avif',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flv', '.webm', '.ogg', '.m4a', '.opus',
    '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.tgz', '.zst',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.jar', '.war',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.pyc', '.pyo', '.wasm', '.node', '.db', '.sqlite', '.sqlite3', '.mdb',
    '.iso', '.img', '.dmg', '.pkg', '.deb', '.rpm',
]);

function isProbablyBinaryByExtension(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

// Iterative recursive walk that prunes junk directories.
// Iterative (stack) avoids deep-recursion issues on huge trees.
async function collectSearchableFiles(directory) {
    const results = [];
    const stack = [directory];

    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;

        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
                stack.push(fullPath);
            } else if (entry.isFile()) {
                if (isProbablyBinaryByExtension(fullPath)) continue;
                results.push(fullPath);
            }
        }
    }

    return results;
}

// Returns true if the given file contains the search term.
// Performance notes:
//   * stat() first - skip huge files (>16MB) that are almost never source code.
//   * Extension pre-filter for binaries (never even read them).
//   * Read as Buffer, then NUL-byte scan on the first 8KB to catch binary content.
//   * Case-sensitive path uses Buffer.includes() (native, memmem-like, very fast).
//   * Case-insensitive path falls back to a single lowercase string pass.
async function fileContainsTerm(filePath, searchTerm, caseSensitive, termBuffer) {
    let stats;

    try {
        stats = await fs.stat(filePath);
    } catch {
        return false;
    }

    if (stats.size === 0) return false;
    if (stats.size > 16 * 1024 * 1024) return false;

    let buffer;

    try {
        buffer = await fs.readFile(filePath);
    } catch {
        return false;
    }

    // Fast binary content check on the first 8KB (NUL byte = binary).
    const scanLen = Math.min(buffer.length, 8192);
    for (let i = 0; i < scanLen; i++) {
        if (buffer[i] === 0) return false;
    }

    if (caseSensitive) {
        return buffer.includes(termBuffer);
    }

    // Case-insensitive: decode once, lowercase, then match.
    const text = buffer.toString('utf8');
    return text.toLowerCase().includes(searchTerm);
}

// ============================================================
//  Fuzzy string similarity - Dice coefficient over character bigrams.
//  Returns 0..1. Very fast and works well for filename-ish strings.
// ============================================================
function diceCoefficient(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;

    const bigrams = new Map();

    for (let i = 0; i < a.length - 1; i++) {
        const gram = a.substring(i, i + 2);
        bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
    }

    let intersection = 0;

    for (let i = 0; i < b.length - 1; i++) {
        const gram = b.substring(i, i + 2);
        const count = bigrams.get(gram) || 0;
        if (count > 0) {
            bigrams.set(gram, count - 1);
            intersection++;
        }
    }

    return (2 * intersection) / ((a.length - 1) + (b.length - 1));
}

// ============================================================
//  Score a candidate file against the search term.
//
//  Weight hierarchy (highest first):
//    1. Filename (without extension) equals the term     -> strongest
//    2. Filename starts-with / contains the term
//    3. Path contains the term
//    4. Content occurrence count (meaningful but below any name hit)
//    5. Fuzzy filename similarity (typos / partial names)
//
//  Rationale: if the user types "myfilename" and "myfilename.js"
//  exists, it must dominate the ranking. Content hits are only a
//  fallback signal.
// ============================================================
function scoreFileMatch(filePath, term, contentHits = 0) {
    const baseName = path.basename(filePath);
    const baseNoExt = baseName.replace(/\.[^.]+$/, '');
    const termLower = term.toLowerCase();
    const baseLower = baseName.toLowerCase();
    const baseNoExtLower = baseNoExt.toLowerCase();
    const pathLower = filePath.toLowerCase();

    let score = 0;
    let nameMatched = false;

    // --- Filename: the dominant signal ---
    if (baseNoExtLower === termLower) {
        score += 2000;                        // "myfilename" -> myfilename.js
        nameMatched = true;
    } else if (baseLower === termLower) {
        score += 1900;
        nameMatched = true;
    } else if (baseNoExtLower.startsWith(termLower)) {
        score += 1600;                        // myfilename -> myfilename.utils.js
        nameMatched = true;
    } else if (baseNoExtLower.includes(termLower)) {
        score += 1300;                        // myfilename -> app.myfilename.js
        nameMatched = true;
    } else if (baseLower.includes(termLower)) {
        score += 1100;
        nameMatched = true;
    }

    // --- Fuzzy filename similarity (typos / partial matches) ---
    const sim = diceCoefficient(baseNoExtLower, termLower);
    score += Math.round(sim * 400);

    // --- Path containment (directory names) ---
    if (!nameMatched && pathLower.includes(termLower)) {
        score += 500;
    }

    // --- Content hits: meaningful, but always below a name hit ---
    if (contentHits > 0) {
        score += Math.min(900, 550 + contentHits * 10);
    }

    return score;
}

// ============================================================
//  Same as fileContainsTerm but also counts occurrences (capped).
//  The cap prevents giant log-like files from dominating scores.
// ============================================================
async function fileContainsTermWithCount(filePath, searchTerm, caseSensitive, termBuffer) {
    let stats;

    try {
        stats = await fs.stat(filePath);
    } catch {
        return { matched: false, hits: 0 };
    }

    if (stats.size === 0) return { matched: false, hits: 0 };
    if (stats.size > 16 * 1024 * 1024) return { matched: false, hits: 0 };

    let buffer;

    try {
        buffer = await fs.readFile(filePath);
    } catch {
        return { matched: false, hits: 0 };
    }

    const scanLen = Math.min(buffer.length, 8192);
    for (let i = 0; i < scanLen; i++) {
        if (buffer[i] === 0) return { matched: false, hits: 0 };
    }

    let hits = 0;
    const HIT_CAP = 50;

    if (caseSensitive) {
        let idx = 0;
        while (hits < HIT_CAP) {
            idx = buffer.indexOf(termBuffer, idx);
            if (idx === -1) break;
            hits++;
            idx += termBuffer.length;
        }
    } else {
        const text = buffer.toString('utf8').toLowerCase();
        let idx = 0;
        while (hits < HIT_CAP) {
            idx = text.indexOf(searchTerm, idx);
            if (idx === -1) break;
            hits++;
            idx += searchTerm.length;
        }
    }

    return { matched: hits > 0, hits };
}

// ============================================================
//  Prompt stopwords - a rich dictionary of common words that
//  show up in natural-language prompts ("please help me find
//  the login function") but carry very little discriminative
//  signal when searching source code. They receive a LOWER
//  weight so that rare, meaningful words dominate the ranking.
//  Grouped by category for readability.
// ============================================================
const PROMPT_STOPWORDS = new Set([
    // --- articles / determiners ---
    'a', 'an', 'the', 'this', 'that', 'these', 'those',
    'some', 'any', 'all', 'each', 'every', 'either', 'neither',
    'no', 'none', 'both', 'few', 'many', 'much', 'more', 'most',
    'less', 'least', 'several', 'such', 'another', 'other', 'others',

    // --- pronouns ---
    'i', 'me', 'my', 'mine', 'myself',
    'you', 'your', 'yours', 'yourself',
    'he', 'him', 'his', 'himself',
    'she', 'her', 'hers', 'herself',
    'it', 'its', 'itself',
    'we', 'us', 'our', 'ours', 'ourselves',
    'they', 'them', 'their', 'theirs', 'themselves',
    'who', 'whom', 'whose', 'which', 'what', 'whatever', 'whichever',
    'anyone', 'anybody', 'anything', 'anywhere',
    'someone', 'somebody', 'something', 'somewhere',
    'everyone', 'everybody', 'everything', 'everywhere',
    'nobody', 'nothing', 'nowhere',
    'one', 'ones', 'thing', 'things', 'stuff', 'way', 'ways',

    // --- be / have / do / auxiliaries ---
    'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'having',
    'do', 'does', 'did', 'doing', 'done',
    'will', 'would', 'shall', 'should',
    'can', 'could', 'may', 'might', 'must', 'ought',
    'let', 'lets', 'dare',

    // --- very common request verbs ---
    'want', 'wants', 'wanted', 'wanting',
    'need', 'needs', 'needed', 'needing',
    'like', 'likes', 'liked', 'liking',
    'get', 'gets', 'got', 'getting', 'gotten',
    'give', 'gives', 'gave', 'given', 'giving',
    'take', 'takes', 'took', 'taken', 'taking',
    'make', 'makes', 'made', 'making',
    'go', 'goes', 'went', 'gone', 'going',
    'come', 'comes', 'came', 'coming',
    'see', 'sees', 'saw', 'seen', 'seeing',
    'look', 'looks', 'looked', 'looking',
    'find', 'finds', 'found', 'finding',
    'search', 'searches', 'searched', 'searching',
    'show', 'shows', 'showed', 'shown', 'showing',
    'tell', 'tells', 'told', 'telling',
    'say', 'says', 'said', 'saying',
    'ask', 'asks', 'asked', 'asking',
    'help', 'helps', 'helped', 'helping',
    'try', 'tries', 'tried', 'trying',
    'use', 'uses', 'used', 'using',
    'put', 'puts', 'putting',
    'set', 'sets', 'setting',
    'keep', 'keeps', 'kept', 'keeping',
    'know', 'knows', 'knew', 'known', 'knowing',
    'think', 'thinks', 'thought', 'thinking',
    'feel', 'feels', 'felt', 'feeling',
    'leave', 'leaves', 'left', 'leaving',
    'call', 'calls', 'called', 'calling',
    'read', 'reads', 'reading',
    'write', 'writes', 'wrote', 'written', 'writing',
    'add', 'adds', 'added', 'adding',
    'remove', 'removes', 'removed', 'removing',
    'change', 'changes', 'changed', 'changing',
    'modify', 'modifies', 'modified', 'modifying',
    'update', 'updates', 'updated', 'updating',
    'create', 'creates', 'created', 'creating',
    'delete', 'deletes', 'deleted', 'deleting',
    'fix', 'fixes', 'fixed', 'fixing',
    'move', 'moves', 'moved', 'moving',
    'start', 'starts', 'started', 'starting',
    'stop', 'stops', 'stopped', 'stopping',
    'run', 'runs', 'ran', 'running',
    'work', 'works', 'worked', 'working',
    'check', 'checks', 'checked', 'checking',
    'explain', 'explains', 'explained', 'explaining',
    'describe', 'describes', 'described', 'describing',
    'implement', 'implements', 'implemented', 'implementing',
    'build', 'builds', 'built', 'building',
    'improve', 'improves', 'improved', 'improving',
    'apply', 'applies', 'applied', 'applying',
    'open', 'opens', 'opened', 'opening',
    'close', 'closes', 'closed', 'closing',
    'handle', 'handles', 'handled', 'handling',
    'return', 'returns', 'returned', 'returning',
    'pass', 'passes', 'passed', 'passing',
    'allow', 'allows', 'allowed', 'allowing',
    'prevent', 'prevents', 'prevented', 'preventing',
    'ensure', 'ensures', 'ensured', 'ensuring',
    'avoid', 'avoids', 'avoided', 'avoiding',
    'require', 'requires', 'required', 'requiring',
    'include', 'includes', 'included', 'including',
    'contain', 'contains', 'contained', 'containing',
    'support', 'supports', 'supported', 'supporting',
    'provide', 'provides', 'provided', 'providing',
    'consider', 'considers', 'considered', 'considering',

    // --- conjunctions / connectors ---
    'and', 'or', 'but', 'nor', 'yet', 'so',
    'if', 'then', 'else', 'otherwise',
    'when', 'whenever', 'while', 'whereas',
    'because', 'since', 'as', 'until', 'unless',
    'although', 'though', 'even', 'however', 'therefore',
    'thus', 'hence', 'meanwhile', 'moreover', 'furthermore',
    'besides', 'instead', 'rather', 'also', 'too', 'either',
    'whether', 'both', 'neither',

    // --- prepositions / particles ---
    'of', 'in', 'on', 'at', 'by', 'with', 'without',
    'from', 'to', 'into', 'onto', 'upon',
    'for', 'about', 'against', 'between', 'among',
    'through', 'during', 'before', 'after', 'above', 'below',
    'over', 'under', 'up', 'down', 'out', 'off', 'away',
    'back', 'forward', 'around', 'near', 'across', 'along',
    'behind', 'beyond', 'within', 'beside',
    'per', 'via', 'versus', 'vs',

    // --- adverbs / quantifiers / hedges ---
    'here', 'there', 'now', 'then', 'today', 'tomorrow', 'yesterday',
    'always', 'never', 'sometimes', 'often', 'rarely', 'usually',
    'again', 'once', 'twice', 'already', 'still', 'just', 'only',
    'very', 'really', 'quite', 'somewhat', 'fairly',
    'pretty', 'enough', 'almost', 'nearly',
    'exactly', 'precisely', 'approximately', 'roughly',
    'probably', 'possibly', 'perhaps', 'maybe', 'definitely',
    'certainly', 'surely', 'clearly', 'obviously', 'apparently',
    'actually', 'basically', 'essentially', 'simply', 'literally',
    'honestly', 'frankly', 'personally', 'generally', 'typically',
    'normally', 'commonly', 'seldom',

    // --- greetings / politeness ---
    'hi', 'hello', 'hey', 'yo', 'sup', 'greetings',
    'please', 'kindly', 'thanks', 'thank', 'thankyou',
    'sorry', 'excuse', 'pardon', 'welcome',
    'yes', 'yeah', 'yep', 'yup', 'nope', 'nah',
    'ok', 'okay', 'sure', 'fine', 'alright', 'cool', 'great',

    // --- vague / context words ---
    'code', 'file', 'files', 'line', 'lines', 'part', 'parts',
    'piece', 'pieces', 'section', 'sections', 'area', 'areas',
    'place', 'places', 'point', 'points', 'spot', 'spots',
    'kind', 'kinds', 'type', 'types', 'sort', 'sorts',
    'case', 'cases', 'example', 'examples', 'instance', 'instances',
    'bit', 'bits', 'little', 'small', 'big', 'large', 'huge', 'tiny',
    'new', 'old', 'same', 'different', 'similar', 'various',
    'first', 'second', 'third', 'last', 'next', 'previous',
    'two', 'three', 'four', 'five',
    'main', 'primary', 'secondary', 'final', 'initial',
    'current', 'existing', 'original', 'actual', 'real', 'true',
    'good', 'bad', 'better', 'best', 'worse', 'worst',
    'easy', 'hard', 'simple', 'complex', 'quick', 'fast', 'slow',

    // --- meta / AI-assistant phrases ---
    'ai', 'assistant', 'model', 'bot', 'chat', 'prompt',
    'request', 'task', 'job', 'question', 'answer', 'response',
]);

// Split a natural-language query into lowercase word tokens.
// Keeps only tokens with 2+ chars (drops stray single letters).
function tokenizeSearchTerm(term) {
    if (!term) return [];
    const matches = String(term).toLowerCase().match(/[a-z0-9_$]+/g);
    return matches ? matches.filter(t => t.length >= 2) : [];
}

// Weight a single token: stopwords -> low, long unique -> high.
// Deliberately subtle so nothing is ever fully silenced.
function wordWeight(token) {
    if (PROMPT_STOPWORDS.has(token)) return 0.2;
    if (token.length <= 3) return 0.55;
    if (token.length <= 5) return 0.8;
    if (token.length <= 8) return 1.0;
    return 1.15;
}

// Read a file once and return its lowercase text (or null on
// binary / too-large / unreadable). Same guards as
// fileContainsTermWithCount (16MB cap, NUL-byte binary scan).
async function readSearchableFileText(filePath) {
    let stats;
    try { stats = await fs.stat(filePath); } catch { return null; }
    if (stats.size === 0) return null;
    if (stats.size > 16 * 1024 * 1024) return null;

    let buffer;
    try { buffer = await fs.readFile(filePath); } catch { return null; }

    const scanLen = Math.min(buffer.length, 8192);
    for (let i = 0; i < scanLen; i++) {
        if (buffer[i] === 0) return null;
    }

    return buffer.toString('utf8').toLowerCase();
}

// Prompt-style scored search. Sums per-token scores weighted by
// token rarity. Files that match several UNIQUE words get a bonus;
// files that only match stopwords are damped so noise stays low.
async function searchFilesForPromptScored(filePaths, tokens, concurrency = 32) {
    const results = [];
    if (filePaths.length === 0) return results;

    const tokenInfos = tokens.map(t => ({
        token: t,
        weight: wordWeight(t),
        isUnique: !PROMPT_STOPWORDS.has(t),
    }));

    const uniqueCount = tokenInfos.filter(t => t.isUnique).length;
    if (uniqueCount === 0) return results;  // nothing meaningful to search for

    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            const i = nextIndex++;
            if (i >= filePaths.length) return;
            const filePath = filePaths[i];

            try {
                const textLower = await readSearchableFileText(filePath);
                if (textLower === null) continue;

                const baseName = path.basename(filePath);
                const baseNoExt = baseName.replace(/\.[^.]+$/, '');
                const baseLower = baseNoExt.toLowerCase();
                const pathLower = filePath.toLowerCase();

                let weightedScore = 0;
                let totalHits = 0;
                let uniqueMatched = 0;
                let commonMatched = 0;

                for (const info of tokenInfos) {
                    const HIT_CAP = 50;
                    let hits = 0;
                    let idx = 0;
                    while (hits < HIT_CAP) {
                        idx = textLower.indexOf(info.token, idx);
                        if (idx === -1) break;
                        hits++;
                        idx += info.token.length;
                    }

                    let nameScore = 0;
                    if (baseLower === info.token) nameScore = 2000;
                    else if (baseLower.startsWith(info.token)) nameScore = 1600;
                    else if (baseLower.includes(info.token)) nameScore = 1300;
                    else if (pathLower.includes(info.token)) nameScore = 500;

                    if (hits > 0 || nameScore > 0) {
                        if (info.isUnique) uniqueMatched++;
                        else commonMatched++;
                    }

                    const hitsComponent = hits > 0 ? Math.min(700, 200 + hits * 15) : 0;
                    weightedScore += (nameScore + hitsComponent) * info.weight;
                    totalHits += hits;
                }

                // Bonus when multiple UNIQUE tokens all hit - the
                // strongest indicator of relevance for a prompt search.
                if (uniqueMatched >= 2) weightedScore += uniqueMatched * uniqueMatched * 80;
                if (uniqueMatched >= 4) weightedScore += 200;

                // Damp files that only matched stopwords (pure noise).
                if (uniqueMatched === 0 && commonMatched > 0) {
                    weightedScore *= 0.35;
                }

                const finalScore = Math.round(weightedScore);

                if (finalScore >= 200) {
                    results.push({
                        path: filePath,
                        score: finalScore,
                        hits: totalHits,
                        contentMatched: totalHits > 0,
                    });
                }
            } catch {
                // Ignore per-file errors so one bad file doesn't abort the search.
            }
        }
    };

    const workerCount = Math.min(concurrency, filePaths.length);
    const workers = new Array(workerCount);
    for (let i = 0; i < workerCount; i++) workers[i] = worker();
    await Promise.all(workers);

    results.sort((a, b) => b.score - a.score);
    return results;
}

// ============================================================
//  Scored parallel search.
//
//  Two paths:
//    * Single-token query -> original exact-match behaviour
//      (filename dominant, content hit secondary, fuzzy bonus).
//    * Multi-word prompt  -> token-weighted prompt search:
//      unique words score more, common prompt stopwords score
//      much less. See searchFilesForPromptScored().
//
//  Returns an array of { path, score, hits, contentMatched }
//  sorted by score descending. Files that only match by fuzzy
//  filename similarity are still included so the temperature
//  slider in the results view has candidates to reveal at
//  higher values.
// ============================================================
async function searchFilesForTermScored(filePaths, searchTerm, caseSensitive, concurrency = 32) {
    const results = [];

    if (filePaths.length === 0) return results;

    // Detect prompt-style query (2+ word tokens). If so, use the
    // token-weighted prompt scorer. Single-token queries keep the
    // original exact-match behaviour completely untouched.
    const promptTokens = tokenizeSearchTerm(searchTerm);
    if (promptTokens.length >= 2) {
        return searchFilesForPromptScored(filePaths, promptTokens, concurrency);
    }

    const termBuffer = Buffer.from(searchTerm, 'utf8');
    const normalizedTerm = caseSensitive ? searchTerm : searchTerm.toLowerCase();

    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            const i = nextIndex++;
            if (i >= filePaths.length) return;

            const filePath = filePaths[i];

            try {
                const { matched, hits } = await fileContainsTermWithCount(
                    filePath,
                    normalizedTerm,
                    caseSensitive,
                    termBuffer
                );

                const score = scoreFileMatch(filePath, searchTerm, hits);

                // Keep files that either matched in content OR have a
                // meaningful fuzzy/similarity score in the filename.
                if (matched || score >= 300) {
                    results.push({
                        path: filePath,
                        score,
                        hits,
                        contentMatched: matched,
                    });
                }
            } catch {
                // Ignore per-file errors so one bad file doesn't abort the search.
            }
        }
    };

    const workerCount = Math.min(concurrency, filePaths.length);
    const workers = new Array(workerCount);

    for (let i = 0; i < workerCount; i++) {
        workers[i] = worker();
    }

    await Promise.all(workers);

    // Highest score first.
    results.sort((a, b) => b.score - a.score);

    return results;
}

// ============================================================
//  ADDITIONAL LAYER: .gitignore-aware filename-match penalty.
//
//  This is a POST-SCORING pass. It runs AFTER every existing
//  scoring layer (filename / path / content / fuzzy / prompt
//  token weighting) and NEVER modifies their logic. Those layers
//  stay exactly as they were.
//
//  Its only job:
//    When a candidate's FILENAME (basename) matches the search
//    term AND that same filename also matches a pattern coming
//    from the applicable .gitignore file, REDUCE the score.
//
//  Guarantees that keep the current 100%-working behaviour safe:
//    * Content-only matches are NEVER penalised.
//    * Files whose name has nothing to do with the search term
//      are NEVER penalised (only true FILENAME MATCH cases are).
//    * If there is no .gitignore, or it cannot be read, the
//      whole layer is a no-op and results are returned untouched.
//    * The penalty is moderate so the temperature slider in the
//      find-results view can still reveal these files by raising
//      the temperature (nothing is ever truly dropped here).
// ============================================================
const GITIGNORE_FILENAME_PENALTY_MULTIPLIER = 0.3;
const GITIGNORE_FILENAME_PENALTY_FLAT = 300;

// Parse a single .gitignore line into a structured matcher.
// Returns null for comments, blanks, and patterns that cannot
// apply to a bare basename (i.e. patterns containing an inner
// slash - those are anchored to a specific path).
function parseGitignoreLine(line) {
    let p = line.trim();
    if (!p || p.startsWith('#')) return null;

    let negated = false;
    if (p.startsWith('!')) {
        negated = true;
        p = p.slice(1);
    }

    // Directory-only marker is irrelevant for basename matching -
    // strip it and continue.
    if (p.endsWith('/')) p = p.slice(0, -1);

    // Leading slash anchors to the .gitignore location. After
    // stripping it we still only match the basename (per request).
    if (p.startsWith('/')) p = p.slice(1);

    // Patterns with an inner slash are path-anchored - they do not
    // participate in the "filename match" penalty. Skip them.
    if (p.includes('/')) return null;

    // Glob -> RegExp. Support * and ? only (covers ~99% of real
    // .gitignore filename patterns like *.log, .env, *.tmp).
    let re = '';
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === '*') {
            re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else if ('\\^$.|+()[]{}'.includes(c)) {
            re += '\\' + c;
        } else {
            re += c;
        }
    }

    let regex;
    try {
        regex = new RegExp('^' + re + '$');
    } catch {
        return null;
    }

    return { regex, negated };
}

// Read the top-level .gitignore from the given root directory.
// Returns an array of parsed patterns (may be empty). Never throws.
async function loadRootGitignorePatterns(rootDir) {
    let content;
    try {
        content = await fs.readFile(path.join(rootDir, '.gitignore'), 'utf8');
    } catch {
        return [];
    }

    const patterns = [];
    for (const line of content.split(/\r?\n/)) {
        const parsed = parseGitignoreLine(line);
        if (parsed) patterns.push(parsed);
    }
    return patterns;
}

// Does a bare filename match any of the parsed gitignore patterns?
// Follows standard gitignore semantics: LAST matching pattern wins,
// and a "!" pattern can un-ignore a previously matched name.
function basenameMatchesGitignorePatterns(baseName, patterns) {
    let matched = false;
    for (const pat of patterns) {
        if (pat.regex.test(baseName)) {
            matched = !pat.negated;
        }
    }
    return matched;
}

// Apply the gitignore filename penalty IN PLACE and re-sort.
//
// A candidate is penalised ONLY when BOTH are true:
//   (a) at least one search token appears in the basename
//       (this is what makes it a true "FILENAME MATCH" case -
//       content-only hits are left completely alone), AND
//   (b) that basename matches an applicable .gitignore pattern.
//
// The entry stays in the results array; only its score is
// reduced, so the temperature slider can still reveal it.
function applyGitignoreFilenamePenalty(results, patterns, searchTerm) {
    if (!patterns || patterns.length === 0) return results;

    const tokens = tokenizeSearchTerm(searchTerm);
    if (tokens.length === 0) return results;

    for (const r of results) {
        const baseName = path.basename(r.path);
        const baseLower = baseName.toLowerCase();

        // (a) Filename itself matched the search term.
        const termInName = tokens.some(t => baseLower.includes(t));
        if (!termInName) continue;

        // (b) Filename is gitignored.
        if (!basenameMatchesGitignorePatterns(baseName, patterns)) continue;

        r.score = Math.max(
            0,
            Math.round(r.score * GITIGNORE_FILENAME_PENALTY_MULTIPLIER) - GITIGNORE_FILENAME_PENALTY_FLAT
        );
        r.gitignored = true;
    }

    results.sort((a, b) => b.score - a.score);
    return results;
}

// ============================================================
//  Temperature -> minimum-score threshold.
//
//  Behaves like a volume knob for similarity:
//    0  = only strong filename matches
//    ~5 = balanced (default) - includes content hits
//    10 = everything, including weak fuzzy hits
// ============================================================
function temperatureToThreshold(temp, maxTemp = 10) {
    const t = Math.max(0, Math.min(maxTemp, temp)) / maxTemp;
    // Ease-out curve: strict at 0, smooth slope, fully open at max.
    return Math.round(1800 * Math.pow(1 - t, 2.2));
}

// Parallel worker-pool search across the given file paths.
// concurrency ~= number of in-flight reads. 32 is a sweet spot for local SSDs:
// high enough to saturate I/O, low enough to avoid EMFILE / thrashing.
async function searchFilesForTerm(filePaths, searchTerm, caseSensitive, concurrency = 32) {
    const matches = [];

    if (filePaths.length === 0) return matches;

    const termBuffer = Buffer.from(searchTerm, 'utf8');
    const normalizedTerm = caseSensitive ? searchTerm : searchTerm.toLowerCase();

    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            const i = nextIndex++;
            if (i >= filePaths.length) return;

            const filePath = filePaths[i];

            try {
                const found = await fileContainsTerm(filePath, normalizedTerm, caseSensitive, termBuffer);
                if (found) matches.push(filePath);
            } catch {
                // Ignore per-file errors so one bad file doesn't abort the search.
            }
        }
    };

    const workerCount = Math.min(concurrency, filePaths.length);
    const workers = new Array(workerCount);

    for (let i = 0; i < workerCount; i++) {
        workers[i] = worker();
    }

    await Promise.all(workers);

    return matches;
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
        console.log(`Stats: ${summary.totalLines} lines | ${summary.containers} containers | ${summary.functions} functions | ${summary.totalMembers} members
`);
        
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
    const referenceOnlyFiles = new Set();  // NEW: set for reference-only files
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
        referenceOnlyFiles.delete(filePath);  // remove from reference set if deselected
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
        
        if (referenceOnlyFiles.size > 0) {
            console.log(`${MAGENTA}${BOLD}ℹ️  ${referenceOnlyFiles.size} file(s) marked reference-only${RESET}`);
        }
        
        console.log('─'.repeat(process.stdout.columns || 80));
        console.log(`${BOLD}Navigation:${RESET} ↑/↓ move, PgUp/PgDn page, Enter open/select, Space toggle, a current, A recursive, I with imports, l list, f find, G gen, C customize, P gen+request, b back, q quit`);
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
                } else if (referenceOnlyFiles.has(fullPath)) {
                    prefix = `${YELLOW}[ℹ️]${RESET} `;
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

    // ========================================================
    //  ONE-PAGE WIZARD key reader with LEFT-ARROW = BACK.
    //
    //  Used only inside the generate flow. Instead of printing a
    //  fresh prompt each time, the whole wizard is rendered on a
    //  single page and only the focused row is edited here.
    //
    //  Behavior:
    //    * printable keys are appended to the current value and echoed
    //    * Backspace removes the last character
    //    * Enter submits the value   -> { type: 'value', value }
    //    * LEFT ARROW                -> { type: 'back' }
    //    * Ctrl+C                    -> { type: 'back' } (safe: caller
    //                                   steps back; at the first step
    //                                   it exits the generate flow)
    // ========================================================
    const askStepWithBack = (label, initialValue = '', defaultValue = null) => {
        return new Promise(resolve => {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.setEncoding('utf8');

            let buffer = String(initialValue == null ? '' : initialValue);

            // Print the label + current buffer on the current line.
            process.stdout.write(`${label} ${buffer}`);

            const finishBack = () => {
                process.stdin.removeListener('data', onData);
                process.stdout.write('\n');
                resolve({ type: 'back' });
            };

            const finishValue = () => {
                process.stdin.removeListener('data', onData);
                process.stdout.write('\n');
                const trimmed = buffer.trim();
                const value = (trimmed === '' && defaultValue !== null)
                    ? String(defaultValue)
                    : trimmed;
                resolve({ type: 'value', value });
            };

            const onData = (key) => {
                if (key === '\u0003') { finishBack(); return; }

                if (key === '\r' || key === '\n') { finishValue(); return; }

                // LEFT ARROW - cascade back one step (single keypress).
                if (key === '\u001b[D') { finishBack(); return; }

                if (key === '\u007f' || key === '\b') {
                    if (buffer.length > 0) {
                        buffer = buffer.slice(0, -1);
                        process.stdout.write('\b \b');
                    }
                    return;
                }

                // Ignore other escape sequences (up/down/right arrows, etc).
                if (key.startsWith('\u001b')) return;

                // Ignore non-printable control chars.
                if (key.length === 1 && key.charCodeAt(0) < 32) return;

                buffer += key;
                process.stdout.write(key);
            };

            process.stdin.on('data', onData);
        });
    };

    // ========================================================
    //  Generate flow (CUSTOMIZE WIZARD) - extracted so both the
    //  main menu and the find-results view can trigger it with
    //  the C key.
    // ========================================================
    async function handleGenerate() {
        // Detach the browser key handler FIRST, even on the early
        // "no files selected" return path. This prevents a duplicate
        // listener from being attached when the wizard is invoked
        // repeatedly without any files selected (listener-accumulation
        // bug). Removing a non-attached listener is a no-op, so this
        // is safe when called from the find-results view too.
        process.stdin.removeListener('data', onKeypress);

        if (selectedFiles.size === 0) {
            console.log('\nNo files selected.');
            render();
            return;
        }

        // Temporarily disable raw mode for interactive prompts.
        process.stdin.setRawMode(false);

        // ============================================================
        //  ONE-PAGE WIZARD + CASCADE BACK
        //
        //  The whole generate flow is rendered as a single page
        //  (a form-like summary). Every prompt is a row on that page.
        //
        //  As you move through steps the page is REDRAWN, filling in
        //  the rows behind you and highlighting the current row.
        //
        //  Pressing the LEFT ARROW KEY at any step moves the focus to
        //  the PREVIOUS row - a true one-page cascade. The value of
        //  the row you land on is editable again, and any state that
        //  was applied by steps AFTER it is cleanly undone.
        //
        //  The AI REQUEST/DEMAND row instead opens the robust multi-
        //  line text editor (openTextEditor). Cancelling that editor
        //  (Esc / Ctrl+C) behaves exactly like pressing LEFT ARROW:
        //  it steps back to the previous row.
        // ============================================================
        const jsFiles = [...selectedFiles].filter(isJavaScriptFile);

        // Track what THIS session added so we can undo cleanly on "back".
        const sessionParsedFiles = new Set();
        const sessionRefFiles = new Set();

        // The ordered list of "rows" in the wizard. Each row is a step.
        // A row is only shown when its `visible()` returns true.
        const ROW = {
            PARSE: 'parse',
            PARSE_FILES: 'parse-files',
            REF: 'ref',
            REF_FILES: 'ref-files',
            AI: 'ai',
            DEMAND: 'demand',
            FORMAT: 'format',
            SAVE: 'save',
        };

        // State driven by the wizard rows.
        let parseChoice = 'no';           // 'yes' | 'no'
        let filesToParse = [];            // resolved js paths
        let refChoice = 'no';             // 'yes' | 'no'
        let filesToMarkRef = [];          // resolved selected paths
        let includeInstructions = true;   // bool (default: yes)
        let userDemand = '';              // string (may be multi-line)
        let outputFormat = 'tagged';      // 'full' | 'tagged' | 'both' | 'codeonly' (default: tagged)
        let saveName = '';                // string

        // Which rows are currently part of the flow (some are conditional).
        const visibleRows = () => {
            const rows = [];
            if (jsFiles.length > 0) {
                rows.push(ROW.PARSE);
                if (parseChoice === 'yes') rows.push(ROW.PARSE_FILES);
            }
            rows.push(ROW.REF);
            if (refChoice === 'yes') rows.push(ROW.REF_FILES);
            rows.push(ROW.AI);
            if (includeInstructions) {
                rows.push(ROW.DEMAND);
                rows.push(ROW.FORMAT);
            }
            rows.push(ROW.SAVE);
            return rows;
        };

        // The step that should be focused AFTER the given one, based on
        // the current state. Used when Enter is pressed on a row.
        const nextRow = (current) => {
            const rows = visibleRows();
            const idx = rows.indexOf(current);
            if (idx === -1) return rows[rows.length - 1];
            return rows[Math.min(idx + 1, rows.length - 1)];
        };

        // The step that should be focused BEFORE the given one, based on
        // the current state. Used when Left Arrow is pressed on a row.
        // Returns null when we are already at the first row.
        const prevRow = (current) => {
            const rows = visibleRows();
            const idx = rows.indexOf(current);
            if (idx <= 0) return null;
            return rows[idx - 1];
        };

        // Undo any state that was ADDED while sitting on the given row,
        // so stepping back leaves no trace from that row's actions.
        const undoRowState = (fromRow) => {
            if (fromRow === ROW.PARSE_FILES) {
                // Undo parsing done in this session when re-editing this row.
                for (const f of sessionParsedFiles) parsedFiles.delete(f);
                sessionParsedFiles.clear();
            }
            if (fromRow === ROW.REF_FILES) {
                // Undo reference-only marks done in this session.
                for (const f of sessionRefFiles) referenceOnlyFiles.delete(f);
                sessionRefFiles.clear();
            }
        };

        // Format a row's current value for the summary display.
        const rowValueText = (row) => {
            switch (row) {
                case ROW.PARSE:
                    return jsFiles.length === 0 ? '(skipped - no JS files)' : (parseChoice === 'yes' ? 'yes' : 'no');
                case ROW.PARSE_FILES:
                    return filesToParse.length === 0
                        ? 'none'
                        : filesToParse.map(f => path.basename(f)).join(', ');
                case ROW.REF:
                    return refChoice === 'yes' ? 'yes' : 'no';
                case ROW.REF_FILES:
                    return filesToMarkRef.length === 0
                        ? 'none'
                        : filesToMarkRef.map(f => path.basename(f)).join(', ');
                case ROW.AI:
                    return includeInstructions ? 'yes' : 'no';
                case ROW.DEMAND: {
                    if (!userDemand) return '(empty)';
                    const demandLines = userDemand.split('\n');
                    const firstLine = demandLines[0];
                    return demandLines.length > 1
                        ? `${firstLine}  [${demandLines.length} lines]`
                        : firstLine;
                }
                case ROW.FORMAT:
                    if (outputFormat === 'tagged') return 'Tagged replacements';
                    if (outputFormat === 'both') return 'Both';
                    if (outputFormat === 'codeonly') return 'Full code only (no tags)';
                    return 'Full files';
                case ROW.SAVE:
                    return saveName || '(empty)';
                default:
                    return '';
            }
        };

        // Human-readable label for a row.
        const rowLabelText = (row) => {
            switch (row) {
                case ROW.PARSE: return 'Parse JS files with CodeParser?';
                case ROW.PARSE_FILES: return '  Which files to parse?';
                case ROW.REF: return 'Mark files as reference-only?';
                case ROW.REF_FILES: return '  Which files are reference-only?';
                case ROW.AI: return 'Add AI instructions?';
                case ROW.DEMAND: return '  AI request/demand:';
                case ROW.FORMAT: return '  Output format:';
                case ROW.SAVE: return 'Save session as (empty to skip):';
                default: return '';
            }
        };

        // Render the entire wizard page with the focused row highlighted.
        const renderWizardPage = (focusedRow) => {
            clearScreen();

            console.log(`${BOLD}${GREEN}=== GENERATE STRUCT ===${RESET}`);
            console.log(`${BOLD}${BLUE}Step-by-step wizard${RESET}  ${MAGENTA}(← Left Arrow = back one step, Enter = confirm)${RESET}`);
            console.log('─'.repeat(process.stdout.columns || 80));
            console.log(`${BOLD}Selected:${RESET} ${selectedFiles.size} file(s) | ${BOLD}Tokens:${RESET} ${formatNumber(totalTokens)}`);
            console.log('─'.repeat(process.stdout.columns || 80));

            const rows = visibleRows();

            // Compute the index of the focused row so we can color it.
            const focusedIdx = rows.indexOf(focusedRow);

            rows.forEach((row, idx) => {
                const label = rowLabelText(row);
                const value = rowValueText(row);

                // Rows before focus are "done", rows after are "future".
                let statusIcon;
                let statusColor;
                if (idx < focusedIdx) {
                    statusIcon = '✔';
                    statusColor = GREEN;
                } else if (idx === focusedIdx) {
                    statusIcon = '▶';
                    statusColor = YELLOW;
                } else {
                    statusIcon = '·';
                    statusColor = MAGENTA;
                }

                const line = `${statusColor}[${statusIcon}]${RESET} ${label} ${BOLD}${value}${RESET}`;

                if (idx === focusedIdx) {
                    console.log(`${REVERSE}${line}${RESET}`);
                } else if (idx < focusedIdx) {
                    console.log(line);
                } else {
                    // Dim future rows a bit (use plain text, color only icon).
                    console.log(`${line}`);
                }
            });

            console.log('─'.repeat(process.stdout.columns || 80));

            if (focusedIdx === 0) {
                console.log(`${MAGENTA}At the first step. Left Arrow cancels generate and returns to file selection.${RESET}`);
            }
        };

        // Main loop - drives the one-page wizard.
        // `currentRow` is the row currently being edited.
        // A special value of `null` means the wizard is done / exiting.
        let currentRow = jsFiles.length > 0 ? ROW.PARSE : ROW.REF;
        let exitGenerate = false;
        let generated = false;

        while (!exitGenerate && !generated) {
            renderWizardPage(currentRow);

            // Show contextual hints for the row about to be edited.
            if (currentRow === ROW.PARSE_FILES) {
                console.log(`\n${BOLD}JavaScript files available for parsing:${RESET}`);
                jsFiles.forEach((file, idx) => {
                    const alreadyParsed = parsedFiles.has(file) ? ' (already parsed)' : '';
                    console.log(`  ${idx + 1}. ${path.basename(file)}${alreadyParsed}`);
                });
            } else if (currentRow === ROW.REF_FILES) {
                console.log(`\n${BOLD}Selected files:${RESET}`);
                const allSelected = [...selectedFiles];
                allSelected.forEach((file, idx) => {
                    const alreadyRef = referenceOnlyFiles.has(file) ? ' (already marked)' : '';
                    console.log(`  ${idx + 1}. ${path.basename(file)}${alreadyRef}`);
                });
            } else if (currentRow === ROW.FORMAT) {
                console.log(`\n  ${BOLD}1${RESET} = Full files   ${BOLD}2${RESET} = Tagged replacements   ${BOLD}3${RESET} = Both   ${BOLD}4${RESET} = Full code only (no tags, no abbreviations)`);
                if (parsedFiles.size > 0) {
                    console.log(`  ${YELLOW}💡 You have parsed files - option 2 (Tagged) works better.${RESET}`);
                }
            }

            // Ask this row's question (single-line, ← = back).
            let res;

            switch (currentRow) {
                case ROW.PARSE: {
                    res = await askStepWithBack(
                        `${BOLD}Parse JS files with CodeParser? (y/n):${RESET}`,
                        '',
                        'n'
                    );
                    if (res.type === 'back') { exitGenerate = true; break; }

                    const a = res.value.toLowerCase();
                    parseChoice = (a === 'y' || a === 'yes') ? 'yes' : 'no';
                    if (parseChoice === 'no') {
                        filesToParse = [];
                        undoRowState(ROW.PARSE_FILES);
                    }
                    currentRow = nextRow(ROW.PARSE);
                    break;
                }

                case ROW.PARSE_FILES: {
                    res = await askStepWithBack(
                        `${BOLD}Which files? (all | 1,3,5 | 2-4 | none):${RESET}`,
                        '',
                        'none'
                    );
                    if (res.type === 'back') {
                        undoRowState(ROW.PARSE_FILES);
                        currentRow = prevRow(ROW.PARSE_FILES);
                        break;
                    }

                    const a = res.value.toLowerCase();
                    if (a === 'none' || a === '') {
                        filesToParse = [];
                    } else if (a === 'all') {
                        filesToParse = [...jsFiles];
                    } else {
                        const indexes = parseIndexes(res.value, jsFiles.length);
                        filesToParse = indexes.map(i => jsFiles[i]);
                    }

                    // Run the parser NOW for each chosen file (this row's action).
                    // Because undoRowState(ROW.PARSE_FILES) is called when we
                    // step back OR before re-applying, this remains idempotent.
                    for (const filePath of filesToParse) {
                        // Skip files already parsed in THIS session (avoids
                        // re-opening the menu if the user just presses Enter
                        // again after tweaking the index list).
                        if (sessionParsedFiles.has(filePath) && parsedFiles.has(filePath)) continue;

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
                                validation: parseResult.validation,
                                selection: parseResult.selection,
                            });
                            sessionParsedFiles.add(filePath);
                            console.log(`\n${GREEN}✓ ${path.basename(filePath)} parsed successfully${RESET}`);
                        }
                    }

                    currentRow = nextRow(ROW.PARSE_FILES);
                    break;
                }

                case ROW.REF: {
                    res = await askStepWithBack(
                        `${BOLD}Mark files as reference-only? (y/n):${RESET}`,
                        '',
                        'n'
                    );
                    if (res.type === 'back') {
                        // Leaving REF undoes any reference-only marks it created.
                        undoRowState(ROW.REF_FILES);
                        const prev = prevRow(ROW.REF);
                        if (prev === null) { exitGenerate = true; break; }
                        currentRow = prev;
                        break;
                    }

                    const a = res.value.toLowerCase();
                    refChoice = (a === 'y' || a === 'yes') ? 'yes' : 'no';
                    if (refChoice === 'no') {
                        filesToMarkRef = [];
                        undoRowState(ROW.REF_FILES);
                    }
                    currentRow = nextRow(ROW.REF);
                    break;
                }

                case ROW.REF_FILES: {
                    res = await askStepWithBack(
                        `${BOLD}Which files reference-only? (all | 1,3,5 | 2-4 | none):${RESET}`,
                        '',
                        'none'
                    );
                    if (res.type === 'back') {
                        undoRowState(ROW.REF_FILES);
                        currentRow = prevRow(ROW.REF_FILES);
                        break;
                    }

                    const a = res.value.toLowerCase();
                    const allSelected = [...selectedFiles];
                    if (a === 'none' || a === '') {
                        filesToMarkRef = [];
                    } else if (a === 'all') {
                        filesToMarkRef = [...allSelected];
                    } else {
                        const indexes = parseIndexes(res.value, allSelected.length);
                        filesToMarkRef = indexes.map(i => allSelected[i]);
                    }

                    // Apply marks for this row's choice. Undo first so that
                    // pressing Enter again after editing the list is clean.
                    undoRowState(ROW.REF_FILES);
                    for (const filePath of filesToMarkRef) {
                        referenceOnlyFiles.add(filePath);
                        sessionRefFiles.add(filePath);
                    }
                    if (filesToMarkRef.length > 0) {
                        console.log(`\n${GREEN}Marked ${filesToMarkRef.length} file(s) as reference-only.${RESET}`);
                    }

                    currentRow = nextRow(ROW.REF_FILES);
                    break;
                }

                case ROW.AI: {
                    res = await askStepWithBack(
                        `${BOLD}Add AI instructions? (y/n):${RESET}`,
                        '',
                        'y'
                    );
                    if (res.type === 'back') {
                        // Stepping back from AI lands on the previous visible row.
                        const prev = prevRow(ROW.AI);
                        if (prev === null) { exitGenerate = true; break; }
                        currentRow = prev;
                        break;
                    }

                    const a = res.value.toLowerCase();
                    includeInstructions = (a === 'y' || a === 'yes');
                    if (!includeInstructions) {
                        userDemand = '';
                        outputFormat = 'tagged';
                    }
                    currentRow = nextRow(ROW.AI);
                    break;
                }

                case ROW.DEMAND: {
                    // Robust nano-like multi-line editor for the user request.
                    // Cancelling (Esc / Ctrl+C) behaves like Left Arrow:
                    // it steps back to the previous row.
                    const editResult = await openTextEditor(userDemand || '', 'AI REQUEST/DEMAND');
                    if (editResult.type === 'cancel') {
                        currentRow = prevRow(ROW.DEMAND);
                        break;
                    }
                    userDemand = editResult.value;
                    currentRow = nextRow(ROW.DEMAND);
                    break;
                }

                case ROW.FORMAT: {
                    res = await askStepWithBack(
                        `${BOLD}Output format (1/2/3/4):${RESET}`,
                        '',
                        '2'
                    );
                    if (res.type === 'back') {
                        currentRow = prevRow(ROW.FORMAT);
                        break;
                    }

                    if (res.value === '2') outputFormat = 'tagged';
                    else if (res.value === '3') outputFormat = 'both';
                    else if (res.value === '4') outputFormat = 'codeonly';
                    else outputFormat = 'full';

                    currentRow = nextRow(ROW.FORMAT);
                    break;
                }

                case ROW.SAVE: {
                    res = await askStepWithBack(
                        `${BOLD}Save session as (empty to skip):${RESET}`,
                        ''
                    );
                    if (res.type === 'back') {
                        currentRow = prevRow(ROW.SAVE);
                        break;
                    }
                    saveName = res.value;

                    // Now generate the struct file using the collected state.
                    console.log(`\n${GREEN}${BOLD}=== GENERATING STRUCT ===${RESET}\n`);

                    await generateStruct([...selectedFiles], 'struct', {
                        includeInstructions,
                        userDemand,
                        outputFormat,
                        parsedFiles,
                        referenceOnlyFiles,
                    });

                    if (saveName) {
                        // Serialize only the parser SELECTIONS - the actual parsed
                        // content is regenerated from disk when the save is loaded,
                        // so edits made to the files afterwards are picked up.
                        const parsedState = {};
                        for (const [filePath, info] of parsedFiles.entries()) {
                            parsedState[filePath] = {
                                selection: info.selection || null,
                            };
                        }

                        await saveState({
                            version: 1,
                            files: [...selectedFiles],
                            includeInstructions,
                            userDemand,
                            outputFormat,
                            parsed: parsedState,
                            referenceOnly: [...referenceOnlyFiles],
                        }, saveName);
                    }

                    generated = true;
                    break;
                }
            }
        }

        if (exitGenerate) {
            // Cascade back out of generate. The caller will restore the
            // correct key handler and re-render (browser or find results).
            return;
        }

        cleanupAndExit(0);
    }

    // ========================================================
    //  FIND-RESULTS view (scored + temperature slider)
    //
    //  Accepts an array of scored results:
    //     { path, score, hits, contentMatched }
    //
    //  The TEMPERATURE slider (0..10) acts like a volume knob for
    //  the minimum-similarity threshold:
    //     low  -> only strong filename matches are shown/selected
    //     mid  -> content hits join in (default)
    //     high -> weak fuzzy filename matches are revealed too
    //
    //  The selection mirrors the visible (above-threshold) set:
    //  raising temperature adds candidates; lowering it removes
    //  them. Individual toggles still work on top of that.
    //
    //  Keys:
    //    ↑/↓, PgUp/PgDn  -> navigate
    //    Space / Enter   -> toggle selection of file under cursor
    //    [ or -          -> decrease temperature (stricter)
    //    ] or + or =     -> increase temperature (looser)
    //    a               -> select all currently visible
    //    n               -> unselect all currently visible
    //    G               -> generate directly (defaults, no wizard)
    //    C               -> enter customize wizard
    //    P               -> generate asking only for USER REQUEST
    //                       (captured in the robust multi-line editor)
    //    B (or Esc)      -> return to the normal browser
    //    Ctrl+C          -> quit
    // ========================================================
    async function showFindResultsView(scoredResults) {
        process.stdin.setRawMode(true);
        process.stdin.resume();

        const MAX_TEMP = 10;
        let temperature = 5;   // balanced default
        let cursor = 0;
        let scrollOffset = 0;

        // Recompute the visible list + mirror selection to match.
        // Files above the threshold become selected; files below
        // the threshold get deselected. This gives the "volume-like"
        // progressive selection feel the user asked for.
        const recomputeVisible = async () => {
            const threshold = temperatureToThreshold(temperature, MAX_TEMP);
            const visible = scoredResults.filter(r => r.score >= threshold);
            const visibleSet = new Set(visible.map(r => r.path));

            for (const r of scoredResults) {
                const shouldBeSelected = visibleSet.has(r.path);
                const isSelected = selectedFiles.has(r.path);

                if (shouldBeSelected && !isSelected) {
                    await selectFile(r.path);
                } else if (!shouldBeSelected && isSelected) {
                    deselectFile(r.path);
                }
            }

            // Clamp cursor if the visible list shrank.
            if (cursor >= visible.length) {
                cursor = Math.max(0, visible.length - 1);
            }

            return visible;
        };

        const getMaxRows = () => {
            const rows = process.stdout.rows || 24;
            return Math.max(1, rows - 7);
        };

        const adjustScroll = (visibleLength) => {
            const max = getMaxRows();

            if (cursor < scrollOffset) scrollOffset = cursor;
            if (cursor >= scrollOffset + max) scrollOffset = cursor - max + 1;

            const maxScroll = Math.max(0, visibleLength - max);
            if (scrollOffset > maxScroll) scrollOffset = maxScroll;
            if (scrollOffset < 0) scrollOffset = 0;
        };

        // Volume-bar style temperature indicator.
        const buildVolumeBar = (value, max, width = 12) => {
            const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
            const empty = width - filled;
            const fillColor = value < 3 ? RED : value < 7 ? YELLOW : GREEN;
            return `${fillColor}${'█'.repeat(filled)}${RESET}${'░'.repeat(empty)}`;
        };

        const renderFind = (visible) => {
            clearScreen();

            const max = getMaxRows();
            adjustScroll(visible.length);

            const slice = visible.slice(scrollOffset, scrollOffset + max);
            const selectedVisible = visible.filter(r => selectedFiles.has(r.path)).length;
            const threshold = temperatureToThreshold(temperature, MAX_TEMP);

            console.log(`${BOLD}${GREEN}=== FIND RESULTS ===${RESET}`);
            console.log(
                `${BOLD}Candidates: ${scoredResults.length} | Visible: ${visible.length} | Selected (visible): ${selectedVisible}${RESET}`
            );
            console.log(
                `${BOLD}Temperature:${RESET} ${buildVolumeBar(temperature, MAX_TEMP)} ` +
                `${BOLD}${temperature}/${MAX_TEMP}${RESET}  ` +
                `${MAGENTA}(min score: ${threshold})${RESET}`
            );
            console.log('─'.repeat(process.stdout.columns || 80));
            console.log(
                `${BOLD}Keys:${RESET} ↑/↓ move, PgUp/PgDn page, Space toggle, ` +
                `${YELLOW}[${RESET}/${YELLOW}]${RESET} temp, a all, n none, ` +
                `${GREEN}G${RESET} gen, ${YELLOW}C${RESET} customize, ${MAGENTA}P${RESET} request, ${YELLOW}B${RESET} back`
            );
            console.log('─'.repeat(process.stdout.columns || 80));

            slice.forEach((item, index) => {
                const actualIndex = scrollOffset + index;
                const isSelected = selectedFiles.has(item.path);
                const prefix = isSelected ? `${GREEN}[✔]${RESET}` : '[ ]';
                const rel = path.relative(currentDirectory, item.path) || item.path;

                // [cN] = content match with N hits, [f] = filename-only fuzzy
                const tag = item.contentMatched
                    ? `${BLUE}c${String(item.hits).padStart(2, '0')}${RESET}`
                    : `${MAGENTA}f  ${RESET}`;
                const scoreStr = `${BOLD}${String(item.score).padStart(4, ' ')}${RESET}`;
                const line = `${prefix} ${scoreStr} [${tag}] ${rel}`;

                if (actualIndex === cursor) {
                    console.log(`${REVERSE}${line}${RESET}`);
                } else {
                    console.log(line);
                }
            });

            if (visible.length > max) {
                const page = Math.floor(scrollOffset / max) + 1;
                const totalPages = Math.ceil(visible.length / max);
                console.log(`─ ${BOLD}${page}${RESET}/${totalPages} ${visible.length} visible`);
            } else if (visible.length === 0) {
                console.log(`${YELLOW}(temperature too low - raise it with ] or +)${RESET}`);
            }
        };

        // Initial population of the visible list (auto-selects).
        let visible = await recomputeVisible();

        return new Promise(resolve => {
            const onFindKeypress = async (key) => {
                // ---------- temperature controls ----------
                if (key === '[' || key === '-') {
                    if (temperature > 0) {
                        temperature--;
                        visible = await recomputeVisible();
                    }
                    renderFind(visible);
                    return;
                }

                if (key === ']' || key === '+' || key === '=') {
                    if (temperature < MAX_TEMP) {
                        temperature++;
                        visible = await recomputeVisible();
                    }
                    renderFind(visible);
                    return;
                }

                // ---------- navigation ----------
                if (key === '\u001b[A') {
                    if (cursor > 0) cursor--;
                    renderFind(visible);
                    return;
                }

                if (key === '\u001b[B') {
                    if (cursor < visible.length - 1) cursor++;
                    renderFind(visible);
                    return;
                }

                if (key === '\u001b[5~') {
                    cursor = Math.max(0, cursor - getMaxRows());
                    renderFind(visible);
                    return;
                }

                if (key === '\u001b[6~') {
                    cursor = Math.min(visible.length - 1, cursor + getMaxRows());
                    renderFind(visible);
                    return;
                }

                // ---------- toggle under cursor ----------
                if (key === ' ' || key === '\r' || key === '\n') {
                    const item = visible[cursor];
                    if (item) {
                        await toggleFile(item.path);
                    }
                    renderFind(visible);
                    return;
                }

                // ---------- bulk select/unselect (visible only) ----------
                if (key === 'a') {
                    for (const item of visible) {
                        if (!selectedFiles.has(item.path)) {
                            await selectFile(item.path);
                        }
                    }
                    renderFind(visible);
                    return;
                }

                if (key === 'n') {
                    for (const item of visible) {
                        deselectFile(item.path);
                    }
                    renderFind(visible);
                    return;
                }

                // ---------- generate (direct, default values) ----------
                if (key === 'g' || key === 'G') {
                    if (selectedFiles.size === 0) {
                        renderFind(visible);
                        return;
                    }

                    process.stdin.removeListener('data', onFindKeypress);
                    process.stdin.setRawMode(false);

                    console.log(`\n${GREEN}${BOLD}=== GENERATING STRUCT ===${RESET}\n`);
                    console.log(`Selected files:  ${selectedFiles.size}`);
                    console.log(`AI instructions: yes`);
                    console.log(`Output format:   Tagged replacements`);
                    console.log(`Parsing:         skipped (default)`);
                    console.log(`Reference-only:  none (default)\n`);

                    await generateStruct([...selectedFiles], 'struct', {
                        includeInstructions: true,
                        userDemand: '',
                        outputFormat: 'tagged',
                        parsedFiles: new Map(),
                        referenceOnlyFiles: new Set(),
                    });

                    cleanupAndExit(0);
                    return;
                }

                // ---------- customize (full wizard) ----------
                if (key === 'c' || key === 'C') {
                    if (selectedFiles.size === 0) {
                        renderFind(visible);
                        return;
                    }

                    process.stdin.removeListener('data', onFindKeypress);

                    // handleGenerate() exits the process on normal completion.
                    // If the user cascades all the way back from the first
                    // wizard row, it returns early so we hand control back to
                    // the caller, which restores the browser view.
                    await handleGenerate();

                    // Resolve so showFindResultsView returns; the caller
                    // (the `f` handler) re-attaches onKeypress and renders
                    // the file browser for us.
                    resolve();
                    return;
                }

                // ---------- generate with USER REQUEST only (P key) ----------
                if (key === 'p' || key === 'P') {
                    if (selectedFiles.size === 0) {
                        renderFind(visible);
                        return;
                    }

                    process.stdin.removeListener('data', onFindKeypress);

                    // Open the robust multi-line editor for the request.
                    // The editor manages raw mode itself and restores it
                    // on exit, so no raw-mode toggling is needed here.
                    const editResult = await openTextEditor('', 'USER REQUEST');

                    if (editResult.type === 'cancel') {
                        process.stdin.on('data', onFindKeypress);
                        renderFind(visible);
                        return;
                    }

                    const userDemand = editResult.value;

                    if (!userDemand || userDemand.trim() === '') {
                        console.log(`\n${YELLOW}Empty request - cancelling.${RESET}`);
                        process.stdin.on('data', onFindKeypress);
                        renderFind(visible);
                        return;
                    }

                    console.log(`\n${GREEN}${BOLD}=== GENERATING STRUCT ===${RESET}\n`);

                    await generateStruct([...selectedFiles], 'struct', {
                        includeInstructions: true,
                        userDemand: userDemand.trim(),
                        outputFormat: 'tagged',
                        parsedFiles: new Map(),
                        referenceOnlyFiles: new Set(),
                    });

                    cleanupAndExit(0);
                    return;
                }

                // ---------- back to normal browser ----------
                if (key === 'b' || key === 'B' || key === '\u001b') {
                    process.stdin.removeListener('data', onFindKeypress);
                    resolve();
                    return;
                }

                if (key === '\u0003') {
                    cleanupAndExit(0);
                }
            };

            process.stdin.on('data', onFindKeypress);
            renderFind(visible);
        });
    }

    // ========================================================
    //  SELECTED FILES LIST view (INTERACTIVE)
    //
    //  Triggered by the `l` key from the main browser view.
    //  Shows a clean list of every currently selected file
    //  (full absolute path) plus per-file tags for the parsed /
    //  reference-only state, per-file token counts, and the
    //  overall token total.
    //
    //  NEW: the view is now INTERACTIVE - you can exclude a file
    //  from the selection without leaving this clean list, then
    //  re-include it if you change your mind.
    //
    //  Keys:
    //    ↑/↓, PgUp/PgDn  -> navigate
    //    Space           -> toggle selected/excluded for the
    //                       file under the cursor (calls the
    //                       SAME selectFile/deselectFile helpers
    //                       used everywhere else - no selection
    //                       logic is changed)
    //    Enter / Esc     -> return to the file browser
    //    b / B / q / Q   -> return to the file browser
    //    l / L           -> return to the file browser
    //
    //  A "snapshot" of the files selected when the view opened is
    //  kept stable so excluded files stay visible (shown as
    //  excluded) and can be re-included with Space. Leaving the
    //  view leaves the real selection exactly as toggled.
    //
    //  Purely additive: does NOT touch selection logic, parsing,
    //  search, or the generate flow. Uses the same raw-mode +
    //  dedicated-key-handler pattern as the find-results view,
    //  then restores onKeypress and redraws when done.
    // ========================================================
    async function showSelectedFilesList() {
        // Enter a dedicated raw-mode view (same pattern as find).
        process.stdin.removeListener('data', onKeypress);
        process.stdin.setRawMode(true);
        process.stdin.resume();

        // Stable snapshot of the files selected when the view opened.
        // Toggling only calls selectFile/deselectFile; the snapshot
        // itself never changes, so an excluded file stays visible here
        // and can be re-included.
        const snapshot = [...selectedFiles].sort();

        let cursor = 0;
        let scrollOffset = 0;

        const getMaxRows = () => {
            const rows = process.stdout.rows || 24;
            return Math.max(1, rows - 8);
        };

        const adjustScroll = (len) => {
            const max = getMaxRows();

            if (cursor < scrollOffset) scrollOffset = cursor;
            if (cursor >= scrollOffset + max) scrollOffset = cursor - max + 1;

            const maxScroll = Math.max(0, len - max);
            if (scrollOffset > maxScroll) scrollOffset = maxScroll;
            if (scrollOffset < 0) scrollOffset = 0;
        };

        const renderList = () => {
            clearScreen();

            const max = getMaxRows();
            adjustScroll(snapshot.length);

            const slice = snapshot.slice(scrollOffset, scrollOffset + max);
            const stillSelected = snapshot.filter(f => selectedFiles.has(f)).length;
            const excludedCount = snapshot.length - stillSelected;

            console.log(`${BOLD}${GREEN}=== SELECTED FILES ===${RESET}`);
            console.log(`${BOLD}${BLUE}Base directory:${RESET} ${YELLOW}${currentDirectory}${RESET}`);
            console.log(
                `${BOLD}In list: ${snapshot.length} | Still selected: ${stillSelected}${RESET}` +
                (excludedCount > 0 ? ` | ${RED}Excluded: ${excludedCount}${RESET}` : '')
            );
            console.log('─'.repeat(process.stdout.columns || 80));
            console.log(
                `${BOLD}Keys:${RESET} ↑/↓ move, PgUp/PgDn page, ` +
                `${RED}Space${RESET} exclude/include, ${GREEN}Enter/Esc${RESET} back`
            );
            console.log('─'.repeat(process.stdout.columns || 80));

            if (snapshot.length === 0) {
                console.log(`\n${YELLOW}(no files were selected when this view opened)${RESET}`);
            }

            slice.forEach((file, index) => {
                const actualIndex = scrollOffset + index;
                const isSelected = selectedFiles.has(file);
                const prefix = isSelected ? `${GREEN}[✔]${RESET}` : `${RED}[✗]${RESET}`;

                let tag = '';

                if (parsedFiles.has(file)) {
                    tag = ` ${MAGENTA}[PARSED]${RESET}`;
                } else if (referenceOnlyFiles.has(file)) {
                    tag = ` ${YELLOW}[REF-ONLY]${RESET}`;
                }

                const tokenCount = selectedTokenCounts.get(file) || 0;
                const tokenStr = isSelected
                    ? `${BOLD}(${formatNumber(tokenCount)} tok)${RESET}`
                    : `${MAGENTA}(excluded)${RESET}`;
                const number = String(actualIndex + 1).padStart(3, ' ');
                const line = `${prefix} ${number}. ${file} ${tokenStr}${tag}`;

                if (actualIndex === cursor) {
                    console.log(`${REVERSE}${line}${RESET}`);
                } else {
                    console.log(line);
                }
            });

            if (snapshot.length > max) {
                const page = Math.floor(scrollOffset / max) + 1;
                const totalPages = Math.ceil(snapshot.length / max);
                console.log(`─ ${BOLD}${page}${RESET}/${totalPages} ${snapshot.length} items`);
            }

            console.log('─'.repeat(process.stdout.columns || 80));
            console.log(
                `${BOLD}Total selected: ${selectedFiles.size} file(s) | Tokens: ${formatNumber(totalTokens)}${RESET}`
            );

            if (parsedFiles.size > 0) {
                console.log(`${MAGENTA}${parsedFiles.size} file(s) will be PARSED (filtered content).${RESET}`);
            }
            if (referenceOnlyFiles.size > 0) {
                console.log(`${YELLOW}${referenceOnlyFiles.size} file(s) marked REFERENCE-ONLY (do not modify).${RESET}`);
            }
        };

        return new Promise(resolve => {
            const onListKeypress = async (key) => {
                // ---------- navigation ----------
                if (key === '\u001b[A') {
                    if (cursor > 0) cursor--;
                    renderList();
                    return;
                }

                if (key === '\u001b[B') {
                    if (cursor < snapshot.length - 1) cursor++;
                    renderList();
                    return;
                }

                if (key === '\u001b[5~') {
                    cursor = Math.max(0, cursor - getMaxRows());
                    renderList();
                    return;
                }

                if (key === '\u001b[6~') {
                    cursor = Math.min(snapshot.length - 1, cursor + getMaxRows());
                    renderList();
                    return;
                }

                // ---------- toggle exclude/include under cursor ----------
                // Reuses the SAME selectFile/deselectFile helpers used
                // everywhere else - selection state, token totals, parsed
                // cache and reference-only marks stay fully consistent.
                if (key === ' ') {
                    const file = snapshot[cursor];
                    if (file) {
                        if (selectedFiles.has(file)) {
                            deselectFile(file);
                        } else {
                            await selectFile(file);
                        }
                    }
                    renderList();
                    return;
                }

                // ---------- return to the file browser ----------
                if (
                    key === '\r' || key === '\n' || key === '\u001b' ||
                    key === 'b' || key === 'B' ||
                    key === 'q' || key === 'Q' ||
                    key === 'l' || key === 'L'
                ) {
                    process.stdin.removeListener('data', onListKeypress);
                    resolve();
                    return;
                }

                if (key === '\u0003') {
                    cleanupAndExit(0);
                }
            };

            process.stdin.on('data', onListKeypress);
            renderList();
        }).then(() => {
            // Restore browser key handler and redraw - exactly like
            // the existing find/imports handlers do when they return.
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', onKeypress);
            render();
        });
    }

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

        if (key === 'l' || key === 'L') {
            // NEW: show a clean preview of all currently selected files.
            await showSelectedFilesList();
            return;
        }

        if (key === 'I') {
            // Select a JS/TS file AND every file it imports (recursively).
            // Prompts for depth; Enter = 1 layer (default), "all" = full graph.
            // Reuses the exact same raw-mode toggling pattern as the
            // existing `f` (find) handler, and calls the SAME selectFile()
            // helper used everywhere else - no other logic is touched.
            if (entries.length === 0 || cursorIndex < 0 || cursorIndex >= entries.length) {
                render();
                return;
            }

            const entry = entries[cursorIndex];

            if (entry.isDirectory()) {
                render();
                return;
            }

            const fullPath = path.join(currentDirectory, entry.name);

            if (!isJavaScriptFile(fullPath)) {
                // Non-JS file: nothing to expand, just select it normally.
                if (!selectedFiles.has(fullPath)) {
                    await selectFile(fullPath);
                }
                render();
                return;
            }

            // Temporarily leave raw mode so readline can prompt cleanly.
            process.stdin.removeListener('data', onKeypress);
            process.stdin.setRawMode(false);

            console.log(`\n${YELLOW}${BOLD}=== SELECT WITH IMPORTS ===${RESET}`);
            console.log(`File: ${path.basename(fullPath)}`);
            console.log(`Selects the file and every file it imports (recursively).`);
            console.log(`Depth 1 = direct imports only. Press Enter for default (1).`);
            console.log(`Type "all" for the full import graph (unlimited depth).\n`);

            const depthAnswer = await askQuestion('Import depth (default 1, or "all"):');

            let maxDepth = 1;
            const trimmedDepth = depthAnswer.trim().toLowerCase();

            if (trimmedDepth === 'all') {
                maxDepth = Infinity;
            } else if (trimmedDepth !== '') {
                const parsed = parseInt(trimmedDepth, 10);
                if (!isNaN(parsed) && parsed >= 0) {
                    maxDepth = parsed;
                }
            }

            const depthLabel = maxDepth === Infinity ? 'all' : String(maxDepth);
            console.log(`\nCollecting imports (depth: ${depthLabel})...`);

            let importedFiles = [];

            try {
                importedFiles = await collectImportedFiles(fullPath, maxDepth);
            } catch (err) {
                console.log(`${RED}Error collecting imports: ${err.message}${RESET}`);
            }

            let newlySelected = 0;

            for (const importedFile of importedFiles) {
                if (!selectedFiles.has(importedFile)) {
                    await selectFile(importedFile);
                    newlySelected++;
                }
            }

            console.log(
                `${GREEN}✓ Found ${importedFiles.length} file(s), ` +
                `added ${newlySelected} new selection(s).${RESET}`
            );
            await askQuestion('Press Enter to return...');

            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', onKeypress);
            render();
            return;
        }

        if (key === 'f' || key === 'F') {
            // Temporarily leave raw mode so readline can prompt cleanly.
            process.stdin.removeListener('data', onKeypress);
            process.stdin.setRawMode(false);

            console.log(`\n${YELLOW}${BOLD}=== FIND FILES ===${RESET}`);
            console.log(`Recursive search under: ${currentDirectory}`);
            console.log(`${BOLD}Smart case:${RESET} lowercase = case-insensitive, any UPPERCASE = case-sensitive`);
            console.log(`${MAGENTA}(node_modules, .git and other junk dirs are skipped)${RESET}`);
            console.log(`${BOLD}Weighting:${RESET} filename matches score highest; content hits score lower.`);
            console.log(`${BOLD}Long prompts:${RESET} the query is tokenized - unique words get more weight,`);
            console.log(`common prompt words (please, help, find, the, ...) get much less.`);
            console.log(`A temperature slider in the results view lets you relax/strict the`);
            console.log(`similarity threshold in real time (like a volume knob).\n`);

            const rawTerm = await askQuestion('Enter search term (empty to cancel):');

            if (!rawTerm || rawTerm.trim() === '') {
                process.stdin.setRawMode(true);
                process.stdin.resume();
                process.stdin.on('data', onKeypress);
                render();
                return;
            }

            const term = rawTerm.trim();
            const caseSensitive = /[A-Z]/.test(term);

            console.log(`\nSearching for "${term}" (${caseSensitive ? 'case-sensitive' : 'case-insensitive'})...`);

            const startTime = Date.now();

            let allFiles = [];
            try {
                allFiles = await collectSearchableFiles(currentDirectory);
            } catch (err) {
                console.error(`${RED}Failed to walk directory: ${err.message}${RESET}`);
            }

            // Skip already-selected files - no need to re-read them.
            const filesToSearch = allFiles.filter(f => !selectedFiles.has(f));

            console.log(`Candidate files: ${formatNumber(filesToSearch.length)}`);

            let results = [];
            try {
                results = await searchFilesForTermScored(filesToSearch, term, caseSensitive, 32);
            } catch (err) {
                console.error(`${RED}Search error: ${err.message}${RESET}`);
            }

            // ============================================================
            //  ADDITIONAL LAYER (post-scoring): .gitignore filename penalty.
            //
            //  Runs AFTER all existing scoring layers, leaving them
            //  completely untouched. It ONLY lowers the score of
            //  candidates whose filename matched the search term AND
            //  whose filename matches a .gitignore pattern. Content-only
            //  matches keep their exact original score.
            //
            //  Best-effort: if .gitignore is missing/unreadable, or the
            //  layer throws for any reason, the original results are
            //  used unchanged so nothing can break the search.
            // ============================================================
            try {
                const gitignorePatterns = await loadRootGitignorePatterns(currentDirectory);
                if (gitignorePatterns.length > 0) {
                    results = applyGitignoreFilenamePenalty(results, gitignorePatterns, term);
                }
            } catch {
                // Ignore - the penalty layer must never abort a search.
            }

            const elapsed = Date.now() - startTime;

            console.log(`\n${GREEN}${BOLD}✓ Search complete${RESET}`);
            console.log(`  Elapsed:   ${elapsed} ms`);
            console.log(`  Scanned:   ${formatNumber(filesToSearch.length)} file(s)`);
            console.log(`  Matched:   ${formatNumber(results.length)} candidate(s)`);
            if (results.length > 0) {
                console.log(`  Top score: ${results[0].score}  (${path.relative(currentDirectory, results[0].path) || results[0].path})`);
            }

            if (results.length === 0) {
                await askQuestion(`\n${YELLOW}No matches found. Press Enter to return...${RESET}`);
                process.stdin.setRawMode(true);
                process.stdin.resume();
                process.stdin.on('data', onKeypress);
                render();
                return;
            }

            // Enter the dedicated FIND-RESULTS view with SCORED results.
            // The view has a temperature slider that filters candidates
            // and mirrors selection in real time.
            await showFindResultsView(results);

            // Restore the main menu after the find-results view returns (B pressed).
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', onKeypress);
            render();
            return;
        }

        if (key === 'g' || key === 'G') {
            // DEFAULT: generate the struct directly using the flow's
            // DEFAULT values - no wizard, no parsing, AI instructions ON,
            // output format = Tagged replacements. This is the old D key
            // behaviour, now on G.
            //
            // Safe with no files selected: just render and return, no
            // listener is ever detached/re-attached here, so repeated
            // presses cannot accumulate duplicate listeners.
            if (selectedFiles.size === 0) {
                render();
                return;
            }

            process.stdin.removeListener('data', onKeypress);
            process.stdin.setRawMode(false);

            console.log(`\n${GREEN}${BOLD}=== GENERATING STRUCT ===${RESET}\n`);
            console.log(`Selected files:  ${selectedFiles.size}`);
            console.log(`AI instructions: yes`);
            console.log(`Output format:   Tagged replacements`);
            console.log(`Parsing:         skipped (default)`);
            console.log(`Reference-only:  none (default)\n`);

            await generateStruct([...selectedFiles], 'struct', {
                includeInstructions: true,
                userDemand: '',
                outputFormat: 'tagged',
                parsedFiles: new Map(),
                referenceOnlyFiles: new Set(),
            });

            cleanupAndExit(0);
            return;
        }

        if (key === 'c' || key === 'C') {
            // CUSTOMIZE: enter the full wizard (the old G behaviour).
            await handleGenerate();
            // If we reach here, the user cascaded all the way back from the
            // first wizard row (or the wizard exited early because no files
            // were selected). handleGenerate() already detached the handler
            // at its start, so reattach once and redraw.
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', onKeypress);
            render();
            return;
        }

        if (key === 'p' || key === 'P') {
            // GENERATE + USER REQUEST: skip the entire wizard, only ask
            // for the USER REQUEST text (via the robust multi-line editor),
            // then generate with default values (AI instructions ON,
            // tagged output, no parsing, no ref-only).
            //
            // This used to be the R key. Now it is the P key.
            if (selectedFiles.size === 0) {
                render();
                return;
            }

            process.stdin.removeListener('data', onKeypress);

            // Open the robust multi-line editor. It manages raw mode
            // itself and restores the previous state on exit.
            const editResult = await openTextEditor('', 'USER REQUEST');

            if (editResult.type === 'cancel') {
                process.stdin.on('data', onKeypress);
                render();
                return;
            }

            const userDemand = editResult.value;

            if (!userDemand || userDemand.trim() === '') {
                console.log(`\n${YELLOW}Empty request - cancelling.${RESET}`);
                process.stdin.on('data', onKeypress);
                render();
                return;
            }

            console.log(`\n${GREEN}${BOLD}=== GENERATE WITH USER REQUEST ===${RESET}\n`);
            console.log(`Selected files:  ${selectedFiles.size}`);
            console.log(`AI instructions: yes`);
            console.log(`Output format:   Tagged replacements`);
            console.log(`Parsing:         skipped`);
            console.log(`Reference-only:  none
`);

            await generateStruct([...selectedFiles], 'struct', {
                includeInstructions: true,
                userDemand: userDemand.trim(),
                outputFormat: 'tagged',
                parsedFiles: new Map(),
                referenceOnlyFiles: new Set(),
            });

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
            const state = await loadState(saveName);

            if (!state.files || state.files.length === 0) {
                console.error('No files found in save file.');
                process.exit(1);
            }

            // Regenerate exactly like the interactive flow, but using
            // the LATEST file contents on disk.
            await regenerateFromState(state);
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
