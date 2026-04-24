#!/usr/bin/env bash
# build-001-tinyemu-native.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
log()  { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "WARNING: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

mkdir -p "${SCRIPT_DIR}/assets"

log "Cleaning WASM artifacts before native build..."
rm -f "${SCRIPT_DIR}/tinyemu/"*.js.o "${SCRIPT_DIR}/tinyemu/"*.js.d

log "Building TinyEMU ($(nproc) CPUs)..."
make -C "${SCRIPT_DIR}/tinyemu" -j"$(nproc)"

[ -x "${SCRIPT_DIR}/tinyemu/temu" ] || die "temu binary not produced."
cp "${SCRIPT_DIR}/tinyemu/temu" "${SCRIPT_DIR}/assets/temu"
log "temu: $(du -sh "${SCRIPT_DIR}/assets/temu" | cut -f1)"

log "Building splitimg..."
make -C "${SCRIPT_DIR}/tinyemu" splitimg
[ -x "${SCRIPT_DIR}/tinyemu/splitimg" ] || die "splitimg binary not produced."
cp "${SCRIPT_DIR}/tinyemu/splitimg" "${SCRIPT_DIR}/assets/splitimg"
log "splitimg: ${SCRIPT_DIR}/assets/splitimg"

# Smoke test
"${SCRIPT_DIR}/assets/temu" 2>&1 | head -1 || true

log "Step 1 complete."
