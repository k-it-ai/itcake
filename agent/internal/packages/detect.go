package packages

import (
	"os"
	"os/exec"

	"github.com/itcake/agent/internal/commands"
)

func init() {
	// Ensure package manager detection uses the extended PATH
	// so brew, npm, pip etc. are found even when running as a system service
	os.Setenv("PATH", commands.ExtendedPath())
}

// DetectManagers returns all available package managers on this system.
// Order matters for UI dropdowns — we want the OS-native manager listed
// first when multiple are available.
func DetectManagers() []Manager {
	candidates := []Manager{
		&Apps{},
		&Apt{}, &Dnf{}, &Pacman{}, &Apk{},
		&Brew{}, &Npm{}, &Pip{},
	}
	// Append platform-specific managers (winget/choco/scoop on Windows,
	// nothing extra on Linux/macOS).
	candidates = append(candidates, detectExtra()...)

	var available []Manager
	for _, m := range candidates {
		if m.IsAvailable() {
			available = append(available, m)
		}
	}
	return available
}

// commandExists checks if a binary is in PATH.
func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}
