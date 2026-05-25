package packages

import (
	"os"
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

type Dnf struct{}

func (d *Dnf) Name() string { return "dnf" }
func (d *Dnf) IsAvailable() bool {
	if _, err := os.Stat(syspath.Dnf()); err == nil {
		return true
	}
	return commandExists("dnf")
}

func (d *Dnf) ListInstalled() ([]Package, error) {
	out, err := exec.Command(syspath.Dnf(), "list", "installed", "-q").Output()
	if err != nil {
		return nil, err
	}
	var pkgs []Package
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := splitFields(line)
		if len(parts) < 2 {
			continue
		}
		name := strings.Split(parts[0], ".")[0]
		pkgs = append(pkgs, Package{Name: name, Version: parts[1]})
	}
	return pkgs, nil
}

func (d *Dnf) InstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.Dnf(), Argv: []string{"install", "-y", pkg}, AsRoot: true}
}
func (d *Dnf) UpdatePlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.Dnf(), Argv: []string{"update", "-y", pkg}, AsRoot: true}
}
func (d *Dnf) UninstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.Dnf(), Argv: []string{"remove", "-y", pkg}, AsRoot: true}
}
func (d *Dnf) UpgradePlan() *ExecPlan {
	return &ExecPlan{Binary: syspath.Dnf(), Argv: []string{"upgrade", "-y"}, AsRoot: true}
}

func (d *Dnf) InstallCommand(pkg string) string   { return planToShell(d.InstallPlan(pkg)) }
func (d *Dnf) UpdateCommand(pkg string) string    { return planToShell(d.UpdatePlan(pkg)) }
func (d *Dnf) UninstallCommand(pkg string) string { return planToShell(d.UninstallPlan(pkg)) }
func (d *Dnf) UpgradeCommand() string             { return planToShell(d.UpgradePlan()) }

var _ ArgvCapable = (*Dnf)(nil)

func (d *Dnf) InstallArgv(pkg string) (string, []string) {
	p := d.InstallPlan(pkg)
	return p.Binary, p.Argv
}
func (d *Dnf) UpdateArgv(pkg string) (string, []string) {
	p := d.UpdatePlan(pkg)
	return p.Binary, p.Argv
}
func (d *Dnf) UninstallArgv(pkg string) (string, []string) {
	p := d.UninstallPlan(pkg)
	return p.Binary, p.Argv
}
