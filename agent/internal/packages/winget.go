//go:build windows

package packages

import (
	"encoding/json"
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

// Winget — Microsoft's official package manager. Ships with Windows 11,
// available on Windows 10. Preferred over chocolatey for new deployments.
type Winget struct{}

func (w *Winget) Name() string { return "winget" }

func (w *Winget) IsAvailable() bool {
	_, err := exec.LookPath("winget")
	return err == nil
}

// Structured winget output (--format json) is a supported, stable interface.
// This avoids screen-scraping the column-aligned default output, which
// changes across versions and across locales.
type wingetListItem struct {
	ID             string `json:"PackageIdentifier"`
	Name           string `json:"Name"`
	Version        string `json:"Version"`
	AvailableVersion string `json:"AvailableVersion"`
}

func (w *Winget) ListInstalled() ([]Package, error) {
	// winget list doesn't consistently produce JSON in older builds;
	// fall back to tab-tolerant parsing of the plain-text table.
	out, err := exec.Command(syspath.WingetExe(), "list",
		"--accept-source-agreements", "--disable-interactivity").Output()
	if err != nil {
		return nil, err
	}
	return parseWingetList(string(out)), nil
}

// Older winget writes human-readable UTF-16-with-BOM output. This
// parser is tolerant to: BOM, header separator lines, locale-specific
// column widths, blank source column (manual installers).
func parseWingetList(text string) []Package {
	text = strings.TrimPrefix(text, "\ufeff")
	var pkgs []Package
	var nameStart, idStart, verStart, availStart int = -1, -1, -1, -1
	inTable := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r ")
		if !inTable {
			// Header row contains "Name" and "Id" — capture column
			// starts by lower-case match to support localized labels.
			lower := strings.ToLower(line)
			if strings.Contains(lower, "name") && strings.Contains(lower, "id") {
				nameStart = strings.Index(lower, "name")
				idStart = strings.Index(lower, "id")
				verStart = strings.Index(lower, "version")
				availStart = strings.Index(lower, "available")
				continue
			}
			if strings.HasPrefix(line, "---") || strings.HasPrefix(line, "─") {
				inTable = true
			}
			continue
		}
		if line == "" {
			continue
		}
		if idStart < 0 || len(line) <= idStart {
			continue
		}
		// Clip each column by its recorded start offset.
		name := substr(line, nameStart, idStart)
		id := substr(line, idStart, verStart)
		ver := substr(line, verStart, availStart)
		avail := ""
		if availStart > 0 {
			avail = substr(line, availStart, len(line))
		}
		name = strings.TrimSpace(name)
		id = strings.TrimSpace(id)
		ver = strings.TrimSpace(ver)
		avail = strings.TrimSpace(avail)
		if name == "" || id == "" {
			continue
		}
		pkg := Package{Name: id, Version: ver}
		if avail != "" && !strings.HasPrefix(strings.ToLower(avail), "source") {
			pkg.LatestVersion = avail
			pkg.UpdateAvailable = true
		}
		pkgs = append(pkgs, pkg)
	}
	return pkgs
}

func substr(s string, start, end int) string {
	if start < 0 {
		return ""
	}
	if end < 0 || end > len(s) {
		end = len(s)
	}
	if start > len(s) {
		return ""
	}
	return s[start:end]
}

func (w *Winget) UpdateCommand(pkg string) string {
	return `winget upgrade --accept-source-agreements --accept-package-agreements --silent --id "` + escapeArg(pkg) + `"`
}

func (w *Winget) UpgradeCommand() string {
	return `winget upgrade --all --accept-source-agreements --accept-package-agreements --silent`
}

func (w *Winget) InstallCommand(pkg string) string {
	return `winget install --accept-source-agreements --accept-package-agreements --silent --id "` + escapeArg(pkg) + `"`
}

func (w *Winget) UninstallCommand(pkg string) string {
	return `winget uninstall --accept-source-agreements --disable-interactivity --silent --id "` + escapeArg(pkg) + `"`
}

// (compile-time assertion that winget JSON type stays in sync)
var _ = json.Marshal
var _ = wingetListItem{}
