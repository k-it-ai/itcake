package packages

// Package represents a single installed package.
type Package struct {
	Name            string `json:"name"`
	Version         string `json:"version"`
	LatestVersion   string `json:"latestVersion"`
	UpdateAvailable bool   `json:"updateAvailable"`
}

// ExecPlan tells the dispatcher how to execute a package-manager operation.
// Argv form bypasses /bin/sh; ShellScript form is for multi-step pipelines
// (apt `update && install`). Exactly one of Argv/ShellScript is meaningful.
type ExecPlan struct {
	Binary      string
	Argv        []string
	ShellScript string
	AsRoot      bool
}

// IsArgv reports whether the plan should run via ExecuteArgv.
func (p *ExecPlan) IsArgv() bool { return p != nil && p.Argv != nil }

// IsEmpty reports whether the plan has nothing to execute.
func (p *ExecPlan) IsEmpty() bool {
	if p == nil {
		return true
	}
	if p.Argv != nil {
		return p.Binary == ""
	}
	return p.ShellScript == ""
}

// Manager is the interface for package managers. *Plan methods are the
// preferred dispatch surface; *Command methods are retained for callers
// that still want the raw shell-string form.
type Manager interface {
	Name() string
	IsAvailable() bool
	ListInstalled() ([]Package, error)

	UpdateCommand(pkg string) string
	UpgradeCommand() string
	InstallCommand(pkg string) string
	UninstallCommand(pkg string) string

	InstallPlan(pkg string) *ExecPlan
	UpdatePlan(pkg string) *ExecPlan
	UninstallPlan(pkg string) *ExecPlan
	UpgradePlan() *ExecPlan
}

// ArgvCapable is the legacy capability some managers expose. Prefer *Plan().
type ArgvCapable interface {
	InstallArgv(pkg string) (string, []string)
	UpdateArgv(pkg string) (string, []string)
	UninstallArgv(pkg string) (string, []string)
}
