package packages

import (
	"os/exec"
	"strings"
)

type Apt struct{}

func (a *Apt) Name() string        { return "apt" }
func (a *Apt) IsAvailable() bool   { return commandExists("apt") && commandExists("dpkg") }

func (a *Apt) ListInstalled() ([]Package, error) {
	out, err := exec.Command("dpkg-query", "-W", "-f=${Package}\t${Version}\n").Output()
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

func (a *Apt) UpdateCommand(pkg string) string    { return "apt-get update && apt-get install -y " + pkg }
func (a *Apt) UpgradeCommand() string              { return "apt-get update && apt-get upgrade -y" }
func (a *Apt) InstallCommand(pkg string) string    { return "apt-get update && apt-get install -y " + pkg }
func (a *Apt) UninstallCommand(pkg string) string  { return "apt-get remove -y " + pkg }
