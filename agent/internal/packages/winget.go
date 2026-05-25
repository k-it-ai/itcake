//go:build windows

package packages

import (
	"encoding/json"
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

type Winget struct{}

func (w *Winget) Name() string { return "winget" }

func (w *Winget) IsAvailable() bool {
	_, err := exec.LookPath("winget")
	return err == nil
}

type wingetListItem struct {
	ID             string `json:"PackageIdentifier"`
	Name           string `json:"Name"`
	Version        string `json:"Version"`
	AvailableVersion string `json:"AvailableVersion"`
}

func (w *Winget) ListInstalled() ([]Package, error) {
	// Older winget builds don't reliably emit JSON; parse the plain-text table.
	out, err := exec.Command(syspath.WingetExe(), "list",
		"--accept-source-agreements", "--disable-interactivity").Output()
	if err != nil {
		return nil, err
	}
	return parseWingetList(string(out)), nil
}

// parseWingetList tolerates BOM, locale-specific labels, and blank source columns.
func parseWingetList(text string) []Package {
	text = strings.TrimPrefix(text, "\ufeff")
	var pkgs []Package
	var nameStart, idStart, verStart, availStart int = -1, -1, -1, -1
	inTable := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r ")
		if !inTable {
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
	return `"` + syspath.WingetExe() + `" upgrade --accept-source-agreements --accept-package-agreements --silent --id "` + escapeArg(pkg) + `"`
}

func (w *Winget) UpgradeCommand() string {
	return `"` + syspath.WingetExe() + `" upgrade --all --accept-source-agreements --accept-package-agreements --silent`
}

func (w *Winget) InstallCommand(pkg string) string {
	return `"` + syspath.WingetExe() + `" install --accept-source-agreements --accept-package-agreements --silent --id "` + escapeArg(pkg) + `"`
}

func (w *Winget) UninstallCommand(pkg string) string {
	return `"` + syspath.WingetExe() + `" uninstall --accept-source-agreements --disable-interactivity --silent --id "` + escapeArg(pkg) + `"`
}

func (w *Winget) InstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: w.InstallCommand(pkg)}
}
func (w *Winget) UpdatePlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: w.UpdateCommand(pkg)}
}
func (w *Winget) UninstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: w.UninstallCommand(pkg)}
}
func (w *Winget) UpgradePlan() *ExecPlan {
	return &ExecPlan{ShellScript: w.UpgradeCommand()}
}

var _ = json.Marshal
var _ = wingetListItem{}
