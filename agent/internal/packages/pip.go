package packages

import (
	"encoding/json"
	"os"
	"os/exec"

	"github.com/itcake/agent/internal/syspath"
)

type Pip struct{}

func (p *Pip) Name() string      { return "pip" }
func (p *Pip) IsAvailable() bool { return commandExists("pip3") || commandExists("pip") }

// pipBinary returns the syspath-pinned absolute pip path — defends against
// a planted pip3 earlier in PATH being executed as root.
func (p *Pip) pipBinary() string {
	if commandExists("pip3") {
		return syspath.Pip3()
	}
	return syspath.Pip()
}

// pipExec runs pip as the console user when root (same LPE concern as npm).
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

func (p *Pip) InstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: p.pipBinary(), Argv: []string{"install", pkg}}
}
func (p *Pip) UpdatePlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: p.pipBinary(), Argv: []string{"install", "--upgrade", pkg}}
}
func (p *Pip) UninstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: p.pipBinary(), Argv: []string{"uninstall", "-y", pkg}}
}

// UpgradePlan: pip lacks "upgrade all"; pipe list --outdated through python+xargs.
func (p *Pip) UpgradePlan() *ExecPlan {
	pip := p.pipBinary()
	script := pip + " list --outdated --format=json | " +
		syspath.Python3() + ` -c "import json,sys;[print(p['name']) for p in json.load(sys.stdin)]" | ` +
		syspath.Xargs() + " -n1 " + pip + " install -U"
	return &ExecPlan{ShellScript: script}
}

func (p *Pip) InstallCommand(pkg string) string   { return planToShell(p.InstallPlan(pkg)) }
func (p *Pip) UpdateCommand(pkg string) string    { return planToShell(p.UpdatePlan(pkg)) }
func (p *Pip) UninstallCommand(pkg string) string { return planToShell(p.UninstallPlan(pkg)) }
func (p *Pip) UpgradeCommand() string             { return planToShell(p.UpgradePlan()) }

var _ ArgvCapable = (*Pip)(nil)

func (p *Pip) InstallArgv(pkg string) (string, []string) {
	pl := p.InstallPlan(pkg)
	return pl.Binary, pl.Argv
}
func (p *Pip) UpdateArgv(pkg string) (string, []string) {
	pl := p.UpdatePlan(pkg)
	return pl.Binary, pl.Argv
}
func (p *Pip) UninstallArgv(pkg string) (string, []string) {
	pl := p.UninstallPlan(pkg)
	return pl.Binary, pl.Argv
}
