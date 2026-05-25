//go:build windows

package packages

import (
	"strings"

	"golang.org/x/sys/windows/registry"

	"github.com/itcake/agent/internal/syspath"
)

// Apps enumerates installed Windows applications from the standard
// uninstall registry locations. Uninstall invokes the registered
// UninstallString (or QuietUninstallString).
type Apps struct{}

func (a *Apps) Name() string { return "apps" }

func (a *Apps) IsAvailable() bool { return true }

var uninstallRoots = []struct {
	root registry.Key
	path string
}{
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`},
	{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`},
	{registry.CURRENT_USER, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`},
}

func (a *Apps) ListInstalled() ([]Package, error) {
	seen := make(map[string]struct{})
	var pkgs []Package

	for _, r := range uninstallRoots {
		k, err := registry.OpenKey(r.root, r.path, registry.READ|registry.ENUMERATE_SUB_KEYS)
		if err != nil {
			continue
		}
		names, err := k.ReadSubKeyNames(-1)
		_ = k.Close()
		if err != nil {
			continue
		}
		for _, sub := range names {
			full := r.path + `\` + sub
			sk, err := registry.OpenKey(r.root, full, registry.READ)
			if err != nil {
				continue
			}
			display, _, _ := sk.GetStringValue("DisplayName")
			version, _, _ := sk.GetStringValue("DisplayVersion")
			systemComponent, _, _ := sk.GetIntegerValue("SystemComponent")
			parent, _, _ := sk.GetStringValue("ParentDisplayName")
			_ = sk.Close()

			if display == "" || systemComponent == 1 || parent != "" {
				continue
			}
			if _, dup := seen[display]; dup {
				continue
			}
			seen[display] = struct{}{}
			pkgs = append(pkgs, Package{Name: display, Version: version})
		}
	}
	return pkgs, nil
}

// UpdateCommand delegates to winget — Programs & Features has no per-app update.
func (a *Apps) UpdateCommand(pkg string) string {
	return `"` + syspath.WingetExe() + `" upgrade --accept-source-agreements --accept-package-agreements --silent --name "` + escapeArg(pkg) + `"`
}

func (a *Apps) UpgradeCommand() string {
	return `"` + syspath.WingetExe() + `" upgrade --all --accept-source-agreements --accept-package-agreements --silent`
}

func (a *Apps) InstallCommand(pkg string) string {
	return `"` + syspath.WingetExe() + `" install --accept-source-agreements --accept-package-agreements --silent --name "` + escapeArg(pkg) + `"`
}

// UninstallCommand looks up the app's UninstallString in the registry and
// invokes it via PowerShell to combine quiet flags per installer technology.
func (a *Apps) UninstallCommand(pkg string) string {
	return `"` + syspath.PowerShell() + `" -NoProfile -NonInteractive -Command "` +
		`$names = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',` +
		`'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',` +
		`'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); ` +
		`$hit = $null; foreach ($p in $names) { if (Test-Path $p) { ` +
		`Get-ChildItem $p | ForEach-Object { $v = Get-ItemProperty $_.PsPath; ` +
		`if ($v.DisplayName -eq '` + escapeArg(pkg) + `') { $hit = $v } } } }; ` +
		`if (-not $hit) { Write-Error 'Not found'; exit 1 }; ` +
		`$u = if ($hit.QuietUninstallString) { $hit.QuietUninstallString } else { $hit.UninstallString }; ` +
		`if ($u -match 'msiexec' -and $u -notmatch '/quiet') { $u = $u + ' /quiet /norestart' }; ` +
		`$u = $u -replace '/I\{','/X{'; ` +
		`Write-Host ('Running: ' + $u); ` +
		`& '` + syspath.CmdExe() + `' /c \"$u\""`
}

func (a *Apps) InstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: a.InstallCommand(pkg)}
}
func (a *Apps) UpdatePlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: a.UpdateCommand(pkg)}
}
func (a *Apps) UninstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: a.UninstallCommand(pkg)}
}
func (a *Apps) UpgradePlan() *ExecPlan {
	return &ExecPlan{ShellScript: a.UpgradeCommand()}
}

// escapeArg strips characters that would break out of a double-quoted cmd.exe arg.
func escapeArg(s string) string {
	bad := []string{`"`, `'`, "`", "$", "|", ";", "&", "<", ">", "\n", "\r"}
	out := s
	for _, b := range bad {
		out = strings.ReplaceAll(out, b, "")
	}
	return out
}
