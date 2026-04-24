#!/usr/bin/env bash
# build-007-ext2opt.sh
# Build the ext2opt tool for optimizing ext2 block placement.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
log()  { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "WARNING: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# ─── Build e2fsprogs and ext2opt ──────────────────────────────────────────────

E2FSPROGS="${SCRIPT_DIR}/e2fsprogs"
if [ ! -f "${E2FSPROGS}/lib/libext2fs.a" ]; then
    log "Building e2fsprogs libraries..."
    (cd "${E2FSPROGS}" && ./configure --enable-elf-shlibs=no)
    make -C "${E2FSPROGS}" -j"$(nproc)" libs
fi

log "Building ext2opt..."
make -C "${SCRIPT_DIR}/ext2opt" -j"$(nproc)"

[ -x "${SCRIPT_DIR}/ext2opt/ext2opt" ] || die "ext2opt binary not produced."

# ─── Capture sector log ───────────────────────────────────────────────────────

SECTOR_LOG="${SCRIPT_DIR}/sector_log.txt"
TEMU="${SCRIPT_DIR}/assets/temu"

[ -x "${TEMU}" ] || die "temu binary not found at ${TEMU}"

log "Starting temu to capture sector log (15 seconds)..."
"${TEMU}" --block-log vmsandbox_console.cfg </dev/null >/dev/null 2>"${SECTOR_LOG}" &
TEMU_PID=$!

sleep 15

log "Killing temu (pid ${TEMU_PID})..."
kill "${TEMU_PID}" 2>/dev/null || true
wait "${TEMU_PID}" 2>/dev/null || true

SECTOR_LINES=$(wc -l < "${SECTOR_LOG}")
log "Captured ${SECTOR_LINES} lines in sector_log.txt"
[ "${SECTOR_LINES}" -gt 0 ] || die "sector_log.txt is empty — is temu running with --block-log?"

log "Running ext2opt (hot blocks to front)..."
"${SCRIPT_DIR}/ext2opt/ext2opt" "${SCRIPT_DIR}/assets/disk.img" "${SECTOR_LOG}"

log "Splitting disk image into chunks..."
DISK_OUT="${SCRIPT_DIR}/assets/disk"
rm -rf "${DISK_OUT}"
mkdir -p "${DISK_OUT}"
"${SCRIPT_DIR}/assets/splitimg" "${SCRIPT_DIR}/assets/disk.img" "${DISK_OUT}" 256
[ -f "${DISK_OUT}/blk.txt" ] || die "splitimg did not produce blk.txt"

log "Compressing split bin files with zstd -12..."
zstd -12 -T0 --force -q "${DISK_OUT}"/*.bin
log "Compression complete."

log "Updating blk.txt with compression metadata..."
python3 - "${DISK_OUT}/blk.txt" <<'PYEOF'
import sys, json
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
data["compressed"] = True
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF

size_sum() { du -sb "$@" 2>/dev/null | awk '{s+=$1} END {print s}'; }
SZ_RAW=$(size_sum "${DISK_OUT}"/*.bin)
SZ_ZST=$(size_sum "${DISK_OUT}"/*.bin.zst)
log "Uncompressed: $(numfmt --to=iec-i --suffix=B ${SZ_RAW})"
log "Compressed:   $(numfmt --to=iec-i --suffix=B ${SZ_ZST})"

git -C ${SCRIPT_DIR}/e2fsprogs clean -f util/symlinks

log "Step 7 complete."
