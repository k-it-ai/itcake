//go:build windows

package packages

import (
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

// Scoop — per-user package manager for developer tooling. Refuses
// to run as admin/SYSTEM by design, so we only attempt it when the
// console user (= logged-in interactive user) is available and the
// agent is running in that context. In SYSTEM service mode, we skip
// scoop entirely — reporting inventory under a non-matching user
// would be misleading.
type Scoop struct{}

func (s *Scoop) Name() string { return "scoop" }

func (s *Scoop) IsAvailable() bool {
	// scoop is commonly a `.cmd` in the user's profile; check both
	// `scoop` and `scoop.cmd` to cover typical installs.
	for _, n := range []string{"scoop", "scoop.cmd"} {
		if _, err := exec.LookPath(n); err == nil {
			return true
		}
	}
	return false
}

func (s *Scoop) ListInstalled() ([]Package, error) {
	out, err := exec.Command(syspath.Scoop(), "list").Output()
	if err != nil {
		return nil, err
	}
	var pkgs []Package
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "Name") || strings.HasPrefix(line, "---") ||
			strings.HasPrefix(line, "Installed apps") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pkgs = append(pkgs, Package{Name: fields[0], Version: fields[1]})
	}
	return pkgs, nil
}

func (s *Scoop) UpdateCommand(pkg string) string {
	return `"` + syspath.Scoop() + `" update "` + escapeArg(pkg) + `"`
}
func (s *Scoop) UpgradeCommand() string {
	return `"` + syspath.Scoop() + `" update *`
}
func (s *Scoop) InstallCommand(pkg string) string {
	return `"` + syspath.Scoop() + `" install "` + escapeArg(pkg) + `"`
}
func (s *Scoop) UninstallCommand(pkg string) string {
	return `"` + syspath.Scoop() + `" uninstall "` + escapeArg(pkg) + `"`
}

func (s *Scoop) InstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: s.InstallCommand(pkg)}
}
func (s *Scoop) UpdatePlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: s.UpdateCommand(pkg)}
}
func (s *Scoop) UninstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: s.UninstallCommand(pkg)}
}
func (s *Scoop) UpgradePlan() *ExecPlan {
	return &ExecPlan{ShellScript: s.UpgradeCommand()}
}
