#!/bin/sh

# Lay.sh - Layer Directory Navigator
# Compatible with sh/ash/bash
# Usage: lay [options] [command]
# Options:
#   [number]        - Move exact number of layers
#   [name]          - Switch to layer by custom name (if name is not a number)
#   reverse, -r, --reverse  - Force reverse direction
#   back, up, -u, --up     - Go back/up (alternative to reverse)
#   new [name]      - Create new layer (clean copy, only tracked files)
#   new --changes [name] - Create new layer with changes (includes untracked)
#   delete          - Delete current layer and return to main repo
#   clearall        - Clear all repo instances (with verification)
#   clear           - Clear instances of current repo only (with verification)
#   swi [N|name]    - Switch to layer by number or custom name (0 = main repo)
#   reposwi [name|N]- Switch to a different repository (by name or index)
#   repo [name|N]   - Switch to a different repository (alternative to reposwi)
#   list            - List all layer instances (full names)
#   repos           - List unique repository names
#   diff            - Navigate to a git diff file's directory
#   --test          - Run internal tests
#   -v, --verbose  - Show detailed output (what's happening)
#   -h, --help     - Show help

LAYER_NAME="._"

# Detect if script is being sourced or executed
is_sourced() {
    case "$0" in
        *lay.sh|*lay|*-lay)
            if [ "$0" = "${0#/}" ] && [ -f "./$0" ]; then
                return 1  # Being executed
            elif [ -f "$0" ]; then
                return 1  # Being executed
            else
                return 0  # Being sourced (script is function/alias)
            fi
            ;;
        *)
            return 0  # Being sourced
            ;;
    esac
}

# If executed directly, re-execute with source
if ! is_sourced; then
    CURRENT_SHELL="${SHELL:-/bin/sh}"
    
    if echo "$BASH_VERSION" >/dev/null 2>&1; then
        exec bash -c ". \"$0\" $*; exec \$SHELL"
    else
        printf "Please source this script instead:\n"
        printf "  . %s" "$0"
        [ $# -gt 0 ] && printf " %s" "$@"
        printf "\n"
        printf "Or create an alias in your shell config:\n"
        printf "  alias lay='. %s'\n" "$0"
        exit 1
    fi
fi

# Check if terminal supports colors
if [ -t 1 ]; then
    COLOR_GREEN='\033[0;32m'
    COLOR_BLUE='\033[0;34m'
    COLOR_YELLOW='\033[1;33m'
    COLOR_RED='\033[0;31m'
    COLOR_CYAN='\033[0;36m'
    COLOR_MAGENTA='\033[0;35m'
    COLOR_BOLD='\033[1m'
    COLOR_RESET='\033[0m'
else
    COLOR_GREEN=''
    COLOR_BLUE=''
    COLOR_YELLOW=''
    COLOR_RED=''
    COLOR_CYAN=''
    COLOR_MAGENTA=''
    COLOR_BOLD=''
    COLOR_RESET=''
fi

show_help() {
    printf "${COLOR_GREEN}Lay.sh${COLOR_RESET} - Layer Directory Navigator\n"
    printf "====================================\n"
    printf "Navigate between ${COLOR_BLUE}%s${COLOR_RESET} directory layers like ping-pong.\n\n" "$LAYER_NAME"
    printf "${COLOR_YELLOW}Usage:${COLOR_RESET}\n"
    printf "  lay                # Go deep to last layer, or back to top (silent)\n"
    printf "  lay [N]            # Move N layers (deep or back) (silent)\n"
    printf "  lay [name]         # Switch to layer by custom name (if not a number)\n"
    printf "  lay new [name]     # Create new layer (clean copy, only tracked files)\n"
    printf "  lay new --changes [name] # Create new layer with changes (includes untracked)\n"
    printf "  lay delete         # Delete current layer and return to main repo\n"
    printf "  lay clearall       # Clear all repo instances (with verification)\n"
    printf "  lay clear          # Clear instances of current repo only (with verification)\n"
    printf "  lay swi [N|name]   # Switch to layer by number or custom name (0 = main repo)\n"
    printf "  lay repo [name|N]  # Switch to a different repository (by name or 1-based index)\n"
    printf "  lay reposwi [name|N] # Alternative: switch to different repository\n"
    printf "  lay list           # List all layer instances (full names)\n"
    printf "  lay repos          # List unique repository names\n"
    printf "  lay diff           # Navigate to a git diff file's directory\n"
    printf "  lay --test         # Run internal tests\n"
    printf "  lay reverse        # Force go back/up (silent)\n"
    printf "  lay back           # Alternative: go back/up (silent)\n"
    printf "  lay -r | --reverse # Same as reverse (silent)\n"
    printf "  lay -u | --up      # Same as back (silent)\n"
    printf "  lay -v | --verbose # Show detailed output\n"
    printf "  lay -h | --help    # Show this help\n"
    printf "\n${COLOR_YELLOW}Custom Names:${COLOR_RESET}\n"
    printf "  Instead of auto-numbering (repo_1, repo_2), you can use custom names:\n"
    printf "  ${COLOR_CYAN}lay new feature-x${COLOR_RESET}     # Creates repo_feature-x (only tracked files)\n"
    printf "  ${COLOR_CYAN}lay new --changes bugfix${COLOR_RESET} # Creates repo_bugfix (includes untracked files)\n"
    printf "  ${COLOR_CYAN}lay swi feature-x${COLOR_RESET}      # Switch to repo_feature-x\n"
    printf "  ${COLOR_CYAN}lay feature-x${COLOR_RESET}          # Switch to repo_feature-x (shorthand)\n"
    printf "\n${COLOR_YELLOW}Note:${COLOR_RESET}\n"
    printf "  By default, 'lay new' only copies git-tracked files (respects .gitignore)\n"
    printf "  Use 'lay new --changes' to include untracked and modified files\n"
}

# Parse arguments
REVERSE_MODE=0
LAYER_COUNT=""
VERBOSE_MODE=0
CREATE_NEW_LAYER=0
INCLUDE_UNCOMMITTED=0
CUSTOM_LAYER_NAME=""
DELETE_CURRENT_LAYER=0
CLEAR_ALL_LAYERS=0
CLEAR_CURRENT_REPO=0
SWITCH_TO_LAYER=0
TARGET_LAYER_NUMBER=""
SWITCH_REPOSITORY=0
TARGET_REPOSITORY=""
LIST_ALL_LAYERS=0
LIST_ALL_REPOSITORIES=0
RUN_INTERNAL_TESTS=0
SWITCH_BY_NAME=0
TARGET_NAME=""
DIFF_NAVIGATE=0

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            show_help
            return 0 2>/dev/null || exit 0
            ;;
        -v|--verbose)
            VERBOSE_MODE=1
            shift
            ;;
        -r|--reverse|reverse|back|-u|--up|up)
            REVERSE_MODE=1
            shift
            ;;
        new|--new|-n)
            CREATE_NEW_LAYER=1
            shift
            # Check for --changes flag
            if [ $# -gt 0 ] && ( [ "$1" = "--changes" ] || [ "$1" = "-c" ] || [ "$1" = "changes" ] ); then
                INCLUDE_UNCOMMITTED=1
                shift
            fi
            # Check for custom name
            if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
                CUSTOM_LAYER_NAME="$1"
                shift
            fi
            ;;
        delete|--delete|-d|del)
            DELETE_CURRENT_LAYER=1
            shift
            ;;
        clearall|--clearall|-ca|clear-all)
            CLEAR_ALL_LAYERS=1
            shift
            ;;
        clear|--clear|-c)
            CLEAR_CURRENT_REPO=1
            shift
            ;;
        swi|--swi|-s|switch|--switch)
            SWITCH_TO_LAYER=1
            shift
            # Check if there's an argument (number or name)
            if [ $# -gt 0 ]; then
                TARGET_LAYER_NUMBER="$1"
                shift
            fi
            ;;
        repo|--repo)
            SWITCH_REPOSITORY=1
            shift
            # Check for argument (name or number)
            if [ $# -gt 0 ]; then
                TARGET_REPOSITORY="$1"
                shift
            fi
            ;;
        reposwi|--reposwi|-rs|reposwitch|swirepo|swi-repo)
            SWITCH_REPOSITORY=1
            shift
            # Check for argument (name or number)
            if [ $# -gt 0 ]; then
                TARGET_REPOSITORY="$1"
                shift
            fi
            ;;
        list|--list|-l)
            LIST_ALL_LAYERS=1
            shift
            ;;
        repos|--repos|-rp)
            LIST_ALL_REPOSITORIES=1
            shift
            ;;
        diff|--diff|-df)
            DIFF_NAVIGATE=1
            shift
            ;;
        --test|-t|test)
            RUN_INTERNAL_TESTS=1
            shift
            ;;
        -*)
            printf "Unknown option: %s\n" "$1"
            printf "Use -h for help\n"
            return 1 2>/dev/null || exit 1
            ;;
        *)
            # This is the catch-all for numbers or names
            # Check if argument is a number or a name
            case "$1" in
                ''|*[!0-9]*)
                    # It's a name (non-numeric) - treat as switch by name
                    SWITCH_BY_NAME=1
                    TARGET_NAME="$1"
                    shift
                    ;;
                *)
                    # It's a number - treat as layer count
                    LAYER_COUNT="$1"
                    shift
                    ;;
            esac
            ;;
    esac
done

# Store current directory
CURRENT_DIRECTORY="$PWD"

# Find deepest ._ path from current position
find_deepest_layer() {
    start_directory="$1"
    current_directory="$start_directory"
    depth_count=0
    
    while [ -d "$current_directory/$LAYER_NAME" ]; do
        current_directory="$current_directory/$LAYER_NAME"
        depth_count=$((depth_count + 1))
    done
    
    printf "%d:%s\n" "$depth_count" "$current_directory"
}

# Find the top directory above all ._ layers
find_top_directory() {
    current_directory="$1"
    
    # First, go up until we're no longer inside a ._ directory
    while [ "$current_directory" != "/" ] && [ "$(basename "$current_directory")" = "$LAYER_NAME" ]; do
        current_directory="$(dirname "$current_directory")"
    done
    
    # Now go up until we find a directory that has a ._ subdirectory
    while [ "$current_directory" != "/" ]; do
        if [ -d "$current_directory/$LAYER_NAME" ]; then
            break
        fi
        current_directory="$(dirname "$current_directory")"
    done
    
    printf "%s\n" "$current_directory"
}

# Count how many ._ layers are above current position
count_layers_above() {
    current_directory="$1"
    layer_count=0
    
    while [ "$current_directory" != "/" ]; do
        if [ "$(basename "$current_directory")" = "$LAYER_NAME" ]; then
            layer_count=$((layer_count + 1))
        fi
        current_directory="$(dirname "$current_directory")"
    done
    
    printf "%d\n" "$layer_count"
}

# Go deep into layers
go_deep() {
    deep_layer_information=$(find_deepest_layer "$CURRENT_DIRECTORY")
    available_layers=$(printf "%s" "$deep_layer_information" | cut -d: -f1)
    deepest_path=$(printf "%s" "$deep_layer_information" | cut -d: -f2)
    
    if [ "$available_layers" -eq 0 ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "Already at the deepest level (no %s directories found)\n" "$LAYER_NAME"
        return 1
    fi
    
    target_path="$deepest_path"
    
    if [ -n "$LAYER_COUNT" ]; then
        if [ "$LAYER_COUNT" -gt "$available_layers" ]; then
            [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}Requested %d layers, but only %d available${COLOR_RESET}\n" "$LAYER_COUNT" "$available_layers"
            target_path="$deepest_path"
        else
            current_directory="$CURRENT_DIRECTORY"
            iterator=0
            while [ $iterator -lt "$LAYER_COUNT" ]; do
                if [ -d "$current_directory/$LAYER_NAME" ]; then
                    current_directory="$current_directory/$LAYER_NAME"
                    iterator=$((iterator + 1))
                else
                    break
                fi
            done
            target_path="$current_directory"
            [ $VERBOSE_MODE -eq 1 ] && printf "Moving %d layer(s) deeper...\n" "$LAYER_COUNT"
        fi
    else
        [ $VERBOSE_MODE -eq 1 ] && printf "Moving to deepest layer (%d level(s) deep)...\n" "$available_layers"
    fi
    
    if [ "$target_path" != "$CURRENT_DIRECTORY" ]; then
        cd "$target_path" || return 1
        [ $VERBOSE_MODE -eq 1 ] && printf "Now at: %s\n" "$PWD"
        return 0
    else
        [ $VERBOSE_MODE -eq 1 ] && printf "Already at target directory\n"
        return 1
    fi
}

# Go back from layers
go_back() {
    layers_above_count=$(count_layers_above "$CURRENT_DIRECTORY")
    
    if [ -n "$LAYER_COUNT" ]; then
        if [ "$LAYER_COUNT" -gt "$layers_above_count" ]; then
            [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}Requested to go back %d layers, but only %d available${COLOR_RESET}\n" "$LAYER_COUNT" "$layers_above_count"
            target_path=$(find_top_directory "$CURRENT_DIRECTORY")
        else
            current_directory="$CURRENT_DIRECTORY"
            iterator=0
            # Go up the specified number of layers, but stop at ._ boundaries
            while [ $iterator -lt "$LAYER_COUNT" ]; do
                # If we're in a ._ directory, go to its parent
                if [ "$(basename "$current_directory")" = "$LAYER_NAME" ]; then
                    current_directory="$(dirname "$current_directory")"
                    iterator=$((iterator + 1))
                else
                    # We're above all ._ layers
                    break
                fi
            done
            target_path="$current_directory"
            [ $VERBOSE_MODE -eq 1 ] && printf "Moving back %d layer(s)...\n" "$LAYER_COUNT"
        fi
    else
        # Go back to the top directory (the one containing the first ._ layer)
        target_path=$(find_top_directory "$CURRENT_DIRECTORY")
        [ $VERBOSE_MODE -eq 1 ] && printf "Moving back to top directory...\n"
    fi
    
    if [ "$target_path" != "$CURRENT_DIRECTORY" ]; then
        cd "$target_path" || return 1
        [ $VERBOSE_MODE -eq 1 ] && printf "Now at: %s\n" "$PWD"
        return 0
    else
        [ $VERBOSE_MODE -eq 1 ] && printf "Already at the top level\n"
        return 1
    fi
}

# Get repo name from .git
get_repo_name_from_git() {
    git_config_file="$1/.git/config"
    
    if [ ! -f "$git_config_file" ]; then
        return 1
    fi
    
    # Try to get URL from git config
    git_url=$(grep -m 1 "url = " "$git_config_file" | sed 's/.*url = //' | tr -d '[:space:]')
    
    if [ -z "$git_url" ]; then
        return 1
    fi
    
    # Extract repo name from URL
    # Handle formats like:
    # https://github.com/user/repo.git
    # git@github.com:user/repo.git
    # ssh://git@github.com/user/repo.git
    repository_name=$(printf "%s" "$git_url" | sed 's|.*/||' | sed 's|\.git$||')
    
    if [ -z "$repository_name" ]; then
        return 1
    fi
    
    printf "%s\n" "$repository_name"
}

# Get the main repo name (without _number or _customname)
get_main_repo_name() {
    current_directory="$1"
    basename_directory="$(basename "$current_directory")"
    
    # Remove _suffix if present (number or custom name)
    main_repository_name=$(printf "%s" "$basename_directory" | sed 's/_[^_]*$//')
    
    printf "%s\n" "$main_repository_name"
}

# Get the instance suffix from directory name (empty if main repo)
get_instance_suffix() {
    current_directory="$1"
    basename_directory="$(basename "$current_directory")"
    
    # Check if it has a suffix (contains underscore)
    if printf "%s" "$basename_directory" | grep -q '_'; then
        printf "%s" "$basename_directory" | sed 's/.*_\([^_]*\)$/\1/'
    else
        printf ""
    fi
}

# Check if suffix is numeric
is_numeric() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

# Get the current branch name
get_current_branch() {
    repository_root="$1"
    if [ -d "$repository_root/.git" ]; then
        # Try to get current branch from HEAD
        branch=$(cd "$repository_root" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null)
        if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
            printf "%s" "$branch"
            return 0
        fi
    fi
    # Fallback to master if we can't determine
    printf "master"
    return 0
}

# Copy files from repository state (clean, no changes)
copy_tracked_files() {
    source_directory="$1"
    destination_directory="$2"
    
    # Try using git to get clean files from repository
    if [ -d "$source_directory/.git" ] && command -v git >/dev/null 2>&1; then
        [ $VERBOSE_MODE -eq 1 ] && printf "Getting clean files from repository state...\n"
        
        # Get current branch
        current_branch=$(cd "$source_directory" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null)
        if [ -z "$current_branch" ] || [ "$current_branch" = "HEAD" ]; then
            current_branch="master"
        fi
        
        # Use git archive to get clean state
        [ $VERBOSE_MODE -eq 1 ] && printf "Using git archive from branch '%s'...\n" "$current_branch"
        
        # Create a temporary directory for the archive
        temp_archive_dir=$(mktemp -d /tmp/lay_archive.XXXXXX 2>/dev/null) || {
            [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Failed to create temp dir for archive${COLOR_RESET}\n"
            return 1
        }
        
        # Export clean files using git archive
        (cd "$source_directory" 2>/dev/null && git archive --format=tar "$current_branch" 2>/dev/null) | (cd "$temp_archive_dir" 2>/dev/null && tar xf - 2>/dev/null)
        
        if [ $? -eq 0 ] && [ -n "$(ls -A "$temp_archive_dir" 2>/dev/null)" ]; then
            # Copy files from temp dir to destination
            [ $VERBOSE_MODE -eq 1 ] && printf "Copying clean files to destination...\n"
            
            # Copy everything from temp archive to destination
            for item in "$temp_archive_dir"/* "$temp_archive_dir"/.[!.]*; do
                [ -e "$item" ] || continue
                basename_item="$(basename "$item")"
                if [ "$basename_item" != "." ] && [ "$basename_item" != ".." ]; then
                    cp -r "$item" "$destination_directory/" 2>/dev/null
                fi
            done
            
            # Clean up temp dir
            rm -rf "$temp_archive_dir" 2>/dev/null
            
            # Copy .git directory
            if [ -d "$source_directory/.git" ]; then
                [ $VERBOSE_MODE -eq 1 ] && printf "Copying .git directory...\n"
                cp -r "$source_directory/.git" "$destination_directory/.git" 2>/dev/null || {
                    [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}Warning: Could not copy .git directory${COLOR_RESET}\n"
                }
            fi
            
            return 0
        fi
        
        # Clean up temp dir if archive failed
        rm -rf "$temp_archive_dir" 2>/dev/null
        
        # Fallback: use git checkout-index for clean files
        [ $VERBOSE_MODE -eq 1 ] && printf "Archive failed, using checkout-index for clean files...\n"
        
        # Create a temporary directory for checkout
        temp_checkout_dir=$(mktemp -d /tmp/lay_checkout.XXXXXX 2>/dev/null) || {
            [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Failed to create temp dir for checkout${COLOR_RESET}\n"
            return 1
        }
        
        # Checkout clean files from repository
        (cd "$source_directory" 2>/dev/null && git checkout-index --prefix="$temp_checkout_dir/" -a 2>/dev/null)
        
        if [ $? -eq 0 ] && [ -n "$(ls -A "$temp_checkout_dir" 2>/dev/null)" ]; then
            # Copy files from temp dir to destination
            [ $VERBOSE_MODE -eq 1 ] && printf "Copying checked-out files to destination...\n"
            
            # Copy everything from temp checkout to destination
            for item in "$temp_checkout_dir"/* "$temp_checkout_dir"/.[!.]*; do
                [ -e "$item" ] || continue
                basename_item="$(basename "$item")"
                if [ "$basename_item" != "." ] && [ "$basename_item" != ".." ]; then
                    cp -r "$item" "$destination_directory/" 2>/dev/null
                fi
            done
            
            # Clean up temp dir
            rm -rf "$temp_checkout_dir" 2>/dev/null
            
            # Copy .git directory
            if [ -d "$source_directory/.git" ]; then
                [ $VERBOSE_MODE -eq 1 ] && printf "Copying .git directory...\n"
                cp -r "$source_directory/.git" "$destination_directory/.git" 2>/dev/null || {
                    [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}Warning: Could not copy .git directory${COLOR_RESET}\n"
                }
            fi
            
            return 0
        fi
        
        # Clean up temp dir
        rm -rf "$temp_checkout_dir" 2>/dev/null
        
        # Final fallback: use git ls-files
        [ $VERBOSE_MODE -eq 1 ] && printf "Using git ls-files as final fallback...\n"
        
        tracked_files_list=$(cd "$source_directory" 2>/dev/null && git ls-files 2>/dev/null)
        
        if [ $? -eq 0 ] && [ -n "$tracked_files_list" ]; then
            # Copy each tracked file
            printf "%s\n" "$tracked_files_list" | while IFS= read -r file_path; do
                parent_directory="$destination_directory/$(dirname "$file_path")"
                mkdir -p "$parent_directory" 2>/dev/null
                
                if [ -f "$source_directory/$file_path" ]; then
                    cp "$source_directory/$file_path" "$destination_directory/$file_path" 2>/dev/null
                elif [ -d "$source_directory/$file_path" ]; then
                    mkdir -p "$destination_directory/$file_path" 2>/dev/null
                    cp -r "$source_directory/$file_path"/* "$destination_directory/$file_path/" 2>/dev/null
                fi
            done
            
            if [ -d "$source_directory/.git" ]; then
                [ $VERBOSE_MODE -eq 1 ] && printf "Copying .git directory...\n"
                cp -r "$source_directory/.git" "$destination_directory/.git" 2>/dev/null
            fi
            
            return 0
        fi
    fi
    
    # Ultimate fallback: copy everything except .git
    [ $VERBOSE_MODE -eq 1 ] && printf "Git not available, copying all files...\n"
    
    for item in "$source_directory"/* "$source_directory"/.[!.]* "$source_directory"/..?*; do
        [ -e "$item" ] || continue
        basename_item="$(basename "$item")"
        if [ "$basename_item" != ".git" ] && [ "$basename_item" != "." ] && [ "$basename_item" != ".." ]; then
            cp -r "$item" "$destination_directory/" 2>/dev/null
        fi
    done
    
    if [ -d "$source_directory/.git" ]; then
        cp -r "$source_directory/.git" "$destination_directory/.git" 2>/dev/null
    fi
    
    return 0
}

# Copy all files (including untracked and ignored) - preserve current state
copy_all_files() {
    source_directory="$1"
    destination_directory="$2"
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Copying all files including untracked (current state)...\n"
    
    # Copy everything
    for item in "$source_directory"/* "$source_directory"/.[!.]* "$source_directory"/..?*; do
        [ -e "$item" ] || continue
        basename_item="$(basename "$item")"
        if [ "$basename_item" != "." ] && [ "$basename_item" != ".." ]; then
            cp -r "$item" "$destination_directory/" 2>/dev/null || {
                [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}Warning: Could not copy %s${COLOR_RESET}\n" "$basename_item"
            }
        fi
    done
    
    return 0
}

# Create new layer
create_new_layer() {
    # Determine the actual repository root (not inside ._ if we're there)
    repository_root="$CURRENT_DIRECTORY"
    
    # If we're inside a ._ directory, go up to find the actual repo root
    if [ "$(basename "$repository_root")" = "$LAYER_NAME" ]; then
        repository_root="$(dirname "$repository_root")"
        [ $VERBOSE_MODE -eq 1 ] && printf "Detected inside %s, repository root is: %s\n" "$LAYER_NAME" "$repository_root"
    fi
    
    # Check if we're in a git repository
    if [ ! -d "$repository_root/.git" ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Not in a git repository${COLOR_RESET}\n"
        return 1
    fi
    
    # Get repo name
    repository_name=$(get_repo_name_from_git "$repository_root")
    if [ -z "$repository_name" ]; then
        # Fallback: use directory name if .git/config doesn't have URL
        repository_name=$(get_main_repo_name "$repository_root")
        [ $VERBOSE_MODE -eq 1 ] && printf "Using directory name as repo name: %s\n" "$repository_name"
    fi
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Repository name: %s\n" "$repository_name"
    
    # Find parent directory (one level above the repo root)
    parent_directory="$(dirname "$repository_root")"
    
    # Determine new layer directory name
    if [ -n "$CUSTOM_LAYER_NAME" ]; then
        # Use custom name
        new_layer_directory="$parent_directory/${repository_name}_${CUSTOM_LAYER_NAME}"
        
        # Check if directory already exists
        if [ -d "$new_layer_directory" ]; then
            [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Layer '%s' already exists${COLOR_RESET}\n" "${repository_name}_${CUSTOM_LAYER_NAME}"
            return 1
        fi
    else
        # Auto-number: find the next available number
        counter=1
        while [ -d "$parent_directory/${repository_name}_${counter}" ]; do
            counter=$((counter + 1))
        done
        new_layer_directory="$parent_directory/${repository_name}_${counter}"
    fi
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Creating new layer directory: %s\n" "$new_layer_directory"
    
    # Create the new directory
    mkdir -p "$new_layer_directory" || {
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Could not create directory %s${COLOR_RESET}\n" "$new_layer_directory"
        return 1
    }
    
    if [ $INCLUDE_UNCOMMITTED -eq 1 ]; then
        # Copy with all files (including untracked and changes) - current state
        copy_all_files "$repository_root" "$new_layer_directory" || return 1
    else
        # Copy only tracked files from the repository (clean state)
        copy_tracked_files "$repository_root" "$new_layer_directory" || return 1
    fi
    
    # Navigate to the new directory
    cd "$new_layer_directory" || {
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Could not cd to %s${COLOR_RESET}\n" "$new_layer_directory"
        return 1
    }
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    return 0
}

# Delete current layer
delete_current_layer() {
    # Determine the actual repository root
    repository_root="$CURRENT_DIRECTORY"
    
    # If we're inside a ._ directory, go up to find the actual repo root
    if [ "$(basename "$repository_root")" = "$LAYER_NAME" ]; then
        repository_root="$(dirname "$repository_root")"
    fi
    
    # Check if we're in a numbered or custom layer
    instance_suffix=$(get_instance_suffix "$repository_root")
    
    if [ -z "$instance_suffix" ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Cannot delete main repository${COLOR_RESET}\n"
        return 1
    fi
    
    # Get repo name
    repository_name=$(get_repo_name_from_git "$repository_root")
    if [ -z "$repository_name" ]; then
        repository_name=$(get_main_repo_name "$repository_root")
    fi
    
    # Get parent directory
    parent_directory="$(dirname "$repository_root")"
    
    # Navigate to main repo
    main_repository="$parent_directory/${repository_name}"
    
    if [ ! -d "$main_repository" ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Main repository not found: %s${COLOR_RESET}\n" "$main_repository"
        return 1
    fi
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Deleting layer: %s\n" "$repository_root"
    [ $VERBOSE_MODE -eq 1 ] && printf "Returning to: %s\n" "$main_repository"
    
    # Delete the current layer
    rm -rf "$repository_root" || {
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Could not delete %s${COLOR_RESET}\n" "$repository_root"
        return 1
    }
    
    # Navigate to main repo
    cd "$main_repository" || return 1
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    return 0
}

# Clear instances of current repo only
clear_current_repo_instances() {
    # Determine current repo root and parent dir
    repository_root="$CURRENT_DIRECTORY"
    if [ "$(basename "$repository_root")" = "$LAYER_NAME" ]; then
        repository_root="$(dirname "$repository_root")"
    fi
    parent_directory="$(dirname "$repository_root")"
    
    # Get current repo name
    current_repository=$(get_repo_name_from_git "$repository_root")
    if [ -z "$current_repository" ]; then
        current_repository=$(get_main_repo_name "$repository_root")
    fi
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Clearing instances for repository '%s'...\n" "$current_repository"
    
    # Check if main repo exists
    if [ ! -d "$parent_directory/$current_repository" ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Main repository '%s' not found${COLOR_RESET}\n" "$current_repository"
        return 1
    fi
    
    # Determine main repo branch
    main_repo_branch=$(get_current_branch "$parent_directory/$current_repository")
    [ $VERBOSE_MODE -eq 1 ] && printf "Main repo branch: %s\n" "$main_repo_branch"
    
    # Collect instances and categorize them
    instances_to_delete=""
    instances_needing_verification=""
    verification_details=""
    
    for directory in "$parent_directory"/${current_repository}_*; do
        [ -d "$directory" ] || continue
        basename_directory=$(basename "$directory")
        # Skip ._ directories
        if [ "$basename_directory" = "$LAYER_NAME" ]; then
            continue
        fi
        
        # Check if this instance has uncommitted changes
        has_uncommitted_changes=0
        if [ -d "$directory/.git" ] && command -v git >/dev/null 2>&1; then
            if (cd "$directory" 2>/dev/null && git status --porcelain 2>/dev/null | grep -q .); then
                has_uncommitted_changes=1
            fi
        fi
        
        # Check if branch differs from main repo
        branch_differs=0
        instance_branch=""
        if [ -d "$directory/.git" ] && command -v git >/dev/null 2>&1; then
            instance_branch=$(get_current_branch "$directory")
            if [ "$instance_branch" != "$main_repo_branch" ]; then
                branch_differs=1
            fi
        fi
        
        if [ $has_uncommitted_changes -eq 0 ] && [ $branch_differs -eq 0 ]; then
            # Safe to delete
            if [ -z "$instances_to_delete" ]; then
                instances_to_delete="$directory"
            else
                instances_to_delete="$instances_to_delete
$directory"
            fi
        else
            # Needs verification
            if [ -z "$instances_needing_verification" ]; then
                instances_needing_verification="$directory"
            else
                instances_needing_verification="$instances_needing_verification
$directory"
            fi
            
            # Build verification details
            instance_details="$basename_directory:"
            if [ $has_uncommitted_changes -eq 1 ]; then
                instance_details="$instance_details has_uncommitted_changes"
            fi
            if [ $branch_differs -eq 1 ]; then
                if [ $has_uncommitted_changes -eq 1 ]; then
                    instance_details="$instance_details,"
                fi
                instance_details="$instance_details branch=${instance_branch:-unknown}(main:${main_repo_branch})"
            fi
            
            if [ -z "$verification_details" ]; then
                verification_details="$instance_details"
            else
                verification_details="$verification_details
$instance_details"
            fi
        fi
    done
    
    # Delete instances that are clean
    if [ -n "$instances_to_delete" ]; then
        printf "${COLOR_CYAN}Deleting clean instances:${COLOR_RESET}\n"
        printf "%s\n" "$instances_to_delete" | while IFS= read -r directory; do
            [ -z "$directory" ] && continue
            printf "  Removing: %s\n" "$(basename "$directory")"
            rm -rf "$directory" 2>/dev/null || {
                [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}Warning: Could not delete %s${COLOR_RESET}\n" "$directory"
            }
        done
    fi
    
    # Handle instances needing verification
    if [ -n "$instances_needing_verification" ]; then
        printf "${COLOR_YELLOW}The following instances have differences:${COLOR_RESET}\n"
        printf "%s\n" "$verification_details" | while IFS= read -r details; do
            [ -z "$details" ] && continue
            printf "  %s\n" "$details"
        done
        
        printf "\n${COLOR_YELLOW}Do you want to delete these instances too? (y/n): ${COLOR_RESET}"
        read -r user_response
        
        case "$user_response" in
            [Yy]|[Yy][Ee][Ss])
                printf "%s\n" "$instances_needing_verification" | while IFS= read -r directory; do
                    [ -z "$directory" ] && continue
                    printf "  Removing: %s\n" "$(basename "$directory")"
                    rm -rf "$directory" 2>/dev/null || {
                        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}Warning: Could not delete %s${COLOR_RESET}\n" "$directory"
                    }
                done
                printf "${COLOR_GREEN}All instances cleared.${COLOR_RESET}\n"
                ;;
            *)
                printf "${COLOR_YELLOW}Skipped deletion of instances with differences.${COLOR_RESET}\n"
                ;;
        esac
    else
        printf "${COLOR_GREEN}All clean instances cleared.${COLOR_RESET}\n"
    fi
    
    # Navigate to main repo if we're in a deleted instance
    if [ ! -d "$CURRENT_DIRECTORY" ]; then
        cd "$parent_directory/$current_repository" || return 1
        [ $VERBOSE_MODE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    fi
    
    return 0
}

# Clear all repo instances (across all repos)
clear_all_layers() {
    # Determine current repo root and parent dir
    repository_root="$CURRENT_DIRECTORY"
    if [ "$(basename "$repository_root")" = "$LAYER_NAME" ]; then
        repository_root="$(dirname "$repository_root")"
    fi
    parent_directory="$(dirname "$repository_root")"
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Clearing instances for all repositories in: %s\n" "$parent_directory"
    
    # Collect unique repo names using temp file
    seen_file=$(mktemp /tmp/lay_seen.XXXXXX) || return 1
    trap 'rm -f "$seen_file"' RETURN
    
    for directory in "$parent_directory"/*/; do
        [ -d "$directory" ] || continue
        basename_directory=$(basename "$directory")
        # Skip ._ directories
        if [ "$basename_directory" = "$LAYER_NAME" ]; then
            continue
        fi
        # Extract base repo name (everything before the last underscore)
        base_repository_name=$(printf "%s" "$basename_directory" | sed 's/_[^_]*$//')
        # Check if we've seen this repo before
        if ! grep -q "^${base_repository_name}$" "$seen_file" 2>/dev/null; then
            printf "%s\n" "$base_repository_name" >> "$seen_file"
        fi
    done
    
    # Arrays to store all instances needing verification across repos
    all_verification_instances=""
    all_verification_details=""
    all_clean_instances=""
    
    # Process each unique repo to collect instances
    while IFS= read -r repo_name; do
        [ -z "$repo_name" ] && continue
        
        [ $VERBOSE_MODE -eq 1 ] && printf "\nCollecting instances for repository: %s\n" "$repo_name"
        
        # Check if main repo exists
        if [ ! -d "$parent_directory/$repo_name" ]; then
            [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}Main repo '%s' not found, skipping${COLOR_RESET}\n" "$repo_name"
            continue
        fi
        
        # Determine main repo branch
        main_repo_branch=$(get_current_branch "$parent_directory/$repo_name")
        
        for directory in "$parent_directory"/${repo_name}_*; do
            [ -d "$directory" ] || continue
            basename_directory=$(basename "$directory")
            # Skip ._ directories
            if [ "$basename_directory" = "$LAYER_NAME" ]; then
                continue
            fi
            
            # Check if this instance has uncommitted changes
            has_uncommitted_changes=0
            if [ -d "$directory/.git" ] && command -v git >/dev/null 2>&1; then
                if (cd "$directory" 2>/dev/null && git status --porcelain 2>/dev/null | grep -q .); then
                    has_uncommitted_changes=1
                fi
            fi
            
            # Check if branch differs from main repo
            branch_differs=0
            instance_branch=""
            if [ -d "$directory/.git" ] && command -v git >/dev/null 2>&1; then
                instance_branch=$(get_current_branch "$directory")
                if [ "$instance_branch" != "$main_repo_branch" ]; then
                    branch_differs=1
                fi
            fi
            
            if [ $has_uncommitted_changes -eq 0 ] && [ $branch_differs -eq 0 ]; then
                # Clean instance
                if [ -z "$all_clean_instances" ]; then
                    all_clean_instances="$directory"
                else
                    all_clean_instances="$all_clean_instances
$directory"
                fi
            else
                # Needs verification
                if [ -z "$all_verification_instances" ]; then
                    all_verification_instances="$directory"
                else
                    all_verification_instances="$all_verification_instances
$directory"
                fi
                
                # Build verification details
                instance_details="$basename_directory:"
                if [ $has_uncommitted_changes -eq 1 ]; then
                    instance_details="$instance_details has_uncommitted_changes"
                fi
                if [ $branch_differs -eq 1 ]; then
                    if [ $has_uncommitted_changes -eq 1 ]; then
                        instance_details="$instance_details,"
                    fi
                    instance_details="$instance_details branch=${instance_branch:-unknown}(main:${main_repo_branch})"
                fi
                
                if [ -z "$all_verification_details" ]; then
                    all_verification_details="$instance_details"
                else
                    all_verification_details="$all_verification_details
$instance_details"
                fi
            fi
        done
    done < "$seen_file"
    
    # Delete all clean instances
    if [ -n "$all_clean_instances" ]; then
        printf "${COLOR_CYAN}Deleting clean instances:${COLOR_RESET}\n"
        printf "%s\n" "$all_clean_instances" | while IFS= read -r directory; do
            [ -z "$directory" ] && continue
            printf "  Removing: %s\n" "$(basename "$directory")"
            rm -rf "$directory" 2>/dev/null || {
                [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}Warning: Could not delete %s${COLOR_RESET}\n" "$directory"
            }
        done
    fi
    
    # Handle instances needing verification with numbered list
    if [ -n "$all_verification_instances" ]; then
        printf "\n${COLOR_YELLOW}The following instances have differences:${COLOR_RESET}\n"
        
        # Create numbered list
        counter=1
        while IFS= read -r directory; do
            [ -z "$directory" ] && continue
            details_line=$(printf "%s\n" "$all_verification_details" | sed -n "${counter}p")
            printf "  ${COLOR_BOLD}%d.${COLOR_RESET} %s\n" "$counter" "$details_line"
            counter=$((counter + 1))
        done <<EOF
$all_verification_instances
EOF
        
        printf "\n${COLOR_YELLOW}Enter numbers to delete (e.g., '1 3 5'), 'all' for all, or 'n' to skip: ${COLOR_RESET}"
        read -r user_response
        
        case "$user_response" in
            [Nn]|[Nn][Oo]|"")
                printf "${COLOR_YELLOW}Skipped deletion of instances with differences.${COLOR_RESET}\n"
                ;;
            [Aa]|[Aa][Ll][Ll])
                # Delete all instances with differences
                printf "%s\n" "$all_verification_instances" | while IFS= read -r directory; do
                    [ -z "$directory" ] && continue
                    printf "  Removing: %s\n" "$(basename "$directory")"
                    rm -rf "$directory" 2>/dev/null || {
                        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}Warning: Could not delete %s${COLOR_RESET}\n" "$directory"
                    }
                done
                printf "${COLOR_GREEN}All instances with differences deleted.${COLOR_RESET}\n"
                ;;
            *)
                # Delete selected instances
                for num in $user_response; do
                    if printf "%s" "$num" | grep -q '^[0-9][0-9]*$'; then
                        # Find the directory for this number
                        selected_directory=$(printf "%s\n" "$all_verification_instances" | sed -n "${num}p")
                        if [ -n "$selected_directory" ]; then
                            printf "  Removing: %s\n" "$(basename "$selected_directory")"
                            rm -rf "$selected_directory" 2>/dev/null || {
                                [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}Warning: Could not delete %s${COLOR_RESET}\n" "$selected_directory"
                            }
                        else
                            printf "${COLOR_YELLOW}Invalid number: %s${COLOR_RESET}\n" "$num"
                        fi
                    fi
                done
                printf "${COLOR_GREEN}Selected instances deleted.${COLOR_RESET}\n"
                ;;
        esac
    else
        printf "${COLOR_GREEN}All clean instances cleared.${COLOR_RESET}\n"
    fi
    
    # Navigate to main repo if we're in a deleted instance
    if [ ! -d "$CURRENT_DIRECTORY" ]; then
        # Try to find current repo main
        current_repo_name=$(get_main_repo_name "$repository_root")
        if [ -d "$parent_directory/$current_repo_name" ]; then
            cd "$parent_directory/$current_repo_name" || return 1
        else
            cd "$parent_directory" || return 1
        fi
        [ $VERBOSE_MODE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    fi
    
    return 0
}

# Switch to specific layer with fallback
switch_to_layer() {
    # Determine the actual repository root
    repository_root="$CURRENT_DIRECTORY"
    
    # If we're inside a ._ directory, go up to find the actual repo root
    if [ "$(basename "$repository_root")" = "$LAYER_NAME" ]; then
        repository_root="$(dirname "$repository_root")"
    fi
    
    # Get repo name
    repository_name=$(get_repo_name_from_git "$repository_root")
    if [ -z "$repository_name" ]; then
        repository_name=$(get_main_repo_name "$repository_root")
    fi
    
    # Get parent directory
    parent_directory="$(dirname "$repository_root")"
    
    # Determine target directory
    if [ -z "$TARGET_LAYER_NUMBER" ] || [ "$TARGET_LAYER_NUMBER" = "0" ]; then
        # Switch to main repo
        target_directory="$parent_directory/${repository_name}"
    elif is_numeric "$TARGET_LAYER_NUMBER"; then
        # Numeric switching
        if [ -d "$parent_directory/${repository_name}_${TARGET_LAYER_NUMBER}" ]; then
            target_directory="$parent_directory/${repository_name}_${TARGET_LAYER_NUMBER}"
        else
            # Fallback: find next higher number
            found_layer=0
            higher_number=$((TARGET_LAYER_NUMBER + 1))
            while [ $higher_number -le 999 ]; do
                if [ -d "$parent_directory/${repository_name}_${higher_number}" ]; then
                    target_directory="$parent_directory/${repository_name}_${higher_number}"
                    found_layer=1
                    break
                fi
                higher_number=$((higher_number + 1))
            done
            
            # If not found, find previous lower number
            if [ $found_layer -eq 0 ]; then
                lower_number=$((TARGET_LAYER_NUMBER - 1))
                while [ $lower_number -ge 1 ]; do
                    if [ -d "$parent_directory/${repository_name}_${lower_number}" ]; then
                        target_directory="$parent_directory/${repository_name}_${lower_number}"
                        found_layer=1
                        break
                    fi
                    lower_number=$((lower_number - 1))
                done
            fi
            
            if [ $found_layer -eq 0 ]; then
                [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: No layer found for number %s (neither exact nor nearby)${COLOR_RESET}\n" "$TARGET_LAYER_NUMBER"
                return 1
            fi
        fi
    else
        # Custom name switching
        target_directory="$parent_directory/${repository_name}_${TARGET_LAYER_NUMBER}"
        if [ ! -d "$target_directory" ]; then
            [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Layer '%s' not found${COLOR_RESET}\n" "${repository_name}_${TARGET_LAYER_NUMBER}"
            return 1
        fi
    fi
    
    # Check if target directory exists
    if [ ! -d "$target_directory" ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Target directory not found: %s${COLOR_RESET}\n" "$target_directory"
        return 1
    fi
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Switching to layer %s: %s\n" "${TARGET_LAYER_NUMBER:-main}" "$target_directory"
    
    # Navigate to target directory
    cd "$target_directory" || return 1
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    return 0
}

# Switch to layer by name (shorthand for `lay swi <name>`)
switch_by_name() {
    # This function uses the same logic as switch_to_layer but sets TARGET_LAYER_NUMBER
    if [ -z "$TARGET_NAME" ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: No name specified${COLOR_RESET}\n"
        return 1
    fi
    
    # Set TARGET_LAYER_NUMBER to the name and call switch_to_layer
    TARGET_LAYER_NUMBER="$TARGET_NAME"
    switch_to_layer
    return $?
}

# List all layer instances (full names)
list_layers() {
    # Determine current repo root and parent dir
    repository_root="$CURRENT_DIRECTORY"
    if [ "$(basename "$repository_root")" = "$LAYER_NAME" ]; then
        repository_root="$(dirname "$repository_root")"
    fi
    parent_directory="$(dirname "$repository_root")"
    
    # Get repo name
    repository_name=$(get_repo_name_from_git "$repository_root")
    if [ -z "$repository_name" ]; then
        repository_name=$(get_main_repo_name "$repository_root")
    fi
    
    # Get current instance
    current_basename="$(basename "$repository_root")"
    
    printf "${COLOR_CYAN}Layers for repository ${COLOR_BOLD}'%s'${COLOR_RESET}:\n" "$repository_name"
    
    # Print main repo with indicator if current
    if [ "$current_basename" = "$repository_name" ]; then
        printf "  ${COLOR_GREEN}● %s ${COLOR_BOLD}(current)${COLOR_RESET}\n" "$repository_name"
    else
        printf "  %s (main)\n" "$repository_name"
    fi
    
    # Print all layer instances
    for directory in "$parent_directory"/${repository_name}_*; do
        [ -d "$directory" ] || continue
        basename_directory=$(basename "$directory")
        # Skip ._ directories
        if [ "$basename_directory" = "$LAYER_NAME" ]; then
            continue
        fi
        
        if [ "$basename_directory" = "$current_basename" ]; then
            printf "  ${COLOR_GREEN}● %s ${COLOR_BOLD}(current)${COLOR_RESET}\n" "$basename_directory"
        else
            printf "  %s\n" "$basename_directory"
        fi
    done
    return 0
}

# List unique repository names (without numbers)
list_repositories() {
    # Determine parent directory (up one level from current repo root)
    repository_root="$CURRENT_DIRECTORY"
    if [ "$(basename "$repository_root")" = "$LAYER_NAME" ]; then
        repository_root="$(dirname "$repository_root")"
    fi
    parent_directory="$(dirname "$repository_root")"
    
    # Get current repo name
    current_repository=$(get_repo_name_from_git "$repository_root")
    if [ -z "$current_repository" ]; then
        current_repository=$(get_main_repo_name "$repository_root")
    fi
    
    printf "${COLOR_CYAN}Unique repositories in %s:${COLOR_RESET}\n" "$parent_directory"
    
    # Use a temporary file to track seen repos
    seen_file=$(mktemp /tmp/lay_seen.XXXXXX) || return 1
    trap 'rm -f "$seen_file"' RETURN
    
    counter=1
    for directory in "$parent_directory"/*/; do
        [ -d "$directory" ] || continue
        basename_directory=$(basename "$directory")
        # Skip ._ directories
        if [ "$basename_directory" = "$LAYER_NAME" ]; then
            continue
        fi
        # Extract base repo name (everything before the last underscore)
        base_repository_name=$(printf "%s" "$basename_directory" | sed 's/_[^_]*$//')
        # Check if we've seen this repo before
        if ! grep -q "^${base_repository_name}$" "$seen_file" 2>/dev/null; then
            # Add to seen list
            printf "%s\n" "$base_repository_name" >> "$seen_file"
            
            # Print with indicator if current
            if [ "$base_repository_name" = "$current_repository" ]; then
                printf "  ${COLOR_GREEN}● %d. %s ${COLOR_BOLD}(current)${COLOR_RESET}\n" "$counter" "$base_repository_name"
            else
                printf "  %d. %s\n" "$counter" "$base_repository_name"
            fi
            counter=$((counter + 1))
        fi
    done
    return 0
}

# Switch to a different repository (by name or 1-based index)
switch_to_repository() {
    if [ -z "$TARGET_REPOSITORY" ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: repo requires an argument (name or number)${COLOR_RESET}\n"
        return 1
    fi
    
    # Determine current parent directory
    repository_root="$CURRENT_DIRECTORY"
    if [ "$(basename "$repository_root")" = "$LAYER_NAME" ]; then
        repository_root="$(dirname "$repository_root")"
    fi
    parent_directory="$(dirname "$repository_root")"
    
    # Collect unique repo names using temp file
    seen_file=$(mktemp /tmp/lay_seen.XXXXXX) || return 1
    trap 'rm -f "$seen_file"' RETURN    
    # Helper to get nth repo name (1-based)
    get_nth_repository() {
        target_index="$1"
        count=0
        for directory in "$parent_directory"/*/; do
            [ -d "$directory" ] || continue
            basename_directory=$(basename "$directory")
            if [ "$basename_directory" = "$LAYER_NAME" ]; then
                continue
            fi
            base_repository_name=$(printf "%s" "$basename_directory" | sed 's/_[^_]*$//')
            if ! grep -q "^${base_repository_name}$" "$seen_file" 2>/dev/null; then
                printf "%s\n" "$base_repository_name" >> "$seen_file"
                count=$((count + 1))
                if [ $count -eq $target_index ]; then
                    printf "%s" "$base_repository_name"
                    return 0
                fi
            fi
        done
        return 1
    }
    
    # Determine target repo name
    target_repository_name=""
    if printf "%s" "$TARGET_REPOSITORY" | grep -q '^[0-9][0-9]*$'; then
        # Numeric index (1-based)
        index="$TARGET_REPOSITORY"
        target_repository_name=$(get_nth_repository "$index")
        if [ -z "$target_repository_name" ]; then
            [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Repository index %d out of range${COLOR_RESET}\n" "$index"
            return 1
        fi
    else
        # Assume it's a name - try exact match first
        if [ -d "$parent_directory/$TARGET_REPOSITORY" ]; then
            target_repository_name="$TARGET_REPOSITORY"
        else
            # Maybe they gave a name that has no main but has instances?
            found_repository=0
            for directory in "$parent_directory"/${TARGET_REPOSITORY}_*; do
                if [ -d "$directory" ]; then
                    target_repository_name="$TARGET_REPOSITORY"
                    found_repository=1
                    break
                fi
            done
            if [ $found_repository -eq 0 ]; then
                [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Repository '%s' not found${COLOR_RESET}\n" "$TARGET_REPOSITORY"
                return 1
            fi
        fi
    fi
    
    # Now navigate to main directory if exists, else first instance
    if [ -d "$parent_directory/$target_repository_name" ]; then
        target_directory="$parent_directory/$target_repository_name"
    else
        # Find first instance
        for directory in "$parent_directory"/${target_repository_name}_*; do
            if [ -d "$directory" ]; then
                target_directory="$directory"
                break
            fi
        done
        if [ -z "$target_directory" ]; then
            [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: No directory found for repository '%s'${COLOR_RESET}\n" "$target_repository_name"
            return 1
        fi
    fi
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Switching to repository '%s': %s\n" "$target_repository_name" "$target_directory"
    cd "$target_directory" || return 1
    [ $VERBOSE_MODE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    return 0
}

# Navigate to a git diff file's directory
navigate_to_diff_file() {
    # Check git availability
    if ! command -v git >/dev/null 2>&1; then
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: git is required${COLOR_RESET}\n"
        return 1
    fi
    
    # Find git repository root
    git_root=$(git rev-parse --show-toplevel 2>/dev/null)
    if [ -z "$git_root" ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Not in a git repository${COLOR_RESET}\n"
        return 1
    fi
    
    # Collect changed files (unstaged + staged), deduplicated
    diff_files=$(
        cd "$git_root" 2>/dev/null || exit 0
        git diff --name-only 2>/dev/null
        git diff --name-only --cached 2>/dev/null
    )
    diff_files=$(printf "%s\n" "$diff_files" | awk 'NF && !seen[$0]++')
    
    if [ -z "$diff_files" ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_YELLOW}No git diff files found${COLOR_RESET}\n"
        return 1
    fi
    
    file_count=$(printf "%s\n" "$diff_files" | wc -l | tr -d ' ')
    
    if [ "$file_count" -eq 1 ]; then
        # Only one file - navigate directly without selection
        selected_file="$diff_files"
    else
        # Multiple files - show selection list
        printf "${COLOR_CYAN}Git diff files:${COLOR_RESET}\n"
        counter=1
        printf "%s\n" "$diff_files" | while IFS= read -r file_path; do
            [ -z "$file_path" ] && continue
            printf "  ${COLOR_BOLD}%d.${COLOR_RESET} %s\n" "$counter" "$file_path"
            counter=$((counter + 1))
        done
        
        printf "\n${COLOR_YELLOW}Enter number to navigate to (or 'n' to cancel): ${COLOR_RESET}"
        read -r user_response
        
        case "$user_response" in
            ''|[Nn]|[Nn][Oo])
                printf "${COLOR_YELLOW}Cancelled.${COLOR_RESET}\n"
                return 1
                ;;
            *[!0-9]*)
                printf "${COLOR_RED}Invalid selection: %s${COLOR_RESET}\n" "$user_response"
                return 1
                ;;
        esac
        
        selected_file=$(printf "%s\n" "$diff_files" | sed -n "${user_response}p")
        if [ -z "$selected_file" ]; then
            printf "${COLOR_RED}Invalid selection: %s${COLOR_RESET}\n" "$user_response"
            return 1
        fi
    fi
    
    # Determine target directory (directory containing the selected file)
    file_directory=$(dirname "$selected_file")
    if [ "$file_directory" = "." ]; then
        target_directory="$git_root"
    else
        target_directory="$git_root/$file_directory"
    fi
    
    if [ ! -d "$target_directory" ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "${COLOR_RED}Error: Directory not found: %s${COLOR_RESET}\n" "$target_directory"
        return 1
    fi
    
    [ $VERBOSE_MODE -eq 1 ] && printf "Navigating to: %s\n" "$target_directory"
    cd "$target_directory" || return 1
    [ $VERBOSE_MODE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    return 0
}

# Run internal tests
run_internal_tests() {
    printf "${COLOR_YELLOW}Running internal tests...${COLOR_RESET}\n"
    
    # Check if git is available
    if ! command -v git >/dev/null 2>&1; then
        printf "${COLOR_RED}Error: git is required for tests${COLOR_RESET}\n"
        return 1
    fi
    
    # Create temporary test directory
    TEST_ROOT_DIRECTORY=$(mktemp -d /tmp/lay_test.XXXXXX) || {
        printf "${COLOR_RED}Failed to create temp dir${COLOR_RESET}\n"
        return 1
    }
    trap 'rm -rf "$TEST_ROOT_DIRECTORY"' EXIT
    
    cd "$TEST_ROOT_DIRECTORY" || return 1
    CURRENT_DIRECTORY="$PWD"
    
    # Create a real git repository
    mkdir testrepo
    cd testrepo
    git init >/dev/null 2>&1
    
    # Create tracked files
    echo "tracked content" > tracked.txt
    echo "another tracked" > tracked2.txt
    echo "tracked3" > tracked3.txt
    
    # Create .gitignore with ignored files
    echo "*.log" > .gitignore
    echo "ignored/" >> .gitignore
    echo "ignored content" > test.log
    mkdir -p ignored
    echo "ignored dir content" > ignored/ignored.txt
    
    # Create untracked file (not added)
    echo "untracked content" > untracked.txt
    
    # Add and commit tracked files
    git add tracked.txt tracked2.txt tracked3.txt .gitignore >/dev/null 2>&1
    git commit -m "Initial commit" >/dev/null 2>&1
    
    # Set current directory to the repo
    CURRENT_DIRECTORY="$PWD"
    
    printf "\n--- Test 1: Create layer with only tracked files (clean) ---\n"
    CREATE_NEW_LAYER=1
    INCLUDE_UNCOMMITTED=0
    CUSTOM_LAYER_NAME=""
    if create_new_layer; then
        printf "PASS: New layer created\n"
    else
        printf "FAIL: create_new_layer failed\n"
        return 1
    fi
    CURRENT_DIRECTORY="$PWD"
    
    # Check that tracked files are copied
    if [ -f "tracked.txt" ] && [ -f "tracked2.txt" ] && [ -f "tracked3.txt" ] && [ -f ".gitignore" ]; then
        printf "PASS: Tracked files copied\n"
    else
        printf "FAIL: Tracked files not copied\n"
        printf "Files in current dir:\n"
        ls -la
        return 1
    fi
    
    # Check that untracked files are NOT copied
    if [ ! -f "untracked.txt" ]; then
        printf "PASS: Untracked file not copied (correct)\n"
    else
        printf "FAIL: Untracked file was copied (should not be)\n"
        return 1
    fi
    
    # Check that ignored files are NOT copied
    if [ ! -f "test.log" ] && [ ! -d "ignored" ]; then
        printf "PASS: Ignored files not copied (correct)\n"
    else
        printf "FAIL: Ignored files were copied (should not be)\n"
        return 1
    fi
    
    # Switch back to main repo
    cd "$TEST_ROOT_DIRECTORY/testrepo"
    CURRENT_DIRECTORY="$PWD"
    
    printf "\n--- Test 2: Create layer with all files (--changes) ---\n"
    CREATE_NEW_LAYER=1
    INCLUDE_UNCOMMITTED=1
    CUSTOM_LAYER_NAME="with-changes"
    if create_new_layer; then
        printf "PASS: Layer with changes created\n"
    else
        printf "FAIL: create_new_layer with changes failed\n"
        return 1
    fi
    CURRENT_DIRECTORY="$PWD"
    
    # Check that all files are copied including untracked
    if [ -f "tracked.txt" ] && [ -f "tracked2.txt" ] && [ -f ".gitignore" ] && [ -f "untracked.txt" ]; then
        printf "PASS: All files copied (tracked + untracked)\n"
    else
        printf "FAIL: Not all files copied\n"
        printf "Files in current dir:\n"
        ls -la
        return 1
    fi
    
    # Check that ignored files are also copied
    if [ -f "test.log" ] && [ -d "ignored" ]; then
        printf "PASS: Ignored files copied (correct with --changes)\n"
    else
        printf "FAIL: Ignored files not copied with --changes\n"
        printf "Files in current dir:\n"
        ls -la
        return 1
    fi
    
    printf "\n--- Test 3: Switch back to main repo ---\n"
    SWITCH_TO_LAYER=1
    TARGET_LAYER_NUMBER="0"
    if switch_to_layer; then
        printf "PASS: Switched to main\n"
    else
        printf "FAIL: switch_to_layer failed\n"
        return 1
    fi
    
    printf "\n--- Test 4: List layers ---\n"
    LIST_ALL_LAYERS=1
    output=$(list_layers)
    printf "%s\n" "$output"
    if printf "%s" "$output" | grep -q "testrepo_1" && printf "%s" "$output" | grep -q "testrepo_with-changes"; then
        printf "PASS: list contains both layers\n"
    else
        printf "FAIL: list output missing layers\n"
        return 1
    fi
    
    printf "\n--- Test 5: Switch by name shorthand ---\n"
    # Switch to testrepo_with-changes by name
    SWITCH_BY_NAME=1
    TARGET_NAME="with-changes"
    if switch_by_name; then
        printf "PASS: Switched by name to 'with-changes'\n"
    else
        printf "FAIL: switch_by_name failed\n"
        return 1
    fi
    
    # Verify we're in the right directory
    current_basename="$(basename "$PWD")"
    if [ "$current_basename" = "testrepo_with-changes" ]; then
        printf "PASS: Successfully in testrepo_with-changes\n"
    else
        printf "FAIL: Not in expected directory (in %s)\n" "$current_basename"
        return 1
    fi
    
    printf "\n--- Test 6: Cleanup ---\n"
    # Delete both layers
    cd "$TEST_ROOT_DIRECTORY/testrepo_1"
    DELETE_CURRENT_LAYER=1
    delete_current_layer >/dev/null 2>&1
    
    cd "$TEST_ROOT_DIRECTORY/testrepo_with-changes"
    DELETE_CURRENT_LAYER=1
    delete_current_layer >/dev/null 2>&1
    
    CURRENT_DIRECTORY="$PWD"
    if [ "$(basename "$PWD")" = "testrepo" ]; then
        printf "PASS: Cleanup successful\n"
    else
        printf "FAIL: Cleanup did not return to main (in %s)\n" "$PWD"
        return 1
    fi
    
    printf "${COLOR_GREEN}All tests passed!${COLOR_RESET}\n"
    return 0
}

# Main logic
if [ $RUN_INTERNAL_TESTS -eq 1 ]; then
    run_internal_tests
    return $? 2>/dev/null || exit $?
fi

if [ $LIST_ALL_LAYERS -eq 1 ]; then
    list_layers
    return $? 2>/dev/null || exit $?
fi

if [ $LIST_ALL_REPOSITORIES -eq 1 ]; then
    list_repositories
    return $? 2>/dev/null || exit $?
fi

if [ $SWITCH_REPOSITORY -eq 1 ]; then
    switch_to_repository
    [ $? -eq 0 ] && [ $VERBOSE_MODE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

if [ $CREATE_NEW_LAYER -eq 1 ]; then
    create_new_layer
    [ $? -eq 0 ] && [ $VERBOSE_MODE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

if [ $DELETE_CURRENT_LAYER -eq 1 ]; then
    delete_current_layer
    [ $? -eq 0 ] && [ $VERBOSE_MODE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

if [ $CLEAR_ALL_LAYERS -eq 1 ]; then
    clear_all_layers
    [ $? -eq 0 ] && [ $VERBOSE_MODE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

if [ $CLEAR_CURRENT_REPO -eq 1 ]; then
    clear_current_repo_instances
    [ $? -eq 0 ] && [ $VERBOSE_MODE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

if [ $DIFF_NAVIGATE -eq 1 ]; then
    navigate_to_diff_file
    [ $? -eq 0 ] && [ $VERBOSE_MODE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

if [ $SWITCH_TO_LAYER -eq 1 ]; then
    switch_to_layer
    [ $? -eq 0 ] && [ $VERBOSE_MODE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

# Handle switch by name (shorthand for `lay swi <name>`)
if [ $SWITCH_BY_NAME -eq 1 ]; then
    switch_by_name
    [ $? -eq 0 ] && [ $VERBOSE_MODE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

# Default behavior: navigate ._ layers
layers_above_count=$(count_layers_above "$CURRENT_DIRECTORY")
deep_layer_information=$(find_deepest_layer "$CURRENT_DIRECTORY")
available_deep_layers=$(printf "%s" "$deep_layer_information" | cut -d: -f1)

if [ $REVERSE_MODE -eq 1 ]; then
    if [ $layers_above_count -eq 0 ]; then
        [ $VERBOSE_MODE -eq 1 ] && printf "Not inside any %s directory\n" "$LAYER_NAME"
        [ $VERBOSE_MODE -eq 0 ] && clear
        return 1 2>/dev/null || exit 1
    fi
    go_back
    [ $? -eq 0 ] && [ $VERBOSE_MODE -eq 0 ] && clear
elif [ $layers_above_count -gt 0 ]; then
    go_back
    [ $? -eq 0 ] && [ $VERBOSE_MODE -eq 0 ] && clear
elif [ $available_deep_layers -gt 0 ]; then
    go_deep
    [ $? -eq 0 ] && [ $VERBOSE_MODE -eq 0 ] && clear
else
    [ $VERBOSE_MODE -eq 1 ] && printf "No %s directories found in current path\n" "$LAYER_NAME"
    [ $VERBOSE_MODE -eq 1 ] && printf "Current directory: %s\n" "$PWD"
    [ $VERBOSE_MODE -eq 0 ] && clear
    return 1 2>/dev/null || exit 1
fi