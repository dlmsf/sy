#!/usr/bin/env node
/**
 * SingleInstall.js – Bundle a Node.js script into a self-installing .sh
 *
 * Usage:
 *   SingleInstall.js <file.js>        Generate <name>-install.sh for the file
 *   SingleInstall.js --list           Manage previously installed commands
 *   SingleInstall.js --help           Show help
 *
 * Features:
 *   - Detects ESM automatically:
 *       * .mjs extension
 *       * nearest package.json with "type":"module"
 *       * top-level import / export statements
 *     When ESM is detected the bundled file is written as .mjs and the
 *     wrapper runs `node <file>.mjs`.
 *   - Working-directory option:
 *       * "caller"  (default) – wrapper runs with the cwd of the caller
 *       * "install"           – wrapper cd's into the install dir first
 *   - The wrapper forwards "$@" unchanged, so args work.
 *   - Reinstall is idempotent (it overwrites).
 *   - Only tracked files (registry dir + wrapper + js) are ever removed.
 *
 * The generated installer .sh will:
 *   1. Ensure Node.js is installed (apt / apt-get / apk / dnf / yum / pacman)
 *   2. Write the JS payload to  /usr/local/etc/singleinstall/<name>/<name>.{js|mjs}
 *   3. Create a global wrapper  /usr/local/bin/<name>
 *   4. Register itself under    /usr/local/etc/singleinstall/apps/<name>.info
 *   5. Support --uninstall to clean everything up
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execSync } from 'node:child_process';

const writeFile = promisify(fs.writeFile);
const readFile  = promisify(fs.readFile);
const access    = promisify(fs.access);
const readdir   = promisify(fs.readdir);

// ---------------------------------------------------------------------------
// Paths / constants
// ---------------------------------------------------------------------------
const REGISTRY_ROOT   = '/usr/local/etc/singleinstall';
const REGISTRY_APPS   = path.join(REGISTRY_ROOT, 'apps');
const DEFAULT_BIN_DIR = '/usr/local/bin';

const rl  = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
async function fileExists(p) {
  try { await access(p, fs.constants.F_OK); return true; } catch { return false; }
}

function sanitizeName(name) {
  return String(name)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '') || 'app';
}

function sanitizeCommand(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';
}

/**
 * Pick a heredoc delimiter that is guaranteed not to appear as a line
 * inside the payload content.
 */
function pickDelimiter(content) {
  const base = '__SINGLEINSTALL_JS_PAYLOAD_EOF__';
  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasLine = (text, delim) =>
    new RegExp('(^|\\n)' + reEscape(delim) + '(\\n|$)').test(text);
  let d = base;
  let i = 0;
  while (hasLine(content, d)) {
    i += 1;
    d = `${base}_${i}`;
    if (i > 1000) break;
  }
  return d;
}

// ---------------------------------------------------------------------------
// ESM detection
// ---------------------------------------------------------------------------
function findNearestPackageJson(startDir) {
  let dir = path.resolve(startDir);
  // walk up until filesystem root
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function packageJsonIsModule(pkgPath) {
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    return pkg && pkg.type === 'module';
  } catch {
    return false;
  }
}

/**
 * Very small heuristic check for top-level ESM syntax.
 * We only look at real import/export statements at the start of a line
 * (after optional whitespace), so strings and comments are unlikely to
 * cause false positives in practice.
 */
function hasEsmSyntax(src) {
  return /^\s*(import\s|import\s*\{|import\s+[\w*{[]|export\s|export\s*\{|export\s+default\b|export\s+\*)/m.test(src);
}

/**
 * Returns true when the given source file should be bundled as ESM.
 */
function isEsmSource(srcPath, srcContent) {
  const ext = path.extname(srcPath).toLowerCase();
  if (ext === '.mjs') return true;
  if (ext === '.cjs') return false;

  const pkg = findNearestPackageJson(path.dirname(srcPath));
  if (pkg && packageJsonIsModule(pkg)) return true;

  if (hasEsmSyntax(srcContent)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Registry (info files written by generated .sh installers)
// ---------------------------------------------------------------------------
async function readRegistryEntries() {
  try { await access(REGISTRY_APPS, fs.constants.R_OK); } catch { return []; }
  let files;
  try { files = await readdir(REGISTRY_APPS); } catch { return []; }
  const entries = [];
  for (const f of files) {
    if (!f.endsWith('.info')) continue;
    try {
      const content = await readFile(path.join(REGISTRY_APPS, f), 'utf8');
      const entry = {};
      for (const line of content.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) entry[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      if (entry.NAME) entries.push(entry);
    } catch { /* skip unreadable */ }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// .sh generation
// ---------------------------------------------------------------------------
function generateInstallerSh(cfg) {
  const {
    appName, commandName, sourceFileName, sourceContent,
    installDir, jsFile, binPath, infoFile, binDir,
    runMode, // 'caller' | 'install'
  } = cfg;

  const delim = pickDelimiter(sourceContent);

  // Build the wrapper body (embedded inside the generated installer).
  // When runMode is 'install', we cd into the install dir first.
  const wrapperCd = runMode === 'install'
    ? `cd "${installDir}" || exit 1\n`
    : '';

  return `#!/bin/sh
# =============================================================================
# ${appName} installer  (generated by SingleInstall.js)
# Command   : ${commandName}
# JS file   : ${jsFile}
# Installed : ${installDir}
# Run mode  : ${runMode} (cwd = ${runMode === 'install' ? 'install dir' : 'caller dir'})
# =============================================================================

APP_NAME="${appName}"
COMMAND_NAME="${commandName}"
INSTALL_DIR="${installDir}"
JS_FILE="${jsFile}"
BIN_DIR="${binDir}"
BIN_PATH="${binPath}"
INFO_FILE="${infoFile}"
RUN_MODE="${runMode}"

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
fi

have_cmd() { command -v "$1" >/dev/null 2>&1; }

show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Install '${appName}' as the global command '${commandName}'."
    echo ""
    echo "Options:"
    echo "  -h, --help        Show this help"
    echo "  -u, --uninstall   Remove '${commandName}' from the system"
    echo ""
}

case "$1" in
    -h|--help)
        show_help
        exit 0
        ;;
    -u|--uninstall)
        echo "Uninstalling '${commandName}'..."
        [ -n "$BIN_PATH" ]    && $SUDO rm -f "$BIN_PATH"
        [ -n "$INSTALL_DIR" ] && $SUDO rm -rf "$INSTALL_DIR"
        [ -n "$INFO_FILE" ]   && $SUDO rm -f "$INFO_FILE"
        echo "Removed command '${commandName}'."
        exit 0
        ;;
esac

echo "Installing '${appName}' as command '${commandName}'..."

# ---------------------------------------------------------------------------
# 1. Ensure Node.js is available
# ---------------------------------------------------------------------------
if ! have_cmd node; then
    echo "Node.js not found - attempting installation..."
    if   have_cmd apt-get; then $SUDO apt-get update -qq && $SUDO apt-get install -y nodejs npm
    elif have_cmd apt;     then $SUDO apt update -qq     && $SUDO apt install -y nodejs npm
    elif have_cmd apk;     then $SUDO apk add --no-cache nodejs npm
    elif have_cmd dnf;     then $SUDO dnf install -y nodejs
    elif have_cmd yum;     then $SUDO yum install -y nodejs
    elif have_cmd pacman;  then $SUDO pacman -S --noconfirm nodejs npm
    else
        echo "No supported package manager found; please install Node.js manually." >&2
        exit 1
    fi
    if ! have_cmd node; then
        echo "Failed to install Node.js." >&2
        exit 1
    fi
    echo "Node.js installed: $(node --version 2>/dev/null || echo unknown)"
else
    echo "Node.js found at $(command -v node) ($(node --version 2>/dev/null || echo unknown))"
fi

# ---------------------------------------------------------------------------
# 2. Create the install directory
# ---------------------------------------------------------------------------
echo "Creating $INSTALL_DIR"
$SUDO mkdir -p "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# 3. Write the embedded JS payload
# ---------------------------------------------------------------------------
echo "Writing $JS_FILE"
$SUDO tee "$JS_FILE" > /dev/null << '${delim}'
${sourceContent}
${delim}
$SUDO chmod 644 "$JS_FILE"

# ---------------------------------------------------------------------------
# 4. Create the global command wrapper
# ---------------------------------------------------------------------------
echo "Creating command $BIN_PATH"
$SUDO mkdir -p "$BIN_DIR"
tmp_wrapper="$(mktemp)"
{
    echo '#!/bin/sh'
    ${wrapperCd ? `printf '%s\\n' '${wrapperCd.trim()}'` : ': # no cd (caller dir)'}
    printf 'exec node "%s" "$@"\\n' "$JS_FILE"
} > "$tmp_wrapper"
$SUDO mv "$tmp_wrapper" "$BIN_PATH"
$SUDO chmod 755 "$BIN_PATH"

# ---------------------------------------------------------------------------
# 5. Register in the apps registry
# ---------------------------------------------------------------------------
$SUDO mkdir -p "$(dirname "$INFO_FILE")"
$SUDO tee "$INFO_FILE" > /dev/null << INFOEOF
NAME=${appName}
COMMAND=${commandName}
SOURCE_FILE=${sourceFileName}
INSTALL_DIR=${installDir}
JS_FILE=${jsFile}
BIN_DIR=${binDir}
BIN_PATH=${binPath}
RUN_MODE=${runMode}
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
INFOEOF
$SUDO chmod 644 "$INFO_FILE"

echo ""
echo "Installed successfully."
echo "  JS file : $JS_FILE"
echo "  Command : $BIN_PATH"
echo "  Run mode: $RUN_MODE"
echo ""
echo "Try it: ${commandName} --help"
echo "Remove: $0 --uninstall"
`;
}

// ---------------------------------------------------------------------------
// Create installer (single-input use case)
// ---------------------------------------------------------------------------
async function createInstaller(opts) {
  const file = opts.file;

  if (!file) {
    console.error('Error: no input file specified.');
    console.error('Usage: SingleInstall.js <file.js>');
    process.exit(1);
  }
  if (!(await fileExists(file))) {
    console.error(`Error: file not found: ${file}`);
    process.exit(1);
  }

  const absSource  = path.resolve(file);
  const rawSource  = await readFile(absSource, 'utf8');
  const parsed     = path.parse(absSource);
  const safeBase   = sanitizeName(parsed.name);
  const defaultCmd = sanitizeCommand(parsed.name);

  // -- ESM detection ------------------------------------------------------
  const esm = isEsmSource(absSource, rawSource);
  const jsExt = esm ? 'mjs' : 'js';

  // Strip any shebang from the source; we prepend our own below.
  const body = rawSource.replace(/^#!.*\n/, '');
  const jsPayload = `#!/usr/bin/env node\n${body}`;

  // -- Defaults -----------------------------------------------------------
  let commandName = opts.command || defaultCmd;
  let installDir  = opts.installDir || path.join(REGISTRY_ROOT, safeBase);
  let binDir      = opts.binDir || DEFAULT_BIN_DIR;
  let runMode     = opts.runMode || 'caller'; // 'caller' | 'install'

  // -- Interactive prompts ------------------------------------------------
  if (!opts.yes) {
    console.log('');
    console.log(`Source file : ${absSource}`);
    console.log(`App name    : ${safeBase}`);
    console.log(`Module type : ${esm ? 'ESM (.mjs)' : 'CommonJS (.js)'}`);
    console.log('');

    const c = (await ask(`Command name [${commandName}]: `)).trim();
    if (c) commandName = sanitizeCommand(c);

    const d = (await ask(`Install dir  [${installDir}]: `)).trim();
    if (d) installDir = d;

    const b = (await ask(`Bin dir      [${binDir}]: `)).trim();
    if (b) binDir = b;

    console.log('');
    console.log('Working directory for the installed command:');
    console.log('  1. caller  – run in the directory the user invoked it from (default)');
    console.log('  2. install – cd into the installation directory before running');
    const rm = (await ask(`Choose [1]: `)).trim();
    runMode = (rm === '2' || rm.toLowerCase() === 'install') ? 'install' : 'caller';
  }

  const jsFile   = path.join(installDir, `${safeBase}.${jsExt}`);
  const binPath  = path.join(binDir, commandName);
  const infoFile = path.join(REGISTRY_APPS, `${safeBase}.info`);

  const sh = generateInstallerSh({
    appName: safeBase,
    commandName,
    sourceFileName: absSource,
    sourceContent: jsPayload,
    installDir,
    jsFile,
    binPath,
    infoFile,
    binDir,
    runMode,
  });

  const outFile = `${safeBase}-install.sh`;
  await writeFile(outFile, sh, 'utf8');
  try { execSync(`chmod +x ${JSON.stringify(outFile)}`); } catch { /* ignore */ }

  console.log('');
  console.log(`Generated installer : ${outFile}`);
  console.log(`Module type         : ${esm ? 'ESM (.mjs)' : 'CommonJS (.js)'}`);
  console.log(`Run mode            : ${runMode}`);
  console.log(`Run it with         : sudo ./${outFile}`);
  console.log(`Global command      : ${commandName}`);
  console.log(`Uninstall with      : sudo ./${outFile} --uninstall`);
}

// ---------------------------------------------------------------------------
// --list interface
// ---------------------------------------------------------------------------
async function listInstalled() {
  while (true) {
    const entries = await readRegistryEntries();

    console.log('');
    console.log('=========================================');
    console.log('  SingleInstall – Installed commands');
    console.log('=========================================');

    if (entries.length === 0) {
      console.log(`No installations found in ${REGISTRY_APPS}`);
      return;
    }

    entries.forEach((e, i) => {
      console.log('');
      console.log(`  ${i + 1}. ${e.NAME}`);
      console.log(`     command : ${e.COMMAND}`);
      console.log(`     js file : ${e.JS_FILE}`);
      console.log(`     source  : ${e.SOURCE_FILE}`);
      console.log(`     run mode: ${e.RUN_MODE || 'caller'}`);
      console.log(`     date    : ${e.INSTALLED_AT}`);
    });

    console.log('');
    console.log('Enter a number to manage, "r" to refresh, or "q" to quit.');
    const raw = (await ask('list> ')).trim().toLowerCase();

    if (raw === '' || raw === 'q' || raw === 'quit' || raw === 'exit') return;
    if (raw === 'r' || raw === 'refresh') continue;

    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1 || n > entries.length) {
      console.log('Invalid selection.');
      continue;
    }
    await manageEntry(entries[n - 1]);
  }
}

async function manageEntry(entry) {
  console.log('');
  console.log(`Managing: ${entry.NAME}`);
  console.log('  1. Uninstall');
  console.log('  2. Show registry entry');
  console.log('  3. Back');
  const choice = (await ask('manage> ')).trim();

  if (choice === '1') {
    const confirm = (await ask(`Uninstall '${entry.COMMAND}'? (y/n): `))
      .trim().toLowerCase();
    if (confirm === 'y') await uninstallEntry(entry);
  } else if (choice === '2') {
    try {
      const info = await readFile(
        path.join(REGISTRY_APPS, `${entry.NAME}.info`), 'utf8');
      console.log('');
      console.log(info);
    } catch {
      console.log('Could not read info file.');
    }
  }
}

async function uninstallEntry(entry) {
  const paths = [entry.BIN_PATH, entry.INSTALL_DIR, entry.INFO_FILE]
    .filter(Boolean);

  try {
    const rmArgs = paths.map((p) => JSON.stringify(p)).join(' ');
    execSync(`sudo rm -rf ${rmArgs}`, { stdio: 'inherit' });
    console.log(`Uninstalled '${entry.COMMAND}'.`);
  } catch (err) {
    console.error('Uninstall failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    file: null,
    command: null,
    installDir: null,
    binDir: null,
    runMode: null,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--command')           opts.command    = argv[++i];
    else if (a === '--install-dir')                opts.installDir = argv[++i];
    else if (a === '--bin-dir')                    opts.binDir     = argv[++i];
    else if (a === '--run-mode') {
      const v = (argv[++i] || '').toLowerCase();
      opts.runMode = (v === 'install') ? 'install' : 'caller';
    }
    else if (a === '-y' || a === '--yes')          opts.yes        = true;
    else if (!opts.file && !a.startsWith('-'))     opts.file       = a;
  }
  return opts;
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === '--help' || first === '-h' || argv.length === 0) {
    console.log(`
SingleInstall.js - Bundle a Node.js script into a self-installing .sh

Usage:
  SingleInstall.js <file.js>            Generate <name>-install.sh
  SingleInstall.js --list               Manage previously installed commands
  SingleInstall.js --help               Show this help

Options when generating an installer:
  -c, --command <name>     Override the global command name
      --install-dir <dir>  Override install directory
                           (default /usr/local/etc/singleinstall/<name>)
      --bin-dir <dir>      Override bin directory   (default /usr/local/bin)
      --run-mode <mode>    "caller" (default) or "install"
                           caller  = wrapper runs in the caller's cwd
                           install = wrapper cd's into the install dir first
  -y, --yes                Skip interactive prompts (accept defaults)

ESM auto-detection:
  The source is bundled as ESM (.mjs) when any of these is true:
    - the file extension is .mjs
    - the nearest package.json has "type": "module"
    - the source contains top-level import / export statements
  Otherwise it is bundled as CommonJS (.js).

What the generated installer does:
  1. Ensures Node.js is present (apt / apk / dnf / yum / pacman)
  2. Writes the JS payload to a system location
  3. Creates a global command that executes the JS file, forwarding all args
  4. Registers itself so '--list' can find, show, and uninstall it

Example:
  ./SingleInstall.js ./myapp.js
  sudo ./myapp-install.sh
  myapp arg1 arg2
  ./SingleInstall.js --list
`);
    process.exit(0);
  }

  if (first === '--list' || first === '-l') {
    await listInstalled();
    rl.close();
    process.exit(0);
  }

  const opts = parseArgs(argv);
  await createInstaller(opts);
  rl.close();
}

main().catch((err) => {
  console.error('Error:', err);
  try { rl.close(); } catch { /* ignore */ }
  process.exit(1);
});