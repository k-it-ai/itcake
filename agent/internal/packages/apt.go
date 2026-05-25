package packages

import (
	"os"
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

type Apt struct{}

func (a *Apt) Name() string { return "apt" }
func (a *Apt) IsAvailable() bool {
	if _, err := os.Stat(syspath.Apt()); err == nil {
		if _, err := os.Stat(syspath.Dpkg()); err == nil {
			return true
		}
	}
	return commandExists("apt") && commandExists("dpkg")
}

func (a *Apt) ListInstalled() ([]Package, error) {
	out, err := exec.Command(syspath.DpkgQuery(), "-W", "-f=${Package}\t${Version}\n").Output()
	if err != nil {
		return nil, err
	}
	var pkgs []Package
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) < 2 {
			continue
		}
		pkgs = append(pkgs, Package{Name: parts[0], Version: parts[1]})
	}
	return pkgs, nil
}

// InstallPlan/UpdatePlan chain `apt-get update && apt-get install` so they
// must be ShellScript. pkg is shellQuote'd to neutralise validator drift.
func (a *Apt) InstallPlan(pkg string) *ExecPlan {
	script := syspath.AptGet() + " update && " + syspath.AptGet() + " install -y " + shellQuote(pkg)
	return &ExecPlan{ShellScript: script, AsRoot: true}
}
func (a *Apt) UpdatePlan(pkg string) *ExecPlan {
	script := syspath.AptGet() + " update && " + syspath.AptGet() + " install -y " + shellQuote(pkg)
	return &ExecPlan{ShellScript: script, AsRoot: true}
}
func (a *Apt) UpgradePlan() *ExecPlan {
	script := syspath.AptGet() + " update && " + syspath.AptGet() + " upgrade -y"
	return &ExecPlan{ShellScript: script, AsRoot: true}
}

func (a *Apt) UninstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.AptGet(), Argv: []string{"remove", "-y", pkg}, AsRoot: true}
}

func (a *Apt) InstallCommand(pkg string) string   { return planToShell(a.InstallPlan(pkg)) }
func (a *Apt) UpdateCommand(pkg string) string    { return planToShell(a.UpdatePlan(pkg)) }
func (a *Apt) UninstallCommand(pkg string) string { return planToShell(a.UninstallPlan(pkg)) }
func (a *Apt) UpgradeCommand() string             { return planToShell(a.UpgradePlan()) }

var _ ArgvCapable = (*Apt)(nil)

func (a *Apt) UninstallArgv(pkg string) (string, []string) {
	p := a.UninstallPlan(pkg)
	return p.Binary, p.Argv
}
func (a *Apt) InstallArgv(pkg string) (string, []string) { return "", nil }
func (a *Apt) UpdateArgv(pkg string) (string, []string)  { return "", nil }
