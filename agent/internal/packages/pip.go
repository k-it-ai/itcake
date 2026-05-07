package packages

import (
	"encoding/json"
	"os"
	"os/exec"

	"github.com/itcake/agent/internal/syspath"
)

type Pip struct{}

func (p *Pip) Name() string        { return "pip" }
func (p *Pip) IsAvailable() bool   { return commandExists("pip3") || commandExists("pip") }

func (p *Pip) pipCmd() string {
	if commandExists("pip3") {
		return "pip3"
	}
	return "pip"
}

// pipBinary returns the syspath-pinned absolute path for pip3 (preferred)
// or pip. Used for direct exec.Command calls. The shell-string command
// builders below keep the unqualified name so the user-PATH (extended
// to include user-installed pip prefixes) resolves correctly.
func (p *Pip) pipBinary() string {
	if commandExists("pip3") {
		return syspath.Pip3()
	}
	return syspath.Pip()
}

// pipExec runs pip as the console user when the agent is running as root.
// pip typically lives in user-writable directories — same LPE concern as npm.
func (p *Pip) pipExec(args ...string) ([]byte, error) {
	bin := p.pipBinary()
	user := ConsoleUser()
	if user != "" && os.Getuid() == 0 {
		sudoArgs := append([]string{"-u", user, "-H", "--non-interactive", bin}, args...)
		return exec.Command(syspath.Sudo(), sudoArgs...).Output()
	}
	return exec.Command(bin, args...).Output()
}

func (p *Pip) ListInstalled() ([]Package, error) {
	out, err := p.pipExec("list", "--format=json")
	if err != nil {
		return nil, err
	}
	var data []struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(out, &data); err != nil {
		return nil, err
	}
	var pkgs []Package
	for _, d := range data {
		pkgs = append(pkgs, Package{Name: d.Name, Version: d.Version})
	}
	return pkgs, nil
}

func (p *Pip) UpdateCommand(pkg string) string  { return p.pipCmd() + " install --upgrade " + pkg }
func (p *Pip) UpgradeCommand() string {
	return p.pipCmd() + " list --outdated --format=json | " + syspath.Python3() + " -c \"import json,sys;[print(p['name']) for p in json.load(sys.stdin)]\" | xargs -n1 " + p.pipCmd() + " install -U"
}
func (p *Pip) InstallCommand(pkg string) string    { return p.pipCmd() + " install " + pkg }
func (p *Pip) UninstallCommand(pkg string) string  { return p.pipCmd() + " uninstall -y " + pkg }
