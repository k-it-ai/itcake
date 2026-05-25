//go:build windows

package packages

import (
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

type Choco struct{}

func (c *Choco) Name() string { return "choco" }

func (c *Choco) IsAvailable() bool {
	_, err := exec.LookPath("choco")
	return err == nil
}

func (c *Choco) ListInstalled() ([]Package, error) {
	chocoBin := syspath.Choco()
	out, err := exec.Command(chocoBin, "list", "--localonly",
		"--limit-output", "--no-color").Output()
	if err != nil {
		// Newer choco removed --localonly alias for "list".
		out, err = exec.Command(chocoBin, "list", "--limit-output", "--no-color").Output()
		if err != nil {
			return nil, err
		}
	}
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
	return `"` + syspath.Choco() + `" upgrade "` + escapeArg(pkg) + `" -y --no-progress`
}
func (c *Choco) UpgradeCommand() string {
	return `"` + syspath.Choco() + `" upgrade all -y --no-progress`
}
func (c *Choco) InstallCommand(pkg string) string {
	return `"` + syspath.Choco() + `" install "` + escapeArg(pkg) + `" -y --no-progress`
}
func (c *Choco) UninstallCommand(pkg string) string {
	// -x removes leftovers; --remove-dependencies omitted so shared runtimes survive.
	return `"` + syspath.Choco() + `" uninstall "` + escapeArg(pkg) + `" -y --no-progress -x`
}

func (c *Choco) InstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: c.InstallCommand(pkg)}
}
func (c *Choco) UpdatePlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: c.UpdateCommand(pkg)}
}
func (c *Choco) UninstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: c.UninstallCommand(pkg)}
}
func (c *Choco) UpgradePlan() *ExecPlan {
	return &ExecPlan{ShellScript: c.UpgradeCommand()}
}
