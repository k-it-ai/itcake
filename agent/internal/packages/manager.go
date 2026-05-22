package packages

// Package represents a single installed package.
type Package struct {
	Name            string `json:"name"`
	Version         string `json:"version"`
	LatestVersion   string `json:"latestVersion"`
	UpdateAvailable bool   `json:"updateAvailable"`
}

// ExecPlan tells the dispatcher how to execute a package-manager
// operation. Argv-first form is preferred because pkg / user / home
// flow as separate argv elements — shell metacharacters cannot escape
// into /bin/sh -c. The ShellScript fallback is reserved for multi-step
// pipelines (apt `update && install`, brew uninstall cleanup) that
// don't fit a single exec.Command call.
//
// Exactly one of (Argv, ShellScript) is meaningful — when Argv is
// non-nil the caller runs ExecuteArgv(Binary, Argv, ...); when Argv
// is nil the caller runs Execute(ShellScript, ...). AsRoot picks
// between the ...AsRoot variants for either form.
type ExecPlan struct {
	Binary      string
	Argv        []string
	ShellScript string
	AsRoot      bool
}

// IsArgv reports whether the plan should run through ExecuteArgv
// instead of Execute (shell-string).
func (p *ExecPlan) IsArgv() bool { return p != nil && p.Argv != nil }

// IsEmpty reports whether the plan has nothing to execute — used by
// the dispatcher to fall through to the next package manager.
func (p *ExecPlan) IsEmpty() bool {
	if p == nil {
		return true
	}
	if p.Argv != nil {
		return p.Binary == ""
	}
	return p.ShellScript == ""
}

// Manager is the interface for package managers.
//
// The *Plan methods are the preferred dispatch surface — they return
// an ExecPlan that the caller hands to ExecuteArgv / Execute. The
// *Command methods are retained for backward compatibility with
// callers / tests that still want the raw shell-string form; new
// callers should prefer the *Plan variants.
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

// ArgvCapable is the historical optional capability some managers
// implemented before the ExecPlan refactor. New callers should consume
// *Plan() instead — those return the same (binary, argv) pair plus the
// AsRoot flag in one shot. Kept here so external compile-time assertions
// (`var _ ArgvCapable = (*Npm)(nil)`) and any out-of-tree code still
// works during migration.
type ArgvCapable interface {
	InstallArgv(pkg string) (string, []string)
	UpdateArgv(pkg string) (string, []string)
	UninstallArgv(pkg string) (string, []string)
}
