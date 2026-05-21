#!/bin/sh

# ============================================================================
# QEMU VM Launcher - Unified Script for Multiple OS
# ============================================================================

# --- Default Configuration ---
DEFAULT_OS="alpine"
SSH_BASE_PORT=2222
DEFAULT_DISK_SIZE="10G"
DEFAULT_MEMORY="2048"
ALPINE_DEFAULT_MEMORY="256"
MAX_RETRY_ATTEMPTS=18
RETRY_DELAY_SECONDS=3
DEFAULT_CPU_CORES=1

# --- Network Configuration ---
BRIDGE_NAME="qemubr0"
TAP_PREFIX="qemutap"
BRIDGE_IP="10.10.10.1"
BRIDGE_NETMASK="255.255.255.0"
BRIDGE_SUBNET="10.10.10.0/24"
VM_IP_PREFIX="10.10.10."
VM_IP_START=10
VM_IP_END=99

# NEW: Alternative subnet for nested VMs
NESTED_BRIDGE_IP="10.10.11.1"
NESTED_BRIDGE_NETMASK="255.255.255.0"
NESTED_BRIDGE_SUBNET="10.10.11.0/24"
NESTED_VM_IP_PREFIX="10.10.11."
NESTED_VM_IP_START=10
NESTED_VM_IP_END=99
IS_NESTED="false"

# --- IP Lock Directory (per‑IP atomic reservation) ---
IP_LOCK_DIR="/tmp/qemu_vm_ip_locks"
mkdir -p "$IP_LOCK_DIR" 2>/dev/null

# --- Download lock directory (prevents concurrent downloads) ---
DOWNLOAD_LOCK_DIR="/tmp/qemu_vm_download_locks"
mkdir -p "$DOWNLOAD_LOCK_DIR" 2>/dev/null

# --- Cleanup tracking for partial downloads ---
PARTIAL_DOWNLOAD_PID_FILE="/tmp/qemu_vm_download_pid_$$"

# --- Helper: Show help message ---
show_help() {
    cat << 'HELPEOF'
QEMU VM Launcher - Multiple OS Quick Start
===========================================

USAGE: bash qemu.sh [OS] [NAME] [OPTIONS]

OS:
  --alpine            Alpine Linux 3.23 (default)
  --ubuntu            Ubuntu Server 24.04

NAME:
  myvm                Persistent VM (omit for temporary/auto-destroy)

OPTIONS:
  --port N            SSH port (default: 2222, auto-finds free)
  --size SIZE         Disk size (default: 5G, ex: 10G, 20G)
  --memory MB         RAM in MB (auto-calculated if omitted)
  --cpu N             Number of CPU cores (default: 1, auto-capped to host max)
  --no-kvm            Disable KVM acceleration
  --no-bridge         Force port forwarding (disable bridge/networking)
  --retry-attempts N  Max retry attempts on port conflict (default: 18)
  --retry-delay N     Delay between retries in seconds (default: 3)
  -h, --help          Show this help

COMMANDS:
  list                List all saved persistent VMs
  delete <vm-name>    Delete a saved persistent VM

ACCESS:  ssh root@localhost -p PORT  (password: 123)
         OR if bridge networking is available:
         ssh root@VM_IP  (password: 123)

HELPEOF
    exit 0
}

# --- Helper: List all saved VMs ---
list_vms() {
    local found=0
    echo "[VM LIST] Scanning for saved VMs..."
    
    for vm_dir in *-vm-*; do
        if [ -d "$vm_dir" ]; then
            local os_prefix="${vm_dir%%-vm-*}"
            local vm_name="${vm_dir#*-vm-}"
            
            local img_file=""
            if [ -f "$vm_dir/alpine-cloudinit.qcow2" ]; then
                img_file="alpine-cloudinit.qcow2"
            elif [ -f "$vm_dir/noble-server-cloudimg-amd64.img" ]; then
                img_file="noble-server-cloudimg-amd64.img"
            fi
            
            local disk_size="unknown"
            if [ -n "$img_file" ] && [ -f "$vm_dir/$img_file" ]; then
                disk_size=$(qemu-img info "$vm_dir/$img_file" 2>/dev/null | awk '/^virtual size:/ {print $3, $4}' || echo "unknown")
            fi
            
            local created="unknown"
            if [ -f "$vm_dir/alpine-cloud-init.iso" ] || [ -f "$vm_dir/noble-cloud-init.iso" ]; then
                local iso_file=$(ls "$vm_dir"/*-cloud-init.iso 2>/dev/null | head -1)
                if [ -n "$iso_file" ]; then
                    created=$(stat -c '%Y' "$iso_file" 2>/dev/null || stat -f '%m' "$iso_file" 2>/dev/null)
                    if [ "$created" != "unknown" ] && [ -n "$created" ]; then
                        created=$(date -d "@$created" "+%Y-%m-%d %H:%M" 2>/dev/null || date -r "$created" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "unknown")
                    fi
                fi
            fi
            
            local vm_ip=""
            if [ -f "/tmp/qemu_vm_ips.txt" ]; then
                vm_ip=$(grep "^${vm_name}=" "/tmp/qemu_vm_ips.txt" 2>/dev/null | cut -d'=' -f2)
            fi
            
            local ip_info=""
            if [ -n "$vm_ip" ]; then
                ip_info=" ip=${vm_ip}"
            fi
            
            printf "%-20s os=%-8s disk=%-12s created=%-16s dir=%s%s\n" \
                "$vm_name" "$os_prefix" "$disk_size" "$created" "$vm_dir" "$ip_info"
            found=1
        fi
    done
    
    if [ "$found" -eq 0 ]; then
        echo "[VM LIST] No saved VMs found."
    fi
}

# --- Helper: Delete a saved VM ---
delete_vm() {
    local vm_name="$1"
    local deleted=0
    
    if [ -z "$vm_name" ]; then
        echo "ERROR: VM name required for delete command"
        echo "Usage: $0 delete <vm-name>"
        exit 1
    fi
    
    echo "[DELETE] Searching for VM: $vm_name"
    
    for vm_dir in *-vm-"$vm_name"; do
        if [ -d "$vm_dir" ]; then
            echo "[DELETE] Found VM directory: $vm_dir"
            echo "[DELETE] This will permanently delete all data in: $vm_dir"
            printf "[DELETE] Are you sure? (y/N): "
            read -r confirm
            if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
                rm -rf "$vm_dir"
                # Release any still‑held IP lock
                local ip_to_release=$(grep "^${vm_name}=" "/tmp/qemu_vm_ips.txt" 2>/dev/null | cut -d'=' -f2)
                if [ -n "$ip_to_release" ]; then
                    rmdir "${IP_LOCK_DIR}/ip_${ip_to_release}" 2>/dev/null
                    sed -i "/^${vm_name}=/d" "/tmp/qemu_vm_ips.txt" 2>/dev/null
                fi
                echo "[DELETE] VM '$vm_name' has been deleted successfully."
                deleted=1
            else
                echo "[DELETE] Deletion cancelled."
                exit 0
            fi
        fi
    done
    
    if [ "$deleted" -eq 0 ]; then
        echo "ERROR: No VM found with name: $vm_name"
        echo "Use '$0 list' to see all saved VMs"
        exit 1
    fi
}

# --- OS Definitions ---
get_os_config() {
    local os="$1"
    case "$os" in
        alpine)
            IMG_URL="https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/cloud/generic_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2"
            IMG_FILE="alpine-cloudinit.qcow2"
            ISO_FILE="alpine-cloud-init.iso"
            DEFAULT_PASSWORD="123"
            HOSTNAME_PREFIX="alpine"
            CLOUD_USER="root"
            OS_TYPE="alpine"
            ;;
        ubuntu)
            IMG_URL="https://cloud-images.ubuntu.com/noble/20260216/noble-server-cloudimg-amd64.img"
            IMG_FILE="noble-server-cloudimg-amd64.img"
            ISO_FILE="noble-cloud-init.iso"
            DEFAULT_PASSWORD="123"
            HOSTNAME_PREFIX="noble"
            CLOUD_USER="root"
            OS_TYPE="ubuntu"
            ;;
        *)
            echo "ERROR: Unknown OS type: $os"
            echo "Supported OS: alpine, ubuntu"
            exit 1
            ;;
    esac
}

# --- Helper: Get host CPU core count ---
get_host_cpu_cores() {
    if command -v nproc >/dev/null 2>&1; then
        nproc --all
    elif [ -f /proc/cpuinfo ]; then
        grep -c "^processor" /proc/cpuinfo
    elif command -v sysctl >/dev/null 2>&1; then
        sysctl -n hw.ncpu 2>/dev/null || echo "1"
    else
        echo "1"
    fi
}

# --- Helper: Validate and cap CPU cores ---
validate_cpu_cores() {
    local requested_cores="$1"
    local host_cores=$(get_host_cpu_cores)
    
    if ! [ "$requested_cores" -eq "$requested_cores" ] 2>/dev/null || [ "$requested_cores" -lt 1 ]; then
        echo "ERROR: Invalid CPU core count: $requested_cores (must be positive integer)" >&2
        exit 1
    fi
    
    if [ "$requested_cores" -gt "$host_cores" ]; then
        echo "[CPU] Requested ${requested_cores} cores exceeds host maximum (${host_cores})" >&2
        echo "[CPU] Falling back to host maximum: ${host_cores} cores" >&2
        echo "$host_cores"
    else
        echo "[CPU] Using ${requested_cores} CPU core(s) (host has ${host_cores})" >&2
        echo "$requested_cores"
    fi
}

# --- Helper: Get total system memory in MB ---
get_total_memory_mb() {
    if [ -f /proc/meminfo ]; then
        awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null
    elif command -v sysctl >/dev/null 2>&1; then
        sysctl -n hw.memsize 2>/dev/null | awk '{print int($1/1024/1024)}'
    else
        echo "0"
    fi
}

# --- Helper: Get available system memory in MB ---
get_available_memory_mb() {
    if [ -f /proc/meminfo ]; then
        local mem_available=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)
        if [ -n "$mem_available" ] && [ "$mem_available" -gt 0 ]; then
            echo "$mem_available"
            return 0
        fi
        local mem_free=$(awk '/^MemFree:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)
        local buffers=$(awk '/^Buffers:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)
        local cached=$(awk '/^Cached:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)
        echo $((mem_free + buffers + cached))
    elif command -v vm_stat >/dev/null 2>&1; then
        local page_size=$(vm_stat | awk '/page size/ {print $8}')
        local free_pages=$(vm_stat | awk '/Pages free/ {print $3}' | tr -d '.')
        echo $((free_pages * page_size / 1024 / 1024))
    else
        echo "4096"
    fi
}

# --- Helper: Calculate safe VM memory size ---
calculate_vm_memory() {
    local requested_memory="$1"
    local os_type="$2"
    local available_mem=$(get_available_memory_mb)
    local total_mem=$(get_total_memory_mb)
    
    echo "[MEMORY] Host total memory: ${total_mem}MB, available: ${available_mem}MB" >&2
    
    if [ -n "$requested_memory" ] && [ "$requested_memory" -gt 0 ]; then
        if [ "$total_mem" -gt 0 ] && [ "$requested_memory" -gt "$total_mem" ]; then
            echo "ERROR: Requested memory (${requested_memory}MB) exceeds total system memory (${total_mem}MB)" >&2
            exit 1
        fi
        
        if [ "$requested_memory" -gt "$available_mem" ]; then
            echo "[WARNING] Requested memory (${requested_memory}MB) exceeds currently available memory (${available_mem}MB)" >&2
        fi
        
        echo "[MEMORY] Using requested memory: ${requested_memory}MB" >&2
        echo "$requested_memory"
        return 0
    fi
    
    local vm_memory
    
    if [ "$os_type" = "alpine" ]; then
        if [ "$available_mem" -ge 8192 ]; then
            vm_memory="$ALPINE_DEFAULT_MEMORY"
            echo "[MEMORY] Alpine selected, using minimal memory: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 2048 ]; then
            vm_memory="$ALPINE_DEFAULT_MEMORY"
            echo "[MEMORY] Alpine selected, using minimal memory: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 1024 ]; then
            vm_memory="$ALPINE_DEFAULT_MEMORY"
            echo "[MEMORY] Alpine selected, using minimal memory: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 512 ]; then
            vm_memory=256
            echo "[MEMORY] Low memory, Alpine using minimum: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 384 ]; then
            vm_memory=192
            echo "[MEMORY] Very low memory! Alpine using absolute minimum: ${vm_memory}MB" >&2
            echo "[WARNING] VM may be unstable with only ${vm_memory}MB RAM" >&2
        elif [ "$available_mem" -ge 256 ]; then
            vm_memory=128
            echo "[MEMORY] Extremely low memory! Alpine using bare minimum: ${vm_memory}MB" >&2
            echo "[WARNING] VM will be severely limited with only ${vm_memory}MB RAM" >&2
        else
            echo "ERROR: Insufficient memory available (${available_mem}MB). Cannot start VM." >&2
            echo "Minimum required: 256MB available, have: ${available_mem}MB" >&2
            exit 1
        fi
    else
        if [ "$available_mem" -ge 8192 ]; then
            vm_memory=4096
            echo "[MEMORY] High memory detected, allocating: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 4096 ]; then
            vm_memory=2048
            echo "[MEMORY] Moderate memory detected, allocating: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 2048 ]; then
            vm_memory=1024
            echo "[MEMORY] Limited memory detected, allocating: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 1024 ]; then
            vm_memory=512
            echo "[MEMORY] Low memory detected, allocating minimal: ${vm_memory}MB" >&2
            echo "[WARNING] Ubuntu may struggle with only ${vm_memory}MB RAM" >&2
        elif [ "$available_mem" -ge 512 ]; then
            vm_memory=256
            echo "[MEMORY] Very low memory! Allocating absolute minimum: ${vm_memory}MB" >&2
            echo "[WARNING] VM may be unstable with only ${vm_memory}MB RAM" >&2
        else
            echo "ERROR: Insufficient memory available (${available_mem}MB). Cannot start VM." >&2
            echo "Minimum required: 512MB available, have: ${available_mem}MB" >&2
            exit 1
        fi
    fi
    
    echo "$vm_memory"
}

# --- Helper: Check KVM availability ---
check_kvm() {
    if [ -e /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
        echo "[KVM] KVM acceleration available"
        return 0
    else
        echo "[KVM] KVM not available, falling back to software emulation (slower)"
        return 1
    fi
}

# ============================================================================
# ROBUST DOWNLOAD HANDLING - Prevents partial/corrupt downloads
# ============================================================================

# --- Acquire download lock to prevent concurrent downloads of same file ---
acquire_download_lock() {
    local file_name="$1"
    local lock_dir="${DOWNLOAD_LOCK_DIR}/${file_name}.lock"
    local max_wait=120  # Maximum seconds to wait for lock
    local waited=0
    local stale_removal_attempted=0
    
    while ! mkdir "$lock_dir" 2>/dev/null; do
        if [ $waited -ge $max_wait ]; then
            echo "ERROR: Timeout waiting for download lock after ${max_wait}s" >&2
            echo "If another download is stuck, manually remove: ${lock_dir}" >&2
            exit 1
        fi
        
        # Check if the process holding the lock is still alive
        if [ -f "${lock_dir}/pid" ]; then
            local lock_pid=$(cat "${lock_dir}/pid" 2>/dev/null)
            if [ -n "$lock_pid" ]; then
                if ! kill -0 "$lock_pid" 2>/dev/null; then
                    # Only attempt stale removal once per wait cycle
                    if [ $stale_removal_attempted -eq 0 ]; then
                        echo "[DOWNLOAD] Stale lock detected (PID ${lock_pid} is dead), removing..." >&2
                        rm -f "${lock_dir}/pid" 2>/dev/null
                        rmdir "$lock_dir" 2>/dev/null
                        stale_removal_attempted=1
                        continue
                    fi
                fi
            fi
        else
            # Lock directory exists but no PID file - try to remove it
            if [ $stale_removal_attempted -eq 0 ]; then
                echo "[DOWNLOAD] Stale lock without PID file detected, removing..." >&2
                rmdir "$lock_dir" 2>/dev/null
                stale_removal_attempted=1
                continue
            fi
        fi
        
        # Reset stale removal flag after each attempt
        stale_removal_attempted=0
        
        sleep 1
        waited=$((waited + 1))
        if [ $((waited % 10)) -eq 0 ]; then
            echo "[DOWNLOAD] Waiting for another download to complete... (${waited}s)" >&2
        fi
    done
    
    # Store our PID in the lock
    echo "$$" > "${lock_dir}/pid"
    echo "$lock_dir"
}

# --- Release download lock ---
release_download_lock() {
    local lock_dir="$1"
    if [ -n "$lock_dir" ] && [ -d "$lock_dir" ]; then
        rm -f "${lock_dir}/pid" 2>/dev/null
        rmdir "$lock_dir" 2>/dev/null
    fi
}

# --- Verify downloaded file integrity ---
verify_download_integrity() {
    local file_path="$1"
    
    # Check if file exists and has non-zero size
    if [ ! -f "$file_path" ]; then
        echo "[VERIFY] File does not exist: ${file_path}"
        return 1
    fi
    
    local file_size=$(stat -c%s "$file_path" 2>/dev/null || stat -f%z "$file_path" 2>/dev/null || echo "0")
    
    if [ "$file_size" -eq 0 ]; then
        echo "[VERIFY] File is empty: ${file_path}"
        return 1
    fi
    
    # For qcow2 images, verify with qemu-img
    if echo "$file_path" | grep -qE '\.qcow2$|\.img$'; then
        if command -v qemu-img >/dev/null 2>&1; then
            if qemu-img check "$file_path" >/dev/null 2>&1; then
                echo "[VERIFY] Image file verified: ${file_path} (${file_size} bytes)"
                return 0
            else
                echo "[VERIFY] Corrupt image file detected: ${file_path}"
                return 1
            fi
        fi
    fi
    
    # For other files, just check minimum size (1MB for cloud images)
    if [ "$file_size" -lt 1048576 ]; then
        echo "[VERIFY] File too small, likely partial download: ${file_path} (${file_size} bytes)"
        return 1
    fi
    
    echo "[VERIFY] File verified: ${file_path} (${file_size} bytes)"
    return 0
}

# --- Cleanup partial download ---
cleanup_partial_download() {
    local file_path="$1"
    local temp_path="${file_path}.partial"
    
    echo "[CLEANUP] Removing partial/corrupt downloads..."
    
    if [ -f "$file_path" ]; then
        if ! verify_download_integrity "$file_path"; then
            echo "[CLEANUP] Removing corrupt file: ${file_path}"
            rm -f "$file_path"
        fi
    fi
    
    if [ -f "$temp_path" ]; then
        echo "[CLEANUP] Removing temporary download: ${temp_path}"
        rm -f "$temp_path"
    fi
}

# --- Download with resume support and integrity verification ---
download_with_integrity() {
    local url="$1"
    local output_path="$2"
    local temp_path="${output_path}.partial"
    local max_retries=3
    local retry_count=0
    
    # Check if we have a valid completed download
    if [ -f "$output_path" ] && verify_download_integrity "$output_path"; then
        echo "[DOWNLOAD] Valid file already exists: ${output_path}"
        return 0
    fi
    
    # Cleanup any existing partial/corrupt files
    cleanup_partial_download "$output_path"
    
    echo "[DOWNLOAD] Starting download: ${url}"
    echo "[DOWNLOAD] Output: ${output_path}"
    
    # Try download with resume support
    while [ $retry_count -lt $max_retries ]; do
        retry_count=$((retry_count + 1))
        
        if [ $retry_count -gt 1 ]; then
            echo "[DOWNLOAD] Retry attempt ${retry_count}/${max_retries}..."
            sleep 2
        fi
        
        # Use wget with resume support for partial downloads
        if [ -f "$temp_path" ]; then
            echo "[DOWNLOAD] Resuming previous partial download..."
        fi
        
        # Download to temporary file first
        if wget -c -O "$temp_path" "$url" 2>&1; then
            echo "[DOWNLOAD] Download completed, verifying integrity..."
            
            # Verify the downloaded file
            if [ -f "$temp_path" ] && [ -s "$temp_path" ]; then
                # Move to final location
                mv "$temp_path" "$output_path"
                
                if verify_download_integrity "$output_path"; then
                    echo "[DOWNLOAD] Download successful and verified"
                    return 0
                else
                    echo "[DOWNLOAD] Download verification failed, cleaning up..."
                    rm -f "$output_path"
                fi
            else
                echo "[DOWNLOAD] Download failed or file is empty"
                rm -f "$temp_path"
            fi
        else
            local wget_exit=$?
            echo "[DOWNLOAD] wget failed with exit code: ${wget_exit}"
            
            # Clean up on failure (except for partial downloads we might resume)
            if [ $wget_exit -ne 0 ] && [ $wget_exit -ne 1 ]; then
                rm -f "$temp_path"
            fi
        fi
    done
    
    echo "ERROR: Failed to download ${url} after ${max_retries} attempts"
    return 1
}

# --- Signal handler for clean interrupt during download ---
setup_download_signal_handlers() {
    # Save current trap handlers
    local old_int=$(trap -p INT 2>/dev/null | sed "s/trap -- '\(.*\)' INT/\1/")
    local old_term=$(trap -p TERM 2>/dev/null | sed "s/trap -- '\(.*\)' TERM/\1/")
    
    # Set cleanup handler for downloads
    trap 'handle_download_interrupt' INT TERM
}

# --- Handle interrupt during download ---
handle_download_interrupt() {
    echo ""
    echo "[INTERRUPT] Download interrupted by user"
    echo "[INTERRUPT] Cleaning up partial downloads..."
    
    # Clean up any partial downloads
    if [ -n "$CURRENT_DOWNLOAD_FILE" ]; then
        rm -f "${CURRENT_DOWNLOAD_FILE}.partial" 2>/dev/null
        rm -f "${CURRENT_DOWNLOAD_FILE}" 2>/dev/null
        echo "[INTERRUPT] Removed partial download: ${CURRENT_DOWNLOAD_FILE}"
    fi
    
    echo "[INTERRUPT] Exiting..."
    exit 130
}

# ============================================================================
# NETWORK BRIDGE SETUP - Multiple methods for maximum compatibility
# ============================================================================

# --- Universal helper: run command with privilege escalation if needed ---
net_cmd() {
    if [ "$(id -u)" = "0" ]; then
        eval "$@" 2>/dev/null
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@" 2>/dev/null
    else
        eval "$@" 2>/dev/null
    fi
}

# --- Check if we have sufficient privileges ---
check_net_privileges() {
    if [ "$(id -u)" = "0" ]; then
        return 0
    fi
    
    if command -v sudo >/dev/null 2>&1; then
        if sudo -n true 2>/dev/null; then
            return 0
        fi
        echo "[NET] Bridge setup requires root privileges (sudo may ask for password)"
        if sudo true 2>/dev/null; then
            return 0
        fi
    fi
    
    echo "[NET] Insufficient privileges for network setup"
    return 1
}

# --- Check TUN/TAP availability ---
check_tun_available() {
    if [ -c /dev/net/tun ]; then
        return 0
    fi
    
    net_cmd modprobe tun 2>/dev/null && sleep 0.5
    
    if [ -c /dev/net/tun ]; then
        return 0
    fi
    
    if [ -f /proc/modules ] && grep -q "^tun" /proc/modules 2>/dev/null; then
        return 0
    fi
    
    return 1
}

# --- Check available bridge method ---
detect_bridge_method() {
    # Method 1: brctl (bridge-utils) - MOST RELIABLE on older systems
    if command -v brctl >/dev/null 2>&1; then
        local test_bridge="qemutest_$$"
        if net_cmd brctl addbr "$test_bridge" 2>/dev/null; then
            net_cmd brctl delbr "$test_bridge" 2>/dev/null
            echo "brctl"
            return 0
        fi
    fi
    
    # Method 2: Modern ip command with bridge support
    if command -v ip >/dev/null 2>&1; then
        local test_bridge="qemutest_$$"
        if net_cmd ip link add name "$test_bridge" type bridge 2>/dev/null; then
            net_cmd ip link delete "$test_bridge" 2>/dev/null
            echo "ip-bridge"
            return 0
        fi
    fi
    
    # Method 3: Just TAP interface
    if check_tun_available; then
        if command -v tunctl >/dev/null 2>&1; then
            local test_tap="qemutest_$$"
            if net_cmd tunctl -t "$test_tap" 2>/dev/null; then
                net_cmd tunctl -d "$test_tap" 2>/dev/null
                echo "tap-only"
                return 0
            fi
        elif command -v ip >/dev/null 2>&1; then
            local test_tap="qemutest_$$"
            if net_cmd ip tuntap add dev "$test_tap" mode tap 2>/dev/null; then
                net_cmd ip tuntap del dev "$test_tap" mode tap 2>/dev/null
                echo "tap-only"
                return 0
            fi
        fi
    fi
    
    echo "none"
    return 1
}

# --- Create TAP interface ---
create_tap_interface() {
    local tap_name="$1"
    
    if command -v tunctl >/dev/null 2>&1; then
        if net_cmd tunctl -t "$tap_name" 2>/dev/null; then
            net_cmd ip link set "$tap_name" up 2>/dev/null
            return 0
        fi
    fi
    
    if command -v ip >/dev/null 2>&1; then
        if net_cmd ip tuntap add dev "$tap_name" mode tap 2>/dev/null; then
            net_cmd ip link set "$tap_name" up 2>/dev/null
            return 0
        fi
    fi
    
    if command -v openvpn >/dev/null 2>&1 && net_cmd openvpn --mktun --dev "$tap_name" 2>/dev/null; then
        net_cmd ip link set "$tap_name" up 2>/dev/null
        return 0
    fi
    
    return 1
}

# --- Delete TAP interface ---
delete_tap_interface() {
    local tap_name="$1"
    
    if command -v tunctl >/dev/null 2>&1; then
        net_cmd tunctl -d "$tap_name" 2>/dev/null && return 0
    fi
    
    if command -v ip >/dev/null 2>&1; then
        net_cmd ip tuntap del dev "$tap_name" mode tap 2>/dev/null && return 0
    fi
    
    if command -v openvpn >/dev/null 2>&1; then
        net_cmd openvpn --rmtun --dev "$tap_name" 2>/dev/null && return 0
    fi
    
    return 1
}

# --- Setup bridge using brctl method ---
setup_bridge_brctl() {
    echo "[NET] Setting up bridge using 'brctl' command..."
    
    if ip link show "$BRIDGE_NAME" >/dev/null 2>&1; then
        echo "[NET] Bridge ${BRIDGE_NAME} already exists"
        net_cmd ip link set "$BRIDGE_NAME" up 2>/dev/null || net_cmd ifconfig "$BRIDGE_NAME" up 2>/dev/null
        
        if ! ip addr show "$BRIDGE_NAME" 2>/dev/null | grep -q "$BRIDGE_IP"; then
            echo "[NET] Adding IP ${BRIDGE_IP} to existing bridge"
            net_cmd ip addr add "${BRIDGE_IP}/24" dev "$BRIDGE_NAME" 2>/dev/null || \
            net_cmd ifconfig "$BRIDGE_NAME" "${BRIDGE_IP}" netmask "${BRIDGE_NETMASK}" 2>/dev/null
        fi
        return 0
    fi
    
    echo "[NET] Creating bridge ${BRIDGE_NAME}..."
    if ! net_cmd brctl addbr "$BRIDGE_NAME"; then
        echo "[NET] Failed to create bridge with brctl"
        return 1
    fi
    
    net_cmd brctl stp "$BRIDGE_NAME" off 2>/dev/null
    net_cmd brctl setfd "$BRIDGE_NAME" 0 2>/dev/null
    
    if ! net_cmd ip addr add "${BRIDGE_IP}/24" dev "$BRIDGE_NAME" 2>/dev/null; then
        if ! net_cmd ifconfig "$BRIDGE_NAME" "${BRIDGE_IP}" netmask "${BRIDGE_NETMASK}" up 2>/dev/null; then
            echo "[NET] Failed to assign IP to bridge"
            net_cmd brctl delbr "$BRIDGE_NAME" 2>/dev/null
            return 1
        fi
    fi
    
    if ! net_cmd ip link set "$BRIDGE_NAME" up 2>/dev/null; then
        if ! net_cmd ifconfig "$BRIDGE_NAME" up 2>/dev/null; then
            echo "[NET] Failed to bring bridge up"
            net_cmd brctl delbr "$BRIDGE_NAME" 2>/dev/null
            return 1
        fi
    fi
    
    echo "[NET] Bridge created successfully: ${BRIDGE_NAME}"
    return 0
}

# --- Setup bridge using ip method ---
setup_bridge_ip() {
    echo "[NET] Setting up bridge using 'ip' command..."
    
    if ip link show "$BRIDGE_NAME" >/dev/null 2>&1; then
        echo "[NET] Bridge ${BRIDGE_NAME} already exists"
        net_cmd ip link set "$BRIDGE_NAME" up 2>/dev/null
        if ! ip addr show "$BRIDGE_NAME" 2>/dev/null | grep -q "$BRIDGE_IP"; then
            net_cmd ip addr add "${BRIDGE_IP}/24" dev "$BRIDGE_NAME" 2>/dev/null
        fi
        return 0
    fi
    
    if net_cmd ip link add name "$BRIDGE_NAME" type bridge 2>/dev/null; then
        net_cmd ip addr add "${BRIDGE_IP}/24" dev "$BRIDGE_NAME" 2>/dev/null
        net_cmd ip link set "$BRIDGE_NAME" up 2>/dev/null
        return 0
    fi
    
    if command -v brctl >/dev/null 2>&1; then
        echo "[NET] 'ip' bridge creation failed, trying 'brctl' instead..."
        if setup_bridge_brctl; then
            return 0
        fi
    fi
    
    echo "[NET] All bridge creation methods failed"
    return 1
}

# --- Add interface to bridge ---
add_to_bridge() {
    local bridge="$1"
    local tap="$2"
    local method="$3"
    
    case "$method" in
        ip-bridge)
            net_cmd ip link set "$tap" master "$bridge" 2>/dev/null
            ;;
        brctl)
            net_cmd brctl addif "$bridge" "$tap" 2>/dev/null
            ;;
        *)
            net_cmd ip link set "$tap" master "$bridge" 2>/dev/null || \
            net_cmd brctl addif "$bridge" "$tap" 2>/dev/null
            ;;
    esac
}

# --- Check and install iptables if needed ---
install_iptables() {
    if command -v apt-get >/dev/null 2>&1; then
        echo "[INSTALL] Installing iptables..."
        smart_apt_install "iptables" "iptables" && return 0
        echo "[NET] Failed to install iptables; VMs will have local network only"
        return 1
    elif command -v apk >/dev/null 2>&1; then
        echo "[INSTALL] Installing iptables via apk..."
        apk add --no-cache iptables && return 0
        echo "[NET] Failed to install iptables via apk; VMs will have local network only"
        return 1
    else
        echo "[NET] iptables not available and no supported package manager found."
        echo "[NET] VMs will have local network only"
        return 1
    fi
}

# --- Setup NAT for internet access ---
setup_nat() {
    echo "[NET] Configuring NAT..."
    
    if ! command -v iptables >/dev/null 2>&1; then
        if ! install_iptables; then
            return 0   # iptables still missing -> local-only
        fi
    fi
    
    local out_iface=""
    
    # Find outbound interface
    out_iface=$(ip route get 8.8.8.8 2>/dev/null | awk '{print $5; exit}')
    if [ -z "$out_iface" ]; then
        out_iface=$(route -n 2>/dev/null | grep '^0.0.0.0' | awk '{print $8}' | head -1)
    fi
    
    if [ -z "$out_iface" ]; then
        echo "[NET] WARNING: Could not detect outbound interface"
        out_iface=$(ip link show 2>/dev/null | grep -E '^[0-9]+: (eth|ens|enp)' | head -1 | awk -F': ' '{print $2}')
        if [ -z "$out_iface" ]; then
            echo "[NET] ERROR: No network interface found"
            return 1
        fi
        echo "[NET] Using guessed interface: ${out_iface}"
    fi
    
    echo "[NET] Outbound interface: ${out_iface}"
    echo "[NET] Bridge subnet: ${BRIDGE_SUBNET}"
    
    # CRITICAL: Enable IP forwarding using sysctl (more reliable than echo)
    if command -v sysctl >/dev/null 2>&1; then
        net_cmd sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1
        net_cmd sysctl -w net.ipv4.conf.all.forwarding=1 >/dev/null 2>&1
        net_cmd sysctl -w net.ipv4.conf.${out_iface}.forwarding=1 >/dev/null 2>&1
        net_cmd sysctl -w net.ipv4.conf.${BRIDGE_NAME}.forwarding=1 >/dev/null 2>&1
        echo "[NET] Enabled IP forwarding via sysctl"
    else
        # Fallback to echo with explicit sudo
        if [ "$(id -u)" = "0" ]; then
            echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null
            echo 1 > /proc/sys/net/ipv4/conf/all/forwarding 2>/dev/null
            echo 1 > /proc/sys/net/ipv4/conf/${out_iface}/forwarding 2>/dev/null
            echo 1 > /proc/sys/net/ipv4/conf/${BRIDGE_NAME}/forwarding 2>/dev/null
        else
            sudo sh -c "echo 1 > /proc/sys/net/ipv4/ip_forward" 2>/dev/null
            sudo sh -c "echo 1 > /proc/sys/net/ipv4/conf/all/forwarding" 2>/dev/null
            sudo sh -c "echo 1 > /proc/sys/net/ipv4/conf/${out_iface}/forwarding" 2>/dev/null
            sudo sh -c "echo 1 > /proc/sys/net/ipv4/conf/${BRIDGE_NAME}/forwarding" 2>/dev/null
        fi
        echo "[NET] Enabled IP forwarding via proc"
    fi
    
    # Verify forwarding is enabled
    local ip_forward_status=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)
    if [ "$ip_forward_status" != "1" ]; then
        echo "[NET] WARNING: Failed to enable IP forwarding (status: ${ip_forward_status})"
        echo "[NET] Try running manually: sudo sysctl -w net.ipv4.ip_forward=1"
    else
        echo "[NET] IP forwarding verified: enabled"
    fi
    
    # Remove duplicate rules first to avoid clutter
    net_cmd iptables -D FORWARD -i "$BRIDGE_NAME" -o "$out_iface" -j ACCEPT 2>/dev/null
    net_cmd iptables -D FORWARD -i "$out_iface" -o "$BRIDGE_NAME" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null
    net_cmd iptables -D FORWARD -i "$BRIDGE_NAME" -j ACCEPT 2>/dev/null
    net_cmd iptables -D FORWARD -o "$BRIDGE_NAME" -j ACCEPT 2>/dev/null
    net_cmd iptables -t nat -D POSTROUTING -s "${BRIDGE_SUBNET}" -o "${out_iface}" -j MASQUERADE 2>/dev/null
    
    # Add clean rules
    net_cmd iptables -I FORWARD 1 -i "$BRIDGE_NAME" -o "$out_iface" -j ACCEPT 2>/dev/null
    net_cmd iptables -I FORWARD 2 -i "$out_iface" -o "$BRIDGE_NAME" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null
    net_cmd iptables -t nat -A POSTROUTING -s "${BRIDGE_SUBNET}" -o "${out_iface}" -j MASQUERADE 2>/dev/null
    
    echo "[NET] NAT configured for internet access"
}

# --- Detect if we're running inside a VM with our bridge subnet ---
detect_nested_environment() {
    if ip route show 2>/dev/null | grep -q "via ${BRIDGE_IP} "; then
        echo "[NET] Detected nested environment (parent uses ${BRIDGE_SUBNET})"
        return 0
    fi
    return 1
}


# --- Main bridge setup orchestration ---
setup_bridge_network() {
    echo "[NET] Attempting to set up bridge networking..."
    
    if ! check_net_privileges; then
        echo "[NET] Will use port forwarding instead"
        return 1
    fi
    
    if ! check_tun_available; then
        echo "[NET] TUN/TAP not available, will use port forwarding"
        return 1
    fi
    
    # Detect nested environment and switch to alternative subnet
    if detect_nested_environment; then
        IS_NESTED="true"
        BRIDGE_NAME="qemubr1"
        BRIDGE_IP="$NESTED_BRIDGE_IP"
        BRIDGE_NETMASK="$NESTED_BRIDGE_NETMASK"
        BRIDGE_SUBNET="$NESTED_BRIDGE_SUBNET"
        VM_IP_PREFIX="$NESTED_VM_IP_PREFIX"
        VM_IP_START="$NESTED_VM_IP_START"
        VM_IP_END="$NESTED_VM_IP_END"
        echo "[NET] Using nested subnet: ${BRIDGE_SUBNET}"
    fi
    
    bridge_method=$(detect_bridge_method)
    if [ "$bridge_method" = "none" ]; then
        echo "[NET] No bridge utilities found, will use port forwarding"
        return 1
    fi
    
    echo "[NET] Using bridge method: ${bridge_method}"
    
    case "$bridge_method" in
        ip-bridge)
            setup_bridge_ip || return 1
            ;;
        brctl)
            setup_bridge_brctl || return 1
            ;;
        tap-only)
            echo "[NET] Using TAP-only mode"
            if ! create_tap_interface "${TAP_PREFIX}0"; then
                echo "[NET] Failed to create TAP interface"
                return 1
            fi
            BRIDGE_NAME="${TAP_PREFIX}0"
            net_cmd ip addr add "${BRIDGE_IP}/24" dev "$BRIDGE_NAME" 2>/dev/null
            net_cmd ip link set "$BRIDGE_NAME" up 2>/dev/null
            ;;
    esac
    
    if ! ip link show "$BRIDGE_NAME" >/dev/null 2>&1; then
        echo "[NET] Bridge interface not found after setup"
        return 1
    fi
    
    # In nested mode, add a route to reach parent's network through the correct interface
    if [ "$IS_NESTED" = "true" ]; then
        # Find the interface that has the parent's subnet
        local parent_iface=$(ip route show 2>/dev/null | grep "via ${NESTED_BRIDGE_IP%%1}1" | awk '{print $3}' | head -1 || ip route show default 2>/dev/null | awk '{print $5}')
        if [ -n "$parent_iface" ]; then
            echo "[NET] Setting up NAT for nested subnet via ${parent_iface}"
        fi
    fi
    
    setup_nat
    
    echo "[NET] Bridge network ready: ${BRIDGE_NAME} (${BRIDGE_IP}/24)"
    return 0
}

# --- Atomic per‑IP reservation using directories ---
reserve_vm_ip() {
    local vm_name="$1"
    local candidate=""
    local lock_dir=""
    
    local ip_num="$VM_IP_START"
    while [ "$ip_num" -le "$VM_IP_END" ]; do
        candidate="${VM_IP_PREFIX}${ip_num}"
        lock_dir="${IP_LOCK_DIR}/ip_${candidate}"
        
        if mkdir "$lock_dir" 2>/dev/null; then
            echo "${vm_name}=${candidate}" >> "/tmp/qemu_vm_ips.txt" 2>/dev/null
            echo "[NET] Reserved IP: ${candidate} for VM ${vm_name}" >&2
            echo "$candidate"
            return 0
        fi
        ip_num=$((ip_num + 1))
    done
    
    echo "[NET] No available IPs in range ${VM_IP_PREFIX}${VM_IP_START}-${VM_IP_END}" >&2
    return 1
}

# --- Release a previously reserved IP ---
release_vm_ip() {
    local ip="$1"
    if [ -n "$ip" ]; then
        local lock_dir="${IP_LOCK_DIR}/ip_${ip}"
        rmdir "$lock_dir" 2>/dev/null
        sed -i "/=${ip}$/d" "/tmp/qemu_vm_ips.txt" 2>/dev/null
    fi
}

# --- Generate unique TAP name ---
generate_tap_name() {
    local vm_identifier="$1"
    local max_length=15
    
    local hash=$(echo "$vm_identifier" | md5sum 2>/dev/null | cut -c1-6 || echo "$vm_identifier" | cksum 2>/dev/null | cut -d' ' -f1 | head -c6)
    
    local base_name="${TAP_PREFIX}_${hash}"
    local tap_name=$(echo "$base_name" | cut -c1-${max_length})
    
    echo "$tap_name"
}

# --- Create VM TAP interface ---
create_vm_tap() {
    local tap_name="$1"
    
    if ip link show "$tap_name" >/dev/null 2>&1; then
        echo "[NET] TAP interface ${tap_name} already exists, removing first"
        delete_tap_interface "$tap_name"
    fi
    
    if ! create_tap_interface "$tap_name"; then
        return 1
    fi
    
    if [ "$BRIDGE_NAME" != "$tap_name" ]; then
        add_to_bridge "$BRIDGE_NAME" "$tap_name" "$bridge_method"
    fi
    
    return 0
}

# --- Smart installation helper for apt-based systems ---
smart_apt_install() {
    local package="$1"
    local display_name="$2"
    
    echo "[INSTALL] Installing ${display_name} via apt..."
    
    if apt-get install -y -qq "$package" 2>/dev/null; then
        echo "[INSTALL] ${display_name} installed successfully (no update needed)"
        return 0
    fi
    
    echo "[INSTALL] Direct install failed, updating package lists and retrying..."
    if apt-get update -qq && apt-get install -y -qq "$package"; then
        echo "[INSTALL] ${display_name} installed successfully (after update)"
        return 0
    fi
    
    echo "ERROR: Failed to install ${display_name}"
    return 1
}

# --- Check and install genisoimage ---
install_genisoimage() {
    if command -v apt-get >/dev/null 2>&1; then
        smart_apt_install "genisoimage" "genisoimage" || exit 1
    elif command -v apk >/dev/null 2>&1; then
        echo "[INSTALL] Installing genisoimage (cdrkit) via apk..."
        apk add --no-cache cdrkit 2>/dev/null || {
            echo "[INSTALL] cdrkit not available, trying genisoimage..."
            apk add --no-cache genisoimage 2>/dev/null || {
                echo "ERROR: Failed to install genisoimage/cdrkit via apk"
                exit 1
            }
        }
        # Verify genisoimage is now available
        if ! command -v genisoimage >/dev/null 2>&1; then
            echo "ERROR: genisoimage still not found after apk installation"
            exit 1
        fi
    elif command -v yum >/dev/null 2>&1; then
        echo "[INSTALL] Installing genisoimage via yum..."
        yum install -y -q genisoimage
    elif command -v dnf >/dev/null 2>&1; then
        echo "[INSTALL] Installing genisoimage via dnf..."
        dnf install -y -q genisoimage
    else
        echo "ERROR: No supported package manager found. Install genisoimage manually."
        exit 1
    fi
}

# --- Check and install qemu-img if needed ---
install_qemu_img() {
    if command -v apt-get >/dev/null 2>&1; then
        smart_apt_install "qemu-utils" "qemu-utils" || exit 1
    elif command -v apk >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-img via apk..."
        apk add --no-cache qemu-img
    elif command -v yum >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-img via yum..."
        yum install -y -q qemu-img
    elif command -v dnf >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-img via dnf..."
        dnf install -y -q qemu-img
    else
        echo "ERROR: No supported package manager found. Install qemu-img manually."
        exit 1
    fi
}

# --- Check and install QEMU system emulator if needed ---
install_qemu_system() {
    if command -v apt-get >/dev/null 2>&1; then
        smart_apt_install "qemu-system-x86" "qemu-system-x86" || exit 1
    elif command -v apk >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-system-x86_64 via apk..."
        apk add --no-cache qemu-system-x86_64
    elif command -v yum >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-system-x86 via yum..."
        yum install -y -q qemu-system-x86
    elif command -v dnf >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-system-x86 via dnf..."
        dnf install -y -q qemu-system-x86
    else
        echo "ERROR: No supported package manager found. Install QEMU manually."
        exit 1
    fi
}

# --- Pre-flight checks ---
if ! command -v genisoimage >/dev/null 2>&1; then
    echo "[CHECK] genisoimage not found, installing..."
    install_genisoimage
else
    echo "[CHECK] genisoimage already installed"
fi

if ! command -v qemu-img >/dev/null 2>&1; then
    echo "[CHECK] qemu-img not found, installing..."
    install_qemu_img
else
    echo "[CHECK] qemu-img already installed"
fi

if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
    echo "[CHECK] qemu-system-x86_64 not found, installing..."
    install_qemu_system
else
    echo "[CHECK] qemu-system-x86_64 already installed"
fi

# --- Functions ---
find_available_port() {
    local start_port="$1"
    local port="$start_port"
    local max_attempts=100
    
    while [ $((port - start_port)) -lt $max_attempts ]; do
        if ! ss -tlnp 2>/dev/null | grep -q ":${port} " && \
           ! netstat -tlnp 2>/dev/null | grep -q ":${port} " && \
           ! lsof -i :${port} 2>/dev/null >/dev/null; then
            echo "$port"
            return 0
        fi
        port=$((port + 1))
    done
    
    echo "ERROR: No available ports found between ${start_port} and $((start_port + max_attempts - 1))"
    return 1
}

test_port_binding() {
    local port="$1"
    local timeout=2
    
    if command -v timeout >/dev/null 2>&1; then
        timeout "$timeout" nc -l -p "$port" 2>/dev/null &
    else
        nc -l -p "$port" 2>/dev/null &
    fi
    local nc_pid=$!
    sleep 0.5
    
    if kill -0 "$nc_pid" 2>/dev/null; then
        kill "$nc_pid" 2>/dev/null
        wait "$nc_pid" 2>/dev/null
        return 0
    else
        wait "$nc_pid" 2>/dev/null
        return 1
    fi
}

resize_disk() {
    local disk_path="$1"
    local target_size="$2"
    
    echo "[RESIZE] Resizing disk to: ${target_size}"
    qemu-img resize "${disk_path}" "${target_size}" || {
        echo "ERROR: Failed to resize disk image"
        exit 1
    }
    echo "[RESIZE] Disk resized successfully to ${target_size}"
}

# --- Generate password hash for cloud-init ---
generate_password_hash() {
    local pass="$1"
    local hash=""
    
    # Python3 method - most reliable
    if command -v python3 >/dev/null 2>&1; then
        hash=$(python3 -c "import crypt; print(crypt.crypt('${pass}', crypt.mksalt(crypt.METHOD_SHA512)))" 2>/dev/null)
        if [ -n "$hash" ]; then
            echo "$hash"
            return 0
        fi
    fi
    
    # mkpasswd method
    if command -v mkpasswd >/dev/null 2>&1; then
        hash=$(echo "${pass}" | mkpasswd --method=sha-512 --stdin 2>/dev/null)
        if [ -n "$hash" ]; then
            echo "$hash"
            return 0
        fi
    fi
    
    # openssl method
    if command -v openssl >/dev/null 2>&1; then
        hash=$(echo "${pass}" | openssl passwd -6 -stdin 2>/dev/null)
        if [ -n "$hash" ]; then
            echo "$hash"
            return 0
        fi
    fi
    
    echo "ERROR: No tool found to generate a SHA-512 password hash." >&2
    echo "Please install python3, whois (mkpasswd), or openssl." >&2
    exit 1
}

create_cloud_init_iso() {
    local target_dir="$1"
    local vm_ip="$2"  # static IP for bridge mode (empty for DHCP)
    local os_type="$3"
    
    target_dir=$(cd "$target_dir" 2>/dev/null && pwd || echo "$target_dir")
    local iso_path="${target_dir}/${ISO_FILE}"
    
    if [ -f "${iso_path}" ]; then
        echo "[ISO] Cloud-init ISO already exists, skipping creation"
        return 0
    fi
    
    echo "[ISO] Creating cloud-init ISO for ${os_type}..."
    local workdir="${target_dir}/cloud-init-source"
    mkdir -p "${workdir}"
    
    cd "${workdir}" || exit 1
    
    # Hostname
    local vm_hostname="${HOSTNAME_PREFIX}-vm"
    if [ -n "$vm_ip" ]; then
        local ip_suffix=$(echo "$vm_ip" | cut -d'.' -f4)
        vm_hostname="${HOSTNAME_PREFIX}-vm-${ip_suffix}"
    fi
    
    cat > meta-data << METAEOF
instance-id: ${vm_hostname}-$(date +%s)
local-hostname: ${vm_hostname}
METAEOF
    
    # Generate a solid password hash
    local pass_hash=$(generate_password_hash "$DEFAULT_PASSWORD")
    
    # Network and user-data differ by OS
    if [ "$os_type" = "ubuntu" ]; then
        # UBUNTU: Use correct interface name (ens3)
        if [ -n "$vm_ip" ]; then
            # Ubuntu static IP (netplan) with correct interface name
            cat > network-config << NETEOF
version: 2
ethernets:
  ens3:
    dhcp4: false
    addresses:
      - ${vm_ip}/24
    routes:
      - to: default
        via: ${BRIDGE_IP}
    nameservers:
      addresses:
        - 8.8.8.8
        - 1.1.1.1
NETEOF
            echo "[ISO] Ubuntu static IP configured: ${vm_ip}/24 on interface ens3"
        else
            # Ubuntu DHCP with correct interface name
            cat > network-config << NETEOF
version: 2
ethernets:
  ens3:
    dhcp4: true
NETEOF
        fi
        
        # Use chpasswd list format for reliable root password
        cat > user-data << CLOUDEOF
#cloud-config
ssh_pwauth: true
disable_root: false

# Set root password directly
chpasswd:
  list: |
    root:${DEFAULT_PASSWORD}
  expire: False

# Enable root login via SSH
write_files:
  - path: /etc/ssh/sshd_config.d/99-enable-root-login.conf
    content: |
      PermitRootLogin yes
      PasswordAuthentication yes
    permissions: "0644"
    owner: root:root

# Ensure network interface is up and apply configuration
bootcmd:
  - ip link set ens3 up

runcmd:
  - netplan apply
  - systemctl restart ssh 2>/dev/null || service ssh restart 2>/dev/null || true
  - systemctl restart networking 2>/dev/null || service networking restart 2>/dev/null || true
CLOUDEOF
    else
        # ALPINE: Original working configuration
        if [ -n "$vm_ip" ]; then
            cat > network-config << NETEOF
version: 2
ethernets:
  eth0:
    dhcp4: false
    addresses:
      - ${vm_ip}/24
    gateway4: ${BRIDGE_IP}
    nameservers:
      addresses:
        - 8.8.8.8
        - 1.1.1.1
NETEOF
            echo "[ISO] Alpine static IP configured: ${vm_ip}/24"
        else
            cat > network-config << NETEOF
version: 2
ethernets:
  eth0:
    dhcp4: true
NETEOF
        fi
        
        cat > user-data << CLOUDEOF
#cloud-config
password: ${pass_hash}
chpasswd:
  expire: False
ssh_pwauth: True

user: ${CLOUD_USER}
disable_root: false

write_files:
  - path: /etc/ssh/sshd_config.d/99-enable-root-login.conf
    content: |
      PermitRootLogin yes
      PasswordAuthentication yes
    permissions: "0644"
    owner: root:root

runcmd:
  - echo "nameserver 8.8.8.8" > /etc/resolv.conf
  - echo "nameserver 1.1.1.1" >> /etc/resolv.conf
  - systemctl restart ssh 2>/dev/null || service ssh restart 2>/dev/null || /etc/init.d/sshd restart 2>/dev/null || true
  - systemctl restart networking 2>/dev/null || service networking restart 2>/dev/null || /etc/init.d/networking restart 2>/dev/null || true
CLOUDEOF
    fi
    
    # Build ISO
    if [ -f network-config ]; then
        genisoimage -output "${iso_path}" -volid cidata -joliet -rock user-data meta-data network-config 2>/dev/null
    else
        genisoimage -output "${iso_path}" -volid cidata -joliet -rock user-data meta-data 2>/dev/null
    fi
    
    if [ $? -ne 0 ]; then
        echo "ERROR: genisoimage failed"
        cd "${target_dir}" || exit 1
        rm -rf "${workdir}"
        exit 1
    fi
    
    cd "${target_dir}" || exit 1
    rm -rf "${workdir}"
    
    if [ -f "${iso_path}" ]; then
        echo "[ISO] Cloud-init ISO created successfully at: ${iso_path}"
    else
        echo "ERROR: Failed to create ISO at: ${iso_path}"
        exit 1
    fi
}

run_vm_with_retry() {
    local img_path="$1"
    local iso_path="$2"
    local initial_port="$3"
    local vm_memory="$4"
    local use_kvm="$5"
    local cpu_cores="$6"
    local use_bridge="$7"
    local vm_ip="$8"
    local tap_name="$9"
    
    if [ -d "$(dirname "$img_path")" ]; then
        img_path=$(cd "$(dirname "$img_path")" && pwd)/$(basename "$img_path")
    else
        img_path="$(pwd)/${img_path#./}"
    fi
    
    if [ -d "$(dirname "$iso_path")" ]; then
        iso_path=$(cd "$(dirname "$iso_path")" && pwd)/$(basename "$iso_path")
    else
        iso_path="$(pwd)/${iso_path#./}"
    fi
    
    if [ ! -f "${img_path}" ]; then
        echo "ERROR: Disk image not found: ${img_path}"
        exit 1
    fi
    if [ ! -f "${iso_path}" ]; then
        echo "ERROR: Cloud-init ISO not found: ${iso_path}"
        exit 1
    fi
    
    # Bridge mode
    if [ "$use_bridge" = "true" ] && [ -n "$vm_ip" ]; then
        echo "[VM] Starting QEMU with BRIDGE networking:"
        echo "  OS:      ${SELECTED_OS}"
        echo "  Disk:    ${img_path}"
        echo "  RAM:     ${vm_memory}MB"
        echo "  CPU:     ${cpu_cores} core(s)"
        echo "  Network: Bridge ${BRIDGE_NAME}"
        echo "  TAP:     ${tap_name}"
        echo "  VM IP:   ${vm_ip}"
        echo "  SSH:     ssh root@${vm_ip}"
        if [ "$use_kvm" = "true" ]; then
            echo "  KVM:     enabled"
        else
            echo "  KVM:     disabled"
        fi
        echo ""
        
        qemu-system-x86_64 \
            -drive file="${img_path}",format=qcow2,if=virtio \
            -cdrom "${iso_path}" \
            -m "${vm_memory}" \
            -smp "${cpu_cores}" \
            -netdev tap,id=net0,ifname="${tap_name}",script=no,downscript=no \
            -device virtio-net,netdev=net0 \
            -nographic \
            $([ "$use_kvm" = "true" ] && echo "-enable-kvm") \
            2>/tmp/qemu_error_$$.log
        
        local qemu_exit_code=$?
        
        if [ $qemu_exit_code -ne 0 ] && [ -f /tmp/qemu_error_$$.log ]; then
            echo "[NET] Bridge mode failed, falling back to port forwarding..."
            cat /tmp/qemu_error_$$.log >&2
            rm -f /tmp/qemu_error_$$.log
            delete_tap_interface "$tap_name"
            release_vm_ip "$vm_ip"
            use_bridge="false"
        else
            rm -f /tmp/qemu_error_$$.log
            delete_tap_interface "$tap_name"
            return $qemu_exit_code
        fi
    fi
    
    # Port forwarding mode
    local attempt=1
    local current_port="$initial_port"
    
    while [ "$attempt" -le "$MAX_RETRY_ATTEMPTS" ]; do
        echo "[RETRY] Attempt ${attempt}/${MAX_RETRY_ATTEMPTS} with port ${current_port}"
        
        echo "[VM] Starting QEMU with port forwarding:"
        echo "  OS:    ${SELECTED_OS}"
        echo "  Disk:  ${img_path}"
        echo "  RAM:   ${vm_memory}MB"
        echo "  CPU:   ${cpu_cores} core(s)"
        echo "  Port:  localhost:${current_port} -> VM:22"
        if [ "$use_kvm" = "true" ]; then
            echo "  KVM:   enabled"
        else
            echo "  KVM:   disabled"
        fi
        echo ""
        
        local port_available=false
        if test_port_binding "$current_port"; then
            port_available=true
        fi
        
        if [ "$port_available" = "true" ]; then
            qemu-system-x86_64 \
                -drive file="${img_path}",format=qcow2,if=virtio \
                -cdrom "${iso_path}" \
                -m "${vm_memory}" \
                -smp "${cpu_cores}" \
                -netdev user,id=net0,hostfwd=tcp::"${current_port}"-:22 \
                -device virtio-net,netdev=net0 \
                -nographic \
                $([ "$use_kvm" = "true" ] && echo "-enable-kvm") \
                2>/tmp/qemu_error_$$.log
            
            local qemu_exit_code=$?
            
            if [ $qemu_exit_code -ne 0 ] && [ -f /tmp/qemu_error_$$.log ]; then
                if grep -q "Could not set up host forward" /tmp/qemu_error_$$.log; then
                    rm -f /tmp/qemu_error_$$.log
                    if [ "$attempt" -lt "$MAX_RETRY_ATTEMPTS" ]; then
                        local new_port=$(find_available_port $((current_port + 1)))
                        if [ $? -eq 0 ]; then
                            current_port="$new_port"
                        else
                            attempt="$MAX_RETRY_ATTEMPTS"
                        fi
                        sleep "$RETRY_DELAY_SECONDS"
                        attempt=$((attempt + 1))
                        continue
                    else
                        echo "ERROR: Failed after ${MAX_RETRY_ATTEMPTS} attempts"
                        return 1
                    fi
                else
                    echo "ERROR: QEMU failed:"
                    cat /tmp/qemu_error_$$.log
                    rm -f /tmp/qemu_error_$$.log
                    return 1
                fi
            fi
            
            rm -f /tmp/qemu_error_$$.log
            return $qemu_exit_code
        else
            if [ "$attempt" -lt "$MAX_RETRY_ATTEMPTS" ]; then
                local new_port=$(find_available_port $((current_port + 1)))
                if [ $? -eq 0 ]; then
                    current_port="$new_port"
                else
                    attempt="$MAX_RETRY_ATTEMPTS"
                fi
                sleep "$RETRY_DELAY_SECONDS"
                attempt=$((attempt + 1))
            else
                echo "ERROR: Failed after ${MAX_RETRY_ATTEMPTS} attempts"
                return 1
            fi
        fi
    done
    
    return 1
}

# --- Main Logic ---
SELECTED_OS="$DEFAULT_OS"
CUSTOM_PORT=""
VM_NAME=""
DISK_SIZE="${DEFAULT_DISK_SIZE}"
CUSTOM_MEMORY=""
CUSTOM_CPU_CORES=""
NO_KVM=""
NO_BRIDGE=""
USE_BRIDGE="false"
VM_IP=""
TAP_NAME=""
bridge_method=""
CURRENT_DOWNLOAD_FILE=""  # Track current download for interrupt handler
DOWNLOAD_LOCK_DIR_PATH=""  # Track download lock directory

# Parse arguments
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help|-help|--h)
            show_help
            ;;
        --alpine)
            SELECTED_OS="alpine"
            shift
            ;;
        --ubuntu)
            SELECTED_OS="ubuntu"
            shift
            ;;
        --port)
            if [ -n "$2" ] && [ "$2" -eq "$2" ] 2>/dev/null; then
                CUSTOM_PORT="$2"
                shift 2
            else
                echo "ERROR: --port requires a valid number"
                exit 1
            fi
            ;;
        --size)
            if [ -n "$2" ]; then
                DISK_SIZE="$2"
                shift 2
            else
                echo "ERROR: --size requires a valid size (e.g., 5G, 10G, 20G)"
                exit 1
            fi
            ;;
        --memory|--mem)
            if [ -n "$2" ] && [ "$2" -eq "$2" ] 2>/dev/null; then
                CUSTOM_MEMORY="$2"
                shift 2
            else
                echo "ERROR: --memory requires a valid number in MB"
                exit 1
            fi
            ;;
        --cpu)
            if [ -n "$2" ] && [ "$2" -eq "$2" ] 2>/dev/null; then
                CUSTOM_CPU_CORES="$2"
                shift 2
            else
                echo "ERROR: --cpu requires a valid number"
                exit 1
            fi
            ;;
        --no-kvm)
            NO_KVM="true"
            shift
            ;;
        --no-bridge)
            NO_BRIDGE="true"
            shift
            ;;
        --retry-attempts)
            if [ -n "$2" ] && [ "$2" -eq "$2" ] 2>/dev/null; then
                MAX_RETRY_ATTEMPTS="$2"
                shift 2
            else
                echo "ERROR: --retry-attempts requires a valid number"
                exit 1
            fi
            ;;
        --retry-delay)
            if [ -n "$2" ] && [ "$2" -eq "$2" ] 2>/dev/null; then
                RETRY_DELAY_SECONDS="$2"
                shift 2
            else
                echo "ERROR: --retry-delay requires a valid number in seconds"
                exit 1
            fi
            ;;
        list)
            list_vms
            exit 0
            ;;
        delete)
            if [ -n "$2" ] && [ "${2#--}" = "$2" ]; then
                delete_vm "$2"
                exit 0
            else
                echo "ERROR: delete requires a VM name"
                exit 1
            fi
            ;;
        *)
            if [ -z "$VM_NAME" ] && [ "${1#--}" = "$1" ]; then
                VM_NAME="$1"
                shift
            else
                echo "ERROR: Unknown argument: $1"
                echo "Try: $0 --help"
                exit 1
            fi
            ;;
    esac
done

# Load OS configuration
echo "[SETUP] Selected OS: ${SELECTED_OS}"
get_os_config "$SELECTED_OS"

# --- Network Setup ---
if [ "$NO_BRIDGE" = "true" ]; then
    echo "[NET] Bridge disabled by user (--no-bridge)"
    USE_BRIDGE="false"
else
    if setup_bridge_network; then
        vm_identifier="${VM_NAME:-temp-$$}"
        
        # Reserve IP atomically via directory lock
        VM_IP=$(reserve_vm_ip "$vm_identifier")
        if [ -n "$VM_IP" ]; then
            TAP_NAME=$(generate_tap_name "${vm_identifier}-$(date +%s)")
            if create_vm_tap "$TAP_NAME"; then
                USE_BRIDGE="true"
                echo ""
                echo "=============================================================="
                echo "  BRIDGE NETWORKING ENABLED"
                echo "  VM IP: ${VM_IP}"
                echo "  TAP:   ${TAP_NAME}"
                echo "  SSH:   ssh root@${VM_IP}"
                echo "=============================================================="
                echo ""
            else
                echo "[NET] Failed to create TAP interface, releasing IP and using port forwarding"
                release_vm_ip "$VM_IP"
                VM_IP=""
                USE_BRIDGE="false"
            fi
        else
            echo "[NET] Could not assign an IP, using port forwarding"
            USE_BRIDGE="false"
        fi
    else
        USE_BRIDGE="false"
    fi
fi

# Determine KVM usage
if [ "$NO_KVM" = "true" ]; then
    USE_KVM="false"
    echo "[KVM] KVM disabled by user request"
else
    if check_kvm; then
        USE_KVM="true"
    else
        USE_KVM="false"
    fi
fi

# Validate CPU cores
if [ -n "$CUSTOM_CPU_CORES" ]; then
    VM_CPU_CORES=$(validate_cpu_cores "$CUSTOM_CPU_CORES")
else
    VM_CPU_CORES="$DEFAULT_CPU_CORES"
    echo "[CPU] Using default CPU cores: ${VM_CPU_CORES} (host has $(get_host_cpu_cores))"
fi

# Calculate VM memory
VM_MEMORY=$(calculate_vm_memory "$CUSTOM_MEMORY" "$SELECTED_OS" 2>&1)
MEMORY_EXIT_CODE=$?
echo "$VM_MEMORY" | while IFS= read -r line; do
    if echo "$line" | grep -qE '^\[MEMORY\]|^\[WARNING\]'; then
        echo "$line" >&2
    fi
done
VM_MEMORY=$(echo "$VM_MEMORY" | tail -n1)
if [ "$MEMORY_EXIT_CODE" -ne 0 ]; then
    exit 1
fi

# Port setup (only needed for non-bridge mode)
if [ "$USE_BRIDGE" = "false" ]; then
    if [ -n "$CUSTOM_PORT" ]; then
        START_PORT="$CUSTOM_PORT"
    else
        START_PORT="$SSH_BASE_PORT"
    fi
    echo "[PORT] Searching for available port starting from: ${START_PORT}"
    
    SSH_PORT=$(find_available_port "$START_PORT")
    if [ $? -ne 0 ]; then
        echo "$SSH_PORT"
        exit 1
    fi
    
    echo "[PORT] Using: ${SSH_PORT}"
else
    SSH_PORT="$SSH_BASE_PORT"
fi

# Store base directory
BASE_DIR=$(pwd)

# Ensure base image exists with robust download handling
if [ ! -f "${BASE_DIR}/${IMG_FILE}" ]; then
    echo "[SETUP] Base image not found, preparing download..."
    
    # Set up signal handlers for clean interrupt during download
    setup_download_signal_handlers
    
    # Acquire download lock to prevent concurrent downloads
    DOWNLOAD_LOCK_DIR_PATH=$(acquire_download_lock "${IMG_FILE}")
    
    # Set current download file for interrupt handler
    CURRENT_DOWNLOAD_FILE="${BASE_DIR}/${IMG_FILE}"
    
    # Download with integrity verification
    if ! download_with_integrity "${IMG_URL}" "${BASE_DIR}/${IMG_FILE}"; then
        echo "ERROR: Failed to download base image"
        release_download_lock "$DOWNLOAD_LOCK_DIR_PATH"
        exit 1
    fi
    
    # Release download lock
    release_download_lock "$DOWNLOAD_LOCK_DIR_PATH"
    DOWNLOAD_LOCK_DIR_PATH=""
    CURRENT_DOWNLOAD_FILE=""
    
    echo "[SETUP] Base image cached: ${BASE_DIR}/${IMG_FILE}"
else
    # Verify existing image integrity
    echo "[SETUP] Checking existing base image..."
    if ! verify_download_integrity "${BASE_DIR}/${IMG_FILE}"; then
        echo "[SETUP] Existing base image is corrupt, removing and re-downloading..."
        rm -f "${BASE_DIR}/${IMG_FILE}"
        rm -f "${BASE_DIR}/${IMG_FILE}.partial"
        
        # Set up signal handlers for clean interrupt during download
        setup_download_signal_handlers
        
        # Acquire download lock
        DOWNLOAD_LOCK_DIR_PATH=$(acquire_download_lock "${IMG_FILE}")
        
        # Set current download file for interrupt handler
        CURRENT_DOWNLOAD_FILE="${BASE_DIR}/${IMG_FILE}"
        
        # Re-download
        if ! download_with_integrity "${IMG_URL}" "${BASE_DIR}/${IMG_FILE}"; then
            echo "ERROR: Failed to download base image"
            release_download_lock "$DOWNLOAD_LOCK_DIR_PATH"
            exit 1
        fi
        
        # Release download lock
        release_download_lock "$DOWNLOAD_LOCK_DIR_PATH"
        DOWNLOAD_LOCK_DIR_PATH=""
        CURRENT_DOWNLOAD_FILE=""
        
        echo "[SETUP] Base image re-downloaded successfully: ${BASE_DIR}/${IMG_FILE}"
    else
        echo "[SETUP] Using cached base image: ${BASE_DIR}/${IMG_FILE}"
    fi
fi

# Cleanup function: releases IP lock and removes temporary files
cleanup_vm() {
    # Release download lock if we still hold it
    if [ -n "$DOWNLOAD_LOCK_DIR_PATH" ]; then
        release_download_lock "$DOWNLOAD_LOCK_DIR_PATH"
    fi
    
    if [ "$USE_BRIDGE" = "true" ] && [ -n "$VM_IP" ]; then
        release_vm_ip "$VM_IP"
        delete_tap_interface "$TAP_NAME"
    fi
    
    if [ -z "$VM_NAME" ] && [ -n "$TMPDIR" ]; then
        echo "[TEMP MODE] Cleaning up temporary files..."
        rm -rf "${TMPDIR}"
    fi
}
trap cleanup_vm EXIT

if [ -z "$VM_NAME" ]; then
    # Temporary mode
    TMPDIR=$(mktemp -d /tmp/${HOSTNAME_PREFIX}-vm-tmp.XXXXXX)
    echo "[TEMP MODE] Using temporary directory: ${TMPDIR}"
    echo "[TEMP MODE] All data will be lost when VM shuts down"
    
    cp "${BASE_DIR}/${IMG_FILE}" "${TMPDIR}/${IMG_FILE}"
    resize_disk "${TMPDIR}/${IMG_FILE}" "${DISK_SIZE}"
    
    create_cloud_init_iso "${TMPDIR}" "$VM_IP" "$OS_TYPE"
    
    run_vm_with_retry "${TMPDIR}/${IMG_FILE}" "${TMPDIR}/${ISO_FILE}" "${SSH_PORT}" "${VM_MEMORY}" "${USE_KVM}" "${VM_CPU_CORES}" "${USE_BRIDGE}" "${VM_IP}" "${TAP_NAME}"
else
    # Persistent mode
    VMDIR="${BASE_DIR}/${HOSTNAME_PREFIX}-vm-${VM_NAME}"
    
    if [ ! -d "${VMDIR}" ]; then
        echo "[PERSISTENT MODE] Creating new VM: ${VM_NAME} at ${VMDIR}"
        mkdir -p "${VMDIR}"
    else
        echo "[PERSISTENT MODE] Using existing VM: ${VM_NAME}"
    fi
    
    if [ ! -f "${VMDIR}/${IMG_FILE}" ]; then
        echo "[PERSISTENT MODE] Copying base image..."
        cp "${BASE_DIR}/${IMG_FILE}" "${VMDIR}/${IMG_FILE}"
        resize_disk "${VMDIR}/${IMG_FILE}" "${DISK_SIZE}"
    else
        echo "[PERSISTENT MODE] Using existing disk image (size preserved)"
    fi
    
    create_cloud_init_iso "${VMDIR}" "$VM_IP" "$OS_TYPE"
    
    run_vm_with_retry "${VMDIR}/${IMG_FILE}" "${VMDIR}/${ISO_FILE}" "${SSH_PORT}" "${VM_MEMORY}" "${USE_KVM}" "${VM_CPU_CORES}" "${USE_BRIDGE}" "${VM_IP}" "${TAP_NAME}"
    echo "[PERSISTENT MODE] VM data preserved in: ${VMDIR}"
fi