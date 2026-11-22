#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { promisify } from 'util';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const access = promisify(fs.access);
const execPromise = promisify(exec);

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m'
};

// Get terminal size
const terminalWidth = process.stdout.columns || 80;
const terminalHeight = process.stdout.rows || 24;

// Directories to ignore for code analysis (but NOT for total size calculation)
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.cache', 'tmp', 'temp']);

// File extensions by language for LOC counting
const LANGUAGE_EXTENSIONS = {
  assembly: ['.asm', '.s', '.inc', '.nasm', '.masm', '.arm', '.lst'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  typescript: ['.ts', '.tsx'],
  python: ['.py', '.py3', '.pyc', '.pyo', '.pyd', '.pyw'],
  java: ['.java', '.class'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.h', '.hh', '.hxx', '.c++', '.h++'],
  c: ['.c', '.h'],
  csharp: ['.cs', '.csx'],
  go: ['.go'],
  ruby: ['.rb', '.rbw', '.gemspec'],
  php: ['.php', '.php3', '.php4', '.php5', '.phtml'],
  swift: ['.swift'],
  kotlin: ['.kt', '.kts', '.ktm'],
  rust: ['.rs', '.rlib'],
  html: ['.html', '.htm', '.xhtml', '.html5'],
  css: ['.css', '.scss', '.sass', '.less', '.styl'],
  markdown: ['.md', '.markdown', '.mdown', '.mdwn'],
  shell: ['.sh', '.bash', '.zsh', '.fish', '.ksh'],
  sql: ['.sql', '.mysql', '.pgsql'],
  yaml: ['.yml', '.yaml'],
  docker: ['Dockerfile', '.dockerignore'],
  git: ['.gitignore', '.gitattributes', '.gitmodules'],
  xml: ['.xml', '.xsd', '.xslt', '.xsl'],
  perl: ['.pl', '.pm', '.t', '.pod'],
  lua: ['.lua'],
  r: ['.r', '.rdata'],
  dart: ['.dart'],
  scala: ['.scala', '.sc'],
  groovy: ['.groovy', '.gvy', '.gy', '.gsh'],
  powershell: ['.ps1', '.psm1', '.psd1'],
  make: ['Makefile', '.mk', '.mak'],
  cmake: ['CMakeLists.txt', '.cmake'],
  zig : ['.zig']
};

// Archive file extensions
const ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.bz2', '.xz', '.zst', '.br',
  '.jar', '.war', '.ear', '.apk', '.ipa', '.deb', '.rpm', '.pkg', '.msi',
  '.json', '.jsonc', '.json5'
]);

// Binary file extensions
const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.out', '.elf', '.app',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff', '.psd',
  '.raw', '.cr2', '.nef', '.orf', '.sr2', '.eps', '.ai', '.cdr', '.wmf',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.pfb', '.pfm', '.afm',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.webm',
  '.m4a', '.m4v', '.wma', '.wmv', '.aac', '.ac3', '.ape', '.mid', '.midi',
  '.mpg', '.mpeg', '.m2v', '.mts', '.m2ts', '.flv', '.swf', '.vob',
  '.3gp', '.3g2', '.asf', '.rm', '.ra', '.ram', '.divx', '.xvid',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.odp', '.odg', '.odf', '.pub', '.rtf', '.wpd', '.wps', '.key', '.numbers',
  '.pages', '.ps', '.epub', '.mobi', '.azw', '.djvu',
  '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb', '.dbf', '.pdb', '.frm',
  '.myd', '.myi', '.ibd', '.fdb', '.gdb', '.kdb', '.kdbx',
  '.o', '.obj', '.lib', '.a', '.la', '.lo', '.mod', '.ko', '.prx',
  '.class', '.dex', '.odex'
]);

const CODE_EXTENSIONS_PRIORITY = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.py3', '.pyw',
  '.java', '.cs', '.csx',
  '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hh', '.hxx',
  '.go', '.rb', '.php', '.swift', '.kt', '.kts', '.rs',
  '.dart', '.scala', '.sc', '.groovy', '.lua', '.r',
  '.pl', '.pm', '.ps1', '.psm1', '.psd1',
  '.zig', '.asm', '.s', '.inc', '.nasm'
]);

// ===== EXTENSION HANDLING FUNCTIONS =====

function getFinalExtension(filePath) {
  const filename = path.basename(filePath);
  
  const specialFilenames = ['Dockerfile', 'Makefile', 'CMakeLists.txt'];
  if (specialFilenames.includes(filename)) {
    return filename;
  }
  
  if (filename.startsWith('.')) {
    const lastDotIndex = filename.lastIndexOf('.');
    if (lastDotIndex > 0) {
      return filename.substring(lastDotIndex).toLowerCase();
    }
    return filename.toLowerCase();
  }
  
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1) {
    return '';
  }
  
  return filename.substring(lastDotIndex).toLowerCase();
}

function filenameMatchesExtension(filename, extension) {
  const name = path.basename(filename);
  const nameLowerCase = name.toLowerCase();
  const extensionLowerCase = extension.toLowerCase();
  
  if (nameLowerCase === extensionLowerCase) {
    return true;
  }
  
  if (extensionLowerCase.startsWith('.')) {
    return nameLowerCase.endsWith(extensionLowerCase);
  }
  
  return nameLowerCase === extensionLowerCase;
}

function filenameMatchesAnyExtension(filename, extensions) {
  const extensionList = extensions instanceof Set ? [...extensions] : extensions;
  
  for (const extension of extensionList) {
    if (filenameMatchesExtension(filename, extension)) {
      return true;
    }
  }
  
  return false;
}

function detectFileLanguage(filename) {
  for (const [language, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (filenameMatchesAnyExtension(filename, extensions)) {
      return language;
    }
  }
  return null;
}

function isArchiveFile(filename) {
  return filenameMatchesAnyExtension(filename, ARCHIVE_EXTENSIONS);
}

function isCodeExtension(filename) {
  const extension = getFinalExtension(filename);
  return CODE_EXTENSIONS_PRIORITY.has(extension);
}

// ===== EMAIL NORMALIZATION AND DEDUPLICATION FUNCTIONS =====

/**
 * Generic/system emails to exclude from contributor counting
 */
const GENERIC_EMAILS = new Set([
  'root@localhost',
  'root@local',
  'root@localhost.localdomain',
  'root@server',
  'admin@localhost',
  'admin@local',
  'administrator@localhost',
  'user@localhost',
  'user@local',
  'test@localhost',
  'test@test.com',
  'test@example.com',
  'example@example.com',
  'noreply@example.com',
  'noreply@localhost',
  'noreply@noreply.com',
  'no-reply@example.com',
  'no-reply@localhost',
  'git@localhost',
  'git@local',
  'dev@localhost',
  'developer@localhost',
  'unknown@localhost',
  'unknown@unknown',
  'none@none.com',
  'null@null.com',
  'default@default.com',
  'user@example.com',
  'user@domain.com',
  'email@example.com',
  'mail@example.com',
  'contact@example.com',
  'info@example.com',
  'support@example.com'
]);

/**
 * Generic usernames to exclude
 */
const GENERIC_USERNAMES = new Set([
  'root', 'admin', 'administrator', 'user', 'test', 'guest', 'anonymous',
  'unknown', 'none', 'null', 'default', 'system', 'local', 'localhost',
  'dev', 'developer', 'git', 'svn', 'webmaster', 'postmaster', 'noreply',
  'no-reply', 'nobody', 'example', 'sample', 'demo'
]);

/**
 * Normalize email for unique contributor counting
 * Handles common typos and variations in email addresses
 */
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') {
    return '';
  }
  
  let normalized = email.trim().toLowerCase();
  
  // Remove common email variations
  normalized = normalized.replace(/\s+/g, '');
  
  // Handle Gmail specific normalization (dots don't matter in Gmail)
  const gmailMatch = normalized.match(/^([^@]+)@gmail\.com$/);
  if (gmailMatch) {
    // Remove all dots from Gmail username
    normalized = gmailMatch[1].replace(/\./g, '') + '@gmail.com';
  }
  
  // Handle common typos in domain names
  const domainTypos = {
    'gmial.com': 'gmail.com',
    'gmal.com': 'gmail.com',
    'gmail.co': 'gmail.com',
    'gmail.cm': 'gmail.com',
    'gmai.com': 'gmail.com',
    'hotmial.com': 'hotmail.com',
    'hotmal.com': 'hotmail.com',
    'hotmail.co': 'hotmail.com',
    'outlook.co': 'outlook.com',
    'outlok.com': 'outlook.com',
    'yahoo.co': 'yahoo.com',
    'yaho.com': 'yahoo.com',
    'protonmail.co': 'protonmail.com',
    'icloud.co': 'icloud.com',
    'iclod.com': 'icloud.com'
  };
  
  // Replace common domain typos
  const [username, domain] = normalized.split('@');
  if (username && domain && domainTypos[domain]) {
    normalized = `${username}@${domainTypos[domain]}`;
  }
  
  return normalized;
}

/**
 * Check if email should be excluded (generic/system emails)
 */
function isGenericEmail(email) {
  if (!email || typeof email !== 'string') {
    return true;
  }
  
  const normalized = normalizeEmail(email);
  
  // Check if it's in the generic emails set
  if (GENERIC_EMAILS.has(normalized)) {
    return true;
  }
  
  // Extract username and domain
  const [username, domain] = normalized.split('@');
  
  if (!username || !domain) {
    return true;
  }
  
  // Check if username is generic
  if (GENERIC_USERNAMES.has(username)) {
    return true;
  }
  
  // Check for generic username patterns
  if (username.length < 2 || /^\d+$/.test(username)) {
    return true;
  }
  
  // Check for generic local domains
  const genericDomains = new Set([
    'localhost', 'local', 'localhost.localdomain', 'localdomain',
    '127.0.0.1', '0.0.0.0', 'example.com', 'test.com', 'domain.com'
  ]);
  
  if (genericDomains.has(domain)) {
    return true;
  }
  
  return false;
}

/**
 * Calculate Levenshtein distance for fuzzy email matching
 */
function levenshteinDistance(str1, str2) {
  const track = Array(str2.length + 1).fill(null).map(() =>
    Array(str1.length + 1).fill(null));
  
  for (let i = 0; i <= str1.length; i += 1) {
    track[0][i] = i;
  }
  
  for (let j = 0; j <= str2.length; j += 1) {
    track[j][0] = j;
  }
  
  for (let j = 1; j <= str2.length; j += 1) {
    for (let i = 1; i <= str1.length; i += 1) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1,
        track[j - 1][i] + 1,
        track[j - 1][i - 1] + indicator
      );
    }
  }
  
  return track[str2.length][str1.length];
}

/**
 * Check if two emails are likely the same person
 * ROBUST: Uses stricter matching criteria to reduce false positives
 */
function areEmailsSimilar(email1, email2) {
  if (!email1 || !email2) return false;
  
  const normalized1 = normalizeEmail(email1);
  const normalized2 = normalizeEmail(email2);
  
  // Exact match after normalization
  if (normalized1 === normalized2) {
    return true;
  }
  
  // Split into username and domain
  const [username1, domain1] = normalized1.split('@');
  const [username2, domain2] = normalized2.split('@');
  
  if (!username1 || !username2 || !domain1 || !domain2) {
    return false;
  }
  
  // Same domain, similar username (likely typo)
  if (domain1 === domain2) {
    const distance = levenshteinDistance(username1, username2);
    const maxLength = Math.max(username1.length, username2.length);
    const similarityRatio = 1 - (distance / maxLength);
    
    // Only consider similar if:
    // 1. Distance is very small (1 character)
    // 2. Usernames are reasonably long (at least 4 characters)
    // 3. Similarity ratio is high (> 80%)
    if (username1.length >= 4 && username2.length >= 4) {
      if (distance === 1 && similarityRatio >= 0.85) {
        return true;
      }
    }
    
    // For very short usernames, require exact match
    if (distance <= 1 && Math.abs(username1.length - username2.length) <= 1 && username1.length >= 5) {
      return true;
    }
  }
  
  // Similar domain (likely typo in domain) - but only for long usernames
  if (username1 === username2 && username1.length >= 5) {
    const domainDistance = levenshteinDistance(domain1, domain2);
    if (domainDistance === 1) {
      return true;
    }
  }
  
  return false;
}

/**
 * Deduplicate contributors based on email similarity
 * ROBUST: Excludes generic emails and uses stricter matching
 */
function deduplicateContributors(contributors) {
  const uniqueContributors = [];
  const seenEmails = new Set();
  
  for (const contributor of contributors) {
    // Skip generic/system emails
    if (isGenericEmail(contributor.email)) {
      continue;
    }
    
    // Skip if we've already seen this exact email
    const normalizedEmail = normalizeEmail(contributor.email);
    if (seenEmails.has(normalizedEmail)) {
      continue;
    }
    
    let isDuplicate = false;
    
    // Check for similar emails in existing unique contributors
    for (const existing of uniqueContributors) {
      if (areEmailsSimilar(contributor.email, existing.email)) {
        // Merge contributor info, prefer the one with more complete info
        if (contributor.name && !existing.name) {
          existing.name = contributor.name;
        }
        isDuplicate = true;
        break;
      }
    }
    
    if (!isDuplicate) {
      uniqueContributors.push({ 
        name: contributor.name || 'Unknown', 
        email: normalizedEmail 
      });
      seenEmails.add(normalizedEmail);
    }
  }
  
  return uniqueContributors;
}

// Helper to format bytes to human readable
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function truncate(str, maxLength) {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

function horizontalLine(char = '─', color = colors.dim) {
  return color + char.repeat(terminalWidth - 1) + colors.reset;
}

function centerText(text, width = terminalWidth) {
  const padding = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(padding) + text;
}

// ===== GENERIC BINARY DETECTION =====

async function isBinaryContent(filePath, stats) {
  if (stats.size < 1024) return false;
  
  try {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
      
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) {
          return true;
        }
      }
      return false;
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

async function isBinaryFile(filePath, stats) {
  const filename = path.basename(filePath);
  
  if (isCodeExtension(filename)) {
    return false;
  }
  
  if (filenameMatchesAnyExtension(filename, BINARY_EXTENSIONS)) {
    return true;
  }
  
  const extension = getFinalExtension(filePath);
  if (extension === '') {
    try {
      await access(filePath, fs.constants.X_OK);
      return true;
    } catch {
      // Not executable
    }
  }
  
  if (stats.size > 1024) {
    return await isBinaryContent(filePath, stats);
  }
  
  return false;
}

async function getRealDirectorySize(dirPath) {
  try {
    if (process.platform !== 'win32') {
      try {
        const { stdout } = await execPromise(`find "${dirPath}" -type f -exec stat -f%z {} \\; 2>/dev/null | awk '{sum+=$1} END {print sum}'`, {
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          shell: true
        });
        
        const size = parseInt(stdout.trim(), 10);
        if (!isNaN(size) && size > 0) {
          return size;
        }
      } catch (findError) {
        try {
          const { stdout } = await execPromise(`find "${dirPath}" -type f -exec stat -c%s {} \\; 2>/dev/null | awk '{sum+=$1} END {print sum}'`, {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            shell: true
          });
          
          const size = parseInt(stdout.trim(), 10);
          if (!isNaN(size) && size > 0) {
            return size;
          }
        } catch (linuxError) {
          // Fall back to manual calculation
        }
      }
    }
    
    let totalSize = 0;
    
    async function calculateSize(currentPath) {
      try {
        const items = await readdir(currentPath);
        
        for (const item of items) {
          const fullPath = path.join(currentPath, item);
          try {
            const stats = await stat(fullPath);
            
            if (stats.isFile()) {
              totalSize += stats.size;
            } else if (stats.isDirectory()) {
              await calculateSize(fullPath);
            } else if (stats.isSymbolicLink()) {
              continue;
            }
          } catch (error) {
            continue;
          }
        }
      } catch (error) {
        return;
      }
    }
    
    await calculateSize(dirPath);
    return totalSize;
  } catch (error) {
    return 0;
  }
}

/**
 * Base Analyzer class
 */
class BaseAnalyzer {
  constructor() {
    this.name = 'Base Analyzer';
  }

  async processFile(filePath, stats) {
    // Override in child classes
  }

  getReport() {
    return {};
  }

  reset() {
    // Override in child classes
  }
}

/**
 * Analyzer for total directory size
 */
class TotalSizeAnalyzer extends BaseAnalyzer {
  constructor(ignoreDirs) {
    super();
    this.name = 'Total Size Analyzer';
    this.ignoreDirs = ignoreDirs;
    this.totalSize = 0;
    this.realTotalSize = 0;
    this.codeSize = 0;
    this.binarySize = 0;
    this.archiveSize = 0;
    this.gitSize = 0;
    this.ignoredDirsSize = 0;
    this.fileCount = 0;
    this.dirCount = 0;
    this.skippedDirs = [];
    this.skippedCount = 0;
  }

  async processFile(filePath, stats) {
    const relativePath = path.relative(process.cwd(), filePath);
    const pathParts = relativePath.split(path.sep);
    
    const hasGit = pathParts.includes('.git');
    if (hasGit) {
      this.gitSize += stats.size;
      return;
    }
    
    let shouldIgnoreForCode = false;
    for (const part of pathParts) {
      if (this.ignoreDirs.has(part)) {
        this.skippedDirs.push(part);
        this.skippedCount++;
        this.ignoredDirsSize += stats.size;
        shouldIgnoreForCode = true;
        break;
      }
    }
  
    this.totalSize += stats.size;
    
    if (shouldIgnoreForCode) {
      return;
    }
    
    if (stats.isFile()) {
      const filename = path.basename(filePath);
      
      if (isArchiveFile(filename)) {
        this.archiveSize += stats.size;
      }
      else if (await isBinaryFile(filePath, stats)) {
        this.binarySize += stats.size;
      }
      else {
        const language = detectFileLanguage(filename);
        if (language) {
          this.codeSize += stats.size;
        }
      }
      
      this.fileCount++;
    } else if (stats.isDirectory()) {
      this.dirCount++;
    }
  }

  async calculateRealSize(dirPath) {
    this.realTotalSize = await getRealDirectorySize(dirPath);
  }

  getReport() {
    const otherSize = this.totalSize - this.codeSize - this.binarySize - this.archiveSize;
    
    const codePurityRate = this.totalSize > 0 
      ? ((this.codeSize / this.totalSize) * 100).toFixed(2)
      : '0.00';
    
    const repositoryEfficiencyRate = this.realTotalSize > 0 
      ? ((this.totalSize / this.realTotalSize) * 100).toFixed(2)
      : '100.00';
    
    return {
      totalSize: this.totalSize,
      totalSizeFormatted: formatSize(this.totalSize),
      totalSizeMB: formatMB(this.totalSize),
      realTotalSize: this.realTotalSize,
      realTotalSizeFormatted: formatSize(this.realTotalSize),
      realTotalSizeMB: formatMB(this.realTotalSize),
      codeSize: this.codeSize,
      codeSizeFormatted: formatSize(this.codeSize),
      codeSizeMB: formatMB(this.codeSize),
      binarySize: this.binarySize,
      binarySizeFormatted: formatSize(this.binarySize),
      binarySizeMB: formatMB(this.binarySize),
      archiveSize: this.archiveSize,
      archiveSizeFormatted: formatSize(this.archiveSize),
      archiveSizeMB: formatMB(this.archiveSize),
      gitSize: this.gitSize,
      gitSizeFormatted: formatSize(this.gitSize),
      gitSizeMB: formatMB(this.gitSize),
      ignoredDirsSize: this.ignoredDirsSize,
      ignoredDirsSizeFormatted: formatSize(this.ignoredDirsSize),
      ignoredDirsSizeMB: formatMB(this.ignoredDirsSize),
      otherSize: otherSize,
      otherSizeFormatted: formatSize(otherSize),
      otherSizeMB: formatMB(otherSize),
      fileCount: this.fileCount,
      dirCount: this.dirCount,
      skippedDirs: [...new Set(this.skippedDirs)],
      skippedCount: this.skippedCount,
      codePurityRate: `${codePurityRate}%`,
      repositoryEfficiencyRate: `${repositoryEfficiencyRate}%`
    };
  }

  reset() {
    this.totalSize = 0;
    this.realTotalSize = 0;
    this.codeSize = 0;
    this.binarySize = 0;
    this.archiveSize = 0;
    this.gitSize = 0;
    this.ignoredDirsSize = 0;
    this.fileCount = 0;
    this.dirCount = 0;
    this.skippedDirs = [];
    this.skippedCount = 0;
  }
}

/**
 * Analyzer for package.json files
 */
class PackageJsonAnalyzer extends BaseAnalyzer {
  constructor() {
    super();
    this.name = 'Package.json Analyzer';
    this.packageJsonFiles = [];
    this.results = [];
    this.totalDeps = 0;
    this.totalDevDeps = 0;
    this.projectsWithDeps = 0;
  }

  async processFile(filePath, stats) {
    const relativePath = path.relative(process.cwd(), filePath);
    const pathParts = relativePath.split(path.sep);
    
    if (pathParts.includes('.git')) return;
    for (const part of pathParts) {
      if (IGNORE_DIRS.has(part)) return;
    }
    
    if (path.basename(filePath) === 'package.json') {
      this.packageJsonFiles.push(filePath);
      
      try {
        const content = await readFile(filePath, 'utf8');
        const packageJson = JSON.parse(content);
        
        const dependencies = packageJson.dependencies || {};
        const devDependencies = packageJson.devDependencies || {};
        
        const result = {
          path: filePath,
          name: packageJson.name || path.basename(path.dirname(filePath)),
          version: packageJson.version || 'N/A',
          dependencyCount: Object.keys(dependencies).length,
          devDependencyCount: Object.keys(devDependencies).length,
          dependencies: Object.keys(dependencies),
          hasProductionDeps: Object.keys(dependencies).length > 0
        };
        
        this.results.push(result);
        this.totalDeps += result.dependencyCount;
        this.totalDevDeps += result.devDependencyCount;
        if (result.hasProductionDeps) {
          this.projectsWithDeps++;
        }
      } catch (error) {
        this.results.push({
          path: filePath,
          error: `Failed to parse: ${error.message}`
        });
      }
    }
  }

  getReport() {
    const totalFiles = this.packageJsonFiles.length;
    const pureProjects = totalFiles - this.projectsWithDeps;
    const purityPercentage = totalFiles > 0 
      ? (pureProjects / totalFiles * 100).toFixed(2) 
      : '100.00';
    
    return {
      totalFiles,
      projectsWithDeps: this.projectsWithDeps,
      totalDeps: this.totalDeps,
      totalDevDeps: this.totalDevDeps,
      averageDeps: totalFiles > 0 ? (this.totalDeps / totalFiles).toFixed(2) : '0.00',
      pureProjects,
      purityPercentage,
      results: this.results
    };
  }

  reset() {
    this.packageJsonFiles = [];
    this.results = [];
    this.totalDeps = 0;
    this.totalDevDeps = 0;
    this.projectsWithDeps = 0;
  }
}

/**
 * Analyzer for counting lines of code by language
 */
class LocAnalyzer extends BaseAnalyzer {
  constructor() {
    super();
    this.name = 'Lines of Code Analyzer';
    this.linesByLanguage = {};
    this.filesByLanguage = {};
    this.totalLines = 0;
  }

  async processFile(filePath, stats) {
    const filename = path.basename(filePath);
    const relativePath = path.relative(process.cwd(), filePath);
    const pathParts = relativePath.split(path.sep);
    
    if (pathParts.includes('.git')) return;
    for (const part of pathParts) {
      if (IGNORE_DIRS.has(part)) return;
    }
    
    if (isArchiveFile(filename)) return;
    if (await isBinaryFile(filePath, stats)) return;
    
    const language = detectFileLanguage(filename);
    
    if (language) {
      try {
        const content = await readFile(filePath, 'utf8');
        const lines = content.split('\n').length;
        
        this.linesByLanguage[language] = (this.linesByLanguage[language] || 0) + lines;
        this.filesByLanguage[language] = (this.filesByLanguage[language] || 0) + 1;
        this.totalLines += lines;
      } catch (error) {
        // Skip files that can't be read
      }
    }
  }

  getReport() {
    const sortedLanguages = Object.entries(this.linesByLanguage)
      .sort(([, a], [, b]) => b - a)
      .map(([language, lines]) => ({
        language,
        lines,
        files: this.filesByLanguage[language],
        percentage: this.totalLines > 0 ? ((lines / this.totalLines) * 100).toFixed(2) : '0.00'
      }));

    return {
      totalLines: this.totalLines,
      totalLinesFormatted: this.totalLines.toLocaleString(),
      languages: sortedLanguages
    };
  }

  reset() {
    this.linesByLanguage = {};
    this.filesByLanguage = {};
    this.totalLines = 0;
  }
}

/**
 * Analyzer for counting approximate LLM tokens by language.
 * Uses the common 4-characters-per-token heuristic for source/text files.
 */
class TokenAnalyzer extends BaseAnalyzer {
  constructor() {
    super();
    this.name = 'Token Analyzer';
    this.tokensByLanguage = {};
    this.filesByLanguage = {};
    this.totalTokens = 0;
    this.totalCharacters = 0;
  }

  async processFile(filePath, stats) {
    const filename = path.basename(filePath);
    const relativePath = path.relative(process.cwd(), filePath);
    const pathParts = relativePath.split(path.sep);

    if (pathParts.includes('.git')) return;
    for (const part of pathParts) {
      if (IGNORE_DIRS.has(part)) return;
    }

    if (isArchiveFile(filename)) return;
    if (await isBinaryFile(filePath, stats)) return;

    const language = detectFileLanguage(filename);

    if (language) {
      try {
        const content = await readFile(filePath, 'utf8');
        const charCount = content.length;
        const tokenCount = Math.ceil(charCount / 4);

        this.tokensByLanguage[language] = (this.tokensByLanguage[language] || 0) + tokenCount;
        this.filesByLanguage[language] = (this.filesByLanguage[language] || 0) + 1;
        this.totalTokens += tokenCount;
        this.totalCharacters += charCount;
      } catch (error) {
        // Skip files that can't be read
      }
    }
  }

  getReport() {
    const sortedLanguages = Object.entries(this.tokensByLanguage)
      .sort(([, a], [, b]) => b - a)
      .map(([language, tokens]) => ({
        language,
        tokens,
        files: this.filesByLanguage[language],
        percentage: this.totalTokens > 0 ? ((tokens / this.totalTokens) * 100).toFixed(2) : '0.00'
      }));

    return {
      totalTokens: this.totalTokens,
      totalTokensFormatted: this.totalTokens.toLocaleString(),
      totalCharacters: this.totalCharacters,
      totalCharactersFormatted: this.totalCharacters.toLocaleString(),
      languages: sortedLanguages
    };
  }

  reset() {
    this.tokensByLanguage = {};
    this.filesByLanguage = {};
    this.totalTokens = 0;
    this.totalCharacters = 0;
  }
}

/**
 * Analyzer for archive files
 */
class ArchiveAnalyzer extends BaseAnalyzer {
  constructor() {
    super();
    this.name = 'Archive Files Analyzer';
    this.archives = [];
    this.totalSize = 0;
    this.totalCount = 0;
    this.byType = {};
  }

  async processFile(filePath, stats) {
    const filename = path.basename(filePath);
    const relativePath = path.relative(process.cwd(), filePath);
    const pathParts = relativePath.split(path.sep);
    
    if (pathParts.includes('.git')) return;
    for (const part of pathParts) {
      if (IGNORE_DIRS.has(part)) return;
    }
    
    if (isArchiveFile(filename)) {
      const extension = getFinalExtension(filename);
      this.archives.push({
        path: filePath,
        name: filename,
        size: stats.size,
        sizeFormatted: formatSize(stats.size),
        sizeMB: formatMB(stats.size),
        type: extension
      });
      this.totalSize += stats.size;
      this.totalCount++;
      this.byType[extension] = (this.byType[extension] || 0) + 1;
    }
  }

  getReport() {
    return {
      totalCount: this.totalCount,
      totalSize: this.totalSize,
      totalSizeFormatted: formatSize(this.totalSize),
      totalSizeMB: formatMB(this.totalSize),
      byType: this.byType,
      largest: this.archives.sort((a, b) => b.size - a.size).slice(0, 5)
    };
  }

  reset() {
    this.archives = [];
    this.totalSize = 0;
    this.totalCount = 0;
    this.byType = {};
  }
}

/**
 * Analyzer for binary files
 */
class BinaryAnalyzer extends BaseAnalyzer {
  constructor() {
    super();
    this.name = 'Binary Files Analyzer';
    this.binaries = [];
    this.totalSize = 0;
    this.totalCount = 0;
    this.byType = {};
  }

  async processFile(filePath, stats) {
    const filename = path.basename(filePath);
    const relativePath = path.relative(process.cwd(), filePath);
    const pathParts = relativePath.split(path.sep);
    
    if (pathParts.includes('.git')) {
      return;
    }
    
    for (const part of pathParts) {
      if (IGNORE_DIRS.has(part)) {
        return;
      }
    }
    
    if (isArchiveFile(filename)) {
      return;
    }
    
    if (await isBinaryFile(filePath, stats)) {
      const extension = getFinalExtension(filename) || '[no ext]';
      
      this.binaries.push({
        path: filePath,
        name: filename,
        size: stats.size,
        sizeFormatted: formatSize(stats.size),
        sizeMB: formatMB(stats.size),
        type: extension
      });
      this.totalSize += stats.size;
      this.totalCount++;
      this.byType[extension] = (this.byType[extension] || 0) + 1;
    }
  }

  getReport() {
    return {
      totalCount: this.totalCount,
      totalSize: this.totalSize,
      totalSizeFormatted: formatSize(this.totalSize),
      totalSizeMB: formatMB(this.totalSize),
      byType: this.byType,
      largest: this.binaries.sort((a, b) => b.size - a.size).slice(0, 10)
    };
  }

  reset() {
    this.binaries = [];
    this.totalSize = 0;
    this.totalCount = 0;
    this.byType = {};
  }
}

/**
 * Analyzer for Git repositories to get contributors and commits
 * IMPROVED: Now calculates average pure code added per commit
 */
class GitAnalyzer extends BaseAnalyzer {
  constructor() {
    super();
    this.name = 'Git Analyzer';
    this.repositories = [];
    this.gitDirs = new Set();
  }

  async findGitRepositories(dir) {
    const gitRepos = [];
    
    async function scan(currentPath) {
      try {
        const items = await readdir(currentPath);
        
        if (items.includes('.git')) {
          const gitPath = path.join(currentPath, '.git');
          const stats = await stat(gitPath);
          if (stats.isDirectory()) {
            gitRepos.push(currentPath);
            return;
          }
        }
        
        for (const item of items) {
          if (IGNORE_DIRS.has(item) && item !== '.git') {
            continue;
          }
          
          const fullPath = path.join(currentPath, item);
          const stats = await stat(fullPath);
          
          if (stats.isDirectory() && !fullPath.includes('.git')) {
            await scan(fullPath);
          }
        }
      } catch (error) {
        // Silently skip directories that can't be read
      }
    }
    
    await scan(dir);
    return gitRepos;
  }

  /**
   * Get the total pure code added (in bytes) across all commits
   * Pure code means only files with known code extensions and excludes binary/archive files
   */
  async getTotalPureCodeAdded(repoPath) {
    try {
      // Get list of all commits with their stats
      // Using --numstat gives us added/deleted lines per file
      const { stdout: numstatOutput } = await execPromise('git log --numstat --format="COMMIT:%H"', {
        cwd: repoPath,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
      });
      
      let totalPureCodeAddedBytes = 0;
      let commitHash = null;
      
      const lines = numstatOutput.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('COMMIT:')) {
          commitHash = line.substring(7);
          continue;
        }
        
        if (!line.trim() || !commitHash) continue;
        
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        
        const addedLines = parts[0];
        const deletedLines = parts[1];
        const filename = parts[2];
        
        // Skip binary files (shown as '-' in numstat)
        if (addedLines === '-' || deletedLines === '-') {
          continue;
        }
        
        // Only count pure code files (not binary, not archive)
        if (isArchiveFile(filename)) {
          continue;
        }
        
        // Check if it's a code file by extension
        const language = detectFileLanguage(filename);
        if (!language) {
          continue;
        }
        
        // Calculate bytes: use average bytes per line (rough estimate)
        // This is an approximation since we can't easily get exact byte counts
        // without checking out each commit
        const addedLineCount = parseInt(addedLines, 10) || 0;
        const deletedLineCount = parseInt(deletedLines, 10) || 0;
        
        // Net pure code added (positive means net addition)
        const netAddedLines = Math.max(0, addedLineCount - deletedLineCount);
        
        // Estimate bytes: average line is about 40-50 bytes including newline
        // Use 45 as a reasonable average for code files
        const estimatedBytes = netAddedLines * 45;
        
        totalPureCodeAddedBytes += estimatedBytes;
      }
      
      return totalPureCodeAddedBytes;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Alternative method: Get total pure code added using diff stats
   * This is more accurate as it uses actual byte counts
   */
  async getTotalPureCodeAddedAccurate(repoPath) {
    try {
      // Get all commits
      const { stdout: commitList } = await execPromise('git rev-list --all', {
        cwd: repoPath,
        encoding: 'utf8'
      });
      
      const commits = commitList.split('\n').filter(c => c.trim());
      
      if (commits.length === 0) {
        return 0;
      }
      
      let totalPureCodeAddedBytes = 0;
      
      // Process commits in batches for efficiency
      const batchSize = 100;
      for (let i = 0; i < commits.length; i += batchSize) {
        const batch = commits.slice(i, i + batchSize);
        
        for (const commit of batch) {
          try {
            // Get diff stats for this commit
            const { stdout: diffStats } = await execPromise(`git show --numstat --format="" ${commit}`, {
              cwd: repoPath,
              encoding: 'utf8',
              maxBuffer: 10 * 1024 * 1024
            });
            
            const lines = diffStats.split('\n');
            
            for (const line of lines) {
              if (!line.trim()) continue;
              
              const parts = line.split('\t');
              if (parts.length < 3) continue;
              
              const added = parts[0];
              const deleted = parts[1];
              const filename = parts[2];
              
              // Skip binary files
              if (added === '-' || deleted === '-') {
                continue;
              }
              
              // Only count pure code files
              if (isArchiveFile(filename)) {
                continue;
              }
              
              const language = detectFileLanguage(filename);
              if (!language) {
                continue;
              }
              
              // Try to get actual byte count for added lines
              try {
                const { stdout: diffContent } = await execPromise(`git show ${commit} -- "${filename}" | grep '^+' | grep -v '^+++' | wc -c`, {
                  cwd: repoPath,
                  encoding: 'utf8',
                  shell: true
                });
                
                const bytesAdded = parseInt(diffContent.trim(), 10) || 0;
                totalPureCodeAddedBytes += bytesAdded;
              } catch (innerError) {
                // Fall back to line count estimation
                const addedLineCount = parseInt(added, 10) || 0;
                totalPureCodeAddedBytes += addedLineCount * 45;
              }
            }
          } catch (commitError) {
            // Skip problematic commits
            continue;
          }
        }
      }
      
      return totalPureCodeAddedBytes;
    } catch (error) {
      return 0;
    }
  }

  async analyzeRepository(repoPath) {
    try {
      const { stdout: commitCountOutput } = await execPromise('git rev-list --all --count', {
        cwd: repoPath,
        encoding: 'utf8'
      });
      const totalCommits = parseInt(commitCountOutput.trim(), 10) || 0;
      
      const { stdout: contributorDetailsOutput } = await execPromise('git log --format="%an|%ae"', {
        cwd: repoPath,
        shell: true,
        encoding: 'utf8'
      });
      
      // Parse all contributors (including duplicates)
      const allContributors = contributorDetailsOutput
        .split('\n')
        .filter(line => line.trim() && line.includes('|'))
        .map(line => {
          const [name, email] = line.split('|');
          return { 
            name: name.trim(), 
            email: email.trim().toLowerCase() 
          };
        });
      
      // Deduplicate contributors, excluding generic emails
      const deduplicatedContributors = deduplicateContributors(allContributors);
      const uniqueContributors = deduplicatedContributors.length;
      
      // Calculate average pure code added per commit
      let totalPureCodeAdded = 0;
      let averagePureCodeAddedPerCommit = 0;
      let averagePureCodeAddedPerCommitFormatted = '0 B';
      
      if (totalCommits > 0) {
        // Use the efficient method first (single pass)
        totalPureCodeAdded = await this.getTotalPureCodeAdded(repoPath);
        
        // If the result seems too low (possible parsing issue), try accurate method
        if (totalPureCodeAdded === 0 && totalCommits > 10) {
          totalPureCodeAdded = await this.getTotalPureCodeAddedAccurate(repoPath);
        }
        
        averagePureCodeAddedPerCommit = totalCommits > 0 
          ? Math.round(totalPureCodeAdded / totalCommits) 
          : 0;
        
        averagePureCodeAddedPerCommitFormatted = formatSize(averagePureCodeAddedPerCommit);
      }
      
      return {
        path: repoPath,
        name: path.basename(repoPath),
        totalCommits,
        uniqueContributors,
        contributors: deduplicatedContributors,
        totalPureCodeAdded,
        totalPureCodeAddedFormatted: formatSize(totalPureCodeAdded),
        totalPureCodeAddedMB: formatMB(totalPureCodeAdded),
        averagePureCodeAddedPerCommit,
        averagePureCodeAddedPerCommitFormatted,
        averagePureCodeAddedPerCommitMB: formatMB(averagePureCodeAddedPerCommit),
        success: true
      };
    } catch (error) {
      return {
        path: repoPath,
        name: path.basename(repoPath),
        totalCommits: 0,
        uniqueContributors: 0,
        contributors: [],
        totalPureCodeAdded: 0,
        totalPureCodeAddedFormatted: '0 B',
        totalPureCodeAddedMB: '0.00',
        averagePureCodeAddedPerCommit: 0,
        averagePureCodeAddedPerCommitFormatted: '0 B',
        averagePureCodeAddedPerCommitMB: '0.00',
        success: false,
        error: error.message
      };
    }
  }

  async processFile(filePath, stats) {
    // This analyzer doesn't process individual files
  }

  async scanDirectory(dir) {
    const repositories = await this.findGitRepositories(dir);
    
    for (const repo of repositories) {
      const analysis = await this.analyzeRepository(repo);
      this.repositories.push(analysis);
    }
  }

  getReport() {
    const totalRepos = this.repositories.length;
    const successfulRepos = this.repositories.filter(r => r.success).length;
    const totalCommitsAcrossRepos = this.repositories.reduce((sum, repo) => sum + repo.totalCommits, 0);
    const totalUniqueContributorsAcrossRepos = this.repositories.reduce((sum, repo) => sum + repo.uniqueContributors, 0);
    const totalPureCodeAddedAcrossRepos = this.repositories.reduce((sum, repo) => sum + (repo.totalPureCodeAdded || 0), 0);
    const averagePureCodeAddedPerCommitAcrossRepos = totalCommitsAcrossRepos > 0
      ? Math.round(totalPureCodeAddedAcrossRepos / totalCommitsAcrossRepos)
      : 0;
    
    const repoWithMostContributors = this.repositories.length > 0
      ? this.repositories.reduce((max, repo) => repo.uniqueContributors > max.uniqueContributors ? repo : max, this.repositories[0])
      : null;
    
    const repoWithMostCommits = this.repositories.length > 0
      ? this.repositories.reduce((max, repo) => repo.totalCommits > max.totalCommits ? repo : max, this.repositories[0])
      : null;
    
    return {
      totalRepositories: totalRepos,
      successfulRepositories: successfulRepos,
      failedRepositories: totalRepos - successfulRepos,
      totalCommits: totalCommitsAcrossRepos,
      totalUniqueContributors: totalUniqueContributorsAcrossRepos,
      totalPureCodeAdded: totalPureCodeAddedAcrossRepos,
      totalPureCodeAddedFormatted: formatSize(totalPureCodeAddedAcrossRepos),
      totalPureCodeAddedMB: formatMB(totalPureCodeAddedAcrossRepos),
      averagePureCodeAddedPerCommit: averagePureCodeAddedPerCommitAcrossRepos,
      averagePureCodeAddedPerCommitFormatted: formatSize(averagePureCodeAddedPerCommitAcrossRepos),
      averagePureCodeAddedPerCommitMB: formatMB(averagePureCodeAddedPerCommitAcrossRepos),
      repositories: this.repositories,
      repoWithMostContributors: repoWithMostContributors,
      repoWithMostCommits: repoWithMostCommits
    };
  }

  reset() {
    this.repositories = [];
    this.gitDirs.clear();
  }
}

/**
 * Main class to orchestrate file traversal and analyzers
 */
class DirectoryAnalyzer {
  constructor() {
    this.analyzers = [];
  }

  registerAnalyzer(analyzer) {
    if (analyzer instanceof BaseAnalyzer) {
      this.analyzers.push(analyzer);
    } else {
      throw new Error('Analyzer must extend BaseAnalyzer');
    }
  }

  resetAll() {
    this.analyzers.forEach(analyzer => analyzer.reset());
  }

  async traverseDirectory(dir) {
    try {
      const items = await readdir(dir);
      
      for (const item of items) {
        const fullPath = path.join(dir, item);
        
        try {
          const stats = await stat(fullPath);
          
          for (const analyzer of this.analyzers) {
            await analyzer.processFile(fullPath, stats);
          }
          
          if (stats.isDirectory()) {
            await this.traverseDirectory(fullPath);
          }
        } catch (error) {
          // Silently skip files that can't be accessed
        }
      }
    } catch (error) {
      // Silently skip directories that can't be read
    }
  }

  getReport() {
    const reports = {};
    this.analyzers.forEach(analyzer => {
      reports[analyzer.name] = analyzer.getReport();
    });
    return reports;
  }
}

/**
 * Print functions for single directory mode
 */
function printHeader(title, color = colors.cyan) {
  console.log('\n' + color + colors.bright + '┌' + '─'.repeat(terminalWidth - 2) + '┐' + colors.reset);
  console.log(color + colors.bright + '│' + centerText(title, terminalWidth - 2) + '│' + colors.reset);
  console.log(color + colors.bright + '└' + '─'.repeat(terminalWidth - 2) + '┘' + colors.reset);
}

function printSubHeader(title, color = colors.cyan) {
  console.log('\n' + color + colors.bright + '┌─ ' + title + ' ' + '─'.repeat(Math.max(0, terminalWidth - title.length - 6)) + '┐' + colors.reset);
}

function printStat(label, value, color = colors.white, indent = 2) {
  const indentStr = ' '.repeat(indent);
  const line = `${indentStr}${colors.dim}${label}:${colors.reset} ${color}${value}${colors.reset}`;
  console.log(line);
}

function printProgressBar(value, max, width = Math.min(30, terminalWidth - 20), color = colors.green) {
  if (max === 0) return;
  const percentage = Math.min(100, Math.round((value / max) * 100));
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  const bar = color + '█'.repeat(filled) + colors.dim + '░'.repeat(empty) + colors.reset;
  console.log(`   ${bar} ${colors.bright}${percentage}%${colors.reset}`);
}

function printKeyValue(label, value, color = colors.white, width1 = 20, width2 = 15) {
  const truncatedLabel = truncate(label, width1);
  const truncatedValue = truncate(value.toString(), width2);
  console.log(`  ${colors.dim}${truncatedLabel.padEnd(width1)}:${colors.reset} ${color}${truncatedValue.padEnd(width2)}${colors.reset}`);
}

/**
 * Print Git analysis for single directory mode
 */
function printGitAnalysis(gitReport) {
  if (!gitReport || gitReport.totalRepositories === 0) {
    return;
  }
  
  printHeader('🔀 GIT REPOSITORY ANALYSIS', colors.magenta);
  
  printKeyValue('Git repositories', gitReport.totalRepositories, colors.bright, 25, 15);
  
  if (gitReport.successfulRepositories > 0) {
    printKeyValue('Total commits (all repos)', gitReport.totalCommits.toLocaleString(), colors.green, 25, 15);
    printKeyValue('Unique contributors (all repos)', gitReport.totalUniqueContributors.toLocaleString(), colors.cyan, 25, 15);
    printKeyValue('Total pure code added', gitReport.totalPureCodeAddedFormatted, colors.green, 25, 15);
    printKeyValue('Avg pure code/commit', gitReport.averagePureCodeAddedPerCommitFormatted, colors.yellow, 25, 15);
    
    if (gitReport.repoWithMostContributors && gitReport.repoWithMostContributors.uniqueContributors > 0) {
      console.log(`\n  ${colors.dim}Repository with most contributors:${colors.reset}`);
      console.log(`    ${colors.yellow}📦 ${truncate(gitReport.repoWithMostContributors.name, 50)}${colors.reset}`);
      console.log(`    ${colors.cyan}   👥 ${gitReport.repoWithMostContributors.uniqueContributors} unique contributors${colors.reset}`);
      console.log(`    ${colors.green}   📝 ${gitReport.repoWithMostContributors.totalCommits.toLocaleString()} total commits${colors.reset}`);
      console.log(`    ${colors.yellow}   📊 Avg pure code/commit: ${gitReport.repoWithMostContributors.averagePureCodeAddedPerCommitFormatted}${colors.reset}`);
    }
    
    if (gitReport.repoWithMostCommits && gitReport.repoWithMostCommits !== gitReport.repoWithMostContributors) {
      console.log(`\n  ${colors.dim}Repository with most commits:${colors.reset}`);
      console.log(`    ${colors.yellow}📦 ${truncate(gitReport.repoWithMostCommits.name, 50)}${colors.reset}`);
      console.log(`    ${colors.green}   📝 ${gitReport.repoWithMostCommits.totalCommits.toLocaleString()} total commits${colors.reset}`);
      console.log(`    ${colors.cyan}   👥 ${gitReport.repoWithMostCommits.uniqueContributors} unique contributors${colors.reset}`);
      console.log(`    ${colors.yellow}   📊 Avg pure code/commit: ${gitReport.repoWithMostCommits.averagePureCodeAddedPerCommitFormatted}${colors.reset}`);
    }
    
    if (gitReport.repositories.length > 0) {
      console.log(`\n  ${colors.dim}Repositories found:${colors.reset}`);
      gitReport.repositories.slice(0, 5).forEach((repo, idx) => {
        if (repo.success) {
          const statusIcon = repo.uniqueContributors > 0 ? '✓' : '○';
          console.log(`    ${colors.green}${statusIcon}${colors.reset} ${truncate(repo.name, 40)} - ${colors.cyan}${repo.uniqueContributors} contributors${colors.reset}, ${colors.green}${repo.totalCommits.toLocaleString()} commits${colors.reset}, ${colors.yellow}${repo.averagePureCodeAddedPerCommitFormatted}/commit${colors.reset}`);
        } else {
          console.log(`    ${colors.red}✗${colors.reset} ${truncate(repo.name, 40)} - ${colors.dim}Failed to analyze${colors.reset}`);
        }
      });
      
      if (gitReport.repositories.length > 5) {
        console.log(`    ${colors.dim}... and ${gitReport.repositories.length - 5} more repositories${colors.reset}`);
      }
    }
  } else {
    console.log(`  ${colors.yellow}⚠ No valid Git repositories could be analyzed${colors.reset}`);
    if (gitReport.failedRepositories > 0) {
      console.log(`  ${colors.dim}Failed repositories: ${gitReport.failedRepositories}${colors.reset}`);
    }
  }
}

/**
 * Print functions for multi-directory comparison mode
 */
function printComparisonHeader(directories) {
  console.log('\n' + colors.bgBlue + colors.white + colors.bright + '╔' + '═'.repeat(terminalWidth - 2) + '╗' + colors.reset);
  console.log(colors.bgBlue + colors.white + colors.bright + '║' + centerText('📊 DIRECTORY COMPARISON ANALYZER', terminalWidth - 2) + '║' + colors.reset);
  console.log(colors.bgBlue + colors.white + colors.bright + '╚' + '═'.repeat(terminalWidth - 2) + '╝' + colors.reset);
  
  console.log(`\n${colors.cyan}${colors.bright}Comparing:${colors.reset}`);
  directories.forEach((dir, i) => {
    const displayDir = truncate(dir, terminalWidth - 10);
    console.log(`  ${colors.bright}${i + 1}.${colors.reset} ${colors.yellow}${displayDir}${colors.reset}`);
  });
  console.log(`\n${colors.dim}Ignoring for code analysis: ${Array.from(IGNORE_DIRS).join(', ')}${colors.reset}`);
  console.log();
}

function createTable(directories, metrics, reportsByDir) {
  const dirCount = directories.length;
  const maxDirNameLength = Math.min(25, Math.floor(terminalWidth * 0.2));
  const valueWidth = Math.min(15, Math.floor((terminalWidth - maxDirNameLength - 10) / dirCount));
  
  let headerLine = ' '.repeat(maxDirNameLength);
  directories.forEach(dir => {
    const shortName = truncate(path.basename(dir), valueWidth);
    headerLine += `│ ${colors.bright}${shortName.padEnd(valueWidth)}${colors.reset} `;
  });
  
  console.log('\n' + colors.dim + '┌' + '─'.repeat(maxDirNameLength + 2) + '┬' + '─'.repeat((valueWidth + 4) * dirCount - 1) + '┐' + colors.reset);
  console.log(headerLine);
  console.log(colors.dim + '├' + '─'.repeat(maxDirNameLength + 2) + '┼' + '─'.repeat((valueWidth + 4) * dirCount - 1) + '┤' + colors.reset);
  
  metrics.forEach((metric, idx) => {
    const values = directories.map(dir => {
      const report = reportsByDir[dir];
      if (metric.getValue) {
        return metric.getValue(report);
      }
      return report[metric.key];
    });
    
    const numericValues = values.map(v => {
      if (typeof v === 'string' && v.includes(' ')) {
        const num = parseFloat(v.split(' ')[0]);
        return isNaN(num) ? 0 : num;
      }
      const num = parseFloat(v);
      return isNaN(num) ? 0 : num;
    });
    
    const winnerValue = metric.winner === 'largest' 
      ? Math.max(...numericValues) 
      : Math.min(...numericValues);
    
    let row = `  ${truncate(metric.label, maxDirNameLength - 2).padEnd(maxDirNameLength)}`;
    directories.forEach((dir, i) => {
      const value = values[i];
      const isWinner = numericValues[i] === winnerValue;
      const color = isWinner ? colors.green + colors.bright : colors.white;
      row += `│ ${color}${truncate(value.toString(), valueWidth).padEnd(valueWidth)}${colors.reset} `;
    });
    console.log(row);
    
    if (idx < metrics.length - 1) {
      console.log(colors.dim + '├' + '─'.repeat(maxDirNameLength + 2) + '┼' + '─'.repeat((valueWidth + 4) * dirCount - 1) + '┤' + colors.reset);
    }
  });
  
  console.log(colors.dim + '└' + '─'.repeat(maxDirNameLength + 2) + '┴' + '─'.repeat((valueWidth + 4) * dirCount - 1) + '┘' + colors.reset);
}

function printLanguagesComparison(directories, reportsByDir) {
  const dirCount = directories.length;
  const maxDirNameLength = Math.min(20, Math.floor(terminalWidth * 0.15));
  const langWidth = Math.min(15, Math.floor((terminalWidth - maxDirNameLength - 10) / dirCount));
  
  const allLanguages = new Set();
  directories.forEach(dir => {
    const languages = reportsByDir[dir]['Lines of Code Analyzer'].languages || [];
    languages.slice(0, 3).forEach(l => allLanguages.add(l.language));
  });
  
  const topLanguages = Array.from(allLanguages).slice(0, 5);
  
  if (topLanguages.length === 0) return;
  
  console.log('\n' + colors.cyan + colors.bright + '📊 TOP LANGUAGES' + colors.reset);
  console.log(colors.dim + '┌' + '─'.repeat(maxDirNameLength + 2) + '┬' + '─'.repeat((langWidth + 4) * dirCount - 1) + '┐' + colors.reset);
  
  let headerLine = ' '.repeat(maxDirNameLength);
  directories.forEach(dir => {
    const shortName = truncate(path.basename(dir), langWidth);
    headerLine += `│ ${colors.bright}${shortName.padEnd(langWidth)}${colors.reset} `;
  });
  console.log(headerLine);
  console.log(colors.dim + '├' + '─'.repeat(maxDirNameLength + 2) + '┼' + '─'.repeat((langWidth + 4) * dirCount - 1) + '┤' + colors.reset);
  
  topLanguages.forEach((language, idx) => {
    let row = `  ${truncate(language, maxDirNameLength - 2).padEnd(maxDirNameLength)}`;
    directories.forEach(dir => {
      const langData = (reportsByDir[dir]['Lines of Code Analyzer'].languages || [])
        .find(l => l.language === language);
      const value = langData ? langData.lines.toLocaleString() : '-';
      row += `│ ${colors.yellow}${truncate(value, langWidth).padEnd(langWidth)}${colors.reset} `;
    });
    console.log(row);
    
    if (idx < topLanguages.length - 1) {
      console.log(colors.dim + '├' + '─'.repeat(maxDirNameLength + 2) + '┼' + '─'.repeat((langWidth + 4) * dirCount - 1) + '┤' + colors.reset);
    }
  });
  
  console.log(colors.dim + '└' + '─'.repeat(maxDirNameLength + 2) + '┴' + '─'.repeat((langWidth + 4) * dirCount - 1) + '┘' + colors.reset);
}

/**
 * Print Git comparison for multi-directory mode
 */
function printGitComparison(directories, reportsByDir) {
  const hasGitRepos = directories.some(dir => {
    const gitReport = reportsByDir[dir]['Git Analyzer'];
    return gitReport && gitReport.totalRepositories > 0;
  });
  
  if (!hasGitRepos) return;
  
  console.log('\n' + colors.magenta + colors.bright + '🔀 GIT REPOSITORY COMPARISON' + colors.reset);
  
  const gitMetrics = [
    { 
      label: 'Git Repos', 
      key: 'totalRepositories', 
      winner: 'largest', 
      getValue: (r) => r['Git Analyzer'].totalRepositories 
    },
    { 
      label: 'Total Commits', 
      key: 'totalCommits', 
      winner: 'largest', 
      getValue: (r) => r['Git Analyzer'].totalCommits?.toLocaleString() || '0' 
    },
    { 
      label: 'Unique Contributors', 
      key: 'totalUniqueContributors', 
      winner: 'largest', 
      getValue: (r) => r['Git Analyzer'].totalUniqueContributors?.toLocaleString() || '0' 
    },
    { 
      label: 'Pure Code Added', 
      key: 'totalPureCodeAdded', 
      winner: 'largest', 
      getValue: (r) => r['Git Analyzer'].totalPureCodeAddedFormatted || '0 B' 
    },
    { 
      label: 'Avg Pure/Commit', 
      key: 'averagePureCodeAddedPerCommit', 
      winner: 'largest', 
      getValue: (r) => r['Git Analyzer'].averagePureCodeAddedPerCommitFormatted || '0 B' 
    }
  ];
  
  createTable(directories, gitMetrics, reportsByDir);
  
  console.log(`\n  ${colors.dim}Detailed repository information:${colors.reset}`);
  directories.forEach(dir => {
    const gitReport = reportsByDir[dir]['Git Analyzer'];
    if (gitReport && gitReport.totalRepositories > 0 && gitReport.repositories.length > 0) {
      const shortName = truncate(path.basename(dir), 40);
      console.log(`\n    ${colors.yellow}📁 ${shortName}${colors.reset}`);
      
      gitReport.repositories.slice(0, 3).forEach(repo => {
        if (repo.success) {
          console.log(`      ${colors.green}└─${colors.reset} ${truncate(repo.name, 35)} - ${colors.cyan}${repo.uniqueContributors} contributors${colors.reset}, ${colors.green}${repo.totalCommits.toLocaleString()} commits${colors.reset}, ${colors.yellow}${repo.averagePureCodeAddedPerCommitFormatted}/commit${colors.reset}`);
        } else {
          console.log(`      ${colors.red}└─${colors.reset} ${truncate(repo.name, 35)} - ${colors.dim}Failed to analyze${colors.reset}`);
        }
      });
      
      if (gitReport.repositories.length > 3) {
        console.log(`      ${colors.dim}   ... and ${gitReport.repositories.length - 3} more repositories${colors.reset}`);
      }
    }
  });
}

function printWinnerPodium(winners) {
  const sortedWinners = Object.entries(winners)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 3);
  
  if (sortedWinners.length === 0) return;
  
  console.log('\n' + colors.green + colors.bright + '🏆 WINNER PODIUM' + colors.reset);
  console.log(colors.dim + '┌' + '─'.repeat(terminalWidth - 2) + '┐' + colors.reset);
  
  sortedWinners.forEach(([dir, wins], i) => {
    const medal = i === 0 ? '🥇 GOLD' : i === 1 ? '🥈 SILVER' : '🥉 BRONZE';
    const displayDir = truncate(dir, terminalWidth - 30);
    const line = `│ ${colors.bright}${medal}${colors.reset}  ${colors.yellow}${displayDir.padEnd(terminalWidth - 25)}${colors.reset} ${colors.green}${wins} wins${colors.reset} │`;
    console.log(line);
  });
  
  console.log(colors.dim + '└' + '─'.repeat(terminalWidth - 2) + '┘' + colors.reset);
}

/**
 * Process a single directory
 */
async function processSingleDirectory(targetDir) {
  const absolutePath = path.resolve(targetDir);
  
  try {
    const stats = await stat(absolutePath);
    if (!stats.isDirectory()) {
      console.error(`${colors.red}Error: The provided path is not a directory${colors.reset}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`${colors.red}Error: Directory does not exist: ${absolutePath}${colors.reset}`);
    process.exit(1);
  }
  
  console.clear();
  console.log('\n' + colors.bgBlue + colors.white + colors.bright + '╔' + '═'.repeat(terminalWidth - 2) + '╗' + colors.reset);
  console.log(colors.bgBlue + colors.white + colors.bright + '║' + centerText('🔍 DIRECTORY ANALYZER', terminalWidth - 2) + '║' + colors.reset);
  console.log(colors.bgBlue + colors.white + colors.bright + '╚' + '═'.repeat(terminalWidth - 2) + '╝' + colors.reset);
  
  console.log(`\n${colors.cyan}${colors.bright}Scanning:${colors.reset} ${colors.white}${absolutePath}${colors.reset}`);
  console.log(`${colors.cyan}${colors.bright}Ignoring for code analysis:${colors.reset} ${colors.dim}${Array.from(IGNORE_DIRS).join(', ')}${colors.reset}`);
  
  const analyzer = new DirectoryAnalyzer();
  
  const sizeAnalyzer = new TotalSizeAnalyzer(IGNORE_DIRS);
  analyzer.registerAnalyzer(sizeAnalyzer);
  analyzer.registerAnalyzer(new PackageJsonAnalyzer());
  analyzer.registerAnalyzer(new LocAnalyzer());
  analyzer.registerAnalyzer(new TokenAnalyzer());
  analyzer.registerAnalyzer(new ArchiveAnalyzer());
  analyzer.registerAnalyzer(new BinaryAnalyzer());
  
  const gitAnalyzer = new GitAnalyzer();
  analyzer.registerAnalyzer(gitAnalyzer);
  
  console.log(`\n${colors.dim}Registered analyzers:${colors.reset}`);
  analyzer.analyzers.forEach(a => console.log(`  ${colors.green}✓${colors.reset} ${a.name}`));
  
  console.log(`\n${colors.yellow}Processing files...${colors.reset}`);
  console.log(`${colors.dim}Calculating real directory size (including .git and ignored dirs)...${colors.reset}`);
  
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;
  const spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${colors.cyan}${spinnerFrames[spinnerIndex]} Scanning...${colors.reset}`);
    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
  }, 100);
  
  analyzer.resetAll();
  await analyzer.traverseDirectory(absolutePath);
  
  await sizeAnalyzer.calculateRealSize(absolutePath);
  
  await gitAnalyzer.scanDirectory(absolutePath);
  
  clearInterval(spinnerInterval);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  
  const reports = analyzer.getReport();
  
  // Total Size Report
  printHeader('📊 DIRECTORY STATISTICS', colors.cyan);
  const sizeReport = reports['Total Size Analyzer'];
  
  const statsData = [
    { label: '📁 REAL Total Size (OS)', value: sizeReport.realTotalSizeFormatted, color: colors.bright + colors.green },
    { label: '📊 Analyzed Size', value: sizeReport.totalSizeFormatted, color: colors.green },
    { label: '├─ Pure Code', value: sizeReport.codeSizeFormatted, color: colors.green },
    { label: '├─ Binary Files', value: sizeReport.binarySizeFormatted, color: colors.blue },
    { label: '├─ Archive Files', value: sizeReport.archiveSizeFormatted, color: colors.yellow },
    { label: '├─ .git Directory', value: sizeReport.gitSizeFormatted, color: colors.magenta },
    { label: '├─ Ignored Dirs', value: sizeReport.ignoredDirsSizeFormatted, color: colors.dim },
    { label: '└─ Other', value: sizeReport.otherSizeFormatted, color: colors.dim },
    { label: '💎 Code Purity Rate', value: sizeReport.codePurityRate, color: colors.bright + colors.cyan },
    { label: '⚡ Repo Efficiency', value: sizeReport.repositoryEfficiencyRate, color: colors.bright + colors.green },
    { label: 'Files Scanned', value: sizeReport.fileCount.toLocaleString(), color: colors.cyan },
    { label: 'Directories', value: sizeReport.dirCount.toLocaleString(), color: colors.cyan }
  ];
  
  statsData.forEach(({label, value, color}) => {
    printKeyValue(label, value, color, 25, 20);
  });
  
  if (sizeReport.skippedDirs.length > 0) {
    console.log(`\n  ${colors.dim}Ignored for analysis: ${colors.yellow}${Array.from(new Set(sizeReport.skippedDirs)).slice(0, 3).join(', ')}${colors.reset}`);
    if (sizeReport.skippedCount > 3) {
      console.log(`  ${colors.dim}  and ${sizeReport.skippedCount - 3} more items${colors.reset}`);
    }
  }
  
  // Package.json Report
  printHeader('📦 PACKAGE.JSON ANALYSIS', colors.magenta);
  const pkgReport = reports['Package.json Analyzer'];
  
  if (pkgReport.totalFiles > 0) {
    const pkgData = [
      { label: 'package.json files', value: pkgReport.totalFiles, color: colors.bright },
      { label: 'Production deps', value: pkgReport.totalDeps, color: colors.yellow },
      { label: 'Dev dependencies', value: pkgReport.totalDevDeps, color: colors.cyan },
      { label: 'Average deps', value: pkgReport.averageDeps, color: colors.white },
      { label: 'Purity', value: `${pkgReport.purityPercentage}%`, color: pkgReport.purityPercentage > 80 ? colors.green : pkgReport.purityPercentage > 50 ? colors.yellow : colors.red }
    ];
    
    pkgData.forEach(({label, value, color}) => {
      printKeyValue(label, value, color, 20, 15);
    });
    
    console.log(`\n  ${colors.dim}Purity bar:${colors.reset}`);
    printProgressBar(pkgReport.pureProjects, pkgReport.totalFiles, 30, 
      pkgReport.purityPercentage > 80 ? colors.green : pkgReport.purityPercentage > 50 ? colors.yellow : colors.red);
    console.log(`   ${pkgReport.pureProjects} pure projects (no production deps)`);
  } else {
    console.log(`  ${colors.green}✓ No package.json files found - 100% Pure${colors.reset}`);
  }
  
  // Lines of Code Report
  printHeader('📝 LINES OF CODE', colors.green);
  const locReport = reports['Lines of Code Analyzer'];
  
  if (locReport.totalLines > 0) {
    printKeyValue('Total lines', locReport.totalLinesFormatted, colors.bright, 20, 15);
    
    const assemblyLang = locReport.languages.find(l => l.language === 'assembly');
    if (assemblyLang) {
      console.log(`\n  ${colors.yellow}🔧 Assembly detected: ${assemblyLang.lines.toLocaleString()} lines in ${assemblyLang.files} files${colors.reset}`);
    }
    
    console.log(`\n  ${colors.dim}Top languages:${colors.reset}`);
    locReport.languages.slice(0, 5).forEach(({language, lines, percentage}) => {
      const langColor = language === 'assembly' ? colors.yellow : 
                       percentage > 30 ? colors.green : 
                       percentage > 10 ? colors.yellow : colors.blue;
      console.log(`    ${langColor}${language.padEnd(12)}${colors.reset} ${lines.toLocaleString().padStart(8)} lines ${colors.dim}(${percentage}%)${colors.reset}`);
      printProgressBar(lines, locReport.totalLines, 25, langColor);
    });
    
    if (locReport.languages.length > 5) {
      console.log(`    ${colors.dim}... and ${locReport.languages.length - 5} more languages${colors.reset}`);
    }
  } else {
    console.log(`  ${colors.yellow}No code files found${colors.reset}`);
  }
  
  // Tokens Report
  printHeader('🪙 TOKENS (LLM estimate)', colors.blue);
  const tokenReport = reports['Token Analyzer'];
  
  if (tokenReport.totalTokens > 0) {
    printKeyValue('Total tokens', tokenReport.totalTokensFormatted, colors.bright, 20, 15);
    printKeyValue('Total characters', tokenReport.totalCharactersFormatted, colors.dim, 20, 15);
    
    console.log(`\n  ${colors.dim}Top languages by tokens:${colors.reset}`);
    tokenReport.languages.slice(0, 5).forEach(({language, tokens, percentage}) => {
      const langColor = percentage > 30 ? colors.green : 
                       percentage > 10 ? colors.yellow : colors.blue;
      console.log(`    ${langColor}${language.padEnd(12)}${colors.reset} ${tokens.toLocaleString().padStart(10)} tokens ${colors.dim}(${percentage}%)${colors.reset}`);
    });
    
    if (tokenReport.languages.length > 5) {
      console.log(`    ${colors.dim}... and ${tokenReport.languages.length - 5} more languages${colors.reset}`);
    }
  } else {
    console.log(`  ${colors.yellow}No tokens counted${colors.reset}`);
  }
  
  // Archive Files Report
  printHeader('📦 ARCHIVE FILES', colors.yellow);
  const archiveReport = reports['Archive Files Analyzer'];
  
  if (archiveReport.totalCount > 0) {
    printKeyValue('Archive files', archiveReport.totalCount, colors.bright, 20, 15);
    printKeyValue('Total size', archiveReport.totalSizeFormatted, colors.yellow, 20, 15);
    
    console.log(`\n  ${colors.dim}By type:${colors.reset}`);
    Object.entries(archiveReport.byType).slice(0, 4).forEach(([type, count]) => {
      console.log(`    ${colors.cyan}${type.padEnd(8)}${colors.reset}: ${count} files`);
    });
    
    if (archiveReport.largest.length > 0) {
      console.log(`\n  ${colors.dim}Largest:${colors.reset}`);
      archiveReport.largest.slice(0, 2).forEach(archive => {
        console.log(`    ${colors.red}▸${colors.reset} ${truncate(archive.name, 40)} ${colors.yellow}(${archive.sizeFormatted})${colors.reset}`);
      });
    }
  } else {
    console.log(`  ${colors.yellow}No archive files found${colors.reset}`);
  }
  
  // Binary Files Report
  printHeader('💾 BINARY FILES', colors.blue);
  const binaryReport = reports['Binary Files Analyzer'];
  
  if (binaryReport.totalCount > 0) {
    printKeyValue('Binary files', binaryReport.totalCount, colors.bright, 20, 15);
    printKeyValue('Total size', binaryReport.totalSizeFormatted, colors.blue, 20, 15);
    
    console.log(`\n  ${colors.dim}Largest:${colors.reset}`);
    binaryReport.largest.slice(0, 3).forEach(binary => {
      const execMarker = binary.type === '[no ext]' ? ' (executable)' : '';
      console.log(`    ${colors.blue}▸${colors.reset} ${truncate(binary.name, 40)}${colors.dim}${execMarker}${colors.reset} - ${colors.blue}${binary.sizeFormatted}${colors.reset}`);
    });
  } else {
    console.log(`  ${colors.yellow}No binary files found${colors.reset}`);
  }
  
  // Git Analysis Report
  const gitReport = reports['Git Analyzer'];
  if (gitReport && gitReport.totalRepositories > 0) {
    printGitAnalysis(gitReport);
  }
  
  // Summary
  printHeader('⚡ SUMMARY', colors.white + colors.bgBlue);
  
  const summaryItems = [
    { icon: '💾', label: 'REAL Total Size', value: sizeReport.realTotalSizeFormatted, color: colors.bright + colors.green },
    { icon: '📁', label: 'Analyzed Size', value: sizeReport.totalSizeFormatted, color: colors.green },
    { icon: '📝', label: 'Code', value: sizeReport.codeSizeFormatted, color: colors.green },
    { icon: '💾', label: 'Binary', value: `${binaryReport.totalCount} files (${sizeReport.binarySizeFormatted})`, color: colors.blue },
    { icon: '📦', label: 'Archive', value: `${archiveReport.totalCount} files (${sizeReport.archiveSizeFormatted})`, color: colors.yellow },
    { icon: '🔧', label: '.git', value: sizeReport.gitSizeFormatted, color: colors.magenta },
    { icon: '📊', label: 'Lines', value: locReport.totalLinesFormatted, color: colors.green },
    { icon: '🪙', label: 'Tokens', value: tokenReport.totalTokensFormatted, color: colors.blue },
    { icon: '📋', label: 'Files', value: sizeReport.fileCount.toLocaleString(), color: colors.cyan },
    { icon: '💎', label: 'Code Purity', value: sizeReport.codePurityRate, color: colors.bright + colors.cyan },
    { icon: '⚡', label: 'Repo Efficiency', value: sizeReport.repositoryEfficiencyRate, color: colors.bright + colors.green }
  ];
  
  if (gitReport && gitReport.totalRepositories > 0) {
    summaryItems.push(
      { icon: '🔀', label: 'Repos', value: gitReport.totalRepositories, color: colors.magenta },
      { icon: '👥', label: 'Contributors', value: gitReport.totalUniqueContributors.toLocaleString(), color: colors.cyan },
      { icon: '📝', label: 'Commits', value: gitReport.totalCommits.toLocaleString(), color: colors.green },
      { icon: '📊', label: 'Pure Code Added', value: gitReport.totalPureCodeAddedFormatted, color: colors.green },
      { icon: '⚡', label: 'Avg Pure/Commit', value: gitReport.averagePureCodeAddedPerCommitFormatted, color: colors.yellow }
    );
  }
  
  summaryItems.forEach(({icon, label, value, color}) => {
    console.log(`  ${icon} ${colors.bright}${label}:${colors.reset} ${color}${value}${colors.reset}`);
  });
  
  if (pkgReport.totalFiles > 0) {
    const purityEmoji = pkgReport.purityPercentage > 80 ? '🟢' : pkgReport.purityPercentage > 50 ? '🟡' : '🔴';
    console.log(`\n  ${purityEmoji} ${colors.dim}Purity:${colors.reset} ${pkgReport.pureProjects}/${pkgReport.totalFiles} projects without deps`);
  }
  
  console.log('\n' + colors.dim + '─'.repeat(terminalWidth - 1) + colors.reset);
  console.log(colors.green + '✓ Analysis complete!' + colors.reset);
}

/**
 * Process multiple directories in comparison mode
 */
async function processMultipleDirectories(directories) {
  const validDirs = [];
  for (const dir of directories) {
    const absolutePath = path.resolve(dir);
    try {
      const stats = await stat(absolutePath);
      if (!stats.isDirectory()) {
        console.error(`${colors.red}Warning: ${dir} is not a directory, skipping${colors.reset}`);
        continue;
      }
      validDirs.push(absolutePath);
    } catch (error) {
      console.error(`${colors.red}Warning: Directory does not exist: ${dir}, skipping${colors.reset}`);
    }
  }

  if (validDirs.length === 0) {
    console.error(`${colors.red}Error: No valid directories to analyze${colors.reset}`);
    process.exit(1);
  }

  if (validDirs.length === 1) {
    console.log(`${colors.yellow}Only one valid directory provided, switching to single mode${colors.reset}\n`);
    await processSingleDirectory(validDirs[0]);
    return;
  }

  console.clear();
  printComparisonHeader(validDirs);

  const reports = {};
  const sizeAnalyzers = {};
  const gitAnalyzers = {};

  let completedDirs = 0;
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  const spinnerInterval = setInterval(() => {
    const progress = Math.floor((completedDirs / validDirs.length) * 100);
    process.stdout.write(`\r${colors.cyan}${spinnerFrames[spinnerIndex]} Processing directories... ${progress}% (${completedDirs}/${validDirs.length})${colors.reset}`);
    spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
  }, 100);

  for (const dir of validDirs) {
    const analyzer = new DirectoryAnalyzer();
    
    const sizeAnalyzer = new TotalSizeAnalyzer(IGNORE_DIRS);
    analyzer.registerAnalyzer(sizeAnalyzer);
    analyzer.registerAnalyzer(new PackageJsonAnalyzer());
    analyzer.registerAnalyzer(new LocAnalyzer());
    analyzer.registerAnalyzer(new TokenAnalyzer());
    analyzer.registerAnalyzer(new ArchiveAnalyzer());
    analyzer.registerAnalyzer(new BinaryAnalyzer());
    
    const gitAnalyzer = new GitAnalyzer();
    analyzer.registerAnalyzer(gitAnalyzer);
    
    sizeAnalyzers[dir] = sizeAnalyzer;
    gitAnalyzers[dir] = gitAnalyzer;
    
    analyzer.resetAll();
    await analyzer.traverseDirectory(dir);
    
    await sizeAnalyzer.calculateRealSize(dir);
    await gitAnalyzer.scanDirectory(dir);
    
    reports[dir] = analyzer.getReport();
    completedDirs++;
  }

  clearInterval(spinnerInterval);
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  const flattenedReports = {};
  validDirs.forEach(dir => {
    const sizeReport = reports[dir]['Total Size Analyzer'];
    const pkgReport = reports[dir]['Package.json Analyzer'];
    const locReport = reports[dir]['Lines of Code Analyzer'];
    const tokenReport = reports[dir]['Token Analyzer'];
    const archiveReport = reports[dir]['Archive Files Analyzer'];
    const binaryReport = reports[dir]['Binary Files Analyzer'];
    const gitReport = reports[dir]['Git Analyzer'];
    
    flattenedReports[dir] = {
      ...sizeReport,
      'Package.json Analyzer': pkgReport,
      'Lines of Code Analyzer': locReport,
      'Token Analyzer': tokenReport,
      'Archive Files Analyzer': archiveReport,
      'Binary Files Analyzer': binaryReport,
      'Git Analyzer': gitReport
    };
  });

  // Directory Statistics Table
  console.log('\n' + colors.cyan + colors.bright + '📁 DIRECTORY STATISTICS' + colors.reset);
  const dirMetrics = [
    { label: '💾 REAL Total Size', key: 'realTotalSizeFormatted', winner: 'largest', getValue: (r) => r.realTotalSizeFormatted },
    { label: 'Total Size (analyzed)', key: 'totalSizeFormatted', winner: 'smallest', getValue: (r) => r.totalSizeFormatted },
    { label: 'Code Size', key: 'codeSizeFormatted', winner: 'largest', getValue: (r) => r.codeSizeFormatted },
    { label: 'Binary Size', key: 'binarySizeFormatted', winner: 'smallest', getValue: (r) => r.binarySizeFormatted },
    { label: 'Archive Size', key: 'archiveSizeFormatted', winner: 'smallest', getValue: (r) => r.archiveSizeFormatted },
    { label: '.git Size', key: 'gitSizeFormatted', winner: 'smallest', getValue: (r) => r.gitSizeFormatted },
    { label: '💎 Code Purity', key: 'codePurityRate', winner: 'largest', getValue: (r) => r.codePurityRate },
    { label: '⚡ Repo Efficiency', key: 'repositoryEfficiencyRate', winner: 'largest', getValue: (r) => r.repositoryEfficiencyRate },
    { label: 'Files', key: 'fileCount', winner: 'largest', getValue: (r) => r.fileCount.toLocaleString() },
    { label: 'Directories', key: 'dirCount', winner: 'largest', getValue: (r) => r.dirCount.toLocaleString() }
  ];
  createTable(validDirs, dirMetrics, flattenedReports);

  // Package.json Table
  const hasPackageJson = validDirs.some(dir => flattenedReports[dir]['Package.json Analyzer'].totalFiles > 0);
  if (hasPackageJson) {
    console.log('\n' + colors.magenta + colors.bright + '📦 PACKAGE.JSON ANALYSIS' + colors.reset);
    const pkgMetrics = [
      { label: 'package.json', key: 'totalFiles', winner: 'largest', getValue: (r) => r['Package.json Analyzer'].totalFiles },
      { label: 'Dependencies', key: 'totalDeps', winner: 'smallest', getValue: (r) => r['Package.json Analyzer'].totalDeps },
      { label: 'Purity %', key: 'purityPercentage', winner: 'largest', getValue: (r) => `${r['Package.json Analyzer'].purityPercentage}%` }
    ];
    createTable(validDirs, pkgMetrics, flattenedReports);
  }

  // Lines of Code Table
  const hasLoc = validDirs.some(dir => flattenedReports[dir]['Lines of Code Analyzer'].totalLines > 0);
  if (hasLoc) {
    console.log('\n' + colors.green + colors.bright + '📝 LINES OF CODE' + colors.reset);
    const locMetrics = [
      { label: 'Total Lines', key: 'totalLines', winner: 'largest', getValue: (r) => r['Lines of Code Analyzer'].totalLinesFormatted }
    ];
    createTable(validDirs, locMetrics, flattenedReports);
    printLanguagesComparison(validDirs, flattenedReports);
  }

  // Tokens Table
  const hasTokens = validDirs.some(dir => flattenedReports[dir]['Token Analyzer'].totalTokens > 0);
  if (hasTokens) {
    console.log('\n' + colors.blue + colors.bright + '🪙 TOKENS' + colors.reset);
    const tokenMetrics = [
      { label: 'Total Tokens', key: 'totalTokens', winner: 'largest', getValue: (r) => r['Token Analyzer'].totalTokensFormatted }
    ];
    createTable(validDirs, tokenMetrics, flattenedReports);
  }

  // Archive Files Table
  const hasArchives = validDirs.some(dir => flattenedReports[dir]['Archive Files Analyzer'].totalCount > 0);
  if (hasArchives) {
    console.log('\n' + colors.yellow + colors.bright + '📦 ARCHIVE FILES' + colors.reset);
    const archiveMetrics = [
      { label: 'Archive Files', key: 'totalCount', winner: 'smallest', getValue: (r) => r['Archive Files Analyzer'].totalCount },
      { label: 'Archive Size', key: 'totalSize', winner: 'smallest', getValue: (r) => r['Archive Files Analyzer'].totalSizeFormatted }
    ];
    createTable(validDirs, archiveMetrics, flattenedReports);
  }

  // Binary Files Table
  const hasBinaries = validDirs.some(dir => flattenedReports[dir]['Binary Files Analyzer'].totalCount > 0);
  if (hasBinaries) {
    console.log('\n' + colors.blue + colors.bright + '💾 BINARY FILES' + colors.reset);
    const binaryMetrics = [
      { label: 'Binary Files', key: 'totalCount', winner: 'smallest', getValue: (r) => r['Binary Files Analyzer'].totalCount },
      { label: 'Binary Size', key: 'totalSize', winner: 'smallest', getValue: (r) => r['Binary Files Analyzer'].totalSizeFormatted }
    ];
    createTable(validDirs, binaryMetrics, flattenedReports);
  }

  // Git Comparison Table
  printGitComparison(validDirs, flattenedReports);

  // Calculate winners
  const winners = {};
  validDirs.forEach(dir => winners[dir] = 0);

  const allMetrics = [...dirMetrics];
  if (hasPackageJson) allMetrics.push(...[
    { label: 'package.json', key: 'totalFiles', winner: 'largest' },
    { label: 'Dependencies', key: 'totalDeps', winner: 'smallest' },
    { label: 'Purity %', key: 'purityPercentage', winner: 'largest' }
  ]);
  if (hasLoc) allMetrics.push({ label: 'Total Lines', key: 'totalLines', winner: 'largest' });
  if (hasTokens) allMetrics.push({ label: 'Total Tokens', key: 'totalTokens', winner: 'largest' });
  if (hasArchives) allMetrics.push({ label: 'Archive Files', key: 'totalCount', winner: 'smallest' });
  if (hasBinaries) allMetrics.push({ label: 'Binary Files', key: 'totalCount', winner: 'smallest' });
  
  const hasGit = validDirs.some(dir => flattenedReports[dir]['Git Analyzer'].totalRepositories > 0);
  if (hasGit) {
    allMetrics.push(
      { label: 'Git Repos', key: 'totalRepositories', winner: 'largest' },
      { label: 'Total Commits', key: 'totalCommits', winner: 'largest' },
      { label: 'Unique Contributors', key: 'totalUniqueContributors', winner: 'largest' },
      { label: 'Pure Code Added', key: 'totalPureCodeAdded', winner: 'largest' },
      { label: 'Avg Pure/Commit', key: 'averagePureCodeAddedPerCommit', winner: 'largest' }
    );
  }

  allMetrics.forEach(metric => {
    const values = validDirs.map(dir => {
      if (metric.key.includes('Formatted') || metric.key === 'totalLinesFormatted') {
        const report = flattenedReports[dir];
        if (metric.key === 'realTotalSizeFormatted') return parseFloat(report.realTotalSizeMB);
        if (metric.key === 'totalSizeFormatted') return parseFloat(report.totalSizeMB);
        if (metric.key === 'codeSizeFormatted') return parseFloat(report.codeSizeMB);
        if (metric.key === 'binarySizeFormatted') return parseFloat(report.binarySizeMB);
        if (metric.key === 'archiveSizeFormatted') return parseFloat(report.archiveSizeMB);
        if (metric.key === 'gitSizeFormatted') return parseFloat(report.gitSizeMB);
        if (metric.key === 'totalLinesFormatted') return flattenedReports[dir]['Lines of Code Analyzer'].totalLines;
      }
      if (metric.key === 'totalTokens') {
        return flattenedReports[dir]['Token Analyzer'].totalTokens;
      }
      if (metric.key === 'totalFiles' || metric.key === 'totalDeps' || metric.key === 'purityPercentage') {
        return parseFloat(flattenedReports[dir]['Package.json Analyzer'][metric.key]) || 0;
      }
      if (metric.key === 'codePurityRate' || metric.key === 'repositoryEfficiencyRate') {
        return parseFloat(flattenedReports[dir][metric.key]) || 0;
      }
      if (metric.key === 'totalCount') {
        if (metric.label.includes('Archive')) {
          return flattenedReports[dir]['Archive Files Analyzer'].totalCount;
        }
        if (metric.label.includes('Binary')) {
          return flattenedReports[dir]['Binary Files Analyzer'].totalCount;
        }
      }
      if (metric.key === 'totalRepositories' || metric.key === 'totalCommits' || metric.key === 'totalUniqueContributors') {
        return flattenedReports[dir]['Git Analyzer'][metric.key] || 0;
      }
      if (metric.key === 'totalPureCodeAdded') {
        return flattenedReports[dir]['Git Analyzer'].totalPureCodeAdded || 0;
      }
      if (metric.key === 'averagePureCodeAddedPerCommit') {
        return flattenedReports[dir]['Git Analyzer'].averagePureCodeAddedPerCommit || 0;
      }
      return parseFloat(flattenedReports[dir][metric.key]) || 0;
    });

    const winnerValue = metric.winner === 'largest' ? Math.max(...values) : Math.min(...values);
    const winnerIndex = values.indexOf(winnerValue);
    if (winnerIndex !== -1) {
      winners[validDirs[winnerIndex]]++;
    }
  });

  printWinnerPodium(winners);

  console.log('\n' + colors.dim + '─'.repeat(terminalWidth - 1) + colors.reset);
  console.log(colors.green + '✓ Comparison complete!' + colors.reset);
  console.log(colors.dim + `Analyzed ${validDirs.length} directories` + colors.reset);
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error(`${colors.red}Error: Please provide at least one directory path${colors.reset}`);
    console.error(`${colors.yellow}Usage: node script.js <directory-path> [directory-path2 ...]${colors.reset}`);
    process.exit(1);
  }
  
  if (args.length === 1) {
    await processSingleDirectory(args[0]);
  } else {
    await processMultipleDirectories(args);
  }
}

/* ------------------------------------------------------------------------- */
/*  NEW: Programmatic API – export default function                           */
/* ------------------------------------------------------------------------- */

/**
 * Resolve and validate directories, returning absolute paths.
 */
async function resolveValidDirectories(directories) {
  const validDirs = [];
  for (const dir of directories) {
    const absolutePath = path.resolve(dir);
    try {
      const stats = await stat(absolutePath);
      if (stats.isDirectory()) {
        validDirs.push(absolutePath);
      }
    } catch (error) {
      // ignore invalid dirs
    }
  }
  return validDirs;
}

/**
 * Run all analyzers on a single directory and return the raw report.
 * This does NOT print anything to the console.
 */
async function analyzeSingleDirectoryData(dir) {
  const absolutePath = path.resolve(dir);
  
  // Validate existence
  try {
    const stats = await stat(absolutePath);
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${absolutePath}`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Directory does not exist: ${absolutePath}`);
    }
    throw error;
  }
  
  const analyzer = new DirectoryAnalyzer();
  
  const sizeAnalyzer = new TotalSizeAnalyzer(IGNORE_DIRS);
  analyzer.registerAnalyzer(sizeAnalyzer);
  analyzer.registerAnalyzer(new PackageJsonAnalyzer());
  analyzer.registerAnalyzer(new LocAnalyzer());
  analyzer.registerAnalyzer(new TokenAnalyzer());
  analyzer.registerAnalyzer(new ArchiveAnalyzer());
  analyzer.registerAnalyzer(new BinaryAnalyzer());
  
  const gitAnalyzer = new GitAnalyzer();
  analyzer.registerAnalyzer(gitAnalyzer);
  
  analyzer.resetAll();
  await analyzer.traverseDirectory(absolutePath);
  
  await sizeAnalyzer.calculateRealSize(absolutePath);
  await gitAnalyzer.scanDirectory(absolutePath);
  
  return analyzer.getReport();
}

/**
 * Run comparison analysis on multiple directories and return data
 * without printing anything.
 */
async function analyzeMultipleDirectoriesData(directories) {
  const validDirs = await resolveValidDirectories(directories);
  if (validDirs.length === 0) {
    throw new Error('No valid directories provided');
  }
  
  const reports = {};
  const flattenedReports = {};
  
  for (const dir of validDirs) {
    const analyzer = new DirectoryAnalyzer();
    
    const sizeAnalyzer = new TotalSizeAnalyzer(IGNORE_DIRS);
    analyzer.registerAnalyzer(sizeAnalyzer);
    analyzer.registerAnalyzer(new PackageJsonAnalyzer());
    analyzer.registerAnalyzer(new LocAnalyzer());
    analyzer.registerAnalyzer(new TokenAnalyzer());
    analyzer.registerAnalyzer(new ArchiveAnalyzer());
    analyzer.registerAnalyzer(new BinaryAnalyzer());
    
    const gitAnalyzer = new GitAnalyzer();
    analyzer.registerAnalyzer(gitAnalyzer);
    
    analyzer.resetAll();
    await analyzer.traverseDirectory(dir);
    
    await sizeAnalyzer.calculateRealSize(dir);
    await gitAnalyzer.scanDirectory(dir);
    
    const report = analyzer.getReport();
    reports[dir] = report;
    
    flattenedReports[dir] = {
      ...report['Total Size Analyzer'],
      'Package.json Analyzer': report['Package.json Analyzer'],
      'Lines of Code Analyzer': report['Lines of Code Analyzer'],
      'Token Analyzer': report['Token Analyzer'],
      'Archive Files Analyzer': report['Archive Files Analyzer'],
      'Binary Files Analyzer': report['Binary Files Analyzer'],
      'Git Analyzer': report['Git Analyzer']
    };
  }
  
  // Calculate winners (same logic as the CLI)
  const winners = {};
  validDirs.forEach(dir => winners[dir] = 0);
  
  const dirMetrics = [
    { label: '💾 REAL Total Size', key: 'realTotalSizeFormatted', winner: 'largest', getValue: (r) => r.realTotalSizeFormatted },
    { label: 'Total Size (analyzed)', key: 'totalSizeFormatted', winner: 'smallest', getValue: (r) => r.totalSizeFormatted },
    { label: 'Code Size', key: 'codeSizeFormatted', winner: 'largest', getValue: (r) => r.codeSizeFormatted },
    { label: 'Binary Size', key: 'binarySizeFormatted', winner: 'smallest', getValue: (r) => r.binarySizeFormatted },
    { label: 'Archive Size', key: 'archiveSizeFormatted', winner: 'smallest', getValue: (r) => r.archiveSizeFormatted },
    { label: '.git Size', key: 'gitSizeFormatted', winner: 'smallest', getValue: (r) => r.gitSizeFormatted },
    { label: '💎 Code Purity', key: 'codePurityRate', winner: 'largest', getValue: (r) => r.codePurityRate },
    { label: '⚡ Repo Efficiency', key: 'repositoryEfficiencyRate', winner: 'largest', getValue: (r) => r.repositoryEfficiencyRate },
    { label: 'Files', key: 'fileCount', winner: 'largest', getValue: (r) => r.fileCount.toLocaleString() },
    { label: 'Directories', key: 'dirCount', winner: 'largest', getValue: (r) => r.dirCount.toLocaleString() }
  ];
  
  const hasPackageJson = validDirs.some(dir => flattenedReports[dir]['Package.json Analyzer'].totalFiles > 0);
  const hasLoc = validDirs.some(dir => flattenedReports[dir]['Lines of Code Analyzer'].totalLines > 0);
  const hasTokens = validDirs.some(dir => flattenedReports[dir]['Token Analyzer'].totalTokens > 0);
  const hasArchives = validDirs.some(dir => flattenedReports[dir]['Archive Files Analyzer'].totalCount > 0);
  const hasBinaries = validDirs.some(dir => flattenedReports[dir]['Binary Files Analyzer'].totalCount > 0);
  const hasGit = validDirs.some(dir => flattenedReports[dir]['Git Analyzer'].totalRepositories > 0);
  
  const allMetrics = [...dirMetrics];
  if (hasPackageJson) {
    allMetrics.push(
      { label: 'package.json', key: 'totalFiles', winner: 'largest' },
      { label: 'Dependencies', key: 'totalDeps', winner: 'smallest' },
      { label: 'Purity %', key: 'purityPercentage', winner: 'largest' }
    );
  }
  if (hasLoc) allMetrics.push({ label: 'Total Lines', key: 'totalLines', winner: 'largest' });
  if (hasTokens) allMetrics.push({ label: 'Total Tokens', key: 'totalTokens', winner: 'largest' });
  if (hasArchives) allMetrics.push({ label: 'Archive Files', key: 'totalCount', winner: 'smallest' });
  if (hasBinaries) allMetrics.push({ label: 'Binary Files', key: 'totalCount', winner: 'smallest' });
  if (hasGit) {
    allMetrics.push(
      { label: 'Git Repos', key: 'totalRepositories', winner: 'largest' },
      { label: 'Total Commits', key: 'totalCommits', winner: 'largest' },
      { label: 'Unique Contributors', key: 'totalUniqueContributors', winner: 'largest' },
      { label: 'Pure Code Added', key: 'totalPureCodeAdded', winner: 'largest' },
      { label: 'Avg Pure/Commit', key: 'averagePureCodeAddedPerCommit', winner: 'largest' }
    );
  }
  
  allMetrics.forEach(metric => {
    const values = validDirs.map(dir => {
      const report = flattenedReports[dir];
      if (metric.key === 'realTotalSizeFormatted') return parseFloat(report.realTotalSizeMB);
      if (metric.key === 'totalSizeFormatted') return parseFloat(report.totalSizeMB);
      if (metric.key === 'codeSizeFormatted') return parseFloat(report.codeSizeMB);
      if (metric.key === 'binarySizeFormatted') return parseFloat(report.binarySizeMB);
      if (metric.key === 'archiveSizeFormatted') return parseFloat(report.archiveSizeMB);
      if (metric.key === 'gitSizeFormatted') return parseFloat(report.gitSizeMB);
      if (metric.key === 'codePurityRate' || metric.key === 'repositoryEfficiencyRate') {
        return parseFloat(report[metric.key]) || 0;
      }
      if (metric.key === 'fileCount' || metric.key === 'dirCount') return report[metric.key];
      if (metric.key === 'totalFiles' || metric.key === 'totalDeps' || metric.key === 'purityPercentage') {
        return parseFloat(report['Package.json Analyzer'][metric.key]) || 0;
      }
      if (metric.key === 'totalLines') return report['Lines of Code Analyzer'].totalLines;
      if (metric.key === 'totalTokens') return report['Token Analyzer'].totalTokens;
      if (metric.key === 'totalCount') {
        if (metric.label.includes('Archive')) return report['Archive Files Analyzer'].totalCount;
        if (metric.label.includes('Binary')) return report['Binary Files Analyzer'].totalCount;
      }
      if (metric.key === 'totalRepositories' || metric.key === 'totalCommits' || metric.key === 'totalUniqueContributors') {
        return report['Git Analyzer'][metric.key] || 0;
      }
      if (metric.key === 'totalPureCodeAdded') {
        return report['Git Analyzer'].totalPureCodeAdded || 0;
      }
      if (metric.key === 'averagePureCodeAddedPerCommit') {
        return report['Git Analyzer'].averagePureCodeAddedPerCommit || 0;
      }
      return parseFloat(report[metric.key]) || 0;
    });
    
    const winnerValue = metric.winner === 'largest' ? Math.max(...values) : Math.min(...values);
    const winnerIndex = values.indexOf(winnerValue);
    if (winnerIndex !== -1) {
      winners[validDirs[winnerIndex]]++;
    }
  });
  
  return {
    directories: validDirs,
    reports,
    flattenedReports,
    winners,
    hasPackageJson,
    hasLoc,
    hasTokens,
    hasArchives,
    hasBinaries,
    hasGit
  };
}

/**
 * Default export – programmatic interface.
 *
 * @param {string|string[]} paths - A single directory path or an array of paths.
 * @returns {Promise<Object>} Analysis result.
 */
export default async function analyzeDirectories(paths) {
  const inputDirs = Array.isArray(paths) ? paths : [paths];
  if (inputDirs.length === 0) {
    throw new Error('No directories provided');
  }
  
  const validDirs = await resolveValidDirectories(inputDirs);
  if (validDirs.length === 0) {
    throw new Error('No valid directories provided');
  }
  
  if (validDirs.length === 1) {
    const report = await analyzeSingleDirectoryData(validDirs[0]);
    return {
      mode: 'single',
      path: validDirs[0],
      report
    };
  }
  
  const comparison = await analyzeMultipleDirectoriesData(validDirs);
  return {
    mode: 'comparison',
    ...comparison
  };
}

/* ------------------------------------------------------------------------- */
/*  CLI execution guard                                                      */
/* ------------------------------------------------------------------------- */

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.on('unhandledRejection', (error) => {
    console.error(`${colors.red}Unhandled rejection: ${error}${colors.reset}`);
    process.exit(1);
  });

  main();
}
