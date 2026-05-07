package packages

import (
	"os"
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

type Apk struct{}

func (a *Apk) Name() string { return "apk" }
func (a *Apk) IsAvailable() bool {
	if _, err := os.Stat(syspath.Apk()); err == nil {
		return true
	}
	return commandExists("apk")
}

func (a *Apk) ListInstalled() ([]Package, error) {
	out, err := exec.Command(syspath.Apk(), "list", "--installed").Output()
	if err != nil {
		return nil, err
	}
	var pkgs []Package
	for _, line := range splitLines(string(out)) {
		// Format: "package-name-1.2.3-r0 x86_64 {origin} (license)"
		parts := splitFields(line)
		if len(parts) < 1 {
			continue
		}
		// Split name and version at last dash before version number
		nameVer := parts[0]
		idx := strings.LastIndex(nameVer, "-")
		if idx <= 0 {
			continue
		}
		// Check if there's another dash (version has revision like -r0)
		name := nameVer[:idx]
		version := nameVer[idx+1:]
		if dashIdx := strings.LastIndex(name, "-"); dashIdx > 0 {
			// Could be name-version-revision
			name = nameVer[:dashIdx]
			version = nameVer[dashIdx+1:]
		}
		pkgs = append(pkgs, Package{Name: name, Version: version})
	}
	return pkgs, nil
}

func (a *Apk) UpdateCommand(pkg string) string    { return "apk update && apk upgrade " + pkg }
func (a *Apk) UpgradeCommand() string              { return "apk update && apk upgrade" }
func (a *Apk) InstallCommand(pkg string) string    { return "apk add " + pkg }
func (a *Apk) UninstallCommand(pkg string) string  { return "apk del " + pkg }
