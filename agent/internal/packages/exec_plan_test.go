package packages

import (
	"strings"
	"testing"

	"github.com/itcake/agent/internal/syspath"
)

// Shell metacharacters that must NEVER appear inside an argv element.
// If pkg contained any of these and Argv concatenated it into a shell
// string instead of passing as a separate argv item, the server-side
// validator would be the last line of defense — the whole point of
// this refactor is to make argv the FIRST line of defense.
var shellMetaChars = []string{";", "|", "&", "`", "$", ">", "<", "\n", "\r", "\\"}

func argvContainsShellMetas(argv []string) (string, bool) {
	for _, a := range argv {
		for _, m := range shellMetaChars {
			if strings.Contains(a, m) {
				return a, true
			}
		}
	}
	return "", false
}

// All argv-form managers MUST source Binary through the syspath helpers.
// On a fully-provisioned host that resolves to an absolute path; on a
// CI box without the binary installed, syspath falls back to the bare
// name (with a one-time stderr warning) — that's by design and is
// acceptable defense-in-depth posture. The test accepts both as long
// as the value matches what syspath returns for that tool.
func assertBinaryFromSyspath(t *testing.T, label, got, expected string) {
	t.Helper()
	if got == "" {
		t.Errorf("%s: empty Binary on Argv plan", label)
		return
	}
	if got != expected {
		t.Errorf("%s: Binary %q != syspath value %q", label, got, expected)
		return
	}
	// When syspath did resolve to an absolute path, sanity-check the
	// shape. When it fell back to a bare name (no `/`), the warnOnce
	// in syspath.go has already documented the degraded posture.
	if strings.Contains(got, "/") && !strings.HasPrefix(got, "/") {
		t.Errorf("%s: Binary %q is path-relative — syspath must return absolute or bare name", label, got)
	}
}

func assertArgvSafe(t *testing.T, label string, plan *ExecPlan, expectedBinary string) {
	t.Helper()
	if plan == nil {
		t.Errorf("%s: nil plan", label)
		return
	}
	if !plan.IsArgv() {
		return // ShellScript form — tested separately
	}
	assertBinaryFromSyspath(t, label, plan.Binary, expectedBinary)
	if bad, ok := argvContainsShellMetas(plan.Argv); ok {
		t.Errorf("%s: argv element %q contains shell metacharacter", label, bad)
	}
}

func TestExecPlan_Npm_AllOpsAreArgv(t *testing.T) {
	n := &Npm{}
	cases := []struct {
		label string
		plan  *ExecPlan
	}{
		{"npm install", n.InstallPlan("react")},
		{"npm update", n.UpdatePlan("react")},
		{"npm uninstall", n.UninstallPlan("react")},
		{"npm upgrade", n.UpgradePlan()},
	}
	for _, c := range cases {
		if !c.plan.IsArgv() {
			t.Errorf("%s: expected Argv form, got ShellScript=%q", c.label, c.plan.ShellScript)
			continue
		}
		assertArgvSafe(t, c.label, c.plan, syspath.Npm())
	}
}

func TestExecPlan_Npm_NoSudoPrefixInArgv(t *testing.T) {
	// ExecuteArgv handles the console-user drop on Unix. If a manager
	// snuck `sudo -u user` into the argv slice, the executor would
	// double-wrap (`sudo -u user sudo -u user npm ...`), which works
	// by accident but is brittle. Enforce: no manager argv starts with
	// the sudo binary.
	for _, plan := range []*ExecPlan{
		(&Npm{}).InstallPlan("react"),
		(&Pip{}).InstallPlan("requests"),
		(&Brew{}).InstallPlan("htop"),
	} {
		if !plan.IsArgv() {
			continue
		}
		if strings.HasSuffix(plan.Binary, "/sudo") || plan.Binary == "sudo" {
			t.Errorf("plan Binary is sudo (%q) — argv-based dispatch already handles privilege drop", plan.Binary)
		}
	}
}

func TestExecPlan_Pip_AllSinglePkgOpsAreArgv(t *testing.T) {
	p := &Pip{}
	expected := p.pipBinary()
	cases := []struct {
		label string
		plan  *ExecPlan
	}{
		{"pip install", p.InstallPlan("requests")},
		{"pip update", p.UpdatePlan("requests")},
		{"pip uninstall", p.UninstallPlan("requests")},
	}
	for _, c := range cases {
		if !c.plan.IsArgv() {
			t.Errorf("%s: expected Argv form, got ShellScript=%q", c.label, c.plan.ShellScript)
			continue
		}
		assertArgvSafe(t, c.label, c.plan, expected)
	}
	// UpgradePlan uses a python+xargs pipeline — ShellScript form is OK.
	up := p.UpgradePlan()
	if up.IsArgv() {
		t.Errorf("pip upgrade: expected ShellScript form (xargs pipeline), got Argv")
	}
	if up.ShellScript == "" {
		t.Error("pip upgrade: ShellScript is empty")
	}
}

func TestExecPlan_Brew_InstallUpdateAreArgv(t *testing.T) {
	b := &Brew{}
	expected := brewPath()
	for _, c := range []struct {
		label string
		plan  *ExecPlan
	}{
		{"brew install", b.InstallPlan("htop")},
		{"brew update", b.UpdatePlan("htop")},
	} {
		if !c.plan.IsArgv() {
			t.Errorf("%s: expected Argv form, got ShellScript=%q", c.label, c.plan.ShellScript)
			continue
		}
		assertArgvSafe(t, c.label, c.plan, expected)
	}
}

func TestExecPlan_Brew_UninstallIsShellScript(t *testing.T) {
	// The brew uninstall pipeline does multi-step bash cleanup
	// (PlistBuddy + find loops with sudo -u drops). It can't fit a
	// single argv call. Confirm: Argv == nil, ShellScript populated.
	plan := (&Brew{}).UninstallPlan("htop")
	if plan.Argv != nil {
		t.Errorf("brew uninstall: expected Argv == nil (script form), got %v", plan.Argv)
	}
	if plan.ShellScript == "" {
		t.Error("brew uninstall: ShellScript is empty")
	}
	// pkg must be single-quoted in the script so an injected ';' or '`'
	// (after a future validator relaxation) can't escape the surrounding
	// shell context. The pkg literal we passed contains no metas, but
	// the script SHOULD contain the literal `'htop'` (single-quoted) as
	// the PKG bash variable assignment.
	if !strings.Contains(plan.ShellScript, "PKG='htop'") {
		t.Error("brew uninstall: expected `PKG='htop'` in ShellScript (pkg must flow shell-quoted)")
	}
}

func TestExecPlan_Brew_UninstallHandlesShellMetaPkgSafely(t *testing.T) {
	// Even with a malicious-looking pkg field (which ValidatePackageName
	// rejects upstream), shellQuote MUST single-quote so the script's
	// surrounding bash context can't be broken out of. This is the
	// defense-in-depth property the whole refactor is for.
	plan := (&Brew{}).UninstallPlan("evil'; reboot;'#")
	if plan.Argv != nil {
		t.Fatal("brew uninstall: expected ShellScript form")
	}
	// Look for the literal token sequence shellQuote produces for
	// `evil'; reboot;'#`: closes the quote, escapes the embedded
	// quote, reopens — yielding `'evil'\''; reboot;'\''#'`.
	if !strings.Contains(plan.ShellScript, `'evil'\''; reboot;'\''#'`) {
		t.Errorf("brew uninstall: pkg not shell-quoted as expected; ShellScript=%q", plan.ShellScript)
	}
}

func TestExecPlan_Apt_InstallUpdateAreShellScript(t *testing.T) {
	// apt-get install/update chain `apt-get update && apt-get install`,
	// so they're inherently shell-script form. Uninstall is a single
	// call, which CAN be argv.
	a := &Apt{}
	for _, c := range []struct {
		label string
		plan  *ExecPlan
	}{
		{"apt install", a.InstallPlan("htop")},
		{"apt update", a.UpdatePlan("htop")},
		{"apt upgrade", a.UpgradePlan()},
	} {
		if c.plan.IsArgv() {
			t.Errorf("%s: expected ShellScript form (chains apt-get update + install), got Argv=%v", c.label, c.plan.Argv)
		}
		if c.plan.ShellScript == "" {
			t.Errorf("%s: ShellScript empty", c.label)
		}
		if !c.plan.AsRoot {
			t.Errorf("%s: AsRoot must be true (apt requires root, agent runs as root on Linux)", c.label)
		}
	}
	un := a.UninstallPlan("htop")
	if !un.IsArgv() {
		t.Errorf("apt uninstall: expected Argv form, got ShellScript=%q", un.ShellScript)
	}
	assertArgvSafe(t, "apt uninstall", un, syspath.AptGet())
}

func TestExecPlan_Dnf_AllOpsAreArgv(t *testing.T) {
	d := &Dnf{}
	expected := syspath.Dnf()
	for _, c := range []struct {
		label string
		plan  *ExecPlan
	}{
		{"dnf install", d.InstallPlan("htop")},
		{"dnf update", d.UpdatePlan("htop")},
		{"dnf uninstall", d.UninstallPlan("htop")},
		{"dnf upgrade", d.UpgradePlan()},
	} {
		if !c.plan.IsArgv() {
			t.Errorf("%s: expected Argv form, got ShellScript=%q", c.label, c.plan.ShellScript)
			continue
		}
		assertArgvSafe(t, c.label, c.plan, expected)
		if !c.plan.AsRoot {
			t.Errorf("%s: AsRoot must be true", c.label)
		}
	}
}

func TestExecPlan_Pacman_AllOpsAreArgv(t *testing.T) {
	p := &Pacman{}
	expected := syspath.Pacman()
	for _, c := range []struct {
		label string
		plan  *ExecPlan
	}{
		{"pacman install", p.InstallPlan("htop")},
		{"pacman update", p.UpdatePlan("htop")},
		{"pacman uninstall", p.UninstallPlan("htop")},
		{"pacman upgrade", p.UpgradePlan()},
	} {
		if !c.plan.IsArgv() {
			t.Errorf("%s: expected Argv form, got ShellScript=%q", c.label, c.plan.ShellScript)
			continue
		}
		assertArgvSafe(t, c.label, c.plan, expected)
	}
}

func TestExecPlan_Apk_SinglePkgOpsAreArgv(t *testing.T) {
	a := &Apk{}
	expected := syspath.Apk()
	for _, c := range []struct {
		label string
		plan  *ExecPlan
	}{
		{"apk install", a.InstallPlan("htop")},
		{"apk uninstall", a.UninstallPlan("htop")},
	} {
		if !c.plan.IsArgv() {
			t.Errorf("%s: expected Argv form, got ShellScript=%q", c.label, c.plan.ShellScript)
			continue
		}
		assertArgvSafe(t, c.label, c.plan, expected)
	}
	// apk update chains `apk update && apk upgrade <pkg>` — ShellScript form.
	up := a.UpdatePlan("htop")
	if up.IsArgv() {
		t.Errorf("apk update: expected ShellScript form (chains update + upgrade), got Argv=%v", up.Argv)
	}
	ug := a.UpgradePlan()
	if ug.IsArgv() {
		t.Errorf("apk upgrade: expected ShellScript form (chains update + upgrade-all), got Argv=%v", ug.Argv)
	}
}

func TestExecPlan_ArgvBinariesGoThroughSyspath(t *testing.T) {
	// Iterate the cross-platform manager set and confirm every Argv
	// plan's Binary matches the syspath helper for that manager. This
	// guards against a future commit that swaps `syspath.Npm()` for
	// bare `"npm"` (or any literal string) inside a manager.
	cases := []struct {
		mgr      Manager
		expected string
	}{
		{&Npm{}, syspath.Npm()},
		{&Pip{}, (&Pip{}).pipBinary()},
		{&Brew{}, brewPath()},
		{&Apt{}, syspath.AptGet()},
		{&Dnf{}, syspath.Dnf()},
		{&Pacman{}, syspath.Pacman()},
		{&Apk{}, syspath.Apk()},
	}
	for _, c := range cases {
		for _, plan := range []struct {
			label string
			p     *ExecPlan
		}{
			{c.mgr.Name() + " install", c.mgr.InstallPlan("htop")},
			{c.mgr.Name() + " update", c.mgr.UpdatePlan("htop")},
			{c.mgr.Name() + " uninstall", c.mgr.UninstallPlan("htop")},
			{c.mgr.Name() + " upgrade", c.mgr.UpgradePlan()},
		} {
			assertArgvSafe(t, plan.label, plan.p, c.expected)
		}
	}
}

func TestExecPlan_IsEmpty(t *testing.T) {
	cases := []struct {
		label string
		plan  *ExecPlan
		empty bool
	}{
		{"nil plan", nil, true},
		{"empty struct", &ExecPlan{}, true},
		{"argv ok", &ExecPlan{Binary: "/usr/bin/x", Argv: []string{"a"}}, false},
		{"argv no binary", &ExecPlan{Argv: []string{"a"}}, true},
		{"script ok", &ExecPlan{ShellScript: "echo hi"}, false},
	}
	for _, c := range cases {
		if got := c.plan.IsEmpty(); got != c.empty {
			t.Errorf("%s: IsEmpty()=%v, want %v", c.label, got, c.empty)
		}
	}
}

func TestExecPlan_PlanToShellRoundtrip(t *testing.T) {
	// For argv-form plans, planToShell must produce a shell-quoted
	// concatenation. Even with a metacharacter-laden arg, the quoting
	// must keep it inside the single-quoted span so /bin/sh -c can't
	// interpret it.
	plan := &ExecPlan{Binary: "/usr/local/bin/npm", Argv: []string{"install", "-g", "evil'; reboot;'"}}
	got := planToShell(plan)
	want := `'/usr/local/bin/npm' 'install' '-g' 'evil'\''; reboot;'\'''`
	if got != want {
		t.Errorf("planToShell:\n got  %q\n want %q", got, want)
	}
}

func TestExecPlan_PlanToShellPassesScriptThrough(t *testing.T) {
	plan := &ExecPlan{ShellScript: "echo hi && echo bye"}
	got := planToShell(plan)
	if got != "echo hi && echo bye" {
		t.Errorf("planToShell pass-through: got %q", got)
	}
}

// Sanity: every Manager satisfies the new Manager interface (the *Plan
// methods are now part of the interface, so a missing method would
// fail compilation). Listed here so a future contributor can grep
// "Manager interface" and find the comprehensive set.
var (
	_ Manager = (*Npm)(nil)
	_ Manager = (*Pip)(nil)
	_ Manager = (*Brew)(nil)
	_ Manager = (*Apt)(nil)
	_ Manager = (*Dnf)(nil)
	_ Manager = (*Pacman)(nil)
	_ Manager = (*Apk)(nil)
)
