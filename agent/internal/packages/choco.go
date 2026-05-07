//go:build windows

package packages

import (
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

// Chocolatey — community Windows package manager, very common on
// SMB/dev machines. Runs in elevated mode by default (service context
// is already SYSTEM for us).
type Choco struct{}

func (c *Choco) Name() string { return "choco" }

func (c *Choco) IsAvailable() bool {
	_, err := exec.LookPath("choco")
	return err == nil
}

func (c *Choco) ListInstalled() ([]Package, error) {
	chocoBin := syspath.Choco()
	// Pipe form: `choco list --localonly --limit-output --no-color` gives
	// `name|version` lines — stable, locale-independent, no banner.
	out, err := exec.Command(chocoBin, "list", "--localonly",
		"--limit-output", "--no-color").Output()
	if err != nil {
		// Newer choco removed --localonly alias for "list" itself.
		out, err = exec.Command(chocoBin, "list", "--limit-output", "--no-color").Output()
		if err != nil {
			return nil, err
		}
	}
	// outdated once for update-available flags
	outdated := map[string]string{}
	if od, err := exec.Command(chocoBin, "outdated",
		"--limit-output", "--no-color").Output(); err == nil {
		for _, line := range strings.Split(string(od), "\n") {
			parts := strings.Split(strings.TrimSpace(line), "|")
			if len(parts) >= 3 {
				outdated[strings.ToLower(parts[0])] = parts[2]
			}
		}
	}
	var pkgs []Package
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 2 {
			continue
		}
		p := Package{Name: parts[0], Version: parts[1]}
		if latest, ok := outdated[strings.ToLower(parts[0])]; ok {
			p.LatestVersion = latest
			p.UpdateAvailable = true
		}
		pkgs = append(pkgs, p)
	}
	return pkgs, nil
}

func (c *Choco) UpdateCommand(pkg string) string {
	return `choco upgrade "` + escapeArg(pkg) + `" -y --no-progress`
}
func (c *Choco) UpgradeCommand() string {
	return `choco upgrade all -y --no-progress`
}
func (c *Choco) InstallCommand(pkg string) string {
	return `choco install "` + escapeArg(pkg) + `" -y --no-progress`
}
func (c *Choco) UninstallCommand(pkg string) string {
	// -x removes leftovers; -y suppresses confirmation; --remove-dependencies
	// is omitted so we don't cascade-delete shared runtimes.
	return `choco uninstall "` + escapeArg(pkg) + `" -y --no-progress -x`
}
