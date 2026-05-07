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

func (n *Npm) UpdateCommand(pkg string) string    { return "npm update -g " + pkg }
func (n *Npm) UpgradeCommand() string              { return "npm update -g" }
func (n *Npm) InstallCommand(pkg string) string    { return "npm install -g " + pkg }
func (n *Npm) UninstallCommand(pkg string) string  { return "npm uninstall -g " + pkg }
