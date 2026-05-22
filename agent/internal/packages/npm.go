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

// npmExec runs npm as the console user when the agent is running as root.
// npm typically lives in user-writable directories (Homebrew, ~/.nvm,
// /usr/local/bin via npm-global) — running it as root with PATH that
// includes those directories is a local-user → root LPE primitive
// (whoever owns /opt/homebrew/bin can plant `npm` and have it executed
// as root on the next inventory cycle).
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
		// npm list exits non-zero when packages have issues, but still outputs JSON
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

// InstallPlan / UpdatePlan / UninstallPlan: pkg flows as a separate
// argv element. ExecuteArgv handles the console-user drop on Unix,
// so we don't prepend `sudo -u` here ourselves.
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
