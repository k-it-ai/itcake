package packages

import (
	"encoding/json"
	"os"
	"os/exec"

	"github.com/itcake/agent/internal/syspath"
)

type Npm struct{}

func (n *Npm) Name() string      { return "npm" }
func (n *Npm) IsAvailable() bool { return commandExists("npm") }

// npmExec runs npm as the console user when root — npm lives in
// user-writable dirs (brew, ~/.nvm), so running it as root is a LPE primitive.
func npmExec(args ...string) ([]byte, error) {
	bin := syspath.Npm()
	user := ConsoleUser()
	if user != "" && os.Getuid() == 0 {
		sudoArgs := append([]string{"-u", user, "-H", "--non-interactive", bin}, args...)
		return exec.Command(syspath.Sudo(), sudoArgs...).Output()
	}
	return exec.Command(bin, args...).Output()
}

func (n *Npm) ListInstalled() ([]Package, error) {
	out, err := npmExec("list", "-g", "--json", "--depth=0")
	if err != nil {
		// npm list exits non-zero on dep issues but still outputs JSON.
		if len(out) == 0 {
			return nil, err
		}
	}
	var data struct {
		Dependencies map[string]struct {
			Version string `json:"version"`
		} `json:"dependencies"`
	}
	if err := json.Unmarshal(out, &data); err != nil {
		return nil, err
	}
	var pkgs []Package
	for name, dep := range data.Dependencies {
		pkgs = append(pkgs, Package{Name: name, Version: dep.Version})
	}
	return pkgs, nil
}

func (n *Npm) InstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.Npm(), Argv: []string{"install", "-g", pkg}}
}
func (n *Npm) UpdatePlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.Npm(), Argv: []string{"update", "-g", pkg}}
}
func (n *Npm) UninstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: syspath.Npm(), Argv: []string{"uninstall", "-g", pkg}}
}
func (n *Npm) UpgradePlan() *ExecPlan {
	return &ExecPlan{Binary: syspath.Npm(), Argv: []string{"update", "-g"}}
}

func (n *Npm) UpdateCommand(pkg string) string    { return planToShell(n.UpdatePlan(pkg)) }
func (n *Npm) UpgradeCommand() string             { return planToShell(n.UpgradePlan()) }
func (n *Npm) InstallCommand(pkg string) string   { return planToShell(n.InstallPlan(pkg)) }
func (n *Npm) UninstallCommand(pkg string) string { return planToShell(n.UninstallPlan(pkg)) }

var _ ArgvCapable = (*Npm)(nil)

func (n *Npm) InstallArgv(pkg string) (string, []string) {
	p := n.InstallPlan(pkg)
	return p.Binary, p.Argv
}
func (n *Npm) UpdateArgv(pkg string) (string, []string) {
	p := n.UpdatePlan(pkg)
	return p.Binary, p.Argv
}
func (n *Npm) UninstallArgv(pkg string) (string, []string) {
	p := n.UninstallPlan(pkg)
	return p.Binary, p.Argv
}
