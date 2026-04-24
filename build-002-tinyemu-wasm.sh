#!/usr/bin/env bash
# build-002-tinyemu-wasm.sh
#
# Output:
#   $SCRIPT_DIR/assets/riscvemu64-wasm.js   — patched JS loader
#   $SCRIPT_DIR/assets/riscvemu64-wasm.wasm — patched WASM binary

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
log()  { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "WARNING: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

${SCRIPT_DIR}/emsdk/emsdk install latest
${SCRIPT_DIR}/emsdk/emsdk activate latest
source "${SCRIPT_DIR}/emsdk/emsdk_env.sh" &>/dev/null || die "Failed to source Emscripten environment."

# ─── Preflight ────────────────────────────────────────────────────────────────

if ! command -v emcc &>/dev/null; then
    die "emcc not found"
fi

# ─── Build WASM ───────────────────────────────────────────────────────────────

log "Cleaning native artifacts before WASM build..."
make -C "${SCRIPT_DIR}/tinyemu" clean

log "Building riscvemu64-wasm.js with emcc $(emcc --version 2>&1 | grep -oP '\d+\.\d+\.\d+' | head -1)..."
make -C "${SCRIPT_DIR}/tinyemu" -f Makefile.js js/riscvemu64-wasm.js

# ─── Install into assets/ ─────────────────────────────────────────────────────

log "Installing WASM into ${SCRIPT_DIR}/assets/..."
cp "${SCRIPT_DIR}/tinyemu/js/riscvemu64-wasm.js"   "${SCRIPT_DIR}/assets/riscvemu64-wasm.js"
cp "${SCRIPT_DIR}/tinyemu/js/riscvemu64-wasm.wasm" "${SCRIPT_DIR}/assets/riscvemu64-wasm.wasm"

log "  riscvemu64-wasm.js:   $(du -sh "${SCRIPT_DIR}/assets/riscvemu64-wasm.js"   | cut -f1)"
log "  riscvemu64-wasm.wasm: $(du -sh "${SCRIPT_DIR}/assets/riscvemu64-wasm.wasm" | cut -f1)"
log "Step 2 complete."
