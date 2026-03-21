package packages

import (
	"os/exec"
	"strings"
)

type Dnf struct{}

func (d *Dnf) Name() string        { return "dnf" }
func (d *Dnf) IsAvailable() bool   { return commandExists("dnf") }

func (d *Dnf) ListInstalled() ([]Package, error) {
	out, err := exec.Command("dnf", "list", "installed", "-q").Output()
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

func (d *Dnf) UpdateCommand(pkg string) string    { return "dnf update -y " + pkg }
func (d *Dnf) UpgradeCommand() string              { return "dnf upgrade -y" }
func (d *Dnf) InstallCommand(pkg string) string    { return "dnf install -y " + pkg }
func (d *Dnf) UninstallCommand(pkg string) string  { return "dnf remove -y " + pkg }
