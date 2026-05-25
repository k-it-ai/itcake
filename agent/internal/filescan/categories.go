package filescan

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	categoryTempFiles      = "temp_files"
	categoryBrowserCache   = "browser_cache"
	categoryPackageCache   = "package_cache"
	categoryTrash          = "trash"
	categoryOldDownloads   = "old_downloads"
	categoryUnrotatedLogs  = "unrotated_logs"
	maxSamplesPerCategory  = 20
)

type matcher struct {
	id           string
	prefixes     []string
	containsAll  []string
	minAge       time.Duration
	minSize      int64
	requireRoot  bool
}

func categoryMatchers() []matcher {
	homes := candidateHomeDirs()
	mat := []matcher{
		{id: categoryTempFiles, prefixes: tempPrefixes(), minAge: 7 * 24 * time.Hour},
		{id: categoryBrowserCache, prefixes: browserCachePrefixes(homes), containsAll: []string{"Cache"}},
		{id: categoryPackageCache, prefixes: packageCachePrefixes(homes)},
		{id: categoryTrash, prefixes: trashPrefixes(homes)},
		{id: categoryOldDownloads, prefixes: downloadPrefixes(homes), minAge: 90 * 24 * time.Hour},
		{id: categoryUnrotatedLogs, prefixes: logPrefixes(), minAge: 30 * 24 * time.Hour, minSize: 100 * 1024 * 1024},
	}
	return mat
}

func tempPrefixes() []string {
	out := []string{"/tmp/", "/var/tmp/"}
	switch runtime.GOOS {
	case "darwin":
		// macOS per-user temp lives under /var/folders/.../T/ via _CS_DARWIN_USER_TEMP_DIR.
		if t := os.TempDir(); t != "" {
			sep := string(os.PathSeparator)
			if !strings.HasSuffix(t, sep) {
				t += sep
			}
			out = append(out, t)
		}
	case "windows":
		if t := os.Getenv("TEMP"); t != "" {
			out = append(out, normWinPrefix(t))
		}
		if t := os.Getenv("TMP"); t != "" {
			out = append(out, normWinPrefix(t))
		}
	}
	return out
}

func browserCachePrefixes(homes []string) []string {
	out := []string{}
	for _, h := range homes {
		out = append(out,
			filepath.Join(h, ".cache", "google-chrome")+string(os.PathSeparator),
			filepath.Join(h, ".cache", "chromium")+string(os.PathSeparator),
			filepath.Join(h, ".cache", "mozilla")+string(os.PathSeparator),
			filepath.Join(h, ".mozilla", "firefox")+string(os.PathSeparator),
			filepath.Join(h, "Library", "Caches", "Google", "Chrome")+string(os.PathSeparator),
			filepath.Join(h, "Library", "Caches", "Firefox")+string(os.PathSeparator),
			filepath.Join(h, "Library", "Caches", "com.apple.Safari")+string(os.PathSeparator),
			filepath.Join(h, "AppData", "Local", "Google", "Chrome", "User Data")+string(os.PathSeparator),
			filepath.Join(h, "AppData", "Local", "Microsoft", "Edge", "User Data")+string(os.PathSeparator),
			filepath.Join(h, "AppData", "Local", "Mozilla", "Firefox")+string(os.PathSeparator),
		)
	}
	return out
}

func packageCachePrefixes(homes []string) []string {
	out := []string{}
	for _, h := range homes {
		out = append(out,
			filepath.Join(h, ".cache", "yarn")+string(os.PathSeparator),
			filepath.Join(h, ".npm", "_cacache")+string(os.PathSeparator),
			filepath.Join(h, ".cache", "pip")+string(os.PathSeparator),
			filepath.Join(h, ".cargo", "registry", "cache")+string(os.PathSeparator),
			filepath.Join(h, "Library", "Caches", "Homebrew")+string(os.PathSeparator),
			filepath.Join(h, "Library", "Caches", "pip")+string(os.PathSeparator),
			filepath.Join(h, "AppData", "Roaming", "npm-cache")+string(os.PathSeparator),
		)
	}
	return out
}

func trashPrefixes(homes []string) []string {
	out := []string{}
	for _, h := range homes {
		out = append(out,
			filepath.Join(h, ".local", "share", "Trash")+string(os.PathSeparator),
			filepath.Join(h, ".Trash")+string(os.PathSeparator),
		)
	}
	if runtime.GOOS == "windows" {
		out = append(out, `C:\$Recycle.Bin\`)
	}
	return out
}

func downloadPrefixes(homes []string) []string {
	out := []string{}
	for _, h := range homes {
		out = append(out, filepath.Join(h, "Downloads")+string(os.PathSeparator))
	}
	return out
}

func logPrefixes() []string {
	if runtime.GOOS == "windows" {
		return []string{}
	}
	return []string{"/var/log/"}
}

// matchCategory returns the category id for a file path or "" if none.
func matchCategory(path string, modTime time.Time, size int64, mats []matcher) string {
	now := time.Now()
	for _, m := range mats {
		if !pathMatchesAny(path, m.prefixes) {
			continue
		}
		if len(m.containsAll) > 0 {
			ok := true
			for _, sub := range m.containsAll {
				if !strings.Contains(path, sub) {
					ok = false
					break
				}
			}
			if !ok {
				continue
			}
		}
		if m.minAge > 0 && now.Sub(modTime) < m.minAge {
			continue
		}
		if m.minSize > 0 && size < m.minSize {
			continue
		}
		return m.id
	}
	return ""
}

func pathMatchesAny(path string, prefixes []string) bool {
	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	for _, p := range prefixes {
		if p == "" {
			continue
		}
		needle := p
		if runtime.GOOS == "windows" {
			needle = strings.ToLower(needle)
		}
		if strings.HasPrefix(path, needle) {
			return true
		}
	}
	return false
}

// systemPathDenylist returns the set of resolved-path prefixes that the
// cleanup helper MUST refuse to touch. Categories like temp/cache/trash
// have their own positive allowlist; this is the explicit deny that
// catches symlink shenanigans (a symlink under /tmp pointing into /etc).
func systemPathDenylist() []string {
	if runtime.GOOS == "windows" {
		return []string{
			`C:\Windows\`,
			`C:\Program Files\`,
			`C:\Program Files (x86)\`,
			`C:\ProgramData\`,
			`C:\Users\Default\`,
		}
	}
	return []string{
		"/etc/",
		"/usr/",
		"/bin/",
		"/sbin/",
		"/lib/",
		"/lib64/",
		"/boot/",
		"/var/log/",
		"/Applications/",
		"/System/",
	}
}

func candidateHomeDirs() []string {
	seen := map[string]struct{}{}
	out := []string{}
	add := func(s string) {
		if s == "" {
			return
		}
		if _, ok := seen[s]; ok {
			return
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	add(os.Getenv("HOME"))
	if h, err := os.UserHomeDir(); err == nil {
		add(h)
	}
	if runtime.GOOS == "linux" {
		entries, err := os.ReadDir("/home")
		if err == nil {
			for _, e := range entries {
				if e.IsDir() {
					add(filepath.Join("/home", e.Name()))
				}
			}
		}
	}
	if runtime.GOOS == "darwin" {
		entries, err := os.ReadDir("/Users")
		if err == nil {
			for _, e := range entries {
				if e.IsDir() && !strings.HasPrefix(e.Name(), ".") && e.Name() != "Shared" {
					add(filepath.Join("/Users", e.Name()))
				}
			}
		}
	}
	return out
}

func normWinPrefix(p string) string {
	if !strings.HasSuffix(p, string(os.PathSeparator)) {
		p += string(os.PathSeparator)
	}
	return p
}
