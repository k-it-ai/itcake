//go:build !windows

package packages

import (
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

var consoleUser string

// POSIX-portable username — gates values flowing into sudo -u argv.
var validUsernameRE = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

func isValidUsername(s string) bool {
	if s == "" || s == "root" {
		return false
	}
	return validUsernameRE.MatchString(s)
}

func init() {
	consoleUser = detectConsoleUser()
}

// ConsoleUser returns the logged-in non-root user, or "" when not root.
func ConsoleUser() string {
	return consoleUser
}

func detectConsoleUser() string {
	if os.Getuid() != 0 {
		return ""
	}

	if runtime.GOOS == "darwin" {
		out, err := exec.Command("/usr/bin/stat", "-f", "%Su", "/dev/console").Output()
		if err == nil {
			user := strings.TrimSpace(string(out))
			if isValidUsername(user) {
				return user
			}
		}
		for _, brewPath := range []string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"} {
			out, err := exec.Command("/usr/bin/stat", "-f", "%Su", brewPath).Output()
			if err == nil {
				user := strings.TrimSpace(string(out))
				if isValidUsername(user) {
					return user
				}
			}
		}
	}

	// Linux: SUDO_USER is env-spoofable and logname fails under systemd;
	// treat as service-identity (root) and skip the privilege-drop.
	return ""
}
