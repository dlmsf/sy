#!/usr/bin/env node

/**
 * shinstall.js – Modular install.sh generator  (rewrite v4)
 *
 * Guarantees:
 *  1. ONLY install.sh is ever written (plus old-install.sh when the user
 *     explicitly asks for it via menu 3 / 6, or --emb / --old).
 *  2. Legacy files (.shinstallrc, .shinstall-features, install.sh.bak)
 *     are deleted at startup AND on exit / SIGINT / SIGTERM, just in case
 *     an older version of this tool left them behind.
 *  3. Feature selection uses node:readline/promises so consecutive awaits
 *     work reliably. The loop exits ONLY on the literal word "done"
 *     (or "0"/"q"). Empty input never exits.
 *  4. Generated install.sh is idempotent: every dependency is checked
 *     with "command -v" and the package manager, and only missing pieces
 *     are installed. apt-get update runs at most once per run, and only
 *     if something actually needs installing.
 *  5. Compiled languages (c/cpp/go/rust/java) are compiled once during
 *     install.sh. The generated command wrappers just exec the compiled
 *     binary; they never compile.
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { execSync } from 'node:child_process';

const unlink    = promisify(fs.unlink);
const writeFile = promisify(fs.writeFile);
const rename    = promisify(fs.rename);
const access    = promisify(fs.access);

// ---------------------------------------------------------------------------
// Legacy cleanup (belt + suspenders)
// ---------------------------------------------------------------------------
const LEGACY_FILES = ['.shinstallrc', '.shinstall-features', 'install.sh.bak'];

function removeLegacyFilesSync() {
  for (const f of LEGACY_FILES) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

// Remove at startup (in case a previous version left them behind).
removeLegacyFilesSync();

// Remove on exit / Ctrl+C / SIGTERM.
const onExit = () => { removeLegacyFilesSync(); };
process.on('exit', onExit);
process.on('SIGINT',  () => { removeLegacyFilesSync(); process.exit(130); });
process.on('SIGTERM', () => { removeLegacyFilesSync(); process.exit(143); });

// ---------------------------------------------------------------------------
// readline/promises
// ---------------------------------------------------------------------------
const rl  = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

// ---------------------------------------------------------------------------
// Session-only state (never persisted)
// ---------------------------------------------------------------------------
const SESSION = {
  config: null,
  features: new Set()
};

const BASE_DEFAULTS = {
  projectName: 'MyApp',
  binDir: '/usr/local/bin',
  repoDir: process.cwd(),
  mainSourceDir: '.',
  mainEntryPointsSrc: 'app.js',
  mainEntryPointsCmd: 'myapp',
  shellScriptsSrc: '',
  shellScriptsCmd: '',
  postInstallScripts: '',
  preservationWhitelist: ''
};

const defaultInstallDir = (name) => `/usr/local/etc/${name}`;

function getConfig() {
  if (!SESSION.config) {
    SESSION.config = {
      ...BASE_DEFAULTS,
      installDir: defaultInstallDir(BASE_DEFAULTS.projectName)
    };
  }
  return SESSION.config;
}

// ---------------------------------------------------------------------------
// Feature list
// ---------------------------------------------------------------------------
const features = [
  { id: 'autodeps',      name: 'Auto language detection & dependencies',
    generate: () => autoDepsFeatureSnippet() },
  { id: 'debs',          name: 'Debian package installation',
    generate: () => debInstallFeatureSnippet() },
  { id: 'pm2',           name: 'PM2 extraction',
    generate: () => pm2ExtractFeatureSnippet() },
  { id: 'pkgcli',        name: 'pkg CLI utility',
    generate: () => pkgCliFeatureSnippet() },
  { id: 'wsave',         name: 'wsave permission fixer',
    generate: () => wsaveFeatureSnippet() },
  { id: 'gitconfig',     name: 'git-config command',
    generate: () => gitConfigFeatureSnippet() },
  { id: 'shellfallback', name: 'Shell script bash→ash fallback',
    generate: () => shellFallbackFeatureSnippet() },
  { id: 'oldwrapper',    name: 'Old script wrapper (--old support)',
    generate: () => oldWrapperFeatureSnippet() }
];

// ---------------------------------------------------------------------------
// Feature snippets
// ---------------------------------------------------------------------------

function autoDepsFeatureSnippet() {
  return `
# =============================================================================
# AUTO LANGUAGE DETECTION & DEPENDENCIES  (idempotent)
# =============================================================================
INSTALL_DEPS=true
APT_UPDATED=false

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# Is a package already installed?  Try the native package manager first.
pkg_installed() {
    pkg="$1"
    if have_cmd dpkg;   then dpkg -s "$pkg"       >/dev/null 2>&1 && return 0; fi
    if have_cmd rpm;    then rpm -q "$pkg"        >/dev/null 2>&1 && return 0; fi
    if have_cmd apk;    then apk info -e "$pkg"   >/dev/null 2>&1 && return 0; fi
    if have_cmd pacman; then pacman -Q  "$pkg"    >/dev/null 2>&1 && return 0; fi
    return 1
}

# Run apt-get update at most once per install.sh invocation, and only
# when we're actually about to install something.
apt_update_once() {
    [ "$APT_UPDATED" = "true" ] && return 0
    APT_UPDATED=true
    if have_cmd apt-get; then $SUDO apt-get update -qq
    elif have_cmd apt;   then $SUDO apt update -qq
    fi
}

# Install the given packages, skipping any that are already present.
install_packages() {
    [ $# -eq 0 ] && return 0
    to_install=""
    for pkg in "$@"; do
        if pkg_installed "$pkg"; then
            echo "    already installed: $pkg"
        else
            echo "    MISSING:           $pkg"
            to_install="$to_install $pkg"
        fi
    done
    if [ -z "$to_install" ]; then
        echo "    -> nothing to install"
        return 0
    fi
    echo "    -> installing:$to_install"
    apt_update_once
    if have_cmd apt-get; then $SUDO apt-get install -y $to_install
    elif have_cmd apt;   then $SUDO apt install -y $to_install
    elif have_cmd apk;   then $SUDO apk add $to_install
    elif have_cmd dnf;   then $SUDO dnf install -y $to_install
    elif have_cmd yum;   then $SUDO yum install -y $to_install
    elif have_cmd pacman; then $SUDO pacman -S --noconfirm $to_install
    else echo "    no supported package manager; install manually:$to_install"; return 1
    fi
}

# Skip if the toolchain commands are already present; otherwise check
# the package manager, then install only the missing packages.
install_language_deps() {
    lang="$1"
    case "$lang" in
        node)
            if have_cmd node && have_cmd npm; then
                echo "    node/npm: present at $(command -v node)"; return 0
            fi
            install_packages nodejs npm ;;
        python)
            if have_cmd python3; then
                echo "    python3: present at $(command -v python3)"; return 0
            fi
            install_packages python3 ;;
        ruby)
            if have_cmd ruby; then
                echo "    ruby:    present at $(command -v ruby)"; return 0
            fi
            install_packages ruby ;;
        php)
            if have_cmd php; then
                echo "    php:     present at $(command -v php)"; return 0
            fi
            install_packages php-cli php ;;
        perl)
            if have_cmd perl; then
                echo "    perl:    present at $(command -v perl)"; return 0
            fi
            install_packages perl ;;
        shell)
            if have_cmd bash; then
                echo "    bash:    present at $(command -v bash)"; return 0
            fi
            install_packages bash ;;
        java)
            if have_cmd javac && have_cmd java; then
                echo "    javac:   present at $(command -v javac)"; return 0
            fi
            install_packages default-jdk ;;
        c)
            if have_cmd gcc; then
                echo "    gcc:     present at $(command -v gcc)"; return 0
            fi
            install_packages build-essential gcc ;;
        cpp)
            if have_cmd g++; then
                echo "    g++:     present at $(command -v g++)"; return 0
            fi
            install_packages build-essential g++ ;;
        go)
            if have_cmd go; then
                echo "    go:      present at $(command -v go)"; return 0
            fi
            install_packages golang-go ;;
        rust)
            if have_cmd rustc; then
                echo "    rustc:   present at $(command -v rustc)"; return 0
            fi
            install_packages rustc cargo ;;
    esac
}
`;
}

function debInstallFeatureSnippet() {
  return `
# =============================================================================
# DEBIAN PACKAGE INSTALLATION (idempotent)
# =============================================================================
SKIP_DEBS=false
DEB_DIR="$REPO_DIR/deb-packages"

deb_installed() { dpkg -s "$1" >/dev/null 2>&1; }

install_debs() {
    [ "$SKIP_DEBS" = true ] && return 0
    [ ! -d "$DEB_DIR" ] && return 0
    echo "Checking .deb packages in $DEB_DIR..."
    find "$DEB_DIR" -name '*.deb' -type f | while read -r deb; do
        pkg=$(dpkg-deb -f "$deb" Package 2>/dev/null || basename "$deb" .deb)
        if deb_installed "$pkg"; then
            echo "  already installed: $pkg"
        else
            echo "  installing: $deb"
            $SUDO dpkg -i "$deb" || $SUDO apt-get install -f -y
        fi
    done
}
`;
}

function pm2ExtractFeatureSnippet() {
  return `
# =============================================================================
# PM2 EXTRACTION
# =============================================================================
PM2_TAR_GZ="$REPO_DIR/archives/pm2.tar.gz"
PM2_EXTRACT_DIR="$INSTALL_DIR/vendor/pm2"

extract_pm2() {
    [ -f "$PM2_TAR_GZ" ] || return 0
    if [ -d "$PM2_EXTRACT_DIR" ] && [ -n "$(ls -A "$PM2_EXTRACT_DIR" 2>/dev/null)" ]; then
        echo "  PM2 already extracted; skipping."
        return 0
    fi
    echo "Extracting PM2..."
    mkdir -p "$PM2_EXTRACT_DIR"
    tar -xzf "$PM2_TAR_GZ" -C "$PM2_EXTRACT_DIR" --strip-components=1
}
`;
}

function pkgCliFeatureSnippet() {
  return `
# =============================================================================
# PKG CLI UTILITY
# =============================================================================
create_pkg_cli() {
    mkdir -p "$INSTALL_DIR/wrappers"
    cat > "$INSTALL_DIR/wrappers/pkg" << 'PKGEOF'
#!/usr/bin/env node
console.log("pkg command placeholder");
PKGEOF
    chmod +x "$INSTALL_DIR/wrappers/pkg"
    link_cmd "$INSTALL_DIR/wrappers/pkg" "pkg"
}
`;
}

function wsaveFeatureSnippet() {
  return `
# =============================================================================
# WSAVE PERMISSION FIXER
# =============================================================================
create_wsave() {
    mkdir -p "$INSTALL_DIR/wrappers"
    cat > "$INSTALL_DIR/wrappers/wsave" << 'WSAVEEOF'
#!/bin/sh
USERNAME="\${SUDO_USER:-\$USER}"
chown -R "\$USERNAME:\$USERNAME" /home >/dev/null 2>&1
chmod -R u+rwX /home >/dev/null 2>&1
WSAVEEOF
    chmod +x "$INSTALL_DIR/wrappers/wsave"
    link_cmd "$INSTALL_DIR/wrappers/wsave" "wsave"
}
`;
}

function gitConfigFeatureSnippet() {
  return `
# =============================================================================
# GIT-CONFIG COMMAND
# =============================================================================
create_git_config() {
    mkdir -p "$INSTALL_DIR/wrappers"
    cat > "$INSTALL_DIR/wrappers/git-config" << GITEOF
#!/bin/sh
GIT_JS=\\$(find "$INSTALL_DIR" -name 'Git.js' -type f 2>/dev/null | head -1)
[ -z "\\$GIT_JS" ] && { echo "Git.js not found"; exit 1; }
cd "$INSTALL_DIR"
exec node "\\$GIT_JS" --setup "\\$@"
GITEOF
    chmod +x "$INSTALL_DIR/wrappers/git-config"
    link_cmd "$INSTALL_DIR/wrappers/git-config" "git-config"
}
`;
}

function shellFallbackFeatureSnippet() {
  return `
# =============================================================================
# SHELL SCRIPT BASH→ASH FALLBACK
# =============================================================================
create_shell_commands() {
    [ -z "$SHELL_SCRIPTS_SRC" ] && return 0
    mkdir -p "$INSTALL_DIR/wrappers"
    idx=1
    for src in $SHELL_SCRIPTS_SRC; do
        cmd=$(echo "$SHELL_SCRIPTS_CMD" | tr ' ' '\\n' | sed -n "\${idx}p")
        [ -z "$cmd" ] && { idx=$((idx+1)); continue; }
        src_path="$INSTALL_DIR/$src"
        if [ ! -f "$src_path" ]; then
            echo "  warning: shell script not found: $src_path"
            idx=$((idx+1)); continue
        fi
        chmod +x "$src_path"
        wrapper="$INSTALL_DIR/wrappers/$cmd"
        cat > "$wrapper" << SHEOF
#!/bin/sh
if command -v bash >/dev/null 2>&1; then
    exec bash "$src_path" "\\$@"
else
    exec sh "$src_path" "\\$@"
fi
SHEOF
        chmod +x "$wrapper"
        link_cmd "$wrapper" "$cmd"
        echo "  created shell command: $cmd"
        idx=$((idx+1))
    done
}
`;
}

function oldWrapperFeatureSnippet() {
  return `
# =============================================================================
# OLD SCRIPT WRAPPER (--old)
# =============================================================================
OLD_SCRIPT_PATH="$REPO_DIR/old-install.sh"
`;
}

// ---------------------------------------------------------------------------
// install.sh assembly
// ---------------------------------------------------------------------------

function generateInstallSh(config, enabledFeatures) {
  const parts = [];

  parts.push(`#!/bin/sh
# =============================================================================
# ${config.projectName} Installation Script
# Generated by shinstall.js
# =============================================================================
`);

  parts.push(`
PROJECT_NAME="${config.projectName}"
INSTALL_DIR="${config.installDir}"
BIN_DIR="${config.binDir}"
REPO_DIR=$(pwd)
MAIN_SOURCE_DIR="${config.mainSourceDir}"
MAIN_ENTRY_POINTS_SRC="${config.mainEntryPointsSrc}"
MAIN_ENTRY_POINTS_CMD="${config.mainEntryPointsCmd}"
`);

  if (config.shellScriptsSrc) {
    parts.push(`
SHELL_SCRIPTS_SRC="${config.shellScriptsSrc}"
SHELL_SCRIPTS_CMD="${config.shellScriptsCmd}"
`);
  }
  if (config.postInstallScripts) {
    parts.push(`\nPOST_INSTALL_SCRIPTS="${config.postInstallScripts}"\n`);
  }
  if (config.preservationWhitelist) {
    parts.push(`\nPRESERVATION_WHITELIST="${config.preservationWhitelist}"\n`);
  }

  parts.push(`
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
fi
`);

  if (enabledFeatures.has('oldwrapper')) {
    parts.push(`
OLD_SCRIPT_PATH="$REPO_DIR/old-install.sh"
if [ "$1" = "--old" ] && [ -f "$OLD_SCRIPT_PATH" ]; then
    echo "Running old install script..."
    shift
    exec bash "$OLD_SCRIPT_PATH" "$@"
fi
`);
  }

  for (const feature of features) {
    if (enabledFeatures.has(feature.id)) {
      parts.push(feature.generate());
    }
  }

  parts.push(`
# =============================================================================
# CORE HELPERS
# =============================================================================
detect_language() {
    case "$1" in
        *.js|*.mjs|*.cjs|*.ts)    echo "node" ;;
        *.py)                     echo "python" ;;
        *.rb)                     echo "ruby" ;;
        *.php)                    echo "php" ;;
        *.pl)                     echo "perl" ;;
        *.sh)                     echo "shell" ;;
        *.java)                   echo "java" ;;
        *.c|*.h)                  echo "c" ;;
        *.cpp|*.cc|*.cxx|*.hpp)   echo "cpp" ;;
        *.go)                     echo "go" ;;
        *.rs)                     echo "rust" ;;
        *)                        echo "unknown" ;;
    esac
}

link_cmd() {
    target="$1"; name="$2"
    if [ -w "$BIN_DIR" ]; then
        ln -sf "$target" "$BIN_DIR/$name"
    else
        $SUDO ln -sf "$target" "$BIN_DIR/$name"
    fi
}

copy_files() {
    src_dir="$1"; dst_dir="$2"
    [ -d "$src_dir" ] || { echo "Source dir not found: $src_dir"; return 1; }
    mkdir -p "$dst_dir"
    echo "Copying files from $src_dir to $dst_dir..."
    cp -R "$src_dir"/. "$dst_dir"/ 2>/dev/null || true
    rm -rf "$dst_dir/.git" "$dst_dir/node_modules"
}

remove_links() {
    cmd_list="$MAIN_ENTRY_POINTS_CMD"
    for cmd in $cmd_list; do
        [ -L "$BIN_DIR/$cmd" ] && $SUDO rm -f "$BIN_DIR/$cmd"
    done
    [ -d "$INSTALL_DIR/wrappers" ] && rm -rf "$INSTALL_DIR/wrappers"
}

execute_post_install_scripts() {
    [ -z "$POST_INSTALL_SCRIPTS" ] && return 0
    echo "Executing post-install scripts..."
    cd "$INSTALL_DIR" || return 0
    for script in $POST_INSTALL_SCRIPTS; do
        [ -f "$script" ] && sh "$script"
    done
    cd - >/dev/null 2>&1 || true
}

cleanup() {
    $SUDO dpkg --configure -a >/dev/null 2>&1 || true
}
`);

  parts.push(`
# =============================================================================
# COMPILE STEP (once, at install time)
# =============================================================================
compile_entry() {
    lang="$1"; src="$2"; out="$3"
    case "$lang" in
        c)    command -v gcc   >/dev/null 2>&1 || { echo "  gcc missing";   return 1; }; gcc   -O2 -o "$out" "$src" ;;
        cpp)  command -v g++   >/dev/null 2>&1 || { echo "  g++ missing";   return 1; }; g++   -O2 -o "$out" "$src" ;;
        go)   command -v go    >/dev/null 2>&1 || { echo "  go missing";    return 1; }; go    build -o "$out" "$src" ;;
        rust) command -v rustc >/dev/null 2>&1 || { echo "  rustc missing"; return 1; }; rustc -O   -o "$out" "$src" ;;
        java) command -v javac >/dev/null 2>&1 || { echo "  javac missing"; return 1; }; javac -d "$(dirname "$src")" "$src" ;;
        *)    return 0 ;;
    esac
}

build_compiled_entries() {
    mkdir -p "$INSTALL_DIR/bin"
    idx=1
    for src in $MAIN_ENTRY_POINTS_SRC; do
        cmd=$(echo "$MAIN_ENTRY_POINTS_CMD" | tr ' ' '\\n' | sed -n "\${idx}p")
        [ -z "$cmd" ] && { idx=$((idx+1)); continue; }
        src_path="$INSTALL_DIR/$src"
        [ ! -f "$src_path" ] && { idx=$((idx+1)); continue; }
        lang=$(detect_language "$src_path")
        case "$lang" in
            c|cpp|go|rust)
                out="$INSTALL_DIR/bin/$cmd"
                echo "Compiling $src_path -> $out"
                compile_entry "$lang" "$src_path" "$out" || true
                ;;
            java)
                echo "Compiling Java source $src_path"
                compile_entry "java" "$src_path" "" || true
                ;;
        esac
        idx=$((idx+1))
    done
}
`);

  parts.push(`
# =============================================================================
# COMMAND WRAPPERS (never compile here)
# =============================================================================
create_command_links() {
    mkdir -p "$INSTALL_DIR/wrappers"
    src_list="$MAIN_ENTRY_POINTS_SRC"
    cmd_list="$MAIN_ENTRY_POINTS_CMD"
    idx=1
    for src in $src_list; do
        cmd=$(echo "$cmd_list" | tr ' ' '\\n' | sed -n "\${idx}p")
        [ -z "$cmd" ] && { idx=$((idx+1)); continue; }
        src_path="$INSTALL_DIR/$src"
        if [ ! -f "$src_path" ]; then
            echo "  warning: source file not found: $src_path"
            idx=$((idx+1)); continue
        fi
        lang=$(detect_language "$src_path")
        wrapper="$INSTALL_DIR/wrappers/$cmd"
        echo "Creating command '$cmd' for $src_path (language: $lang)"

        case "$lang" in
            node)
                if ! head -1 "$src_path" | grep -q '^#!'; then
                    tmp="$(mktemp)"
                    { echo '#!/usr/bin/env node'; cat "$src_path"; } > "$tmp"
                    mv "$tmp" "$src_path"
                fi
                chmod +x "$src_path"
                cat > "$wrapper" << WRAPEOF
#!/bin/sh
exec node "$src_path" "\\$@"
WRAPEOF
                ;;
            python) cat > "$wrapper" << WRAPEOF
#!/bin/sh
exec python3 "$src_path" "\\$@"
WRAPEOF
                ;;
            ruby) cat > "$wrapper" << WRAPEOF
#!/bin/sh
exec ruby "$src_path" "\\$@"
WRAPEOF
                ;;
            php) cat > "$wrapper" << WRAPEOF
#!/bin/sh
exec php "$src_path" "\\$@"
WRAPEOF
                ;;
            perl) cat > "$wrapper" << WRAPEOF
#!/bin/sh
exec perl "$src_path" "\\$@"
WRAPEOF
                ;;
            shell) cat > "$wrapper" << WRAPEOF
#!/bin/sh
exec bash "$src_path" "\\$@"
WRAPEOF
                ;;
            c|cpp|go|rust)
                binary="$INSTALL_DIR/bin/$cmd"
                if [ -x "$binary" ]; then
                    cat > "$wrapper" << WRAPEOF
#!/bin/sh
exec "$binary" "\\$@"
WRAPEOF
                else
                    echo "  error: binary not built for $src_path (compiler missing?)"
                    idx=$((idx+1)); continue
                fi
                ;;
            java)
                cls=$(basename "$src_path" .java)
                cls_dir=$(dirname "$src_path")
                cat > "$wrapper" << WRAPEOF
#!/bin/sh
exec java -cp "$cls_dir" "$cls" "\\$@"
WRAPEOF
                ;;
            *)
                chmod +x "$src_path" 2>/dev/null || true
                cat > "$wrapper" << WRAPEOF
#!/bin/sh
exec "$src_path" "\\$@"
WRAPEOF
                ;;
        esac
        chmod +x "$wrapper"
        link_cmd "$wrapper" "$cmd"
        echo "  -> $BIN_DIR/$cmd"
        idx=$((idx+1))
    done
}
`);

  parts.push(`
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo "Install $PROJECT_NAME"
    echo ""
    echo "Options:"
    echo "  -h, --help       Show this help"
    echo "  --deps           Force dependency installation check"
    echo "  --force, -f      Force update without asking"
    echo "  --remove, -r     Remove existing installation"
    echo ""
    echo "Commands created:"
    for cmd in $MAIN_ENTRY_POINTS_CMD; do
        echo "  $cmd"
    done
}

FORCE_UPDATE=false
FORCE_REMOVE=false
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)   show_help; exit 0 ;;
        --deps)      INSTALL_DEPS=true ;;
        --force|-f)  FORCE_UPDATE=true ;;
        --remove|-r) FORCE_REMOVE=true ;;
        *) ;;
    esac
    shift
done

if [ -d "$INSTALL_DIR" ]; then
    if [ "$FORCE_REMOVE" = true ]; then
        echo "Removing existing installation..."
        remove_links
        $SUDO rm -rf "$INSTALL_DIR"
        echo "Removed. Proceeding with fresh install..."
    elif [ "$FORCE_UPDATE" = true ]; then
        echo "Forcing update..."
        remove_links
    else
        echo "Existing installation found at $INSTALL_DIR"
        echo "  1. Update (replace existing files)"
        echo "  2. Remove (delete existing installation)"
        echo "  3. Exit"
        printf "Enter your choice (1/2/3): "
        read choice
        case "$choice" in
            1) echo "Updating..."; remove_links ;;
            2)
                echo "Removing..."
                remove_links
                $SUDO rm -rf "$INSTALL_DIR"
                echo "Removed successfully."
                exit 0
                ;;
            *) echo "Exiting."; exit 0 ;;
        esac
    fi
fi
`);

  if (enabledFeatures.has('autodeps')) {
    parts.push(`
if [ "$INSTALL_DEPS" != "false" ]; then
    echo "Checking language toolchains for entry points..."
    for src in $MAIN_ENTRY_POINTS_SRC; do
        lang=$(detect_language "$src")
        [ "$lang" = "unknown" ] && { echo "  $src: unknown language, skipping"; continue; }
        echo "  $src -> $lang"
        install_language_deps "$lang"
    done
fi
`);
  }

  if (enabledFeatures.has('debs')) parts.push(`install_debs`);

  parts.push(`
copy_files "$MAIN_SOURCE_DIR" "$INSTALL_DIR"
build_compiled_entries
create_command_links
`);

  if (enabledFeatures.has('pm2'))           parts.push(`extract_pm2`);
  if (enabledFeatures.has('pkgcli'))        parts.push(`create_pkg_cli`);
  if (enabledFeatures.has('wsave'))         parts.push(`create_wsave`);
  if (enabledFeatures.has('gitconfig'))     parts.push(`create_git_config`);
  if (enabledFeatures.has('shellfallback')) parts.push(`create_shell_commands`);

  parts.push(`
execute_post_install_scripts
cleanup

echo ""
echo "Installation completed!"
echo ""
echo "Available commands:"
for cmd in $MAIN_ENTRY_POINTS_CMD; do
    echo "  $cmd"
done
echo ""
echo "Installation directory: $INSTALL_DIR"
`);

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Feature chooser
// ---------------------------------------------------------------------------

function renderFeatureList(enabled) {
  console.log('');
  console.log('Feature list:');
  for (let i = 0; i < features.length; i++) {
    const mark = enabled.has(features[i].id) ? '[X]' : '[ ]';
    console.log(`  ${i + 1}. ${mark} ${features[i].name}`);
  }
  console.log('');
}

/**
 * Multi-select loop.  Accepts one or more numbers per line (space/comma).
 * Exits ONLY on the literal word "done" (or "0"/"q").
 * Empty input does nothing — never exits.
 */
async function chooseFeaturesInteractive() {
  const enabled = SESSION.features;

  console.log('Toggle features by entering numbers separated by spaces or commas');
  console.log('(example: "1 3 5" or "1,3,5").');
  console.log('Type "all", "none", "list", or "done" (finishes the selection).');

  while (true) {
    renderFeatureList(enabled);

    const raw = await ask('features> ');
    if (raw === undefined || raw === null) {
      // stdin closed (EOF) — treat as done.
      console.log('(stdin closed, finishing selection)');
      break;
    }

    const input = String(raw).trim();
    const lower = input.toLowerCase();

    if (lower === 'done' || lower === '0' || lower === 'q' ||
        lower === 'quit' || lower === 'exit') {
      break;
    }
    if (input === '') {
      // Do nothing; loop and re-show the list.
      continue;
    }
    if (lower === 'list') {
      continue;
    }
    if (lower === 'all') {
      for (const f of features) enabled.add(f.id);
      continue;
    }
    if (lower === 'none') {
      enabled.clear();
      continue;
    }

    const tokens = input.split(/[\s,]+/).filter(Boolean);
    for (const tok of tokens) {
      const n = Number.parseInt(tok, 10);
      if (Number.isInteger(n) && n >= 1 && n <= features.length) {
        const id = features[n - 1].id;
        if (enabled.has(id)) {
          enabled.delete(id);
          console.log(`  turned OFF: ${features[n - 1].name}`);
        } else {
          enabled.add(id);
          console.log(`  turned ON : ${features[n - 1].name}`);
        }
      } else {
        console.log(`  ignored: "${tok}" (not a feature number)`);
      }
    }
  }
  return enabled;
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------

async function interactiveMenu() {
  console.clear();
  console.log('=========================================');
  console.log('  shinstall.js – Modular install.sh Builder');
  console.log('=========================================');
  console.log('Current directory:', process.cwd());
  console.log('');

  const existingInstall = await fileExists('install.sh');

  console.log('Options:');
  console.log('1. Create a new install.sh from scratch');
  if (existingInstall) {
    console.log('2. Modify existing install.sh (overwrite)');
    console.log('3. Embed old script (backup as old-install.sh and generate new)');
  }
  console.log('4. Toggle features');
  console.log('5. Configure project settings');
  console.log('6. Generate old-install.sh wrapper (--old support)');
  console.log('7. Remove old-install.sh');
  console.log('0. Exit');
  console.log('');

  const choice = (await ask('Select an option: ')).trim();
  switch (choice) {
    case '1': await createNewInstall(); break;
    case '2':
      if (existingInstall) await modifyExistingInstall();
      else console.log('No existing install.sh found.');
      break;
    case '3':
      if (existingInstall) await embedOldScript();
      else console.log('No existing install.sh to embed.');
      break;
    case '4':
      await chooseFeaturesInteractive();
      console.log('Feature set updated (in-memory only).');
      break;
    case '5': await configureSettings(); break;
    case '6': await generateOldWrapper(); break;
    case '7': await removeOldWrapper(); break;
    case '0':
      console.log('Goodbye!');
      rl.close();
      process.exit(0);
    default:
      console.log('Invalid choice.');
  }
  console.log('\nPress Enter to continue...');
  await ask('');
  return interactiveMenu();
}

async function createNewInstall() {
  console.log('\n--- Create new install.sh ---');
  const config = await gatherProjectConfig();

  console.log('\nNow choose the features for this install.sh.');
  await chooseFeaturesInteractive();

  const content = generateInstallSh(config, SESSION.features);
  await writeFile('install.sh', content, 'utf8');
  try { execSync('chmod +x install.sh'); } catch { /* ignore */ }
  console.log('\ninstall.sh generated successfully.');
  console.log('Selected features: ' +
    (SESSION.features.size ? Array.from(SESSION.features).join(', ') : 'none'));
}

async function modifyExistingInstall() {
  console.log('\n--- Modify existing install.sh ---');
  const confirm = (await ask('This will overwrite install.sh. Continue? (y/n): ')).toLowerCase();
  if (confirm !== 'y') return;
  await createNewInstall();
}

async function embedOldScript() {
  console.log('\n--- Embed old script ---');
  const confirm = (await ask('Backup install.sh as old-install.sh and generate a new one? (y/n): ')).toLowerCase();
  if (confirm !== 'y') return;
  await rename('install.sh', 'old-install.sh');
  await createNewInstall();
  console.log('Old script saved as old-install.sh. Use install.sh --old to run it.');
}

async function configureSettings() {
  console.log('\n--- Configure Project Settings ---');
  const config = getConfig();
  const projectName = (await ask(`Project name (${config.projectName}): `)) || config.projectName;
  config.projectName = projectName;

  const defInstall = defaultInstallDir(projectName);
  const installDir = (await ask(`Install directory (${defInstall}): `)) || defInstall;
  config.installDir = installDir;

  const binDir = (await ask(`Bin directory (${config.binDir}): `)) || config.binDir;
  config.binDir = binDir;

  const mainSrc = (await ask(`Main entry point source (${config.mainEntryPointsSrc}): `)) || config.mainEntryPointsSrc;
  config.mainEntryPointsSrc = mainSrc;

  const mainCmd = (await ask(`Main command name (${config.mainEntryPointsCmd}): `)) || config.mainEntryPointsCmd;
  config.mainEntryPointsCmd = mainCmd;

  console.log('Settings updated (in-memory only; nothing written to disk).');
}

async function generateOldWrapper() {
  console.log('\n--- Generate old-install.sh wrapper ---');
  if (await fileExists('old-install.sh')) {
    console.log('old-install.sh already exists. Nothing to do.');
    return;
  }
  if (!(await fileExists('install.sh'))) {
    console.log('No install.sh found to wrap.');
    return;
  }
  const wrapperContent = `#!/bin/sh
# Wrapper that runs the old install script via install.sh --old
exec bash "$(dirname "$0")/install.sh" --old "$@"
`;
  await writeFile('old-install.sh', wrapperContent, 'utf8');
  try { execSync('chmod +x old-install.sh'); } catch { /* ignore */ }
  console.log('old-install.sh wrapper created.');
}

async function removeOldWrapper() {
  if (await fileExists('old-install.sh')) {
    await unlink('old-install.sh');
    console.log('old-install.sh removed.');
  } else {
    console.log('No old-install.sh found.');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(p) {
  try { await access(p, fs.constants.F_OK); return true; } catch { return false; }
}

async function gatherProjectConfig() {
  const config = getConfig();
  console.log('\nEnter project details (Enter = accept default):');

  const projectName = (await ask(`Project name (${config.projectName}): `)) || config.projectName;
  config.projectName = projectName;

  const defInstall = defaultInstallDir(projectName);
  const installDir = (await ask(`Install directory (${defInstall}): `)) || defInstall;
  config.installDir = installDir;

  const binDir = (await ask(`Bin directory (${config.binDir}): `)) || config.binDir;
  config.binDir = binDir;

  const mainSrc = (await ask(`Main entry point source (${config.mainEntryPointsSrc}): `)) || config.mainEntryPointsSrc;
  config.mainEntryPointsSrc = mainSrc;

  const mainCmd = (await ask(`Main command name (${config.mainEntryPointsCmd}): `)) || config.mainEntryPointsCmd;
  config.mainEntryPointsCmd = mainCmd;

  return config;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
shinstall.js – Modular install.sh generator

Usage:
  node shinstall.js               Interactive menu
  node shinstall.js --new         Create a new install.sh
  node shinstall.js --emb         Backup install.sh as old-install.sh and generate new
  node shinstall.js --old         Generate an old-install.sh wrapper
  node shinstall.js --no-old      Remove the old-install.sh wrapper
  node shinstall.js --help        Show this help

Guarantees:
  - Only install.sh is written.
  - old-install.sh is written only when explicitly requested.
  - .shinstallrc / .shinstall-features / install.sh.bak are deleted at
    startup and on exit, so a previous version can't leave them behind.
`);
    process.exit(0);
  }

  if (args.includes('--new'))    { await createNewInstall();   process.exit(0); }
  if (args.includes('--emb'))    { await embedOldScript();     process.exit(0); }
  if (args.includes('--old'))    { await generateOldWrapper(); process.exit(0); }
  if (args.includes('--no-old')) { await removeOldWrapper();   process.exit(0); }

  await interactiveMenu();
}

main().catch((err) => {
  console.error('Error:', err);
  removeLegacyFilesSync();
  process.exit(1);
});
