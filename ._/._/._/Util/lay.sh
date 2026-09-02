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
    NC='\033[0m'
else
    GREEN=''
    BLUE=''
    YELLOW=''
    RED=''
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
        [ $VERBOSE -eq 1 ] && printf "${RED}Error: Could not determine repository name from .git/config${NC}\n"
        return 1
    fi
    
    [ $VERBOSE -eq 1 ] && printf "Repository name: %s\n" "$repo_name"
    
    # Get current branch name
    current_branch=""
    if [ -f "$repo_root/.git/HEAD" ]; then
        current_branch=$(grep -o 'refs/heads/.*' "$repo_root/.git/HEAD" 2>/dev/null | sed 's|refs/heads/||')
        if [ -z "$current_branch" ]; then
            current_branch=$(cat "$repo_root/.git/HEAD" 2>/dev/null | sed 's/.*\///')
        fi
    fi
    
    # If no branch found, try git command
    if [ -z "$current_branch" ] && command -v git >/dev/null 2>&1; then
        current_branch=$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null)
    fi
    
    [ $VERBOSE -eq 1 ] && printf "Current branch: %s\n" "$current_branch"
    
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
    mkdir -p "$new_layer_dir" || return 1
    
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
        # Clean copy (only tracked files from HEAD)
        [ $VERBOSE -eq 1 ] && printf "Creating clean copy from HEAD...\n"
        
        # Use git archive for clean copy if possible
        if command -v git >/dev/null 2>&1 && [ -d "$repo_root/.git" ]; then
            # Try to use git archive for a clean copy
            (cd "$repo_root" && git archive HEAD 2>/dev/null | (cd "$new_layer_dir" && tar -x 2>/dev/null))
            
            # If git archive worked, copy .git as well
            if [ $? -eq 0 ]; then
                cp -r "$repo_root/.git" "$new_layer_dir/.git" 2>/dev/null
            else
                # Fallback: use git ls-files
                tracked_files=$(git -C "$repo_root" ls-files 2>/dev/null)
                if [ -n "$tracked_files" ]; then
                    printf "%s\n" "$tracked_files" | while IFS= read -r file; do
                        src="$repo_root/$file"
                        dst="$new_layer_dir/$file"
                        if [ -e "$src" ] || [ -L "$src" ]; then
                            mkdir -p "$(dirname "$dst")"
                            cp -r "$src" "$dst" 2>/dev/null
                        fi
                    done
                    cp -r "$repo_root/.git" "$new_layer_dir/.git" 2>/dev/null
                fi
            fi
        fi
    fi
    
    # Navigate to the new directory
    cd "$new_layer_dir" || return 1
    
    # Reset to HEAD for clean copy (remove any uncommitted changes)
    if [ $WITH_CHANGES -eq 0 ] && command -v git >/dev/null 2>&1; then
        git reset --hard HEAD >/dev/null 2>&1
        git clean -fd >/dev/null 2>&1
    fi
    
    # Ensure we're on master/main branch for clean copy
    if [ $WITH_CHANGES -eq 0 ] && command -v git >/dev/null 2>&1; then
        # Try to checkout master first, then main
        git checkout master >/dev/null 2>&1 || {
            git checkout main >/dev/null 2>&1 || {
                # If neither exists, create master
                git checkout -b master >/dev/null 2>&1 || {
                    git checkout -b main >/dev/null 2>&1
                }
            }
        }
    fi
    
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

# Switch to specific layer
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
    
    # Determine target directory
    if [ -z "$SWITCH_NUM" ] || [ "$SWITCH_NUM" = "0" ]; then
        target_dir="$parent_dir/${repo_name}"
    else
        target_dir="$parent_dir/${repo_name}_${SWITCH_NUM}"
    fi
    
    # Check if target directory exists
    if [ ! -d "$target_dir" ]; then
        [ $VERBOSE -eq 1 ] && printf "${RED}Error: Layer %s not found: %s${NC}\n" "$SWITCH_NUM" "$target_dir"
        return 1
    fi
    
    [ $VERBOSE -eq 1 ] && printf "Switching to layer %s: %s\n" "${SWITCH_NUM:-0}" "$target_dir"
    
    # Navigate to target directory
    cd "$target_dir" || return 1
    
    [ $VERBOSE -eq 1 ] && printf "Now at: %s\n" "$PWD"
    return 0
}

# Main logic
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