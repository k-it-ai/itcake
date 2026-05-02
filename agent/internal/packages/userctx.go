//go:build !windows

package packages

import (
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

// consoleUser caches the detected non-root user who owns brew/GUI tools.
var consoleUser string

// POSIX-portable username: starts with a letter or underscore, then 0-31
// letters/digits/dashes/underscores. Anything else gets rejected so a
// SUDO_USER like "alice; rm -rf /" can never reach the shell-string
// concatenation in brew/npm/pip helpers.
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

// ConsoleUser returns the logged-in non-root user. Empty if detection fails or not root.
func ConsoleUser() string {
	return consoleUser
}

func detectConsoleUser() string {
	// Only needed when running as root
	if os.Getuid() != 0 {
		return ""
	}

	if runtime.GOOS == "darwin" {
		// macOS: stat the console device to find the logged-in user
		out, err := exec.Command("/usr/bin/stat", "-f", "%Su", "/dev/console").Output()
		if err == nil {
			user := strings.TrimSpace(string(out))
			if isValidUsername(user) {
				return user
			}
		}
		// Fallback: find the owner of the brew binary
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

	if runtime.GOOS == "linux" {
		// Linux: check SUDO_USER or logname
		if user := os.Getenv("SUDO_USER"); isValidUsername(user) {
			return user
		}
		out, err := exec.Command("logname").Output()
		if err == nil {
			user := strings.TrimSpace(string(out))
			if isValidUsername(user) {
				return user
			}
		}
	}

	return ""
}

