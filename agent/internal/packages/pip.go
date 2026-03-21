package packages

import (
	"encoding/json"
	"os/exec"
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

func (p *Pip) ListInstalled() ([]Package, error) {
	out, err := exec.Command(p.pipCmd(), "list", "--format=json").Output()
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
func (p *Pip) UpgradeCommand() string            { return p.pipCmd() + " list --outdated --format=json | python3 -c \"import json,sys;[print(p['name']) for p in json.load(sys.stdin)]\" | xargs -n1 " + p.pipCmd() + " install -U" }
func (p *Pip) InstallCommand(pkg string) string    { return p.pipCmd() + " install " + pkg }
func (p *Pip) UninstallCommand(pkg string) string  { return p.pipCmd() + " uninstall -y " + pkg }
