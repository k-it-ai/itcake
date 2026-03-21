package packages

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

type Brew struct{}

func (b *Brew) Name() string { return "brew" }

func (b *Brew) IsAvailable() bool {
	// Check common paths directly since PATH may not include them as root
	for _, p := range []string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"} {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return commandExists("brew")
}

func brewPath() string {
	for _, p := range []string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "brew"
}

// brewExec runs a brew command as the console user (brew refuses root).
func brewExec(args ...string) ([]byte, error) {
	bp := brewPath()
	user := ConsoleUser()
	if user != "" && os.Getuid() == 0 {
		// Drop privileges: sudo -u <user> -H /opt/homebrew/bin/brew ...
		sudoArgs := append([]string{"-u", user, "-H", "--non-interactive", bp}, args...)
		return exec.Command("sudo", sudoArgs...).Output()
	}
	return exec.Command(bp, args...).Output()
}

func (b *Brew) ListInstalled() ([]Package, error) {
	out, err := brewExec("list", "--versions")
	if err != nil {
		return nil, err
	}

	// Get outdated packages
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

	// Also list casks (macOS GUI apps)
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

func (b *Brew) UpdateCommand(pkg string) string {
	bp := brewPath()
	user := ConsoleUser()
	if user != "" && os.Getuid() == 0 {
		return "sudo -u " + user + " -H --non-interactive " + bp + " upgrade " + pkg
	}
	return bp + " upgrade " + pkg
}

func (b *Brew) UpgradeCommand() string {
	bp := brewPath()
	user := ConsoleUser()
	if user != "" && os.Getuid() == 0 {
		return "sudo -u " + user + " -H --non-interactive " + bp + " update && sudo -u " + user + " -H --non-interactive " + bp + " upgrade"
	}
	return bp + " update && " + bp + " upgrade"
}

func (b *Brew) InstallCommand(pkg string) string {
	bp := brewPath()
	user := ConsoleUser()
	if user != "" && os.Getuid() == 0 {
		return "sudo -u " + user + " -H --non-interactive " + bp + " install " + pkg
	}
	return bp + " install " + pkg
}

func (b *Brew) UninstallCommand(pkg string) string {
	bp := brewPath()
	user := ConsoleUser()
	home := "/var/root"
	if user != "" {
		home = "/Users/" + user
	}

	// Step 1: brew uninstall --zap (handles brew tracking + zap stanza if present)
	// Step 2: find-based deep scan (catches everything zap misses)
	// We need the bundle ID from the .app before brew removes it
	brewCmd := bp + " uninstall --zap " + pkg
	if user != "" && os.Getuid() == 0 {
		brewCmd = "sudo -u " + user + " -H --non-interactive " + bp + " uninstall --zap " + pkg
	}

	return fmt.Sprintf(`
# Get bundle ID before brew removes the app
BID=""
for appdir in "/Applications" "%s/Applications"; do
  PLIST="$appdir/%s.app/Contents/Info.plist"
  if [ -f "$PLIST" ]; then
    BID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$PLIST" 2>/dev/null)
    break
  fi
done
APPNAME="%s"
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
`, home, pkg, pkg, home, user, brewCmd)
}
