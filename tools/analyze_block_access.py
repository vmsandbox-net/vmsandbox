#!/usr/bin/env python3
"""
Analyze sector-level block access logs and map to ext2 blocks and download chunks.

Usage (native temu with DUMP_BLOCK_IO):
  ./temu -config vmsandbox_console.cfg 2>sector_log.txt
  python3 tools/analyze_block_access.py --disk path/to/rootfs.img < sector_log.txt

Usage (browser WASM — copy console output to a file):
  python3 tools/analyze_block_access.py --disk path/to/rootfs.img < sector_log.txt

Output:
  - Number and list of ext2 blocks accessed (sorted, unique)
  - Which 256 KB download chunks contain those ext2 blocks
  - A prefetch list suitable for blk.txt
"""
import sys
import struct
import argparse
import re


def get_ext2_block_size(disk_path):
    """Read block size from the ext2 superblock (at disk byte offset 1024)."""
    with open(disk_path, 'rb') as f:
        f.seek(1024 + 24)  # superblock at 1024, s_log_block_size at offset 24
        data = f.read(4)
        if len(data) < 4:
            raise ValueError("Disk image too small to contain ext2 superblock")
        log_bs = struct.unpack('<I', data)[0]
    block_size = 1024 << log_bs
    return block_size


def parse_sector_log(lines):
    """
    Parse sector access log lines from either:
      - temu.c DUMP_BLOCK_IO:  "blk R sector=N n=M bytes=B"
      - block_net.c printf:    "bf_read_async: sector_num=N n=M"
                                "bf_write_async: sector_num=N n=M"
    Returns list of (sector_num, n_sectors, rw) tuples.
    """
    accesses = []
    # temu.c format
    pattern_temu = re.compile(r'blk ([RW]) sector=(\d+) n=(\d+)')
    # block_net.c format
    pattern_net = re.compile(r'bf_(read|write)_async: sector_num=(\d+) n=(\d+)')

    for line in lines:
        m = pattern_temu.search(line)
        if m:
            rw = m.group(1)
            sector_num = int(m.group(2))
            n = int(m.group(3))
            accesses.append((sector_num, n, rw))
            continue
        m = pattern_net.search(line)
        if m:
            rw = 'R' if m.group(1) == 'read' else 'W'
            sector_num = int(m.group(2))
            n = int(m.group(3))
            accesses.append((sector_num, n, rw))

    return accesses


def sectors_to_ext2_blocks(accesses, ext2_bs):
    """Convert sector accesses to a set of ext2 block numbers."""
    ext2_blocks = set()
    for sector_num, n, rw in accesses:
        if rw != 'R':
            continue  # only track reads for prefetch purposes
        byte_start = sector_num * 512
        byte_end = byte_start + n * 512 - 1
        first_blk = byte_start // ext2_bs
        last_blk = byte_end // ext2_bs
        for b in range(first_blk, last_blk + 1):
            ext2_blocks.add(b)
    return ext2_blocks


def main():
    parser = argparse.ArgumentParser(
        description='Map sector access log to ext2 blocks and download chunks')
    parser.add_argument('--disk', required=True,
                        help='Path to raw disk image (to read ext2 superblock)')
    parser.add_argument('--chunk-kb', type=int, default=256,
                        help='Download chunk size in KB (default: 256)')
    parser.add_argument('--prefetch-only', action='store_true',
                        help='Only output the prefetch chunk list (for blk.txt)')
    args = parser.parse_args()

    ext2_bs = get_ext2_block_size(args.disk)
    chunk_bytes = args.chunk_kb * 1024

    print(f"ext2 block size: {ext2_bs} bytes", file=sys.stderr)
    print(f"download chunk size: {args.chunk_kb} KB", file=sys.stderr)

    accesses = parse_sector_log(sys.stdin)
    print(f"parsed {len(accesses)} sector accesses", file=sys.stderr)

    ext2_blocks = sorted(sectors_to_ext2_blocks(accesses, ext2_bs))
    download_chunks = sorted(set(
        (b * ext2_bs) // chunk_bytes for b in ext2_blocks
    ))

    import math
    blocks_per_chunk = chunk_bytes // ext2_bs
    optimal_chunks = math.ceil(len(ext2_blocks) / blocks_per_chunk) if ext2_blocks else 0

    if args.prefetch_only:
        print(download_chunks)
        return

    print(f"\n=== {len(ext2_blocks)} ext2 blocks accessed (reads only) ===")
    for b in ext2_blocks:
        byte_off = b * ext2_bs
        chunk = byte_off // chunk_bytes
        # print(f"  ext2[{b:6d}]  byte_offset={byte_off:#012x}  download_chunk={chunk}")

    print(f"\n=== chunk summary ===")
    print(f"  actual chunks needed:  {len(download_chunks)}"
          f"  ({len(download_chunks) * chunk_bytes // 1024} KB)")
    print(f"  optimal chunks needed: {optimal_chunks}"
          f"  ({optimal_chunks * chunk_bytes // 1024} KB)"
          f"  [{blocks_per_chunk} ext2 blocks per chunk]")
    if optimal_chunks:
        waste = len(download_chunks) / optimal_chunks
        print(f"  overhead vs optimal:   {waste:.2f}x  "
              f"({(len(download_chunks) - optimal_chunks) * chunk_bytes // 1024} KB wasted)")

    print(f"\n  download chunks: {download_chunks}")

    print(f'\nAdd to blk.txt "prefetch" array:')
    print(f'"prefetch": {download_chunks}')


if __name__ == '__main__':
    main()
