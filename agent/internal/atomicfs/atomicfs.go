// Package atomicfs provides crash-safe atomic file writes.
//
// The standard "write to tmp + rename" idiom is atomic in metadata
// terms — after the rename, readers see either the old file or the new
// one, never a half-written byte stream. But without fsync, a power
// loss between the rename and the next page-cache writeback can leave
// the new file present at zero size (or with a partial write) because
// the data hadn't reached disk before the metadata operation
// completed.
//
// `WriteFile` here:
//  1. Writes the tmp file
//  2. fsync()s the tmp file (data + metadata to disk)
//  3. Renames tmp → real
//  4. fsync()s the parent directory (so the rename itself is durable)
//
// Applied at every agent persistence site: config.json (per-row
// encryption secrets), replay-cache.json (replay window protection),
// state.json (operator-visible heartbeat). The cost of two extra
// fsyncs per write is negligible (~1 ms on SSD); the durability
// guarantee is significant — a power loss mid-write of replay-cache
// would otherwise re-open the replay window after reboot.
package atomicfs

import (
	"fmt"
	"os"
	"path/filepath"
)

// WriteFile writes `data` to `path` atomically + durably. Uses
// `path + ".tmp"` as the intermediate file; the tmp file is removed on
// any error so partial writes don't accumulate.
func WriteFile(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return fmt.Errorf("create tmp: %w", err)
	}
	cleanup := func() { _ = os.Remove(tmp) }
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("write tmp: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("fsync tmp: %w", err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close tmp: %w", err)
	}
	// Re-apply permissions (umask may have intersected with `perm` on
	// older filesystems). Best-effort — Windows ignores chmod.
	_ = os.Chmod(tmp, perm)
	if err := os.Rename(tmp, path); err != nil {
		cleanup()
		return fmt.Errorf("rename: %w", err)
	}
	// fsync the parent directory so the rename itself is durable.
	// Without this, a power loss after rename can lose the rename
	// metadata and the file appears as the OLD content (or absent if
	// it never existed). Best-effort on platforms where dir fsync
	// isn't supported (Windows returns EINVAL — ignored).
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}
