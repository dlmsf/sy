#!/bin/sh

# =============================================================================
# GENERIC INSTALLATION TEMPLATE
# =============================================================================
# CUSTOMIZE THE VARIABLES BELOW FOR YOUR SPECIFIC PROJECT
# =============================================================================

# PROJECT BASIC INFO (REQUIRED)
PROJECT_NAME="SyManager"                    # Change to your project name
PROJECT_DESCRIPTION="General System Manager in AppLevel"      # Brief description

# INSTALLATION PATHS (REQUIRED)
INSTALL_DIR="/usr/local/etc/$PROJECT_NAME"          # Where project will be installed
BIN_DIR="/usr/local/bin"                            # Where command symlinks will be created

# SOURCE PATHS (REQUIRED - adjust to your project structure)
REPO_DIR=$(pwd)                                     # Current repository directory
MAIN_SOURCE_DIR="$REPO_DIR"                         # Root of your project files
# DEB_DIR="$REPO_DIR/deb-packages"                  # Uncomment if using .deb packages
# DEB_SERVER_DIR="$REPO_DIR/deb-packages-server"    # Uncomment for server-specific debs
# ARCHIVE_DIR="$REPO_DIR/archives"                  # Uncomment if using archives like pm2

# =============================================================================
# NODE.JS COMMAND MAPPING (REQUIRED - define your commands)
# =============================================================================
# Using space-separated lists for ash compatibility (no associative arrays)
NODE_ENTRY_POINTS_SRC="SyManager.js ._/SyPM.js ._/SyDB.js pkg-cli.js ._/._/._/Packager/Pack.js ._/._/._/Util/arch.js"
NODE_ENTRY_POINTS_CMD="sy sypm sydb pkg pack arc"

# =============================================================================
# SHELL SCRIPT COMMAND MAPPING (OPTIONAL - for .sh files with bash→ash fallback)
# =============================================================================
# Format: Space-separated pairs of (source_file command_name)
# Example: SHELL_SCRIPTS_SRC="scripts/deploy.sh scripts/backup.sh"
#          SHELL_SCRIPTS_CMD="deploy backup"
#
# Each shell script automatically gets:
#   - Bash detection with automatic ash fallback
#   - Working directory control (caller/global)
#   - Full argument passthrough
#   - Wrapper in $INSTALL_DIR/wrappers/
#   - Global symlink in $BIN_DIR/
#
# To add a new shell command:
#   1. Add source and command name above
#   2. Add working directory in get_command_working_dir() below
#   3. Run installer
#
SHELL_SCRIPTS_SRC="./._/._/._/Qemu/qemu.sh ._/._/._/Util/lay.sh"    # ← Add your .sh script paths here
SHELL_SCRIPTS_CMD="qemu lay"    # ← Add your command names here

# =============================================================================
# COMMAND WORKING DIRECTORY CONFIGURATION
# =============================================================================
# WORKING DIRECTORY TYPES:
#   "global"  - Execute from installation directory ($INSTALL_DIR)
#   "caller"  - Execute from user's current working directory (where command was called)
#   "file"    - Execute from the directory containing the script file itself
#
# Using case statements for ash compatibility
get_command_working_dir() {
    command="$1"
    case "$command" in
        # =====================================================================
        # NODE.JS COMMANDS
        # =====================================================================
        "sy") echo "global" ;;
        "sypm") echo "caller" ;;
        "sydb") echo "global" ;;
        "pkg") echo "caller" ;;
        "pack") echo "caller" ;;
        "git-config") echo "global" ;;
        "qemu") echo "file" ;;
        "lay") echo "caller" ;;   
        "arc") echo "caller" ;;   
        
        # =====================================================================
        # SHELL SCRIPT COMMANDS - ADD YOURS HERE
        # =====================================================================
        # Example:
        # "deploy") echo "global" ;;
        # "backup") echo "caller" ;;
        # "monitor") echo "file" ;;     # ← Can also use "file" for shell scripts
        
        # =====================================================================
        # DEFAULT
        # =====================================================================
        *) echo "global" ;;
    esac
}

# =============================================================================
# PRESERVATION WHITELIST - Files/Directories to keep during updates
# =============================================================================
# FORMAT: Space-separated list of patterns
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │ HOW TO USE - ALL CASES EXPLAINED                                        │
# └─────────────────────────────────────────────────────────────────────────┘
#
# CASE 1: Preserve a FILE by its FULL RELATIVE PATH
#   Just put the exact file path from installation root
#   Example: "config/database.json"
#   Example: "._/._/._/Qemu/qemu.sh"
#   Example: "data/cache/index.db"
#   → Matches that EXACT file only
#
# CASE 2: Preserve a DIRECTORY by its FULL RELATIVE PATH
#   Put the directory path ending with /
#   Example: "config/"
#   Example: "._/._/._/Qemu/"
#   Example: "data/"
#   → Matches ALL files inside that directory (recursively)
#
# CASE 3: Preserve files by FILENAME PATTERN (anywhere in tree)
#   Format: "startpattern_endpattern"
#   Uses underscore (_) as separator between START and END of filename
#
#   3a. Match START of filename:
#       "qemu_"     → ANY file starting with "qemu" anywhere
#       "filestart_ → ANY file starting with "filestart" anywhere
#       Example: "qemu_" matches: qemu.sh, qemu.conf, qemu-custom, dir/qemu.xyz
#
#   3b. Match END of filename (ignoring extension):
#       "_sh"       → ANY file ending with "sh" (not counting .extension)
#       "_json"     → ANY file ending with "json" (not counting .extension)
#       Example: "_json" matches: test.json, config.json, data.json
#       Example: "_sh" matches: qemu.sh, run.sh, deploy.sh
#       IMPORTANT: "_json" does NOT require .json extension,
#                  it matches filename ending in "json", with or without extension
#
#   3c. Match START AND END of filename:
#       "qemu_sh"   → Files starting with "qemu" AND ending with "sh"
#       "filestart_customname" → Files starting with "filestart" AND ending with "customname"
#       Example: "qemu_sh" matches: qemu.sh, qemu-custom.sh, qemu_sh
#       Example: "app_conf" matches: app.conf, app-config.conf, app_conf
#
#   3d. Match START only (no underscore):
#       "qemu"      → ANY file starting with "qemu"
#       "filestart" → ANY file starting with "filestart"
#       Example: "qemu" matches: qemu.sh, qemu.conf, qemu-anything, qemu
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │ PUT YOUR PATTERNS HERE (space-separated):                               │
# └─────────────────────────────────────────────────────────────────────────┘
#
PRESERVATION_WHITELIST="alpine-cloudinit noble-server-cloudimg noble-vm alpine-vm"
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │ REAL EXAMPLES (uncomment the one you need):                             │
# └─────────────────────────────────────────────────────────────────────────┘
# PRESERVATION_WHITELIST="._/._/._/Qemu/qemu.sh"
# PRESERVATION_WHITELIST="._/._/._/Qemu/"
# PRESERVATION_WHITELIST="qemu_"
# PRESERVATION_WHITELIST="_json _sh _conf"
# PRESERVATION_WHITELIST="filestart_customname"
# PRESERVATION_WHITELIST="._/._/._/Qemu/ _json qemu_ config/database.json"

# =============================================================================
# ADVANCED CONFIGURATION (Usually don't need changes)
# =============================================================================

# Installation options (set via command line flags)
BACKUP_DIR="/usr/local/etc/${PROJECT_NAME}_old_$(date +%s)"
LOG_FILE="/var/log/${PROJECT_NAME}-install.log"
LOG_MODE=false
SKIP_DEBS=false
LOCAL_DIR_MODE=false
PRESERVE_DATA=true
INSTALL_NODE=false
BUILD_MODE=false
BUILD_TAR=false
BUILD_CONFIG=false
BUILD_DIR="$REPO_DIR/build"

# External dependencies (uncomment and configure if needed)
# PM2_TAR_GZ="$ARCHIVE_DIR/pm2.tar.gz"              # Uncomment if using pm2
# PM2_EXTRACT_DIR="$INSTALL_DIR/vendor/pm2"         # Uncomment if using pm2

# =============================================================================
# BUILD SYSTEM FUNCTIONS
# =============================================================================

# Sanitize string for filesystem (remove/replace invalid characters)
sanitize_filename() {
    input="$1"
    # Replace spaces with underscores
    # Replace invalid filesystem characters with underscores
    # Keep only alphanumeric, dots, dashes, underscores
    sanitized=$(echo "$input" | tr ' ' '_' | sed 's/[^a-zA-Z0-9._-]/_/g' | sed 's/__*/_/g' | sed 's/^_//' | sed 's/_$//')
    
    # If empty after sanitization, use default
    [ -z "$sanitized" ] && sanitized="build"
    
    echo "$sanitized"
}

# Get last commit message and sanitize for filename
get_commit_filename() {
    if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
        commit_msg=$(git log -1 --pretty=%B 2>/dev/null | head -n1)
        if [ -n "$commit_msg" ]; then
            sanitize_filename "$commit_msg"
        else
            echo "initial_build"
        fi
    else
        echo "build_$(date +%Y%m%d_%H%M%S)"
    fi
}

# Interactive configuration interface for build exclusion
build_config_interface() {
    echo ""
    echo "========================================="
    echo "  BUILD CONFIGURATION"
    echo "========================================="
    echo ""
    echo "Select files to EXCLUDE from the build"
    echo "Files are sorted by size (largest first)"
    echo ""
    
    # Get list of files from last commit sorted by size
    if ! command -v git >/dev/null 2>&1 || ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: Not in a git repository"
        return 1
    fi
    
    # Create temp file for exclusion list
    EXCLUDE_LIST="/tmp/build_exclude_$$.txt"
    > "$EXCLUDE_LIST"
    
    # Create temp file for build files list
    BUILD_FILES_LIST="/tmp/build_files_$$.txt"
    > "$BUILD_FILES_LIST"
    
    # Get files from last commit with sizes
    git ls-tree -r -l HEAD 2>/dev/null | while IFS=' ' read -r mode type hash size filename; do
        # Skip if size is not available (it's a submodule or special)
        [ "$size" = "-" ] && size=0
        
        # Format size for display
        if [ "$size" -gt 1048576 ]; then
            size_display="$((size / 1048576))MB"
        elif [ "$size" -gt 1024 ]; then
            size_display="$((size / 1024))KB"
        else
            size_display="${size}B"
        fi
        
        # Determine if it's code or binary/data
        case "$filename" in
            *.js|*.sh|*.py|*.rb|*.php|*.ts|*.jsx|*.tsx|*.css|*.html|*.json|*.xml|*.yml|*.yaml|*.md|*.txt|*.conf|*.cfg|*.ini)
                file_type="CODE"
                ;;
            *)
                file_type="BINARY/DATA"
                ;;
        esac
        
        echo "$size|$filename|$file_type|$size_display" >> "$BUILD_FILES_LIST"
    done
    
    # Sort by size (largest first)
    sort -t'|' -k1 -n -r "$BUILD_FILES_LIST" > "${BUILD_FILES_LIST}.sorted"
    mv "${BUILD_FILES_LIST}.sorted" "$BUILD_FILES_LIST"
    
    # Interactive selection loop
    show_non_code=false
    
    while true; do
        clear
        echo "========================================="
        echo "  BUILD CONFIGURATION - EXCLUDE FILES"
        echo "========================================="
        echo ""
        [ "$show_non_code" = true ] && echo "Showing: ALL files (including non-code)" || echo "Showing: CODE files only (toggle with 't')"
        echo ""
        echo "Currently excluded files:"
        if [ -s "$EXCLUDE_LIST" ]; then
            cat "$EXCLUDE_LIST" | while IFS= read -r file; do
                echo "  ✗ $file"
            done
        else
            echo "  (none)"
        fi
        echo ""
        echo "Available files (largest first):"
        echo ""
        
        # Clear mapping file
        MAPPING_FILE="/tmp/build_mapping_$$.txt"
        > "$MAPPING_FILE"
        
        # Display files with numbers
        counter=1
        while IFS='|' read -r size file type size_display; do
            [ -z "$file" ] && continue
            
            # Apply filter
            if [ "$show_non_code" = false ] && [ "$type" = "BINARY/DATA" ]; then
                continue
            fi
            
            # Check if already excluded
            already_excluded=false
            if grep -q "^${file}$" "$EXCLUDE_LIST" 2>/dev/null; then
                already_excluded=true
            fi
            
            printf "%3d. [%s] %s - %s" "$counter" "$type" "$size_display" "$file"
            [ "$already_excluded" = true ] && printf " (EXCLUDED)"
            printf "\n"
            
            # Save mapping
            echo "$counter|$file" >> "$MAPPING_FILE"
            counter=$((counter + 1))
        done < "$BUILD_FILES_LIST"
        
        echo ""
        echo "Commands:"
        echo "  <number>  - Toggle exclusion for that file"
        echo "  t         - Toggle show/hide non-code files"
        echo "  a         - Exclude ALL currently shown files"
        echo "  c         - Clear all exclusions"
        echo "  d         - Done, continue with build"
        echo "  q         - Quit build process"
        echo ""
        printf "Enter command: "
        read cmd
        
        case "$cmd" in
            t)
                if [ "$show_non_code" = true ]; then
                    show_non_code=false
                else
                    show_non_code=true
                fi
                ;;
            a)
                # Exclude all shown files
                while IFS='|' read -r size file type size_display; do
                    [ -z "$file" ] && continue
                    if [ "$show_non_code" = false ] && [ "$type" = "BINARY/DATA" ]; then
                        continue
                    fi
                    if ! grep -q "^${file}$" "$EXCLUDE_LIST" 2>/dev/null; then
                        echo "$file" >> "$EXCLUDE_LIST"
                    fi
                done < "$BUILD_FILES_LIST"
                ;;
            c)
                > "$EXCLUDE_LIST"
                ;;
            d)
                break
                ;;
            q)
                rm -f "$EXCLUDE_LIST" "$BUILD_FILES_LIST" "$MAPPING_FILE"
                echo "Build cancelled."
                exit 0
                ;;
            *)
                if echo "$cmd" | grep -q '^[0-9]\+$'; then
                    # Find file by number
                    file_to_toggle=$(grep "^${cmd}|" "$MAPPING_FILE" 2>/dev/null | cut -d'|' -f2)
                    if [ -n "$file_to_toggle" ]; then
                        if grep -q "^${file_to_toggle}$" "$EXCLUDE_LIST" 2>/dev/null; then
                            # Remove from exclude list
                            grep -v "^${file_to_toggle}$" "$EXCLUDE_LIST" > "${EXCLUDE_LIST}.tmp" 2>/dev/null
                            mv "${EXCLUDE_LIST}.tmp" "$EXCLUDE_LIST" 2>/dev/null
                        else
                            # Add to exclude list
                            echo "$file_to_toggle" >> "$EXCLUDE_LIST"
                        fi
                    fi
                fi
                ;;
        esac
    done
    
    echo ""
    echo "Exclusion list created:"
    cat "$EXCLUDE_LIST" 2>/dev/null
    echo ""
    
    return 0
}

# Main build function
do_build() {
    log_message "Starting build process..."
    
    # Check if we're in a git repository
    if ! command -v git >/dev/null 2>&1 || ! git rev-parse --git-dir >/dev/null 2>&1; then
        log_message "Error: Not in a git repository. Build requires git."
        echo "Error: Build mode requires a git repository"
        exit 1
    fi
    
    # Use the directory where the script was called from
    build_base_dir="$REPO_DIR/build"
    mkdir -p "$build_base_dir"
    
    # Get sanitized commit message for naming
    build_name=$(get_commit_filename)
    build_path="$build_base_dir/$build_name"
    
    log_message "Build name: $build_name"
    log_message "Build path: $build_path"
    
    # Run configuration interface if requested
    if [ "$BUILD_CONFIG" = true ]; then
        build_config_interface
    fi
    
    # Create temporary directory for build
    temp_build="/tmp/build_$$"
    rm -rf "$temp_build"
    mkdir -p "$temp_build"
    
    # Get list of files from last commit and extract them
    log_message "Extracting files from last commit..."
    
    # Use git archive for efficient extraction
    if [ -f "$EXCLUDE_LIST" ] && [ -s "$EXCLUDE_LIST" ]; then
        # With exclusions: extract all then remove excluded
        git archive HEAD 2>/dev/null | (cd "$temp_build" && tar xf - 2>/dev/null)
        
        if [ $? -eq 0 ]; then
            # Remove excluded files
            while IFS= read -r excluded_file; do
                [ -z "$excluded_file" ] && continue
                if [ -e "$temp_build/$excluded_file" ]; then
                    rm -rf "$temp_build/$excluded_file"
                    log_message "  Excluded: $excluded_file"
                fi
            done < "$EXCLUDE_LIST"
            
            # Remove empty directories
            find "$temp_build" -type d -empty -delete 2>/dev/null
        else
            log_message "Error: Failed to extract files from git"
            echo "Error: Failed to extract files from git"
            rm -rf "$temp_build"
            exit 1
        fi
    else
        # No exclusions: simple archive extraction
        git archive HEAD 2>/dev/null | (cd "$temp_build" && tar xf - 2>/dev/null)
        
        if [ $? -ne 0 ]; then
            log_message "Error: Failed to extract files from git"
            echo "Error: Failed to extract files from git"
            rm -rf "$temp_build"
            exit 1
        fi
    fi
    
    # Count files
    file_count=$(find "$temp_build" -type f 2>/dev/null | wc -l)
    log_message "Extracted $file_count files"
    
    # Clean up temp files
    rm -f "$EXCLUDE_LIST" "$BUILD_FILES_LIST" "$MAPPING_FILE"
    
    # Create the build
    if [ "$BUILD_TAR" = true ]; then
        # Create tar.gz
        tar_file="$build_path.tar.gz"
        log_message "Creating tar.gz archive: $tar_file"
        
        # Remove existing archive if present
        [ -f "$tar_file" ] && rm -f "$tar_file"
        
        cd "$temp_build" || exit 1
        tar -czf "$tar_file" . 2>/dev/null
        
        if [ $? -eq 0 ]; then
            log_message "Build archive created successfully: $tar_file"
            echo ""
            echo "========================================="
            echo "  BUILD COMPLETE"
            echo "========================================="
            echo ""
            echo "Archive: $tar_file"
            echo "Size: $(ls -lh "$tar_file" | awk '{print $5}')"
            echo "Files: $file_count"
            echo ""
        else
            log_message "Error: Failed to create tar.gz archive"
            echo "Error: Failed to create archive"
            cd "$REPO_DIR" > /dev/null 2>&1
            rm -rf "$temp_build"
            exit 1
        fi
        
        cd "$REPO_DIR" > /dev/null 2>&1
        
        # Clean up temp directory
        rm -rf "$temp_build"
        
        # Add build info alongside the tar.gz
        cat > "${tar_file}.info" << EOF
Build Name: $build_name
Build Date: $(date)
Commit: $(git rev-parse HEAD 2>/dev/null)
Commit Message: $(git log -1 --pretty=%B 2>/dev/null)
Files: $file_count
EOF
    else
        # Create directory build
        log_message "Creating directory build: $build_path"
        
        # Remove existing if present
        [ -d "$build_path" ] && rm -rf "$build_path"
        
        mv "$temp_build" "$build_path"
        
        if [ $? -eq 0 ]; then
            log_message "Build directory created successfully: $build_path"
            
            # Add build info file
            cat > "$build_path/BUILD_INFO.txt" << EOF
Build Name: $build_name
Build Date: $(date)
Commit: $(git rev-parse HEAD 2>/dev/null)
Commit Message: $(git log -1 --pretty=%B 2>/dev/null)
Files: $file_count
EOF
            
            echo ""
            echo "========================================="
            echo "  BUILD COMPLETE"
            echo "========================================="
            echo ""
            echo "Directory: $build_path"
            echo "Files: $file_count"
            echo "Size: $(du -sh "$build_path" | awk '{print $1}')"
            echo ""
        else
            log_message "Error: Failed to create build directory"
            echo "Error: Failed to create build directory"
            rm -rf "$temp_build"
            exit 1
        fi
    fi
    
    log_message "Build process completed"
    exit 0
}

# =============================================================================
# FUNCTION DEFINITIONS (Ash-compatible versions)
# =============================================================================

show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo "Install $PROJECT_NAME - $PROJECT_DESCRIPTION"
    echo
    echo "Options:"
    echo "  -h, --help       Show this help"
    echo "  -log             Enable installation logging"
    echo "  --skip-debs      Skip .deb package installation"
    echo "  --local-dir      Run commands from current directory"
    echo "  --no-preserve    Don't preserve files during update"
    echo "  --node           Auto-install Node.js if missing (requires internet)"
    echo "  --nodejs         Same as --node"
    echo "  --build          Create a build from the last commit"
    echo "  --tar            Create a tar.gz archive (use with --build)"
    echo "  --config         Interactive file exclusion (use with --build)"
    echo
    echo "Build examples:"
    echo "  $0 --build                    Create build directory from last commit"
    echo "  $0 --build --tar              Create tar.gz archive from last commit"
    echo "  $0 --build --config           Interactive exclusion before directory build"
    echo "  $0 --build --tar --config     Interactive exclusion before tar.gz build"
    echo
    echo "Commands will be created for:"
    
    # Display Node.js commands
    for cmd in $NODE_ENTRY_POINTS_CMD; do
        echo "  $cmd"
    done
    
    # Display Shell script commands
    if [ -n "$SHELL_SCRIPTS_CMD" ]; then
        for cmd in $SHELL_SCRIPTS_CMD; do
            echo "  $cmd (shell script)"
        done
    fi
    
    echo "  wsave"
    echo "  git-config"
    echo
    echo "Working directory configuration:"
    
    # Display working directories for Node.js commands
    for cmd in $NODE_ENTRY_POINTS_CMD; do
        working_dir=$(get_command_working_dir "$cmd")
        echo "  $cmd: $working_dir"
    done
    
    # Display working directories for Shell commands
    if [ -n "$SHELL_SCRIPTS_CMD" ]; then
        for cmd in $SHELL_SCRIPTS_CMD; do
            working_dir=$(get_command_working_dir "$cmd")
            echo "  $cmd: $working_dir (bash→ash fallback)"
        done
    fi
    
    echo "  git-config: global"
    echo
    echo "pkg command features:"
    echo "  pkg start                    Create package.json (if missing) with version 0.0.1 and type:module"
    echo "  pkg run <script> [args...]   Run npm script from any package.json with arguments"
    echo "  pkg version <type|ver>        Update version (major|minor|patch|X.Y.Z) and git commit"
    echo
    echo "pack command features:"
    echo "  pack [path1] [path2] ...     Compare directories and show differences"
    echo "  Examples:"
    echo "    pack path/to/project              Compare single directory with itself"
    echo "    pack path/to/one path/to/two      Compare two directories"
    echo "    pack path/one path/two path/three Compare multiple directories"
    exit 0
}

detect_ubuntu_variant() {
    if command -v dpkg >/dev/null 2>&1 && dpkg -l 2>/dev/null | grep -q ubuntu-desktop; then
        echo "desktop"
    else
        echo "server"
    fi
}

# Detect Linux distribution for package management
detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        echo "$ID"
    elif [ -f /etc/debian_version ]; then
        echo "debian"
    elif [ -f /etc/redhat-release ]; then
        echo "rhel"
    elif [ -f /etc/arch-release ]; then
        echo "arch"
    else
        echo "unknown"
    fi
}

# Check for internet connectivity
check_internet() {
    log_message "Checking internet connectivity..."
    if command -v wget >/dev/null 2>&1; then
        wget -q --spider http://google.com 2>/dev/null && return 0
    elif command -v curl >/dev/null 2>&1; then
        curl -s --head http://google.com >/dev/null 2>&1 && return 0
    elif command -v ping >/dev/null 2>&1; then
        ping -c 1 -W 2 google.com >/dev/null 2>&1 && return 0
    fi
    return 1
}

# Check if Node.js is installed
check_node() {
    if command -v node >/dev/null 2>&1; then
        node_version=$(node --version 2>/dev/null)
        log_message "Node.js is already installed: $node_version"
        return 0
    else
        log_message "Node.js is not installed"
        return 1
    fi
}

# =============================================================================
# NODE.JS INSTALLATION FUNCTIONS
# Pattern: Try direct install first → if fails, update → retry install
# =============================================================================

# Install Node.js using apt (Ubuntu/Debian/Mint/Pop/Elementary/Zorin)
install_nodejs_apt() {
    echo "Attempting direct Node.js installation..."
    
    # Try direct install first
    if sudo apt install -y nodejs 2>/dev/null; then
        echo "Node.js installed successfully"
        return 0
    fi
    
    # Direct install failed - update package lists and retry
    echo "Direct installation failed. Updating package lists..."
    if sudo apt update 2>/dev/null; then
        echo "Package lists updated. Retrying Node.js installation..."
        if sudo apt install -y nodejs 2>/dev/null; then
            echo "Node.js installed successfully after update"
            return 0
        fi
    fi
    
    echo "Failed to install Node.js after update"
    return 1
}

# Install Node.js using dnf (Fedora/RHEL 8+/CentOS 8+/Rocky/AlmaLinux)
install_nodejs_dnf() {
    echo "Attempting direct Node.js installation with DNF..."
    
    # Try direct install first
    if sudo dnf install -y nodejs 2>/dev/null; then
        echo "Node.js installed successfully"
        return 0
    fi
    
    # Direct install failed - update metadata and retry
    echo "Direct installation failed. Updating package metadata..."
    if sudo dnf makecache 2>/dev/null; then
        echo "Metadata updated. Retrying Node.js installation..."
        if sudo dnf install -y nodejs 2>/dev/null; then
            echo "Node.js installed successfully after update"
            return 0
        fi
    fi
    
    echo "Failed to install Node.js after update"
    return 1
}

# Install Node.js using yum (RHEL/CentOS 7 and older)
install_nodejs_yum() {
    echo "Attempting direct Node.js installation with YUM..."
    
    # Try direct install first
    if sudo yum install -y nodejs 2>/dev/null; then
        echo "Node.js installed successfully"
        return 0
    fi
    
    # Direct install failed - update metadata and retry
    echo "Direct installation failed. Updating package metadata..."
    if sudo yum makecache 2>/dev/null; then
        echo "Metadata updated. Retrying Node.js installation..."
        if sudo yum install -y nodejs 2>/dev/null; then
            echo "Node.js installed successfully after update"
            return 0
        fi
    fi
    
    echo "Failed to install Node.js after update"
    return 1
}

# Install Node.js using pacman (Arch/Manjaro/EndeavourOS)
install_nodejs_pacman() {
    echo "Attempting direct Node.js installation with Pacman..."
    
    # Try direct install first
    if sudo pacman -S --noconfirm nodejs 2>/dev/null; then
        echo "Node.js installed successfully"
        return 0
    fi
    
    # Direct install failed - sync databases and retry
    echo "Direct installation failed. Syncing package databases..."
    if sudo pacman -Sy 2>/dev/null; then
        echo "Databases synced. Retrying Node.js installation..."
        if sudo pacman -S --noconfirm nodejs 2>/dev/null; then
            echo "Node.js installed successfully after sync"
            return 0
        fi
    fi
    
    echo "Failed to install Node.js after sync"
    return 1
}

# Install Node.js using zypper (openSUSE/SUSE)
install_nodejs_zypper() {
    echo "Attempting direct Node.js installation with Zypper..."
    
    # Try direct install first
    if sudo zypper install -y nodejs 2>/dev/null; then
        echo "Node.js installed successfully"
        return 0
    fi
    
    # Direct install failed - refresh repositories and retry
    echo "Direct installation failed. Refreshing repositories..."
    if sudo zypper refresh 2>/dev/null; then
        echo "Repositories refreshed. Retrying Node.js installation..."
        if sudo zypper install -y nodejs 2>/dev/null; then
            echo "Node.js installed successfully after refresh"
            return 0
        fi
    fi
    
    echo "Failed to install Node.js after refresh"
    return 1
}

# Install Node.js using apk (Alpine Linux)
install_nodejs_apk() {
    echo "Attempting direct Node.js installation with APK..."
    
    # Determine apk command (with or without sudo)
    if [ "$(id -u)" = "0" ]; then
        APK_CMD="apk"
    elif command -v sudo >/dev/null 2>&1; then
        APK_CMD="sudo apk"
    else
        echo "Error: Need root privileges to install packages"
        echo "Please run as root or install sudo"
        return 1
    fi
    
    # Try direct install first
    if $APK_CMD add nodejs npm 2>/dev/null; then
        echo "Node.js installed successfully"
        return 0
    fi
    
    # Direct install failed - update index and retry
    echo "Direct installation failed. Updating package index..."
    if $APK_CMD update 2>/dev/null; then
        echo "Package index updated. Retrying Node.js installation..."
        if $APK_CMD add nodejs npm 2>/dev/null; then
            echo "Node.js installed successfully after update"
            return 0
        fi
    fi
    
    echo "Failed to install Node.js after update"
    return 1
}

# =============================================================================
# MAIN NODE.JS INSTALLATION ROUTER
# =============================================================================

# Install Node.js based on detected distribution
install_nodejs() {
    distro=$(detect_distro)
    log_message "Detected Linux distribution: $distro"
    
    case "$distro" in
        ubuntu|debian|linuxmint|pop|elementary|zorin)
            log_message "Installing Node.js using apt..."
            install_nodejs_apt
            return $?
            ;;
        rhel|centos|fedora|rocky|almalinux)
            # Check if system uses dnf (newer) or yum (older)
            if command -v dnf >/dev/null 2>&1; then
                log_message "Installing Node.js using dnf..."
                install_nodejs_dnf
            else
                log_message "Installing Node.js using yum..."
                install_nodejs_yum
            fi
            return $?
            ;;
        arch|manjaro|endeavouros)
            log_message "Installing Node.js using pacman..."
            install_nodejs_pacman
            return $?
            ;;
        opensuse*|suse)
            log_message "Installing Node.js using zypper..."
            install_nodejs_zypper
            return $?
            ;;
        alpine)
            log_message "Installing Node.js using apk..."
            install_nodejs_apk
            return $?
            ;;
        *)
            log_message "Unknown distribution. Cannot install Node.js automatically"
            log_message "Please install Node.js manually from: https://nodejs.org/"
            return 1
            ;;
    esac
}

# =============================================================================
# NODE.JS INSTALLATION ENTRY POINT
# =============================================================================

# Check and install Node.js if requested
ensure_nodejs() {
    [ "$INSTALL_NODE" = false ] && return 0
    
    log_message "========================================="
    log_message "Node.js installation check requested (--node/--nodejs flag detected)"
    log_message "========================================="
    
    # First check if node is already installed
    if check_node; then
        log_message "Node.js is already installed"
        return 0
    fi
    
    echo ""
    echo "========================================="
    echo "  Node.js Installation"
    echo "========================================="
    echo ""
    
    # Node.js is not installed, check internet connectivity
    if ! check_internet; then
        log_message "No internet connection detected"
        log_message "Skipping Node.js installation - proceeding with normal installation"
        echo "Warning: No internet connection. Skipping Node.js installation."
        return 0
    fi
    
    # Internet is available, install Node.js
    log_message "Internet connection detected. Starting Node.js installation..."
    echo "Starting download and installation of Node.js..."
    echo "This may take a few minutes depending on your internet speed."
    echo ""
    
    if install_nodejs; then
        echo ""
        log_message "Node.js installation completed successfully"
        # Verify installation
        if check_node; then
            node_version=$(node --version 2>/dev/null)
            npm_version=$(npm --version 2>/dev/null)
            echo "✓ Node.js $node_version installed successfully"
            [ -n "$npm_version" ] && echo "✓ npm $npm_version installed successfully"
            return 0
        else
            log_message "Warning: Node.js installation completed but verification failed"
            echo "Warning: Node.js may not be properly installed"
            log_message "Continuing with installation anyway..."
            return 0
        fi
    else
        echo ""
        log_message "Warning: Failed to install Node.js"
        echo "Warning: Could not install Node.js automatically"
        log_message "Continuing with installation anyway..."
        return 0
    fi
}

log_message() {
    message="$1"
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    if [ "$LOG_MODE" = true ]; then
        echo "[$timestamp] $message" | tee -a "$LOG_FILE"
    else
        echo "[$timestamp] $message"
    fi
}

show_progress() {
    message="$1"
    pid="$2"
    
    # Simple progress indicator without fancy input
    if [ -t 0 ]; then
        while kill -0 $pid 2>/dev/null; do
            printf "%s...\r" "$message"
            sleep 1
        done
        wait $pid 2>/dev/null || true
        printf "\n%s completed.\n" "$message"
    else
        wait $pid 2>/dev/null || true
        printf "%s completed.\n" "$message"
    fi
}

install_debs() {
    [ "$SKIP_DEBS" = true ] && return 0
    [ -z "$DEB_DIR" ] && return 0

    variant=$(detect_ubuntu_variant)
    deb_dir="$DEB_DIR"
    
    [ "$variant" = "server" ] && [ -n "$DEB_SERVER_DIR" ] && deb_dir="$DEB_SERVER_DIR"
    [ ! -d "$deb_dir" ] && return 0

    # Find .deb files
    deb_files=""
    for file in "$deb_dir"/*.deb; do
        [ -e "$file" ] && deb_files="$deb_files $file"
    done
    
    [ -z "$deb_files" ] && return 0

    log_message "Installing .deb packages..."
    if [ "$LOG_MODE" = true ]; then
        sudo dpkg -i $deb_files 2>&1 | tee -a "$LOG_FILE" &
    else
        sudo dpkg -i $deb_files > /dev/null 2>&1 &
    fi
    
    show_progress "Installing packages" $!
    return $?
}

copy_files() {
    src_dir="$1"
    dest_dir="$2"

    mkdir -p "$dest_dir"
    log_message "Copying files to $dest_dir..."

    # Create a simple copy function without rsync
    copy_with_progress() {
        # Count total files for progress (approx)
        total_files=0
        if [ -d "$src_dir" ]; then
            # Simple file count - won't work perfectly for complex structures but good enough
            total_files=$(find "$src_dir" -type f -not -path '*/\.git/*' | wc -l)
        fi
        
        # Copy files recursively
        if [ "$LOG_MODE" = true ]; then
            (cd "$src_dir" && find . -type f -not -path '*/\.git/*' -exec cp --parents {} "$dest_dir" \; 2>&1 | tee -a "$LOG_FILE") &
        else
            (cd "$src_dir" && find . -type f -not -path '*/\.git/*' -exec cp --parents {} "$dest_dir" \; > /dev/null 2>&1) &
        fi
        
        echo $!
    }
    
    pid=$(copy_with_progress)
    show_progress "Copying files" $pid
    return $?
}

remove_links() {
    # Convert space-separated list to lines for processing
    echo "$NODE_ENTRY_POINTS_CMD" | tr ' ' '\n' | while read cmd; do
        [ -z "$cmd" ] && continue
        dest_path="$BIN_DIR/$cmd"
        [ -L "$dest_path" ] && rm -f "$dest_path"
    done
    
    # Remove shell script command links
    if [ -n "$SHELL_SCRIPTS_CMD" ]; then
        echo "$SHELL_SCRIPTS_CMD" | tr ' ' '\n' | while read cmd; do
            [ -z "$cmd" ] && continue
            dest_path="$BIN_DIR/$cmd"
            [ -L "$dest_path" ] && rm -f "$dest_path"
        done
    fi
    
    # Remove wsave link
    [ -L "$BIN_DIR/wsave" ] && rm -f "$BIN_DIR/wsave"
    
    # Remove git-config link
    [ -L "$BIN_DIR/git-config" ] && rm -f "$BIN_DIR/git-config"
    
    # Clean up shell wrappers
    [ -d "$INSTALL_DIR/wrappers" ] && rm -rf "$INSTALL_DIR/wrappers"
}

# =============================================================================
# PRESERVATION PATTERN MATCHING
# =============================================================================
# Check if a path matches any preservation pattern
# Handles: exact file paths, directory paths, directory name patterns, and filename patterns
#
matches_pattern() {
    rel_path="$1"      # Relative path from installation root (e.g., "._/._/._/Qemu/qemu.sh")
    pattern="$2"       # Pattern to match against
    
    filename=$(basename "$rel_path")
    dirname=$(dirname "$rel_path")
    
    # CASE 1: Pattern ends with / → EXACT DIRECTORY path
    # Example: "config/" matches config/ and everything inside
    case "$pattern" in
        */)
            case "$rel_path" in
                "${pattern}"*) return 0 ;;
            esac
            return 1
            ;;
    esac
    
    # CASE 2: Pattern contains / → EXACT FILE path
    # Example: "._/._/._/Qemu/qemu.sh" matches only that exact file
    case "$pattern" in
        */*)
            [ "$rel_path" = "$pattern" ] && return 0
            return 1
            ;;
    esac
    
    # CASE 3: DIRECTORY NAME pattern (check if ANY directory in path starts with pattern)
    # Walk up the path checking each directory component
    check_path="$rel_path"
    while [ "$check_path" != "." ] && [ -n "$check_path" ]; do
        check_dir=$(basename "$check_path")
        case "$check_dir" in
            "${pattern}"*)
                return 0
                ;;
        esac
        check_path=$(dirname "$check_path")
    done
    
    # CASE 4: FILENAME pattern
    # Uses underscore as separator: "start_end", "start_", "_end", or "word"
    case "$pattern" in
        *_*)
            start="${pattern%_*}"
            end="${pattern#*_}"
            
            if [ -n "$start" ] && [ -n "$end" ]; then
                # 4c: BOTH start AND end → "start_end"
                base="${filename%.*}"
                case "$base" in
                    "${start}"*"${end}") return 0 ;;
                esac
                case "$filename" in
                    "${start}"*"${end}") return 0 ;;
                esac
            elif [ -n "$start" ]; then
                # 4a: START only → "start_"
                case "$filename" in
                    "${start}"*) return 0 ;;
                esac
            else
                # 4b: END only → "_end"
                base="${filename%.*}"
                case "$base" in
                    *"${end}") return 0 ;;
                esac
                case "$filename" in
                    *"${end}") return 0 ;;
                esac
            fi
            ;;
        *)
            # 4d: No underscore - match BOTH filename AND directory name starting with pattern
            case "$filename" in
                "${pattern}"*) return 0 ;;
            esac
            ;;
    esac
    
    return 1
}

preserve_files_from_backup() {
    [ "$PRESERVE_DATA" = false ] && return 0
    [ ! -d "$BACKUP_DIR" ] && return 0
    [ -z "$PRESERVATION_WHITELIST" ] && return 0

    log_message "Restoring preserved files with duplicate detection..."
    log_message "Active patterns: $PRESERVATION_WHITELIST"
    
    # Walk through ALL files AND directories in backup
    find "$BACKUP_DIR" \( -type f -o -type d \) 2>/dev/null | while IFS= read -r source_path; do
        rel_path="${source_path#$BACKUP_DIR/}"
        [ -z "$rel_path" ] && continue
        
        # Skip the root directory itself
        [ "$source_path" = "$BACKUP_DIR" ] && continue
        
        # Check against each pattern
        for pattern in $PRESERVATION_WHITELIST; do
            if matches_pattern "$rel_path" "$pattern"; then
                dest_path="$INSTALL_DIR/$rel_path"
                
                if [ -d "$source_path" ]; then
                    # It's a directory - just ensure it exists
                    if [ ! -d "$dest_path" ]; then
                        mkdir -p "$dest_path"
                        log_message "  [DIR] Preserved directory: $rel_path"
                    fi
                else
                    # It's a file
                    if [ -e "$dest_path" ]; then
                        log_message "  [KEEP] $rel_path (exists in both, keeping backup version)"
                        rm -rf "$dest_path"
                    else
                        log_message "  [RESTORE] $rel_path (only in backup)"
                    fi
                    mkdir -p "$(dirname "$dest_path")"
                    cp -pr "$source_path" "$dest_path" 2>/dev/null || true
                fi
                break
            fi
        done
    done
    
    rm -rf "$BACKUP_DIR"
}

extract_archive() {
    archive_file="$1"
    extract_dir="$2"
    
    [ ! -f "$archive_file" ] && return 0

    log_message "Extracting $(basename $archive_file)..."
    mkdir -p "$extract_dir"
    tar -xzf "$archive_file" -C "$extract_dir" --strip-components=1 2>/dev/null
}

create_pkg_cli() {
    install_dir="$1"
    pkg_cli_path="$install_dir/pkg-cli.js"
    
    log_message "Creating enhanced pkg CLI utility with start command that creates minimal package.json..."
    
    # Always remove existing pkg-cli.js to ensure fresh creation
    if [ -f "$pkg_cli_path" ]; then
        rm -f "$pkg_cli_path"
    fi
    
    # Create the enhanced pkg CLI JavaScript file with ES module syntax
    cat > "$pkg_cli_path" << 'PKG_EOF'
#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

// Get the caller's current working directory
const callerCwd = process.cwd();
const packageJsonPath = path.join(callerCwd, 'package.json');

// Terminal cleanup utilities
function cleanupTerminal() {
    try {
        // Reset terminal modes
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        
        // Show cursor and reset terminal
        process.stdout.write('\x1b[?25h'); // Show cursor
        process.stdout.write('\x1b[0m');   // Reset colors
        process.stdout.write('\x1b[?1000l'); // Disable mouse tracking
        process.stdout.write('\x1b[?1002l');
        process.stdout.write('\x1b[?1003l');
        process.stdout.write('\x1b[?1006l');
    } catch (error) {
        // Ignore cleanup errors
    }
}

function readPackageJson() {
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

function createMinimalPackageJson() {
  const packageJson = {
    version: "0.0.1",
    type: "module"
  };
  
  try {
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    console.log(`✓ Created package.json with version 0.0.1 and type:module in ${callerCwd}`);
    return packageJson;
  } catch (error) {
    console.error(`Error creating package.json: ${error.message}`);
    process.exit(1);
  }
}

function start() {
  const existingPackageJson = readPackageJson();
  
  if (!existingPackageJson) {
    // No package.json exists - create it
    createMinimalPackageJson();
    return;
  }
  
  // Package.json exists - check if type needs updating
  let modified = false;
  let updateMessage = [];
  
  // Check if type exists and is not "module"
  if (!existingPackageJson.type || existingPackageJson.type !== "module") {
    existingPackageJson.type = "module";
    modified = true;
    updateMessage.push("Added/updated type: 'module'");
  }
  
  // Also ensure version exists for consistency
  if (!existingPackageJson.version) {
    existingPackageJson.version = "0.0.1";
    modified = true;
    updateMessage.push("Added version: 0.0.1");
  }
  
  if (modified) {
    try {
      fs.writeFileSync(packageJsonPath, JSON.stringify(existingPackageJson, null, 2));
      console.log(`✓ Updated package.json in ${callerCwd}:`);
      updateMessage.forEach(msg => console.log(`  • ${msg}`));
    } catch (error) {
      console.error(`Error updating package.json: ${error.message}`);
      process.exit(1);
    }
  } else {
    console.log(`package.json already exists in ${callerCwd} with type:module and version: ${existingPackageJson.version || '0.0.1'}`);
  }
}

async function runScript(scriptName, ...scriptArgs) {
  const packageJson = readPackageJson();
  
  if (!packageJson) {
    console.error(`Error: No package.json found in ${callerCwd}`);
    console.error(`Run 'pkg start' first to create one, or ensure you're in a project with package.json`);
    process.exit(1);
  }
  
  if (!packageJson.scripts || !packageJson.scripts[scriptName]) {
    console.error(`Script "${scriptName}" not found in package.json`);
    console.error(`Available scripts: ${Object.keys(packageJson.scripts || {}).join(', ') || 'None'}`);
    process.exit(1);
  }
  
  const command = packageJson.scripts[scriptName];
  
  // Check if the script uses npm run or similar pattern
  let fullCommand;
  if (command.startsWith('npm ') || command.startsWith('yarn ') || command.startsWith('pnpm ')) {
    // For npm/yarn/pnpm commands, append our args
    fullCommand = `${command} ${scriptArgs.join(' ')}`.trim();
  } else {
    // For other commands, pass args directly
    fullCommand = `${command} ${scriptArgs.join(' ')}`.trim();
  }
  
  console.log(`Running: ${fullCommand}`);
  
  try {
    // Use spawn to preserve colors and real-time output
    const child = spawn(fullCommand, {
      shell: true,
      stdio: 'inherit',
      cwd: callerCwd,
      detached: false  // Changed to false for better signal handling
    });
    
    // Set up signal handlers for proper cleanup
    const signalHandler = (signal) => {
        cleanupTerminal();
        if (!child.killed) {
            child.kill(signal);
        }
    };
    
    // Listen for termination signals
    process.on('SIGINT', () => signalHandler('SIGINT'));
    process.on('SIGTERM', () => signalHandler('SIGTERM'));
    process.on('SIGHUP', () => signalHandler('SIGHUP'));
    
    return new Promise((resolve, reject) => {
        child.on('close', (code, signal) => {
            // Clean up terminal before exiting
            cleanupTerminal();
            
            // Remove signal listeners
            process.removeAllListeners('SIGINT');
            process.removeAllListeners('SIGTERM');
            process.removeAllListeners('SIGHUP');
            
            if (signal === 'SIGINT') {
                console.log('\nProcess terminated by user');
                process.exit(0);
            } else {
                process.exit(code || 0);
            }
        });
        
        child.on('error', (error) => {
            cleanupTerminal();
            console.error(`Error running script: ${error.message}`);
            process.exit(1);
        });
    });
  } catch (error) {
    cleanupTerminal();
    console.error(`Error running script: ${error.message}`);
    process.exit(1);
  }
}

function bumpVersion(bumpType) {
  const packageJson = readPackageJson();
  
  if (!packageJson) {
    console.error(`Error: No package.json found in ${callerCwd}`);
    console.error(`Run 'pkg start' first to create one`);
    process.exit(1);
  }
  
  const currentVersion = packageJson.version || '0.0.0';
  
  // Parse current version
  const versionParts = currentVersion.split('.');
  if (versionParts.length < 3) {
    console.error(`Invalid current version format: ${currentVersion}`);
    console.error('Expected format: major.minor.patch');
    process.exit(1);
  }
  
  let major = parseInt(versionParts[0]) || 0;
  let minor = parseInt(versionParts[1]) || 0;
  let patch = parseInt(versionParts[2]) || 0;
  
  // Handle prerelease versions
  const prereleaseMatch = versionParts[2].match(/^(\d+)(-.+)?$/);
  if (prereleaseMatch) {
    patch = parseInt(prereleaseMatch[1]) || 0;
  }
  
  // Bump version based on type
  let newVersion;
  switch (bumpType) {
    case 'major':
      major += 1;
      minor = 0;
      patch = 0;
      newVersion = `${major}.${minor}.${patch}`;
      break;
      
    case 'minor':
      minor += 1;
      patch = 0;
      newVersion = `${major}.${minor}.${patch}`;
      break;
      
    case 'patch':
      patch += 1;
      newVersion = `${major}.${minor}.${patch}`;
      break;
      
    default:
      // Assume it's a direct version string
      const versionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
      if (!versionRegex.test(bumpType)) {
        console.error(`Invalid version: ${bumpType}`);
        console.error('Use: major, minor, patch, or X.Y.Z format');
        process.exit(1);
      }
      newVersion = bumpType;
  }
  
  return updateVersion(packageJson, newVersion);
}

async function updateVersion(packageJson, newVersion) {
  packageJson.version = newVersion;
  
  try {
    // Update package.json
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    
    // Git operations
    try {
      // Check if we're in a git repository
      execSync('git rev-parse --is-inside-work-tree', { cwd: callerCwd, stdio: 'ignore' });
      
      // Add package.json to git
      execSync('git add package.json', { cwd: callerCwd, stdio: 'pipe' });
      
      // Create commit
      const commitMessage = `${newVersion}`;
      execSync(`git commit -m "${commitMessage}"`, { cwd: callerCwd, stdio: 'pipe' });
      
      console.log(`${commitMessage}`);
      
      execSync(`git tag -a v${newVersion} -m "Version ${newVersion}"`, { 
        cwd: callerCwd, 
        stdio: 'pipe' 
      });
      //console.log(`Created git tag: v${newVersion}`);
           
    } catch (gitError) {
      console.log('Not a git repository or git not available. Skipping git operations.');
    }
    
  } catch (error) {
    console.error(`Error updating version: ${error.message}`);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
pkg - Generic package.json utility

Usage: pkg <command> [options]

Commands:
  start                  Create/ensure package.json has version 0.0.1 and type:module
  run <script> [args...]  Run any script from package.json with arguments
  version <type|ver>      Update version and create git commit
  
Arguments:
  For 'start' command:
    No arguments - creates package.json if missing, or adds/updates type:module if needed
  
  For 'run' command:
    <script>              Script name from package.json scripts section
    [args...]            Arguments to pass to the script
  
  For 'version' command:
    major                 Bump major version (X+1.0.0)
    minor                 Bump minor version (X.Y+1.0)
    patch                 Bump patch version (X.Y.Z+1)
    <X.Y.Z>              Set specific version (e.g., 1.2.3)
    <X.Y.Z-prerelease>    Set version with prerelease tag

Examples:
  pkg start               Create package.json with version 0.0.1 and type:module, or update existing
  pkg run test            Run the 'test' script from package.json
  pkg run build           Run the 'build' script from package.json
  pkg run dev --port 3000 Run 'dev' script with --port argument
  pkg run test --watch    Run 'test' script with --watch argument
  pkg version patch       Bump patch version (1.2.3 -> 1.2.4)
  pkg version minor       Bump minor version (1.2.3 -> 1.3.0)
  pkg version major       Bump major version (1.2.3 -> 2.0.0)
  pkg version 2.1.0       Set version to 2.1.0
  pkg version 1.0.0-beta.1  Set version to 1.0.0-beta.1

Working directory: ${callerCwd}
  `);
}

// Main CLI logic
async function main() {
  // Set up global cleanup for unexpected exits
  process.on('uncaughtException', (error) => {
    cleanupTerminal();
    console.error('Uncaught Exception:', error.message);
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    cleanupTerminal();
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
  
  // Clean up terminal on normal exit
  process.on('exit', () => {
    cleanupTerminal();
  });
  
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }
  
  const command = args[0];
  
  switch (command) {
    case 'start':
      start();
      break;
      
    case 'run':
      if (args.length < 2) {
        console.error('Usage: pkg run <script-name> [script-args...]');
        process.exit(1);
      }
      await runScript(args[1], ...args.slice(2));
      break;
      
    case 'version':
      if (args.length < 2) {
        console.error('Usage: pkg version <type|version>');
        console.error('Type: major, minor, patch, or specific version X.Y.Z');
        process.exit(1);
      }
      await bumpVersion(args[1]);
      break;
      
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
      
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Use "pkg help" for usage information');
      process.exit(1);
  }
}

// Run the CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    cleanupTerminal();
    console.error(`Unhandled error: ${error.message}`);
    process.exit(1);
  });
}
PKG_EOF
    
    chmod +x "$pkg_cli_path"
    log_message "Created enhanced pkg CLI utility at $pkg_cli_path"
}

create_wsave_cli() {
    install_dir="$1"
    wsave_path="$install_dir/wsave"
    
    log_message "Creating wsave CLI utility for totally silent VSCode permission fixes..."
    
    if [ -f "$wsave_path" ]; then
        rm -f "$wsave_path"
    fi
    
    # Create the shell script for wsave (totally silent mode)
    cat > "$wsave_path" << 'WSAVE_EOF'
#!/bin/sh
USERNAME="${SUDO_USER:-${USER:-$(whoami)}}"
TARGET_DIR="/home"

# 1. THE GIT-SAFE COMMAND (Totally Silent)
chown -R "$USERNAME:$USERNAME" "$TARGET_DIR" >/dev/null 2>&1 || sudo -n chown -R "$USERNAME:$USERNAME" "$TARGET_DIR" >/dev/null 2>&1
chmod -R u+rwX "$TARGET_DIR" >/dev/null 2>&1 || sudo -n chmod -R u+rwX "$TARGET_DIR" >/dev/null 2>&1

# 2. THE GIT-SAFE BACKGROUND SWEEPER
CRON_CMD="*/5 * * * * chown -R $USERNAME:$USERNAME $TARGET_DIR 2>/dev/null; chmod -R u+rwX $TARGET_DIR 2>/dev/null"
echo "$CRON_CMD" | sudo -n tee /etc/cron.d/vscode-permissions-home >/dev/null 2>&1 || true
WSAVE_EOF
    
    chmod +x "$wsave_path"
}

create_git_config_command() {
    install_dir="$1"
    
    log_message "Creating git-config command that finds Git.js anywhere in installation tree..."
    
    # Create wrapper that finds Git.js dynamically and ensures proper exit
    git_config_wrapper="$install_dir/wrappers/git-config"
    mkdir -p "$(dirname "$git_config_wrapper")"
    
    cat > "$git_config_wrapper" << 'EOF'
#!/bin/sh
# Find Git.js anywhere in the installation directory
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GIT_JS=$(find "$INSTALL_DIR" -name "Git.js" -type f | head -1)

if [ -z "$GIT_JS" ]; then
    echo "Error: Git.js not found in installation directory" >&2
    exit 1
fi

# Change to installation directory
cd "$INSTALL_DIR" || exit 1

# Use exec to replace the shell process with Node.js
# This ensures proper signal handling and process termination
exec node "$GIT_JS" --setup "$@"
EOF
    
    chmod +x "$git_config_wrapper"
    
    # Create symlink in bin directory
    [ -L "$BIN_DIR/git-config" ] && rm -f "$BIN_DIR/git-config"
    ln -sf "$git_config_wrapper" "$BIN_DIR/git-config"
    
    log_message "Created git-config command that finds Git.js dynamically"
}

create_shell_command_links() {
    install_dir="$1"
    
    # Skip if no shell scripts configured
    [ -z "$SHELL_SCRIPTS_SRC" ] && return 0
    
    log_message "Creating shell script command wrappers with bash→ash fallback..."
    
    # Process each pair: source_file command_name
    src_idx=1
    for src in $SHELL_SCRIPTS_SRC; do
        # Find matching command name by position
        cmd_idx=1
        command_name=""
        for cmd in $SHELL_SCRIPTS_CMD; do
            [ "$cmd_idx" = "$src_idx" ] && command_name="$cmd" && break
            cmd_idx=$((cmd_idx + 1))
        done
        src_idx=$((src_idx + 1))
        
        [ -z "$command_name" ] && continue
        
        src_path="$install_dir/$src"
        
        # Validate source file exists
        if [ ! -f "$src_path" ]; then
            log_message "Warning: Shell script source not found: $src_path"
            continue
        fi
        
        chmod +x "$src_path" 2>/dev/null || true
        working_dir=$(get_command_working_dir "$command_name")
        
        # Create wrapper directory
        wrapper_dir="$install_dir/wrappers"
        mkdir -p "$wrapper_dir"
        
        # =====================================================================
        # STEP 1: Create shell wrapper with bash→ash→sh fallback
        # =====================================================================
        shell_wrapper="$wrapper_dir/${command_name}.sh"
        
        cat > "$shell_wrapper" << 'SHELL_FALLBACK_EOF'
#!/bin/sh
# =====================================================================
# AUTO-GENERATED SHELL WRAPPER
# Provides automatic bash → ash → sh fallback
# =====================================================================
if command -v bash >/dev/null 2>&1; then
    exec bash "SCRIPT_PATH_PLACEHOLDER" "$@"
elif command -v ash >/dev/null 2>&1; then
    exec ash "SCRIPT_PATH_PLACEHOLDER" "$@"
else
    exec sh "SCRIPT_PATH_PLACEHOLDER" "$@"
fi
SHELL_FALLBACK_EOF
        
        # Insert actual script path
        sed -i "s|SCRIPT_PATH_PLACEHOLDER|${src_path}|g" "$shell_wrapper"
        chmod +x "$shell_wrapper"
        
        # =====================================================================
        # STEP 2: Create public command wrapper with working directory logic
        # =====================================================================
        command_wrapper="$wrapper_dir/$command_name"
        
        case "$working_dir" in
            "caller")
                # Mode: Execute from user's current directory
                cat > "$command_wrapper" << CALLER_MODE
#!/bin/sh
# Command: $command_name
# Type: Shell script (bash→ash fallback)
# Working directory: caller's current directory
exec "$shell_wrapper" "\$@"
CALLER_MODE
                ;;
            "file")
                # Mode: Execute from script file's own directory
                cat > "$command_wrapper" << FILE_MODE
#!/bin/sh
# Command: $command_name
# Type: Shell script (bash→ash fallback)
# Working directory: script file location
cd "\$(dirname "$src_path")" || exit 1
exec "$shell_wrapper" "\$@"
FILE_MODE
                ;;
            *)
                # Mode: Execute from installation directory (default)
                cat > "$command_wrapper" << GLOBAL_MODE
#!/bin/sh
# Command: $command_name
# Type: Shell script (bash→ash fallback)
# Working directory: $install_dir
cd "$install_dir" || exit 1
exec "$shell_wrapper" "\$@"
GLOBAL_MODE
                ;;
        esac
        
        chmod +x "$command_wrapper"
        
        # =====================================================================
        # STEP 3: Create global symlink in $BIN_DIR
        # =====================================================================
        [ -L "$BIN_DIR/$command_name" ] && rm -f "$BIN_DIR/$command_name"
        ln -sf "$command_wrapper" "$BIN_DIR/$command_name"
        
        log_message "Created shell command: $command_name (bash→ash) [dir: $working_dir]"
    done
}

# =============================================================================
# MAIN COMMAND LINK CREATION
# =============================================================================

create_command_links() {
    install_dir="$1"
    
    # Create pkg CLI in the installation directory
    create_pkg_cli "$install_dir"
    
    # Create wsave CLI and map globally
    create_wsave_cli "$install_dir"
    [ -L "$BIN_DIR/wsave" ] && rm -f "$BIN_DIR/wsave"
    ln -sf "$install_dir/wsave" "$BIN_DIR/wsave"
    
    # Create git-config command
    create_git_config_command "$install_dir"
    
    # Create arrays from space-separated lists
    src_list="$NODE_ENTRY_POINTS_SRC"
    cmd_list="$NODE_ENTRY_POINTS_CMD"
    
    # Process each command
    idx=1
    for src in $src_list; do
        # Get corresponding command name
        command_name=$(echo "$cmd_list" | tr ' ' '\n' | sed -n "${idx}p")
        [ -z "$command_name" ] && continue
        
        src_path="$install_dir/$src"
        dest_path="$BIN_DIR/$command_name"
        working_dir=$(get_command_working_dir "$command_name")
        
        # Ensure source file exists
        if [ ! -f "$src_path" ]; then
            log_message "Warning: Source file not found: $src_path"
            idx=$((idx + 1))
            continue
        fi
        
        chmod +x "$src_path" 2>/dev/null || true
        
        if [ "$LOCAL_DIR_MODE" = true ]; then
            [ -L "$dest_path" ] && rm -f "$dest_path"
            ln -sf "$src_path" "$dest_path"
        else
            wrapper_path="$install_dir/wrappers/$command_name"
            mkdir -p "$(dirname "$wrapper_path")"
            
            # Create wrapper based on working directory configuration
            case "$working_dir" in
                "caller")
                    # Use caller's current directory
                    cat > "$wrapper_path" <<EOF
#!/bin/sh
# Working directory: caller's current directory
exec node "$src_path" "\$@"
EOF
                    ;;
                "file")
                    # Use the directory containing the script file
                    cat > "$wrapper_path" <<EOF
#!/bin/sh
# Working directory: script file location
cd "\$(dirname "$src_path")" || exit 1
exec node "$src_path" "\$@"
EOF
                    ;;
                *)
                    # Use global installation directory (default)
                    cat > "$wrapper_path" <<EOF
#!/bin/sh
cd "$install_dir" || exit 1
exec node "$src_path" "\$@"
EOF
                    ;;
            esac
            
            chmod +x "$wrapper_path"
            [ -L "$dest_path" ] && rm -f "$dest_path"
            ln -sf "$wrapper_path" "$dest_path"
            
            log_message "Created command '$command_name' with working directory: $working_dir"
        fi
        
        idx=$((idx + 1))
    done
    
    # Create shell script commands (bash→ash fallback)
    create_shell_command_links "$install_dir"
}

cleanup() {
    sudo dpkg --configure -a > /dev/null 2>&1 || true
}

interrupt_handler() {
    log_message "Installation interrupted. Cleaning up..."
    cleanup
    exit 1
}

# =============================================================================
# MAIN EXECUTION
# =============================================================================

trap interrupt_handler INT TERM

# Parse command line arguments
for arg in "$@"; do
    case "$arg" in
        -h|--help) show_help ;;
        -log) LOG_MODE=true; touch "$LOG_FILE" 2>/dev/null || true ;;
        --skip-debs) SKIP_DEBS=true ;;
        --local-dir) LOCAL_DIR_MODE=true ;;
        --no-preserve) PRESERVE_DATA=false ;;
        --node|--nodejs) INSTALL_NODE=true ;;
        --build) BUILD_MODE=true ;;
        --tar) BUILD_TAR=true ;;
        --config) BUILD_CONFIG=true ;;
    esac
done

# Handle build mode (exit early if only building)
if [ "$BUILD_MODE" = true ]; then
    do_build
fi

log_message "Starting $PROJECT_NAME installation..."

# Check and install Node.js if --node or --nodejs flag was provided
ensure_nodejs

if [ -d "$INSTALL_DIR" ]; then
    log_message "Existing installation found."
    printf "Choose: 1=Update, 2=Remove, 3=Exit\n"
    printf "Enter choice: "
    read choice
    case "$choice" in
        1) 
            # Always remove old pkg-cli.js during update to ensure fresh creation
            if [ -f "$INSTALL_DIR/pkg-cli.js" ]; then
                rm -f "$INSTALL_DIR/pkg-cli.js"
            fi
            mv -f "$INSTALL_DIR" "$BACKUP_DIR"
            remove_links 
            ;;
        2) remove_links; rm -rf "$INSTALL_DIR"; exit 0 ;;
        3) exit 0 ;;
        *) exit 1 ;;
    esac
fi

# Main installation steps
install_debs
mkdir -p "$INSTALL_DIR"
copy_files "$MAIN_SOURCE_DIR" "$INSTALL_DIR"
preserve_files_from_backup

# Extract archives if configured
[ -n "$PM2_TAR_GZ" ] && extract_archive "$PM2_TAR_GZ" "$PM2_EXTRACT_DIR"

create_command_links "$INSTALL_DIR"
cleanup

log_message "$PROJECT_NAME installation completed!"

printf "\n"
echo "Available commands:"
for cmd in $NODE_ENTRY_POINTS_CMD; do
    echo "  $cmd"
done

# Display shell script commands if configured
if [ -n "$SHELL_SCRIPTS_CMD" ]; then
    for cmd in $SHELL_SCRIPTS_CMD; do
        echo "  $cmd"
    done
fi

echo "  wsave"
echo "  git-config"

printf "\n"
echo "Working directory configuration:"
for cmd in $NODE_ENTRY_POINTS_CMD; do
    working_dir=$(get_command_working_dir "$cmd")
    echo "  $cmd: $working_dir"
done

# Display shell command working directories if configured
if [ -n "$SHELL_SCRIPTS_CMD" ]; then
    for cmd in $SHELL_SCRIPTS_CMD; do
        working_dir=$(get_command_working_dir "$cmd")
        echo "  $cmd: $working_dir (bash→ash fallback)"
    done
fi

echo "  git-config: global"

printf "\n"
echo "pkg command features:"
echo "  pkg start                    - Create/ensure package.json has version 0.0.1 and type:module"
echo "  pkg run <script> [args...]   - Run any script from package.json with arguments"
echo "  pkg version <type|ver>       - Update version and create git commit"

printf "\n"
echo "pack command features:"
echo "  pack [path1] [path2] ...     - Compare directories and show differences"
echo "  Examples:"
echo "    pack path/to/project              - Compare single directory with itself"
echo "    pack path/to/one path/to/two      - Compare two directories"
echo "    pack path/one path/two path/three - Compare multiple directories"

printf "\n"
echo "Other commands:"
echo "  wsave                        - Surgically fix VSCode save permissions silently"
echo "  git-config                    - Complete Git setup (finds and runs Git.js --setup)"

printf "\n"
echo "pkg version supports:"
echo "  • patch    - Bump patch version (1.2.3 → 1.2.4)"
echo "  • minor    - Bump minor version (1.2.3 → 1.3.0)"
echo "  • major    - Bump major version (1.2.3 → 2.0.0)"
echo "  • X.Y.Z    - Set specific version"
echo "  • X.Y.Z-prerelease - Set version with prerelease tag"

printf "\n"
echo "Examples:"
echo "  pkg start                     # Creates/ensures package.json has version 0.0.1 and type:module"
echo "  pkg run test                  # Runs 'test' script from package.json"
echo "  pkg run build                 # Runs 'build' script from package.json"
echo "  pkg run dev --port 3000       # Runs 'dev' script with --port argument"
echo "  pkg version patch             # Bumps patch version and commits"
echo "  pack ./project1 ./project2    # Compares two directories"
echo "  pack ./src ./dist             # Compares source and distribution directories"
echo "  git-config                     # Complete Git setup (Git.js --setup)"

printf "\n"
echo "Note: pkg works from any directory. 'pkg start' ensures package.json has version 0.0.1 and type:module"
echo "Note: pack works from any directory and supports multiple paths as arguments"
echo "Note: git-config finds Git.js anywhere in the installation tree"

# Display shell command notes if configured
if [ -n "$SHELL_SCRIPTS_CMD" ]; then
    printf "\n"
    echo "Shell script commands use automatic bash→ash fallback for maximum compatibility"
    echo "Each .sh script is wrapped to detect and use the best available shell interpreter"
fi

printf "\n"
if [ "$LOCAL_DIR_MODE" = true ]; then
    echo "Commands run from current directory"
else
    echo "Installation directory: $INSTALL_DIR"
    echo "Node.js processes start in configured working directories (see above)"
fi