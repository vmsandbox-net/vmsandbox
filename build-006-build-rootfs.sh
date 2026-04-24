#!/usr/bin/env bash
# build-006-build-rootfs.sh
# Build a minimal Debian Trixie riscv64 ext2 disk image.
# Self-elevates to root for chroot/debootstrap.
# Output: $SCRIPT_DI./assets/disk.img (raw flat image, ~512 MB)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
log()  { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "WARNING: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
    exec sudo -- env SCRIPT_DIR="${SCRIPT_DIR}" "$0" "$@"
fi

# ─── Configuration ────────────────────────────────────────────────────────────

DEBIAN_SUITE="trixie"
DEBIAN_MIRROR="https://deb.debian.org/debian"
IMAGE_SIZE_MB=562
ROOT_PASSWORD="tinyemu"

WORK_DIR="${SCRIPT_DIR}/tmp/vmsandbox-rootfs-build"
ROOTFS_DIR="${WORK_DIR}/rootfs"
IMAGE_FILE="${WORK_DIR}/rootfs.img"
APT_CACHE_DIR="${SCRIPT_DIR}/downloads/apt-cache"

PACKAGES=(
    iproute2    # ip command
    ifupdown    # ifup/ifdown
    procps      # ps, top, free
    less        # pager
    vim-tiny    # editor
    wget        # network testing
    strace      # syscall tracing / debugging
    dhcpcd      # DHCP client (for testing virtio-net)
    etcd-server
    etcd-client
    tcpdump      # network traffic capture and analysis
    coreutils
    tmux
    zsh
    tshark
    perl                # required by pg_ctlcluster and other pg wrapper scripts
    postgresql          # PostgreSQL 17 server
    postgresql-client   # psql, pg_isready, pg_basebackup
    btop
    ngircd      # irc server
    irssi       # irc client
    bird2       # BGP/OSPF routing daemon
    util-linux          # agetty
    ncurses-term        # xterm-256color terminfo
)

# ─── Cleanup trap ─────────────────────────────────────────────────────────────

MOUNTS_ACTIVE=0
teardown() {
    if [ "${MOUNTS_ACTIVE}" -eq 1 ]; then
        for mp in "${ROOTFS_DIR}/var/cache/apt/archives" \
                  "${ROOTFS_DIR}/dev/pts" "${ROOTFS_DIR}/dev" \
                  "${ROOTFS_DIR}/sys" "${ROOTFS_DIR}/proc"; do
            mountpoint -q "${mp}" 2>/dev/null && umount -lf "${mp}" || true
        done
        MOUNTS_ACTIVE=0
    fi
}
trap teardown EXIT

# ─── Preflight ────────────────────────────────────────────────────────────────

for cmd in debootstrap mke2fs e2fsck riscv64-linux-gnu-gcc; do
    command -v "${cmd}" &>/dev/null || die "'${cmd}' not found. Run setup first."
done
[ -f /proc/sys/fs/binfmt_misc/qemu-riscv64 ] \
    || die "qemu-riscv64 binfmt not registered. Run setup first."
grep -q '^flags:.*F' /proc/sys/fs/binfmt_misc/qemu-riscv64 \
    || die "binfmt handler missing F flag. Re-run step 1."

# ─── Step 1: Prepare ──────────────────────────────────────────────────────────

log "Preparing build directories..."
if [ -d "${ROOTFS_DIR}" ]; then
    teardown
    rm -rf "${ROOTFS_DIR}"
fi
mkdir -p "${ROOTFS_DIR}" "${WORK_DIR}" "${SCRIPT_DIR}/assets" "${APT_CACHE_DIR}"

log "Cross-compiling tools/fireworks.c for riscv64..."
riscv64-linux-gnu-gcc -O2 -static \
    -o "${WORK_DIR}/fireworks" \
    "${SCRIPT_DIR}/tools/fireworks.c" \
    -lm

# ─── Step 2: debootstrap stage 1 ─────────────────────────────────────────────

log "debootstrap stage 1 (foreign)..."
debootstrap \
    --arch=riscv64 --variant=minbase --foreign \
    --cache-dir="${APT_CACHE_DIR}" \
    --include=busybox-static \
    "${DEBIAN_SUITE}" "${ROOTFS_DIR}" "${DEBIAN_MIRROR}"

# ─── Step 3: chroot setup ─────────────────────────────────────────────────────

log "Setting up chroot..."
cp /usr/bin/qemu-riscv64-static "${ROOTFS_DIR}/usr/bin/"
mount --bind /proc "${ROOTFS_DIR}/proc"
mount --bind /sys  "${ROOTFS_DIR}/sys"
mount --bind /dev  "${ROOTFS_DIR}/dev"
mount --bind /dev/pts "${ROOTFS_DIR}/dev/pts"
mkdir -p "${ROOTFS_DIR}/var/cache/apt/archives"
mount --bind "${APT_CACHE_DIR}" "${ROOTFS_DIR}/var/cache/apt/archives"
MOUNTS_ACTIVE=1

# ─── Step 4: debootstrap stage 2 ─────────────────────────────────────────────

log "debootstrap stage 2 (riscv64 via QEMU — takes ~2-3 min)..."
chroot "${ROOTFS_DIR}" /debootstrap/debootstrap --second-stage

# ─── Step 5: Configure rootfs ─────────────────────────────────────────────────

log "Configuring rootfs..."

cat > "${ROOTFS_DIR}/etc/apt/sources.list" <<EOF
deb ${DEBIAN_MIRROR} ${DEBIAN_SUITE} main
deb ${DEBIAN_MIRROR} ${DEBIAN_SUITE}-updates main
deb https://security.debian.org/debian-security ${DEBIAN_SUITE}-security main
EOF

cp /etc/resolv.conf "${ROOTFS_DIR}/etc/resolv.conf"

mkdir -p "${ROOTFS_DIR}/etc/apt/preferences.d"
cat > "${ROOTFS_DIR}/etc/apt/preferences.d/no-systemd" <<'EOF'
Package: systemd-sysv
Pin: release *
Pin-Priority: -1
EOF

cat > "${ROOTFS_DIR}/etc/apt/preferences.d/no-netplan" <<'EOF'
Package: netplan.io
Pin: release *
Pin-Priority: -1
EOF

chroot "${ROOTFS_DIR}" apt-get update -qq

if [ ${#PACKAGES[@]} -gt 0 ]; then
    log "Installing packages: ${PACKAGES[*]}"
    chroot "${ROOTFS_DIR}" env DEBIAN_FRONTEND=noninteractive \
        apt-get install -y --no-install-recommends "${PACKAGES[@]}"
fi

# busybox init (agetty from util-linux is used instead of busybox getty)
chroot "${ROOTFS_DIR}" busybox --install -s /bin
mkdir -p "${ROOTFS_DIR}/sbin"
ln -sf /bin/busybox "${ROOTFS_DIR}/sbin/init"
ln -sf /sbin/init   "${ROOTFS_DIR}/init"

cat > "${ROOTFS_DIR}/etc/inittab" <<'EOF'
::sysinit:/etc/init.d/rcS
hvc0::respawn:/sbin/agetty --autologin root --noissue --noclear hvc0 xterm-256color
hvc1::respawn:/sbin/agetty --wait-cr --autologin root --noissue --noclear hvc1 xterm-256color
hvc2::respawn:/sbin/agetty --wait-cr --autologin root --noissue --noclear hvc2 xterm-256color
hvc3::respawn:/sbin/agetty --wait-cr --autologin root --noissue --noclear hvc3 xterm-256color
::restart:/sbin/init
::ctrlaltdel:/sbin/reboot
::shutdown:/bin/umount -a -r
EOF

mkdir -p "${ROOTFS_DIR}/etc/init.d"
cat > "${ROOTFS_DIR}/etc/init.d/rcS" <<'EOF'
#!/bin/sh
mkdir -p /dev/pts /dev/shm
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devpts devpts /dev/pts
[ -e /etc/mtab ] || ln -sf /proc/self/mounts /etc/mtab
mkdir -p /run/init
mount -t 9p /dev/virtio0 /run/init -o ro,trans=virtio,version=9p2000.L
[ -f /run/init/init.sh ] && sh /run/init/init.sh
EOF
chmod +x "${ROOTFS_DIR}/etc/init.d/rcS"

# /root/.bash_profile: sourced by bash login shells (agetty --autologin → login → bash).
# Sets the EXIT trap so the frontend learns when the shell exits, then sources the
# per-VM init.sh provided via virtio9p (topology-specific setup, prompts, etc.).
cat > "${ROOTFS_DIR}/root/.bash_profile" <<'EOF'
trap 'printf "\033]31;\007"' EXIT
[ -f /run/init/startup.sh ] && . /run/init/startup.sh
EOF

# agetty and login write login records to these files; they must exist before first login.
touch "${ROOTFS_DIR}/var/run/utmp"
touch "${ROOTFS_DIR}/var/log/wtmp"

cat > "${ROOTFS_DIR}/etc/fstab" <<'EOF'
/dev/vda    /        ext2    errors=remount-ro    0    1
proc        /proc    proc    defaults             0    0
sysfs       /sys     sysfs   defaults             0    0
devpts      /dev/pts devpts  defaults             0    0
tmpfs       /tmp     tmpfs   defaults             0    0
EOF

mkdir -p "${ROOTFS_DIR}/etc/network"
cat > "${ROOTFS_DIR}/etc/network/interfaces" <<'EOF'
auto lo
iface lo inet loopback
iface eth0 inet dhcp
EOF

echo "vmsandbox-riscv64" > "${ROOTFS_DIR}/etc/hostname"
echo "root:${ROOT_PASSWORD}" | chroot "${ROOTFS_DIR}" chpasswd -c MD5

# pam_loginuid.so requires CONFIG_AUDIT in the kernel; our minimal kernel omits
# audit, so mark it optional to prevent pam_open_session() failing silently
# (which would cause login to exit without exec'ing the shell).
sed -i 's/session[[:space:]]*required[[:space:]]*pam_loginuid\.so/session    optional     pam_loginuid.so/' \
    "${ROOTFS_DIR}/etc/pam.d/login"

# console-probe: static riscv64 diagnostic binary for testing virtio console I/O
if [ -f "${SCRIPT_DIR}/console-probe" ]; then
    install -m 0755 "${SCRIPT_DIR}/console-probe" "${ROOTFS_DIR}/usr/sbin/console-probe"
fi

# fireworks: terminal fireworks demo
install -m 0755 "${WORK_DIR}/fireworks" "${ROOTFS_DIR}/usr/local/bin/fireworks"

rm -rf "${ROOTFS_DIR}/var/lib/apt/lists/"*
rm -f  "${ROOTFS_DIR}/usr/bin/qemu-riscv64-static"
teardown

# ─── Trim rootfs to reduce disk size ─────────────────────────────────────────
# apt cache was bind-mounted during install; unmounting (teardown) makes it safe to delete.
rm -rf "${ROOTFS_DIR}/var/cache/apt"                  # 120 MB: .deb archives + pkgcache indices
rm -rf "${ROOTFS_DIR}/usr/share/doc"                  #  21 MB: package documentation
rm -rf "${ROOTFS_DIR}/usr/share/man"                  #   9 MB: man pages
rm -rf "${ROOTFS_DIR}/usr/share/i18n"                 #  17 MB: locale definition sources (not compiled locales)
rm -rf "${ROOTFS_DIR}/usr/share/locale"               #  66 MB: message-catalog translations (programs fall back to C)
rm -rf "${ROOTFS_DIR}/usr/share/zsh/functions"        #  17 MB: zsh completion functions (not needed for lab scripts)
rm -rf "${ROOTFS_DIR}/usr/share/zsh/help"             # 428 KB: zsh help texts

# ─── Step 6: Create ext2 image ────────────────────────────────────────────────

log "Creating disk image..."
used_mb=$(du -sm "${ROOTFS_DIR}" | cut -f1)
[ "${IMAGE_SIZE_MB}" -lt "${used_mb}" ] && IMAGE_SIZE_MB=$(( used_mb * 120 / 100 + 50 ))
log "  Image size: ${IMAGE_SIZE_MB} MB (rootfs used: ${used_mb} MB)"

rm -f "${IMAGE_FILE}"
truncate -s "${IMAGE_SIZE_MB}M" "${IMAGE_FILE}"
# -g 32768: maximum blocks per group for 4096-byte blocks → 8 groups instead of ~30
# -O sparse_super: only groups 0,1,3,5,7 carry superblock copies
# ^resize_inode: no reserved GDT blocks (we never resize this image)
mke2fs -t ext2 -b 4096 -g 32768 -O sparse_super,^resize_inode -d "${ROOTFS_DIR}" "${IMAGE_FILE}"
e2fsck -f -p "${IMAGE_FILE}" || true

cp "${IMAGE_FILE}" "${SCRIPT_DIR}/assets/disk.img"

log "Splitting disk image into chunks..."
DISK_OUT="${SCRIPT_DIR}/assets/disk"
rm -rf "${DISK_OUT}"
mkdir -p "${DISK_OUT}"
"${SCRIPT_DIR}/assets/splitimg" "${SCRIPT_DIR}/assets/disk.img" "${DISK_OUT}" 256
[ -f "${DISK_OUT}/blk.txt" ] || die "splitimg did not produce blk.txt"

log "disk.img: $(du -sh "${SCRIPT_DIR}/assets/disk.img" | cut -f1)"

# Restore ownership to the invoking user (sudo sets SUDO_UID/SUDO_GID)
if [ -n "${SUDO_UID:-}" ] && [ -n "${SUDO_GID:-}" ]; then
    chown -R "${SUDO_UID}:${SUDO_GID}" \
        "${SCRIPT_DIR}/assets/disk.img" \
        "${SCRIPT_DIR}/assets/disk"
fi

log "Step 6 complete."
