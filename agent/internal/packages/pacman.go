package packages

import (
	"os"
	"os/exec"

	"github.com/itcake/agent/internal/syspath"
)

type Pacman struct{}

func (p *Pacman) Name() string { return "pacman" }
func (p *Pacman) IsAvailable() bool {
	if _, err := os.Stat(syspath.Pacman()); err == nil {
		return true
	}
	return commandExists("pacman")
}

func (p *Pacman) ListInstalled() ([]Package, error) {
	out, err := exec.Command(syspath.Pacman(), "-Q").Output()
	if err != nil {
		return nil, err
	}
	var pkgs []Package
	for _, line := range splitLines(string(out)) {
		parts := splitFields(line)
		if len(parts) < 2 {
			continue
		}
		pkgs = append(pkgs, Package{Name: parts[0], Version: parts[1]})
	}
	return pkgs, nil
}

// All pacman operations fit single argv calls.
func (p *Pacman) InstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.Pacman(), Argv: []string{"-S", "--noconfirm", pkg}, AsRoot: true}
}
func (p *Pacman) UpdatePlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.Pacman(), Argv: []string{"-Sy", "--noconfirm", pkg}, AsRoot: true}
}
func (p *Pacman) UninstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.Pacman(), Argv: []string{"-R", "--noconfirm", pkg}, AsRoot: true}
}
func (p *Pacman) UpgradePlan() *ExecPlan {
	return &ExecPlan{Binary: syspath.Pacman(), Argv: []string{"-Syu", "--noconfirm"}, AsRoot: true}
}

func (p *Pacman) InstallCommand(pkg string) string   { return planToShell(p.InstallPlan(pkg)) }
func (p *Pacman) UpdateCommand(pkg string) string    { return planToShell(p.UpdatePlan(pkg)) }
func (p *Pacman) UninstallCommand(pkg string) string { return planToShell(p.UninstallPlan(pkg)) }
func (p *Pacman) UpgradeCommand() string             { return planToShell(p.UpgradePlan()) }

var _ ArgvCapable = (*Pacman)(nil)

func (p *Pacman) InstallArgv(pkg string) (string, []string) {
	pl := p.InstallPlan(pkg)
	return pl.Binary, pl.Argv
}
func (p *Pacman) UpdateArgv(pkg string) (string, []string) {
	pl := p.UpdatePlan(pkg)
	return pl.Binary, pl.Argv
}
func (p *Pacman) UninstallArgv(pkg string) (string, []string) {
	pl := p.UninstallPlan(pkg)
	return pl.Binary, pl.Argv
}
