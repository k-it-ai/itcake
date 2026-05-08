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

// All command strings are built around `syspath.AptGet()` so the absolute
// path wins over an attacker-planted `apt-get` earlier in the agent's
// extended PATH (homebrew on macOS, $HOME/.local/bin on Linux). The same
// reasoning applies to every *Command builder in this package.
func (a *Apt) UpdateCommand(pkg string) string {
	return syspath.AptGet() + " update && " + syspath.AptGet() + " install -y " + pkg
}
func (a *Apt) UpgradeCommand() string {
	return syspath.AptGet() + " update && " + syspath.AptGet() + " upgrade -y"
}
func (a *Apt) InstallCommand(pkg string) string {
	return syspath.AptGet() + " update && " + syspath.AptGet() + " install -y " + pkg
}
func (a *Apt) UninstallCommand(pkg string) string {
	return syspath.AptGet() + " remove -y " + pkg
}
