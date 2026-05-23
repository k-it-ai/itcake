package packages

// Apps is a no-op on Linux (no /Applications directory).
type Apps struct{}

func (a *Apps) Name() string                      { return "apps" }
func (a *Apps) IsAvailable() bool                 { return false }
func (a *Apps) ListInstalled() ([]Package, error) { return nil, nil }

func (a *Apps) InstallPlan(pkg string) *ExecPlan   { return &ExecPlan{} }
func (a *Apps) UpdatePlan(pkg string) *ExecPlan    { return &ExecPlan{} }
func (a *Apps) UninstallPlan(pkg string) *ExecPlan { return &ExecPlan{} }
func (a *Apps) UpgradePlan() *ExecPlan             { return &ExecPlan{} }

func (a *Apps) UpdateCommand(pkg string) string    { return "" }
func (a *Apps) UpgradeCommand() string             { return "" }
func (a *Apps) InstallCommand(pkg string) string   { return "" }
func (a *Apps) UninstallCommand(pkg string) string { return "" }
