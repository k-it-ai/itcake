package packages

import (
	"os"
	"os/exec"

	"github.com/itcake/agent/internal/commands"
)

func init() {
	os.Setenv("PATH", commands.ExtendedPath())
}

// DetectManagers returns all available package managers on this system.
// Order is OS-native first.
func DetectManagers() []Manager {
	candidates := []Manager{
		&Apps{},
		&Apt{}, &Dnf{}, &Pacman{}, &Apk{},
		&Brew{}, &Npm{}, &Pip{},
	}
	candidates = append(candidates, detectExtra()...)

	var available []Manager
	for _, m := range candidates {
		if m.IsAvailable() {
			available = append(available, m)
		}
	}
	return available
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}
