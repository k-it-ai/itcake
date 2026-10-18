package packages

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

type Brew struct{}

func (b *Brew) Name() string { return "brew" }

func (b *Brew) IsAvailable() bool {
	for _, p := range []string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"} {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return commandExists("brew")
}

func brewPath() string {
	return syspath.Brew()
}

// brewExec runs a brew command as the console user (brew refuses root).
func brewExec(args ...string) ([]byte, error) {
	bp := brewPath()
	user := ConsoleUser()
	if user != "" && os.Getuid() == 0 {
		sudoArgs := append([]string{"-u", user, "-H", "--non-interactive", bp}, args...)
		return exec.Command(syspath.Sudo(), sudoArgs...).Output()
	}
	return exec.Command(bp, args...).Output()
}

func (b *Brew) ListInstalled() ([]Package, error) {
	out, err := brewExec("list", "--versions")
	if err != nil {
		return nil, err
	}

	outdatedMap := make(map[string]string)
	if outdatedOut, err := brewExec("outdated", "--json=v2"); err == nil {
		var data struct {
			Formulae []struct {
				Name           string `json:"name"`
				CurrentVersion string `json:"current_version"`
			} `json:"formulae"`
		}
		if json.Unmarshal(outdatedOut, &data) == nil {
			for _, f := range data.Formulae {
				outdatedMap[f.Name] = f.CurrentVersion
			}
		}
	}

	if caskOut, err := brewExec("list", "--cask", "--versions"); err == nil {
		out = append(out, '\n')
		out = append(out, caskOut...)
	}

	var pkgs []Package
	for _, line := range splitLines(strings.TrimSpace(string(out))) {
		parts := splitFields(line)
		if len(parts) < 2 {
			continue
		}
		name := parts[0]
		version := parts[len(parts)-1]
		pkg := Package{Name: name, Version: version}
		if latest, ok := outdatedMap[name]; ok {
			pkg.LatestVersion = latest
			pkg.UpdateAvailable = true
		}
		pkgs = append(pkgs, pkg)
	}
	return pkgs, nil
}

// InstallPlan/UpdatePlan: AsRoot=false so ExecuteArgv drops to the console
// user when running as root (brew refuses root).
func (b *Brew) InstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: brewPath(), Argv: []string{"install", pkg}}
}
func (b *Brew) UpdatePlan(pkg string) *ExecPlan {
	return &ExecPlan{Binary: brewPath(), Argv: []string{"upgrade", pkg}}
}

// UpgradePlan chains `brew update && brew upgrade` so it must be a ShellScript.
func (b *Brew) UpgradePlan() *ExecPlan {
	bp := brewPath()
	user := ConsoleUser()
	if user != "" && os.Getuid() == 0 {
		script := syspath.Sudo() + " -u " + user + " -H --non-interactive " + bp + " update && " +
			syspath.Sudo() + " -u " + user + " -H --non-interactive " + bp + " upgrade"
		return &ExecPlan{ShellScript: script}
	}
	return &ExecPlan{ShellScript: bp + " update && " + bp + " upgrade"}
}

// UninstallPlan runs `brew uninstall --zap` then a deep-scan cleanup pass.
// pkg is single-quoted via shellQuote to neutralise upstream validator drift.
func (b *Brew) UninstallPlan(pkg string) *ExecPlan {
	bp := brewPath()
	user := ConsoleUser()
	home := "/var/root"
	if user != "" {
		home = "/Users/" + user
	}

	qpkg := shellQuote(pkg)
	brewCmd := bp + " uninstall --zap " + qpkg
	if user != "" && os.Getuid() == 0 {
		brewCmd = syspath.Sudo() + " -u " + user + " -H --non-interactive " + bp + " uninstall --zap " + qpkg
	}

	script := fmt.Sprintf(`
PKG=%s
# Get bundle ID before brew removes the app
BID=""
for appdir in "/Applications" "%s/Applications"; do
  PLIST="$appdir/${PKG}.app/Contents/Info.plist"
  if [ -f "$PLIST" ]; then
    BID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$PLIST" 2>/dev/null)
    break
  fi
done
case "$BID" in
  ''|*[!a-zA-Z0-9_.-]*) BID='' ;;
esac
APPNAME="$PKG"
H="%s"
U="%s"

# Step 1: brew uninstall --zap
%s 2>&1

# Step 2: deep scan for leftovers (same as apps manager)
if [ -n "$BID" ]; then
  HITLIST=$(mktemp)
  trap "rm -f $HITLIST" EXIT

  for dir in "Application Scripts" "Application Support" "Caches" "Containers" "Cookies" \
             "Group Containers" "HTTPStorages" "LaunchAgents" "Logs" "Preferences" \
             "Preferences/ByHost" "Saved Application State" "SyncedPreferences" "WebKit"; do
    [ -d "$H/Library/$dir" ] && sudo -u "$U" find "$H/Library/$dir" -maxdepth 2 \( -name "$BID" -o -name "$BID.*" -o -name "$BID*" -o -name "*$BID*" \) 2>/dev/null >> "$HITLIST"
  done
  for dir in "Application Support" "Caches" "LaunchAgents" "LaunchDaemons" "Logs" "Preferences" "PrivilegedHelperTools"; do
    [ -d "/Library/$dir" ] && find "/Library/$dir" -maxdepth 2 \( -name "$BID" -o -name "$BID.*" -o -name "$BID*" -o -name "*$BID*" \) 2>/dev/null >> "$HITLIST"
  done
  find /Library/Logs/DiagnosticReports -maxdepth 1 -name "*$BID*" 2>/dev/null >> "$HITLIST"
  find /var/db/receipts -maxdepth 1 -name "$BID*" 2>/dev/null >> "$HITLIST"

  VENDOR=$(echo "$BID" | awk -F. '{print $1"."$2}')
  [ -n "$VENDOR" ] && [ "$VENDOR" != "$BID" ] && [ -d "$H/Library/Group Containers" ] && \
    sudo -u "$U" find "$H/Library/Group Containers" -maxdepth 1 -name "*$VENDOR*" 2>/dev/null >> "$HITLIST"

  if [ -s "$HITLIST" ]; then
    sort -u "$HITLIST" | while IFS= read -r f; do
      [ -e "$f" ] && rm -rf "$f" 2>/dev/null
    done
  fi
fi

# App-name cleanup
for dir in "Application Support" "Caches" "Logs"; do
  [ -d "$H/Library/$dir/$APPNAME" ] && rm -rf "$H/Library/$dir/$APPNAME" 2>/dev/null
  [ -d "/Library/$dir/$APPNAME" ] && rm -rf "/Library/$dir/$APPNAME" 2>/dev/null
done
sudo -u "$U" find "$H/Library/Application Support/CrashReporter" -maxdepth 1 -name "${APPNAME}_*" -delete 2>/dev/null

echo "Done"
`, qpkg, home, home, user, brewCmd)

	return &ExecPlan{ShellScript: script}
}

func (b *Brew) InstallCommand(pkg string) string   { return planToShell(b.InstallPlan(pkg)) }
func (b *Brew) UpdateCommand(pkg string) string    { return planToShell(b.UpdatePlan(pkg)) }
func (b *Brew) UninstallCommand(pkg string) string { return planToShell(b.UninstallPlan(pkg)) }
func (b *Brew) UpgradeCommand() string             { return planToShell(b.UpgradePlan()) }

var _ ArgvCapable = (*Brew)(nil)

func (b *Brew) InstallArgv(pkg string) (string, []string) {
	p := b.InstallPlan(pkg)
	return p.Binary, p.Argv
}
func (b *Brew) UpdateArgv(pkg string) (string, []string) {
	p := b.UpdatePlan(pkg)
	return p.Binary, p.Argv
}

// UninstallArgv returns ("", nil) — uninstall needs the zap+cleanup shell pipeline.
func (b *Brew) UninstallArgv(pkg string) (string, []string) {
	return "", nil
}
