// Package filescan walks operator-specified paths, categorises files by
// well-known cleanup buckets (temp / cache / trash / downloads / logs),
// tracks the largest files + directories, and offers a defensive
// cleanup helper that refuses to touch anything outside a small fixed
// set of category roots.
//
// Detection-only by default. The cleanup path is gated server-side
// (operator MFA + explicit category) and re-validates every input on
// the agent.
package filescan

import "time"

type ScopeConfig struct {
	Paths            []string `json:"paths"`
	SkipPatterns     []string `json:"skipPatterns"`
	MaxFileSizeBytes int64    `json:"maxFileSizeBytes"`
	TimeoutSeconds   int      `json:"timeoutSeconds"`
	Workers          int      `json:"workers"`
}

type FileEntry struct {
	Path      string    `json:"path"`
	SizeBytes int64     `json:"sizeBytes"`
	ModTime   time.Time `json:"modTime"`
}

type DirEntry struct {
	Path       string `json:"path"`
	TotalBytes int64  `json:"totalBytes"`
	FileCount  int64  `json:"fileCount"`
}

type Category struct {
	ID         string      `json:"id"`
	TotalBytes int64       `json:"totalBytes"`
	FileCount  int64       `json:"fileCount"`
	Samples    []FileEntry `json:"samples"`
}

type Result struct {
	ScannedAt          time.Time   `json:"scannedAt"`
	DurationSeconds    int         `json:"durationSeconds"`
	FilesScanned       int64       `json:"filesScanned"`
	BytesScanned       int64       `json:"bytesScanned"`
	DirectoriesScanned int64       `json:"directoriesScanned"`
	Categories         []Category  `json:"categories"`
	TopFiles           []FileEntry `json:"topFiles"`
	TopDirectories     []DirEntry  `json:"topDirectories"`
	Truncated          bool        `json:"truncated"`
	Errors             []string    `json:"errors"`
}

type CleanupResult struct {
	Deleted    int      `json:"deleted"`
	Skipped    int      `json:"skipped"`
	FreedBytes int64    `json:"freedBytes"`
	Errors     []string `json:"errors"`
}
