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
        referenceOnlyFiles = new Set(),  // NEW: set of paths marked as reference-only
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

        // NEW: mention reference-only files in instructions
        if (referenceOnlyFiles.size > 0) {
            structContent += `${'*'.repeat(50)}\n`;
            structContent += `ℹ️  REFERENCE-ONLY FILES\n`;
            structContent += `${'*'.repeat(50)}\n\n`;
            structContent += `The following files are provided for CONTEXT ONLY.\n`;
            structContent += `DO NOT modify them, do not propose changes to them.\n`;
            structContent += `Use them only to understand the surrounding code.\n\n`;
            for (const refFile of referenceOnlyFiles) {
                structContent += `  REFERENCE ONLY: ${refFile}\n`;
            }
            structContent += `\n${'*'.repeat(50)}\n\n`;
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
            structContent += `CRITICAL RULE - STANDALONE REPLACEMENTS:\n`;
            structContent += `EVERY response with [CODEREPLACER] tags must be COMPLETE and STANDALONE.\n`;
            structContent += `Treat each response as if it will be applied to a FRESH copy of the original files.\n`;
            structContent += `You must include ALL replacements needed to fully implement the user's request - even if\n`;
            structContent += `you previously provided them in an earlier message. NEVER reference or rely on\n`;
            structContent += `previous responses. Imagine the user has just run 'git restore .' before applying your\n`;
            structContent += `tags. If a replacement depends on another replacement, INCLUDE BOTH in the same response.\n`;
            structContent += `A response containing only partial or incremental changes is INVALID and will fail.\n\n`;
        } else if (outputFormat === 'both') {
            structContent += `OUTPUT FORMAT: BOTH FULL FILES AND TAGGED REPLACEMENTS\n`;
            structContent += `You may provide either full file contents or tagged replacements, as appropriate.\n`;
            structContent += `For each file, decide which method is cleaner and use that.\n`;
            structContent += `Clearly separate the two approaches if mixed.\n`;
            structContent += `CRITICAL: Regardless of format, preserve the exact path in all outputs.\n\n`;
            structContent += `CRITICAL RULE - STANDALONE REPLACEMENTS:\n`;
            structContent += `EVERY response with [CODEREPLACER] tags must be COMPLETE and STANDALONE.\n`;
            structContent += `Treat each response as if it will be applied to a FRESH copy of the original files.\n`;
            structContent += `You must include ALL replacements needed to fully implement the user's request - even if\n`;
            structContent += `you previously provided them in an earlier message. NEVER reference or rely on\n`;
            structContent += `previous responses. Imagine the user has just run 'git restore .' before applying your\n`;
            structContent += `tags. If a replacement depends on another replacement, INCLUDE BOTH in the same response.\n`;
            structContent += `A response containing only partial or incremental changes is INVALID and will fail.\n\n`;
        }

        structContent += `${'='.repeat(50)}\n\n`;
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
        console.log(`${BOLD}Navigation:${RESET} ↑/↓ move, PgUp/PgDn page, Enter open/select, Space toggle, a current, A recursive, f find, g gen, b back, q quit`);
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
    //  Generate flow - extracted so both the main menu and the
    //  find-results view can trigger it with the G key.
    // ========================================================
    async function handleGenerate() {
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

        // STEP 1.5: Ask about reference-only files (NEW)
        console.log(`\n${YELLOW}${BOLD}=== REFERENCE-ONLY SELECTION ===${RESET}`);
        const refAnswer = await askQuestion(`Do you want to mark any of the selected files as reference/context only (not to be modified)? (y/n):`);
        if (refAnswer.toLowerCase() === 'y' || refAnswer.toLowerCase() === 'yes') {
            console.log(`\n${BOLD}Selected files:${RESET}`);
            const allSelected = [...selectedFiles];
            allSelected.forEach((file, idx) => {
                const alreadyRef = referenceOnlyFiles.has(file) ? ' (already marked)' : '';
                console.log(`  ${idx + 1}. ${path.basename(file)}${alreadyRef}`);
            });
            
            const refChoice = await askQuestion(`\nWhich files should be reference-only? (all | 1,3,5 | 2-4 | none):`);
            if (refChoice.toLowerCase() !== 'none' && refChoice.trim() !== '') {
                let filesToMark = [];
                
                if (refChoice.toLowerCase() === 'all') {
                    filesToMark = allSelected;
                } else {
                    const indexes = parseIndexes(refChoice, allSelected.length);
                    filesToMark = indexes.map(idx => allSelected[idx]);
                }
                
                for (const filePath of filesToMark) {
                    referenceOnlyFiles.add(filePath);
                }
                console.log(`\n${GREEN}Marked ${filesToMark.length} file(s) as reference-only.${RESET}`);
            }
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

        // STEP 3: Generate the struct file with options (including referenceOnlyFiles)
        await generateStruct([...selectedFiles], 'struct', {
            includeInstructions,
            userDemand,
            outputFormat,
            parsedFiles,
            referenceOnlyFiles,
        });

        // STEP 4: Ask if save paths
        const saveName = await askQuestion('\nSave selected file paths? Enter a filename (or leave empty to skip):');

        if (saveName) {
            await savePaths([...selectedFiles], saveName);
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
    //    G (or g)        -> proceed to generate (calls handleGenerate)
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
                `${GREEN}G${RESET} generate, ${YELLOW}B${RESET} back`
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

                // ---------- generate ----------
                if (key === 'g' || key === 'G') {
                    if (selectedFiles.size === 0) {
                        renderFind(visible);
                        return;
                    }

                    process.stdin.removeListener('data', onFindKeypress);

                    // handleGenerate() will exit the process when it completes.
                    await handleGenerate();

                    // Safety net - reached only if handleGenerate() returns
                    // early (e.g. user abort) without exiting.
                    process.stdin.on('data', onKeypress);
                    resolve();
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
            await handleGenerate();
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