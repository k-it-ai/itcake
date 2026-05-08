//go:build windows

package packages

import (
	"strings"
	"testing"

	"github.com/itcake/agent/internal/syspath"
)

// Pin every Windows *Command builder to its syspath helper. Without this,
// a future contributor reverting a builder to use the bare `winget`/`choco`/
// `scoop` token (resolved via PATH) reintroduces a PATH-hijack vector that
// cmd.exe would happily resolve from a writable directory.
func TestWindowsPackageBuildersUseSyspath(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"choco install", (&Choco{}).InstallCommand("git"), syspath.Choco()},
		{"choco update", (&Choco{}).UpdateCommand("git"), syspath.Choco()},
		{"choco uninstall", (&Choco{}).UninstallCommand("git"), syspath.Choco()},
		{"choco upgrade-all", (&Choco{}).UpgradeCommand(), syspath.Choco()},
		{"winget install", (&Winget{}).InstallCommand("Git.Git"), syspath.WingetExe()},
		{"winget update", (&Winget{}).UpdateCommand("Git.Git"), syspath.WingetExe()},
		{"winget uninstall", (&Winget{}).UninstallCommand("Git.Git"), syspath.WingetExe()},
		{"winget upgrade-all", (&Winget{}).UpgradeCommand(), syspath.WingetExe()},
		{"scoop install", (&Scoop{}).InstallCommand("git"), syspath.Scoop()},
		{"scoop update", (&Scoop{}).UpdateCommand("git"), syspath.Scoop()},
		{"scoop uninstall", (&Scoop{}).UninstallCommand("git"), syspath.Scoop()},
		{"scoop upgrade-all", (&Scoop{}).UpgradeCommand(), syspath.Scoop()},
		// Apps delegates winget for install/update/upgrade — pin those.
		{"apps install", (&Apps{}).InstallCommand("Some App"), syspath.WingetExe()},
		{"apps update", (&Apps{}).UpdateCommand("Some App"), syspath.WingetExe()},
		{"apps upgrade-all", (&Apps{}).UpgradeCommand(), syspath.WingetExe()},
		// Apps uninstall builds a PowerShell one-liner — pin powershell.exe.
		{"apps uninstall", (&Apps{}).UninstallCommand("Some App"), syspath.PowerShell()},
	}
	for _, tc := range cases {
		if !strings.HasPrefix(tc.got, `"`+tc.want+`"`) {
			t.Errorf("%s: got %q, expected to start with %q", tc.name, tc.got, `"`+tc.want+`"`)
		}
	}
}
