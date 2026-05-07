package filescan

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Per-file size cap during cleanup. A file > this is almost certainly
// not actually disposable cache; refuse to delete it even if the path
// matches the category root.
const cleanupMaxFileSize int64 = 1 << 30 // 1 GiB

// validCleanupCategories lists the category IDs the cleanup endpoint
// will accept. Categories outside this list (e.g. unrotated_logs) are
// strictly read-only — we surface them in analysis but never delete.
var validCleanupCategories = map[string]struct{}{
	categoryTempFiles:    {},
	categoryBrowserCache: {},
	categoryPackageCache: {},
	categoryTrash:        {},
	categoryOldDownloads: {},
}

// IsValidCleanupCategory reports whether `id` is in the cleanup allowlist.
func IsValidCleanupCategory(id string) bool {
	_, ok := validCleanupCategories[id]
	return ok
}

// allowedCleanupRoots returns the set of path prefixes a deletion may
// target for the given category. Cross-checked against the resolved
// (symlink-followed) absolute path so a symlink under /tmp pointing into
// /etc still gets refused.
func allowedCleanupRoots(category string) []string {
	homes := candidateHomeDirs()
	switch category {
	case categoryTempFiles:
		return tempPrefixes()
	case categoryBrowserCache:
		return browserCachePrefixes(homes)
	case categoryPackageCache:
		return packageCachePrefixes(homes)
	case categoryTrash:
		return trashPrefixes(homes)
	case categoryOldDownloads:
		return downloadPrefixes(homes)
	}
	return nil
}

// ExecuteCleanup deletes operator-supplied paths after re-validating
// every input. Defensive on every layer: absolute paths only, must lie
// inside the category's allowlist after EvalSymlinks, must not resolve
// to a system path, must not be > 1 GiB, must not be owned by a uid
// the agent can't legally delete (root-owned files only allowed when
// the agent runs as root and the parent is in the category allowlist).
func ExecuteCleanup(category string, paths []string) (CleanupResult, error) {
	res := CleanupResult{}
	if !IsValidCleanupCategory(category) {
		return res, fmt.Errorf("unknown cleanup category %q", category)
	}
	roots := allowedCleanupRoots(category)
	if len(roots) == 0 {
		return res, fmt.Errorf("no cleanup roots known for category %q on this OS", category)
	}
	deny := systemPathDenylist()

	for _, p := range paths {
		if err := validateCleanupPath(p, roots, deny); err != nil {
			res.Skipped++
			res.Errors = append(res.Errors, p+": "+err.Error())
			continue
		}
		info, err := os.Lstat(p)
		if err != nil {
			res.Skipped++
			res.Errors = append(res.Errors, p+": "+err.Error())
			continue
		}
		if info.IsDir() {
			res.Skipped++
			res.Errors = append(res.Errors, p+": directories require recursive flag (not supported)")
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			res.Skipped++
			res.Errors = append(res.Errors, p+": symlink not deletable here")
			continue
		}
		if info.Size() > cleanupMaxFileSize {
			res.Skipped++
			res.Errors = append(res.Errors, fmt.Sprintf("%s: %d bytes > %d cap", p, info.Size(), cleanupMaxFileSize))
			continue
		}
		if !mayDeleteByOwner(info) {
			res.Skipped++
			res.Errors = append(res.Errors, p+": owned by privileged user")
			continue
		}
		size := info.Size()
		if err := os.Remove(p); err != nil {
			res.Skipped++
			res.Errors = append(res.Errors, p+": "+err.Error())
			continue
		}
		res.Deleted++
		res.FreedBytes += size
	}
	return res, nil
}

func validateCleanupPath(p string, roots, deny []string) error {
	if p == "" {
		return errors.New("empty path")
	}
	if !filepath.IsAbs(p) {
		return errors.New("path must be absolute")
	}
	if strings.ContainsAny(p, "\x00") {
		return errors.New("null byte in path")
	}
	cleaned := filepath.Clean(p)
	if !pathInsideAny(cleaned, roots) {
		return errors.New("not inside any cleanup-category root")
	}
	resolved, err := filepath.EvalSymlinks(cleaned)
	if err != nil {
		// File doesn't exist (yet) — that's a 404 at deletion time, not
		// a permission issue. Fall through; os.Remove will surface it.
		if os.IsNotExist(err) {
			resolved = cleaned
		} else {
			return err
		}
	}
	if !pathInsideAny(resolved, roots) {
		return errors.New("symlink resolves outside cleanup roots")
	}
	if pathInsideAny(resolved, deny) {
		return errors.New("resolves to a system path")
	}
	return nil
}

func pathInsideAny(p string, prefixes []string) bool {
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	for _, prefix := range prefixes {
		if prefix == "" {
			continue
		}
		needle := prefix
		if runtime.GOOS == "windows" {
			needle = strings.ToLower(needle)
		}
		if !strings.HasSuffix(needle, string(os.PathSeparator)) {
			needle += string(os.PathSeparator)
		}
		if p+string(os.PathSeparator) == needle || strings.HasPrefix(p+string(os.PathSeparator), needle) {
			return true
		}
	}
	return false
}
