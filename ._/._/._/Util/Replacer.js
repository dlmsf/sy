#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';

// ----------------------------------------------------------------------
// Utility: similarity between two strings (Jaccard on character bigrams)
// ----------------------------------------------------------------------
function similarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  if (s1 === s2) return 1;

  const bigrams = (str) => {
    const grams = new Set();
    for (let i = 0; i < str.length - 1; i++) {
      grams.add(str.slice(i, i + 2));
    }
    return grams;
  };

  const set1 = bigrams(s1);
  const set2 = bigrams(s2);
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
}

// ----------------------------------------------------------------------
// Extract fenced code blocks from the text
// ----------------------------------------------------------------------
function extractCodeBlocks(text) {
  const blocks = [];
  const regex = /```(\w*)\s*\n([\s\S]*?)```/g;
  let match;
  let lastIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    const language = match[1].trim().toLowerCase();
    const code = match[2].replace(/\n$/, '');
    const precedingText = text.slice(lastIndex, match.index);
    blocks.push({ language, code, precedingText });
    lastIndex = regex.lastIndex;
  }
  return blocks;
}

// ----------------------------------------------------------------------
// Recursively scan a directory for files, skipping common non‑source dirs
// ----------------------------------------------------------------------
async function scanFiles(dir, skipDirs = new Set(['node_modules', '.git'])) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        results.push(...(await scanFiles(fullPath, skipDirs)));
      }
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

// ----------------------------------------------------------------------
// Map language identifiers to common file extensions
// ----------------------------------------------------------------------
const langExtensions = {
  bash: ['.sh', '.bash'],
  sh: ['.sh', '.bash'],
  shell: ['.sh', '.bash'],
  javascript: ['.js', '.mjs', '.cjs'],
  js: ['.js', '.mjs', '.cjs'],
  node: ['.js', '.mjs', '.cjs'],
  assembly: ['.asm', '.s', '.S'],
  asm: ['.asm', '.s', '.S'],
  python: ['.py'],
  py: ['.py'],
  ruby: ['.rb'],
  go: ['.go'],
  rust: ['.rs'],
  c: ['.c', '.h'],
  'c++': ['.cpp', '.hpp', '.cc'],
  cpp: ['.cpp', '.hpp', '.cc'],
  java: ['.java'],
  // Add more as needed
};

// ----------------------------------------------------------------------
// Heuristically detect language from code content (when no fence language)
// ----------------------------------------------------------------------
function detectLanguageFromCode(code) {
  const firstLine = code.split('\n')[0].trim();

  // Shebang checks
  if (firstLine.startsWith('#!/bin/bash') || firstLine.startsWith('#!/usr/bin/env bash'))
    return 'bash';
  if (firstLine.startsWith('#!/usr/bin/env node') || firstLine.includes('node'))
    return 'javascript';
  if (firstLine.startsWith('#!/usr/bin/env python') || firstLine.startsWith('#!/usr/bin/python'))
    return 'python';

  // Assembly patterns
  if (/\b(\.globl|\.section|\.text|\.data|mov\s|eax|ebx|esp|ebp)\b/.test(code))
    return 'assembly';

  // JavaScript patterns
  if (/\b(function|const|let|var|=>|require\(|import\s|export\s|console\.log)\b/.test(code))
    return 'javascript';

  // Bash patterns
  if (/\b(echo|if\s*\[|fi|done|then|else|while|for\s+.*\s+in)\b/.test(code) &&
      !/\b(function|const|let|var)\b/.test(code))
    return 'bash';

  return ''; // unknown
}

// ----------------------------------------------------------------------
// Extract a filename from surrounding text or code comments
// ----------------------------------------------------------------------
function extractFilenameFromText(text) {
  if (!text) return null;

  // Explicit label: "file:", "filename:", "path:"
  const explicit = /(?:file|filename|path)\s*:\s*([^\s]+)/i.exec(text);
  if (explicit) return explicit[1];

  // Look for any word with a known extension, prefer the last occurrence
  const knownExtensions = new Set(Object.values(langExtensions).flat());
  const pathLike = /([^\s]+\.[a-zA-Z0-9]+)/g;
  const matches = text.match(pathLike);
  if (matches) {
    for (let i = matches.length - 1; i >= 0; i--) {
      const ext = path.extname(matches[i]).toLowerCase();
      if (knownExtensions.has(ext)) {
        return matches[i];
      }
    }
  }
  return null;
}

// ----------------------------------------------------------------------
// Tokenize code: extract identifiers and keywords (lowercased)
// ----------------------------------------------------------------------
function tokenize(code) {
  const tokens = new Set();
  // Match words (identifiers, keywords)
  const wordRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
  let m;
  while ((m = wordRegex.exec(code)) !== null) {
    tokens.add(m[0].toLowerCase());
  }
  // Also include numbers? Not necessary for most code similarity.
  return tokens;
}

// ----------------------------------------------------------------------
// Robust content similarity between two code strings
// Combines line-based, token-based, and character-based metrics
// ----------------------------------------------------------------------
function calculateContentSimilarity(codeA, codeB) {
  if (!codeA || !codeB) return 0;
  if (codeA === codeB) return 1;

  // Normalize line endings
  const a = codeA.replace(/\r\n/g, '\n');
  const b = codeB.replace(/\r\n/g, '\n');

  // --- Line-based metrics ---
  const linesA = a.split('\n').filter(line => line.trim() !== '');
  const linesB = b.split('\n').filter(line => line.trim() !== '');
  const setA = new Set(linesA);
  const setB = new Set(linesB);
  const intersection = [...setA].filter(line => setB.has(line));
  const union = new Set([...setA, ...setB]);

  const lineJaccard = union.size === 0 ? 0 : intersection.length / union.size;
  const lineContainmentA = linesA.length === 0 ? 0 : intersection.length / linesA.length;
  const lineContainmentB = linesB.length === 0 ? 0 : intersection.length / linesB.length;
  const lineContainment = Math.max(lineContainmentA, lineContainmentB); // how well one fits inside the other

  // --- Token-based Jaccard ---
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  const tokenIntersection = new Set([...tokensA].filter(t => tokensB.has(t)));
  const tokenUnion = new Set([...tokensA, ...tokensB]);
  const tokenSim = tokenUnion.size === 0 ? 0 : tokenIntersection.size / tokenUnion.size;

  // --- Character bigram similarity (existing) ---
  const charSim = similarity(a, b);

  // --- Weighted combination ---
  // Line metrics are most indicative for code (unchanged lines remain)
  // Token similarity catches identifier changes
  // Character similarity picks up small modifications
  const score = 
    lineJaccard * 0.4 +
    lineContainment * 0.3 +
    tokenSim * 0.2 +
    charSim * 0.1;

  return Math.min(1, score);
}

// ----------------------------------------------------------------------
// Find the best matching file for a code block using content similarity
// ----------------------------------------------------------------------
async function findMatchingFile(block, allFiles, fileContents) {
  let lang = block.language;
  if (!lang) {
    lang = detectLanguageFromCode(block.code);
  }

  const extensions = langExtensions[lang] || [];
  const extractedFilename =
    extractFilenameFromText(block.precedingText) || extractFilenameFromText(block.code);

  // Filter candidates by extension if possible
  let candidates = allFiles;
  if (extensions.length > 0) {
    const filtered = allFiles.filter(file =>
      extensions.includes(path.extname(file).toLowerCase())
    );
    if (filtered.length > 0) {
      candidates = filtered;
    }
  }

  if (candidates.length === 0) return null;

  let bestScore = -Infinity;
  let bestFile = null;
  let bestContentSim = 0;

  for (const file of candidates) {
    const fileContent = fileContents.get(file);
    let score = 0;

    // Extension bonus
    if (extensions.length > 0 && extensions.includes(path.extname(file).toLowerCase())) {
      score += 100;
    }

    // Filename similarity
    if (extractedFilename) {
      const fileNameSim = similarity(extractedFilename, path.basename(file));
      score += fileNameSim * 50;
    }

    // Shebang match (exact first line)
    let shebangBonus = 0;
    if (fileContent !== undefined) {
      const blockFirstLine = block.code.split('\n')[0].trim();
      const fileFirstLine = fileContent.split('\n')[0].trim();
      if (blockFirstLine.startsWith('#!') && blockFirstLine === fileFirstLine) {
        shebangBonus = 30;
      }
    }

    // Content similarity (core metric)
    let contentSim = 0;
    if (fileContent !== undefined && fileContent !== null) {
      contentSim = calculateContentSimilarity(block.code, fileContent);
    }
    score += contentSim * 200; // high weight
    score += shebangBonus;

    if (score > bestScore) {
      bestScore = score;
      bestFile = file;
      bestContentSim = contentSim;
    }
  }

  // Threshold: require at least minimal content similarity to avoid random matches
  // (content similarity alone can be low but still be correct if other signals are strong)
  if (bestContentSim < 0.2 && bestScore < 150) {
    return null;
  }

  return bestFile;
}

// ----------------------------------------------------------------------
// Simple CLI prompt
// ----------------------------------------------------------------------
async function askQuestion(query) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  let inputFile;
  let forceAll = false;

  // Check for --all flag
  const allFlagIndex = args.indexOf('--all');
  if (allFlagIndex !== -1) {
    forceAll = true;
    args.splice(allFlagIndex, 1);
  }

  if (args.length === 0) {
    // Look for default file(s): "result" or "result.txt"
    const defaults = ['result', 'result.txt'];
    let found = null;
    for (const def of defaults) {
      try {
        await fs.access(def);
        found = def;
        break;
      } catch {
        // not found, try next
      }
    }
    if (!found) {
      console.error('Usage: node replace-codes.mjs <input-file> [--all]');
      console.error('Or ensure a default file "result" or "result.txt" exists in the current directory.');
      process.exit(1);
    }
    inputFile = found;
    console.log(`No input file specified, using default file "${found}".`);
  } else {
    inputFile = args[0];
  }

  let text;
  try {
    text = await fs.readFile(inputFile, 'utf8');
  } catch (err) {
    console.error(`Error reading input file "${inputFile}":`, err.message);
    process.exit(1);
  }

  console.log('Extracting code blocks...');
  const blocks = extractCodeBlocks(text);
  if (blocks.length === 0) {
    console.log('No fenced code blocks found. Treating entire file as a single code block.');
    blocks.push({ language: '', code: text.replace(/\n$/, ''), precedingText: '' });
  }
  console.log(`Found ${blocks.length} code block(s).`);

  console.log('Scanning files in current directory (recursively)...');
  const cwd = process.cwd();
  const allFiles = await scanFiles(cwd);
  console.log(`Scanned ${allFiles.length} file(s).`);

  // Pre-load file contents into memory for fast similarity computation
  const fileContents = new Map();
  for (const file of allFiles) {
    try {
      const content = await fs.readFile(file, 'utf8');
      // Skip binary files (simple check)
      if (!content.includes('\0')) {
        fileContents.set(file, content);
      }
    } catch {
      // ignore unreadable files
    }
  }
  console.log(`Loaded contents for ${fileContents.size} file(s).`);

  console.log('Matching code blocks to files (content similarity)...');
  const matches = [];
  for (const block of blocks) {
    const file = await findMatchingFile(block, allFiles, fileContents);
    matches.push({ block, file });
    const lang = block.language || detectLanguageFromCode(block.code) || 'unknown';
    const rel = file ? path.relative(cwd, file) : 'NOT FOUND';
    console.log(`- [${lang}] -> ${rel}`);
  }

  // Show summary and prompt
  console.log('\nMatched files:');
  matches.forEach((m, i) => {
    const lang = m.block.language || detectLanguageFromCode(m.block.code) || 'unknown';
    const rel = m.file ? path.relative(cwd, m.file) : 'NOT FOUND';
    console.log(`${i + 1}. [${lang}] ${rel}`);
  });

  let selectedIndices = [];

  if (forceAll) {
    selectedIndices = matches.map((_, i) => i);
  } else {
    const answer = await askQuestion(
      '\nEnter numbers to replace (comma-separated), "all" to replace all, or "q" to quit: '
    );

    if (answer.toLowerCase() === 'q') {
      console.log('Exiting without changes.');
      process.exit(0);
    }

    if (answer.toLowerCase() === 'all') {
      selectedIndices = matches.map((_, i) => i);
    } else {
      selectedIndices = answer
        .split(',')
        .map((s) => parseInt(s.trim(), 10) - 1)
        .filter((i) => !isNaN(i) && i >= 0 && i < matches.length);
    }
  }

  for (const idx of selectedIndices) {
    const m = matches[idx];
    if (!m.file) {
      console.log(`Skipping block ${idx + 1} – no file found.`);
      continue;
    }

    let newContent = m.block.code;
    if (!newContent.endsWith('\n')) {
      newContent += '\n';
    }
    try {
      await fs.writeFile(m.file, newContent, 'utf8');
      console.log(`Replaced ${path.relative(cwd, m.file)}`);
    } catch (err) {
      console.error(`Failed to write ${path.relative(cwd, m.file)}:`, err.message);
    }
  }

  console.log('Done.');
}

// ----------------------------------------------------------------------
// Execute
// ----------------------------------------------------------------------
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
