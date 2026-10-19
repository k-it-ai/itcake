package packages

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

// Apps lists and manages macOS .app bundles in /Applications.
type Apps struct{}

func (a *Apps) Name() string      { return "apps" }
func (a *Apps) IsAvailable() bool { return true } // Always available on macOS

func (a *Apps) ListInstalled() ([]Package, error) {
	// Get brew cask list to exclude brew-managed apps (those show under "brew" source)
	brewCasks := getBrewCaskApps()

	entries, err := os.ReadDir("/Applications")
	if err != nil {
		return nil, err
	}

	var pkgs []Package
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasSuffix(entry.Name(), ".app") {
			continue
		}
		appPath := filepath.Join("/Applications", entry.Name())
		name := strings.TrimSuffix(entry.Name(), ".app")

		// Skip brew-managed apps — they're listed under the "brew" source
		// and should be uninstalled via "brew uninstall --zap" for proper cleanup
		if brewCasks[strings.ToLower(name)] {
			continue
		}

		version := readPlistKey(appPath, "CFBundleShortVersionString")
		pkgs = append(pkgs, Package{
			Name:    name,
			Version: version,
		})
	}

	return pkgs, nil
}

// getBrewCaskApps returns a set of app names (lowercased) installed via brew cask.
func getBrewCaskApps() map[string]bool {
	result := make(map[string]bool)
	user := ConsoleUser()
	bp := brewPath()

	var out []byte
	var err error
	if user != "" && os.Getuid() == 0 {
		out, err = exec.Command(syspath.Sudo(), "-u", user, "-H", "--non-interactive", bp, "list", "--cask").Output()
	} else {
		out, err = exec.Command(bp, "list", "--cask").Output()
	}
	if err != nil {
		return result
	}

	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name := strings.TrimSpace(line)
		if name != "" {
			result[strings.ToLower(name)] = true
		}
	}
	return result
}

func (a *Apps) UpdateCommand(pkg string) string  { return "" } // Apps don't self-update via CLI
func (a *Apps) UpgradeCommand() string           { return "" }
func (a *Apps) InstallCommand(pkg string) string { return "" }

// InstallPlan / UpdatePlan / UpgradePlan: no-op — macOS .app bundles
// are not installable via CLI. Returning an empty plan lets the
// dispatcher fall through to the next package manager (brew, etc.).
func (a *Apps) InstallPlan(pkg string) *ExecPlan { return &ExecPlan{} }
func (a *Apps) UpdatePlan(pkg string) *ExecPlan  { return &ExecPlan{} }
func (a *Apps) UpgradePlan() *ExecPlan           { return &ExecPlan{} }

// UninstallPlan: the deep-cleanup pass is a multi-step bash script
// (PlistBuddy reads, find loops with multiple patterns, sudo -u drops)
// that can't fit a single argv call. Stays as a ShellScript. pkg /
// user / home are stripped via shellSafeArg before interpolation, so
// metacharacters can't escape the surrounding `"..."` contexts even
// if an upstream validator relaxes. AsRoot=true because the script
// removes /Applications/<App>.app which requires root.
func (a *Apps) UninstallPlan(pkg string) *ExecPlan {
	return &ExecPlan{ShellScript: a.UninstallCommand(pkg), AsRoot: true}
}

// shellSafeArg strips characters that would break out of a double-quoted shell
// argument. The script below interpolates `pkg`, `user`, and `home` into
// double-quoted positions; even though all three values pass earlier
// validation (server-side `packageNameRegex` for pkg; `isValidUsername` for
// user; `/Users/<user>` derivation for home), defense-in-depth says we
// scrub here too so any future regex relaxation can't trigger shell
// injection through this script. Same posture as `apps_windows.escapeArg`.
func shellSafeArg(s string) string {
	for _, bad := range []string{`"`, `'`, "`", "$", "|", ";", "&", "<", ">", "\\", "\n", "\r", "(", ")"} {
		s = strings.ReplaceAll(s, bad, "")
	}
	return s
}

func (a *Apps) UninstallCommand(pkg string) string {
	user := shellSafeArg(ConsoleUser())
	home := shellSafeArg(userHome(user))
	pkg = shellSafeArg(pkg)
	// AppCleaner-style deep uninstall using find-based scanning.
	// Scans ~/Library and /Library for ANY file/directory matching the bundle ID or app name.
	script := fmt.Sprintf(`
APPPATH="/Applications/%s.app"
if [ ! -d "$APPPATH" ]; then echo "App not found: $APPPATH"; exit 1; fi

BID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APPPATH/Contents/Info.plist" 2>/dev/null)
# CFBundleIdentifier comes from the app's on-disk Info.plist (which the
# app vendor controls). Bash double-quoting leaves dollar-expansion +
# backtick command-substitution intact when the value is interpolated
# into a quoted argument, so a malicious plist value containing literal
# command-substitution syntax would yield code execution under root.
# Reject any value that contains characters outside the reverse-DNS
# safe set — the script's downstream code handles empty BID gracefully.
case "$BID" in
  ''|*[!a-zA-Z0-9_.-]*) BID='' ;;
esac
APPNAME="%s"
H="%s"
U="%s"

# Quit + kill
if [ -n "$BID" ]; then
  sudo -u "$U" osascript -e "tell application id \"$BID\" to quit" 2>/dev/null
  sleep 1
fi
killall "$APPNAME" 2>/dev/null
sleep 0.5

# Remove .app bundle
rm -rf "$APPPATH"
echo "Removed $APPPATH"

# Collect all paths to delete into a temp file (avoids subshell counter issues)
HITLIST=$(mktemp)
trap "rm -f $HITLIST" EXIT

scan_user() {
  sudo -u "$U" find "$1" -maxdepth "$2" \( -name "$BID" -o -name "$BID.*" -o -name "$BID*" -o -name "*$BID*" \) 2>/dev/null >> "$HITLIST"
}

scan_root() {
  find "$1" -maxdepth "$2" \( -name "$BID" -o -name "$BID.*" -o -name "$BID*" -o -name "*$BID*" \) 2>/dev/null >> "$HITLIST"
}

if [ -n "$BID" ]; then
  # ~/Library — scan each subdirectory (quoted properly for multi-word names)
  for dir in "Application Scripts" "Application Support" "Caches" "Containers" "Cookies" \
             "Group Containers" "HTTPStorages" "LaunchAgents" "Logs" "Preferences" \
             "Preferences/ByHost" "Saved Application State" "SyncedPreferences" "WebKit"; do
    [ -d "$H/Library/$dir" ] && scan_user "$H/Library/$dir" 2
  done

  # /Library — system level
  for dir in "Application Support" "Caches" "LaunchAgents" "LaunchDaemons" "Logs" \
             "Preferences" "PrivilegedHelperTools"; do
    [ -d "/Library/$dir" ] && scan_root "/Library/$dir" 2
  done

  # DiagnosticReports
  scan_root "/Library/Logs/DiagnosticReports" 1

  # Receipts
  scan_root "/var/db/receipts" 1

  # Group Containers — also match by vendor prefix (e.g. group.com.apple.iWork for Pages)
  VENDOR=$(echo "$BID" | awk -F. '{print $1"."$2}')
  if [ -n "$VENDOR" ] && [ "$VENDOR" != "$BID" ] && [ -d "$H/Library/Group Containers" ]; then
    sudo -u "$U" find "$H/Library/Group Containers" -maxdepth 1 -name "*$VENDOR*" 2>/dev/null >> "$HITLIST"
  fi
fi

# App-name based cleanup (catches paths like "Citrix Workspace", "Firefox")
if [ -n "$APPNAME" ]; then
  for dir in "Application Support" "Caches" "Logs"; do
    [ -d "$H/Library/$dir/$APPNAME" ] && echo "$H/Library/$dir/$APPNAME" >> "$HITLIST"
    [ -d "/Library/$dir/$APPNAME" ] && echo "/Library/$dir/$APPNAME" >> "$HITLIST"
  done
  # CrashReporter
  [ -d "$H/Library/Application Support/CrashReporter" ] && \
    sudo -u "$U" find "$H/Library/Application Support/CrashReporter" -maxdepth 1 -name "${APPNAME}_*" 2>/dev/null >> "$HITLIST"
  # DiagnosticReports by executable name
  EXENAME=$(echo "$APPNAME" | tr ' ' '_')
  find /Library/Logs/DiagnosticReports -maxdepth 1 \( -name "${APPNAME}_*" -o -name "${EXENAME}_*" \) 2>/dev/null >> "$HITLIST"
fi

# Deduplicate and delete
CLEANED=0
if [ -s "$HITLIST" ]; then
  sort -u "$HITLIST" | while IFS= read -r f; do
    if [ -e "$f" ]; then
      rm -rf "$f" 2>/dev/null
      CLEANED=$((CLEANED+1))
    fi
  done
fi

echo "Done"
`, pkg, pkg, home, user)

	return script
}

func readPlistKey(appPath, key string) string {
	plistPath := filepath.Join(appPath, "Contents", "Info.plist")
	out, err := exec.Command("/usr/libexec/PlistBuddy", "-c", fmt.Sprintf("Print :%s", key), plistPath).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func userHome(user string) string {
	if user != "" {
		return "/Users/" + user
	}
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	return "/var/root"
}
