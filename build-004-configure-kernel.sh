#!/usr/bin/env bash
# build-004-configure-kernel.sh
# Apply vmsandbox_defconfig to the extracted Linux kernel source.
# Output: $SCRIPT_DIR/linux/ with .config ready for building.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
log()  { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "WARNING: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

log "Installing vmsandbox_defconfig..."
cp "${SCRIPT_DIR}/vmsandbox_defconfig" "${SCRIPT_DIR}/linux/arch/riscv/configs/vmsandbox_defconfig"

log "Running make vmsandbox_defconfig..."
make -C "${SCRIPT_DIR}/linux" \
    ARCH=riscv \
    CROSS_COMPILE=riscv64-linux-gnu- \
    "vmsandbox_defconfig"

log "Step 4 complete. Linux source at: ${SCRIPT_DIR}/linux"
