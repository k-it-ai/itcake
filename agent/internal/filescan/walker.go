package filescan

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultMaxFileSize    int64 = 5 * 1024 * 1024 * 1024
	maxAllowedFileSize    int64 = 100 * 1024 * 1024 * 1024
	defaultTimeoutSeconds       = 600
	maxTimeoutSeconds           = 3600
	defaultWorkers              = 4
	maxWorkers                  = 16
	topFilesK                   = 50
	topDirsK                    = 30
	maxErrorEntries             = 50
)

var systemAlwaysSkip = []string{
	"/proc",
	"/sys",
	"/dev",
	"/var/run",
	"/run",
}

func systemAlwaysSkipWindows() []string {
	return []string{
		`C:\Windows`,
		`C:\$Recycle.Bin\$I`,
		`C:\System Volume Information`,
	}
}

// Walk performs a single chunked walk over the configured paths and
// returns a categorised result. Bounded by ScopeConfig.TimeoutSeconds.
func Walk(scope ScopeConfig) (Result, error) {
	if scope.MaxFileSizeBytes <= 0 {
		scope.MaxFileSizeBytes = defaultMaxFileSize
	}
	if scope.MaxFileSizeBytes > maxAllowedFileSize {
		scope.MaxFileSizeBytes = maxAllowedFileSize
	}
	if scope.TimeoutSeconds <= 0 {
		scope.TimeoutSeconds = defaultTimeoutSeconds
	}
	if scope.TimeoutSeconds > maxTimeoutSeconds {
		scope.TimeoutSeconds = maxTimeoutSeconds
	}
	if scope.Workers <= 0 {
		scope.Workers = defaultWorkers
	}
	if scope.Workers > maxWorkers {
		scope.Workers = maxWorkers
	}

	skipREs := compileSkipPatterns(scope.SkipPatterns)
	mats := categoryMatchers()

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(scope.TimeoutSeconds)*time.Second)
	defer cancel()

	type catAccum struct {
		total   int64
		count   int64
		samples []FileEntry
	}

	var (
		mu              sync.Mutex
		filesScanned    atomic.Int64
		bytesScanned    atomic.Int64
		dirsScanned     atomic.Int64
		errs            []string
		topFiles        = newFileTop(topFilesK)
		topDirs         = newDirTop(topDirsK)
		categories      = make(map[string]*catAccum)
		truncated       atomic.Bool
	)

	addError := func(s string) {
		mu.Lock()
		defer mu.Unlock()
		if len(errs) < maxErrorEntries {
			errs = append(errs, s)
		}
	}

	type fileWork struct {
		path string
		size int64
		mod  time.Time
	}
	ch := make(chan fileWork, scope.Workers*8)
	var wg sync.WaitGroup
	for i := 0; i < scope.Workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for w := range ch {
				select {
				case <-ctx.Done():
					return
				default:
				}
				filesScanned.Add(1)
				bytesScanned.Add(w.size)
				mu.Lock()
				topFiles.consider(FileEntry{Path: w.path, SizeBytes: w.size, ModTime: w.mod})
				topDirs.addFile(w.path, w.size)
				if cat := matchCategory(w.path, w.mod, w.size, mats); cat != "" {
					accum, ok := categories[cat]
					if !ok {
						accum = &catAccum{}
						categories[cat] = accum
					}
					accum.total += w.size
					accum.count++
					if len(accum.samples) < maxSamplesPerCategory {
						accum.samples = append(accum.samples, FileEntry{Path: w.path, SizeBytes: w.size, ModTime: w.mod})
					}
				}
				mu.Unlock()
			}
		}()
	}

	walkOne := func(root string) {
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			select {
			case <-ctx.Done():
				truncated.Store(true)
				return ctx.Err()
			default:
			}
			if err != nil {
				addError(p + ": " + err.Error())
				if d != nil && d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if isSystemSkipPath(p) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if matchesAnyRegex(p, skipREs) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				if isNetworkMount(p) {
					return filepath.SkipDir
				}
				dirsScanned.Add(1)
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			size := info.Size()
			if size > scope.MaxFileSizeBytes {
				return nil
			}
			select {
			case ch <- fileWork{path: p, size: size, mod: info.ModTime()}:
				return nil
			case <-ctx.Done():
				truncated.Store(true)
				return ctx.Err()
			}
		})
	}

	for _, root := range scope.Paths {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		if !filepath.IsAbs(root) {
			addError(root + ": not absolute, skipping")
			continue
		}
		walkOne(root)
	}

	close(ch)
	wg.Wait()

	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		truncated.Store(true)
	}

	mu.Lock()
	cats := make([]Category, 0, len(categories))
	for id, a := range categories {
		cats = append(cats, Category{ID: id, TotalBytes: a.total, FileCount: a.count, Samples: a.samples})
	}
	res := Result{
		ScannedAt:          start,
		DurationSeconds:    int(time.Since(start).Seconds()),
		FilesScanned:       filesScanned.Load(),
		BytesScanned:       bytesScanned.Load(),
		DirectoriesScanned: dirsScanned.Load(),
		Categories:         cats,
		TopFiles:           topFiles.drain(),
		TopDirectories:     topDirs.topK(),
		Truncated:          truncated.Load(),
		Errors:             errs,
	}
	mu.Unlock()
	return res, nil
}

func compileSkipPatterns(patterns []string) []*regexp.Regexp {
	out := make([]*regexp.Regexp, 0, len(patterns))
	for _, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		re, err := regexp.Compile(p)
		if err != nil {
			continue
		}
		out = append(out, re)
	}
	return out
}

func matchesAnyRegex(s string, res []*regexp.Regexp) bool {
	for _, r := range res {
		if r.MatchString(s) {
			return true
		}
	}
	return false
}

func isSystemSkipPath(p string) bool {
	if runtime.GOOS == "windows" {
		lp := strings.ToLower(p)
		for _, sk := range systemAlwaysSkipWindows() {
			if strings.HasPrefix(lp, strings.ToLower(sk)) {
				return true
			}
		}
		return false
	}
	for _, sk := range systemAlwaysSkip {
		if p == sk || strings.HasPrefix(p, sk+"/") {
			return true
		}
	}
	return false
}

// isNetworkMount returns true when `dir` is the root of an NFS / SMB /
// AFP mount. Linux: parses /proc/mounts. macOS: shells out to df+mount
// is too heavy; we use os.Stat + the result's Sys() statfs (best-effort
// on darwin builds — see walker_unix.go for the actual statfs read).
// Windows: best-effort drive-type via mount classification falls back
// to false.
func isNetworkMount(dir string) bool {
	return platformIsNetworkMount(dir)
}
