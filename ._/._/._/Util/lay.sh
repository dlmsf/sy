#!/bin/sh

# Lay.sh - Layer Directory Navigator
# Compatible with sh/ash/bash
# Usage: lay [options] [command]
# Options:
#   [number]        - Move exact number of layers
#   reverse, -r, --reverse  - Force reverse direction
#   back, up, -u, --up     - Go back/up (alternative to reverse)
#   new             - Create new layer (clean copy)
#   new --changes   - Create new layer with uncommitted changes
#   delete          - Delete current layer and return to main repo
#   swi [N]         - Switch to layer N (0 = main repo)
#   reposwi [name|N]- Switch to a different repository (by name or index)
#   repo [name|N]   - Switch to a different repository (alternative to reposwi)
#   list            - List all layer instances (full names)
#   repos           - List unique repository names
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
    GREEN='\033[0;32m'
    BLUE='\033[0;34m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    CYAN='\033[0;36m'
    MAGENTA='\033[0;35m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    GREEN=''
    BLUE=''
    YELLOW=''
    RED=''
    CYAN=''
    MAGENTA=''
    BOLD=''
    NC=''
fi

show_help() {
    printf "${GREEN}Lay.sh${NC} - Layer Directory Navigator\n"
    printf "====================================\n"
    printf "Navigate between ${BLUE}%s${NC} directory layers like ping-pong.\n\n" "$LAYER_NAME"
    printf "${YELLOW}Usage:${NC}\n"
    printf "  lay                # Go deep to last layer, or back to top (silent)\n"
    printf "  lay [N]            # Move N layers (deep or back) (silent)\n"
    printf "  lay new            # Create new layer (clean copy, no changes)\n"
    printf "  lay new --changes  # Create new layer with uncommitted changes\n"
    printf "  lay delete         # Delete current layer and return to main repo\n"
    printf "  lay swi [N]        # Switch to layer N (0 = main repo)\n"
    printf "  lay repo [name|N]  # Switch to a different repository (by name or 1-based index)\n"
    printf "  lay reposwi [name|N] # Alternative: switch to different repository\n"
    printf "  lay list           # List all layer instances (full names)\n"
    printf "  lay repos          # List unique repository names\n"
    printf "  lay --test         # Run internal tests\n"
    printf "  lay reverse        # Force go back/up (silent)\n"
    printf "  lay back           # Alternative: go back/up (silent)\n"
    printf "  lay -r | --reverse # Same as reverse (silent)\n"
    printf "  lay -u | --up      # Same as back (silent)\n"
    printf "  lay -v | --verbose # Show detailed output\n"
    printf "  lay -h | --help    # Show this help\n"
}

# Parse arguments
REVERSE=0
LAYERS=""
VERBOSE=0
NEW_LAYER=0
WITH_CHANGES=0
DELETE_LAYER=0
SWITCH_LAYER=0
SWITCH_NUM=""
REPO_SWITCH=0
REPO_TARGET=""
LIST_LAYERS=0
LIST_REPOS=0
RUN_TEST=0

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            show_help
            return 0 2>/dev/null || exit 0
            ;;
        -v|--verbose)
            VERBOSE=1
            shift
            ;;
        -r|--reverse|reverse|back|-u|--up|up)
            REVERSE=1
            shift
            ;;
        new|--new|-n)
            NEW_LAYER=1
            shift
            # Check for --changes flag
            if [ "$1" = "--changes" ] || [ "$1" = "-c" ] || [ "$1" = "changes" ]; then
                WITH_CHANGES=1
                shift
            fi
            ;;
        delete|--delete|-d|del)
            DELETE_LAYER=1
            shift
            ;;
        swi|--swi|-s|switch|--switch)
            SWITCH_LAYER=1
            shift
            # Check if there's a number argument
            if [ $# -gt 0 ]; then
                case "$1" in
                    ''|*[!0-9]*)
                        printf "Invalid switch number: %s (expected number)\n" "$1"
                        return 1 2>/dev/null || exit 1
                        ;;
                    *)
                        SWITCH_NUM="$1"
                        shift
                        ;;
                esac
            fi
            ;;
        repo|--repo)
            REPO_SWITCH=1
            shift
            # Check for argument (name or number)
            if [ $# -gt 0 ]; then
                REPO_TARGET="$1"
                shift
            fi
            ;;
        reposwi|--reposwi|-rs|reposwitch|swirepo|swi-repo)
            REPO_SWITCH=1
            shift
            # Check for argument (name or number)
            if [ $# -gt 0 ]; then
                REPO_TARGET="$1"
                shift
            fi
            ;;
        list|--list|-l)
            LIST_LAYERS=1
            shift
            ;;
        repos|--repos|-rp)
            LIST_REPOS=1
            shift
            ;;
        --test|-t|test)
            RUN_TEST=1
            shift
            ;;
        -*)
            printf "Unknown option: %s\n" "$1"
            printf "Use -h for help\n"
            return 1 2>/dev/null || exit 1
            ;;
        *)
            case "$1" in
                ''|*[!0-9]*)
                    printf "Invalid argument: %s (expected number or option)\n" "$1"
                    return 1 2>/dev/null || exit 1
                    ;;
                *)
                    LAYERS="$1"
                    shift
                    ;;
            esac
            ;;
    esac
done

# Store current directory
CURRENT_DIR="$PWD"

# Find deepest ._ path from current position
find_deepest_layer() {
    start_dir="$1"
    current="$start_dir"
    depth=0
    
    while [ -d "$current/$LAYER_NAME" ]; do
        current="$current/$LAYER_NAME"
        depth=$((depth + 1))
    done
    
    printf "%d:%s\n" "$depth" "$current"
}

# Find the top directory above all ._ layers
find_top_directory() {
    current="$1"
    
    # First, go up until we're no longer inside a ._ directory
    while [ "$current" != "/" ] && [ "$(basename "$current")" = "$LAYER_NAME" ]; do
        current="$(dirname "$current")"
    done
    
    # Now go up until we find a directory that has a ._ subdirectory
    while [ "$current" != "/" ]; do
        if [ -d "$current/$LAYER_NAME" ]; then
            break
        fi
        current="$(dirname "$current")"
    done
    
    printf "%s\n" "$current"
}

# Count how many ._ layers are above current position
count_layers_above() {
    current="$1"
    count=0
    
    while [ "$current" != "/" ]; do
        if [ "$(basename "$current")" = "$LAYER_NAME" ]; then
            count=$((count + 1))
        fi
        current="$(dirname "$current")"
    done
    
    printf "%d\n" "$count"
}

# Go deep into layers
go_deep() {
    deep_info=$(find_deepest_layer "$CURRENT_DIR")
    available_layers=$(printf "%s" "$deep_info" | cut -d: -f1)
    deepest_path=$(printf "%s" "$deep_info" | cut -d: -f2)
    
    if [ "$available_layers" -eq 0 ]; then
        [ $VERBOSE -eq 1 ] && printf "Already at the deepest level (no %s directories found)\n" "$LAYER_NAME"
        return 1
    fi
    
    target_path="$deepest_path"
    
    if [ -n "$LAYERS" ]; then
        if [ "$LAYERS" -gt "$available_layers" ]; then
            [ $VERBOSE -eq 1 ] && printf "${YELLOW}Requested %d layers, but only %d available${NC}\n" "$LAYERS" "$available_layers"
            target_path="$deepest_path"
        else
            current="$CURRENT_DIR"
            i=0
            while [ $i -lt "$LAYERS" ]; do
                if [ -d "$current/$LAYER_NAME" ]; then
                    current="$current/$LAYER_NAME"
                    i=$((i + 1))
                else
                    break
                fi
            done
            target_path="$current"
            [ $VERBOSE -eq 1 ] && printf "Moving %d layer(s) deeper...\n" "$LAYERS"
        fi
    else
        [ $VERBOSE -eq 1 ] && printf "Moving to deepest layer (%d level(s) deep)...\n" "$available_layers"
    fi
    
    if [ "$target_path" != "$CURRENT_DIR" ]; then
        cd "$target_path" || return 1
        [ $VERBOSE -eq 1 ] && printf "Now at: %s\n" "$PWD"
        return 0
    else
        [ $VERBOSE -eq 1 ] && printf "Already at target directory\n"
        return 1
    fi
}

# Go back from layers
go_back() {
    layers_above=$(count_layers_above "$CURRENT_DIR")
    
    if [ -n "$LAYERS" ]; then
        if [ "$LAYERS" -gt "$layers_above" ]; then
            [ $VERBOSE -eq 1 ] && printf "${YELLOW}Requested to go back %d layers, but only %d available${NC}\n" "$LAYERS" "$layers_above"
            target_path=$(find_top_directory "$CURRENT_DIR")
        else
            current="$CURRENT_DIR"
            i=0
            # Go up the specified number of layers, but stop at ._ boundaries
            while [ $i -lt "$LAYERS" ]; do
                # If we're in a ._ directory, go to its parent
                if [ "$(basename "$current")" = "$LAYER_NAME" ]; then
                    current="$(dirname "$current")"
                    i=$((i + 1))
                else
                    # We're above all ._ layers
                    break
                fi
            done
            target_path="$current"
            [ $VERBOSE -eq 1 ] && printf "Moving back %d layer(s)...\n" "$LAYERS"
        fi
    else
        # Go back to the top directory (the one containing the first ._ layer)
        target_path=$(find_top_directory "$CURRENT_DIR")
        [ $VERBOSE -eq 1 ] && printf "Moving back to top directory...\n"
    fi
    
    if [ "$target_path" != "$CURRENT_DIR" ]; then
        cd "$target_path" || return 1
        [ $VERBOSE -eq 1 ] && printf "Now at: %s\n" "$PWD"
        return 0
    else
        [ $VERBOSE -eq 1 ] && printf "Already at the top level\n"
        return 1
    fi
}

# Get repo name from .git
get_repo_name_from_git() {
    git_config="$1/.git/config"
    
    if [ ! -f "$git_config" ]; then
        return 1
    fi
    
    # Try to get URL from git config
    git_url=$(grep -m 1 "url = " "$git_config" | sed 's/.*url = //' | tr -d '[:space:]')
    
    if [ -z "$git_url" ]; then
        return 1
    fi
    
    # Extract repo name from URL
    # Handle formats like:
    # https://github.com/user/repo.git
    # git@github.com:user/repo.git
    # ssh://git@github.com/user/repo.git
    repo_name=$(printf "%s" "$git_url" | sed 's|.*/||' | sed 's|\.git$||')
    
    if [ -z "$repo_name" ]; then
        return 1
    fi
    
    printf "%s\n" "$repo_name"
}

# Get the main repo name (without _number)
get_main_repo_name() {
    current_dir="$1"
    basename_dir="$(basename "$current_dir")"
    
    # Remove _number suffix if present
    main_name=$(printf "%s" "$basename_dir" | sed 's/_[0-9]*$//')
    
    printf "%s\n" "$main_name"
}

# Get the layer number from directory name (0 if main repo)
get_layer_number() {
    current_dir="$1"
    basename_dir="$(basename "$current_dir")"
    
    # Check if it has _number suffix
    if printf "%s" "$basename_dir" | grep -q '_[0-9]*$'; then
        printf "%s" "$basename_dir" | sed 's/.*_\([0-9]*\)$/\1/'
    else
        printf "0"
    fi
}

# Create new layer
create_new_layer() {
    # Determine the actual repository root (not inside ._ if we're there)
    repo_root="$CURRENT_DIR"
    
    # If we're inside a ._ directory, go up to find the actual repo root
    if [ "$(basename "$repo_root")" = "$LAYER_NAME" ]; then
        repo_root="$(dirname "$repo_root")"
        [ $VERBOSE -eq 1 ] && printf "Detected inside %s, repository root is: %s\n" "$LAYER_NAME" "$repo_root"
    fi
    
    # Check if we're in a git repository
    if [ ! -d "$repo_root/.git" ]; then
        [ $VERBOSE -eq 1 ] && printf "${RED}Error: Not in a git repository${NC}\n"
        return 1
    fi
    
    # Get repo name
    repo_name=$(get_repo_name_from_git "$repo_root")
    if [ -z "$repo_name" ]; then
        # Fallback: use directory name if .git/config doesn't have URL
        repo_name=$(get_main_repo_name "$repo_root")
        [ $VERBOSE -eq 1 ] && printf "Using directory name as repo name: %s\n" "$repo_name"
    fi
    
    [ $VERBOSE -eq 1 ] && printf "Repository name: %s\n" "$repo_name"
    
    # Find parent directory (one level above the repo root)
    parent_dir="$(dirname "$repo_root")"
    
    # Find the next available number for the new layer
    counter=1
    while [ -d "$parent_dir/${repo_name}_${counter}" ]; do
        counter=$((counter + 1))
    done
    
    new_layer_dir="$parent_dir/${repo_name}_${counter}"
    
    [ $VERBOSE -eq 1 ] && printf "Creating new layer directory: %s\n" "$new_layer_dir"
    
    # Create the new directory
    mkdir -p "$new_layer_dir" || {
        [ $VERBOSE -eq 1 ] && printf "${RED}Error: Could not create directory %s${NC}\n" "$new_layer_dir"
        return 1
    }
    
    if [ $WITH_CHANGES -eq 1 ]; then
        # Copy WITH changes (working directory state)
        [ $VERBOSE -eq 1 ] && printf "Copying with uncommitted changes...\n"
        
        # Copy everything except .git
        for item in "$repo_root"/* "$repo_root"/.[!.]* "$repo_root"/..?*; do
            [ -e "$item" ] || continue
            basename_item="$(basename "$item")"
            if [ "$basename_item" != ".git" ] && [ "$basename_item" != "." ] && [ "$basename_item" != ".." ]; then
                cp -r "$item" "$new_layer_dir/" 2>/dev/null || {
                    [ $VERBOSE -eq 1 ] && printf "${YELLOW}Warning: Could not copy %s${NC}\n" "$basename_item"
                }
            fi
        done
        
        # Copy .git
        if [ -d "$repo_root/.git" ]; then
            cp -r "$repo_root/.git" "$new_layer_dir/.git" || {
                [ $VERBOSE -eq 1 ] && printf "${RED}Error: Could not copy .git directory${NC}\n"
                return 1
            }
        fi
    else
        # Clean copy - just copy everything (simpler and more reliable)
        [ $VERBOSE -eq 1 ] && printf "Creating clean copy...\n"
        
        # Copy all files and directories
        for item in "$repo_root"/* "$repo_root"/.[!.]* "$repo_root"/..?*; do
            [ -e "$item" ] || continue
            basename_item="$(basename "$item")"
            if [ "$basename_item" != "." ] && [ "$basename_item" != ".." ]; then
                cp -r "$item" "$new_layer_dir/" 2>/dev/null || {
                    [ $VERBOSE -eq 1 ] && printf "${YELLOW}Warning: Could not copy %s${NC}\n" "$basename_item"
                }
            fi
        done
    fi
    
    # Navigate to the new directory
    cd "$new_layer_dir" || {
        [ $VERBOSE -eq 1 ] && printf "${RED}Error: Could not cd to %s${NC}\n" "$new_layer_dir"
        return 1
    }
    
    [ $VERBOSE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    return 0
}

# Delete current layer
delete_current_layer() {
    # Determine the actual repository root
    repo_root="$CURRENT_DIR"
    
    # If we're inside a ._ directory, go up to find the actual repo root
    if [ "$(basename "$repo_root")" = "$LAYER_NAME" ]; then
        repo_root="$(dirname "$repo_root")"
    fi
    
    # Check if we're in a numbered layer
    layer_num=$(get_layer_number "$repo_root")
    
    if [ "$layer_num" = "0" ]; then
        [ $VERBOSE -eq 1 ] && printf "${RED}Error: Cannot delete main repository${NC}\n"
        return 1
    fi
    
    # Get repo name
    repo_name=$(get_repo_name_from_git "$repo_root")
    if [ -z "$repo_name" ]; then
        repo_name=$(get_main_repo_name "$repo_root")
    fi
    
    # Get parent directory
    parent_dir="$(dirname "$repo_root")"
    
    # Navigate to main repo
    main_repo="$parent_dir/${repo_name}"
    
    if [ ! -d "$main_repo" ]; then
        [ $VERBOSE -eq 1 ] && printf "${RED}Error: Main repository not found: %s${NC}\n" "$main_repo"
        return 1
    fi
    
    [ $VERBOSE -eq 1 ] && printf "Deleting layer: %s\n" "$repo_root"
    [ $VERBOSE -eq 1 ] && printf "Returning to: %s\n" "$main_repo"
    
    # Delete the current layer
    rm -rf "$repo_root" || {
        [ $VERBOSE -eq 1 ] && printf "${RED}Error: Could not delete %s${NC}\n" "$repo_root"
        return 1
    }
    
    # Navigate to main repo
    cd "$main_repo" || return 1
    
    [ $VERBOSE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    return 0
}

# Switch to specific layer with fallback to next/previous available
switch_to_layer() {
    # Determine the actual repository root
    repo_root="$CURRENT_DIR"
    
    # If we're inside a ._ directory, go up to find the actual repo root
    if [ "$(basename "$repo_root")" = "$LAYER_NAME" ]; then
        repo_root="$(dirname "$repo_root")"
    fi
    
    # Get repo name
    repo_name=$(get_repo_name_from_git "$repo_root")
    if [ -z "$repo_name" ]; then
        repo_name=$(get_main_repo_name "$repo_root")
    fi
    
    # Get parent directory
    parent_dir="$(dirname "$repo_root")"
    
    # Determine target directory (with fallback)
    if [ -z "$SWITCH_NUM" ] || [ "$SWITCH_NUM" = "0" ]; then
        target_dir="$parent_dir/${repo_name}"
    else
        # Try exact number first
        if [ -d "$parent_dir/${repo_name}_${SWITCH_NUM}" ]; then
            target_dir="$parent_dir/${repo_name}_${SWITCH_NUM}"
        else
            # Fallback: find next higher number
            found=0
            higher=$((SWITCH_NUM + 1))
            while [ $higher -le 999 ]; do
                if [ -d "$parent_dir/${repo_name}_${higher}" ]; then
                    target_dir="$parent_dir/${repo_name}_${higher}"
                    found=1
                    break
                fi
                higher=$((higher + 1))
            done
            
            # If not found, find previous lower number
            if [ $found -eq 0 ]; then
                lower=$((SWITCH_NUM - 1))
                while [ $lower -ge 1 ]; do
                    if [ -d "$parent_dir/${repo_name}_${lower}" ]; then
                        target_dir="$parent_dir/${repo_name}_${lower}"
                        found=1
                        break
                    fi
                    lower=$((lower - 1))
                done
            fi
            
            if [ $found -eq 0 ]; then
                [ $VERBOSE -eq 1 ] && printf "${RED}Error: No layer found for number %s (neither exact nor nearby)${NC}\n" "$SWITCH_NUM"
                return 1
            fi
        fi
    fi
    
    # Check if target directory exists (already handled, but double-check)
    if [ ! -d "$target_dir" ]; then
        [ $VERBOSE -eq 1 ] && printf "${RED}Error: Target directory not found: %s${NC}\n" "$target_dir"
        return 1
    fi
    
    [ $VERBOSE -eq 1 ] && printf "Switching to layer %s: %s\n" "${SWITCH_NUM:-0}" "$target_dir"
    
    # Navigate to target directory
    cd "$target_dir" || return 1
    
    [ $VERBOSE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    return 0
}

# List all layer instances (full names)
list_layers() {
    # Determine current repo root and parent dir
    repo_root="$CURRENT_DIR"
    if [ "$(basename "$repo_root")" = "$LAYER_NAME" ]; then
        repo_root="$(dirname "$repo_root")"
    fi
    parent_dir="$(dirname "$repo_root")"
    
    # Get repo name
    repo_name=$(get_repo_name_from_git "$repo_root")
    if [ -z "$repo_name" ]; then
        repo_name=$(get_main_repo_name "$repo_root")
    fi
    
    # Get current layer number
    current_layer=$(get_layer_number "$repo_root")
    current_basename="$(basename "$repo_root")"
    
    printf "${CYAN}Layers for repository ${BOLD}'%s'${NC}:\n" "$repo_name"
    
    # Print main repo with indicator if current
    if [ "$current_layer" = "0" ]; then
        printf "  ${GREEN}● %s ${BOLD}(current)${NC}\n" "$repo_name"
    else
        printf "  %s (main)\n" "$repo_name"
    fi
    
    # Print numbered layers
    for dir in "$parent_dir"/${repo_name}_*; do
        [ -d "$dir" ] || continue
        basename_dir=$(basename "$dir")
        # Only list those that match pattern exactly
        if printf "%s" "$basename_dir" | grep -q "^${repo_name}_[0-9][0-9]*$"; then
            if [ "$basename_dir" = "$current_basename" ]; then
                printf "  ${GREEN}● %s ${BOLD}(current)${NC}\n" "$basename_dir"
            else
                printf "  %s\n" "$basename_dir"
            fi
        fi
    done
    return 0
}

# List unique repository names (without numbers)
list_repos() {
    # Determine parent directory (up one level from current repo root)
    repo_root="$CURRENT_DIR"
    if [ "$(basename "$repo_root")" = "$LAYER_NAME" ]; then
        repo_root="$(dirname "$repo_root")"
    fi
    parent_dir="$(dirname "$repo_root")"
    
    # Get current repo name
    current_repo=$(get_repo_name_from_git "$repo_root")
    if [ -z "$current_repo" ]; then
        current_repo=$(get_main_repo_name "$repo_root")
    fi
    
    printf "${CYAN}Unique repositories in %s:${NC}\n" "$parent_dir"
    
    # Use a temporary file to track seen repos
    seen_file=$(mktemp /tmp/lay_seen.XXXXXX) || return 1
    trap 'rm -f "$seen_file"' RETURN
    
    counter=1
    for dir in "$parent_dir"/*/; do
        [ -d "$dir" ] || continue
        basename_dir=$(basename "$dir")
        # Skip ._ directories
        if [ "$basename_dir" = "$LAYER_NAME" ]; then
            continue
        fi
        # Remove _number suffix if present
        base_name=$(printf "%s" "$basename_dir" | sed 's/_[0-9][0-9]*$//')
        # Check if we've seen this repo before
        if ! grep -q "^${base_name}$" "$seen_file" 2>/dev/null; then
            # Add to seen list
            printf "%s\n" "$base_name" >> "$seen_file"
            
            # Print with indicator if current
            if [ "$base_name" = "$current_repo" ]; then
                printf "  ${GREEN}● %d. %s ${BOLD}(current)${NC}\n" "$counter" "$base_name"
            else
                printf "  %d. %s\n" "$counter" "$base_name"
            fi
            counter=$((counter + 1))
        fi
    done
    return 0
}

# Switch to a different repository (by name or 1-based index)
switch_to_repo() {
    if [ -z "$REPO_TARGET" ]; then
        [ $VERBOSE -eq 1 ] && printf "${RED}Error: repo requires an argument (name or number)${NC}\n"
        return 1
    fi
    
    # Determine current parent directory
    repo_root="$CURRENT_DIR"
    if [ "$(basename "$repo_root")" = "$LAYER_NAME" ]; then
        repo_root="$(dirname "$repo_root")"
    fi
    parent_dir="$(dirname "$repo_root")"
    
    # Collect unique repo names using temp file
    seen_file=$(mktemp /tmp/lay_seen.XXXXXX) || return 1
    trap 'rm -f "$seen_file"' RETURN
    
    # Helper to get nth repo name (1-based)
    get_nth_repo() {
        n="$1"
        count=0
        for dir in "$parent_dir"/*/; do
            [ -d "$dir" ] || continue
            basename_dir=$(basename "$dir")
            if [ "$basename_dir" = "$LAYER_NAME" ]; then
                continue
            fi
            base_name=$(printf "%s" "$basename_dir" | sed 's/_[0-9][0-9]*$//')
            if ! grep -q "^${base_name}$" "$seen_file" 2>/dev/null; then
                printf "%s\n" "$base_name" >> "$seen_file"
                count=$((count + 1))
                if [ $count -eq $n ]; then
                    printf "%s" "$base_name"
                    return 0
                fi
            fi
        done
        return 1
    }
    
    # Determine target repo name
    target_repo=""
    if printf "%s" "$REPO_TARGET" | grep -q '^[0-9][0-9]*$'; then
        # Numeric index (1-based)
        idx="$REPO_TARGET"
        target_repo=$(get_nth_repo "$idx")
        if [ -z "$target_repo" ]; then
            [ $VERBOSE -eq 1 ] && printf "${RED}Error: Repository index %d out of range${NC}\n" "$idx"
            return 1
        fi
    else
        # Assume it's a name - try exact match first
        if [ -d "$parent_dir/$REPO_TARGET" ]; then
            target_repo="$REPO_TARGET"
        else
            # Maybe they gave a name that has no main but has numbered instances?
            found=0
            for dir in "$parent_dir"/${REPO_TARGET}_*; do
                if [ -d "$dir" ]; then
                    target_repo="$REPO_TARGET"
                    found=1
                    break
                fi
            done
            if [ $found -eq 0 ]; then
                [ $VERBOSE -eq 1 ] && printf "${RED}Error: Repository '%s' not found${NC}\n" "$REPO_TARGET"
                return 1
            fi
        fi
    fi
    
    # Now navigate to main directory if exists, else first numbered instance
    if [ -d "$parent_dir/$target_repo" ]; then
        target_dir="$parent_dir/$target_repo"
    else
        # Find first numbered instance
        for dir in "$parent_dir"/${target_repo}_*; do
            if [ -d "$dir" ]; then
                target_dir="$dir"
                break
            fi
        done
        if [ -z "$target_dir" ]; then
            [ $VERBOSE -eq 1 ] && printf "${RED}Error: No directory found for repository '%s'${NC}\n" "$target_repo"
            return 1
        fi
    fi
    
    [ $VERBOSE -eq 1 ] && printf "Switching to repository '%s': %s\n" "$target_repo" "$target_dir"
    cd "$target_dir" || return 1
    [ $VERBOSE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    return 0
}

# Run internal tests
run_tests() {
    printf "${YELLOW}Running internal tests...${NC}\n"
    
    # Create temporary test directory
    TEST_ROOT=$(mktemp -d /tmp/lay_test.XXXXXX) || {
        printf "${RED}Failed to create temp dir${NC}\n"
        return 1
    }
    trap 'rm -rf "$TEST_ROOT"' EXIT
    
    cd "$TEST_ROOT" || return 1
    CURRENT_DIR="$PWD"
    
    # Setup a fake git repo
    mkdir -p testrepo/.git
    cat > testrepo/.git/config <<EOF
[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
[remote "origin"]
	url = https://github.com/testuser/testrepo.git
	fetch = +refs/heads/*:refs/heads/*
EOF
    # Create a dummy file
    echo "test content" > testrepo/README.md
    # Create a fake HEAD
    echo "ref: refs/heads/master" > testrepo/.git/HEAD
    
    # Setup a second fake git repo for testing repo switching
    mkdir -p secondrepo/.git
    cat > secondrepo/.git/config <<EOF
[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
[remote "origin"]
	url = https://github.com/testuser/secondrepo.git
	fetch = +refs/heads/*:refs/heads/*
EOF
    echo "second repo content" > secondrepo/README.md
    echo "ref: refs/heads/master" > secondrepo/.git/HEAD
    
    printf "\n--- Test 1: Create first layer ---\n"
    CURRENT_DIR="$TEST_ROOT/testrepo"
    NEW_LAYER=1
    WITH_CHANGES=0
    if create_new_layer; then
        printf "PASS: New layer created\n"
    else
        printf "FAIL: create_new_layer failed\n"
        return 1
    fi
    CURRENT_DIR="$PWD"
    if [ "$(basename "$PWD")" = "testrepo_1" ]; then
        printf "PASS: In testrepo_1 directory\n"
    else
        printf "FAIL: Not in testrepo_1 (in %s)\n" "$PWD"
        return 1
    fi
    
    printf "\n--- Test 2: Switch to main repo (swi 0) ---\n"
    SWITCH_LAYER=1
    SWITCH_NUM="0"
    if switch_to_layer; then
        printf "PASS: Switched to main\n"
    else
        printf "FAIL: switch_to_layer failed\n"
        return 1
    fi
    CURRENT_DIR="$PWD"
    if [ "$(basename "$PWD")" = "testrepo" ]; then
        printf "PASS: In main repo directory\n"
    else
        printf "FAIL: Not in main repo (in %s)\n" "$PWD"
        return 1
    fi
    
    printf "\n--- Test 3: Switch to different repo using 'repo' command ---\n"
    REPO_SWITCH=1
    REPO_TARGET="secondrepo"
    if switch_to_repo; then
        printf "PASS: Switched to secondrepo\n"
    else
        printf "FAIL: switch_to_repo failed\n"
        return 1
    fi
    CURRENT_DIR="$PWD"
    if [ "$(basename "$PWD")" = "secondrepo" ]; then
        printf "PASS: In secondrepo directory\n"
    else
        printf "FAIL: Not in secondrepo (in %s)\n" "$PWD"
        return 1
    fi
    
    printf "\n--- Test 4: Switch back using 'repo' with index ---\n"
    REPO_SWITCH=1
    REPO_TARGET="2"
    if switch_to_repo; then
        printf "PASS: Switched using index\n"
    else
        printf "FAIL: switch_to_repo with index failed\n"
        return 1
    fi
    CURRENT_DIR="$PWD"
    if [ "$(basename "$PWD")" = "testrepo" ]; then
        printf "PASS: In testrepo directory (index 2)\n"
    else
        printf "FAIL: Not in testrepo (in %s)\n" "$PWD"
        return 1
    fi
    
    printf "\n--- Test 5: List repos ---\n"
    LIST_REPOS=1
    output=$(list_repos)
    printf "%s\n" "$output"
    if printf "%s" "$output" | grep -q "testrepo" && printf "%s" "$output" | grep -q "secondrepo"; then
        printf "PASS: repos contains both testrepo and secondrepo\n"
    else
        printf "FAIL: repos output missing repositories\n"
        return 1
    fi
    
    printf "\n--- Test 6: List layers ---\n"
    LIST_LAYERS=1
    output=$(list_layers)
    printf "%s\n" "$output"
    if printf "%s" "$output" | grep -q "testrepo_1"; then
        printf "PASS: list contains testrepo_1\n"
    else
        printf "FAIL: list output missing testrepo_1\n"
        return 1
    fi
    
    printf "\n--- Test 7: Delete layer and cleanup ---\n"
    DELETE_LAYER=1
    delete_current_layer >/dev/null 2>&1
    CURRENT_DIR="$PWD"
    if [ "$(basename "$PWD")" = "testrepo" ]; then
        printf "PASS: Final cleanup delete successful\n"
    else
        printf "FAIL: Final delete did not return to main (in %s)\n" "$PWD"
        return 1
    fi
    
    printf "${GREEN}All tests passed!${NC}\n"
    return 0
}

# Main logic
if [ $RUN_TEST -eq 1 ]; then
    run_tests
    return $? 2>/dev/null || exit $?
fi

if [ $LIST_LAYERS -eq 1 ]; then
    list_layers
    return $? 2>/dev/null || exit $?
fi

if [ $LIST_REPOS -eq 1 ]; then
    list_repos
    return $? 2>/dev/null || exit $?
fi

if [ $REPO_SWITCH -eq 1 ]; then
    switch_to_repo
    [ $? -eq 0 ] && [ $VERBOSE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

if [ $NEW_LAYER -eq 1 ]; then
    create_new_layer
    [ $? -eq 0 ] && [ $VERBOSE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

if [ $DELETE_LAYER -eq 1 ]; then
    delete_current_layer
    [ $? -eq 0 ] && [ $VERBOSE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

if [ $SWITCH_LAYER -eq 1 ]; then
    switch_to_layer
    [ $? -eq 0 ] && [ $VERBOSE -eq 0 ] && clear
    return $? 2>/dev/null || exit $?
fi

layers_above=$(count_layers_above "$CURRENT_DIR")
deep_info=$(find_deepest_layer "$CURRENT_DIR")
available_deep=$(printf "%s" "$deep_info" | cut -d: -f1)

if [ $REVERSE -eq 1 ]; then
    if [ $layers_above -eq 0 ]; then
        [ $VERBOSE -eq 1 ] && printf "Not inside any %s directory\n" "$LAYER_NAME"
        [ $VERBOSE -eq 0 ] && clear
        return 1 2>/dev/null || exit 1
    fi
    go_back
    [ $? -eq 0 ] && [ $VERBOSE -eq 0 ] && clear
elif [ $layers_above -gt 0 ]; then
    go_back
    [ $? -eq 0 ] && [ $VERBOSE -eq 0 ] && clear
elif [ $available_deep -gt 0 ]; then
    go_deep
    [ $? -eq 0 ] && [ $VERBOSE -eq 0 ] && clear
else
    [ $VERBOSE -eq 1 ] && printf "No %s directories found in current path\n" "$LAYER_NAME"
    [ $VERBOSE -eq 1 ] && printf "Current directory: %s\n" "$PWD"
    [ $VERBOSE -eq 0 ] && clear
    return 1 2>/dev/null || exit 1
fi