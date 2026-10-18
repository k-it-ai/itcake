package secscan

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	chunkSize    = 64 * 1024
	overlapBytes = 256
	binaryProbeN = 8 * 1024
	maxFindings  = 5000
)

// Scope mirrors the server-validated scope. Agent re-validates as defense-in-depth.
type Scope struct {
	Paths              []string `json:"paths"`
	SuppressPaths      []string `json:"suppressPaths"`
	SuppressPatternIDs []string `json:"suppressPatternIds"`
	MaxFileSizeBytes   int64    `json:"maxFileSizeBytes"`
	TimeoutSeconds     int      `json:"timeoutSeconds"`
	Workers            int      `json:"workers"`
}

// Finding is one row in the on-the-wire result.
type Finding struct {
	Path      string `json:"path"`
	Line      int    `json:"line"`
	PatternID string `json:"patternId"`
	Severity  string `json:"severity"`
	Sample    string `json:"sample"`
}

// Summary tracks aggregate scan statistics for the result envelope.
type Summary struct {
	FilesScanned int   `json:"filesScanned"`
	BytesScanned int64 `json:"bytesScanned"`
	DurationMs   int64 `json:"durationMs"`
}

// ScanResult is the JSON the agent emits in commandResult.stdout.
type ScanResult struct {
	Findings []Finding `json:"findings"`
	Summary  Summary   `json:"summary"`
}

// Scan walks scope.Paths, applies the regex catalogue, and returns a result.
// Missing/unreadable paths are silently skipped.
func Scan(scope Scope) ScanResult {
	if scope.MaxFileSizeBytes <= 0 {
		scope.MaxFileSizeBytes = 5 * 1024 * 1024
	}
	if scope.TimeoutSeconds <= 0 {
		scope.TimeoutSeconds = 120
	}
	if scope.Workers <= 0 {
		scope.Workers = 4
	}
	if scope.Workers > 16 {
		scope.Workers = 16
	}

	suppressed := make(map[string]struct{}, len(scope.SuppressPatternIDs))
	for _, id := range scope.SuppressPatternIDs {
		suppressed[strings.ToLower(id)] = struct{}{}
	}
	patterns := make([]Pattern, 0, len(Patterns))
	for _, p := range Patterns {
		if _, off := suppressed[strings.ToLower(p.ID)]; off {
			continue
		}
		patterns = append(patterns, p)
	}

	suppressMatchers := make([]*regexp.Regexp, 0, len(scope.SuppressPaths))
	// Cap regex source length — Go's RE2-backed regexp has no compile
	// timeout, and a very long source can still burn CPU at match time.
	const maxSuppressRegexLen = 256
	for _, sp := range scope.SuppressPaths {
		if sp == "" {
			continue
		}
		if strings.HasPrefix(sp, "re:") {
			if len(sp) > maxSuppressRegexLen {
				continue
			}
			if r, err := regexp.Compile(sp[3:]); err == nil {
				suppressMatchers = append(suppressMatchers, r)
			}
		}
	}

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(scope.TimeoutSeconds)*time.Second)
	defer cancel()

	var (
		mu       sync.Mutex
		findings = make([]Finding, 0, 64)
		summary  Summary
	)

	fileCh := make(chan string, scope.Workers*4)
	var wg sync.WaitGroup
	for i := 0; i < scope.Workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range fileCh {
				select {
				case <-ctx.Done():
					return
				default:
				}
				fileFindings, bytesRead := scanFile(path, patterns, scope.MaxFileSizeBytes)
				mu.Lock()
				summary.FilesScanned++
				summary.BytesScanned += bytesRead
				if len(findings) < maxFindings {
					remaining := maxFindings - len(findings)
					if len(fileFindings) > remaining {
						findings = append(findings, fileFindings[:remaining]...)
					} else {
						findings = append(findings, fileFindings...)
					}
				}
				mu.Unlock()
			}
		}()
	}

	walk := func(root string) {
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}
			for _, sp := range scope.SuppressPaths {
				if !strings.HasPrefix(sp, "re:") && sp != "" && strings.HasPrefix(p, sp) {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
			}
			for _, r := range suppressMatchers {
				if r.MatchString(p) {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
			}
			if d.IsDir() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			if info.Size() > scope.MaxFileSizeBytes {
				return nil
			}
			select {
			case fileCh <- p:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}

	for _, root := range scope.Paths {
		if root == "" {
			continue
		}
		// Absolute paths only — server validator allows any non-empty
		// string, and `../../../etc` would resolve against agent CWD.
		if !filepath.IsAbs(root) {
			continue
		}
		walk(root)
	}
	close(fileCh)
	wg.Wait()
	summary.DurationMs = time.Since(start).Milliseconds()

	return ScanResult{Findings: findings, Summary: summary}
}

func scanFile(path string, patterns []Pattern, maxSize int64) ([]Finding, int64) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0
	}
	defer f.Close()

	probe := make([]byte, binaryProbeN)
	n, _ := f.Read(probe)
	if n > 0 && bytes.IndexByte(probe[:n], 0) >= 0 {
		return nil, 0
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, 0
	}

	findings := make([]Finding, 0, 4)
	matchCount := make(map[string]int, len(patterns))
	totalRead := int64(0)
	tail := make([]byte, 0, overlapBytes)
	firstChunk := true
	lineOffset := 1

	for {
		buf := make([]byte, chunkSize)
		n, err := f.Read(buf)
		if n > 0 {
			totalRead += int64(n)
			combined := make([]byte, 0, len(tail)+n)
			combined = append(combined, tail...)
			combined = append(combined, buf[:n]...)

			minStart := len(tail)
			if firstChunk {
				minStart = 0
				firstChunk = false
			}

			text := string(combined)
			for _, pat := range patterns {
				if matchCount[pat.ID] >= pat.MaxMatchesPerFile {
					continue
				}
				idxs := pat.RE.FindAllStringIndex(text, -1)
				for _, idx := range idxs {
					// Boundary-spanning matches only — fully-in-tail were counted last chunk.
					if idx[1] <= minStart {
						continue
					}
					if matchCount[pat.ID] >= pat.MaxMatchesPerFile {
						break
					}
					match := text[idx[0]:idx[1]]
					if pat.NeedsLuhn && !LuhnValid(match) {
						continue
					}
					line := lineOffset + countNewlines(text[:idx[0]])
					sample := match
					if len(sample) > 64 {
						sample = sample[:64]
					}
					findings = append(findings, Finding{
						Path:      path,
						Line:      line,
						PatternID: pat.ID,
						Severity:  string(pat.Severity),
						Sample:    SanitizeSample(pat.ID, sample),
					})
					matchCount[pat.ID]++
				}
			}

			if len(combined) > overlapBytes {
				lineOffset += countNewlines(text[:len(combined)-overlapBytes])
				tail = append(tail[:0], combined[len(combined)-overlapBytes:]...)
			} else {
				tail = append(tail[:0], combined...)
			}
		}
		if err == nil {
			continue
		}
		if errors.Is(err, io.EOF) {
			break
		}
		break
	}
	if totalRead > maxSize {
		return nil, totalRead
	}
	return findings, totalRead
}

func countNewlines(s string) int {
	return strings.Count(s, "\n")
}
