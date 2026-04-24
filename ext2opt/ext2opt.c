#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ext2fs/ext2fs.h>

/* ---- metadata block detection ------------------------------------------ */

static int is_metadata_block(ext2_filsys fs, blk64_t block)
{
    dgrp_t g;
    for (g = 0; g < fs->group_desc_count; g++) {
        if (ext2fs_block_bitmap_loc(fs, g) == block) return 1;
        if (ext2fs_inode_bitmap_loc(fs, g) == block) return 1;
        blk64_t itable = ext2fs_inode_table_loc(fs, g);
        if (block >= itable && block < itable + fs->inode_blocks_per_group)
            return 1;
        if (ext2fs_bg_has_super(fs, g)) {
            blk64_t sb = ext2fs_group_first_block2(fs, g);
            if (block == sb) return 1;
            /* desc_blocks = actual GDT blocks; s_reserved_gdt_blocks = blocks
             * reserved for online growth (resize_inode feature). Both must be
             * treated as metadata. */
            blk64_t desc_end = sb + (blk64_t)fs->desc_blocks
                               + fs->super->s_reserved_gdt_blocks + 1;
            if (block > sb && block < desc_end) return 1;
        }
    }
    return 0;
}

/* ---- block reference remap callback ------------------------------------ */

static blk64_t *g_remap;
static blk64_t  g_remap_size;

static int remap_block_cb(ext2_filsys fs EXT2FS_ATTR((unused)),
                           blk64_t *blocknr,
                           e2_blkcnt_t blockcnt EXT2FS_ATTR((unused)),
                           blk64_t ref_blk EXT2FS_ATTR((unused)),
                           int ref_offset EXT2FS_ATTR((unused)),
                           void *priv EXT2FS_ATTR((unused)))
{
    if (*blocknr == 0 || *blocknr >= g_remap_size)
        return 0;
    blk64_t dst = g_remap[*blocknr];
    if (dst) {
        *blocknr = dst;
        return BLOCK_CHANGED;
    }
    return 0;
}

/* ---- apply the remap: inode scan + bitmap update ----------------------- */

static int apply_remap(ext2_filsys fs, blk64_t total)
{
    errcode_t err;

    /* inode scan */
    err = ext2fs_read_inode_bitmap(fs);
    if (err) { com_err("ext2opt", err, "reading inode bitmap"); return 1; }

    ext2_inode_scan scan;
    err = ext2fs_open_inode_scan(fs, 0, &scan);
    if (err) { com_err("ext2opt", err, "opening inode scan"); return 1; }

    char *block_buf = malloc(fs->blocksize * 3);
    if (!block_buf) { fprintf(stderr, "out of memory\n"); return 1; }

    ext2_ino_t ino;
    struct ext2_inode inode;
    blk64_t n_inodes = 0;
    for (;;) {
        err = ext2fs_get_next_inode(scan, &ino, &inode);
        if (err || ino == 0) break;
        if (!ext2fs_test_inode_bitmap2(fs->inode_map, ino)) continue;
        if (inode.i_links_count == 0) continue;
        if (!ext2fs_inode_has_valid_blocks2(fs, &inode)) continue;
        ext2fs_block_iterate3(fs, ino, 0, block_buf, remap_block_cb, NULL);
        n_inodes++;
    }
    ext2fs_close_inode_scan(scan);
    free(block_buf);
    printf("  scanned %llu inodes\n", (unsigned long long)n_inodes);

    /* bitmap update: two-phase to handle positions that are both a source
     * (evicted cold block) and a destination (incoming hot block) */
    for (blk64_t b = 0; b < total; b++)
        if (g_remap[b])
            ext2fs_unmark_block_bitmap2(fs->block_map, b);
    for (blk64_t b = 0; b < total; b++)
        if (g_remap[b])
            ext2fs_mark_block_bitmap2(fs->block_map, g_remap[b]);

    /* group descriptor free-block-count deltas */
    int32_t *delta = calloc(fs->group_desc_count, sizeof(int32_t));
    if (!delta) { fprintf(stderr, "out of memory\n"); return 1; }
    for (blk64_t b = 0; b < total; b++) {
        if (!g_remap[b]) continue;
        delta[ext2fs_group_of_blk2(fs, b)]++;           /* src freed */
        delta[ext2fs_group_of_blk2(fs, g_remap[b])]--;  /* dst used  */
    }
    for (dgrp_t g = 0; g < fs->group_desc_count; g++) {
        if (!delta[g]) continue;
        ext2fs_bg_free_blocks_count_set(fs, g,
            ext2fs_bg_free_blocks_count(fs, g) + delta[g]);
        ext2fs_group_desc_csum_set(fs, g);
    }
    free(delta);

    ext2fs_mark_bb_dirty(fs);
    ext2fs_mark_super_dirty(fs);
    return 0;
}

/* ---- copy blocks and update references for a list of (src, dst) pairs -- */

static int copy_and_remap(ext2_filsys fs, blk64_t total EXT2FS_ATTR((unused)),
                           blk64_t *srcs, blk64_t *dsts, blk64_t n,
                           const char *label)
{
    errcode_t err;
    char *buf = malloc(fs->blocksize);
    if (!buf) { fprintf(stderr, "out of memory\n"); return 1; }

    for (blk64_t i = 0; i < n; i++) {
        if (i % 1000 == 0)
            printf("  %s %llu / %llu ...\r", label,
                   (unsigned long long)i, (unsigned long long)n);
        err = io_channel_read_blk64(fs->io, srcs[i], 1, buf);
        if (err) { com_err("ext2opt", err, "reading block"); free(buf); return 1; }
        err = io_channel_write_blk64(fs->io, dsts[i], 1, buf);
        if (err) { com_err("ext2opt", err, "writing block"); free(buf); return 1; }
        g_remap[srcs[i]] = dsts[i];
    }
    free(buf);
    printf("  %s %llu / %llu done\n", label, (unsigned long long)n, (unsigned long long)n);
    return 0;
}

/* ======================================================================== */
/* Mode 1: move all in-use data blocks to end of disk                        */
/* ======================================================================== */

static int mode_move_to_end(ext2_filsys fs, blk64_t total, blk64_t start)
{
    blk64_t *inuse     = malloc(total * sizeof(blk64_t));
    blk64_t *free_blks = malloc(total * sizeof(blk64_t));
    if (!inuse || !free_blks) { fprintf(stderr, "out of memory\n"); return 1; }

    blk64_t n_inuse = 0, n_free = 0;
    for (blk64_t b = start; b < total; b++) {
        if (ext2fs_test_block_bitmap2(fs->block_map, b)) {
            if (!is_metadata_block(fs, b))
                inuse[n_inuse++] = b;
        } else {
            free_blks[n_free++] = b;
        }
    }

    /* reverse free_blks so [0] is the highest free block */
    for (blk64_t i = 0, j = n_free - 1; i < j; i++, j--) {
        blk64_t t = free_blks[i]; free_blks[i] = free_blks[j]; free_blks[j] = t;
    }

    blk64_t n_moves = 0;
    while (n_moves < n_inuse && n_moves < n_free &&
           inuse[n_moves] < free_blks[n_moves])
        n_moves++;

    printf("in-use data blocks: %llu\n", (unsigned long long)n_inuse);
    printf("free blocks:        %llu\n", (unsigned long long)n_free);
    printf("blocks to move:     %llu\n", (unsigned long long)n_moves);

    if (n_moves == 0) { printf("nothing to move\n"); goto done; }

    g_remap = calloc(total, sizeof(blk64_t));
    if (!g_remap) { fprintf(stderr, "out of memory\n"); return 1; }
    g_remap_size = total;

    if (copy_and_remap(fs, total, inuse, free_blks, n_moves, "moving")) return 1;
    if (apply_remap(fs, total)) return 1;

    free(g_remap);
    printf("done.\n");
done:
    free(inuse);
    free(free_blks);
    return 0;
}

/* ======================================================================== */
/* Mode 2: place hot blocks at front, push cold blocks to back              */
/* ======================================================================== */

static void parse_sector_log(FILE *f, uint8_t *hot, blk64_t total, uint32_t ext2_bs)
{
    char line[512];
    while (fgets(line, sizeof(line), f)) {
        long long sector = -1, n = -1;
        if (sscanf(line, "blk R sector=%lld n=%lld", &sector, &n) < 2)
            sscanf(line, "bf_read_async: sector_num=%lld n=%lld", &sector, &n);
        if (sector < 0 || n <= 0) continue;
        blk64_t byte_start = (blk64_t)sector * 512;
        blk64_t byte_end   = byte_start + (blk64_t)n * 512 - 1;
        blk64_t first = byte_start / ext2_bs;
        blk64_t last  = byte_end   / ext2_bs;
        for (blk64_t b = first; b <= last && b < total; b++)
            hot[b] = 1;
    }
}

static int mode_optimize(ext2_filsys fs, blk64_t total, blk64_t start, FILE *log_f)
{
    uint32_t ext2_bs = EXT2_BLOCK_SIZE(fs->super);

    /* parse sector log */
    uint8_t *hot = calloc(total, 1);
    if (!hot) { fprintf(stderr, "out of memory\n"); return 1; }
    parse_sector_log(log_f, hot, total, ext2_bs);

    /* N = hot non-metadata in-use blocks (these go to the front) */
    blk64_t N = 0;
    for (blk64_t b = start; b < total; b++)
        if (hot[b] && !is_metadata_block(fs, b) &&
            ext2fs_test_block_bitmap2(fs->block_map, b))
            N++;
    printf("hot non-metadata in-use blocks: %llu\n", (unsigned long long)N);

    if (N == 0) { printf("nothing to do\n"); free(hot); return 0; }

    /* target[] = first N non-metadata positions in the disk.
     * These are the positions we want hot blocks to occupy. */
    uint8_t *in_target = calloc(total, 1);
    if (!in_target) { fprintf(stderr, "out of memory\n"); return 1; }
    blk64_t found = 0;
    for (blk64_t b = start; b < total && found < N; b++)
        if (!is_metadata_block(fs, b)) { in_target[b] = 1; found++; }

    /* categorise:
     *   evict_src  - cold block in target range → must move out
     *   place_dst  - position in target range not occupied by a hot block
     *                (superset of evict_src positions; also includes free slots)
     *   place_src  - hot block outside target range → must move in
     *   evict_dst  - free block outside target range (receives evicted cold data) */
    blk64_t *evict_src  = malloc(N * sizeof(blk64_t));
    blk64_t *evict_dst  = malloc(N * sizeof(blk64_t));
    blk64_t *place_src  = malloc(N * sizeof(blk64_t));
    blk64_t *place_dst  = malloc(N * sizeof(blk64_t));
    if (!evict_src || !evict_dst || !place_src || !place_dst) {
        fprintf(stderr, "out of memory\n"); return 1;
    }
    blk64_t n_evict = 0, n_evict_dst = 0, n_place_src = 0, n_place_dst = 0;

    for (blk64_t b = start; b < total; b++) {
        int used = ext2fs_test_block_bitmap2(fs->block_map, b);
        if (in_target[b]) {
            if (used && !hot[b]) evict_src[n_evict++] = b; /* cold in target */
            if (!(used && hot[b])) place_dst[n_place_dst++] = b; /* not hot→available */
        } else {
            if (hot[b] && used && !is_metadata_block(fs, b))
                place_src[n_place_src++] = b; /* hot outside target */
        }
    }

    /* collect evict_dst: free blocks outside target, from the back */
    for (blk64_t b = total - 1; b >= start && n_evict_dst < n_evict; b--)
        if (!in_target[b] && !ext2fs_test_block_bitmap2(fs->block_map, b))
            evict_dst[n_evict_dst++] = b;

    printf("cold blocks to evict from front: %llu\n", (unsigned long long)n_evict);
    printf("hot blocks to pull to front:     %llu\n", (unsigned long long)n_place_src);

    if (n_evict_dst < n_evict) {
        fprintf(stderr, "error: not enough free space outside target for evictions "
                "(%llu needed, %llu available)\n",
                (unsigned long long)n_evict, (unsigned long long)n_evict_dst);
        return 1;
    }
    if (n_place_dst != n_place_src) {
        fprintf(stderr, "error: place count mismatch (dst=%llu src=%llu)\n",
                (unsigned long long)n_place_dst, (unsigned long long)n_place_src);
        return 1;
    }

    if (n_evict == 0 && n_place_src == 0) {
        printf("all hot blocks already at front, nothing to move\n");
        goto done;
    }

    g_remap = calloc(total, sizeof(blk64_t));
    if (!g_remap) { fprintf(stderr, "out of memory\n"); return 1; }
    g_remap_size = total;

    /* Phase 1: copy cold blocks out of target range (evictions first so their
     * positions are free before hot blocks move in) */
    if (n_evict && copy_and_remap(fs, total, evict_src, evict_dst, n_evict,
                                  "evicting cold")) return 1;

    /* Phase 2: copy hot blocks into target range */
    if (n_place_src && copy_and_remap(fs, total, place_src, place_dst, n_place_src,
                                      "placing hot")) return 1;

    if (apply_remap(fs, total)) return 1;

    free(g_remap);
    printf("done.\n");
done:
    free(evict_src); free(evict_dst);
    free(place_src); free(place_dst);
    free(in_target);
    free(hot);
    return 0;
}

/* ======================================================================== */
/* main                                                                      */
/* ======================================================================== */

int main(int argc, char *argv[])
{
    const char *disk     = "assets/disk.img";
    const char *log_path = NULL;

    if (argc >= 2) disk     = argv[1];
    if (argc >= 3) log_path = argv[2];

    ext2_filsys fs;
    errcode_t err = ext2fs_open(disk, EXT2_FLAG_RW, 0, 0, unix_io_manager, &fs);
    if (err) { com_err("ext2opt", err, "opening %s", disk); return 1; }

    err = ext2fs_read_block_bitmap(fs);
    if (err) { com_err("ext2opt", err, "reading block bitmap"); return 1; }

    blk64_t total = ext2fs_blocks_count(fs->super);
    blk64_t start = fs->super->s_first_data_block;
    printf("total blocks: %llu\n", (unsigned long long)total);

    int rc;
    if (!log_path) {
        printf("mode: move all in-use data to end\n");
        rc = mode_move_to_end(fs, total, start);
    } else {
        printf("mode: optimize hot blocks to front  (log: %s)\n", log_path);
        FILE *f = fopen(log_path, "r");
        if (!f) { perror(log_path); ext2fs_close(fs); return 1; }
        rc = mode_optimize(fs, total, start, f);
        fclose(f);
    }

    ext2fs_close(fs);
    return rc;
}
