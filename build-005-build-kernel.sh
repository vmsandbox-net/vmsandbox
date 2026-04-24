#!/usr/bin/env bash
# build-005-build-kernel.sh
# Build the Linux kernel.
# Output: $SCRIPT_DIR/assets/kernel.bin

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
log()  { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "WARNING: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

[ -f "${SCRIPT_DIR}/linux/.config" ] || die ".config not found. Run step 4 first."

log "Building kernel ($(nproc) CPUs) — this takes 3-5 min..."
make -C "${SCRIPT_DIR}/linux" \
    ARCH=riscv \
    CROSS_COMPILE=riscv64-linux-gnu- \
    KBUILD_BUILD_USER=vmsandbox \
    KBUILD_BUILD_HOST=vmsandbox \
    -j"$(nproc)"

KERNEL_IMAGE="${SCRIPT_DIR}/linux/arch/riscv/boot/Image"
[ -f "${KERNEL_IMAGE}" ] || die "Kernel Image not produced."

mkdir -p "${SCRIPT_DIR}/assets"
cp "${KERNEL_IMAGE}" "${SCRIPT_DIR}/assets/kernel.bin"
zstd -12 --force -q "${SCRIPT_DIR}/assets/kernel.bin" -o "${SCRIPT_DIR}/assets/kernel.bin.zst"
log "kernel.bin:     $(du -sh "${SCRIPT_DIR}/assets/kernel.bin"     | cut -f1)"
log "kernel.bin.zst: $(du -sh "${SCRIPT_DIR}/assets/kernel.bin.zst" | cut -f1)"
log "Step 5 complete."
