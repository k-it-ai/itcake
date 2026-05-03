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

// POSIX-portable username — gates SUDO_USER and friends before the value
// reaches /bin/sh -c interpolation in brew/npm/pip helpers.
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

	// Linux: under systemd the agent always runs as root with no console
	// user. SUDO_USER is environment-controllable (anyone with a drop-in
	// unit file or a pinned env override can spoof it), and `logname`
	// fails in non-interactive service contexts. Treat Linux as
	// service-identity only — package operations execute as root, the
	// documented model. Re-introducing privilege drop here would require
	// a kernel-attested user source, which we don't have.

	return ""
}

