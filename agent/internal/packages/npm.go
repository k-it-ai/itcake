package packages

import (
	"encoding/json"
	"os/exec"

	"github.com/itcake/agent/internal/syspath"
)

type Npm struct{}

func (n *Npm) Name() string      { return "npm" }
func (n *Npm) IsAvailable() bool { return commandExists("npm") }

func (n *Npm) ListInstalled() ([]Package, error) {
	out, err := exec.Command(syspath.Npm(), "list", "-g", "--json", "--depth=0").Output()
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
