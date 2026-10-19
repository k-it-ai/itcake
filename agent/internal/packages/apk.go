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
		nameVer := parts[0]
		idx := strings.LastIndex(nameVer, "-")
		if idx <= 0 {
			continue
		}
		name := nameVer[:idx]
		version := nameVer[idx+1:]
		if dashIdx := strings.LastIndex(name, "-"); dashIdx > 0 {
			name = nameVer[:dashIdx]
			version = nameVer[dashIdx+1:]
		}
		pkgs = append(pkgs, Package{Name: name, Version: version})
	}
	return pkgs, nil
}

func (a *Apk) InstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.Apk(), Argv: []string{"add", pkg}, AsRoot: true}
}

// UpdatePlan chains `apk update && apk upgrade <pkg>`.
func (a *Apk) UpdatePlan(pkg string) *ExecPlan {
	script := syspath.Apk() + " update && " + syspath.Apk() + " upgrade " + shellQuote(pkg)
	return &ExecPlan{ShellScript: script, AsRoot: true}
}

func (a *Apk) UpgradePlan() *ExecPlan {
	script := syspath.Apk() + " update && " + syspath.Apk() + " upgrade"
	return &ExecPlan{ShellScript: script, AsRoot: true}
}

func (a *Apk) UninstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.Apk(), Argv: []string{"del", pkg}, AsRoot: true}
}

func (a *Apk) InstallCommand(pkg string) string   { return planToShell(a.InstallPlan(pkg)) }
func (a *Apk) UpdateCommand(pkg string) string    { return planToShell(a.UpdatePlan(pkg)) }
func (a *Apk) UninstallCommand(pkg string) string { return planToShell(a.UninstallPlan(pkg)) }
func (a *Apk) UpgradeCommand() string             { return planToShell(a.UpgradePlan()) }

var _ ArgvCapable = (*Apk)(nil)

func (a *Apk) InstallArgv(pkg string) (string, []string) {
	p := a.InstallPlan(pkg)
	return p.Binary, p.Argv
}
func (a *Apk) UpdateArgv(pkg string) (string, []string) { return "", nil }
func (a *Apk) UninstallArgv(pkg string) (string, []string) {
	p := a.UninstallPlan(pkg)
	return p.Binary, p.Argv
}
