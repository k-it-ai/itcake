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
		name := strings.Split(parts[0], ".")[0] // Remove arch suffix
		pkgs = append(pkgs, Package{Name: name, Version: parts[1]})
	}
	return pkgs, nil
}

func (d *Dnf) UpdateCommand(pkg string) string    { return syspath.Dnf() + " update -y " + pkg }
func (d *Dnf) UpgradeCommand() string              { return syspath.Dnf() + " upgrade -y" }
func (d *Dnf) InstallCommand(pkg string) string    { return syspath.Dnf() + " install -y " + pkg }
func (d *Dnf) UninstallCommand(pkg string) string  { return syspath.Dnf() + " remove -y " + pkg }
