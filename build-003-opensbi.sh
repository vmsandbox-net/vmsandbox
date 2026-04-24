#!/usr/bin/env bash
# build-003-opensbi.sh
# Build OpenSBI firmware.
# Output: $SCRIPT_DIR/assets/opensbi.bin

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
log()  { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "WARNING: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

log "Building OpenSBI fw_jump ($(nproc) CPUs)..."
make -C "${SCRIPT_DIR}/opensbi" \
    PLATFORM=generic \
    CROSS_COMPILE=riscv64-linux-gnu- \
    FW_JUMP=y \
    -j"$(nproc)"

FW_BIN="${SCRIPT_DIR}/opensbi/build/platform/generic/firmware/fw_jump.bin"
[ -f "${FW_BIN}" ] || die "fw_jump.bin not produced."

mkdir -p "${SCRIPT_DIR}/assets"
cp "${FW_BIN}" "${SCRIPT_DIR}/assets/opensbi.bin"
zstd -10 --force -q "${SCRIPT_DIR}/assets/opensbi.bin" -o "${SCRIPT_DIR}/assets/opensbi.bin.zst"
log "opensbi.bin:     $(du -sh "${SCRIPT_DIR}/assets/opensbi.bin"     | cut -f1)"
log "opensbi.bin.zst: $(du -sh "${SCRIPT_DIR}/assets/opensbi.bin.zst" | cut -f1)"
log "Step 3 complete."
