package packages

// Package represents a single installed package.
type Package struct {
	Name            string `json:"name"`
	Version         string `json:"version"`
	LatestVersion   string `json:"latestVersion"`
	UpdateAvailable bool   `json:"updateAvailable"`
}

// Manager is the interface for package managers.
type Manager interface {
	Name() string
	IsAvailable() bool
	ListInstalled() ([]Package, error)
	UpdateCommand(pkg string) string
	UpgradeCommand() string
	InstallCommand(pkg string) string
	UninstallCommand(pkg string) string
}
