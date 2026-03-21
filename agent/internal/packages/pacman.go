package packages

import "os/exec"

type Pacman struct{}

func (p *Pacman) Name() string        { return "pacman" }
func (p *Pacman) IsAvailable() bool   { return commandExists("pacman") }

func (p *Pacman) ListInstalled() ([]Package, error) {
	out, err := exec.Command("pacman", "-Q").Output()
	if err != nil {
		return nil, err
	}
	var pkgs []Package
	for _, line := range splitLines(string(out)) {
		parts := splitFields(line)
		if len(parts) < 2 {
			continue
		}
		pkgs = append(pkgs, Package{Name: parts[0], Version: parts[1]})
	}
	return pkgs, nil
}

func (p *Pacman) UpdateCommand(pkg string) string    { return "pacman -Sy --noconfirm " + pkg }
func (p *Pacman) UpgradeCommand() string              { return "pacman -Syu --noconfirm" }
func (p *Pacman) InstallCommand(pkg string) string    { return "pacman -S --noconfirm " + pkg }
func (p *Pacman) UninstallCommand(pkg string) string  { return "pacman -R --noconfirm " + pkg }
